// Home feed (in #video-column when nothing is playing): a carousel, a
// recommended grid, and category rows. Data via Rust-proxied Helix
// (get_top_live_streams, get_streams_for_game_names, get_users_info for
// avatars). Helix has no personalized-recommendation or genre endpoint, so this
// substitutes top-viewed streams and a hand-picked RPG list.

import { invoke } from "@tauri-apps/api/core";
import { feedInvoke, isKick } from "./platform.js";
import { streamHasDropsEnabled } from "./drops.js";

const REFRESH_INTERVAL_MS = 60_000;
// Home density. The underlying fetches return far more than these show
// (Twitch get_top_live_streams pulls 100, Kick pulls 40, category rows
// have hundreds), so these are pure display caps - raised to fill the
// home page out rather than leaving most of the fetched data unused.
const CAROUSEL_SIZE = 15;
// How many cards a grid row shows before its "Show more" expands to the
// full set. Higher = a fuller first screen without needing to expand.
const GRID_COLLAPSED_COUNT = 8;
// Kick mode: how many top categories get their own home-feed row (the
// Kick counterpart of the hand-picked RPGs row - see fetchKickCategoryRows).
const KICK_CATEGORY_ROW_COUNT = 6;
const RPG_GAME_NAMES = [
  "Path of Exile 2",
  "Elden Ring",
  "Baldur's Gate 3",
  "Final Fantasy XIV Online",
  "Diablo IV",
  "Genshin Impact",
];

export class HomeFeed {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.containerEl - element to render into
   * @param {(channel: string) => void} opts.onChannelSelect
   */
  constructor({ containerEl, onChannelSelect }) {
    this.containerEl = containerEl;
    this.onChannelSelect = onChannelSelect || (() => {});
    /** @type {Map<string, string>} user_id -> profile_image_url */
    this.avatars = new Map();
    this.carouselIndex = 0;
    this.gridExpanded = false;
    this.refreshTimer = null;
    this.loaded = false;
    // #video-frame (containing #video-region, where #video-element plays
    // the decoded stream) has its own permanent solid black background,
    // independent of whatever its placeholder child's visibility is set
    // to - hiding only the placeholder text left that black box sitting
    // on top of the home feed at all times, regardless of whether a
    // stream was actually
    // running. Hide/show it together with the home feed itself, since
    // they're mutually exclusive by definition (nothing is playing <->
    // home feed shows; something is playing <-> video frame shows).
    this.videoFrameEl = document.getElementById("video-frame");
  }

  show() {
    this.containerEl.style.display = "block";
    if (this.videoFrameEl) this.videoFrameEl.style.display = "none";
    if (!this.loaded) {
      this.loaded = true;
      this.refresh();
      if (!this.refreshTimer) {
        this.refreshTimer = setInterval(() => this.refresh(), REFRESH_INTERVAL_MS);
      }
    }
  }

  hide() {
    this.containerEl.style.display = "none";
    if (this.videoFrameEl) this.videoFrameEl.style.display = "";
  }

  /** Platform toggled (see applyPlatformUi in main.js): everything on
   * this feed is platform-sourced, so drop it and refetch. If the feed
   * is currently showing, refetch immediately; if not, just mark it
   * stale so the next show() reloads instead of rendering the other
   * platform's leftovers. */
  reloadForPlatformChange() {
    this.topLive = [];
    this.extraRows = [];
    if (this.containerEl.style.display !== "none" && this.loaded) {
      this.refresh();
    } else {
      this.loaded = false;
    }
  }

