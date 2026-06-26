# Claude: Harvest Code

A **Tauri desktop** app that renders a live Claude Code session as an 8-bit
Harvest Moon farm. It reads `~/.claude/projects/*/*.jsonl` (the logs Claude Code
already writes) — **read-only**, no hooks, nothing injected into Claude — and
animates them: files become crops, subagents become farmhands, MCP servers
become barn animals, skills become recipes.

Design doc: [`GAME_DESIGN.md`](./GAME_DESIGN.md). Forked in spirit from
`agent-quest` (the data/visualizer half) and `virtual-pet` (the sprite editor).

## Architecture

```
~/.claude/projects/<proj>/<session>.jsonl
        │  read-only (Rust: std::fs + notify watcher)
        ▼
  src-tauri/src/lib.rs   commands: list_projects · list_sessions · read_session · watch_project
        │  invoke() / emit("session-changed")
        ▼
  src/parser.ts          JSONL → typed event timeline (+ derived: file, mcpServer, testPass)
        │
        ▼
  src/main.ts            canvas farm (placeholder render for now)
```

Sprites are authored in a **dev-only pixel editor** (`editor.html`, ported from
`virtual-pet`): draw → `assets/*.json` → `npm run gen` → `src/generated/*.ts`,
which the game imports. Indexed-palette model: palette **variants** recolor every
frame for free (seasons / quality / species).

## Dev

```sh
npm install
npm run test:parser     # parse your newest real session, print a farm summary
npm run dev             # vite frontend in the browser (no backend data)
npm run tauri dev       # the full desktop app (live data + watcher)
npm run gen             # regenerate sprite TS from assets/*.json
```

Open the sprite editor in dev at `http://localhost:1420/editor.html`.

## Status

Early build (vertical slice). Working: Rust read/list/watch commands, typed
parser (proven on real logs), placeholder canvas farm, ported pixel editor +
codegen. Next: real sprites, the harvest economy + save file, seasons, LIVE
polish. See `GAME_DESIGN.md` §11 backlog (HC-*).
