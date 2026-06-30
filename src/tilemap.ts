// tilemap.ts — a scene as a grid of tiles. Each cell names a `kind="tile"` sprite
// (in SPRITES); "" = empty. Every tile is its own sprite with its own palette, so
// the map can mix wildly different art (ground, walls, props). Maps are static,
// so the whole map bakes once to an offscreen canvas, then blits in one drawImage
// — dynamic stuff (crops, animals) draws on top.

import { drawSprite, SPRITES } from "./sprites";
import { tileFlipAt } from "./editor/project";

export const TILE_PX = 16;

export interface TileMap {
  w: number;          // width in tiles
  h: number;          // height in tiles
  cells: string[];    // row-major tile sprite names ("" = empty)
}

// map -> scale -> baked canvas. Maps are immutable at runtime; the editor will
// invalidate by handing over a fresh map object (new WeakMap key).
const baked = new WeakMap<TileMap, Map<number, HTMLCanvasElement>>();

function bake(map: TileMap, scale: number): HTMLCanvasElement {
  const cv = document.createElement("canvas");
  cv.width = map.w * TILE_PX * scale;
  cv.height = map.h * TILE_PX * scale;
  const c = cv.getContext("2d");
  if (!c) throw new Error("2D context unavailable for tilemap bake");
  c.imageSmoothingEnabled = false;
  for (let i = 0; i < map.cells.length; i++) {
    const name = map.cells[i];
    const sprite = name ? SPRITES[name] : undefined;
    if (!sprite) continue; // empty cell or unknown tile
    const col = i % map.w, row = Math.floor(i / map.w);
    // Deterministic per-cell mirror to break up repetition (if the tile allows it).
    const { flipX, flipY } = tileFlipAt(sprite.tileFlip, col, row);
    drawSprite(c, sprite, col * TILE_PX * scale, row * TILE_PX * scale, { frame: 0, scale, flip: flipX, flipY });
  }
  return cv;
}

/** Blit a tilemap at (dx,dy), integer-scaled. Bakes once per (map, scale). */
export function drawTileMap(ctx: CanvasRenderingContext2D, map: TileMap, dx = 0, dy = 0, scale = 1): void {
  let byScale = baked.get(map);
  if (!byScale) baked.set(map, (byScale = new Map()));
  let cv = byScale.get(scale);
  if (!cv) { cv = bake(map, scale); byScale.set(scale, cv); }
  ctx.drawImage(cv, dx | 0, dy | 0);
}
