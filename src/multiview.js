// MultiView: full-screen grid of several streams at once.
//
// Built outside the single-stream player/relay stack: each tile is a bare
// <video> fed by attachHlsVod + get_live_m3u8_url (native-HLS, cross-platform,
// no relay). Tradeoff: tiles get weaker ad-stripping than the main player's
// byte relay - fine for a monitoring grid.

import { attachHlsVod } from "./vod-player.js";
import { invoke } from "@tauri-apps/api/core";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { TwitchChat } from "./chat.js";

export class MultiView {
  constructor() {
    this.tiles = new Map(); // channel(lowercase) -> tile record
    this.focusedChannel = null;
    this.rootEl = null;
    this._open = false;
    this._chat = null;         // single shared TwitchChat, follows focus
    this._chatChannel = null;  // channel the shared chat is connected to
    this._theater = false;     // theater mode: only the focused tile shows
    this._spotlight = true;    // 3+ tiles: one big + strip (vs even grid)
    this._multiAudio = false;   // multi-audio mode: independent per-tile audio.
                                // Default OFF = single-focus (clicking a tile
                                // moves audio to it, mutes the rest).
  }

  get isOpen() { return this._open; }

  // Enable the shared chat's input; re-applied when it reconnects on focus change.
  setLoggedIn(login, userId, displayName) {
    this._login = { login, userId, displayName };
    this._chat?.setLoggedIn(login, userId, displayName);
  }

