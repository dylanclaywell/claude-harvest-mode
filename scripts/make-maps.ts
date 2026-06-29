/**
 * Seed the starter tilemaps into assets/*.map.json (source of truth, edited
 * thereafter in tilemap.html). Re-run only to reset the starters.
 *   npx tsx scripts/make-maps.ts
 *
 * Map file: { name, tileset, w, h, cells } — cells are row-major tile ids
 * (= frame indices into the named tileset sprite). Tile ids for `tile`:
 *   0 grass, 1 tilled, 2 dirt, 3 wood-floor, 4 wall
 */
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");
const GRASS = 0, DIRT = 2, WOOD = 3, WALL = 4;

interface MapFile { name: string; tileset: string; w: number; h: number; cells: number[]; }

function farm(): MapFile {
  const w = 20, h = 15;
  const cells = new Array(w * h).fill(GRASS);
  for (let y = 0; y < h; y++) cells[y * w + 2] = DIRT; // a vertical path
  return { name: "farm", tileset: "tile", w, h, cells };
}

function barn(): MapFile {
  const w = 13, h = 15;
  const cells = new Array(w * h).fill(WOOD);
  for (let y = 0; y < 2; y++) for (let x = 0; x < w; x++) cells[y * w + x] = WALL;
  return { name: "barn", tileset: "tile", w, h, cells };
}

if (!existsSync(ASSETS)) mkdirSync(ASSETS, { recursive: true });
for (const m of [farm(), barn()]) {
  writeFileSync(join(ASSETS, `${m.name}.map.json`), JSON.stringify(m, null, 2));
  console.log(`✓ assets/${m.name}.map.json  ${m.w}x${m.h}`);
}
