// session-restore.js — remember what was playing across a reload.
//
// F5 in a Tauri app reloads the webview and wipes all JS state, dropping
// you back on Home even though the relay (in the Rust host) may still be
// alive. This records just enough to REPLAY the last watch call on the
// next boot, so a reload lands you back in the stream instead of on Home.
//
// It stores only the IDENTITY of what to watch - channel/vod id, platform,
// and which of the four watch entry points to call. Everything else the
// watch functions already recover on their own: currentQuality and
// lowLatency persist via their own localStorage keys, and VOD position
// comes from get_vod_progress. So there's deliberately no playback state
// here to drift out of sync.
//
// "Reload" and "cold start" are intentionally the same path. If the app
// was quit while watching, relaunching also drops you back in - which is
// the behavior you'd want anyway, and avoids a fragile "was this a reload
// or a fresh launch" distinction the webview can't reliably draw.

const KEY = "activeSession";

/**
 * Records the current watch session so the next boot can replay it. Called
 * at the point each watch entry point has committed to playing something.
 *
 * @param {object} s
 * @param {"twitchLive"|"kickLive"|"twitchVod"|"kickVod"} s.kind - which
 *   watch function to replay.
 * @param {string} s.id - channel login (live) or video id (vod).
 * @param {number} [s.vodTotalSeconds] - carried for vod kinds so the
 *   replayed call can render its scrub bar without a refetch; position
 *   itself is NOT stored (get_vod_progress owns that).
 */
export function rememberSession(s) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch (err) {
    // Persistence is a nicety, never load-bearing - a full/blocked
    // localStorage must not break playback.
    console.warn("[session-restore] failed to save session:", err);
  }
}

/** Clears the remembered session. Called on Stop, so an explicit Stop is
 * respected across a reload (you land on Home, as you asked to). */
export function forgetSession() {
  try {
    localStorage.removeItem(KEY);
  } catch (err) {
    console.warn("[session-restore] failed to clear session:", err);
  }
}

/**
 * Replays the remembered session, if any, by handing it to the matching
 * watch function. Called once at boot, after the watch entry points and
 * pages exist.
 *
 * Failures are swallowed to Home: a channel that has since gone offline,
 * a deleted VOD, or malformed storage should degrade to "you're on Home"
 * rather than a broken launch. The watch functions' own error handling
 * (setStatus, page restore) covers the offline-channel case for free.
 *
 * @param {object} watchers - the four entry points, injected to avoid a
 *   circular import with main.js.
 * @returns {boolean} true if a session was replayed. The caller shows
 *   Home up front regardless (the replayed watch call hides it on
 *   success), so this is informational rather than load-bearing.
 */
export function restoreSession(watchers) {
  let s;
  try {
    s = JSON.parse(localStorage.getItem(KEY) || "null");
  } catch {
    return false;
  }
  if (!s || !s.kind || !s.id) return false;

  try {
    switch (s.kind) {
      case "twitchLive":
        watchers.watchChannel(s.id);
        return true;
      case "kickLive":
        watchers.watchKickChannel(s.id);
        return true;
      case "twitchVod":
        // startPositionSecs omitted -> watchVod consults get_vod_progress,
        // exactly as a fresh card click does, so you resume where you left
        // off rather than at 0.
        watchers.watchVod(s.id, s.vodTotalSeconds || 0, s.broadcastLogin || "");
        return true;
      case "kickVod":
        watchers.watchKickVod(s.id, s.vodTotalSeconds || 0);
        return true;
      default:
        return false;
    }
  } catch (err) {
    console.warn("[session-restore] failed to replay session:", err);
    return false;
  }
}
