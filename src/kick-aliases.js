// kick-aliases.js — Twitch-login -> Kick-slug mapping for the failover
// and offline-entry paths in main.js.
//
// The Kick failover was built on a same-name assumption: Twitch stream
// ends -> check kick.com/<same name>. Plenty of streamers break that
// assumption (zackrawrr on Twitch is asmongold on Kick), and there is
// no reliable automated way to discover the pairing - Kick's channel
// payloads don't state a Twitch identity, and guessing via search
// risks auto-playing a stranger's stream, which is far worse than not
// failing over. So the mapping is explicit and user-set: the "Link
// Kick" control on the Twitch channel info bar writes entries here.
//
// Stored in localStorage as {twitchLogin: kickSlug}, both lowercase.

const STORAGE_KEY = "kickAliases";

function read() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function write(map) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Quota failure - worst case the alias doesn't survive a restart.
  }
}

const SLUG_RE = /^[a-z0-9_-]+$/;

/** The stored Kick slug for a Twitch login, or null if none set. */
export function getKickAlias(twitchLogin) {
  const key = String(twitchLogin || "").toLowerCase();
  return read()[key] || null;
}

/** Set (or clear, with an empty slug) the Kick slug for a Twitch login.
 * @returns {boolean} whether the value was accepted. */
export function setKickAlias(twitchLogin, kickSlug) {
  const key = String(twitchLogin || "").toLowerCase();
  if (!key) return false;
  const map = read();
  const slug = String(kickSlug || "").trim().toLowerCase();
  if (!slug) {
    delete map[key];
    write(map);
    return true;
  }
  if (!SLUG_RE.test(slug)) return false;
  map[key] = slug;
  write(map);
  return true;
}

/** The Kick slug to use for a Twitch login: the alias if one is set,
 * else the login itself (the original same-name behavior). Every Kick
 * lookup keyed by a TWITCH channel name should go through this. */
export function kickSlugFor(twitchLogin) {
  return getKickAlias(twitchLogin) || String(twitchLogin || "").toLowerCase();
}
