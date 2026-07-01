// Tilemap editor (dev-only). Paint tiles onto stacked LAYERS, then save
// assets/<name>.map.json (the source of truth maps.ts loads). Each cell names a
// kind="tile" sprite; the palette is every such sprite. A layer can be flagged
// `above` to draw over entities in-game (tree tops, roofs). Sibling to the
// sprite editor; shares the /api/assets dev shim.

import { drawSprite, SPRITES, type GenSprite } from "../sprites";
import { tileFlipAt } from "../editor/project";
import { cornerMask, type Filled } from "../dualgrid";
import { TILE_PX } from "../tilemap";

interface Layer { name: string; above?: boolean; cells: string[]; dual?: { tileset: string }; }
interface MapFile { name: string; w: number; h: number; layers: Layer[]; }
type Tool = "pencil" | "fill";

// Marker stored in a dual layer's cells: any non-"" value means "terrain here"
// (bakeDual only tests truthiness). A constant keeps the mask independent of the
// tileset name, so renaming the tileset never rewrites the map.
const ON = "1";

/** Every paintable tile: sprites marked kind="tile", as [name, sprite]. */
function tileSprites(): [string, GenSprite][] {
  return Object.entries(SPRITES).filter(([, s]) => s.kind === "tile");
}
function firstTile(): string {
  return tileSprites()[0]?.[0] ?? "";
}
/** A tile usable as a dual-grid tileset: kind="tile", 16 frames, and TILE_PX
 *  square so it aligns to the map grid (see bakeDual). */
function isDualTileset(s: GenSprite | undefined): boolean {
  return !!s && s.kind === "tile" && s.frames.length >= 16 && s.width === TILE_PX && s.height === TILE_PX;
}

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el as T;
}
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Accept current {layers} or legacy single {cells}; ensure ≥1 layer. */
function toLayers(m: { w: number; h: number; layers?: Layer[]; cells?: unknown[] }): Layer[] {
  if (Array.isArray(m.layers) && m.layers.length) {
    return m.layers.map((l) => ({
      name: l.name ?? "layer",
      above: !!l.above,
      cells: (l.cells ?? []).map(String),
      ...(l.dual?.tileset ? { dual: { tileset: String(l.dual.tileset) } } : {}),
    }));
  }
  return [{ name: "ground", cells: (m.cells ?? new Array(m.w * m.h).fill("")).map(String) }];
}

class TilemapEditor {
  private map: MapFile = blankMap("untitled", 20, 15);
  private active = 0;            // active layer index
  private visible: boolean[] = [true]; // editor-only per-layer visibility
  private tile: string = firstTile();
  private tool: Tool = "pencil";
  private dispScale = 1;
  private painting = false;
  private currentFile: string | null = null;
  private undoStack: { layer: number; cells: string[] }[] = [];

  private grid = $<HTMLCanvasElement>("tmCanvas");
  private ctx = this.grid.getContext("2d")!;

  init(): void {
    this.ctx.imageSmoothingEnabled = false;
    this.wire();
    this.renderTiles();
    this.renderLayers();
    this.applySize();
    this.renderGrid();
    void this.refreshMaps().then(() => void this.openFirstOr(this.map.name));
  }

  private cells(): string[] { return this.map.layers[this.active].cells; }

  // --- wiring ---

