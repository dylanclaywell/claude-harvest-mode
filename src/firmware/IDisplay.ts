/**
 * Abstract graphics interfaces. These mirror the TFT_eSPI / Adafruit_GFX API
 * (method names, argument order, color-last convention) so firmware drawing
 * code ports to C++ by swapping the object it is called on — `display.fillRect`
 * becomes `tft.fillRect`, `spr.fillRect`, etc. — and recompiling.
 *
 * Colors are 16-bit RGB565 integers (same as the real TFT). Build them with the
 * helpers in `colors.ts` or `color565()`.
 *
 * The firmware (game + view) draws ONLY through these interfaces. It must never
 * reference the canvas or the DOM. On real hardware these are backed by
 * TFT_eSPI / TFT_eSprite; in the emulator they are backed by the Canvas2D
 * classes in `src/platform/`.
 */

/** Sprite memory model, mirroring TFT_eSprite::setColorDepth(). */
export type ColorDepth = 1 | 4 | 8 | 16;

/**
 * Drawing surface shared by the main display and off-screen sprites — the
 * common subset of TFT_eSPI and TFT_eSprite. Anything that can be drawn on
 * both implements this.
 */
export interface IGfx {
  width(): number;
  height(): number;

  /** Pack 8-bit r,g,b into RGB565. Mirrors tft.color565(). */
  color565(r: number, g: number, b: number): number;

  /** Fill the entire surface with one color. */
  fillScreen(color: number): void;

  drawPixel(x: number, y: number, color: number): void;
  drawLine(x0: number, y0: number, x1: number, y1: number, color: number): void;

  /** Horizontal / vertical fast lines (single fillRect on hardware). */
  drawFastHLine(x: number, y: number, w: number, color: number): void;
  drawFastVLine(x: number, y: number, h: number, color: number): void;

  drawRect(x: number, y: number, w: number, h: number, color: number): void;
  fillRect(x: number, y: number, w: number, h: number, color: number): void;

  drawRoundRect(x: number, y: number, w: number, h: number, r: number, color: number): void;
  fillRoundRect(x: number, y: number, w: number, h: number, r: number, color: number): void;

  drawCircle(x: number, y: number, r: number, color: number): void;
  fillCircle(x: number, y: number, r: number, color: number): void;

  drawTriangle(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, color: number): void;
  fillTriangle(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, color: number): void;

  /**
   * Blit a block of pixels (row-major, length w*h) at (x, y). Mirrors
   * TFT_eSPI::pushImage and its overloads:
   *   - `Uint16Array` data = direct RGB565; `transparent` is an RGB565 value.
   *   - `Uint8Array` data = palette INDICES; `transparent` is an index. The
   *     palette comes from the `palette` argument, or (on a sprite) the one set
   *     via createPalette(). This is the indexed-bitmap / sprite-sheet path.
   * Pixels equal to `transparent` are skipped (color-key). This is how
   * flash-stored bitmaps / backgrounds are drawn on hardware.
   */
  pushImage(
    x: number,
    y: number,
    w: number,
    h: number,
    data: Uint16Array | Uint8Array,
    transparent?: number,
    palette?: Uint16Array | number[],
  ): void;

  // --- Stateful text, mirroring GFX / TFT_eSPI ---

  /** Set text color. With `bg`, glyph cells are drawn on an opaque background. */
  setTextColor(color: number, bg?: number): void;
  /** Integer scale factor (1 = 6x8 classic font cell). */
  setTextSize(size: number): void;
  setCursor(x: number, y: number): void;
  /** Enable/disable wrapping to the next line at the surface edge. */
  setTextWrap(wrap: boolean): void;
  /** Print at the cursor, advancing it (handles `\n`). */
  print(text: string): void;
  println(text: string): void;
  /** One-shot draw at (x, y); does not move the cursor. Returns advance width. */
  drawString(text: string, x: number, y: number): number;
}

/**
 * The main display: a drawing surface that can also rotate and spawn sprites.
 * Mirrors TFT_eSPI.
 */
export interface IDisplay extends IGfx {
  /** 0-3, in 90-degree steps. Swaps reported width/height for 1 and 3. */
  setRotation(rotation: number): void;

  /** SPI transaction batching. No-op in the emulator; kept for port parity. */
  startWrite(): void;
  endWrite(): void;

  /**
   * Allocate an off-screen sprite (RAM framebuffer) of w x h. Mirrors
   * `TFT_eSprite spr(&tft); spr.createSprite(w, h);` collapsed into one call.
   * Composite into it and `pushSprite()` for flicker-free / dirty-rect drawing.
   */
  createSprite(w: number, h: number): ISprite;
}

/**
 * Off-screen drawing buffer. Mirrors TFT_eSprite: the full IGfx drawing API
 * plus depth/palette control and push-to-display.
 */
export interface ISprite extends IGfx {
  /**
   * Set the memory model. 16 = direct RGB565. 8/4/1 = palette-indexed: after
   * createPalette(), color arguments to draw calls are palette INDICES, exactly
   * like TFT_eSprite. Halves (8-bit) / quarters (4-bit) the RAM a sprite costs.
   */
  setColorDepth(bpp: ColorDepth): void;
  /** Define the palette for an indexed (<16-bit) sprite. */
  createPalette(palette: Uint16Array | number[]): void;
  /** Fill the whole sprite (alias of fillScreen, TFT_eSprite name). */
  fillSprite(color: number): void;
  /** Blit this sprite to the display at (x, y), optional color-key transparent. */
  pushSprite(x: number, y: number, transparent?: number): void;
  /** Free the sprite's buffer. */
  deleteSprite(): void;
}
