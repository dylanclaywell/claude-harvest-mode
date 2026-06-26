// test-state.ts — headless checks for the save/state reconcile engine.
//   npm run test:state
import { defaultSave } from "../src/save";
import { applySession, rollover, type Cursors } from "../src/state";
import { GROWTH_STAGES } from "../src/config";
import type { VizEvent } from "../src/parser";

let pass = 0, fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) { pass++; console.log("  ok  -", name); }
  else { fail++; console.error("  FAIL-", name); }
}

let seq = 0;
const buildEv = (file: string): VizEvent =>
  ({ seq: seq++, t: 0, kind: "tool", actor: "o", tokTotal: 0, ctxUsed: 0, cat: "build", tool: "Edit", file });
const skillEv = (skill: string): VizEvent =>
  ({ seq: seq++, t: 0, kind: "skill", actor: "o", tokTotal: 0, ctxUsed: 0, skill });
const mcpEv = (srv: string): VizEvent =>
  ({ seq: seq++, t: 0, kind: "tool", actor: "o", tokTotal: 0, ctxUsed: 0, cat: "mcp", tool: `mcp__${srv}__x`, mcpServerName: srv });

const now = new Date();
const save = defaultSave();
const cursors: Cursors = new Map();

// Backlog that predates the app: must NOT count (baseline rule).
const events: VizEvent[] = [buildEv("old.ts"), buildEv("old.ts"), skillEv("legacy")];
const n0 = applySession(save, "s", events, cursors, now);
check("baseline applies 0 backlog events", n0 === 0);
check("no crops from backlog", Object.keys(save.field).length === 0);
check("no gold from backlog", save.goldTotal === 0);

// Re-read with no new events (live tail no-op): still 0.
check("re-read applies nothing", applySession(save, "s", events, cursors, now) === 0);

// New activity after load: grows a crop to ripe, learns a recipe, gets an animal.
for (let i = 0; i < GROWTH_STAGES; i++) events.push(buildEv("src/app.ts"));
events.push(skillEv("code-review"));
events.push(mcpEv("codegraph"), mcpEv("codegraph"));
const n1 = applySession(save, "s", events, cursors, now);
check("applies the new events", n1 === GROWTH_STAGES + 3);
check("crop planted", !!save.field["src/app.ts"]);
check("crop ripened", save.field["src/app.ts"]?.ripe === true);
check("recipe learned once", save.recipeBook.length === 1);
check("animal acquired", !!save.barn["codegraph"]);
check("animal accrued produce", save.barn["codegraph"].pendingProduce === 2);

// Idempotency: applying again with no new events does nothing.
check("no double-count", applySession(save, "s", events, cursors, now) === 0);

// Overnight: pretend the last run was a different day → harvest.
save.lastSessionDate = "2000-01-01";
const report = rollover(save, now);
check("rollover produced a report", !!report);
check("gold banked", save.goldTotal > 0);
check("ripe crop shipped (field cleared)", !save.field["src/app.ts"]);
check("produce shipped", save.barn["codegraph"].pendingProduce === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