  async refresh() {
    // The rows below the "we think you'll like" grid are platform-shaped:
    // Twitch keeps its hand-picked RPGs row (exact Helix category names -
    // see RPG_GAME_NAMES' header comment for why it can't be dynamic
    // there), while Kick builds its rows from whatever categories are
    // actually biggest on Kick right now - its directory API states
    // per-category viewer counts outright, so there's no reason to
    // hand-pick, and a Twitch-centric game list resolved to nothing on
    // Kick anyway (which is why the Kick home page used to end after
    // one grid).
    const [topLive, extraRows] = await Promise.all([
      this.fetchTopLive(),
      isKick()
        ? this.fetchKickCategoryRows()
        : this.fetchRpgs().then((rpgs) =>
            rpgs.length > 0 ? [{ key: "rpgs", title: "RPGs", streams: rpgs }] : []
          ),
    ]);
    await this.hydrateAvatars([
      ...topLive,
      ...extraRows.flatMap((r) => r.streams),
    ]);
    this.topLive = topLive;
    this.extraRows = extraRows;
    this.render();
  }

  /** Kick's home-feed category rows: the top KICK_CATEGORY_ROW_COUNT
   * categories by live viewers, one section each - "whatever is big on
   * Kick right now" (typically Just Chatting / Slots & Casino / a top
   * game) rather than a fixed list. A category whose stream fetch fails
   * or comes back empty is dropped, not rendered as an empty shelf. */
  async fetchKickCategoryRows() {
    let games = [];
    try {
      const payload = JSON.parse(await feedInvoke("get_top_games", {}));
      games = Array.isArray(payload?.games) ? payload.games : [];
    } catch (err) {
      console.error("Failed to load home feed (Kick categories):", err);
      return [];
    }
    const top = games
      .filter((g) => g && g.id && g.name)
      .sort((a, b) => (b.viewers || 0) - (a.viewers || 0))
      .slice(0, KICK_CATEGORY_ROW_COUNT);
    const rows = await Promise.all(
      top.map(async (g) => {
        try {
          const streams = JSON.parse(
            await feedInvoke("get_streams_for_game_id", { gameId: g.id })
          );
          return {
            key: `kickcat-${g.id}`,
            title: g.name,
            streams: Array.isArray(streams) ? streams : [],
          };
        } catch (err) {
          console.error(`Failed to load Kick category row "${g.name}":`, err);
          return { key: `kickcat-${g.id}`, title: g.name, streams: [] };
        }
      })
    );
    return rows.filter((r) => r.streams.length > 0);
  }

  async fetchTopLive() {
    try {
      return JSON.parse(await feedInvoke("get_top_live_streams"));
    } catch (err) {
      console.error("Failed to load home feed (top live):", err);
      return [];
    }
  }

  async fetchRpgs() {
    try {
      return JSON.parse(
        await feedInvoke("get_streams_for_game_names", { gameNames: RPG_GAME_NAMES })
      );
    } catch (err) {
      console.error("Failed to load home feed (RPGs):", err);
      return [];
    }
  }

  async hydrateAvatars(streams) {
    // Kick-normalized streams carry their avatar inline (kick.rs embeds
    // profile_image_url on each stream, since Kick's payloads include it
    // where Helix needs a second lookup) - seed those first, then only
    // batch-query Twitch for genuinely missing TWITCH ids. kick:* ids
    // must never reach get_users_info (Helix would 400 the whole batch).
    for (const s of streams) {
      if (s.profile_image_url && !this.avatars.has(s.user_id)) {
        this.avatars.set(s.user_id, s.profile_image_url);
      }
    }
    const missingIds = [...new Set(streams.map((s) => s.user_id))].filter(
      (id) => !this.avatars.has(id) && !String(id).startsWith("kick:")
    );
    if (missingIds.length === 0) return;
    try {
      const users = JSON.parse(await invoke("get_users_info", { userIds: missingIds }));
      for (const u of users) this.avatars.set(u.id, u.profile_image_url);
    } catch (err) {
      // Not fatal - cards just fall back to a blank avatar. Most likely
      // cause is the user not being logged in yet (get_users_info requires
      // auth), which is expected on first load before login completes.
      console.error("Failed to load home feed avatars:", err);
    }
  }

