/**
 * Placeholder sprite generator. Emits crude-but-recognizable 8-bit sprites to
 * assets/*.json so the game has art before anything is hand-drawn in
 * editor.html. These .json files ARE the source of truth — once real art is
 * authored, delete this script (or the asset) and stop regenerating it.
 *
 * Run: npx tsx scripts/make-placeholders.ts   (then `npm run gen`)
 */
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { rgb } from "../src/color";
import { toJson, type Palette, type SpriteProject } from "../src/editor/project";

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");

// --- tiny pixel-grid helper -------------------------------------------------

class Grid {
  readonly px: number[];
  constructor(readonly w: number, readonly h: number) {
    this.px = new Array(w * h).fill(0); // 0 = transparent
  }
  set(x: number, y: number, i: number): void {
    if (x >= 0 && x < this.w && y >= 0 && y < this.h) this.px[y * this.w + x] = i;
  }
  rect(x: number, y: number, w: number, h: number, i: number): void {
    for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) this.set(x + dx, y + dy, i);
  }
  /** Draw from an ASCII map; `key` maps each non-space char to a palette index. */
  art(rows: string[], key: Record<string, number>): void {
    rows.forEach((row, y) =>
      [...row].forEach((ch, x) => {
        if (ch !== " " && ch !== ".") this.set(x, y, key[ch] ?? 0);
      }),
    );
  }
}

function project(name: string, w: number, h: number, colors: number[], frames: Grid[]): SpriteProject {
  const palettes: Palette[] = [{ name: "base", rarity: "common", colors: [0x000000, ...colors] }];
  return { name, width: w, height: h, depth: 4, palettes, frames: frames.map((g) => g.px), clips: {} };
}

// --- palettes (index 1+ ; index 0 is always transparent) --------------------
// Keep each sprite's roles small and readable.

// --- CROP: 5 growth stages -------------------------------------------------
// roles: 1 dirt-dark 2 dirt-lite 3 stem 4 leaf 5 leaf-lite 6 fruit 7 fruit-hi
const CROP_COLORS = [
  rgb(74, 42, 24), rgb(120, 78, 44),
  rgb(40, 96, 36), rgb(46, 140, 46), rgb(120, 216, 96),
  rgb(216, 40, 40), rgb(255, 140, 140),
];
function cropStage(stage: number): Grid {
  const g = new Grid(16, 16);
  // mound of soil along the bottom, present at every stage
  g.rect(2, 13, 12, 3, 1);
  g.rect(3, 12, 10, 1, 2);
  if (stage >= 1) { g.rect(7, 10, 2, 2, 3); g.set(7, 9, 4); } // sprout
  if (stage >= 2) { g.rect(7, 7, 2, 5, 3); g.set(6, 8, 4); g.set(9, 9, 4); g.set(7, 6, 5); }
  if (stage >= 3) {
    g.rect(7, 4, 2, 8, 3);
    g.art(
      [
        "                ",
        "     5    5     ",
        "    454  454    ",
        "   45445 5445   ",
      ].map((r) => r.padEnd(16)),
      { "4": 4, "5": 5 },
    );
  }
  if (stage >= 4) { // ripe: red fruit + highlight
    g.set(6, 6, 6); g.set(9, 6, 6); g.set(7, 4, 6); g.set(8, 9, 6);
    g.set(6, 5, 7); g.set(7, 3, 7);
  }
  return g;
}

// --- TILE: grass / tilled --------------------------------------------------
// roles: 1 grass-dark 2 grass-lite 3 soil-dark 4 soil-lite
const TILE_COLORS = [rgb(45, 74, 30), rgb(64, 104, 42), rgb(74, 42, 24), rgb(112, 72, 40)];
function tileGrass(): Grid {
  const g = new Grid(16, 16);
  g.rect(0, 0, 16, 16, 1);
  for (let y = 1; y < 16; y += 3) for (let x = (y % 2) + 1; x < 16; x += 4) g.set(x, y, 2);
  return g;
}
function tileTilled(): Grid {
  const g = new Grid(16, 16);
  g.rect(0, 0, 16, 16, 3);
  for (let y = 2; y < 16; y += 4) g.rect(0, y, 16, 1, 4); // furrows
  return g;
}

