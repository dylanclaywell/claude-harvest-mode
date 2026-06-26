import { IGfx } from "../firmware/IDisplay";
import { rgb565 } from "../firmware/colors";
import { FONT_5X7, GLYPH_COLS, GLYPH_ROWS } from "./glcdfont";

// GFX classic font: 5px glyph + 1px right spacing = 6px cell, 8px tall.
const CELL_W = GLYPH_COLS + 1;
const CELL_H = GLYPH_ROWS;

/** Expand a 16-bit RGB565 color to 8-bit [r, g, b]. */
export function rgb565ToRgb(c: number): [number, number, number] {
  const r = Math.round(((c >> 11) & 0x1f) * 255 / 31);
  const g = Math.round(((c >> 5) & 0x3f) * 255 / 63);
  const b = Math.round((c & 0x1f) * 255 / 31);
  return [r, g, b];
}

/** Convert a 16-bit RGB565 color to a CSS rgb() string. */
export function rgb565ToCss(c: number): string {
  const [r, g, b] = rgb565ToRgb(c);
  return `rgb(${r},${g},${b})`;
}

/**
 * Canvas2D implementation of the shared IGfx drawing API. Subclassed by both
 * CanvasDisplay (main screen) and CanvasSprite (off-screen buffer), exactly as
 * TFT_eSPI and TFT_eSprite share their drawing methods.
 *
 * Color values are turned into pixels through `resolveColor`, which the sprite
 * subclass overrides to implement palette (4/8-bit) mode.
 */
export abstract class CanvasGfx implements IGfx {
  protected w: number;
  protected h: number;

  // Text state, mirroring GFX / TFT_eSPI cursor/color/size globals.
  private textColor = 0xffff;
  private textBg: number | null = null;
  private textSize = 1;
  private cursorX = 0;
  private cursorY = 0;
  private wrap = true;

  constructor(
    protected readonly ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
  ) {
    this.w = w;
    this.h = h;
    this.ctx.imageSmoothingEnabled = false;
  }

  /**
   * Resolve a draw-call color value to an RGB565 number. Identity for the main
   * display; the sprite subclass overrides this to look up palette indices.
   */
  protected toRgb565(color: number): number {
    return color;
  }

  /** Map a draw-call color value to a CSS color string. */
  protected resolveColor(color: number): string {
    return rgb565ToCss(this.toRgb565(color));
  }

  width(): number {
    return this.w;
  }
  height(): number {
    return this.h;
  }

  color565(r: number, g: number, b: number): number {
    return rgb565(r, g, b);
  }

  fillScreen(color: number): void {
    this.ctx.fillStyle = this.resolveColor(color);
    this.ctx.fillRect(0, 0, this.w, this.h);
  }

  drawPixel(x: number, y: number, color: number): void {
    this.ctx.fillStyle = this.resolveColor(color);
    this.ctx.fillRect(x | 0, y | 0, 1, 1);
  }

  drawLine(x0: number, y0: number, x1: number, y1: number, color: number): void {
    this.ctx.strokeStyle = this.resolveColor(color);
    this.ctx.lineWidth = 1;
    this.ctx.beginPath();
    // +0.5 keeps 1px lines crisp on the pixel grid.
    this.ctx.moveTo((x0 | 0) + 0.5, (y0 | 0) + 0.5);
    this.ctx.lineTo((x1 | 0) + 0.5, (y1 | 0) + 0.5);
    this.ctx.stroke();
  }

  drawFastHLine(x: number, y: number, w: number, color: number): void {
    this.fillRect(x, y, w, 1, color);
  }

  drawFastVLine(x: number, y: number, h: number, color: number): void {
    this.fillRect(x, y, 1, h, color);
  }

  drawRect(x: number, y: number, w: number, h: number, color: number): void {
    this.ctx.strokeStyle = this.resolveColor(color);
    this.ctx.lineWidth = 1;
    this.ctx.strokeRect((x | 0) + 0.5, (y | 0) + 0.5, w - 1, h - 1);
  }

  fillRect(x: number, y: number, w: number, h: number, color: number): void {
    this.ctx.fillStyle = this.resolveColor(color);
    this.ctx.fillRect(x | 0, y | 0, w | 0, h | 0);
  }

  drawRoundRect(x: number, y: number, w: number, h: number, r: number, color: number): void {
    this.ctx.strokeStyle = this.resolveColor(color);
    this.ctx.lineWidth = 1;
    this.roundRectPath(x + 0.5, y + 0.5, w - 1, h - 1, r);
    this.ctx.stroke();
  }

  fillRoundRect(x: number, y: number, w: number, h: number, r: number, color: number): void {
    this.ctx.fillStyle = this.resolveColor(color);
    this.roundRectPath(x, y, w, h, r);
    this.ctx.fill();
  }

  drawCircle(x: number, y: number, r: number, color: number): void {
    this.ctx.strokeStyle = this.resolveColor(color);
    this.ctx.lineWidth = 1;
    this.ctx.beginPath();
    this.ctx.arc(x, y, r, 0, Math.PI * 2);
    this.ctx.stroke();
  }

  fillCircle(x: number, y: number, r: number, color: number): void {
    this.ctx.fillStyle = this.resolveColor(color);
    this.ctx.beginPath();
    this.ctx.arc(x, y, r, 0, Math.PI * 2);
    this.ctx.fill();
  }

