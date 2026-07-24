// Channels sidebar - "Followed Channels" (live + offline, like the
// official site's "For You" rail) and a "Live Channels" list.
//
// Data flow:
//   1. get_followed_channels  -> who the logged-in user follows (Rust,
//      proxies /helix/channels/followed - requires user:read:follows).
//   2. get_streams_for_users  -> which of those are live right now, plus
//      viewer_count/game_name (Rust, proxies /helix/streams).
//   3. get_users_info         -> profile_image_url for avatars (Rust,
//      proxies /helix/users).
//   4. get_top_live_streams   -> a public, non-personalized "what's live
//      right now" list for the Live Channels rail, since Twitch doesn't
//      expose its real personalized recommendation feed via public Helix.
//
// All four require api.twitch.tv, which (like IRC/badges elsewhere in this
// app) isn't reachable directly from WebView2 - hence routing through Rust
// commands rather than calling Helix with fetch() here.

import { invoke } from "@tauri-apps/api/core";
import { feedInvoke, isKick } from "./platform.js";
import { getKickFollows, onKickFollowsChange } from "./kick-follows.js";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { streamHasDropsEnabled } from "./drops.js";

const REFRESH_INTERVAL_MS = 60_000;
const COLLAPSED_LIVE_COUNT = 8;

export class ChannelsSidebar {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.followedListEl
   * @param {HTMLElement} opts.showMoreBtn
   * @param {HTMLElement} opts.loginPromptEl
   * @param {HTMLElement} opts.topLiveListEl
   * @param {(channel: string) => void} opts.onChannelSelect - called with a
   *   lowercase channel login when the user clicks an entry.
   */
  constructor({ followedListEl, showMoreBtn, loginPromptEl, topLiveListEl, onChannelSelect }) {
    this.followedListEl = followedListEl;
    this.showMoreBtn = showMoreBtn;
    this.loginPromptEl = loginPromptEl;
    this.topLiveListEl = topLiveListEl;
    this.onChannelSelect = onChannelSelect || (() => {});

    this.loggedIn = false;
    this.expanded = false;
    /** Merged followed-channel rows: {id, login, name, live, viewers, game} */
    this.followed = [];
    /** @type {Map<string, string>} user_id -> profile_image_url */
    this.avatars = new Map();

    /** @type {Set<string>} Lowercase channel logins the user has opted
     * into go-live desktop notifications for. Loaded from disk in init()
     * (notify_prefs.rs) and kept in sync with that file on every toggle -
     * see toggleNotify(). */
    this.notifyChannels = new Set();
    /** @type {Map<string, boolean>} login -> live state as of the last
     * completed refreshFollowed() tick. Compared against the new state
     * on the NEXT tick to detect false->true transitions (offline ->
     * live) - that comparison, not the raw "is it live" value, is what
     * decides whether to fire a notification. Without tracking the
     * previous tick, every single refresh would notify all-already-live
     * opted-in channels over and over, every 60s, forever. */
    this._lastLiveState = new Map();

    this.refreshTimer = null;

    this.showMoreBtn.addEventListener("click", () => {
      this.expanded = !this.expanded;
      this.renderFollowed();
    });

    // Follow toggled from the channel info bar (kick-follows.js) - the
    // Following section should reflect it without waiting for the next
    // 60s refresh tick.
    onKickFollowsChange(() => {
      if (isKick()) this.refreshKickFollowing();
    });
  }

  /** Call once login succeeds (or has already happened on startup). */
  onLogin() {
    this.loggedIn = true;
    this.loginPromptEl.style.display = "none";
    this.refresh();
    if (!this.refreshTimer) {
      this.refreshTimer = setInterval(() => this.refresh(), REFRESH_INTERVAL_MS);
    }
  }

