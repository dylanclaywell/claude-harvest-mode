// barn.ts — the barn overlay: a top-down room that slides in from the right to
// show the animals (one per MCP server) meandering around. Purely visual /
// transient — nothing here is persisted. Reacts to the durable save and to
// interaction "pokes" surfaced from applySession.
//
//  - Slides in on any MCP interaction (and via the on-canvas tab, which pins
//    it open). Auto-closes a few seconds after the last interaction.
//  - Animals wander in 2D across the floor; everyone is depth-sorted by y so
//    they overlap correctly (lower on screen = nearer = drawn last).
//  - On a poke the farmer walks to that animal and tends it; the first
//    interaction of the day floats a heart bubble (the +1 affection).

import { drawSprite, animFrame, SPRITES, FARMHAND, HEART, type GenSprite } from "./sprites";
import { drawText, textWidth } from "./font";
import { HEARTS_MAX, PRODUCE_OF, producePrice } from "./config";
import { drawTileMap } from "./tilemap";
import { makeBarnMap } from "./maps";
import type { HarvestSave, AnimalState } from "./save";
import type { Interaction } from "./state";

const PANEL_W = 210;        // panel width in canvas px
const HOLD_MS = 5000;       // auto-close this long after the last interaction
const SLIDE = 0.16;         // open/close ease per frame
const WANDER = 0.012;       // animal stroll speed, px/ms (gentle)
const FARMER_SPD = 0.05;    // farmer walk speed, px/ms
const COLLECT_MS = 900;     // time spent collecting produce once the farmer arrives
const BUBBLE_MS = 2200;     // heart bubble lifetime
const SCALE = 2;            // sprite scale inside the barn (16px -> 32px)
const SPR = 16 * SCALE;
const TAB_W = 18, TAB_H = 30, TAB_Y = 88; // on-canvas open/close handle
// Pen bounds (panel-local), below the top wall with margins for sprite size.
// PEN_T reaches up to the trough front so animals crowd the feeder (the trough
// is an above-entity layer, so their heads tuck behind it — reads as feeding).
const PEN_T = 46, PEN_B = 240 - SPR - 10, PEN_L = 8, PEN_R = PANEL_W - SPR - 10;
// Wander rhythm: short local strolls, a pause between each, rare longer walks.
const DWELL_MIN = 900, DWELL_MAX = 3200; // pause between strolls, ms
const HOP_NEAR = 40, HOP_FAR = 95;       // stroll distance, px
const FAR_CHANCE = 0.15;                 // odds a stroll is a longer walk
const FEED_CHANCE = 0.3;                  // odds a wander target is the trough
const LANT_Y = 8;                         // lantern hangs this far below the ceiling

interface Mover { x: number; y: number; tx: number; ty: number; flip: boolean; } // flip=true faces right
interface Critter extends Mover { phase: "move" | "pause"; until: number; }
interface Bubble { server: string; until: number; }
/** One produce pickup, surfaced from update() so the caller can toast it. */
export interface Collected { crop: string; qty: number; gold: number; }

const barnMap = makeBarnMap();

