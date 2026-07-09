/**
 * Author the ambient wandering critters (cat, dog, squirrel) as 16x16 sprites
 * and write them to assets/*.json in the same schema the editor exports, so
 * `npm run gen` turns them into src/generated/*.ts like every other sprite.
 *
 * Art is defined as ASCII grids below; the char map picks a palette slot:
 *   '.' transparent  'B' body   'o' outline  'L' light   'a' accent
 *   'd' dark (stripe/patch/tail)  'e' eye
 * Re-run with:  npx tsx scripts/make-critters.ts   (then npm run gen)
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");

const CH: Record<string, number> = { ".": 0, "B": 1, "o": 2, "L": 3, "a": 4, "d": 5, "e": 6 };

/** Build one sprite JSON from a palette + ASCII rows; validates the grid. */
function make(name: string, colors: number[], rows: string[]): void {
  if (rows.length !== 16) throw new Error(`${name}: expected 16 rows, got ${rows.length}`);
  const frame: number[] = [];
  rows.forEach((r, y) => {
    if (r.length !== 16) throw new Error(`${name}: row ${y} is ${r.length} chars, expected 16 -> "${r}"`);
    for (const ch of r) {
      const idx = CH[ch];
      if (idx === undefined) throw new Error(`${name}: bad char "${ch}" in row ${y}`);
      frame.push(idx);
    }
  });
  const project = {
    name,
    width: 16,
    height: 16,
    depth: 4,
    palettes: [{ name: "base", rarity: "common", colors }],
    frames: [frame],
    clips: {},
  };
  writeFileSync(join(ASSETS, `${name}.json`), JSON.stringify(project, null, 2));
  console.log(`✓ wrote assets/${name}.json`);
}

const hex = (n: number) => n; // colors are already 0xRRGGBB ints

// slots: 0 transparent, 1 body, 2 outline, 3 light, 4 accent, 5 dark, 6 eye
// --- CAT: orange tabby, sitting, front 3/4 ---
make("cat", [
  0, hex(0xe0842c), hex(0x241a10), hex(0xf2d2a0), hex(0xe87890), hex(0xa85818), hex(0x1a2a1a),
], [
  "................",
  "..o......o......",
  ".oBo....oBo.....",
  ".oaBo..oBao.....",
  ".oBBBBBBBBBo....",
  ".oBeBBBBeBBo....",
  ".oBBBBaBBBBo....",
  ".oBBLLLLLLBo....",
  "..oBBBBBBBBo....",
  "..oBLLLLLLBo..d.",
  "..oBLLLLLLBoddd.",
  "..oBBBBBBBBodd..",
  "..oBBoBBoBBo....",
  "..oBo..oBo......",
  "..ooo..ooo......",
  "................",
]);

// --- DOG: brown, floppy ears, sitting ---
make("dog", [
  0, hex(0x9a6636), hex(0x241a10), hex(0xc89a64), hex(0x1a1a1a), hex(0x70441e), hex(0x1a1a1a),
], [
  "................",
  "...oBBBBo.......",
  "..oBBBBBBo......",
  ".odBBBBBBdo.....",
  ".odBeBBeBdo.....",
  ".odBBBaBBdo.....",
  ".odBLLLLLBdo....",
  ".oddBLaLBddo....",
  "..oBBBBBBBBo....",
  "..oBBBBBBBBo..d.",
  "..oBLLLLLLBoddd.",
  "..oBBBBBBBBod...",
  "..oBBoBBoBBo....",
  "..oBo..oBo......",
  "..ooo..ooo......",
  "................",
]);

// --- SQUIRREL: red-brown, big bushy tail arcing up on the right ---
make("squirrel", [
  0, hex(0x9a6a3a), hex(0x241a10), hex(0xd8b888), hex(0x1a1a1a), hex(0x7a4a24), hex(0x1a1a1a),
], [
  ".........odo....",
  "........odddo...",
  "..oBo...oddddo..",
  ".oBBBo..oddddo..",
  ".oBeBBo.oddddo..",
  ".oBaBBo.oddddo..",
  ".oBLLBo.odddo...",
  "..oBBBoodddo....",
  "..oBLLBddddo....",
  "..oBLLBoddo.....",
  "..oBBBBoo.......",
  "..oBBBBo........",
  "..oBBBBo........",
  "..oBoBBo........",
  "..oo.oo.........",
  "................",
]);
