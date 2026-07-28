// Twitch chat: connection lifecycle and the message render pipeline.
//
// The actual Twitch IRC WebSocket connection lives in Rust
// (src-tauri/src/chat.rs), not here. WebView2's Tracking Prevention feature
// was silently blocking/killing the WebSocket connection to
// irc-ws.chat.twitch.tv when it ran in this webview (confirmed via devtools:
// "Tracking Prevention blocked access to storage for
// https://irc-ws.chat.twitch.tv/"). Rust's networking has no exposure to
// that browser-level feature, so the IRC client moved there.
//
// This file holds TwitchChat's core: invoking start_chat/stop_chat,
// listening for the chat-message/chat-system/chat-status/chat-room events
// Rust emits, and the message send/render pipeline. Everything else
// (emotes, badges, AutoMod, user cards, moderation actions, link previews,
// @mention autocomplete, VOD chat replay) is mixed in from src/chat/ - see the imports
// below and each file's own header comment.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { chatEmotesMixin } from "./chat/chat-emotes.js";
import { chatEmotePickerMixin } from "./chat/chat-emote-picker.js";
import { chatVodReplayMixin } from "./chat/chat-vod-replay.js";
import { chatBadgesMixin } from "./chat/chat-badges.js";
import { chatAutomodMixin } from "./chat/chat-automod.js";
import { chatUserCardMixin } from "./chat/chat-usercard.js";
import { chatModActionsMixin } from "./chat/chat-mod-actions.js";
import { chatLinkPreviewMixin } from "./chat/chat-link-preview.js";
import { chatAutocompleteMixin } from "./chat/chat-autocomplete.js";
import { looksLikeUrl, USER_CARD_HISTORY_LIMIT } from "./chat/shared.js";

