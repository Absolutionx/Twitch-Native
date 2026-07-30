// Browse / directory page (in #video-column when the Browse tab is active),
// mirroring twitch.tv/directory: pills, a Categories/Live Channels switcher,
// search, sort, and the grid. Three levels: categories or live-channels grid ->
// a category's streams -> a pill's single category. Routed through Rust like
// home.js/sidebar.js (see sidebar.js for why not a direct webview fetch).

import { invoke } from "@tauri-apps/api/core";
import { feedInvoke, isKick } from "./platform.js";
import { streamHasDropsEnabled } from "./drops.js";

// No longer used to slice/collapse the categories grid (every loaded
// category is always shown now - see get_top_games' cursor pagination in
// main.rs and loadMoreGames() below). Kept only as a minimum-list-length
// threshold for the "You've reached the end of the list" message, so
// that note doesn't show up under a tiny first page that was never
// really worth scrolling through in the first place.
const CATEGORIES_COLLAPSED_COUNT = 18;

// Debounce delay for the category search box - matches a typical
// "search as you type" feel without firing a Helix request on every
// single keystroke while someone is still typing a longer query.
const SEARCH_DEBOUNCE_MS = 300;

// How close to the bottom of #browse-page (in pixels) before
// _handleScroll() triggers loading the next page - matches twitch.tv's
// own directory, which starts fetching more content shortly before you
// actually hit the bottom rather than only once you're literally there,
// so new cards are usually already in place by the time you'd otherwise
// see blank space.
const SCROLL_TRIGGER_PX = 600;

// Sub-directory pills, each mapping to one real Twitch category (IRL, Music &
// DJs, Talk Shows & Podcasts are all single categories since 2018). "Games" is
// omitted (it's "everything else", so it shows the Categories grid), and there's
// no "Esports" pill - it's a tag-based aggregate with no Helix endpoint. Names
// must match Twitch's exactly (exact-name lookup, not fuzzy search).
const PILL_CATEGORIES = {
  irl: "IRL",
  music: "Music",
  creative: "Talk Shows & Podcasts",
  // Kick-only pill (see PILL_DEFS_KICK): Kick's own directory has
  // Gambling as a first-class top-level group - one of its biggest -
  // with no Twitch equivalent. The name here resolves through
  // kick_streams_for_game_names' group mapping (kick.rs), same as the
  // other three.
  gambling: "Gambling",
};

// Inline SVG icons for the 5 pills - small enough and few enough that
// bundling them as plain strings here is simpler than separate icon
// files, and avoids any external asset/network dependency for something
// this app fully controls the rendering of anyway.
const PILL_ICONS = {
  games: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M7 7h2v2h2v2H9v2H7v-2H5v-2h2V7zm9 1.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm-3 4a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM6 3h12a4 4 0 0 1 4 4v8a4 4 0 0 1-4 4h-1.5l-2-3h-9l-2 3H2a4 4 0 0 1-4-4V7a4 4 0 0 1 4-4h2z" opacity="0"/><path d="M6.5 4A4.5 4.5 0 0 0 2 8.5v7A4.5 4.5 0 0 0 6.5 20c.97 0 1.86-.33 2.57-.88L11 17h2l1.93 2.12c.71.55 1.6.88 2.57.88A4.5 4.5 0 0 0 22 15.5v-7A4.5 4.5 0 0 0 17.5 4h-11zM8 8v2h2v2H8v2H6v-2H4v-2h2V8h2zm9 .5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM14 12.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z"/></svg>',
  irl: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 2a5 5 0 0 1 5 5v3a5 5 0 0 1-10 0V7a5 5 0 0 1 5-5z"/><path d="M5 11a1 1 0 0 1 2 0 5 5 0 0 0 10 0 1 1 0 0 1 2 0 7 7 0 0 1-6 6.93V21h2a1 1 0 0 1 0 2H9a1 1 0 0 1 0-2h2v-3.07A7 7 0 0 1 5 11z"/></svg>',
  music: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M9 3v12.55A4 4 0 1 0 11 19V8h7V5h-7V3H9z"/></svg>',
  creative: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 1a3.5 3.5 0 0 0-3.5 3.5v6a3.5 3.5 0 0 0 7 0v-6A3.5 3.5 0 0 0 12 1z"/><path d="M5.5 10a1 1 0 0 1 1 1 5.5 5.5 0 0 0 11 0 1 1 0 1 1 2 0 7.5 7.5 0 0 1-6.5 7.43V21h3a1 1 0 0 1 0 2h-8a1 1 0 0 1 0-2h3v-2.57A7.5 7.5 0 0 1 4.5 11a1 1 0 0 1 1-1z"/></svg>',
};

