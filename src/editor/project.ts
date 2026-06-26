import { rgb565 } from "../firmware/colors";
import { rgb565ToRgb } from "../platform/CanvasGfx";

/**
 * Sprite editor project model + codegen. A project is authored within the
 * exact hardware constraints (4-bit / 16-color palette, RGB565, magenta
 * color-key) so every export is portable to the ESP32 by construction.
 *
 * Pixels are palette INDICES (roles). A project carries one or more named
 * palette variants (e.g. rarity tiers) that all share those roles, so swapping
 * the palette recolors every frame for free — that is the whole point of the
 * indexed format.
 *
 * Outputs from one source:
 *   - the .json project (source of truth, committed to git)
 *   - a TypeScript module (emulator + portable, imported by the game)
 *   - a C++ PROGMEM header (the ESP32 twin)
 */

export const PALETTE_SIZE = 16; // 4-bit
export const TRANSPARENT_INDEX = 0;
export const TRANSPARENT_RGB565 = 0xf81f; // magenta color-key

/** A named palette variant. `colors[0]` is always the transparent key. */
export interface Palette {
  name: string;
  rarity: string;
  colors: number[];
}

export interface SpriteProject {
  name: string;
  width: number;
  height: number;
  depth: 4;
  /** Variants sharing the same index roles. [0] is the base/default. */
  palettes: Palette[];
  /** Each frame is width*height palette indices, row-major. */
  frames: number[][];
}

export function newProject(name: string, width: number, height: number): SpriteProject {
  return {
    name,
    width,
    height,
    depth: 4,
    palettes: [{ name: "base", rarity: "common", colors: [TRANSPARENT_RGB565, 0x0000, 0xffff] }],
    frames: [blankFrame(width, height)],
  };
}

export function blankFrame(width: number, height: number): number[] {
  return new Array(width * height).fill(TRANSPARENT_INDEX);
}

/** A new variant cloned from an existing one (preserves role count). */
export function clonePalette(src: Palette, name: string): Palette {
  return { name, rarity: src.rarity, colors: src.colors.slice() };
}

// --- color helpers ---

/** "#rrggbb" (from an <input type=color>) snapped to the nearest RGB565. */
export function hexToRgb565(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return rgb565((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
}

/** RGB565 -> "#rrggbb", showing the actual (rounded) on-device color. */
export function rgb565ToHex(c: number): string {
  const [r, g, b] = rgb565ToRgb(c);
  return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
}

// --- project (de)serialize ---

export function toJson(p: SpriteProject): string {
  return JSON.stringify(p, null, 2);
}

interface LegacyProject {
  palette?: number[];
  palettes?: Palette[];
  width?: number;
  height?: number;
  frames?: number[][];
  name?: string;
}

export function fromJson(text: string): SpriteProject {
  const o = JSON.parse(text) as LegacyProject;
  if (!o.width || !o.height || !Array.isArray(o.frames)) {
    throw new Error("not a valid sprite project");
  }
  // Migrate the old single-palette format.
  let palettes = o.palettes;
  if (!palettes && Array.isArray(o.palette)) {
    palettes = [{ name: "base", rarity: "common", colors: o.palette }];
  }
  if (!palettes || !palettes.length) throw new Error("project has no palettes");
  return {
    name: o.name ?? "sprite",
    width: o.width,
    height: o.height,
    depth: 4,
    palettes,
    frames: o.frames,
  };
}

// --- single palette (de)serialize (.pal.json) ---

export function paletteToJson(pal: Palette): string {
  return JSON.stringify({ name: pal.name, rarity: pal.rarity, colors: pal.colors }, null, 2);
}

export function paletteFromJson(text: string): Palette {
  const o = JSON.parse(text) as Partial<Palette>;
  if (!Array.isArray(o.colors) || o.colors.length < 1) throw new Error("not a valid palette");
  const colors = o.colors.slice(0, PALETTE_SIZE).map((c) => c & 0xffff);
  colors[TRANSPARENT_INDEX] = TRANSPARENT_RGB565; // enforce the transparent key
  return { name: o.name ?? "imported", rarity: o.rarity ?? "common", colors };
}

// --- codegen ---

function constName(name: string): string {
  const s = name.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
  return /^[A-Z]/.test(s) ? s : "SPRITE_" + s;
}

function key(name: string, used: Set<string>): string {
  let k = name.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();
  if (!k || !/^[a-z]/.test(k)) k = "p_" + k;
  let out = k;
  let n = 1;
  while (used.has(out)) out = k + "_" + n++;
  used.add(out);
  return out;
}

function hex16(c: number): string {
  return "0x" + (c & 0xffff).toString(16).padStart(4, "0");
}

/** Pad a variant's colors to the full 16 entries hardware createPalette() expects. */
function padded(colors: number[]): number[] {
  const out = colors.slice(0, PALETTE_SIZE);
  while (out.length < PALETTE_SIZE) out.push(0);
  return out;
}

/** Chunk a flat index array into width-sized rows for readable output. */
function rows(frame: number[], width: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < frame.length; i += width) out.push(frame.slice(i, i + width).join(", "));
  return out;
}

export function toTypeScript(p: SpriteProject): string {
  const NAME = constName(p.name);
  const used = new Set<string>();
  const palettes = p.palettes
    .map((pal) => `    ${key(pal.name, used)}: Uint16Array.from([${padded(pal.colors).map(hex16).join(", ")}]),`)
    .join("\n");
  const frames = p.frames
    .map((f) => `    Uint8Array.from([\n      ${rows(f, p.width).join(",\n      ")},\n    ])`)
    .join(",\n");
  return `// AUTO-GENERATED by \`npm run gen\` from assets/${p.name}.json. Do not hand-edit.
export const ${NAME} = {
  width: ${p.width},
  height: ${p.height},
  depth: ${p.depth},
  transparentIndex: ${TRANSPARENT_INDEX},
  palettes: {
${palettes}
  },
  frames: [
${frames},
  ],
} as const;
`;
}

export function toHeader(p: SpriteProject): string {
  const NAME = constName(p.name);
  const used = new Set<string>();
  const variants = p.palettes.map((pal) => ({ pal, k: key(pal.name, used).toUpperCase() }));
  const palDecls = variants
    .map(({ pal, k }) => `const uint16_t ${NAME}_PALETTE_${k}[${PALETTE_SIZE}] PROGMEM = { ${padded(pal.colors).map(hex16).join(", ")} };`)
    .join("\n");
  const table = variants.map(({ k }) => `${NAME}_PALETTE_${k}`).join(", ");
  const frames = p.frames.map((f) => `  {\n    ${rows(f, p.width).join(",\n    ")},\n  }`).join(",\n");
  const cells = p.width * p.height;
  return `#pragma once
#include <Arduino.h>
// AUTO-GENERATED by \`npm run gen\` from assets/${p.name}.json. Do not hand-edit.

constexpr uint16_t ${NAME}_WIDTH = ${p.width};
constexpr uint16_t ${NAME}_HEIGHT = ${p.height};
constexpr uint8_t  ${NAME}_FRAME_COUNT = ${p.frames.length};
constexpr uint8_t  ${NAME}_TRANSPARENT_INDEX = ${TRANSPARENT_INDEX};
constexpr uint8_t  ${NAME}_PALETTE_COUNT = ${variants.length};

${palDecls}
const uint16_t* const ${NAME}_PALETTES[${variants.length}] PROGMEM = { ${table} };

const uint8_t ${NAME}_FRAMES[${p.frames.length}][${cells}] PROGMEM = {
${frames},
};
`;
}
