// Kick.com live-status lookup for Twitch -> Kick failover.
//
// Some streamers simulcast on Twitch and Kick and keep only the Kick
// stream going after ending the Twitch one (commonly for content Twitch
// doesn't permit). When the Twitch stream ends mid-watch, main.js asks
// this module whether the same slug is live on Kick and, if so, switches
// the player to Kick's HLS feed - see tryKickFailover in main.js for the
// frontend half and the exact conditions under which the switch happens.
//
// Uses Kick's unofficial v2 channel endpoint - the same one kick.com's
// own web frontend calls, but it IS unofficial: it sits behind Cloudflare
// and can start challenging non-browser clients at any time. Every error
// path here therefore reports rather than panics, and the frontend treats
// any Err as "couldn't check" (no failover), never as "offline".
//
// TRANSPORT: curl subprocess first, reqwest as fallback - not the other
// way around, and not reqwest alone (which is what this module originally
// did). Cloudflare's bot check on kick.com fingerprints the TLS handshake
// itself (JA3/JA4), not just headers, so reqwest's rustls handshake gets
// a 403 no matter what User-Agent it sends - that's the "[kick]
// offline-entry live check failed: Kick API returned 403 Forbidden" that
// this transport switch fixes. curl's TLS fingerprint currently passes
// Kick's Cloudflare tier (the same trick the published kick-api crate
// uses for this exact endpoint, and curl ships with Windows 10 1803+ and
// macOS out of the box - and this app already shells out to streamlink/
// ffmpeg, so a subprocess is nothing new here). reqwest is kept only as
// the fallback for machines with no curl on PATH, where it's better than
// nothing: it may still succeed when/where Cloudflare is being lenient.

use std::sync::Arc;

use crate::stream_relay::{proxied_hls_url, StreamRelayState};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Browser-ish UA sent on both transports. For curl it's mostly
/// cosmetic (Cloudflare passes curl on its TLS fingerprint - kick-api
/// gets through with "User-Agent: Chatterino7"); for the reqwest
/// fallback it's load-bearing, since reqwest's default UA alone is a
/// guaranteed block even before the TLS fingerprint gets a say.
const BROWSER_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) \
     AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

#[derive(serde::Serialize)]
pub struct KickLiveInfo {
    /// Kick's HLS master playlist, already wrapped in the local hls-proxy
    /// so hls.js can fetch it without CORS trouble (the proxy is
    /// host-agnostic and rewrites nested playlist URIs through itself,
    /// so Kick rides the exact same path Twitch VODs do).
    pub proxied_url: String,
    pub title: String,
    pub viewer_count: u64,
    pub category: String,
    /// Kick chatroom id for this channel, used by kick_chat.rs to
    /// subscribe to the Pusher channel `chatrooms.{id}.v2`. None if the
    /// payload didn't include one (chat then simply isn't offered).
    pub chatroom_id: Option<u64>,
    /// The broadcaster's Kick USER id (distinct from chatroom_id and from
    /// the channel id). Required as `broadcaster_user_id` when POSTing a
    /// chat message via the public API (see kick_oauth.rs's
    /// kick_send_chat_message). None if the payload didn't include it, in
    /// which case sending isn't offered for this channel (chat stays
    /// read-only) even when logged in.
    pub broadcaster_user_id: Option<u64>,
    /// ISO-8601 UTC wall-clock time this broadcast started, when Kick's
    /// payload includes one. Lets the frontend expand the live seek bar
    /// to show the full broadcast's elapsed time and an accurate "behind
    /// live" readout (playback-controls.js's liveDvrStreamStartedAt),
    /// exactly like Twitch's get_live_vod_info does with its VOD's
    /// created_at - see attachKickStream in main.js. Kick has no separate
    /// on-demand VOD endpoint for an in-progress broadcast the way Twitch
    /// does; get_kick_live_dvr below tries to find the session's
    /// in-progress RECORDING in the channel's videos list instead, and
    /// when it succeeds this timestamp also anchors the seek-bar-to-VOD
    /// offset math (see resolveKickDvr/onLiveDvrSeek in main.js). When
    /// that lookup fails, this still powers the display, and deep seeks
    /// clamp like before. None if the payload lacked a timestamp at
    /// every path tried, in which case Kick sessions fall back to the
    /// same buffer-relative display Twitch uses in its first ~30-60s
    /// before its own VOD info resolves.
    pub started_at: Option<String>,
    /// Kick's id for the CURRENT livestream session (distinct from the
    /// channel id, the chatroom id, and the user id - Kick mints a fresh
    /// one per broadcast). get_kick_live_dvr uses it to pick out this
    /// exact session's entry from the channel's videos listing, so the
    /// DVR swap can never land on last week's VOD. None if the payload
    /// didn't state one; DVR then falls back to the is_live flag match.
    pub livestream_id: Option<u64>,
    // ── Channel-page fields (the info bar - see updateKickChannelInfoBar
    // in main.js). All optional/defaulted: the bar renders whatever
    // subset the payload actually carried, mirroring how the Twitch bar
    // tolerates a null stream. ──────────────────────────────────────────
    /// Display name (capitalization as the user styled it), vs the slug.
    pub display_name: Option<String>,
    /// The broadcaster's profile picture URL.
    pub avatar: Option<String>,
    /// Kick's verified checkmark. The payload carries this as an object
    /// when verified and null when not (occasionally a plain bool) -
    /// normalized to a bool here.
    pub verified: bool,
    pub followers_count: Option<u64>,
    /// Broadcast language as Kick states it (usually a plain English
    /// word like "English"; sometimes an ISO code - the frontend
    /// handles both).
    pub language: Option<String>,
    pub is_mature: bool,
    /// Kick's freeform stream tags, when present.
    pub tags: Vec<String>,
    /// The channel's custom subscriber badge art, one entry per tier
    /// ({months, src}), from the payload's subscriber_badges array.
    /// Passed through to chat (connectKick -> renderBadges) so a
    /// subscriber's badge shows the channel's own months-matched art
    /// exactly like kick.com's chat, falling back to a generic
    /// subscriber badge when the channel has none. Empty when the
    /// payload carries none.
    pub subscriber_badges: Vec<KickSubscriberBadge>,
}

/// One tier of a channel's custom subscriber badge art - see
/// KickLiveInfo::subscriber_badges.
#[derive(serde::Serialize)]
pub struct KickSubscriberBadge {
    pub months: u64,
    pub src: String,
}

