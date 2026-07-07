/**
 * Author the ground tile sprites (grass/dirt/wood/wall/tilled) to match the
 * character-sprite look: 3-tone shading (shadow/base/light), warm palettes, and
 * real structure instead of flat 2-tone noise. Emits assets/<name>.json — normal
 * tile sprite projects — then `npm run gen` compiles them like any other sprite.
 *
 *   npx tsx scripts/make-tiles.ts && npm run gen
 *
 * Palette index convention (per tile): 0 = transparent, then material tones.
 * Deterministic: a seeded PRNG makes the organic scatter reproducible, so a
 * re-run reproduces byte-identical frames.
 *
 * Flip policy: grass/dirt are directionless → tileFlip "hv" for per-cell variety
 * when laid in a map. wood/wall/tilled carry directional light (plank/brick/
 * furrow edges), so they are "h" only — a vertical flip would light them wrong.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");
const N = 16; // TILE_PX

/** Seeded PRNG (mulberry32) — deterministic organic scatter. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Grid = number[]; // N*N palette indices
const make = (fill: number): Grid => new Array(N * N).fill(fill);
const set = (g: Grid, x: number, y: number, v: number) => {
  if (x >= 0 && x < N && y >= 0 && y < N) g[y * N + x] = v;
};

interface TileArt {
  name: string;
  colors: number[]; // palette, index 0 transparent
  frame: Grid;
  /** "none" for structured props (trough) that must not random-mirror. */
  tileFlip: "hv" | "h" | "none";
}

const hline = (g: Grid, y: number, x0: number, x1: number, v: number) => {
  for (let x = x0; x <= x1; x++) set(g, x, y, v);
};
const vline = (g: Grid, x: number, y0: number, y1: number, v: number) => {
  for (let y = y0; y <= y1; y++) set(g, x, y, v);
};

/** Grass: warm meadow green, base fill with small 3-tone tufts + rare flowers. */
function grass(): TileArt {
  const [SHADOW, BASE, LIGHT, FLOWER] = [1, 2, 3, 4];
  const g = make(BASE);
  const r = rng(0x6a55);
  // Small tufts: a light blade tip with a shadow pixel beside it (roughly
  // symmetric so it survives mirroring), scattered but not gridded.
  for (let i = 0; i < 22; i++) {
    const x = Math.floor(r() * N), y = Math.floor(r() * N);
    set(g, x, y, LIGHT);
    if (r() < 0.7) set(g, x + (r() < 0.5 ? 1 : -1), y, SHADOW);
    if (r() < 0.4) set(g, x, y + 1, LIGHT);
  }
  for (let i = 0; i < 10; i++) set(g, Math.floor(r() * N), Math.floor(r() * N), SHADOW);
  // One tiny flower speck for life (kept sparse so a field isn't polka-dot).
  set(g, Math.floor(r() * N), Math.floor(r() * N), FLOWER);
  return { name: "grass", colors: [0x000000, 0x33602a, 0x4c8a38, 0x66a84a, 0xf0c84a], frame: g, tileFlip: "hv" };
}

/** Dirt: warm soil, base fill with scattered clods (light clump + shadow side). */
function dirt(): TileArt {
  const [SHADOW, BASE, LIGHT] = [1, 2, 3];
  const g = make(BASE);
  const r = rng(0xd1a7);
  for (let i = 0; i < 12; i++) {
    const x = Math.floor(r() * N), y = Math.floor(r() * N);
    set(g, x, y, LIGHT);
    if (r() < 0.6) set(g, x + 1, y, LIGHT);
    if (r() < 0.7) set(g, x, y + 1, SHADOW);
    if (r() < 0.4) set(g, x - 1, y + 1, SHADOW);
  }
  for (let i = 0; i < 14; i++) set(g, Math.floor(r() * N), Math.floor(r() * N), SHADOW);
  return { name: "dirt", colors: [0x000000, 0x593218, 0x7a4a24, 0x976036], frame: g, tileFlip: "hv" };
}

/** Wood: horizontal planks — light top edge, shadow seam at the bottom, grain
 *  dashes, offset butt joints. Plank height 4px → 4 planks per tile. */
function wood(): TileArt {
  const [SEAM, BASE, LIGHT, GRAIN] = [1, 2, 3, 4];
  const g = make(BASE);
  const r = rng(0x0d);
  const PH = 4; // plank height
  for (let p = 0; p < N / PH; p++) {
    const top = p * PH;
    for (let x = 0; x < N; x++) {
      set(g, x, top, LIGHT);          // highlit top edge
      set(g, x, top + PH - 1, SEAM);  // shadow groove between planks
    }
    // Grain: a few horizontal dashes in the plank body.
    for (let i = 0; i < 3; i++) {
      const gy = top + 1 + Math.floor(r() * (PH - 2));
      const gx = Math.floor(r() * (N - 3));
      for (let k = 0; k < 2 + Math.floor(r() * 2); k++) set(g, gx + k, gy, GRAIN);
    }
    // One vertical butt joint per plank, offset so joints don't line up.
    const jx = Math.floor(r() * N);
    for (let y = top; y < top + PH; y++) set(g, jx, y, SEAM);
  }
  return { name: "wood", colors: [0x000000, 0x5a3a20, 0x8a5c34, 0xa4703f, 0x6f4526], frame: g, tileFlip: "h" };
}

