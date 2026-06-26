// parser.ts — turn a Claude Code session .jsonl into a typed visualizer event
// timeline. Ported from agent-quest/lib/parser.js, with farm-relevant fields
// added (MCP server, file path, test-pass) per GAME_DESIGN.md §3.
//
// A session log is newline-delimited JSON. Lines we care about:
//   { type:"assistant", message:{ content:[ {type:"text"|"tool_use",...} ], usage }, timestamp }
//   { type:"user",      message:{ content: "..." | [ {type:"tool_result",...} ] }, timestamp }
//   { type:"ai-title", aiTitle } | { type:"summary", summary }
//   { type:"system", subtype, cwd, version, gitBranch, sessionId, ... }

const AGENT_TOOLS = new Set(["Agent", "Task"]);

// Claude context-window tiers (tokens). Hearts/stamina read against this.
const CONTEXT_TIERS = [200_000, 1_000_000] as const;
function windowForPeak(peak: number): number {
  for (const t of CONTEXT_TIERS) if (peak <= t) return t;
  return CONTEXT_TIERS[CONTEXT_TIERS.length - 1];
}

// Commands that count as "running the tests" → rain / quality in the farm.
const TEST_CMD_RE = /\b(npm (run )?test|pytest|jest|vitest|go test|cargo test|mvn test|gradle test|rspec|phpunit|dotnet test)\b/;

export type ToolCategory =
  | "agent" | "skill" | "search" | "build" | "bomb" | "scroll" | "mcp" | "quest" | "misc";

export function toolCategory(name: string | undefined): ToolCategory {
  if (!name) return "misc";
  if (AGENT_TOOLS.has(name)) return "agent";
  if (name === "Skill") return "skill";
  if (/^(Read|Glob|Grep|Explore|NotebookRead|ToolSearch)$/.test(name)) return "search";
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name)) return "build";
  if (/^(Bash|PowerShell)$/.test(name)) return "bomb";
  if (/^(WebFetch|WebSearch)$/.test(name)) return "scroll";
  if (name.startsWith("mcp__")) return "mcp";
  if (/Task(Create|Update|Get|List|Output|Stop)/.test(name)) return "quest";
  return "misc";
}

/** MCP server name from a tool name: `mcp__<server>__<tool>` → `<server>`. */
export function mcpServer(name: string | undefined): string | null {
  if (!name || !name.startsWith("mcp__")) return null;
  return name.split("__")[1] || null;
}

export type EventKind = "prompt" | "say" | "tool" | "agent" | "agentDone" | "skill";
export type EventStatus = "running" | "done" | "error";

export interface VizEvent {
  seq: number;
  t: number | null; // ms since session start
  kind: EventKind;
  actor: string;
  tokTotal: number; // running output tokens at this point
  ctxUsed: number; // context occupancy at this point
  text?: string;
  // tool / agent
  tool?: string;
  cat?: ToolCategory;
  status?: EventStatus;
  id?: string;
  // agent
  agentType?: string;
  bg?: boolean;
  durMs?: number | null;
  ref?: number; // agentDone → spawning agent's seq
  // skill
  skill?: string;
  // farm-relevant derived fields
  file?: string; // build/search target → crop plot key
  mcpServerName?: string; // mcp → barn animal key
  command?: string; // bomb → raw command
  testPass?: boolean; // bomb that ran tests and succeeded → rain
}

export interface SessionMeta {
  sessionId: string | null;
  title: string | null;
  project: string | null;
  cwd: string | null;
  model: string | null;
  gitBranch: string | null;
  version: string | null;
  startTs: number | null;
}

export interface SessionResult {
  meta: SessionMeta;
  events: VizEvent[];
  outputTokens: number;
  contextUsed: number;
  contextWindow: number;
}

function contextOccupancy(usage: any): number {
  if (!usage) return 0;
  return (
    (usage.input_tokens || 0) +
    (usage.cache_read_input_tokens || 0) +
    (usage.cache_creation_input_tokens || 0)
  );
}