/// Returns Ok(Some(info)) if `slug` is currently live on Kick.
/// Returns Ok(None) if the channel is offline OR doesn't exist on Kick at
/// all - both mean "nothing to fail over to", and no-such-Kick-channel is
/// the EXPECTED outcome for most Twitch channels, so it's a clean None,
/// not an error. Err is reserved for genuine can't-tell failures
/// (network, Cloudflare challenge, unparseable JSON).
/// Chat + identity info for a Kick channel REGARDLESS of live status -
/// the offline-channel counterpart of get_kick_stream (which returns
/// Ok(None) the moment a channel isn't live, discarding the very fields
/// chat needs). Kick chatrooms stay open when the channel is offline,
/// so watching an offline Kick channel should still connect chat - both
/// to READ the occasional message and, for a logged-in user, to SEND.
/// Ok(None) only for a genuine 404 (no such channel). None of the
/// livestream/playback fields are touched here; this is purely the
/// channel object's stable identity.
#[tauri::command]
pub async fn get_kick_channel_chat_info(slug: String) -> Result<Option<serde_json::Value>, String> {
    let slug = slug.trim().to_lowercase();
    if slug.is_empty()
        || !slug
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err("invalid channel slug".into());
    }
    let url = format!("https://kick.com/api/v2/channels/{slug}");
    let Some(json) = fetch_kick_json(&url).await? else {
        return Ok(None); // 404: no such channel
    };
    let Some(chatroom_id) = json.pointer("/chatroom/id").and_then(|v| v.as_u64()) else {
        // No chatroom on the payload - nothing chat can attach to.
        return Ok(None);
    };
    Ok(Some(serde_json::json!({
        "chatroom_id": chatroom_id,
        "broadcaster_user_id": u64_at(&json, &["/user_id", "/user/id"]),
        "subscriber_badges": json.pointer("/subscriber_badges").cloned(),
        "display_name": str_at(&json, &["/user/username", "/user/name"]).map(str::to_string),
        "avatar": str_at(
            &json,
            &["/user/profile_pic", "/user/profilepic", "/user/profile_picture"],
        )
        .map(str::to_string),
        "verified": match json.get("verified") {
            Some(v) if v.is_boolean() => v.as_bool().unwrap_or(false),
            Some(v) => !v.is_null(),
            None => json.pointer("/user/verified").and_then(|v| v.as_bool()).unwrap_or(false),
        },
        "followers_count": u64_at(&json, &["/followers_count", "/followersCount"]),
    })))
}

/// Returns Ok(Some(info)) if `slug` is currently live on Kick, else
/// Ok(None) (offline or no such channel - both "nothing to play").
#[tauri::command]
pub async fn get_kick_stream(
    slug: String,
    relay: tauri::State<'_, Arc<StreamRelayState>>,
) -> Result<Option<KickLiveInfo>, String> {
    // Twitch logins are [a-z0-9_]; Kick slugs additionally use '-'.
    // Anything outside that can't be a valid slug, and since the slug is
    // interpolated into a URL path (and, now, a curl argv), reject
    // rather than try to encode.
    let slug = slug.trim().to_lowercase();
    if slug.is_empty()
        || !slug
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err("invalid channel slug".into());
    }

    let url = format!("https://kick.com/api/v2/channels/{slug}");

    // Ok(None) here means HTTP 404: no such Kick channel.
    let Some(json) = fetch_kick_json(&url).await? else {
        return Ok(None);
    };

    // `livestream` is null when offline. When present, is_live should be
    // true - but check it anyway rather than assume: Kick has been seen
    // serving a stale livestream object right around stream end, which
    // is exactly the moment this code runs.
    let is_live = json
        .pointer("/livestream/is_live")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if !is_live {
        return Ok(None);
    }
    let Some(playback) = json
        .get("playback_url")
        .and_then(|v| v.as_str())
        .filter(|s| s.starts_with("http"))
    else {
        // Live but no usable playback URL - treat as not-failoverable.
        return Ok(None);
    };

    Ok(Some(KickLiveInfo {
        proxied_url: proxied_hls_url(&relay, playback).await?,
        title: json
            .pointer("/livestream/session_title")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        viewer_count: json
            .pointer("/livestream/viewer_count")
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
        category: json
            .pointer("/livestream/categories/0/name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        chatroom_id: json.pointer("/chatroom/id").and_then(|v| v.as_u64()),
        // The channel's owning user id. On /api/v2/channels this is the
        // top-level `user_id` (the channel object's owner); `/user/id`
        // is the same user's nested object as a fallback for payload
        // shape drift.
        broadcaster_user_id: u64_at(&json, &["/user_id", "/user/id"]),
        // Same field-name variants livestream_to_helix already tries for
        // browse/home listings, just rooted at /livestream instead of the
        // livestream object being the JSON root - Kick's timestamp field
        // naming isn't consistent across its own endpoints.
        started_at: str_at(
            &json,
            &["/livestream/created_at", "/livestream/started_at", "/livestream/start_time"],
        )
        .map(to_iso_utc),
        livestream_id: json.pointer("/livestream/id").and_then(|v| v.as_u64()),
        display_name: str_at(&json, &["/user/username", "/user/name"]).map(str::to_string),
        avatar: str_at(
            &json,
            &["/user/profile_pic", "/user/profilepic", "/user/profile_picture"],
        )
        .map(str::to_string),
        verified: match json.get("verified") {
            Some(v) if v.is_boolean() => v.as_bool().unwrap_or(false),
            Some(v) => !v.is_null(), // object = verified, null = not
            None => json
                .pointer("/user/verified")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
        },
        followers_count: u64_at(&json, &["/followers_count", "/followersCount"]),
        language: str_at(&json, &["/livestream/language", "/livestream/lang"])
            .map(str::to_string),
        is_mature: json
            .pointer("/livestream/is_mature")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        tags: json
            .pointer("/livestream/tags")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|t| t.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
        subscriber_badges: json
            .pointer("/subscriber_badges")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|b| {
                        let months = b.get("months").and_then(|v| v.as_u64())?;
                        let src = str_at(b, &["/badge_image/src", "/badge_image"])
                            .filter(|s| s.starts_with("http"))?;
                        Some(KickSubscriberBadge { months, src: src.to_string() })
                    })
                    .collect()
            })
            .unwrap_or_default(),
    }))
}

/// Live-DVR source for a channel that is CURRENTLY live: the in-progress
/// recording of this very broadcast, playable as a growing HLS VOD.
///
/// Twitch exposes this directly (an "archive" VOD exists from minute one
/// of a broadcast); Kick doesn't have a dedicated endpoint, but for
/// channels with VODs enabled the current session's recording shows up
/// in the channel's own videos listing while still live, with a video
/// uuid that resolves to a master playlist via /api/v1/video/{uuid} -
/// the exact pair of calls kick.com's own site uses for its VOD pages.
/// The recording grows as the broadcast continues (hls.js handles the
/// growing playlist fine), trailing the live edge by ~30-60s, same as
/// Twitch's in-progress VODs.
///
/// Matching WHICH listing entry is this session (rather than an older
/// VOD) is deliberately strict: the livestream id from get_kick_stream
/// when provided, else an is_live flag on the entry. No "newest entry"
/// fallback - swapping the player onto last week's VOD because a seek
/// went past the buffer would be far worse than the clamp behavior this
/// feature replaces. Ok(None) = no DVR available (VODs disabled on the
/// channel, session not listed yet, or no playable source) - the
/// frontend keeps the old clamp-with-notice behavior then.
#[tauri::command]
pub async fn get_kick_live_dvr(
    slug: String,
    livestream_id: Option<u64>,
    relay: tauri::State<'_, Arc<StreamRelayState>>,
) -> Result<Option<serde_json::Value>, String> {
    let slug = slug.trim().to_lowercase();
    if slug.is_empty()
        || !slug
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err("invalid channel slug".into());
    }

    // 1) The channel's videos listing - each entry is a livestream object
    //    with an embedded {video: {uuid}} once a recording exists for it.
    let url = format!("https://kick.com/api/v2/channels/{slug}/videos");
    let Some(json) = fetch_kick_json(&url).await? else {
        return Ok(None);
    };
    let items = items_of(&json);
    let uuid_of = |v: &serde_json::Value| {
        str_at(v, &["/video/uuid", "/uuid"]).map(str::to_string)
    };
    let mut uuid: Option<String> = None;
    if let Some(want) = livestream_id {
        // Exact session match. Field spelling tried in the known variants,
        // same per-item tolerance as every other extractor in this module.
        uuid = items.iter().find_map(|v| {
            let id = u64_at(v, &["/id", "/livestream/id", "/video/live_stream_id"]);
            if id == Some(want) { uuid_of(v) } else { None }
        });
    }
    if uuid.is_none() {
        // No id to match (or no entry carried it): accept an entry Kick
        // itself flags as the live one.
        uuid = items.iter().find_map(|v| {
            let live = v
                .pointer("/is_live")
                .or_else(|| v.pointer("/livestream/is_live"))
                .and_then(|x| x.as_bool())
                .unwrap_or(false);
            if live { uuid_of(v) } else { None }
        });
    }
    let Some(uuid) = uuid else {
        return Ok(None);
    };

    // 2) Resolve the uuid to its (proxied) master playlist - shared with
    //    kick_vod_playback below, which does the same for finished VODs.
    let Some(proxied) = resolve_kick_video_url(&uuid, &relay).await? else {
        // Invalid-looking uuid, 404, or listed but no playable source
        // (yet) - recording may still be initializing right after stream
        // start. Not an error; the frontend can simply not offer DVR
        // this session.
        return Ok(None);
    };

    Ok(Some(serde_json::json!({
        // Wrapped in the local hls-proxy exactly like the live playlist,
        // so hls.js fetches it CORS-free through the same relay path.
        "proxied_vod_url": proxied,
    })))
}

