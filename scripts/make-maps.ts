/**
 * Seed the starter tilemaps into assets/*.map.json (source of truth, edited
 * thereafter in tilemap.html). Re-run only to reset the starters.
 *   npx tsx scripts/make-maps.ts
 *
 * Map file: { name, w, h, cells } — cells are row-major tile sprite NAMES
 * (each a kind="tile" sprite in assets/), "" = empty.
 */
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");

interface MapFile { name: string; w: number; h: number; cells: string[]; }

function farm(): MapFile {
  const w = 20, h = 15;
  const cells = new Array(w * h).fill("grass");
  for (let y = 0; y < h; y++) cells[y * w + 2] = "dirt"; // a vertical path
  return { name: "farm", w, h, cells };
}

function barn(): MapFile {
  const w = 13, h = 15;
  const cells = new Array(w * h).fill("wood");
  for (let y = 0; y < 2; y++) for (let x = 0; x < w; x++) cells[y * w + x] = "wall";
  return { name: "barn", w, h, cells };
}

if (!existsSync(ASSETS)) mkdirSync(ASSETS, { recursive: true });
for (const m of [farm(), barn()]) {
  writeFileSync(join(ASSETS, `${m.name}.map.json`), JSON.stringify(m, null, 2));
  console.log(`✓ assets/${m.name}.map.json  ${m.w}x${m.h}`);
}
