// daynight.ts — time-of-day lighting for the farm. No WebGL: a single
// full-screen translucent tint whose color and strength follow the wall clock.
// Brightest in early afternoon (no tint); warm at dawn/dusk; dark and blue at
// night.
//
// Draw AFTER the world (ground, entities, tree-tops) but BEFORE the HUD, so the
// day/season bar and stamina meter stay readable.

/** A tint keyframe: hour of day, overlay color, and its alpha. Lerped between. */
interface Key { h: number; c: [number, number, number]; a: number; }

// Keyframes around the clock (0..24). Alpha 0 at midday = no tint (brightest).
// The 0h and 24h entries match so the cycle wraps seamlessly across midnight.
const KEYS: Key[] = [
  { h: 0,    c: [18, 26, 62],   a: 0.58 }, // deep night
  { h: 5,    c: [30, 36, 74],   a: 0.5 },  // pre-dawn
  { h: 6.5,  c: [232, 120, 60], a: 0.34 }, // dawn — warm
  { h: 9,    c: [255, 224, 156], a: 0.08 }, // soft morning
  { h: 13,   c: [255, 255, 255], a: 0.0 },  // afternoon — brightest
  { h: 16,   c: [255, 240, 200], a: 0.05 }, // late afternoon
  { h: 18,   c: [240, 128, 48],  a: 0.36 }, // dusk — warm
  { h: 20,   c: [56, 48, 90],    a: 0.5 },  // twilight
  { h: 24,   c: [18, 26, 62],    a: 0.58 }, // wrap to deep night
];

/** Fractional hour of a Date, 0..24. */
function hourOf(now: Date): number {
  return now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600;
}

// Dev-only clock override. When set, the lighting uses this hour instead of the
// real wall clock (the HUD/season still follow the real Date). null = off.
let overrideHour: number | null = null;
export function setDayNightOverride(h: number | null): void {
  overrideHour = h === null ? null : ((h % 24) + 24) % 24;
}
export function getDayNightOverride(): number | null { return overrideHour; }

function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }

/** Interpolated tint for the given hour. */
function tintAt(h: number): { r: number; g: number; b: number; a: number } {
  let lo = KEYS[0], hi = KEYS[KEYS.length - 1];
  for (let i = 0; i < KEYS.length - 1; i++) {
    if (h >= KEYS[i].h && h <= KEYS[i + 1].h) { lo = KEYS[i]; hi = KEYS[i + 1]; break; }
  }
  const span = hi.h - lo.h || 1;
  const t = (h - lo.h) / span;
  return {
    r: lerp(lo.c[0], hi.c[0], t),
    g: lerp(lo.c[1], hi.c[1], t),
    b: lerp(lo.c[2], hi.c[2], t),
    a: lerp(lo.a, hi.a, t),
  };
}

/**
 * Apply the day/night pass to the buffer: a single ambient tint whose color and
 * strength follow the (optionally overridden) hour. `W`/`H` are the buffer dims.
 */
export function applyDayNight(ctx: CanvasRenderingContext2D, W: number, H: number, now: Date): void {
  const h = overrideHour ?? hourOf(now);
  const c = tintAt(h);
  if (c.a > 0.001) {
    ctx.save();
    ctx.globalAlpha = c.a;
    ctx.fillStyle = `rgb(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)})`;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }
}
