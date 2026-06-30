// tilemap.ts — a scene as STACKED layers of tiles. Each cell names a
// kind="tile" sprite (in SPRITES); "" = empty (lower layers / ground show
// through). Layers draw bottom→top; a layer flagged `above` draws OVER entities
// (tree tops, roofs you walk behind), the rest under them. Maps are static, so
// each pass (below / above) bakes once to an offscreen canvas and blits in one
// drawImage — dynamic stuff (crops, animals) draws between the passes.

import { drawSprite, SPRITES } from "./sprites";
import { tileFlipAt } from "./editor/project";

export const TILE_PX = 16;

export interface TileLayer {
  name: string;
  above?: boolean;    // drawn over entities (default false = under)
  cells: string[];    // row-major tile sprite names ("" = empty)
}

export interface TileMap {
  w: number;          // width in tiles
  h: number;          // height in tiles
  layers: TileLayer[];
}

/** Accept either the current {layers} shape or the legacy single {cells}. */
export function normalizeMap(m: { w: number; h: number; layers?: TileLayer[]; cells?: unknown[] }): TileMap {
  const layers = Array.isArray(m.layers)
    ? m.layers.map((l) => ({ name: l.name ?? "layer", above: !!l.above, cells: (l.cells ?? []).map(String) }))
    : [{ name: "ground", above: false, cells: (m.cells ?? []).map(String) }];
  return { w: m.w, h: m.h, layers };
}

// map -> "scale:above" -> baked canvas. Maps are immutable at runtime; the
// editor invalidates by handing over a fresh map object (new WeakMap key).
const baked = new WeakMap<TileMap, Map<string, HTMLCanvasElement>>();

function bake(map: TileMap, scale: number, above: boolean): HTMLCanvasElement {
  const cv = document.createElement("canvas");
  cv.width = map.w * TILE_PX * scale;
  cv.height = map.h * TILE_PX * scale;
  const c = cv.getContext("2d");
  if (!c) throw new Error("2D context unavailable for tilemap bake");
  c.imageSmoothingEnabled = false;
  for (const layer of map.layers) {
    if ((layer.above ?? false) !== above) continue;
    for (let i = 0; i < layer.cells.length; i++) {
      const name = layer.cells[i];
      const sprite = name ? SPRITES[name] : undefined;
      if (!sprite) continue;
      const col = i % map.w, row = Math.floor(i / map.w);
      const { flipX, flipY } = tileFlipAt(sprite.tileFlip, col, row);
      drawSprite(c, sprite, col * TILE_PX * scale, row * TILE_PX * scale, { frame: 0, scale, flip: flipX, flipY });
    }
  }
  return cv;
}

/**
 * Blit a map's tile layers at (dx,dy). `above=false` draws the under-entity
 * layers (call before entities); `above=true` the over-entity layers (after).
 * Bakes once per (map, scale, pass).
 */
export function drawTileMap(ctx: CanvasRenderingContext2D, map: TileMap, above: boolean, dx = 0, dy = 0, scale = 1): void {
  let byKey = baked.get(map);
  if (!byKey) baked.set(map, (byKey = new Map()));
  const key = `${scale}:${above}`;
  let cv = byKey.get(key);
  if (!cv) { cv = bake(map, scale, above); byKey.set(key, cv); }
  ctx.drawImage(cv, dx | 0, dy | 0);
}