/// Resolve a Kick video RECORDING uuid to its master playlist, wrapped
/// in the local hls-proxy. Ok(None) = uuid malformed, video gone (404),
/// or listed but carrying no playable `source` (recordings right after
/// stream start, or VODs mid-processing). Shared by get_kick_live_dvr
/// (in-progress recording of a live session) and kick_vod_playback
/// (finished past broadcasts) - same endpoint, same contract.
async fn resolve_kick_video_url(
    uuid: &str,
    relay: &Arc<StreamRelayState>,
) -> Result<Option<String>, String> {
    // The uuid goes into a URL path - validate its shape (hex + dashes)
    // for the same reason channel slugs are validated at every entry
    // point in this module.
    if uuid.is_empty()
        || !uuid
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Ok(None);
    }

    let vurl = format!("https://kick.com/api/v1/video/{uuid}");
    let Some(vjson) = fetch_kick_json(&vurl).await? else {
        return Ok(None);
    };
    let Some(source) = vjson
        .get("source")
        .and_then(|v| v.as_str())
        .filter(|s| s.starts_with("http"))
    else {
        return Ok(None);
    };
    Ok(Some(proxied_hls_url(relay, source).await?))
}

/// Past broadcasts for one channel - the Kick-mode counterpart of
/// get_videos_for_login (main.rs), backing the same VODs page. Returns
/// a JSON string of vods.js's expected Helix video shape: {id, title,
/// created_at, duration, thumbnail_url, view_count}, with:
///   - id = "kick:<recording uuid>". The prefix is what routes a card
///     click to the Kick watch path in main.js (and keeps saved VOD
///     progress keys from ever colliding with Twitch's numeric ids).
///   - duration in Helix's own "XhYmZs" spelling, so vods.js's existing
///     parseDuration/parseDurationToSeconds work unchanged.
#[tauri::command]
pub async fn kick_channel_videos(slug: String) -> Result<String, String> {
    let slug = slug.trim().to_lowercase();
    if slug.is_empty()
        || !slug
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err("invalid channel slug".into());
    }
    let url = format!("https://kick.com/api/v2/channels/{slug}/videos");
    let Some(json) = fetch_kick_json(&url).await? else {
        // 404: no such channel -> nothing to list, same clean-empty
        // treatment as a Twitch channel with zero archives.
        return Ok("[]".into());
    };
    let vods: Vec<_> = items_of(&json)
        .iter()
        .filter_map(video_entry_to_helix_vod)
        .collect();
    serde_json::to_string(&vods).map_err(|e| e.to_string())
}

/// Playback URL for one finished Kick VOD - the id is whatever
/// kick_channel_videos put on the card ("kick:<uuid>"; a bare uuid is
/// accepted too). Errors (rather than returning empty) when there's no
/// playable source, so main.js's watchKickVod shows a real reason
/// instead of a silent black player.
#[tauri::command]
pub async fn kick_vod_playback(
    video_id: String,
    relay: tauri::State<'_, Arc<StreamRelayState>>,
) -> Result<String, String> {
    let trimmed = video_id.trim();
    let uuid = trimmed.strip_prefix("kick:").unwrap_or(trimmed);
    match resolve_kick_video_url(uuid, &relay).await? {
        Some(url) => Ok(url),
        None => Err(
            "This Kick VOD has no playable source - it may still be processing, or was deleted."
                .into(),
        ),
    }
}

/// Normalize one entry of /api/v2/channels/{slug}/videos (a livestream
/// object with an embedded {video: {uuid}}) into the Helix video shape
/// vods.js renders - see kick_channel_videos for the field contract.
/// None = skipped: either too malformed to render (no recording uuid),
/// or the CURRENTLY-LIVE session's in-progress recording, which the
/// listing includes but a past-broadcasts page shouldn't (it's already
/// watchable as live; get_kick_live_dvr is what wants that entry).
fn video_entry_to_helix_vod(v: &serde_json::Value) -> Option<serde_json::Value> {
    let uuid = str_at(v, &["/video/uuid", "/uuid"])?;
    let live = v
        .pointer("/is_live")
        .or_else(|| v.pointer("/livestream/is_live"))
        .and_then(|x| x.as_bool())
        .unwrap_or(false);
    if live {
        return None;
    }
    let title = str_at(v, &["/session_title", "/video/session_title", "/title"]).unwrap_or("");
    let created = str_at(v, &["/start_time", "/created_at", "/video/created_at"])
        .map(to_iso_utc)
        .unwrap_or_default();
    // Kick states duration in MILLISECONDS on this listing.
    let secs = u64_at(v, &["/duration", "/video/duration"]).unwrap_or(0) / 1000;
    let thumb = str_at(
        v,
        &["/thumbnail/src", "/thumbnail", "/video/thumbnail/src", "/video/thumbnail"],
    )
    .unwrap_or("");
    Some(serde_json::json!({
        "id": format!("kick:{uuid}"),
        "title": title,
        "created_at": created,
        "duration": helix_duration(secs),
        "thumbnail_url": thumb,
        "view_count": u64_at(v, &["/views", "/video/views"]).unwrap_or(0),
        "platform": "kick",
    }))
}

/// Seconds -> Helix's duration spelling ("3h8m33s" / "45m12s" / "58s"),
/// matching what /helix/videos returns so the frontend's one duration
/// parser covers both platforms.
fn helix_duration(total_secs: u64) -> String {
    let h = total_secs / 3600;
    let m = (total_secs % 3600) / 60;
    let s = total_secs % 60;
    if h > 0 {
        format!("{h}h{m}m{s}s")
    } else if m > 0 {
        format!("{m}m{s}s")
    } else {
        format!("{s}s")
    }
}

