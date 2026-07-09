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

// Neglected crops rot on wall-clock time (not day count): an unripe crop that
// goes untouched withers at 2h and dies (vanishes) at 4h. Every build on the
// file refreshes the timer, so active work keeps a crop alive. Ripe crops are
// exempt — they wait for the farmhand or the day rollover.
const CROP_WITHER_MS = 2 * 60 * 60 * 1000;
const CROP_DIE_MS = 4 * 60 * 60 * 1000;

/**
 * Age unripe crops against the wall clock. Withers the neglected, deletes the
 * long-dead. Returns true if anything changed (caller persists).
 */
export function ageCrops(save: HarvestSave, now: Date): boolean {
  const t = now.getTime();
  let changed = false;
  for (const [path, c] of Object.entries(save.field)) {
    if (c.ripe) continue; // ripe crops never rot — they wait to be harvested
    const idle = t - c.lastBuildMs;
    if (idle >= CROP_DIE_MS) {
      delete save.field[path];
      changed = true;
    } else if (idle >= CROP_WITHER_MS && !c.withered) {
      c.withered = true;
      changed = true;
    }
  }
  return changed;
}

/**
 * A barn interaction produced while applying events — surfaced so the render
 * layer can animate it (farmer tends the animal; first-of-day shows a heart).
 * Transient: not persisted, just a signal for BarnView.
 */
export interface Interaction {
  server: string;
  firstToday: boolean; // first use of this server today → the +1-heart tend
}

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

  // Start from what the farmhand already picked today (gold banks now, not at
  // harvest time), then sweep anything still ripe the farmhand didn't reach.
  const lines: ShipLine[] = (save.harvested ?? []).map((l) => ({ ...l }));
  const add = (crop: string, ext: string, gold: number) => {
    const hit = lines.find((l) => l.crop === crop && l.ext === ext);
    if (hit) { hit.qty++; hit.gold += gold; }
    else lines.push({ crop, ext, qty: 1, gold });
  };
  save.harvested = [];

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
  effects?: Interaction[],
): number {
  const have = cursors.get(sessionId);
  if (have === undefined) {
    cursors.set(sessionId, events.length); // BASELINE — ignore the backlog
    return 0;
  }
  let applied = 0;
  for (let i = have; i < events.length; i++) {
    applyEvent(save, events[i], now, effects);
    applied++;
  }
  cursors.set(sessionId, events.length);
  return applied;
}

function applyEvent(save: HarvestSave, ev: VizEvent, now: Date, effects?: Interaction[]): void {
  const season = seasonOf(now);

  if (ev.kind === "tool" && ev.cat === "build" && ev.file) {
    const f = ev.file;
    const c = save.field[f];
    if (!c) {
      // A new file drops a seed (stage 0 = sown soil, no sprout yet). The
      // farmhand walks over and plants it, which is what raises it to stage 1.
      save.field[f] = { crop: cropForFile(f, season), ext: extOf(f), stage: 0, quality: 1, ripe: false, lastBuildMs: now.getTime() };
    } else if (c.stage === 0) {
      c.lastBuildMs = now.getTime(); // still awaiting the farmhand; just keep it fresh
    } else if (!c.ripe) {
      c.stage++;
      c.lastBuildMs = now.getTime(); // tending resets the wither clock
      c.withered = false; // a fresh build revives a withered crop
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

  // MCP server = barn animal. Every call = one produce + a tend. The FIRST
  // call of a calendar day is the affection feed: +1 heart (per used day).
  if (ev.kind === "tool" && ev.cat === "mcp" && ev.mcpServerName) {
    const s = ev.mcpServerName;
    let a = save.barn[s];
    if (!a) {
      a = save.barn[s] = {
        species: speciesForIndex(Object.keys(save.barn).length),
        hearts: 1, ageDays: 0, lastFedDate: null, pendingProduce: 0,
      };
    }
    a.pendingProduce++;
    const today = dateKey(now);
    const firstToday = a.lastFedDate !== today;
    if (firstToday) a.hearts = Math.min(HEARTS_MAX, a.hearts + 1);
    a.lastFedDate = today;
    effects?.push({ server: s, firstToday });
    return;
  }

  // Skill = learn a recipe once; repeats are just cooking (no new entry).
  if (ev.kind === "skill" && ev.skill) {
    const name = recipeName(ev.skill, season);
    if (!save.recipeBook.includes(name)) save.recipeBook.push(name);
    return;
  }
}
