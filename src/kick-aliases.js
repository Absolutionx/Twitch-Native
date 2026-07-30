// Twitch-login -> Kick-slug mapping for the failover paths in main.js. The
// same-name assumption breaks for many streamers (zackrawrr on Twitch is
// asmongold on Kick) and can't be auto-discovered safely, so the mapping is
// explicit and user-set (the "Link Kick" control). Stored in localStorage as
// {twitchLogin: kickSlug}, lowercase.

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
