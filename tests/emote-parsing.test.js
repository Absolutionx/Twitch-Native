// Tests for src/chat/emote-parsing.js - the pure parsing core of the
// chat pipeline. Runs with Node's built-in runner (`npm test`), no
// dependencies, no webview. These functions are where rendering
// regressions actually come from (a wrong offset or tier renders every
// message wrong), and being pure they're cheap to pin down exactly.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseTwitchEmotesTag,
  parseCheermoteWord,
  parseKickEmoteMarker,
  pickEmoteUrl,
  reconstructVodMessage,
  EMOTE_PROVIDER_PRIORITY,
  isChannelProvider,
} from "../src/chat/emote-parsing.js";

// ---------------------------------------------------------------- //
// parseTwitchEmotesTag
// ---------------------------------------------------------------- //

test("emotes tag: single emote, single range", () => {
  const msg = "Kappa hello";
  const map = parseTwitchEmotesTag(msg, "25:0-4");
  assert.equal(map.size, 1);
  assert.deepEqual(map.get(0), { id: "25", word: "Kappa" });
});

test("emotes tag: one emote used twice (comma ranges)", () => {
  const msg = "Kappa mid Kappa";
  const map = parseTwitchEmotesTag(msg, "25:0-4,10-14");
  assert.deepEqual(map.get(0),  { id: "25", word: "Kappa" });
  assert.deepEqual(map.get(10), { id: "25", word: "Kappa" });
});

test("emotes tag: multiple emotes (slash-separated)", () => {
  const msg = "Kappa PogChamp";
  const map = parseTwitchEmotesTag(msg, "25:0-4/305954156:6-13");
  assert.deepEqual(map.get(0), { id: "25", word: "Kappa" });
  assert.deepEqual(map.get(6), { id: "305954156", word: "PogChamp" });
});

test("emotes tag: null/empty tag yields empty map", () => {
  assert.equal(parseTwitchEmotesTag("hello", null).size, 0);
  assert.equal(parseTwitchEmotesTag("hello", "").size, 0);
});

test("emotes tag: malformed pieces are skipped, valid ones kept", () => {
  const msg = "Kappa hello";
  // missing colon part, garbage range, then a valid entry
  const map = parseTwitchEmotesTag(msg, "nonsense/25:zz-4,0-4");
  assert.equal(map.size, 1);
  assert.deepEqual(map.get(0), { id: "25", word: "Kappa" });
});

test("emotes tag: emote ids can contain non-numeric chars (emotesv2_)", () => {
  const msg = "catJAM";
  const map = parseTwitchEmotesTag(msg, "emotesv2_abc123:0-5");
  assert.deepEqual(map.get(0), { id: "emotesv2_abc123", word: "catJAM" });
});

// ---------------------------------------------------------------- //
// parseCheermoteWord
// ---------------------------------------------------------------- //

// prefix -> tiers sorted DESCENDING by minBits, as ingestCheermotes builds
const cheermoteMap = new Map([
  ["cheer", [
    { minBits: 10000, color: "red" },
    { minBits: 5000,  color: "blue" },
    { minBits: 1000,  color: "green" },
    { minBits: 100,   color: "purple" },
    { minBits: 1,     color: "gray" },
  ]],
]);

test("cheermote: picks highest applicable tier", () => {
  assert.equal(parseCheermoteWord("Cheer100", cheermoteMap).tier.color, "purple");
  assert.equal(parseCheermoteWord("Cheer999", cheermoteMap).tier.color, "purple");
  assert.equal(parseCheermoteWord("Cheer1000", cheermoteMap).tier.color, "green");
  assert.equal(parseCheermoteWord("Cheer25000", cheermoteMap).tier.color, "red");
});

test("cheermote: prefix match is case-insensitive, amount parsed", () => {
  const r = parseCheermoteWord("cHeEr50", cheermoteMap);
  assert.equal(r.amount, 50);
  assert.equal(r.tier.color, "gray");
});

test("cheermote: rejects non-cheermotes", () => {
  assert.equal(parseCheermoteWord("Cheer", cheermoteMap), null);      // no amount
  assert.equal(parseCheermoteWord("Cheer0", cheermoteMap), null);     // zero
  assert.equal(parseCheermoteWord("Cheerio100x", cheermoteMap), null); // trailing junk
  assert.equal(parseCheermoteWord("hello", cheermoteMap), null);
});

// ---------------------------------------------------------------- //
// pickEmoteUrl
// ---------------------------------------------------------------- //

test("pickEmoteUrl: prefers 2x.webp by name", () => {
  const host = { url: "//cdn.7tv.app/emote/abc", files: [
    { name: "1x.avif", format: "AVIF" },
    { name: "2x.webp", format: "WEBP" },
    { name: "4x.webp", format: "WEBP" },
  ]};
  assert.equal(pickEmoteUrl(host), "https://cdn.7tv.app/emote/abc/2x.webp");
});

