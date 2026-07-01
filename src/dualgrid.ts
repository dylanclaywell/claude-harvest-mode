// dualgrid.ts — dual-grid autotiling: resolve a boolean terrain field into
// display tiles, and GENERATE the 16-frame tileset those tiles index.
//
// A dual-grid layer stores which WORLD cells are terrain. The visible tiles sit
// on a grid offset by half a tile: each display tile covers the junction of 4
// world cells, so its look is decided by 4 corners → a 4-bit mask → 1 of 16
// frames. Draw (or generate) those 16 once and every edge / corner / inner-
// corner falls out for free — no hand-painted transitions, and no random flip
// (mirroring would break corner continuity).
//
// The 16 frames tile CORRECTLY as a raw union of 8×8 quadrant blocks (that's the
// dual-grid property). genDualFrames only rounds the block seams near each
// tile's center for an organic look; tile EDGES stay untouched, so neighbours
// still meet seamlessly.

import { TRANSPARENT_INDEX } from "./editor/project";

// Corner bits. The frame index for a display tile is TL|TR|BL|BR of its four
// surrounding world cells, so authored/generated frame N depicts pattern N.
export const TL = 1, TR = 2, BL = 4, BR = 8;

/** Is world cell (col,row) terrain? Callers treat off-map as empty. */
export type Filled = (col: number, row: number) => boolean;

/** 0..15 frame index for the display tile centered on world corner (cx,cy). */
export function cornerMask(filled: Filled, cx: number, cy: number): number {
  return (filled(cx - 1, cy - 1) ? TL : 0)
       | (filled(cx,     cy - 1) ? TR : 0)
       | (filled(cx - 1, cy)     ? BL : 0)
       | (filled(cx,     cy)     ? BR : 0);
}

// --- tileset generation ---

export interface DualGridSpec {
  /** Tile edge in px (square). */
  size: number;
  /** size*size interior texture (palette indices), sampled for interior pixels. */
  fill: ArrayLike<number>;
  /** Corner rounding radius in px (clamped to [1, size/2 - 1]). */
  radius: number;
  /** Index for the 1px inner border; omit → interior fill runs to the edge. */
  rim?: number;
  /** Index outside terrain; default transparent (lower layers show through). */
  bg?: number;
}

/**
 * Is pixel (x,y) terrain in the tile for corner mask `m`? Raw membership is
 * "the pixel's quadrant is on"; near the center junction we round the seam:
 * an isolated on-corner (both orthogonal neighbours off) is shaved convex, a
 * true inner corner (both orthogonal neighbours AND the diagonal opposite on)
 * is filled concave. Adjacent-on quadrants form a straight edge (no rounding,
 * required to tile), and diagonal-on quadrants pinch at the center.
 */
function insideDual(m: number, x: number, y: number, size: number, r: number): boolean {
  const half = size / 2;
  const u = x + 0.5 - half; // signed distance from the junction, pixel center
  const v = y + 0.5 - half;
  const on = (bit: number) => (m & bit) !== 0;

  // The pixel's own quadrant, plus the quadrants across each mid-line (ortho)
  // and diagonally opposite — all in terms of the u/v sign quadrant it's in.
  const q       = u < 0 ? (v < 0 ? TL : BL) : (v < 0 ? TR : BR);
  const orthoU  = u < 0 ? (v < 0 ? TR : BR) : (v < 0 ? TL : BL); // across u=0
  const orthoV  = v < 0 ? (u < 0 ? BL : BR) : (u < 0 ? TL : TR); // across v=0
  const diagOpp = u < 0 ? (v < 0 ? BR : TR) : (v < 0 ? BL : TL);

  const near = Math.abs(u) < r && Math.abs(v) < r; // in the central rounding box
  const su = u < 0 ? -1 : 1, sv = v < 0 ? -1 : 1;

  if (on(q)) {
    // Isolated convex corner → shave the tip near the junction to an arc.
    if (near && !on(orthoU) && !on(orthoV)) {
      const du = u - su * r, dv = v - sv * r;
      return du * du + dv * dv <= r * r;
    }
    return true;
  }
  // Empty inner-corner notch → fill a quarter disc so ground curves into it.
  if (near && on(orthoU) && on(orthoV) && on(diagOpp)) {
    return u * u + v * v <= r * r;
  }
  return false;
}

/** An inside pixel touching an outside pixel WITHIN the tile. Dual-grid outlines
 *  always run through tile interiors, so off-tile neighbours count as inside —
 *  the map seam is never rimmed. */
function isEdge(inside: boolean[], x: number, y: number, size: number): boolean {
  return (x > 0 && !inside[y * size + x - 1]) ||
         (x < size - 1 && !inside[y * size + x + 1]) ||
         (y > 0 && !inside[(y - 1) * size + x]) ||
         (y < size - 1 && !inside[(y + 1) * size + x]);
}

/**
 * Build all 16 dual-grid frames from one interior fill + a rim + a radius, in
 * mask order (frame N = corner pattern N), ready to drop into a `kind:"tile"`
 * sprite. Coherence is by construction: every frame shares the one fill, rim,
 * and rounding, so edges/corners can't drift the way 16 hand-drawn tiles do.
 */
export function genDualFrames(spec: DualGridSpec): number[][] {
  const { size, fill } = spec;
  const bg = spec.bg ?? TRANSPARENT_INDEX;
  const r = Math.max(1, Math.min(spec.radius, size / 2 - 1));
  const frames: number[][] = [];
  for (let m = 0; m < 16; m++) {
    const inside: boolean[] = new Array(size * size);
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) inside[y * size + x] = insideDual(m, x, y, size, r);
    const frame: number[] = new Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        if (!inside[i]) { frame[i] = bg; continue; }
        frame[i] = spec.rim !== undefined && isEdge(inside, x, y, size) ? spec.rim : fill[i];
      }
    }
    frames.push(frame);
  }
  return frames;
}
