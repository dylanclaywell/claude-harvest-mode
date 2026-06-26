import { IDisplay, ISprite } from "../firmware/IDisplay";
import { CanvasGfx } from "./CanvasGfx";
import { CanvasSprite } from "./CanvasSprite";

/**
 * Canvas-backed IDisplay (the main screen). EMULATOR-ONLY; on real hardware
 * this whole file is replaced by a TFT_eSPI-backed display. Drawing uses the
 * native display resolution; the canvas is upscaled via CSS.
 */
export class CanvasDisplay extends CanvasGfx implements IDisplay {
  constructor(
    canvas: HTMLCanvasElement,
    private readonly nativeW: number,
    private readonly nativeH: number,
    scale: number,
  ) {
    canvas.width = nativeW;
    canvas.height = nativeH;
    canvas.style.width = `${nativeW * scale}px`;
    canvas.style.height = `${nativeH * scale}px`;
    canvas.style.imageRendering = "pixelated";

    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable");
    super(ctx, nativeW, nativeH);
  }

  setRotation(rotation: number): void {
    const r = ((rotation % 4) + 4) % 4;
    const nw = this.nativeW;
    const nh = this.nativeH;
    // Reported dimensions swap on the quarter turns, like TFT_eSPI.
    this.w = r === 1 || r === 3 ? nh : nw;
    this.h = r === 1 || r === 3 ? nw : nh;
    // setTransform(a,b,c,d,e,f): device = (a*x + c*y + e, b*x + d*y + f).
    switch (r) {
      case 0: this.ctx.setTransform(1, 0, 0, 1, 0, 0); break;
      case 1: this.ctx.setTransform(0, 1, -1, 0, nh, 0); break;
      case 2: this.ctx.setTransform(-1, 0, 0, -1, nw, nh); break;
      case 3: this.ctx.setTransform(0, -1, 1, 0, 0, nw); break;
    }
  }

  // SPI transaction batching is a no-op on canvas; kept so firmware that wraps
  // bursts in startWrite()/endWrite() compiles and ports unchanged.
  startWrite(): void {}
  endWrite(): void {}

  createSprite(w: number, h: number): ISprite {
    return new CanvasSprite(this.ctx, w, h);
  }
}
