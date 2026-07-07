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
/** Horizontal mirror of a tile (for building a right cap from a left one). */
const mirror = (g: Grid): Grid => {
  const o = make(0);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) o[y * N + (N - 1 - x)] = g[y * N + x];
  return o;
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

/** Tilled: plowed furrows — a lit ridge then a soft shadow groove per 4px, with
 *  scattered soil clods so it reads as loose earth (not planks). */
function tilled(): TileArt {
  const [GROOVE, BASE, RIDGE, CLOD] = [1, 2, 3, 4];
  const g = make(BASE);
  const r = rng(0x71c3);
  for (let y = 0; y < N; y++) {
    const phase = y % 4;
    const v = phase === 0 ? RIDGE : phase === 3 ? GROOVE : BASE; // ridge, base, base, groove
    for (let x = 0; x < N; x++) set(g, x, y, v);
  }
  for (let i = 0; i < 20; i++) set(g, Math.floor(r() * N), Math.floor(r() * N), CLOD); // soil clods
  return { name: "tilled", colors: [0x000000, 0x5a3418, 0x7a4a24, 0x926030, 0x452818], frame: g, tileFlip: "h" };
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

/**
 * A cozy farmhouse as a 5×4 grid of tiles: a shingled hip roof (2 rows, sloped
 * ends), tan walls with two windows and a central door (2 rows). Placed on the
 * farm map by name; drawn under entities. Palette: 0 transparent, 1 outline,
 * 2 roof_dk, 3 roof, 4 roof_lt, 5 wall_dk, 6 wall, 7 wall_lt, 8 wood_dk, 9 wood,
 * 10 glass.
 */
function house(): TileArt[] {
  const [O, RD, R, RL, WD, W, WL, DD, D, G, BR, SM] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  const colors = [0x000000, 0x2a1e16, 0x8a3a2a, 0xb0503a, 0xc86a4a, 0xb89a6a, 0xd8bd88, 0xeeddb0, 0x5a3a20, 0x835530, 0x6ab0d0, 0x7a4436, 0xd8d4c8];
  const shingle = (y: number): number => (y % 3 === 0 ? RD : y % 3 === 1 ? RL : R); // banded shingles

  // --- roof ---
  const mkRTM = (): Grid => { const g = make(0); for (let y = 0; y < N; y++) hline(g, y, 0, N - 1, shingle(y)); hline(g, 0, 0, N - 1, O); return g; };
  const mkRTL = (): Grid => {
    const g = make(0);
    for (let y = 0; y < N; y++) { const start = y < 4 ? 4 - y : 0; for (let x = start; x < N; x++) set(g, x, y, shingle(y)); set(g, start, y, O); }
    hline(g, 0, 4, N - 1, O); // ridge cap right of the slope
    return g;
  };
  const mkRBM = (): Grid => { const g = make(0); for (let y = 0; y < N; y++) hline(g, y, 0, N - 1, shingle(y)); hline(g, 15, 0, N - 1, O); hline(g, 14, 0, N - 1, RD); return g; };
  const mkRBL = (): Grid => { const g = mkRBM(); vline(g, 0, 0, N - 1, O); return g; };

  // Chimney: sits on the map row above the roof; brick stack + a few smoke puffs.
  const mkCHIM = (): Grid => {
    const g = make(0);
    for (let y = 7; y < N; y++) for (let x = 5; x <= 10; x++) set(g, x, y, BR);        // stack
    for (let y = 9; y < N; y += 2) hline(g, y, 6, 9, O);                               // mortar courses
    vline(g, 5, 7, N - 1, O); vline(g, 10, 7, N - 1, O);                               // sides
    hline(g, 6, 4, 11, WD); hline(g, 5, 4, 11, O);                                     // cap
    for (const [x, y] of [[8, 4], [8, 3], [7, 2], [9, 1], [9, 0]]) set(g, x, y, SM);   // smoke
    return g;
  };

  // --- walls (clapboard siding, eave trim, stone foundation) ---
  const clap = (g: Grid): void => { for (const y of [4, 7, 10]) hline(g, y, 0, N - 1, WD); }; // siding seams
  const wallRow = (g: Grid): void => { for (let y = 0; y < N; y++) hline(g, y, 0, N - 1, W); };
  const mkWMT = (): Grid => { const g = make(0); wallRow(g); clap(g); hline(g, 0, 0, N - 1, WD); hline(g, 1, 0, N - 1, WL); return g; }; // eave shadow + trim board
  const mkWTL = (): Grid => { const g = mkWMT(); vline(g, 0, 0, N - 1, O); vline(g, 1, 2, N - 1, WD); return g; };
  const mkWIN = (): Grid => {
    const g = mkWMT();
    for (let y = 4; y <= 11; y++) { set(g, 2, y, WD); set(g, 3, y, WD); set(g, 12, y, WD); set(g, 13, y, WD); } // shutters
    for (let y = 3; y <= 11; y++) for (let x = 4; x <= 11; x++) set(g, x, y, DD);      // frame
    for (let y = 4; y <= 10; y++) for (let x = 5; x <= 10; x++) set(g, x, y, G);       // glass
    vline(g, 7, 4, 10, DD); vline(g, 8, 4, 10, DD); hline(g, 7, 5, 10, DD);            // mullions
    set(g, 5, 4, WL); set(g, 6, 4, WL);                                                // glint
    return g;
  };
  const foundation = (g: Grid): void => { hline(g, 13, 0, N - 1, WD); hline(g, 14, 0, N - 1, WD); hline(g, 15, 0, N - 1, O); }; // stone base + ground
  const mkWMB = (): Grid => { const g = make(0); wallRow(g); clap(g); foundation(g); return g; };
  const mkWBL = (): Grid => { const g = mkWMB(); vline(g, 0, 0, N - 1, O); vline(g, 1, 0, 12, WD); return g; };
  const mkDOOR = (): Grid => {
    const g = make(0); wallRow(g); clap(g); foundation(g);
    for (let y = 1; y <= 15; y++) for (let x = 3; x <= 12; x++) set(g, x, y, DD);      // wide frame
    for (let y = 2; y <= 15; y++) for (let x = 4; x <= 11; x++) set(g, x, y, D);       // door slab
    hline(g, 1, 3, 12, WL);                                                            // lintel
    hline(g, 8, 4, 11, DD); vline(g, 7, 2, 15, WD); vline(g, 8, 2, 15, WD);            // panels + center seam
    set(g, 10, 9, WL); set(g, 10, 8, O);                                               // knob
    hline(g, 15, 3, 12, WD);                                                           // stone step
    return g;
  };

  return [
    { name: "house_chim", colors, frame: mkCHIM(), tileFlip: "none" },
    { name: "house_rtl", colors, frame: mkRTL(), tileFlip: "none" },
    { name: "house_rtm", colors, frame: mkRTM(), tileFlip: "none" },
    { name: "house_rtr", colors, frame: mirror(mkRTL()), tileFlip: "none" },
    { name: "house_rbl", colors, frame: mkRBL(), tileFlip: "none" },
    { name: "house_rbm", colors, frame: mkRBM(), tileFlip: "none" },
    { name: "house_rbr", colors, frame: mirror(mkRBL()), tileFlip: "none" },
    { name: "house_wtl", colors, frame: mkWTL(), tileFlip: "none" },
    { name: "house_wmt", colors, frame: mkWMT(), tileFlip: "none" },
    { name: "house_wtr", colors, frame: mirror(mkWTL()), tileFlip: "none" },
    { name: "house_win", colors, frame: mkWIN(), tileFlip: "none" },
    { name: "house_wbl", colors, frame: mkWBL(), tileFlip: "none" },
    { name: "house_wmb", colors, frame: mkWMB(), tileFlip: "none" },
    { name: "house_wbr", colors, frame: mirror(mkWBL()), tileFlip: "none" },
    { name: "house_door", colors, frame: mkDOOR(), tileFlip: "none" },
  ];
}

/** Slice a 2N×2N grid into the 4 quadrant tiles (tl, tr, bl, br). */
function quad(big: number[], S: number, names: [string, string, string, string], colors: number[]): TileArt[] {
  const cut = (ox: number, oy: number): Grid => { const t = make(0); for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) t[y * N + x] = big[(oy + y) * S + (ox + x)]; return t; };
  const q: [number, number][] = [[0, 0], [N, 0], [0, N], [N, N]];
  return names.map((name, i) => ({ name, colors, frame: cut(q[i][0], q[i][1]), tileFlip: "none" as const }));
}