/// GET `url` and parse the body as JSON. Ok(None) = HTTP 404 (channel
/// doesn't exist), Err = couldn't tell (network / Cloudflare / bad JSON).
///
/// curl first; falls back to reqwest ONLY when curl can't spawn at all
/// (not on PATH). A curl run that spawns but fails - network error,
/// Cloudflare 403, whatever - is a real answer about reachability, and
/// reqwest would only do worse against the same Cloudflare, so no
/// second attempt in that case.
async fn fetch_kick_json(url: &str) -> Result<Option<serde_json::Value>, String> {
    match fetch_via_curl(url).await {
        Ok(outcome) => outcome,
        // io::ErrorKind::NotFound from spawn = "curl isn't installed" -
        // the one case where trying the other transport makes sense.
        Err(spawn_err) if spawn_err.kind() == std::io::ErrorKind::NotFound => {
            fetch_via_reqwest(url).await
        }
        Err(spawn_err) => Err(format!("failed to run curl: {spawn_err}")),
    }
}

/// Outer Err = curl failed to SPAWN (caller may fall back to reqwest).
/// Inner Result/Option = same contract as fetch_kick_json.
async fn fetch_via_curl(
    url: &str,
) -> Result<Result<Option<serde_json::Value>, String>, std::io::Error> {
    let mut cmd = tokio::process::Command::new("curl");
    cmd.args([
        "-s",
        // Body goes to stdout as usual; then curl appends the HTTP
        // status on its own line. Needed because -s swallows errors and
        // plain curl exits 0 even on a 403/404 - the status code is how
        // 404 (clean "no such channel") gets told apart from 403
        // (Cloudflare, "couldn't check").
        "-w",
        "\n%{http_code}",
        "--max-time",
        "10",
        "-H",
        "Accept: application/json",
        "-H",
    ]);
    cmd.arg(format!("User-Agent: {BROWSER_UA}"));
    cmd.arg(url);
    cmd.stdin(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Same as every other subprocess in this app (see deps_check.rs):
        // without it, each lookup flashes a console window.
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = cmd.output().await?; // spawn failure -> outer Err

    Ok((|| {
        if !output.status.success() {
            // -s hides curl's own error text; exit code is all there is.
            // 28 = timeout, 6 = DNS, 7 = connect refused, per curl(1).
            return Err(format!(
                "curl exited with code {:?}",
                output.status.code()
            ));
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        // Split off the status line -w appended after the body.
        let (body, code) = stdout
            .rsplit_once('\n')
            .ok_or_else(|| "curl produced no output".to_string())?;
        match code.trim() {
            "404" => return Ok(None),
            "200" => {}
            other => return Err(format!("Kick API returned {other}")),
        }
        let json: serde_json::Value = serde_json::from_str(body)
            .map_err(|e| format!("Kick API returned unparseable JSON: {e}"))?;
        Ok(Some(json))
    })())
}

/// The original reqwest transport, kept as the no-curl fallback. Expect
/// this to 403 whenever Cloudflare is fingerprinting TLS (see module
/// comment) - but on a machine without curl it's the only option, and
/// Cloudflare's strictness has historically come and gone.
async fn fetch_via_reqwest(url: &str) -> Result<Option<serde_json::Value>, String> {
    let client = reqwest::Client::builder()
        .user_agent(BROWSER_UA)
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get(url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("Kick request failed: {e}"))?;

    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None); // no such Kick channel - nothing to fail over to
    }
    if !resp.status().is_success() {
        // 403 here is almost always Cloudflare challenging us rather
        // than a real permission answer - genuinely can't tell.
        return Err(format!("Kick API returned {}", resp.status()));
    }

    resp.json::<serde_json::Value>()
        .await
        .map(Some)
        .map_err(|e| format!("Kick API returned unparseable JSON: {e}"))
}

// ═══════════════════════════════════════════════════════════════════════
// Kick discovery: home feed / browse / search, for the platform toggle.
//
// Everything below feeds the SAME frontend renderers the Twitch feeds
// use (home.js, browse.js, sidebar.js) - the entire adaptation happens
// here, once, by normalizing Kick's payloads into Helix-shaped objects
// (user_login/title/viewer_count/game_name/thumbnail_url/...). The
// frontend's platform.js just swaps command names; the card builders
// never learn Kick exists. Two Kick-only extras ride along on each
// object: `platform: "kick"` (so click handlers route to the Kick watch
// path) and `profile_image_url` (Kick embeds avatars in stream payloads
// where Helix needs a second get_users_info call - hydrateAvatars seeds
// from this field and skips the Twitch lookup for kick:* ids).
//
// Endpoints are the unofficial ones kick.com's own frontend uses, same
// Cloudflare tier as /api/v2/channels (so everything rides
// fetch_kick_json's curl transport):
//   /api/v2/featured-livestreams/en?limit=N      top/featured live
//   /stream/livestreams/en?page=&limit=&...      live list; filters:
//       subcategory={slug} (one category), category={games|irl|music|
//       gambling|creative} (top-level group)
//   /api/v1/categories/top?limit=&page=          top categories
//   /api/search?searched_word=                   site search
//
// All of them are undocumented and Kick has changed their schemas
// before, so every extractor below tries the known field spellings in
// order and degrades per-item (a stream that can't be normalized is
// skipped, not fatal) - a schema drift should thin the grid, never
// blank the app.

/// Minimal percent-encoder for query VALUES (RFC 3986 unreserved set
/// kept literal). No dependency pulled in for this - the app only
/// encodes short user-typed search strings and category slugs.
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// First string found at any of the given JSON pointer paths.
fn str_at<'a>(v: &'a serde_json::Value, paths: &[&str]) -> Option<&'a str> {
    paths.iter().find_map(|p| v.pointer(p).and_then(|x| x.as_str()))
}

/// First u64 found at any of the given JSON pointer paths.
fn u64_at(v: &serde_json::Value, paths: &[&str]) -> Option<u64> {
    paths.iter().find_map(|p| v.pointer(p).and_then(|x| x.as_u64()))
}

/// Kick timestamps come as "2023-02-26 01:27:10" (UTC, space-separated)
/// in some payloads and proper ISO in others - normalize to ISO-8601 UTC
/// so anything downstream treating started_at like Helix's works.
fn to_iso_utc(ts: &str) -> String {
    if ts.contains('T') {
        ts.to_string()
    } else {
        let mut s = ts.replacen(' ', "T", 1);
        s.push('Z');
        s
    }
}

