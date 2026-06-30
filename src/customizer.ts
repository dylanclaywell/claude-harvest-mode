// customizer.ts — character color customizer. A DOM overlay (the game canvas is
// 320x240, far too small for drag-sliders) that lets the player retint each
// named part of a sprite. Sliders drive an Appearance; a live preview re-bakes
// the sprite through applyAppearance on every change. Returns the Appearance to
// the caller (main.ts persists it and recolors the in-game player — chunk D).

import { applyAppearance, listParts, type Appearance, type PartAdjust } from "./appearance";
import { intToCss } from "./color";
import { drawSprite, type GenSprite } from "./sprites";

export interface CustomizerOpts {
  /** Fires on every slider move with the live appearance (for in-game preview). */
  onChange?: (a: Appearance) => void;
  /** Fires when the player confirms. */
  onDone?: (a: Appearance) => void;
  /** Fires on Esc / cancel — caller should revert to the pre-open appearance. */
  onCancel?: () => void;
}

const HUE = { min: -180, max: 180 }; // degrees
const PCT = { min: -40, max: 40 }; // bright/sat as percent, mapped to -0.4..0.4

let styleInjected = false;
function injectStyle(): void {
  if (styleInjected) return;
  styleInjected = true;
  const css = `
  .cz-backdrop { position: fixed; inset: 0; background: rgba(10,8,5,0.72);
    display: flex; align-items: center; justify-content: center; z-index: 50;
    font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; }
  .cz-panel { background: #1a1410; color: #e8d8b0; border: 2px solid #5a4632;
    border-radius: 8px; width: min(92vw, 460px); max-height: 90vh; overflow: auto;
    padding: 16px 18px; box-shadow: 0 12px 40px rgba(0,0,0,0.5); }
  .cz-panel h2 { margin: 0 0 12px; font-size: 14px; letter-spacing: 0.1em;
    text-transform: uppercase; color: #c8b890; }
  .cz-top { display: flex; gap: 16px; align-items: center; margin-bottom: 14px; }
  .cz-preview { image-rendering: pixelated; background: #2d4a1e;
    border: 1px solid #5a4632; border-radius: 4px; flex: none; }
  .cz-hint { font-size: 11px; line-height: 1.5; opacity: 0.75; }
  .cz-part { border-top: 1px solid #3a2e20; padding: 9px 0; }
  .cz-part-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .cz-chip { width: 14px; height: 14px; border-radius: 3px; border: 1px solid #00000066; flex: none; }
  .cz-part-name { font-size: 12px; text-transform: capitalize; }
  .cz-slider { display: grid; grid-template-columns: 42px 1fr 38px; align-items: center;
    gap: 8px; margin: 3px 0; font-size: 10px; }
  .cz-slider label { opacity: 0.7; text-transform: uppercase; letter-spacing: 0.04em; }
  .cz-slider input[type=range] { width: 100%; accent-color: #c8b890; margin: 0; }
  .cz-slider output { text-align: right; opacity: 0.8; font-variant-numeric: tabular-nums; }
  .cz-foot { display: flex; gap: 8px; margin-top: 14px; }
  .cz-foot .cz-spacer { flex: 1; }
  .cz-btn { background: #2a2018; color: #e8d8b0; border: 1px solid #5a4632;
    border-radius: 5px; padding: 6px 14px; font: inherit; font-size: 12px; cursor: pointer; }
  .cz-btn:hover { background: #3a2e20; }
  .cz-btn.cz-primary { background: #4a6b2a; border-color: #6b8c44; color: #f0f0e0; }
  .cz-btn.cz-primary:hover { background: #5a7d34; }
  `;
  const el = document.createElement("style");
  el.textContent = css;
  document.head.appendChild(el);
}

export class Customizer {
  private root: HTMLDivElement | null = null;
  private appearance: Appearance = {};
  private preview!: CanvasRenderingContext2D;
  private chips = new Map<string, HTMLDivElement>();

  constructor(private sprite: GenSprite, private opts: CustomizerOpts = {}) {
    injectStyle();
  }

  get isOpen(): boolean {
    return this.root !== null;
  }

  /** Open with an initial appearance (deep-copied so cancel can't leak edits). */
  open(initial: Appearance = {}): void {
    if (this.root) return;
    this.appearance = structuredClone(initial);
    this.build();
    this.renderPreview();
  }

  close(): void {
    if (!this.root) return;
    document.removeEventListener("keydown", this.onKey);
    this.root.remove();
    this.root = null;
    this.chips.clear();
  }

