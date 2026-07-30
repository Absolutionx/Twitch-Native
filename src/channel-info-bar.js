// The strip below the player (avatar, name, title, game, viewers, tags) plus
// the in-video info overlay. Owns its own DOM and caches; watchChannel,
// switchPage, and setStatus are injected via initChannelInfoBar() to avoid a
// circular import from main.js.

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isKickFollowed, toggleKickFollow } from "./kick-follows.js";
import { getKickAlias, setKickAlias } from "./kick-aliases.js";
import { streamHasDropsEnabled } from "./drops.js";
import { updateDropsBanner } from "./drops-banner.js";
import { formatViewerCount } from "./format.js";
import { session } from "./session.js";

// --- Injected app-shell collaborators (see initChannelInfoBar) ----------
let watchChannel = () => {};
let switchPage = () => {};
let setStatus = () => {};

/** Wires up the app-shell functions this module needs. Called once from
 * main.js at startup, before anything can click a button in the bar. */
export function initChannelInfoBar(deps) {
  watchChannel = deps.watchChannel;
  switchPage = deps.switchPage;
  setStatus = deps.setStatus;
}

/** Runs after refreshKickAliasBtn() re-evaluates the alias button's
 * visibility, so main.js's dev "Test failover" button can track it. */
let _afterAliasBtnRefresh = () => {};
export function setAfterAliasBtnRefresh(fn) {
  _afterAliasBtnRefresh = fn;
}

/** The Kick-alias button, exported only so main.js can hang the dev
 * "Test failover" button next to it. */
export { channelInfoKickAliasBtn };

// --- DOM ----------------------------------------------------------------
const channelInfoBar = document.getElementById("channel-info-bar");
const channelInfoAvatar = document.getElementById("channel-info-avatar");
const channelInfoName = document.getElementById("channel-info-name");
const channelInfoFollowBtn = document.getElementById("channel-info-follow-btn");
const channelInfoSubscribeBtn = document.getElementById("channel-info-subscribe-btn");
const channelInfoVideosBtn = document.getElementById("channel-info-videos-btn");
const channelInfoKickAliasBtn = document.getElementById("channel-info-kick-alias-btn");
const channelInfoViewers = document.getElementById("channel-info-viewers");
const channelInfoTitle = document.getElementById("channel-info-title");
const channelInfoTags = document.getElementById("channel-info-tags");
const streamInfoOverlay = document.getElementById("stream-info-overlay");
const streamInfoAvatar = document.getElementById("stream-info-avatar");
const streamInfoName  = document.getElementById("stream-info-name");
const streamInfoBadge  = document.getElementById("stream-info-badge");
const streamInfoTitle  = document.getElementById("stream-info-title");
const streamInfoMeta  = document.getElementById("stream-info-meta");

// --- Channel info bar ----------------------------------------------------
//
// Fills the space left over below #video-frame when not in theater mode -
// see the HTML comment on #channel-info-bar in index.html for the full
// rationale (mirrors the official site's below-player strip instead of
// leaving that area solid black).
//
/** @type {Map<string, string>} user_id -> profile_image_url, so switching
 * back to a recently-watched channel doesn't refetch an avatar we already
 * have - same caching approach as the avatar maps in home.js/browse.js/
 * sidebar.js. */
const channelInfoAvatars = new Map();

/** user_id -> broadcaster_type ("partner"|"affiliate"|""), populated
 *  alongside channelInfoAvatars so the partner badge needs no extra fetch.
 *  Used by the stream-info overlay (shows on video mouseover). */
const channelBroadcasterTypes = new Map();
let channelInfoRefreshTimer = null;
// Last (channel, stream) the bar was actually rendered with, so
// resyncChannelInfoBarVisibility() below can cheaply re-show/hide it on
// every tab click or pill click without redoing the full render (DOM
// rebuild + an avatar fetch) each time - those only need to happen when
// the underlying data changes (stream start, the 60s refresh), not on
// every navigation in and out of the video view.
let lastChannelInfo = null;

