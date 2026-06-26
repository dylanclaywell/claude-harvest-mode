// test-parser.ts — run the parser against a REAL Claude Code session log and
// print a farm-oriented summary. Proves the pipeline before any UI.
//
//   npm run test:parser              (newest session in newest project)
//   npm run test:parser -- <path>    (a specific .jsonl)
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseSessionText, toolCategory, mcpServer } from "../src/parser";

function newestJsonl(): string | null {
  const root = join(homedir(), ".claude", "projects");
  if (!existsSync(root)) return null;
  let best: { full: string; mt: number } | null = null;
  for (const proj of readdirSync(root)) {
    const dir = join(root, proj);
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of files) {
      const full = join(dir, f);
      try {
        const mt = statSync(full).mtimeMs;
        if (!best || mt > best.mt) best = { full, mt };
      } catch {}
    }
  }
  return best?.full ?? null;
}

const arg = process.argv[2];
const path = arg || newestJsonl();
if (!path) {
  console.error("No session .jsonl found under ~/.claude/projects (and none passed).");
  process.exit(1);
}

console.log("Parsing:", path);
const text = readFileSync(path, "utf8");
const res = parseSessionText(text);

const byKind: Record<string, number> = {};
const crops = new Set<string>();
const animals = new Set<string>();
const skills = new Set<string>();
const agents = new Set<string>();
let tests = 0;
const toolCats: Record<string, number> = {};

for (const e of res.events) {
  byKind[e.kind] = (byKind[e.kind] || 0) + 1;
  if (e.kind === "tool") {
    toolCats[e.cat || "misc"] = (toolCats[e.cat || "misc"] || 0) + 1;
    if (e.file) crops.add(e.file);
    if (e.mcpServerName) animals.add(e.mcpServerName);
    if (e.testPass) tests++;
  }
  if (e.kind === "agent" && e.agentType) agents.add(e.agentType);
  if (e.kind === "skill" && e.skill) skills.add(e.skill);
}

const line = "─".repeat(48);
console.log(line);
console.log("title    :", res.meta.title || "(untitled)");
console.log("model    :", res.meta.model || "?");
console.log("events   :", res.events.length, JSON.stringify(byKind));
console.log("toolCats :", JSON.stringify(toolCats));
console.log(line);
console.log(`GOLD source  · output tokens : ${res.outputTokens}`);
console.log(`STAMINA      · ctx ${res.contextUsed} / ${res.contextWindow}`);
console.log(`CROPS (files): ${crops.size}`);
for (const f of [...crops].slice(0, 12)) console.log("   ", f.split(/[\\/]/).pop());
console.log(`ANIMALS (MCP servers): ${animals.size} → ${[...animals].join(", ") || "(none)"}`);
console.log(`FARMHANDS (agent types): ${agents.size} → ${[...agents].join(", ") || "(none)"}`);
console.log(`RECIPES (skills): ${skills.size} → ${[...skills].join(", ") || "(none)"}`);
console.log(`RAIN (test passes): ${tests}`);
console.log(line);

// sanity-check the derived identifiers on a couple of raw tool names
const sample = ["mcp__codegraph__codegraph_search", "Edit", "Bash", "Skill"];
console.log("derive check:", sample.map((n) => `${n}→${toolCategory(n)}${mcpServer(n) ? "/" + mcpServer(n) : ""}`).join("  "));