  private onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      this.opts.onCancel?.();
      this.close();
    }
  };

  private adj(part: string): PartAdjust {
    return (this.appearance[part] ??= {});
  }

  private build(): void {
    const parts = listParts(this.sprite.names, this.sprite.palettes.base);

    const backdrop = document.createElement("div");
    backdrop.className = "cz-backdrop";
    backdrop.addEventListener("pointerdown", (e) => {
      if (e.target === backdrop) {
        this.opts.onCancel?.();
        this.close();
      }
    });

    const panel = document.createElement("div");
    panel.className = "cz-panel";
    panel.innerHTML = `<h2>Customize Farmhand</h2>`;

    // Preview + hint row
    const top = document.createElement("div");
    top.className = "cz-top";
    const pv = document.createElement("canvas");
    const px = 5; // preview pixel scale
    pv.width = this.sprite.width * px;
    pv.height = this.sprite.height * px;
    pv.className = "cz-preview";
    const pctx = pv.getContext("2d");
    if (!pctx) throw new Error("2D context unavailable for customizer preview");
    pctx.imageSmoothingEnabled = false;
    this.preview = pctx;
    const hint = document.createElement("div");
    hint.className = "cz-hint";
    hint.textContent = "Drag a part's hue, brightness, and saturation. Shades follow automatically.";
    top.append(pv, hint);
    panel.append(top);

    // One block per customizable part.
    for (const { part, color } of parts) {
      panel.append(this.buildPart(part, color));
    }

    // Footer
    const foot = document.createElement("div");
    foot.className = "cz-foot";
    const randomBtn = this.button("Randomize", () => this.randomize());
    const resetBtn = this.button("Reset", () => this.reset());
    const spacer = document.createElement("div");
    spacer.className = "cz-spacer";
    const doneBtn = this.button("Done", () => {
      this.opts.onDone?.(this.cleaned());
      this.close();
    });
    doneBtn.classList.add("cz-primary");
    foot.append(randomBtn, resetBtn, spacer, doneBtn);
    panel.append(foot);

    backdrop.append(panel);
    document.body.append(backdrop);
    this.root = backdrop;
    document.addEventListener("keydown", this.onKey);
  }

  private buildPart(part: string, color: number): HTMLDivElement {
    const wrap = document.createElement("div");
    wrap.className = "cz-part";
    const head = document.createElement("div");
    head.className = "cz-part-head";
    const chip = document.createElement("div");
    chip.className = "cz-chip";
    chip.style.background = intToCss(color);
    this.chips.set(part, chip);
    const name = document.createElement("div");
    name.className = "cz-part-name";
    name.textContent = part.replace(/_/g, " ");
    head.append(chip, name);
    wrap.append(head);

    wrap.append(this.slider(part, "hue", "Hue", HUE.min, HUE.max, (a) => a.hue ?? 0, (a, v) => (a.hue = v), (v) => `${v}°`));
    wrap.append(this.slider(part, "bright", "Light", PCT.min, PCT.max, (a) => Math.round((a.bright ?? 0) * 100), (a, v) => (a.bright = v / 100), (v) => `${v}`));
    wrap.append(this.slider(part, "sat", "Sat", PCT.min, PCT.max, (a) => Math.round((a.sat ?? 0) * 100), (a, v) => (a.sat = v / 100), (v) => `${v}`));
    return wrap;
  }

  private slider(
    part: string,
    key: string,
    label: string,
    min: number,
    max: number,
    get: (a: PartAdjust) => number,
    set: (a: PartAdjust, v: number) => void,
    fmt: (v: number) => string,
  ): HTMLDivElement {
    const row = document.createElement("div");
    row.className = "cz-slider";
    const lab = document.createElement("label");
    lab.textContent = label;
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(min);
    input.max = String(max);
    input.step = "1";
    input.dataset.part = part;
    input.dataset.key = key;
    input.value = String(get(this.adj(part)));
    const out = document.createElement("output");
    out.textContent = fmt(Number(input.value));
    input.addEventListener("input", () => {
      const v = Number(input.value);
      set(this.adj(part), v);
      out.textContent = fmt(v);
      this.changed();
    });
    row.append(lab, input, out);
    return row;
  }

  private button(text: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.className = "cz-btn";
    b.textContent = text;
    b.addEventListener("click", onClick);
    return b;
  }

  /** Re-read the appearance into the preview + chips, fire onChange. */
  private changed(): void {
    this.renderPreview();
    this.opts.onChange?.(this.cleaned());
  }

  /** Appearance with no-op parts (all offsets zero/unset) dropped. */
  private cleaned(): Appearance {
    const out: Appearance = {};
    for (const [part, a] of Object.entries(this.appearance)) {
      if ((a.hue ?? 0) || (a.bright ?? 0) || (a.sat ?? 0)) out[part] = { ...a };
    }
    return out;
  }

  private renderPreview(): void {
    const colors = applyAppearance(this.sprite.palettes.base, this.sprite.names, this.appearance);
    const { width, height } = this.preview.canvas;
    this.preview.clearRect(0, 0, width, height);
    drawSprite(this.preview, this.sprite, 0, 0, { colors, scale: width / this.sprite.width });
    // Update each part's chip to its current base color.
    for (const { part, slot } of listParts(this.sprite.names, this.sprite.palettes.base)) {
      this.chips.get(part)?.style.setProperty("background", intToCss(colors[slot]));
    }
  }

  private reset(): void {
    this.appearance = {};
    this.syncInputs();
    this.changed();
  }

  private randomize(): void {
    for (const { part } of listParts(this.sprite.names, this.sprite.palettes.base)) {
      this.appearance[part] = {
        hue: Math.round(HUE.min + Math.random() * (HUE.max - HUE.min)),
        bright: Math.round((Math.random() - 0.5) * 30) / 100, // ±0.15
        sat: Math.round((Math.random() - 0.5) * 30) / 100,
      };
    }
    this.syncInputs();
    this.changed();
  }

  /** Push appearance values back into the slider inputs (after reset/random). */
  private syncInputs(): void {
    if (!this.root) return;
    this.root.querySelectorAll<HTMLInputElement>("input[type=range]").forEach((input) => {
      const a = this.appearance[input.dataset.part!] ?? {};
      const k = input.dataset.key!;
      const v = k === "hue" ? a.hue ?? 0 : k === "bright" ? Math.round((a.bright ?? 0) * 100) : Math.round((a.sat ?? 0) * 100);
      input.value = String(v);
      const out = input.nextElementSibling as HTMLOutputElement | null;
      if (out) out.textContent = k === "hue" ? `${v}°` : `${v}`;
    });
  }
}
