// maps.ts — starter scene layouts, built procedurally. Tile ids index the
// `tile` tileset sprite's frames. These are placeholders until the tilemap
// editor (Phase 3) lets you author and save real *.map.json layouts.

import type { TileMap } from "./tilemap";

// Tile ids = frame indices in assets/tile.json.
export const T = { GRASS: 0, TILLED: 1, DIRT: 2, WOOD: 3, WALL: 4 } as const;

/** Full-screen farm ground: grass with a dirt path. Crops/plots draw on top. */
export function makeFarmMap(): TileMap {
  const w = 20, h = 15; // 320x240 at 16px tiles
  const cells = new Array(w * h).fill(T.GRASS);
  for (let y = 0; y < h; y++) cells[y * w + 2] = T.DIRT; // a vertical path
  return { w, h, cells };
}

/** Top-down barn interior: wood floor with a brick wall along the top. */
export function makeBarnMap(): TileMap {
  const w = 13, h = 15; // ~panel-sized (208x240)
  const cells = new Array(w * h).fill(T.WOOD);
  for (let y = 0; y < 2; y++) for (let x = 0; x < w; x++) cells[y * w + x] = T.WALL;
  return { w, h, cells };
}
