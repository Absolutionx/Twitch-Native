// System tray icon and menu.
//
// The tray is the app's "bring me back / quit me" affordance: restore on
// double-click or the Open menu item, and Quit. It's also what the
// single-instance plugin routes a second launch through (see main.rs) -
// one consistent "bring the running app to the front" path.
//
// HISTORY: this module used to also own a background go-live polling loop
// (run_live_polling + TrayPollingState), spawned by a hide_to_tray command
// when the user picked "Minimize to Tray" in a close dialog. That whole
// feature is gone: the close dialog no longer exists (closing the window
// closes the app), and go-live notifications are handled by the frontend
// now - sidebar.js diffs live state on its refresh tick and fires
// sendNotification itself, which works the entire time the app is open.

use tauri::{AppHandle, Manager};

// ── Tray icon setup ───────────────────────────────────────────────────────

/// Builds and registers the system tray icon with its context menu.
/// Called once from main()'s `.setup()` closure.
pub fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::TrayIconBuilder;

    let open = MenuItem::with_id(app, "open", "Open Twitch Native", true, None::<&str>)?;
    let sep  = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &sep, &quit])?;

    TrayIconBuilder::with_id("main")
        .tooltip("Twitch Native")
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => restore_window(app),
            "quit" => do_quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // Left double-click restores the window (single click opens menu).
            if let tauri::tray::TrayIconEvent::DoubleClick { .. } = event {
                restore_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

// ── Helpers ───────────────────────────────────────────────────────────────

/// Shows and focuses the main window. Used by the tray menu, the tray
/// double-click, and the single-instance second-launch callback.
pub fn restore_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Exits the process. Previously also killed a running streamlink/mpv
/// child process so it wouldn't become an orphan - no longer needed now
/// that playback runs entirely inside the webview via hls.js.
pub fn do_quit(app: &AppHandle) {
    app.exit(0);
}
