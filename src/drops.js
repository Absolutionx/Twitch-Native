// Drops detection. Drops can't actually progress here (Twitch tracks watch-time
// server-side through its own player), so instead we surface whether the
// broadcaster has Drops enabled and link out to the site to collect. Detected
// from the "DropsEnabled" tag in Helix /streams responses (already fetched);
// matched with spaces/casing stripped as cheap insurance against a variant.

const DROPS_TAG = "dropsenabled";

/**
 * @param {{tags?: string[]}} stream - a raw Helix stream object (or
 *   anything with a `tags` array shaped the same way).
 * @returns {boolean}
 */
export function streamHasDropsEnabled(stream) {
  const tags = stream && Array.isArray(stream.tags) ? stream.tags : [];
  return tags.some(
    (t) => typeof t === "string" && t.toLowerCase().replace(/\s+/g, "") === DROPS_TAG
  );
}
