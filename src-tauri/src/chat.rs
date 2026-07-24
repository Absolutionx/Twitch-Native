// Twitch IRC chat client - runs natively in Rust (Tokio + tokio-tungstenite)
// instead of the webview's JS, specifically to avoid WebView2's Tracking
// Prevention feature, which was silently blocking/killing the WebSocket
// connection to irc-ws.chat.twitch.tv when it ran in JS (confirmed via
// devtools: "Tracking Prevention blocked access to storage for
// https://irc-ws.chat.twitch.tv/"). Rust's networking has no exposure to
// that browser-level feature at all.
//
// Supports two modes:
//   - Anonymous (no AuthCredentials): read-only, random justinfanXXXXX nick.
//   - Authenticated (Some(AuthCredentials)): real NICK + PASS oauth:<token>,
//     enabling sending messages via send_chat_message (scope: chat:edit).
//
// Parsed messages are emitted to the frontend via Tauri's event system;
// 7TV emote fetching still happens in JS (plain fetch() to 7tv.io, which is
// unaffected by the tracking-prevention issue above).

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use std::collections::HashMap;
use tauri::{AppHandle, Emitter};
use tokio_tungstenite::tungstenite::Message;

const TWITCH_IRC_WS: &str = "wss://irc-ws.chat.twitch.tv:443";

/// Credentials for an authenticated (read+write) IRC connection. None of
/// this is persisted to disk in this PoC - it lives only in memory for the
/// duration of the chat session.
#[derive(Clone)]
pub struct AuthCredentials {
    pub access_token: String,
    pub login: String,
    pub user_id: String,
}

#[derive(Serialize, Clone)]
pub struct ChatMessageEvent {
    pub username: String,
    pub color: Option<String>,
    pub message: String,
    /// Raw value of the IRC `badges` tag, e.g. "broadcaster/1,subscriber/12"
    /// Parsing and image resolution happens in chat.js.
    pub badges: Option<String>,
    /// Bits cheered in this message (from the `bits` IRC tag).
    /// Present only on cheer messages; None otherwise.
    pub bits: Option<u32>,
    /// Set when this message was sent as a channel point redemption reward
    /// that includes a required/optional chat message (custom-reward-id tag).
    /// The reward name isn't in IRC - only the UUID - but the frontend uses
    /// this to apply a visual indicator regardless of the specific reward.
    pub custom_reward_id: Option<String>,
    /// Display name of the user being replied to (reply-parent-display-name tag).
    /// None if this is not a reply.
    pub reply_parent_user: Option<String>,
    /// Truncated body of the parent message (reply-parent-msg-body tag).
    /// IRC escapes (\s → space, \: → semicolon) are unescaped before sending.
    pub reply_parent_body: Option<String>,
    /// True when the message was a /me (CTCP ACTION) command.
    pub is_action: bool,
    /// Raw IRC @emotes tag value (e.g. "25:0-4/86:6-11").
    /// Used by the frontend to render Twitch native emotes by position.
    pub emotes_tag: Option<String>,
    /// Twitch-assigned unique message ID (IRC "id" tag). Used by the
    /// frontend to send @reply-parent-msg-id when the user hits Reply.
    pub msg_id: Option<String>,
    /// Sender's Twitch user id (IRC "user-id" tag) - distinct from
    /// `username` (their display name). Mod actions (timeout/ban) need
    /// this Helix-shaped numeric id, not the display name, so it's
    /// captured here even though nothing used it before mod tools existed.
    pub user_id: Option<String>,
    /// True when this is the very first message this user has ever sent
    /// in the channel (IRC "first-msg" tag - Twitch sends this on every
    /// PRIVMSG, no extra capability needed beyond the `tags` one already
    /// requested). Drives the purple first-time-chatter highlight on
    /// twitch.tv itself - see renderMessage()'s is-first-msg handling.
    pub is_first_msg: bool,
}

#[derive(Serialize, Clone)]
pub struct ChatSystemEvent {
    pub text: String,
}