  drawTriangle(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, color: number): void {
    this.ctx.strokeStyle = this.resolveColor(color);
    this.ctx.lineWidth = 1;
    this.trianglePath(x0, y0, x1, y1, x2, y2, 0.5);
    this.ctx.stroke();
  }

  fillTriangle(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, color: number): void {
    this.ctx.fillStyle = this.resolveColor(color);
    this.trianglePath(x0, y0, x1, y1, x2, y2, 0);
    this.ctx.fill();
  }

  pushImage(
    x: number,
    y: number,
    w: number,
    h: number,
    data: Uint16Array | Uint8Array,
    transparent?: number,
    palette?: Uint16Array | number[],
  ): void {
    const indexed = data instanceof Uint8Array;
    const pal = palette === undefined ? null : palette instanceof Uint16Array ? palette : Uint16Array.from(palette);
    const img = this.ctx.createImageData(w, h);
    const px = img.data;
    for (let i = 0; i < w * h; i++) {
      const v = data[i];
      const o = i * 4;
      if (transparent !== undefined && v === transparent) {
        px[o + 3] = 0; // skip (color-key) — compared in source units (index or RGB565)
        continue;
      }
      // Resolve to RGB565: direct for 16-bit data, via palette arg or the
      // surface's own palette (toRgb565) for indexed data.
      const rgb = !indexed ? v : pal ? (pal[v] ?? 0) : this.toRgb565(v);
      const [r, g, b] = rgb565ToRgb(rgb);
      px[o] = r;
      px[o + 1] = g;
      px[o + 2] = b;
      px[o + 3] = 255;
    }
    this.blit(img, x, y);
  }

  // --- Text ---

  setTextColor(color: number, bg?: number): void {
    this.textColor = color;
    this.textBg = bg ?? null;
  }
  setTextSize(size: number): void {
    this.textSize = Math.max(1, size | 0);
  }
  setCursor(x: number, y: number): void {
    this.cursorX = x | 0;
    this.cursorY = y | 0;
  }
  setTextWrap(wrap: boolean): void {
    this.wrap = wrap;
  }

  print(text: string): void {
    const end = this.putText(text, this.cursorX, this.cursorY, this.wrap);
    this.cursorX = end.x;
    this.cursorY = end.y;
  }
  println(text: string): void {
    this.print(text + "\n");
  }

  drawString(text: string, x: number, y: number): number {
    const end = this.putText(text, x, y, false);
    return end.x - (x | 0);
  }

  /**
   * Render the real Adafruit GFX classic bitmap font, pixel-for-pixel, scaled
   * by the integer text size — same glyphs TFT_eSPI draws on hardware. Returns
   * the end cursor position.
   */
  private putText(text: string, x: number, y: number, wrap: boolean): { x: number; y: number } {
    const size = this.textSize;
    const cellW = CELL_W * size;
    const cellH = CELL_H * size;
    const fg = this.resolveColor(this.textColor);
    const bg = this.textBg === null ? null : this.resolveColor(this.textBg);
    const ox = x | 0;
    let cx = ox;
    let cy = y | 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text.charCodeAt(i);
      if (ch === 10) {
        cx = ox;
        cy += cellH;
        continue;
      }
      if (wrap && cx + cellW > this.w) {
        cx = ox;
        cy += cellH;
      }
      if (bg !== null) {
        this.ctx.fillStyle = bg;
        this.ctx.fillRect(cx, cy, cellW, cellH);
      }
      this.drawGlyph(cx, cy, ch & 0xff, size, fg);
      cx += cellW;
    }
    return { x: cx, y: cy };
  }

  private drawGlyph(x: number, y: number, ch: number, size: number, css: string): void {
    this.ctx.fillStyle = css;
    const base = ch * GLYPH_COLS;
    for (let col = 0; col < GLYPH_COLS; col++) {
      const bits = FONT_5X7[base + col];
      for (let row = 0; row < GLYPH_ROWS; row++) {
        if (bits & (1 << row)) {
          this.ctx.fillRect(x + col * size, y + row * size, size, size);
        }
      }
    }
  }

  // --- shared path helpers ---

  private roundRectPath(x: number, y: number, w: number, h: number, r: number): void {
    const rr = Math.min(r, w / 2, h / 2);
    const c = this.ctx;
    c.beginPath();
    c.moveTo(x + rr, y);
    c.arcTo(x + w, y, x + w, y + h, rr);
    c.arcTo(x + w, y + h, x, y + h, rr);
    c.arcTo(x, y + h, x, y, rr);
    c.arcTo(x, y, x + w, y, rr);
    c.closePath();
  }

  private trianglePath(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, off: number): void {
    const c = this.ctx;
    c.beginPath();
    c.moveTo((x0 | 0) + off, (y0 | 0) + off);
    c.lineTo((x1 | 0) + off, (y1 | 0) + off);
    c.lineTo((x2 | 0) + off, (y2 | 0) + off);
    c.closePath();
  }

  /** Draw an ImageData block at (x, y) respecting the current transform. */
  protected blit(img: ImageData, x: number, y: number): void {
    const tmp = document.createElement("canvas");
    tmp.width = img.width;
    tmp.height = img.height;
    const tctx = tmp.getContext("2d");
    if (!tctx) return;
    tctx.putImageData(img, 0, 0);
    this.ctx.drawImage(tmp, x | 0, y | 0);
  }
}