/// Normalize one Kick livestream object (from featured-livestreams or
/// stream/livestreams - both embed a `channel`) into a Helix-shaped
/// stream. None = item too malformed to render; caller skips it.
fn livestream_to_helix(v: &serde_json::Value) -> Option<serde_json::Value> {
    // The channel's slug is the watchable identity - without it a card
    // can't do anything when clicked, so it's the one hard requirement.
    // (/slug alone is NOT a fallback: on livestream objects that's the
    // STREAM's url slug, not the channel's.)
    let login = str_at(v, &["/channel/slug"])?;
    let title = str_at(v, &["/session_title", "/stream_title", "/title"]).unwrap_or("");
    let display =
        str_at(v, &["/channel/user/username", "/channel/user/name"]).unwrap_or(login);
    let viewers = u64_at(v, &["/viewer_count", "/viewers"]).unwrap_or(0);
    let game = str_at(
        v,
        &["/categories/0/name", "/category/name", "/subcategory/name"],
    )
    .unwrap_or("");
    let thumb = str_at(
        v,
        &["/thumbnail/src", "/thumbnail/url", "/thumbnail"],
    )
    .unwrap_or("");
    let avatar = str_at(
        v,
        &[
            "/channel/user/profile_pic",
            "/channel/user/profilepic",
            "/channel/user/profile_picture",
        ],
    )
    .unwrap_or("");
    let started = str_at(v, &["/created_at", "/started_at", "/start_time"]).unwrap_or("");
    let channel_id = u64_at(v, &["/channel/id", "/channel_id"]);

    Some(serde_json::json!({
        // Helix-shaped core, consumed verbatim by the card builders:
        "user_login": login,
        "user_name": display,
        // Prefixed so it can never collide with a real Twitch user id in
        // the shared avatars map, and so hydrateAvatars can recognize
        // and exclude it from get_users_info batches.
        "user_id": match channel_id {
            Some(id) => format!("kick:{id}"),
            None => format!("kick:{login}"),
        },
        "title": title,
        "viewer_count": viewers,
        "game_name": game,
        // Plain URL, no {width}x{height} template - thumbnailUrl()'s
        // replace() calls are no-ops on it, verified in home.js/browse.js.
        "thumbnail_url": thumb,
        "type": "live",
        "started_at": if started.is_empty() { String::new() } else { to_iso_utc(started) },
        "is_mature": v.pointer("/is_mature").and_then(|x| x.as_bool()).unwrap_or(false),
        "tags": [],
        // Kick-only extras (see module comment):
        "platform": "kick",
        "profile_image_url": avatar,
    }))
}

/// Normalize one Kick subcategory into a Helix game shape
/// ({id, name, box_art_url}). Kick's stable handle for a category is its
/// SLUG (that's what the livestream-filter endpoint takes), so the slug
/// goes in `id` - browse.js hands game.id straight back to
/// kick_streams_for_category, exactly like it hands Twitch game ids to
/// get_streams_for_game_id.
fn subcategory_to_helix_game(v: &serde_json::Value) -> Option<serde_json::Value> {
    // Search results have been seen both flat and wrapped ({document:
    // {...}}, a search-engine hit envelope) - unwrap if present.
    let v = v.get("document").unwrap_or(v);
    let slug = str_at(v, &["/slug"])?;
    let name = str_at(v, &["/name"]).unwrap_or(slug);
    let banner = str_at(
        v,
        &["/banner/src", "/banner/url", "/banner", "/thumbnail/src", "/thumbnail"],
    )
    .unwrap_or("");
    Some(serde_json::json!({
        "id": slug,
        "name": name,
        "box_art_url": banner,
        "viewers": u64_at(v, &["/viewers", "/viewer_count"]).unwrap_or(0),
        "platform": "kick",
    }))
}

/// Kick list payloads arrive either as a bare array or wrapped Laravel-
/// style ({data: [...]}) - accept both.
fn items_of(json: &serde_json::Value) -> Vec<serde_json::Value> {
    if let Some(arr) = json.as_array() {
        return arr.clone();
    }
    if let Some(arr) = json.get("data").and_then(|d| d.as_array()) {
        return arr.clone();
    }
    Vec::new()
}

fn normalize_streams(json: &serde_json::Value) -> Vec<serde_json::Value> {
    items_of(json).iter().filter_map(livestream_to_helix).collect()
}

/// Top/featured live streams - Kick-mode counterpart of
/// get_top_live_streams (home carousel/grid + sidebar Top Channels).
/// Same contract: a JSON string of a plain Helix-shaped stream array.
#[tauri::command]
pub async fn kick_top_live_streams() -> Result<String, String> {
    // Kick has renamed/moved its unofficial endpoints before, and a 404
    // here previously became a silent "[]" - which blanked the entire
    // Kick home feed AND the sidebar's Live Channels list (both are fed
    // by this command) while watch/chat kept working, since those use
    // the still-alive /api/v2/channels. So: try the known spellings of
    // the featured feed in order, and fall back to the general live
    // list (the same endpoint Browse pages through, sorted by viewers)
    // - visually equivalent content for a "top live" rail. First
    // candidate that yields any normalizable streams wins.
    const CANDIDATES: [&str; 3] = [
        "https://kick.com/stream/featured-livestreams/en",
        "https://kick.com/api/v2/featured-livestreams/en?limit=40",
        "https://kick.com/stream/livestreams/en?page=1&limit=40&sort=desc",
    ];
    let mut last_err: Option<String> = None;
    for url in CANDIDATES {
        match fetch_kick_json(url).await {
            Ok(Some(json)) => {
                let streams = normalize_streams(&json);
                if !streams.is_empty() {
                    return serde_json::to_string(&streams).map_err(|e| e.to_string());
                }
                // Parsed but empty/unrecognizable - try the next spelling.
            }
            Ok(None) => {} // 404: endpoint gone - try the next spelling.
            Err(e) => last_err = Some(e), // remember, but keep trying
        }
    }
    // Every candidate came back empty. If any genuinely errored, surface
    // that (home.js logs it to the console) rather than pretending Kick
    // has zero live channels.
    match last_err {
        Some(e) => Err(e),
        None => Ok("[]".into()),
    }
}

/// Where /stream/livestreams pagination stops being trusted. The
/// endpoints take page= but none of this is documented; if a future
/// schema change makes Kick ignore the param, every page would return
/// page 1's content and infinite scroll would append the same cards
/// forever. Capping bounds that worst case at a few duplicate screens
/// while leaving normal browsing (well within the cap) untouched.
const MAX_KICK_PAGES: u32 = 8;

/// Separate (much higher) cap for the CATEGORIES grid, which pages the
/// full subcategories listing rather than a live-streams feed: Kick has
/// hundreds of categories and "expand fully" is the whole point of that
/// grid's infinite scroll, so 8 pages (256 items) would cut it short.
/// The duplicate-loop worst case this cap guards against is additionally
/// bounded on the frontend now - browse.js dedupes appended pages by id
/// and stops paging after several consecutive pages that added nothing
/// new - so a big cap here no longer risks a long visible dupe crawl.
const MAX_KICK_CATEGORY_PAGES: u32 = 64;

fn page_from_cursor(cursor: &Option<String>) -> u32 {
    cursor
        .as_deref()
        .and_then(|c| c.parse::<u32>().ok())
        .filter(|&p| p >= 1)
        .unwrap_or(1)
}

/// Whether a page-numbered listing should advertise another page:
/// a full page suggests more; a short one is the end. next_page_url is
/// checked first when present (Laravel paginators state it outright).
fn next_cursor(
    json: &serde_json::Value,
    got: usize,
    limit: usize,
    page: u32,
    max_pages: u32,
) -> Option<String> {
    if page >= max_pages {
        return None;
    }
    match json.get("next_page_url") {
        Some(v) if v.is_null() => None,
        Some(_) => Some((page + 1).to_string()),
        None if got == limit => Some((page + 1).to_string()),
        None => None,
    }
}

