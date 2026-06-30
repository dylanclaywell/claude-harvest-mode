// save.ts — the game-owned persistent state (GAME_DESIGN.md §8E). Separate from
// the read-only Claude logs. Loaded/stored via the Rust read_save/write_save
// commands (atomic write in the app-data dir).

import type { Species } from "./config";
import type { Appearance } from "./appearance";
import { readSave as ipcRead, writeSave as ipcWrite, inTauri } from "./ipc";

export const SAVE_VERSION = 1;

export interface CropState {
  crop: string; // display name, fixed at plant time
  ext: string;
  stage: number; // 0..GROWTH_STAGES; >= GROWTH_STAGES = ripe
  quality: number; // multiplier, 1..QUALITY_MAX
  ripe: boolean;
}

export interface AnimalState {
  species: Species;
  hearts: number;
  ageDays: number;
  lastFedDate: string | null;
  pendingProduce: number;
}

export interface ShipLine { crop: string; ext: string; qty: number; gold: number; }
export interface MorningReport {
  date: string;
  shipped: ShipLine[];
  earned: number;
  bought: string[]; // animals purchased overnight (future; empty for now)
}

export interface HarvestSave {
  version: number;
  lastSessionDate: string | null;
  dayCount: number;
  goldTotal: number;
  pendingReport: MorningReport | null;
  field: Record<string, CropState>; // keyed by file path
  barn: Record<string, AnimalState>; // keyed by MCP server name
  recipeBook: string[];
  appearance: Appearance; // player's chosen part colors ({} = base palette)
}

export function defaultSave(): HarvestSave {
  return {
    version: SAVE_VERSION,
    lastSessionDate: null,
    dayCount: 1,
    goldTotal: 0,
    pendingReport: null,
    field: {},
    barn: {},
    recipeBook: [],
    appearance: {},
  };
}

export async function loadSave(): Promise<HarvestSave> {
  if (!inTauri()) return defaultSave();
  const text = await ipcRead();
  if (!text) return defaultSave();
  try {
    const o = JSON.parse(text) as Partial<HarvestSave>;
    return { ...defaultSave(), ...o };
  } catch {
    return defaultSave();
  }
}

export async function persistSave(save: HarvestSave): Promise<void> {
  if (!inTauri()) return;
  await ipcWrite(JSON.stringify(save, null, 2));
}
