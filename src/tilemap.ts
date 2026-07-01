// tilemap.ts — a scene as STACKED layers of tiles. Each cell names a
// kind="tile" sprite (in SPRITES); "" = empty (lower layers / ground show
// through). Layers draw bottom→top; a layer flagged `above` draws OVER entities
// (tree tops, roofs you walk behind), the rest under them. Maps are static, so
// each pass (below / above) bakes once to an offscreen canvas and blits in one
// drawImage — dynamic stuff (crops, animals) draws between the passes.

import { drawSprite, SPRITES } from "./sprites";
import { tileFlipAt } from "./editor/project";
import { cornerMask, type Filled } from "./dualgrid";

export const TILE_PX = 16;

export interface TileLayer {
  name: string;
  above?: boolean;    // drawn over entities (default false = under)
  cells: string[];    // row-major tile sprite names ("" = empty)
  /**
   * Dual-grid autotiling. When set, `cells` is read as a terrain MASK (any
   * non-"" cell = terrain present) rather than per-cell art, and the layer is
   * drawn from `tileset` — a 16-frame `kind:"tile"` sprite (see genDualFrames).
   * Each display tile straddles a 2×2 of world cells, so edges/corners resolve
   * automatically; no per-cell painting of transitions.
   */
  dual?: { tileset: string };
}

export interface TileMap {
  w: number;          // width in tiles
  h: number;          // height in tiles
  layers: TileLayer[];
}

/** Accept either the current {layers} shape or the legacy single {cells}. */
export function normalizeMap(m: { w: number; h: number; layers?: TileLayer[]; cells?: unknown[] }): TileMap {
  const layers = Array.isArray(m.layers)
    ? m.layers.map((l) => ({
        name: l.name ?? "layer",
        above: !!l.above,
        cells: (l.cells ?? []).map(String),
        ...(l.dual?.tileset ? { dual: { tileset: String(l.dual.tileset) } } : {}),
      }))
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
    if (layer.dual) bakeDual(c, layer, map, scale);
    else bakeNamed(c, layer, map, scale);
  }
  return cv;
}

/** Per-cell mode: each cell names its own tile sprite, drawn at its grid slot. */
function bakeNamed(c: CanvasRenderingContext2D, layer: TileLayer, map: TileMap, scale: number): void {
  for (let i = 0; i < layer.cells.length; i++) {
    const name = layer.cells[i];
    const sprite = name ? SPRITES[name] : undefined;
    if (!sprite) continue;
    const col = i % map.w, row = Math.floor(i / map.w);
    const { flipX, flipY } = tileFlipAt(sprite.tileFlip, col, row);
    drawSprite(c, sprite, col * TILE_PX * scale, row * TILE_PX * scale, { frame: 0, scale, flip: flipX, flipY });
  }
}

/**
 * Dual-grid mode: `cells` is a terrain mask (non-"" = terrain). The visible
 * grid is (w+1)×(h+1), offset up-left by half a tile; each display tile picks
 * frame 0..15 from the 16-frame `tileset` by its 4 surrounding world cells.
 * No random flip — mirroring would break corner continuity. Border tiles hang
 * half a tile past the map and are clipped by the baked canvas bounds.
 */
function bakeDual(c: CanvasRenderingContext2D, layer: TileLayer, map: TileMap, scale: number): void {
  const ts = SPRITES[layer.dual!.tileset];
  if (!ts) return; // unknown tileset name — skip (e.g. before `npm run gen`)
  const filled: Filled = (col, row) =>
    col >= 0 && row >= 0 && col < map.w && row < map.h && !!layer.cells[row * map.w + col];
  const px = TILE_PX * scale, half = (TILE_PX / 2) * scale;
  for (let cy = 0; cy <= map.h; cy++) {
    for (let cx = 0; cx <= map.w; cx++) {
      const m = cornerMask(filled, cx, cy);
      if (m === 0) continue; // corner entirely outside terrain — nothing to draw
      drawSprite(c, ts, cx * px - half, cy * px - half, { frame: m, scale });
    }
  }
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
