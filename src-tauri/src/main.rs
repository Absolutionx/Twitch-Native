#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
// Twitch native player - Rust backend.
//
// Playback (streamlink → local HTTP relay → MSE in the webview) lives in
// stream_relay.rs, including the history of why it's architected this
// way. This file wires up Tauri: app state, command registration, and
// the Helix (Twitch REST API) commands that don't yet warrant their own
// module (see README's project-structure note).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{Manager, State};

mod chat;
mod chat_commands;
mod deps_check;
mod eventsub;
mod helix;
mod kick;
mod kick_chat;
mod kick_oauth;
mod link_preview;
mod notify_prefs;
mod oauth;
mod stream_relay;
mod seventv_events;
mod tray;
mod vod_progress;

/// Holds state for the currently active chat session: the sender half of a
/// oneshot channel used to signal the running chat task to disconnect, the
/// sender half of an mpsc channel used to push outgoing PRIVMSGs into that
/// task, and the currently logged-in user's credentials (if any) so the UI
/// can query whether sending messages is even possible.
pub(crate) struct ChatState {
    pub(crate) stop_tx: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    pub(crate) outgoing_tx: Mutex<Option<tokio::sync::mpsc::UnboundedSender<chat::OutgoingMessage>>>,
    pub(crate) auth: Mutex<Option<chat::AuthCredentials>>,
}

impl Default for ChatState {
    fn default() -> Self {
        ChatState {
            stop_tx: Mutex::new(None),
            outgoing_tx: Mutex::new(None),
            auth: Mutex::new(None),
        }
    }
}

/// Manages the EventSub WebSocket connection lifecycle.
/// One connection per watched channel; torn down on Stop.
pub(crate) struct EventSubState {
    pub(crate) stop_tx: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
}

impl Default for EventSubState {
    fn default() -> Self {
        EventSubState { stop_tx: Mutex::new(None) }
    }
}

/// Manages the 7TV EventAPI WebSocket connection lifecycle (see
/// seventv_events.rs). One connection per watched channel's 7TV emote
/// set; torn down on Stop/channel switch, same pattern as EventSubState
/// above just for a completely separate, unrelated service.
pub(crate) struct SevenTvEventsState {
    pub(crate) stop_tx: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
}

impl Default for SevenTvEventsState {
    fn default() -> Self {
        SevenTvEventsState { stop_tx: Mutex::new(None) }
    }
}


/// True until the first time the frontend asks. Distinguishes a genuine
/// process launch from an in-process webview reload (F5): a reload hits
/// the SAME running host, so it sees the flag already cleared, while a
/// fresh launch is a new process with a fresh `true`. This is what lets
/// F5 resume the stream while a cold start (close-app-before-bed, open in
/// the morning) correctly lands on Home instead of a now-offline stream.
///
/// Deliberately backend-side rather than sessionStorage: it keys off real
/// process identity, so it can't be fooled by any webview storage-lifetime
/// quirk across platforms (WebView2 vs WebKit).
struct LaunchState {
    fresh: AtomicBool,
}

impl Default for LaunchState {
    fn default() -> Self {
        Self { fresh: AtomicBool::new(true) }
    }
}

/// Returns whether THIS call is the first since the process started, and
/// clears the flag so every later call (i.e. every reload) returns false.
#[tauri::command]
fn take_is_fresh_launch(state: State<LaunchState>) -> bool {
    state.fresh.swap(false, Ordering::SeqCst)
}

