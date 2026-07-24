// chat-emotes.js — part of TwitchChat (see ../chat.js). Emote loading, parsing, rendering, and the emote autocomplete popup (Twitch/BTTV/7TV).
//
// This is a mixin, not a standalone class: chat.js does
// `Object.assign(TwitchChat.prototype, chatEmotesMixin)` after the class
// body, so every method here runs with the same `this` (container, ws,
// caches, etc.) as methods still defined directly in chat.js. Methods are
// grouped into files by feature area purely for readability — there is no
// behavioral difference from having them all in one file.
import { invoke } from "@tauri-apps/api/core";
import { SEVENTV_API_BASE, BTTV_API_BASE } from "./shared.js";
import {
  parseTwitchEmotesTag,
  parseCheermoteWord,
  parseKickEmoteMarker,
  pickEmoteUrl,
  EMOTE_PROVIDER_PRIORITY,
  isChannelProvider,
} from "./emote-parsing.js";

export const chatEmotesMixin = {
  /** See emote-parsing.js - kept as methods so render code can keep
   * calling this.parseTwitchEmotesTag() etc. unchanged. */
  parseTwitchEmotesTag(message, emotesTag) {
    return parseTwitchEmotesTag(message, emotesTag);
  },

  /** See parseCheermoteWord in emote-parsing.js. */
  parseCheermote(word) {
    return parseCheermoteWord(word, this.cheermoteMap);
  },

  /** See parseKickEmoteMarker in emote-parsing.js. */
  parseKickEmoteMarker(word) {
    return parseKickEmoteMarker(word);
  },

  /** See emote-parsing.js. */
  pickEmoteUrl(host) {
    return pickEmoteUrl(host);
  },

  /**
   * Single write-path for every third-party emote (7TV/BTTV/FFZ, global
   * and channel) into this.sevenTvEmotes. Applies the fixed provider
   * precedence from EMOTE_PROVIDER_PRIORITY (see its declaration for
   * the ordering rationale) so a name collision between providers
   * resolves the same way every session, instead of by whichever
   * fire-and-forget fetch happened to finish last. A same-provider
   * write always goes through - that's a reload or a live update of
   * the provider's own emote, not a collision.
   */
  _setEmote(name, entry, provider) {
    const existing = this.sevenTvEmotes.get(name);
    if (existing && existing.provider !== provider &&
        (EMOTE_PROVIDER_PRIORITY[provider] ?? 0) < (EMOTE_PROVIDER_PRIORITY[existing.provider] ?? 0)) {
      return; // a higher-priority provider already owns this name
    }
    this.sevenTvEmotes.set(name, { ...entry, provider });
  },

  /** Removes channel-level emotes (all providers) while keeping globals.
   * connect() does a full sevenTvEmotes.clear() on every live channel
   * switch, but setVodMode() only ever goes through disconnect(), which
   * doesn't - so a VOD opened after watching a live channel silently
   * kept that channel's emotes and rendered them in the (unrelated)
   * VOD's chat. Globals are intentionally kept: they're channel-
   * independent, and the VOD path re-fetches them anyway (idempotent). */
  _clearChannelEmotes() {
    for (const [name, entry] of this.sevenTvEmotes) {
      if (isChannelProvider(entry.provider)) this.sevenTvEmotes.delete(name);
    }
  },

  async loadSevenTvGlobalEmotes() {
    try {
      const res = await fetch(`${SEVENTV_API_BASE}/emote-sets/global`);
      if (!res.ok) {
        console.warn("[7tv] Global emote-set fetch failed:", res.status);
        return;
      }
      const data = await res.json();
      const countBefore = this.sevenTvEmotes.size;
      this.ingestEmoteSet(data, "seventv-global");
      console.log(`Loaded ${this.sevenTvEmotes.size - countBefore} 7TV global emotes.`);
    } catch (err) {
      console.warn("Failed to load 7TV global emotes:", err);
    }
  },

  async loadSevenTvChannelEmotes(twitchUserId) {
    try {
      const res = await fetch(`${SEVENTV_API_BASE}/users/twitch/${twitchUserId}`);
      if (!res.ok) {
        if (res.status === 404) {
          // Informational, not a warning - most commonly this channel
          // genuinely has no 7TV profile set up, which is normal. Logged
          // (rather than fully silent, which this used to be) so a
          // channel emote not rendering can be told apart from "no 7TV
          // profile" vs some other, actually-wrong failure mode, without
          // needing to guess.
          console.log(`[7tv] No 7TV profile for user id ${twitchUserId} (404) - channel likely hasn't set one up.`);
        } else {
          console.warn("7TV channel lookup failed:", res.status);
        }
        return;
      }
      const data = await res.json();
      if (data.emote_set) {
        this.ingestEmoteSet(data.emote_set, "seventv-channel");
        this.systemLine(`Loaded ${data.emote_set.emotes?.length ?? 0} 7TV emotes for this channel.`);
        // Subscribe to this specific emote set's changes so additions/
        // removals made mid-stream (e.g. a temporary channel-points-
        // unlocked emote) show up live, instead of only ever reflecting
        // whatever the set looked like at the moment this fetch ran -
        // see seventv_events.rs and the seventv-emote-set-update
        // listener in setupListeners() below for the rest of this flow.
        // data.emote_set.id is the SET's own id (distinct from
        // twitchUserId, which is what we looked up BY) - that's what
        // 7TV's EventAPI subscription needs as its object_id.
        if (data.emote_set.id) {
          invoke("start_seventv_events", { emoteSetId: data.emote_set.id }).catch((err) => {
            console.warn("Failed to start 7TV live emote updates:", err);
          });
        }
      } else {
        console.log(`[7tv] User id ${twitchUserId} has a 7TV profile but no emote_set in the response:`, JSON.stringify(data));
      }
    } catch (err) {
      console.warn("Failed to load 7TV channel emotes:", err);
    }
  },

  /** 7TV channel emotes for a KICK channel. 7TV supports Kick as a
   * first-class platform connection - same lookup shape as the Twitch
   * one above, just /users/kick/{kick user id} instead of
   * /users/twitch/{twitch user id}. The id is the broadcaster's Kick
   * USER id (KickLiveInfo.broadcaster_user_id), which is what 7TV keys
   * Kick connections on. BTTV and FFZ have no Kick support at all, so
   * there are deliberately no Kick counterparts for those two - their
   * GLOBAL sets still load in Kick chat (connectKick), since global
   * emote usage is platform-independent muscle memory. */
  async loadSevenTvKickChannelEmotes(kickUserId) {
    try {
      const res = await fetch(`${SEVENTV_API_BASE}/users/kick/${kickUserId}`);
      if (!res.ok) {
        if (res.status === 404) {
          console.log(`[7tv] No 7TV profile for Kick user id ${kickUserId} (404) - channel likely hasn't linked Kick on 7TV.`);
        } else {
          console.warn("7TV Kick channel lookup failed:", res.status);
        }
        return;
      }
      const data = await res.json();
      if (data.emote_set) {
        this.ingestEmoteSet(data.emote_set, "seventv-channel");
        this.systemLine(`Loaded ${data.emote_set.emotes?.length ?? 0} 7TV emotes for this channel.`);
        // Same live-update subscription as the Twitch loader - the
        // EventAPI is keyed on the SET id, which is platform-agnostic.
        if (data.emote_set.id) {
          invoke("start_seventv_events", { emoteSetId: data.emote_set.id }).catch((err) => {
            console.warn("Failed to start 7TV live emote updates:", err);
          });
        }
      } else {
        console.log(`[7tv] Kick user id ${kickUserId} has a 7TV profile but no emote_set in the response.`);
      }
    } catch (err) {
      console.warn("Failed to load 7TV Kick channel emotes:", err);
    }
  },

  /** The channel's NATIVE Kick emotes (its own set + Kick's Global and
   * Emoji sets, fetched via Rust - kick.com is Cloudflare-fronted, so
   * no plain fetch() from the webview). kick_chat.rs flattens inline
   * [emote:id:name] tokens to bare names; ingesting name -> CDN-url
   * entries here is what turns those names back into images in the
   * exact same render path every other provider uses (autocomplete
   * included, for free). */
  async loadKickNativeEmotes(slug) {
    try {
      const emotes = JSON.parse(await invoke("kick_channel_emotes", { slug }));
      let channelCount = 0;
      let globalCount = 0;
      for (const e of emotes) {
        if (!e?.id || !e?.name) continue;
        const url = `https://files.kick.com/emotes/${e.id}/fullsize`;
        this._setEmote(e.name, { url, zeroWidth: false }, e.global ? "kick-global" : "kick-channel");
        if (e.global) globalCount++;
        else channelCount++;
      }
      if (channelCount > 0) this.systemLine(`Loaded ${channelCount} Kick emotes for this channel.`);
      if (globalCount > 0) console.log(`Loaded ${globalCount} Kick global emotes.`);
    } catch (err) {
      console.warn("Failed to load Kick native emotes:", err);
    }
  },

  async loadBttvGlobalEmotes() {
    try {
      const res = await fetch(`${BTTV_API_BASE}/cached/emotes/global`);
      if (!res.ok) return;
      const emotes = await res.json();
      let count = 0;
      for (const emote of emotes) {
        // BTTV CDN: https://cdn.betterttv.net/emote/<id>/2x.<ext>
        const ext = emote.imageType || "png";
        const url = `https://cdn.betterttv.net/emote/${emote.id}/2x.${ext}`;
        this._setEmote(emote.code, { url, zeroWidth: false }, "bttv-global");
        count++;
      }
      console.log(`Loaded ${count} BTTV global emotes.`);
    } catch (err) {
      console.warn("Failed to load BTTV global emotes:", err);
    }
  },

  /** Fetches the channel's BTTV emotes (channelEmotes + sharedEmotes).
   * Same numeric-Twitch-user-id requirement as loadSevenTvChannelEmotes.
   * 404 is normal - it just means the channel has no BTTV page at all. */
  async loadBttvChannelEmotes(twitchUserId) {
    try {
      const res = await fetch(`${BTTV_API_BASE}/cached/users/twitch/${twitchUserId}`);
      if (!res.ok) {
        if (res.status === 404) {
          console.log(`[bttv] No BTTV user for id ${twitchUserId} (404) - channel likely has no BTTV emotes.`);
        } else {
          console.warn("BTTV channel lookup failed:", res.status);
        }
        return;
      }
      const data = await res.json();
      const emotes = [...(data.channelEmotes || []), ...(data.sharedEmotes || [])];
      let count = 0;
      for (const emote of emotes) {
        if (!emote?.id || !emote?.code) continue;
        const ext = emote.imageType || "png";
        const url = `https://cdn.betterttv.net/emote/${emote.id}/2x.${ext}`;
        this._setEmote(emote.code, { url, zeroWidth: false }, "bttv-channel");
        count++;
      }
      if (count > 0) this.systemLine(`Loaded ${count} BTTV emotes for this channel.`);
    } catch (err) {
      console.warn("Failed to load BTTV channel emotes:", err);
    }
  },

  /** Shared ingest for BTTV's cached FrankerFaceZ endpoints (global and
   * per-channel), which return FFZ emotes in a BTTV-like flat array:
   * [{ id, code, images: { "1x": url, "2x": url|null, "4x": url|null } }].
   * Using BTTV's mirror instead of api.frankerfacez.com keeps all
   * third-party emote traffic on the one API base already known to work
   * from the webview. 2x/4x can be null for small emotes, so fall
   * through the sizes. Returns how many emotes were ingested. */
  _ingestFfzEmotes(emotes, provider) {
    let count = 0;
    for (const emote of emotes || []) {
      const images = emote?.images || {};
      const url = images["2x"] || images["4x"] || images["1x"];
      if (!url || !emote.code) continue;
      this._setEmote(emote.code, { url, zeroWidth: false }, provider);
      count++;
    }
    return count;
  },

  /** Fetches FrankerFaceZ GLOBAL emotes via BTTV's cached FFZ mirror.
   * FFZ was previously not loaded at all (neither global nor channel),
   * which is why extremely common FFZ emotes rendered as plain text -
   * the confirmed root cause of LOLW/KEKW showing as bare names in
   * quin69's chat: both are FFZ *channel* emotes there, a provider this
   * app never consulted. */
  async loadFfzGlobalEmotes() {
    try {
      const res = await fetch(`${BTTV_API_BASE}/cached/frankerfacez/emotes/global`);
      if (!res.ok) {
        console.warn("[ffz] Global emote fetch failed:", res.status);
        return;
      }
      const count = this._ingestFfzEmotes(await res.json(), "ffz-global");
      console.log(`Loaded ${count} FFZ global emotes.`);
    } catch (err) {
      console.warn("Failed to load FFZ global emotes:", err);
    }
  },

  /** Fetches the channel's FrankerFaceZ emotes via BTTV's cached FFZ
   * mirror. Same numeric-id requirement and 404-is-normal semantics as
   * the other channel loaders. */
  async loadFfzChannelEmotes(twitchUserId) {
    try {
      const res = await fetch(`${BTTV_API_BASE}/cached/frankerfacez/users/twitch/${twitchUserId}`);
      if (!res.ok) {
        if (res.status === 404) {
          console.log(`[ffz] No FFZ room for id ${twitchUserId} (404) - channel likely has no FFZ emotes.`);
        } else {
          console.warn("FFZ channel lookup failed:", res.status);
        }
        return;
      }
      const count = this._ingestFfzEmotes(await res.json(), "ffz-channel");
      if (count > 0) this.systemLine(`Loaded ${count} FFZ emotes for this channel.`);
    } catch (err) {
      console.warn("Failed to load FFZ channel emotes:", err);
    }
  },

  /** Fetches Twitch's own global emotes (Kappa, PogChamp, LUL, etc.) via Rust -
   * same WebView2 cross-origin issue as badges/cheermotes, so api.twitch.tv
   * can't be hit with a plain fetch() from here. Populates twitchNativeEmotes,
   * which renderMessageBody() falls back to when a message lacks an IRC
   * emotes tag, and which the autocomplete popup also searches. */
  async loadTwitchGlobalEmotes() {
    try {
      const json = await invoke("fetch_global_emotes");
      const data = JSON.parse(json);
      let count = 0;
      for (const emote of data.data ?? []) {
        const images = emote.images || {};
        const url = images.url_4x || images.url_2x || images.url_1x;
        if (!url) continue;
        this.twitchNativeEmotes.set(emote.name, { id: emote.id, url });
        count++;
      }
      console.log(`Loaded ${count} Twitch global emotes.`);
    } catch (err) {
      console.warn("Failed to load Twitch global emotes:", err);
    }
  },

  /**
   * Parses the Helix /bits/cheermotes response into cheermoteMap.
   * Helix shape: { data: [{ prefix, tiers: [{ min_bits, color, images, can_cheer }] }] }
   * We prefer dark/animated/2x images to match the app's dark theme.
   */
  ingestCheermotes(data) {
    if (!Array.isArray(data?.data)) return;
    for (const cheermote of data.data) {
      const prefix = cheermote.prefix?.toLowerCase();
      if (!prefix) continue;
      const tiers = (cheermote.tiers || [])
        .filter(t => t.can_cheer)
        .map(t => ({
          minBits: t.min_bits,
          color:   t.color || "#9147ff",
          url:     t.images?.dark?.animated?.["2"]
                || t.images?.dark?.animated?.["1"]
                || t.images?.dark?.static?.["2"]
                || t.images?.dark?.static?.["1"]
                || "",
        }))
        .filter(t => t.url)
        .sort((a, b) => b.minBits - a.minBits); // descending - see parseCheermote
      if (tiers.length) this.cheermoteMap.set(prefix, tiers);
    }
  },

  /** Re-evaluate the current input word and show/hide the emote popup. */
  _updateEmotePopup() {
    const { word } = this._currentEmoteWord();
    // Trigger on any word of 2+ characters starting with a non-space char.
    if (!word || word.length < 2) {
      this._hideEmotePopup();
      return;
    }
    const lower = word.toLowerCase();
    // Collect all emote names that contain the typed fragment (case-insensitive),
    // prioritising prefix matches, capped at 12 so the popup stays compact.
    // Same platform gate as the picker (_collectEmotePickerBuckets):
    // Twitch's native globals aren't suggestable in a Kick chat - they
    // don't exist on Kick, so committing one would just send text that
    // renders unresolved for everyone else.
    const all = this._isKickChat
      ? [...this.sevenTvEmotes.keys()]
      : [...this.sevenTvEmotes.keys(), ...this.twitchNativeEmotes.keys()];
    const prefix = all.filter(n => n.toLowerCase().startsWith(lower));
    const contains = all.filter(n =>
      !n.toLowerCase().startsWith(lower) && n.toLowerCase().includes(lower));
    const matches = [...prefix, ...contains].slice(0, 12);

    if (matches.length === 0) {
      this._hideEmotePopup();
      return;
    }
    this._showEmotePopup(matches);
  },

  /**
   * Returns { word, wordStart, wordEnd } for the word under the cursor,
   * or { word: "", wordStart: 0, wordEnd: 0 } if cursor is on whitespace.
   */
  _currentEmoteWord() {
    const input = this.inputEl;
    if (!input) return { word: "", wordStart: 0, wordEnd: 0 };
    const pos = input.selectionStart ?? input.value.length;
    const val = input.value;
    let start = pos;
    while (start > 0 && val[start - 1] !== " ") start--;
    let end = pos;
    while (end < val.length && val[end] !== " ") end++;
    const word = val.slice(start, end);
    return { word, wordStart: start, wordEnd: end };
  },

  _showEmotePopup(names) {
    const popup = this._emotePopup;
    popup.innerHTML = "";
    this._emotePopupIndex = -1;

    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      const emote = this.sevenTvEmotes.get(name);
      const twitchEmote = !emote ? this.twitchNativeEmotes.get(name) : null;
      const item = document.createElement("div");
      item.className = "emote-autocomplete-item";
      item.dataset.name = name;

      if (emote) {
        const img = document.createElement("img");
        img.src = emote.url;
        img.alt = name;
        img.className = "emote-autocomplete-img";
        item.appendChild(img);
      } else if (twitchEmote) {
        const img = document.createElement("img");
        img.src = twitchEmote.url;
        img.alt = name;
        img.className = "emote-autocomplete-img";
        item.appendChild(img);
      }
      const label = document.createElement("span");
      label.textContent = name;
      item.appendChild(label);

      item.addEventListener("mousedown", (e) => {
        e.preventDefault(); // prevent blur before commit
        this._commitEmoteByName(name);
      });
      popup.appendChild(item);
    }
    popup.style.display = "block";

    // Position the popup fixed above the input element.
    // Must happen after display:block so the popup has a measurable height.
    this._repositionPopup();

    // Select first item by default so Tab/Enter immediately commits.
    this._setEmoteSelection(0);
  },

  _repositionPopup() {
    if (!this.inputEl || this._emotePopup.style.display === "none") return;
    const rect = this.inputEl.getBoundingClientRect();
    // If the input is hidden or not yet laid out its rect will have zero
    // dimensions. Positioning relative to (0,0) would strand the popup in
    // the top-left corner of the window overlapping the nav bar.
    if (rect.width === 0 || rect.height === 0) {
      this._hideEmotePopup();
      return;
    }
    const popupHeight = this._emotePopup.offsetHeight;
    this._emotePopup.style.position = "fixed";
    this._emotePopup.style.left = rect.left + "px";
    this._emotePopup.style.width = rect.width + "px";
    // Prefer above the input; fall back to below if not enough room.
    if (rect.top - popupHeight - 6 >= 0) {
      this._emotePopup.style.top = (rect.top - popupHeight - 6) + "px";
      this._emotePopup.style.bottom = "";
    } else {
      this._emotePopup.style.top = (rect.bottom + 6) + "px";
      this._emotePopup.style.bottom = "";
    }
  },

  _hideEmotePopup() {
    this._emotePopup.style.display = "none";
    this._emotePopupIndex = -1;
  },

  _moveEmoteSelection(delta) {
    const items = this._emotePopup.querySelectorAll(".emote-autocomplete-item");
    const next = Math.max(0, Math.min(items.length - 1,
      this._emotePopupIndex + delta));
    this._setEmoteSelection(next);
  },

  _setEmoteSelection(index) {
    const items = this._emotePopup.querySelectorAll(".emote-autocomplete-item");
    items.forEach((el, i) => el.classList.toggle("selected", i === index));
    this._emotePopupIndex = index;
    items[index]?.scrollIntoView({ block: "nearest" });
  },

  _commitEmoteSelection() {
    const items = this._emotePopup.querySelectorAll(".emote-autocomplete-item");
    const selected = items[this._emotePopupIndex];
    if (!selected) { this._hideEmotePopup(); return; }
    if (this._popupMode === "user") this._commitUserByName(selected.dataset.name);
    else this._commitEmoteByName(selected.dataset.name);
  },

  _commitEmoteByName(name) {
    const input = this.inputEl;
    if (!input) return;
    const { wordStart, wordEnd } = this._currentEmoteWord();
    const val = input.value;
    // Replace the partial word with the full emote name + trailing space.
    input.value = val.slice(0, wordStart) + name + " " + val.slice(wordEnd);
    this._autosizeChatInput();
    const newPos = wordStart + name.length + 1;
    input.setSelectionRange(newPos, newPos);
    this._hideEmotePopup();
    input.focus();
    // Previously called _updateEmotePopup() here to "re-evaluate in case
    // of another word," but that's exactly the auto-open behavior this
    // whole feature was just changed to NOT do (see the Tab handler in
    // the constructor) - the cursor now sits right after a trailing
    // space, so leaving this would risk popping suggestions back open
    // for whatever follows, with no Tab press involved. Opening now only
    // ever happens via explicit Tab.
  },

  ingestEmoteSet(emoteSet, provider) {
    if (!emoteSet || !Array.isArray(emoteSet.emotes)) return;
    for (const emote of emoteSet.emotes) {
      const host = emote.data?.host;
      const url = this.pickEmoteUrl(host);
      if (!url) {
        // Rare - most emotes always have a valid host.url. Logged (once
        // per emote, not spammed) rather than silently dropped, since
        // there was previously no way to tell which specific emotes were
        // missing or why - "99% of emotes work, a few mysteriously
        // don't" was reported with no way to narrow down which ones or
        // what their actual data looked like.
        console.warn(`[7tv] Skipping emote "${emote.name}" - no usable host.url. host:`, JSON.stringify(host));
        continue;
      }
      this._setEmote(emote.name, {
        url,
        zeroWidth: Boolean(emote.data?.flags & 1),
      }, provider);
    }
  },

  /** Handles a live seventv-emote-set-update push (see seventv_events.rs)
   * for the currently-watched channel's 7TV emote set - the real-time
   * counterpart to ingestEmoteSet()/loadSevenTvChannelEmotes()'s one-time
   * fetch at join. `payload.added` entries are individual emote objects
   * (same shape as emoteSet.emotes[i] that ingestEmoteSet iterates, just
   * not wrapped in a {emotes: [...]} container - 7TV's EventAPI dispatch
   * body gives them flat), so they're merged in directly rather than via
   * ingestEmoteSet itself. `payload.removed` entries are the same shape;
   * only their `.name` is needed to delete the matching map entry. */
  _applySevenTvEmoteSetUpdate(payload) {
    const added = Array.isArray(payload?.added) ? payload.added : [];
    const removed = Array.isArray(payload?.removed) ? payload.removed : [];

    for (const emote of added) {
      const host = emote.data?.host;
      const url = this.pickEmoteUrl(host);
      if (!url || !emote.name) {
        console.warn(`[7tv] Skipping live-added emote "${emote.name}" - no usable host.url. host:`, JSON.stringify(host));
        continue;
      }
      this._setEmote(emote.name, {
        url,
        zeroWidth: Boolean(emote.data?.flags & 1),
      }, "seventv-channel");
    }
    for (const emote of removed) {
      // Only delete the entry if this provider actually owns it - a
      // same-named emote from another provider (which _setEmote's
      // precedence may have let 7TV shadow) shouldn't vanish because
      // 7TV removed ITS emote. The shadowed lower-priority emote isn't
      // restored until its loader next runs (channel switch) - accepted:
      // same-name-across-providers plus a mid-stream 7TV removal is
      // rare enough that resurrecting shadowed entries isn't worth
      // keeping a full history per name.
      if (emote.name && this.sevenTvEmotes.get(emote.name)?.provider === "seventv-channel") {
        this.sevenTvEmotes.delete(emote.name);
      }
    }

    // Mirrors the systemLine() loadSevenTvChannelEmotes() posts on the
    // initial load, so a temporary emote appearing/disappearing mid-
    // stream is just as visible/discoverable in chat as the original
    // batch load was, rather than silently changing what's available
    // with no indication anything happened.
    for (const emote of added) {
      if (emote.name) this.systemLine(`7TV emote added: ${emote.name}`);
    }
    for (const emote of removed) {
      if (emote.name) this.systemLine(`7TV emote removed: ${emote.name}`);
    }
  },

};