  /** Kicks off an initial load of the public Live Channels rail, which
   * doesn't need login - call this unconditionally at startup. Also
   * restores the saved go-live-notification opt-in set, which is
   * independent of login state (it's just a local file, not Twitch
   * account data), so it loads here rather than in onLogin(). */
  async init() {
    try {
      const channels = await invoke("get_notify_channels");
      this.notifyChannels = new Set(channels);
    } catch (err) {
      console.error("Failed to load notification preferences:", err);
    }
    await this.refreshTopLive();
  }

  async refresh() {
    await Promise.all([this.refreshFollowed(), this.refreshTopLive()]);
  }

  async refreshFollowed() {
    // Kick mode: the Following section is the LOCAL follow list (see
    // kick-follows.js for why it can't be the real kick.com one), which
    // needs no Twitch login - or any login - at all.
    if (isKick()) {
      await this.refreshKickFollowing();
      return;
    }
    if (!this.loggedIn) return;

    let followedRows;
    try {
      followedRows = JSON.parse(await invoke("get_followed_channels"));
    } catch (err) {
      console.error("Failed to load followed channels:", err);
      return;
    }

    const ids = followedRows.map((r) => r.broadcaster_id);
    if (ids.length === 0) {
      this.followed = [];
      this.renderFollowed();
      return;
    }

    // get_streams_for_users and get_users_info both only depend on `ids`,
    // not on each other's result - fetching them concurrently instead of
    // one after the other cuts a full network round-trip off of every
    // sidebar refresh. allSettled (not Promise.all) keeps each call's
    // failure independent of the other's, matching the try/catch
    // isolation this had before - one endpoint erroring shouldn't wipe
    // out data the other one successfully returned.
    const missingAvatarIds = ids.filter((id) => !this.avatars.has(id));
    const [liveResult, usersResult] = await Promise.allSettled([
      invoke("get_streams_for_users", { broadcasterIds: ids }),
      missingAvatarIds.length > 0
        ? invoke("get_users_info", { userIds: missingAvatarIds })
        : Promise.resolve(null),
    ]);

    let liveRows = [];
    if (liveResult.status === "fulfilled") {
      liveRows = JSON.parse(liveResult.value);
    } else {
      console.error("Failed to load stream status:", liveResult.reason);
    }
    const liveById = new Map(liveRows.map((s) => [s.user_id, s]));

    if (usersResult.status === "fulfilled" && usersResult.value !== null) {
      const users = JSON.parse(usersResult.value);
      for (const u of users) {
        this.avatars.set(u.id, u.profile_image_url);
      }
    } else if (usersResult.status === "rejected") {
      console.error("Failed to load channel avatars:", usersResult.reason);
    }

    this.followed = followedRows
      .map((r) => {
        const live = liveById.get(r.broadcaster_id);
        return {
          id: r.broadcaster_id,
          login: r.broadcaster_login,
          title: live ? live.title : "",
          name: r.broadcaster_name,
          avatar: this.avatars.get(r.broadcaster_id) || "",
          live: Boolean(live),
          viewers: live ? live.viewer_count : 0,
          game: live ? live.game_name : "",
          dropsEnabled: live ? streamHasDropsEnabled(live) : false,
        };
      })
      // Live channels first (highest viewers first), then offline
      // alphabetically - matches the official sidebar's default sort.
      .sort((a, b) => {
        if (a.live !== b.live) return a.live ? -1 : 1;
        if (a.live) return b.viewers - a.viewers;
        return a.name.localeCompare(b.name);
      });

    this._checkForNewlyLiveChannels();
    this.renderFollowed();
  }