fn main() {
    // Must happen before any TLS connection (i.e. before the chat WebSocket
    // ever connects) - rustls 0.23+ panics on first use if no CryptoProvider
    // has been installed yet. This is a process-wide, one-time setup call,
    // unrelated to Tauri itself.
    let _ = rustls::crypto::ring::default_provider().install_default();

    tauri::Builder::default()
        // Must be the FIRST plugin registered (per the plugin's own docs)
        // so it runs before anything else gets a chance to spawn windows/
        // tray icons for what would otherwise be a second, fully separate
        // process. When a second launch is detected, this callback runs
        // INSIDE THE ALREADY-RUNNING instance (the new process's main()
        // never actually proceeds past this point - the plugin exits it
        // immediately) - so "restore_window" here brings the existing
        // window forward instead of a second one ever appearing. Same
        // restore_window() used by the tray menu's "Open Twitch Native"
        // and the tray icon double-click, for one consistent "bring the
        // running app to the front" behavior everywhere it can be
        // triggered from.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            tray::restore_window(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            tray::setup_tray(app).map_err(|e| e.to_string())?;
            Ok(())
        })
        .manage(LaunchState::default())
        .manage(ChatState::default())
        .manage(EventSubState::default())
        .manage(SevenTvEventsState::default())
        .manage(kick_chat::KickChatState::default())
        .manage(std::sync::Arc::new(stream_relay::StreamRelayState::default()))
        .invoke_handler(tauri::generate_handler![
            take_is_fresh_launch,
            stream_relay::start_stream,
            kick::get_kick_stream,
            kick::get_kick_channel_chat_info,
            kick::get_kick_live_dvr,
            kick::kick_followed_status,
            kick::kick_top_live_streams,
            kick::kick_live_streams_page,
            kick::kick_top_games,
            kick::kick_streams_for_category,
            kick::kick_streams_for_game_names,
            kick::kick_search_categories,
            kick::kick_category_viewer_counts,
            kick::kick_channel_emotes,
            kick::kick_channel_videos,
            kick::kick_vod_playback,
            kick_oauth::kick_oauth_configured,
            kick_oauth::start_kick_oauth_login,
            kick_oauth::restore_kick_session,
            kick_oauth::kick_logout,
            kick_oauth::kick_send_chat_message,
            kick_chat::start_kick_chat,
            kick_chat::stop_kick_chat,
            stream_relay::get_vod_m3u8_url,
            stream_relay::stop_stream,
            stream_relay::get_available_qualities,
            stream_relay::get_available_vod_qualities,
            chat_commands::start_chat,
            chat_commands::stop_chat,
            oauth::start_oauth_login,
            notify_prefs::get_notify_channels,
            notify_prefs::set_notify_channels,
            vod_progress::get_all_vod_progress,
            vod_progress::get_vod_progress,
            vod_progress::save_vod_progress,
            oauth::validate_oauth_token,
            oauth::restore_session,
            oauth::logout,
            chat_commands::fetch_global_badges,
            chat_commands::fetch_global_emotes,
            chat_commands::fetch_channel_badges,
            chat_commands::fetch_cheermotes,
            link_preview::fetch_link_preview,
            link_preview::fetch_storyboard_json,
            deps_check::check_stream_deps,
            deps_check::install_stream_deps,
            chat_commands::ban_user,
            chat_commands::unban_user,
            chat_commands::delete_chat_message,
            chat_commands::automod_process_message,
            chat_commands::get_user_id_for_login,
            chat_commands::start_eventsub,
            chat_commands::stop_eventsub,
            chat_commands::start_seventv_events,
            chat_commands::stop_seventv_events,
            chat_commands::send_chat_message,
            chat_commands::set_oauth_credentials,
            helix::get_followed_channels,
            chat_commands::get_chatters,
            helix::get_streams_for_users,
            helix::get_stream_for_login,
            helix::get_user_by_login,
            helix::get_users_info,
            helix::get_top_live_streams,
            helix::get_live_streams_page,
            helix::get_streams_for_game_names,
            helix::get_top_games,
            helix::get_streams_for_game_id,
            helix::search_categories,
            helix::get_category_viewer_counts,
            helix::get_videos_for_login,
            helix::get_vod_muted_segments,
            helix::get_live_vod_info,
            helix::get_vod_chat
        ])
        .on_window_event(|window, event| {
            if window.label() != "main" { return; }
            match event {
                tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed => {
                    // The PiP window is an independent OS window with its
                    // own copy of the stream, fed by the in-process relay -
                    // so without this, closing the main window leaves the
                    // whole app running headless with the PiP as its only
                    // window (Tauri exits when ALL windows are gone, and
                    // the PiP counts). Closing it here covers every route
                    // the main window can die, including ones the main
                    // webview's JS never sees. Handling both events is
                    // belt-and-braces: CloseRequested for the user's X,
                    // Destroyed for programmatic teardown - the second
                    // close of an already-closing window is a no-op.
                    if let Some(pip) = window.app_handle().get_webview_window("pip") {
                        let _ = pip.close();
                    }
                    // (The old streamlink/mpv child-process cleanup that
                    // used to live here is no longer needed - playback runs
                    // inside the webview and tears down with the window.)
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
