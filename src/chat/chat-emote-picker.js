// chat-emote-picker.js — part of TwitchChat (see ../chat.js). The emote
// picker: a button in the composer (#chat-emote-btn) that opens a
// browsable, searchable grid of every emote available in the current
// chat - Twitch global, plus 7TV/BTTV/FFZ global and channel - grouped
// into sections with a provider tab bar, mirroring the emote menu the
// official Twitch site and the 7TV browser extension both put next to
// their own chat input.
//
// Deliberately reads this.sevenTvEmotes / this.twitchNativeEmotes fresh
// on every render rather than caching a snapshot: those maps are written
// to live (channel switches in connect()/connectKick(), 7TV EventAPI
// set updates in _applySevenTvEmoteSetUpdate), and the picker is only
// ever open for the few seconds it takes to pick an emote, so there's no
// real cost to recomputing the grouped view each time it's shown.
//
// Mixin, not a standalone class - see chat-emotes.js's own header
// comment for why (same `this`, just split out for readability).

/** Tab bars shown along the bottom of the picker, above the search box -
 * "All" plus one per source, PER PLATFORM: the last tab is the platform's
 * own native global set, so Twitch chat gets a "Twitch" tab and Kick
 * chat gets a "Kick" tab - a Kick chat has no business offering Twitch's
 * native globals (they don't exist on Kick; picking one would just send
 * plain text everyone else sees unrendered), and vice versa. Order
 * mirrors how a viewer would reach for these: their own channel's
 * emotes first, then the three third-party providers, then the
 * platform's own global set last (least likely to be what someone
 * opened the picker looking for, since typing e.g. "Kappa" doesn't need
 * a picker at all). */
const EMOTE_PICKER_TABS_TWITCH = [
  { id: "all", label: "All" },
  { id: "channel", label: "Channel" },
  { id: "seventv", label: "7TV" },
  { id: "bttv", label: "BTTV" },
  { id: "ffz", label: "FFZ" },
  { id: "twitch", label: "Twitch" },
];
const EMOTE_PICKER_TABS_KICK = [
  { id: "all", label: "All" },
  { id: "channel", label: "Channel" },
  { id: "seventv", label: "7TV" },
  { id: "bttv", label: "BTTV" },
  { id: "ffz", label: "FFZ" },
  { id: "kick", label: "Kick" },
];

/** Section labels used above each provider's grid when the "All" tab is
 * showing everything at once - kept distinct from the tab button labels
 * since a section header reads better with a bit more context ("7TV
 * Global" vs. just "7TV") than a compact tab does. */
const EMOTE_PICKER_SECTIONS = {
  channel: "Channel Emotes",
  seventv: "7TV Global",
  bttv: "BTTV Global",
  ffz: "FFZ Global",
  twitch: "Twitch Global",
  kick: "Kick Global",
};

function bucketForProvider(provider) {
  if (provider === "seventv-channel" || provider === "bttv-channel" ||
      provider === "ffz-channel" || provider === "kick-channel") return "channel";
  if (provider === "seventv-global") return "seventv";
  if (provider === "bttv-global") return "bttv";
  if (provider === "ffz-global") return "ffz";
  // Kick's site-wide Global + Emoji sets get their own shelf, exactly
  // like Twitch's native globals do - previously these were folded into
  // "channel", which both bloated that bucket by hundreds of entries
  // and left the Kick tab position occupied by a Twitch tab instead.
  if (provider === "kick-global") return "kick";
  return null;
}