  /** Compares this tick's live state against last tick's for every
   * opted-in channel, and fires a desktop notification for any
   * false->true transition (offline -> live) since the last refresh.
   * Must run AFTER this.followed is rebuilt but it owns updating
   * _lastLiveState itself, so it's safe to call unconditionally on every
   * refreshFollowed() tick regardless of whether anything opted-in
   * actually changed. */
  async _checkForNewlyLiveChannels() {
    if (this.notifyChannels.size === 0) {
      // Nothing opted in - still update the tracked state below so that
      // if the user opts into a channel later, the NEXT tick has a
      // correct baseline rather than possibly misreading "first time we
      // ever saw this channel" as a transition.
      for (const ch of this.followed) this._lastLiveState.set(ch.login, ch.live);
      return;
    }

    const newlyLive = [];
    for (const ch of this.followed) {
      const wasLive = this._lastLiveState.get(ch.login);
      if (ch.live && wasLive === false && this.notifyChannels.has(ch.login)) {
        newlyLive.push(ch);
      }
      this._lastLiveState.set(ch.login, ch.live);
    }
    if (newlyLive.length === 0) return;

    // Permission is checked/requested lazily, right when there's
    // actually something to notify about - rather than on every refresh
    // tick - so a user who's opted into nothing never gets an OS
    // permission prompt at all.
    try {
      let granted = await isPermissionGranted();
      if (!granted) {
        granted = (await requestPermission()) === "granted";
      }
      if (!granted) return;
    } catch (err) {
      console.error("Notification permission check failed:", err);
      return;
    }

    for (const ch of newlyLive) {
      try {
        sendNotification({
          title: `${ch.name} is live!`,
          body: ch.title || ch.game || "Started streaming on Twitch",
        });
      } catch (err) {
        console.error(`Failed to send go-live notification for ${ch.login}:`, err);
      }
    }
  }

  /** DEBUG/TESTING ONLY - manually triggers the real go-live notification
   * path for one channel, without waiting for it to actually go live.
   * Exposed on window as window.__testGoLiveNotification() (see main.js)
   * for use from the devtools console.
   *
   * Unlike calling sendNotification() directly, this goes through the
   * actual production path: forces _lastLiveState for the given login to
   * false (simulating "last poll saw it offline"), then calls the real
   * _checkForNewlyLiveChannels() - the same function the 60s
   * refreshFollowed() poll calls. So this exercises the real
   * offline→live detection, the real notifyChannels opt-in check, and
   * the real permission/sendNotification call, not an approximation.
   *
   * @param {string} [login] - lowercase channel login to fake a
   *   transition for. Defaults to the first channel opted into
   *   notifications, so most callers don't need to know/type a login.
   *   Throws if omitted and nothing is opted in - there'd be nothing
   *   meaningful to test. Requires a genuine FOLLOWED channel (not just
   *   opted-in) since production data (name, title, game) comes from
   *   there.
   */
  async debugTestGoLiveNotification(login) {
    const targetLogin = login || [...this.notifyChannels][0];
    if (!targetLogin) {
      throw new Error(
        "No channel opted into notifications yet - click the bell on a followed channel first, or pass a login explicitly: window.__testGoLiveNotification('somechannel')"
      );
    }
    const ch = this.followed.find((c) => c.login === targetLogin);
    if (!ch) {
      throw new Error(
        `"${targetLogin}" isn't in your followed channels list right now - debugTestGoLiveNotification only works with a channel from this.followed, since that's where the notification's title/game text comes from.`
      );
    }
    if (!this.notifyChannels.has(targetLogin)) {
      throw new Error(
        `"${targetLogin}" isn't opted into notifications - click its bell icon first, or pass a login that already is.`
      );
    }
    // Force "last seen offline" so the real function below reads this as
    // a genuine transition, regardless of what the most recent actual
    // poll tick happened to record.
    this._lastLiveState.set(targetLogin, false);
    // Also force ch.live itself, in case the channel is genuinely
    // offline right now - _checkForNewlyLiveChannels reads ch.live (not
    // just the cached _lastLiveState) to decide if THIS tick sees it
    // live, so without this a real-offline channel would never trigger
    // even with _lastLiveState faked.
    ch.live = true;
    console.log(`[debug] Faking go-live transition for "${targetLogin}" and re-running the real notification check...`);
    await this._checkForNewlyLiveChannels();
    console.log("[debug] Done - check your OS notifications if nothing appeared, see console for any errors logged above.");
  }

