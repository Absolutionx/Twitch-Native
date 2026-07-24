// chat-usercard.js — part of TwitchChat (see ../chat.js). The hover/click user-info card: fetching info, rendering, positioning, dragging.
//
// Clicking a username opens this - matches Twitch's own chat, where it's
// the ONLY place mod tools live (see chat-mod-actions.js for why hover
// icons/right-click no longer carry them). Shows the account's avatar/
// badges/creation date (one Helix lookup, cached per user), this
// session's message count + a short recent-message log (both tracked
// client-side in renderMessage - there's no Helix endpoint for "message
// history," so this can only ever cover what's actually been seen since
// connecting, not real history from before that), and the timeout/ban
// actions.
//
// This is a mixin, not a standalone class: chat.js does
// `Object.assign(TwitchChat.prototype, chatUserCardMixin)` after the class
// body, so every method here runs with the same `this` (container, ws,
// caches, etc.) as methods still defined directly in chat.js. Methods are
// grouped into files by feature area purely for readability — there is no
// behavioral difference from having them all in one file.
import { invoke } from "@tauri-apps/api/core";
import { USER_CARD_HISTORY_LIMIT } from "./shared.js";

export const chatUserCardMixin = {
  /** Opens the user card for `userId`/`username`, anchored below
   * `anchorEl` (the username span that was clicked). `badgesTag` is the
   * raw IRC badges string off that specific message, used to render the
   * same badge icons in the card that appear next to their messages.
   * `msgId`/`messageText` identify the SPECIFIC message whose username
   * was clicked - the card's Delete button acts on that one message
   * (delete is inherently message-scoped, not user-scoped, unlike
   * timeout/ban - opening the card from a different message by the same
   * user deletes THAT message, not whichever one happened to be open
   * before). */
  async _showUserCard(anchorEl, userId, username, badgesTag, msgId, messageText) {
    this._closeUserCard();

    const card = document.createElement("div");
    card.className = "user-card";
    // Close button included even in the brief loading state, not just
    // the fully-rendered card from _renderUserCard - the Helix lookup is
    // usually fast but isn't guaranteed to be, and the card shouldn't be
    // unclosable while waiting on it.
    card.innerHTML =
      '<button class="user-card-close-btn user-card-loading-close" aria-label="Close">' +
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none"><path d="M5 5l14 14M19 5L5 19" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>' +
      "</button>" +
      '<div class="user-card-loading">Loading…</div>';
    card.querySelector(".user-card-loading-close").addEventListener("click", (e) => {
      e.stopPropagation();
      this._closeUserCard();
    });
    document.body.appendChild(card);
    this._userCardEl = card;
    // Tracks whether THIS card instance has been manually dragged, so
    // the re-position call below (after the async Helix lookup resolves
    // and the card's real height is known) doesn't snap a card the user
    // already moved back to the anchor. Lives on the element itself
    // rather than `this` so it's automatically scoped to this specific
    // card instance - no separate reset needed when a new card opens for
    // a different user, since that's always a fresh element.
    card._dragged = false;
    this._positionUserCard(card, anchorEl);
    this._makeUserCardDraggable(card);

    this._userCardOutsideHandler = (e) => {
      if (!card.contains(e.target) && e.target !== anchorEl) this._closeUserCard();
    };
    setTimeout(() => {
      document.addEventListener("click", this._userCardOutsideHandler, true);
    }, 0);

    // Helix lookup (cached) - everything else needed to render the card
    // is already available synchronously (badgesTag, message count/
    // history), so the card shows immediately with a small loading state
    // only for the parts that genuinely need a network round trip.
    let info = this._userInfoCache.get(userId);
    if (info === undefined) {
      try {
        const users = JSON.parse(await invoke("get_users_info", { userIds: [userId] }));
        info = users[0] || null;
      } catch (err) {
        console.error("Failed to load user info for card:", err);
        info = null;
      }
      this._userInfoCache.set(userId, info);
    }

    // The card may have been closed (or reopened for a different user)
    // while that lookup was in flight - don't resurrect/overwrite it.
    if (this._userCardEl !== card) return;

    this._renderUserCard(card, userId, username, badgesTag, info, msgId, messageText);
    // Skip the re-position entirely if the user already dragged the card
    // during the (typically brief) loading window - re-running it would
    // discard their drag and snap the card back to the anchor, which is
    // exactly the "fights with positioning logic" failure mode dragging
    // needs to avoid.
    if (!card._dragged) this._positionUserCard(card, anchorEl);
  },

  _renderUserCard(card, userId, username, badgesTag, info, msgId, messageText) {
    card.innerHTML = "";

    const header = document.createElement("div");
    header.className = "user-card-header";

    const avatar = document.createElement("img");
    avatar.className = "user-card-avatar";
    avatar.src = info?.profile_image_url || this.blankAvatarDataUri();
    avatar.alt = "";
    header.appendChild(avatar);

    const nameBlock = document.createElement("div");
    nameBlock.className = "user-card-name-block";
    const nameEl = document.createElement("div");
    nameEl.className = "user-card-name";
    nameEl.textContent = info?.display_name || username;
    nameBlock.appendChild(nameEl);
    if (info?.login && info.login.toLowerCase() !== (info?.display_name || "").toLowerCase()) {
      const loginEl = document.createElement("div");
      loginEl.className = "user-card-login";
      loginEl.textContent = `@${info.login}`;
      nameBlock.appendChild(loginEl);
    }
    header.appendChild(nameBlock);

    // Close button - lives in the header (not the scrollable body below)
    // so it's always reachable regardless of scroll position, same as
    // any standard dialog/popup close affordance. mousedown is stopped
    // from propagating so clicking it can never be misread as the start
    // of a drag by _makeUserCardDraggable's header-wide mousedown
    // listener - without this, a quick click-and-release on the X would
    // both close the card AND (harmlessly, but pointlessly) register as
    // a zero-distance drag attempt first.
    const closeBtn = document.createElement("button");
    closeBtn.className = "user-card-close-btn";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none"><path d="M5 5l14 14M19 5L5 19" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    closeBtn.addEventListener("mousedown", (e) => e.stopPropagation());
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this._closeUserCard();
    });
    header.appendChild(closeBtn);

    card.appendChild(header);

    // Everything below the header lives in its own scrollable body
    // container, separate from the header itself, so a long message
    // history (see below) scrolls in its own region while the header -
    // including the new close button - stays pinned and reachable
    // regardless of scroll position. Previously everything was appended
    // directly to `card`, with `.user-card`'s own max-height/overflow-y
    // meant to cap and scroll the WHOLE card including the header - but
    // a single scrolling region containing a flex header is more fragile
    // than it needs to be, and conflated "pin the header" with "cap the
    // content," which are really two different jobs. Splitting them
    // makes each rule do only the one thing it needs to.
    const body = document.createElement("div");
    body.className = "user-card-body";
    card.appendChild(body);

    // Badges row - same icons shown next to the user's messages, reusing
    // renderBadges() rather than a separate lookup/rendering path.
    const badgeFragment = badgesTag ? this.renderBadges(badgesTag) : null;
    if (badgeFragment) {
      const badgeRow = document.createElement("div");
      badgeRow.className = "user-card-badges";
      badgeRow.appendChild(badgeFragment);
      body.appendChild(badgeRow);
    }

    const created = document.createElement("div");
    created.className = "user-card-created";
    // Defensive against created_at being absent - Helix has had reports
    // of omitting it in some cases despite documenting it as always
    // present (see the comment trail for why this isn't assumed solid).
    created.textContent = info?.created_at
      ? `Account created: ${this._formatAccountDate(info.created_at)}`
      : "Account created: unknown";
    body.appendChild(created);

    // Mod actions - same enabled/disabled logic the old hover row used,
    // just relocated here. isSelf/enabled recomputed fresh on every open
    // since isMod can change between opens of the same card.
    const isSelf = this._isSelf(username);
    const enabled = this.isMod && Boolean(this.roomId) && !isSelf;

    const actionsRow = document.createElement("div");
    actionsRow.className = "user-card-mod-actions";

    const timeoutPresets = [["1s", 1], ["30s", 30], ["1m", 60], ["10m", 600],
      ["30m", 1800], ["1h", 3600], ["4h", 14400], ["12h", 43200],
      ["1d", 86400], ["7d", 604800], ["14d", 1209600]];
    for (const [label, secs] of timeoutPresets) {
      const btn = document.createElement("button");
      btn.className = "user-card-timeout-preset";
      btn.textContent = label;
      btn.disabled = !enabled;
      btn.title = enabled ? `Timeout ${username} for ${label}` : "Mod only";
      btn.addEventListener("click", () => {
        if (!enabled) return;
        this._timeoutUser(userId, username, secs);
      });
      actionsRow.appendChild(btn);
    }
    body.appendChild(actionsRow);

    const banRow = document.createElement("div");
    banRow.className = "user-card-ban-row";

    // Delete is message-scoped, not user-scoped (unlike timeout/ban) -
    // acts on the SPECIFIC message whose username was clicked to open
    // this card (msgId/messageText passed in from there), not "the
    // user's messages" in general. Disabled with its own reason when
    // there's simply no message id to act on (e.g. somehow opened
    // without one) even if the mod/self-targeting checks would otherwise
    // allow it.
    const deleteBtn = document.createElement("button");
    deleteBtn.className = "user-card-delete-btn";
    deleteBtn.textContent = "Delete message";
    const canDelete = enabled && Boolean(msgId);
    deleteBtn.disabled = !canDelete;
    deleteBtn.title = !this.isMod ? "Mod only"
      : !msgId ? "No message to delete"
      : isSelf ? "Mod only"
      : "Delete this message";
    deleteBtn.addEventListener("click", () => {
      if (!canDelete) return;
      this._deleteMessage(msgId, deleteBtn);
    });
    banRow.appendChild(deleteBtn);

    const banBtn = document.createElement("button");
    banBtn.className = "user-card-ban-btn";
    banBtn.textContent = "Ban";
    banBtn.disabled = !enabled;
    banBtn.title = enabled ? `Ban ${username}` : "Mod only";
    banBtn.addEventListener("click", () => {
      if (!enabled) return;
      this._confirmAndBan(userId, username);
    });
    banRow.appendChild(banBtn);
    body.appendChild(banRow);

    // Stats row - Messages is the one stat this client can actually
    // populate (tracked client-side as messages arrive - see
    // renderMessage). Warnings/Timeouts/Bans/Comments, shown on
    // twitch.tv's own card, come from the moderation dashboard's
    // internal log, which has no public Helix equivalent - showing them
    // here would mean either hardcoding 0 (misleading - looks like real
    // data saying "never happened") or omitting them, so they're omitted
    // rather than faked.
    const stats = document.createElement("div");
    stats.className = "user-card-stats";
    const msgCount = this._messageCountByUserId.get(userId) || 0;
    const statBox = document.createElement("div");
    statBox.className = "user-card-stat";
    const statValue = document.createElement("div");
    statValue.className = "user-card-stat-value";
    statValue.textContent = String(msgCount);
    const statLabel = document.createElement("div");
    statLabel.className = "user-card-stat-label";
    statLabel.textContent = "Messages (this session)";
    statBox.appendChild(statValue);
    statBox.appendChild(statLabel);
    stats.appendChild(statBox);
    body.appendChild(stats);

    // Recent message log - client-tracked, so it only ever covers what's
    // been seen since connecting (no Helix endpoint exists for real
    // chat history), but still useful context for a mod deciding on an
    // action right now. Capped to USER_CARD_HISTORY_LIMIT entries at the
    // point messages are recorded (see renderMessage) - this loop always
    // renders the full (already-capped) array as-is, it doesn't impose
    // any further limit of its own.
    const history = this._messageHistoryByUserId.get(userId) || [];
    if (history.length > 0) {
      const historyEl = document.createElement("div");
      historyEl.className = "user-card-history";
      for (const entry of history) {
        const row = document.createElement("div");
        row.className = "user-card-history-row";
        const time = document.createElement("span");
        time.className = "user-card-history-time";
        time.textContent = new Date(entry.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        const text = document.createElement("span");
        text.className = "user-card-history-text";
        text.textContent = entry.text;
        row.appendChild(time);
        row.appendChild(text);
        historyEl.appendChild(row);
      }
      body.appendChild(historyEl);
    }
  },

  _formatAccountDate(iso) {
    try {
      return new Date(iso).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
    } catch (_) {
      return iso;
    }
  },

  /** Same blank-avatar fallback used elsewhere in the app (sidebar/home/
   * browse) - duplicated here rather than imported since those live in
   * main.js-side modules with no shared util module between them and
   * chat.js for a single-line data URI. */
  blankAvatarDataUri() {
    return "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
  },

  _positionUserCard(card, anchorEl) {
    const rect = anchorEl.getBoundingClientRect();
    card.style.position = "fixed";
    const cardWidth = card.offsetWidth;
    let left = rect.left;
    const maxLeft = window.innerWidth - cardWidth - 8;
    if (left > maxLeft) left = Math.max(8, maxLeft);
    card.style.left = `${left}px`;
    const cardHeight = card.offsetHeight;
    if (rect.bottom + cardHeight + 6 <= window.innerHeight) {
      card.style.top = `${rect.bottom + 6}px`;
    } else {
      card.style.top = `${Math.max(8, rect.top - cardHeight - 6)}px`;
    }
  },

  /** Lets the user drag the card by its header to reposition it anywhere
   * on screen. Attached to `card` itself rather than the header element
   * directly, because _renderUserCard() does `card.innerHTML = ""` and
   * rebuilds a brand new header once the async Helix lookup resolves -
   * a listener on the original (loading-state) header would be destroyed
   * along with it. card.contains(e.target) plus a .closest() check on
   * mousedown achieves the same "only the header starts a drag" behavior
   * without depending on which header element currently exists. */
  _makeUserCardDraggable(card) {
    card.addEventListener("mousedown", (e) => {
      const header = e.target.closest(".user-card-header");
      if (!header || !card.contains(header)) return;
      // Right/middle-click shouldn't start a drag, and ignore clicks that
      // landed on an interactive element inside the header (there are
      // none today, but this keeps future header additions - e.g. a
      // close button - from being eaten by drag-start instead of their
      // own click handler).
      if (e.button !== 0 || e.target.closest("button, a")) return;

      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      const startLeft = card.offsetLeft;
      const startTop = card.offsetTop;
      card.classList.add("dragging");

      const onMove = (moveEvent) => {
        card._dragged = true;
        // Clamp so the header (the only way to grab and move it again)
        // can never be dragged fully off-screen and become unreachable -
        // same 8px margin _positionUserCard already uses on the right
        // edge, applied here on all four edges for consistency.
        const maxLeft = window.innerWidth - card.offsetWidth - 8;
        const maxTop = window.innerHeight - card.offsetHeight - 8;
        const newLeft = Math.min(
          Math.max(8, startLeft + (moveEvent.clientX - startX)),
          Math.max(8, maxLeft)
        );
        const newTop = Math.min(
          Math.max(8, startTop + (moveEvent.clientY - startY)),
          Math.max(8, maxTop)
        );
        card.style.left = `${newLeft}px`;
        card.style.top = `${newTop}px`;
      };
      const onUp = () => {
        card.classList.remove("dragging");
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        card._dragCleanup = null;
      };
      // Stored on the element so _closeUserCard() can force-detach these
      // document-level listeners if the card is removed mid-drag (e.g. a
      // scroll-triggered close while the mouse is still held down) -
      // otherwise onUp only ever runs on a real mouseup, and a card
      // removed before that fires would leak both listeners.
      card._dragCleanup = onUp;
      // Listening on document rather than the header itself so the drag
      // keeps tracking the cursor even if it moves faster than the
      // header/card during a fast drag and ends up outside their bounds.
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  },

  _closeUserCard() {
    if (this._userCardEl) {
      // If the card is being removed mid-drag (e.g. a scroll-triggered
      // close fires while the mouse is still held down), the drag's own
      // mouseup listener will never get a chance to run and detach
      // itself - do it explicitly here instead of leaking those two
      // document-level listeners.
      this._userCardEl._dragCleanup?.();
      this._userCardEl.remove();
      this._userCardEl = null;
    }
    if (this._userCardOutsideHandler) {
      document.removeEventListener("click", this._userCardOutsideHandler, true);
      this._userCardOutsideHandler = null;
    }
  },

  _formatDuration(secs) {
    if (secs >= 86400) return `${Math.round(secs / 86400)}d`;
    if (secs >= 3600) return `${Math.round(secs / 3600)}h`;
    if (secs >= 60) return `${Math.round(secs / 60)}m`;
    return `${secs}s`;
  },

  /** Case-insensitive check against this.ownLogin. Used to disable mod
   * actions against the logged-in user's own messages - comparing by
   * username rather than user id since that's what's already tracked
   * here (see setLoggedIn()) and IRC's display-name casing never matches
   * the lowercase login Twitch's OAuth validation returns, so this can't
   * just be a plain === . Not a security boundary either way - Twitch's
   * own Helix endpoints behind these buttons reject self-targeting
   * server-side regardless of what this client shows. */
  _isSelf(username) {
    return Boolean(this.ownLogin) && Boolean(username) &&
      this.ownLogin.toLowerCase() === username.toLowerCase();
  },

};
