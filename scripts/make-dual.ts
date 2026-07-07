/**
 * Generate proper 16×16 dual-grid tileset assets from an existing plain tile,
 * using the SAME genDualFrames the editor uses (so editor preview and this stay
 * byte-identical). Emits assets/<name>.json — a normal tile sprite project — so
 * `npm run gen` then compiles it like any other sprite.
 *
 *   npx tsx scripts/make-dual.ts && npm run gen
 *
 * Why a script and not the editor: dual tiles MUST be TILE_PX (16px) square to
 * align in maps, and must reuse an existing tile's texture/palette so seams
 * match the plain tiles around them. Codifying that here keeps it reproducible.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { genDualFrames } from "../src/dualgrid";
import { TILE_PX } from "../src/tilemap";

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");

interface DualSpec {
  /** Output asset name → assets/<out>.json. */
  out: string;
  /** Source plain tile whose frame 0 + palette become the interior fill. */
  from: string;
  /** Corner rounding radius in px. */
  radius: number;
  /** Palette index for the 1px inner rim (a darker edge). Omit → no rim. */
  rim?: number;
  /** Recolor the source palette in place: index → new 0xRRGGBB. Lets one source
   *  tile spawn several materials (e.g. straw = dirt shape, yellow palette). */
  recolor?: Record<number, number>;
}

/** Build one dual tileset asset: terrain = the source tile, empty = transparent
 *  (so a lower layer shows through the gaps), edges/corners auto-rounded. */
function makeDual(spec: DualSpec): void {
  const src = JSON.parse(readFileSync(join(ASSETS, `${spec.from}.json`), "utf8"));
  if (src.width !== TILE_PX || src.height !== TILE_PX) {
    throw new Error(`${spec.from} is ${src.width}×${src.height}; dual tiles must be ${TILE_PX}×${TILE_PX}`);
  }
  const fill = src.frames[0] as number[]; // TILE_PX² palette indices — the interior texture
  const frames = genDualFrames({ size: TILE_PX, fill, radius: spec.radius, rim: spec.rim });
  // Reuse the source palette (indices resolve identically), optionally recolored.
  const palettes = src.palettes.map((p: { colors: number[] }) => ({
    ...p,
    colors: p.colors.map((c, i) => spec.recolor?.[i] ?? c),
  }));
  const project = {
    name: spec.out,
    width: TILE_PX,
    height: TILE_PX,
    depth: 4,
    palettes,
    frames,
    clips: {},
    kind: "tile",
    // no tileFlip: dual tiles must never random-mirror (breaks corner seams).
  };
  writeFileSync(join(ASSETS, `${spec.out}.json`), JSON.stringify(project, null, 2));
  console.log(`✓ assets/${spec.out}.json  ${TILE_PX}×${TILE_PX}  16 frames  (dual of ${spec.from})`);
}

// A dirt path/patch that auto-rounds where it meets grass below it.
makeDual({ out: "dirt_path", from: "dirt", radius: 4, rim: 7 });

// Straw bedding for the barn pen: dirt's texture recolored to yellow so it reads
// against the wood floor. Fill uses dirt indices 3/4, rim 7 (see dirt.json).
makeDual({
  out: "straw",
  from: "dirt",
  radius: 4,
  rim: 7,
  recolor: { 3: 0xc79a3f, 4: 0xd9b45a, 7: 0x8a6d2a },
});