/**
 * Populates the video-overlay stream info card (avatar, channel name,
 * title, game + viewer count). Shows when controls are visible (via CSS
 * #video-frame.controls-visible .stream-info-overlay:not(.empty)); hides
 * itself with the .empty class when called with no live stream.
 */
export function updateStreamInfoOverlay(channel, stream, avatarUrl, broadcasterType) {
  if (!stream || !channel) {
    streamInfoOverlay.classList.add("empty");
    return;
  }
  streamInfoAvatar.src = avatarUrl || blankAvatarDataUri();
  streamInfoName.textContent = stream.user_name || channel;
  // Partner badge: only for verified partners (broadcaster_type="partner").
  streamInfoBadge.style.display =
    broadcasterType === "partner" ? "inline-block" : "none";
  streamInfoTitle.textContent = stream.title || "";
  const gamePart    = stream.game_name ? `Playing ${stream.game_name}` : "";
  // Full comma-formatted number (e.g. "4,373 viewers") matching Twitch's
  // own player overlay style, rather than the abbreviated "4.4K" used in
  // the channel info bar where horizontal space is tighter.
  const viewerPart  =
    typeof stream.viewer_count === "number"
      ? `${stream.viewer_count.toLocaleString()} viewers`
      : "";
  // Mirrors the format shown in the screenshot: "Playing X for N viewers".
  streamInfoMeta.textContent =
    gamePart && viewerPart ? `${gamePart} for ${viewerPart}` :
    gamePart || viewerPart;
  streamInfoOverlay.classList.remove("empty");
}

/**
 * Populates the channel info bar's content for the given channel, and
 * shows/hides it based on current state. `stream` may be null (e.g. a
 * manual Watch on a channel that's actually offline, or a failed lookup) -
 * in that case the bar still shows with whatever's knowable (channel name,
 * Follow/Subscribe links) but omits viewer count/title/tags rather than
 * showing stale or fabricated values.
 *
 * Deliberately callable (and called, from watchChannel below) BEFORE
 * start_stream has actually resolved a playback URL - see
 * resyncChannelInfoBarVisibility() below for why visibility is gated on
 * session.intendedChannel/session.pageVisible rather than `session.playing`, and why that
 * distinction is what this whole function's timing depends on.
 */