  /** Kick-mode Following: local follow list + one batched live-status
   * lookup (kick_followed_status). Live rows first (highest viewers
   * first), offline rows greyed after - the same shape renderFollowed/
   * buildChannelRow already draw for Twitch, so no new row rendering
   * exists for this at all. A channel whose lookup failed (Cloudflare
   * hiccup, renamed, etc.) falls back to its stored name/avatar and
   * renders offline rather than vanishing. */
  async refreshKickFollowing() {
    const follows = getKickFollows();
    if (follows.length === 0) {
      this.followed = [];
      this.renderFollowed();
      return;
    }
    let statuses = [];
    try {
      statuses = JSON.parse(
        await invoke("kick_followed_status", { slugs: follows.map((f) => f.slug) })
      );
    } catch (err) {
      console.error("Failed to load Kick following statuses:", err);
    }
    const bySlug = new Map(statuses.map((st) => [st.slug, st]));
    this.followed = follows
      .map((f) => {
        const st = bySlug.get(f.slug);
        return {
          id: `kick:${f.slug}`,
          login: f.slug,
          name: st?.name || f.name || f.slug,
          avatar: st?.avatar || f.avatar || "",
          live: Boolean(st?.is_live),
          viewers: st?.viewer_count ?? 0,
          game: st?.game || "",
          title: "",
        };
      })
      .sort((a, b) => {
        if (a.live !== b.live) return a.live ? -1 : 1;
        return (b.viewers || 0) - (a.viewers || 0);
      });
    this.renderFollowed();
    // The shared 60s refresh normally only starts on Twitch login - a
    // Kick Following section wants live-state updates regardless.
    if (!this.refreshTimer) {
      this.refreshTimer = setInterval(() => this.refresh(), REFRESH_INTERVAL_MS);
    }
  }

  async refreshTopLive() {
    let rows = [];
    try {
      rows = JSON.parse(await feedInvoke("get_top_live_streams"));
    } catch (err) {
      console.error("Failed to load top live channels:", err);
      this.topLiveListEl.innerHTML = "";
      return;
    }
    await this.renderTopLive(rows);
  }

  renderFollowed() {
    this.followedListEl.innerHTML = "";
    const kick = isKick();

    if (this.followed.length === 0) {
      if (kick) {
        const empty = document.createElement("div");
        empty.className = "sidebar-empty";
        empty.textContent = "Follow a Kick channel to pin it here.";
        this.followedListEl.appendChild(empty);
      } else if (this.loggedIn) {
        const empty = document.createElement("div");
        empty.className = "sidebar-empty";
        empty.textContent = "No followed channels yet.";
        this.followedListEl.appendChild(empty);
      }
      this.showMoreBtn.style.display = "none";
      return;
    }

    const visible = this.expanded
      ? this.followed
      : this.followed.slice(0, COLLAPSED_LIVE_COUNT);

    for (const ch of visible) {
      // The bell (go-live desktop notifications) is wired to the Twitch
      // followed-channels poll - Kick rows don't get one (their refresh
      // has no offline->live notification pipeline behind it).
      this.followedListEl.appendChild(
        this.buildChannelRow(ch, { showNotifyToggle: !kick })
      );
    }

    if (this.followed.length > COLLAPSED_LIVE_COUNT) {
      this.showMoreBtn.style.display = "block";
      this.showMoreBtn.textContent = this.expanded
        ? "Show Less"
        : `Show More (${this.followed.length - COLLAPSED_LIVE_COUNT})`;
    } else {
      this.showMoreBtn.style.display = "none";
    }
  }

