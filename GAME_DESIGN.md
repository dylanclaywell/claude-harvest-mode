# Claude: Harvest Code — Game Design Document

> A desktop (Tauri) visualizer that renders a live Claude Code session as an
> 8-bit Harvest Moon farm. It **reads** `~/.claude/projects/*/*.jsonl` (the logs
> Claude Code already writes) and animates them — read-only on Claude's logs, no
> hooks, nothing injected into Claude. The game keeps its **own** small save file
> (app-data dir) for the cross-day economy — that is the game's state, separate
> from Claude. Forked from the architecture of `agent-quest` (a NES-Zelda
> visualizer), reskinned to farming.

Status: **v0.3** — locked: crop = file in play · real-calendar seasons · in-season crop-by-extension · overnight harvest economy · gold at day-end · deterministic food-recipe names · app save file + morning report · MCP server = animal · **art via ported `virtual-pet` pixel editor (dev-only, 16-color/RGB565, palette variants)**. §10 levers are now tuning, not blockers.

---

## 1. Vision

Watch your coding session play out as a farm. While Claude works, a little
farmer tends plots, hires farmhands, weathers storms, and ships crops at day's
end. Ambient, fun, and a genuine read on what the session is *doing* — files in
play, subagents running, tokens spent, context filling up.

Design pillars:
- **Truthful.** Everything on screen maps to a real event in the session log.
- **Ambient.** Glanceable. Runs in its own window beside your editor.
- **Cozy.** Harvest Moon tone — no fail states, no pressure. Setbacks are weeds, not game-overs.
- **Decoupled.** Read-only on logs. The game never touches git, files, or Claude's behavior.

---

## 2. Core metaphor

A coding session is cultivation: you plant work, tend it, and harvest results.

| Concept | Maps to |
|---|---|
| The farmer (player avatar) | The main session / orchestrator |
| Farmhands | Subagents (one sprite per `subagent_type`) |
| Crops | Files being worked (see §10 for alternatives) |
| A day | One session |
| Going to sleep → next day | Context compaction (field carries over, stamina refills) |
| The land / number of plots | Context-window tier (200K vs 1M) |

---

## 3. Source data (what we read from the log)

The parser (ported from `agent-quest/lib/parser.js` → `parser.ts`) turns session
JSONL into a typed event timeline. Event kinds and HUD signals available:

**Event kinds**
- `prompt` — a human prompt (new instruction)
- `say` — assistant text (Claude "thinking out loud")
- `tool` — a normal tool call (`Read`/`Edit`/`Bash`/…) + its success/error result
- `agent` / `agentDone` — subagent spawn + completion (✓/✗, duration)
- `skill` — a Skill invocation

**Tool categories** (from `toolCategory()`)
`search` (Read/Glob/Grep/Explore/ToolSearch) · `build` (Edit/Write/MultiEdit/NotebookEdit) ·
`bomb` (Bash/PowerShell) · `scroll` (WebFetch/WebSearch) · `mcp` (`mcp__*`) ·
`agent` · `skill` · `quest` (Task*) · `misc`

**Derived identifiers** (parsed from `tool_use` names/inputs)
- **MCP server** = `name.split("__")[1]` for any `mcp__<server>__<tool>` → drives the barn (§8D).
- **File path** = `input.file_path` on Read/Write/Edit → drives crop plots (§8B).
- **Test pass** = a `Bash`/`PowerShell` whose command matches a test runner + success result → rain/quality.

**HUD signals**
- running **output tokens** (sum of `usage.output_tokens`)
- **context occupancy** per turn (input + cache read + cache creation)
- inferred **context window** (200K / 1M, from peak occupancy)
- counts: agents spawned, skills used

---

## 4. Mapping — tools → farm actions