export async function updateChannelInfoBar(channel, stream) {
  lastChannelInfo = { channel, stream };
  // Both platforms offer Videos now; kept here as belt-and-braces in
  // case any path ever hides it.
  channelInfoVideosBtn.style.display = "";

  channelInfoName.textContent = (stream && stream.user_name) || channel;
  channelInfoTitle.textContent = (stream && stream.title) || "";
  channelInfoViewers.textContent =
    stream && typeof stream.viewer_count === "number"
      ? `${formatViewerCount(stream.viewer_count)} viewers`
      : "";

  const channelUrl = `https://www.twitch.tv/${encodeURIComponent(channel)}`;
  channelInfoFollowBtn.href = channelUrl;
  // A preceding Kick session may have left this reading "Following" -
  // on Twitch it's a plain link-out, always labeled Follow.
  channelInfoFollowBtn.textContent = "Follow";
  channelInfoFollowBtn.classList.remove("is-following");
  channelInfoSubscribeBtn.href = channelUrl;
  // Sync the "Link Kick" control to THIS channel's stored alias (and
  // re-show it - the Kick populator hides it). Without this per-channel
  // refresh the button only updated when an edit finished, so its label
  // followed you across channels ("Kick: asmongold" while watching xqc)
  // and a freshly-opened channel showed the static default "Link Kick"
  // even when its alias was saved - which read as the link being lost,
  // though the stored mapping (and the failover reading it) was fine.
  refreshKickAliasBtn(channel);

  channelInfoTags.innerHTML = "";
  if (stream && streamHasDropsEnabled(stream)) {
    const dropsTag = document.createElement("span");
    dropsTag.className = "channel-info-tag channel-info-drops-tag";
    dropsTag.textContent = "Drops Enabled";
    channelInfoTags.appendChild(dropsTag);
  }
  for (const t of (stream && stream.tags) || []) {
    if (typeof t !== "string" || t.toLowerCase().replace(/\s+/g, "") === "dropsenabled") {
      continue; // already shown as its own styled tag above, don't duplicate
    }
    const tag = document.createElement("span");
    tag.className = "channel-info-tag";
    tag.textContent = t;
    channelInfoTags.appendChild(tag);
  }

  // Show the avatar we already have cached for this broadcaster (if any)
  // immediately; otherwise fall back to blank for now rather than leaving
  // whatever the previous channel's avatar happened to be on screen.
  // Check both the id-keyed entry (live) and the login-keyed entry (offline)
  // so a returning offline channel shows its cached avatar without waiting.
  channelInfoAvatar.src =
    (stream && stream.user_id && channelInfoAvatars.get(stream.user_id)) ||
    channelInfoAvatars.get(`login:${channel}`) ||
    blankAvatarDataUri();

  // Sync the video overlay immediately with whatever we have cached.
  updateStreamInfoOverlay(
    channel, stream,
    channelInfoAvatar.src,
    (stream?.user_id && channelBroadcasterTypes.get(stream.user_id)) || "",
  );

  // Everything above this point is synchronous (no await yet) - resync
  // visibility now, BEFORE the avatar fetch below, so the bar actually
  // appears with the name/title/viewer count the instant this function
  // runs. Previously this call was the last line of the function, after
  // the `await invoke("get_users_info", ...)` below - which meant the
  // whole bar (title and all, not just the avatar) stayed display:none
  // until that fetch finished. If get_users_info was ever slow for any
  // reason, this looked exactly like "the title takes forever," when
  // actually the already-known, already-set title was just being held
  // behind an unrelated network call for no reason. The avatar itself is
  // genuinely fine to arrive a moment later, asynchronously, into a bar
  // that's already visible - see the second resync call further below.
  resyncChannelInfoBarVisibility();

  // Avatar fetch: two paths depending on whether the channel is live.
  //
  // Live: stream.user_id is available -> get_users_info (batch by ID).
  // Offline: stream is null, only the login name is known -> fall back
  //   to get_user_by_login, which does a single /helix/users?login=
  //   request.  Cached under "login:<channel>" to avoid re-fetching on
  //   repeated offline visits; distinct from the id-keyed entry so both
  //   can coexist without stomping each other when the channel goes live.
  const cacheKey   = (stream && stream.user_id) ? stream.user_id : `login:${channel}`;
  const alreadyHas = channelInfoAvatars.has(cacheKey);

  if (!alreadyHas) {
    try {
      let url = null;
      let broadcasterType = "";
      if (stream && stream.user_id) {
        const users = JSON.parse(await invoke("get_users_info", { userIds: [stream.user_id] }));
        url = users[0]?.profile_image_url ?? null;
        broadcasterType = users[0]?.broadcaster_type ?? "";
        if (broadcasterType) channelBroadcasterTypes.set(stream.user_id, broadcasterType);
      } else if (channel) {
        const user = JSON.parse(await invoke("get_user_by_login", { login: channel }));
        url = user?.profile_image_url ?? null;
      }
      if (url) {
        channelInfoAvatars.set(cacheKey, url);
        // Only apply if this channel is still the one the user actually
        // intends to be watching - this is the tail end of an await, and
        // session.intendedChannel (set synchronously at the top of
        // watchChannel()) is the most current source of truth for that,
        // unlike playbackControls.currentChannel (not set until
        // start_stream has actually resolved a playback URL) or lastChannelInfo (one level further
        // removed - it's set by this very function, so checking it here
        // wouldn't catch a stale call from an older, still-in-flight
        // watchChannel() invocation).
        if (session.intendedChannel === channel) {
          channelInfoAvatar.src = url;
          // Update overlay with the now-resolved avatar and partner badge.
          updateStreamInfoOverlay(channel, stream, url, broadcasterType);
        }
      }
    } catch (err) {
      console.error("Failed to load channel info avatar:", err);
    }
  }
}

