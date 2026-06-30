import { hexToInt, intToCss, intToHex } from "../color";
import {
  PALETTE_SIZE,
  Palette,
  SpriteProject,
  TRANSPARENT_INDEX,
  blankFrame,
  clonePalette,
  fromJson,
  newProject,
  normalizeName,
  paletteFromJson,
  paletteToJson,
  toJson,
} from "./project";

// File System Access API — not yet in the standard DOM lib. Lets us write the
// .json straight into assets/ instead of bouncing through the downloads dir.
declare global {
  interface Window {
    showSaveFilePicker?: (opts?: {
      suggestedName?: string;
      types?: { description?: string; accept: Record<string, string[]> }[];
    }) => Promise<FileSystemFileHandle>;
  }
}

type Tool = "pencil" | "eraser" | "fill" | "select";

/** Marquee bounds, in grid cells. */
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Pixels lifted out of the frame during a move, with their current position. */
interface Floating extends Rect {
  data: number[]; // row-major, w*h palette indices
}

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el as T;
}

/**
 * Pixel sprite editor. Authors within the 16-color indexed-palette constraint
 * (24-bit colors per role) and exports the .json project plus the generated TS
 * module the game imports. The live preview renders the current frame through
 * the active palette directly to a canvas.
 */
export class EditorApp {
  private project!: SpriteProject;
  private tool: Tool = "pencil";
  private primary = 1; // palette index — left mouse button
  private secondary = TRANSPARENT_INDEX; // palette index — right mouse button
  private activePalette = 0; // which palette variant is being edited / previewed
  private brush = 1; // pencil/eraser square size in pixels
  private dragColor = 1; // color locked in at pointerdown for the current stroke
  private activeFrame = 0;
  private activeClip: string | null = null; // clip selected for editing / preview
  private painting = false;
  private playing = false;
  private hoverX = -1; // grid cell under the cursor, -1 when off-canvas
  private hoverY = -1;
  private lastX = -1; // last painted cell this stroke, for interpolation
  private lastY = -1;

  // --- selection (select tool) ---
  private selection: Rect | null = null; // marquee overlay, persists between strokes
  private floating: Floating | null = null; // pixels lifted during an active move drag
  private selMode: "none" | "marquee" | "move" = "none";
  private selAnchorX = 0; // marquee corner fixed at pointerdown
  private selAnchorY = 0;
  private moveStartX = 0; // cell where a move drag began
  private moveStartY = 0;
  private floatStartX = 0; // floating origin when the move drag began
  private floatStartY = 0;

  // --- undo / redo ---
  private undoStack: SpriteProject[] = []; // pre-action project snapshots
  private redoStack: SpriteProject[] = [];
  private colorEditing = false; // coalesce a color-picker drag into one entry
  private static readonly HISTORY_LIMIT = 100;

  // File handle for the current project's .json, so re-saves overwrite in place.
  private fileHandle: FileSystemFileHandle | null = null;
  private currentFile: string | null = null; // assets/ filename currently loaded, for the project list
  private dirty = false; // unsaved changes since last save / load

  // Live-preview render target (current frame through the active palette).
  private previewCtx!: CanvasRenderingContext2D;
  private previewScale = 1;
  private previewW = 0;
  private previewH = 0;
  private lastAdvance = 0;
  private animFrame = 0;

  private grid!: CanvasRenderingContext2D;
  private gridCell = 1;

  init(): void {
    this.project = newProject("sprite", 32, 32);
    this.grid = $<HTMLCanvasElement>("gridCanvas").getContext("2d")!;
    this.wire();
    this.rebuildForSize();
    this.renderAll();
    this.updateHistoryButtons();
    this.updateCurrentFile();
    this.updateSaveState();
    void this.refreshAssets();
    requestAnimationFrame(this.tick);
  }

  /** The palette variant currently being edited / previewed. */
  private variant(): Palette {
    return this.project.palettes[this.activePalette];
  }
  private colors(): number[] {
    return this.variant().colors;
  }

  /** Display name for a slot, or "" if unnamed. */
  private slotName(i: number): string {
    return this.project.names?.[i] ?? "";
  }
  /** Set a slot's role name (project-level). Normalizes; blank clears it. */
  private setSlotName(i: number, raw: string): void {
    const name = normalizeName(raw) ?? "";
    if (this.slotName(i) === name) return;
    this.beginAction();
    const names = (this.project.names ??= []);
    while (names.length <= i) names.push(""); // grow to reach slot i
    names[i] = name;
    if (!names.some(Boolean)) this.project.names = undefined; // drop empty array
  }

  // --- wiring ---