test("pickEmoteUrl: falls back to any WEBP, then files[0]", () => {
  const anyWebp = { url: "//cdn.7tv.app/emote/abc", files: [
    { name: "1x.avif", format: "AVIF" },
    { name: "3x.webp", format: "WEBP" },
  ]};
  assert.equal(pickEmoteUrl(anyWebp), "https://cdn.7tv.app/emote/abc/3x.webp");
  const noWebp = { url: "//cdn.7tv.app/emote/abc", files: [
    { name: "1x.avif", format: "AVIF" },
  ]};
  assert.equal(pickEmoteUrl(noWebp), "https://cdn.7tv.app/emote/abc/1x.avif");
});

test("pickEmoteUrl: empty files guesses 2x.webp; protocol-relative gets https", () => {
  assert.equal(pickEmoteUrl({ url: "//cdn.7tv.app/emote/abc", files: [] }),
               "https://cdn.7tv.app/emote/abc/2x.webp");
  assert.equal(pickEmoteUrl({ url: "https://cdn.7tv.app/emote/abc" }),
               "https://cdn.7tv.app/emote/abc/2x.webp");
});

test("pickEmoteUrl: missing host or url yields null", () => {
  assert.equal(pickEmoteUrl(null), null);
  assert.equal(pickEmoteUrl({}), null);
  assert.equal(pickEmoteUrl({ files: [{ name: "2x.webp" }] }), null);
});

// ---------------------------------------------------------------- //
// reconstructVodMessage
// ---------------------------------------------------------------- //

test("vod fragments: text-only message has null emotesTag", () => {
  const r = reconstructVodMessage([{ text: "hello " }, { text: "world" }]);
  assert.equal(r.body, "hello world");
  assert.equal(r.emotesTag, null);
});

test("vod fragments: emote positions become id:start-end entries", () => {
  const r = reconstructVodMessage([
    { text: "hi " },
    { text: "Kappa", emote: { emoteID: "25" } },
    { text: " bye " },
    { text: "PogChamp", emote: { emoteID: "88" } },
  ]);
  assert.equal(r.body, "hi Kappa bye PogChamp");
  assert.equal(r.emotesTag, "25:3-7/88:13-20");
  // and the produced tag round-trips through the live-chat parser
  const map = parseTwitchEmotesTag(r.body, r.emotesTag);
  assert.deepEqual(map.get(3),  { id: "25", word: "Kappa" });
  assert.deepEqual(map.get(13), { id: "88", word: "PogChamp" });
});

test("vod fragments: empty/missing input yields empty body", () => {
  assert.deepEqual(reconstructVodMessage([]), { body: "", emotesTag: null });
  assert.deepEqual(reconstructVodMessage(undefined), { body: "", emotesTag: null });
});

// ---------------------------------------------------------------- //
// provider precedence
// ---------------------------------------------------------------- //

test("provider priority: channel beats global, 7tv > bttv > ffz within a tier", () => {
  const p = EMOTE_PROVIDER_PRIORITY;
  assert.ok(p["ffz-channel"] > p["seventv-global"], "any channel emote beats any global");
  assert.ok(p["seventv-channel"] > p["bttv-channel"] && p["bttv-channel"] > p["ffz-channel"]);
  assert.ok(p["seventv-global"] > p["bttv-global"] && p["bttv-global"] > p["ffz-global"]);
});

test("isChannelProvider distinguishes the tiers", () => {
  assert.ok(isChannelProvider("seventv-channel"));
  assert.ok(isChannelProvider("ffz-channel"));
  assert.ok(!isChannelProvider("seventv-global"));
  assert.ok(!isChannelProvider(undefined));
});

// ---------------------------------------------------------------- //
// parseKickEmoteMarker
// ---------------------------------------------------------------- //

test("parseKickEmoteMarker: matches the \\x01id\\x01name\\x01 format kick_chat.rs emits", () => {
  assert.deepEqual(parseKickEmoteMarker("\u000137226\u0001KEKW\u0001"), {
    id: "37226",
    name: "KEKW",
  });
});

test("parseKickEmoteMarker: cross-channel emote ids resolve the same as native ones", () => {
  // The whole point of carrying the id is that it works regardless of
  // whether this app ever fetched the owning channel's emote set.
  assert.deepEqual(parseKickEmoteMarker("\u00019999999\u0001SomeOtherChannelsEmote\u0001"), {
    id: "9999999",
    name: "SomeOtherChannelsEmote",
  });
});

test("parseKickEmoteMarker: rejects plain words and malformed markers", () => {
  assert.equal(parseKickEmoteMarker("KEKW"), null);
  assert.equal(parseKickEmoteMarker(""), null);
  assert.equal(parseKickEmoteMarker("\u0001onlyoneseparator"), null);
  assert.equal(parseKickEmoteMarker("\u0001notanumber\u0001KEKW\u0001"), null);
  assert.equal(parseKickEmoteMarker("\u0001123\u0001\u0001"), null); // empty name
});
