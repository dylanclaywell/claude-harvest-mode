// Tilemap editor (dev-only). Paint tiles onto a grid, then save
// assets/<name>.map.json (the source of truth maps.ts loads). Each cell names a
// kind="tile" sprite; the palette is every such sprite. Sibling to the sprite
// editor; shares the /api/assets dev shim.

import { drawSprite, SPRITES, type GenSprite } from "../sprites";
import { tileFlipAt } from "../editor/project";

interface MapFile { name: string; w: number; h: number; cells: string[]; }
type Tool = "pencil" | "fill";

/** Every paintable tile: sprites marked kind="tile", as [name, sprite]. */
function tileSprites(): [string, GenSprite][] {
  return Object.entries(SPRITES).filter(([, s]) => s.kind === "tile");
}
function firstTile(): string {
  return tileSprites()[0]?.[0] ?? "";
}

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el as T;
}
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

class TilemapEditor {
  private map: MapFile = blankMap("untitled", 20, 15);
  private tile: string = firstTile(); // selected tile sprite name
  private tool: Tool = "pencil";
  private dispScale = 1;     // integer px scale of the grid
  private painting = false;
  private currentFile: string | null = null;
  private undoStack: string[][] = [];

  private grid = $<HTMLCanvasElement>("tmCanvas");
  private ctx = this.grid.getContext("2d")!;

  init(): void {
    this.ctx.imageSmoothingEnabled = false;
    this.wire();
    this.renderTiles();
    this.applySize();
    this.renderGrid();
    void this.refreshMaps().then(() => void this.openFirstOr(this.map.name));
  }

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
      this.paintAt(e, e.button === 2 ? "" : this.tile); // right-click erases
    });
    c.addEventListener("pointermove", (e) => {
      if (this.painting && this.tool === "pencil") this.paintAt(e, e.buttons & 2 ? "" : this.tile);
    });
    c.addEventListener("pointerup", () => (this.painting = false));
    c.addEventListener("pointercancel", () => (this.painting = false));

    window.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); this.undo(); }
    });

    $("btnNew").addEventListener("click", () => {
      const name = ($<HTMLInputElement>("mapName").value.trim() || "untitled").replace(/[^A-Za-z0-9._-]/g, "");
      const w = clamp(parseInt($<HTMLInputElement>("mapW").value, 10) || 20, 1, 60);
      const h = clamp(parseInt($<HTMLInputElement>("mapH").value, 10) || 15, 1, 60);
      this.map = blankMap(name, w, h);
      this.currentFile = null;
      this.undoStack = [];
      this.applySize();
      this.renderGrid();
      this.status(`new ${w}×${h} map`);
    });
    $("btnSave").addEventListener("click", () => void this.save());
    $<HTMLInputElement>("mapName").addEventListener("input", (e) => (this.map.name = (e.target as HTMLInputElement).value));
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
    if (this.tool === "fill") this.flood(i, tile);
    else this.map.cells[i] = tile;
    this.renderGrid();
  }

  private flood(start: number, to: string): void {
    const from = this.map.cells[start];
    if (from === to) return;
    const { w, h, cells } = this.map;
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
    this.undoStack.push(this.map.cells.slice());
    if (this.undoStack.length > 80) this.undoStack.shift();
  }
  private undo(): void {
    const prev = this.undoStack.pop();
    if (prev) { this.map.cells = prev; this.renderGrid(); }
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
    const { w, h, cells } = this.map;
    const cell = 16 * this.dispScale;
    const g = this.ctx;
    g.clearRect(0, 0, this.grid.width, this.grid.height);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const name = cells[y * w + x];
        const sprite = name ? SPRITES[name] : undefined;
        if (!sprite) continue; // empty / unknown
        // Mirror the game's per-cell random flip so the editor matches in-game.
        const { flipX, flipY } = tileFlipAt(sprite.tileFlip, x, y);
        drawSprite(g, sprite, x * cell, y * cell, { frame: 0, scale: this.dispScale, flip: flipX, flipY });
      }
    }
    g.strokeStyle = "rgba(255,255,255,0.10)";
    g.lineWidth = 1;
    for (let x = 0; x <= w; x++) { g.beginPath(); g.moveTo(x * cell + 0.5, 0); g.lineTo(x * cell + 0.5, h * cell); g.stroke(); }
    for (let y = 0; y <= h; y++) { g.beginPath(); g.moveTo(0, y * cell + 0.5); g.lineTo(w * cell, y * cell + 0.5); g.stroke(); }
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
      btn.addEventListener("click", () => { this.tile = name; this.renderTiles(); });
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
      if (!m.w || !m.h || !Array.isArray(m.cells)) throw new Error("not a tilemap");
      this.map = { name: m.name ?? file.replace(/\.map\.json$/, ""), w: m.w, h: m.h, cells: m.cells.map(String) };
      this.currentFile = file;
      this.undoStack = [];
      this.applySize();
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
    try {
      const res = await fetch(`/api/assets/${encodeURIComponent(file)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(this.map, null, 2),
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
  return { name, w, h, cells: new Array(w * h).fill(firstTile()) };
}

new TilemapEditor().init();
