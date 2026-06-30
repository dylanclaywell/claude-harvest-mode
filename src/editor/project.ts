/**
 * Sprite editor project model + codegen.
 *
 * Pixels are palette INDICES (roles), capped at 16 colors — that 16-color
 * limit is what reads as "8-bit". A project carries one or more named palette
 * variants (e.g. rarity tiers) that all share those roles, so swapping the
 * palette recolors every frame for free — the whole point of the indexed
 * format. Each color is a 24-bit 0xRRGGBB int (no quantization).
 *
 * Outputs from one source:
 *   - the .json project (source of truth, committed to git)
 *   - a TypeScript module (imported by the game)
 */

export const PALETTE_SIZE = 16; // 16-color cap (4-bit indices)
export const TRANSPARENT_INDEX = 0;

/** A named palette variant. `colors[0]` is the transparent slot; its value is ignored at render time. */
export interface Palette {
  name: string;
  rarity: string;
  colors: number[];
}

/**
 * Which axes a tile may be randomly mirrored on when laid in a tilemap, to break
 * up visible repetition. "none" = always upright. The flip per cell is chosen
 * deterministically from its coords (see tileFlipAt) so it's stable across
 * redraws and identical in the editor preview and the game.
 */
export type TileFlip = "none" | "h" | "v" | "hv";

/**
 * What a sprite is for. "sprite" (default) = drawn at a position (actors, props,
 * UI). "tile" = grid art placed in a tilemap; only tiles carry tile-specific
 * behavior like random mirror flips. Extend (e.g. "object") as the scene model
 * grows.
 */
export type SpriteKind = "sprite" | "tile";

/** Hash two integers to a well-mixed unsigned 32-bit value (stable, no state). */
function hash2(x: number, y: number): number {
  let h = (Math.imul(x | 0, 0x1656_67b1) ^ Math.imul(y | 0, 0x4f6c_dd1d)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b_3c6d) >>> 0;
  return (h ^ (h >>> 13)) >>> 0;
}

/** Deterministic per-cell flip for a tile at (col,row), limited by allowed axes. */
export function tileFlipAt(flip: TileFlip | undefined, col: number, row: number): { flipX: boolean; flipY: boolean } {
  if (!flip || flip === "none") return { flipX: false, flipY: false };
  const h = hash2(col, row);
  const allowH = flip === "h" || flip === "hv";
  const allowV = flip === "v" || flip === "hv";
  return { flipX: allowH && (h & 1) === 1, flipY: allowV && (h & 2) === 2 };
}

export interface SpriteProject {
  name: string;
  width: number;
  height: number;
  depth: 4;
  /**
   * Optional human label per palette slot, indexed by slot (parallel to a
   * palette's `colors`). Lives at the project level, not per-variant, because
   * slot N is the same role in every variant. names[0] (transparent) is
   * ignored. Slots sharing a base name (after stripping a shade suffix like
   * `_shadow`) form one recolorable part for the character customizer.
   */
  names?: string[];
  /** Variants sharing the same index roles. [0] is the base/default. */
  palettes: Palette[];
  /** Each frame is width*height palette indices, row-major. */
  frames: number[][];
  /**
   * Named animations: clip name -> ordered frame indices to play. Lets one
   * sprite hold several anims (idle/walk/harvest) instead of a file each. The
   * game's animFrame() resolves a clip to a frame by wall-clock; `idle` is the
   * conventional default. Empty = the sprite has no time-based animation
   * (e.g. crop frames are growth STAGES, addressed by data, not cycled).
   */
  clips: Record<string, number[]>;
  /** What this sprite is for. Default "sprite"; "tile" enables tilemap behavior. */
  kind?: SpriteKind;
  /** Allowed random mirror axes when this sprite is tiled. Default "none". */
  tileFlip?: TileFlip;
}

export function newProject(name: string, width: number, height: number): SpriteProject {
  return {
    name,
    width,
    height,
    depth: 4,
    palettes: [{ name: "base", rarity: "common", colors: [0x000000, 0x000000, 0xffffff] }],
    frames: [blankFrame(width, height)],
    clips: {},
  };
}

export function blankFrame(width: number, height: number): number[] {
  return new Array(width * height).fill(TRANSPARENT_INDEX);
}

/** A new variant cloned from an existing one (preserves role count). */
export function clonePalette(src: Palette, name: string): Palette {
  return { name, rarity: src.rarity, colors: src.colors.slice() };
}

// --- project (de)serialize ---

export function toJson(p: SpriteProject): string {
  return JSON.stringify(p, null, 2);
}

interface LegacyProject {
  palette?: number[];
  palettes?: Palette[];
  names?: string[];
  width?: number;
  height?: number;
  frames?: number[][];
  name?: string;
  clips?: Record<string, number[]>;
  kind?: SpriteKind;
  tileFlip?: TileFlip;
}

const TILE_FLIPS: TileFlip[] = ["none", "h", "v", "hv"];

/**
 * Normalize a slot name to a stable identifier so the customizer's suffix
 * grouping is predictable: lowercase, non-alphanumerics collapse to `_`.
 * Empty/blank → undefined (an unnamed, non-customizable slot).
 */
export function normalizeName(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const s = raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return s || undefined;
}