/** A leafy tree: a bumpy multi-lobe canopy (darker than grass, outlined, lit from
 *  the upper-left) over a thick bark trunk. 2×2 tiles. */
function tree(): TileArt[] {
  const S = 2 * N;
  const [O, TD, TB, TH, LD, L, LH] = [1, 2, 3, 4, 5, 6, 7];
  const colors = [0x000000, 0x122a0d, 0x4a2e18, 0x6b4423, 0x8a5a30, 0x24541f, 0x336b28, 0x4e9a3e];
  const g = new Array(S * S).fill(0);
  const s2 = (x: number, y: number, v: number) => { if (x >= 0 && x < S && y >= 0 && y < S) g[y * S + x] = v; };
  const at = (x: number, y: number): number => (x >= 0 && x < S && y >= 0 && y < S ? g[y * S + x] : 0);
  // Canopy = union of overlapping lobes → an organic, bumpy silhouette. Sits a
  // few px below the top edge so the crown reads rounded, not clipped flat.
  const lobes: [number, number, number][] = [[10, 14, 7], [22, 14, 7], [16, 9, 8], [8, 20, 6], [24, 20, 6], [16, 18, 10]];
  const inCanopy = (x: number, y: number): boolean => lobes.some(([lx, ly, r]) => { const dx = x - lx + 0.5, dy = y - ly + 0.5; return dx * dx + dy * dy <= r * r; });
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    if (!inCanopy(x, y)) continue;
    const s = (x - 16) + (y - 15);            // diagonal light ramp (upper-left bright)
    s2(x, y, s < -8 ? LH : s > 10 ? LD : L);
  }
  const rr = rng(0x7ee1);
  for (let i = 0; i < 55; i++) { const x = Math.floor(rr() * S), y = Math.floor(rr() * S); if (at(x, y) === L) s2(x, y, rr() < 0.5 ? LD : LH); }
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) { // outline the canopy edge
    if (at(x, y) && (!inCanopy(x - 1, y) || !inCanopy(x + 1, y) || !inCanopy(x, y - 1) || !inCanopy(x, y + 1))) s2(x, y, O);
  }
  for (let y = 25; y < S; y++) {              // trunk (6px wide, bark-shaded)
    for (let x = 13; x <= 18; x++) s2(x, y, x <= 14 ? TD : x <= 16 ? TB : TH);
    s2(12, y, O); s2(19, y, O);
  }
  s2(13, S - 1, O); s2(18, S - 1, O);
  for (let y = 27; y < S; y += 3) s2(15, y, TD); // bark grain
  return quad(g, S, ["tree_tl", "tree_tr", "tree_bl", "tree_br"], colors);
}

