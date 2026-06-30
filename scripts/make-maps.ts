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

interface Layer { name: string; above?: boolean; cells: string[]; }
interface MapFile { name: string; w: number; h: number; layers: Layer[]; }

function farm(): MapFile {
  const w = 20, h = 15;
  const ground = new Array(w * h).fill("grass");
  for (let y = 0; y < h; y++) ground[y * w + 2] = "dirt"; // a vertical path
  return { name: "farm", w, h, layers: [{ name: "ground", cells: ground }] };
}

function barn(): MapFile {
  const w = 13, h = 15;
  const ground = new Array(w * h).fill("wood");
  for (let y = 0; y < 2; y++) for (let x = 0; x < w; x++) ground[y * w + x] = "wall";
  return { name: "barn", w, h, layers: [{ name: "ground", cells: ground }] };
}

if (!existsSync(ASSETS)) mkdirSync(ASSETS, { recursive: true });
for (const m of [farm(), barn()]) {
  writeFileSync(join(ASSETS, `${m.name}.map.json`), JSON.stringify(m, null, 2));
  console.log(`✓ assets/${m.name}.map.json  ${m.w}x${m.h}`);
}
