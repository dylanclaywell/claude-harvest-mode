// main.ts — game entry. Loads the durable save, reconciles it against the live
// session (baseline rule: only post-load events count), and draws a placeholder
// farm. Real sprites (from the ported editor) replace the rectangles later.

import { parseSessionText, type SessionResult } from "./parser";
import { inTauri, listProjects, listSessions, readSession, onSessionChanged, watchProject } from "./ipc";
import { loadSave, persistSave, defaultSave, type HarvestSave } from "./save";
import { rollover, applySession, type Cursors, type Interaction } from "./state";
import { seasonOf, GROWTH_STAGES } from "./config";
import { drawSprite, CROP, TILE, COIN } from "./sprites";
import { drawTileMap } from "./tilemap";
import { makeFarmMap } from "./maps";
import { drawText, textWidth } from "./font";
import { BarnView } from "./barn";

const statusEl = document.getElementById("status") as HTMLDivElement;
const canvas = document.getElementById("farm") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
ctx.imageSmoothingEnabled = false;

const barn = new BarnView();
const farmMap = makeFarmMap();

function status(msg: string): void { statusEl.textContent = msg; }

const INK = "#e8d8b0", DIRT = "#3a2a18";
const SCALE = 2; // sprites are 16x16 native; blit at 2x → 32px cells

function draw(save: HarvestSave, live: SessionResult | null, now: Date): void {
  const W = canvas.width, H = canvas.height;
  drawTileMap(ctx, farmMap, TILE, 0, 0, 1); // tiled farm ground (full screen)

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

  // Field: one plot per saved crop. Tilled tile under, crop sprite on top.
  const cell = 16 * SCALE + 4, cols = Math.max(1, Math.floor((W - 16) / cell)), x0 = 8, y0 = 26;
  Object.entries(save.field).slice(0, cols * 4).forEach(([path, c], i) => {
    const x = x0 + (i % cols) * cell, y = y0 + Math.floor(i / cols) * cell;
    drawSprite(ctx, TILE, x, y, { frame: 1, scale: SCALE }); // tilled soil
    const stage = Math.min(GROWTH_STAGES, c.ripe ? GROWTH_STAGES : c.stage);
    drawSprite(ctx, CROP, x, y, { frame: stage, scale: SCALE });
    drawText(ctx, (path.split(/[\\/]/).pop() || "").slice(0, 5), x, y + 16 * SCALE + 1, { color: INK });
  });

  // (Animals live in the slide-in barn panel now — see BarnView.)

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
}

// Latest data to render. The render loop reads this every animation frame;
// data refresh (session parse / rollover) just swaps it in. Decoupling the two
// means sprites animate at 60fps regardless of how often the session changes.
let view: { save: HarvestSave; live: SessionResult | null } | null = null;

function startRenderLoop(): void {
  const frame = (t: number): void => {
    if (view) {
      barn.update(view.save, t);
      draw(view.save, view.live, new Date());
      barn.draw(ctx, view.save, t); // overlay on top of the farm
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// Canvas-space click routing: the barn tab is drawn in the 320x240 buffer, so
// map the click from CSS pixels back into buffer coords and hit-test it.
function wireCanvasClicks(): void {
  canvas.addEventListener("click", (e) => {
    const r = canvas.getBoundingClientRect();
    const x = (e.clientX - r.left) * (canvas.width / r.width);
    const y = (e.clientY - r.top) * (canvas.height / r.height);
    if (barn.hit(x, y, canvas.width)) barn.toggle();
  });
}

async function main(): Promise<void> {
  startRenderLoop();
  wireCanvasClicks();

  if (!inTauri()) {
    status("Browser dev mode — launch via `npm run tauri dev` for live data.");
    const demo = defaultSave();
    demo.field["a.ts"] = { crop: "Tomato", ext: ".ts", stage: 2, quality: 1, ripe: false };
    demo.field["b.rs"] = { crop: "Corn", ext: ".rs", stage: GROWTH_STAGES, quality: 1.5, ripe: true };
    demo.barn["codegraph"] = { species: "Cow", hearts: 3, ageDays: 4, lastFedDate: null, pendingProduce: 2 };
    demo.barn["julie"] = { species: "Chicken", hearts: 2, ageDays: 2, lastFedDate: null, pendingProduce: 1 };
    demo.barn["rivet"] = { species: "Sheep", hearts: 1, ageDays: 1, lastFedDate: null, pendingProduce: 0 };
    view = { save: demo, live: null };
    // Dev-only: press "i" to simulate an MCP interaction (cycles servers).
    const servers = Object.keys(demo.barn);
    let di = 0, first = true;
    window.addEventListener("keydown", (e) => {
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
      const n = applySession(save, sess.id, live.events, cursors, new Date(), effects);
      if (n > 0) await persistSave(save);
      view = { save, live };
      for (const it of effects) barn.poke(it, performance.now());
    };

    await refresh(); // first attach = baseline, applies nothing
    await onSessionChanged(refresh);
  } catch (e) {
    status("Error: " + (e instanceof Error ? e.message : String(e)));
  }
}

void main();