export const chatEmotePickerMixin = {
  /** Wires up the button + flyout. Called once from the constructor,
   * same as the emote-autocomplete popup's own setup - see chat.js. */
  _initEmotePicker() {
    this.emoteBtn = this._emoteBtnEl;
    this._emotePickerMenu = this._emotePickerMenuEl;
    this._emotePickerTab = "all";
    this._emotePickerSearch = "";
    if (!this.emoteBtn || !this._emotePickerMenu) return; // absent in tests/older markup - every call site below already guards on this.emoteBtn

    this.emoteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this._toggleEmotePicker();
    });

    // Outside click closes it - same pattern as quality-menu/user-menu.
    // Checked on mousedown (not click) so it fires before a click inside
    // the composer's own textarea would otherwise re-focus and re-open
    // nothing, matching every other flyout in this app.
    document.addEventListener("mousedown", (e) => {
      if (!this._emotePickerMenu.classList.contains("open")) return;
      if (this._emotePickerMenu.contains(e.target)) return;
      if (this.emoteBtn.contains(e.target)) return;
      this._closeEmotePicker();
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this._emotePickerMenu.classList.contains("open")) {
        this._closeEmotePicker();
      }
    });

    // Keep it pinned above the composer if the window is resized while
    // it's open - same reasoning as the emote-autocomplete popup and
    // quality-menu, which reposition on every render instead of assuming
    // a static layout.
    window.addEventListener("resize", () => this._repositionEmotePicker());
  },

  _toggleEmotePicker() {
    if (this._emotePickerMenu.classList.contains("open")) this._closeEmotePicker();
    else this._openEmotePicker();
  },

  _openEmotePicker() {
    if (!this.emoteBtn || this.emoteBtn.disabled) return;
    // Only one flyout above the composer at a time - an in-progress
    // Tab-triggered autocomplete suggestion left open behind this would
    // otherwise sit exactly on top of it.
    this._hideEmotePopup();
    this._emotePickerMenu.classList.add("open");
    this.emoteBtn.classList.add("open");
    this._renderEmotePicker();
    this._repositionEmotePicker();
  },

  _closeEmotePicker() {
    this._emotePickerMenu?.classList.remove("open");
    this.emoteBtn?.classList.remove("open");
  },

  _repositionEmotePicker() {
    const menu = this._emotePickerMenu;
    if (!menu || !this.inputEl || !menu.classList.contains("open")) return;
    // Anchor to the whole input row (not just the textarea) so the panel
    // lines up with the Send button's right edge, same width as the
    // composer as a whole rather than just the textarea's own box.
    const rect = (this.inputEl.closest(".chat-input-row, .multiview-chat-input-row") || this.inputEl).getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) { this._closeEmotePicker(); return; }
    const menuHeight = menu.offsetHeight || 360;
    menu.style.left = rect.left + "px";
    menu.style.width = rect.width + "px";
    // Prefer above the composer, matching every other chat flyout in
    // this app; if the window's too short for that, pin near the top
    // instead of drifting off-screen.
    const top = rect.top - menuHeight - 6;
    menu.style.top = (top >= 6 ? top : 6) + "px";
  },

  /** Groups every known emote by picker bucket, applying the current
   * search filter. Returns {channel, seventv, bttv, ffz, twitch}, each an
   * array of {name, url} sorted alphabetically. */
  _collectEmotePickerBuckets() {
    const term = this._emotePickerSearch.trim().toLowerCase();
    const buckets = { channel: [], seventv: [], bttv: [], ffz: [], twitch: [], kick: [] };
    for (const [name, entry] of this.sevenTvEmotes) {
      if (term && !name.toLowerCase().includes(term)) continue;
      const bucket = bucketForProvider(entry.provider);
      if (bucket) buckets[bucket].push({ name, url: entry.url });
    }
    // Twitch's native globals only belong in a TWITCH chat's picker -
    // the map itself persists across a platform swap (it's loaded once
    // at startup), so gate on the session, not on the map's contents.
    if (!this._isKickChat) {
      for (const [name, entry] of this.twitchNativeEmotes) {
        if (term && !name.toLowerCase().includes(term)) continue;
        buckets.twitch.push({ name, url: entry.url });
      }
    }
    for (const key of Object.keys(buckets)) {
      buckets[key].sort((a, b) => a.name.localeCompare(b.name));
    }
    return buckets;
  },

  /** Full (re)render: search box, tabs, and the grid itself. Called on
   * open and on every tab switch - cheap enough (a few hundred DOM nodes
   * at most) that a targeted diff isn't worth the complexity. */
  _renderEmotePicker() {
    const menu = this._emotePickerMenu;
    menu.innerHTML = "";

    const gridWrap = document.createElement("div");
    gridWrap.className = "emote-picker-grid-wrap";

    const tabs = document.createElement("div");
    tabs.className = "emote-picker-tabs";
    const tabList = this._isKickChat ? EMOTE_PICKER_TABS_KICK : EMOTE_PICKER_TABS_TWITCH;
    // The remembered tab can belong to the OTHER platform's bar (picker
    // used on Twitch, platform flipped, picker reopened on Kick - the
    // stored "twitch" id has no button now). Snap back to All.
    if (!tabList.some((t) => t.id === this._emotePickerTab)) {
      this._emotePickerTab = "all";
    }
    for (const tab of tabList) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "emote-picker-tab" + (this._emotePickerTab === tab.id ? " active" : "");
      btn.textContent = tab.label;
      btn.title = tab.id === "all" ? "All emotes" : EMOTE_PICKER_SECTIONS[tab.id];
      btn.addEventListener("click", () => {
        this._emotePickerTab = tab.id;
        tabs.querySelectorAll(".emote-picker-tab").forEach(el => el.classList.remove("active"));
        btn.classList.add("active");
        this._renderEmoteGrid(gridWrap);
      });
      tabs.appendChild(btn);
    }

    const searchWrap = document.createElement("div");
    searchWrap.className = "emote-picker-search-wrap";
    const search = document.createElement("input");
    search.type = "text";
    search.className = "emote-picker-search-input";
    search.placeholder = "Search emotes…";
    search.value = this._emotePickerSearch;
    search.autocomplete = "off";
    search.spellcheck = false;
    search.addEventListener("input", () => {
      this._emotePickerSearch = search.value;
      this._renderEmoteGrid(gridWrap);
    });
    // This is a sibling input, not the composer - Enter shouldn't send
    // the (unrelated) chat message, and every other key should stay
    // local to typing a search term rather than falling through to the
    // composer's own history/autocomplete keydown handling.
    search.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { this._closeEmotePicker(); return; }
      e.stopPropagation();
    });
    searchWrap.appendChild(search);

    menu.appendChild(gridWrap);
    menu.appendChild(tabs);
    menu.appendChild(searchWrap);

    this._renderEmoteGrid(gridWrap);
    search.focus();
  },

  /** Renders just the grid portion for the currently-selected tab +
   * search term, without touching the tabs/search box - called on every
   * keystroke in the search box and every tab switch so those stay
   * responsive without a full teardown/rebuild of the whole panel. */
  _renderEmoteGrid(gridWrap) {
    gridWrap.innerHTML = "";
    const buckets = this._collectEmotePickerBuckets();
    const order = this._emotePickerTab === "all"
      ? (this._isKickChat
          ? ["channel", "seventv", "bttv", "ffz", "kick"]
          : ["channel", "seventv", "bttv", "ffz", "twitch"])
      : [this._emotePickerTab];
    const sections = order
      .map(id => [id, buckets[id]])
      .filter(([, rows]) => rows.length > 0);

    if (sections.length === 0) {
      const empty = document.createElement("div");
      empty.className = "emote-picker-empty";
      empty.textContent = this._emotePickerSearch.trim()
        ? "No emotes match your search."
        : "No emotes loaded for this channel yet.";
      gridWrap.appendChild(empty);
      return;
    }

    for (const [id, rows] of sections) {
      const section = document.createElement("div");
      section.className = "emote-picker-section";

      const title = document.createElement("div");
      title.className = "emote-picker-section-title";
      title.textContent = `${EMOTE_PICKER_SECTIONS[id]} · ${rows.length}`;
      section.appendChild(title);

      const grid = document.createElement("div");
      grid.className = "emote-picker-grid";
      for (const { name, url } of rows) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "emote-picker-item";
        item.title = name;
        const img = document.createElement("img");
        img.src = url;
        img.alt = name;
        img.loading = "lazy";
        item.appendChild(img);
        item.addEventListener("click", () => this._insertEmoteAtCursor(name));
        grid.appendChild(item);
      }
      section.appendChild(grid);
      gridWrap.appendChild(section);
    }
  },

  /** Inserts `name` at the current cursor position in the composer,
   * padding with spaces only where the surrounding text actually needs
   * one - distinct from _commitEmoteByName (chat-emotes.js), which
   * REPLACES the partial word being autocompleted rather than inserting
   * at an arbitrary cursor position with arbitrary text on either side. */
  _insertEmoteAtCursor(name) {
    const input = this.inputEl;
    if (!input) return;
    const val = input.value;
    const pos = input.selectionStart ?? val.length;
    const needsLeadingSpace = pos > 0 && val[pos - 1] !== " ";
    const needsTrailingSpace = pos >= val.length || val[pos] !== " ";
    const insertText = (needsLeadingSpace ? " " : "") + name + (needsTrailingSpace ? " " : "");
    input.value = val.slice(0, pos) + insertText + val.slice(pos);
    const newPos = pos + insertText.length;
    input.setSelectionRange(newPos, newPos);
    // Fires the existing "input" listener (setLoggedIn, chat.js) that
    // toggles .has-text on the wrapper and drives the Send button's
    // visibility - a plain value assignment above doesn't dispatch that
    // event on its own.
    input.dispatchEvent(new Event("input", { bubbles: true }));
    this._autosizeChatInput();
    input.focus();
  },
};
