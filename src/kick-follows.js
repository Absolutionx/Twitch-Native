// kick-follows.js — the local follow list behind Kick mode's sidebar
// "Following" section and the channel info bar's Follow toggle.
//
// LOCAL by necessity, not by choice: Kick's real followed-channels
// endpoint (api/v1/channels/followed) authenticates with the SITE
// session cookie from a browser login. The OAuth app token this app's
// Kick login produces is a different credential entirely and is not
// accepted there, so the user's actual kick.com follow list is simply
// unreachable from here. What IS achievable is the same experience with
// an app-side list: Follow on a channel pins it, the sidebar shows the
// pinned channels with live/offline state (kick_followed_status in
// kick.rs answers "which are live"), Following again unpins.
//
// Stored in localStorage (fine in Tauri's webview, persists per-app) as
// an array of {slug, name, avatar} - name/avatar are cached at
// follow-time so an offline (or lookup-failed) channel still renders a
// recognizable row instead of a bare slug next to a blank circle.

const STORAGE_KEY = "kickFollows";

const listeners = new Set();

function read() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(raw)
      ? raw.filter((f) => f && typeof f.slug === "string" && f.slug)
      : [];
  } catch {
    return [];
  }
}

function write(follows) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(follows));
  } catch {
    // Quota/serialization failure - the in-memory notify below still
    // lets this session behave correctly.
  }
  for (const cb of listeners) {
    try {
      cb();
    } catch (err) {
      console.error("[kick-follows] change listener failed:", err);
    }
  }
}

/** @returns {{slug: string, name: string, avatar: string}[]} */
export function getKickFollows() {
  return read();
}

export function isKickFollowed(slug) {
  const s = String(slug || "").toLowerCase();
  return read().some((f) => f.slug === s);
}

/** Follow if not followed, unfollow if followed. `meta` ({name, avatar})
 * is only used on the follow half, to seed the cached row data.
 * @returns {boolean} the NEW followed state. */
export function toggleKickFollow(slug, meta = {}) {
  const s = String(slug || "").toLowerCase();
  if (!s) return false;
  const follows = read();
  const idx = follows.findIndex((f) => f.slug === s);
  if (idx >= 0) {
    follows.splice(idx, 1);
    write(follows);
    return false;
  }
  follows.push({
    slug: s,
    name: meta.name || s,
    avatar: meta.avatar || "",
  });
  write(follows);
  return true;
}

/** Subscribe to any change to the follow list (fired AFTER the write).
 * Used by the sidebar to re-render when the info bar's button toggles. */
export function onKickFollowsChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
