// chat/shared.js — small constants and pure helpers used by more than one
// of the chat modules (chat.js itself plus its mixin files in this
// directory). Kept separate rather than duplicated so there's exactly one
// definition of each to keep in sync.

export const SEVENTV_API_BASE = "https://7tv.io/v3";
export const BTTV_API_BASE = "https://api.betterttv.net/3";

// How long the cursor must sit on a link before a preview fetch fires (or
// a cached preview is shown) - see chat-link-preview.js for the reasoning.
export const LINK_PREVIEW_HOVER_DELAY_MS = 400;

// Max recent messages kept per user for the user card's message log -
// matches the card showing only a handful of recent lines, not a full
// transcript (which would need real pagination/storage this app doesn't
// have - see chat-usercard.js for the full reasoning).
export const USER_CARD_HISTORY_LIMIT = 20;

// Matches a bare URL within a single chat word (messages are tokenized
// space-by-space in renderMessageBody, same as emote/cheermote matching,
// so this only ever needs to match a whole word, not find a URL embedded
// in a longer string). Requires an explicit http(s):// or www. prefix -
// deliberately NOT trying to recognize bare "example.com" without either,
// since that pattern matches all sorts of ordinary words/abbreviations
// chat sends entirely unrelated to links (e.g. "nice.try", "rip.bro").
const CHAT_URL_RE = /^(https?:\/\/[^\s]+|www\.[^\s]+\.[a-z]{2,}[^\s]*)$/i;

/** True if `word` looks like a standalone URL per CHAT_URL_RE. */
export function looksLikeUrl(word) {
  return CHAT_URL_RE.test(word);
}

/** Normalizes a matched chat word into a fetchable/clickable URL - adds
 * an https:// prefix for the bare "www.example.com" form, since that form
 * has no scheme of its own and both fetch() and openUrl() need one. */
export function normalizeUrl(word) {
  return /^https?:\/\//i.test(word) ? word : `https://${word}`;
}