  /** Builds the overlay DOM lazily on first open. */
  _ensureRoot() {
    if (this.rootEl) return;
    const root = document.createElement("div");
    root.id = "multiview";
    root.className = "multiview-overlay";
    root.innerHTML = `
      <div class="multiview-bar">
        <span class="multiview-title">MultiView</span>
        <span class="multiview-count"></span>
        <span class="multiview-bar-divider"></span>
        <div class="multiview-add">
          <button class="multiview-followed-btn mv-tip" data-tooltip="Add from followed">
            <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>
          </button>
          <input type="text" class="multiview-add-input"
                 placeholder="Add a channel..." spellcheck="false" />
          <button class="multiview-add-btn">Add</button>
        </div>
        <div class="multiview-followed-panel" style="display:none">
          <div class="multiview-followed-header">
            <span>Followed channels</span>
            <button class="multiview-followed-close" title="Close">&times;</button>
          </div>
          <div class="multiview-followed-list"></div>
        </div>
        <span class="multiview-bar-divider"></span>
        <button class="multiview-autopip multiview-icon-btn mv-tip" data-tooltip="Auto-PiP on tab-out">
          <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path d="M3 5h18v14H3V5zm10 5h6v5h-6v-5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>
        </button>
        <button class="multiview-multiaudio multiview-icon-btn mv-tip" data-tooltip="Multi-audio">
          <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4zm12.5 3a4 4 0 00-2-3.5M18.5 12a7 7 0 00-3.5-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <button class="multiview-theater multiview-icon-btn mv-tip" data-tooltip="Theater (T)">
          <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path d="M3 5h18v14H3V5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>
        </button>
        <button class="multiview-spotlight multiview-icon-btn mv-tip" data-tooltip="Spotlight layout">
          <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path d="M3 4h18v10H3V4zm0 13h5v3H3v-3zm7 0h5v3h-5v-3zm7 0h4v3h-4v-3z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>
        </button>
        <span class="multiview-bar-divider"></span>
        <button class="multiview-close multiview-icon-btn mv-tip" data-tooltip="Close (Esc)">
          <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>
        </button>
      </div>
      <div class="multiview-body">
        <div class="multiview-grid-wrap">
          <div class="multiview-grid"></div>
          <div class="multiview-empty">
            Add channels above to start watching several at once.
          </div>
        </div>
        <div class="multiview-chat">
          <div class="multiview-chat-header">
            <span class="multiview-chat-title">Chat</span>
            <span class="multiview-chat-channel"></span>
          </div>
          <div class="multiview-chat-body-wrap">
            <div class="multiview-chat-body" id="multiview-chat-body"></div>
            <button id="multiview-jump-to-latest" class="jump-to-latest-btn">
              Chat paused <span id="multiview-jump-to-latest-count"></span>
            </button>
          </div>
          <div class="multiview-chat-status" id="multiview-chat-status"></div>
          <div class="multiview-chat-input-row">
            <div class="multiview-chat-input-wrapper">
              <div id="multiview-chat-input-badge" class="chat-input-badge"></div>
              <textarea id="multiview-chat-input" class="multiview-chat-input"
                        rows="1" placeholder="Send a message" disabled></textarea>
              <button id="multiview-chat-emote-btn" class="chat-emote-btn" type="button" title="Emotes" disabled>
                <svg viewBox="0 0 24 24" width="18" height="18">
                  <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.6"/>
                  <circle cx="8.7" cy="9.8" r="1.15" fill="currentColor"/>
                  <circle cx="15.3" cy="9.8" r="1.15" fill="currentColor"/>
                  <path d="M8 14.2c1 1.3 2.4 2 4 2s3-.7 4-2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
                </svg>
              </button>
            </div>
            <button id="multiview-chat-send" class="multiview-chat-send" disabled>Chat</button>
          </div>
          <div id="multiview-emote-picker-menu" class="emote-picker-menu"></div>
        </div>
      </div>
    `;
    document.body.appendChild(root);
    this.rootEl = root;
    this.gridEl = root.querySelector(".multiview-grid");
    this.emptyEl = root.querySelector(".multiview-empty");
    this.countEl = root.querySelector(".multiview-count");
    this.chatChannelEl = root.querySelector(".multiview-chat-channel");

    // Auto-hide the floating command bar. Only mouse movement over the video
    // grid area reveals it (moving the mouse in the chat sidebar shouldn't wake
    // it). Any move there resets a 2.5s idle timer; the bar stays put while
    // hovered or while the followed panel is open so it can't vanish mid-action.
    this._barIdleTimer = null;
    const revealBar = () => {
      root.classList.remove("multiview-bar-hidden");
      if (this._barIdleTimer) clearTimeout(this._barIdleTimer);
      this._barIdleTimer = setTimeout(() => {
        const bar = root.querySelector(".multiview-bar");
        const panelOpen = this.followedPanel && this.followedPanel.style.display !== "none";
        if (bar && bar.matches(":hover")) return; // don't hide under the cursor
        if (panelOpen) return;
        root.classList.add("multiview-bar-hidden");
      }, 2500);
    };
    const gridWrap = root.querySelector(".multiview-grid-wrap");
    gridWrap?.addEventListener("mousemove", revealBar);
    // Hovering the floating bar itself keeps it alive (it can extend beyond the
    // grid-wrap's mousemove coverage while shown).
    root.querySelector(".multiview-bar")?.addEventListener("mousemove", (e) => {
      e.stopPropagation();
      revealBar();
    });
    this._revealBar = revealBar;

    // Recompute 16:9 tile sizing when the window resizes.
    this._onResize = () => { if (this._open) this._refreshLayout(); };
    window.addEventListener("resize", this._onResize);

    // One shared chat that reconnects to the focused channel. Only one channel
    // is ever connected, so the global chat-message event stays unambiguous.
    this._chat = new TwitchChat({
      container: root.querySelector("#multiview-chat-body"),
      statusEl: root.querySelector("#multiview-chat-status"),
      inputEl: root.querySelector("#multiview-chat-input"),
      sendBtn: root.querySelector("#multiview-chat-send"),
      emoteBtn: root.querySelector("#multiview-chat-emote-btn"),
      emotePickerMenu: root.querySelector("#multiview-emote-picker-menu"),
      inputBadge: root.querySelector("#multiview-chat-input-badge"),
      jumpToLatestBtn: root.querySelector("#multiview-jump-to-latest"),
      jumpToLatestCount: root.querySelector("#multiview-jump-to-latest-count"),
    });

    const input = root.querySelector(".multiview-add-input");
    const add = () => {
      const v = input.value.trim().toLowerCase().replace(/^#/, "");
      if (v) { this.addChannel(v); input.value = ""; }
    };
    root.querySelector(".multiview-add-btn").addEventListener("click", add);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") add(); });
    root.querySelector(".multiview-close").addEventListener("click", () => this.close());
    root.querySelector(".multiview-theater").addEventListener("click", () => this.toggleTheater());
    // Spotlight vs even-grid layout (only affects 3+ tiles).
    const spotBtn = root.querySelector(".multiview-spotlight");
    spotBtn.classList.toggle("active", this._spotlight);
    spotBtn.addEventListener("click", () => {
      this._spotlight = !this._spotlight;
      spotBtn.classList.toggle("active", this._spotlight);
      this._refreshLayout();
    });
    // Auto-PiP shares the same localStorage key as the single-view setting, so
    // toggling here or there stays in sync (it's one global preference).
    const autoPipBtn = root.querySelector(".multiview-autopip");
    const syncAutoPipBtn = () => {
      autoPipBtn.classList.toggle("active", localStorage.getItem("autoPipOnBlur") === "1");
    };
    syncAutoPipBtn();
    autoPipBtn.addEventListener("click", () => {
      const next = localStorage.getItem("autoPipOnBlur") !== "1";
      localStorage.setItem("autoPipOnBlur", next ? "1" : "0");
      syncAutoPipBtn();
    });
    root.querySelector(".multiview-multiaudio").addEventListener("click", () => this.toggleMultiAudio());

    this.followedPanel = root.querySelector(".multiview-followed-panel");
    this.followedListEl = root.querySelector(".multiview-followed-list");
    root.querySelector(".multiview-followed-btn")
      .addEventListener("click", () => this._toggleFollowedPanel());
    root.querySelector(".multiview-followed-close")
      .addEventListener("click", () => this._toggleFollowedPanel(false));
  }

  /** HTML-escapes a string for safe insertion via innerHTML. */
  _escape(str) {
    const d = document.createElement("div");
    d.textContent = String(str ?? "");
    return d.innerHTML;
  }

  /** Opens/closes the followed-channels picker, loading it on first open. */
  _toggleFollowedPanel(force) {
    if (!this.followedPanel) return;
    const show = force ?? this.followedPanel.style.display === "none";
    this.followedPanel.style.display = show ? "" : "none";
    if (show) {
      // Show cached rows instantly if we have them, then refresh in the background.
      if (this._followedCache) {
        this._renderFollowedRows(this._followedCache);
      }
      this._loadFollowed();
    }
  }

  // Load followed channels, rendering names first then enriching with live
  // status + avatars so the panel isn't blocked on all three calls.
  async _loadFollowed() {
    if (!this.followedListEl) return;
    if (!this._followedCache) {
      this.followedListEl.innerHTML = '<div class="multiview-followed-loading">Loading...</div>';
    }
    let followedRows;
    try {
      followedRows = JSON.parse(await invoke("get_followed_channels"));
    } catch (err) {
      if (!this._followedCache) {
        this.followedListEl.innerHTML =
          '<div class="multiview-followed-empty">Couldn\'t load followed channels. '
          + 'Are you logged in to Twitch?</div>';
      }
      return;
    }
    if (!followedRows.length) {
      this.followedListEl.innerHTML =
        '<div class="multiview-followed-empty">You don\'t follow any channels yet.</div>';
      return;
    }

    // Show names immediately, before the live/avatar calls return.
    const baseRows = followedRows.map((r) => ({
      login: (r.broadcaster_login || r.broadcaster_name || "").toLowerCase(),
      name: r.broadcaster_name || r.broadcaster_login || "",
      broadcaster_id: r.broadcaster_id,
      avatar: "", live: false, viewers: 0, game: "",
    })).filter((r) => r.login);
    baseRows.sort((a, b) => a.name.localeCompare(b.name));
    if (!this._followedCache) this._renderFollowedRows(baseRows);

    // Enrich with live status + avatars, then re-render sorted live-first.
    const ids = followedRows.map((r) => r.broadcaster_id);
    let liveRows = [];
    const avatarById = new Map();
    try {
      const [liveRes, usersRes] = await Promise.allSettled([
        invoke("get_streams_for_users", { broadcasterIds: ids }),
        invoke("get_users_info", { userIds: ids }),
      ]);
      if (liveRes.status === "fulfilled") liveRows = JSON.parse(liveRes.value);
      if (usersRes.status === "fulfilled" && usersRes.value) {
        for (const u of JSON.parse(usersRes.value)) avatarById.set(u.id, u.profile_image_url);
      }
    } catch { /* non-fatal */ }
    const liveById = new Map(liveRows.map((s) => [s.user_id, s]));

    const rows = baseRows.map((r) => {
      const live = liveById.get(r.broadcaster_id);
      return {
        ...r,
        avatar: avatarById.get(r.broadcaster_id) || "",
        live: Boolean(live),
        viewers: live ? (live.viewer_count || 0) : 0,
        game: live ? (live.game_name || "") : "",
      };
    });
    rows.sort((a, b) => {
      if (a.live !== b.live) return a.live ? -1 : 1;
      if (a.live) return b.viewers - a.viewers;
      return a.name.localeCompare(b.name);
    });

    this._followedCache = rows; // instant on next open
    this._renderFollowedRows(rows);
  }

  /** Renders a set of followed rows into the panel list. */
  _renderFollowedRows(rows) {
    if (!this.followedListEl) return;
    this.followedListEl.innerHTML = "";
    for (const r of rows) {
      const item = document.createElement("button");
      item.className = "multiview-followed-item" + (r.live ? " is-live" : "");
      const already = this.tiles.has(r.login);
      const avatar = r.avatar
        ? `<img class="multiview-followed-avatar" src="${this._escape(r.avatar)}" alt="" />`
        : `<span class="multiview-followed-avatar multiview-followed-avatar-fallback">${this._escape(r.name.charAt(0).toUpperCase())}</span>`;
      const sub = r.live
        ? `<span class="multiview-followed-sub">${r.game ? this._escape(r.game) : "Live"}</span>`
        : `<span class="multiview-followed-sub offline">Offline</span>`;
      item.innerHTML = `
        <span class="multiview-followed-avatar-wrap">
          ${avatar}
          ${r.live ? '<span class="multiview-followed-live-dot"></span>' : ''}
        </span>
        <span class="multiview-followed-text">
          <span class="multiview-followed-name">${this._escape(r.name)}</span>
          ${sub}
        </span>
        ${r.live ? `<span class="multiview-followed-viewers">${this._formatViewers(r.viewers)}</span>` : ''}
        <span class="multiview-followed-add">${already ? "✓" : "+"}</span>
      `;
      if (already) item.classList.add("added");
      item.addEventListener("click", () => {
        if (this.tiles.has(r.login)) return;
        this.addChannel(r.login);
        item.classList.add("added");
        item.querySelector(".multiview-followed-add").textContent = "✓";
      });
      this.followedListEl.appendChild(item);
    }
  }

  /** 1234 -> "1.2K", 999 -> "999". */
  _formatViewers(n) {
    if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, "") + "K";
    return String(n);
  }