  async renderTopLive(rows) {
    // /helix/streams (where `rows` comes from) doesn't include profile
    // images - only /helix/users does - so do a second batched lookup for
    // whichever of these user_ids we haven't already cached an avatar for
    // (likely already warm from the followed-channels refresh).
    // Kick-mode rows skip that entirely: kick.rs embeds the avatar as
    // profile_image_url on each stream (Kick's payloads include it
    // inline), and their kick:* user_ids must never reach get_users_info
    // (Helix would 400 the whole batch).
    for (const s of rows) {
      if (s.profile_image_url && !this.avatars.has(s.user_id)) {
        this.avatars.set(s.user_id, s.profile_image_url);
      }
    }
    const missingAvatarIds = rows
      .map((s) => s.user_id)
      .filter((id) => !this.avatars.has(id) && !String(id).startsWith("kick:"));
    if (missingAvatarIds.length > 0 && this.loggedIn) {
      try {
        const users = JSON.parse(
          await invoke("get_users_info", { userIds: missingAvatarIds })
        );
        for (const u of users) {
          this.avatars.set(u.id, u.profile_image_url);
        }
      } catch (err) {
        console.error("Failed to load top-live avatars:", err);
      }
    }

    this.topLiveListEl.innerHTML = "";
    for (const s of rows) {
      const ch = {
        id: s.user_id,
        login: s.user_login,
        name: s.user_name,
        avatar: this.avatars.get(s.user_id) || "",
        live: true,
        viewers: s.viewer_count,
        title: s.title,
        game: s.game_name,
        dropsEnabled: streamHasDropsEnabled(s),
      };
      this.topLiveListEl.appendChild(this.buildChannelRow(ch));
    }
  }

  /**
   * @param {object} ch - channel row data (see refreshFollowed/renderTopLive)
   * @param {object} [opts]
   * @param {boolean} [opts.showNotifyToggle] - adds a bell button for
   *   opting into go-live desktop notifications. Only passed true for
   *   Followed rows (renderFollowed) - Top Live rows (renderTopLive) are
   *   channels the user may not even follow, so "notify me when this
   *   goes live" doesn't really apply there the same way, and keeps the
   *   public/no-login-required Live Channels rail simpler.
   */
  buildChannelRow(ch, opts = {}) {
    const btn = document.createElement("button");
    btn.className = "sidebar-channel";
    btn.addEventListener("click", () =>
      this.onChannelSelect(
        ch.login,
        ch.live
          ? {
              user_id: ch.id,
              user_name: ch.name,
              title: ch.title || "",
              tags: ch.dropsEnabled ? ["DropsEnabled"] : [],
              viewer_count: ch.viewers,
              // watchChannel() in main.js checks stream.type === "live"
              // to decide whether to attempt playback at all (added so
              // genuinely offline channels go straight to a chat-only
              // view instead of resolving a playback URL just to watch it
              // fail) - home.js/browse.js pass Helix's raw stream object
              // straight through, which already has this field, but this
              // object is hand-built from the sidebar's own `ch` shape
              // and was missing it entirely. That meant EVERY sidebar
              // click (both Followed and Live Channels rows) had
              // stream.type === undefined, so watchChannel() treated
              // every sidebar-launched channel as offline regardless of
              // actual status - this `ch.live` branch only ever runs for
              // a row the sidebar already knows is live, so hardcoding
              // "live" here is correct, not a guess.
              type: "live",
            }
          : null
      )
    );

    const avatarWrap = document.createElement("div");
    avatarWrap.className = "sidebar-channel-avatar-wrap";

    const avatar = document.createElement("img");
    avatar.className = `sidebar-channel-avatar${ch.live ? "" : " offline"}`;
    avatar.src = ch.avatar || blankAvatarDataUri();
    avatar.alt = "";
    avatarWrap.appendChild(avatar);

    btn.appendChild(avatarWrap);

    const info = document.createElement("div");
    info.className = "sidebar-channel-info";

    const name = document.createElement("div");
    name.className = `sidebar-channel-name${ch.live ? "" : " offline"}`;
    name.textContent = ch.name || ch.login;
    info.appendChild(name);

    const sub = document.createElement("div");
    sub.className = "sidebar-channel-sub";
    sub.textContent = ch.live ? ch.game || "" : "Offline";
    info.appendChild(sub);

    btn.appendChild(info);

    const status = document.createElement("div");
    status.className = `sidebar-channel-status ${ch.live ? "live" : "offline"}`;
    if (ch.live) {
      const viewerRow = document.createElement("div");
      viewerRow.className = "sidebar-channel-viewer-row";
      const dot = document.createElement("span");
      dot.className = "sidebar-live-dot";
      viewerRow.appendChild(dot);
      viewerRow.appendChild(document.createTextNode(formatViewerCount(ch.viewers)));
      status.appendChild(viewerRow);

      if (ch.dropsEnabled) {
        const dropsLabel = document.createElement("div");
        dropsLabel.className = "sidebar-drops-label";
        dropsLabel.textContent = "Drops";
        dropsLabel.title = "Drops Enabled";
        status.appendChild(dropsLabel);
      }
    }
    btn.appendChild(status);

    if (!opts.showNotifyToggle) {
      return btn;
    }

    // The bell toggle must NOT be a descendant of `btn` - nesting a
    // <button> inside another <button> is invalid HTML, and in practice
    // means the inner button's clicks are unreliable/inconsistent across
    // engines rather than cleanly bubbling or being contained. Instead,
    // wrap both as siblings in a plain (non-button) container, so each
    // has its own independent click target.
    const row = document.createElement("div");
    row.className = "sidebar-channel-row";
    row.appendChild(btn);

    const notifyBtn = document.createElement("button");
    const isOn = this.notifyChannels.has(ch.login);
    notifyBtn.className = `sidebar-notify-toggle${isOn ? " active" : ""}`;
    notifyBtn.title = isOn
      ? `Notifications on - click to turn off for ${ch.name || ch.login}`
      : `Notify me when ${ch.name || ch.login} goes live`;
    notifyBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.89 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/></svg>';
    notifyBtn.addEventListener("click", (e) => {
      // Stop this from also triggering btn's click (channel select) -
      // they're siblings now rather than nested, so without this a click
      // landing on the bell would otherwise do nothing else unwanted,
      // but stopPropagation here is cheap insurance and makes the intent
      // explicit regardless.
      e.stopPropagation();
      this.toggleNotify(ch.login, notifyBtn, ch.name || ch.login);
    });
    row.appendChild(notifyBtn);

    return row;
  }

