// farmer.ts — the autonomous farmhand on the main farm. Mirrors the barn farmer
// in spirit: it roams the field, walks to ripe crops, and harvests them. A pick
// removes the crop from the field and banks a ship line into save.harvested; the
// GOLD is not credited here — the next morning report (rollover) sells the bucket
// and pays out. Purely drives what the player sees + the harvest timing.

import { drawSprite, animFrame, FARMHAND, SPRITES } from "./sprites";
import { cropPrice } from "./config";
import type { HarvestSave } from "./save";

const TILE = 16;
const SPD = 0.03;         // purposeful walk to a ripe crop, px/ms
const WANDER_SPD = 0.014; // idle mosey — slower than a beeline to a crop
const HARVEST_MS = 600;   // time spent picking a crop
const DWELL_MIN = 600, DWELL_MAX = 2000; // idle pause between strolls
const CHEER_MS = 2400;    // "recipe get!" celebration duration

interface FieldRect { x0: number; y0: number; w: number; h: number; }

/** Bank a picked crop into the pending-sale bucket (merged by crop+ext). */
function bank(save: HarvestSave, crop: string, ext: string, gold: number): void {
  const hit = save.harvested.find((l) => l.crop === crop && l.ext === ext);
  if (hit) { hit.qty++; hit.gold += gold; }
  else save.harvested.push({ crop, ext, qty: 1, gold });
}

export class FarmFarmer {
  /** Player's customized palette (from the character customizer); undefined = base. */
  colors: number[] | undefined;
  x: number; y: number;
  private tx: number; private ty: number;
  private flip = false;
  private state: "seek" | "harvest" | "wander" = "wander";
  private timer = 0;
  private target: string | null = null;
  private lastT = 0;
  private cheerUntil = 0;

  /** Throw the hands up with a recipe card overhead (a new recipe was learned). */
  celebrate(nowMs: number): void { this.cheerUntil = nowMs + CHEER_MS; }

  constructor(private field: FieldRect) {
    this.x = this.tx = (field.x0 + field.w / 2) * TILE;
    this.y = this.ty = (field.y0 + field.h) * TILE;
  }

  /** Depth-sort key (feet). +0.5 so the farmer draws in front of a crop it shares a row with. */
  get sortY(): number { return this.y + TILE + 0.5; }

  /** Tile pixel of the ripe crop at enumeration index i (same order main.ts draws). */
  private slotXY(i: number): [number, number] {
    return [(this.field.x0 + (i % this.field.w)) * TILE, (this.field.y0 + Math.floor(i / this.field.w)) * TILE];
  }

  /** First ripe crop in the field, or null. */
  private findRipe(save: HarvestSave): { path: string; x: number; y: number } | null {
    const entries = Object.entries(save.field).slice(0, this.field.w * this.field.h);
    for (let i = 0; i < entries.length; i++) {
      if (entries[i][1].ripe) { const [x, y] = this.slotXY(i); return { path: entries[i][0], x, y }; }
    }
    return null;
  }

  /** Step toward (tx,ty) at `speed` px/ms; true once arrived. */
  private step(dt: number, speed: number): boolean {
    const dx = this.tx - this.x, dy = this.ty - this.y, d = Math.hypot(dx, dy);
    if (Math.abs(dx) > 0.5) this.flip = dx > 0;
    if (d < 1.2) return true;
    const s = Math.min(speed * dt, d);
    this.x += (dx / d) * s; this.y += (dy / d) * s;
    return false;
  }

  /** Advance one frame; returns true if a crop was harvested (caller should persist). */
  update(save: HarvestSave, nowMs: number): boolean {
    const dt = this.lastT ? Math.min(64, nowMs - this.lastT) : 16;
    this.lastT = nowMs;

    if (nowMs < this.cheerUntil) return false; // stand still and cheer

    if (this.state === "harvest") {
      if (nowMs < this.timer) return false;
      let picked = false;
      const c = this.target ? save.field[this.target] : undefined;
      if (c && c.ripe) { bank(save, c.crop, c.ext, cropPrice(c.quality)); delete save.field[this.target!]; picked = true; }
      this.target = null;
      this.state = "wander";
      this.timer = nowMs + DWELL_MIN;
      return picked;
    }

    // Prefer a ripe crop; otherwise mosey around the field.
    const ripe = this.findRipe(save);
    if (ripe) {
      this.target = ripe.path; this.tx = ripe.x; this.ty = ripe.y; this.state = "seek";
      if (this.step(dt, SPD)) { this.state = "harvest"; this.timer = nowMs + HARVEST_MS; }
    } else {
      this.target = null;
      if (this.step(dt, WANDER_SPD) && nowMs >= this.timer) {
        this.tx = (this.field.x0 + Math.random() * (this.field.w - 1)) * TILE;
        this.ty = (this.field.y0 + Math.random() * (this.field.h - 1)) * TILE;
        this.timer = nowMs + DWELL_MIN + Math.random() * (DWELL_MAX - DWELL_MIN);
      }
      this.state = "wander";
    }
    return false;
  }

  /** Ground shadow, drawn under everything (call before the depth-sorted sprites). */
  drawShadow(ctx: CanvasRenderingContext2D): void {
    ctx.save();
    ctx.globalAlpha = 0.28;
    ctx.fillStyle = "#000";
    ctx.beginPath();
    ctx.ellipse(this.x + TILE / 2, this.y + TILE - 1, TILE * 0.34, TILE * 0.16, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  draw(ctx: CanvasRenderingContext2D, nowMs: number): void {
    if (nowMs < this.cheerUntil) {                        // recipe get!
      drawSprite(ctx, SPRITES.farmhand_cheer, this.x, this.y, { scale: 1, colors: this.colors });
      const lift = (Math.floor(nowMs / 160) % 2) ? 1 : 0; // paper bobs above the raised hands
      drawSprite(ctx, SPRITES.recipe, this.x, this.y - 14 - lift, { scale: 1 });
      return;
    }
    const bob = this.state === "harvest" ? (Math.floor(nowMs / 110) % 2 ? 1 : 0) : 0; // stoop while picking
    drawSprite(ctx, FARMHAND, this.x, this.y + bob, {
      scale: 1, flip: this.flip, colors: this.colors,
      frame: animFrame(FARMHAND, nowMs, { clip: "idle", fps: 6 }),
    });
  }
}