  open(initialChannels = [], hooks = {}) {
    if (this._open) return; // already open - don't leak a second esc handler
    this._ensureRoot();
    this._open = true;
    this._hooks = hooks;
    this.rootEl.classList.add("multiview-open");
    document.body.classList.add("multiview-active");
    // Stop the main player so it doesn't play under the grid (main.js supplies the hook).
    this._hooks.onOpen?.();
    // Escape closes; T toggles theater. Ignored while typing in a text field.
    this._escHandler = (e) => {
      const tag = e.target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") {

        return;
      }
      if (e.key === "Escape") {
        // Back out one level at a time: followed panel, then theater, then
        // close the overlay.
        if (this.followedPanel && this.followedPanel.style.display !== "none") {
          this._toggleFollowedPanel(false);
        } else if (this._theater) {
          this.toggleTheater();
        } else {
          this.close();
        }
      }
      else if (e.key === "t" || e.key === "T") this.toggleTheater();
    };
    document.addEventListener("keydown", this._escHandler);
    // Reflect active state on the nav tab.
    document.getElementById("multiview-tab")?.classList.add("nav-tab-active");
    for (const ch of initialChannels) this.addChannel(ch);
    this._refreshLayout();
    // Recompute once the overlay has actually been laid out (clientWidth/Height
    // are 0 until then).
    requestAnimationFrame(() => this._refreshLayout());
    this._revealBar?.(); // show the bar, then let it auto-hide when idle
  }

  close() {
    this._open = false;
    // Tear down any drag left in progress (removes window listeners + ghost).
    if (this._activeDragCleanup) this._activeDragCleanup();
    this._removeSplitHandle();
    if (this._barIdleTimer) { clearTimeout(this._barIdleTimer); this._barIdleTimer = null; }
    if (this._onResize) { window.removeEventListener("resize", this._onResize); this._onResize = null; }
    this.rootEl?.classList.remove("multiview-bar-hidden");
    if (this.rootEl) this.rootEl.classList.remove("multiview-open");
    document.body.classList.remove("multiview-active");
    if (this._escHandler) {
      document.removeEventListener("keydown", this._escHandler);
      this._escHandler = null;
    }
    document.getElementById("multiview-tab")?.classList.remove("nav-tab-active");
    // Reset theater so a fresh open starts in grid view.
    this._theater = false;
    this.rootEl?.classList.remove("multiview-theater-on");
    this.rootEl?.querySelector(".multiview-theater")?.classList.remove("active");
    this._multiAudio = false;
    this.rootEl?.classList.remove("multiview-multiaudio-on");
    this.rootEl?.querySelector(".multiview-multiaudio")?.classList.remove("active");
    // Tear down every tile: stop video, free the HLS instances.
    for (const ch of [...this.tiles.keys()]) this.removeChannel(ch);
    // Disconnect the shared chat so its IRC connection doesn't linger.
    if (this._chat) { this._chat.disconnect?.().catch?.(() => {}); this._chatChannel = null; }
    // Restore the main player's audio that we silenced on open.
    this._hooks?.onClose?.();
  }

  async addChannel(channel) {
    channel = channel.toLowerCase().replace(/^#/, "");
    if (this.tiles.has(channel)) return; // already present
    if (this.tiles.size >= 9) return;    // sane cap for a 3x3 grid

    const tileEl = document.createElement("div");
    tileEl.className = "multiview-tile";
    tileEl.dataset.channel = channel;
    tileEl.innerHTML = `
      <div class="multiview-tile-video">
        <video playsinline muted></video>
        <div class="multiview-tile-loading">Loading ${channel}...</div>
        <div class="multiview-tile-overlay">
          <span class="multiview-tile-name">${channel}</span>
          <div class="multiview-tile-actions">
            <select class="multiview-tile-quality" title="Quality">
              <option value="best">Source</option>
              <option value="720p60">720p60</option>
              <option value="720p">720p</option>
              <option value="480p">480p</option>
              <option value="360p">360p</option>
              <option value="160p">160p</option>
            </select>
            <button class="multiview-tile-mute" title="Mute/unmute">🔇</button>
            <input class="multiview-tile-volume" type="range" min="0" max="1" step="0.05" value="0" title="Volume" />
            <button class="multiview-tile-pip" title="Picture in Picture">⧉</button>
            <button class="multiview-tile-fs" title="Fullscreen">⛶</button>
            <button class="multiview-tile-remove" title="Remove">&times;</button>
          </div>
        </div>
      </div>
    `;
    this.gridEl.appendChild(tileEl);

    const videoEl = tileEl.querySelector("video");
    const loadingEl = tileEl.querySelector(".multiview-tile-loading");

    const record = { channel, tileEl, videoEl, hls: null, quality: "best", volumeLevel: 0 };
    this.tiles.set(channel, record);

    // Clicking a tile sets chat focus; audio is per-tile via the controls below.
    tileEl.querySelector(".multiview-tile-video")
      .addEventListener("click", (e) => {
        if (e.target.closest(".multiview-tile-actions")) return; // let buttons act
        if (this._justDragged) return; // ignore the click that ends a drag
        this.focus(channel);
      });
    tileEl.querySelector(".multiview-tile-remove")
      .addEventListener("click", () => this.removeChannel(channel));
    tileEl.querySelector(".multiview-tile-mute")
      .addEventListener("click", (e) => {
        e.stopPropagation();
        if (this._multiAudio) this.toggleTileMute(channel);
        else this.focus(channel); // single-focus: move audio here
      });
    tileEl.querySelector(".multiview-tile-volume")
      .addEventListener("input", (e) => { e.stopPropagation(); this.setTileVolume(channel, parseFloat(e.target.value)); });
    tileEl.querySelector(".multiview-tile-quality")
      .addEventListener("change", (e) => this._setQuality(channel, e.target.value));
    tileEl.querySelector(".multiview-tile-pip")
      .addEventListener("click", (e) => {
        e.stopPropagation();
        this.popOutToNativePip(channel);
      });
    tileEl.querySelector(".multiview-tile-fs")
      .addEventListener("click", (e) => {
        e.stopPropagation();
        const target = tileEl.querySelector(".multiview-tile-video");
        try {
          if (document.fullscreenElement) document.exitFullscreen();
          else target.requestFullscreen();
        } catch { /* ignore */ }
      });

    // Drag-to-reorder: the whole tile is draggable. A movement threshold keeps
    // a plain click as focus (not a drag), and pointerdowns landing on the
    // controls/overlay are ignored so buttons and sliders still work.
    tileEl.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return; // left button only
      if (e.target.closest(".multiview-tile-actions, .multiview-tile-overlay, .multiview-tile-quality, input, button, select")) return;
      this._maybeBeginTileDrag(channel, tileEl, e);
    });

    await this._loadVideo(record, loadingEl);
    // First tile added becomes the audio focus automatically.
    if (!this.focusedChannel) this.focus(channel);
    this._refreshLayout();
  }

  /** Pointer-based tile drag: a ghost chip follows the cursor, the hovered
   *  tile highlights, and releasing swaps them. */
  /** Waits for the pointer to move past a small threshold before committing to
   *  a drag, so a plain click still focuses the tile (handled separately). */
  _maybeBeginTileDrag(channel, tileEl, downEvent) {
    const startX = downEvent.clientX, startY = downEvent.clientY;
    const THRESHOLD = 6; // px of movement before it counts as a drag
    let armed = true;
    const onMove = (e) => {
      if (!armed) return;
      if (Math.abs(e.clientX - startX) > THRESHOLD || Math.abs(e.clientY - startY) > THRESHOLD) {
        armed = false;
        cleanup();
        this._beginTileDrag(channel, tileEl, e);
      }
    };
    const onUp = () => { armed = false; cleanup(); };
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  _beginTileDrag(channel, tileEl, downEvent) {
    tileEl.classList.add("multiview-tile-dragging");
    let overEl = null;

    // A floating chip under the cursor so it's obvious something is being
    // dragged (the tile itself stays in the grid, just dimmed).
    const ghost = document.createElement("div");
    ghost.className = "multiview-drag-ghost";
    ghost.textContent = `⠿  ${channel}`;
    document.body.appendChild(ghost);
    const moveGhost = (x, y) => {
      ghost.style.left = `${x + 12}px`;
      ghost.style.top = `${y + 12}px`;
    };
    moveGhost(downEvent.clientX, downEvent.clientY);

    const clearOver = () => {
      if (overEl) { overEl.classList.remove("multiview-tile-dragover"); overEl = null; }
    };
    const onMove = (e) => {
      moveGhost(e.clientX, e.clientY);
      // The dragged tile has pointer-events suppressed (see CSS) so
      // elementFromPoint returns the tile underneath, not the one we're moving.
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const targetTile = el?.closest?.(".multiview-tile");
      if (targetTile && targetTile !== tileEl) {
        if (overEl !== targetTile) { clearOver(); overEl = targetTile; overEl.classList.add("multiview-tile-dragover"); }
      } else {
        clearOver();
      }
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      this._activeDragCleanup = null;
      tileEl.classList.remove("multiview-tile-dragging");
      ghost.remove();
      const targetCh = overEl?.dataset?.channel;
      clearOver();
      if (targetCh && targetCh !== channel) this._swapTiles(channel, targetCh);
      // Swallow the click that fires right after this pointerup.
      this._justDragged = true;
      setTimeout(() => { this._justDragged = false; }, 0);
    };
    // Exposed so close() can tear down a drag left in progress.
    this._activeDragCleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      tileEl.classList.remove("multiview-tile-dragging");
      ghost.remove();
      clearOver();
      this._activeDragCleanup = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  /** Swaps two tiles' positions in the grid DOM (drag-to-reorder). */
  _swapTiles(chA, chB) {
    const a = this.tiles.get(chA)?.tileEl;
    const b = this.tiles.get(chB)?.tileEl;
    if (!a || !b || a === b) return;
    // Swap DOM positions using placeholder nodes so it works regardless of
    // whether the two are adjacent.
    const marker = document.createElement("div");
    a.parentNode.insertBefore(marker, a);
    b.parentNode.insertBefore(a, b);
    marker.parentNode.insertBefore(b, marker);
    marker.remove();
  }

  async _loadVideo(record, loadingEl) {
    try {
      const m3u8 = await invoke("get_live_m3u8_url", {
        channel: record.channel,
        quality: record.quality,
      });
      if (!this.tiles.has(record.channel)) return; // removed while resolving
      if (record.hls) { record.hls.destroy(); record.hls = null; }
      record.hls = attachHlsVod(record.videoEl, m3u8, {
        startPosition: -1,
        liveEdge: true,
        smallPlayer: true, // grid tiles are small; cap quality/buffers
        onFatalError: () => {
          if (loadingEl) loadingEl.textContent = `${record.channel} unavailable`;
        },
      });
      record.videoEl.play().catch(() => {});
      if (loadingEl) loadingEl.style.display = "none";
    } catch (err) {
      if (loadingEl) loadingEl.textContent = `${record.channel} offline or unavailable`;
    }
  }

  async _setQuality(channel, quality) {
    const record = this.tiles.get(channel);
    if (!record || record.quality === quality) return;
    record.quality = quality;
    const loadingEl = record.tileEl.querySelector(".multiview-tile-loading");
    if (loadingEl) { loadingEl.style.display = ""; loadingEl.textContent = `Loading ${channel}...`; }
    await this._loadVideo(record, loadingEl);
    // Preserve this tile's own audio state across the reattach.
    const vol = record.volumeLevel ?? 0;
    record.videoEl.volume = vol;
    record.videoEl.muted = vol === 0;
    if (vol > 0) record.videoEl.play().catch(() => {});
    this._updateTileAudioUi(record);
  }

  // Theater: show only the focused tile, filling the grid area.
  toggleTheater() {
    this._theater = !this._theater;
    this.rootEl?.classList.toggle("multiview-theater-on", this._theater);
    const btn = this.rootEl?.querySelector(".multiview-theater");
    if (btn) btn.classList.toggle("active", this._theater);
    this._applyTheater();
    this._refreshLayout();
  }

  // Show only the focused tile in theater mode.
  _applyTheater() {
    for (const [ch, rec] of this.tiles) {
      const hidden = this._theater && ch !== this.focusedChannel;
      rec.tileEl.style.display = hidden ? "none" : "";
    }
  }

  focus(channel, { keepAudio = false } = {}) {
    this.focusedChannel = channel;
    for (const [ch, rec] of this.tiles) {
      const focused = ch === channel;
      rec.tileEl.classList.toggle("multiview-tile-focused", focused);
      if (!this._multiAudio && !keepAudio) {
        // Single-focus: only the focused tile is audible, at its saved level.
        if (focused) {
          if (rec.volumeLevel == null || rec.volumeLevel === 0) rec.volumeLevel = 1;
          rec.videoEl.muted = false;
          rec.videoEl.volume = rec.volumeLevel;
          rec.videoEl.play().catch(() => {});
        } else {
          rec.videoEl.muted = true;
          rec.videoEl.volume = 0;
          // Keep rec.volumeLevel as the user's saved preference; don't zero it.
        }
        this._updateTileAudioUi(rec);
      }
      // Multi-audio (or keepAudio): leave audio as-is; focus only moves the
      // highlight + chat.
    }
    this._connectChat(channel);
    this._applyTheater();
    // In spotlight, the focused tile is the big one - refresh so clicking a
    // strip tile promotes it into the main slot.
    if (this._spotlight && this.tiles.size >= 3 && !this._theater) {
      this._applySpotlight();
    }
  }

  // Toggle single-focus vs multi-audio (independent per-tile volume).
  toggleMultiAudio() {
    this._multiAudio = !this._multiAudio;
    this.rootEl?.classList.toggle("multiview-multiaudio-on", this._multiAudio);
    this.rootEl?.querySelector(".multiview-multiaudio")?.classList.toggle("active", this._multiAudio);
    if (this._multiAudio) {
      // Seed each tile's slider from its current audio state.
      for (const [ch, rec] of this.tiles) {
        rec.volumeLevel = rec.videoEl.muted ? 0 : (rec.videoEl.volume || 0);
        this._updateTileAudioUi(rec);
      }
    } else {
      // Back to single-focus: only the focused tile stays audible.
      if (this.focusedChannel) {
        this.focus(this.focusedChannel);
      } else {
        for (const [, rec] of this.tiles) {
          rec.videoEl.muted = true;
          rec.videoEl.volume = 0;
          this._updateTileAudioUi(rec);
        }
      }
    }
  }

  // Set a tile's volume (0..1), unmuting if > 0.
  setTileVolume(channel, vol) {
    const rec = this.tiles.get(channel);
    if (!rec) return;

    // Single-focus: dragging a tile's slider focuses it, then sets the level.
    if (!this._multiAudio && this.focusedChannel !== channel) {
      this.focus(channel);
    }

    rec.volumeLevel = vol;
    rec.videoEl.volume = vol;
    if (vol > 0 && rec.videoEl.muted) {
      rec.videoEl.muted = false;
    }
    // play() inside the gesture unlocks audio past the autoplay gate.
    if (vol > 0) rec.videoEl.play().catch(() => {});
    this._updateTileAudioUi(rec);
  }

  // Toggle a tile's mute, restoring its slider level on unmute.
  toggleTileMute(channel) {
    const rec = this.tiles.get(channel);
    if (!rec) return;
    const nowMuted = !rec.videoEl.muted;
    rec.videoEl.muted = nowMuted;
    if (!nowMuted) {
      // Unmuting: if the slider was at 0, bump to a sensible default.
      if (!rec.volumeLevel || rec.volumeLevel === 0) rec.volumeLevel = 0.5;
      rec.videoEl.volume = rec.volumeLevel;
      rec.videoEl.play().catch(() => {});
    }
    this._updateTileAudioUi(rec);
  }

  // Sync a tile's mute glyph + slider to its audio state.
  _updateTileAudioUi(rec) {
    const audible = !rec.videoEl.muted && (rec.volumeLevel ?? 0) > 0;
    const btn = rec.tileEl.querySelector(".multiview-tile-mute");
    if (btn) btn.textContent = audible ? "🔊" : "🔇";
    const slider = rec.tileEl.querySelector(".multiview-tile-volume");
    // Show the saved level even when muted, so it can be pre-set.
    if (slider) slider.value = String(rec.volumeLevel ?? 0);
  }

  // Point the shared chat at `channel` (only one is ever connected).
  _connectChat(channel) {
    if (!this._chat || this._chatChannel === channel) return;
    this._chatChannel = channel;
    if (this.chatChannelEl) this.chatChannelEl.textContent = channel ? `#${channel}` : "";
    if (channel) {
      this._chat.connect(channel).catch(() => {});
    } else {
      this._chat.disconnect?.().catch?.(() => {});
    }
  }

  /**
   * Pops a tile out into its own native always-on-top PiP window and removes
   * it from the grid (removing it keeps a bad connection from carrying both
   * the grid tile and the window). Each window gets a unique label so several
   * can coexist - browser PiP allows only one, native Tauri windows don't.
   */
  async popOutToNativePip(channel) {
    const rec = this.tiles.get(channel);
    if (!rec) return;
    // Suppresses the tab-out auto-PiP: creating a Tauri window steals focus,
    // and without this a manual pop-out would trigger auto-PiP for the rest.
    this.isOpeningPip = true;
    try {
      await this._doPopOutToNativePip(channel, rec);
    } finally {
      // Hold the flag briefly past creation so the focus-loss event (which
      // arrives slightly after) is still suppressed.
      setTimeout(() => { this.isOpeningPip = false; }, 800);
    }
  }

  async _doPopOutToNativePip(channel, rec) {
    const label = `pip-${channel.replace(/[^a-z0-9_-]/gi, "")}`;
    // Adopt-and-close any stale window with this label before creating fresh.
    const stale = await WebviewWindow.getByLabel(label).catch(() => null);
    if (stale) await stale.close().catch(() => {});

    // Pass the channel + quality, NOT the resolved m3u8 - a live m3u8 URL is
    // huge (tokened usher URL) and breaks the pip.html query string. pip.js
    // resolves it itself via get_live_m3u8_url.
    // Popping out is an intent to watch this stream, so the PiP plays
    // audible by default (at the tile's level, or full if it was muted in
    // the grid) rather than inheriting a muted background tile's state.
    const pipVolume = (rec.volumeLevel ?? 0) > 0 ? rec.volumeLevel : 1;
    const params = new URLSearchParams({
      mode: "mv",
      mvchannel: channel,
      mvquality: rec.quality || "best",
      volume: String(pipVolume),
      muted: "0",
      channel,
      kick: "0",
    });
    const win = new WebviewWindow(label, {
      url: `pip.html?${params}`,
      width: 480, height: 270,
      minWidth: 192, minHeight: 108,
      alwaysOnTop: true, decorations: false, resizable: true,
      maximizable: false, skipTaskbar: false,
      title: `PiP - ${channel}`,
      visible: false,
    });

    // Only proceed once the window is actually created. If creation errors,
    // leave the tile in the grid rather than stranding it.
    let created = false;
    try {
      await new Promise((resolve, reject) => {
        let timer = null;
        const done = (fn, arg) => { if (timer) clearTimeout(timer); fn(arg); };
        win.once("tauri://created", () => { created = true; done(resolve); });
        win.once("tauri://error", (e) => done(reject, e?.payload || "window error"));
        timer = setTimeout(() => (created ? resolve() : reject("timeout")), 4000);
      });
    } catch (err) {
      console.error("[multiview] PiP window failed to create:", err);
      try { await win.close(); } catch {}
      return; // tile stays in the grid
    }

    // Bring the stream back into the grid when the PiP window closes. Guarded
    // by a flag so a stray early 'destroyed' can't fire the re-add. Also set
    // isOpeningPip briefly: closing the window can transiently blur the main
    // window, and without this the tab-out auto-PiP would pop out a DIFFERENT
    // tile in response.
    let popped = true;
    win.once("tauri://destroyed", async () => {
      this.isOpeningPip = true;
      setTimeout(() => { this.isOpeningPip = false; }, 800);
      if (popped && this._open && !this.tiles.has(channel)) {
        await this.addChannel(channel);
        // You were hearing this stream in PiP, so keep it audible: focus it
        // when it returns (unless multi-audio, where sliders own audio).
        if (!this._multiAudio) this.focus(channel);
      }
    });

    // Now that the window exists, remove the tile so we're not decoding twice.
    this.removeChannel(channel);
  }

  removeChannel(channel) {
    const record = this.tiles.get(channel);
    if (!record) return;
    if (record.hls) { record.hls.destroy(); record.hls = null; }
    try { record.videoEl.pause(); record.videoEl.removeAttribute("src"); record.videoEl.load(); } catch {}
    record.tileEl.remove();
    this.tiles.delete(channel);
    if (this.focusedChannel === channel) {
      this.focusedChannel = null;
      // Hand focus (highlight + chat) to a remaining tile, but do NOT
      // auto-unmute it - a background tile the user had silent shouldn't
      // start blasting just because the focused tile was popped out. Pass
      // keepAudio so focus() only moves the highlight/chat.
      const next = this.tiles.keys().next().value;
      if (next) this.focus(next, { keepAudio: true });
      else this._connectChat(null);
    }
    this._refreshLayout();
  }

  // Choose the grid layout that makes the tiles as large as possible for the
  // current window shape - so 2 streams stack vertically on a wide window but
  // sit side by side on a tall one, etc. Special modes:
  //   - exactly 2 tiles: a draggable divider (see _applySplitLayout)
  //   - 3+ tiles with spotlight on: one big + a strip (see _applySpotlight)
  _refreshLayout() {
    const n = this.tiles.size;
    if (this.emptyEl) this.emptyEl.style.display = n === 0 ? "" : "none";
    if (this.countEl) this.countEl.textContent = n ? `${n} stream${n === 1 ? "" : "s"}` : "";
    if (!this.gridEl) return;

    // Clear mode classes; the branch below re-adds the right one.
    this.gridEl.classList.remove("multiview-grid-split", "multiview-grid-spotlight");
    this._removeSplitHandle();

    if (this._theater || n <= 1) {
      this.gridEl.style.gridTemplateColumns = "1fr";
      this.gridEl.style.gridTemplateRows = "";
      return;
    }

    if (n === 2) {
      // Two tiles -> draggable split.
      this._applySplitLayout();
      return;
    }

    if (n >= 3 && this._spotlight) {
      this._applySpotlight();
      return;
    }

    // Auto-grid: pick the column count that yields the largest 16:9 tiles.
    this._applyAutoGrid(n);
  }

  _applyAutoGrid(n) {
    const gap = 6, pad = 6;
    const boxW = this.gridEl.clientWidth - pad * 2;
    const boxH = this.gridEl.clientHeight - pad * 2;
    let cols;
    if (boxW <= 0 || boxH <= 0) {
      cols = n <= 4 ? 2 : 3;
    } else {
      let best = { cols: 1, tileW: 0 };
      for (let c = 1; c <= n; c++) {
        const r = Math.ceil(n / c);
        const availW = boxW - gap * (c - 1);
        const availH = boxH - gap * (r - 1);
        if (availW <= 0 || availH <= 0) continue;
        const tileW = Math.min(availW / c, (availH / r) * (16 / 9));
        if (tileW > best.tileW) best = { cols: c, tileW };
      }
      cols = best.cols;
    }
    const rows = Math.max(1, Math.ceil(n / cols));
    this.gridEl.style.gridTemplateRows = "";
    const availW = boxW - gap * (cols - 1);
    const availH = boxH - gap * (rows - 1);
    if (availW > 0 && availH > 0) {
      const tileW = Math.floor(Math.min(availW / cols, (availH / rows) * (16 / 9)));
      this.gridEl.style.gridTemplateColumns = `repeat(${cols}, ${tileW}px)`;
    } else {
      this.gridEl.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    }
  }

  // Two-tile draggable split: the grid becomes two columns sized by _splitRatio
  // (0..1), with a draggable handle between them. Tiles fill their cell (not
  // forced 16:9) so dragging gives an exact split.
  _applySplitLayout() {
    if (this._splitRatio == null) this._splitRatio = 0.5;
    this.gridEl.classList.add("multiview-grid-split");
    this.gridEl.style.gridTemplateRows = "";
    const left = Math.round(this._splitRatio * 100);
    this.gridEl.style.gridTemplateColumns = `${left}fr ${100 - left}fr`;
    this._addSplitHandle();
    this._positionSplitHandle();
  }

  _addSplitHandle() {
    if (this._splitHandle) return;
    const handle = document.createElement("div");
    handle.className = "multiview-split-handle";
    handle.addEventListener("pointerdown", (e) => this._beginSplitDrag(e));
    this.gridEl.parentElement.appendChild(handle);
    this._splitHandle = handle;
    this._positionSplitHandle();
  }

  _removeSplitHandle() {
    if (this._splitHandle) { this._splitHandle.remove(); this._splitHandle = null; }
  }

  _positionSplitHandle() {
    if (!this._splitHandle) return;
    const wrap = this.gridEl.parentElement;
    const pad = 6;
    const usableW = this.gridEl.clientWidth - pad * 2;
    const x = pad + usableW * (this._splitRatio ?? 0.5);
    this._splitHandle.style.left = `${x}px`;
  }

  _beginSplitDrag(downEvent) {
    downEvent.preventDefault();
    const wrap = this.gridEl.parentElement;
    const pad = 6;
    const onMove = (e) => {
      const rect = this.gridEl.getBoundingClientRect();
      const usableW = rect.width - pad * 2;
      let ratio = (e.clientX - rect.left - pad) / usableW;
      ratio = Math.max(0.2, Math.min(0.8, ratio)); // clamp so neither tile vanishes
      this._splitRatio = ratio;
      const left = Math.round(ratio * 100);
      this.gridEl.style.gridTemplateColumns = `${left}fr ${100 - left}fr`;
      this._positionSplitHandle();
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  // Spotlight (3+): the focused tile fills the main area, the rest sit in a
  // small strip. Clicking a strip tile focuses it (promotes it to the big slot).
  _applySpotlight() {
    this.gridEl.classList.add("multiview-grid-spotlight");
    // Ensure something is focused (the big tile).
    if (!this.focusedChannel || !this.tiles.has(this.focusedChannel)) {
      const first = this.tiles.keys().next().value;
      if (first) this.focusedChannel = first;
    }
    const stripCount = Math.max(1, this.tiles.size - 1);
    // Top row = main (flexible), bottom row = strip (~20%); strip has one
    // column per non-main tile so they sit side by side.
    this.gridEl.style.gridTemplateRows = "1fr 20%";
    this.gridEl.style.gridTemplateColumns = `repeat(${stripCount}, 1fr)`;
    for (const [ch, rec] of this.tiles) {
      rec.tileEl.classList.toggle("multiview-tile-spot-main", ch === this.focusedChannel);
    }
  }
}
