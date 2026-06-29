// barn.ts — the barn overlay: a panel that slides in from the right to show the
// animals (one per MCP server) milling about. Purely visual / transient state —
// nothing here is persisted. The durable economy lives in the save; this layer
// just reacts to it and to interaction "pokes" surfaced from applySession.
//
// Behavior:
//  - Slides in on any MCP interaction (and via the manual Barn button, which
//    pins it open). Auto-closes a few seconds after the last interaction.
//  - Animals wander left/right along the floor.
//  - On a poke the farmer walks to that animal and tends it (a bob). The
//    first interaction of the day also floats a heart bubble (the +1 affection).

import { drawSprite, animFrame, SPRITES, FARMHAND, HEART, type GenSprite } from "./sprites";
import { drawText } from "./font";
import type { HarvestSave } from "./save";
import type { Interaction } from "./state";

const PANEL_W = 210;        // panel width in canvas px
const HOLD_MS = 5000;       // auto-close this long after the last interaction
const SLIDE = 0.16;         // open/close ease per frame
const WANDER = 0.012;       // animal speed, px/ms
const FARMER_SPD = 0.05;    // farmer walk speed, px/ms
const TEND_MS = 1400;       // how long the farmer tends after reaching an animal
const BUBBLE_MS = 2200;     // heart bubble lifetime
const SCALE = 2;            // sprite scale inside the barn (16px -> 32px)
const SPR = 16 * SCALE;
const FLOOR_L = 10;                 // wander bounds, panel-local
const FLOOR_R = PANEL_W - SPR - 10;
const TAB_W = 18, TAB_H = 30, TAB_Y = 88; // on-canvas open/close handle

interface Critter { x: number; dir: number; }
interface Bubble { server: string; until: number; }

export class BarnView {
  private open = 0;             // 0 closed .. 1 fully in
  private pinned = false;       // manual toggle keeps it open
  private lastPoke = -Infinity;
  private lastT = 0;
  private critters = new Map<string, Critter>();
  private bubbles: Bubble[] = [];
  private targetServer: string | null = null;
  private farmerX = FLOOR_R;
  private farmerState: "idle" | "walk" | "tend" = "idle";
  private tendUntil = 0;

  get isOpen(): boolean { return this.open > 0.01; }

  /** Barn tab: pin open, or unpin to close immediately. */
  toggle(): void {
    this.pinned = !this.pinned;
    // Pin → hold open. Unpin → close now (not after the auto-close window),
    // so an explicit click closes right away instead of lingering for HOLD_MS.
    this.lastPoke = this.pinned ? Infinity : -Infinity;
  }

  /** An MCP interaction happened — slide in and send the farmer to that animal. */
  poke(it: Interaction, nowMs: number): void {
    this.lastPoke = this.pinned ? Infinity : nowMs;
    this.targetServer = it.server;
    this.farmerState = "walk";
    if (it.firstToday) this.bubbles.push({ server: it.server, until: nowMs + BUBBLE_MS });
  }

  update(save: HarvestSave, nowMs: number): void {
    const dt = this.lastT ? Math.min(64, nowMs - this.lastT) : 16;
    this.lastT = nowMs;

    const want = this.pinned || nowMs - this.lastPoke < HOLD_MS ? 1 : 0;
    this.open += (want - this.open) * SLIDE;
    if (this.open < 0.001) this.open = 0;

    // Sync critters to the barn roster (panel-local x, spread along the floor).
    const servers = Object.keys(save.barn);
    servers.forEach((s, i) => {
      if (!this.critters.has(s)) {
        const span = Math.max(1, FLOOR_R - FLOOR_L);
        this.critters.set(s, { x: FLOOR_L + (((i + 1) * 37) % span), dir: i % 2 ? 1 : -1 });
      }
    });
    for (const s of this.critters.keys()) if (!save.barn[s]) this.critters.delete(s);

    // Wander.
    for (const c of this.critters.values()) {
      c.x += c.dir * WANDER * dt;
      if (c.x <= FLOOR_L) { c.x = FLOOR_L; c.dir = 1; }
      if (c.x >= FLOOR_R) { c.x = FLOOR_R; c.dir = -1; }
    }

    // Farmer: walk to the target animal, tend, then idle.
    const target = this.targetServer ? this.critters.get(this.targetServer) : null;
    if (target && this.farmerState !== "tend") {
      const dx = target.x - this.farmerX;
      if (Math.abs(dx) > 4) {
        this.farmerX += Math.sign(dx) * FARMER_SPD * dt;
        this.farmerState = "walk";
      } else {
        this.farmerState = "tend";
        this.tendUntil = nowMs + TEND_MS;
      }
    } else if (this.farmerState === "tend" && nowMs > this.tendUntil) {
      this.farmerState = "idle";
      this.targetServer = null;
    }

    this.bubbles = this.bubbles.filter((b) => b.until > nowMs);
  }

