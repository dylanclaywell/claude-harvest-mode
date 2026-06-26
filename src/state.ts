// state.ts — reconcile the durable save against the live event timeline.
//
// Two rules from the design discussion:
//  1. BASELINE: when the app first attaches to a session this run, snapshot the
//     log's current length; only events ARRIVING AFTER that advance the economy.
//     (Opening the app never retroactively banks the whole backlog.)
//  2. IDEMPOTENT: a per-session cursor means re-reading the file during live
//     tailing applies each new event exactly once.
//
// Cursors are in-memory per app run (Map below). The durable economy is in the
// save. So closing the app = a gap that isn't tracked — by design.

import {
  GROWTH_STAGES, QUALITY_MAX, QUALITY_TEST_BONUS, HEARTS_MAX,
  cropForFile, cropPrice, dateKey, extOf, producePrice, recipeName,
  seasonOf, speciesForIndex, PRODUCE_OF,
} from "./config";
import type { HarvestSave, MorningReport, ShipLine } from "./save";
import type { VizEvent } from "./parser";

/** Per-session high-water mark of events already applied this run. */
export type Cursors = Map<string, number>;

/**
 * Day-boundary reconciliation. On a new calendar day, ship ripe crops + animal
 * produce into a morning report and bank the gold. First ever run just stamps
 * the date. Returns the report to display (or null).
 */
export function rollover(save: HarvestSave, now: Date): MorningReport | null {
  const today = dateKey(now);
  if (save.lastSessionDate === today) return save.pendingReport; // same day, nothing new
  if (save.lastSessionDate === null) {
    save.lastSessionDate = today;
    return null; // fresh farm
  }

  const lines: ShipLine[] = [];
  const add = (crop: string, ext: string, gold: number) => {
    const hit = lines.find((l) => l.crop === crop && l.ext === ext);
    if (hit) { hit.qty++; hit.gold += gold; }
    else lines.push({ crop, ext, qty: 1, gold });
  };

  // Ripe crops ship and leave the field; unripe crops carry over.
  for (const [path, c] of Object.entries(save.field)) {
    if (c.ripe) {
      add(c.crop, c.ext, cropPrice(c.quality));
      delete save.field[path];
    }
  }
  // Animal produce ships; animals age a day.
  for (const a of Object.values(save.barn)) {
    if (a.pendingProduce > 0) {
      const g = a.pendingProduce * producePrice(a.hearts);
      add(PRODUCE_OF[a.species], "barn", g);
      // collapse the per-item qty into the real count
      const line = lines.find((l) => l.crop === PRODUCE_OF[a.species] && l.ext === "barn")!;
      line.qty += a.pendingProduce - 1;
      a.pendingProduce = 0;
    }
    a.ageDays++;
  }

  const earned = lines.reduce((s, l) => s + l.gold, 0);
  save.goldTotal += earned;
  save.dayCount++;
  save.lastSessionDate = today;
  save.pendingReport = { date: today, shipped: lines, earned, bought: [] };
  return save.pendingReport;
}

/**
 * Attach to a session and apply only post-baseline events. First call for a
 * session sets the baseline (cursor = current length, applies nothing).
 * Returns the number of events applied.
 */
export function applySession(
  save: HarvestSave, sessionId: string, events: VizEvent[], cursors: Cursors, now: Date,
): number {
  const have = cursors.get(sessionId);
  if (have === undefined) {
    cursors.set(sessionId, events.length); // BASELINE — ignore the backlog
    return 0;
  }
  let applied = 0;
  for (let i = have; i < events.length; i++) {
    applyEvent(save, events[i], now);
    applied++;
  }
  cursors.set(sessionId, events.length);
  return applied;
}

function applyEvent(save: HarvestSave, ev: VizEvent, now: Date): void {
  const season = seasonOf(now);

  if (ev.kind === "tool" && ev.cat === "build" && ev.file) {
    const f = ev.file;
    const c = save.field[f];
    if (!c) {
      save.field[f] = { crop: cropForFile(f, season), ext: extOf(f), stage: 1, quality: 1, ripe: false };
    } else if (!c.ripe) {
      c.stage++;
      if (c.stage >= GROWTH_STAGES) c.ripe = true;
    }
    return;
  }

  // A passing test rains on the field → quality bump for growing crops.
  if (ev.kind === "tool" && ev.cat === "bomb" && ev.testPass) {
    for (const c of Object.values(save.field)) {
      if (!c.ripe) c.quality = Math.min(QUALITY_MAX, c.quality + QUALITY_TEST_BONUS);
    }
    return;
  }

  // MCP server = barn animal; each call = one produce + a feed.
  if (ev.kind === "tool" && ev.cat === "mcp" && ev.mcpServerName) {
    const s = ev.mcpServerName;
    let a = save.barn[s];
    if (!a) {
      a = save.barn[s] = {
        species: speciesForIndex(Object.keys(save.barn).length),
        hearts: 1, ageDays: 0, lastFedDate: dateKey(now), pendingProduce: 0,
      };
    }
    a.pendingProduce++;
    a.lastFedDate = dateKey(now);
    a.hearts = Math.min(HEARTS_MAX, a.hearts + (a.pendingProduce % 5 === 0 ? 1 : 0));
    return;
  }

  // Skill = learn a recipe once; repeats are just cooking (no new entry).
  if (ev.kind === "skill" && ev.skill) {
    const name = recipeName(ev.skill, season);
    if (!save.recipeBook.includes(name)) save.recipeBook.push(name);
    return;
  }
}
