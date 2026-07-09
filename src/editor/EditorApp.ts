import { hexToInt, intToCss, intToHex } from "../color";
import { cornerMask, genDualFrames, BL, BR, TL, TR, type Filled } from "../dualgrid";
import { TILE_PX } from "../tilemap";
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
  tileFlipAt,
  toJson,
  type SpriteKind,
  type TileFlip,
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

type Tool = "pencil" | "eraser" | "fill" | "select" | "eyedropper";

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
 * Sprites the game references by a FIXED name, so renaming them would break the
 * build / runtime lookups: const imports (CROP, TILLED, COIN, FARMHAND, HEART)
 * and animals resolved by species (cow/chicken/sheep). Keep in sync with the
 * hardcoded names in main.ts / barn.ts. Tiles and other sprites rename freely.
 */
const RESERVED_NAMES = new Set(["crop", "tilled", "coin", "farmhand", "heart", "cow", "chicken", "sheep"]);

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
  private tiled = false; // preview the sprite as a 3x3 grid to check tiling
  private terrain = false; // preview a sample terrain patch assembled from all 16 dual-grid frames
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
    this.project = newProject("untitled", 16, 16); // 16px = the game's tile size; scale up via Resize for larger sprites
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
    $<HTMLInputElement>("newW").value = String(this.project.width);
    $<HTMLInputElement>("newH").value = String(this.project.height);

    $("btnNew").addEventListener("click", () => {
      const w = clamp(parseInt($<HTMLInputElement>("newW").value, 10) || 16, 1, 128);
      const h = clamp(parseInt($<HTMLInputElement>("newH").value, 10) || 16, 1, 128);
      this.beginAction();
      this.project = newProject("untitled", w, h); // named on first Save (Save As)
      this.fileHandle = null;
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

    for (const t of ["pencil", "eraser", "fill", "select", "eyedropper"] as Tool[]) {
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
      if (this.tool === "eyedropper") {
        this.pickColor(e.button === 2); // right button picks the R (secondary) slot
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
      if (this.tool === "eyedropper") {
        if (this.painting) this.pickColor((e.buttons & 2) !== 0); // drag to keep picking
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
      } else if (ctrl && k === "c") {
        e.preventDefault();
        this.copySelection();
      } else if (ctrl && k === "v") {
        e.preventDefault();
        this.paste();
      } else if (e.key === "Escape" && this.selection) {
        // Escape deselects (matching Aseprite).
        this.clearSelection();
        this.renderGrid();
      } else {
        // Single-key tool switch (Aseprite-style). Flip the radio so its
        // change handler runs — keeps tool wiring in one place.
        const toolKeys: Record<string, Tool> = { b: "pencil", e: "eraser", g: "fill", m: "select", i: "eyedropper" };
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
    $("btnCopyFrame").addEventListener("click", () => this.copySelection());
    $("btnPasteFrame").addEventListener("click", () => this.paste());
    $("btnFlipH").addEventListener("click", () => this.flipFrame(true));
    $("btnFlipV").addEventListener("click", () => this.flipFrame(false));
    $("btnPlay").addEventListener("click", () => {
      this.playing = !this.playing;
      this.animFrame = 0;
      $("btnPlay").textContent = this.playing ? "Stop" : "Play";
    });

    $<HTMLInputElement>("tilePreview").addEventListener("change", (e) => {
      this.tiled = (e.target as HTMLInputElement).checked;
      if (this.tiled && this.terrain) { // the two preview modes are exclusive
        this.terrain = false;
        $<HTMLInputElement>("terrainPreview").checked = false;
      }
      this.sizePreview(); // resize the canvas; the tick re-renders next frame
    });
    $<HTMLInputElement>("terrainPreview").addEventListener("change", (e) => {
      this.terrain = (e.target as HTMLInputElement).checked;
      if (this.terrain && this.tiled) {
        this.tiled = false;
        $<HTMLInputElement>("tilePreview").checked = false;
      }
      this.sizePreview();
    });

    const syncTileFlip = () => {
      const h = $<HTMLInputElement>("tileFlipH").checked;
      const v = $<HTMLInputElement>("tileFlipV").checked;
      const flip: TileFlip = h && v ? "hv" : h ? "h" : v ? "v" : "none";
      this.beginAction();
      this.project.tileFlip = flip === "none" ? undefined : flip;
    };
    $<HTMLInputElement>("tileFlipH").addEventListener("change", syncTileFlip);
    $<HTMLInputElement>("tileFlipV").addEventListener("change", syncTileFlip);

    $("btnGenDual").addEventListener("click", () => this.genDualGrid());

    $<HTMLSelectElement>("spriteKind").addEventListener("change", (e) => {
      this.beginAction();
      const kind = (e.target as HTMLSelectElement).value as SpriteKind;
      this.project.kind = kind === "tile" ? "tile" : undefined;
      if (kind !== "tile") this.project.tileFlip = undefined; // flip is tile-only
      // Hint the map tile size for the next New/Resize (doesn't touch current art).
      if (kind === "tile") { $<HTMLInputElement>("newW").value = String(TILE_PX); $<HTMLInputElement>("newH").value = String(TILE_PX); }
      this.syncTileFlipInputs();
    });

    $("btnResize").addEventListener("click", () => this.resizeProject());

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
    $("btnSaveAs").addEventListener("click", () => void this.saveAs());
    $("btnRename").addEventListener("click", () => void this.renameSprite());
    $("btnDelete").addEventListener("click", () => void this.deleteSprite());
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

  /**
   * Resize the current sprite to the size fields, anchored top-left: pad new
   * area with transparent, crop anything outside. Applies to every frame, so
   * the whole animation stays consistent. Makes the size fields actually do
   * something to a loaded sprite (Save then writes the new dimensions).
   */
  private resizeProject(): void {
    const ow = this.project.width, oh = this.project.height;
    const w = clamp(parseInt($<HTMLInputElement>("newW").value, 10) || ow, 1, 128);
    const h = clamp(parseInt($<HTMLInputElement>("newH").value, 10) || oh, 1, 128);
    if (w === ow && h === oh) { this.renameStatus(`already ${w}×${h}`); return; }
    if ((w < ow || h < oh) && !window.confirm(`Resize to ${w}×${h}? Pixels outside the new bounds are cropped.`)) return;
    this.beginAction();
    const cw = Math.min(ow, w), ch = Math.min(oh, h);
    this.project.frames = this.project.frames.map((f) => {
      const n = new Array(w * h).fill(TRANSPARENT_INDEX);
      for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) n[y * w + x] = f[y * ow + x];
      return n;
    });
    this.project.width = w;
    this.project.height = h;
    this.clearSelection();
    this.rebuildForSize();
    this.renderAll();
  }

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

  // Pixel clipboard lives in localStorage so a copy survives switching sprites
  // (and reloads) — the whole point of cross-sprite paste.
  private static readonly CLIP_KEY = "harvestEditor.frameClipboard";

  private readClipboard(): { w: number; h: number; data: number[] } | null {
    try {
      const raw = localStorage.getItem(EditorApp.CLIP_KEY);
      const c = raw ? JSON.parse(raw) : null;
      return c && Array.isArray(c.data) ? c : null;
    } catch { return null; }
  }

  /** Copy the current selection's pixels to the shared clipboard. Only valid
   *  with the Select tool and an active marquee (the buttons gate this too). */
  private copySelection(): void {
    if (this.tool !== "select" || !this.selection) return;
    const s = this.selection;
    const { width } = this.project;
    const frame = this.project.frames[this.activeFrame];
    const data: number[] = [];
    for (let dy = 0; dy < s.h; dy++)
      for (let dx = 0; dx < s.w; dx++)
        data.push(frame[(s.y + dy) * width + (s.x + dx)]);
    try { localStorage.setItem(EditorApp.CLIP_KEY, JSON.stringify({ w: s.w, h: s.h, data })); } catch { /* quota */ }
    this.updateActionButtons();
  }

  /** Paste the clipboard pixels into the frame and select them, so they can be
   *  dragged into place with the Select tool. Anchored at the current selection
   *  (or top-left), clipped to the frame. Indices map slot-for-slot, so pasting
   *  across sprites keeps the shape and takes on the target palette's colors. */
  private paste(): void {
    const clip = this.readClipboard();
    if (!clip) return;
    this.beginAction();
    this.commitFloating();
    const { width: W, height: H } = this.project;
    const px = clamp(this.selection ? this.selection.x : 0, 0, Math.max(0, W - clip.w));
    const py = clamp(this.selection ? this.selection.y : 0, 0, Math.max(0, H - clip.h));
    const frame = this.project.frames[this.activeFrame];
    for (let dy = 0; dy < clip.h; dy++)
      for (let dx = 0; dx < clip.w; dx++) {
        const v = clip.data[dy * clip.w + dx];
        if (v === TRANSPARENT_INDEX) continue; // overlay: transparent passes through
        const gx = px + dx, gy = py + dy;
        if (gx < W && gy < H) frame[gy * W + gx] = v;
      }
    // Switch to Select and marquee the pasted region so it's ready to reposition.
    $<HTMLInputElement>("tool-select").checked = true;
    this.tool = "select";
    this.selection = { x: px, y: py, w: Math.min(clip.w, W - px), h: Math.min(clip.h, H - py) };
    this.selMode = "none";
    this.renderFrames();
    this.renderGrid();
  }

  /** Mirror the active selection (if any) or the whole frame, horizontally or
   *  vertically. */
  private flipFrame(horizontal: boolean): void {
    this.beginAction();
    this.commitFloating();
    const { width: W, height: H } = this.project;
    const frame = this.project.frames[this.activeFrame];
    const r = this.selection ?? { x: 0, y: 0, w: W, h: H };
    const src: number[] = [];
    for (let dy = 0; dy < r.h; dy++)
      for (let dx = 0; dx < r.w; dx++)
        src.push(frame[(r.y + dy) * W + (r.x + dx)]);
    for (let dy = 0; dy < r.h; dy++)
      for (let dx = 0; dx < r.w; dx++) {
        const sx = horizontal ? r.w - 1 - dx : dx;
        const sy = horizontal ? dy : r.h - 1 - dy;
        frame[(r.y + dy) * W + (r.x + dx)] = src[sy * r.w + sx];
      }
    this.renderFrames();
    this.renderGrid();
  }

  /** Enable Copy only with the Select tool + an active selection; Paste only
   *  when the clipboard has pixels. */
  private updateActionButtons(): void {
    ($<HTMLButtonElement>("btnCopyFrame")).disabled = !(this.tool === "select" && !!this.selection);
    ($<HTMLButtonElement>("btnPasteFrame")).disabled = !this.readClipboard();
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

  /** Eyedropper: adopt the palette index under the cursor as the L (or R) color. */
  private pickColor(secondary: boolean): void {
    if (this.hoverX < 0) return;
    const idx = this.project.frames[this.activeFrame][this.hoverY * this.project.width + this.hoverX];
    if (secondary) this.secondary = idx;
    else {
      this.primary = idx;
      if (idx !== TRANSPARENT_INDEX) $<HTMLInputElement>("colorPicker").value = intToHex(this.colors()[idx]);
    }
    this.renderPalette(); // reflect the new active slot (swatch, hex, name)
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
    $("dirtyDot").hidden = !this.dirty; // the shared status line is for transient messages
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

    this.sizePreview();
  }

  /** Size the preview canvas + scale for the current mode (single / 3×3 tiled / terrain montage). */
  private sizePreview(): void {
    const { width, height } = this.project;
    this.previewW = width;
    this.previewH = height;
    const pc = $<HTMLCanvasElement>("previewCanvas");
    if (this.terrain) {
      // (W+1)×(H+1) display tiles, each width×height px, laid edge-to-edge.
      const dw = SAMPLE_W + 1, dh = SAMPLE_H + 1;
      this.previewScale = Math.max(1, Math.floor(288 / Math.max(dw * width, dh * height)));
      pc.width = dw * width * this.previewScale;
      pc.height = dh * height * this.previewScale;
    } else {
      const tiles = this.tiled ? 3 : 1;
      const box = this.tiled ? 240 : 192; // fit the whole grid in roughly this box
      this.previewScale = Math.max(1, Math.floor(box / (Math.max(width, height) * tiles)));
      pc.width = width * this.previewScale * tiles;
      pc.height = height * this.previewScale * tiles;
    }
    this.previewCtx = pc.getContext("2d")!;
    this.previewCtx.imageSmoothingEnabled = false;
  }

  private renderAll(): void {
    this.renderVariants();
    this.renderPalette();
    this.renderFrames();
    this.renderClips();
    this.renderGrid();
    this.syncTileFlipInputs();
  }

  /** Reflect the loaded project's kind + tileFlip into the header + flip controls. */
  private syncTileFlipInputs(): void {
    const isTile = this.project.kind === "tile";
    $<HTMLSelectElement>("spriteKind").value = isTile ? "tile" : "sprite";
    $("tileFlipRow").style.display = isTile ? "" : "none"; // flip is tile-only
    const f = this.project.tileFlip;
    $<HTMLInputElement>("tileFlipH").checked = f === "h" || f === "hv";
    $<HTMLInputElement>("tileFlipV").checked = f === "v" || f === "hv";
  }

  private renderGrid(): void {
    this.updateActionButtons(); // keep Copy/Paste enabled-state in sync with tool+selection
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
    // In dual-grid mode (a 16-frame tile) frame index === corner mask, so label
    // each button with a 2×2 corner glyph — otherwise "1…16" says nothing.
    const dual = this.project.kind === "tile" && this.project.frames.length === 16;
    this.project.frames.forEach((_, i) => {
      const b = document.createElement("button");
      b.className = "frame" + (i === this.activeFrame ? " active" : "");
      if (dual) {
        b.appendChild(cornerGlyph(i));
        const num = document.createElement("span");
        num.className = "fnum";
        num.textContent = String(i);
        b.appendChild(num);
        b.title = `frame ${i} — terrain corners: ${cornerNames(i)}`;
      } else {
        b.textContent = String(i + 1);
      }
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

  // --- dual-grid tileset generation ---

  /**
   * Replace this sprite's frames with a generated 16-frame dual-grid tileset:
   * the current frame becomes the interior fill, the R (secondary) slot the rim
   * (transparent R = no rim), rounded by the radius input. Turns the sprite into
   * a tile (kind=tile, no flip). Save + `npm run gen`, then point a tilemap
   * layer's dual tileset at it.
   */
  private genDualGrid(): void {
    const { width, height } = this.project;
    if (width !== height) { this.renameStatus("dual-grid needs a square tile (w = h)"); return; }
    const size = width;
    this.beginAction();
    const fill = this.project.frames[this.activeFrame].slice();
    const rim = this.secondary === TRANSPARENT_INDEX ? undefined : this.secondary;
    const radius = clamp(parseInt($<HTMLInputElement>("dualRadius").value, 10) || 4, 1, (size >> 1) - 1);
    this.project.frames = genDualFrames({ size, fill, radius, rim });
    this.project.clips = {};
    this.project.kind = "tile";
    this.project.tileFlip = undefined; // dual tiles must not random-flip (breaks seams)
    this.activeFrame = 0;
    this.activeClip = null;
    this.clearSelection();
    this.renderAll();
    this.sizePreview();
    // Tilemaps are TILE_PX square; a differently-sized tileset previews fine but
    // won't align when laid in a map, so steer toward the right size.
    this.renameStatus(
      size === TILE_PX
        ? `generated 16 dual-grid frames · save + npm run gen, then set a layer's dual tileset to "${this.project.name}"`
        : `generated, but tilemap tiles are ${TILE_PX}px — this is ${size}px and won't align in maps. Make a ${TILE_PX}×${TILE_PX} tile.`,
    );
  }

  // --- live preview ---

  private tick = (now: number): void => {
    if (this.terrain) { // assembled terrain montage — static, redrawn live for palette/frame edits
      this.renderTerrain();
      requestAnimationFrame(this.tick);
      return;
    }
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

  /**
   * Assemble a sample terrain patch from the project's frames using dual-grid
   * corner rules — the "joined" picture. Each display tile picks its frame by
   * the 4 surrounding world cells (frame index = corner mask), laid edge-to-edge
   * so seams show exactly as in-game. Drawn from the live frames + active
   * palette, so editing any tile updates the montage.
   */
  private renderTerrain(): void {
    const g = this.previewCtx;
    const s = this.previewScale;
    const colors = this.colors();
    const { width: tw, height: th, frames } = this.project;
    const nFrames = frames.length;
    const filled: Filled = (col, row) =>
      col >= 0 && row >= 0 && col < SAMPLE_W && row < SAMPLE_H && SAMPLE[row * SAMPLE_W + col];
    // Checkerboard behind everything so transparent terrain edges read.
    const bs = 8, cw = g.canvas.width, ch = g.canvas.height;
    for (let y = 0; y < ch; y += bs)
      for (let x = 0; x < cw; x += bs) {
        g.fillStyle = (((x / bs) | 0) + ((y / bs) | 0)) & 1 ? "#787878" : "#505050";
        g.fillRect(x, y, bs, bs);
      }
    for (let cy = 0; cy <= SAMPLE_H; cy++) {
      for (let cx = 0; cx <= SAMPLE_W; cx++) {
        const m = cornerMask(filled, cx, cy);
        if (m === 0) continue; // corner outside terrain — leave checker showing
        const frame = frames[Math.min(m, nFrames - 1)];
        const ox = cx * tw, oy = cy * th;
        for (let y = 0; y < th; y++) {
          for (let x = 0; x < tw; x++) {
            const idx = frame[y * tw + x] ?? TRANSPARENT_INDEX;
            if (idx === TRANSPARENT_INDEX) continue;
            g.fillStyle = intToCss(colors[idx] ?? 0);
            g.fillRect((ox + x) * s, (oy + y) * s, s, s);
          }
        }
      }
    }
    // Outline every display tile that uses the frame being edited, tying the
    // active frame to where it lands in the terrain. Skip 0 (empty) — its tiles
    // draw nothing, so highlighting bare checker would just be noise.
    const active = this.activeFrame;
    if (active !== 0) {
      for (let cy = 0; cy <= SAMPLE_H; cy++) {
        for (let cx = 0; cx <= SAMPLE_W; cx++) {
          if (cornerMask(filled, cx, cy) !== active) continue;
          const px = cx * tw * s, py = cy * th * s, w = tw * s, h = th * s;
          g.lineWidth = 1;
          g.strokeStyle = "rgba(0,0,0,0.85)"; // dark backing, then bright, reads on any tile
          g.strokeRect(px + 0.5, py + 0.5, w - 1, h - 1);
          g.strokeStyle = "#ffd54a";
          g.strokeRect(px + 1.5, py + 1.5, w - 3, h - 3);
        }
      }
    }
  }

  private renderPreview(frame: number[]): void {
    const g = this.previewCtx;
    const s = this.previewScale;
    const colors = this.colors();
    const { previewW: w, previewH: h } = this;
    const tiles = this.tiled ? 3 : 1;
    const fullW = w * tiles, fullH = h * tiles;
    // Wrap the sprite across the whole canvas (modulo) so a 3x3 grid reveals
    // tiling seams. Checkerboard shows through transparent pixels, continuous
    // across tiles so gaps read correctly. Per-cell flips match the game.
    const flip = this.tiled ? this.project.tileFlip : undefined;
    const bs = 8;
    for (let y = 0; y < fullH; y++) {
      for (let x = 0; x < fullW; x++) {
        const { flipX, flipY } = tileFlipAt(flip, (x / w) | 0, (y / h) | 0);
        const lx = flipX ? w - 1 - (x % w) : x % w;
        const ly = flipY ? h - 1 - (y % h) : y % h;
        const idx = frame[ly * w + lx] ?? TRANSPARENT_INDEX;
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
   * Save to the current file. An untitled sprite has no file yet, so this
   * defers to Save As (which prompts for a name). Ctrl+S routes here too.
   */
  private async saveJson(): Promise<void> {
    if (!this.currentFile) return this.saveAs();
    if (await this.writeFile(this.currentFile, toJson(this.project))) {
      this.markSaved();
      this.flashSaved(this.currentFile);
      void this.refreshAssets();
    }
  }

  /** Save a copy under a new name, then switch to editing that file. */
  private async saveAs(): Promise<void> {
    const base = this.currentFile ? this.currentFile.replace(/\.json$/, "") : this.project.name;
    const raw = window.prompt("Save as (file name):", base === "untitled" ? "" : base);
    if (raw === null) return; // cancelled
    const name = raw.trim().replace(/[^A-Za-z0-9._-]/g, "_");
    if (!name) { this.renameStatus("enter a file name"); return; }
    const file = `${name}.json`;
    this.project.name = name;
    if (await this.writeFile(file, toJson(this.project))) {
      this.currentFile = file;
      this.fileHandle = null;
      this.markSaved();
      this.flashSaved(file);
      this.updateCurrentFile();
      void this.refreshAssets();
    }
  }

  /**
   * Write the project JSON to assets/<file>. Preferred path is the dev-server
   * API (all browsers); falls back to the Chromium File System Access picker,
   * then a plain download. Returns true once the bytes are written (or handed
   * to a download); false on cancel or unrecoverable error.
   */
  private async writeFile(file: string, text: string): Promise<boolean> {
    // 1. Dev-server middleware — writes directly to assets/.
    if (await this.saveViaApi(file, text)) return true;

    // 2. File System Access API (Chromium, e.g. static hosting).
    const picker = window.showSaveFilePicker;
    if (picker) {
      try {
        if (!this.fileHandle || this.fileHandle.name !== file) {
          this.fileHandle = await picker({
            suggestedName: file,
            types: [{ description: "Sprite project", accept: { "application/json": [".json"] } }],
          });
        }
        const writable = await this.fileHandle.createWritable();
        await writable.write(text);
        await writable.close();
        return true;
      } catch (err) {
        if ((err as DOMException)?.name === "AbortError") return false; // cancelled
        this.fileHandle = null;
        alert("Save failed: " + (err as Error).message);
        return false;
      }
    }

    // 3. Last resort: download to the browser's downloads dir.
    this.download(file, text);
    return true;
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

  /** Reflect the loaded file in the header title + which file actions apply. */
  private updateCurrentFile(): void {
    $("docTitle").textContent = this.currentFile ?? "untitled";
    // Save As always works; Rename/Delete need a saved file, and are locked for
    // sprites the game references by a fixed name (renaming would break the build).
    const saved = !!this.currentFile;
    const reserved = saved && RESERVED_NAMES.has(this.currentFile!.replace(/\.json$/, ""));
    const rename = $<HTMLButtonElement>("btnRename");
    const del = $<HTMLButtonElement>("btnDelete");
    rename.disabled = del.disabled = !saved || reserved;
    const why = reserved
      ? "Referenced by name in game code — locked."
      : !saved
        ? "Save the sprite first."
        : "";
    rename.title = why || "Rename this file and update tilemap references…";
    del.title = why || "Delete this file from assets/";
  }

  /** Briefly confirm a save in the status area (button label stays put). */
  private flashSaved(name: string): void {
    this.renameStatus(`saved → ${name}`);
  }

  private renameStatus(msg: string): void {
    const el = $("saveState");
    el.textContent = msg;
    window.setTimeout(() => (el.textContent = ""), 3000);
  }

  /**
   * Rename the loaded file (a move): write the new .json, delete the old one,
   * and rewrite any tilemap cells that referenced the old name. The generated
   * registry self-heals on the next `npm run gen`.
   */
  private async renameSprite(): Promise<void> {
    if (!this.currentFile) { this.renameStatus("save before renaming"); return; }
    const oldFile = this.currentFile;
    const oldName = oldFile.replace(/\.json$/, "");
    if (RESERVED_NAMES.has(oldName)) { this.renameStatus(`"${oldName}" is used by name in game code — can't rename`); return; }
    const raw = window.prompt("Rename file to:", oldName);
    if (raw === null) return; // cancelled
    const newName = raw.trim().replace(/[^A-Za-z0-9._-]/g, "_");
    if (!newName || newName === oldName) { this.renameStatus("enter a different name"); return; }
    const newFile = `${newName}.json`;

    this.project.name = newName;
    if (!(await this.saveViaApi(newFile, toJson(this.project)))) {
      this.renameStatus("rename needs the dev server");
      return;
    }
    await fetch(`/api/assets/${encodeURIComponent(oldFile)}`, { method: "DELETE" }).catch(() => {});
    const maps = await this.renameInMaps(oldName, newName);

    this.currentFile = newFile;
    this.fileHandle = null;
    this.markSaved();
    this.updateCurrentFile();
    void this.refreshAssets();
    this.renameStatus(`renamed → ${newFile}${maps ? ` · ${maps} map(s) updated` : ""} · run npm run gen`);
  }

  /** Delete the loaded file from assets/, then drop back to an untitled sprite. */
  private async deleteSprite(): Promise<void> {
    if (!this.currentFile) { this.renameStatus("nothing to delete"); return; }
    const file = this.currentFile;
    const name = file.replace(/\.json$/, "");
    if (RESERVED_NAMES.has(name)) { this.renameStatus(`"${name}" is used by name in game code — can't delete`); return; }
    if (!window.confirm(`Delete ${file}? This removes it from assets/. Run npm run gen after.`)) return;
    const ok = await fetch(`/api/assets/${encodeURIComponent(file)}`, { method: "DELETE" }).then((r) => r.ok).catch(() => false);
    if (!ok) { this.renameStatus("delete needs the dev server"); return; }

    // Reset to a fresh untitled sprite at the same size.
    this.undoStack = [];
    this.redoStack = [];
    this.project = newProject("untitled", this.project.width, this.project.height);
    this.fileHandle = null;
    this.currentFile = null;
    this.activePalette = 0;
    this.primary = 1;
    this.secondary = TRANSPARENT_INDEX;
    this.activeFrame = 0;
    this.activeClip = null;
    this.rebuildForSize();
    this.renderAll();
    this.updateHistoryButtons();
    this.updateCurrentFile();
    this.markSaved();
    void this.refreshAssets();
    this.renameStatus(`deleted ${file} · run npm run gen`);
  }

  /** Replace a tile name in every map's cells. Returns how many maps changed. */
  private async renameInMaps(oldName: string, newName: string): Promise<number> {
    let changed = 0;
    try {
      const res = await fetch("/api/assets");
      if (!res.ok) return 0;
      const list = (await res.json()) as { file: string; project?: { cells?: unknown[] } }[];
      for (const e of list) {
        const cells = e.project?.cells;
        if (!e.file.endsWith(".map.json") || !Array.isArray(cells) || !cells.includes(oldName)) continue;
        const updated = { ...e.project, cells: cells.map((c) => (c === oldName ? newName : c)) };
        if (await this.saveViaApi(e.file, JSON.stringify(updated, null, 2))) changed++;
      }
    } catch { /* no dev server */ }
    return changed;
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

// Sample terrain for the montage preview — a blob with islands, a hole, and a
// diagonal pinch so edges, outer corners, inner corners, and the diagonal case
// all appear joined. "#" = terrain, "." = empty.
const SAMPLE_ROWS = [
  "..........",
  ".###..##..",
  ".#####.#..",
  ".##.####..",
  ".#####.#..",
  "..###.##..",
  "..........",
];
const SAMPLE_W = SAMPLE_ROWS[0].length;
const SAMPLE_H = SAMPLE_ROWS.length;
const SAMPLE: boolean[] = SAMPLE_ROWS.join("").split("").map((c) => c === "#");

/** A 16px 2×2 icon showing which of the 4 corners are terrain for a dual-grid mask. */
function cornerGlyph(mask: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = 16;
  c.height = 16;
  const g = c.getContext("2d")!;
  g.fillStyle = "#2b2f38"; // empty-corner backing
  g.fillRect(0, 0, 16, 16);
  g.fillStyle = "#7bc47f"; // terrain corner
  const quad = (bit: number, x: number, y: number) => { if (mask & bit) g.fillRect(x, y, 7, 7); };
  quad(TL, 1, 1); quad(TR, 8, 1); quad(BL, 1, 8); quad(BR, 8, 8);
  return c;
}

/** Human list of a mask's terrain corners, for the frame tooltip. */
function cornerNames(mask: number): string {
  if (mask === 0) return "none (empty)";
  if (mask === 15) return "all (solid fill)";
  return [[TL, "TL"], [TR, "TR"], [BL, "BL"], [BR, "BR"]]
    .filter(([bit]) => mask & (bit as number))
    .map(([, n]) => n)
    .join(", ");
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