| Tool category | Trigger | Farm action / animation |
|---|---|---|
| `build` — `Write` (new file) | new file_path seen | **Plant a seed** on an empty plot → new crop, stage 0 |
| `build` — `Edit`/`MultiEdit` (existing file) | file_path already a plot | **Tend/water** that crop → +1 growth stage, watering-can animation |
| `bomb` — `Bash`/`PowerShell` | generic command | **Heavy labor** — farmer swings hoe / chops / breaks a rock |
| `bomb` — **test command, exit 0** | cmd matches test runner + success | **Rain shower** — free water across the whole field |
| `bomb` — command **errors** | non-zero exit | a **rock** or **crow** appears (pest) |
| `search` | Read/Grep/Glob/Explore | **Survey the land** — farmer walks the plot with a lantern/magnifier |
| `scroll` | WebFetch/WebSearch | **Trip to town** — farmer walks to the gate/mailbox, returns with a parcel |
| `mcp` | `mcp__<server>__*` | **Tend an animal** — the barn animal for that MCP server is milked/sheared/collected (see §8E) |
| `skill` | Skill invoke | **Elder's recipe** — "TAKE THIS!" cutscene, recipe added to the book |
| `agent` | Agent/Task spawn | **Hire a farmhand** — sprite walks out of the farmhouse to a plot |

---

## 5. Mapping — events → flourishes

| Event | Flourish |
|---|---|
| `agentDone` ✓ | Farmhand carries a crop to the **shipping bin**, gold ding, then poofs |
| `agentDone` ✗ | Farmhand **trips**, crop wilts, sad chime |
| background agent (`run_in_background`) | Farmhand works a **distant field** (edge of screen) |
| `prompt` (human) | A **rooster crows** / signpost updates with the new instruction |
| `say` (assistant text) | Farmer **wipes brow** / thought bubble |
| tool error result | Crop **wilts** a stage or a **weed** sprouts; cleared on a later success |
| big token burst | **Bountiful sparkle** on the active plot |

---

## 6. Mapping — resources, HUD, time

| Signal | Farm resource |
|---|---|
| **harvested ripe crops** (day-end) | **Gold (G)** — the ONLY gold source; credited overnight, shown next morning |
| running output tokens | **Effort** — HUD stat; optionally feeds crop *size/quality*, never gold directly |
| context occupancy (this turn) | **Stamina bar** — drains as context fills |
| context compaction | **Afternoon nap** — stamina refills (NOT a new day anymore; see day model) |
| context window tier (200K/1M) | **Farm size** — small homestead vs big ranch (more plots) |
| agents spawned | **Farmhands hired** counter |
| skills used | **Recipes learned** counter |
| session elapsed time | **Time-of-day clock** — sun/moon arc across the sky |