// Per-platform pill bars: each pill maps to a real top-level group on
// THAT platform's directory, and the two directories genuinely differ -
// Kick has Gambling/Slots & Casino as a first-class (and huge) group
// with no Twitch equivalent, and labels its groups differently ("Music"
// not "Music & DJs", "Creative" not "Talk Shows & Podcasts"). Sharing
// one bar meant Kick browse offered only Twitch's shape of the world.
PILL_ICONS.gambling = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm3 3.5A1.5 1.5 0 1 0 8 9.5a1.5 1.5 0 0 0 0-3zm8 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm-4 4a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm-4 4a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm8 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z"/></svg>';

const PILL_DEFS_TWITCH = [
  { key: "games", label: "Games" },
  { key: "irl", label: "IRL" },
  { key: "music", label: "Music & DJs" },
  { key: "creative", label: "Talk Shows & Podcasts" },
];
const PILL_DEFS_KICK = [
  { key: "games", label: "Games" },
  { key: "irl", label: "IRL" },
  { key: "music", label: "Music" },
  { key: "gambling", label: "Slots & Casino" },
  { key: "creative", label: "Creative" },
];

export class BrowsePage {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.containerEl
   * @param {(channel: string) => void} opts.onChannelSelect
   */
  constructor({ containerEl, onChannelSelect }) {
    this.containerEl = containerEl;
    this.onChannelSelect = onChannelSelect || (() => {});
    /** @type {Map<string, string>} user_id -> profile_image_url */
    this.avatars = new Map();
    this.games = [];
    /** @type {Map<string, {viewer_count:number, channel_count:number}>} game_id -> approximated counts (see get_category_viewer_counts) */
    this.categoryCounts = new Map();
    /** Currently drilled-into category, or null when showing the top-level grid. */
    this.activeGame = null;
    /** Which pill is visually active - "games" by default (the Categories/Live-Channels view), or one of PILL_CATEGORIES' keys. */
    this.activePill = "games";
    /** "categories" | "live" - which top-level tab is showing. Irrelevant whenever a pill other than "games" or a specific category is active. */
    this.activeTab = "categories";
    /** "recommended" | "viewers" - sort order for the Categories grid. There's no public "recommended for you" signal, so "recommended" just keeps get_top_games' own (already viewer-influenced) order; "viewers" re-sorts using the approximated counts. */
    this.sortMode = "recommended";
    this.searchQuery = "";
    this._searchDebounceTimer = null;
    /** @type {Array|null} Live search results, or null when not searching. */
    this.searchResults = null;
    this.topLiveStreams = [];
    this.videoFrameEl = document.getElementById("video-frame");
    this.loaded = false;
    // Pagination cursor for get_top_games - null means either "haven't
    // loaded yet" or "Twitch has no more categories with at least one
    // live viewer right now" (the actual end of the list, not an
    // artificial cap - see get_top_games' comment in main.rs for why this
    // replaced the old fixed-200-then-stop behavior). Distinguished from
    // "no more pages" via hasMoreGames below, since both states are
    // represented by a null cursor.
    this.nextGamesCursor = null;
    this.hasMoreGames = true;
    // Guards loadMoreGames() against firing a duplicate Helix request
    // while the previous page is still loading (e.g. a fast scroll
    // crossing the trigger threshold more than once before the first
    // request resolves).
    this.loadingMoreGames = false;
    // Consecutive loadMoreGames() pages that contributed ZERO new
    // categories after id-dedupe. Kick's categories walk intentionally
    // overlaps (its ranked top list shows up again inside the full
    // subcategories listing - see kick_top_games in kick.rs), so a few
    // all-duplicate pages in a row are normal and must NOT stop the
    // scroll; but if EVERY page keeps deduping to nothing, the endpoint
    // is almost certainly ignoring its page param and further requests
    // would loop the same content forever - stop paging at that point.
    this._allDupGamePages = 0;
    // Same trio, for the Live Channels tab's own independent infinite
    // scroll (see get_live_streams_page in main.rs - a separate command
    // from get_top_live_streams, which home.js/sidebar.js also use and
    // expect a plain non-paginated array from).
    this.nextLiveCursor = null;
    this.hasMoreLive = true;
    this.loadingMoreLive = false;
    // Bound once so addEventListener/removeEventListener (not currently
    // needed since the container persists for this page's whole
    // lifetime, but kept as a stable reference for clarity/future use)
    // refer to the same function. Attached in the constructor, not
    // show()/render(), since this.containerEl is a single persistent
    // element for the page's entire lifetime - re-attaching on every
    // render() would stack up duplicate listeners.
    this._onScroll = () => this._handleScroll();
    this.containerEl.addEventListener("scroll", this._onScroll);
    // True while loadTopGames()/loadTopLiveStreams() (the FIRST page of
    // either grid) is in flight. Distinct from loadingMoreGames/
    // loadingMoreLive (which guard the second-page-and-beyond path) -
    // without this, switching to a tab/pill could trigger a real bug:
    // setting containerEl.scrollTop = 0 fires a native 'scroll' event
    // synchronously, which calls _handleScroll(), which would see
    // hasMoreGames/hasMoreLive still at their default `true` and
    // loadingMoreGames/loadingMoreLive still `false` (the initial load
    // hadn't progressed far enough yet to flip them), and so kick off a
    // SECOND, redundant fetch of page 1 racing the first one - this flag
    // closes that gap.
    this._initialLoadInProgress = false;
  }