#[derive(Serialize, Clone)]
pub struct ChatRoomEvent {
    pub room_id: String,
}

/// Fired on USERSTATE (after JOIN and after each sent message). Carries
/// the logged-in user's current badge string for that channel, and their
/// chosen chat color, so the frontend can show both next to the chat
/// input AND reuse them for the optimistic local echo of the user's own
/// sent messages (Twitch's IRC server never echoes a client's own PRIVMSG
/// back to it, so USERSTATE is the only source for this account's own
/// color/badges - see chat.js's sendMessage()).
#[derive(Serialize, Clone)]
pub struct UserStateEvent {
    pub badges: String,
    pub color: Option<String>,
}

/// Fired on CLEARCHAT. Either a single user's messages were cleared
/// (target_user_id/target_username set, ban_duration_secs set only if it
/// was a timeout rather than a permanent ban) or the entire chat was
/// cleared (all three None).
#[derive(Serialize, Clone)]
pub struct ChatClearChatEvent {
    pub target_user_id: Option<String>,
    pub target_username: Option<String>,
    pub ban_duration_secs: Option<u32>,
}

/// Fired on CLEARMSG - a single message was deleted. target_msg_id matches
/// the msg_id already sent on ChatMessageEvent for that same message.
#[derive(Serialize, Clone)]
pub struct ChatClearMsgEvent {
    pub target_msg_id: String,
}

#[derive(Serialize, Clone)]
pub struct ChatStatusEvent {
    pub status: String,
}

/// Parses Twitch IRC tag string ("key1=val1;key2=val2") into a map.
fn parse_tags(tag_str: &str) -> HashMap<String, String> {
    let mut tags = HashMap::new();
    for pair in tag_str.split(';') {
        if let Some(eq) = pair.find('=') {
            tags.insert(pair[..eq].to_string(), pair[eq + 1..].to_string());
        }
    }
    tags
}