  render() {
    this.containerEl.innerHTML = "";
    if ((this.topLive || []).length > 0) {
      this.containerEl.appendChild(this.buildCarousel(this.topLive.slice(0, CAROUSEL_SIZE)));
    }
    this.containerEl.appendChild(
      this.buildSection(
        "Live channels we think you'll like",
        this.topLive || [],
        GRID_COLLAPSED_COUNT,
        "grid-expanded-likely"
      )
    );
    for (const row of this.extraRows || []) {
      if (!row.streams.length) continue;
      this.containerEl.appendChild(
        this.buildSection(row.title, row.streams, GRID_COLLAPSED_COUNT, `grid-expanded-${row.key}`)
      );
    }
  }

  // --- Carousel ------------------------------------------------------------

  buildCarousel(streams) {
    const wrap = document.createElement("div");
    wrap.className = "home-carousel";

    const track = document.createElement("div");
    track.className = "home-carousel-track";

    for (const s of streams) {
      track.appendChild(this.buildCarouselCard(s));
    }
    wrap.appendChild(track);

    const prevBtn = document.createElement("button");
    prevBtn.className = "home-carousel-nav home-carousel-prev";
    prevBtn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    prevBtn.addEventListener("click", () => {
      this.carouselIndex = Math.max(0, this.carouselIndex - 1);
      track.scrollTo({ left: this.carouselIndex * 360, behavior: "smooth" });
    });

    const nextBtn = document.createElement("button");
    nextBtn.className = "home-carousel-nav home-carousel-next";
    nextBtn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    nextBtn.addEventListener("click", () => {
      this.carouselIndex = Math.min(streams.length - 1, this.carouselIndex + 1);
      track.scrollTo({ left: this.carouselIndex * 360, behavior: "smooth" });
    });

    wrap.appendChild(prevBtn);
    wrap.appendChild(nextBtn);
    return wrap;
  }

  buildCarouselCard(s) {
    const card = document.createElement("button");
    card.className = "home-carousel-card";
    card.addEventListener("click", () => this.onChannelSelect(s.user_login, s));

    const thumb = document.createElement("img");
    thumb.className = "home-carousel-thumb";
    thumb.src = thumbnailUrl(s.thumbnail_url, 440, 248);
    thumb.alt = "";
    card.appendChild(thumb);

    const liveBadge = document.createElement("span");
    liveBadge.className = "home-live-badge";
    liveBadge.textContent = "LIVE";
    card.appendChild(liveBadge);

    if (streamHasDropsEnabled(s)) {
      const dropsBadge = document.createElement("span");
      dropsBadge.className = "home-drops-badge";
      dropsBadge.textContent = "Drops Enabled";
      card.appendChild(dropsBadge);
    }

    const info = document.createElement("div");
    info.className = "home-carousel-info";

    const avatar = document.createElement("img");
    avatar.className = "home-carousel-avatar";
    avatar.src = this.avatars.get(s.user_id) || blankAvatarDataUri();
    avatar.alt = "";
    info.appendChild(avatar);

    const text = document.createElement("div");
    text.className = "home-carousel-text";

    const name = document.createElement("div");
    name.className = "home-carousel-name";
    name.textContent = s.user_name;
    text.appendChild(name);

    const game = document.createElement("div");
    game.className = "home-carousel-game";
    game.textContent = s.game_name || "";
    text.appendChild(game);

    const tags = document.createElement("div");
    tags.className = "home-card-tags";
    for (const t of (s.tags || []).slice(0, 2)) {
      const tag = document.createElement("span");
      tag.className = "home-card-tag";
      tag.textContent = t;
      tags.appendChild(tag);
    }
    text.appendChild(tags);

    info.appendChild(text);

    const viewers = document.createElement("div");
    viewers.className = "home-carousel-viewers";
    viewers.textContent = `${formatViewerCount(s.viewer_count)} viewers`;
    info.appendChild(viewers);

    card.appendChild(info);
    return card;
  }

  // --- Grid sections ---------------------------------------------------