/// Paged live-streams list - Kick-mode counterpart of
/// get_live_streams_page (Browse's Live Channels tab). Cursor is just a
/// stringified page number, opaque to the frontend either way.
#[tauri::command]
pub async fn kick_live_streams_page(cursor: Option<String>) -> Result<String, String> {
    let page = page_from_cursor(&cursor);
    let url =
        format!("https://kick.com/stream/livestreams/en?page={page}&limit=32&sort=desc");
    let Some(json) = fetch_kick_json(&url).await? else {
        return Ok(r#"{"streams":[],"cursor":null}"#.into());
    };
    let streams = normalize_streams(&json);
    let cursor = next_cursor(&json, streams.len(), 32, page, MAX_KICK_PAGES);
    serde_json::to_string(&serde_json::json!({ "streams": streams, "cursor": cursor }))
        .map_err(|e| e.to_string())
}

/// Appends `list` into `games`, skipping any whose id is already in
/// `seen` (empty ids are always kept - they can't be deduped meaningfully
/// and dropping them would silently lose categories). Used to merge the
/// ranked top list and the first subcategories page without showing the
/// overlap between them twice. See kick_top_games.
fn push_unique_games(
    list: Vec<serde_json::Value>,
    games: &mut Vec<serde_json::Value>,
    seen: &mut std::collections::HashSet<String>,
) {
    for g in list {
        let id = g.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if id.is_empty() || seen.insert(id) {
            games.push(g);
        }
    }
}

/// Top categories - Kick-mode counterpart of get_top_games (Browse's
/// Categories grid). Same envelope: {games: [...], cursor}.
///
/// TWO listings stitched into one cursor walk, because neither alone
/// gives what the grid needs:
///
///   * categories/top is viewer-ranked (the right FIRST screen) but
///     serves only a short fixed list and doesn't genuinely paginate -
///     which is exactly why the grid used to stop after ~2 rows: its
///     short first page read as "end of list" under the generic
///     full-page-means-more heuristic, so no cursor was ever handed
///     back and infinite scroll had nothing to walk.
///   * the plain subcategories listing DOES paginate through every
///     category Kick has, but isn't viewer-ranked, so it makes a poor
///     first screen on its own.
///
/// So: page 1 (cursor null) serves categories/top asking for as much as
/// it will give, then hands back the cursor "sub:1" - every subsequent
/// page walks the full subcategories listing ("sub:N"). The top
/// categories inevitably appear AGAIN somewhere in that full walk;
/// browse.js dedupes appended pages by game id, so the user never sees
/// the overlap. Bare-numeric cursors are still accepted (treated as
/// sub-listing page numbers) so any in-flight cursor from before this
/// change keeps working.
#[tauri::command]
pub async fn kick_top_games(cursor: Option<String>) -> Result<String, String> {
    // ── Pages 2+ : the full subcategories listing ("sub:N") ──────────
    if let Some(cur) = cursor.as_deref() {
        let page = cur
            .strip_prefix("sub:")
            .unwrap_or(cur)
            .parse::<u32>()
            .ok()
            .filter(|&p| p >= 1)
            .unwrap_or(1);
        return kick_subcategories_page(page, None).await;
    }

    // ── Page 1: the viewer-ranked top list, PLUS the first page of the
    //    full subcategories listing merged in ───────────────────────────
    // categories/top caps server-side at ~13 no matter what limit we ask
    // for, so on its own it makes a sparse first screen (this is the
    // "browse only shows 13 categories" report). The full walk below has
    // hundreds more, but they used to appear only once the user scrolled.
    // Merge the first subcategories page into page 1 so the initial grid
    // is full immediately; dedupe by id so the ranked entries that also
    // appear in the sub-listing aren't shown twice. The cursor still hands
    // off to "sub:2", so infinite scroll continues seamlessly from there.
    let mut games: Vec<serde_json::Value> = Vec::new();
    let mut seen_ids: std::collections::HashSet<String> = std::collections::HashSet::new();

    let mut last_err: Option<String> = None;
    match fetch_kick_json("https://kick.com/api/v1/categories/top?limit=100").await {
        Ok(Some(json)) => {
            let ranked: Vec<_> = items_of(&json)
                .iter()
                .filter_map(subcategory_to_helix_game)
                .collect();
            push_unique_games(ranked, &mut games, &mut seen_ids);
        }
        Ok(None) => {} // 404: endpoint gone - fall through to sub-listing only
        Err(e) => last_err = Some(e),
    }

    // First subcategories page, merged in behind the ranked entries.
    if let Ok(Some(json)) = fetch_kick_json(
        "https://kick.com/api/v1/subcategories?limit=32&page=1",
    ).await {
        let subs: Vec<_> = items_of(&json)
            .iter()
            .filter_map(subcategory_to_helix_game)
            .collect();
        push_unique_games(subs, &mut games, &mut seen_ids);
    }

    if !games.is_empty() {
        // Continue the walk from sub:2 (page 1 is already folded in above).
        return serde_json::to_string(
            &serde_json::json!({ "games": games, "cursor": "sub:2" }),
        )
        .map_err(|e| e.to_string());
    }
    // Nothing from either source - fall through to the error-surfacing
    // sub-listing path (page 1), same insurance as before.
    kick_subcategories_page(1, last_err).await
}

/// One page of the full subcategories listing, in kick_top_games'
/// response envelope. `carried_err` is a categories/top failure to
/// surface if THIS listing also yields nothing (mirrors
/// kick_top_live_streams' don't-pretend-Kick-is-empty error handling).
async fn kick_subcategories_page(
    page: u32,
    carried_err: Option<String>,
) -> Result<String, String> {
    let url = format!("https://kick.com/api/v1/subcategories?limit=32&page={page}");
    let json = match fetch_kick_json(&url).await {
        Ok(Some(j)) => j,
        Ok(None) => {
            return match carried_err {
                Some(e) => Err(e),
                None => Ok(r#"{"games":[],"cursor":null}"#.into()),
            };
        }
        Err(e) => return Err(carried_err.unwrap_or(e)),
    };
    let games: Vec<_> = items_of(&json)
        .iter()
        .filter_map(subcategory_to_helix_game)
        .collect();
    let cursor = next_cursor(&json, games.len(), 32, page, MAX_KICK_CATEGORY_PAGES)
        .map(|p| format!("sub:{p}"));
    serde_json::to_string(&serde_json::json!({ "games": games, "cursor": cursor }))
        .map_err(|e| e.to_string())
}

/// Live streams for one category - Kick-mode counterpart of
/// get_streams_for_game_id. `game_id` is the Kick subcategory SLUG,
/// because that's what kick_top_games/kick_search_categories put in the
/// game objects' `id` field (see subcategory_to_helix_game).
#[tauri::command]
pub async fn kick_streams_for_category(game_id: String) -> Result<String, String> {
    let slug = game_id.trim().to_lowercase();
    if slug.is_empty()
        || !slug
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err("invalid category slug".into());
    }
    let url = format!(
        "https://kick.com/stream/livestreams/en?page=1&limit=32&subcategory={slug}&sort=desc"
    );
    let Some(json) = fetch_kick_json(&url).await? else {
        return Ok("[]".into());
    };
    serde_json::to_string(&normalize_streams(&json)).map_err(|e| e.to_string())
}

/// Category-by-NAME lookup - Kick-mode counterpart of
/// get_streams_for_game_names, which the frontend uses for two things:
/// the Browse pills (IRL / Music / Talk Shows & Podcasts) and the home
/// feed's hand-picked RPGs row. The pill names map onto Kick's own
/// top-level category groups (the `category=` filter); anything else -
/// including the entire RPG list, which is Twitch-category-name-specific
/// - resolves to no group and contributes nothing, which the frontend
/// already handles (home.js hides an empty RPGs row; a pill shows "No
/// live channels right now").
/// Live status for a list of Kick channels - powers the sidebar's
/// Following section in Kick mode. Kick's real followed-channels
/// endpoint authenticates with the SITE session cookie, which an OAuth
/// app token (this app's login) can't produce - so follows are kept
/// locally (see kick-follows.js) and this command just answers "which
/// of these are live right now" by fetching each channel payload.
/// Chunked so a long list doesn't spawn dozens of curl processes at
/// once; a slug whose lookup fails is simply omitted (the frontend
/// falls back to its stored name/avatar and renders the row offline).
#[tauri::command]
pub async fn kick_followed_status(slugs: Vec<String>) -> Result<String, String> {
    const MAX_SLUGS: usize = 30;
    const CHUNK: usize = 6;
    let slugs: Vec<String> = slugs
        .into_iter()
        .map(|s| s.trim().to_lowercase())
        .filter(|s| {
            !s.is_empty()
                && s.chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        })
        .take(MAX_SLUGS)
        .collect();

    let mut out: Vec<serde_json::Value> = Vec::new();
    for chunk in slugs.chunks(CHUNK) {
        let futs = chunk.iter().map(|slug| async move {
            let url = format!("https://kick.com/api/v2/channels/{slug}");
            match fetch_kick_json(&url).await {
                Ok(Some(json)) => Some(channel_json_to_status(slug, &json)),
                _ => None, // 404 / network / Cloudflare - omit, don't fail the batch
            }
        });
        for item in futures_util::future::join_all(futs).await.into_iter().flatten() {
            out.push(item);
        }
    }
    serde_json::to_string(&out).map_err(|e| e.to_string())
}

fn channel_json_to_status(slug: &str, json: &serde_json::Value) -> serde_json::Value {
    let live = json
        .pointer("/livestream/is_live")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    serde_json::json!({
        "slug": slug,
        "name": str_at(json, &["/user/username", "/user/name"]).unwrap_or(slug),
        "avatar": str_at(
            json,
            &["/user/profile_pic", "/user/profilepic", "/user/profile_picture"],
        )
        .unwrap_or(""),
        "is_live": live,
        "viewer_count": json
            .pointer("/livestream/viewer_count")
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
        "game": str_at(
            json,
            &["/livestream/categories/0/name", "/livestream/category/name"],
        )
        .unwrap_or(""),
    })
}

#[tauri::command]
pub async fn kick_streams_for_game_names(game_names: Vec<String>) -> Result<String, String> {
    let group = game_names.iter().find_map(|n| match n.as_str() {
        "IRL" => Some("irl"),
        "Music" => Some("music"),
        // Twitch's pill name and Kick's own label both accepted, plus
        // the plain group word - the frontend's per-platform pill bars
        // (browse.js) send the human labels, not the filter values.
        "Talk Shows & Podcasts" | "Creative" => Some("creative"),
        "Gambling" | "Slots & Casino" => Some("gambling"),
        _ => None,
    });
    let Some(group) = group else {
        return Ok("[]".into());
    };
    let url = format!(
        "https://kick.com/stream/livestreams/en?page=1&limit=32&category={group}&sort=desc"
    );
    let Some(json) = fetch_kick_json(&url).await? else {
        return Ok("[]".into());
    };
    serde_json::to_string(&normalize_streams(&json)).map_err(|e| e.to_string())
}

/// Category search - Kick-mode counterpart of search_categories (the
/// Browse search box). Kick's site search returns several result kinds
/// in one payload; only the categories are wanted here.
#[tauri::command]
pub async fn kick_search_categories(query: String) -> Result<String, String> {
    let q = query.trim();
    if q.is_empty() {
        return Ok("[]".into());
    }
    let url = format!(
        "https://kick.com/api/search?searched_word={}",
        urlencode(q)
    );
    let Some(json) = fetch_kick_json(&url).await? else {
        return Ok("[]".into());
    };
    // Categories have been seen at /categories and (search-engine
    // era) under a hits wrapper - try the known spots.
    let cats = json
        .pointer("/categories")
        .or_else(|| json.pointer("/categories/hits"))
        .or_else(|| json.pointer("/data/categories"))
        .and_then(|c| c.as_array())
        .cloned()
        .unwrap_or_default();
    let games: Vec<_> = cats.iter().filter_map(subcategory_to_helix_game).collect();
    serde_json::to_string(&games).map_err(|e| e.to_string())
}

/// The channel's native Kick emotes (its own subscriber/channel emotes
/// PLUS Kick's site-wide "Global" and "Emoji" sets, which this endpoint
/// bundles into the same payload). Used by chat: kick_chat.rs flattens
/// inline `[emote:id:name]` tokens down to their bare names, and the
/// frontend resolves those names back into images through its normal
/// third-party-emote map - but only if the name->image entries exist.
/// This command supplies them: a flat [{id, name, global}] list the
/// frontend turns into files.kick.com CDN URLs (the id alone determines
/// the image URL: https://files.kick.com/emotes/{id}/fullsize).
///
/// Same unofficial-endpoint caveats as everything else here; any failure
/// degrades to "native emotes render as text", never an error dialog.
#[tauri::command]
pub async fn kick_channel_emotes(slug: String) -> Result<String, String> {
    let slug = slug.trim().to_lowercase();
    if slug.is_empty()
        || !slug
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err("invalid channel slug".into());
    }
    let url = format!("https://kick.com/emotes/{slug}");
    let Some(json) = fetch_kick_json(&url).await? else {
        return Ok("[]".into());
    };
    // Payload is an array of emote SETS: the channel's own set (id =
    // numeric channel id) plus "Global" and "Emoji"/"Emojis" sets.
    // Flatten them, tagging which are site-wide vs channel-specific so
    // the frontend can apply its channel-beats-global precedence.
    let mut out: Vec<serde_json::Value> = Vec::new();
    for set in items_of(&json) {
        let is_global = set
            .get("id")
            .and_then(|v| v.as_str())
            .map(|s| s.eq_ignore_ascii_case("global") || s.eq_ignore_ascii_case("emoji") || s.eq_ignore_ascii_case("emojis"))
            .unwrap_or(false);
        let Some(emotes) = set.get("emotes").and_then(|e| e.as_array()) else {
            continue;
        };
        for e in emotes {
            let (Some(id), Some(name)) = (
                e.get("id").and_then(|v| v.as_u64()),
                e.get("name").and_then(|v| v.as_str()),
            ) else {
                continue; // per-item degradation, same as normalize_streams
            };
            out.push(serde_json::json!({ "id": id, "name": name, "global": is_global }));
        }
    }
    serde_json::to_string(&out).map_err(|e| e.to_string())
}