  show() {
    this.containerEl.style.display = "block";
    if (this.videoFrameEl) this.videoFrameEl.style.display = "none";
    if (!this.loaded) {
      this.loaded = true;
      this.loadTopGames();
    } else {
      this.render();
    }
  }

  hide() {
    this.containerEl.style.display = "none";
    if (this.videoFrameEl) this.videoFrameEl.style.display = "";
  }

  /** Platform toggled (see applyPlatformUi in main.js): every list on
   * this page is platform-sourced, so reset to the top-level Categories
   * view with empty state. If the page is currently showing, reload
   * right away; otherwise mark stale for the next show(). */
  reloadForPlatformChange() {
    this.games = [];
    this.topLiveStreams = [];
    this.categoryCounts = new Map();
    this.activeGame = null;
    this.activePill = "games";
    this.activeTab = "categories";
    this.searchQuery = "";
    this.searchResults = null;
    this.nextGamesCursor = null;
    this.hasMoreGames = true;
    this._allDupGamePages = 0;
    this.nextLiveCursor = null;
    this.hasMoreLive = true;
    if (this.containerEl.style.display !== "none" && this.loaded) {
      this.loadTopGames();
    } else {
      this.loaded = false;
    }
  }

  async loadTopGames() {
    this._initialLoadInProgress = true;
    this.containerEl.innerHTML = '<div class="home-section-title">Loading categories…</div>';
    try {
      const { games, cursor } = JSON.parse(await feedInvoke("get_top_games", { cursor: null }));
      this.games = dedupeGamesById(games);
      this.nextGamesCursor = cursor;
      this.hasMoreGames = Boolean(cursor);
      this._allDupGamePages = 0;
    } catch (err) {
      console.error("Failed to load top games:", err);
      this.containerEl.innerHTML = '<div class="home-section-title">Failed to load categories.</div>';
      this._initialLoadInProgress = false;
      return;
    }
    this._initialLoadInProgress = false;
    this.activeGame = null;
    this.render();
    // Approximate viewer counts load in the background and re-render once
    // ready, rather than blocking the initial grid paint on a much heavier
    // request (this samples up to 1000 streams server-side - see
    // get_category_viewer_counts in main.rs) - the grid is still fully
    // usable without counts for the brief moment before they arrive.
    this.loadCategoryCounts();
  }

