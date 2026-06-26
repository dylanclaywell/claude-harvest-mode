// ipc.ts — thin transport to the Rust backend. Replaces agent-quest's net.js
// (fetch + SSE) with Tauri commands + events. Falls back gracefully when run in
// a plain browser (vite dev without Tauri) so the frontend still boots.

import type { SessionResult } from "./parser";

export interface ProjectInfo { id: string; name: string; sessions: number; lastModified: number; }
export interface SessionInfo { id: string; title: string; mtime: number; agents: number; skills: number; }

interface TauriCore {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
}
interface TauriEvent {
  listen<T>(event: string, cb: (e: { payload: T }) => void): Promise<() => void>;
}

export function inTauri(): boolean {
  return typeof (globalThis as any).__TAURI_INTERNALS__ !== "undefined";
}

async function core(): Promise<TauriCore> {
  return await import("@tauri-apps/api/core");
}
async function events(): Promise<TauriEvent> {
  return await import("@tauri-apps/api/event");
}

export async function listProjects(): Promise<ProjectInfo[]> {
  if (!inTauri()) return [];
  const { invoke } = await core();
  return invoke<ProjectInfo[]>("list_projects");
}

export async function listSessions(projectId: string): Promise<SessionInfo[]> {
  if (!inTauri()) return [];
  const { invoke } = await core();
  return invoke<SessionInfo[]>("list_sessions", { projectId });
}

/** Read a session's raw JSONL text. Parsing happens in the frontend (parser.ts). */
export async function readSession(projectId: string, sessionId: string): Promise<string> {
  if (!inTauri()) return "";
  const { invoke } = await core();
  return invoke<string>("read_session", { projectId, sessionId });
}

/** Subscribe to live "session-changed" events emitted by the Rust notify watcher. */
export async function onSessionChanged(cb: (path: string) => void): Promise<() => void> {
  if (!inTauri()) return () => {};
  const { listen } = await events();
  return listen<string>("session-changed", (e) => cb(e.payload));
}

export async function watchProject(projectId: string): Promise<void> {
  if (!inTauri()) return;
  const { invoke } = await core();
  await invoke("watch_project", { projectId });
}

/** Read the game save file (empty string if none yet). */
export async function readSave(): Promise<string> {
  if (!inTauri()) return "";
  const { invoke } = await core();
  return invoke<string>("read_save");
}

export async function writeSave(contents: string): Promise<void> {
  if (!inTauri()) return;
  const { invoke } = await core();
  await invoke("write_save", { contents });
}

export type { SessionResult };
