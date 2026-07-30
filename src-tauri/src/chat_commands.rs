// Tauri command surface for chat: lifecycle (connect/disconnect/send),
// moderation, cosmetics (badges/emotes/cheermotes), and the realtime side-
// channels (EventSub redeems, 7TV emote events). The IRC client is in chat.rs;
// this is only the command layer.

use tauri::State;

use crate::helix::{helix_get, require_auth, urlencoding_encode};
use crate::{chat, eventsub, oauth, seventv_events};
use crate::{ChatState, EventSubState, SevenTvEventsState};

/// Starts the Twitch IRC chat client for the given channel, running it as a
/// background Tokio task. Runs in Rust (not JS) specifically to avoid
/// WebView2's Tracking Prevention feature, which blocks/kills WebSocket
/// connections to irc-ws.chat.twitch.tv when run from the webview - see the
/// module-level comment in chat.rs for details.
///
/// If the user has logged in (set_oauth_credentials was called previously
/// and succeeded), connects authenticated and able to send messages;
/// otherwise connects anonymously/read-only as before.
#[tauri::command]
pub fn start_chat(app: tauri::AppHandle, state: State<ChatState>, channel: String) -> Result<(), String> {
    // If a chat session is already running, signal it to stop first so we
    // don't end up with two concurrent connections.
    {
        let mut guard = state.stop_tx.lock().map_err(|e| e.to_string())?;
        if let Some(old_tx) = guard.take() {
            let _ = old_tx.send(());
        }
    }

    let (stop_tx, stop_rx) = tokio::sync::oneshot::channel();
    let (outgoing_tx, outgoing_rx) = tokio::sync::mpsc::unbounded_channel();

    {
        let mut guard = state.stop_tx.lock().map_err(|e| e.to_string())?;
        *guard = Some(stop_tx);
    }
    {
        let mut guard = state.outgoing_tx.lock().map_err(|e| e.to_string())?;
        *guard = Some(outgoing_tx);
    }

    let auth = {
        let guard = state.auth.lock().map_err(|e| e.to_string())?;
        guard.clone()
    };

    tauri::async_runtime::spawn(async move {
        chat::run_chat_client(app, channel, auth, outgoing_rx, stop_rx).await;
    });

    Ok(())
}

#[tauri::command]
pub fn stop_chat(state: State<ChatState>) -> Result<(), String> {
    let mut guard = state.stop_tx.lock().map_err(|e| e.to_string())?;
    if let Some(tx) = guard.take() {
        let _ = tx.send(());
    }
    Ok(())
}

/// Sends a chat message into the currently active connection. Errors if
/// no chat session is running, or if the session is anonymous (no login -
/// Twitch IRC rejects PRIVMSG from justinfanXXXXX connections, so we check
/// for that case ourselves rather than letting it fail silently server-side).
#[tauri::command]
pub fn send_chat_message(
    state: State<ChatState>,
    message: String,
    reply_to_msg_id: Option<String>,
) -> Result<(), String> {
    {
        let auth_guard = state.auth.lock().map_err(|e| e.to_string())?;
        if auth_guard.is_none() {
            return Err("Not logged in - log in with Twitch to send messages.".to_string());
        }
    }

    let guard = state.outgoing_tx.lock().map_err(|e| e.to_string())?;
    let sender = guard
        .as_ref()
        .ok_or_else(|| "No active chat connection - is a stream playing?".to_string())?;

    let outgoing = match reply_to_msg_id {
        Some(id) if !id.is_empty() => {
            chat::OutgoingMessage::ReplyPrivmsg { reply_to_id: id, text: message }
        }
        _ => chat::OutgoingMessage::Privmsg(message),
    };

    sender
        .send(outgoing)
        .map_err(|e| format!("Chat connection closed: {e}"))
}

