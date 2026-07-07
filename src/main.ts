// main.ts — game entry. Loads the durable save, reconciles it against the live
// session (baseline rule: only post-load events count), and draws a placeholder
// farm. Real sprites (from the ported editor) replace the rectangles later.

import { parseSessionText, type SessionResult } from "./parser";
import { inTauri, listProjects, listSessions, readSession, onSessionChanged, watchProject } from "./ipc";
import { loadSave, persistSave, defaultSave, type HarvestSave } from "./save";
import { rollover, applySession, type Cursors, type Interaction } from "./state";
import { seasonOf, GROWTH_STAGES } from "./config";
import { drawSprite, CROP, COIN, FARMHAND } from "./sprites";
import { Customizer } from "./customizer";
import { applyAppearance, type Appearance } from "./appearance";
import { drawTileMap } from "./tilemap";
import { makeFarmMap } from "./maps";
import { drawText, textWidth, drawTooltip } from "./font";
import { BarnView } from "./barn";
import { FarmFarmer } from "./farmer";

const statusEl = document.getElementById("status") as HTMLDivElement;
const canvas = document.getElementById("farm") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
ctx.imageSmoothingEnabled = false;

const barn = new BarnView();
const farmMap = makeFarmMap();

// Recolor the in-game player from an appearance. Empty = base palette (clear
// the override so the named-palette fast path is used). Computed once per change
// — not per frame — and shared by the barn farmer and the farm farmhand.
function applyPlayerColors(a: Appearance): void {
  const colors = Object.keys(a).length
    ? applyAppearance(FARMHAND.palettes.base, FARMHAND.names, a)
    : undefined;
  barn.farmerColors = colors;
  farmer.colors = colors;
}

// Character customizer, opened via the on-canvas gear button. Live preview on
// every slider move; persists to the save on Done; reverts to the saved look on
// cancel (Esc / backdrop).
const customizer = new Customizer(FARMHAND, {
  onChange: (a) => applyPlayerColors(a),
  onDone: (a) => {
    if (view) {
      view.save.appearance = a;
      void persistSave(view.save);
    }
    applyPlayerColors(a);
  },
  onCancel: () => applyPlayerColors(view?.save.appearance ?? {}),
});

function status(msg: string): void { statusEl.textContent = msg; }

const INK = "#e8d8b0", DIRT = "#3a2a18";
// The tilled field on the farm map (keep in sync with scripts/make-maps.ts).
// Crops are planted one per tile within this rect; empty plots show bare soil.
const FIELD_X0 = 3, FIELD_Y0 = 9, FIELD_W = 7, FIELD_H = 5;
const farmer = new FarmFarmer({ x0: FIELD_X0, y0: FIELD_Y0, w: FIELD_W, h: FIELD_H });
// Latest cursor position in buffer (320×240) coords, or null when off-canvas.
let mouse: { x: number; y: number } | null = null;

// Crop fruit tint by file extension (CROP palette slots 6=fruit, 7=fruit-hi), so
// each language grows a differently colored crop. Unknown extensions keep the
// sprite's default red. Colors roughly evoke each language's brand.
const CROP_FRUIT: Record<string, [number, number]> = {
  ".ts": [0x2f6fc0, 0x74a8e8], ".tsx": [0x2f6fc0, 0x74a8e8],
  ".js": [0xd8b820, 0xf0e060], ".jsx": [0xd8b820, 0xf0e060], ".json": [0xd8b820, 0xf0e060],
  ".rs": [0xc0662c, 0xe0a060],
  ".py": [0xe0b020, 0xffe070],
  ".go": [0x1aa0c0, 0x70d8f0],
  ".rb": [0xc03030, 0xf08080],
  ".java": [0xc0621e, 0xe0a050], ".kt": [0xc0621e, 0xe0a050],
  ".c": [0x5a78c0, 0x90b0e8], ".cpp": [0x5a78c0, 0x90b0e8], ".h": [0x5a78c0, 0x90b0e8],
  ".css": [0x2f8fc0, 0x74c8e8], ".html": [0xc06a2c, 0xe0a060],
  ".md": [0x8a8a8a, 0xc0c0c0], ".sh": [0x4a9a4a, 0x80d080],
};
const cropBase = Array.from(CROP.palettes.base as ArrayLike<number>);
/** Palette override for a crop of the given extension, or undefined for default. */
function cropColors(ext: string): number[] | undefined {
  const f = CROP_FRUIT[(ext || "").toLowerCase()];
  if (!f) return undefined;
  const c = cropBase.slice();
  c[6] = f[0]; c[7] = f[1];
  return c;
}