function isMetaPrompt(text: unknown): boolean {
  if (typeof text !== "string") return true;
  const t = text.trim();
  if (!t) return true;
  return (
    t.startsWith("<local-command") ||
    t.startsWith("<command-") ||
    t.startsWith("Caveat:") ||
    t.startsWith("<system-reminder") ||
    t.startsWith("[Request interrupted")
  );
}

function baseName(p: unknown): string {
  return typeof p === "string" ? p.split(/[\\/]/).pop() || "" : "";
}

function toolTarget(name: string, input: any): string {
  if (!input || typeof input !== "object") return "";
  switch (name) {
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return baseName(input.file_path || input.notebook_path);
    case "Glob":
    case "Grep":
      return input.pattern || "";
    case "Bash":
    case "PowerShell":
      return (input.description || input.command || "").slice(0, 48);
    case "WebFetch":
    case "WebSearch":
      return (input.url || input.query || "").slice(0, 48);
    case "Skill":
      return input.skill || "";
    default:
      return (input.description || "").slice(0, 48);
  }
}

function trimText(s: unknown, n = 160): string {
  if (!s) return "";
  let str = String(s).replace(/\s+/g, " ").trim();
  return str.length > n ? str.slice(0, n - 1) + "…" : str;
}

interface PendingAgent { idx: number; agentType: string; startMs: number | null; }
interface PendingTool { idx: number; cat: ToolCategory; command?: string; }

/**
 * Stateful streaming parser. Feed raw lines in order; it accumulates events and
 * meta. Works for both whole-file parse and incremental live tailing.
 */
export class SessionParser {
  meta: SessionMeta = {
    sessionId: null, title: null, project: null, cwd: null,
    model: null, gitBranch: null, version: null, startTs: null,
  };
  events: VizEvent[] = [];
  seq = 0;
  totalOutputTokens = 0;
  contextUsed = 0;
  peakContext = 0;
  contextWindow: number = CONTEXT_TIERS[0];
  pendingAgents = new Map<string, PendingAgent>();
  pendingTools = new Map<string, PendingTool>();

  private _ms(ts: unknown): number | null {
    if (!ts || typeof ts !== "string") return null;
    const ms = Date.parse(ts);
    if (Number.isNaN(ms)) return null;
    if (this.meta.startTs == null) this.meta.startTs = ms;
    return ms;
  }

  private _push(ev: Omit<VizEvent, "seq" | "tokTotal" | "ctxUsed">): VizEvent {
    const full = ev as VizEvent;
    full.seq = this.seq++;
    full.tokTotal = this.totalOutputTokens;
    full.ctxUsed = this.contextUsed;
    this.events.push(full);
    return full;
  }

  feedLine(line: string): void {
    const l = line && line.trim();
    if (!l) return;
    let o: any;
    try {
      o = JSON.parse(l);
    } catch {
      return;
    }
    this.feed(o);
  }

