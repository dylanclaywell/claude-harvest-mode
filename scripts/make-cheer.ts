/**
 * Derive a "recipe get!" celebration frame from the base farmhand sprite: keep
 * the hat/face/torso/legs, erase the arms-at-sides, and raise both arms overhead.
 * Also emit a little recipe-paper sprite to float above. Both reuse names that let
 * `npm run gen` compile them like any other sprite.
 *
 *   npx tsx scripts/make-cheer.ts && npm run gen
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");
const N = 16;

const src = JSON.parse(readFileSync(join(ASSETS, "farmhand.json"), "utf8"));
const SKIN = 2, OUT = 5; // palette slots in farmhand.json: 2=skin, 5=dark outline

// --- cheer frame: copy the base, redo the arms ---
const cheer: number[] = (src.frames[0] as number[]).slice();
const set = (x: number, y: number, v: number) => { if (x >= 0 && x < N && y >= 0 && y < N) cheer[y * N + x] = v; };
// Erase the arms-at-sides (torso is cols 5–10; arms sit outside it, rows 9–11).
for (let y = 9; y <= 11; y++) for (const x of [1, 2, 3, 4, 11, 12, 13, 14]) set(x, y, 0);
// Raise a left arm from the shoulder up past the hat; mirror it for the right.
const armSkin: [number, number][] = [[4, 9], [4, 8], [3, 7], [3, 6], [3, 5], [2, 4], [2, 3]];
const hand: [number, number][] = [[2, 2], [3, 2], [2, 1], [3, 1]];
const armOut: [number, number][] = [[1, 3], [1, 2], [1, 1], [4, 2], [4, 1], [2, 5]];
for (const [x, y] of armSkin) { set(x, y, SKIN); set(N - 1 - x, y, SKIN); }
for (const [x, y] of hand) { set(x, y, SKIN); set(N - 1 - x, y, SKIN); }
for (const [x, y] of armOut) { set(x, y, OUT); set(N - 1 - x, y, OUT); }

writeFileSync(join(ASSETS, "farmhand_cheer.json"), JSON.stringify({
  name: "farmhand_cheer", width: N, height: N, depth: 4,
  names: src.names, palettes: src.palettes, frames: [cheer], clips: {},
}, null, 2));
console.log("✓ assets/farmhand_cheer.json  (arms raised)");

// --- recipe paper: a cream note card with a corner fold + a few text lines ---
const [T, O, P, PH, INK, FOLD] = [0, 1, 2, 3, 4, 5];
const colors = [0x000000, 0x3a2e1c, 0xf4ecd0, 0xfffbe8, 0x6a5a3a, 0xd8cba6];
const paper = new Array(N * N).fill(T);
const pset = (x: number, y: number, v: number) => { if (x >= 0 && x < N && y >= 0 && y < N) paper[y * N + x] = v; };
for (let y = 2; y <= 13; y++) for (let x = 3; x <= 12; x++) pset(x, y, P);   // page
for (let y = 2; y <= 13; y++) { pset(3, y, O); pset(12, y, O); }              // side edges
for (let x = 3; x <= 12; x++) { pset(x, 2, O); pset(x, 13, O); }              // top/bottom
for (let y = 3; y <= 5; y++) for (let x = 4; x <= 11; x++) pset(x, y, PH);    // lit upper page
for (const y of [5, 7, 9, 11]) for (let x = 5; x <= (y === 11 ? 8 : 10); x++) pset(x, y, INK); // text lines
pset(12, 2, FOLD); pset(11, 2, FOLD); pset(12, 3, FOLD);                      // dog-eared corner
writeFileSync(join(ASSETS, "recipe.json"), JSON.stringify({
  name: "recipe", width: N, height: N, depth: 4,
  palettes: [{ name: "base", rarity: "common", colors }], frames: [paper], clips: {},
}, null, 2));
console.log("✓ assets/recipe.json  (recipe card)");