// On-canvas settings (gear) button, bottom-right. Drawn each frame; hit-tested
// in wireCanvasClicks. Buffer-space geometry (the 320x240 buffer scales up).
const GEAR_R = 7;
const gearCenter = (W: number, H: number) => ({ cx: W - 13, cy: H - 13 });

function drawGearButton(ctx: CanvasRenderingContext2D, W: number, H: number): void {
  const { cx, cy } = gearCenter(W, H);
  ctx.save();
  ctx.fillStyle = "rgba(20,16,10,0.85)"; // dark disc for contrast over tiles
  ctx.beginPath();
  ctx.arc(cx, cy, GEAR_R + 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = INK;
  for (let i = 0; i < 8; i++) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((i / 8) * Math.PI * 2);
    ctx.fillRect(-1, -GEAR_R - 2, 2, 3); // a tooth
    ctx.restore();
  }
  ctx.beginPath();
  ctx.arc(cx, cy, GEAR_R - 1, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(20,16,10,0.95)"; // center hole
  ctx.beginPath();
  ctx.arc(cx, cy, 2.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function gearHit(x: number, y: number, W: number, H: number): boolean {
  const { cx, cy } = gearCenter(W, H);
  return Math.hypot(x - cx, y - cy) <= GEAR_R + 4;
}

function draw(save: HarvestSave, live: SessionResult | null, now: Date): void {
  const W = canvas.width, H = canvas.height;
  drawTileMap(ctx, farmMap, false, 0, 0, 1); // under-entity farm layers (full screen)

  // Crops (one 16px sprite per field tile) + the farmhand, depth-sorted by ground
  // y so the farmer overlaps correctly. Tilled soil is baked into the map below.
  const nowMs = performance.now();
  const items: { y: number; render: () => void }[] = [];
  Object.entries(save.field).slice(0, FIELD_W * FIELD_H).forEach(([, c], i) => {
    const x = (FIELD_X0 + (i % FIELD_W)) * 16, y = (FIELD_Y0 + Math.floor(i / FIELD_W)) * 16;
    const stage = Math.min(GROWTH_STAGES, c.ripe ? GROWTH_STAGES : c.stage);
    items.push({ y: y + 16, render: () => drawSprite(ctx, CROP, x, y, { frame: stage, scale: 1, colors: cropColors(c.ext) }) });
  });
  if (!barn.isOpen) { // hide the farmhand while the barn is open — they're in it
    items.push({ y: farmer.sortY, render: () => farmer.draw(ctx, nowMs) });
    farmer.drawShadow(ctx);
  }
  items.sort((a, b) => a.y - b.y).forEach((it) => it.render());

  // HUD
  ctx.fillStyle = DIRT;
  ctx.fillRect(0, 0, W, 22);
  const dayLine = `DAY ${save.dayCount}  ${seasonOf(now)}`;
  drawText(ctx, dayLine, 4, 2, { color: INK });
  const goldX = 4 + textWidth(dayLine) + 8; // place coin+gold past the day/season text
  drawSprite(ctx, COIN, goldX, 1, { scale: 1 });
  drawText(ctx, `${save.goldTotal}`, goldX + 10, 2, { color: INK });
  drawText(ctx, `recipes ${save.recipeBook.length}  animals ${Object.keys(save.barn).length}`, 4, 12, { color: INK });
  // stamina = remaining context (derived live)
  const ctxUsed = live?.contextUsed ?? 0, ctxWin = live?.contextWindow ?? 200000;
  const rem = ctxWin ? 1 - Math.min(1, ctxUsed / ctxWin) : 1;
  ctx.fillStyle = "#222";
  ctx.fillRect(W - 84, 2, 80, 6);
  ctx.fillStyle = rem < 0.15 ? "#d82800" : "#58d854";
  ctx.fillRect(W - 84, 2, 80 * rem, 6);
  drawText(ctx, "STAMINA", W - 84, 12, { color: INK });

  // (Crops are drawn on the field above; animals live in the barn panel.)

  drawTileMap(ctx, farmMap, true, 0, 0, 1); // over-entity farm layers (tree tops, etc.)

  // Morning report overlay
  if (save.pendingReport && save.pendingReport.shipped.length) {
    const r = save.pendingReport;
    const bw = 200, bh = 16 + r.shipped.length * 10 + 14, bx = (W - bw) / 2, byo = 30;
    ctx.fillStyle = "rgba(20,16,10,0.92)";
    ctx.fillRect(bx, byo, bw, bh);
    ctx.strokeStyle = INK;
    ctx.strokeRect(bx + 0.5, byo + 0.5, bw - 1, bh - 1);
    drawText(ctx, `~ DAY ${save.dayCount}  ${r.date} ~`, bx + 8, byo + 5, { color: INK });
    r.shipped.forEach((l, i) => {
      drawText(ctx, `${l.qty}x ${l.crop} (${l.ext})`, bx + 8, byo + 17 + i * 10, { color: INK });
      drawText(ctx, `${l.gold}G`, bx + bw - 36, byo + 17 + i * 10, { color: INK });
    });
    drawText(ctx, `Earned ${r.earned}G   Total ${save.goldTotal}G`, bx + 8, byo + bh - 11, { color: INK });
  }

  drawText(ctx, (live?.meta.title || "Harvest Code").slice(0, 52), 4, H - 9, { color: INK });

  // Hover tooltip: the file a planted crop represents. Suppressed while the barn
  // is open (the panel and its own tooltip take over the right side).
  if (mouse && !barn.isOpen) {
    const col = Math.floor(mouse.x / 16), row = Math.floor(mouse.y / 16);
    const i = (row - FIELD_Y0) * FIELD_W + (col - FIELD_X0);
    const inField = col >= FIELD_X0 && col < FIELD_X0 + FIELD_W && row >= FIELD_Y0 && row < FIELD_Y0 + FIELD_H;
    const entries = Object.entries(save.field).slice(0, FIELD_W * FIELD_H);
    if (inField && i >= 0 && i < entries.length) {
      const [path, c] = entries[i];
      drawTooltip(ctx, mouse.x + 4, mouse.y, [path, c.ripe ? "ripe" : `growing ${c.stage}/${GROWTH_STAGES}`], W, H);
    }
  }
}

// Latest data to render. The render loop reads this every animation frame;
// data refresh (session parse / rollover) just swaps it in. Decoupling the two
// means sprites animate at 60fps regardless of how often the session changes.
let view: { save: HarvestSave; live: SessionResult | null } | null = null;

function startRenderLoop(): void {
  const frame = (t: number): void => {
    if (view) {
      barn.update(view.save, t);
      // While the barn panel is open the player is in the barn — pause farm work.
      if (!barn.isOpen && farmer.update(view.save, t)) void persistSave(view.save); // a crop was picked
      draw(view.save, view.live, new Date());
      barn.draw(ctx, view.save, t, mouse); // overlay on top of the farm
      drawGearButton(ctx, canvas.width, canvas.height); // always on top, clickable
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// Canvas-space click routing: the barn tab is drawn in the 320x240 buffer, so
// map the click from CSS pixels back into buffer coords and hit-test it.
function wireCanvasClicks(): void {
  const toBuffer = (e: MouseEvent): { x: number; y: number } => {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (canvas.width / r.width), y: (e.clientY - r.top) * (canvas.height / r.height) };
  };
  canvas.addEventListener("click", (e) => {
    const { x, y } = toBuffer(e);
    if (gearHit(x, y, canvas.width, canvas.height)) {
      if (!customizer.isOpen) customizer.open(view?.save.appearance ?? {});
      return;
    }
    if (barn.hit(x, y, canvas.width)) barn.toggle();
  });
  canvas.addEventListener("mousemove", (e) => { mouse = toBuffer(e); });
  canvas.addEventListener("mouseleave", () => { mouse = null; });
}

async function main(): Promise<void> {
  startRenderLoop();
  wireCanvasClicks();

  if (!inTauri()) {
    status("Browser dev mode — launch via `npm run tauri dev` for live data.");
    const demo = defaultSave();
    demo.field["a.ts"] = { crop: "Tomato", ext: ".ts", stage: GROWTH_STAGES, quality: 1, ripe: true };
    demo.field["b.rs"] = { crop: "Corn", ext: ".rs", stage: GROWTH_STAGES, quality: 1.5, ripe: true };
    // A few more, mostly still growing, so the field stays planted while the
    // farmhand picks off the ripe ones (varied extensions → varied crops).
    ["c.py", "d.go", "e.js", "f.rb", "g.c", "h.java", "i.css"].forEach((f, idx) => {
      const ext = f.slice(f.indexOf("."));
      const ripe = idx % 4 === 0;
      demo.field[f] = { crop: "Crop", ext, stage: ripe ? GROWTH_STAGES : 1 + (idx % (GROWTH_STAGES - 1)), quality: 1, ripe };
    });
    demo.barn["codegraph"] = { species: "Cow", hearts: 3, ageDays: 4, lastFedDate: null, pendingProduce: 2 };
    demo.barn["julie"] = { species: "Chicken", hearts: 2, ageDays: 2, lastFedDate: null, pendingProduce: 1 };
    demo.barn["rivet"] = { species: "Sheep", hearts: 1, ageDays: 1, lastFedDate: null, pendingProduce: 0 };
    demo.appearance = { shirt: { hue: 80 }, hat: { hue: -60 } }; // dev: show off recoloring
    view = { save: demo, live: null };
    applyPlayerColors(demo.appearance);
    // Dev-only: "i" simulates an MCP interaction (cycles servers); "r" fires the
    // recipe-get celebration.
    const servers = Object.keys(demo.barn);
    let di = 0, first = true;
    window.addEventListener("keydown", (e) => {
      if (e.key === "r") { farmer.celebrate(performance.now()); return; }
      if (e.key !== "i") return;
      barn.poke({ server: servers[di++ % servers.length], firstToday: first }, performance.now());
      first = false;
    });
    return;
  }

  try {
    const save = await loadSave();
    rollover(save, new Date());
    await persistSave(save);
    view = { save, live: null };
    applyPlayerColors(save.appearance);

    const projects = await listProjects();
    if (!projects.length) { status("No Claude Code projects found."); return; }
    const proj = projects[0];
    const sessions = await listSessions(proj.id);
    if (!sessions.length) { status(`${proj.name}: no sessions.`); return; }
    const sess = sessions[0];
    status(`${proj.name} · ${sess.title}`);

    await watchProject(proj.id);
    const cursors: Cursors = new Map();

    const refresh = async (): Promise<void> => {
      const text = await readSession(proj.id, sess.id);
      const live = parseSessionText(text);
      const effects: Interaction[] = [];
      const recipesBefore = save.recipeBook.length;
      const n = applySession(save, sess.id, live.events, cursors, new Date(), effects);
      if (n > 0) await persistSave(save);
      view = { save, live };
      for (const it of effects) barn.poke(it, performance.now());
      if (save.recipeBook.length > recipesBefore) farmer.celebrate(performance.now()); // learned a recipe
    };

    await refresh(); // first attach = baseline, applies nothing
    await onSessionChanged(refresh);
  } catch (e) {
    status("Error: " + (e instanceof Error ? e.message : String(e)));
  }
}

void main();