  feed(o: any): void {
    const type = o && o.type;
    if (!type) return;

    if (type === "ai-title" && o.aiTitle) {
      this.meta.title = o.aiTitle;
      return;
    }
    if (type === "summary" && o.summary && !this.meta.title) {
      this.meta.title = o.summary;
      return;
    }

    const ms = this._ms(o.timestamp);
    const t = ms != null && this.meta.startTs != null ? ms - this.meta.startTs : null;

    if (type === "system") {
      if (!this.meta.cwd && o.cwd) this.meta.cwd = o.cwd;
      if (!this.meta.gitBranch && o.gitBranch) this.meta.gitBranch = o.gitBranch;
      if (!this.meta.version && o.version) this.meta.version = o.version;
      if (!this.meta.sessionId && o.sessionId) this.meta.sessionId = o.sessionId;
      return;
    }

    if (type === "user") {
      const msg = o.message || {};
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c && c.type === "tool_result") {
            this._resolveResult(c.tool_use_id, c.is_error, c.content, t);
          }
        }
        return;
      }
      if (typeof content === "string" && !isMetaPrompt(content)) {
        this._push({ t, kind: "prompt", actor: "orchestrator", text: trimText(content, 220) });
      }
      return;
    }

    if (type === "assistant") {
      const msg = o.message || {};
      if (!this.meta.model && msg.model) this.meta.model = msg.model;
      if (msg.usage && typeof msg.usage.output_tokens === "number") {
        this.totalOutputTokens += msg.usage.output_tokens;
      }
      const occ = contextOccupancy(msg.usage);
      if (occ > 0) {
        this.contextUsed = occ;
        if (occ > this.peakContext) this.peakContext = occ;
        this.contextWindow = windowForPeak(this.peakContext);
      }
      const content = msg.content;
      if (!Array.isArray(content)) return;

      for (const c of content) {
        if (!c || typeof c !== "object") continue;

        if (c.type === "text" && c.text && c.text.trim()) {
          this._push({ t, kind: "say", actor: "orchestrator", text: trimText(c.text, 200) });
        } else if (c.type === "tool_use") {
          const name: string = c.name;
          const input = c.input || {};
          const cat = toolCategory(name);

          if (cat === "agent") {
            const agentType = input.subagent_type || "claude";
            const ev = this._push({
              t, kind: "agent", actor: "orchestrator", agentType, tool: name,
              bg: !!input.run_in_background, text: trimText(input.description || agentType, 80),
              status: "running", durMs: null, id: c.id,
            });
            if (c.id) this.pendingAgents.set(c.id, { idx: ev.seq, agentType, startMs: ms });
          } else if (cat === "skill") {
            this._push({
              t, kind: "skill", actor: "orchestrator", skill: input.skill || "skill",
              text: trimText((input.skill || "skill") + (input.args ? " " + input.args : ""), 80),
              id: c.id,
            });
          } else {
            const ev = this._push({
              t, kind: "tool", actor: "orchestrator", tool: name, cat,
              text: trimText(toolTarget(name, input) || name, 80), status: "running", id: c.id,
              file: cat === "build" || cat === "search" ? input.file_path : undefined,
              mcpServerName: cat === "mcp" ? mcpServer(name) ?? undefined : undefined,
              command: cat === "bomb" ? input.command : undefined,
            });
            if (c.id) {
              this.pendingTools.set(c.id, {
                idx: ev.seq, cat,
                command: cat === "bomb" ? input.command : undefined,
              });
            }
          }
        }
      }
      return;
    }
  }

  private _resolveResult(
    toolUseId: string | undefined, isError: boolean | undefined,
    content: unknown, t: number | null,
  ): void {
    if (!toolUseId) return;
    if (this.pendingAgents.has(toolUseId)) {
      const info = this.pendingAgents.get(toolUseId)!;
      this.pendingAgents.delete(toolUseId);
      const orig = this.events.find((e) => e.seq === info.idx);
      if (orig) {
        orig.status = isError ? "error" : "done";
        if (t != null && this.meta.startTs != null && info.startMs != null) {
          orig.durMs = this.meta.startTs + t - info.startMs;
        }
      }
      this._push({
        t, kind: "agentDone", actor: info.agentType, agentType: info.agentType,
        ref: info.idx, id: toolUseId, status: isError ? "error" : "done",
        text: this._resultPreview(content),
      });
      return;
    }
    if (this.pendingTools.has(toolUseId)) {
      const info = this.pendingTools.get(toolUseId)!;
      this.pendingTools.delete(toolUseId);
      const orig = this.events.find((e) => e.seq === info.idx);
      if (orig) {
        orig.status = isError ? "error" : "done";
        // A successful test run waters the field.
        if (info.cat === "bomb" && !isError && info.command && TEST_CMD_RE.test(info.command)) {
          orig.testPass = true;
        }
      }
    }
  }

  private _resultPreview(content: unknown): string {
    let s = "";
    if (typeof content === "string") s = content;
    else if (Array.isArray(content)) {
      for (const c of content) {
        if (c && (c as any).type === "text" && (c as any).text) {
          s = (c as any).text;
          break;
        }
      }
    }
    return trimText(s, 140);
  }

  result(): SessionResult {
    return {
      meta: this.meta,
      events: this.events,
      outputTokens: this.totalOutputTokens,
      contextUsed: this.contextUsed,
      contextWindow: this.contextWindow,
    };
  }
}

/** Parse an entire file's text content at once. */
export function parseSessionText(text: string): SessionResult {
  const p = new SessionParser();
  for (const ln of text.split("\n")) p.feedLine(ln);
  return p.result();
}