// --- ANIMALS ---------------------------------------------------------------
function cow(): Grid { // roles: 1 body-white 2 spot 3 outline 4 pink
  const g = new Grid(16, 16);
  g.art(
    [
      "                ",
      "   33      33   ",
      "  3113    3113  ",
      "  31111111113   ",
      " 3111221111113  ",
      " 3112221111113  ",
      " 3111111122113  ",
      " 3111111222113  ",
      " 3111111111113  ",
      "  31111111113   ",
      "  34111111143   ",
      "  34311111343   ",
      "   3 3  3 3     ",
      "                ",
      "                ",
      "                ",
    ],
    { "1": 1, "2": 2, "3": 3, "4": 4 },
  );
  return g;
}
function chicken(): Grid { // roles: 1 body-white 2 outline 3 comb-red 4 beak-yellow
  const g = new Grid(16, 16);
  g.art(
    [
      "                ",
      "       33       ",
      "      3113      ",
      "     211112     ",
      "    21111142    ",
      "    2111111 4   ",
      "    21111112    ",
      "    211111112   ",
      "   2111111112   ",
      "   21111111 2   ",
      "    222222222   ",
      "     4    4     ",
      "                ",
      "                ",
      "                ",
      "                ",
    ],
    { "1": 1, "2": 2, "3": 3, "4": 4 },
  );
  return g;
}
function sheep(): Grid { // roles: 1 wool 2 wool-shade 3 face-dark 4 leg
  const g = new Grid(16, 16);
  g.art(
    [
      "                ",
      "    11  11      ",
      "   1111111      ",
      "  111111111 33  ",
      " 11111111111333 ",
      " 11211112111333 ",
      " 11111111111 3  ",
      " 11211112111    ",
      " 11111111111    ",
      "  1112111111    ",
      "   444  444     ",
      "                ",
      "                ",
      "                ",
      "                ",
      "                ",
    ],
    { "1": 1, "2": 2, "3": 3, "4": 4 },
  );
  return g;
}

// --- FARMHAND (subagent) ---------------------------------------------------
function farmhand(): Grid { // roles: 1 hat 2 skin 3 shirt 4 pants 5 outline
  const g = new Grid(16, 16);
  g.art(
    [
      "                ",
      "     11111      ",
      "    1111111     ",
      "     22222      ",
      "     22222      ",
      "    3333333     ",
      "   333333333    ",
      "   3 33333 3    ",
      "   2 33333 2    ",
      "     33333      ",
      "     44 44      ",
      "     44 44      ",
      "     44 44      ",
      "    444 444     ",
      "                ",
      "                ",
    ],
    { "1": 1, "2": 2, "3": 3, "4": 4 },
  );
  return g;
}
const FARMHAND_COLORS = [rgb(120, 72, 40), rgb(240, 200, 160), rgb(70, 120, 200), rgb(60, 60, 90)];
const COW_COLORS = [rgb(245, 245, 245), rgb(40, 36, 34), rgb(30, 26, 24), rgb(240, 150, 160)];
const CHICKEN_COLORS = [rgb(250, 250, 230), rgb(60, 50, 30), rgb(220, 40, 40), rgb(240, 180, 40)];
const SHEEP_COLORS = [rgb(238, 238, 230), rgb(190, 190, 185), rgb(50, 44, 40), rgb(70, 60, 50)];

// --- ICONS 8x8 -------------------------------------------------------------
function coin(): Grid { // roles: 1 gold 2 gold-hi 3 gold-shade
  const g = new Grid(8, 8);
  g.art(
    [
      "  3333  ",
      " 311113 ",
      "3112113 ",
      "3121113 ",
      "3111113 ",
      "3111113 ",
      " 311113 ",
      "  3333  ",
    ],
    { "1": 1, "2": 2, "3": 3 },
  );
  return g;
}
function heart(): Grid { // roles: 1 red 2 hi
  const g = new Grid(8, 8);
  g.art(
    [
      " 11  11 ",
      "1121 112",
      "11111111",
      "11111111",
      " 111111 ",
      "  1111  ",
      "   11   ",
      "        ",
    ],
    { "1": 1, "2": 2 },
  );
  return g;
}
const COIN_COLORS = [rgb(240, 200, 40), rgb(255, 240, 160), rgb(180, 130, 20)];
const HEART_COLORS = [rgb(220, 40, 50), rgb(255, 150, 160)];

// --- emit ------------------------------------------------------------------

const sprites: SpriteProject[] = [
  project("crop", 16, 16, CROP_COLORS, [0, 1, 2, 3, 4].map(cropStage)),
  project("tile", 16, 16, TILE_COLORS, [tileGrass(), tileTilled()]),
  project("cow", 16, 16, COW_COLORS, [cow()]),
  project("chicken", 16, 16, CHICKEN_COLORS, [chicken()]),
  project("sheep", 16, 16, SHEEP_COLORS, [sheep()]),
  project("farmhand", 16, 16, FARMHAND_COLORS, [farmhand()]),
  project("coin", 8, 8, COIN_COLORS, [coin()]),
  project("heart", 8, 8, HEART_COLORS, [heart()]),
];

if (!existsSync(ASSETS)) mkdirSync(ASSETS, { recursive: true });
for (const s of sprites) {
  writeFileSync(join(ASSETS, `${s.name}.json`), toJson(s));
  console.log(`✓ assets/${s.name}.json  ${s.width}x${s.height}  ${s.frames.length}f`);
}
console.log(`Wrote ${sprites.length} placeholder sprites.`);