  private wire(): void {
    document.querySelectorAll<HTMLInputElement>('input[name="tool"]').forEach((r) =>
      r.addEventListener("change", () => { if (r.checked) this.tool = r.value as Tool; }),
    );

    const c = this.grid;
    c.addEventListener("contextmenu", (e) => e.preventDefault());
    c.addEventListener("pointerdown", (e) => {
      this.painting = true;
      c.setPointerCapture(e.pointerId);
      this.snapshot();
      this.paintAt(e, e.button === 2 ? "" : this.tile);
    });
    c.addEventListener("pointermove", (e) => {
      if (this.painting && this.tool === "pencil") this.paintAt(e, e.buttons & 2 ? "" : this.tile);
    });
    c.addEventListener("pointerup", () => (this.painting = false));
    c.addEventListener("pointercancel", () => (this.painting = false));

    window.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); this.undo(); }
    });

    // Layer panel buttons.
    $("layAdd").addEventListener("click", () => this.addLayer());
    $("layDel").addEventListener("click", () => this.delLayer());
    $("layUp").addEventListener("click", () => this.moveLayer(1));
    $("layDown").addEventListener("click", () => this.moveLayer(-1));
    $("layAbove").addEventListener("click", () => this.toggleAbove());
    $("layDual").addEventListener("click", () => this.toggleDual());
    $("layRename").addEventListener("click", () => this.renameLayer());

    $("btnNew").addEventListener("click", () => {
      const name = ($<HTMLInputElement>("mapName").value.trim() || "untitled").replace(/[^A-Za-z0-9._-]/g, "");
      const w = clamp(parseInt($<HTMLInputElement>("mapW").value, 10) || 20, 1, 60);
      const h = clamp(parseInt($<HTMLInputElement>("mapH").value, 10) || 15, 1, 60);
      this.map = blankMap(name, w, h);
      this.active = 0;
      this.visible = this.map.layers.map(() => true);
      this.currentFile = null;
      this.undoStack = [];
      this.applySize();
      this.renderLayers();
      this.renderGrid();
      this.status(`new ${w}×${h} map`);
    });
    $("btnSave").addEventListener("click", () => void this.save());
    $<HTMLInputElement>("mapName").addEventListener("input", (e) => (this.map.name = (e.target as HTMLInputElement).value));
  }

  // --- layers ---

  private addLayer(): void {
    const name = `layer ${this.map.layers.length}`;
    this.map.layers.push({ name, above: false, cells: new Array(this.map.w * this.map.h).fill("") });
    this.visible.push(true);
    this.active = this.map.layers.length - 1; // select the new (top) layer
    this.undoStack = [];
    this.renderLayers();
    this.renderGrid();
  }

  private delLayer(): void {
    if (this.map.layers.length <= 1) { this.status("a map needs at least one layer"); return; }
    this.map.layers.splice(this.active, 1);
    this.visible.splice(this.active, 1);
    this.active = clamp(this.active, 0, this.map.layers.length - 1);
    this.undoStack = [];
    this.renderLayers();
    this.renderGrid();
  }

  /** Move the active layer by `dir` in draw order (+1 = toward front/top). */
  private moveLayer(dir: number): void {
    const j = this.active + dir;
    if (j < 0 || j >= this.map.layers.length) return;
    [this.map.layers[this.active], this.map.layers[j]] = [this.map.layers[j], this.map.layers[this.active]];
    [this.visible[this.active], this.visible[j]] = [this.visible[j], this.visible[this.active]];
    this.active = j;
    this.renderLayers();
    this.renderGrid();
  }

  private toggleAbove(): void {
    const l = this.map.layers[this.active];
    l.above = !l.above;
    this.renderLayers();
  }

  /**
   * Toggle dual-grid autotiling on the active layer. Turning it on binds the
   * currently selected tile as the tileset (must be a 16-frame dual tileset —
   * generate one in the sprite editor's "Gen 16") and reinterprets the layer's
   * cells as a terrain mask, so any previously painted names collapse to on/off.
   */
  private toggleDual(): void {
    const l = this.map.layers[this.active];
    if (l.dual) {
      delete l.dual;
      this.status(`dual off — "${l.name}" is a normal tile layer`);
    } else {
      const tileset = isDualTileset(SPRITES[this.tile]) ? this.tile : tileSprites().find(([, s]) => isDualTileset(s))?.[0];
      if (!tileset) { this.status("no 16-frame dual tileset found — make one in the sprite editor (Gen 16)"); return; }
      l.dual = { tileset };
      l.cells = l.cells.map((c) => (c ? ON : "")); // existing paint → terrain mask
      this.status(`dual on — "${l.name}" uses tileset "${tileset}"; paint terrain on/off`);
    }
    this.renderLayers();
    this.renderGrid();
  }

  private renameLayer(): void {
    const cur = this.map.layers[this.active].name;
    const next = window.prompt("Layer name", cur);
    if (next) { this.map.layers[this.active].name = next.trim() || cur; this.renderLayers(); }
  }

  private renderLayers(): void {
    const host = $("layersEl");
    host.innerHTML = "";
    // Top layer (drawn last) listed first, so the list reads top→bottom.
    for (let i = this.map.layers.length - 1; i >= 0; i--) {
      const l = this.map.layers[i];
      const row = document.createElement("div");
      row.className = "layer" + (i === this.active ? " active" : "");
      const eye = document.createElement("button");
      eye.className = "eye";
      eye.textContent = this.visible[i] ? "👁" : "—";
      eye.title = "toggle visibility";
      eye.addEventListener("click", (e) => { e.stopPropagation(); this.visible[i] = !this.visible[i]; this.renderLayers(); this.renderGrid(); });
      const label = document.createElement("span");
      label.className = "layer-name";
      label.textContent = l.name + (l.above ? "  ▲above" : "") + (l.dual ? `  ⧉${l.dual.tileset}` : "");
      row.append(eye, label);
      row.addEventListener("click", () => { this.active = i; this.undoStack = []; this.renderLayers(); });
      host.appendChild(row);
    }
  }

  // --- editing ---

  private cellAt(e: PointerEvent): number {
    const r = this.grid.getBoundingClientRect();
    const cell = 16 * this.dispScale;
    const x = Math.floor((e.clientX - r.left) * (this.grid.width / r.width) / cell);
    const y = Math.floor((e.clientY - r.top) * (this.grid.height / r.height) / cell);
    if (x < 0 || y < 0 || x >= this.map.w || y >= this.map.h) return -1;
    return y * this.map.w + x;
  }

  private paintAt(e: PointerEvent, tile: string): void {
    const i = this.cellAt(e);
    if (i < 0) return;
    // On a dual layer, cells are a terrain mask: paint the ON marker, not a name.
    const val = this.map.layers[this.active].dual ? (tile ? ON : "") : tile;
    if (this.tool === "fill") this.flood(i, val);
    else this.cells()[i] = val;
    this.renderGrid();
  }

  private flood(start: number, to: string): void {
    const cells = this.cells();
    const from = cells[start];
    if (from === to) return;
    const { w, h } = this.map;
    const stack = [start];
    while (stack.length) {
      const i = stack.pop()!;
      if (cells[i] !== from) continue;
      cells[i] = to;
      const x = i % w, y = (i / w) | 0;
      if (x > 0) stack.push(i - 1);
      if (x < w - 1) stack.push(i + 1);
      if (y > 0) stack.push(i - w);
      if (y < h - 1) stack.push(i + w);
    }
  }

  private snapshot(): void {
    this.undoStack.push({ layer: this.active, cells: this.cells().slice() });
    if (this.undoStack.length > 80) this.undoStack.shift();
  }
  private undo(): void {
    const prev = this.undoStack.pop();
    if (prev && this.map.layers[prev.layer]) {
      this.map.layers[prev.layer].cells = prev.cells;
      this.active = prev.layer;
      this.renderLayers();
      this.renderGrid();
    }
  }

  // --- rendering ---

  private applySize(): void {
    const { w, h } = this.map;
    this.dispScale = clamp(Math.floor(640 / (Math.max(w, h) * 16)), 1, 4);
    const cell = 16 * this.dispScale;
    this.grid.width = w * cell;
    this.grid.height = h * cell;
    $<HTMLInputElement>("mapName").value = this.map.name;
    $<HTMLInputElement>("mapW").value = String(w);
    $<HTMLInputElement>("mapH").value = String(h);
  }

  private renderGrid(): void {
    const { w, h } = this.map;
    const cell = 16 * this.dispScale;
    const g = this.ctx;
    g.clearRect(0, 0, this.grid.width, this.grid.height);
    // Composite every visible layer bottom→top.
    this.map.layers.forEach((layer, li) => {
      if (!this.visible[li]) return;
      if (layer.dual) { this.drawDualLayer(layer, cell); return; }
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const name = layer.cells[y * w + x];
          const sprite = name ? SPRITES[name] : undefined;
          if (!sprite) continue;
          const { flipX, flipY } = tileFlipAt(sprite.tileFlip, x, y);
          drawSprite(g, sprite, x * cell, y * cell, { frame: 0, scale: this.dispScale, flip: flipX, flipY });
        }
      }
    });
    g.strokeStyle = "rgba(255,255,255,0.10)";
    g.lineWidth = 1;
    for (let x = 0; x <= w; x++) { g.beginPath(); g.moveTo(x * cell + 0.5, 0); g.lineTo(x * cell + 0.5, h * cell); g.stroke(); }
    for (let y = 0; y <= h; y++) { g.beginPath(); g.moveTo(0, y * cell + 0.5); g.lineTo(w * cell, y * cell + 0.5); g.stroke(); }
  }

  /**
   * Draw a dual-grid layer the way the game does: cells are a terrain mask, and
   * each of the (w+1)×(h+1) display tiles picks frame 0..15 from the tileset by
   * its 4 surrounding cells, offset up-left by half a cell. Mirrors bakeDual so
   * the editor is WYSIWYG.
   */
  private drawDualLayer(layer: Layer, cell: number): void {
    const ts = layer.dual ? SPRITES[layer.dual.tileset] : undefined;
    if (!ts) return; // tileset not generated yet — nothing to draw
    const { w, h } = this.map;
    const filled: Filled = (col, row) =>
      col >= 0 && row >= 0 && col < w && row < h && !!layer.cells[row * w + col];
    const half = cell / 2;
    for (let cy = 0; cy <= h; cy++) {
      for (let cx = 0; cx <= w; cx++) {
        const m = cornerMask(filled, cx, cy);
        if (m === 0) continue;
        drawSprite(this.ctx, ts, cx * cell - half, cy * cell - half, { frame: m, scale: this.dispScale });
      }
    }
  }

  private renderTiles(): void {
    const host = $("tilesEl");
    host.innerHTML = "";
    for (const [name, sprite] of tileSprites()) {
      const btn = document.createElement("button");
      btn.className = "tile" + (name === this.tile ? " active" : "");
      btn.title = name;
      const cv = document.createElement("canvas");
      cv.width = 32; cv.height = 32;
      const c = cv.getContext("2d")!;
      c.imageSmoothingEnabled = false;
      drawSprite(c, sprite, 0, 0, { frame: 0, scale: 2 });
      btn.appendChild(cv);
      btn.addEventListener("click", () => {
        this.tile = name;
        // On a dual layer, picking a 16-frame tileset rebinds the layer to it.
        const l = this.map.layers[this.active];
        if (l?.dual && isDualTileset(sprite)) { l.dual.tileset = name; this.renderLayers(); this.renderGrid(); }
        this.renderTiles();
      });
      host.appendChild(btn);
    }
  }

  private status(msg: string): void { $("status").textContent = msg; }

  // --- map files (assets/*.map.json via the dev API) ---

  private async refreshMaps(): Promise<void> {
    const host = $("mapsEl");
    let files: string[] = [];
    try {
      const res = await fetch("/api/assets");
      if (!res.ok) return;
      const list = (await res.json()) as { file: string }[];
      files = list.map((e) => e.file).filter((f) => f.endsWith(".map.json"));
    } catch { return; }
    host.innerHTML = "";
    for (const file of files) {
      const b = document.createElement("button");
      b.className = "mapitem" + (file === this.currentFile ? " active" : "");
      b.textContent = file.replace(/\.map\.json$/, "");
      b.addEventListener("click", () => void this.openMap(file));
      host.appendChild(b);
    }
  }

  private async openFirstOr(_fallback: string): Promise<void> {
    const first = document.querySelector<HTMLButtonElement>("#mapsEl .mapitem");
    if (first) first.click();
  }

  private async openMap(file: string): Promise<void> {
    try {
      const res = await fetch(`/api/assets/${encodeURIComponent(file)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const m = (await res.json()) as MapFile;
      if (!m.w || !m.h) throw new Error("not a tilemap");
      this.map = { name: m.name ?? file.replace(/\.map\.json$/, ""), w: m.w, h: m.h, layers: toLayers(m) };
      this.active = 0;
      this.visible = this.map.layers.map(() => true);
      this.currentFile = file;
      this.undoStack = [];
      this.applySize();
      this.renderLayers();
      this.renderGrid();
      void this.refreshMaps();
      this.status(`editing ${file}`);
    } catch (err) {
      this.status(`open failed: ${(err as Error).message}`);
    }
  }

  private async save(): Promise<void> {
    const name = (this.map.name.trim() || "untitled").replace(/[^A-Za-z0-9._-]/g, "");
    this.map.name = name;
    const file = `${name}.map.json`;
    // Keep files tidy: only emit `above` / `dual` when set.
    const out = {
      name,
      w: this.map.w,
      h: this.map.h,
      layers: this.map.layers.map((l) => ({
        name: l.name,
        ...(l.above ? { above: true } : {}),
        ...(l.dual ? { dual: { tileset: l.dual.tileset } } : {}),
        cells: l.cells,
      })),
    };
    try {
      const res = await fetch(`/api/assets/${encodeURIComponent(file)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(out, null, 2),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.currentFile = file;
      this.status(`saved → ${file}`);
      void this.refreshMaps();
    } catch (err) {
      this.status(`save failed: ${(err as Error).message}`);
    }
  }
}

function blankMap(name: string, w: number, h: number): MapFile {
  return { name, w, h, layers: [{ name: "ground", cells: new Array(w * h).fill(firstTile()) }] };
}

new TilemapEditor().init();
