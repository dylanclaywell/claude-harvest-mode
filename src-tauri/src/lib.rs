// Harvest Code — Tauri backend. Read-only over ~/.claude/projects: list
// projects/sessions, read a session's JSONL, and tail the active session via a
// `notify` file watcher (emits "session-changed"). Parsing/game logic live in
// the TS frontend (src/parser.ts).

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use serde_json::Value;
use tauri::{Emitter, Manager};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Project {
    id: String,
    name: String,
    sessions: usize,
    last_modified: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionInfo {
    id: String,
    title: String,
    mtime: f64,
    agents: usize,
    skills: usize,
}

struct WatchState(Mutex<Option<RecommendedWatcher>>);

fn projects_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("projects"))
}

fn mtime_ms(p: &Path) -> f64 {
    std::fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

/// Trailing repo-ish segment of an encoded project dir name.
fn friendly_name(dir: &str) -> String {
    if let Some(idx) = dir.find("repos-") {
        return dir[idx + 6..].to_string();
    }
    dir.rsplit('-').find(|s| !s.is_empty()).unwrap_or(dir).to_string()
}

/// Reject ids that could escape the projects dir.
fn safe_segment(s: &str) -> bool {
    !s.is_empty() && !s.contains('/') && !s.contains('\\') && !s.contains("..")
}

#[tauri::command]
fn list_projects() -> Vec<Project> {
    let root = match projects_dir() {
        Some(r) => r,
        None => return vec![],
    };
    let mut out = vec![];
    let entries = match std::fs::read_dir(&root) {
        Ok(e) => e,
        Err(_) => return vec![],
    };
    for entry in entries.flatten() {
        if !entry.path().is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().to_string();
        let mut sessions = 0usize;
        let mut last = 0.0f64;
        if let Ok(files) = std::fs::read_dir(entry.path()) {
            for f in files.flatten() {
                let p = f.path();
                if p.extension().map_or(false, |e| e == "jsonl") {
                    sessions += 1;
                    let m = mtime_ms(&p);
                    if m > last {
                        last = m;
                    }
                }
            }
        }
        if sessions == 0 {
            continue;
        }
        out.push(Project {
            name: friendly_name(&id),
            id,
            sessions,
            last_modified: last,
        });
    }
    out.sort_by(|a, b| b.last_modified.partial_cmp(&a.last_modified).unwrap());
    out
}

fn quick_title(text: &str) -> String {
    for line in text.lines() {
        if line.contains("\"type\":\"ai-title\"") || line.contains("\"ai-title\"") {
            if let Ok(v) = serde_json::from_str::<Value>(line) {
                if let Some(t) = v.get("aiTitle").and_then(|x| x.as_str()) {
                    return t.to_string();
                }
            }
        }
    }
    for line in text.lines() {
        if !line.contains("\"type\":\"user\"") {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<Value>(line) {
            if let Some(c) = v.get("message").and_then(|m| m.get("content")).and_then(|x| x.as_str()) {
                let t = c.trim();
                if !t.is_empty() && !t.starts_with('<') && !t.starts_with("Caveat") {
                    let s: String = t.split_whitespace().collect::<Vec<_>>().join(" ");
                    return s.chars().take(80).collect();
                }
            }
        }
    }
    "(untitled)".to_string()
}

#[tauri::command]
fn list_sessions(project_id: String) -> Result<Vec<SessionInfo>, String> {
    if !safe_segment(&project_id) {
        return Err("invalid project id".into());
    }
    let dir = projects_dir().ok_or("no home dir")?.join(&project_id);
    let mut out = vec![];
    let files = std::fs::read_dir(&dir).map_err(|e| e.to_string())?;
    for f in files.flatten() {
        let p = f.path();
        if p.extension().map_or(false, |e| e == "jsonl") {
            let text = std::fs::read_to_string(&p).unwrap_or_default();
            let id = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            out.push(SessionInfo {
                title: quick_title(&text),
                mtime: mtime_ms(&p),
                agents: text.matches("\"subagent_type\"").count(),
                skills: text.matches("\"name\":\"Skill\"").count(),
                id,
            });
        }
    }
    out.sort_by(|a, b| b.mtime.partial_cmp(&a.mtime).unwrap());
    Ok(out)
}

#[tauri::command]
fn read_session(project_id: String, session_id: String) -> Result<String, String> {
    if !safe_segment(&project_id) || !safe_segment(&session_id) {
        return Err("invalid id".into());
    }
    let path = projects_dir()
        .ok_or("no home dir")?
        .join(&project_id)
        .join(format!("{session_id}.jsonl"));
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

// --- game save (game-owned state, separate from the read-only Claude logs) ----

fn save_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("harvest-save.json"))
}

#[tauri::command]
fn read_save(app: tauri::AppHandle) -> Result<String, String> {
    let path = save_path(&app)?;
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn write_save(app: tauri::AppHandle, contents: String) -> Result<(), String> {
    let path = save_path(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // Atomic: write a temp file, then rename over the target.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, contents.as_bytes()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn watch_project(
    project_id: String,
    app: tauri::AppHandle,
    state: tauri::State<WatchState>,
) -> Result<(), String> {
    if !safe_segment(&project_id) {
        return Err("invalid project id".into());
    }
    let dir = projects_dir().ok_or("no home dir")?.join(&project_id);
    let app2 = app.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            if matches!(ev.kind, EventKind::Modify(_) | EventKind::Create(_)) {
                for p in ev.paths {
                    if p.extension().map_or(false, |e| e == "jsonl") {
                        let _ = app2.emit("session-changed", p.to_string_lossy().to_string());
                    }
                }
            }
        }
    })
    .map_err(|e| e.to_string())?;
    watcher
        .watch(&dir, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;
    // Keep the watcher alive by stashing it in app state (replaces any prior one).
    *state.0.lock().unwrap() = Some(watcher);
    Ok(())
}

/// Watch the whole projects root recursively so every session in every project
/// tails at once (the aggregate farm). Emits the same "session-changed" path
/// events; the frontend routes each path to its project/session.
#[tauri::command]
fn watch_all(app: tauri::AppHandle, state: tauri::State<WatchState>) -> Result<(), String> {
    let dir = projects_dir().ok_or("no home dir")?;
    let app2 = app.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            if matches!(ev.kind, EventKind::Modify(_) | EventKind::Create(_)) {
                for p in ev.paths {
                    if p.extension().map_or(false, |e| e == "jsonl") {
                        let _ = app2.emit("session-changed", p.to_string_lossy().to_string());
                    }
                }
            }
        }
    })
    .map_err(|e| e.to_string())?;
    watcher
        .watch(&dir, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
    *state.0.lock().unwrap() = Some(watcher);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(WatchState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            list_projects,
            list_sessions,
            read_session,
            watch_project,
            watch_all,
            read_save,
            write_save
        ])
        .setup(|_app| Ok(()))
        .run(tauri::generate_context!())
        .expect("error while running Harvest Code");
}