/** A stone well: a peaked shingled roof on two posts, a thick 3-tone stone rim
 *  around a small water pool, and a bucket on a rope. 2×2 tiles. */
function well(): TileArt[] {
  const S = 2 * N;
  const [O, WO, W, WH, SD, ST, SH, AD, AQ, AH] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const colors = [0x000000, 0x2e1e12, 0x5a3a20, 0x835530, 0xa4703f, 0x5c5c56, 0x8a8a80, 0xb6b6ac, 0x2a6a9c, 0x3f8ec8, 0x7ac0e8];
  const g = new Array(S * S).fill(0);
  const s2 = (x: number, y: number, v: number) => { if (x >= 0 && x < S && y >= 0 && y < S) g[y * S + x] = v; };
  // Stone body: thick rim (lit upper-left) around a water pool with a rounded
  // glint (upper-left) and a deeper ring near the rim — no hard tonal split.
  const bx = 16, by = 24, rx = 12, ry = 8;
  for (let y = 15; y < S; y++) for (let x = 0; x < S; x++) {
    const dx = (x - bx + 0.5) / rx, dy = (y - by + 0.5) / ry, d = Math.hypot(dx, dy);
    if (d > 1) continue;
    if (d > 0.58) { s2(x, y, d > 0.9 ? O : (x < bx && y < by) ? SH : (x > bx && y > by) ? SD : ST); continue; }
    const gx = x - (bx - 4), gy = y - (by - 3);          // glint centre, upper-left
    s2(x, y, gx * gx + gy * gy < 11 ? AH : d > 0.46 ? AD : AQ);
  }
  // Peaked gable roof, starting a couple rows down so the peak isn't clipped.
  for (let y = 2; y <= 10; y++) { const half = Math.round((y - 2) * 1.4); for (let x = bx - half; x <= bx + half; x++) s2(x, y, y % 2 ? WO : W); s2(bx - half, y, O); s2(bx + half, y, O); }
  for (let x = bx - 12; x <= bx + 12; x++) s2(x, 10, O);           // eave line
  for (let y = 3; y <= 6; y++) s2(bx, y, WH);                       // ridge highlight
  for (let y = 11; y <= 16; y++) { s2(6, y, WO); s2(7, y, W); s2(24, y, W); s2(25, y, WO); } // posts
  for (let x = 7; x <= 25; x++) s2(x, 15, W);                       // a crossbeam between the posts
  for (let x = 7; x <= 25; x++) s2(x, 14, WH);
  return quad(g, S, ["well_tl", "well_tr", "well_bl", "well_br"], colors);
}

