// VODs page - shows a channel's past broadcasts (archives) in a grid,
// playable in-app via the streamlink relay just like live streams.
//
// Triggered by the "Videos" button in the channel info bar. Fetches from
// /helix/videos via the get_videos_for_login Rust command (which resolves
// the login -> user_id lookup internally so we don't need to track user_id
// on the JS side).
//
// VOD thumbnail URLs from Helix use %{width}x%{height} as dimension
// placeholders - we substitute a concrete size before setting img.src.

import { invoke } from "@tauri-apps/api/core";
import { fetchVodChapters } from "./chapters.js";

/** Replace Helix's %{width}x%{height} thumbnail placeholders. */
function resolveThumbnailUrl(url, width = 440, height = 248) {
  return url
    .replace("%{width}", String(width))
    .replace("%{height}", String(height));
}

/**
 * Parse Helix's duration string (e.g. "3h8m33s", "45m12s", "58s") into
 * a human-readable label ("3:08:33", "45:12", "0:58").
 */
function parseDuration(dur) {
  const h = (dur.match(/(\d+)h/) || [])[1] | 0;
  const m = (dur.match(/(\d+)m/) || [])[1] | 0;
  const s = (dur.match(/(\d+)s/) || [])[1] | 0;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Convert Helix's duration string to total seconds.
 * "6h35m5s" -> 23705, "45m12s" -> 2712, "58s" -> 58.
 */
function parseDurationToSeconds(dur) {
  const h = (dur.match(/(\d+)h/) || [])[1] | 0;
  const m = (dur.match(/(\d+)m/) || [])[1] | 0;
  const s = (dur.match(/(\d+)s/) || [])[1] | 0;
  return h * 3600 + m * 60 + s;
}

/** Format a Helix ISO date string as a relative label ("3 days ago", etc.). */
function relativeDate(isoString) {
  const diff = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} day${days !== 1 ? "s" : ""} ago`;
  const weeks = Math.floor(days / 7);
  return `${weeks} week${weeks !== 1 ? "s" : ""} ago`;
}

export class VodsPage {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.containerEl   - #vods-page
   * @param {HTMLElement} opts.videoFrameEl  - #video-frame (to hide while shown)
   * @param {(videoId: string) => void} opts.onVodSelect
   */
  constructor({ containerEl, videoFrameEl, onVodSelect }) {
    this.containerEl = containerEl;
    this.videoFrameEl = videoFrameEl;
    this.onVodSelect = onVodSelect || (() => {});
    this.currentChannel = null;
    /** True while showing a Kick channel's videos - see show()'s kick param. */
    this.isKick = false;
  }

  /**
   * Show the VODs page for `channel`, fetching fresh data.
   * Safe to call while already showing (switches channel).
   *
   * @param {string} channel
   * @param {object} [opts]
   * @param {boolean} [opts.kick] - `channel` is a Kick slug: fetch via
   *   kick_channel_videos (kick.rs) instead of Helix, and skip the
   *   chapter-badge pass (chapters are a Twitch GQL feature; every
   *   lookup would fail for a kick:<uuid> id). Everything else -
   *   the grid, duration/date labels, resume bars - renders identically
   *   because kick.rs normalizes its entries to the same Helix video
   *   shape, and resume progress is keyed by the card's own id string
   *   either way.
   */
  async show(channel, { kick = false } = {}) {
    this.currentChannel = channel;
    this.isKick = kick;
    this.containerEl.style.display = "block";
    if (this.videoFrameEl) this.videoFrameEl.style.display = "none";

    this.containerEl.innerHTML = `
      <div class="vods-header">
        <span class="vods-channel-name">${this._esc(channel)}</span>
        <span class="vods-header-label">Past Broadcasts</span>
      </div>
      <div class="home-section-title vods-loading">Loading videos…</div>`;

    let vods;
    let progressByVodId = {};
    try {
      const [vodsResult, progressResult] = await Promise.allSettled([
        kick
          ? invoke("kick_channel_videos", { slug: channel })
          : invoke("get_videos_for_login", { login: channel }),
        invoke("get_all_vod_progress"),
      ]);
      if (vodsResult.status === "rejected") throw vodsResult.reason;
      vods = JSON.parse(vodsResult.value);
      if (progressResult.status === "fulfilled") {
        progressByVodId = progressResult.value;
      } else {
        console.warn("Failed to load VOD resume progress:", progressResult.reason);
      }
    } catch (err) {
      this.containerEl.innerHTML = `
        <div class="vods-header">
          <span class="vods-channel-name">${this._esc(channel)}</span>
          <span class="vods-header-label">Past Broadcasts</span>
        </div>
        <div class="home-section-title">Failed to load videos: ${this._esc(String(err))}</div>`;
      return;
    }

    // Guard: user navigated away while the fetch was in flight
    if (this.currentChannel !== channel) return;

    this.containerEl.innerHTML = "";

    const header = document.createElement("div");
    header.className = "vods-header";
    header.innerHTML = `
      <span class="vods-channel-name">${this._esc(channel)}</span>
      <span class="vods-header-label">Past Broadcasts</span>`;
    this.containerEl.appendChild(header);

    if (vods.length === 0) {
      const empty = document.createElement("div");
      empty.className = "home-section-title";
      empty.textContent = "No past broadcasts found.";
      this.containerEl.appendChild(empty);
      return;
    }

    const grid = document.createElement("div");
    grid.className = "home-grid vods-grid";
    const cardRefs = []; // {vodId, totalSeconds, card} for chapter badge injection
    for (const vod of vods) {
      const card = this._buildVodCard(vod, progressByVodId[vod.id]);
      grid.appendChild(card);
      const totalSeconds = vod.duration ? parseDurationToSeconds(vod.duration) : 0;
      cardRefs.push({ vodId: vod.id, totalSeconds, card });
    }
    this.containerEl.appendChild(grid);

    // Fire chapter fetches for every VOD in parallel. They update the DOM
    // asynchronously as each response arrives, so the grid is usable
    // immediately and badges just appear as data comes in. Twitch-only:
    // chapters come from Twitch's GQL API (see show()'s kick param).
    if (!kick) {
      this._injectChapterBadges(cardRefs, channel);
    }
  }

  hide() {
    this.containerEl.style.display = "none";
    if (this.videoFrameEl) this.videoFrameEl.style.display = "";
    this.currentChannel = null;
  }

  _buildVodCard(vod, progress) {
    const card = document.createElement("button");
    card.className = "home-grid-card";
    const totalSeconds = vod.duration ? parseDurationToSeconds(vod.duration) : 0;
    card.addEventListener("click", () => this.onVodSelect(vod.id, totalSeconds, this.currentChannel));

    // Thumbnail
    const thumbWrap = document.createElement("div");
    thumbWrap.className = "home-grid-thumb-wrap";

    const thumb = document.createElement("img");
    thumb.className = "home-grid-thumb";
    thumb.alt = "";
    const thumbUrl = vod.thumbnail_url || "";
    // Helix returns a "_404/404_processing_..." URL for VODs that are
    // still being transcoded. Treat that the same as no thumbnail rather
    // than firing a 403 console error for a resource we know won't load.
    const isProcessing = thumbUrl.includes("404_processing") || !thumbUrl;
    if (isProcessing) {
      thumb.style.background = "#1a1a1d";
    } else {
      thumb.src = resolveThumbnailUrl(thumbUrl);
      thumb.onerror = () => { thumb.src = ""; thumb.style.background = "#1a1a1d"; };
    }
    thumbWrap.appendChild(thumb);

    // Duration badge (bottom-left, same position as viewer count on live cards)
    if (vod.duration) {
      const dur = document.createElement("span");
      dur.className = "home-grid-viewers vod-duration";
      dur.textContent = parseDuration(vod.duration);
      thumbWrap.appendChild(dur);
    }

    // Views badge (bottom-right)
    if (typeof vod.view_count === "number") {
      const views = document.createElement("span");
      views.className = "vod-views-badge";
      views.textContent = `${vod.view_count.toLocaleString()} views`;
      thumbWrap.appendChild(views);
    }

    // Resume indicator - same "essentially finished" threshold as
    // main.js's actual resume logic (VOD_RESUME_END_THRESHOLD_SECS
    // there), so a card never shows a resume bar for a VOD that would
    // actually just restart from 0 when clicked.
    if (
      progress &&
      progress.total_secs > 0 &&
      progress.position_secs < progress.total_secs - 30
    ) {
      const track = document.createElement("div");
      track.className = "vod-resume-track";
      const fill = document.createElement("div");
      fill.className = "vod-resume-fill";
      const pct = Math.min(100, Math.max(0, (progress.position_secs / progress.total_secs) * 100));
      fill.style.width = `${pct}%`;
      track.appendChild(fill);
      thumbWrap.appendChild(track);
    }

    card.appendChild(thumbWrap);

    // Meta row (no avatar needed - all VODs belong to the same channel)
    const meta = document.createElement("div");
    meta.className = "home-grid-meta vods-meta";

    const text = document.createElement("div");
    text.className = "home-grid-text";

    const title = document.createElement("div");
    title.className = "home-grid-title";
    title.textContent = vod.title || "(untitled)";
    title.title = vod.title || "";

    const date = document.createElement("div");
    date.className = "home-grid-game"; // reuse muted subtitle style
    date.textContent = vod.created_at ? relativeDate(vod.created_at) : "";

    text.appendChild(title);
    text.appendChild(date);
    meta.appendChild(text);
    card.appendChild(meta);

    return card;
  }

  /**
   * Fires one fetchVodChapters() call per card in parallel (no blocking).
   * When chapters arrive for a VOD, stamps the card's meta row with a
   * "Chapters N" pill matching Twitch's own VOD-list badge.
   */
  async _injectChapterBadges(cardRefs, channel) {
    // One active popup at a time.
    let activePopup = null;
    const closePopup = () => { activePopup?.remove(); activePopup = null; };
    document.addEventListener("click", closePopup, { capture: true, once: false });

    await Promise.all(cardRefs.map(async ({ vodId, card, totalSeconds }) => {
      try {
        const chapters = await fetchVodChapters(vodId);
        if (this.currentChannel !== channel) return;
        if (!chapters.length) return;

        const meta = card.querySelector(".vods-meta");
        if (!meta) return;

        const badge = document.createElement("button");
        badge.className = "vod-chapters-badge";
        badge.type = "button";
        badge.innerHTML =
          `<svg viewBox="0 0 20 20" width="11" height="11" fill="currentColor" style="flex-shrink:0">` +
          `<circle cx="3" cy="4.5" r="1.4"/><rect x="6" y="3.5" width="11" height="2" rx="1"/>` +
          `<circle cx="3" cy="10"  r="1.4"/><rect x="6" y="9"   width="11" height="2" rx="1"/>` +
          `<circle cx="3" cy="15.5" r="1.4"/><rect x="6" y="14.5" width="11" height="2" rx="1"/>` +
          `</svg> Chapters ${chapters.length}`;

        badge.addEventListener("click", (e) => {
          e.stopPropagation(); // don't open the VOD
          if (activePopup) { closePopup(); return; }

          const popup = document.createElement("div");
          popup.className = "vod-chapters-popup";
          chapters.forEach((ch) => {
            const item = document.createElement("button");
            item.className = "vod-chapters-popup-item";
            const h  = Math.floor(ch.positionSec / 3600);
            const m  = Math.floor((ch.positionSec % 3600) / 60);
            const s  = Math.floor(ch.positionSec % 60);
            const ts = h > 0
              ? `${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`
              : `${m}:${String(s).padStart(2,"0")}`;
            item.innerHTML =
              `<span class="vod-chapters-popup-time">${ts}</span>` +
              `<span class="vod-chapters-popup-title">${ch.title}</span>`;
            item.addEventListener("click", (ev) => {
              ev.stopPropagation();
              closePopup();
              this.onVodSelect(vodId, totalSeconds, this.currentChannel, Math.floor(ch.positionSec));
            });
            popup.appendChild(item);
          });

          document.body.appendChild(popup);
          activePopup = popup;

          // Position above the badge, right-aligned to it.
          const r = badge.getBoundingClientRect();
          popup.style.left   = `${r.left}px`;
          popup.style.bottom = `${window.innerHeight - r.top + 6}px`;
          popup.style.top    = "";
          // If it would go off-screen to the right, shift left.
          const pw = popup.getBoundingClientRect().width;
          if (r.left + pw > window.innerWidth - 8) {
            popup.style.left = `${window.innerWidth - pw - 8}px`;
          }
        });

        meta.appendChild(badge);
      } catch (err) {
        console.warn(`[chapters] failed for VOD ${vodId}:`, err);
      }
    }));
  }

  /** Minimal HTML-escape for channel names in error messages. */
  _esc(str) {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
}
