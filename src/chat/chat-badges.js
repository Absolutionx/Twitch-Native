// chat-badges.js — part of TwitchChat (see ../chat.js). Badge and cheermote loading/rendering (global + per-channel).
//
// This is a mixin, not a standalone class: chat.js does
// `Object.assign(TwitchChat.prototype, chatBadgesMixin)` after the class
// body, so every method here runs with the same `this` (container, ws,
// caches, etc.) as methods still defined directly in chat.js. Methods are
// grouped into files by feature area purely for readability — there is no
// behavioral difference from having them all in one file.

import { invoke } from "@tauri-apps/api/core";
import { kickBadgeElement } from "./kick-badges.js";
export const chatBadgesMixin = {
  /**
   * Parses the raw IRC `badges` tag (e.g. "broadcaster/1,subscriber/12")
   * and renders an <img> for each one found in badgeMap. Unknown
   * badges (not in either the global or channel-specific maps we've
   * loaded) are silently skipped rather than shown as broken images -
   * this can happen for newly-added badge types we haven't accounted for,
   * or if the badge maps haven't finished loading yet for a very early
   * message.
   *
   * Kick messages ride the same tag with "kick/{type}/{count}" entries
   * (see kick_badges_tag in kick_chat.rs) - those route to the inline
   * Kick badge art in kick-badges.js instead of badgeMap, with
   * subscriber entries months-matched against the channel's custom
   * badge tiers (_kickSubscriberBadges, set by connectKick). One shared
   * entry point on purpose: chat lines AND the user card both render
   * badges through here, so Kick badges appear in both for free.
   */
  renderBadges(badgesTag) {
    if (!badgesTag) return null;

    const fragment = document.createDocumentFragment();
    let foundAny = false;

    for (const pair of badgesTag.split(",")) {
      if (pair.startsWith("kick/")) {
        const [, type, countStr] = pair.split("/");
        const el = kickBadgeElement(type, Number(countStr) || 1, this._kickSubscriberBadges);
        if (el) {
          fragment.appendChild(el);
          foundAny = true;
        }
        continue;
      }
      const badge = this.badgeMap.get(pair);
      if (!badge) continue;
      foundAny = true;

      const img = document.createElement("img");
      img.className = "chat-badge";
      img.src = badge.url;
      img.alt = badge.title;
      img.title = badge.title;
      img.loading = "lazy";
      fragment.appendChild(img);
    }

    return foundAny ? fragment : null;
  },

  /** Twitch sometimes sends colors that are too dark to read on a dark
   * background. Official Twitch handles this by LIGHTENING the color
   * until it's readable while keeping its hue - dark blue becomes a
   * readable blue, dark red a readable red. The old version here
   * instead swapped anything below a luminance floor for a fixed
   * #9a9aff, so every dark-colored user rendered the same periwinkle
   * and looked nothing like they do on twitch.tv, while colors just
   * above the floor stayed murky. This ports the hue-preserving
   * approach: convert to HSL, raise ONLY lightness until the WCAG
   * relative-luminance contrast against the chat background clears
   * ~4.5:1, then convert back. Colors already readable pass through
   * byte-identical. */
  normalizeColor(hex) {
    if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return "#9147ff";
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;

    // WCAG relative luminance (gamma-corrected - NOT the old 0.299/
    // 0.587/0.114 video-luma formula, which under-weights how dark
    // saturated blues actually look).
    const relLum = (rr, gg, bb) => {
      const lin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
      return 0.2126 * lin(rr) + 0.7152 * lin(gg) + 0.0722 * lin(bb);
    };
    // Contrast vs the chat background (~#0e0e10, relative luminance
    // ~0.004) at 4.5:1 needs the color's luminance >= this. Solving
    // (L + 0.05) / (0.004 + 0.05) = 4.5 gives L ~= 0.193.
    const MIN_LUM = 0.193;
    if (relLum(r, g, b) >= MIN_LUM) return hex;

    // RGB -> HSL
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0;
    let l = (max + min) / 2;
    const d = max - min;
    if (d > 0) {
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
      else if (max === g) h = ((b - r) / d + 2) / 6;
      else h = ((r - g) / d + 4) / 6;
    }

    // HSL -> RGB
    const hslToRgb = (hh, ss, ll) => {
      if (ss === 0) return [ll, ll, ll];
      const q = ll < 0.5 ? ll * (1 + ss) : ll + ss - ll * ss;
      const p = 2 * ll - q;
      const chan = (t) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
      };
      return [chan(hh + 1 / 3), chan(hh), chan(hh - 1 / 3)];
    };

    // Walk lightness up until readable. 0.02 steps = at most 50
    // iterations for pure black, in practice a handful; the loop can't
    // fail to terminate because l ends up clamped to 1 (white), which
    // is above any luminance floor.
    let [nr, ng, nb] = [r, g, b];
    while (relLum(nr, ng, nb) < MIN_LUM && l < 1) {
      l = Math.min(1, l + 0.02);
      [nr, ng, nb] = hslToRgb(h, s, l);
    }
    const toHex = (c) => Math.round(c * 255).toString(16).padStart(2, "0");
    return `#${toHex(nr)}${toHex(ng)}${toHex(nb)}`;
  },

  /** Re-renders badges into any already-rendered .chat-badges-slot that's
   * currently empty but has a non-empty badgesTag recorded on it - i.e. a
   * line that rendered before badgeMap had the relevant entries (see
   * loadGlobalBadges/loadChannelBadges below, which call this after they
   * finish). Scoped to all chat lines, not just the logged-in user's own -
   * any message rendered during that same loading window has the
   * identical problem, not just the optimistic echo that prompted this. */
  _backfillBadges() {
    const slots = this.container.querySelectorAll(".chat-badges-slot:empty[data-badges-tag]");
    for (const slot of slots) {
      const tag = slot.dataset.badgesTag;
      if (!tag) continue;
      const fragment = this.renderBadges(tag);
      if (fragment) slot.appendChild(fragment);
    }
  },

  async loadGlobalBadges() {
    // badges.twitch.tv (the old unofficial endpoint) fails with
    // ERR_NAME_NOT_RESOLVED from inside WebView2 - same tracking-prevention
    // issue that drove IRC to Rust. The Rust command hits the Helix API
    // instead, which returns a different shape - see ingestBadgeSets.
    try {
      const json = await invoke("fetch_global_badges");
      this.ingestBadgeSets(JSON.parse(json));
      // Re-render the input badge AND backfill any already-rendered chat
      // lines' badge slots now that badgeMap might actually have entries
      // it didn't before - USERSTATE (which sets _ownBadgesTag) and
      // every PRIVMSG's badges tag arrive independently of this fetch
      // completing, so messages (including the optimistic echo of the
      // user's own sent message) landing first - the common case on a
      // fresh connection, since this fetch is a real network round trip -
      // previously meant renderBadges() ran against an empty map and just
      // silently found nothing, with nothing ever retrying it afterward.
      // This was reported as "doesn't show my badges next to my name."
      if (this._ownBadgesTag) this._renderInputBadges(this._ownBadgesTag);
      this._backfillBadges();
    } catch (err) {
      console.warn("Failed to load global badges:", err);
    }
  },

  async loadChannelBadges(twitchUserId) {
    // Same WebView2 network issue as loadGlobalBadges - routed through Rust.
    // The Helix API returns {"data":[]} with HTTP 200 for channels that have
    // no custom badges (no 404 to handle). Channel-specific entries intentionally
    // OVERWRITE the same set_id/version keys from loadGlobalBadges, matching
    // real Twitch behavior where a channel's subscriber badge art overrides
    // the generic global one.
    try {
      const json = await invoke("fetch_channel_badges", { broadcasterId: twitchUserId });
      this.ingestBadgeSets(JSON.parse(json));
      // Same re-render-after-load reasoning as loadGlobalBadges above.
      if (this._ownBadgesTag) this._renderInputBadges(this._ownBadgesTag);
      this._backfillBadges();
    } catch (err) {
      console.warn("Failed to load channel badges:", err);
    }
  },

  /** Fetches cheermotes for this channel via Rust (WebView2 can't reach api.twitch.tv). */
  async loadCheermotes(broadcasterId) {
    try {
      const json = await invoke("fetch_cheermotes", { broadcasterId });
      this.ingestCheermotes(JSON.parse(json));
    } catch (err) {
      // Silently ignore - user may not be logged in; cheermotes degrade
      // to plain text (the bits total badge still shows from the IRC tag).
      console.warn("Cheermotes unavailable:", err);
    }
  },

  /**
   * Normalizes the Helix badge API response into flat "set_id/version" ->
   * {url, title} entries in this.badgeMap, matching the IRC `badges` tag's
   * own "set_id/version" format so lookups in renderBadges are a simple
   * Map.get with no further parsing needed.
   *
   * Helix shape (different from the old badges.twitch.tv shape we used before):
   *   { "data": [{ "set_id": "subscriber", "versions": [{ "id": "0",
   *     "image_url_1x": "...", "image_url_2x": "...", "title": "..." }] }] }
   *
   * The key difference vs the legacy API: top-level is "data" (array) not
   * "badge_sets" (object), and version keys are "id" (not the object key
   * itself) with "image_url_2x" still present at the same path.
   */
  ingestBadgeSets(data) {
    if (!Array.isArray(data?.data)) return;

    for (const set of data.data) {
      const setId = set.set_id;
      if (!setId || !Array.isArray(set.versions)) continue;
      for (const v of set.versions) {
        const url = v.image_url_2x || v.image_url_1x;
        if (!url) continue;
        this.badgeMap.set(`${setId}/${v.id}`, {
          url,
          title: v.title || setId,
        });
      }
    }
  },

  /** Renders the user's own badges into #chat-input-badge, shown to the
   * left of the chat input field. Called whenever USERSTATE arrives. */
  _renderInputBadges(badgesTag) {
    const container = document.getElementById("chat-input-badge");
    if (!container) return;
    container.innerHTML = "";
    if (!badgesTag) return;
    const fragment = this.renderBadges(badgesTag);
    if (fragment) container.appendChild(fragment);
  },

};