/** A wild-flower cluster to sprinkle on the grass: a few stemmed blooms in
 *  varied colors (transparent elsewhere). */
function flower(): TileArt {
  const [STEM, LEAF, RED, YEL, WHT, CTR] = [1, 2, 3, 4, 5, 6];
  const colors = [0x000000, 0x2f6a2a, 0x46953a, 0xe23b3b, 0xf5cf3e, 0xf4efe2, 0xffe98a];
  const g = make(0);
  const bloom = (cx: number, cy: number, c: number) => {                 // 3×3 round bloom, yellow center
    for (let yy = -1; yy <= 1; yy++) for (let xx = -1; xx <= 1; xx++) set(g, cx + xx, cy + yy, c);
    set(g, cx, cy, CTR);
  };
  const plant = (x: number, base: number, top: number, c: number) => {
    for (let y = top + 2; y <= base; y++) set(g, x, y, STEM);
    set(g, x - 1, base - 2, LEAF); set(g, x + 1, base - 3, LEAF);
    bloom(x, top, c);
  };
  plant(4, 14, 5, RED); plant(8, 15, 7, YEL); plant(12, 13, 4, WHT);
  return { name: "flower", colors, frame: g, tileFlip: "none" };
}

/** A post-and-rail fence: a horizontal run (two rails), a vertical run, and a
 *  stout capped post placed at corners and every few tiles. */
function fence(): TileArt[] {
  const [O, FD, F, FH] = [1, 2, 3, 4];
  const colors = [0x000000, 0x3a2818, 0x7a5228, 0x9c6e38, 0xbe8a52];
  const rail = (g: Grid, y0: number) => { hline(g, y0, 0, N - 1, O); hline(g, y0 + 1, 0, N - 1, FH); hline(g, y0 + 2, 0, N - 1, F); hline(g, y0 + 3, 0, N - 1, FD); };
  const mkH = (): Grid => { const g = make(0); rail(g, 4); rail(g, 9); return g; };
  const railV = (g: Grid, x0: number) => { vline(g, x0, 0, N - 1, O); vline(g, x0 + 1, 0, N - 1, FH); vline(g, x0 + 2, 0, N - 1, F); vline(g, x0 + 3, 0, N - 1, FD); };
  const mkV = (): Grid => { const g = make(0); railV(g, 4); railV(g, 9); return g; };
  const mkPost = (): Grid => {
    const g = make(0);
    hline(g, 5, 0, N - 1, FH); hline(g, 6, 0, N - 1, F); hline(g, 10, 0, N - 1, FH); hline(g, 11, 0, N - 1, F); // rails pass through
    for (let y = 1; y <= 15; y++) for (let x = 5; x <= 10; x++) set(g, x, y, x <= 6 ? FH : x >= 9 ? FD : F); // post
    vline(g, 5, 1, 15, O); vline(g, 10, 1, 15, O); hline(g, 1, 5, 10, O); hline(g, 2, 6, 9, FH);              // outline + cap
    return g;
  };
  return [
    { name: "fence_h", colors, frame: mkH(), tileFlip: "none" },
    { name: "fence_v", colors, frame: mkV(), tileFlip: "none" },
    { name: "fence_post", colors, frame: mkPost(), tileFlip: "none" },
  ];
}

function emit(t: TileArt): void {
  // Guard the classic off-by-one: a frame index past the palette bakes as black.
  const maxIdx = t.frame.reduce((m, v) => Math.max(m, v), 0);
  if (maxIdx >= t.colors.length) throw new Error(`${t.name}: palette index ${maxIdx} but only ${t.colors.length} colors`);
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

for (const t of [grass(), dirt(), wood(), wall(), tilled(), ...trough(), lantern(), ...house(), ...tree(), ...well(), flower(), ...fence()]) emit(t);
