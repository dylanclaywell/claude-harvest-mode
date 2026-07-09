// critter.ts — ambient wandering animals (free-range yard fowl, etc.). Pure
// decoration: they mosey around the open grass, unrelated to the economy or the
// barn's MCP animals. A data-driven walkable grid (grass with no field/decor on
// it) keeps them off crops, trees, the house and fences, so they work on any
// authored map without hand-placed spawn points.

import { drawSprite, animFrame, type GenSprite } from "./sprites";
import type { TileMap } from "./tilemap";

const TILE = 16;
const SPD = 0.011;                       // gentle mosey, px/ms
const DWELL_MIN = 1200, DWELL_MAX = 4200; // pause between strolls, ms
const HOP_TILES = 3;                     // pick a new target within this radius (short hops avoid crossing obstacles)

/** (col,row) → can an ambient critter stand here? Grass with nothing built on it. */
export type Walkable = (col: number, row: number) => boolean;

/**
 * Build a walkable predicate from a farm map: a cell is roamable when every
 * layer except the base ground is empty there (no tilled field, no decor). This
 * derives the open-grass area purely from the authored map.
 */
export function walkableFromMap(map: TileMap): Walkable {
  const blocked = new Uint8Array(map.w * map.h);
  for (const layer of map.layers) {
    if (layer.name === "ground") continue; // the grass everything sits on
    for (let i = 0; i < layer.cells.length; i++) {
      if (layer.cells[i]) blocked[i] = 1;
    }
  }
  return (col, row) =>
    col >= 0 && row >= 0 && col < map.w && row < map.h && !blocked[row * map.w + col];
}

export class Critter {
  x: number; y: number;
  private tx: number; private ty: number;
  private flip = false;
  private timer = 0;
  private lastT = 0;

  constructor(private sprite: GenSprite, private walkable: Walkable, col: number, row: number) {
    this.x = this.tx = col * TILE;
    this.y = this.ty = row * TILE;
  }

  /** Depth-sort key (feet), matching the farmhand/crop convention. */
  get sortY(): number { return this.y + TILE; }

  /** A walkable tile within HOP_TILES of the current one; falls back to staying put. */
  private pickTarget(): void {
    const col = Math.round(this.x / TILE), row = Math.round(this.y / TILE);
    for (let tries = 0; tries < 12; tries++) {
      const c = col + Math.floor((Math.random() * 2 - 1) * HOP_TILES);
      const r = row + Math.floor((Math.random() * 2 - 1) * HOP_TILES);
      if (this.walkable(c, r)) { this.tx = c * TILE; this.ty = r * TILE; return; }
    }
    this.tx = this.x; this.ty = this.y; // hemmed in — just idle in place
  }

  /** Advance one frame (ambient only — no return value / persistence). */
  update(nowMs: number): void {
    const dt = this.lastT ? Math.min(64, nowMs - this.lastT) : 16;
    this.lastT = nowMs;
    const dx = this.tx - this.x, dy = this.ty - this.y, d = Math.hypot(dx, dy);
    if (Math.abs(dx) > 0.5) this.flip = dx > 0;
    if (d < 1.2) {
      if (nowMs >= this.timer) { this.pickTarget(); this.timer = nowMs + DWELL_MIN + Math.random() * (DWELL_MAX - DWELL_MIN); }
      return;
    }
    const s = Math.min(SPD * dt, d);
    this.x += (dx / d) * s; this.y += (dy / d) * s;
  }

  drawShadow(ctx: CanvasRenderingContext2D): void {
    ctx.save();
    ctx.globalAlpha = 0.24;
    ctx.fillStyle = "#000";
    ctx.beginPath();
    ctx.ellipse(this.x + TILE / 2, this.y + TILE - 2, TILE * 0.28, TILE * 0.13, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  draw(ctx: CanvasRenderingContext2D, nowMs: number): void {
    const moving = Math.hypot(this.tx - this.x, this.ty - this.y) > 1.2;
    const bob = moving && Math.floor(nowMs / 180) % 2 ? 1 : 0; // little waddle while walking
    drawSprite(ctx, this.sprite, this.x, this.y - bob, {
      scale: 1, flip: this.flip,
      frame: animFrame(this.sprite, nowMs, { clip: "idle", fps: 4 }),
    });
  }
}

/**
 * Spawn `n` critters of the given sprite on random walkable tiles. Returns an
 * empty array if the map has no open grass (nothing to place them on).
 */
export function spawnCritters(sprite: GenSprite, n: number, walkable: Walkable, cols: number, rows: number): Critter[] {
  const open: Array<[number, number]> = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (walkable(c, r)) open.push([c, r]);
  if (!open.length) return [];
  const out: Critter[] = [];
  for (let i = 0; i < n; i++) {
    const [c, r] = open[Math.floor(Math.random() * open.length)];
    out.push(new Critter(sprite, walkable, c, r));
  }
  return out;
}