/// Stores validated OAuth credentials in state for use by the next
/// start_chat call. Does not affect an already-running anonymous session -
/// the user needs to Stop and Watch again (or we could auto-reconnect, but
/// keeping this simple for the PoC) for a login to take effect on an
/// already-playing stream's chat.
#[tauri::command]
pub fn set_oauth_credentials(
    state: State<ChatState>,
    access_token: String,
    login: String,
    user_id: String,
) -> Result<(), String> {
    let mut guard = state.auth.lock().map_err(|e| e.to_string())?;
    *guard = Some(chat::AuthCredentials { access_token, login, user_id });
    Ok(())
}

/// Fetches Twitch global chat emotes (Kappa, PogChamp, LUL, etc.).
/// Returns raw Helix JSON for chat.js to parse and store by name+id.
#[tauri::command]
pub async fn fetch_global_emotes(state: State<'_, ChatState>) -> Result<String, String> {
    let token = state
        .auth
        .lock()
        .map_err(|e| e.to_string())?
        .as_ref()
        .map(|a| a.access_token.clone());
    helix_get("https://api.twitch.tv/helix/chat/emotes/global", token).await
}

// ---------------------------------------------------------------------------
// Cheermotes (animated bits emotes)
//
// Like badges, the Helix endpoint isn't reachable from WebView2, so this
// proxies through Rust. Returns the raw JSON for the frontend to parse.
// broadcaster_id is required by Helix to include any channel-specific
// cheermote overrides on top of the global set.
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn fetch_cheermotes(
    broadcaster_id: String,
    state: State<'_, ChatState>,
) -> Result<String, String> {
    let token = state
        .auth.lock().map_err(|e| e.to_string())?
        .as_ref().map(|a| a.access_token.clone());
    let url = format!(
        "https://api.twitch.tv/helix/bits/cheermotes?broadcaster_id={broadcaster_id}"
    );
    helix_get(&url, token).await
}

// ---------------------------------------------------------------------------
// Moderation – timeout/ban/unban/delete-message
//
// All four require the logged-in user to be a moderator or the broadcaster
// of the target channel (scopes: moderator:manage:banned_users for ban/
// timeout/unban, moderator:manage:chat_messages for delete) - Twitch 403s
// these for a regular viewer session, which the frontend surfaces as a
// normal error rather than something these commands need to detect
// themselves. "Is this user even a mod here" for UI purposes (showing vs.
// graying out the mod action buttons) is derived client-side from the
// USERSTATE badges tag chat.rs already emits on join - no extra Helix call
// needed just to answer that question.
// ---------------------------------------------------------------------------

