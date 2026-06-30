// sprites.ts — sprite runtime for the game canvas. Turns a generated indexed
// sprite (src/generated/*.ts) into cached RGBA canvases and blits them,
// optionally integer-scaled and palette-swapped. This is the ONE place game
// code touches sprites: draw a crop, lay a ground tile, stamp the player.
//
// Authoring stays in editor.html → assets/*.json → `npm run gen`. Here we only
// consume the generated modules, so adding art is: gen it, register it below,
// call drawSprite/drawTiled. No per-call ImageData work — frames bake once.

import { rgbParts } from "./color";
import { type SpriteKind, type TileFlip } from "./editor/project";

import { GEN_SPRITES } from "./generated";
export * from "./generated"; // re-export every sprite const (CROP, FARMHAND, …)

/** Structural shape of a `npm run gen` sprite module (typed arrays are ArrayLike<number>). */
export interface GenSprite {
  readonly width: number;
  readonly height: number;
  readonly transparentIndex: number;
  /** What this sprite is for; "tile" = tilemap art. Default "sprite". */
  readonly kind?: SpriteKind;
  /** Optional per-slot role labels, index-aligned with each palette's colors. */
  readonly names?: readonly string[];
  /** Allowed random mirror axes when tiled (drawTileMap). Default none. */
  readonly tileFlip?: TileFlip;
  readonly palettes: Readonly<Record<string, ArrayLike<number>>>;
  /** Named animations: clip name -> ordered frame indices. May be absent/empty. */
  readonly clips?: Readonly<Record<string, readonly number[]>>;
  readonly frames: readonly ArrayLike<number>[];
}

export interface BlitOpts {
  /** Frame index; clamped to the sprite's frame count. */
  frame?: number;
  /** Integer pixel scale (1 = native). */
  scale?: number;
  /** Palette variant name (e.g. quality tier); falls back to "base". */
  palette?: string;
  /**
   * Per-slot custom colors (e.g. from the character customizer), overriding the
   * named `palette`. Cached single-slot per sprite by color signature, so live
   * recoloring re-bakes only when the colors actually change.
   */
  colors?: ArrayLike<number>;
  /** Mirror horizontally. Sprites are authored facing left; set true to face right. */
  flip?: boolean;
  /** Mirror vertically. */
  flipY?: boolean;
}

// sprite -> palette name -> one baked canvas per frame. WeakMap so unused
// sprites can be collected; the inner Map memoizes per palette variant.
const baked = new WeakMap<GenSprite, Map<string, HTMLCanvasElement[]>>();

function bakeFrame(s: GenSprite, palette: ArrayLike<number>, frame: ArrayLike<number>): HTMLCanvasElement {
  const cv = document.createElement("canvas");
  cv.width = s.width;
  cv.height = s.height;
  const c = cv.getContext("2d");
  if (!c) throw new Error("2D context unavailable for sprite bake");
  const img = c.createImageData(s.width, s.height);
  const d = img.data;
  for (let i = 0; i < frame.length; i++) {
    const idx = frame[i];
    const o = i * 4;
    if (idx === s.transparentIndex) { d[o + 3] = 0; continue; } // transparent slot
    const [r, g, b] = rgbParts(palette[idx] ?? 0);
    d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
  }
  c.putImageData(img, 0, 0);
  return cv;
}

function framesFor(s: GenSprite, paletteName: string): HTMLCanvasElement[] {
  let byPal = baked.get(s);
  if (!byPal) baked.set(s, (byPal = new Map()));
  let arr = byPal.get(paletteName);
  if (!arr) {
    const pal = s.palettes[paletteName] ?? s.palettes.base ?? Object.values(s.palettes)[0];
    arr = s.frames.map((f) => bakeFrame(s, pal, f));
    byPal.set(paletteName, arr);
  }
  return arr;
}

// Custom (arbitrary) palettes can't key the named cache — slider drags would
// fill it with one entry per intermediate color. Each sprite gets a single
// slot, re-baked only when the color signature changes. Sprites recolored this
// way (the player) are few, so one live palette each is plenty.
const customBaked = new WeakMap<GenSprite, { sig: string; frames: HTMLCanvasElement[] }>();

function framesForCustom(s: GenSprite, colors: ArrayLike<number>): HTMLCanvasElement[] {
  let sig = "";
  for (let i = 0; i < colors.length; i++) sig += colors[i].toString(36) + ",";
  const hit = customBaked.get(s);
  if (hit && hit.sig === sig) return hit.frames;
  const frames = s.frames.map((f) => bakeFrame(s, colors, f));
  customBaked.set(s, { sig, frames });
  return frames;
}

/** Blit one sprite frame to `ctx` at (dx,dy), integer-scaled. Pixel-perfect — caller sets imageSmoothingEnabled=false. */
export function drawSprite(ctx: CanvasRenderingContext2D, s: GenSprite, dx: number, dy: number, opts: BlitOpts = {}): void {
  const { frame = 0, scale = 1, palette = "base", colors, flip = false, flipY = false } = opts;
  const arr = colors ? framesForCustom(s, colors) : framesFor(s, palette);
  const cv = arr[Math.min(frame, arr.length - 1)] ?? arr[0];
  const w = s.width * scale, h = s.height * scale;
  if (flip || flipY) {
    const sx = flip ? -1 : 1, sy = flipY ? -1 : 1;
    ctx.save();
    // Move origin to the mirrored corner, then scale to flip about it.
    ctx.translate((dx | 0) + (flip ? w : 0), (dy | 0) + (flipY ? h : 0));
    ctx.scale(sx, sy);
    ctx.drawImage(cv, 0, 0, w, h);
    ctx.restore();
  } else {
    ctx.drawImage(cv, dx | 0, dy | 0, w, h);
  }
}

/**
 * Resolve a sprite's animation to a frame index by wall-clock. OPT-IN: only
 * entities that should animate over time call this — crops pick a frame by
 * growth stage directly, so they never cycle. `clip` selects a named animation;
 * with none, falls back to the "idle" clip, else the full frame list.
 */
export function animFrame(s: GenSprite, now: number, opts: { clip?: string; fps?: number } = {}): number {
  const { clip, fps = 6 } = opts;
  const seq = (clip ? s.clips?.[clip] : undefined) ?? s.clips?.idle ?? s.frames.map((_, i) => i);
  if (seq.length <= 1) return seq[0] ?? 0;
  return seq[Math.floor(now / (1000 / fps)) % seq.length];
}

/** Fill a cols×rows region of cells with one sprite frame (ground, fences, player tiles). */
export function drawTiled(ctx: CanvasRenderingContext2D, s: GenSprite, dx: number, dy: number, cols: number, rows: number, opts: BlitOpts = {}): void {
  const scale = opts.scale ?? 1;
  const w = s.width * scale, h = s.height * scale;
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    drawSprite(ctx, s, dx + x * w, dy + y * h, opts);
  }
}

/** Name → sprite, for data-driven lookup (animal species, tilemap cells). */
export const SPRITES: Record<string, GenSprite> = GEN_SPRITES;