/// Connects to Twitch IRC for the given channel and streams parsed events
/// to the frontend, RECONNECTING automatically until `stop_rx` fires.
///
/// The reconnect loop exists because every way this connection can die is
/// something the app used to just... accept: a closed/errored socket broke
/// the read loop and that was that (chat silently dead until the user
/// switched channels), Twitch's own `RECONNECT` command - which it sends
/// before restarting an IRC edge server, routinely - wasn't recognized at
/// all, and a half-open TCP connection after a network blip is the worst
/// of the three: no Close frame, no error, `read.next()` just never
/// resolves again while the status still says connected. Confirmed as the
/// cause of "live chat occasionally just stops." So now:
///
///   - Any disconnect (close, error, RECONNECT, or silence timeout) tears
///     down the socket and reconnects with exponential backoff (1s
///     doubling to a 30s cap, reset after any connection that survives
///     60s, so a flapping network doesn't hammer Twitch while a one-off
///     blip recovers in a second).
///   - A keepalive interval PINGs Twitch every 60s and treats 3 minutes
///     with no inbound frames of ANY kind as a dead connection - that
///     bound is what converts the silent half-open case into an ordinary
///     reconnect. (Twitch's own server PINGs arrive roughly every 5
///     minutes; our PINGs provoke PONG traffic well inside the timeout on
///     a healthy connection, so 3 quiet minutes really does mean dead.)
///   - `stop_rx` still ends everything immediately, including mid-backoff.
///
/// Reconnects re-run the full handshake and JOIN; room_id_sent resets so
/// the frontend re-receives chat-room and re-loads channel emotes/badges,
/// all of which is idempotent on that side.
///
/// `outgoing_rx` receives messages to send (e.g. PRIVMSG from the user's
/// own chat input) - the caller keeps the paired Sender half and uses it
/// from a separate Tauri command (send_chat_message) to push messages into
/// this running loop without needing direct access to the WebSocket.
/// Messages arriving during a reconnect gap simply wait in the channel
/// until the next connection is up.
///
/// Runs inside a spawned Tokio task - errors are emitted as chat-system
/// events rather than propagated, since there's no caller left to receive
/// a Result once this is running in the background.
pub async fn run_chat_client(
    app: AppHandle,
    channel: String,
    auth: Option<AuthCredentials>,
    mut outgoing_rx: tokio::sync::mpsc::UnboundedReceiver<OutgoingMessage>,
    mut stop_rx: tokio::sync::oneshot::Receiver<()>,
) {
    let emit_status = |status: &str| {
        let _ = app.emit("chat-status", ChatStatusEvent { status: status.into() });
    };
    let emit_system = |text: String| {
        let _ = app.emit("chat-system", ChatSystemEvent { text });
    };

    let channel_lower = channel.to_lowercase();
    let mut backoff_secs: u64 = 1;
    let mut first_attempt = true;

    // Macro-free little helper for "wait out the backoff, unless stop
    // fires first" - used from two places below. Returns true if stop
    // fired (caller must return).
    async fn backoff_or_stop(
        stop_rx: &mut tokio::sync::oneshot::Receiver<()>,
        secs: u64,
    ) -> bool {
        tokio::select! {
            _ = stop_rx => true,
            _ = tokio::time::sleep(std::time::Duration::from_secs(secs)) => false,
        }
    }

    'outer: loop {
        if first_attempt {
            emit_status("connecting");
            emit_system(format!("Connecting to chat for #{channel}..."));
        } else {
            emit_status("reconnecting");
        }

        let (ws_stream, _) = match tokio_tungstenite::connect_async(TWITCH_IRC_WS).await {
            Ok(pair) => pair,
            Err(e) => {
                emit_status("reconnecting");
                emit_system(format!(
                    "Failed to connect to Twitch chat ({e}) - retrying in {backoff_secs}s..."
                ));
                if backoff_or_stop(&mut stop_rx, backoff_secs).await {
                    emit_status("disconnected");
                    return;
                }
                backoff_secs = (backoff_secs * 2).min(30);
                first_attempt = false;
                continue 'outer;
            }
        };

        let (mut write, mut read) = ws_stream.split();

        let handshake = match &auth {
            Some(creds) => vec![
                format!("PASS oauth:{}", creds.access_token),
                format!("NICK {}", creds.login),
                "CAP REQ :twitch.tv/tags twitch.tv/commands".to_string(),
                format!("JOIN #{channel_lower}"),
            ],
            None => {
                let anon_nick = format!("justinfan{}", 10000 + (rand_u32() % 89999));
                vec![
                    "PASS SCHMOOPIIE".to_string(),
                    format!("NICK {anon_nick}"),
                    "CAP REQ :twitch.tv/tags twitch.tv/commands".to_string(),
                    format!("JOIN #{channel_lower}"),
                ]
            }
        };

        let mut handshake_failed = false;
        for line in handshake {
            if let Err(e) = write.send(Message::Text(line)).await {
                emit_system(format!(
                    "Failed to send IRC handshake ({e}) - retrying in {backoff_secs}s..."
                ));
                handshake_failed = true;
                break;
            }
        }
        if handshake_failed {
            emit_status("reconnecting");
            if backoff_or_stop(&mut stop_rx, backoff_secs).await {
                emit_status("disconnected");
                return;
            }
            backoff_secs = (backoff_secs * 2).min(30);
            first_attempt = false;
            continue 'outer;
        }

        if !first_attempt {
            emit_system("Chat reconnected.".into());
        }

        let connected_at = std::time::Instant::now();
        let mut last_inbound = std::time::Instant::now();
        let mut keepalive = tokio::time::interval(std::time::Duration::from_secs(60));
        // First tick of a tokio interval fires immediately - skip it so
        // the first keepalive PING goes out at t+60s, not t+0.
        keepalive.tick().await;

        let mut room_id_sent = false;

        // Inner connection loop. Breaks with a human-readable reason when
        // the connection should be re-established; returns outright when
        // stop_rx fires.
        let disconnect_reason: String = loop {
            tokio::select! {
                _ = &mut stop_rx => {
                    let _ = write.send(Message::Close(None)).await;
                    emit_status("disconnected");
                    return;
                }
                _ = keepalive.tick() => {
                    if last_inbound.elapsed() > std::time::Duration::from_secs(180) {
                        // See the doc comment: this is the half-open TCP
                        // case - no frames of any kind in 3 minutes on a
                        // connection that should carry Twitch PINGs every
                        // ~5 min and our PONG-provoking PINGs every 60s.
                        break "went silent (no data for 3 minutes)".to_string();
                    }
                    // Provoke a PONG so a healthy-but-quiet channel keeps
                    // last_inbound fresh. A send error here is itself a
                    // dead-connection signal.
                    if write.send(Message::Text("PING :keepalive".to_string())).await.is_err() {
                        break "keepalive send failed".to_string();
                    }
                }
                outgoing = outgoing_rx.recv() => {
                    match outgoing {
                        Some(OutgoingMessage::Privmsg(text)) => {
                            let line = format!("PRIVMSG #{channel_lower} :{text}");
                            if let Err(e) = write.send(Message::Text(line)).await {
                                emit_system(format!("Failed to send message: {e}"));
                            }
                        }
                        Some(OutgoingMessage::ReplyPrivmsg { reply_to_id, text }) => {
                            // Twitch IRC replies require the reply-parent-msg-id
                            // IRCv3 tag on the PRIVMSG line itself.
                            let line = format!(
                                "@reply-parent-msg-id={reply_to_id} PRIVMSG #{channel_lower} :{text}"
                            );
                            if let Err(e) = write.send(Message::Text(line)).await {
                                emit_system(format!("Failed to send reply: {e}"));
                            }
                        }
                        None => {
                            // Sender side dropped - shouldn't normally happen
                            // while the connection is alive, but isn't fatal;
                            // just stop selecting on this branch implicitly by
                            // letting future polls return None again (a no-op
                            // busy-loop risk in theory, but stop_rx or the read
                            // side will end the loop in practice well before
                            // this matters).
                        }
                    }
                }
                msg = read.next() => {
                    match msg {
                        Some(Ok(Message::Text(text))) => {
                            last_inbound = std::time::Instant::now();
                            let mut reconnect_requested = false;
                            for line in text.split("\r\n").filter(|l| !l.is_empty()) {
                                // Twitch sends RECONNECT before restarting an
                                // IRC edge server; the connection is about to
                                // die whether we cooperate or not, so treat it
                                // as an immediate (no-backoff-growth) rebuild.
                                if is_reconnect_command(line) {
                                    reconnect_requested = true;
                                    continue;
                                }
                                handle_irc_line(
                                    line,
                                    &app,
                                    &mut write,
                                    &channel_lower,
                                    &mut room_id_sent,
                                ).await;
                            }
                            if reconnect_requested {
                                backoff_secs = 1;
                                break "was asked to reconnect by Twitch (server restarting)".to_string();
                            }
                        }
                        Some(Ok(Message::Close(_))) | None => {
                            break "connection closed".to_string();
                        }
                        Some(Err(e)) => {
                            break format!("connection error: {e}");
                        }
                        Some(Ok(_)) => {
                            // Ping/Pong/Binary frames - tungstenite handles
                            // protocol-level replies itself; all that matters
                            // here is that the connection demonstrably isn't
                            // dead.
                            last_inbound = std::time::Instant::now();
                        }
                    }
                }
            }
        };

        // A connection that held for a while proves the network/server is
        // basically fine - don't make the NEXT blip pay this one's
        // accumulated backoff.
        if connected_at.elapsed() > std::time::Duration::from_secs(60) {
            backoff_secs = 1;
        }
        emit_status("reconnecting");
        emit_system(format!("Chat {disconnect_reason} - reconnecting in {backoff_secs}s..."));
        if backoff_or_stop(&mut stop_rx, backoff_secs).await {
            emit_status("disconnected");
            return;
        }
        backoff_secs = (backoff_secs * 2).min(30);
        first_attempt = false;
    }
}

