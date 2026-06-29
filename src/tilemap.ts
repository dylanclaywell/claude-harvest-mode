// tilemap.ts — a scene as a grid of tile ids. A tile id is a FRAME INDEX into a
// tileset sprite (frames = 16x16 tiles, authored in the editor like any sprite).
// Maps are static, so the whole map bakes once to an offscreen canvas and then
// blits in one drawImage — dynamic stuff (crops, animals) draws on top.

import { drawSprite, type GenSprite } from "./sprites";

export const TILE_PX = 16;

export interface TileMap {
  w: number;          // width in tiles
  h: number;          // height in tiles
  cells: number[];    // row-major tile ids (= tileset frame indices)
}

// map -> scale -> baked canvas. Maps are immutable at runtime; the editor will
// invalidate by handing over a fresh map object (new WeakMap key).
const baked = new WeakMap<TileMap, Map<number, HTMLCanvasElement>>();

function bake(map: TileMap, tileset: GenSprite, scale: number): HTMLCanvasElement {
  const cv = document.createElement("canvas");
  cv.width = map.w * TILE_PX * scale;
  cv.height = map.h * TILE_PX * scale;
  const c = cv.getContext("2d");
  if (!c) throw new Error("2D context unavailable for tilemap bake");
  c.imageSmoothingEnabled = false;
  for (let i = 0; i < map.cells.length; i++) {
    const x = (i % map.w) * TILE_PX * scale;
    const y = Math.floor(i / map.w) * TILE_PX * scale;
    drawSprite(c, tileset, x, y, { frame: map.cells[i], scale });
  }
  return cv;
}

/** Blit a tilemap at (dx,dy), integer-scaled. Bakes once per (map, scale). */
export function drawTileMap(ctx: CanvasRenderingContext2D, map: TileMap, tileset: GenSprite, dx = 0, dy = 0, scale = 1): void {
  let byScale = baked.get(map);
  if (!byScale) baked.set(map, (byScale = new Map()));
  let cv = byScale.get(scale);
  if (!cv) { cv = bake(map, tileset, scale); byScale.set(scale, cv); }
  ctx.drawImage(cv, dx | 0, dy | 0);
}
