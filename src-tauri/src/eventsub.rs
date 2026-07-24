// Twitch EventSub WebSocket client.
//
// EventSub is how Twitch pushes real-time events (channel point redemptions,
// follows, subs, etc.) to clients without polling. It uses a dedicated
// WebSocket endpoint rather than IRC, so it lives here in Rust for the same
// reason the IRC client does: WebView2's Tracking Prevention kills WebSocket
// connections to Twitch endpoints.
//
// Flow:
//   1. Connect to wss://eventsub.wss.twitch.tv/ws.
//   2. Server immediately sends session_welcome with a session_id.
//   3. We POST to /helix/eventsub/subscriptions to register the events we
//      want, referencing that session_id as the transport target.
//   4. Server streams notification messages as events fire.
//   5. Server sends session_keepalive every ~10 s to confirm it's alive.
//   6. If server wants us to reconnect (rolling deploys etc.) it sends
//      session_reconnect with a new URL - we connect there before closing
//      the old socket to avoid missing events.
//
// AUTHORIZATION NOTE: channel.channel_points_custom_reward_redemption.add
// requires the token owner to be the BROADCASTER or a MOD of the watched
// channel (scope: channel:read:redemptions). The subscription POST will
// return 403 for regular viewers - we handle that silently so it doesn't
// clutter the chat window for non-mod sessions.

use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio_tungstenite::tungstenite::Message;

const EVENTSUB_WS: &str = "wss://eventsub.wss.twitch.tv/ws";

// ── Wire types ───────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct Envelope {
    metadata: Metadata,
    #[serde(default)]
    payload: Value,
}

#[derive(Deserialize)]
struct Metadata {
    message_type: String,
}

// ── Public entry point ────────────────────────────────────────────────────────

/// Runs the EventSub WebSocket loop in a background Tokio task.
/// Exits when stop_rx fires or the connection fails unrecoverably.
pub async fn run(
    app: AppHandle,
    broadcaster_id: String,
    moderator_id: String,
    access_token: String,
    mut stop_rx: tokio::sync::oneshot::Receiver<()>,
) {
    let mut connect_url = EVENTSUB_WS.to_string();

    // Outer loop: handles session_reconnect by re-entering with a new URL.
    'reconnect: loop {
        let ws = match tokio_tungstenite::connect_async(&connect_url).await {
            Ok((ws, _)) => ws,
            Err(e) => {
                eprintln!("[eventsub] connect failed: {e}");
                return;
            }
        };

        let (mut write, mut read) = ws.split();

        loop {
            tokio::select! {
                _ = &mut stop_rx => {
                    let _ = write.send(Message::Close(None)).await;
                    return;
                }
                msg = read.next() => {
                    match msg {
                        Some(Ok(Message::Text(text))) => {
                            let env: Envelope = match serde_json::from_str(&text) {
                                Ok(e) => e,
                                Err(_) => continue,
                            };

                            match env.metadata.message_type.as_str() {
                                "session_welcome" => {
                                    let session_id = env.payload
                                        .get("session").and_then(|s| s.get("id"))
                                        .and_then(|v| v.as_str()).unwrap_or("").to_string();

                                    // Subscribe to channel point redemptions.
                                    // 403 = not mod/broadcaster; log and continue
                                    // so the rest of the app keeps working.
                                    if let Err(e) = subscribe_channel_point_redemptions(
                                        &session_id, &broadcaster_id, &access_token,
                                    ).await {
                                        eprintln!(
                                            "[eventsub] subscription skipped \
                                             (need mod/broadcaster on this channel): {e}"
                                        );
                                    }
                                    // Subscribe to AutoMod-held messages. Same
                                    // 403-for-non-mods story as above - this one
                                    // additionally needs moderator_id in its own
                                    // right (not just broadcaster_id), since Twitch
                                    // only delivers these to the specific
                                    // moderator's own EventSub session, never as a
                                    // broadcast to anyone watching the channel.
                                    if let Err(e) = subscribe_automod_message_hold(
                                        &session_id, &broadcaster_id, &moderator_id, &access_token,
                                    ).await {
                                        eprintln!(
                                            "[eventsub] automod subscription skipped \
                                             (need mod/broadcaster on this channel): {e}"
                                        );
                                    }
                                    // Subscribe to outgoing raids FROM this channel
                                    // (the streamer being watched raiding someone
                                    // else). Unlike the two subscriptions above,
                                    // channel.raid requires no scope/mod status at
                                    // all per Twitch's docs - any token can
                                    // subscribe to it for any broadcaster, so a
                                    // failure here would be a genuine error worth
                                    // logging loudly rather than the expected-for-
                                    // most-viewers 403 the other two get.
                                    if let Err(e) = subscribe_channel_raid(
                                        &session_id, &broadcaster_id, &access_token,
                                    ).await {
                                        eprintln!("[eventsub] raid subscription failed: {e}");
                                    }
                                }
                                "session_keepalive" => {
                                    // Server heartbeat - nothing to do.
                                }
                                "session_reconnect" => {
                                    // Connect to the new URL BEFORE closing this
                                    // socket to avoid a gap in event delivery.
                                    if let Some(url) = env.payload
                                        .get("session").and_then(|s| s.get("reconnect_url"))
                                        .and_then(|v| v.as_str())
                                    {
                                        connect_url = url.to_string();
                                    }
                                    let _ = write.send(Message::Close(None)).await;
                                    continue 'reconnect;
                                }
                                "notification" => {
                                    dispatch_notification(&app, &env.payload);
                                }
                                "revocation" => {
                                    // Subscription was revoked (e.g. scope removed,
                                    // channel banned the app). Log but keep running
                                    // since other subscriptions may still be active.
                                    eprintln!(
                                        "[eventsub] subscription revoked: {}",
                                        env.payload
                                    );
                                }
                                _ => {}
                            }
                        }
                        Some(Ok(Message::Close(_))) | None => {
                            eprintln!("[eventsub] connection closed");
                            return;
                        }
                        Some(Err(e)) => {
                            eprintln!("[eventsub] read error: {e}");
                            return;
                        }
                        _ => {}
                    }
                }
            }
        }
    }
}