/**
 * Kick counterpart of updateChannelInfoBar above: populates the SAME
 * bar + video overlay, from the Kick channel payload (KickLiveInfo)
 * instead of Helix - no Twitch lookups anywhere in this path. Fields
 * mirror what kick.com's own channel page shows: avatar, display name
 * with the verified checkmark, title, viewer count, and a pill
 * row of category / language / 18+ / stream tags. Follow/Subscribe link
 * out to the kick.com channel page (same treatment as the Twitch bar's
 * links to twitch.tv - real follow/subscribe actions need scopes and
 * flows this app doesn't have on either platform). The Videos button
 * opens the same in-app VODs page as on Twitch, backed by Kick's own
 * channel-videos listing (kick_channel_videos in kick.rs).
 */
export function updateKickChannelInfoBar(channel, info) {
  lastChannelInfo = {
    channel,
    stream: null,
    kick: true,
    // Clean values for the Follow toggle to cache (kick-follows.js) -
    // channelInfoName.textContent is NOT usable for this: the verified
    // checkmark below is appended INSIDE that span, so its textContent
    // reads "Name✓".
    displayName: info.display_name || channel,
    avatar: info.avatar || "",
  };

  channelInfoName.textContent = info.display_name || channel;
  if (info.verified) {
    const v = document.createElement("span");
    v.className = "channel-info-verified";
    v.title = "Verified";
    v.textContent = "✓";
    channelInfoName.appendChild(v);
  }
  channelInfoTitle.textContent = info.title || "";

  // Viewer count only - Kick's follower count was previously appended
  // here ("1.6K viewers · 1091K followers") but it's noise next to the
  // live viewer number, which is the figure that actually matters for a
  // live stream.
  channelInfoViewers.textContent =
    typeof info.viewer_count === "number"
      ? `${formatViewerCount(info.viewer_count)} viewers`
      : "";

  const channelUrl = `https://kick.com/${encodeURIComponent(channel)}`;
  // Aliases pair a TWITCH channel to a Kick one - on a Kick session
  // there's nothing to link, so the control hides here and
  // refreshKickAliasBtn re-shows it when a Twitch channel populates.
  channelInfoKickAliasBtn.style.display = "none";
  _afterAliasBtnRefresh(); // hide the dev "Test failover" button too on Kick sessions
  // On Kick the Follow button is a REAL in-app toggle (local follow
  // list -> sidebar Following section), not a link-out like Twitch's -
  // see the click handler's kick branch below. href kept pointing at
  // the channel page anyway so middle-click/copy-link still work.
  channelInfoFollowBtn.href = channelUrl;
  const followed = isKickFollowed(channel);
  channelInfoFollowBtn.textContent = followed ? "Following" : "Follow";
  channelInfoFollowBtn.classList.toggle("is-following", followed);
  channelInfoSubscribeBtn.href = channelUrl;
  // Videos is offered on Kick sessions too: it opens the same in-app
  // VODs page, fetched from Kick's channel-videos listing instead of
  // Helix (see kick_channel_videos in kick.rs and the button handler
  // below, which records which platform the click came from).
  channelInfoVideosBtn.style.display = "";

  channelInfoTags.innerHTML = "";
  if (info.category) {
    // The category gets the accent-filled treatment (like the Drops tag
    // on the Twitch bar) since it's the pill people actually scan for -
    // mirrors the site putting the category first, in green.
    const cat = document.createElement("span");
    cat.className = "channel-info-tag channel-info-category-tag";
    cat.textContent = info.category;
    channelInfoTags.appendChild(cat);
  }
  const plainPills = [];
  if (info.language) plainPills.push(languageLabel(info.language));
  if (info.is_mature) plainPills.push("18+");
  for (const t of info.tags || []) {
    if (typeof t === "string" && t.trim()) plainPills.push(t.trim());
  }
  for (const text of plainPills) {
    const tag = document.createElement("span");
    tag.className = "channel-info-tag";
    tag.textContent = text;
    channelInfoTags.appendChild(tag);
  }

  channelInfoAvatar.src = info.avatar || blankAvatarDataUri();

  // Video overlay: synthesize the Helix-ish shape it expects. Kick's
  // verified checkmark maps onto the overlay's partner badge slot - the
  // closest visual equivalent it has.
  updateStreamInfoOverlay(
    channel,
    {
      user_name: info.display_name || channel,
      title: info.title || "",
      game_name: info.category || "",
      viewer_count: typeof info.viewer_count === "number" ? info.viewer_count : undefined,
    },
    channelInfoAvatar.src,
    info.verified ? "partner" : "",
  );

  resyncChannelInfoBarVisibility();
}

