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
import { drawText } from "./font";
import { drawTileMap } from "./tilemap";
import { makeBarnMap } from "./maps";
import type { HarvestSave } from "./save";
import type { Interaction } from "./state";

const PANEL_W = 210;        // panel width in canvas px
const HOLD_MS = 5000;       // auto-close this long after the last interaction
const SLIDE = 0.16;         // open/close ease per frame
const WANDER = 0.012;       // animal stroll speed, px/ms (gentle)
const FARMER_SPD = 0.05;    // farmer walk speed, px/ms
const TEND_MS = 1400;       // tend duration after the farmer reaches an animal
const BUBBLE_MS = 2200;     // heart bubble lifetime
const SCALE = 2;            // sprite scale inside the barn (16px -> 32px)
const SPR = 16 * SCALE;
const TAB_W = 18, TAB_H = 30, TAB_Y = 88; // on-canvas open/close handle
// Pen bounds (panel-local), below the top wall with margins for sprite size.
const PEN_T = 44, PEN_B = 240 - SPR - 10, PEN_L = 8, PEN_R = PANEL_W - SPR - 10;
// Wander rhythm: short local hops, a pause between each, rare longer strolls.
const DWELL_MIN = 900, DWELL_MAX = 3200; // pause between hops, ms
const HOP_NEAR = 40, HOP_FAR = 95;       // hop distance, px
const FAR_CHANCE = 0.15;                 // odds a hop is a longer stroll

interface Mover { x: number; y: number; tx: number; ty: number; }
interface Critter extends Mover { phase: "move" | "pause"; until: number; }
interface Bubble { server: string; until: number; }

const barnMap = makeBarnMap();

const rand = (lo: number, hi: number): number => lo + Math.random() * (hi - lo);
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Pick a new wander target: a short hop nearby, occasionally a longer stroll. */
function pickTarget(c: Critter): void {
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

export class BarnView {
  private open = 0;
  private pinned = false;
  private lastPoke = -Infinity;
  private lastT = 0;
  private critters = new Map<string, Critter>();
  private bubbles: Bubble[] = [];
  private targetServer: string | null = null;
  private farmer: Mover & { state: "idle" | "walk" | "tend"; tendUntil: number } =
    { x: PEN_R, y: PEN_B, tx: PEN_R, ty: PEN_B, state: "idle", tendUntil: 0 };

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

  /** An MCP interaction — slide in and send the farmer to that animal. */
  poke(it: Interaction, nowMs: number): void {
    this.lastPoke = this.pinned ? Infinity : nowMs;
    this.targetServer = it.server;
    this.farmer.state = "walk";
    if (it.firstToday) this.bubbles.push({ server: it.server, until: nowMs + BUBBLE_MS });
  }

  update(save: HarvestSave, nowMs: number): void {
    const dt = this.lastT ? Math.min(64, nowMs - this.lastT) : 16;
    this.lastT = nowMs;

    const want = this.pinned || nowMs - this.lastPoke < HOLD_MS ? 1 : 0;
    this.open += (want - this.open) * SLIDE;
    if (this.open < 0.001) this.open = 0;

    // Sync critters to the barn roster. Spawn paused with a staggered timer so
    // they don't all set off in lockstep.
    for (const s of Object.keys(save.barn)) {
      if (!this.critters.has(s)) {
        const x = rand(PEN_L, PEN_R), y = rand(PEN_T, PEN_B);
        this.critters.set(s, { x, y, tx: x, ty: y, phase: "pause", until: nowMs + rand(0, DWELL_MAX) });
      }
    }
    for (const s of this.critters.keys()) if (!save.barn[s]) this.critters.delete(s);

    // Wander rhythm: stroll to a nearby spot, then pause a beat, then go again.
    for (const c of this.critters.values()) {
      if (c.phase === "pause") {
        if (nowMs >= c.until) { pickTarget(c); c.phase = "move"; }
      } else if (step(c, WANDER * dt)) {
        c.phase = "pause";
        c.until = nowMs + rand(DWELL_MIN, DWELL_MAX);
      }
    }

    // Farmer: walk to the target animal (stand just in front), tend, then idle.
    const f = this.farmer;
    const target = this.targetServer ? this.critters.get(this.targetServer) : null;
    if (target && f.state !== "tend") {
      f.tx = target.x; f.ty = target.y + 4;
      if (step(f, FARMER_SPD * dt)) { f.state = "tend"; f.tendUntil = nowMs + TEND_MS; }
      else f.state = "walk";
    } else if (f.state === "tend" && nowMs > f.tendUntil) {
      f.state = "idle";
      this.targetServer = null;
    } else if (!target && f.state === "walk") {
      f.state = "idle";
    }

    this.bubbles = this.bubbles.filter((b) => b.until > nowMs);
  }

  draw(ctx: CanvasRenderingContext2D, save: HarvestSave, nowMs: number): void {
    const W = ctx.canvas.width, H = ctx.canvas.height;
    const px = this.panelLeft(W);

    if (this.open > 0) {
      drawTileMap(ctx, barnMap, SPRITES.tile, px, 0, 1); // top-down interior
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.fillRect(px, 0, 3, H); // left edge shadow
      drawText(ctx, `BARN  ${Object.keys(save.barn).length}`, px + 8, 6, { color: "#e8d8b0" });

      // Depth-sorted draw: animals + farmer, nearer (greater y) drawn last.
      const items: { y: number; render: () => void }[] = [];
      for (const [server, c] of this.critters) {
        const a = save.barn[server];
        const sprite: GenSprite = SPRITES[a.species.toLowerCase()] ?? SPRITES.cow;
        items.push({ y: c.y, render: () => drawSprite(ctx, sprite, px + c.x, c.y, { scale: SCALE, frame: animFrame(sprite, nowMs, { clip: "idle", fps: 4 }) }) });
      }
      const fbob = this.farmer.state === "tend" ? (Math.floor(nowMs / 120) % 2 ? 2 : 0) : 0;
      items.push({ y: this.farmer.y, render: () => drawSprite(ctx, FARMHAND, px + this.farmer.x, this.farmer.y + fbob, { scale: SCALE, frame: animFrame(FARMHAND, nowMs, { clip: "idle", fps: 6 }) }) });
      items.sort((a, b) => a.y - b.y).forEach((it) => it.render());

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
