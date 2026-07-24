// chat-mod-actions.js — part of TwitchChat (see ../chat.js). Moderation actions and their /slash-command equivalents (ban, timeout, clear, delete).
//
// Three actions: delete (one message), timeout (a user, for a chosen
// duration), ban (permanent). Timeout/ban are triggered from the user
// card only (click a username), matching Twitch's own chat. Delete is
// available from BOTH the hover row's icon and the card's own Delete
// button, per explicit request to keep it reachable on hover even after
// moving everything else to the card. All three need this.roomId (the
// broadcaster's user id, set once ROOMSTATE arrives - see chat.js's
// connect()) and the target's user id.
//
// Disabled (not hidden) for non-mods and for self-targeting, since
// Twitch's own /timeout and /ban commands refuse to let a mod time out
// or ban themselves - the Helix endpoints behind these buttons would
// just 400 either way, so the button reflects that instead of inviting
// a click that's guaranteed to fail.
//
// This is a mixin, not a standalone class: chat.js does
// `Object.assign(TwitchChat.prototype, chatModActionsMixin)` after the class
// body, so every method here runs with the same `this` (container, ws,
// caches, etc.) as methods still defined directly in chat.js. Methods are
// grouped into files by feature area purely for readability — there is no
// behavioral difference from having them all in one file.

