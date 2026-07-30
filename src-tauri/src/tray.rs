// System tray icon and menu: restore (double-click / Open) and Quit. Also the
// path the single-instance plugin routes a second launch through (see main.rs).

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
