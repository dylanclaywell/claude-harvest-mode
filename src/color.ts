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
