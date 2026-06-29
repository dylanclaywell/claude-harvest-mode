// main.ts — game entry. Loads the durable save, reconciles it against the live
// session (baseline rule: only post-load events count), and draws a placeholder
// farm. Real sprites (from the ported editor) replace the rectangles later.

import { parseSessionText, type SessionResult } from "./parser";
import { inTauri, listProjects, listSessions, readSession, onSessionChanged, watchProject } from "./ipc";
import { loadSave, persistSave, defaultSave, type HarvestSave } from "./save";
import { rollover, applySession, type Cursors } from "./state";
import { seasonOf, GROWTH_STAGES } from "./config";
import { drawSprite, drawTiled, animFrame, SPRITES, CROP, TILE, COIN, HEART } from "./sprites";

const statusEl = document.getElementById("status") as HTMLDivElement;
const canvas = document.getElementById("farm") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
ctx.imageSmoothingEnabled = false;

function status(msg: string): void { statusEl.textContent = msg; }

const GRASS = "#2d4a1e", INK = "#e8d8b0", DIRT = "#3a2a18";
const SCALE = 2; // sprites are 16x16 native; blit at 2x → 32px cells

function draw(save: HarvestSave, live: SessionResult | null, now: Date, t: number): void {
  const W = canvas.width, H = canvas.height;
  ctx.fillStyle = GRASS;
  ctx.fillRect(0, 0, W, H);
  // Grass tile bed beneath the whole play area (16px tiles at 2x = 32px cells).
  drawTiled(ctx, TILE, 0, 22, Math.ceil(W / (16 * SCALE)), Math.ceil((H - 48) / (16 * SCALE)), { frame: 0, scale: SCALE });

  // HUD
  ctx.fillStyle = DIRT;
  ctx.fillRect(0, 0, W, 22);
  ctx.fillStyle = INK;
  ctx.font = "8px monospace";
  ctx.fillText(`DAY ${save.dayCount}  ${seasonOf(now)}`, 4, 9);
  drawSprite(ctx, COIN, 60, 2, { scale: 1 });
  ctx.fillText(`${save.goldTotal}`, 70, 9);
  ctx.fillText(`recipes ${save.recipeBook.length}  animals ${Object.keys(save.barn).length}`, 4, 18);
  // stamina = remaining context (derived live)
  const ctxUsed = live?.contextUsed ?? 0, ctxWin = live?.contextWindow ?? 200000;
  const rem = ctxWin ? 1 - Math.min(1, ctxUsed / ctxWin) : 1;
  ctx.fillStyle = "#222";
  ctx.fillRect(W - 84, 4, 80, 6);
  ctx.fillStyle = rem < 0.15 ? "#d82800" : "#58d854";
  ctx.fillRect(W - 84, 4, 80 * rem, 6);
  ctx.fillStyle = INK;
  ctx.fillText("STAMINA", W - 84, 18);

  // Field: one plot per saved crop. Tilled tile under, crop sprite on top.
  const cell = 16 * SCALE + 4, cols = Math.max(1, Math.floor((W - 16) / cell)), x0 = 8, y0 = 26;
  Object.entries(save.field).slice(0, cols * 4).forEach(([path, c], i) => {
    const x = x0 + (i % cols) * cell, y = y0 + Math.floor(i / cols) * cell;
    drawSprite(ctx, TILE, x, y, { frame: 1, scale: SCALE }); // tilled soil
    const stage = Math.min(GROWTH_STAGES, c.ripe ? GROWTH_STAGES : c.stage);
    drawSprite(ctx, CROP, x, y, { frame: stage, scale: SCALE });
    ctx.fillStyle = INK;
    ctx.fillText((path.split(/[\\/]/).pop() || "").slice(0, 5), x, y + 16 * SCALE + 7);
  });

  // Barn
  const by = H - 22;
  ctx.fillStyle = INK;
  ctx.fillText("BARN:", 4, by - 4);
  Object.entries(save.barn).slice(0, 6).forEach(([srv, a], i) => {
    const x = 36 + i * 46;
    const sprite = SPRITES[a.species.toLowerCase()];
    if (sprite) drawSprite(ctx, sprite, x, by - 18, { scale: SCALE, frame: animFrame(sprite, t, { clip: "idle", fps: 4 }) });
    for (let hI = 0; hI < a.hearts; hI++) drawSprite(ctx, HEART, x + hI * 8, by + 14, { scale: 1 });
    ctx.fillStyle = INK;
    ctx.fillText(srv.slice(0, 5), x, by - 20);
  });

  // Morning report overlay
  if (save.pendingReport && save.pendingReport.shipped.length) {
    const r = save.pendingReport;
    const bw = 200, bh = 16 + r.shipped.length * 10 + 14, bx = (W - bw) / 2, byo = 30;
    ctx.fillStyle = "rgba(20,16,10,0.92)";
    ctx.fillRect(bx, byo, bw, bh);
    ctx.strokeStyle = INK;
    ctx.strokeRect(bx + 0.5, byo + 0.5, bw - 1, bh - 1);
    ctx.fillStyle = INK;
    ctx.fillText(`~ DAY ${save.dayCount}  ${r.date} ~`, bx + 8, byo + 12);
    r.shipped.forEach((l, i) => {
      ctx.fillText(`${l.qty}x ${l.crop} (${l.ext})`, bx + 8, byo + 24 + i * 10);
      ctx.fillText(`${l.gold}G`, bx + bw - 36, byo + 24 + i * 10);
    });
    ctx.fillText(`Earned ${r.earned}G   Total ${save.goldTotal}G`, bx + 8, byo + bh - 4);
  }

  ctx.fillStyle = INK;
  ctx.font = "7px monospace";
  ctx.fillText((live?.meta.title || "Harvest Code").slice(0, 52), 4, H - 2);
}

// Latest data to render. The render loop reads this every animation frame;
// data refresh (session parse / rollover) just swaps it in. Decoupling the two
// means sprites animate at 60fps regardless of how often the session changes.
let view: { save: HarvestSave; live: SessionResult | null } | null = null;

function startRenderLoop(): void {
  const frame = (t: number): void => {
    if (view) draw(view.save, view.live, new Date(), t);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

async function main(): Promise<void> {
  startRenderLoop();

  if (!inTauri()) {
    status("Browser dev mode — launch via `npm run tauri dev` for live data.");
    const demo = defaultSave();
    demo.field["a.ts"] = { crop: "Tomato", ext: ".ts", stage: 2, quality: 1, ripe: false };
    demo.field["b.rs"] = { crop: "Corn", ext: ".rs", stage: GROWTH_STAGES, quality: 1.5, ripe: true };
    view = { save: demo, live: null };
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
      const n = applySession(save, sess.id, live.events, cursors, new Date());
      if (n > 0) await persistSave(save);
      view = { save, live };
    };

    await refresh(); // first attach = baseline, applies nothing
    await onSessionChanged(refresh);
  } catch (e) {
    status("Error: " + (e instanceof Error ? e.message : String(e)));
  }
}

void main();