/** Wall: running-bond brick — mortar courses + vertical joints (offset every
 *  other course), a lit top edge on each brick for a touch of relief. */
function wall(): TileArt {
  const [MORTAR, BASE, LIGHT] = [1, 2, 3];
  const g = make(BASE);
  const CH = 4;      // course height (incl. mortar)
  const BW = 8;      // brick width
  for (let cy = 0; cy < N / CH; cy++) {
    const top = cy * CH;
    for (let x = 0; x < N; x++) set(g, x, top + CH - 1, MORTAR); // mortar bed
    const offset = cy % 2 ? BW / 2 : 0; // running bond: every other course shifts
    for (let bx = -BW; bx < N; bx += BW) {
      const jx = bx + offset;
      for (let y = top; y < top + CH; y++) set(g, jx, y, MORTAR); // vertical joint
      for (let x = jx + 1; x < jx + BW && x < N; x++) set(g, x, top, LIGHT); // lit top
    }
  }
  return { name: "wall", colors: [0x000000, 0x3a2a1a, 0x6e5236, 0x86654a], frame: g, tileFlip: "h" };
}

/** Tilled: parallel plowed furrows — a lit ridge, base, then a shadow groove,
 *  repeating so it tiles into continuous rows. */
function tilled(): TileArt {
  const [GROOVE, BASE, RIDGE] = [1, 2, 3];
  const g = make(BASE);
  for (let y = 0; y < N; y++) {
    const phase = y % 4;
    const v = phase === 0 ? RIDGE : phase === 2 ? GROOVE : BASE;
    for (let x = 0; x < N; x++) set(g, x, y, v);
  }
  return { name: "tilled", colors: [0x000000, 0x4a2a16, 0x7a4a24, 0x976036], frame: g, tileFlip: "h" };
}

/**
 * Hay trough: a 2-tile-tall, 3-part wooden feeder. Top tiles hold the back lip +
 * heaped hay (strands poke into the transparent rows above); bottom tiles are the
 * front board. Left/right caps close the ends. Placed on the barn's ABOVE layer
 * so animals nosing up to it are drawn behind — they read as feeding.
 *
 * Palette: 0 transparent, 1 outline, 2 wood_dk, 3 wood, 4 wood_lt, 5 hay_dk,
 * 6 hay, 7 hay_lt.
 */