// ── Subscription ─────────────────────────────────────────────────────────────

async fn subscribe_channel_point_redemptions(
    session_id: &str,
    broadcaster_id: &str,
    access_token: &str,
) -> Result<(), String> {
    let client = reqwest::Client::new();

    let body = json!({
        "type":    "channel.channel_points_custom_reward_redemption.add",
        "version": "1",
        "condition": { "broadcaster_user_id": broadcaster_id },
        "transport": { "method": "websocket", "session_id": session_id }
    });

    let resp = client
        .post("https://api.twitch.tv/helix/eventsub/subscriptions")
        .header("Client-ID",     crate::oauth::CLIENT_ID)
        .header("Authorization", format!("Bearer {access_token}"))
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body   = resp.text().await.unwrap_or_default();
        return Err(format!("{status}: {body}"));
    }

    eprintln!("[eventsub] subscribed to channel point redemptions for {broadcaster_id}");
    Ok(())
}

/// Subscribes to AutoMod-held messages for `broadcaster_id`, delivered to
/// the specific moderator identified by `moderator_id` (per Twitch's docs,
/// over WebSocket transport this MUST equal the token owner's own user id -
/// see the comment on start_eventsub in main.rs for why that value has to
/// be threaded all the way through from there rather than just reusing
/// broadcaster_id for both spots like the redemptions subscription does).
async fn subscribe_automod_message_hold(
    session_id: &str,
    broadcaster_id: &str,
    moderator_id: &str,
    access_token: &str,
) -> Result<(), String> {
    let client = reqwest::Client::new();

    // Version 1 rather than V2 - both versions wrap the held text in a
    // { "text": "...", "fragments": [...] } object, but V2 adds per-fragment
    // reason annotations that the AutoMod queue UI doesn't use. V1 is enough.
    let body = json!({
        "type":    "automod.message.hold",
        "version": "1",
        "condition": {
            "broadcaster_user_id": broadcaster_id,
            "moderator_user_id":   moderator_id,
        },
        "transport": { "method": "websocket", "session_id": session_id }
    });

    let resp = client
        .post("https://api.twitch.tv/helix/eventsub/subscriptions")
        .header("Client-ID",     crate::oauth::CLIENT_ID)
        .header("Authorization", format!("Bearer {access_token}"))
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body   = resp.text().await.unwrap_or_default();
        return Err(format!("{status}: {body}"));
    }

    eprintln!("[eventsub] subscribed to automod holds for {broadcaster_id} (moderator {moderator_id})");
    Ok(())
}

