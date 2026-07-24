// Persists the go-live notification channel opt-ins.
//
// Stored in notify_channels.json using the same app_local_data_dir path
// that oauth_token.json uses — confirmed to survive full app quit on this
// machine.
//
// This file previously also stored close_pref ("tray"/"quit") for the
// old close-behavior dialog; that feature is gone (closing the window
// just closes the app now), and serde ignores unknown fields by default,
// so old on-disk files that still contain a close_pref key load fine.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const PREFS_FILE: &str = "notify_channels.json";

#[derive(Serialize, Deserialize, Default)]
struct PersistedPrefs {
    /// Lowercase channel logins the user wants go-live notifications for.
    channels: Vec<String>,
}

fn prefs_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_local_data_dir().ok().map(|d| d.join(PREFS_FILE))
}

fn load_prefs(app: &AppHandle) -> PersistedPrefs {
    let Some(path) = prefs_path(app) else { return PersistedPrefs::default() };
    let Ok(json) = std::fs::read_to_string(&path) else { return PersistedPrefs::default() };
    serde_json::from_str::<PersistedPrefs>(&json).unwrap_or_default()
}

fn save_prefs(app: &AppHandle, prefs: &PersistedPrefs) -> Result<(), String> {
    let path = prefs_path(app)
        .ok_or_else(|| "Could not resolve app data directory".to_string())?;
    let json = serde_json::to_string(prefs).map_err(|e| e.to_string())?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, json).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Notification channels
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_notify_channels(app: AppHandle) -> Vec<String> {
    load_prefs(&app).channels
}

#[tauri::command]
pub fn set_notify_channels(app: AppHandle, channels: Vec<String>) -> Result<(), String> {
    let mut prefs = load_prefs(&app);
    prefs.channels = channels;
    save_prefs(&app, &prefs)
}
