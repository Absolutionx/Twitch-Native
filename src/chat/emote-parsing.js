// emote-parsing.js — pure, dependency-free emote parsing helpers.
//
// These are the testable core of chat-emotes.js and chat-vod-replay.js:
// no DOM, no tauri, no fetch, no `this`. Keeping them here (rather than
// as mixin methods) is what lets tests/emote-parsing.test.js run them
// under plain `node --test` without a webview or a mock of
// @tauri-apps/api - regressions in exactly this parsing logic have
// bitten before (native emote offsets, cheermote tiers), so it's the
// highest-value code in the app to pin down with tests. The mixins wrap
// these where a `this`-bound method is the convenient call shape.

/** Parses the IRC @emotes tag into a Map<charStart, {id, word}>.
 * Format: "id:start-end,start-end/id2:start-end"
 * Twitch sends native emote positions as character offsets into the message. */
export function parseTwitchEmotesTag(message, emotesTag) {
  const map = new Map();
  if (!emotesTag) return map;
  for (const part of emotesTag.split("/")) {
    const colonIdx = part.indexOf(":");
    if (colonIdx === -1) continue;
    const id = part.slice(0, colonIdx);
    const ranges = part.slice(colonIdx + 1);
    for (const range of ranges.split(",")) {
      const dashIdx = range.indexOf("-");
      if (dashIdx === -1) continue;
      const start = parseInt(range.slice(0, dashIdx), 10);
      const end   = parseInt(range.slice(dashIdx + 1), 10);
      if (isNaN(start) || isNaN(end)) continue;
      map.set(start, { id, word: message.slice(start, end + 1) });
    }
  }
  return map;
}

/**
 * Tries to parse a word as a cheermote (e.g. "Cheer100", "PogChamp1000")
 * against a prepared cheermote map (prefix -> tiers sorted descending by
 * minBits, as ingestCheermotes builds it).
 * Returns { amount, tier } if matched, null otherwise. Tiers being
 * sorted descending is what makes Array.find yield the highest
 * applicable tier (matching Twitch's own behavior).
 */
export function parseCheermoteWord(word, cheermoteMap) {
  const lower = word.toLowerCase();
  for (const [prefix, tiers] of cheermoteMap) {
    if (!lower.startsWith(prefix)) continue;
    const amountStr = word.slice(prefix.length);
    if (!/^\d+$/.test(amountStr)) continue;
    const amount = parseInt(amountStr, 10);
    if (amount <= 0) continue;
    const tier = tiers.find(t => amount >= t.minBits);
    if (tier) return { amount, tier };
  }
  return null;
}

/**
 * Parses one whitespace-delimited "word" as a Kick native-emote marker
 * produced by kick_chat.rs's flatten_emote_tokens: `\x01{id}\x01{name}\x01`.
 * Returns { id, name } if `word` is exactly one such marker, null
 * otherwise. \x01 (SOH) can't appear in a Kick display name or be typed
 * in the chat input, so it can't collide with real message text.
 *
 * The id is carried instead of just the name specifically so a message
 * using a Kick subscriber's cross-channel emote (Kick lets you use any
 * channel you're subscribed to's emotes, not just the one you're
 * watching) still renders correctly - looking the name up in this app's
 * locally-fetched per-channel emote map would miss it, since that map
 * only ever holds the currently-watched channel's set.
 */
export function parseKickEmoteMarker(word) {
  const SEP = "\u0001";
  if (!word.startsWith(SEP) || !word.endsWith(SEP) || word.length < 3) return null;
  const body = word.slice(1, -1);
  const sepIdx = body.indexOf(SEP);
  if (sepIdx === -1) return null;
  const id = body.slice(0, sepIdx);
  const name = body.slice(sepIdx + 1);
  if (!/^\d+$/.test(id) || name.length === 0) return null;
  return { id, name };
}

/** Picks the best available CDN file from a 7TV emote's host.files list. */
export function pickEmoteUrl(host) {
  if (!host || !host.url) return null;
  const base = host.url.startsWith("http") ? host.url : `https:${host.url}`;
  if (Array.isArray(host.files) && host.files.length > 0) {
    const preferred =
      host.files.find((f) => f.name === "2x.webp") ||
      host.files.find((f) => f.format === "WEBP") ||
      host.files[0];
    return `${base}/${preferred.name}`;
  }
  return `${base}/2x.webp`;
}

/**
 * Reconstructs both the plain-text body AND a Twitch emotes tag from a
 * VOD GQL comment's message fragments. Each fragment is either plain
 * text or an emote reference (f.emote.emoteID). Plain-text fragments
 * just advance the character position; emote fragments produce an
 * "id:start-end" entry that renderMessageBody consumes exactly like the
 * IRC `emotes` tag from live chat.
 * Returns { body, emotesTag } where emotesTag is null when the message
 * contains no emotes.
 */
export function reconstructVodMessage(fragments) {
  let body = "";
  const emoteParts = [];
  for (const f of (fragments || [])) {
    const text = f.text || "";
    const start = body.length;
    body += text;
    if (f.emote?.emoteID) {
      emoteParts.push(`${f.emote.emoteID}:${start}-${body.length - 1}`);
    }
  }
  return { body, emotesTag: emoteParts.length > 0 ? emoteParts.join("/") : null };
}

/**
 * Third-party emote provider precedence, highest first. Channel-level
 * emotes always beat globals (a channel deliberately choosing an emote
 * name should win over a same-named global), and within each level the
 * order mirrors how mainstream chat clients resolve collisions
 * (7TV > BTTV > FFZ). Used by _setEmote in chat-emotes.js to make name
 * collisions deterministic instead of last-fetch-wins - previously all
 * six loaders were fire-and-forget into one shared Map, so whichever
 * provider's network request happened to resolve LAST won, and the same
 * channel could render a contested name differently between two
 * sessions.
 */
export const EMOTE_PROVIDER_PRIORITY = {
  // Kick-native channel emotes outrank everything: a flattened
  // [emote:...] token in a Kick message was, by construction, THAT
  // emote when the sender picked it, so a same-named 7TV emote must not
  // repaint it. These two providers are only ever populated in Kick
  // chat (loadKickNativeEmotes), so Twitch sessions are unaffected.
  "kick-channel":    7,
  "seventv-channel": 6,
  "bttv-channel":    5,
  "ffz-channel":     4,
  "seventv-global":  3,
  "bttv-global":     2,
  "ffz-global":      1,
  // Kick's site-wide Global/Emoji sets rank last: baseline art that any
  // deliberate third-party override should beat.
  "kick-global":     0,
};

/** True when `provider` names a channel-level (not global) emote source. */
export function isChannelProvider(provider) {
  return provider === "seventv-channel"
      || provider === "bttv-channel"
      || provider === "ffz-channel"
      || provider === "kick-channel";
}