**Day/calendar model — LOCKED**
- **A day = a real calendar day.** Multiple sessions in one calendar day = the same farming day.
- **Season = the real-world calendar season** (today's date → spring/summer/fall/winter). The field's crop palette + backdrop follow real life.
- On the **first session of a new calendar day**, the game detects the rollover (compares `lastSessionDate` in the save file), runs the **overnight harvest** (ripe crops → gold), and shows the **morning report**:
  > *Day 4 · Summer 12. Yesterday you shipped: 3× Tomato (.ts), 1× Corn (.md). Earned 340G. Total 1,580G.*
- Compaction is demoted to a cosmetic **nap** (stamina refill only).
- Field + unripe crops + gold + recipes all **persist** in the save file across days/sessions.

**Baseline rule (LOCKED).** The economy only advances from events that arrive
**after the app is open**. On first attach to a session, the log's current length
is snapshotted as a baseline; the historical backlog is ignored (no retroactive
gold). A per-session cursor makes live re-reads idempotent. Trade-off: work done
while the app is closed isn't tracked. Cursors are in-memory per app run; the
durable economy is in the save. (`src/state.ts`)

---

## 7. Core loop (one "day")

1. **Morning** — first session of a new calendar day: run overnight harvest, show **morning report** (yesterday's shipment + gold). Farmer steps out. Day clock starts.
2. **Work** — tool/agent/skill events stream in; farmer + farmhands plant, tend, labor. Edits grow crops; context drains stamina; tokens tick the effort stat.
3. **Weather** — test passes bring rain (free water); errors bring weeds/crows.
4. **Ripen + carry** — a crop that hits max stage becomes **ripe**; a farmhand carries it to the **shipping bin** (visual). No gold yet.
5. **Nightfall (calendar rollover)** — ripe crops in the bin **auto-ship → gold**, banked for tomorrow's morning report. Unripe crops carry over and keep growing. Save file updated.

---

## 8. Screen layout (single screen, v1)

```
┌──────────────────────────────────────────────┐
│ DAY 3  ☀ 14:20   GOLD 1,240   STAMINA ▓▓▓░░  │  ← HUD bar
│ QUEST: sync-pbi-482  ·  farmhands 4 · recipes 2│
├──────────────────────────────────────────────┤
│   farmhouse        field (grid of plots)       │
│      ▟▙        [crop][crop][   ][weed]         │
│     farmer ->  [   ][crop][crop][   ]          │  ← farm scene (canvas)
│                [   ][   ][crop][   ]           │
│   gate/mailbox            shipping bin ▤        │
└──────────────────────────────────────────────┘
```

- HUD bar: day, clock, gold, stamina, quest title (auto-detected), counters.
- Farm scene: farmhouse (spawn point), field grid (plots = files), gate (web), shipping bin (completions).
- Plots recycle / field scrolls when files exceed the grid (cap visible at ~12–16, show overflow count).

---

## 8A. Seasons & crops

**Season = real-world calendar season** (from the system date). The field's crop
palette and backdrop follow real life and change on their own as months pass.

**Crop tables (authentic Harvest Moon, winter filled for non-empty fields).**
Winter is greenhouse/hardy in HM canon — we still show a small set so Dec–Feb
isn't barren.

| Season | Crops |
|---|---|
| Spring | Turnip, Potato, Cucumber, Cabbage, Strawberry |
| Summer | Tomato, Corn, Onion, Pumpkin, Pineapple |
| Fall | Eggplant, Carrot, Sweet Potato, Spinach, Yam |
| Winter | Broccoli, Wasabi, Buckwheat, Snow Turnip *(greenhouse/hardy)* |

**File → crop assignment (LOCKED: in-season set, by extension).**
- `crop = currentSeason.crops[ hash(extension) % currentSeason.crops.length ]`
- Every crop shown is seasonally correct. The same file may show a different crop
  in a different season — charming, not a bug.
- `hash()` is a stable string hash so a given extension is consistent *within* a
  season (all `.ts` files this summer are the same crop).

---

## 8B. Harvest economy

- **Growth.** Each `Edit` to a file's crop = +1 growth stage (0 → ripe over N stages, e.g. N=4).
- **Ripen.** At max stage the crop is **ripe**; a farmhand carries it to the shipping bin (visual only).
- **Quality star.** A test pass touching that file (or high effort/tokens on it) adds a quality multiplier.
- **Price.** `price = base(cropType) × quality`. Bounded by crop type + stages, never raw token count.
- **Harvest.** On calendar rollover, all binned ripe crops **auto-ship → gold**, banked into the next morning report. Unripe crops persist and keep growing.
- **No fail state.** Wilting/weeds (from errors) only slow a crop or dock quality a little; nothing is destroyed.

---

## 8C. Recipes (skills → food)

A `Skill` invocation = the village elder teaching a **food recipe**. Names are
generated from the skill name:

```
[Adjective] [Ingredient] [Dish]
adj:  Hearty, Honeyed, Rustic, Wild, Grandma's, Golden, Spicy
ingr: <a current-season crop — Tomato, Corn, …>
dish: Stew, Pie, Gratin, Risotto, Jam, Skewers, Curry
name = adj[h0] + ingr[h1] + dish[h2]   where h = hash(skillName)
```

- **Stable per skill:** `code-review` → "Hearty Tomato Gratin" every time (hash-seeded, not random).
- **Learn once, then cook (LOCKED).** First time a skill is seen → **LEARN** cutscene ("TAKE THIS!"), recipe added to the book. Repeat invocations of a *known* skill → a small **"Cooked X"** flourish (+tiny gold bonus), **not** a re-learn. Recipe book holds one entry per unique skill (a *collection* to complete).

---

## 8D. Animals & the barn

**Concept — the crops/animals duality.** Crops = files (one-shot work, grown &
harvested). Animals = **recurring resources you keep and tend** — specifically
**MCP servers**, the persistent external services you call again and again.
Fully automatic: no clicks. *(If a session uses no MCP, the barn just stays empty
— animals are a bonus layer, not required.)*

| Aspect | Rule |
|---|---|
| **What** | Each distinct MCP server = one animal. Server name is parsed from tool calls: `name.split("__")[1]` of any `mcp__<server>__<tool>` (double-underscore delimiter). No config needed — servers are *observed* from the log. |
| **Species** | Assigned by **acquisition order**: 1st bought = Cow, 2nd = Chicken, 3rd = Sheep, then cycle. Guarantees variety, no hash collisions. Recorded in the save at purchase → stable forever. (A single MCP = a single animal; the barn fills as you use more servers across days/projects.) |
| **Buy** | At the **morning report**, if a server appears in your logs that isn't in the barn yet AND `gold ≥ price`, it's **auto-purchased** (gold deducted). Multiple new servers buy in order until gold runs out; the rest wait for a richer morning. This is gold's main **sink**. |
| **Produce** | Each `mcp__<server>__*` call = one collection (Cow→milk, Sheep→wool, Chicken→egg), stored in the bin. |
| **Tend / feed** | "Fed" for a day = the server was **used** that day. A day unused drops one **affection heart** (never below 0); a used day adds one (capped). |
| **Affection** | Hearts → a **quality multiplier** on that animal's produce (same star economy as crops). |
| **Grow** | Bought as a **baby**; becomes an **adult** after N real days kept & fed. Babies don't produce yet. |
| **Ship** | Produce auto-ships overnight with the crops → gold in the morning report. |
| **Barn cap** | Soft cap scales with farm size (context tier); extra purchases queue. |

Prices/species/affection curves are balance numbers (see §10).

---

## 8E. Save state (game-owned, separate from Claude)

App-data file, e.g. `harvest-save.json`. Read-only on Claude logs; this is the
game's own persistence for the cross-day economy.

```jsonc
{
  "version": 1,
  "lastSessionDate": "2026-06-26",   // for calendar-rollover detection
  "dayCount": 4,
  "goldTotal": 1580,
  "pendingReport": {                  // shown next morning, then cleared
    "date": "2026-06-25",
    "shipped": [{ "crop": "Tomato", "ext": ".ts", "qty": 3, "gold": 240 }],
    "earned": 340
  },
  "field": {                          // unripe crops carry over
    "src/auth.ts": { "crop": "Tomato", "stage": 2, "quality": 1.0 }
  },
  "barn": {                           // MCP servers kept as animals
    "codegraph": { "species": "Cow", "hearts": 3, "ageDays": 6, "adult": true,
                   "lastFedDate": "2026-06-25", "pendingProduce": 2 }
  },
  "recipeBook": ["Hearty Tomato Gratin", "Rustic Corn Pie"]
}
```

---

## 8F. Art pipeline (ported from `virtual-pet`)

Sprites are **drawn in a real pixel editor**, not hand-typed ASCII. We port
`virtual-pet`'s editor + asset pipeline (a mature TS tool) into the repo.

**Model — indexed palette with variants.** A sprite's pixels are palette
**indices** (roles). Each sprite carries one or more named **palette variants**
that share those roles, so *swapping the palette recolors every frame for free*.
This is the engine behind our recolor needs:
- **Seasonal**: variants `spring / summer / fall / winter`.
- **Quality / affection**: variants as brightness/rarity tiers (the model already has a `rarity` field).
- **Species / farmhand types**: variants per look.

**Constraints (LOCKED — kept from virtual-pet):** 4-bit / **16 colors per
sprite**, RGB565, magenta (`0xf81f`) = transparent key. Authentic 8-bit; ported
verbatim, no model rework. Built-in **animation frames**.

**Pipeline.**
```
editor.html (dev only)  ->  assets/<name>.json   (source of truth, git-committed)
        │  draw / frames / variants                     │
        ▼                                               ▼  npm run gen
  /api/assets dev middleware (write)            src/generated/<name>.ts
                                                 { width, height,
                                                   palettes:{variant:Uint16Array},
                                                   frames:[Uint8Array indices] }
                                                        │
                                                        ▼
                                                 farm renderer (index → canvas blit)
```

**Scope (LOCKED).** Editor is **dev-only** — runs under `npm run dev`, used to
author sprites. The shipped Tauri app contains only the **generated** sprites, no
editor. (Shipping an in-app editor for user reskins = future, see backlog.)

**Drop on port:** ESP32 bits — `firmware/`, the C++ `.h` codegen (`toHeader`),
RGB565-TFT specifics not needed on desktop. Keep `toTypeScript`.

**Sprite sizes (proposed, tune later):** tiles 16×16, characters/animals 32×32,
HUD icons 8–16px. Editor supports 1–128 per side.

---

## 9. MVP — recommended starting point (v1 scope)

Build the **thinnest vertical slice that runs end-to-end on a recorded session**,
then add live + polish. Order:

1. **Pipeline first (replay).** Rust `read_session` command → `parser.ts` → typed
   event timeline. Prove it on a real `.jsonl` before any art.
2. **Art pipeline early.** Port the `virtual-pet` editor + codegen (§8F) so sprites
   exist as generated TS. Author a few placeholder sprites; real set comes in polish.
3. **One farmer + labor animations.** Farmer avatar performs the §4 action per tool event.
4. **Field = files.** Plot grid keyed by file_path; Write plants, Edit grows.
5. **Farmhands.** Spawn/return on agent / agentDone with ✓/✗.
6. **HUD.** Stamina (context), day/season clock, counters. (Gold needs the save+economy — step 7.)
7. **Save state + economy.** `harvest-save.json`: calendar-rollover detection, growth/ripen, overnight harvest, morning report. Gold appears here.
8. **Seasons + crop tables.** Real-calendar season → in-season crop-by-extension.
9. **Then LIVE.** Swap replay for `notify` FS-watch → `emit` → frontend `listen`.
10. **Then polish.** Real sprites, audio, weather, recipe cutscene, shipping-bin carry.

Deliberately **out of v1**: send-a-command, animals, friendship, fishing,
multi-project dashboard.

---

## 10. Open design levers

**Locked:** crop = file in play · gold = day-end harvest only (tokens → effort/quality, never gold) · stamina drains as context fills · season = real calendar · crop = in-season set by extension hash · harvest = overnight auto-ship with mid-day visual carry.

**Still tuning (not blockers):**
- **Quality source.** Test-pass star only, or also tokens/effort attributed to the file.
- **Growth stages N** (e.g. 4) and **base crop prices** — balance numbers.
- **Animal balance.** Species set + per-species price, produce value, affection curve, baby→adult days, barn cap per farm size.
- **Off-season files.** With in-season assignment this can't happen by construction; revisit only if we ever allow fixed-per-extension crops.

---

## 11. Feature backlog

IDs are stable handles for tracking. `[ ]` = todo.

### v1 — MVP (vertical slice, replay → live)
- [x] HC-1  Rust commands: `list_projects`, `list_sessions`, `read_session` (+ `watch_project`) — Tauri 2, path-guards
- [x] HC-2  Port `parser.js` → typed `parser.ts` (+ derived file/mcpServer/testPass); proven via `npm run test:parser`
- [x] HC-3  Event-timeline types (`VizEvent`, `EventKind`, `ToolCategory`, `SessionResult`)
- [x] HC-4  Port `virtual-pet` editor + `gen-assets` codegen (ESP32/.h dropped); `assets/*.json` → `src/generated/*.ts`
- [~] HC-4b Canvas boot done (placeholder rects); index→canvas sprite blit pending real sprites
- [ ] HC-5  Farmer avatar + per-tool labor animations (§4)
- [x] HC-6  Field: plot keyed by file_path; Write=plant, Edit=grow (`src/state.ts` + render)
- [ ] HC-7  Farmhands: spawn on `agent`, return ✓/✗ on `agentDone`
- [x] HC-8  HUD: day/season, gold, stamina (context), counters (placeholder render)
- [x] HC-9  `harvest-save.json`: schema + atomic load/save (Rust `read_save`/`write_save`, app-data dir)
- [x] HC-10 Calendar-rollover (`lastSessionDate`) → overnight harvest + morning report
- [x] HC-11 Economy: growth stages, ripen, quality (test-pass), overnight auto-ship → gold (`src/state.ts`, 15 tests)
- [x] HC-12 Seasons: real-calendar season → crop tables → in-season crop-by-extension hash (`src/config.ts`)
- [ ] HC-13 Compaction → nap (stamina refill only)
- [ ] HC-14 Replay mode: scrub / play-pause / speed
- [~] HC-15 LIVE mode: `notify` watcher → `emit` → frontend `listen` wired (`watch_project`/`onSessionChanged`); not yet verified end-to-end in `tauri dev`
- [ ] HC-16 Plugin: `/harvest` command launches installed binary (idempotent)

### v2 — Cozy polish
- [ ] HC-20 Real Harvest Moon sprite set (farmer, farmhands per agent type, crops)
- [ ] HC-21 Registry: `subagent_type` → farmhand sprite/color/name; tool → action icon
- [ ] HC-22 WebAudio chiptune SFX + ambient farm loop (mute by default)
- [ ] HC-23 Weather: rain on test-pass, clouds on errors
- [ ] HC-24 Weeds/crows on tool errors; cleared on later success
- [ ] HC-25 Elder "recipe" cutscene + food-name generator; learn-once / cook-on-repeat
- [ ] HC-26 Shipping-bin: mid-day ripe-crop carry animation + morning-report screen
- [ ] HC-27 Seasonal backdrop + palette swap per real season
- [ ] HC-28 Quest signpost: auto-detected PBI/task + session title
- [ ] HC-29 Quality star: test-pass attribution per file

### v3 — Depth
- [ ] HC-30 Barn + animals: parse MCP server (`name.split("__")[1]`), animal per server, species by acquisition order, barn render
- [ ] HC-30a Auto-buy at morning report (gold-gated); produce per `mcp__*` call → bin
- [ ] HC-30b Affection (fed = used that day), grow baby→adult, quality multiplier
- [ ] HC-31 Cooking minigame: combine learned recipes for bonus gold
- [ ] HC-32 Field scroll / pagination for large file sets
- [ ] HC-33 Multi-project view (which farms are active right now)
- [ ] HC-34 System tray + "watch active session" auto-attach
- [ ] HC-35 Stats screen: tokens/agents/skills over the session (movie-credits roster)

### Stretch
- [ ] HC-40 Send-a-command (spawn `claude -p` from the app; loopback-safe)
- [ ] HC-41 Friendship/villagers = frequently-used tools or MCP servers
- [ ] HC-42 Save/replay export (share a session as a "farm reel")
- [ ] HC-43 Themable tilesets / palettes (extra seasonal/holiday variants)
- [ ] HC-44 Cross-platform signed installers + auto-update
- [ ] HC-45 Ship the pixel editor in-app (user reskins; Tauri fs save)

---

## 12. Reuse map

**From `agent-quest`** (the data/visualizer half):

| agent-quest | Harvest Code | Change |
|---|---|---|
| `lib/parser.js` | `src/parser.ts` | Port + types; same event model |
| `server.js` (HTTP+SSE) | `src-tauri/src/main.rs` | Rewrite as Tauri commands + `notify` watcher |
| `public/net.js` | `src/ipc.ts` | `invoke()` + `listen()` instead of fetch/SSE |
| `public/game.js` | `src/game.ts` | Reskin scene Zelda→farm; same engine |
| `public/registry.js` | `src/registry.ts` | agent→farmhand, tool→farm-action, MCP→animal map |
| `public/audio.js` | `src/audio.ts` | Reuse synth, new SFX |
| `public/font.js` | `src/font.ts` | Reuse as-is |
| `scripts/visualize.mjs` | — | Dropped; the app is the launcher |

**From `virtual-pet`** (the art/sprite half — replaces hand-drawn sprites):

| virtual-pet | Harvest Code | Change |
|---|---|---|
| `src/editor/` (EditorApp, project) | `src/editor/` | Port as-is; **dev-only** |
| `editor.html` + multi-page Vite | `editor.html` + Vite config | Port; keep `/api/assets` dev middleware |
| `vite-assets-plugin.ts` | same | Port as-is (dev save to `assets/`) |
| `scripts/gen-assets.ts` | `scripts/gen-assets.ts` | Keep `toTypeScript`; **drop** `toHeader`/`.h` |
| `src/platform/Canvas*` + `colors` | `src/platform/` | Reuse for index→canvas blit |
| `assets/*.json` | `assets/*.json` | Our farm sprites (source of truth, git) |
| `src/generated/*.ts` | `src/generated/*.ts` | Build artifact the game imports |
| `firmware/`, `toHeader`, ESP32 bits | — | Dropped (desktop, not ESP32) |
