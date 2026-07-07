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

  // Main farm field: a block of plowed soil (rows 9–13, cols 3–9). Crops are
  // drawn on top of this by the game (see FIELD_* in src/main.ts — keep in sync).
  const field = new Array(w * h).fill("");
  for (let y = 9; y <= 13; y++) for (let x = 3; x <= 9; x++) field[y * w + x] = "tilled";

  // Dual-grid dirt paths: a main street, a spur through the field gate, and a
  // lane down the right side. The tileset auto-rounds edges/corners.
  const path = new Array(w * h).fill("");
  const mark = (x: number, y: number) => { if (x >= 0 && x < w && y >= 0 && y < h) path[y * w + x] = "x"; };
  for (let x = 2; x <= 18; x++) mark(x, 7);          // main horizontal street
  mark(6, 8);                                        // gate spur into the field
  for (let y = 8; y < h; y++) mark(12, y);           // right-side lane to the bottom

  // Everything built from named tiles shares one layer (nothing overlaps).
  const decor = new Array(w * h).fill("");
  const put = (x: number, y: number, name: string) => { if (x >= 0 && x < w && y >= 0 && y < h) decor[y * w + x] = name; };
  const block = (x0: number, y0: number, grid: string[][]) => grid.forEach((r, dy) => r.forEach((n, dx) => put(x0 + dx, y0 + dy, n)));

  // Farmhouse (5×4) at top-right + chimney above it.
  block(13, 3, [
    ["house_rtl", "house_rtm", "house_rtm", "house_rtm", "house_rtr"],
    ["house_rbl", "house_rbm", "house_rbm", "house_rbm", "house_rbr"],
    ["house_wtl", "house_win", "house_wmt", "house_win", "house_wtr"],
    ["house_wbl", "house_wmb", "house_door", "house_wmb", "house_wbr"],
  ]);
  put(14, 2, "house_chim");

  // Rail fence around the field (post corners; a gate gap at col 6, top).
  for (let x = 3; x <= 9; x++) { if (x !== 6) { put(x, 8, "fence_h"); put(x, 14, "fence_h"); } } // top (gated) + bottom
  for (let y = 9; y <= 13; y++) { put(2, y, "fence_v"); put(10, y, "fence_v"); }               // sides
  for (const [x, y] of [[2, 8], [10, 8], [2, 14], [10, 14], [6, 14]]) put(x, y, "fence_post");  // corners + bottom-mid

  // Well (2×2), a couple of trees, and scattered flowers on the grass.
  block(15, 9, [["well_tl", "well_tr"], ["well_bl", "well_br"]]);
  block(4, 2, [["tree_tl", "tree_tr"], ["tree_bl", "tree_br"]]);
  block(16, 11, [["tree_tl", "tree_tr"], ["tree_bl", "tree_br"]]);
  for (const [x, y] of [[11, 2], [1, 11], [18, 11], [12, 4], [6, 4]]) put(x, y, "flower");

  return {
    name: "farm", w, h,
    layers: [
      { name: "ground", cells: grass },
      { name: "field", cells: field },
      { name: "paths", cells: path, dual: { tileset: "dirt_path" } },
      { name: "decor", cells: decor },
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
  // Hay trough across the back of the barn (just below the wall). Drawn UNDER the
  // animals: they sit at the back wall and never go north of it, so they always
  // read as standing IN FRONT of the feeder. 2 tiles tall × 3 parts: left cap, a
  // repeated middle, right cap. Spans cols 1..11 (most of the 13-wide barn).
  const TL = 1, TR = w - 2, TOP = 2; // left cap col, right cap col, top row
  const trough = new Array(w * h).fill("");
  const put = (x: number, y: number, name: string) => { trough[y * w + x] = name; };
  for (let x = TL; x <= TR; x++) {
    const part = x === TL ? "l" : x === TR ? "r" : "m";
    put(x, TOP, `trough_${part}`);       // top: back lip + hay
    put(x, TOP + 1, `trough_${part}_b`); // bottom: front board
  }
  return {
    name: "barn", w, h,
    layers: [
      { name: "ground", cells: ground },
      { name: "pen", cells: pen, dual: { tileset: "straw" } },
      { name: "trough", cells: trough },
    ],
  };
}

if (!existsSync(ASSETS)) mkdirSync(ASSETS, { recursive: true });
for (const m of [farm(), barn()]) {
  writeFileSync(join(ASSETS, `${m.name}.map.json`), JSON.stringify(m, null, 2));
  console.log(`✓ assets/${m.name}.map.json  ${m.w}x${m.h}`);
}