const rand = (lo: number, hi: number): number => lo + Math.random() * (hi - lo);
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** A soft static ground shadow that grounds the sprite. */
function drawShadow(ctx: CanvasRenderingContext2D, cx: number, gy: number): void {
  const rx = SPR * 0.28, ry = Math.max(1.5, rx * 0.4);
  ctx.save();
  ctx.globalAlpha = 0.3;
  ctx.fillStyle = "#000";
  ctx.beginPath();
  ctx.ellipse(cx, gy, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** Hover card for an animal: the MCP server name over a row of heart pips
 *  (filled = current affection, faint = remaining up to HEARTS_MAX). */
function drawAnimalTip(ctx: CanvasRenderingContext2D, mx: number, my: number, server: string, hearts: number, W: number, H: number): void {
  const pad = 3, heartW = 8, gap = 1, lineH = 8;
  const rowW = HEARTS_MAX * (heartW + gap) - gap;
  const w = Math.max(textWidth(server), rowW) + pad * 2;
  const h = pad * 2 + lineH + 2 + heartW;
  const x = Math.min(Math.max(0, mx + 4), W - w);
  const y = Math.min(Math.max(0, my - h - 2), H - h);
  ctx.fillStyle = "rgba(20,16,10,0.92)";
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = "#e8d8b0";
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  drawText(ctx, server, x + pad, y + pad, { color: "#e8d8b0" });
  const hy = y + pad + lineH + 2;
  for (let i = 0; i < HEARTS_MAX; i++) {
    ctx.globalAlpha = i < hearts ? 1 : 0.25;
    drawSprite(ctx, HEART, x + pad + i * (heartW + gap), hy, { scale: 1 });
  }
  ctx.globalAlpha = 1;
}

/** Pick a new wander target: often mosey to the trough to feed, else a short hop
 *  nearby (occasionally a longer stroll). */
function pickTarget(c: Critter): void {
  if (Math.random() < FEED_CHANCE) { // graze along the trough at the back
    c.tx = clamp(rand(PEN_L, PEN_R), PEN_L, PEN_R);
    c.ty = PEN_T + rand(0, 6);
    return;
  }
  const r = Math.random() < FAR_CHANCE ? rand(HOP_NEAR, HOP_FAR) : rand(8, HOP_NEAR);
  const a = Math.random() * Math.PI * 2;
  c.tx = clamp(c.x + Math.cos(a) * r, PEN_L, PEN_R);
  c.ty = clamp(c.y + Math.sin(a) * r, PEN_T, PEN_B);
}

/** Step `m` toward (tx,ty); returns true once essentially arrived. */
function step(p: Mover, speed: number): boolean {
  const dx = p.tx - p.x, dy = p.ty - p.y;
  const d = Math.hypot(dx, dy);
  if (d < 1.5) return true;
  const s = Math.min(speed, d);
  p.x += (dx / d) * s;
  p.y += (dy / d) * s;
  return false;
}

/** Collect an animal's waiting produce (wool/milk/eggs) into the pending-sale
 *  bucket, mirroring the field harvest bank — merged by produce + "barn", gold
 *  credited at the next morning report. Zeroes pendingProduce; returns the qty. */
function bankProduce(save: HarvestSave, a: AnimalState): number {
  const crop = PRODUCE_OF[a.species], qty = a.pendingProduce;
  const gold = producePrice(a.hearts) * qty;
  const hit = save.harvested.find((l) => l.crop === crop && l.ext === "barn");
  if (hit) { hit.qty += qty; hit.gold += gold; }
  else save.harvested.push({ crop, ext: "barn", qty, gold });
  a.pendingProduce = 0;
  return qty;
}

export class BarnView {
  /** Player's customized palette (from the character customizer). Undefined = base colors. */
  farmerColors: number[] | undefined;
  private open = 0;
  private pinned = false;
  private lastPoke = -Infinity;
  private lastT = 0;
  private critters = new Map<string, Critter>();
  private bubbles: Bubble[] = [];
  private targetServer: string | null = null;
  private farmer: Mover & { state: "idle" | "walk" | "collect"; busyUntil: number } =
    { x: PEN_R, y: PEN_B, tx: PEN_R, ty: PEN_B, flip: false, state: "idle", busyUntil: 0 };

  get isOpen(): boolean { return this.open > 0.01; }

  private panelLeft(W: number): number { return Math.round(W - PANEL_W * this.open); }

  /** Barn tab: pin open, or unpin to close immediately. */
  toggle(): void {
    this.pinned = !this.pinned;
    this.lastPoke = this.pinned ? Infinity : -Infinity;
  }

  /** Hit-test the on-canvas tab. x/y must be in canvas (320x240) space. */
  hit(x: number, y: number, W: number): boolean {
    const tabX = this.panelLeft(W) - TAB_W;
    return x >= tabX && x <= tabX + TAB_W && y >= TAB_Y && y <= TAB_Y + TAB_H;
  }

  /** An MCP interaction — slide in; the first-of-day feed floats a heart. The
   *  produce it deposits is collected by the farmer in update(). */
  poke(it: Interaction, nowMs: number): void {
    this.lastPoke = this.pinned ? Infinity : nowMs;
    if (it.firstToday) this.bubbles.push({ server: it.server, until: nowMs + BUBBLE_MS });
  }

  /** First animal (roster order) with produce waiting to be collected, or null. */
  private nextReady(save: HarvestSave): string | null {
    for (const s of this.critters.keys()) {
      const a = save.barn[s];
      if (a && a.pendingProduce > 0) return s;
    }
    return null;
  }

  /** Advance one frame; returns the pickup if produce was collected this frame
   *  (caller persists + toasts), else null. */
  update(save: HarvestSave, nowMs: number): Collected | null {
    const dt = this.lastT ? Math.min(64, nowMs - this.lastT) : 16;
    this.lastT = nowMs;

    // Auto-open to collect produce and hold open until the farmhand is done; a
    // recent poke also holds it. A manual pin (tab) forces open + no auto-close.
    const busy = this.farmer.state !== "idle";
    const ready = this.nextReady(save) !== null;
    const want = this.pinned || ready || busy || nowMs - this.lastPoke < HOLD_MS ? 1 : 0;
    this.open += (want - this.open) * SLIDE;
    if (this.open < 0.001) this.open = 0;

    // Sync critters to the barn roster. Spawn paused with a staggered timer so
    // they don't all set off in lockstep.
    for (const s of Object.keys(save.barn)) {
      if (!this.critters.has(s)) {
        const x = rand(PEN_L, PEN_R), y = rand(PEN_T, PEN_B);
        this.critters.set(s, { x, y, tx: x, ty: y, flip: false, phase: "pause", until: nowMs + rand(0, DWELL_MAX) });
      }
    }
    for (const s of this.critters.keys()) if (!save.barn[s]) this.critters.delete(s);

    // Wander rhythm: stroll to a nearby spot, then pause a beat, then go again.
    for (const c of this.critters.values()) {
      if (c.phase === "pause") {
        if (nowMs >= c.until) { pickTarget(c); c.phase = "move"; }
      } else {
        const dx = c.tx - c.x;
        if (Math.abs(dx) > 0.5) c.flip = dx > 0; // face the way it's walking
        if (step(c, WANDER * dt)) { c.phase = "pause"; c.until = nowMs + rand(DWELL_MIN, DWELL_MAX); }
      }
    }

    // Farmer: walk to the next animal with produce (stand just in front),
    // collect it, then find the next — like the field farmhand picking crops.
    let collected: Collected | null = null;
    const f = this.farmer;
    if (f.state === "collect") {
      if (nowMs > f.busyUntil) {
        const a = this.targetServer ? save.barn[this.targetServer] : undefined;
        if (a && a.pendingProduce > 0) {
          const crop = PRODUCE_OF[a.species], qty = a.pendingProduce, gold = producePrice(a.hearts) * qty;
          bankProduce(save, a);
          collected = { crop, qty, gold };
        }
        f.state = "idle";
        this.targetServer = null;
      }
    } else {
      const srv = this.nextReady(save);
      const target = srv ? this.critters.get(srv) : null;
      if (srv && target) {
        this.targetServer = srv;
        f.tx = target.x; f.ty = target.y + 4;
        const dx = f.tx - f.x;
        if (Math.abs(dx) > 0.5) f.flip = dx > 0;
        if (step(f, FARMER_SPD * dt)) { f.state = "collect"; f.busyUntil = nowMs + COLLECT_MS; }
        else f.state = "walk";
      } else {
        this.targetServer = null;
        f.state = "idle";
      }
    }

    this.bubbles = this.bubbles.filter((b) => b.until > nowMs);
    return collected;
  }

  draw(ctx: CanvasRenderingContext2D, save: HarvestSave, nowMs: number, mouse?: { x: number; y: number } | null): void {
    const W = ctx.canvas.width, H = ctx.canvas.height;
    const px = this.panelLeft(W);

    if (this.open > 0) {
      drawTileMap(ctx, barnMap, false, px, 0, 1); // under-entity interior layers
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.fillRect(px, 0, 3, H); // left edge shadow
      drawText(ctx, `BARN  ${Object.keys(save.barn).length}`, px + 8, 6, { color: "#e8d8b0" });

      // Depth-sorted draw: animals + farmer, nearer (greater y) drawn last. Each
      // has a ground shadow (z-fading) and a body lifted by its hop height z. All
      // shadows draw first so no sprite sits on another's shadow.
      const items: { y: number; shadow: () => void; sprite: () => void }[] = [];
      for (const [server, c] of this.critters) {
        const a = save.barn[server];
        const sprite: GenSprite = SPRITES[a.species.toLowerCase()] ?? SPRITES.cow;
        const gx = px + c.x, gy = c.y;
        items.push({
          y: c.y,
          shadow: () => drawShadow(ctx, gx + SPR / 2, gy + SPR - 5),
          sprite: () => drawSprite(ctx, sprite, gx, gy, { scale: SCALE, flip: c.flip, frame: animFrame(sprite, nowMs, { clip: "idle", fps: 4 }) }),
        });
      }
      const f = this.farmer;
      const fbob = f.state === "collect" ? (Math.floor(nowMs / 120) % 2 ? 2 : 0) : 0;
      const fgx = px + f.x, fgy = f.y;
      items.push({
        y: f.y,
        shadow: () => drawShadow(ctx, fgx + SPR / 2, fgy + SPR - 5),
        sprite: () => drawSprite(ctx, FARMHAND, fgx, fgy + fbob, { scale: SCALE, flip: f.flip, colors: this.farmerColors, frame: animFrame(FARMHAND, nowMs, { clip: "idle", fps: 6 }) }),
      });
      items.sort((a, b) => a.y - b.y);
      for (const it of items) it.shadow();
      for (const it of items) it.sprite();

      drawTileMap(ctx, barnMap, true, px, 0, 1); // over-entity interior layers (roof beams, etc.)

      // Hanging lantern with a warm glow pooling into the room.
      const lcx = px + PANEL_W / 2, lcy = LANT_Y + 8;
      const glow = ctx.createRadialGradient(lcx, lcy, 4, lcx, lcy, 80);
      glow.addColorStop(0, "rgba(255,208,120,0.30)");
      glow.addColorStop(1, "rgba(255,208,120,0)");
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.fillStyle = glow;
      ctx.fillRect(px, 0, PANEL_W, H);
      ctx.restore();
      drawSprite(ctx, SPRITES.lantern, lcx - 8, LANT_Y, { scale: 1 });

      // Produce-ready badge: an egg/token + count over animals with pending yield.
      for (const [server, c] of this.critters) {
        const a = save.barn[server];
        if (!a || a.pendingProduce <= 0) continue;
        const bx = px + c.x + SPR - 14, by = c.y - 2;
        ctx.fillStyle = "#f4ecd8";
        ctx.fillRect(bx, by, 16, 12);
        ctx.fillRect(bx + 5, by + 12, 3, 2); // tail
        const tint = a.species === "Chicken" ? "#fff2d0" : a.species === "Cow" ? "#ffffff" : "#eae6dc";
        ctx.fillStyle = tint; // little egg/produce token
        ctx.fillRect(bx + 3, by + 3, 4, 6);
        ctx.fillRect(bx + 4, by + 2, 2, 8);
        drawText(ctx, String(a.pendingProduce), bx + 9, by + 3, { color: "#3a2a18" });
      }

      // Heart bubbles above the tended animal.
      for (const b of this.bubbles) {
        const c = this.critters.get(b.server);
        if (!c) continue;
        const bx = px + c.x + SPR / 2 - 9, by = c.y - 20;
        ctx.fillStyle = "#f4ecd8";
        ctx.fillRect(bx, by, 18, 14);
        ctx.fillRect(bx + 6, by + 14, 4, 3); // tail
        drawSprite(ctx, HEART, bx + 5, by + 3, { scale: 1 });
      }

      // Hover tooltip: which MCP server this animal is + its heart level, shown
      // as pips (filled = current affection, faint = up to the max).
      if (mouse) {
        for (const [server, c] of this.critters) {
          const sx = px + c.x, sy = c.y;
          if (mouse.x >= sx && mouse.x < sx + SPR && mouse.y >= sy && mouse.y < sy + SPR) {
            drawAnimalTip(ctx, mouse.x + 4, mouse.y, server, save.barn[server].hearts, W, H);
            break;
          }
        }
      }
    }

    this.drawTab(ctx, px);
  }

  /** The clickable barn handle: a cow icon + open/close chevron, rides the edge. */
  private drawTab(ctx: CanvasRenderingContext2D, px: number): void {
    const x = px - TAB_W;
    ctx.fillStyle = "#5a4632";
    ctx.fillRect(x, TAB_Y, TAB_W, TAB_H);
    ctx.fillStyle = "#3a2a18";
    ctx.fillRect(x + 1, TAB_Y + 1, TAB_W - 2, TAB_H - 2);
    drawSprite(ctx, SPRITES.cow, x + 1, TAB_Y + 2, { scale: 1, frame: 0 });
    drawText(ctx, this.open > 0.5 ? ">" : "<", x + 6, TAB_Y + 20, { color: "#e8d8b0" });
  }
}
