// color.ts — 24-bit RGB color helpers. Colors are stored as 0xRRGGBB ints
// (one per palette role). No quantization: the editor's <input type=color> is
// 24-bit and we keep every bit. The "retro" constraint lives in the 16-color
// indexed palette (see project.ts), not in color precision.

/** Pack 8-bit r,g,b (0-255) into a 24-bit 0xRRGGBB int. */
export function rgb(r: number, g: number, b: number): number {
  return ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
}

/** Split 0xRRGGBB into [r, g, b]. */
export function rgbParts(c: number): [number, number, number] {
  return [(c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff];
}

/** "#rrggbb" (from <input type=color>) → 0xRRGGBB. */
export function hexToInt(hex: string): number {
  return parseInt(hex.slice(1), 16) & 0xffffff;
}

/** 0xRRGGBB → "#rrggbb". */
export function intToHex(c: number): string {
  return "#" + (c & 0xffffff).toString(16).padStart(6, "0");
}

/** 0xRRGGBB → "rgb(r,g,b)" CSS string. */
export function intToCss(c: number): string {
  const [r, g, b] = rgbParts(c);
  return `rgb(${r},${g},${b})`;
}

// --- HSL conversion + shading ----------------------------------------------
// Shadows/highlights are derived from a base color by ONE algorithm, shared by
// the saved-palette fixup and the live character customizer, so a slot named
// `x_shadow` always equals shade(x, -1). Convention pixel-art rule: shadows go
// darker + more saturated + hue toward cool; highlights the opposite.

export interface HSL { h: number; s: number; l: number } // h 0..360, s/l 0..1

/** 0xRRGGBB → HSL. */
export function rgbToHsl(c: number): HSL {
  const [r8, g8, b8] = rgbParts(c);
  const r = r8 / 255, g = g8 / 255, b = b8 / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    switch (max) {
      case r: h = ((g - b) / d) % 6; break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4; break;
    }
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s, l };
}

/** HSL → 0xRRGGBB. */
export function hslToRgb({ h, s, l }: HSL): number {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = ((h % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) [r, g] = [c, x];
  else if (hp < 2) [r, g] = [x, c];
  else if (hp < 3) [g, b] = [c, x];
  else if (hp < 4) [g, b] = [x, c];
  else if (hp < 5) [r, b] = [x, c];
  else [r, b] = [c, x];
  const m = l - c / 2;
  const to = (v: number) => Math.round(clamp01(v + m) * 255);
  return rgb(to(r), to(g), to(b));
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

// Per-step shading deltas (one "step" = one _shadow / _hi level). Tuned to the
// farmhand's hand-picked shadow (L −0.22, S +0.12, slight cool hue shift).
export const SHADE = {
  lStep: 0.2, // lightness change per level
  sStep: 0.1, // saturation change per level (shadows +, highlights −)
  hStep: 6, // degrees of hue rotation per level toward the temperature target
  shadowHue: 240, // shadows drift toward blue
  hiliteHue: 45, // highlights drift toward warm yellow
};

/** Rotate `h` toward `target` by at most `maxDeg`, taking the shorter arc. */
function rotateToward(h: number, target: number, maxDeg: number): number {
  let diff = ((target - h + 540) % 360) - 180; // shortest signed delta, -180..180
  if (Math.abs(diff) > maxDeg) diff = Math.sign(diff) * maxDeg;
  return (h + diff + 360) % 360;
}

/**
 * Shade a base color by `steps`: negative = darker shadow, positive = lighter
 * highlight, 0 = unchanged. The slider recolors a part's base, then re-derives
 * its shades with this same function so the relationship always holds.
 */
export function shade(base: number, steps: number): number {
  if (!steps) return base;
  const n = Math.abs(steps);
  const dir = Math.sign(steps); // +1 highlight, -1 shadow
  const hsl = rgbToHsl(base);
  const target = dir < 0 ? SHADE.shadowHue : SHADE.hiliteHue;
  return hslToRgb({
    h: rotateToward(hsl.h, target, SHADE.hStep * n),
    s: clamp01(hsl.s - dir * SHADE.sStep * n), // shadow (dir<0) raises saturation
    l: clamp01(hsl.l + dir * SHADE.lStep * n),
  });
}