// Shade modifiers, each a position on the lighten/darken scale. A trailing
// number scales the level: `shirt_shadow2` = two shadow steps, `shirt_hi3` =
// three highlight steps. Bare modifier = level 1.
const SHADE_SUFFIX: Record<string, number> = {
  shadow: -1, shade: -1, dark: -1,
  hi: 1, light: 1, highlight: 1, lit: 1,
};

export interface SlotRole {
  /** Part this slot belongs to (the name with any shade suffix stripped). */
  base: string;
  /** Shade offset: 0 = the base color, <0 = shadow, >0 = highlight. */
  steps: number;
}

/**
 * Split a slot name into its part + shade level. `shirt` → {base:"shirt",
 * steps:0}; `shirt_shadow` → {steps:-1}; `shirt_shadow2` → {steps:-2};
 * `hat_hi` → {steps:+1}. Unrecognized suffix → the whole name is the base.
 */
export function parseSlotName(name: string): SlotRole {
  const m = /^(.*)_([a-z]+)(\d*)$/.exec(name);
  if (m) {
    const dir = SHADE_SUFFIX[m[2]];
    if (dir !== undefined && m[1]) {
      const level = m[3] ? parseInt(m[3], 10) : 1;
      return { base: m[1], steps: dir * level };
    }
  }
  return { base: name, steps: 0 };
}

/** Keep only valid name strings, trimmed to the palette cap; blanks become "". */
function sanitizeNames(names: unknown): string[] | undefined {
  if (!Array.isArray(names)) return undefined;
  const out = names.slice(0, PALETTE_SIZE).map((n) => normalizeName(typeof n === "string" ? n : "") ?? "");
  return out.some((n) => n) ? out : undefined;
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
    names: sanitizeNames(o.names),
    palettes,
    frames: o.frames,
    clips: sanitizeClips(o.clips, o.frames.length),
    kind: o.kind === "tile" ? "tile" : undefined,
    // tileFlip only applies to tiles.
    tileFlip:
      o.kind === "tile" && TILE_FLIPS.includes(o.tileFlip as TileFlip) && o.tileFlip !== "none" ? o.tileFlip : undefined,
  };
}

/** Keep only valid clips: arrays of in-range integer frame indices. */
export function sanitizeClips(clips: Record<string, number[]> | undefined, frameCount: number): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  if (!clips) return out;
  for (const [name, seq] of Object.entries(clips)) {
    if (!name || !Array.isArray(seq)) continue;
    const valid = seq.filter((i) => Number.isInteger(i) && i >= 0 && i < frameCount);
    if (valid.length) out[name] = valid;
  }
  return out;
}

// --- single palette (de)serialize (.pal.json) ---

export function paletteToJson(pal: Palette): string {
  return JSON.stringify({ name: pal.name, rarity: pal.rarity, colors: pal.colors }, null, 2);
}

export function paletteFromJson(text: string): Palette {
  const o = JSON.parse(text) as Partial<Palette>;
  if (!Array.isArray(o.colors) || o.colors.length < 1) throw new Error("not a valid palette");
  const colors = o.colors.slice(0, PALETTE_SIZE).map((c) => c & 0xffffff);
  return { name: o.name ?? "imported", rarity: o.rarity ?? "common", colors };
}

// --- codegen ---

/** The exported const name for a sprite module (e.g. "tile5" -> "TILE5"). */
export function constName(name: string): string {
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

function hex24(c: number): string {
  return "0x" + (c & 0xffffff).toString(16).padStart(6, "0");
}

/** Pad a variant's colors to the full 16 slots so any index resolves to a color. */
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
    .map((pal) => `    ${key(pal.name, used)}: Uint32Array.from([${padded(pal.colors).map(hex24).join(", ")}]),`)
    .join("\n");
  const frames = p.frames
    .map((f) => `    Uint8Array.from([\n      ${rows(f, p.width).join(",\n      ")},\n    ])`)
    .join(",\n");
  const clips = Object.entries(sanitizeClips(p.clips, p.frames.length))
    .map(([name, seq]) => `    ${JSON.stringify(name)}: [${seq.join(", ")}],`)
    .join("\n");
  // Slot names, padded to the palette width so index N aligns with colors[N].
  const slotCount = p.palettes[0]?.colors.length ?? 0;
  const namesArr = p.names?.length
    ? Array.from({ length: slotCount }, (_, i) => JSON.stringify(p.names?.[i] ?? "")).join(", ")
    : "";
  const namesField = namesArr ? `  names: [${namesArr}],\n` : "";
  const kindField = p.kind === "tile" ? `  kind: "tile",\n` : "";
  const tileFlipField = p.kind === "tile" && p.tileFlip && p.tileFlip !== "none" ? `  tileFlip: ${JSON.stringify(p.tileFlip)},\n` : "";
  return `// AUTO-GENERATED by \`npm run gen\` from assets/${p.name}.json. Do not hand-edit.
export const ${NAME} = {
  width: ${p.width},
  height: ${p.height},
  depth: ${p.depth},
  transparentIndex: ${TRANSPARENT_INDEX},
${kindField}${namesField}${tileFlipField}  palettes: {
${palettes}
  },
  clips: {
${clips}
  },
  frames: [
${frames},
  ],
} as const;
`;
}
