// chat-autocomplete.js — part of TwitchChat (see ../chat.js). @mention autocomplete: chatter list fetching and the username popup.
//
// This is a mixin, not a standalone class: chat.js does
// `Object.assign(TwitchChat.prototype, chatAutocompleteMixin)` after the class
// body, so every method here runs with the same `this` (container, ws,
// caches, etc.) as methods still defined directly in chat.js. Methods are
// grouped into files by feature area purely for readability — there is no
// behavioral difference from having them all in one file.

import { invoke } from "@tauri-apps/api/core";
export const chatAutocompleteMixin = {
  /** Returns the @word under the cursor (including the @ prefix), or "". */
  _currentAtWord() {
    const input = this.inputEl;
    if (!input) return { word: "", wordStart: 0, wordEnd: 0 };
    const pos = input.selectionStart ?? input.value.length;
    const val = input.value;
    let start = pos;
    while (start > 0 && val[start - 1] !== " ") start--;
    let end = pos;
    while (end < val.length && val[end] !== " ") end++;
    const word = val.slice(start, end);
    if (!word.startsWith("@")) return { word: "", wordStart: 0, wordEnd: 0 };
    return { word, wordStart: start, wordEnd: end };
  },

  /**
   * Fetches the full chatter roster (get_chatters, backed by Helix's
   * /helix/chat/chatters) and merges it into _chatUsers, so @mention
   * autocomplete can suggest silent viewers too - not just people who've
   * actually typed, which is all _chatUsers ever captured before this.
   *
   * Only attempted when the logged-in user is a mod or the broadcaster
   * of the channel being watched, since that's the only case Twitch
   * actually permits this endpoint for - calling it as a plain viewer
   * would just 403. Called from both the chat-room handler (room-id just
   * became known) and the mod-status-change listener (mod status just
   * became known), since either one can arrive first; the
   * _chattersFetchedForChannel guard means whichever fires second is a
   * no-op rather than a duplicate fetch.
   *
   * Errors (403 for a non-mod, or any network hiccup) are swallowed -
   * this is purely an enhancement on top of the existing speak-to-be-
   * tracked behavior, never something the rest of chat depends on, so a
   * failure here should just leave that fallback in place rather than
   * surfacing a system-line error for something the user didn't ask for.
   */
  async _maybeFetchChatters() {
    if (!this.roomId || !this.channel) return;
    const isBroadcaster = this.ownLogin && this.ownLogin.toLowerCase() === this.channel;
    if (!this.isMod && !isBroadcaster) return;
    if (this._chattersFetchedForChannel === this.channel) return;
    this._chattersFetchedForChannel = this.channel;

    try {
      const raw = await invoke("get_chatters", { broadcasterId: this.roomId });
      const chatters = JSON.parse(raw);
      for (const c of chatters) {
        const login = c.user_login;
        if (!login) continue;
        // Don't clobber a display-name casing we may have already
        // captured from an actual PRIVMSG - that's the more "live"
        // value of the two sources when both exist for the same user.
        if (!this._chatUsers.has(login.toLowerCase())) {
          this._chatUsers.set(login.toLowerCase(), c.user_name || login);
        }
      }
    } catch (err) {
      // Expected for any channel the logged-in user isn't a mod/
      // broadcaster of (403) - not worth logging as an error each time.
      this._chattersFetchedForChannel = null;
    }
  },

  /** Refreshes the user suggestion popup from the typed @prefix. */
  _updateUserPopup() {
    const { word } = this._currentAtWord();
    if (!word || word.length < 2) { this._hideEmotePopup(); return; }
    const prefix = word.slice(1).toLowerCase(); // strip leading @
    const matches = [];
    for (const [login, displayName] of this._chatUsers) {
      if (login.startsWith(prefix)) matches.push(displayName);
      if (matches.length >= 10) break;
    }
    if (matches.length === 0) { this._hideEmotePopup(); return; }
    this._showUserPopup(matches);
  },

  _showUserPopup(names) {
    this._popupMode = "user";
    const popup = this._emotePopup;
    popup.innerHTML = "";
    this._emotePopupIndex = -1;

    for (const name of names) {
      const item = document.createElement("div");
      item.className = "emote-autocomplete-item";
      item.dataset.name = name;

      const icon = document.createElement("span");
      icon.className = "user-mention-icon";
      icon.textContent = "@";
      item.appendChild(icon);

      const label = document.createElement("span");
      label.textContent = name;
      item.appendChild(label);

      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this._commitUserByName(name);
      });
      popup.appendChild(item);
    }
    popup.style.display = "block";
    this._repositionPopup();
    this._setEmoteSelection(0);
  },

  _commitUserByName(name) {
    const input = this.inputEl;
    if (!input) return;
    const { wordStart, wordEnd } = this._currentAtWord();
    const val = input.value;
    const replacement = `@${name} `;
    input.value = val.slice(0, wordStart) + replacement + val.slice(wordEnd);
    this._autosizeChatInput();
    const pos = wordStart + replacement.length;
    input.setSelectionRange(pos, pos);
    this._hideEmotePopup();
    this._popupMode = "emote";
    input.focus();
    input.closest?.(".chat-input-wrapper")
      ?.classList.toggle("has-text", input.value.length > 0);
  },

};