function trough(): TileArt[] {
  const [O, WD, W, WL, HD, H, HL] = [1, 2, 3, 4, 5, 6, 7];
  const colors = [0x000000, 0x2e2016, 0x5a3a20, 0x835530, 0xa4703f, 0xc79a3f, 0xe0bb52, 0xf3db84];
  const r = rng(0x77a9);

  // Fill the hay body of a top tile between cols [x0,x1]. A deep shadow band just
  // inside the back lip gives the trough visible depth (a well, not a shelf).
  const hayTop = (g: Grid, x0: number, x1: number) => {
    for (let i = 0; i < 5; i++) { // strands poking above the rim
      const x = x0 + Math.floor(r() * (x1 - x0 + 1));
      set(g, x, 2, HL); set(g, x, 3, H);
    }
    hline(g, 4, x0, x1, WL); // back lip highlight
    hline(g, 5, x0, x1, W);  // back lip
    hline(g, 6, x0, x1, O);  // deep shadow inside the lip — the trough well
    hline(g, 7, x0, x1, WD); // inner wall in shade
    for (let y = 8; y < N; y++) hline(g, y, x0, x1, H); // hay fill
    for (let i = 0; i < 14; i++) set(g, x0 + Math.floor(r() * (x1 - x0 + 1)), 8 + Math.floor(r() * 8), HD);
    for (let i = 0; i < 10; i++) set(g, x0 + Math.floor(r() * (x1 - x0 + 1)), 8 + Math.floor(r() * 8), HL);
  };
  // Front board of a bottom tile between cols [x0,x1]: a low hay crest, a shadow
  // seam, then a tall front board so the feeder reads as deep.
  const boardBot = (g: Grid, x0: number, x1: number) => {
    for (let y = 0; y < 4; y++) hline(g, y, x0, x1, H); // hay crest at the top
    for (let i = 0; i < 7; i++) set(g, x0 + Math.floor(r() * (x1 - x0 + 1)), Math.floor(r() * 4), HD);
    hline(g, 4, x0, x1, HD);   // hay settles
    hline(g, 5, x0, x1, O);    // shadow seam: hay meets the inner board (depth)
    hline(g, 6, x0, x1, WL);   // front board top edge (lit)
    for (let y = 7; y <= 14; y++) hline(g, y, x0, x1, W); // tall front board
    for (let i = 0; i < 7; i++) { // grain
      const gx = x0 + Math.floor(r() * (x1 - x0 - 1));
      const gy = 8 + Math.floor(r() * 6);
      set(g, gx, gy, WD); set(g, gx + 1, gy, WD);
    }
    hline(g, 15, x0, x1, O);    // bottom outline
  };
  // A dark corner POST on cols [x0,x1], full tile height so it rises above the
  // rim (a real end post). Darker than the boards for definition.
  const endPost = (g: Grid, x0: number, x1: number, outerLeft: boolean) => {
    for (let x = x0; x <= x1; x++) vline(g, x, 0, 15, WD); // full-height dark post
    vline(g, outerLeft ? x0 : x1, 0, 15, O);               // outer outline
    const inner = outerLeft ? x1 : x0;
    set(g, inner, 0, WL); set(g, inner, 1, WL);            // catch light at the top
  };

  const mkTop = (kind: "l" | "m" | "r"): Grid => {
    const g = make(0);
    if (kind === "l") { hayTop(g, 2, N - 1); endPost(g, 0, 1, true); }
    else if (kind === "r") { hayTop(g, 0, N - 3); endPost(g, N - 2, N - 1, false); }
    else hayTop(g, 0, N - 1);
    return g;
  };
  const mkBot = (kind: "l" | "m" | "r"): Grid => {
    const g = make(0);
    if (kind === "l") { boardBot(g, 2, N - 1); endPost(g, 0, 1, true); }
    else if (kind === "r") { boardBot(g, 0, N - 3); endPost(g, N - 2, N - 1, false); }
    else boardBot(g, 0, N - 1);
    return g;
  };

  const parts: TileArt[] = [];
  for (const k of ["l", "m", "r"] as const) {
    parts.push({ name: `trough_${k}`, colors, frame: mkTop(k), tileFlip: "none" });
    parts.push({ name: `trough_${k}_b`, colors, frame: mkBot(k), tileFlip: "none" });
  }
  return parts;
}

/** A small hanging lantern for the barn ceiling: chain, metal frame, warm glass
 *  with a hot core. Drawn directly (not laid in a map); the barn adds its glow. */
function lantern(): TileArt {
  const [O, M, ML, G, GL, CH] = [1, 2, 3, 4, 5, 6];
  const colors = [0x000000, 0x2a2018, 0x6a5230, 0x9a7a44, 0xf0c040, 0xfff0a0, 0x7a6a4a];
  const g = make(0);
  vline(g, 8, 0, 2, CH);                       // chain from the ceiling
  hline(g, 3, 6, 9, M); set(g, 6, 3, O); set(g, 9, 3, O);         // top cap
  hline(g, 4, 5, 10, M); set(g, 5, 4, O); set(g, 10, 4, O);       // shoulders
  set(g, 7, 4, ML); set(g, 8, 4, ML);
  for (let y = 5; y <= 11; y++) {              // body: side frames + glass
    set(g, 5, y, O); set(g, 10, y, O);
    for (let x = 6; x <= 9; x++) set(g, x, y, G);
  }
  for (let y = 7; y <= 9; y++) for (let x = 7; x <= 8; x++) set(g, x, y, GL); // hot core
  hline(g, 12, 5, 10, M); set(g, 5, 12, O); set(g, 10, 12, O);    // bottom cap
  hline(g, 13, 6, 9, M);
  set(g, 7, 14, O); set(g, 8, 14, O);          // finial
  return { name: "lantern", colors, frame: g, tileFlip: "none" };
}

function emit(t: TileArt): void {
  const project: Record<string, unknown> = {
    name: t.name,
    width: N,
    height: N,
    depth: 4,
    palettes: [{ name: "base", rarity: "common", colors: t.colors }],
    frames: [t.frame],
    clips: {},
    kind: "tile",
  };
  if (t.tileFlip !== "none") project.tileFlip = t.tileFlip;
  writeFileSync(join(ASSETS, `${t.name}.json`), JSON.stringify(project, null, 2));
  console.log(`✓ assets/${t.name}.json  ${N}×${N}  ${t.colors.length - 1} tones  flip=${t.tileFlip}`);
}

for (const t of [grass(), dirt(), wood(), wall(), tilled(), ...trough(), lantern()]) emit(t);
