// Drops detection helper.
//
// This app plays streams through a local streamlink relay feeding an
// in-DOM <video> element instead of the official Twitch player. Drops
// tracks qualifying watch-time entirely server-side, keyed to sessions
// opened through Twitch's own client surfaces - there's no public API
// for a third party to register watch-time, so drops silently never
// progress here no matter how long someone watches. Rather than let
// that fail invisibly, every place a stream is shown surfaces whether
// the broadcaster currently has Drops enabled, and the player banner
// (see main.js) links out to the real site to actually collect it.
//
// Detection: Helix's /helix/streams responses include a `tags` array,
// and Twitch populates it with a "DropsEnabled" tag (no space - the
// literal value Helix returns, confirmed against a live stream showing
// the official site's purple "DropsEnabled" pill) whenever the
// broadcaster has active drops campaigns for their current category. No
// extra Helix call is needed; the existing get_top_live_streams /
// get_streams_for_* responses already carry this.
//
// Matched with spaces/casing stripped rather than an exact literal, in
// case Twitch ever renders it with a space ("Drops Enabled") elsewhere -
// cheap insurance against the exact mismatch that caused this to
// silently never match in the first place.

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
