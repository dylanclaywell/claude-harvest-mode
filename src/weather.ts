// weather.ts — rain and storms over the farm. Same overlay slot as daynight:
// drawn after the world but before the HUD. A rolling "storm score" (bumped by
// tool errors, eased down by passing tests + time) picks the level; the render
// just animates falling rain, a grey darkening, and — in storms — the odd
// lightning flash. No persistent state: purely a live mood layer.

export type WeatherLevel = "clear" | "rain" | "storm";

interface Drop { x: number; y: number; len: number; spd: number; }

const MAX_DROPS = 160; // pool size (storm uses all; rain a fraction)

export class Weather {
  private drops: Drop[] = [];
  private lastT = 0;
  private flashUntil = 0;
  private nextFlash = 0;

  constructor() {
    // Seed the pool spread across a 240-tall buffer so rain starts mid-fall.
    for (let i = 0; i < MAX_DROPS; i++) this.drops.push(this.mk(240));
  }

  private mk(H: number): Drop {
    return { x: Math.random() * 340 - 10, y: Math.random() * H, len: 4 + Math.random() * 4, spd: 3 + Math.random() * 2 };
  }

  /** Draw the weather pass for `level` into the WxH buffer. Advances particles
   *  by its own wall-clock delta so callers needn't thread dt. */
  render(ctx: CanvasRenderingContext2D, W: number, H: number, level: WeatherLevel, nowMs: number): void {
    const dt = this.lastT ? Math.min(64, nowMs - this.lastT) : 16;
    this.lastT = nowMs;
    if (level === "clear") return;

    const storm = level === "storm";
    const count = storm ? MAX_DROPS : Math.floor(MAX_DROPS * 0.45);
    const windX = storm ? 1.7 : 0.7;
    const spdMul = storm ? 1.5 : 1.0;
    const step = dt / 16; // frames elapsed at 60fps baseline

    // Grey overcast darkening (heavier in a storm).
    ctx.save();
    ctx.globalAlpha = storm ? 0.34 : 0.16;
    ctx.fillStyle = storm ? "#1e222c" : "#3a4250";
    ctx.fillRect(0, 0, W, H);
    ctx.restore();

    // Falling rain streaks.
    ctx.save();
    ctx.strokeStyle = storm ? "rgba(180,200,232,0.5)" : "rgba(196,214,238,0.42)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < count; i++) {
      const d = this.drops[i];
      d.y += d.spd * spdMul * step;
      d.x += windX * step;
      if (d.y > H) { d.y = -d.len; d.x = Math.random() * 340 - 10; }
      if (d.x > W + 10) d.x -= W + 20;
      ctx.moveTo(d.x, d.y);
      ctx.lineTo(d.x - windX * 2, d.y - d.len);
    }
    ctx.stroke();
    ctx.restore();

    // Occasional lightning flash in a storm.
    if (storm) {
      if (this.nextFlash === 0) this.nextFlash = nowMs + 3000; // don't flash the instant it starts
      if (nowMs >= this.nextFlash) {
        this.flashUntil = nowMs + 130;
        this.nextFlash = nowMs + 4000 + Math.random() * 7000;
      }
      if (nowMs < this.flashUntil) {
        ctx.save();
        ctx.globalAlpha = 0.45 * ((this.flashUntil - nowMs) / 130); // quick fade-out
        ctx.fillStyle = "#eef2ff";
        ctx.fillRect(0, 0, W, H);
        ctx.restore();
      }
    } else {
      this.nextFlash = 0; // reset so re-entering a storm waits again
    }
  }
}