import { invoke } from "@tauri-apps/api/core";
export const chatModActionsMixin = {
  /** Returns true if `text` was a recognized command (and was handled -
   * success or failure both count as "handled" here, since either way
   * the input shouldn't ALSO be sent as a literal chat message). Returns
   * false for unrecognized /whatever input, which the caller then sends
   * as a normal message instead. */
  async _tryHandleSlashCommand(text) {
    const parts = text.slice(1).split(/\s+/).filter(Boolean);
    const cmd = (parts.shift() || "").toLowerCase();

    switch (cmd) {
      case "ban":
        return this._slashBan(parts);
      case "unban":
        return this._slashUnban(parts);
      case "timeout":
        return this._slashTimeout(parts);
      case "untimeout":
        // Twitch's own /untimeout is exactly "lift this user's active
        // timeout early" - the same call as /unban (DELETE .../bans),
        // since Helix has no separate concept of timeout-vs-ban once one
        // is already in effect; both are just "remove this restriction."
        return this._slashUnban(parts);
      case "clear":
        return this._slashClear();
      default:
        return false; // not a command we recognize
    }
  },

  /** Shared "this command needs to be a mod and needs a roomId" guard,
   * with one consistent system-line message for every command that
   * fails it, rather than each command re-checking and re-messaging. */
  _requireModForSlashCommand(commandLabel) {
    if (!this.roomId) {
      this.systemLine(`Can't run ${commandLabel}: not connected to a channel.`);
      return false;
    }
    if (!this.isMod) {
      this.systemLine(`Can't run ${commandLabel}: you must be a moderator.`);
      return false;
    }
    return true;
  },

  /** Resolves a typed username to a user id via Helix, with one
   * consistent error message on failure (unknown username, network
   * error, etc) so each command doesn't need its own wording for that. */
  async _resolveSlashTarget(login, commandLabel) {
    try {
      return await invoke("get_user_id_for_login", { login });
    } catch (err) {
      console.error(`${commandLabel}: failed to resolve user`, login, err);
      this.systemLine(`Can't find a user named "${login}".`);
      return null;
    }
  },

  async _slashBan(args) {
    if (!this._requireModForSlashCommand("/ban")) return true;
    const [login, ...reasonParts] = args;
    if (!login) {
      this.systemLine("Usage: /ban <username> [reason]");
      return true;
    }
    if (this._isSelf(login)) {
      this.systemLine("You can't ban yourself.");
      return true;
    }
    const userId = await this._resolveSlashTarget(login, "/ban");
    if (!userId) return true;
    const reason = reasonParts.join(" ") || undefined;
    try {
      await invoke("ban_user", { broadcasterId: this.roomId, targetUserId: userId, reason });
      this.systemLine(`${login} has been banned.`);
    } catch (err) {
      console.error("Failed to ban user:", err);
      this.systemLine(`Failed to ban ${login}: ${err}`);
    }
    return true;
  },

  async _slashUnban(args) {
    if (!this._requireModForSlashCommand("/unban")) return true;
    const [login] = args;
    if (!login) {
      this.systemLine("Usage: /unban <username>");
      return true;
    }
    const userId = await this._resolveSlashTarget(login, "/unban");
    if (!userId) return true;
    try {
      await invoke("unban_user", { broadcasterId: this.roomId, targetUserId: userId });
      this.systemLine(`${login} has been unbanned.`);
    } catch (err) {
      // Helix 400s this with "The user in the user_id query parameter is
      // not banned" when there's nothing active to lift - a real, common
      // outcome (e.g. /untimeout on someone whose timeout already
      // expired, or /unban on someone who was never banned), not an
      // actual failure of the request itself. Shown as a plain
      // informational line instead of "Failed to unban" + a raw error
      // dump, since nothing went wrong - there was just nothing to undo.
      if (this._isNotBannedError(err)) {
        this.systemLine(`${login} is not currently banned or timed out.`);
      } else {
        console.error("Failed to unban user:", err);
        this.systemLine(`Failed to unban ${login}: ${err}`);
      }
    }
    return true;
  },

  /** True if `err` (the string Helix-call errors arrive as, per
   * ban_user/unban_user/etc in main.rs's `Result<_, String>` -> Tauri's
   * rejection) is specifically Helix's "this user isn't banned" 400 -
   * shared by /unban and /untimeout (an alias for the same call), both
   * of which can legitimately hit this on a target with no active
   * ban/timeout. Matched on the distinctive message text rather than
   * just the 400 status code, since a 400 could be something else
   * entirely (e.g. a malformed id) that genuinely should show as a
   * failure, not get silently reclassified as "nothing to do here." */
  _isNotBannedError(err) {
    return /not banned/i.test(String(err));
  },

  async _slashTimeout(args) {
    if (!this._requireModForSlashCommand("/timeout")) return true;
    if (args.length === 0) {
      this.systemLine("Usage: /timeout <username> [duration] (e.g. /timeout someuser 10m)");
      return true;
    }
    // Flexible order: whichever token parses as a duration is the
    // duration; whatever's left is the username. Twitch's own /timeout
    // defaults to 10 minutes if no duration is given at all.
    let login = null;
    let durationSeconds = 600;
    let sawDuration = false;
    for (const token of args) {
      const parsed = this._parseDuration(token);
      if (parsed !== null && !sawDuration) {
        durationSeconds = parsed;
        sawDuration = true;
      } else if (!login) {
        login = token;
      }
    }
    if (!login) {
      this.systemLine("Usage: /timeout <username> [duration]");
      return true;
    }
    if (this._isSelf(login)) {
      this.systemLine("You can't time out yourself.");
      return true;
    }
    const userId = await this._resolveSlashTarget(login, "/timeout");
    if (!userId) return true;
    try {
      await invoke("ban_user", { broadcasterId: this.roomId, targetUserId: userId, durationSeconds });
      this.systemLine(`${login} has been timed out for ${this._formatDuration(durationSeconds)}.`);
    } catch (err) {
      console.error("Failed to timeout user:", err);
      this.systemLine(`Failed to timeout ${login}: ${err}`);
    }
    return true;
  },

  async _slashClear() {
    if (!this._requireModForSlashCommand("/clear")) return true;
    try {
      // messageId omitted (null, not a string) - per Helix's docs this
      // clears the ENTIRE chat room rather than one message. See the
      // comment on delete_chat_message in main.rs for the full reasoning
      // on why this shares that command instead of being separate.
      await invoke("delete_chat_message", { broadcasterId: this.roomId, messageId: null });
      this.systemLine("Chat has been cleared.");
    } catch (err) {
      console.error("Failed to clear chat:", err);
      this.systemLine(`Failed to clear chat: ${err}`);
    }
    return true;
  },

  /** Parses a duration token like "15", "15s", "10m", "2h", "1d" into
   * seconds, or returns null if it doesn't look like one at all (so the
   * caller can tell "this token is a duration" apart from "this token is
   * a username that happens to be all digits" - Twitch usernames can't
   * actually start with a digit-only string that's ALSO ambiguous here,
   * but treating a bare number as seconds, matching Twitch's own
   * /timeout, which accepts a bare number of seconds with no suffix at
   * all - e.g. the "/timeout 15 UserName" form from the original request
   * is exactly bare-number-as-seconds). */
  _parseDuration(token) {
    const m = /^(\d+)(s|m|h|d|w)?$/i.exec(token);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    if (!Number.isFinite(n) || n <= 0) return null;
    const unit = (m[2] || "s").toLowerCase();
    const multiplier = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[unit];
    return n * multiplier;
  },

  /** Deletes a single message. `btn` is disabled + given a "..." label
   * while the request is in flight so a slow connection doesn't invite a
   * second click on the same message. */
  async _deleteMessage(msgId, btn) {
    if (!msgId || !this.roomId) return;
    const original = btn.innerHTML;
    btn.disabled = true;
    try {
      await invoke("delete_chat_message", { broadcasterId: this.roomId, messageId: msgId });
      // No optimistic DOM update here - Twitch's own CLEARMSG notice for
      // this exact deletion will arrive over IRC momentarily and is
      // handled centrally in _handleClearMsg(), same path a deletion FROM
      // any other client/mod takes. Doing it twice (once here, once on
      // CLEARMSG) would just be redundant, and centralizing means there's
      // only one place that ever needs to know what "deleted" looks like.
    } catch (err) {
      console.error("Failed to delete message:", err);
      this.systemLine(`Failed to delete message: ${err}`);
    } finally {
      btn.disabled = false;
      btn.innerHTML = original;
    }
  },

  async _timeoutUser(targetUserId, targetUsername, durationSeconds) {
    if (!targetUserId || !this.roomId) return;
    try {
      await invoke("ban_user", {
        broadcasterId: this.roomId,
        targetUserId,
        durationSeconds,
      });
      this.systemLine(`${targetUsername} has been timed out for ${this._formatDuration(durationSeconds)}.`);
    } catch (err) {
      console.error("Failed to timeout user:", err);
      this.systemLine(`Failed to timeout ${targetUsername}: ${err}`);
    }
  },

  /** Bans are permanent and easy to fire by a stray click, unlike timeout
   * (which has a whole picker step already acting as a confirmation) or
   * delete (trivially reversible - the message just stops showing, no
   * lasting account effect) - so this is the one mod action with an
   * actual confirm step in front of it. */
  _confirmAndBan(targetUserId, targetUsername) {
    if (!window.confirm(`Permanently ban ${targetUsername}? This can be undone later via unban.`)) {
      return;
    }
    this._banUser(targetUserId, targetUsername);
  },

  async _banUser(targetUserId, targetUsername) {
    if (!targetUserId || !this.roomId) return;
    try {
      await invoke("ban_user", { broadcasterId: this.roomId, targetUserId });
      this.systemLine(`${targetUsername} has been banned.`);
    } catch (err) {
      console.error("Failed to ban user:", err);
      this.systemLine(`Failed to ban ${targetUsername}: ${err}`);
    }
  },

  /** Right-click context menu - copy + reply only. Mod actions live in
   * the user card (click the username) now, matching Twitch's own chat,
   * where right-click never carries mod tools either - only the card
   * does. Still built fresh on every right-click since reply's
   * availability depends on isLoggedIn/msgId, which can change. */
  _showMessageContextMenu(x, y, line) {
    this._closeMessageContextMenu();

    const menu = document.createElement("div");
    menu.className = "chat-context-menu";

    const addItem = (label, onClick, opts = {}) => {
      const item = document.createElement("button");
      item.className = "chat-context-menu-item" + (opts.danger ? " chat-context-menu-item-danger" : "");
      item.textContent = label;
      item.disabled = Boolean(opts.disabled);
      if (!opts.disabled) {
        item.addEventListener("click", (e) => {
          e.stopPropagation();
          this._closeMessageContextMenu();
          onClick();
        });
      }
      menu.appendChild(item);
      return item;
    };

    addItem("Copy message", () => {
      navigator.clipboard.writeText(line.dataset.msgText || "").catch(() => {});
    });

    if (this.isLoggedIn && line.dataset.msgId) {
      addItem("Reply", () => {
        this._setReplyTarget(line.dataset.msgId, line.dataset.msgUsername, line.dataset.msgText || "");
      });
    }

    document.body.appendChild(menu);
    menu.style.position = "fixed";
    const menuWidth = menu.offsetWidth;
    const menuHeight = menu.offsetHeight;
    menu.style.left = `${Math.min(x, window.innerWidth - menuWidth - 8)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - menuHeight - 8)}px`;

    this._contextMenuEl = menu;
    this._contextMenuOutsideHandler = (e) => {
      if (!menu.contains(e.target)) this._closeMessageContextMenu();
    };
    setTimeout(() => {
      document.addEventListener("click", this._contextMenuOutsideHandler, true);
      document.addEventListener("contextmenu", this._contextMenuOutsideHandler, true);
    }, 0);
  },

  _closeMessageContextMenu() {
    if (this._contextMenuEl) {
      this._contextMenuEl.remove();
      this._contextMenuEl = null;
    }
    if (this._contextMenuOutsideHandler) {
      document.removeEventListener("click", this._contextMenuOutsideHandler, true);
      document.removeEventListener("contextmenu", this._contextMenuOutsideHandler, true);
      this._contextMenuOutsideHandler = null;
    }
  },

};
