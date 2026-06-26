import { ColorDepth, ISprite } from "../firmware/IDisplay";
import { CanvasGfx, rgb565ToRgb } from "./CanvasGfx";

/**
 * Canvas-backed TFT_eSprite: an off-screen buffer with the full IGfx drawing
 * API plus depth/palette control and pushSprite(). EMULATOR-ONLY — on hardware
 * this is TFT_eSprite.
 *
 * In palette mode (depth 1/4/8) the color arguments to draw calls are treated
 * as palette INDICES, matching TFT_eSprite exactly, so game code that builds a
 * 16-color sprite ports without change.
 */
export class CanvasSprite extends CanvasGfx implements ISprite {
  private depth: ColorDepth = 16;
  private palette: Uint16Array | null = null;
  private warnedNoPalette = false;
  private deleted = false;

  constructor(
    private readonly target: CanvasRenderingContext2D,
    w: number,
    h: number,
  ) {
    super(CanvasSprite.makeCtx(w, h), w, h);
  }

  private static makeCtx(w: number, h: number): CanvasRenderingContext2D {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable for sprite");
    return ctx;
  }

  setColorDepth(bpp: ColorDepth): void {
    this.depth = bpp;
  }

  createPalette(palette: Uint16Array | number[]): void {
    this.palette = palette instanceof Uint16Array ? palette : Uint16Array.from(palette);
  }

  fillSprite(color: number): void {
    this.fillScreen(color);
  }

  /**
   * In palette mode, `color` is an index into the palette (matching
   * TFT_eSprite). At 16-bit it is a direct RGB565 value.
   */
  protected override toRgb565(color: number): number {
    if (this.depth === 16) return color;
    if (!this.palette) {
      if (!this.warnedNoPalette) {
        console.warn(`sprite at ${this.depth}-bit depth has no palette; call createPalette() — treating color as RGB565`);
        this.warnedNoPalette = true;
      }
      return color;
    }
    const mask = this.depth === 8 ? 0xff : this.depth === 4 ? 0x0f : 0x01;
    return this.palette[color & mask] ?? 0;
  }

  pushSprite(x: number, y: number, transparent?: number): void {
    if (this.deleted) return;
    const self = (this.ctx.canvas as HTMLCanvasElement);
    if (transparent === undefined) {
      this.target.drawImage(self, x | 0, y | 0);
      return;
    }
    // Color-key: zero the alpha of pixels matching the transparent color, then
    // blit so the background shows through (drawImage alpha-composites).
    // `transparent` is an RGB565 value at 16-bit, a palette index otherwise.
    const [tr, tg, tb] = rgb565ToRgb(this.toRgb565(transparent));
    const img = this.ctx.getImageData(0, 0, this.w, this.h);
    const px = img.data;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i] === tr && px[i + 1] === tg && px[i + 2] === tb) px[i + 3] = 0;
    }
    const tmp = document.createElement("canvas");
    tmp.width = this.w;
    tmp.height = this.h;
    const tctx = tmp.getContext("2d");
    if (!tctx) return;
    tctx.putImageData(img, 0, 0);
    this.target.drawImage(tmp, x | 0, y | 0);
  }

  deleteSprite(): void {
    this.deleted = true;
    this.ctx.canvas.width = 0;
    this.ctx.canvas.height = 0;
  }
}