  /** Fetches and appends the next page of categories - called by
   * _handleScroll() once the user nears the bottom of the grid, same as
   * twitch.tv's own infinite-scrolling directory (there's no "Show more"
   * button anymore; this fires automatically). Unlike the old
   * categoriesExpanded toggle this replaced (which just revealed items
   * already sitting in memory), this is a genuine on-demand Helix
   * request each time, so continuing to scroll can walk through every
   * category Twitch currently has live, not just whatever was fetched up
   * front. */
  async loadMoreGames() {
    if (this.loadingMoreGames || !this.hasMoreGames) return;
    this.loadingMoreGames = true;
    let pageAddedNothing = false;
    this.render(); // shows the loading indicator immediately
    try {
      const { games, cursor } = JSON.parse(
        await feedInvoke("get_top_games", { cursor: this.nextGamesCursor })
      );
      // Dedupe by id across pages: Kick's categories walk overlaps by
      // design (see kick_top_games in kick.rs - the ranked top list
      // reappears inside the full subcategories listing), and even
      // Twitch cursor pages can overlap slightly at page boundaries.
      // Without this, the same category card could render twice.
      const before = this.games.length;
      this.games = dedupeGamesById(this.games.concat(games));
      pageAddedNothing = this.games.length === before;
      this.nextGamesCursor = cursor;
      this.hasMoreGames = Boolean(cursor);
      if (pageAddedNothing) {
        // Whole page was duplicates. A few of these in a row are
        // expected (the overlap above); many in a row means the
        // endpoint is ignoring its page param and every further request
        // would fetch the same content - stop rather than spin through
        // the server-side page cap re-downloading identical lists (see
        // _allDupGamePages in the constructor).
        this._allDupGamePages += 1;
        if (this._allDupGamePages >= 5) this.hasMoreGames = false;
      } else {
        this._allDupGamePages = 0;
      }
    } catch (err) {
      console.error("Failed to load more categories:", err);
      // Leave hasMoreGames as-is so a transient failure doesn't
      // permanently stop future scroll-triggered attempts - the next
      // scroll past the threshold will just try again.
    }
    this.loadingMoreGames = false;
    this.render();
    // An all-duplicate page re-renders identical DOM: the user is still
    // sitting at the same scroll offset, but no new 'scroll' event will
    // fire to trigger the NEXT page. Chain straight into it so the walk
    // hops over the expected overlap (see the dedupe comment above)
    // without the user having to jiggle the scrollbar - bounded by the
    // consecutive-dup stop above plus the server-side page cap.
    if (pageAddedNothing && this.hasMoreGames) this.loadMoreGames();
  }

  /** Fetches and appends the next page of live streams - the Live
   * Channels tab's equivalent of loadMoreGames() above, same
   * scroll-triggered/no-button design, backed by the separate
   * get_live_streams_page command (see its comment in main.rs for why
   * this isn't just get_top_live_streams with a cursor added). */
  async loadMoreLiveStreams() {
    if (this.loadingMoreLive || !this.hasMoreLive) return;
    this.loadingMoreLive = true;
    this.render();
    try {
      const { streams, cursor } = JSON.parse(
        await feedInvoke("get_live_streams_page", { cursor: this.nextLiveCursor })
      );
      await this.hydrateAvatars(streams);
      this.topLiveStreams = this.topLiveStreams.concat(streams);
      this.nextLiveCursor = cursor;
      this.hasMoreLive = Boolean(cursor);
    } catch (err) {
      console.error("Failed to load more live streams:", err);
    }
    this.loadingMoreLive = false;
    this.render();
  }

  /**
   * Fired on every scroll of #browse-page (this.containerEl). Triggers
   * the next page load once the user is within SCROLL_TRIGGER_PX of the
   * bottom, for whichever grid is currently showing - matching
   * twitch.tv's own directory, which loads more as you approach the
   * bottom rather than waiting for an explicit click or the literal
   * last pixel. Only acts on the two views that actually have
   * server-side pagination to walk through (the Categories grid and the
   * Live Channels grid); search results and a drilled-into single
   * category are both already-complete, one-shot lists with nothing
   * further to fetch.
   */
  _handleScroll() {
    if (this.activeGame) return; // drilled into one category - nothing more to page through
    if (this._initialLoadInProgress) return; // first page still loading - see constructor's comment
    const el = this.containerEl;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom > SCROLL_TRIGGER_PX) return;

