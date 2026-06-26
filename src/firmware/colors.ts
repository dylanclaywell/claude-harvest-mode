/**
 * RGB565 color helpers. Matches the 16-bit color format used by TFT_eSPI /
 * Adafruit_GFX, so color constants port directly to C++.
 */

/** Pack 8-bit r,g,b (0-255) into a 16-bit RGB565 integer. */
export function rgb565(r: number, g: number, b: number): number {
  return ((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3);
}

// Common named colors (same values as TFT_eSPI's defines).
export const COLOR_BLACK = 0x0000;
export const COLOR_WHITE = 0xffff;
export const COLOR_RED = 0xf800;
export const COLOR_GREEN = 0x07e0;
export const COLOR_BLUE = 0x001f;
export const COLOR_YELLOW = 0xffe0;
export const COLOR_CYAN = 0x07ff;
export const COLOR_MAGENTA = 0xf81f;
export const COLOR_GRAY = 0x8410;
