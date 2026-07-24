// 7TV EventAPI WebSocket client.
//
// chat.js's loadSevenTvChannelEmotes() only fetches a channel's 7TV emote
// set once, at join time - so mid-stream additions/removals (e.g. a
// streamer temporarily unlocking an emote via channel points) never
// showed up. This subscribes to that emote set's changes in real time
// instead, mirroring the "push, not poll" approach eventsub.rs uses for
// Twitch's own events, against 7TV's separate, unauthenticated EventAPI.
//
// Protocol (see https://github.com/SevenTV/EventAPI):
//   1. Connect to wss://events.7tv.io/v3.
//   2. Server sends Hello (op 1) with heartbeat_interval (ms) and a
//      session_id (unused - see the Resume note below).
//   3. We send Subscribe (op 35) for type "emote_set.update" with
//      condition {"object_id": <the 7TV emote set's id, not the Twitch
//      user id>}.
//   4. Server sends Heartbeat (op 2) periodically; if 3 consecutive
//      intervals pass with no traffic at all (heartbeat or dispatch), the
//      connection is considered dead per spec and we reconnect.
//   5. Server sends Dispatch (op 0) on changes. `pushed`/`pulled` cover
//      emotes added/removed - the primary case this exists to catch.
//      `updated` covers in-place edits (e.g. a rename).
//   6. Server can send Reconnect (op 4), handled the same way as Twitch
//      EventSub's session_reconnect in eventsub.rs.
//
// On reconnect we re-subscribe from scratch rather than using Resume (op
// 34): for a single subscription, re-subscribing is no more expensive
// than resuming and avoids persisting a session_id for a marginal
// benefit (replaying a few missed dispatches) - worst case, the next
// change after a reconnect gap still arrives correctly.

use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio_tungstenite::tungstenite::Message;

const EVENTAPI_WS: &str = "wss://events.7tv.io/v3";

// ── Wire types ───────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct Envelope {
    op: u8,
    #[serde(default)]
    d: Value,
}

const OP_DISPATCH: u8 = 0;
const OP_HELLO: u8 = 1;
const OP_HEARTBEAT: u8 = 2;
const OP_RECONNECT: u8 = 4;
const OP_ACK: u8 = 5;
const OP_ERROR: u8 = 6;
const OP_END_OF_STREAM: u8 = 7;
const OP_SUBSCRIBE: u8 = 35;

// ── Public entry point ────────────────────────────────────────────────────────