    if (this.activeTab === "live") {
      this.loadMoreLiveStreams();
    } else if (this.searchResults === null) {
      // Search results aren't paginated server-side here - searching
      // doesn't scroll-load further matches, same as not having a "Show
      // more" under search results before this change either.
      this.loadMoreGames();
    }
  }

  async loadCategoryCounts() {
    try {
      const raw = await feedInvoke("get_category_viewer_counts");
      const parsed = JSON.parse(raw);
      this.categoryCounts = new Map(Object.entries(parsed));
    } catch (err) {
      console.error("Failed to load category viewer counts:", err);
      return;
    }
    // Only worth a re-render if we're still looking at the Categories
    // grid - a re-render while drilled into a category or viewing Live
    // Channels would just be wasted work (render() no-ops for
    // activeGame, and the counts aren't used there anyway).
    if (!this.activeGame && this.activeTab === "categories" && this.activePill === "games") {
      this.render();
    }
  }

  async loadTopLiveStreams() {
    this._initialLoadInProgress = true;
    this.containerEl.innerHTML = '<div class="home-section-title">Loading live channels…</div>';
    let streams = [];
    try {
      const { streams: page, cursor } = JSON.parse(
        await feedInvoke("get_live_streams_page", { cursor: null })
      );
      streams = page;
      this.nextLiveCursor = cursor;
      this.hasMoreLive = Boolean(cursor);
    } catch (err) {
      console.error("Failed to load top live streams:", err);
    }
    this._initialLoadInProgress = false;
    await this.hydrateAvatars(streams);
    this.topLiveStreams = streams;
    this.render();
  }

  async openGame(game) {
    this.activeGame = game;
    this.containerEl.scrollTop = 0;
    this.containerEl.innerHTML = "";
    this.containerEl.appendChild(this.buildBackRow(game.name));
    const loading = document.createElement("div");
    loading.className = "home-section-title";
    loading.textContent = "Loading streams…";
    this.containerEl.appendChild(loading);

    let streams = [];
    try {
      streams = JSON.parse(await feedInvoke("get_streams_for_game_id", { gameId: game.id }));
    } catch (err) {
      console.error("Failed to load streams for game:", err);
    }
    await this.hydrateAvatars(streams);

    this.containerEl.innerHTML = "";
    this.containerEl.appendChild(this.buildBackRow(game.name));

    if (streams.length === 0) {
      const empty = document.createElement("div");
      empty.className = "home-section-title";
      empty.textContent = "No live channels right now.";
      this.containerEl.appendChild(empty);
      return;
    }

    const grid = document.createElement("div");
    grid.className = "home-grid";
    for (const s of streams) {
      grid.appendChild(this.buildStreamCard(s));
    }
    this.containerEl.appendChild(grid);
  }

  /** Opens one of the 3 single-category pills (IRL/Music/Talk Shows &
   * Podcasts) - same end result as openGame() (a live streams grid with a
   * back row), but resolves by exact category NAME via
   * get_streams_for_game_names rather than already having a game_id from
   * a rendered card, since pills aren't backed by a card the user clicked
   * - they're a fixed shortcut to one specific, known-by-name category. */
  async openPillCategory(pillKey) {
    const categoryName = PILL_CATEGORIES[pillKey];
    this.activePill = pillKey;
    this.activeGame = { id: null, name: categoryName, isPill: true };
    this.containerEl.innerHTML = "";
    this.containerEl.appendChild(this.buildPillsRow());
    this.containerEl.appendChild(this.buildBackRow(categoryName));
    const loading = document.createElement("div");
    loading.className = "home-section-title";
    loading.textContent = "Loading streams…";
    this.containerEl.appendChild(loading);

    let streams = [];
    try {
      streams = JSON.parse(
        await feedInvoke("get_streams_for_game_names", { gameNames: [categoryName] })
      );
    } catch (err) {
      console.error(`Failed to load streams for ${categoryName}:`, err);
    }
    await this.hydrateAvatars(streams);

    this.containerEl.innerHTML = "";
    this.containerEl.appendChild(this.buildPillsRow());
    this.containerEl.appendChild(this.buildBackRow(categoryName));

    if (streams.length === 0) {
      const empty = document.createElement("div");
      empty.className = "home-section-title";
      empty.textContent = "No live channels right now.";
      this.containerEl.appendChild(empty);
      return;
    }

    const grid = document.createElement("div");
    grid.className = "home-grid";
    for (const s of streams) {
      grid.appendChild(this.buildStreamCard(s));
    }
    this.containerEl.appendChild(grid);
  }

  buildBackRow(gameName) {
    const row = document.createElement("div");
    row.className = "browse-back-row";

    const backBtn = document.createElement("button");
    backBtn.className = "browse-back-btn";
    backBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> Categories';
    backBtn.addEventListener("click", () => {
      this.containerEl.scrollTop = 0;
      this.activeGame = null;
      this.activePill = "games";
      this.render();
    });
    row.appendChild(backBtn);

    const title = document.createElement("div");
    title.className = "browse-category-title";
    title.textContent = gameName;
    row.appendChild(title);

    return row;
  }

  async hydrateAvatars(streams) {
    // Same seeding as home.js's hydrateAvatars: Kick streams carry
    // profile_image_url inline; kick:* ids are excluded from the Twitch
    // batch (Helix would 400 on them).
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
      console.error("Failed to load browse-page avatars:", err);
    }
  }

  // ── Header pieces (title, pills, tabs, search/sort) ──────────────

  buildPageTitle() {
    const title = document.createElement("div");
    title.className = "browse-page-title";
    title.textContent = "Browse";
    return title;
  }

  buildPillsRow() {
    const row = document.createElement("div");
    row.className = "browse-pills-row";
    const defs = isKick() ? PILL_DEFS_KICK : PILL_DEFS_TWITCH;
    for (const def of defs) {
      const pill = document.createElement("button");
      pill.className = "browse-pill" + (this.activePill === def.key ? " is-active" : "");

      const label = document.createElement("span");
      label.textContent = def.label;
      pill.appendChild(label);

      const icon = document.createElement("span");
      icon.innerHTML = PILL_ICONS[def.key];
      pill.appendChild(icon);

      pill.addEventListener("click", () => {
        this.containerEl.scrollTop = 0;
        if (def.key === "games") {
          // "Games" has no single-category equivalent - just return to
          // this page's own Categories grid (see PILL_CATEGORIES' comment).
          this.activePill = "games";
          this.activeGame = null;
          this.render();
        } else {
          this.openPillCategory(def.key);
        }
      });
      row.appendChild(pill);
    }
    return row;
  }

  buildTabsRow() {
    const row = document.createElement("div");
    row.className = "browse-tabs-row";

    const categoriesTab = document.createElement("button");
    categoriesTab.className = "browse-tab" + (this.activeTab === "categories" ? " is-active" : "");
    categoriesTab.textContent = "Categories";
    categoriesTab.addEventListener("click", () => {
      if (this.activeTab === "categories") return;
      this.activeTab = "categories";
      this.containerEl.scrollTop = 0;
      this.render();
    });
    row.appendChild(categoriesTab);

    const liveTab = document.createElement("button");
    liveTab.className = "browse-tab" + (this.activeTab === "live" ? " is-active" : "");
    liveTab.textContent = "Live Channels";
    liveTab.addEventListener("click", () => {
      if (this.activeTab === "live") return;
      this.activeTab = "live";
      this.containerEl.scrollTop = 0;
      this.loadTopLiveStreams();
    });
    row.appendChild(liveTab);

    return row;
  }

  buildControlsRow() {
    const row = document.createElement("div");
    row.className = "browse-controls-row";

    // Search box - only meaningful on the Categories tab (searching
    // categories while looking at a flat live-channels list doesn't map
    // to anything sensible here, same as twitch.tv itself only showing
    // category search on the Categories sub-tab).
    if (this.activeTab === "categories") {
      const searchWrap = document.createElement("div");
      searchWrap.className = "browse-search-wrap";

      const icon = document.createElement("span");
      icon.className = "browse-search-icon";
      icon.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>';
      searchWrap.appendChild(icon);

      const input = document.createElement("input");
      input.className = "browse-search-input";
      input.type = "text";
      input.placeholder = "Search Category Tags";
      input.value = this.searchQuery;
      input.addEventListener("input", () => {
        this.searchQuery = input.value;
        clearTimeout(this._searchDebounceTimer);
        this._searchDebounceTimer = setTimeout(() => this.runSearch(), SEARCH_DEBOUNCE_MS);
      });
      searchWrap.appendChild(input);
      row.appendChild(searchWrap);
    } else {
      // Keeps the controls row's flex layout (justify-content:
      // space-between) looking the same on the Live Channels tab, which
      // has a sort control but no search box.
      row.appendChild(document.createElement("div"));
    }

    // Sort by - "Recommended For You" has no public personalization
    // signal to back it with, so it just keeps get_top_games'/
    // get_top_live_streams' own already-popularity-influenced order;
    // "Viewer Count" re-sorts using real numbers (exact for the Live
    // Channels grid, approximated for Categories - see
    // get_category_viewer_counts).
    const sortRow = document.createElement("div");
    sortRow.className = "browse-sort-row";
    const sortLabel = document.createElement("span");
    sortLabel.textContent = "Sort by";
    sortRow.appendChild(sortLabel);

    const select = document.createElement("select");
    select.className = "browse-sort-select";
    const optRecommended = document.createElement("option");
    optRecommended.value = "recommended";
    optRecommended.textContent = "Recommended For You";
    select.appendChild(optRecommended);
    const optViewers = document.createElement("option");
    optViewers.value = "viewers";
    optViewers.textContent = "Viewer Count";
    select.appendChild(optViewers);
    select.value = this.sortMode;
    select.addEventListener("change", () => {
      this.sortMode = select.value;
      this.render();
    });
    sortRow.appendChild(select);
    row.appendChild(sortRow);

    return row;
  }

  async runSearch() {
    const query = this.searchQuery.trim();
    if (!query) {
      this.searchResults = null;
      this.render();
      return;
    }
    try {
      this.searchResults = JSON.parse(await feedInvoke("search_categories", { query }));
    } catch (err) {
      console.error("Category search failed:", err);
      this.searchResults = [];
    }
    // Stale-response guard: if the box was cleared (or changed again)
    // while this request was in flight, searchQuery/searchResults may no
    // longer agree - render() always re-derives what to show from
    // current state, so a quick clear-then-retype can't show results for
    // a query that's no longer in the box.
    if (this.searchQuery.trim() === query) this.render();
  }

  // ── Main render ───────────────────────────────────────────────────

  render() {
    if (this.activeGame) {
      // openGame()/openPillCategory() manage their own rendering once
      // data arrives; nothing further to do here on a plain re-render
      // (e.g. show() called again while already drilled into a category).
      return;
    }

    this.containerEl.innerHTML = "";
    this.containerEl.appendChild(this.buildPageTitle());
    this.containerEl.appendChild(this.buildPillsRow());
    this.containerEl.appendChild(this.buildTabsRow());
    this.containerEl.appendChild(this.buildControlsRow());

    if (this.activeTab === "live") {
      this.renderLiveChannelsGrid();
    } else {
      this.renderCategoriesGrid();
    }
  }

  renderLiveChannelsGrid() {
    let streams = this.topLiveStreams;
    if (this.sortMode === "viewers") {
      streams = [...streams].sort((a, b) => (b.viewer_count || 0) - (a.viewer_count || 0));
    }
    if (streams.length === 0) {
      const empty = document.createElement("div");
      empty.className = "home-section-title";
      empty.textContent = "No live channels right now.";
      this.containerEl.appendChild(empty);
      return;
    }
    const grid = document.createElement("div");
    grid.className = "home-grid";
    for (const s of streams) {
      grid.appendChild(this.buildStreamCard(s));
    }
    this.containerEl.appendChild(grid);

    // Same scroll-triggered pagination footer as the Categories grid -
    // hidden while sorting by viewers, for the same reason: re-sorting a
    // growing list as more pages arrive would shuffle cards the user's
    // already looked at.
    if (this.sortMode !== "viewers") {
      this.containerEl.appendChild(
        this._buildPaginationFooter(this.hasMoreLive, this.loadingMoreLive, this.topLiveStreams.length)
      );
    }
  }

  renderCategoriesGrid() {
    // A non-empty search box takes over the grid with live results,
    // matching twitch.tv's own category search (which replaces the grid
    // rather than filtering it client-side, since the search itself is
    // server-side fuzzy matching across Twitch's full category catalog,
    // not just whatever's in the already-loaded games list).
    const usingSearch = this.searchResults !== null;
    const heading = document.createElement("div");
    heading.className = "home-section-title";
    heading.textContent = usingSearch ? `Results for "${this.searchQuery.trim()}"` : "Categories";
    this.containerEl.appendChild(heading);

    let visible;
    if (usingSearch) {
      visible = this.searchResults;
    } else if (this.sortMode === "viewers") {
      visible = [...this.games].sort((a, b) => {
        const av = this.categoryCounts.get(a.id)?.viewer_count || 0;
        const bv = this.categoryCounts.get(b.id)?.viewer_count || 0;
        return bv - av;
      });
    } else {
      visible = this.games;
    }

    if (visible.length === 0) {
      const empty = document.createElement("div");
      empty.className = "home-section-title";
      empty.textContent = "No categories found.";
      this.containerEl.appendChild(empty);
      return;
    }

    const grid = document.createElement("div");
    grid.className = "browse-games-grid";
    for (const game of visible) {
      grid.appendChild(this.buildGameCard(game));
    }
    this.containerEl.appendChild(grid);

    // Auto-loading footer (spinner while fetching, end-of-list message
    // once exhausted) rather than a clickable button - loading the next
    // page is now triggered by _handleScroll(), not a click. Hidden
    // while sorting by viewers, same reasoning as the Live Channels
    // grid: re-sorting a growing list as more pages arrive would
    // reshuffle cards already seen.
    if (!usingSearch && this.sortMode !== "viewers") {
      this.containerEl.appendChild(
        this._buildPaginationFooter(this.hasMoreGames, this.loadingMoreGames, this.games.length)
      );
    }
  }

  /** Shared footer for both infinite-scrolling grids on this page
   * (Categories and Live Channels): a quiet spinner while a page is
   * loading, nothing while idle with more available (the scroll
   * listener handles triggering the next load silently), or an
   * end-of-list note once the server has confirmed there's nothing
   * further - never a clickable control, since loading more is now
   * entirely scroll-driven, matching twitch.tv's own directory. */
  _buildPaginationFooter(hasMore, isLoading, currentCount) {
    const footer = document.createElement("div");
    footer.className = "browse-pagination-footer";
    if (isLoading) {
      footer.innerHTML = '<span class="browse-pagination-spinner"></span> Loading more…';
    } else if (!hasMore && currentCount > CATEGORIES_COLLAPSED_COUNT) {
      // Only worth saying once there's been enough scrolling for it to
      // be a meaningful confirmation rather than noise right under a
      // short first page.
      footer.textContent = "You've reached the end of the list.";
    }
    return footer;
  }

  buildGameCard(game) {
    const card = document.createElement("button");
    card.className = "browse-game-card";
    card.addEventListener("click", () => this.openGame(game));

    const art = document.createElement("img");
    art.className = "browse-game-art";
    art.src = boxArtUrl(game.box_art_url, 188, 250);
    art.alt = "";
    card.appendChild(art);

    const name = document.createElement("div");
    name.className = "browse-game-name";
    name.textContent = game.name;
    card.appendChild(name);

    // Approximated viewer count (see get_category_viewer_counts in
    // main.rs) - omitted entirely rather than showing "0 viewers" for a
    // category that simply wasn't in the sample, since that would read
    // as "nobody's watching this" when the truth is just "not measured."
    const counts = this.categoryCounts.get(game.id);
    if (counts && counts.viewer_count > 0) {
      const viewers = document.createElement("div");
      viewers.className = "browse-game-viewers";
      viewers.textContent = `${formatViewerCount(counts.viewer_count)} viewers`;
      card.appendChild(viewers);
    }

    return card;
  }

  // Mirrors home.js's buildGridCard exactly, for visual consistency
  // between the home feed's grid sections and the Browse page's
  // per-category streams grid.
  buildStreamCard(s) {
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

/** First occurrence wins, keyed on game id (Twitch numeric ids and Kick
 * slugs alike). Entries with no id at all pass through untouched -
 * better a rare double card than silently dropping distinct categories
 * that happen to both lack an id. */
function dedupeGamesById(list) {
  const seen = new Set();
  return list.filter((g) => {
    const id = g && g.id != null ? String(g.id) : "";
    if (!id) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function boxArtUrl(template, width, height) {
  if (!template) return blankAvatarDataUri();
  return template.replace("{width}", String(width)).replace("{height}", String(height));
}

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
