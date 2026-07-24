// chat-link-preview.js — part of TwitchChat (see ../chat.js). Chat link handling: URL detection/normalization and the hover link-preview popup.
//
// Hovering a chat link waits briefly (LINK_PREVIEW_HOVER_DELAY_MS) before
// fetching, same idea as browser/Discord link-hover previews - chat
// scrolls fast and the cursor crosses plenty of links the user never
// actually meant to pause on, so firing a network request on every
// single mouseenter would be wasteful and would make the popup flicker
// in and out as messages scroll past under a stationary cursor.
//
// This is a mixin, not a standalone class: chat.js does
// `Object.assign(TwitchChat.prototype, chatLinkPreviewMixin)` after the class
// body, so every method here runs with the same `this` (container, ws,
// caches, etc.) as methods still defined directly in chat.js. Methods are
// grouped into files by feature area purely for readability — there is no
// behavioral difference from having them all in one file.
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { normalizeUrl, LINK_PREVIEW_HOVER_DELAY_MS } from "./shared.js";

export const chatLinkPreviewMixin = {
  /**
   * Builds a clickable <a> for a URL posted in chat, wired the same
   * "real href for right-click-copy, intercept the click for openUrl()"
   * way drops-banner-link/channel-info-follow-btn already work in
   * main.js (target="_blank" alone does nothing inside a Tauri webview -
   * there's no second tab to open into, so the click has to be handed off
   * to the user's actual default browser instead). Also attaches hover
   * handlers that lazily fetch and show a link preview popup.
   */
  _createChatLink(word) {
    const url = normalizeUrl(word);
    const a = document.createElement("a");
    a.href = url;
    a.textContent = word;
    a.className = "chat-link";
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.addEventListener("click", (e) => {
      e.preventDefault();
      openUrl(url).catch((err) => {
        console.error("Failed to open chat link in browser:", err);
      });
    });
    a.addEventListener("mouseenter", () => this._scheduleLinkPreview(a, url));
    a.addEventListener("mouseleave", () => this._cancelLinkPreview());
    return a;
  },

  /** Begins (or re-begins) the hover-preview flow for a freshly-hovered
   * link element. Cancels any in-flight timer/request for a previous
   * link first, so rapidly moving across several links in a row only
   * ever ends up fetching for the one the cursor actually settles on. */
  _scheduleLinkPreview(linkEl, url) {
    this._cancelLinkPreview();
    const myToken = ++this._linkPreviewToken;

    const cached = this._linkPreviewCache.get(url);
    if (cached !== undefined) {
      // Still respect the hover delay even on a cache hit, rather than
      // popping in instantly - an instant popup on every hover (even a
      // cached one) reads as noisy/jumpy while skimming through chat.
      this._linkPreviewTimer = setTimeout(() => {
        if (myToken !== this._linkPreviewToken) return; // moved on already
        if (cached) this._showLinkPreviewPopup(linkEl, cached);
      }, LINK_PREVIEW_HOVER_DELAY_MS);
      return;
    }

    this._linkPreviewTimer = setTimeout(async () => {
      if (myToken !== this._linkPreviewToken) return; // moved on already
      let preview;
      try {
        preview = await invoke("fetch_link_preview", { url });
      } catch (err) {
        console.error("Link preview fetch failed:", url, err);
        preview = null;
      }
      // A preview with no title/description/image isn't worth a popup -
      // cache the "nothing useful" result as null either way so a link
      // that errors or genuinely has no OG/<title> tags doesn't get
      // retried on every subsequent hover.
      const hasContent = preview && (preview.title || preview.description || preview.image);
      this._linkPreviewCache.set(url, hasContent ? preview : null);
      if (myToken !== this._linkPreviewToken) return; // moved on while fetching
      if (hasContent) this._showLinkPreviewPopup(linkEl, preview);
    }, LINK_PREVIEW_HOVER_DELAY_MS);
  },

  /** Cancels any pending hover-preview timer and hides the popup if
   * shown. Called on mouseleave, and at the start of every new hover so
   * stale timers/requests from a previously-hovered link can't pop the
   * popup open after the cursor has already moved elsewhere. */
  _cancelLinkPreview() {
    ++this._linkPreviewToken;
    if (this._linkPreviewTimer) {
      clearTimeout(this._linkPreviewTimer);
      this._linkPreviewTimer = null;
    }
    this._hideLinkPreviewPopup();
  },

  _showLinkPreviewPopup(linkEl, preview) {
    const popup = this._linkPreviewPopup;
    popup.innerHTML = "";

    if (preview.image) {
      const img = document.createElement("img");
      img.className = "link-preview-image";
      img.src = preview.image;
      img.alt = "";
      img.loading = "lazy";
      // If the image 404s/fails, drop just the image rather than leaving
      // a broken-image icon sitting in the popup.
      img.addEventListener("error", () => img.remove());
      popup.appendChild(img);
    }

    const body = document.createElement("div");
    body.className = "link-preview-body";

    if (preview.site_name) {
      const site = document.createElement("div");
      site.className = "link-preview-site";
      site.textContent = preview.site_name;
      body.appendChild(site);
    }
    if (preview.title) {
      const title = document.createElement("div");
      title.className = "link-preview-title";
      title.textContent = preview.title;
      body.appendChild(title);
    }
    if (preview.description) {
      const desc = document.createElement("div");
      desc.className = "link-preview-description";
      desc.textContent = preview.description;
      body.appendChild(desc);
    }
    popup.appendChild(body);

    popup.style.display = "block";
    this._positionLinkPreviewPopup(linkEl);
  },

  _hideLinkPreviewPopup() {
    this._linkPreviewPopup.style.display = "none";
  },

  /** Positions the popup just above the hovered link, same fixed-
   * positioning-from-a-live-rect approach as _repositionPopup() uses for
   * the emote autocomplete popup - clamped horizontally so it can't run
   * off the right edge of the window for a link near the chat pane's
   * right border (chat is a narrow column, so this comes up often). */
  _positionLinkPreviewPopup(linkEl) {
    const rect = linkEl.getBoundingClientRect();
    const popup = this._linkPreviewPopup;
    const popupWidth = popup.offsetWidth;
    const popupHeight = popup.offsetHeight;

    let left = rect.left;
    const maxLeft = window.innerWidth - popupWidth - 8;
    if (left > maxLeft) left = Math.max(8, maxLeft);

    popup.style.left = `${left}px`;
    // Prefer above the link; fall back to below if there isn't room
    // above (e.g. a link in one of the very first chat lines).
    if (rect.top - popupHeight - 8 >= 0) {
      popup.style.top = `${rect.top - popupHeight - 8}px`;
    } else {
      popup.style.top = `${rect.bottom + 8}px`;
    }
  },

};