/// Category viewer counts - Kick-mode counterpart of
/// get_category_viewer_counts. Helix needs a 1000-stream sampling pass
/// for this; Kick's top-categories payload states `viewers` outright,
/// so this just reshapes that into the same {game_id: {viewer_count,
/// channel_count}} map browse.js already consumes (channel_count isn't
/// in Kick's payload - 0 means "unknown" and the card simply omits it).
#[tauri::command]
pub async fn kick_category_viewer_counts() -> Result<String, String> {
    let url = "https://kick.com/api/v1/categories/top?limit=60";
    let Some(json) = fetch_kick_json(url).await? else {
        return Ok("{}".into());
    };
    let mut map = serde_json::Map::new();
    for item in items_of(&json) {
        let item = item.get("document").unwrap_or(&item);
        if let Some(slug) = item.get("slug").and_then(|s| s.as_str()) {
            let viewers = u64_at(item, &["/viewers", "/viewer_count"]).unwrap_or(0);
            map.insert(
                slug.to_string(),
                serde_json::json!({ "viewer_count": viewers, "channel_count": 0 }),
            );
        }
    }
    serde_json::to_string(&serde_json::Value::Object(map)).map_err(|e| e.to_string())
}

#[cfg(test)]
mod discovery_tests {
    use super::*;