/// Times out or permanently bans a user in `broadcaster_id`'s channel.
/// `duration_seconds` of None (or omitted) means a permanent ban; Twitch's
/// own /helix/moderation/bans makes this same distinction via the presence
/// of the `duration` field, so this just passes that choice straight
/// through rather than having separate timeout_user/ban_user commands for
/// what's actually one endpoint with one optional field.
#[tauri::command]
pub async fn ban_user(
    state: State<'_, ChatState>,
    broadcaster_id: String,
    target_user_id: String,
    duration_seconds: Option<u32>,
    reason: Option<String>,
) -> Result<(), String> {
    let (token, moderator_id) = require_auth(&state)?;
    let client = reqwest::Client::new();

    let mut data = serde_json::json!({ "user_id": target_user_id });
    if let Some(secs) = duration_seconds {
        data["duration"] = serde_json::json!(secs);
    }
    if let Some(r) = reason.filter(|r| !r.is_empty()) {
        data["reason"] = serde_json::json!(r);
    }

    let resp = client
        .post("https://api.twitch.tv/helix/moderation/bans")
        .header("Client-ID", oauth::CLIENT_ID)
        .header("Authorization", format!("Bearer {token}"))
        .json(&serde_json::json!({
            "broadcaster_id": broadcaster_id,
            "moderator_id": moderator_id,
            "data": data,
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("{status}: {body}"));
    }
    Ok(())
}

/// Lifts an existing timeout or ban early.
#[tauri::command]
pub async fn unban_user(
    state: State<'_, ChatState>,
    broadcaster_id: String,
    target_user_id: String,
) -> Result<(), String> {
    let (token, moderator_id) = require_auth(&state)?;
    let client = reqwest::Client::new();

    let resp = client
        .delete("https://api.twitch.tv/helix/moderation/bans")
        .header("Client-ID", oauth::CLIENT_ID)
        .header("Authorization", format!("Bearer {token}"))
        .query(&[
            ("broadcaster_id", broadcaster_id.as_str()),
            ("moderator_id", moderator_id.as_str()),
            ("user_id", target_user_id.as_str()),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("{status}: {body}"));
    }
    Ok(())
}

/// Deletes a single chat message by its IRC message id (the `id` tag
/// chat.rs already captures and sends to the frontend per-message as
/// msg_id - see ChatMessageEvent). Helix calls this `message_id`.
///
/// `message_id` is optional: per Helix's own docs, omitting the
/// message_id query parameter entirely (not sending it empty - actually
/// absent) clears the ENTIRE chat room instead of one message - this is
/// what backs the /clear slash command, sharing this same endpoint/
/// command rather than needing a separate one.
#[tauri::command]
pub async fn delete_chat_message(
    state: State<'_, ChatState>,
    broadcaster_id: String,
    message_id: Option<String>,
) -> Result<(), String> {
    let (token, moderator_id) = require_auth(&state)?;
    let client = reqwest::Client::new();

    let mut query = vec![
        ("broadcaster_id", broadcaster_id.clone()),
        ("moderator_id", moderator_id.clone()),
    ];
    if let Some(id) = message_id.filter(|s| !s.is_empty()) {
        query.push(("message_id", id));
    }

    let resp = client
        .delete("https://api.twitch.tv/helix/moderation/chat")
        .header("Client-ID", oauth::CLIENT_ID)
        .header("Authorization", format!("Bearer {token}"))
        .query(&query)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("{status}: {body}"));
    }
    Ok(())
}

/// Approves or denies a message AutoMod is currently holding, identified
/// by the msg_id Twitch included in the automod.message.hold EventSub
/// event (see eventsub.rs's dispatch_notification). `action` is "ALLOW"
/// or "DENY" - passed straight through rather than as a bool so the Helix
/// request body (which wants exactly those two strings) and chat.js's
/// Allow/Deny buttons can both just use Twitch's own vocabulary instead of
/// translating a boolean back and forth.
#[tauri::command]
pub async fn automod_process_message(
    state: State<'_, ChatState>,
    msg_id: String,
    action: String,
) -> Result<(), String> {
    let (token, moderator_id) = require_auth(&state)?;
    let client = reqwest::Client::new();

    let resp = client
        .post("https://api.twitch.tv/helix/moderation/automod/message")
        .header("Client-ID", oauth::CLIENT_ID)
        .header("Authorization", format!("Bearer {token}"))
        .json(&serde_json::json!({
            "user_id": moderator_id,
            "msg_id": msg_id,
            "action": action,
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("{status}: {body}"));
    }
    Ok(())
}

/// Resolves a Twitch login (username) to its numeric Helix user id.
/// ban_user/unban_user both need the target's id, not their login - the
/// slash commands (/ban, /timeout, /unban) only ever have a typed
/// username to work with, so this is the lookup step chat.js's slash-
/// command handler runs before calling either of those. Mirrors the same
/// login->id lookup get_videos_for_login already does inline for VODs,
/// pulled out standalone here since slash commands have no other reason
/// to go through that function.
#[tauri::command]
pub async fn get_user_id_for_login(
    state: State<'_, ChatState>,
    login: String,
) -> Result<String, String> {
    let (token, _) = require_auth(&state)?;
    let url = format!(
        "https://api.twitch.tv/helix/users?login={}",
        urlencoding_encode(&login)
    );
    let body = helix_get(&url, Some(token)).await?;
    let parsed: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("Bad JSON from Helix: {e}"))?;
    parsed
        .get("data")
        .and_then(|d| d.as_array())
        .and_then(|arr| arr.first())
        .and_then(|u| u.get("id"))
        .and_then(|id| id.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("No user found for login: {login}"))
}

