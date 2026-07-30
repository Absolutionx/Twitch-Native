// Persists per-VOD playback position so the app can resume where the user left
// off. Single JSON file in app_local_data_dir (whole-file load/save), same
// pattern as notify_prefs.rs.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::{AppHandle, Manager};

const PROGRESS_FILE: &str = "vod_progress.json";

// Caps how many VODs' progress we remember at once. Someone who watches a
// lot of VOD content over months would otherwise grow this file forever;
// evicting the least-recently-updated entries once the cap is hit keeps
// it bounded without needing the user to ever think about it.
const MAX_ENTRIES: usize = 300;

#[derive(Serialize, Deserialize, Clone)]
pub struct ProgressEntry {
    pub position_secs: f64,
    pub total_secs: f64,
    /// Unix milliseconds - used only to decide which entries to evict
    /// once MAX_ENTRIES is exceeded (oldest-updated first), not shown to
    /// the user anywhere.
    pub updated_at: u64,
}

#[derive(Serialize, Deserialize, Default)]
struct PersistedProgress {
    /// Keyed by VOD id (Helix video id, as a string).
    #[serde(default)]
    vods: HashMap<String, ProgressEntry>,
}

fn progress_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_local_data_dir().ok().map(|d| d.join(PROGRESS_FILE))
}

fn load_progress(app: &AppHandle) -> PersistedProgress {
    let Some(path) = progress_path(app) else { return PersistedProgress::default() };
    let Ok(json) = std::fs::read_to_string(&path) else { return PersistedProgress::default() };
    serde_json::from_str::<PersistedProgress>(&json).unwrap_or_default()
}

fn save_progress(app: &AppHandle, progress: &PersistedProgress) -> Result<(), String> {
    let path = progress_path(app)
        .ok_or_else(|| "Could not resolve app data directory".to_string())?;
    let json = serde_json::to_string(progress).map_err(|e| e.to_string())?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, json).map_err(|e| e.to_string())
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Returns saved progress for a single VOD, if any - used when actually
/// opening a VOD to decide whether to resume. See get_all_vod_progress
/// for the bulk version used to show resume indicators across a list.
#[tauri::command]
pub fn get_vod_progress(app: AppHandle, video_id: String) -> Option<ProgressEntry> {
    load_progress(&app).vods.get(&video_id).cloned()
}

/// Returns every VOD with saved progress (id -> entry). Fetched once per
/// VOD-list render (see vods.js) so showing a resume indicator on N cards
/// costs one call, not N.
#[tauri::command]
pub fn get_all_vod_progress(app: AppHandle) -> HashMap<String, ProgressEntry> {
    load_progress(&app).vods
}

/// Upserts progress for one VOD. Called periodically while watching (see
/// main.js) and on stop/switch-away, not on every single position-poll
/// tick - a write every few seconds is plenty for "resume roughly where
/// you left off" and avoids hammering disk I/O on every frame.
#[tauri::command]
pub fn save_vod_progress(
    app: AppHandle,
    video_id: String,
    position_secs: f64,
    total_secs: f64,
) -> Result<(), String> {
    let mut progress = load_progress(&app);
    progress.vods.insert(
        video_id,
        ProgressEntry { position_secs, total_secs, updated_at: now_millis() },
    );

    if progress.vods.len() > MAX_ENTRIES {
        // Evict oldest-updated entries first, down to the cap - keeps
        // whatever's most likely to still matter (recently watched).
        let mut by_age: Vec<(String, u64)> = progress
            .vods
            .iter()
            .map(|(id, entry)| (id.clone(), entry.updated_at))
            .collect();
        by_age.sort_by_key(|(_, updated_at)| *updated_at);
        let overflow = progress.vods.len() - MAX_ENTRIES;
        for (id, _) in by_age.into_iter().take(overflow) {
            progress.vods.remove(&id);
        }
    }

    save_progress(&app, &progress)
}