/** Kick states language as a word ("English") or occasionally an ISO
 * code ("en") depending on payload era - expand codes, pass words
 * through. */
export function languageLabel(lang) {
  const s = String(lang).trim();
  if (!s) return "";
  if (s.length > 3) return s; // already a word
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(s.toLowerCase()) || s;
  } catch {
    return s;
  }
}

/**
 * Keeps the viewer count (and anything else Helix reports) fresh while
 * watching, on the same 60s cadence as the home feed. Without it the bar
 * would freeze at whatever the count was the instant playback started,
 * for the whole session.
 *
 * @param {string} channel
 * @param {() => boolean} isStillCurrent - re-checked every tick; the
 *   caller owns the definition of "still watching this channel," since
 *   that depends on playback state this module can't see.
 */
export function startChannelInfoRefresh(channel, isStillCurrent) {
  if (channelInfoRefreshTimer) clearInterval(channelInfoRefreshTimer);
  channelInfoRefreshTimer = setInterval(() => {
    if (!isStillCurrent()) return;
    invoke("get_stream_for_login", { login: channel })
      .then((json) => updateChannelInfoBar(channel, JSON.parse(json)))
      .catch((err) => console.error("Failed to refresh channel info bar:", err));
  }, 60_000);
}

export function hideChannelInfoBar() {
  channelInfoBar.style.display = "none";
  lastChannelInfo = null;
  streamInfoOverlay.classList.add("empty");
  if (channelInfoRefreshTimer) {
    clearInterval(channelInfoRefreshTimer);
    channelInfoRefreshTimer = null;
  }
}

// Re-show/hide the info bar from whatever it last rendered, no re-fetch (for
// switchPage, the back-to-stream pill, and updateChannelInfoBar). Gated on
// session.intendedChannel (set synchronously in watchChannel), not
// session.playing (only true once start_stream resolves) - gating on the latter
// held the whole bar behind the stream-launch wait even though the Helix data
// was already known. No-ops if nothing has rendered yet.
export function resyncChannelInfoBarVisibility() {
  if (!lastChannelInfo) return;
  channelInfoBar.style.display = session.intendedChannel !== null && !session.pageVisible ? "flex" : "none";
}

/** 1x1 transparent pixel, used so the avatar <img> never shows a broken-
 * image icon while a fresh one is loading or none is available - same
 * fallback used for avatars in home.js/browse.js/sidebar.js. */
export function blankAvatarDataUri() {
  return "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
}

// Same "intercept the click, call openUrl()" pattern as dropsBannerLink
// above and for the same reason: target="_blank" alone does nothing inside
// a Tauri webview. Both buttons just link out to the real channel page -
// see the CSS comment on .channel-info-follow-btn/.channel-info-subscribe-
// -btn in index.html for why these aren't real in-app Follow/Subscribe
// actions (the OAuth scope this app requests doesn't include the
// write permissions that would actually require).
for (const btn of [channelInfoFollowBtn, channelInfoSubscribeBtn]) {
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    // Kick sessions: Follow is an in-app toggle (local follow list; the
    // sidebar's Following section re-renders via onKickFollowsChange).
    // Subscribe still links out - there's no local equivalent of a paid
    // sub, and Twitch mode keeps both as link-outs exactly as before.
    if (btn === channelInfoFollowBtn && lastChannelInfo?.kick) {
      const slug = lastChannelInfo.channel;
      const nowFollowed = toggleKickFollow(slug, {
        name: lastChannelInfo.displayName || slug,
        avatar: lastChannelInfo.avatar || "",
      });
      btn.textContent = nowFollowed ? "Following" : "Follow";
      btn.classList.toggle("is-following", nowFollowed);
      return;
    }
    openUrl(btn.href).catch((err) => {
      console.error("Failed to open channel link in browser:", err);
    });
  });
}