/// Subscribes to channel.raid events FROM `broadcaster_id` - fires when the
/// channel being watched raids another channel. Per Twitch's docs this
/// subscription type requires no authorization at all (works for any
/// broadcaster, regardless of the calling token's relationship to them),
/// unlike the redemptions/automod subscriptions above which need the
/// logged-in user to be a mod/broadcaster of that specific channel. Used by
/// main.js to auto-navigate the player to the raided-into channel the
/// moment this fires - see the eventsub-raid listener in main.js.
async fn subscribe_channel_raid(
    session_id: &str,
    broadcaster_id: &str,
    access_token: &str,
) -> Result<(), String> {
    let client = reqwest::Client::new();

    let body = json!({
        "type":    "channel.raid",
        "version": "1",
        "condition": { "from_broadcaster_user_id": broadcaster_id },
        "transport": { "method": "websocket", "session_id": session_id }
    });

    let resp = client
        .post("https://api.twitch.tv/helix/eventsub/subscriptions")
        .header("Client-ID",     crate::oauth::CLIENT_ID)
        .header("Authorization", format!("Bearer {access_token}"))
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body   = resp.text().await.unwrap_or_default();
        return Err(format!("{status}: {body}"));
    }

    eprintln!("[eventsub] subscribed to outgoing raids for {broadcaster_id}");
    Ok(())
}

// ── Notification dispatch ─────────────────────────────────────────────────────

fn dispatch_notification(app: &AppHandle, payload: &Value) {
    let event_type = payload
        .get("subscription").and_then(|s| s.get("type"))
        .and_then(|v| v.as_str()).unwrap_or("");

    let Some(event) = payload.get("event") else { return };

    match event_type {
        "channel.channel_points_custom_reward_redemption.add" => {
            let redeemer = event.get("user_name")
                .and_then(|v| v.as_str()).unwrap_or("someone").to_string();
            let reward   = event.get("reward").cloned().unwrap_or(Value::Null);
            let reward_title = reward.get("title")
                .and_then(|v| v.as_str()).unwrap_or("?").to_string();
            let reward_cost  = reward.get("cost")
                .and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            let user_input = event.get("user_input")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string());

            let _ = app.emit("eventsub-redeem", json!({
                "redeemer":     redeemer,
                "reward_title": reward_title,
                "reward_cost":  reward_cost,
                "user_input":   user_input,
            }));
        }
        "automod.message.hold" => {
            let user_name = event.get("user_name")
                .and_then(|v| v.as_str()).unwrap_or("someone").to_string();
            let user_id = event.get("user_id")
                .and_then(|v| v.as_str()).unwrap_or("").to_string();
            // V1's `message` field is an object { "text": "...", "fragments": [...] },
            // not a bare string - `.text` is the plain concatenated message content,
            // which is all the AutoMod queue UI needs (no per-fragment breakdown).
            let message = event.get("message")
                .and_then(|v| v.get("text"))
                .and_then(|v| v.as_str()).unwrap_or("").to_string();
            let msg_id = event.get("message_id")
                .and_then(|v| v.as_str()).unwrap_or("").to_string();
            let category = event.get("category")
                .and_then(|v| v.as_str()).unwrap_or("").to_string();
            let level = event.get("level").and_then(|v| v.as_u64()).unwrap_or(0) as u32;

            // msg_id empty would mean the Allow/Deny buttons below have
            // nothing to act on - skip rather than show a useless entry.
            if msg_id.is_empty() { return; }

            let _ = app.emit("eventsub-automod-hold", json!({
                "user_name": user_name,
                "user_id":   user_id,
                "message":   message,
                "msg_id":    msg_id,
                "category":  category,
                "level":     level,
            }));
        }
        "channel.raid" => {
            let to_login = event.get("to_broadcaster_user_login")
                .and_then(|v| v.as_str()).unwrap_or("").to_string();
            let to_name = event.get("to_broadcaster_user_name")
                .and_then(|v| v.as_str()).unwrap_or("").to_string();
            let viewers = event.get("viewers")
                .and_then(|v| v.as_u64()).unwrap_or(0) as u32;

            // to_login empty would mean main.js has nothing to navigate
            // to - skip rather than emit a useless event.
            if to_login.is_empty() { return; }

            let _ = app.emit("eventsub-raid", json!({
                "to_login": to_login,
                "to_name":  to_name,
                "viewers":  viewers,
            }));
        }
        _ => {}
    }
}
