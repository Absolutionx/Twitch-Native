// MultiView: full-screen grid of several streams at once.
//
// Built outside the single-stream player/relay stack: each tile is a bare
// <video> fed by attachHlsVod + get_live_m3u8_url (native-HLS, cross-platform,
// no relay). Tradeoff: tiles get weaker ad-stripping than the main player's
// byte relay - fine for a monitoring grid.

import { attachHlsVod } from "./vod-player.js";
import { invoke } from "@tauri-apps/api/core";
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
        <div class="multiview-add">
          <button class="multiview-followed-btn" title="Add from your followed channels">+ Followed</button>
          <input type="text" class="multiview-add-input"
                 placeholder="or type a channel..." spellcheck="false" />
          <button class="multiview-add-btn">Add</button>
        </div>
        <div class="multiview-followed-panel" style="display:none">
          <div class="multiview-followed-header">
            <span>Followed channels</span>
            <button class="multiview-followed-close" title="Close">&times;</button>
          </div>
          <div class="multiview-followed-list"></div>
        </div>
        <span class="multiview-count"></span>
        <button class="multiview-multiaudio" title="Multi-audio: hear several streams at once (off by default)">Multi-audio</button>
        <button class="multiview-theater" title="Theater mode: focus the selected stream (T)">Theater</button>
        <button class="multiview-close" title="Close (Esc)">&larr; Back</button>
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
        // Back out one level: theater first, else close.
        if (this._theater) this.toggleTheater();
        else this.close();
      }
      else if (e.key === "t" || e.key === "T") this.toggleTheater();
    };
    document.addEventListener("keydown", this._escHandler);
    // Reflect active state on the nav tab.
    document.getElementById("multiview-tab")?.classList.add("nav-tab-active");
    for (const ch of initialChannels) this.addChannel(ch);
    this._refreshLayout();
  }

  close() {
    this._open = false;
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
      .addEventListener("click", async (e) => {
        e.stopPropagation();
        try {
          if (document.pictureInPictureElement === videoEl) {
            await document.exitPictureInPicture();
          } else if (document.pictureInPictureEnabled) {
            await videoEl.requestPictureInPicture();
          }
        } catch { /* PiP can reject if not allowed; ignore */ }
      });
    // A tile can stall after returning from PiP; recover to the live edge.
    videoEl.addEventListener("leavepictureinpicture", () => {
      this._recoverLiveEdge(record);
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

    await this._loadVideo(record, loadingEl);
    // First tile added becomes the audio focus automatically.
    if (!this.focusedChannel) this.focus(channel);
    this._refreshLayout();
  }

  // Seek a stalled tile back to the live edge; reload if that fails.
  _recoverLiveEdge(record) {
    const v = record.videoEl;
    if (!v) return;
    // Give the element a tick to settle after the PiP transition.
    setTimeout(() => {
      try {
        if (v.seekable && v.seekable.length > 0) {
          const liveEdge = v.seekable.end(v.seekable.length - 1);
          // Only jump if we've genuinely fallen behind, to avoid a needless
          // seek that itself causes a hiccup.
          if (liveEdge - v.currentTime > 2) v.currentTime = liveEdge - 0.5;
        }
        const p = v.play();
        if (p) {
          p.catch(() => {
            // Still stuck - reload the stream from scratch as a last resort.
            const loadingEl = record.tileEl.querySelector(".multiview-tile-loading");
            this._loadVideo(record, loadingEl);
          });
        }
      } catch {
        const loadingEl = record.tileEl.querySelector(".multiview-tile-loading");
        this._loadVideo(record, loadingEl);
      }
    }, 150);
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

  focus(channel) {
    this.focusedChannel = channel;
    for (const [ch, rec] of this.tiles) {
      const focused = ch === channel;
      rec.tileEl.classList.toggle("multiview-tile-focused", focused);
      if (!this._multiAudio) {
        // Single-focus: only the focused tile is audible, at its saved level.
        const isPip = document.pictureInPictureElement === rec.videoEl;
        if (focused) {
          if (rec.volumeLevel == null || rec.volumeLevel === 0) rec.volumeLevel = 1;
          rec.videoEl.muted = false;
          rec.videoEl.volume = rec.volumeLevel;
          rec.videoEl.play().catch(() => {});
        } else if (isPip) {
          // A PiP'd tile keeps its audio even when unfocused (same <video>
          // element backs both), and gets a play() nudge to avoid stalling.
          if (rec.volumeLevel == null || rec.volumeLevel === 0) rec.volumeLevel = 1;
          rec.videoEl.muted = false;
          rec.videoEl.volume = rec.volumeLevel;
          if (rec.videoEl.paused) rec.videoEl.play().catch(() => {});
        } else {
          rec.videoEl.muted = true;
          rec.videoEl.volume = 0;
          // Keep rec.volumeLevel as the user's saved preference; don't zero it.
        }
        this._updateTileAudioUi(rec);
      }
      // Multi-audio: sliders own the audio; focus only changes chat + highlight.
    }
    this._connectChat(channel);
    this._applyTheater();
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

  removeChannel(channel) {
    const record = this.tiles.get(channel);
    if (!record) return;
    // Close its PiP first, else removing the video orphans the PiP window.
    try {
      if (document.pictureInPictureElement === record.videoEl) {
        document.exitPictureInPicture().catch(() => {});
      }
    } catch {}
    if (record.hls) { record.hls.destroy(); record.hls = null; }
    try { record.videoEl.pause(); record.videoEl.removeAttribute("src"); record.videoEl.load(); } catch {}
    record.tileEl.remove();
    this.tiles.delete(channel);
    if (this.focusedChannel === channel) {
      this.focusedChannel = null;
      // Hand audio focus (and the chat) to any remaining tile, or clear the
      // chat if the grid is now empty.
      const next = this.tiles.keys().next().value;
      if (next) this.focus(next);
      else this._connectChat(null);
    }
    this._refreshLayout();
  }

  // Set grid columns by tile count; toggle the empty state.
  _refreshLayout() {
    const n = this.tiles.size;
    if (this.emptyEl) this.emptyEl.style.display = n === 0 ? "" : "none";
    if (this.countEl) this.countEl.textContent = n ? `${n} stream${n === 1 ? "" : "s"}` : "";
    // Theater = 1 col; otherwise pack: 1->1, 2-4->2, 5-9->3.
    const cols = this._theater ? 1 : (n <= 1 ? 1 : n <= 4 ? 2 : 3);
    if (this.gridEl) this.gridEl.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  }
}