/** "Link Kick" (Twitch info bar): shows/edits this Twitch channel's
 * Kick failover alias (kick-aliases.js). Label reflects state - "Link
 * Kick" when unset, "Kick: <slug>" when set. Clicking swaps the button
 * for a small inline input: Enter saves (empty clears), Escape cancels,
 * blur commits. No modal - window.prompt is unreliable inside Tauri
 * webviews, and an inline field keeps the interaction on the bar. */
export function refreshKickAliasBtn(channel) {
  // Mid-edit (inline input open), leave everything alone - the info
  // bar re-populates on a 60s timer, and yanking the button back in
  // next to the open editor (or racing its pending commit) would be
  // worse than a one-tick-stale label. finish() re-runs this anyway.
  if (channelInfoKickAliasBtn.nextElementSibling?.classList?.contains("channel-info-alias-input")) {
    return;
  }
  channelInfoKickAliasBtn.style.display = "";
  const alias = getKickAlias(channel);
  channelInfoKickAliasBtn.textContent = alias ? `Kick: ${alias}` : "Link Kick";
  channelInfoKickAliasBtn.classList.toggle("has-alias", Boolean(alias));
  _afterAliasBtnRefresh(); // dev "Test failover" button tracks this button's visibility
}

channelInfoKickAliasBtn.addEventListener("click", () => {
  if (!lastChannelInfo || lastChannelInfo.kick) return;
  const channel = lastChannelInfo.channel;
  // Already editing? (input present right after the button)
  if (channelInfoKickAliasBtn.nextElementSibling?.classList?.contains("channel-info-alias-input")) {
    return;
  }
  const input = document.createElement("input");
  input.type = "text";
  input.className = "channel-info-alias-input";
  input.placeholder = "kick channel name";
  input.value = getKickAlias(channel) || "";
  input.spellcheck = false;
  channelInfoKickAliasBtn.style.display = "none";
  channelInfoKickAliasBtn.after(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    if (commit) {
      const ok = setKickAlias(channel, input.value);
      if (!ok) {
        setStatus(`"${input.value.trim()}" isn't a valid Kick channel name`);
      } else if (input.value.trim()) {
        setStatus(`Kick failover for ${channel} set to ${input.value.trim().toLowerCase()}`);
      } else {
        setStatus(`Kick failover link for ${channel} cleared`);
      }
    }
    input.remove();
    refreshKickAliasBtn(channel);
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish(true);
    else if (e.key === "Escape") finish(false);
    e.stopPropagation(); // keep player shortcuts out of the field
  });
  input.addEventListener("blur", () => finish(true));
});

// Videos button: open the VODs page in-app for the currently-playing channel.
channelInfoVideosBtn.addEventListener("click", () => {
  if (!lastChannelInfo) return;
  const channel = lastChannelInfo.channel;
  session.vodsChannel = channel;
  // Which platform's listing to fetch: the Kick info bar stamps
  // lastChannelInfo with kick:true (updateKickChannelInfoBar); the
  // Twitch bar never sets it. Remembered in session.vodsChannelIsKick so every
  // later re-open of the page (tab restore, VOD-error fallback) keeps
  // fetching from the right place.
  session.vodsChannelIsKick = Boolean(lastChannelInfo.kick);
  switchPage("vods");
});

// target="_blank" alone does nothing here - there's no second tab to open
// into inside a Tauri webview, and Tauri blocks that navigation by default.
// Intercepting the click and calling the opener plugin's openUrl() instead
// is what actually hands the URL off to the user's real default browser.
// (href is still set normally in updateDropsBanner() above so the link
// remains a genuine, right-click-copyable <a> - this only changes what
// happens on a left-click.)