// Must match .chat-input's max-height in index.html - duplicated here
// (rather than read from getComputedStyle) since _autosizeChatInput()
// needs this number on every keystroke and a style read is needless
// overhead for a value that's effectively a constant.
const CHAT_INPUT_MAX_HEIGHT_PX = 120;
export class TwitchChat {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.container - element to append chat lines into
   * @param {HTMLElement} opts.statusEl - element to show connection status in
   * @param {HTMLElement} opts.inputEl - text input for composing messages
   * @param {HTMLElement} opts.sendBtn - button to send the composed message
   */
  constructor({ container, statusEl, inputEl, sendBtn }) {
    this.container = container;
    this.statusEl = statusEl;
    this.inputEl = inputEl;
    this.sendBtn = sendBtn;
    this.channel = null;
    this.isLoggedIn = false;
    this.ownLogin = null;
    this.ownDisplayName = null;
    this.ownUserId = null;
    // True while showing VOD chat replay - replay is read-only (there's
    // no live chat connection to send to), so the input row is hidden
    // entirely for the duration, same as Twitch's own VOD player. Set in
    // setVodMode(), cleared back in connect() when returning to a live
    // channel.
    this._isVodMode = false;
    // --- Kick chat mode (set by connectKick, cleared by connect/
    //     disconnect back to Twitch) -------------------------------------
    // True while the pane is showing Kick chat rather than Twitch IRC.
    // sendMessage() branches on this to POST via kick_send_chat_message
    // instead of the Twitch send_chat_message command.
    this._isKickChat = false;
    // The watched Kick channel's broadcaster user id (from KickLiveInfo).
    // Required to send; when null (payload lacked it) Kick chat stays
    // read-only even if the user is logged in to Kick.
    this._kickBroadcasterId = null;
    // The watched Kick channel's custom subscriber badge tiers
    // ([{months, src}], from KickLiveInfo.subscriber_badges via
    // connectKick) - renderBadges months-matches kick/subscriber/N
    // entries against these so subscribers wear the channel's own art,
    // like kick.com's chat. Empty = generic subscriber badge.
    this._kickSubscriberBadges = [];
    // Kick login state is separate from Twitch's isLoggedIn: a user can
    // be logged into either, both, or neither. Driven by main.js's Kick
    // OAuth result / session restore via setKickLoggedIn().
    this._kickLoggedIn = false;
    this._kickLogin = null;
    // Whether this build can offer Kick login at all - set by main.js
    // via setKickOAuthConfigured() once the async startup check lands.
    this._kickOAuthConfigured = false;
    // Default no-op, overwritten with the real implementation inside
    // setVodMode() - see that method's notifyVodSeek assignment for the
    // full reasoning. This default exists purely so calling it is always
    // safe even before a VOD has ever loaded, rather than relying on the
    // (currently true, but not worth depending on) fact that
    // playbackControls.onSeek can't actually fire before then.
    this.notifyVodSeek = () => {};
    // Account-level chat color (from USERSTATE's color tag), used by
    // sendMessage()'s optimistic local echo - see that listener for the
    // full reasoning. Unlike _ownBadgesTag (channel-specific, reset on
    // every connect()), color is the SAME account-wide setting in every
    // channel, so this deliberately never gets reset on a channel switch.
    this._ownColor = null;
    // Whether the logged-in user is a moderator OR the broadcaster of the
    // CURRENT channel - the one thing every mod-tools UI element (hover
    // icons, context menu, AutoMod queue) gates on. Derived from the
    // USERSTATE badges tag in _updateModStatus() below, not fetched via a
    // separate Helix call - "moderator" or "broadcaster" being present in
    // that tag is exactly the same information Twitch's own IRC server
    // already uses to decide whether to honor this account's mod commands,
    // so there's nothing a dedicated lookup would tell us that this
    // doesn't already answer for free on every join.
    this.isMod = false;
    /** @type {Array<() => void>} Called whenever isMod changes, so main.js
     * (which owns the hover-icon/context-menu DOM) can re-render anything
     * already on screen without chat.js needing to know what that DOM
     * looks like. */
    this._modStatusListeners = [];
    /** @type {Array<{user_name, user_id, message, msg_id, category, level}>}
     * Held messages currently awaiting Allow/Deny, newest last. Cleared
     * on every connect() (a new channel's held messages have nothing to
     * do with the previous one's). */
    this._automodQueue = [];
    /** @type {Map<string, number>} userId -> message count seen this
     * session, for the user card's "Messages" stat. Reset on connect()
     * along with everything else per-channel. */
    this._messageCountByUserId = new Map();
    /** @type {Map<string, Array<{time: number, text: string}>>} userId ->
     * recent message log for the user card, capped at
     * USER_CARD_HISTORY_LIMIT entries per user (oldest dropped first). */
    this._messageHistoryByUserId = new Map();
    /** @type {Map<string, object|null>} userId -> cached Helix /users
     * result (or null for "lookup failed/not found"), so reopening the
     * same user's card doesn't refetch every time. */
    this._userInfoCache = new Map();
    /** @type {Map<string, {url: string, zeroWidth: boolean}>} */
    this.sevenTvEmotes      = new Map(); // 7TV/BTTV/FFZ: name -> {url, zeroWidth, provider} - written only via _setEmote (chat-emotes.js), which enforces provider precedence
    this.twitchNativeEmotes = new Map(); // Twitch global: name -> {id, url}
    /** @type {Map<string, {url: string, title: string}>} Twitch chat
     * badges (Broadcaster, Moderator, VIP, subscriber tiers, etc), keyed
     * by "setId/version" to match the format of the IRC `badges` tag
     * directly (e.g. "subscriber/12" -> 12-month sub badge). Global and
     * channel-specific badges share this same map since their set_ids
     * don't collide in practice (channel-specific ones are almost always
     * "subscriber" or "bits", which the channel response overrides the
     * global default for anyway - exactly matching real Twitch chat
     * behavior, where a channel's own subscriber badge art takes
     * precedence over the generic global one). */
    this.badgeMap = new Map();
    /**
     * Cheermote map: prefix.toLowerCase() → tiers sorted DESCENDING by
     * minBits (so Array.find gives the highest matching tier first).
     * @type {Map<string, Array<{minBits: number, url: string, color: string}>>}
     */
    this.cheermoteMap = new Map();
    this.maxLines = 250;
    this.unlisteners = [];
    // Serializes AND supersedes the connection-lifecycle methods (connect
    // / connectKick / disconnect / setVodMode / setKickVodMode). Two
    // properties are needed at once:
    //   1. No interleaving. Their teardownListeners()/setupListeners()
    //      pairs must not overlap, or two concurrent connects both teardown
    //      (draining unlisteners to []) then both setup, leaving 22
    //      listeners registered and every chat message rendered twice.
    //   2. Latest-click-wins. When the user clicks 5 channels fast, only
    //      the 5th should actually connect - the first 4 are stale the
    //      instant a newer one is requested. A plain serialized queue gets
    //      (1) but not (2): it runs all 5 to completion in order, so chat
    //      visibly crawls A->B->C->D->E before settling. That's the
    //      regression this epoch model fixes.
    // Each lifecycle call bumps _lifecycleEpoch and chains after the
    // previous op; once it's its turn, it bails immediately if a newer
    // call has since bumped the epoch. See _serializeLifecycle().
    this._lifecycleChain = Promise.resolve();
    this._lifecycleEpoch = 0;
    // Explicit flag for whether the user has intentionally scrolled up to
    // read history. Replaces distance-from-bottom checks, which are unreliable
    // during fast chat because scrollHeight grows the instant a new message
    // is appended but scrollTop hasn't moved yet - any tall message would
    // falsely register as "user scrolled up" with the old approach.
    this.userScrolledUp = false;
    // Marks that the next scroll event to arrive (if any) was caused by
    // our own programmatic scrollTop write, not a genuine user scroll -
    // read and cleared unconditionally by the scroll handler. A boolean
    // rather than a counter deliberately - see trimAndScroll() below for
    // why a counter here caused "pause stops working after 15+ minutes
    // of a busy chat."
    this._suppressNextScrollEvent = false;

    // Sent-message history for Up/Down arrow key navigation, matching
    // Twitch's own chat behaviour. _sentHistory[0] is the most recently
    // sent message; _historyIdx is the index currently shown in the input
    // (-1 = not navigating, showing the live draft). _historyDraft saves
    // whatever the user had typed BEFORE they started pressing Up, so
    // pressing Down past index 0 restores it exactly.
    this._sentHistory  = [];
    this._historyIdx   = -1;
    this._historyDraft = "";

    // "Jump to latest" floating button - shown when the user has scrolled
    // up to read history, same UX pattern as Twitch's own chat.
    this.jumpToLatestBtn = document.getElementById("jump-to-latest-btn");
    this.jumpToLatestCount = document.getElementById("jump-to-latest-count");
    this.newMessageCountWhileScrolledUp = 0;

    if (this.sendBtn) {
      this.sendBtn.addEventListener("click", () => this.sendMessage());
    }
    // Emote autocomplete popup element - appended to the chat pane so it
    // appears above the input row and can be positioned relative to it.
    this._emotePopup = document.createElement("div");
    this._emotePopup.className = "emote-autocomplete";
    this._emotePopup.style.display = "none";
    // Appended to <body> with position:fixed so it is never clipped by
    // overflow:hidden ancestors (chat pane, video column, etc.) and is
    // always positioned correctly above the input row regardless of the
    // DOM hierarchy. Coordinates are computed in _showEmotePopup() from
    // the input's live bounding rect.
    document.body.appendChild(this._emotePopup);
    // Currently highlighted item index in the popup list.
    this._emotePopupIndex = -1;
    // Which kind of suggestion the shared popup is showing right now.
    this._popupMode = "emote"; // "emote" | "user"

    // Emote picker: the composer's smiley button + browsable/searchable
    // emote grid flyout (chat-emote-picker.js). Separate from the popup
    // above - that one is a typed-autocomplete suggestion list, this is
    // an explicit "browse everything available" panel, same distinction
    // Twitch's own chat UI and the 7TV extension both draw.
    this._initEmotePicker();
    // Users known for @mention autocomplete, keyed by lowercase login ->
    // display name (preserves casing). Populated from two sources: every
    // chat message seen this session (handles any channel, works for any
    // viewer), and - when the logged-in user is a mod/broadcaster of the
    // channel being watched - a one-time fetch of the FULL chatter list
    // via get_chatters() (see _maybeFetchChatters() below), which also
    // covers people who've been watching silently and never typed. The
    // two sources just merge into the same map; nothing distinguishes
    // them after the fact.
    this._chatUsers = new Map();
    // Guards _maybeFetchChatters() so it only actually fetches once per
    // channel (re-checked on chat-room AND on mod-status change, since
    // whichever arrives first might fire before the other is known).
    this._chattersFetchedForChannel = null;

    // Link preview popup - same "position:fixed, appended to body" pattern
    // as the emote popup above, for the same reason (never clipped by
    // overflow:hidden ancestors, positioned from the hovered link's own
    // bounding rect rather than the DOM hierarchy).
    this._linkPreviewPopup = document.createElement("div");
    this._linkPreviewPopup.className = "link-preview-popup";
    this._linkPreviewPopup.style.display = "none";
    document.body.appendChild(this._linkPreviewPopup);
    // Caches successful AND failed lookups by URL so re-hovering the same
    // link (extremely common - the same link often appears many times in
    // a busy chat) never re-fetches. Failed lookups cache to `null` so a
    // dead/slow link doesn't get retried on every single hover either.
    this._linkPreviewCache = new Map();
    // Guards against a fetch for a link the user already moved off of
    // resolving late and popping the popup back open - see
    // _scheduleLinkPreview/_cancelLinkPreview.
    this._linkPreviewToken = 0;

    if (this.inputEl) {
      this.inputEl.addEventListener("keydown", (e) => {
        if (this._emotePopup.style.display !== "none") {
          // Autocomplete navigation - popup is already open (opened via
          // Tab, see below), so these keys drive it instead of their
          // normal behavior.
          if (e.key === "ArrowUp") {
            e.preventDefault();
            this._moveEmoteSelection(-1);
            return;
          }
          if (e.key === "ArrowDown") {
            e.preventDefault();
            this._moveEmoteSelection(1);
            return;
          }
          if (e.key === "Tab" || e.key === "Enter") {
            e.preventDefault();
            this._commitEmoteSelection();
            return;
          }
          if (e.key === "Escape") {
            this._hideEmotePopup();
            return;
          }
        } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          // Message history navigation. Only active when the emote popup
          // is closed (handled above) and there's actually history to show.
          if (!this._sentHistory.length) return;
          e.preventDefault();

          if (e.key === "ArrowUp") {
            if (this._historyIdx === -1) {
              // Save whatever the user was composing before navigating.
              this._historyDraft = this.inputEl.value;
            }
            if (this._historyIdx < this._sentHistory.length - 1) {
              this._historyIdx++;
            }
          } else {
            // ArrowDown
            if (this._historyIdx === -1) return; // nothing to go forward to
            this._historyIdx--;
          }

          const text = this._historyIdx === -1
            ? this._historyDraft
            : this._sentHistory[this._historyIdx];

          this.inputEl.value = text;
          this._autosizeChatInput();
          // Place cursor at end so it's easy to edit the recalled message.
          this.inputEl.setSelectionRange(text.length, text.length);
          // Sync the send-button visibility.
          this.inputEl.closest?.(".chat-input-wrapper")
            ?.classList.toggle("has-text", text.length > 0);
          return;
        } else if (e.key === "Tab") {
          // Popup is closed - Tab is what opens it now (previously this
          // was driven automatically by the "input" listener below on
          // every keystroke, which meant just typing a common word like
          // "lol" silently opened the popup with its first match
          // pre-selected, and the very next Enter - meant to send the
          // message - committed that emote instead of sending. Gating
          // the popup behind an explicit Tab means typing normally and
          // pressing Enter always just sends, and the popup only ever
          // appears when the user actually asked for suggestions.
          //
          // Only swallow the keypress if there's actually a word under
          // the cursor worth suggesting for - otherwise (empty input, or
          // cursor sitting on whitespace) let Tab fall through to its
          // normal browser behavior (e.g. shifting focus to Send) rather
          // than silently eating every Tab press for nothing.
          const { word } = this._currentEmoteWord();
          if (word && word.length >= 2) {
            e.preventDefault();
            this._updateEmotePopup();
            return;
          }
        }
        // Enter sends (no Shift+Enter multi-line - matches Twitch's own
        // composer, which is also single-message-per-send). Needs
        // preventDefault() now that this is a <textarea>: a plain
        // <input> never inserted a newline on Enter, but a textarea
        // does unless this is stopped, which would just send an empty
        // trailing newline (trimmed away in sendMessage()) instead of
        // ever actually submitting the line for the user.
        if (e.key === "Enter") {
          e.preventDefault();
          this.sendMessage();
        }
      });

      // Opening the popup is now keydown-only, gated behind Tab (see
      // above) - deliberately NOT auto-opening from every input event
      // anymore, which is what used to make it pop open just from typing
      // a normal word. This input listener is scoped to only refresh the
      // filtered list while the popup is already open (e.g. opened on
      // "lo" via Tab, then typing "l" to narrow toward "LUL") - if a
      // commit/Escape/word change closes it, typing further just types
      // normally until Tab is pressed again.
      this.inputEl.addEventListener("input", () => {
        this._autosizeChatInput();
        // @mention autocomplete: auto-open as soon as @ + at least one letter typed.
        const atWord = this._currentAtWord();
        if (atWord.word && atWord.word.length >= 2) {
          this._updateUserPopup();
          return;
        }
        // If the @-word was deleted/changed, close a user popup.
        if (this._popupMode === "user") {
          this._hideEmotePopup();
        }
        // Emote popup refresh while it's already open (Tab-triggered).
        if (this._emotePopup.style.display !== "none") this._updateEmotePopup();
      });
      this.inputEl.addEventListener("blur", () => {
        // Small delay so a popup click registers before the popup hides.
        setTimeout(() => this._hideEmotePopup(), 150);
      });
    }
    if (this.jumpToLatestBtn) {
      this.jumpToLatestBtn.addEventListener("click", () => this.scrollToLatest());
    }
    if (this.container) {
      this.container.addEventListener("scroll", () => {
        // Ignore scroll events caused by our own scrollTop assignments
        // (auto-scroll-to-bottom on a new message, "Jump to latest",
        // connect()'s reset, etc) - checked FIRST, before anything else
        // reacts to this event. This used to be checked after
        // unconditionally dismissing the link preview popup below, which
        // meant every single new message (each one auto-scrolls while
        // the user's at the bottom) dismissed any open/pending preview -
        // and since auto-scrolling shifts chat content under a
        // stationary cursor, it also re-fires mouseenter/mouseleave on
        // whatever's now under the mouse, so a busy chat meant the
        // preview was being scheduled and immediately cancelled many
        // times a second, which is also what was showing up as the chat
        // itself looking "bouncy/vibrating" (each cycle rebuilds the
        // popup's contents and forces a synchronous layout read to
        // measure/position it). A genuine user scroll should still
        // dismiss the preview (its anchor link has moved/scrolled out
        // from under the popup's fixed position), so that part stays -
        // it just needs to happen only for scrolls that actually are that.
        if (this._suppressNextScrollEvent) {
          this._suppressNextScrollEvent = false;
          return;
        }
        // Any scroll event that reaches this point is a genuine user
        // scroll - trimAndScroll() now suppresses its own scrollTop
        // compensation explicitly (see there for why), rather than this
        // handler having to guess whether a given event might have been
        // caused by a trim.
        this._cancelLinkPreview();
        // Same reasoning as the link preview popup above - the card is
        // anchored to a username span whose position becomes stale once
        // the list scrolls.
        this._closeUserCard();
        const atBottom =
          this.container.scrollHeight - this.container.scrollTop - this.container.clientHeight < 80;
        if (atBottom) {
          // User scrolled back down manually - resume auto-scroll.
          this.userScrolledUp = false;
          this.newMessageCountWhileScrolledUp = 0;
          this.jumpToLatestBtn?.classList.remove("visible");
        } else {
          // User scrolled up intentionally.
          this.userScrolledUp = true;
          this.updateJumpToLatestVisibility();
        }
      });
    }
  }

  /** Shows/hides the entire chat-input-row (input box + send button), not
   * just disabling the input - VOD replay has no live chat connection to
   * send to, so there's nothing for an enabled-but-disabled input to do.
   * Twitch's own VOD player has no chat box at all in replay mode; this
   * matches that rather than just greying the input out. */
  _setInputRowVisible(visible) {
    const inputRow = this.inputEl?.closest(".chat-input-row");
    if (inputRow) inputRow.style.display = visible ? "" : "none";
  }

  /** Grows/shrinks the chat textarea to fit its content as the user
   * types, up to the CSS max-height (after which it scrolls internally
   * instead of growing further). Resetting height to "auto" first is
   * required before reading scrollHeight - otherwise scrollHeight just
   * reports the box's current (possibly stale, possibly too-large-from-
   * a-deleted-line) height back, since the textarea hasn't shrunk on its
   * own first. Called on every "input" event and once after clearing the
   * box (sendMessage(), Escape, slash-command handling) so deleting text
   * or sending a multi-line message also shrinks the box back down.
   *
   * overflow-y is toggled here rather than left as a permanent CSS
   * `auto` - Chromium renders a visible scrollbar-gutter/spin-button-
   * looking affordance on a <textarea> with overflow-y:auto even while
   * its content fits well under max-height, which is what made a single
   * short line show stray up/down arrows. Switching to `auto` only once
   * scrollHeight has actually exceeded MAX_HEIGHT_PX (and back to
   * `hidden` once it no longer does) keeps the box looking like a plain
   * input until a message genuinely needs to scroll. */
  _autosizeChatInput() {
    const el = this.inputEl;
    if (!el) return;
    // Not laid out yet (hidden panel, pre-first-paint): scrollHeight
    // reads 0 and writing height:0px would collapse the box. Leave the
    // CSS natural height; a later call from a visible state settles it.
    if (el.scrollHeight === 0) return;
    // Captured BEFORE the resize: growing the input shrinks .chat-body
    // (they're flex siblings), which moves the messages' bottom edge
    // away from the viewport - to the scroll handler that's
    // indistinguishable from the user scrolling up, so typing a long
    // message used to pause chat on itself. Twitch's behavior (and now
    // ours): if chat was pinned to the newest message before the input
    // grew, it stays pinned after.
    const wasPinned = !this.userScrolledUp;
    el.style.height = "auto";
    const overflowing = el.scrollHeight > CHAT_INPUT_MAX_HEIGHT_PX;
    el.style.height = `${Math.min(el.scrollHeight, CHAT_INPUT_MAX_HEIGHT_PX)}px`;
    el.style.overflowY = overflowing ? "auto" : "hidden";
    // Publish the input row's real height so the jump-to-latest pill
    // can sit above it via calc() - its old hardcoded bottom offset
    // assumed a one-line input and let a grown textarea slide right
    // underneath the pill.
    const row = el.closest(".chat-input-row");
    if (row?.parentElement) {
      row.parentElement.style.setProperty("--chat-input-row-h", `${row.offsetHeight}px`);
    }
    if (wasPinned && this.container) {
      // Same programmatic-scroll marker every other pinned write uses,
      // so the scroll handler doesn't misattribute this to the user.
      this._suppressNextScrollEvent = true;
      this.container.scrollTop = this.container.scrollHeight;
    }
  }

  /** Called once login succeeds, to enable the message input. `userId` is
   * the logged-in account's own Twitch user id (from validate_oauth_token
   * via auth.js), stored so sendMessage()'s optimistic local echo can
   * give the user's own messages a real userId, the same way every other
   * rendered message has one - without it, clicking your own username
   * had nothing to attach the click handler to, since the local echo was
   * the only representation of your own messages and predated the user
   * card. */
  setLoggedIn(login, userId, displayName) {
    console.log("[points] setLoggedIn called, channel:", this.channel, "roomId:", this.roomId);
    this.isLoggedIn = true;
    this.ownLogin = login;
    this.ownDisplayName = displayName || login; // properly-cased for display
    this.ownUserId = userId || null;
    if (this.inputEl) {
      this.inputEl.disabled = false;
      this.inputEl.placeholder = "Send a message";
      // Show the Send button only while there is text to send.
      const wrapper = this.inputEl.closest(".chat-input-wrapper");
      this.inputEl.addEventListener("input", () => {
        wrapper?.classList.toggle("has-text", this.inputEl.value.length > 0);
      });
      // Settle the composer at its JS-computed height immediately -
      // otherwise the empty box sits at the browser's natural rows="1"
      // height until the first keystroke, misaligning the badge and
      // placeholder against where they'll be once typing starts.
      this._autosizeChatInput();
    }
    if (this.sendBtn) this.sendBtn.disabled = false;
    if (this.emoteBtn) this.emoteBtn.disabled = false;

    // Badge/cheermote fetches require a Helix API token. If connect() ran
    // before login the initial fetches failed silently (401). Now that we
    // have a token, retry everything without needing a stream restart.
    if (this.channel) {
      this.loadGlobalBadges();
      if (this.roomId) {
        this.loadChannelBadges(this.roomId);
        this.loadCheermotes(this.roomId);
        invoke("start_eventsub", { broadcasterId: this.roomId }).catch(() => {});
        // Same retry reasoning as above: ownLogin/the Helix token
        // _maybeFetchChatters() needs are only available from here on.
        this._maybeFetchChatters();
      }
    }
  }

  async sendMessage() {
    if (!this.inputEl || this._isVodMode) return;

    // Kick chat send path: separate command, separate login, no Twitch
    // IRC semantics (slash commands, reply-parent, USERSTATE color all
    // don't apply). Kept as an early self-contained branch so the Twitch
    // path below stays exactly as it was.
    if (this._isKickChat) {
      if (!this._kickLoggedIn || this._kickBroadcasterId == null) return;
      const text = this.inputEl.value.trim();
      if (!text) return;
      try {
        await invoke("kick_send_chat_message", {
          broadcasterUserId: this._kickBroadcasterId,
          message: text,
        });
        this.inputEl.value = "";
        this._autosizeChatInput();
        this.inputEl.closest?.(".chat-input-wrapper")?.classList.remove("has-text");
        this._sentHistory.unshift(text);
        if (this._sentHistory.length > 50) this._sentHistory.pop();
        this._historyIdx = -1;
        this._historyDraft = "";
        // Kick's Pusher feed DOES echo the sender's own message back
        // (unlike Twitch IRC), so - unlike the Twitch path - we do NOT
        // render an optimistic local echo here; doing so would double
        // every message the user sends. The message appears when it
        // arrives over the socket like everyone else's.
      } catch (err) {
        this.systemLine(`Couldn't send to Kick: ${err}`);
      }
      return;
    }

    if (!this.isLoggedIn) return;
    const text = this.inputEl.value.trim();
    if (!text) return;

    if (text.startsWith("/")) {
      const handled = await this._tryHandleSlashCommand(text);
      if (handled) {
        this.inputEl.value = "";
        this._autosizeChatInput();
        return;
      }
      // Not a command this app recognizes - fall through and send it as
      // a literal message, same as Twitch's own chat does for unknown
      // slash input (e.g. "/this isn't a command" just gets sent as
      // text). Avoids silently swallowing a message someone meant to
      // actually send just because it happened to start with "/".
    }

    try {
      await invoke("send_chat_message", {
        message: text,
        replyToMsgId: this._replyToId || null,
      });
      this.clearReply();
      this.inputEl.value = "";
      this._autosizeChatInput();
      this.inputEl.closest?.(".chat-input-wrapper")?.classList.remove("has-text");

      // Add to sent history so Up/Down can recall it. Prepend so index 0
      // always means "most recent"; cap at 50 to avoid unbounded growth.
      this._sentHistory.unshift(text);
      if (this._sentHistory.length > 50) this._sentHistory.pop();
      this._historyIdx   = -1;
      this._historyDraft = "";

      // Twitch's IRC server deliberately doesn't echo a client's own
      // PRIVMSG back to that connection, so we render our own sent
      // message optimistically here rather than waiting for it to come
      // back - it never will. This doesn't reflect server-side
      // moderation outcomes (a dropped message still appears to send
      // successfully, since there's no client-side way to tell without
      // something like EventSub) - acceptable for this PoC.
      //
      // userId/badgesTag are passed through so the user's own messages
      // get a clickable username opening the user card, same as anyone
      // else's. Color comes from _ownColor (set by the user-state
      // listener below), falling back to Twitch's default purple only if
      // USERSTATE hasn't arrived yet. msgId is deliberately left
      // undefined - it doesn't exist until/unless the message arrives
      // back over IRC, which it never will here - so the card's Delete
      // button stays correctly disabled ("No message to delete") instead
      // of looking enabled while guaranteed to fail against Helix.
      this.renderMessage(this.ownDisplayName || this.ownLogin || "you", this._ownColor || "#9147ff", text, this._ownBadgesTag,
                          undefined, undefined, undefined, undefined, undefined, this.ownUserId,
                          /*isAction=*/false, /*emotesTag=*/null, /*isFirstMsg=*/false);
    } catch (err) {
      console.error("Failed to send message:", err);
      this.systemLine(`Failed to send: ${err}`);
    }
  }

  // ── Slash commands ──────────────────────────────────────────────────
  //
  // /ban, /unban, /timeout, /untimeout, /clear - the same actions the
  // user card's buttons call, reachable by typing instead. All except
  // /clear need a username -> user id resolution first (ban_user/
  // unban_user take an id, not a login - see get_user_id_for_login in
  // main.rs), so these are all async despite most of the actual Helix
  // calls being identical to what the card already does.
  //
  // Argument order is accepted flexibly for /timeout specifically -
  // "/timeout username 10m" and "/timeout 10m username" both work, since
  // the request that prompted this ("/timeout 15 UserName") put the
  // duration first, which is also how Twitch's OWN /timeout has always
  // accepted it (duration optional, defaults to 10 minutes if omitted) -
  // whichever of the two tokens parses as a duration is treated as the
  // duration; the other is the username, regardless of position.

  setStatus(text) {
    if (this.statusEl) this.statusEl.textContent = text;
  }

  systemLine(text) {
    const div = document.createElement("div");
    div.className = "chat-line system";
    div.textContent = text;
    this.container.appendChild(div);
    this.trimAndScroll();
  }

  trimAndScroll() {
    // Scroll-suppression here has been fixed twice, both times because a
    // trimming pass shifts scrollTop and something reacted incorrectly:
    //
    // 1. Native scroll anchoring silently skipped compensation on some
    //    trims (a spec-allowed heuristic miss, not a bug in the browser),
    //    which drifted scrollTop toward the bottom over thousands of
    //    trims until it crossed the "atBottom" threshold on its own -
    //    auto-scroll would silently resume with the user never touching
    //    anything. Fixed by overflow-anchor:none on .chat-body
    //    (index.html) plus the exact scrollHeight-delta compensation
    //    below, so nothing is left to drift.
    //
    // 2. The fix above tracked suppression with a counter
    //    (this.suppressScrollEventCount), incremented per programmatic
    //    scrollTop write and decremented per scroll event received - but
    //    a write doesn't synchronously queue an event, and the browser
    //    can coalesce several rapid writes (common in an active chat)
    //    into fewer dispatched events than writes. That desyncs the
    //    counter permanently above zero, so every future scroll event -
    //    including genuine user scrolls - gets swallowed. This, not a
    //    recurrence of #1, was the real cause of "pause stops working
    //    after 15+ minutes of a busy chat." Fixed by replacing the
    //    counter with this._suppressNextScrollEvent (a boolean): however
    //    many writes happen and however many events actually fire, the
    //    next event to arrive is treated as ours and the flag clears -
    //    nothing to count, nothing to overshoot.
    const heightBefore = this.container.scrollHeight;
    while (this.container.children.length > this.maxLines) {
      this.container.removeChild(this.container.firstChild);
    }
    const removedHeight = heightBefore - this.container.scrollHeight;
    if (removedHeight > 0 && this.userScrolledUp) {
      // Suppress the scroll event this assignment fires, same reasoning
      // as the !userScrolledUp branch below - this is OUR adjustment,
      // not the user scrolling.
      this._suppressNextScrollEvent = true;
      this.container.scrollTop -= removedHeight;
    }
    if (!this.userScrolledUp) {
      // Suppress the scroll event this assignment will fire so it doesn't
      // falsely flip userScrolledUp on the next tick.
      this._suppressNextScrollEvent = true;
      this.container.scrollTop = this.container.scrollHeight;
    } else {
      this.newMessageCountWhileScrolledUp++;
      this.updateJumpToLatestVisibility();
    }

  }

  /** Shows/hides the floating button and updates its new-message count. */
  updateJumpToLatestVisibility() {
    if (!this.jumpToLatestBtn) return;
    if (!this.userScrolledUp) {
      this.newMessageCountWhileScrolledUp = 0;
      this.jumpToLatestBtn.classList.remove("visible");
      return;
    }
    this.jumpToLatestBtn.classList.add("visible");
    if (this.jumpToLatestCount) {
      this.jumpToLatestCount.textContent =
        this.newMessageCountWhileScrolledUp > 0 ? `${this.newMessageCountWhileScrolledUp} new -` : "";
    }
  }

  /** Scrolls to the latest message and resumes auto-scroll. */
  scrollToLatest() {
    this.userScrolledUp = false;
    this.newMessageCountWhileScrolledUp = 0;
    this._suppressNextScrollEvent = true;
    this.container.scrollTop = this.container.scrollHeight;
    if (this.jumpToLatestBtn) this.jumpToLatestBtn.classList.remove("visible");
  }

  /**
   * Runs `fn` after the previous lifecycle op settles (so their
   * teardown/setup pairs never interleave), BUT skips it entirely if a
   * newer lifecycle call arrived while this one was queued. `fn` receives
   * an isCurrent() predicate it can re-check after its own awaits, so a
   * long-running connect that gets superseded mid-flight can also bail.
   *
   * Result: rapid channel switches collapse to just the last one. The
   * intermediate connects are abandoned before doing any visible work
   * instead of each running to completion in sequence.
   */
  _serializeLifecycle(fn) {
    const myEpoch = ++this._lifecycleEpoch;
    const isCurrent = () => this._lifecycleEpoch === myEpoch;
    const run = this._lifecycleChain.then(
      () => {
        // Superseded while waiting our turn - don't touch listeners or the
        // Rust connection at all; the newer call owns them now.
        if (!isCurrent()) return undefined;
        return fn(isCurrent);
      },
      () => {
        if (!isCurrent()) return undefined;
        return fn(isCurrent);
      },
    );
    this._lifecycleChain = run.catch(() => {});
    return run;
  }

  /** Connect (via the Rust backend) and join a channel. Safe to call again to switch channels. */
  async connect(channel) {
    return this._serializeLifecycle((isCurrent) => this._doConnect(channel, isCurrent));
  }

  async _doConnect(channel, isCurrent = () => true) {
    // Stop any VOD chat replay loop left running from a previous
    // setVodMode() call. Without this, switching from a VOD to a live
    // channel left the old replay's tick() loop running indefinitely in
    // the background (it has no lifetime tied to anything else - only
    // _vodReplayStop() / disconnect() ever clears its `stopped` flag,
    // and this function never called either). The stray loop kept
    // periodically wiping #chat-messages (this.container.innerHTML = "")
    // and printing "Chat replay restarting from new position…" into
    // what looked like ordinary live chat, since both replay and live
    // chat render into the same container - see setVodMode()'s symmetric
    // call to this.disconnect() for the same teardown in the other
    // direction.
    if (this._vodReplayStop) {
      this._vodReplayStop();
      this._vodReplayStop = null;
    }
    this.channel = channel.toLowerCase();
    this.roomId = null;
    this.userScrolledUp = false;
    // Leaving any prior Kick-chat session behind - back on Twitch IRC now.
    this._isKickChat = false;
    this._kickBroadcasterId = null;
    // Stale chatters from the old channel shouldn't suggest into this
    // one's @mentions - cleared here (not just in disconnect()) because
    // connect() can be called channel-to-channel directly without
    // disconnect() running first (see watchChannel() in main.js).
    this._chatUsers.clear();
    this._chattersFetchedForChannel = null;
    // Returning to live chat from a VOD (or just connecting fresh) -
    // restore the input row, which setVodMode() hides for the duration
    // of replay. See _setInputRowVisible()'s comment for why it's hidden
    // outright rather than just disabled.
    this._isVodMode = false;
    this._setInputRowVisible(true);
    // ...and put the composer's own state back too: a preceding Kick
    // session leaves it disabled with a "Log in with Kick to chat"
    // placeholder (_applyKickInputState mutates the same shared DOM),
    // and clearing _isKickChat above changes none of that on its own -
    // without this, every Twitch stream after a Kick one showed a dead
    // composer asking for the wrong platform's login.
    this._applyTwitchInputState();
    // Reset to false rather than leaving any pending suppression set -
    // this is a fresh channel/connection, so a suppression queued up for
    // the previous channel's now-cleared chat body is no longer
    // meaningful.
    this._suppressNextScrollEvent = false;
    this.newMessageCountWhileScrolledUp = 0;
    this.sevenTvEmotes.clear();
    this.twitchNativeEmotes.clear();
    this.badgeMap.clear();
    this.cheermoteMap.clear();
    this._ownBadgesTag = null;
    // Reset to false on every channel switch rather than carrying over -
    // being a mod in the previous channel says nothing about this one,
    // and USERSTATE for the new channel won't arrive instantly, so there'd
    // otherwise be a window where mod tools wrongly stay "on" for a
    // channel the user just switched to but isn't actually a mod in.
    this.isMod = false;
    // A new channel's held messages have nothing to do with the previous
    // one's - clear the queue and the panel/badge it drives.
    this._automodQueue = [];
    this._renderAutomodPanel();
    // Same reasoning for the per-user tracking the card reads from - a
    // message count or recent-message log from a different channel's
    // chat would be actively misleading shown against this one. User
    // info (account creation date etc.) is the one exception left
    // un-cleared below - that's about the Twitch account itself, not
    // this channel, so it stays valid and worth keeping cached across a
    // channel switch.
    this._messageCountByUserId = new Map();
    this._messageHistoryByUserId = new Map();
    this._closeUserCard();
    this.container.innerHTML = "";
    this.newMessageCountWhileScrolledUp = 0;
    if (this.jumpToLatestBtn) this.jumpToLatestBtn.classList.remove("visible");

    await this.teardownListeners();
    await this.setupListeners();

    this.setStatus("connecting…");
    // Rust's connect routine (chat.rs) emits its own "Connecting to chat
    // for #channel..." system message via the chat-system event (see the
    // listener in setupListeners) right at the start of its own connection
    // attempt, before any actual network activity - printing the same
    // text here too was pure duplication, not a genuine "instant feedback
    // while Rust is still working" benefit, since the IPC round-trip to
    // reach that point is near-instant.

    // Load 7TV global emotes immediately; channel emotes load once Rust
    // reports the room-id (via the chat-room event) after joining.
    this.loadSevenTvGlobalEmotes();
    this.loadBttvGlobalEmotes();
    this.loadFfzGlobalEmotes();
    this.loadTwitchGlobalEmotes();
    // Same lifecycle for Twitch's own chat badges (Broadcaster, Moderator,
    // VIP, subscriber tiers, etc) - global badges load now, channel-
    // specific ones (which override global subscriber art per-channel)
    // load once we know the room-id.
    this.loadGlobalBadges();

    // If a newer channel was clicked while we were setting up, don't
    // bother opening the Rust IRC connection for this now-stale channel -
    // the queued newer connect (next on the lifecycle chain) will do its
    // own teardown+setup and connect the channel the user actually wants.
    // This is what stops rapid switching from visibly crawling through
    // every intermediate channel's chat.
    if (!isCurrent()) return;

    try {
      await invoke("start_chat", { channel: this.channel });
    } catch (err) {
      this.setStatus("error");
      this.systemLine(`Failed to start chat: ${err}`);
    }
  }

  async disconnect() {
    return this._serializeLifecycle(() => this._doDisconnect());
  }

  async _doDisconnect() {
    // Always dismiss the emote autocomplete popup - it uses position:fixed
    // on document.body so it's not scoped to the chat pane, and can
    // otherwise appear stranded over unrelated parts of the UI after a
    // channel switch or stream stop.
    this._hideEmotePopup();
    // Same reasoning as the autocomplete popup above, plus its contents
    // (the emote grid) would otherwise still show the OLD channel's
    // emotes for a moment after switching.
    this._closeEmotePicker();
    this._chatUsers.clear(); // stale users from old channel shouldn't appear in @mentions
    // Same reasoning, same position:fixed-on-body setup, for the link
    // preview popup - also cancels any in-flight hover timer/fetch so a
    // request for the old channel's chat can't resolve after switching
    // and pop the popup open over the new channel.
    this._cancelLinkPreview();
    // Same reasoning again for the user card.
    this._closeUserCard();
    // Stop any running VOD chat replay loop before tearing down the
    // live connection, so the two don't overlap if the user switches
    // from a VOD back to a live stream mid-replay.
    if (this._vodReplayStop) {
      this._vodReplayStop();
      this._vodReplayStop = null;
    }
    try {
      await invoke("stop_eventsub");
    } catch (_) {}
    try {
      await invoke("stop_seventv_events");
    } catch (_) {}
    try {
      await invoke("stop_chat");
    } catch (err) {
      console.error("stop_chat error:", err);
    }
    await this.teardownListeners();
    // Leave the pane in a neutral Twitch shape rather than whatever the
    // torn-down session had. Matters for the plain Stop-from-a-Kick-
    // session case, where nothing connects afterward: without this the
    // idle composer kept Kick's disabled "Log in with Kick to chat"
    // state indefinitely. Callers that go on to establish a new mode
    // overwrite this immediately (connectKick -> _applyKickInputState,
    // setVodMode/setKickVodMode -> hidden row), so it only ever "sticks"
    // when idle/Twitch is genuinely what comes next - which also makes
    // the constructor's "_isKickChat ... cleared by connect/disconnect"
    // note true (previously only connect() actually cleared it).
    this._isKickChat = false;
    this._kickBroadcasterId = null;
    this._applyTwitchInputState();
  }

  /**
   * Chat state for a Kick VOD: there is no Kick chat-replay API (unlike
   * Twitch's GQL comments that power setVodMode), so this is setVodMode
   * minus the replay engine - tear down whatever live connection was
   * running, clear the pane, hide the composer (nothing to send to),
   * and say plainly why the pane is empty rather than leaving a frozen
   * copy of the previous session's chat sitting there.
   */
  async setKickVodMode() {
    return this._serializeLifecycle(() => this._doSetKickVodMode());
  }

  async _doSetKickVodMode() {
    await this._doDisconnect();
    this._clearChannelEmotes();
    this.container.innerHTML = "";
    this.channel = null;
    this._isKickChat = false;
    this._isVodMode = true;
    this._setInputRowVisible(false);
    this.setStatus("replay");
    this.systemLine("Chat replay isn't available for Kick VODs.");
  }

  /**
   * Kick-mode chat: tears down Twitch chat and starts the read-only Rust
   * Pusher client (kick_chat.rs), whose events ride the exact same
   * chat-message/chat-system pipeline the IRC client uses.
   *
   * This exists because disconnect() ends with teardownListeners() -
   * correct for "chat is over", but the Kick swap in attachKickStream
   * used to call disconnect() and then start the Kick client directly,
   * so every event the (perfectly healthy) Kick client emitted arrived
   * with no listener registered and silently vanished. The confirmed
   * symptom: Kick video playing fine, chat pane frozen on the stale
   * Twitch system lines, and nothing chat-related in the DevTools
   * console at all - the Rust client's own logs go to the terminal, not
   * DevTools, so the drop was invisible from the webview. The return
   * path (back to Twitch) never had this problem because it goes through
   * connect(), which re-registers listeners.
   */
  async connectKick(channel, chatroomId, broadcasterUserId, subscriberBadges) {
    return this._serializeLifecycle(() =>
      this._doConnectKick(channel, chatroomId, broadcasterUserId, subscriberBadges),
    );
  }

  async _doConnectKick(channel, chatroomId, broadcasterUserId, subscriberBadges) {
    await this._doDisconnect(); // full Twitch teardown, incl. listeners
    this.channel = channel.toLowerCase();
    this._isKickChat = true;
    // Clear VOD-replay mode if the previous session was a VOD (Twitch
    // replay or a Kick VOD's no-replay notice) - connect() resets this
    // on the way back to Twitch live, but this path never goes through
    // connect(), and a stale true here blocks sendMessage()'s early
    // return even after _applyKickInputState below re-shows the
    // composer.
    this._isVodMode = false;
    this._kickBroadcasterId = broadcasterUserId ?? null;
    // This channel's custom subscriber badge art - replaced (not merged)
    // per connection so channel A's tiers can never dress channel B's
    // subscribers.
    this._kickSubscriberBadges = Array.isArray(subscriberBadges) ? subscriberBadges : [];
    // Fresh pane: the lines sitting in it ("Connecting to chat for
    // #x…", emote-load notices) belong to the Twitch connection that
    // was just torn down, not to the Kick chat about to start.
    this.container.innerHTML = "";
    // Own-identity leftovers from the Twitch session: USERSTATE's badge
    // tag renders next to the chat input (#chat-input-badge) AND onto
    // local echoes of your own sent messages. It's Twitch-channel state
    // with no Kick equivalent - nothing ever arrives on a Kick
    // connection to overwrite it, and _renderInputBadges only runs on
    // USERSTATE, so without an explicit clear here your Twitch badges
    // (mod sword, sub badge, ...) followed you into every Kick chat.
    this._ownBadgesTag = null;
    this._renderInputBadges(null);
    this.newMessageCountWhileScrolledUp = 0;
    if (this.jumpToLatestBtn) this.jumpToLatestBtn.classList.remove("visible");
    // Re-register the listeners disconnect() tore down - the Kick
    // client emits the same event names, so this is all the frontend
    // needs to render it.
    await this.setupListeners();
    // Emotes. This previously loaded NOTHING for Kick chat - connect()
    // loads globals and the chat-room event loads channel emotes, and
    // the Kick path went through neither, so every 7TV/BTTV/FFZ name
    // rendered as bare text (or worse, as the PREVIOUS Twitch channel's
    // leftover art, since nothing cleared the map). Clear, then load:
    // all three providers' globals, 7TV's Kick-platform channel set
    // (BTTV/FFZ have no Kick support, so globals only for those two),
    // and the channel's native Kick emotes so the [emote:id:name]
    // tokens kick_chat.rs flattens to names resolve back into images.
    this.sevenTvEmotes.clear();
    this.loadSevenTvGlobalEmotes();
    this.loadBttvGlobalEmotes();
    this.loadFfzGlobalEmotes();
    if (this._kickBroadcasterId != null) {
      this.loadSevenTvKickChannelEmotes(this._kickBroadcasterId);
    }
    this.loadKickNativeEmotes(this.channel);
    // Whether this Kick session can SEND depends on three things: the
    // user is logged into Kick, AND we have a broadcaster id to target.
    // If both hold, show and enable the composer; otherwise it stays
    // read-only exactly like before (Kick login came later - the
    // failover/browse paths don't block on it).
    this._applyKickInputState();
    // If sending isn't possible, say WHY, once, in the pane itself -
    // a silently read-only chat with no visible cause was the confirmed
    // complaint this addresses. The three causes are distinct:
    if (!this._kickLoggedIn) {
      if (!this._kickOAuthConfigured) {
        this.systemLine(
          "Kick chat is read-only: this build has no Kick API credentials, so login isn't available. " +
          "Register an app at kick.com/settings/developer and build with KICK_CLIENT_ID / KICK_CLIENT_SECRET set (see kick_oauth.rs)."
        );
      }
      // Configured-but-logged-out needs no system line - the disabled
      // composer's "Log in with Kick to chat" placeholder covers it.
    } else if (this._kickBroadcasterId == null) {
      this.systemLine(
        "Kick chat is read-only for this channel: Kick's payload didn't include a broadcaster id to send to."
      );
    }
    try {
      await invoke("start_kick_chat", { chatroomId });
    } catch (err) {
      this.setStatus("error");
      this.systemLine(`Failed to start Kick chat: ${err}`);
    }
  }

  /** Twitch counterpart of _applyKickInputState below: puts the shared
   * composer DOM back into its Twitch shape - enabled with "Send a
   * message" when logged in, disabled with the same placeholder when not
   * (the HTML's own initial state; setLoggedIn() only ever flips
   * enablement, never the text). This exists because the composer
   * elements are SHARED between the two platforms' chat modes, and
   * _applyKickInputState mutates them (disabled + "Log in with Kick to
   * chat") with nothing on the Twitch return path undoing it - the
   * confirmed symptom being a Twitch stream, after any Kick session,
   * showing a dead composer still asking for a KICK login. Called from
   * connect() (the Kick -> Twitch switch) and disconnect() (Stop from a
   * Kick session with nothing connecting after - an idle pane shouldn't
   * advertise Kick either). */
  _applyTwitchInputState() {
    const canSend = this.isLoggedIn;
    if (this.inputEl) {
      this.inputEl.disabled = !canSend;
      this.inputEl.placeholder = "Send a message";
    }
    if (this.sendBtn) this.sendBtn.disabled = !canSend;
    if (this.emoteBtn) this.emoteBtn.disabled = !canSend;
  }

  /** Reconciles the composer (input row visibility + enabled state +
   * status text) with current Kick state. Called from connectKick and
   * whenever Kick login changes while Kick chat is showing. */
  _applyKickInputState() {
    if (!this._isKickChat) return;
    const canSend = this._kickLoggedIn && this._kickBroadcasterId != null;
    // Show the composer whenever sending is either possible or exactly
    // one login away - a hidden row gave "read-only" zero explanation
    // (the "Log in with Kick to chat" placeholder below was being set
    // on an invisible input). Only when login isn't even offered (build
    // has no Kick credentials, or the payload lacked a broadcaster id
    // to send to) does the row hide entirely, VOD-replay style.
    const loginPossible = this._kickOAuthConfigured && this._kickBroadcasterId != null;
    this._setInputRowVisible(canSend || loginPossible);
    if (this.inputEl) {
      this.inputEl.disabled = !canSend;
      this.inputEl.placeholder = canSend
        ? "Send a message"
        : "Log in with Kick to chat";
    }
    if (this.sendBtn) this.sendBtn.disabled = !canSend;
    if (this.emoteBtn) this.emoteBtn.disabled = !canSend;
    if (canSend) {
      this.setStatus(`kick chat — ${this._kickLogin || "connected"}`);
    } else {
      this.setStatus("kick chat (read-only)");
    }
  }

  /** Called by main.js once at startup after the kick_oauth_configured
   * check resolves: whether this BUILD is capable of Kick login at all
   * (real client credentials baked in). Distinct from _kickLoggedIn,
   * which is whether the user has actually done so. Determines whether
   * the read-only composer is shown-disabled ("log in to chat") or
   * hidden with an explanation (login isn't available, full stop). */
  setKickOAuthConfigured(configured) {
    this._kickOAuthConfigured = Boolean(configured);
    if (this._isKickChat) this._applyKickInputState();
  }

  /** Called by main.js when Kick login state changes (OAuth success,
   * session restore, or logout). Updates the composer live if Kick chat
   * is currently showing, so logging in mid-stream flips the read-only
   * pane into a writable one without a reconnect. */
  setKickLoggedIn(loggedIn, login) {
    this._kickLoggedIn = Boolean(loggedIn);
    this._kickLogin = login || null;
    if (this._isKickChat) this._applyKickInputState();
  }

  async setupListeners() {
    this.unlisteners.push(
      await listen("chat-message", (event) => {
        const { username, color, message, badges, bits, custom_reward_id,
                reply_parent_user, reply_parent_body, msg_id, user_id, is_action,
                emotes_tag, is_first_msg } = event.payload;
        // Track chatters for @mention autocomplete (cap at 500 to avoid memory bloat).
        if (username) {
          this._chatUsers.set(username.toLowerCase(), username);
          if (this._chatUsers.size > 500) {
            this._chatUsers.delete(this._chatUsers.keys().next().value);
          }
        }
        this.renderMessage(username, color || "#9147ff", message, badges, bits, custom_reward_id,
                           reply_parent_user, reply_parent_body, msg_id, user_id, is_action,
                           emotes_tag, is_first_msg);
      })
    );

    this.unlisteners.push(
      await listen("chat-system", (event) => {
        this.systemLine(event.payload.text);
      })
    );

    this.unlisteners.push(
      await listen("chat-status", (event) => {
        this.setStatus(event.payload.status);
      })
    );

    this.unlisteners.push(
      await listen("eventsub-redeem", (event) => {
        this.renderRedeemEvent(event.payload);
      })
    );

    this.unlisteners.push(
      await listen("chat-room", (event) => {
        // Persist so setLoggedIn() can reload badges/cheermotes after login.
        this.roomId = event.payload.room_id;
        this.loadSevenTvChannelEmotes(this.roomId);
        // BTTV *channel* emotes and FFZ (which has no other loader at
        // all) were previously never fetched - the confirmed cause of
        // very common emotes (LOLW, KEKW - both FFZ channel emotes on
        // the affected channel) rendering as bare text in live chat.
        this.loadBttvChannelEmotes(this.roomId);
        this.loadFfzChannelEmotes(this.roomId);
        this.loadChannelBadges(this.roomId);
        this.loadCheermotes(this.roomId);
        // EventSub for channel point redemption events (works when logged
        // in as broadcaster/mod of this channel; silently no-ops otherwise).
        invoke("start_eventsub", { broadcasterId: this.roomId }).catch(() => {});
        // Room-id just became known - the other trigger for
        // _maybeFetchChatters() (see its comment for why there are two).
        this._maybeFetchChatters();
      })
    );

    this.unlisteners.push(
      await listen("seventv-emote-set-update", (event) => {
        this._applySevenTvEmoteSetUpdate(event.payload);
      })
    );

    this.unlisteners.push(
      await listen("user-state", (event) => {
        // Cache the badge string so we can retry after the badge image
        // maps finish loading (USERSTATE often arrives before the async
        // loadGlobalBadges / loadChannelBadges calls complete).
        this._ownBadgesTag = event.payload.badges;
        this._renderInputBadges(this._ownBadgesTag);
        // Own chat color for this channel - used by sendMessage()'s
        // optimistic local echo so the user's own messages show their
        // actual chosen color instead of a hardcoded default (see the
        // comment there for why the echo exists at all). Twitch lets
        // color be unset (a user who's never picked one) - color stays
        // null/undefined in that case rather than getting coerced to a
        // fallback here, since renderMessage's normalizeColor() already
        // has its own (different, established) fallback for that.
        if (event.payload.color) this._ownColor = event.payload.color;
        // Mod tools visibility depends on this - re-derive and let main.js
        // (which owns the hover-icon/context-menu DOM, not chat.js) know
        // it may need to re-render anything already on screen, since
        // USERSTATE can arrive well after the first messages do (it's
        // sent on JOIN, but PRIVMSGs from other users can already be
        // flowing in before it lands).
        this._updateModStatus();
      })
    );

    this.unlisteners.push(
      await listen("chat-clearchat", (event) => {
        this._handleClearChat(event.payload);
      })
    );

    this.unlisteners.push(
      await listen("chat-clearmsg", (event) => {
        this._handleClearMsg(event.payload);
      })
    );

    this.unlisteners.push(
      await listen("eventsub-automod-hold", (event) => {
        this._addAutomodHold(event.payload);
      })
    );
  }

  async teardownListeners() {
    for (const unlisten of this.unlisteners) {
      try {
        unlisten();
      } catch (_) {
        /* already gone, fine */
      }
    }
    this.unlisteners = [];
  }

  renderMessage(username, color, message, badgesTag, bits, customRewardId,
                replyParentUser, replyParentBody, msgId, userId, isAction = false,
                emotesTag = null, isFirstMsg = false) {
    const line = document.createElement("div");
    line.className = "chat-line";
    // Store data needed by hover action buttons.
    if (msgId) line.dataset.msgId = msgId;
    if (userId) line.dataset.msgUserId = userId;
    line.dataset.msgUsername = username;
    line.dataset.msgText = message;

    // User card stats - tracked for every message with a real sender id
    // (i.e. everything except the optimistic local echo / VOD replay,
    // same exclusion as the username-click handler below uses). Recent
    // history is capped so a chatty user across a long session doesn't
    // grow this without bound; only the card needs it and only shows the
    // last few anyway.
    if (userId) {
      this._messageCountByUserId.set(userId, (this._messageCountByUserId.get(userId) || 0) + 1);
      const history = this._messageHistoryByUserId.get(userId) || [];
      history.push({ time: Date.now(), text: message });
      if (history.length > USER_CARD_HISTORY_LIMIT) history.shift();
      this._messageHistoryByUserId.set(userId, history);
    }

    // Channel point message: left-border highlight + gem prefix.
    if (customRewardId) {
      line.classList.add("is-channel-point-message");
      const gem = document.createElement("span");
      gem.className = "channel-point-gem";
      gem.title = "Channel Point Redemption";
      line.appendChild(gem);
    }

    // First-time chatter: purple highlight matching twitch.tv's own
    // treatment for a user's very first message ever in this channel
    // (IRC "first-msg" tag - see ChatMessageEvent::is_first_msg in
    // chat.rs). Distinct from FFZ/7TV-style "returning chatter" tracking
    // or the newer mod-only Creator Chat Highlights feature - this is
    // specifically the classic, viewer-visible one-time welcome banner.
    if (isFirstMsg) {
      line.classList.add("is-first-msg");
      const label = document.createElement("div");
      label.className = "first-msg-label";
      label.textContent = "First time chatting";
      line.appendChild(label);
    }

    // Reply: show a quoted header above the message.
    if (replyParentUser && replyParentBody) {
      line.classList.add("is-reply");
      const replyHeader = document.createElement("div");
      replyHeader.className = "reply-header";
      replyHeader.textContent = `↩ ${replyParentUser}: ${replyParentBody}`;
      line.appendChild(replyHeader);
    }

    // Mention highlight: fires when any of these are true:
    //  - message body contains @ownLogin
    //  - this is a reply thread and the parent message was by ownLogin
    //    (i.e. someone replied directly to you)
    // The login compared against is platform-appropriate: ownLogin is
    // set by TWITCH login only, so Kick chat would never highlight -
    // @'s of the Kick username compared against nothing and fell
    // through. Kick sessions use the Kick login instead.
    const mentionLogin = this._isKickChat ? this._kickLogin : this.ownLogin;
    if (mentionLogin) {
      const login = mentionLogin.toLowerCase();
      // Escape regex metacharacters defensively - Twitch logins are
      // [a-z0-9_] but Kick usernames can carry characters like '-'.
      const escaped = login.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // Match with OR without the "@" - official Twitch highlights a
      // bare "Tincan127," just like "@Tincan127" (people frequently
      // reply by name alone, or via autocomplete strips). The two
      // branches need different left edges: "@" is a non-word char, so
      // "\b@" would look for a boundary between a space and the "@"
      // (two non-word chars - no boundary, no match); the bare name
      // needs "\b" precisely so "xTincan127" and "Tincan1278" don't
      // light up. Trailing \b guards both branches against prefixes of
      // longer names.
      const bodyMention = new RegExp(`(?:@|\\b)${escaped}\\b`, "i").test(message);
      const replyToMe = replyParentUser &&
        replyParentUser.toLowerCase() === login;
      if (bodyMention || replyToMe) {
        line.classList.add("is-mention");
      }
    }

    // Wrapped in a span (even though renderBadges already returns a
    // fragment of <img> tags) so this insertion point is addressable
    // later by _backfillOwnBadges() below - a bare fragment leaves no
    // trace in the DOM once inserted, but this wrapper does, letting a
    // badge set that finishes loading AFTER this line already rendered
    // (a real race - see loadGlobalBadges/loadChannelBadges) still get
    // patched in instead of being silently missing forever. Only ever
    // relevant for the CURRENT message's own badges since that's what
    // those two load functions can retroactively know about.
    const badgeSlot = document.createElement("span");
    badgeSlot.className = "chat-badges-slot";
    badgeSlot.dataset.badgesTag = badgesTag || "";
    const badgeFragment = this.renderBadges(badgesTag);
    if (badgeFragment) badgeSlot.appendChild(badgeFragment);
    line.appendChild(badgeSlot);

    const nameSpan = document.createElement("span");
    nameSpan.className = "chat-username";
    nameSpan.style.color = this.normalizeColor(color);
    nameSpan.textContent = username + ":";
    // Clicking the username opens the user card (avatar, account age,
    // timeout/ban, and delete-this-message). Timeout/ban are card-only,
    // matching Twitch's own chat; delete is ALSO kept on the hover row
    // below per explicit request, so it's reachable both ways. Card
    // needs the sender's user id, not just their display name - msgUserId
    // is absent only for the optimistic local echo of the viewer's own
    // just-sent message, which never gets one since Twitch's IRC never
    // echoes a client's own PRIVMSG back to it (see sendMessage's own
    // comment). VOD replay lines DO have a real userId (commenter.id from
    // the GQL response - see fetchPage), so their cards work the same as
    // live chat; timeout/ban simply stay disabled there since this.roomId
    // is never set during VOD replay, same as for a non-mod viewer.
    // msgId/message are passed through too so the card's Delete button
    // (added per this specific message, not the user in general) knows
    // which line it's acting on - the one whose username was actually
    // clicked.
    if (userId) {
      nameSpan.classList.add("chat-username-clickable");
      nameSpan.addEventListener("click", (e) => {
        e.stopPropagation();
        this._showUserCard(nameSpan, userId, username, badgesTag, msgId, message);
      });
    }
    line.appendChild(nameSpan);

    const textSpan = document.createElement("span");
    textSpan.className = "chat-message-text" + (isAction ? " chat-action-message" : "");
    if (isAction) textSpan.style.fontStyle = "italic";
    textSpan.appendChild(this.renderMessageBody(message, emotesTag));
    line.appendChild(document.createTextNode(" "));
    line.appendChild(textSpan);

    // Bits badge shown after the message text.
    if (bits && bits > 0) {
      const badge = document.createElement("span");
      badge.className = "bits-total-badge";
      badge.title = `${bits.toLocaleString()} bits cheered`;
      badge.textContent = `${bits.toLocaleString()} bits`;
      line.appendChild(badge);
    }

    // Hover action buttons (copy + reply). Built lazily on first mouseenter
    // to avoid creating DOM nodes for every message up front.
    line.addEventListener("mouseenter", () => {
      if (line.querySelector(".chat-line-actions")) return; // already built
      const actions = document.createElement("div");
      actions.className = "chat-line-actions";

      // Copy button
      const copyBtn = document.createElement("button");
      copyBtn.className = "chat-line-action-btn";
      copyBtn.title = "Copy message";
      copyBtn.innerHTML = `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
        <path d="M4 2h7a1 1 0 0 1 1 1v9h-1V3H4V2zm-1 2h7a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm0 10h7V5H3v9z"/>
      </svg>`;
      copyBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(line.dataset.msgText || "").catch(() => {});
      });

      // Reply button (only shown when logged in and msg has an ID)
      if (this.isLoggedIn && line.dataset.msgId) {
        const replyBtn = document.createElement("button");
        replyBtn.className = "chat-line-action-btn";
        replyBtn.title = "Reply";
        replyBtn.innerHTML = `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
          <path d="M6 3.5L1 7.5l5 4V9c3.5 0 6 1 7.5 4C13 9 11 5 6 5V3.5z"/>
        </svg>`;
        replyBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          this._setReplyTarget(line.dataset.msgId, line.dataset.msgUsername, line.dataset.msgText || "");
        });
        actions.appendChild(replyBtn);
      }

      actions.appendChild(copyBtn);

      // Delete - the one mod action kept on hover per explicit request
      // (timeout/ban moved fully to the user card, but delete stays
      // available here too, in addition to the card's own Delete button
      // for whichever message's username was last clicked). Always
      // rendered, disabled+grayed for non-mods/self-targeting rather than
      // hidden, same "don't invite a click that's just going to fail"
      // reasoning as before - enforcement is server-side regardless.
      {
        const targetUsername = line.dataset.msgUsername || "";
        const isSelf = this._isSelf(targetUsername);
        const canDelete = this.isMod && Boolean(line.dataset.msgId) && Boolean(this.roomId) && !isSelf;
        const deleteBtn = document.createElement("button");
        deleteBtn.className = "chat-line-action-btn mod-action-btn";
        deleteBtn.title = canDelete ? "Delete message" : "Delete message (mod only)";
        deleteBtn.disabled = !canDelete;
        deleteBtn.innerHTML = `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
          <path d="M5.5 1a1 1 0 0 0-1 1v1H2v1h12V3h-2.5V2a1 1 0 0 0-1-1h-3zM3 5l.7 8.4A1 1 0 0 0 4.7 14h6.6a1 1 0 0 0 1-.94L13 5H3zm3 2h1v5H6V7zm3 0h1v5H9V7z"/>
        </svg>`;
        deleteBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          if (!canDelete) return;
          this._deleteMessage(line.dataset.msgId, deleteBtn);
        });
        actions.appendChild(deleteBtn);
      }

      line.appendChild(actions);
    });

    // Right-click context menu - copy/reply only; mod actions (besides
    // the hover row's Delete) live in the user card, opened by clicking
    // the username.
    line.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this._showMessageContextMenu(e.clientX, e.clientY, line);
    });

    this.container.appendChild(line);
    this.trimAndScroll();
  }

  /** Renders a channel point redemption event from EventSub as a special chat line. */
  renderRedeemEvent({ redeemer, reward_title, reward_cost, user_input }) {
    const line = document.createElement("div");
    line.className = "chat-line channel-point-redeem-event";

    const icon = document.createElement("span");
    icon.className = "channel-point-gem";
    line.appendChild(icon);

    const redeemInfo = document.createElement("span");
    redeemInfo.className = "redeem-info";

    const nameEl = document.createElement("span");
    nameEl.className = "redeem-username";
    nameEl.textContent = redeemer;
    redeemInfo.appendChild(nameEl);

    redeemInfo.appendChild(document.createTextNode(" redeemed "));

    const titleEl = document.createElement("span");
    titleEl.className = "redeem-title";
    titleEl.textContent = reward_title;
    redeemInfo.appendChild(titleEl);

    const costEl = document.createElement("span");
    costEl.className = "redeem-cost";
    costEl.textContent = ` · ${reward_cost.toLocaleString()} pts`;
    redeemInfo.appendChild(costEl);

    if (user_input) {
      const inputEl = document.createElement("div");
      inputEl.className = "redeem-user-input";
      inputEl.textContent = user_input;
      redeemInfo.appendChild(inputEl);
    }

    line.appendChild(redeemInfo);
    this.container.appendChild(line);
    this.trimAndScroll();
  }

  /**
   * Renders a zero-width emote as an overlay on top of the preceding emote.
   *
   * Zero-width emotes (7TV/BTTV overlays like Fog0) are designed to stack
   * onto the emote before them, forming one combined glyph - that's how the
   * Twitch site and 7TV show them. Given the fragment built so far, this
   * finds the last emote image, wraps it in a positioned container (if it
   * isn't already one), and layers the zero-width emote absolutely centered
   * over it. Returns true if it overlaid successfully, false if there was no
   * preceding emote to stack on (caller then renders it as a normal image).
   */
  _overlayZeroWidthEmote(fragment, emoteUrl, word) {
    // The most recently appended node is usually a separator space; the
    // emote is the node before it. Walk back past trailing text nodes to
    // find the last element (an <img.chat-emote> or an existing overlay
    // container).
    let anchor = fragment.lastChild;
    while (anchor && anchor.nodeType === Node.TEXT_NODE) {
      const prev = anchor.previousSibling;
      // Drop the separating space we appended after the previous emote, so
      // the overlay sits flush on it rather than a space away.
      fragment.removeChild(anchor);
      anchor = prev;
    }
    if (!anchor || anchor.nodeType !== Node.ELEMENT_NODE) return false;

    let container;
    if (anchor.classList && anchor.classList.contains("chat-emote-overlay")) {
      // Already an overlay stack (a second/third zero-width emote on the
      // same base) - just add another layer.
      container = anchor;
    } else if (anchor.classList && anchor.classList.contains("chat-emote")) {
      // Wrap the base emote in an overlay container in-place.
      container = document.createElement("span");
      container.className = "chat-emote-overlay";
      fragment.replaceChild(container, anchor);
      anchor.classList.add("chat-emote-overlay-base");
      container.appendChild(anchor);
    } else {
      return false;
    }

    const layer = document.createElement("img");
    layer.className = "chat-emote chat-emote-overlay-layer";
    layer.src = emoteUrl;
    layer.alt = word;
    layer.title = word;
    layer.loading = "lazy";
    layer.onerror = () => {
      this._loggedEmoteUrlFailures ??= new Set();
      if (!this._loggedEmoteUrlFailures.has(emoteUrl)) {
        this._loggedEmoteUrlFailures.add(emoteUrl);
        console.warn(`[emotes] Image failed to load for "${word}": ${emoteUrl}`);
      }
    };
    container.appendChild(layer);
    return true;
  }

  /** Splits message text on whitespace and renders emotes and cheermotes inline.
   * Checks Twitch native emotes (by position from IRC tag) first, then
   * 7TV/BTTV emotes (by name), then cheermotes, then plain text. */
  renderMessageBody(message, emotesTag = null) {
    const fragment = document.createDocumentFragment();
    const twitchEmotes = this.parseTwitchEmotesTag(message, emotesTag);
    const words = message.split(" ");
    let charPos = 0;

    words.forEach((word, i) => {
      // Kick native emote — id-carrying marker from kick_chat.rs's
      // flatten_emote_tokens. Rendered straight from the id in the
      // token, not a name lookup, so it works even for a Kick
      // subscriber's cross-channel emote that this app never fetched a
      // set for (see parseKickEmoteMarker for why). Checked first since
      // the marker can't coincide with a Twitch emote position or any
      // real word.
      const kickEmote = this.parseKickEmoteMarker(word);
      if (kickEmote) {
        const emoteUrl = `https://files.kick.com/emotes/${kickEmote.id}/fullsize`;
        const img = document.createElement("img");
        img.className = "chat-emote";
        img.src = emoteUrl;
        img.alt = kickEmote.name;
        img.title = kickEmote.name;
        img.loading = "lazy";
        img.onerror = () => {
          this._loggedEmoteUrlFailures ??= new Set();
          if (!this._loggedEmoteUrlFailures.has(emoteUrl)) {
            this._loggedEmoteUrlFailures.add(emoteUrl);
            console.warn(`[emotes] Image failed to load for "${kickEmote.name}": ${emoteUrl}`);
          }
        };
        fragment.appendChild(img);
        if (i < words.length - 1) fragment.appendChild(document.createTextNode(" "));
        charPos += word.length + 1;
        return;
      }

      // Twitch native emote — matched by character position from IRC tag
      const twitch = twitchEmotes.get(charPos);
      if (twitch) {
        const img = document.createElement("img");
        img.className = "chat-emote";
        img.src = `https://static-cdn.jtvnw.net/emoticons/v2/${twitch.id}/default/dark/2.0`;
        img.alt = word;
        img.title = word;
        img.loading = "lazy";
        fragment.appendChild(img);
      } else {
        // 7TV / BTTV emote — matched by name; Twitch native — name fallback
        const emote        = this.sevenTvEmotes.get(word);
        const twitchByName = !emote ? (this.twitchNativeEmotes?.get(word) ?? null) : null;
        // One-time-per-emote diagnostic: log what the app knows about an
        // emote's zero-width status, so a "not overlaying" report can be
        // traced to detection (emote.zeroWidth false/undefined) vs rendering.
        if (emote) {
          this._loggedZeroWidthChecks ??= new Set();
          if (!this._loggedZeroWidthChecks.has(word)) {
            this._loggedZeroWidthChecks.add(word);
            console.log(`[emotes] "${word}" provider-emote zeroWidth=${emote.zeroWidth} provider=${emote.provider}`);
          }
        }
        const emoteUrl     = emote?.url
          ?? (twitchByName ? `https://static-cdn.jtvnw.net/emoticons/v2/${twitchByName.id}/default/dark/2.0` : null);
        if (emoteUrl) {
          // Zero-width emotes (7TV/BTTV overlay emotes like Fog0, cvHazmat)
          // are meant to render ON TOP OF the preceding emote, not beside
          // it. Twitch's site and 7TV stack them into a single glyph. Detect
          // the flag and, instead of appending a standalone image, wrap the
          // previous emote and this one in an overlay container so they
          // occupy the same space.
          if (emote?.zeroWidth) {
            const overlaid = this._overlayZeroWidthEmote(fragment, emoteUrl, word);
            if (overlaid) {
              // A zero-width emote consumes no horizontal space and needs no
              // trailing separator of its own - skip the usual space append
              // and advance charPos.
              charPos += word.length + 1;
              return;
            }
            // If there was no preceding emote to overlay onto (zero-width
            // emote at the start of a message), fall through and render it
            // as a normal standalone image rather than dropping it.
          }
          const img = document.createElement("img");
          img.className = "chat-emote";
          img.src = emoteUrl;
          img.alt = word;
          img.title = word;
          img.loading = "lazy";
          // A failed emote image silently collapses to its alt text -
          // visually identical to the emote never being loaded at all,
          // which made "emote shows as its name" impossible to diagnose
          // from the console. Log each failing URL once so a dead CDN
          // link is distinguishable from a missing provider/emote.
          img.onerror = () => {
            this._loggedEmoteUrlFailures ??= new Set();
            if (!this._loggedEmoteUrlFailures.has(emoteUrl)) {
              this._loggedEmoteUrlFailures.add(emoteUrl);
              console.warn(`[emotes] Image failed to load for "${word}": ${emoteUrl}`);
            }
          };
          fragment.appendChild(img);
        } else if (looksLikeUrl(word)) {
          fragment.appendChild(this._createChatLink(word));
        } else {
          const cheer = this.parseCheermote(word);
          if (cheer) {
            // Animated cheermote image (dark theme, 2x).
            const img = document.createElement("img");
            img.className = "chat-emote cheermote";
            img.src = cheer.tier.url;
            img.alt = word;
            img.title = word;
            img.loading = "lazy";
            fragment.appendChild(img);
            // Colored bit count immediately after the image.
            const amt = document.createElement("span");
            amt.className = "bits-amount";
            amt.style.color = cheer.tier.color;
            amt.textContent = cheer.amount.toLocaleString();
            fragment.appendChild(amt);
          } else if (word.length > 0) {
            fragment.appendChild(document.createTextNode(word));
          }
        }
      }
      if (i < words.length - 1) fragment.appendChild(document.createTextNode(" "));
      charPos += word.length + 1;
    });

    return fragment;
  }

  // ── Reply state ─────────────────────────────────────────────────────

  /**
   * Set the active reply target. Shows a reply indicator bar above the
   * input and stores the message ID so the next send goes as a reply.
   */
  _setReplyTarget(msgId, username, msgText = "") {
    this._replyToId = msgId;
    this._replyToUser = username;

    // Build or re-use the indicator block inserted above the input row.
    let bar = document.getElementById("chat-reply-indicator");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "chat-reply-indicator";
      bar.className = "chat-reply-indicator";
      const inputRow = this.inputEl?.closest(".chat-input-row");
      if (inputRow) inputRow.parentElement?.insertBefore(bar, inputRow);
    }
    bar.innerHTML = "";
    bar.style.display = "block";

    // ── Top row: "↩ Replying to @username"  +  ✕ button ──
    const header = document.createElement("div");
    header.className = "chat-reply-indicator-header";

    const arrow = document.createElement("span");
    arrow.className = "chat-reply-indicator-arrow";
    arrow.textContent = "↩";

    const headerLabel = document.createElement("span");
    headerLabel.className = "chat-reply-indicator-header-label";
    headerLabel.textContent = `Replying to @${username}`;

    const cancel = document.createElement("button");
    cancel.className = "chat-reply-indicator-cancel";
    cancel.title = "Cancel reply";
    cancel.textContent = "✕";
    cancel.addEventListener("click", () => this.clearReply());

    header.appendChild(arrow);
    header.appendChild(headerLabel);
    header.appendChild(cancel);
    bar.appendChild(header);

    // ── Second row: the quoted message body ──
    const body = document.createElement("div");
    body.className = "chat-reply-indicator-body";

    const userSpan = document.createElement("span");
    userSpan.className = "chat-reply-indicator-user";
    userSpan.textContent = `${username}: `;

    const textSpan = document.createElement("span");
    textSpan.className = "chat-reply-indicator-text";
    textSpan.textContent = msgText;

    body.appendChild(userSpan);
    body.appendChild(textSpan);
    bar.appendChild(body);

    // Prefill input with @mention so the user sees who they're replying to.
    if (this.inputEl) {
      this.inputEl.value = `@${username} `;
      this._autosizeChatInput();
      this.inputEl.focus();
      // Put cursor at end.
      const len = this.inputEl.value.length;
      this.inputEl.setSelectionRange(len, len);
    }
  }

  clearReply() {
    this._replyToId = null;
    this._replyToUser = null;
    const bar = document.getElementById("chat-reply-indicator");
    if (bar) bar.style.display = "none";
    // Clear any prefilled @mention if the user hasn't typed anything extra.
    if (this.inputEl && this._replyToUser) {
      const prefix = `@${this._replyToUser} `;
      if (this.inputEl.value === prefix) {
        this.inputEl.value = "";
        this._autosizeChatInput();
      }
    }
  }

  /** Re-derives this.isMod from the cached USERSTATE badges tag and
   * notifies any onModStatusChange() subscribers if it actually changed -
   * called on every USERSTATE (see setupListeners above). The raw tag
   * looks like "broadcaster/1,subscriber/12" - moderator OR broadcaster
   * present anywhere in it means mod tools should be available, matching
   * exactly what Twitch's own IRC server already requires before it'll
   * honor a /timeout, /ban, etc from this account. */
  _updateModStatus() {
    const tag = this._ownBadgesTag || "";
    const wasMod = this.isMod;
    this.isMod = tag.split(",").some((pair) => {
      const setId = pair.split("/")[0];
      return setId === "moderator" || setId === "broadcaster";
    });
    // Mod status just became known (or changed) - this is one of the two
    // triggers for _maybeFetchChatters() (the other being chat-room
    // below), since whichever of roomId/isMod arrives second is what
    // actually unblocks the fetch. The guard inside it means this is a
    // harmless no-op if chat-room already triggered it.
    this._maybeFetchChatters();
    if (this.isMod !== wasMod) {
      // The AutoMod toggle button's visibility depends on isMod - refresh
      // it even with an empty queue so the button actually appears the
      // moment USERSTATE confirms mod status, rather than waiting for the
      // first held message to do it indirectly via _addAutomodHold().
      this._renderAutomodPanel();
      for (const fn of this._modStatusListeners) {
        try { fn(this.isMod); } catch (err) { console.error("mod status listener error:", err); }
      }
    }
  }

  /** Subscribes to isMod changes. Returns an unsubscribe function, same
   * convention as the Tauri listen() calls elsewhere in this file. */
  onModStatusChange(fn) {
    this._modStatusListeners.push(fn);
    return () => {
      this._modStatusListeners = this._modStatusListeners.filter((f) => f !== fn);
    };
  }

}

// Mixed in here rather than defined inline above purely to keep this file a
// manageable size - see the comment atop each file in src/chat/ for what it
// covers. All of these run with the exact same `this` as everything above;
// there is no behavioral difference from having one giant class body.
Object.assign(TwitchChat.prototype, chatEmotesMixin, chatEmotePickerMixin, chatVodReplayMixin, chatBadgesMixin, chatAutomodMixin, chatUserCardMixin, chatModActionsMixin, chatLinkPreviewMixin, chatAutocompleteMixin);