/// Runs the 7TV EventAPI WebSocket loop in a background Tokio task,
/// subscribed to one emote set's changes. Exits when stop_rx fires.
/// Unlike eventsub::run, this needs no access token at all - the EventAPI
/// is a public 7TV service with no auth requirement for this kind of
/// subscription.
pub async fn run(
    app: AppHandle,
    emote_set_id: String,
    mut stop_rx: tokio::sync::oneshot::Receiver<()>,
) {
    'reconnect: loop {
        let ws = match tokio_tungstenite::connect_async(EVENTAPI_WS).await {
            Ok((ws, _)) => ws,
            Err(e) => {
                eprintln!("[seventv-events] connect failed: {e}");
                return;
            }
        };

        let (mut write, mut read) = ws.split();

        // Set once Hello arrives; None beforehand means "use a
        // generous default while we wait," since the spec doesn't
        // guarantee Hello is the very first byte on the wire faster
        // than, say, a slow network could delay it.
        let mut heartbeat_interval_ms: u64 = 30_000;
        let mut missed_heartbeats: u32 = 0;

        loop {
            let timeout_duration =
                std::time::Duration::from_millis(heartbeat_interval_ms);

            tokio::select! {
                _ = &mut stop_rx => {
                    let _ = write.send(Message::Close(None)).await;
                    return;
                }
                msg = tokio::time::timeout(timeout_duration, read.next()) => {
                    let msg = match msg {
                        Ok(m) => m,
                        Err(_) => {
                            // No traffic at all (heartbeat or otherwise)
                            // within one full interval - per spec, after
                            // 3 missed heartbeats the connection should
                            // be considered dead.
                            missed_heartbeats += 1;
                            if missed_heartbeats >= 3 {
                                eprintln!(
                                    "[seventv-events] no heartbeat after {missed_heartbeats} intervals, reconnecting"
                                );
                                continue 'reconnect;
                            }
                            continue;
                        }
                    };

                    match msg {
                        Some(Ok(Message::Text(text))) => {
                            missed_heartbeats = 0;
                            let env: Envelope = match serde_json::from_str(&text) {
                                Ok(e) => e,
                                Err(_) => continue,
                            };

                            match env.op {
                                OP_HELLO => {
                                    if let Some(ms) = env.d.get("heartbeat_interval").and_then(|v| v.as_u64()) {
                                        heartbeat_interval_ms = ms;
                                    }
                                    let sub = json!({
                                        "op": OP_SUBSCRIBE,
                                        "d": {
                                            "type": "emote_set.update",
                                            "condition": { "object_id": emote_set_id }
                                        }
                                    });
                                    if let Ok(text) = serde_json::to_string(&sub) {
                                        if let Err(e) = write.send(Message::Text(text)).await {
                                            eprintln!("[seventv-events] subscribe send failed: {e}");
                                            return;
                                        }
                                    }
                                }
                                OP_HEARTBEAT => {
                                    // Just resets missed_heartbeats above - nothing
                                    // further to do.
                                }
                                OP_DISPATCH => {
                                    // The 7TV Dispatch envelope is:
                                    //   { "op": 0, "d": { "type": "emote_set.update", "body": { "pushed": [...], ... } } }
                                    // `pushed`/`pulled`/`updated` are inside d.body, not d itself.
                                    if let Some(inner_body) = env.d.get("body") {
                                        dispatch_event(&app, inner_body);
                                    }
                                }
                                OP_RECONNECT => {
                                    eprintln!("[seventv-events] server requested reconnect");
                                    let _ = write.send(Message::Close(None)).await;
                                    continue 'reconnect;
                                }
                                OP_ACK => {
                                    // Confirms our Subscribe was accepted - nothing
                                    // to act on, just useful to see in logs while
                                    // developing.
                                }
                                OP_ERROR => {
                                    eprintln!("[seventv-events] server error: {}", env.d);
                                }
                                OP_END_OF_STREAM => {
                                    // Server is about to close the connection on
                                    // its own terms - the close code in `d.code`
                                    // says whether/how to reconnect (see the
                                    // close-codes table in EventAPI's docs), but
                                    // reconnecting unconditionally after a short
                                    // pause is a reasonable default for the cases
                                    // this app cares about (server restarts,
                                    // maintenance) - it'll just fail fast and
                                    // retry again if the server genuinely isn't
                                    // coming back soon.
                                    eprintln!("[seventv-events] end of stream: {}", env.d);
                                    let _ = write.send(Message::Close(None)).await;
                                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                                    continue 'reconnect;
                                }
                                _ => {}
                            }
                        }
                        Some(Ok(Message::Close(_))) | None => {
                            eprintln!("[seventv-events] connection closed, reconnecting");
                            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                            continue 'reconnect;
                        }
                        Some(Err(e)) => {
                            eprintln!("[seventv-events] read error: {e}, reconnecting");
                            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                            continue 'reconnect;
                        }
                        _ => {}
                    }
                }
            }
        }
    }
}

// ── Dispatch handling ──────────────────────────────────────────────────────

/// Extracts emote add/remove/update entries from an emote_set.update
/// Dispatch's *inner* body (i.e. `d.body` from the wire envelope, not
/// `d` itself — the caller is responsible for drilling into the right
/// level before calling this).  Emits them to the frontend as
/// seventv-emote-set-update.  chat.js merges `pushed`+`updated` into its
/// emote map and removes `pulled` entries from it - see its listener for
/// the exact handling.
fn dispatch_event(app: &AppHandle, body: &Value) {
    // body.id is the emote SET's id (matches what we subscribed with);
    // not forwarded since the frontend only ever has one channel's emote
    // set active at a time and doesn't need to re-check which set this
    // was for.
    let extract_emotes = |field: &str| -> Vec<Value> {
        body.get(field)
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|change_field| change_field.get("value").cloned())
                    .collect()
            })
            .unwrap_or_default()
    };

    let pushed = extract_emotes("pushed");
    let updated = extract_emotes("updated");
    let pulled = extract_emotes("pulled");

    if pushed.is_empty() && updated.is_empty() && pulled.is_empty() {
        return;
    }

    let _ = app.emit("seventv-emote-set-update", json!({
        "added": pushed.into_iter().chain(updated).collect::<Vec<_>>(),
        "removed": pulled,
    }));
}
