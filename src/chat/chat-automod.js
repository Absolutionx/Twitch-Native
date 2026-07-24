// chat-automod.js — part of TwitchChat (see ../chat.js). AutoMod hold queue: rendering held messages, the review panel, and mod clear/delete actions.
//
// Messages AutoMod holds for review arrive via the eventsub-automod-hold
// event (see eventsub.rs) rather than over IRC - they were never sent to
// chat in the first place, so there's no chat-line to attach actions to
// the way delete/timeout/ban work. Instead they live in their own queue,
// rendered into #automod-panel, until a mod Allows (lets it post) or
// Denies (blocks it) each one.
//
// This is a mixin, not a standalone class: chat.js does
// `Object.assign(TwitchChat.prototype, chatAutomodMixin)` after the class
// body, so every method here runs with the same `this` (container, ws,
// caches, etc.) as methods still defined directly in chat.js. Methods are
// grouped into files by feature area purely for readability — there is no
// behavioral difference from having them all in one file.

import { invoke } from "@tauri-apps/api/core";
export const chatAutomodMixin = {
  /** CLEARCHAT handler - either one user's messages were cleared (a
   * timeout or ban, by anyone: this client, another mod's client, or the
   * website) or the entire chat was cleared. Mirrors what twitch.tv's own
   * chat does conceptually (affected messages are visually marked as
   * removed) but keeps the original message visible, just dimmed with a
   * strikethrough - see _collapseLine() - rather than replacing it with a
   * placeholder sentence, so there's still a record of what was actually
   * said, not just that something was. */
  _handleClearChat({ target_user_id, target_username, ban_duration_secs }) {
    if (!target_username && !target_user_id) {
      // Whole-chat clear.
      for (const line of this.container.querySelectorAll(".chat-line:not(.is-cleared)")) {
        this._collapseLine(line, "Chat was cleared by a moderator.");
      }
      return;
    }
    const lines = this.container.querySelectorAll(".chat-line:not(.is-cleared)");
    const targetLower = (target_username || "").toLowerCase();
    for (const line of lines) {
      const matchesId = target_user_id && line.dataset.msgUserId === target_user_id;
      const matchesName = !target_user_id && line.dataset.msgUsername?.toLowerCase() === targetLower;
      if (!matchesId && !matchesName) continue;
      const label = ban_duration_secs
        ? `Message from ${target_username} deleted (timed out for ${this._formatDuration(ban_duration_secs)}).`
        : `Message from ${target_username} deleted (banned).`;
      this._collapseLine(line, label);
    }
  },

  /** CLEARMSG handler - a single message was deleted (by anyone). Matches
   * by msg_id, same id PRIVMSG's `id` tag already provides as
   * line.dataset.msgId. */
  _handleClearMsg({ target_msg_id }) {
    const line = this.container.querySelector(`.chat-line[data-msg-id="${CSS.escape(target_msg_id)}"]`);
    if (line && !line.classList.contains("is-cleared")) {
      this._collapseLine(line, `Message from ${line.dataset.msgUsername || "user"} deleted.`);
    }
  },

  /** Marks a chat line as deleted/cleared WITHOUT destroying its content -
   * unlike the old behavior (replace with a "Message from X deleted"
   * placeholder, discarding the rendered message from the DOM entirely),
   * this just adds a class that CSS uses to dim the line and strike
   * through the message text, restoring full brightness on hover so the
   * content is still readable, not gone. `tooltip` (e.g. "Message
   * deleted (timed out for 30s)") becomes a native hover tooltip via
   * `title` rather than visible inline text, since the message itself is
   * now the visible content again. */
  _collapseLine(line, tooltip) {
    line.classList.add("is-cleared");
    line.title = tooltip;
  },

  /** Adds a newly-held message to the queue and refreshes the panel/
   * badge count. Called from the eventsub-automod-hold listener. */
  _addAutomodHold(hold) {
    this._automodQueue.push(hold);
    this._renderAutomodPanel();
    // Surface it even if the panel's currently collapsed - same idea as
    // the existing channel point redemption banner: a mod shouldn't have
    // to have the panel already open to notice something needs review.
    const toggleBtn = document.getElementById("automod-toggle-btn");
    if (toggleBtn) toggleBtn.classList.add("has-pending");
    // Also drop an inline line into the chat stream so mods see it in
    // context (where and when it appeared) rather than only in the panel.
    this._renderAutomodChatLine(hold);
  },

  /** Appends an inline chat-stream line for a held message so mods can
   * Allow/Deny it directly in context, mirroring Twitch's own chat UI.
   * The line is tagged with data-automod-msg-id so _resolveAutomodHold
   * can pull it from the DOM when the hold is resolved (from either the
   * inline buttons or the panel buttons - whichever fires first). */
  _renderAutomodChatLine(hold) {
    const line = document.createElement("div");
    line.className = "chat-line is-automod-held";
    line.dataset.automodMsgId = hold.msg_id;

    // Header row: label + category pill
    const label = document.createElement("div");
    label.className = "automod-held-label";
    const labelText = document.createElement("span");
    labelText.textContent = "Message held by AutoMod";
    label.appendChild(labelText);
    if (hold.category) {
      const cat = document.createElement("span");
      cat.className = "automod-held-category";
      cat.textContent = hold.category;
      label.appendChild(cat);
    }
    line.appendChild(label);

    // Body: username + message text (plain - no emote rendering, matching
    // how Twitch shows held messages: the raw text before it ever posted)
    const body = document.createElement("div");
    body.className = "automod-held-body";
    const nameSpan = document.createElement("span");
    nameSpan.className = "chat-username automod-held-username";
    nameSpan.textContent = (hold.user_name || "user") + ":";
    body.appendChild(nameSpan);
    body.appendChild(document.createTextNode(" "));
    const msgSpan = document.createElement("span");
    msgSpan.className = "chat-message-text";
    msgSpan.textContent = hold.message || "";
    body.appendChild(msgSpan);
    line.appendChild(body);

    // Inline Allow / Deny buttons
    const actions = document.createElement("div");
    actions.className = "automod-inline-actions";
    const allowBtn = document.createElement("button");
    allowBtn.className = "automod-allow-btn";
    allowBtn.textContent = "Allow";
    const denyBtn = document.createElement("button");
    denyBtn.className = "automod-deny-btn";
    denyBtn.textContent = "Deny";
    allowBtn.addEventListener("click", () =>
      this._resolveAutomodHold(hold.msg_id, "ALLOW", allowBtn, denyBtn));
    denyBtn.addEventListener("click", () =>
      this._resolveAutomodHold(hold.msg_id, "DENY", allowBtn, denyBtn));
    actions.appendChild(allowBtn);
    actions.appendChild(denyBtn);
    line.appendChild(actions);

    this.container.appendChild(line);
    this.trimAndScroll();
  },

  /** Removes the inline chat-stream line for a resolved hold (if it's
   * still in the DOM - the panel and inline buttons both call
   * _resolveAutomodHold, so whichever fires second is a no-op here). */
  _removeAutomodChatLine(msgId) {
    const line = this.container.querySelector(
      `[data-automod-msg-id="${msgId}"]`
    );
    if (line) line.remove();
  },

  /** Rebuilds #automod-panel's contents from this._automodQueue and
   * updates the toggle button's count badge. Called on every queue
   * mutation (add/allow/deny) rather than patched incrementally - the
   * queue is expected to stay small (a handful of items at most before a
   * mod clears it), so a full rebuild is simpler and cheap enough here. */
  _renderAutomodPanel() {
    const countEl = document.getElementById("automod-queue-count");
    if (countEl) {
      const n = this._automodQueue.length;
      countEl.textContent = String(n);
      countEl.classList.toggle("visible", n > 0);
    }
    const toggleBtn = document.getElementById("automod-toggle-btn");
    if (toggleBtn) {
      toggleBtn.style.display = this.isMod ? "flex" : "none";
      if (this._automodQueue.length === 0) toggleBtn.classList.remove("has-pending");
    }

    const panel = document.getElementById("automod-panel");
    if (!panel) return;
    panel.innerHTML = "";

    if (this._automodQueue.length === 0) {
      if (this.isMod) {
        const empty = document.createElement("div");
        empty.className = "automod-panel-empty";
        empty.textContent = "No messages awaiting review.";
        panel.appendChild(empty);
      }
      return;
    }

    for (const hold of this._automodQueue) {
      panel.appendChild(this._buildAutomodItem(hold));
    }
  },

  _buildAutomodItem(hold) {
    const item = document.createElement("div");
    item.className = "automod-item";

    const header = document.createElement("div");
    header.className = "automod-item-header";
    const user = document.createElement("span");
    user.className = "automod-item-user";
    user.textContent = hold.user_name || "user";
    header.appendChild(user);
    if (hold.category) {
      const cat = document.createElement("span");
      cat.className = "automod-item-category";
      cat.textContent = hold.category;
      header.appendChild(cat);
    }
    item.appendChild(header);

    const text = document.createElement("div");
    text.className = "automod-item-text";
    text.textContent = hold.message || "";
    item.appendChild(text);

    const actions = document.createElement("div");
    actions.className = "automod-item-actions";

    const allowBtn = document.createElement("button");
    allowBtn.className = "automod-allow-btn";
    allowBtn.textContent = "Allow";
    allowBtn.addEventListener("click", () => this._resolveAutomodHold(hold.msg_id, "ALLOW", allowBtn, denyBtn));

    const denyBtn = document.createElement("button");
    denyBtn.className = "automod-deny-btn";
    denyBtn.textContent = "Deny";
    denyBtn.addEventListener("click", () => this._resolveAutomodHold(hold.msg_id, "DENY", allowBtn, denyBtn));

    actions.appendChild(allowBtn);
    actions.appendChild(denyBtn);
    item.appendChild(actions);

    return item;
  },

  async _resolveAutomodHold(msgId, action, allowBtn, denyBtn) {
    allowBtn.disabled = true;
    denyBtn.disabled = true;
    try {
      await invoke("automod_process_message", { msgId, action });
      // Remove from the queue on success - no separate "it was approved/
      // denied" event to wait for here (unlike delete/timeout/ban, which
      // confirm via CLEARMSG/CLEARCHAT arriving back over IRC); Helix
      // returning success IS the confirmation for this one.
      this._automodQueue = this._automodQueue.filter((h) => h.msg_id !== msgId);
      this._renderAutomodPanel();
      // Also pull the inline chat-stream line - both the panel buttons
      // and the inline buttons call this resolver, so whichever ran
      // first already disabled the other set; this just cleans the DOM.
      this._removeAutomodChatLine(msgId);
    } catch (err) {
      console.error(`Failed to ${action.toLowerCase()} automod message:`, err);
      this.systemLine(`Failed to ${action === "ALLOW" ? "allow" : "deny"} message: ${err}`);
      allowBtn.disabled = false;
      denyBtn.disabled = false;
    }
  },

  /** Toggles #automod-panel's visibility. Wired to automod-toggle-btn's
   * click in main.js (that button lives in static HTML, not chat.js-
   * owned DOM, so it's wired from there - see the AutoMod section of
   * main.js). Exposed as a method here rather than main.js reaching into
   * chat.js's internals directly. */
  toggleAutomodPanel() {
    const panel = document.getElementById("automod-panel");
    if (!panel) return;
    const showing = panel.style.display !== "none";
    panel.style.display = showing ? "none" : "block";
  },

};
