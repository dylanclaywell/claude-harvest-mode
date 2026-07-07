/**
 * Seed the starter tilemaps into assets/*.map.json (source of truth, edited
 * thereafter in tilemap.html). Re-run only to reset the starters.
 *   npx tsx scripts/make-maps.ts
 *
 * Map file: { name, w, h, layers } — each layer { name, above?, cells }, cells
 * row-major tile sprite NAMES ("" = empty). `above` draws over entities.
 */
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");

interface Layer { name: string; above?: boolean; cells: string[]; dual?: { tileset: string }; }
interface MapFile { name: string; w: number; h: number; layers: Layer[]; }

function farm(): MapFile {
  const w = 20, h = 15;
  const grass = new Array(w * h).fill("grass"); // solid grass base
  // Dual-grid dirt paths over the grass: mark path cells as terrain (any non-""
  // value). The dirt_path tileset (npx tsx scripts/make-dual.ts) draws dirt where
  // marked and stays transparent elsewhere, auto-rounding every edge/corner —
  // no hand-painted transitions. Draws UNDER entities.
  const path = new Array(w * h).fill("");
  const mark = (x: number, y: number) => { if (x >= 0 && x < w && y >= 0 && y < h) path[y * w + x] = "x"; };
  for (let y = 0; y < h; y++) mark(2, y);            // vertical path down the left
  for (let x = 2; x <= 12; x++) mark(x, 7);          // branch east to the field
  for (let y = 9; y < 13; y++) for (let x = 9; x < 14; x++) mark(x, y); // a dirt plot
  return {
    name: "farm", w, h,
    layers: [
      { name: "ground", cells: grass },
      { name: "paths", cells: path, dual: { tileset: "dirt_path" } },
    ],
  };
}

function barn(): MapFile {
  const w = 13, h = 15;
  const ground = new Array(w * h).fill("wood");
  for (let y = 0; y < 2; y++) for (let x = 0; x < w; x++) ground[y * w + x] = "wall";
  // Dual-grid straw pen over the wood floor: a bedded animal area with
  // auto-rounded edges (straw reads against the wood). Draws UNDER the animals.
  const pen = new Array(w * h).fill("");
  for (let y = 4; y < 12; y++) for (let x = 2; x < 11; x++) pen[y * w + x] = "x";
  return {
    name: "barn", w, h,
    layers: [
      { name: "ground", cells: ground },
      { name: "pen", cells: pen, dual: { tileset: "straw" } },
    ],
  };
}

if (!existsSync(ASSETS)) mkdirSync(ASSETS, { recursive: true });
for (const m of [farm(), barn()]) {
  writeFileSync(join(ASSETS, `${m.name}.map.json`), JSON.stringify(m, null, 2));
  console.log(`✓ assets/${m.name}.map.json  ${m.w}x${m.h}`);
}