  buildSection(title, streams, collapsedCount, key) {
    const section = document.createElement("div");
    section.className = "home-section";

    const heading = document.createElement("div");
    heading.className = "home-section-title";
    heading.textContent = title;
    section.appendChild(heading);

    const grid = document.createElement("div");
    grid.className = "home-grid";

    const expanded = this._expandedSections?.has(key);
    const visible = expanded ? streams : streams.slice(0, collapsedCount);
    for (const s of visible) {
      grid.appendChild(this.buildGridCard(s));
    }
    section.appendChild(grid);

    if (streams.length > collapsedCount) {
      const showMore = document.createElement("button");
      showMore.className = "home-show-more";
      showMore.innerHTML = expanded
        ? 'Show less <svg viewBox="0 0 24 24" width="14" height="14" style="transform:rotate(180deg)"><path d="M7 10l5 5 5-5z" fill="currentColor"/></svg>'
        : 'Show more <svg viewBox="0 0 24 24" width="14" height="14"><path d="M7 10l5 5 5-5z" fill="currentColor"/></svg>';
      showMore.addEventListener("click", () => {
        if (!this._expandedSections) this._expandedSections = new Set();
        if (expanded) this._expandedSections.delete(key);
        else this._expandedSections.add(key);
        this.render();
      });
      section.appendChild(showMore);
    }

    return section;
  }

  buildGridCard(s) {
    const card = document.createElement("button");
    card.className = "home-grid-card";
    card.addEventListener("click", () => this.onChannelSelect(s.user_login, s));

    const thumbWrap = document.createElement("div");
    thumbWrap.className = "home-grid-thumb-wrap";

    const thumb = document.createElement("img");
    thumb.className = "home-grid-thumb";
    thumb.src = thumbnailUrl(s.thumbnail_url, 320, 180);
    thumb.alt = "";
    thumbWrap.appendChild(thumb);

    const liveBadge = document.createElement("span");
    liveBadge.className = "home-live-badge";
    liveBadge.textContent = "LIVE";
    thumbWrap.appendChild(liveBadge);

    if (streamHasDropsEnabled(s)) {
      const dropsBadge = document.createElement("span");
      dropsBadge.className = "home-drops-badge";
      dropsBadge.textContent = "Drops Enabled";
      thumbWrap.appendChild(dropsBadge);
    }

    const viewers = document.createElement("span");
    viewers.className = "home-grid-viewers";
    viewers.textContent = `${formatViewerCount(s.viewer_count)} viewers`;
    thumbWrap.appendChild(viewers);

    card.appendChild(thumbWrap);

    const meta = document.createElement("div");
    meta.className = "home-grid-meta";

    const avatar = document.createElement("img");
    avatar.className = "home-grid-avatar";
    avatar.src = this.avatars.get(s.user_id) || blankAvatarDataUri();
    avatar.alt = "";
    meta.appendChild(avatar);

    const text = document.createElement("div");
    text.className = "home-grid-text";

    const title = document.createElement("div");
    title.className = "home-grid-title";
    title.textContent = s.title || "";
    title.title = s.title || "";
    text.appendChild(title);

    const name = document.createElement("div");
    name.className = "home-grid-name";
    name.textContent = s.user_name;
    text.appendChild(name);

    const game = document.createElement("div");
    game.className = "home-grid-game";
    game.textContent = s.game_name || "";
    text.appendChild(game);

    const tags = document.createElement("div");
    tags.className = "home-card-tags";
    for (const t of (s.tags || []).slice(0, 3)) {
      const tag = document.createElement("span");
      tag.className = "home-card-tag";
      tag.textContent = t;
      tags.appendChild(tag);
    }
    text.appendChild(tags);

    meta.appendChild(text);
    card.appendChild(meta);

    return card;
  }
}

/** Helix thumbnail URLs come as a template with {width}/{height}
 * placeholders that need substituting before use. */
function thumbnailUrl(template, width, height) {
  if (!template) return blankAvatarDataUri();
  return template.replace("{width}", String(width)).replace("{height}", String(height));
}

function formatViewerCount(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K`;
  return String(n);
}

function blankAvatarDataUri() {
  return "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
}