// ---------------------------------------------------------------------------
// EventSub – channel point redemption events
//
// Requires the logged-in user to be the broadcaster or a moderator of the
// watched channel (scope: channel:read:redemptions). Silently no-ops if the
// subscription returns 403 (regular viewer session).
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn start_eventsub(
    broadcaster_id: String,
    chat_state: State<'_, ChatState>,
    eventsub_state: State<'_, EventSubState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    // Require an authenticated session - EventSub won't work anonymously.
    // Also need the logged-in user's own id now, not just their token -
    // the automod.message.hold subscription's condition requires
    // moderator_user_id (Twitch only delivers AutoMod holds to a specific
    // moderator's session, not broadcast to "anyone watching"), distinct
    // from broadcaster_id which the channel-points subscription already
    // used and which stays the channel being watched either way.
    let (access_token, moderator_id) = {
        let guard = chat_state.auth.lock().map_err(|e| e.to_string())?;
        match guard.as_ref() {
            Some(creds) => (creds.access_token.clone(), creds.user_id.clone()),
            None => return Ok(()), // anonymous - skip silently
        }
    };

    // Tear down any previous EventSub connection for this session.
    {
        let mut guard = eventsub_state.stop_tx.lock().map_err(|e| e.to_string())?;
        if let Some(tx) = guard.take() {
            let _ = tx.send(());
        }
    }

    let (stop_tx, stop_rx) = tokio::sync::oneshot::channel();
    {
        let mut guard = eventsub_state.stop_tx.lock().map_err(|e| e.to_string())?;
        *guard = Some(stop_tx);
    }

    tauri::async_runtime::spawn(eventsub::run(
        app, broadcaster_id, moderator_id, access_token, stop_rx,
    ));

    Ok(())
}

#[tauri::command]
pub fn stop_eventsub(state: State<EventSubState>) -> Result<(), String> {
    let mut guard = state.stop_tx.lock().map_err(|e| e.to_string())?;
    if let Some(tx) = guard.take() {
        let _ = tx.send(());
    }
    Ok(())
}

/// Starts the 7TV EventAPI subscription for one emote set, so additions/
/// removals (e.g. a temporary channel-points-unlocked emote) show up
/// without needing to rejoin the channel. Called from chat.js right after
/// loadSevenTvChannelEmotes() resolves and has the emote set's id on hand
/// - unlike start_eventsub, this needs no auth token check at all, since
/// 7TV's EventAPI has no login requirement for this kind of subscription.
#[tauri::command]
pub async fn start_seventv_events(
    emote_set_id: String,
    state: State<'_, SevenTvEventsState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    // Tear down any previous connection (e.g. a channel switch landed
    // here before the old one's stop_seventv_events call from
    // disconnect() ran) - same defensive double-stop pattern
    // start_eventsub uses for the same reason.
    {
        let mut guard = state.stop_tx.lock().map_err(|e| e.to_string())?;
        if let Some(tx) = guard.take() {
            let _ = tx.send(());
        }
    }

    let (stop_tx, stop_rx) = tokio::sync::oneshot::channel();
    {
        let mut guard = state.stop_tx.lock().map_err(|e| e.to_string())?;
        *guard = Some(stop_tx);
    }

    tauri::async_runtime::spawn(seventv_events::run(app, emote_set_id, stop_rx));

    Ok(())
}

#[tauri::command]
pub fn stop_seventv_events(state: State<SevenTvEventsState>) -> Result<(), String> {
    let mut guard = state.stop_tx.lock().map_err(|e| e.to_string())?;
    if let Some(tx) = guard.take() {
        let _ = tx.send(());
    }
    Ok(())
}


// --------------------------------------------------------------------------- – proxied through Rust for the same reason IRC is:
// api.twitch.tv fails with ERR_NAME_NOT_RESOLVED from inside WebView2.
// Helix requires Authorization: Bearer <token> on every request, so we read
// the stored access token from ChatState. If the user hasn't logged in yet
// the token is None and the request returns a 401; chat.js catches that
// silently and calls loadBadges() again once login completes.
// ---------------------------------------------------------------------------