    // Livestream shape as documented for /api/v1/channels and shared by
    // the listing endpoints (channel embedded, space-separated
    // timestamp, thumbnail as object).
    #[test]
    fn normalizes_documented_livestream_shape() {
        let v: serde_json::Value = serde_json::json!({
            "id": 202501,
            "slug": "1b5ac-building-a-kick-bot", // STREAM slug - must NOT become the login
            "session_title": "Building a KICK bot",
            "created_at": "2023-02-26 01:27:10",
            "is_live": true,
            "is_mature": false,
            "viewer_count": 7,
            "thumbnail": { "url": "https://stream.kick.com/thumb.jpg" },
            "categories": [ { "name": "Software Development", "slug": "software-development" } ],
            "channel": {
                "id": 259825,
                "slug": "mattseabrook",
                "user": { "username": "mattseabrook", "profilepic": "https://cdn/pic.webp" }
            }
        });
        let s = livestream_to_helix(&v).expect("should normalize");
        assert_eq!(s["user_login"], "mattseabrook");
        assert_eq!(s["user_id"], "kick:259825");
        assert_eq!(s["title"], "Building a KICK bot");
        assert_eq!(s["viewer_count"], 7);
        assert_eq!(s["game_name"], "Software Development");
        assert_eq!(s["thumbnail_url"], "https://stream.kick.com/thumb.jpg");
        assert_eq!(s["started_at"], "2023-02-26T01:27:10Z");
        assert_eq!(s["platform"], "kick");
        assert_eq!(s["profile_image_url"], "https://cdn/pic.webp");
    }

    #[test]
    fn skips_items_without_channel_slug() {
        let v = serde_json::json!({ "session_title": "orphan", "viewer_count": 5 });
        assert!(livestream_to_helix(&v).is_none());
    }

    // Subcategory shape as documented for categories/top (banner object,
    // viewers stated outright).
    #[test]
    fn normalizes_documented_subcategory_shape() {
        let v = serde_json::json!({
            "id": 15,
            "name": "Just Chatting",
            "slug": "just-chatting",
            "banner": { "src": "https://cdn/banner.webp" },
            "viewers": 13447
        });
        let g = subcategory_to_helix_game(&v).expect("should normalize");
        assert_eq!(g["id"], "just-chatting"); // slug IS the id (see fn comment)
        assert_eq!(g["name"], "Just Chatting");
        assert_eq!(g["box_art_url"], "https://cdn/banner.webp");
        assert_eq!(g["viewers"], 13447);
    }

    #[test]
    fn accepts_bare_array_and_data_wrapped_lists() {
        let bare = serde_json::json!([ { "a": 1 } ]);
        let wrapped = serde_json::json!({ "data": [ { "a": 1 }, { "a": 2 } ] });
        assert_eq!(items_of(&bare).len(), 1);
        assert_eq!(items_of(&wrapped).len(), 2);
    }

    #[test]
    fn pagination_cursor_logic() {
        let laravel_more = serde_json::json!({ "next_page_url": "https://..." });
        let laravel_end = serde_json::json!({ "next_page_url": null });
        let bare = serde_json::json!([]);
        assert_eq!(next_cursor(&laravel_more, 32, 32, 1, MAX_KICK_PAGES), Some("2".into()));
        assert_eq!(next_cursor(&laravel_end, 32, 32, 1, MAX_KICK_PAGES), None);
        assert_eq!(next_cursor(&bare, 32, 32, 3, MAX_KICK_PAGES), Some("4".into())); // full page implies more
        assert_eq!(next_cursor(&bare, 10, 32, 3, MAX_KICK_PAGES), None); // short page = the end
        assert_eq!(next_cursor(&laravel_more, 32, 32, MAX_KICK_PAGES, MAX_KICK_PAGES), None); // hard cap
        // The categories walk keeps going well past the live-streams cap
        // (that's the whole point of its separate, higher limit)...
        assert_eq!(
            next_cursor(&laravel_more, 32, 32, MAX_KICK_PAGES, MAX_KICK_CATEGORY_PAGES),
            Some((MAX_KICK_PAGES + 1).to_string())
        );
        // ...but still has its own ceiling.
        assert_eq!(
            next_cursor(&laravel_more, 32, 32, MAX_KICK_CATEGORY_PAGES, MAX_KICK_CATEGORY_PAGES),
            None
        );
    }

    #[test]
    fn helix_duration_spellings() {
        assert_eq!(helix_duration(11_313), "3h8m33s");
        assert_eq!(helix_duration(2_712), "45m12s");
        assert_eq!(helix_duration(58), "58s");
        assert_eq!(helix_duration(3_600), "1h0m0s");
        assert_eq!(helix_duration(0), "0s");
    }

    #[test]
    fn normalizes_channel_video_entry() {
        // The documented /api/v2/channels/{slug}/videos entry shape: a
        // livestream object with the recording embedded as {video:{uuid}},
        // duration in milliseconds, and a space-separated start_time.
        let v = serde_json::json!({
            "id": 555,
            "session_title": "late night grind",
            "start_time": "2026-07-10 20:00:00",
            "duration": 11_313_000u64,
            "is_live": false,
            "views": 4321,
            "thumbnail": { "src": "https://cdn/thumb.webp" },
            "video": { "uuid": "abc-123-def" }
        });
        let out = video_entry_to_helix_vod(&v).expect("should normalize");
        assert_eq!(out["id"], "kick:abc-123-def");
        assert_eq!(out["title"], "late night grind");
        assert_eq!(out["created_at"], "2026-07-10T20:00:00Z");
        assert_eq!(out["duration"], "3h8m33s");
        assert_eq!(out["thumbnail_url"], "https://cdn/thumb.webp");
        assert_eq!(out["view_count"], 4321);
        assert_eq!(out["platform"], "kick");
    }

    #[test]
    fn channel_video_entry_skips_live_and_uuidless() {
        // The currently-live session's in-progress recording is listed
        // too - a past-broadcasts page must not show it.
        let live = serde_json::json!({
            "session_title": "LIVE now",
            "is_live": true,
            "video": { "uuid": "live-uuid" }
        });
        assert!(video_entry_to_helix_vod(&live).is_none());
        // No recording uuid = nothing playable to offer.
        let no_uuid = serde_json::json!({ "session_title": "broken", "is_live": false });
        assert!(video_entry_to_helix_vod(&no_uuid).is_none());
    }

    #[test]
    fn urlencode_basics() {
        assert_eq!(urlencode("just chatting"), "just%20chatting");
        assert_eq!(urlencode("a-b_c.d~e"), "a-b_c.d~e");
        assert_eq!(urlencode("50% & more"), "50%25%20%26%20more");
    }
}