  /** Panel left edge in canvas px (W when closed → W-PANEL_W when open). */
  private panelLeft(W: number): number { return Math.round(W - PANEL_W * this.open); }

  /** Hit-test the on-canvas barn tab. x/y must already be in canvas (320x240) space. */
  hit(x: number, y: number, W: number): boolean {
    const tabX = this.panelLeft(W) - TAB_W;
    return x >= tabX && x <= tabX + TAB_W && y >= TAB_Y && y <= TAB_Y + TAB_H;
  }

  draw(ctx: CanvasRenderingContext2D, save: HarvestSave, nowMs: number): void {
    const W = ctx.canvas.width, H = ctx.canvas.height;
    const px = this.panelLeft(W); // panel left edge

    if (this.open > 0) {
      const floorTop = H - 40;        // dirt floor band
      const sprY = floorTop - SPR + 8; // sprite top (feet sink slightly into floor)

      // Interior: back wall, then a dirt floor band, then a left edge shadow.
      ctx.fillStyle = "#2b1d12";
      ctx.fillRect(px, 0, PANEL_W, H);
      ctx.fillStyle = "#3a2a18";
      ctx.fillRect(px, floorTop, PANEL_W, H - floorTop);
      for (let x = px + 6; x < W; x += 16) { ctx.fillStyle = "#33251a"; ctx.fillRect(x, floorTop + 6, 8, 2); } // floor straw
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.fillRect(px, 0, 3, H); // edge shadow

      drawText(ctx, `BARN  ${Object.keys(save.barn).length}`, px + 8, 6, { color: "#e8d8b0" });

      // Animals.
      for (const [server, c] of this.critters) {
        const a = save.barn[server];
        const sprite: GenSprite = SPRITES[a.species.toLowerCase()] ?? SPRITES.cow;
        drawSprite(ctx, sprite, px + c.x, sprY, { scale: SCALE, frame: animFrame(sprite, nowMs, { clip: "idle", fps: 4 }) });
      }

      // Farmer (bob while tending).
      const bob = this.farmerState === "tend" ? (Math.floor(nowMs / 120) % 2 ? 2 : 0) : 0;
      drawSprite(ctx, FARMHAND, px + this.farmerX, sprY + bob, { scale: SCALE, frame: animFrame(FARMHAND, nowMs, { clip: "idle", fps: 6 }) });

      // Heart bubbles above the tended animal.
      for (const b of this.bubbles) {
        const c = this.critters.get(b.server);
        if (!c) continue;
        const bx = px + c.x + SPR / 2 - 9, by = sprY - 20;
        ctx.fillStyle = "#f4ecd8";
        ctx.fillRect(bx, by, 18, 14);
        ctx.fillRect(bx + 6, by + 14, 4, 3); // tail
        drawSprite(ctx, HEART, bx + 5, by + 3, { scale: 1 });
      }
    }

    this.drawTab(ctx, px); // always visible — the open/close handle, rides the panel edge
  }

  /** The clickable barn handle: a small tab with a cow icon + open/close chevron. */
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