/// Fetches global Twitch chat badges (mod, VIP, broadcaster, sub tiers, etc).
/// Returns the raw Helix JSON string for chat.js to parse and ingest.
#[tauri::command]
pub async fn fetch_global_badges(state: State<'_, ChatState>) -> Result<String, String> {
    let token = state
        .auth
        .lock()
        .map_err(|e| e.to_string())?
        .as_ref()
        .map(|a| a.access_token.clone());
    helix_get("https://api.twitch.tv/helix/chat/badges/global", token).await
}

/// Fetches channel-specific badges (usually custom subscriber tiers).
/// Channels with no custom badges return `{"data":[]}` with HTTP 200.
#[tauri::command]
pub async fn fetch_channel_badges(
    broadcaster_id: String,
    state: State<'_, ChatState>,
) -> Result<String, String> {
    let token = state
        .auth
        .lock()
        .map_err(|e| e.to_string())?
        .as_ref()
        .map(|a| a.access_token.clone());
    let url = format!(
        "https://api.twitch.tv/helix/chat/badges?broadcaster_id={broadcaster_id}"
    );
    helix_get(&url, token).await
}

/// Fetches the full list of users currently connected to a channel's chat
/// via /helix/chat/chatters - this is the actual viewer roster (anyone
/// who's joined chat, whether or not they've ever typed), unlike the
/// @mention autocomplete's other data source (chat.js's _chatUsers map,
/// built purely from observed PRIVMSGs), which only ever knows about
/// people who have actually spoken. Used to fill in the gap: e.g. someone
/// named "tylerb" who's been watching silently still gets suggested when
/// typing "@tyler", not just "tyler" who happened to chat earlier.
///
/// Twitch restricts this endpoint to the broadcaster or a moderator of
/// the target channel (scope: moderator:read:chatters) - an ordinary
/// viewer's token gets a 403 here regardless of scope, which is expected
/// and not a bug; chat.js only calls this once it already knows (via
/// USERSTATE) that the logged-in user is a mod/broadcaster of the channel
/// being watched, and silently keeps using the speak-to-be-tracked
/// fallback for every other channel, same as before this existed.
///
/// Paginated the same way get_followed_channels() above is, but capped at
/// MAX_CHATTERS total - the autocomplete list only ever shows 10 matches
/// at a time, so there's no benefit to pulling a full 50,000-viewer
/// roster page by page just to populate a dropdown, and it would mean a
/// lot of avoidable Helix calls for the very largest channels.
#[tauri::command]
pub async fn get_chatters(
    broadcaster_id: String,
    state: State<'_, ChatState>,
) -> Result<String, String> {
    let (token, moderator_id) = require_auth(&state)?;
    const MAX_CHATTERS: usize = 3000;

    let mut all = Vec::new();
    let mut cursor: Option<String> = None;

    loop {
        let url = match &cursor {
            Some(c) => format!(
                "https://api.twitch.tv/helix/chat/chatters?broadcaster_id={broadcaster_id}&moderator_id={moderator_id}&first=1000&after={c}"
            ),
            None => format!(
                "https://api.twitch.tv/helix/chat/chatters?broadcaster_id={broadcaster_id}&moderator_id={moderator_id}&first=1000"
            ),
        };
        let body = helix_get(&url, Some(token.clone())).await?;
        let parsed: serde_json::Value =
            serde_json::from_str(&body).map_err(|e| format!("Bad JSON from Helix: {e}"))?;

        if let Some(data) = parsed.get("data").and_then(|d| d.as_array()) {
            all.extend(data.clone());
        }

        if all.len() >= MAX_CHATTERS {
            break;
        }

        cursor = parsed
            .get("pagination")
            .and_then(|p| p.get("cursor"))
            .and_then(|c| c.as_str())
            .filter(|c| !c.is_empty())
            .map(|c| c.to_string());

        if cursor.is_none() {
            break;
        }
    }

    serde_json::to_string(&all).map_err(|e| e.to_string())
}