  /** Flips one channel's notification opt-in, updates the bell button's
   * own visual state immediately (no full re-render needed), and
   * persists the complete new set to disk via notify_prefs.rs. */
  async toggleNotify(login, btnEl, displayName) {
    const turningOn = !this.notifyChannels.has(login);
    if (turningOn) {
      this.notifyChannels.add(login);
    } else {
      this.notifyChannels.delete(login);
    }
    btnEl.classList.toggle("active", turningOn);
    btnEl.title = turningOn
      ? `Notifications on - click to turn off for ${displayName}`
      : `Notify me when ${displayName} goes live`;

    try {
      await invoke("set_notify_channels", { channels: [...this.notifyChannels] });
    } catch (err) {
      console.error("Failed to save notification preferences:", err);
    }

    // Requesting permission right when the user opts into the FIRST
    // channel (rather than waiting for it to actually go live) gives
    // immediate feedback if they deny it, instead of a silent no-op
    // notification failure minutes/hours later when the channel
    // actually starts streaming.
    if (turningOn) {
      try {
        let granted = await isPermissionGranted();
        if (!granted) await requestPermission();
      } catch (err) {
        console.error("Notification permission request failed:", err);
      }
    }
  }
}

function formatViewerCount(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K`;
  return String(n);
}

/** 1x1 transparent pixel, used so <img> never shows a broken-image icon
 * for channels we have no avatar URL for (e.g. top-live rail entries). */
function blankAvatarDataUri() {
  return "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
}