/// True if `line` is Twitch's IRC `RECONNECT` command (optionally preceded
/// by IRCv3 tags and/or a :prefix). Sent by Twitch shortly before it
/// restarts the edge server this connection is attached to.
fn is_reconnect_command(line: &str) -> bool {
    let mut rest = line;
    if let Some(stripped) = rest.strip_prefix('@') {
        match stripped.find(' ') {
            Some(idx) => rest = &stripped[idx + 1..],
            None => return false,
        }
    }
    if let Some(stripped) = rest.strip_prefix(':') {
        match stripped.find(' ') {
            Some(idx) => rest = &stripped[idx + 1..],
            None => return false,
        }
    }
    rest.trim_start().split_whitespace().next() == Some("RECONNECT")
}

/// Messages that can be sent into a running chat connection's outgoing_rx
/// channel from a separate Tauri command invocation (send_chat_message)
/// that doesn't have direct access to the WebSocket itself.
pub enum OutgoingMessage {
    Privmsg(String),
    /// Reply to a specific message. Twitch IRC requires the reply-parent-msg-id
    /// IRCv3 tag to be sent as a leading @tag on the PRIVMSG line.
    ReplyPrivmsg { reply_to_id: String, text: String },
}

async fn handle_irc_line<S>(
    line: &str,
    app: &AppHandle,
    write: &mut futures_util::stream::SplitSink<S, Message>,
    channel: &str,
    room_id_sent: &mut bool,
) where
    S: futures_util::Sink<Message> + Unpin,
{
    let mut tags = HashMap::new();
    let mut rest = line;

    if let Some(stripped) = rest.strip_prefix('@') {
        if let Some(space_idx) = stripped.find(' ') {
            tags = parse_tags(&stripped[..space_idx]);
            rest = &stripped[space_idx + 1..];
        }
    }

    // PING keepalive - Twitch drops the connection if we don't PONG back.
    if rest.starts_with("PING") {
        let _ = write.send(Message::Text("PONG :tmi.twitch.tv".to_string())).await;
        return;
    }

    let mut prefix = "";
    if let Some(stripped) = rest.strip_prefix(':') {
        if let Some(space_idx) = stripped.find(' ') {
            prefix = &stripped[..space_idx];
            rest = &stripped[space_idx + 1..];
        }
    }

    let (head, trailing) = match rest.find(" :") {
        Some(idx) => (&rest[..idx], &rest[idx + 2..]),
        None => (rest, ""),
    };
    let command = head.split(' ').next().unwrap_or("");

    match command {
        "001" => {
            let _ = app.emit(
                "chat-status",
                ChatStatusEvent { status: format!("connected (#{channel})") },
            );
        }
        "ROOMSTATE" => {
            if !*room_id_sent {
                if let Some(room_id) = tags.get("room-id") {
                    *room_id_sent = true;
                    let _ = app.emit("chat-room", ChatRoomEvent { room_id: room_id.clone() });
                }
            }
        }
        "PRIVMSG" => {
            let username = tags
                .get("display-name")
                .cloned()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| prefix.split('!').next().unwrap_or("user").to_string());
            let color    = tags.get("color").cloned().filter(|s| !s.is_empty());
            let badges   = tags.get("badges").cloned().filter(|s| !s.is_empty());
            let bits     = tags.get("bits").and_then(|v| v.parse::<u32>().ok());
            let custom_reward_id = tags.get("custom-reward-id")
                .cloned().filter(|s| !s.is_empty());
            let reply_parent_user = tags.get("reply-parent-display-name")
                .cloned().filter(|s| !s.is_empty());
            let reply_parent_body = tags.get("reply-parent-msg-body")
                .cloned().filter(|s| !s.is_empty())
                .map(|s| {
                    // Unescape IRC tag value encoding: \s→space, \:→semicolon, \\→backslash
                    s.replace("\\s", " ").replace("\\:", ";").replace("\\\\", "\\")
                });
            let msg_id    = tags.get("id").cloned().filter(|s| !s.is_empty());
            let emotes_tag = tags.get("emotes").cloned().filter(|s| !s.is_empty());
            let user_id = tags.get("user-id").cloned().filter(|s| !s.is_empty());
            let is_first_msg = tags.get("first-msg").map(|v| v == "1").unwrap_or(false);

            // Strip the CTCP ACTION wrapper (ACTION ...) that bots
            // and /me commands use. Pass is_action so the frontend can render
            // the message in italics, matching Twitch's own chat behaviour.
            let (message, is_action) = if trailing.starts_with("ACTION ")
                && trailing.ends_with('')
            {
                let body = &trailing[8..trailing.len() - 1]; // strip prefix+suffix
                (body.to_string(), true)
            } else {
                (trailing.to_string(), false)
            };

            let _ = app.emit(
                "chat-message",
                ChatMessageEvent {
                    username, color,
                    message,
                    badges, bits, custom_reward_id,
                    reply_parent_user, reply_parent_body,
                    msg_id, user_id, is_action, emotes_tag,
                    is_first_msg,
                },
            );
        }
        "NOTICE" => {
            if !trailing.is_empty() {
                let _ = app.emit("chat-system", ChatSystemEvent { text: trailing.to_string() });
            }
        }
        "CLEARCHAT" => {
            // Two shapes share this command:
            //   CLEARCHAT #channel :username   - one user's messages cleared
            //     (ban-duration tag present = timeout for that many seconds;
            //     absent = permanent ban)
            //   CLEARCHAT #channel              - entire chat cleared (the
            //     broadcaster/mod "Clear Chat" action; no trailing text, no
            //     target user)
            // Emitted regardless of whether THIS client's own user did it -
            // any mod/the broadcaster clearing a user (via this app, the
            // website, or any other client) should grey out/remove that
            // user's lines here too, same as it would on twitch.tv itself.
            if trailing.is_empty() {
                let _ = app.emit("chat-clearchat", ChatClearChatEvent {
                    target_user_id: None,
                    target_username: None,
                    ban_duration_secs: None,
                });
            } else {
                let ban_duration_secs = tags.get("ban-duration").and_then(|v| v.parse::<u32>().ok());
                let target_user_id = tags.get("target-user-id").cloned().filter(|s| !s.is_empty());
                let _ = app.emit("chat-clearchat", ChatClearChatEvent {
                    target_user_id,
                    target_username: Some(trailing.to_string()),
                    ban_duration_secs,
                });
            }
        }
        "CLEARMSG" => {
            // Single-message delete (the "Delete" action on one chat line,
            // as opposed to CLEARCHAT's whole-user/whole-room clears).
            // target-msg-id is the same id PRIVMSG's `id` tag carries as
            // msg_id in ChatMessageEvent - the frontend matches the two up
            // to know which rendered line to grey out.
            if let Some(target_msg_id) = tags.get("target-msg-id").cloned().filter(|s| !s.is_empty()) {
                let _ = app.emit("chat-clearmsg", ChatClearMsgEvent { target_msg_id });
            }
        }
        "USERSTATE" => {
            // Sent by Twitch after JOIN and after every PRIVMSG we send.
            // Contains the logged-in user's current badges/color for this
            // channel. Previously only emitted when badges was non-empty,
            // which meant a logged-in user with NO badges in this channel
            // (no mod/sub/etc) but a real chosen chat color would still
            // lose that color, since the whole event got skipped - color
            // and badges are independent tags, so this checks for either
            // being present rather than gating the entire event on badges
            // specifically.
            let badges = tags.get("badges").cloned().unwrap_or_default();
            let color = tags.get("color").cloned().filter(|s| !s.is_empty());
            if !badges.is_empty() || color.is_some() {
                let _ = app.emit("user-state", UserStateEvent { badges, color });
            }
        }
        _ => {
            // JOIN/PART/CAP ack/etc - not needed for display.
        }
    }
}

/// Tiny dependency-free random number source for the anonymous nick suffix.
/// Doesn't need to be cryptographically random, just different enough to
/// avoid nick collisions between concurrent anonymous connections.
fn rand_u32() -> u32 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(42);
    nanos
}
