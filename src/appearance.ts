// appearance.ts — turn per-part slider settings into a recolored palette.
//
// The character customizer gives each named part (shirt, hair, ...) a hue /
// brightness / saturation offset. We apply that to the part's BASE color, then
// re-derive every shade slot of that part with shade() — the same algorithm the
// saved palette was reshaded with — so a slider moves the whole ramp coherently
// (shadows stay shadows). Slots with no appearance entry keep their authored
// color. Pure math, no DOM: sprites.ts bakes the result to canvases.

import { hslToRgb, rgbToHsl, shade } from "./color";
import { parseSlotName } from "./editor/project";

/** Per-part slider offsets. hue in degrees; bright/sat as -1..1 deltas. */
export interface PartAdjust {
  hue?: number;
  bright?: number;
  sat?: number;
}

/** part base-name -> its slider offsets. */
export type Appearance = Record<string, PartAdjust>;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Shift one color in HSL by a part's slider offsets. */
export function adjustColor(rgb: number, adj: PartAdjust): number {
  const { hue = 0, bright = 0, sat = 0 } = adj;
  const hsl = rgbToHsl(rgb);
  return hslToRgb({
    h: ((hsl.h + hue) % 360 + 360) % 360,
    s: clamp01(hsl.s + sat),
    l: clamp01(hsl.l + bright),
  });
}

/**
 * Build a recolored palette from base colors + slot names + appearance.
 * Returns a fresh color array (same length as `base`); unaffected slots are
 * copied through unchanged.
 */
export function applyAppearance(
  base: ArrayLike<number>,
  names: readonly string[] | undefined,
  appearance: Appearance,
): number[] {
  const colors = Array.from(base, (c) => c);
  if (!names) return colors;

  // part base-name -> index of its base (steps===0) slot.
  const baseIdx = new Map<string, number>();
  names.forEach((n, i) => {
    if (!n) return;
    const { base: part, steps } = parseSlotName(n);
    if (steps === 0) baseIdx.set(part, i);
  });

  names.forEach((n, i) => {
    if (!n) return;
    const { base: part, steps } = parseSlotName(n);
    const adj = appearance[part];
    const srcIdx = baseIdx.get(part);
    if (!adj || srcIdx === undefined) return; // not customized, or shade w/o base
    colors[i] = shade(adjustColor(base[srcIdx], adj), steps); // steps 0 -> just the adjusted base
  });
  return colors;
}

/**
 * Distinct customizable parts for a sprite: base names that have a base slot.
 * Each carries its current (authored) base color for UI swatches/defaults.
 */
export function listParts(names: readonly string[] | undefined, base: ArrayLike<number>): { part: string; color: number; slot: number }[] {
  if (!names) return [];
  const out: { part: string; color: number; slot: number }[] = [];
  const seen = new Set<string>();
  names.forEach((n, i) => {
    if (!n) return;
    const { base: part, steps } = parseSlotName(n);
    if (steps !== 0 || seen.has(part)) return;
    seen.add(part);
    out.push({ part, color: base[i], slot: i });
  });
  return out;
}