  private wire(): void {
    $<HTMLInputElement>("assetName").value = this.project.name;
    $<HTMLInputElement>("newW").value = String(this.project.width);
    $<HTMLInputElement>("newH").value = String(this.project.height);

    $("btnNew").addEventListener("click", () => {
      this.beginAction();
      const name = $<HTMLInputElement>("assetName").value.trim() || "sprite";
      const w = clamp(parseInt($<HTMLInputElement>("newW").value, 10) || 32, 1, 128);
      const h = clamp(parseInt($<HTMLInputElement>("newH").value, 10) || 32, 1, 128);
      this.project = newProject(name, w, h);
      this.fileHandle = null; // new project — save targets a fresh file
      this.currentFile = null;
      this.primary = 1;
      this.secondary = TRANSPARENT_INDEX;
      this.activePalette = 0;
      this.activeFrame = 0;
      this.activeClip = null;
      this.rebuildForSize();
      this.renderAll();
      this.updateCurrentFile();
    });

    for (const t of ["pencil", "eraser", "fill", "select"] as Tool[]) {
      $<HTMLInputElement>("tool-" + t).addEventListener("change", () => {
        this.tool = t;
        if (t !== "select") this.clearSelection(); // drop the marquee when leaving Select
        this.renderGrid();
      });
    }

    $<HTMLInputElement>("brushSize").addEventListener("input", (e) => {
      this.brush = clamp(parseInt((e.target as HTMLInputElement).value, 10) || 1, 1, 8);
    });

    const canvas = $<HTMLCanvasElement>("gridCanvas");
    // Block the browser context menu so right-click paints the secondary color.
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    canvas.addEventListener("pointerdown", (e) => {
      this.painting = true;
      canvas.setPointerCapture(e.pointerId);
      this.updateHover(e);
      if (this.tool === "select") {
        this.selectPointerDown(e);
        this.renderGrid();
        return;
      }
      // Lock in the stroke color: right button (2) = secondary, else primary.
      const color = e.button === 2 ? this.secondary : this.primary;
      this.dragColor = this.tool === "eraser" ? TRANSPARENT_INDEX : color;
      this.beginAction(); // one undo entry per stroke
      this.lastX = this.hoverX; // start the stroke at the press cell
      this.lastY = this.hoverY;
      this.applyPaint();
      this.renderGrid();
    });
    canvas.addEventListener("pointermove", (e) => {
      this.updateHover(e);
      if (this.tool === "select") {
        if (this.painting) this.selectPointerMove(e);
        this.renderGrid();
        return;
      }
      // Fill acts once on press; pencil/eraser keep painting through the drag.
      if (this.painting && this.tool !== "fill") this.applyPaint();
      this.renderGrid();
    });
    canvas.addEventListener("pointerup", () => {
      this.painting = false;
      this.lastX = -1;
      this.lastY = -1;
      if (this.tool === "select") {
        this.selectPointerUp();
        this.renderGrid();
      }
    });
    canvas.addEventListener("pointerleave", () => {
      this.hoverX = -1;
      this.hoverY = -1;
      this.renderGrid();
    });
    canvas.addEventListener("pointercancel", () => {
      this.painting = false;
      this.lastX = -1;
      this.lastY = -1;
      this.hoverX = -1;
      this.hoverY = -1;
      if (this.selMode === "move") this.commitFloating(); // don't lose lifted pixels
      this.selMode = "none";
      this.renderGrid();
    });

    window.addEventListener("keydown", (e) => {
      const ctrl = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      // Ctrl/Cmd+S saves, even from a focused input.
      if (ctrl && k === "s") {
        e.preventDefault();
        void this.saveJson();
        return;
      }
      // Don't hijack typing in name/size/rarity fields — but a focused tool
      // radio (after a click) shouldn't block the single-key tool shortcuts.
      const el = e.target as HTMLElement | null;
      const typing =
        el?.tagName === "TEXTAREA" ||
        (el?.tagName === "INPUT" && !["radio", "checkbox", "button"].includes((el as HTMLInputElement).type));
      if (typing) return;
      if (ctrl && k === "z" && !e.shiftKey) {
        e.preventDefault();
        this.undo();
      } else if (ctrl && (k === "y" || (k === "z" && e.shiftKey))) {
        e.preventDefault();
        this.redo();
      } else if (e.key === "Escape" && this.selection) {
        // Escape deselects (matching Aseprite).
        this.clearSelection();
        this.renderGrid();
      } else {
        // Single-key tool switch (Aseprite-style). Flip the radio so its
        // change handler runs — keeps tool wiring in one place.
        const toolKeys: Record<string, Tool> = { b: "pencil", e: "eraser", g: "fill", m: "select" };
        const next = toolKeys[k];
        if (next) {
          const radio = $<HTMLInputElement>("tool-" + next);
          radio.checked = true;
          radio.focus(); // move the focus ring onto the now-active tool
          radio.dispatchEvent(new Event("change"));
        }
      }
    });
    $("btnUndo").addEventListener("click", () => this.undo());
    $("btnRedo").addEventListener("click", () => this.redo());

    $<HTMLInputElement>("colorPicker").addEventListener("input", (e) => {
      if (this.primary === TRANSPARENT_INDEX) return; // transparent slot is locked
      if (!this.colorEditing) {
        this.beginAction(); // snapshot once at the start of a picker drag
        this.colorEditing = true;
      }
      this.colors()[this.primary] = hexToInt((e.target as HTMLInputElement).value);
      this.renderPalette();
      this.renderGrid();
    });
    $<HTMLInputElement>("colorPicker").addEventListener("change", () => (this.colorEditing = false));

    // Slot name: labels the selected (L/primary) slot. Project-level (shared
    // across variants), so naming a role once names it for every variant.
    $<HTMLInputElement>("colorName").addEventListener("input", (e) => {
      if (this.primary === TRANSPARENT_INDEX) return; // transparent has no role
      this.setSlotName(this.primary, (e.target as HTMLInputElement).value);
      this.renderPalette();
    });

    $("btnAddColor").addEventListener("click", () => {
      if (this.colors().length >= PALETTE_SIZE) return;
      this.beginAction();
      // Append a new role slot to EVERY variant so indices stay aligned. The
      // active variant gets the picked color; others copy it (recolor later).
      const c = hexToInt($<HTMLInputElement>("colorPicker").value);
      for (const pal of this.project.palettes) pal.colors.push(c);
      this.primary = this.colors().length - 1;
      this.renderPalette();
    });

    // --- palette variants ---
    $("btnAddVariant").addEventListener("click", () => {
      this.beginAction();
      const base = this.variant();
      this.project.palettes.splice(this.activePalette + 1, 0, clonePalette(base, uniqueVariantName(this.project.palettes, base.name)));
      this.activePalette++;
      this.renderVariants();
      this.renderPalette();
      this.renderGrid();
    });
    $("btnDelVariant").addEventListener("click", () => {
      if (this.project.palettes.length <= 1) return; // keep at least the base
      this.beginAction();
      this.project.palettes.splice(this.activePalette, 1);
      this.activePalette = Math.min(this.activePalette, this.project.palettes.length - 1);
      this.renderVariants();
      this.renderPalette();
      this.renderGrid();
    });
    $<HTMLInputElement>("variantName").addEventListener("input", (e) => {
      this.variant().name = (e.target as HTMLInputElement).value;
      this.renderVariants();
    });
    $<HTMLInputElement>("variantRarity").addEventListener("input", (e) => {
      this.variant().rarity = (e.target as HTMLInputElement).value;
    });
    $("btnExportPal").addEventListener("click", () => this.download(this.variant().name + ".pal.json", paletteToJson(this.variant())));
    $<HTMLInputElement>("fileImportPal").addEventListener("change", (e) => this.importPalette(e));

    $("btnAddFrame").addEventListener("click", () => {
      this.beginAction();
      this.clearSelection();
      this.project.frames.splice(this.activeFrame + 1, 0, blankFrame(this.project.width, this.project.height));
      this.activeFrame++;
      this.renderFrames();
      this.renderGrid();
    });
    $("btnDupFrame").addEventListener("click", () => {
      this.beginAction();
      this.clearSelection();
      this.project.frames.splice(this.activeFrame + 1, 0, this.project.frames[this.activeFrame].slice());
      this.activeFrame++;
      this.renderFrames();
      this.renderGrid();
    });
    $("btnDelFrame").addEventListener("click", () => {
      if (this.project.frames.length <= 1) return;
      this.beginAction();
      this.clearSelection();
      this.project.frames.splice(this.activeFrame, 1);
      this.activeFrame = Math.min(this.activeFrame, this.project.frames.length - 1);
      this.renderFrames();
      this.renderGrid();
    });
    $("btnFrameUp").addEventListener("click", () => this.moveFrame(-1));
    $("btnFrameDown").addEventListener("click", () => this.moveFrame(1));
    $("btnPlay").addEventListener("click", () => {
      this.playing = !this.playing;
      this.animFrame = 0;
      $("btnPlay").textContent = this.playing ? "Stop" : "Play";
    });

    // --- animation clips ---
    $("btnAddClip").addEventListener("click", () => {
      this.beginAction();
      const name = uniqueClipName(this.project.clips);
      this.project.clips[name] = [this.activeFrame]; // seed with the current frame
      this.activeClip = name;
      this.renderClips();
    });
    $("btnDelClip").addEventListener("click", () => {
      if (!this.activeClip) return;
      this.beginAction();
      delete this.project.clips[this.activeClip];
      this.activeClip = null;
      this.renderClips();
    });
    $<HTMLInputElement>("clipName").addEventListener("change", (e) => {
      if (!this.activeClip) return;
      const next = (e.target as HTMLInputElement).value.trim();
      if (!next || next === this.activeClip) return;
      this.beginAction();
      const clips = this.project.clips;
      const key = clips[next] ? uniqueClipName(clips, next) : next;
      clips[key] = clips[this.activeClip];
      delete clips[this.activeClip];
      this.activeClip = key;
      this.renderClips();
    });
    $<HTMLInputElement>("clipFrames").addEventListener("change", (e) => {
      if (!this.activeClip) return;
      this.beginAction();
      this.project.clips[this.activeClip] = this.parseFrameList((e.target as HTMLInputElement).value);
      this.renderClips();
    });

    $("btnSave").addEventListener("click", () => void this.saveJson());
    // The name field is the live project name — also the Save As target.
    $<HTMLInputElement>("assetName").addEventListener("input", (e) => {
      this.project.name = (e.target as HTMLInputElement).value;
      this.markDirty(); // saving will target a different file
    });
    // Re-scan assets/ when the editor regains focus, so external changes
    // (another tab's export, git pull, a hand-edit) show up without a button.
    window.addEventListener("focus", () => void this.refreshAssets());
    // Warn before leaving with unsaved changes.
    window.addEventListener("beforeunload", (e) => {
      if (this.dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    });
  }

  // --- editing ---

  private moveFrame(dir: number): void {
    const j = this.activeFrame + dir;
    if (j < 0 || j >= this.project.frames.length) return;
    this.beginAction();
    this.clearSelection();
    const f = this.project.frames;
    [f[this.activeFrame], f[j]] = [f[j], f[this.activeFrame]];
    this.activeFrame = j;
    this.renderFrames();
  }

  private updateHover(e: PointerEvent): void {
    const rect = $<HTMLCanvasElement>("gridCanvas").getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left) / this.gridCell);
    const y = Math.floor((e.clientY - rect.top) / this.gridCell);
    const inside = x >= 0 && y >= 0 && x < this.project.width && y < this.project.height;
    this.hoverX = inside ? x : -1;
    this.hoverY = inside ? y : -1;
  }

  private applyPaint(): void {
    if (this.hoverX < 0) return;
    const frame = this.project.frames[this.activeFrame];
    if (this.tool === "fill") {
      this.floodFill(frame, this.hoverY * this.project.width + this.hoverX, this.dragColor);
      return;
    }
    // Interpolate from the last painted cell so fast moves don't skip pixels.
    if (this.lastX < 0) {
      this.lastX = this.hoverX;
      this.lastY = this.hoverY;
    }
    this.stampLine(frame, this.lastX, this.lastY, this.hoverX, this.hoverY, this.dragColor);
    this.lastX = this.hoverX;
    this.lastY = this.hoverY;
  }

  /** Stamp the brush along the line between two cells (Bresenham). */
  private stampLine(frame: number[], x0: number, y0: number, x1: number, y1: number, color: number): void {
    let x = x0;
    let y = y0;
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.stamp(frame, x, y, color);
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y += sy;
      }
    }
  }

  /** Paint a brush-sized square centered on (cx, cy). */
  private stamp(frame: number[], cx: number, cy: number, color: number): void {
    const { width, height } = this.project;
    const half = (this.brush - 1) >> 1;
    for (let dy = 0; dy < this.brush; dy++) {
      for (let dx = 0; dx < this.brush; dx++) {
        const x = cx - half + dx;
        const y = cy - half + dy;
        if (x >= 0 && y >= 0 && x < width && y < height) frame[y * width + x] = color;
      }
    }
  }

  private floodFill(frame: number[], start: number, to: number): void {
    const from = frame[start];
    if (from === to) return;
    const { width, height } = this.project;
    const stack = [start];
    while (stack.length) {
      const i = stack.pop()!;
      if (frame[i] !== from) continue;
      frame[i] = to;
      const x = i % width;
      const y = (i / width) | 0;
      if (x > 0) stack.push(i - 1);
      if (x < width - 1) stack.push(i + 1);
      if (y > 0) stack.push(i - width);
      if (y < height - 1) stack.push(i + width);
    }
  }

  // --- selection (select tool) ---

  /** Cursor cell clamped into the grid (marquee/move drags run past the edge). */
  private cellFromEvent(e: PointerEvent): { x: number; y: number } {
    const rect = $<HTMLCanvasElement>("gridCanvas").getBoundingClientRect();
    const x = clamp(Math.floor((e.clientX - rect.left) / this.gridCell), 0, this.project.width - 1);
    const y = clamp(Math.floor((e.clientY - rect.top) / this.gridCell), 0, this.project.height - 1);
    return { x, y };
  }

  private inSelection(x: number, y: number): boolean {
    const s = this.selection;
    return !!s && x >= s.x && x < s.x + s.w && y >= s.y && y < s.y + s.h;
  }

  private selectPointerDown(e: PointerEvent): void {
    const { x, y } = this.cellFromEvent(e);
    if (this.inSelection(x, y)) {
      // Grab the marquee: lift its pixels and start dragging them.
      this.beginAction(); // lift + drop is one undo entry
      this.liftSelection();
      this.selMode = "move";
      this.moveStartX = x;
      this.moveStartY = y;
      this.floatStartX = this.floating!.x;
      this.floatStartY = this.floating!.y;
    } else {
      // Begin a fresh marquee anchored at the press cell.
      this.selMode = "marquee";
      this.selAnchorX = x;
      this.selAnchorY = y;
      this.selection = { x, y, w: 1, h: 1 };
    }
  }

  private selectPointerMove(e: PointerEvent): void {
    const { x, y } = this.cellFromEvent(e);
    if (this.selMode === "marquee") {
      this.selection = {
        x: Math.min(this.selAnchorX, x),
        y: Math.min(this.selAnchorY, y),
        w: Math.abs(x - this.selAnchorX) + 1,
        h: Math.abs(y - this.selAnchorY) + 1,
      };
    } else if (this.selMode === "move" && this.floating) {
      this.floating.x = this.floatStartX + (x - this.moveStartX);
      this.floating.y = this.floatStartY + (y - this.moveStartY);
      this.selection = { x: this.floating.x, y: this.floating.y, w: this.floating.w, h: this.floating.h };
    }
  }

  private selectPointerUp(): void {
    if (this.selMode === "move") {
      this.commitFloating(); // stamp the moved pixels back into the frame
    } else if (this.selMode === "marquee" && this.selection && this.selection.w === 1 && this.selection.h === 1) {
      this.selection = null; // a plain click (no drag) just deselects
    }
    this.selMode = "none";
  }

  /** Cut the selected pixels out of the frame into a floating layer. */
  private liftSelection(): void {
    const s = this.selection!;
    const frame = this.project.frames[this.activeFrame];
    const { width } = this.project;
    const data: number[] = [];
    for (let dy = 0; dy < s.h; dy++) {
      for (let dx = 0; dx < s.w; dx++) {
        const i = (s.y + dy) * width + (s.x + dx);
        data.push(frame[i]);
        frame[i] = TRANSPARENT_INDEX; // clear the source area
      }
    }
    this.floating = { x: s.x, y: s.y, w: s.w, h: s.h, data };
  }

  /** Composite the floating layer back into the frame (transparent passes through). */
  private commitFloating(): void {
    if (!this.floating) return;
    const frame = this.project.frames[this.activeFrame];
    const { width, height } = this.project;
    const f = this.floating;
    for (let dy = 0; dy < f.h; dy++) {
      for (let dx = 0; dx < f.w; dx++) {
        const v = f.data[dy * f.w + dx];
        if (v === TRANSPARENT_INDEX) continue;
        const x = f.x + dx;
        const y = f.y + dy;
        if (x >= 0 && y >= 0 && x < width && y < height) frame[y * width + x] = v;
      }
    }
    this.floating = null;
  }

  /** Drop the marquee and any uncommitted float. */
  private clearSelection(): void {
    this.commitFloating();
    this.selection = null;
    this.selMode = "none";
  }

  // --- undo / redo ---

  /** Snapshot the current project before a mutation; clears the redo branch. */
  private beginAction(): void {
    this.undoStack.push(structuredClone(this.project));
    if (this.undoStack.length > EditorApp.HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.updateHistoryButtons();
    this.markDirty();
  }

  private markDirty(): void {
    this.dirty = true;
    this.updateSaveState();
  }

  private markSaved(): void {
    this.dirty = false;
    this.updateSaveState();
  }

  private updateSaveState(): void {
    $("saveState").textContent = this.dirty ? "● unsaved" : "";
  }

  private undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(structuredClone(this.project));
    this.restore(prev);
  }

  private redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(structuredClone(this.project));
    this.restore(next);
  }

  /** Swap in a snapshot and rebuild all UI (size/frames/palette may differ). */
  private restore(snap: SpriteProject): void {
    this.project = snap;
    this.activePalette = clamp(this.activePalette, 0, this.project.palettes.length - 1);
    this.activeFrame = clamp(this.activeFrame, 0, this.project.frames.length - 1);
    if (this.activeClip && !this.project.clips[this.activeClip]) this.activeClip = null;
    this.primary = clamp(this.primary, 0, this.colors().length - 1);
    this.secondary = clamp(this.secondary, 0, this.colors().length - 1);
    $<HTMLInputElement>("assetName").value = this.project.name;
    $<HTMLInputElement>("newW").value = String(this.project.width);
    $<HTMLInputElement>("newH").value = String(this.project.height);
    this.rebuildForSize(); // also clears any selection/float
    this.renderAll();
    this.updateHistoryButtons();
    this.markDirty(); // undo/redo moves away from the on-disk state
  }

  private updateHistoryButtons(): void {
    $<HTMLButtonElement>("btnUndo").disabled = this.undoStack.length === 0;
    $<HTMLButtonElement>("btnRedo").disabled = this.redoStack.length === 0;
  }

  // --- rendering ---

  private rebuildForSize(): void {
    this.selection = null; // geometry/frames changed — drop any stale marquee
    this.floating = null;
    this.selMode = "none";
    const { width, height } = this.project;
    this.gridCell = Math.max(1, Math.floor(480 / Math.max(width, height)));
    const c = $<HTMLCanvasElement>("gridCanvas");
    c.width = width * this.gridCell;
    c.height = height * this.gridCell;

    this.previewW = width;
    this.previewH = height;
    this.previewScale = Math.max(1, Math.floor(192 / Math.max(width, height)));
    const pc = $<HTMLCanvasElement>("previewCanvas");
    pc.width = width * this.previewScale;
    pc.height = height * this.previewScale;
    this.previewCtx = pc.getContext("2d")!;
    this.previewCtx.imageSmoothingEnabled = false;
  }

  private renderAll(): void {
    this.renderVariants();
    this.renderPalette();
    this.renderFrames();
    this.renderClips();
    this.renderGrid();
  }

  private renderGrid(): void {
    const { width, height } = this.project;
    const colors = this.colors();
    const frame = this.project.frames[this.activeFrame];
    const cell = this.gridCell;
    const g = this.grid;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = colors[frame[y * width + x]] ?? 0;
        if (frame[y * width + x] === TRANSPARENT_INDEX) {
          this.checker(g, x * cell, y * cell, cell);
        } else {
          g.fillStyle = intToCss(i);
          g.fillRect(x * cell, y * cell, cell, cell);
        }
      }
    }
    if (cell >= 4) {
      g.strokeStyle = "rgba(255,255,255,0.08)";
      g.lineWidth = 1;
      for (let x = 0; x <= width; x++) line(g, x * cell + 0.5, 0, x * cell + 0.5, height * cell);
      for (let y = 0; y <= height; y++) line(g, 0, y * cell + 0.5, width * cell, y * cell + 0.5);
    }
    this.drawFloating(g, cell);
    this.drawSelection(g, cell);
    this.drawHover(g, cell);
  }

  /** Draw the lifted pixels at their dragged position (they're not in the frame). */
  private drawFloating(g: CanvasRenderingContext2D, cell: number): void {
    const f = this.floating;
    if (!f) return;
    const { width, height } = this.project;
    const colors = this.colors();
    for (let dy = 0; dy < f.h; dy++) {
      for (let dx = 0; dx < f.w; dx++) {
        const v = f.data[dy * f.w + dx];
        if (v === TRANSPARENT_INDEX) continue;
        const x = f.x + dx;
        const y = f.y + dy;
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        g.fillStyle = intToCss(colors[v] ?? 0);
        g.fillRect(x * cell, y * cell, cell, cell);
      }
    }
  }

  /** Marching-ants outline around the current selection. */
  private drawSelection(g: CanvasRenderingContext2D, cell: number): void {
    const s = this.selection;
    if (!s) return;
    const px = s.x * cell;
    const py = s.y * cell;
    const pw = s.w * cell;
    const ph = s.h * cell;
    g.lineWidth = 1;
    g.setLineDash([]);
    g.strokeStyle = "rgba(0,0,0,0.8)";
    g.strokeRect(px - 0.5, py - 0.5, pw + 1, ph + 1);
    g.setLineDash([4, 4]);
    g.strokeStyle = "rgba(255,255,255,0.95)";
    g.strokeRect(px + 0.5, py + 0.5, pw - 1, ph - 1);
    g.setLineDash([]);
  }

  /** Outline the cells the current tool would affect under the cursor. */
  private drawHover(g: CanvasRenderingContext2D, cell: number): void {
    if (this.hoverX < 0) return;
    const b = this.tool === "fill" ? 1 : this.brush;
    const half = (b - 1) >> 1;
    const px = (this.hoverX - half) * cell;
    const py = (this.hoverY - half) * cell;
    const s = b * cell;
    g.lineWidth = 1;
    // Dark backing then bright outline so it reads on any color underneath.
    g.strokeStyle = "rgba(0,0,0,0.7)";
    g.strokeRect(px - 0.5, py - 0.5, s + 1, s + 1);
    g.strokeStyle = "rgba(255,255,255,0.95)";
    g.strokeRect(px + 0.5, py + 0.5, s - 1, s - 1);
  }

  private checker(g: CanvasRenderingContext2D, x: number, y: number, cell: number): void {
    const h = Math.max(1, cell >> 1);
    g.fillStyle = "#555";
    g.fillRect(x, y, cell, cell);
    g.fillStyle = "#777";
    g.fillRect(x, y, h, h);
    g.fillRect(x + h, y + h, cell - h, cell - h);
  }

  private renderPalette(): void {
    const host = $("paletteEl");
    host.innerHTML = "";
    this.colors().forEach((c, i) => {
      const sw = document.createElement("button");
      sw.className =
        "swatch" + (i === this.primary ? " primary" : "") + (i === this.secondary ? " secondary" : "");
      if (i === TRANSPARENT_INDEX) {
        sw.classList.add("transparent");
        sw.title = "transparent — left/right click to assign";
      } else {
        sw.style.background = intToCss(c);
        const nm = this.slotName(i);
        sw.title = nm ? `${nm} — ${intToHex(c).toUpperCase()}` : intToHex(c).toUpperCase();
        if (nm) sw.classList.add("named");
      }
      // Left click = primary (L button), right click = secondary (R button).
      sw.addEventListener("click", () => {
        this.primary = i;
        if (i !== TRANSPARENT_INDEX) $<HTMLInputElement>("colorPicker").value = intToHex(c);
        this.renderPalette();
      });
      sw.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.secondary = i;
        this.renderPalette();
      });
      host.appendChild(sw);
    });
    const label = (idx: number) => (idx === TRANSPARENT_INDEX ? "—" : intToHex(this.colors()[idx]).toUpperCase());
    $("activeHex").textContent = `L ${label(this.primary)}  ·  R ${label(this.secondary)}`;
    // Reflect the selected slot's name — but don't fight the user mid-type.
    const nameInput = $<HTMLInputElement>("colorName");
    if (document.activeElement !== nameInput) nameInput.value = this.slotName(this.primary);
    nameInput.disabled = this.primary === TRANSPARENT_INDEX;
  }

  private renderVariants(): void {
    const host = $("variantsEl");
    host.innerHTML = "";
    this.project.palettes.forEach((pal, i) => {
      const b = document.createElement("button");
      b.className = "variant" + (i === this.activePalette ? " active" : "");
      b.textContent = pal.name + (pal.rarity ? ` · ${pal.rarity}` : "");
      b.addEventListener("click", () => {
        this.activePalette = i;
        this.primary = Math.min(this.primary, this.colors().length - 1);
        this.secondary = Math.min(this.secondary, this.colors().length - 1);
        this.syncVariantInputs();
        this.renderVariants();
        this.renderPalette();
        this.renderGrid();
      });
      host.appendChild(b);
    });
    this.syncVariantInputs();
  }

  private syncVariantInputs(): void {
    $<HTMLInputElement>("variantName").value = this.variant().name;
    $<HTMLInputElement>("variantRarity").value = this.variant().rarity;
  }

  private renderFrames(): void {
    const host = $("framesEl");
    host.innerHTML = "";
    this.project.frames.forEach((_, i) => {
      const b = document.createElement("button");
      b.className = "frame" + (i === this.activeFrame ? " active" : "");
      b.textContent = String(i + 1);
      b.addEventListener("click", () => {
        this.clearSelection(); // marquee belongs to the frame it was made on
        this.activeFrame = i;
        this.renderFrames();
        this.renderGrid();
      });
      host.appendChild(b);
    });
  }

  /** Frame sequence the preview plays: the selected clip, else every frame. */
  private playSequence(): number[] {
    const seq = this.activeClip ? this.project.clips[this.activeClip] : undefined;
    return seq && seq.length ? seq : this.project.frames.map((_, i) => i);
  }

  private renderClips(): void {
    const host = $("clipsEl");
    host.innerHTML = "";
    const names = Object.keys(this.project.clips);
    if (this.activeClip && !this.project.clips[this.activeClip]) this.activeClip = null;
    for (const name of names) {
      const b = document.createElement("button");
      b.className = "clip" + (name === this.activeClip ? " active" : "");
      b.textContent = name;
      b.title = `${name}: ${this.project.clips[name].map((i) => i + 1).join(", ")}`;
      b.addEventListener("click", () => {
        this.activeClip = this.activeClip === name ? null : name;
        this.animFrame = 0;
        this.renderClips();
      });
      host.appendChild(b);
    }
    // Edit row mirrors the selected clip (frame numbers shown 1-based).
    const editing = this.activeClip !== null;
    $("clipEditRow").style.display = editing ? "" : "none";
    if (editing && this.activeClip) {
      $<HTMLInputElement>("clipName").value = this.activeClip;
      $<HTMLInputElement>("clipFrames").value = this.project.clips[this.activeClip].map((i) => i + 1).join(", ");
    }
    $<HTMLButtonElement>("btnDelClip").disabled = !editing;
  }

  /** Parse a "1, 2, 3" frame list (1-based UI) into clamped 0-based indices. */
  private parseFrameList(text: string): number[] {
    const n = this.project.frames.length;
    return text
      .split(/[,\s]+/)
      .map((s) => parseInt(s, 10) - 1)
      .filter((i) => Number.isInteger(i) && i >= 0 && i < n);
  }

  // --- live preview ---

  private tick = (now: number): void => {
    const fps = clamp(parseInt($<HTMLInputElement>("fpsInput").value, 10) || 6, 1, 30);
    const seq = this.playSequence();
    if (this.playing && now - this.lastAdvance >= 1000 / fps) {
      this.animFrame = (this.animFrame + 1) % seq.length;
      this.lastAdvance = now;
    }
    const idx = this.playing ? (seq[this.animFrame % seq.length] ?? 0) : this.activeFrame;
    this.renderPreview(this.project.frames[idx]);
    requestAnimationFrame(this.tick);
  };

  private renderPreview(frame: number[]): void {
    const g = this.previewCtx;
    const s = this.previewScale;
    const colors = this.colors();
    const { previewW: w, previewH: h } = this;
    // Checkerboard background so transparent pixels read as transparent.
    const bs = 8;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = frame[y * w + x] ?? TRANSPARENT_INDEX;
        if (idx === TRANSPARENT_INDEX) {
          g.fillStyle = (((x / bs) | 0) + ((y / bs) | 0)) & 1 ? "#787878" : "#505050";
        } else {
          g.fillStyle = intToCss(colors[idx] ?? 0);
        }
        g.fillRect(x * s, y * s, s, s);
      }
    }
  }

  // --- import / export ---

  /**
   * Save the project .json straight into assets/<name>.json. Preferred path is
   * the dev-server API (works in every browser); if there's no server (static
   * build) we fall back to the Chromium File System Access picker, then to a
   * plain download.
   */
  private async saveJson(): Promise<void> {
    // Normalize the name so the file is always valid and the field reflects it.
    const safe = this.project.name.trim() || "sprite";
    if (this.project.name !== safe) {
      this.project.name = safe;
      $<HTMLInputElement>("assetName").value = safe;
    }
    const filename = `${safe}.json`;
    const text = toJson(this.project);

    // 1. Dev-server middleware — writes directly to assets/, all browsers.
    if (await this.saveViaApi(filename, text)) {
      this.currentFile = filename;
      this.markSaved();
      this.flashSaved(filename);
      this.updateCurrentFile();
      void this.refreshAssets();
      return;
    }

    // 2. File System Access API (Chromium, e.g. static hosting).
    const picker = window.showSaveFilePicker;
    if (picker) {
      try {
        if (!this.fileHandle || this.fileHandle.name !== filename) {
          this.fileHandle = await picker({
            suggestedName: filename,
            types: [{ description: "Sprite project", accept: { "application/json": [".json"] } }],
          });
        }
        const writable = await this.fileHandle.createWritable();
        await writable.write(text);
        await writable.close();
        this.markSaved();
        this.flashSaved(this.fileHandle.name);
      } catch (err) {
        if ((err as DOMException)?.name === "AbortError") return; // user cancelled
        this.fileHandle = null;
        alert("Save failed: " + (err as Error).message);
      }
      return;
    }

    // 3. Last resort: download to the browser's downloads dir.
    this.download(filename, text);
    this.markSaved();
  }

  /** PUT the project into assets/ via the dev middleware. False if unreachable. */
  private async saveViaApi(file: string, text: string): Promise<boolean> {
    try {
      const res = await fetch(`/api/assets/${encodeURIComponent(file)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: text,
      });
      return res.ok;
    } catch {
      return false; // no dev server (static build)
    }
  }

  // --- project list (assets/ via dev API) ---

  /** Fetch the asset list and render clickable sprite thumbnails. */
  private async refreshAssets(): Promise<void> {
    const host = $("projectsEl");
    let entries: { file: string; project?: SpriteProject; error?: string }[];
    try {
      const res = await fetch("/api/assets");
      if (!res.ok) return; // server present but errored
      entries = await res.json();
    } catch {
      // No dev server — hide the panel entirely.
      $("projectsCard").style.display = "none";
      return;
    }
    entries = entries.filter((e) => !e.file.endsWith(".map.json")); // tilemaps belong to the tilemap editor
    $("projectsCard").style.display = "";
    host.innerHTML = "";
    for (const entry of entries) {
      const item = document.createElement("button");
      item.className = "project" + (entry.file === this.currentFile ? " active" : "");
      item.title = entry.error ? `${entry.file}: ${entry.error}` : entry.file;
      const canvas = document.createElement("canvas");
      if (entry.project) this.drawThumb(canvas, entry.project);
      const label = document.createElement("span");
      label.textContent = entry.file.replace(/\.json$/, "");
      item.append(canvas, label);
      if (entry.project) item.addEventListener("click", () => void this.openAsset(entry.file));
      host.appendChild(item);
    }
  }

  /** Render frame 0 of a project into a thumbnail canvas. */
  private drawThumb(canvas: HTMLCanvasElement, p: SpriteProject): void {
    if (!p.palettes || !p.frames || !p.width) return; // not a sprite project
    canvas.width = p.width;
    canvas.height = p.height;
    const g = canvas.getContext("2d")!;
    const colors = p.palettes[0]?.colors ?? [];
    const frame = p.frames[0] ?? [];
    for (let y = 0; y < p.height; y++) {
      for (let x = 0; x < p.width; x++) {
        const idx = frame[y * p.width + x] ?? TRANSPARENT_INDEX;
        if (idx === TRANSPARENT_INDEX) continue; // leave the black canvas showing
        g.fillStyle = intToCss(colors[idx] ?? 0);
        g.fillRect(x, y, 1, 1);
      }
    }
  }

  /** Load a project from assets/ into the editor. */
  private async openAsset(file: string): Promise<void> {
    let text: string;
    try {
      const res = await fetch(`/api/assets/${encodeURIComponent(file)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      text = await res.text();
    } catch (err) {
      alert(`Couldn't open ${file}: ${(err as Error).message}`);
      return;
    }
    try {
      this.beginAction();
      this.project = fromJson(text);
      this.fileHandle = null;
      this.currentFile = file;
      this.activePalette = 0;
      this.primary = Math.min(1, this.colors().length - 1);
      this.secondary = TRANSPARENT_INDEX;
      this.activeFrame = 0;
      this.activeClip = null;
      $<HTMLInputElement>("assetName").value = this.project.name;
      $<HTMLInputElement>("newW").value = String(this.project.width);
      $<HTMLInputElement>("newH").value = String(this.project.height);
      this.rebuildForSize();
      this.renderAll();
      this.updateCurrentFile();
      this.markSaved(); // just loaded — matches disk
      void this.refreshAssets(); // re-highlight the active item
    } catch (err) {
      alert("Load failed: " + (err as Error).message);
    }
  }

  private updateCurrentFile(): void {
    $("currentFile").textContent = this.currentFile ? `editing ${this.currentFile}` : "unsaved";
  }

  /** Briefly confirm a save on the Save button. */
  private flashSaved(name: string): void {
    const btn = $("btnSave");
    btn.textContent = `Saved → ${name}`;
    window.setTimeout(() => (btn.textContent = "Save"), 1500);
  }

  private download(filename: string, text: string): void {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  private importPalette(e: Event): void {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        this.beginAction();
        const pal = paletteFromJson(String(reader.result));
        // Keep every variant the same role count: grow all to the common max.
        const target = Math.max(this.colors().length, pal.colors.length, 1);
        for (const v of this.project.palettes) while (v.colors.length < target) v.colors.push(0);
        while (pal.colors.length < target) pal.colors.push(0);
        pal.colors.length = target;
        this.project.palettes.push(pal);
        this.activePalette = this.project.palettes.length - 1;
        this.renderVariants();
        this.renderPalette();
        this.renderGrid();
      } catch (err) {
        alert("Palette import failed: " + (err as Error).message);
      }
    };
    reader.readAsText(file);
    input.value = ""; // allow re-importing the same file
  }
}

function uniqueClipName(clips: Record<string, number[]>, base = "idle"): string {
  if (!clips[base]) return base;
  let n = 2;
  while (clips[`${base} ${n}`]) n++;
  return `${base} ${n}`;
}

function uniqueVariantName(palettes: Palette[], base: string): string {
  const names = new Set(palettes.map((p) => p.name));
  if (!names.has(base + " copy")) return base + " copy";
  let n = 2;
  while (names.has(`${base} copy ${n}`)) n++;
  return `${base} copy ${n}`;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function line(g: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number): void {
  g.beginPath();
  g.moveTo(x0, y0);
  g.lineTo(x1, y1);
  g.stroke();
}
