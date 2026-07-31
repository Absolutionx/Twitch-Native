import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { getCurrentWindow, currentMonitor, availableMonitors, cursorPosition } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { TwitchChat } from "./chat.js";
import { PlaybackControls } from "./playback-controls.js";
import { TwitchAuth } from "./auth.js";
import { ChannelsSidebar } from "./sidebar.js";
import { isKickFollowed, toggleKickFollow } from "./kick-follows.js";
import { getKickAlias, setKickAlias, kickSlugFor } from "./kick-aliases.js";
import { HomeFeed } from "./home.js";
import { BrowsePage } from "./browse.js";
import { isKick, togglePlatform, onPlatformChange, setPlatform } from "./platform.js";
import { VodsPage } from "./vods.js";
import { streamHasDropsEnabled } from "./drops.js";
import { session } from "./session.js";
import { rememberSession, forgetSession, restoreSession } from "./session-restore.js";
import { formatViewerCount } from "./format.js";
import { checkStreamDeps } from "./deps-banner.js";
import { checkForUpdate } from "./update-banner.js";
import { MultiView } from "./multiview.js";
import { updateDropsBanner, hideDropsBanner, resetDropsDismissal } from "./drops-banner.js";
import {
  initLayout, switchPage, updateBackToStreamBtn, setTheaterMode,
  toggleTheaterModeAndResync, toggleChatCollapse, toggleFullscreen,
  isAppFullscreen,
} from "./layout.js";
import {
  initChannelInfoBar, setAfterAliasBtnRefresh, channelInfoKickAliasBtn,
  updateChannelInfoBar, updateKickChannelInfoBar, updateStreamInfoOverlay,
  hideChannelInfoBar, resyncChannelInfoBarVisibility, refreshKickAliasBtn,
  startChannelInfoRefresh,
} from "./channel-info-bar.js";

const channelInput = document.getElementById("channel-input");
const watchBtn = document.getElementById("watch-btn");
const loginBtn = document.getElementById("login-btn");
const statusText = document.getElementById("status-text");
const videoPlaceholder = document.getElementById("video-placeholder");
const chatMessages = document.getElementById("chat-messages");
const chatStatus = document.getElementById("chat-status");
const chatInput = document.getElementById("chat-input");
const chatSendBtn = document.getElementById("chat-send-btn");
const appEl = document.getElementById("app");
const theaterBtn = document.getElementById("theater-btn");
const chatCollapseToggle = document.getElementById("chat-collapse-toggle");
const chatExpandStrip = document.getElementById("chat-expand-strip");
const fullscreenBtn = document.getElementById("fullscreen-btn");
const appWindow = getCurrentWindow();
const homeTab = document.getElementById("home-tab");
const browseTab = document.getElementById("browse-tab");
const backToStreamBtn = document.getElementById("back-to-stream-btn");
// Hook run at the end of refreshKickAliasBtn and wherever the alias
// button's visibility changes. No-op in production; the DEV-only "Test
// failover" button installs one to mirror its own visibility to the
// alias button's (both are Twitch-session-only).
// Tracks which channel's VODs the vods page was opened for, so the
// Videos button re-opens correctly after navigating away and back.
// Whether session.vodsChannel is a Kick slug (Videos clicked on a Kick session)
// rather than a Twitch login - passed to every vodsPage.show() so the
// page fetches from the right platform on every (re-)open.

// Tracks the in-progress VOD for the currently-watched live channel, enabling
// live-DVR (seeking further back than the MSE buffer by switching to HLS.js on
// the recording VOD). Populated by watchChannel() after the stream starts,
// cleared on stop/channel switch. { videoId, streamStartedAt (epoch ms) }
// Prefetched VOD m3u8 URL for live-DVR, resolved as soon as session.liveDvrInfo is
// known rather than at seek time — avoids spawning+waiting on a streamlink
// process synchronously when the user actually clicks back into the
// buffer. Keyed by videoId+quality so a stale entry (e.g. after a quality
// change) is never used; invalidated to null whenever either changes.
// Throttle guard for onLiveDvrClamped's status message (see below) - last
// time we told the user a Kick seek clamped instead of reaching where they
// clicked, so a drag across the seek bar doesn't spam setStatus() on every
// intermediate mousemove/click.

/** Resolves and caches the DVR VOD's m3u8 URL in the background. Safe to
 * call speculatively (e.g. right after session.liveDvrInfo becomes available, or
 * after a quality change) — failures are silent since onLiveDvrSeek falls
 * back to resolving synchronously if the cache misses. */
function prefetchLiveDvrM3u8() {
  if (!session.liveDvrInfo) return;
  const { videoId } = session.liveDvrInfo;
  const quality = session.currentQuality;
  invoke("get_vod_m3u8_url", { videoId, quality })
    .then(url => {
      // Guard: only cache if still relevant (channel/VOD/quality unchanged
      // while the request was in flight).
      if (session.liveDvrInfo?.videoId === videoId && session.currentQuality === quality) {
        session.liveDvrM3u8Cache = { videoId, quality, url };
        console.log(`[live-dvr] prefetched m3u8 for id=${videoId} quality=${quality}`);
      }
    })
    .catch(err => {
      console.log(`[live-dvr] prefetch failed (will resolve on demand instead): ${err}`);
    });
}
// Set synchronously at the top of watchChannel (before any await), so a
// late-resolving Helix lookup for a previous channel can't stomp the info bar
// after the user has switched. Distinct from playbackControls.currentChannel,
// which isn't set until start() succeeds.
// Non-null while failed over to a Kick simulcast (see tryKickFailover).
// { channel }; cleared on any new session or a successful Twitch start.
// Quality streamlink was last launched with, so a quality change knows what
// to pass to a fresh start (switching quality relaunches streamlink).

const chat = new TwitchChat({
  container: chatMessages,
  statusEl: chatStatus,
  inputEl: chatInput,
  sendBtn: chatSendBtn,
});
// AutoMod toggle button lives in static HTML, so its click handler is wired
// here; chat.js still owns its visibility/count badge.
const automodToggleBtn = document.getElementById("automod-toggle-btn");
automodToggleBtn?.addEventListener("click", () => chat.toggleAutomodPanel());
// Low-latency mode persists across sessions. Only applies to live streams.


/**
 * Background-resolves a LOW quality playlist for the current VOD and
 * caches it for the PiP window. Exists because the URL the main player
 * runs on is a single-variant MEDIA playlist for whatever quality the
 * user is watching (streamlink resolves one quality, not a master
 * playlist) - confirmed by "[pip:hls] manifest parsed (1 levels)" in a
 * field log, which is why capLevelToPlayerSize could do nothing for the
 * PiP: with one level there's nothing to cap to. So the ~480px PiP was
 * pulling source-quality segments (the +5s manifest->first-fragment gap
 * in the same log). Resolving here, in the background at VOD start,
 * means the ~2-4s streamlink spawn is paid once per VOD while nothing
 * is waiting on it, and every PiP open gets right-sized segments for
 * free. PiP falls back to the main-quality URL if this failed or the
 * cached URL goes stale (see pip.js).
 */
function resolvePipVodUrl(videoId, currentM3u8Url) {
  const key = `pipVodLowUrl:${videoId}`;
  try {
    const cached = JSON.parse(localStorage.getItem(key) || "null");
    // "Fresh" must mean fresh for THIS app session, not just recent:
    // these URLs point at the app's own localhost HLS proxy, whose port
    // is ephemeral per launch - a cached URL that outlives the session
    // that minted it points at a dead port (confirmed in the field:
    // PiP's hls.js spinning on ERR_CONNECTION_REFUSED against a stale
    // 127.0.0.1 port after an app restart). The current main-player URL
    // comes from this session by construction, so matching ports is the
    // session check.
    const samePort = cached?.url && currentM3u8Url &&
      new URL(cached.url).port === new URL(currentM3u8Url).port;
    if (samePort && Date.now() - cached.ts < 3 * 3600_000) return; // still fresh AND this session
  } catch (_) {}
  invoke("get_vod_m3u8_url", { videoId, quality: "480p,360p,worst" })
    .then((url) => {
      localStorage.setItem(key, JSON.stringify({ url, ts: Date.now() }));
      console.log(`[main] pre-resolved low-quality VOD playlist for PiP (${videoId})`);
    })
    .catch((err) => {
      console.warn("[main] PiP low-quality VOD pre-resolve failed (PiP will use the main-quality URL):", err);
    });
}

// Auto-recovery guard for onStreamDead below: allow a burst of restart
// attempts (network blips usually recover on the first), but a relay
// that dies immediately after every restart means something is actually
// wrong (channel went offline, streamlink broke) - give up after 4
// attempts inside a 2-minute window rather than restart-looping forever.
// Any 2 minutes of health resets the budget.

/**
 * Schedules the next Twitch relay reconnect after a stream death that
 * ISN'T a Kick-simulcast handoff (onStreamDead checks Kick first). Holds
 * the backoff ladder that used to live inline in onStreamDead; extracted
 * so the up-front Kick check can defer to it. After the retry budget is
 * spent it makes one final failover attempt as a safety net (covers a
 * Kick stream that only came online partway through the retries).
 */
function scheduleTwitchReconnect(reason) {
  if (session.streamRecoveryAttempts >= 4) {
    // Out of Twitch retries. Last-ditch: maybe Kick came up during the
    // retries (streamer restarted on Kick a beat after ending Twitch).
    tryKickFailover(session.intendedChannel).then((switched) => {
      if (!switched) setStatus("Stream connection lost - unable to recover automatically.");
    });
    return;
  }
  session.streamRecoveryAttempts++;
  session.lastStreamRecoveryAt = Date.now();
  const delaySecs = Math.min(2 * session.streamRecoveryAttempts, 10);
  setStatus(`Stream connection lost (${reason}) - reconnecting in ${delaySecs}s…`);
  const channelAtDeath = session.intendedChannel;
  setTimeout(() => {
    // Re-validate: the user may have stopped playback or switched
    // channels during the delay, in which case this recovery belongs to
    // a session that no longer exists.
    if (session.playing && session.intendedChannel === channelAtDeath && !session.intendedChannel.startsWith("vod:")) {
      console.warn(`[main] auto-restarting stream after relay death (attempt ${session.streamRecoveryAttempts})`);
      restartStreamWithQuality(session.currentQuality, { auto: true });
    }
  }, delaySecs * 1000);
}

// Stream-death handler: fail over to Kick or reconnect Twitch. Named so the
// dev trigger below can exercise the exact production path.
// Single source of truth for "did the Twitch broadcast actually end?" The
// relay signals offline two ways (streamlink's "No playable streams", or
// "closed its output without producing any data"); both mean ended. Byte
// silence ("no bytes for 20s") is deliberately excluded - it's ambiguous with
// a blip and goes to the retry ladder. \bended\b is anchored so it doesn't
// match "appended" from the stall watchdog.
// Guard against overlapping probes (checkForStall is on a timer).
let _endedProbeInFlight = false;

/** DEV ONLY: channel the "Test failover" button wants the ended-probe to
 * report as offline. Twitch won't end a stream on request, so this is the
 * one fact the test has to supply - everything else it triggers for real. */
let _devForceOfflineFor = null;

// Relay went quiet (5s) but isn't declared dead yet. Ask Helix, which is
// authoritative and fast: no stream object -> ended, fail over to Kick now;
// still live -> a blip, do nothing (onDead's 20s verdict + retry ladder still
// run). Only ever acts on a definite end, so a wrong guess never tears down a
// working stream.
async function handleStreamSilent(secs) {
  if (_endedProbeInFlight) return;
  if (!session.playing || !session.intendedChannel) return;
  if (session.intendedChannel.startsWith("vod:")) return;
  if (session.kickFailover) return; // already on Kick

  const channelAtSilence = session.intendedChannel;
  _endedProbeInFlight = true;
  try {
    let stream;
    if (_devForceOfflineFor === channelAtSilence) {
      console.warn(`[test] forcing Helix verdict to OFFLINE for ${channelAtSilence}`);
      stream = null;
    } else {
      const raw = await invoke("get_stream_for_login", { login: channelAtSilence });
      stream = JSON.parse(raw);
    }
    // Helix returns no stream object for an offline channel.
    if (stream) return; // still live -> a blip, not an end. Let it ride.

    // Re-validate: the probe took real time, and the user may have stopped
    // or switched channels in the meantime.
    if (!session.playing || session.intendedChannel !== channelAtSilence) return;

    console.warn(
      `[main] relay silent ${secs}s and Helix reports ${channelAtSilence} offline - stream ended, failing over now`,
    );
    if (await tryKickFailover(channelAtSilence)) return;
    // No Kick simulcast: this IS the end, so say so rather than leaving a
    // frozen frame until the 20s timeout fires.
    setStatus(`${channelAtSilence} has ended the stream.`);
  } catch (err) {
    // Probe failed (network, rate limit). Not evidence of anything - fall
    // through to the existing onDead/retry path.
    console.warn("[main] stream-ended probe failed:", err);
  } finally {
    _endedProbeInFlight = false;
  }
}

function looksLikeStreamEnded(text) {
  return /No playable streams|closed its output without producing any data|offline|stream ended|\bended\b|404|not found/i.test(
    String(text || ""),
  );
}

function handleStreamDead(reason) {
  if (!session.playing || !session.intendedChannel || session.intendedChannel.startsWith("vod:")) return;
  const now = Date.now();
  if (now - session.lastStreamRecoveryAt > 120_000) session.streamRecoveryAttempts = 0;

  // Before spending retries, check whether this is the Twitch stream ending
  // with a Kick simulcast still live (the xQc case). Only runs when the death
  // looks like a genuine end (streamlink/relay reporting offline, not a mid-
  // stream read error), so a real blip falls through to the retry ladder;
  // scheduleTwitchReconnect's final failover still catches a true end later.
  const looksEnded = looksLikeStreamEnded(reason);
  if (session.streamRecoveryAttempts === 0 && looksEnded) {
    const channelAtDeath = session.intendedChannel;
    tryKickFailover(channelAtDeath).then((switched) => {
      if (switched) return; // now session.playing Kick - done
      // Not on Kick (or lookup failed): resume the normal Twitch
      // reconnect path, but only if this session is still the live one
      // and nothing else already advanced the retry state meanwhile.
      if (
        session.playing &&
        session.intendedChannel === channelAtDeath &&
        !session.intendedChannel.startsWith("vod:") &&
        session.streamRecoveryAttempts === 0
      ) {
        scheduleTwitchReconnect(reason);
      }
    });
    return;
  }

  scheduleTwitchReconnect(reason);
}

const playbackControls = new PlaybackControls({
  onQualityChange: (quality) => restartStreamWithQuality(quality),
  // The live relay source died (streamlink exited, network dropped -
  // see attachMseStream's onDead). Previously NOTHING handled this in
  // any way: the video froze on its last frame indefinitely, which
  // together with the chat client's old no-reconnect behavior is why a
  // single network blip made "live stream and live chat just stop."
  // Chat now reconnects on the Rust side; this is the video half.
  onStreamDead: (reason) => handleStreamDead(reason),
  onStreamSilent: (secs) => handleStreamSilent(secs),
  onLowLatencyChange: (enabled) => {
    session.lowLatency = enabled;
    localStorage.setItem("lowLatency", enabled);
    if (session.playing && session.intendedChannel && !session.intendedChannel.startsWith("vod:")) {
      restartStreamWithQuality(session.currentQuality);
    }
  },
  onSeek: (newPositionSeconds) => chat.notifyVodSeek(newPositionSeconds),
  // Live-DVR: fires when the user seeks past the MSE buffer start (wants to
  // go further back than the ~2 minute live buffer), or when they click the
  // Live button while in DVR mode (secondsBehindLive = 0 means "go live").
  onLiveDvrSeek: async (secondsBehindLive) => {
    if (!session.liveDvrInfo || !session.intendedChannel || session.intendedChannel.startsWith("vod:")) return;

    // ── Kick session (liveDvrInfo armed by resolveKickDvr) ─────────────
    // Same seek-bar semantics as Twitch's path below, minus everything
    // Twitch-specific: the recording URL is already resolved and proxied
    // (no streamlink step, no m3u8 cache), "go live" re-attaches the
    // live playlist instead of the MSE relay, and chat deliberately
    // STAYS on live Kick chat - there is no Kick chat-replay API to
    // rewind alongside the video the way chat.setVodMode does for
    // Twitch VODs.
    if (session.liveDvrInfo.kick) {
      // In a failover session intendedChannel is the TWITCH name; the
      // player/chat/DVR all belong to the Kick slug the session
      // actually attached (session.kickFailover.channel). Using the Twitch name
      // here would, with an alias set, restart the player under a
      // different channel key (wiping the session's quality pick, among
      // other per-channel state).
      const kickSlug = session.kickFailover?.channel || session.intendedChannel;
      if (secondsBehindLive <= 0) {
        if (playbackControls._liveDvr) {
          playbackControls._liveDvr = null;
          const saved = session.liveDvrInfo;
          setStatus(`Returning to live…`);
          // startKick re-runs the per-session reset (including wiping
          // liveDvrStreamStartedAt and kickDvrAvailable) - restore the
          // pieces that still describe this same, continuing session.
          playbackControls.startKick(kickSlug, saved.liveUrl);
          playbackControls.liveDvrStreamStartedAt = saved.streamStartedAt;
          playbackControls.kickDvrAvailable = true;
          session.liveDvrInfo = saved;
          setStatus(`Now playing ${kickSlug} on Kick`);
        }
        return;
      }
      const { vodUrl, streamStartedAt } = session.liveDvrInfo;
      const streamElapsedSecs = (Date.now() - streamStartedAt) / 1000;
      // Same live-to-recording lag allowance as the Twitch path below -
      // Kick's IVS recordings trail the live edge by a comparable
      // 30-60s, and overshooting the recording's end stalls hls.js.
      const KICK_VOD_LIVE_DELAY_SECS = 45;
      const vodOffset = Math.max(0, streamElapsedSecs - secondsBehindLive - KICK_VOD_LIVE_DELAY_SECS);
      setStatus(`Loading DVR…`);
      playbackControls._liveDvr = { channel: kickSlug, videoId: null, streamStartedAt };
      playbackControls.attachHlsDvr(vodUrl, vodOffset);
      setStatus(`DVR: ${kickSlug} (Kick — chat stays live)`);
      return;
    }

    if (secondsBehindLive <= 0) {
      // "Go live": tear down HLS.js, reconnect the MSE relay.
      if (playbackControls._liveDvr) {
        playbackControls._liveDvr = null;
        const channel = session.intendedChannel;
        try {
          setStatus(`Returning to live…`);
          const relayUrl = await invoke("start_stream", { channel, quality: session.currentQuality, lowLatency: session.lowLatency });
          playbackControls.attachLiveMse(relayUrl);
          // Switch chat back from VOD replay to live IRC
          await chat.connect(channel);
          setStatus(`Playing: ${channel}`);
        } catch (err) {
          console.error("Failed to return to live:", err);
          setStatus(`Error returning to live: ${err}`);
        }
      }
      return;
    }

    // Seek further back than the buffer: switch to HLS.js on the live VOD.
    const { videoId, streamStartedAt } = session.liveDvrInfo;
    const streamElapsedSecs = (Date.now() - streamStartedAt) / 1000;
    // Add 45s to account for the typical VOD-to-live delay (VOD is usually
    // 30-60s behind the live edge), clamped to 0 so we never request a
    // negative offset. Without this the HLS.js position would be 45s ahead
    // of where the content actually is in the recording.
    const VOD_LIVE_DELAY_SECS = 45;
    const vodOffset = Math.max(0, streamElapsedSecs - secondsBehindLive - VOD_LIVE_DELAY_SECS);

    try {
      const cached = session.liveDvrM3u8Cache;
      const cacheHit = cached && cached.videoId === videoId && cached.quality === session.currentQuality;
      // Only the uncached path actually spawns a streamlink process and
      // waits on it, so only that path needs a distinct status - on a
      // cache hit we go straight to "DVR:" once attached, same as before.
      setStatus(cacheHit ? `Loading DVR…` : `Resolving DVR…`);
      const m3u8Url = cacheHit
        ? cached.url
        : await invoke("get_vod_m3u8_url", { videoId, quality: session.currentQuality });
      playbackControls._liveDvr = { channel: session.intendedChannel, videoId, streamStartedAt };
      playbackControls.attachHlsDvr(m3u8Url, vodOffset);
      resolvePipVodUrl(videoId, m3u8Url);
      // Switch chat to VOD replay, using the channel login for badge
      // loading. vodOffset (not the default 0) tells chat replay where
      // playback is actually landing - see setVodMode's comment on
      // initialPositionSecs for why this matters for long streams.
      await chat.setVodMode(videoId, () => playbackControls.lastKnownPosition, session.intendedChannel, vodOffset);
      setStatus(`DVR: ${session.intendedChannel}`);
    } catch (err) {
      console.error("Failed to enter live-DVR mode:", err);
      setStatus(`DVR error: ${err}`);
      playbackControls._liveDvr = null;
    }
  },
  // Fires only for Kick sessions WITHOUT a resolved DVR recording
  // (kickDvrAvailable false: channel has VODs disabled, or
  // resolveKickDvr couldn't find/resolve this session's recording) -
  // sessions WITH one route past-buffer seeks into onLiveDvrSeek above
  // instead. In the no-DVR case seekToClickPosition/seekRelative clamp
  // at the earliest buffered point; that clamp used to be silent, so
  // clicking anywhere in the (visually full-broadcast) seek bar beyond
  // the last ~1-2 minutes just looked like a tiny, seemingly arbitrary
  // rewind with no explanation. Surface it instead. Throttled since a
  // single drag or a few quick clicks would otherwise fire this on
  // every mousemove/click and spam the status line.
  onLiveDvrClamped: ({ landedSecondsBehindLive }) => {
    const now = Date.now();
    if (now - session.lastLiveDvrClampNoticeAt < 4000) return;
    session.lastLiveDvrClampNoticeAt = now;
    const behind = playbackControls.formatDuration(Math.round(landedSecondsBehindLive));
    setStatus(`No DVR recording available for this Kick channel — jumped to the earliest buffered point (-${behind})`);
  },
  lowLatency: session.lowLatency,
});
// NOTE: if login happens WHILE a stream is already playing, the chat
// input gets enabled immediately, but the underlying IRC connection is
// still the original anonymous one (Twitch IRC doesn't support
// re-authenticating an existing connection - PASS only works during the
// initial handshake). Sending a message in that state will fail with a
// clear error from send_chat_message in main.rs. Stopping and restarting
// the stream after logging in picks up the new credentials correctly,
// since start_chat reads the stored auth fresh each time it's called.
// Acceptable for this PoC; a production version might auto-disconnect and
// reconnect chat on login if a stream is currently active.
const sidebar = new ChannelsSidebar({
  followedListEl: document.getElementById("followed-channels-list"),
  showMoreBtn: document.getElementById("followed-show-more-btn"),
  loginPromptEl: document.getElementById("followed-login-prompt"),
  topLiveListEl: document.getElementById("top-live-list"),
  onChannelSelect: (login, stream) => {
    channelInput.value = login;
    // Kick-sourced cards carry platform:"kick" (set by kick.rs's
    // normalizers); route those to the Kick watch path. Checked on the
    // STREAM, not just the current mode, so a click on an already-
    // rendered Kick card still goes to the right place even if the
    // toggle was flipped after the grid rendered.
    if ((stream && stream.platform === "kick") || isKick()) {
      watchKickChannel(login);
    } else {
      watchChannel(login, stream);
    }
  },
});
sidebar.init();
// The channel info bar can start a stream (clicking a card in it), change
// page (its Videos button), and write the status line - all app-shell
// concerns it can't import without a cycle, so they're handed to it here.
checkStreamDeps();
// Windows-only in practice (the check no-ops on other platforms). Fires
// once at startup; shows the update banner if a newer release exists.
checkForUpdate();

// MultiView: multi-stream grid. Opens as a full-screen overlay, seeded with
// the currently-playing channel if there is one. Self-contained (see
// multiview.js) - uses the native-HLS path per tile, so it doesn't disturb
// the main single-stream relay player.
const multiview = new MultiView();
// MultiView is a distinct "mode": while it's open we fully STOP the main
// single-stream player rather than just pausing it. Pausing/muting left the
// relay pipeline alive and could still leak audio under the grid (the
// reported double-audio); stopping is both silent and cleaner. We remember
// what was playing and restart it when MultiView closes.
let _multiviewResume = null;
const multiviewHooks = {
  onOpen: () => {
    _multiviewResume =
      session.playing && session.intendedChannel ? session.intendedChannel : null;
    try { playbackControls.stop(); } catch {}
  },
  onClose: () => {
    // Restart whatever was playing before, if anything.
    if (_multiviewResume) {
      const ch = _multiviewResume;
      _multiviewResume = null;
      try { watchChannel(ch); } catch {}
    }
  },
};
document.getElementById("multiview-tab")?.addEventListener("click", () => {
  if (multiview.isOpen) { multiview.close(); return; }
  const seed = [];
  if (session.playing && session.intendedChannel) seed.push(session.intendedChannel);
  multiview.open(seed, multiviewHooks);
  if (currentLogin) {
    multiview.setLoggedIn(currentLogin.login, currentLogin.userId, currentLogin.displayName);
  }
});
// Navigating to Home or Browse closes the grid, so those tabs always work
// even while the overlay is up (previously the overlay covered everything
// and trapped the user, escapable only via the small close button).
homeTab.addEventListener("click", () => { if (multiview.isOpen) multiview.close(); });
browseTab.addEventListener("click", () => { if (multiview.isOpen) multiview.close(); });

// Auto-PiP on tab-out (opt-in via the settings-menu toggle). When the app
// window loses focus and something is playing, pop into PiP automatically;
// re-focusing the app closes it again. Uses Tauri's window focus event, which
// (unlike window 'blur') fires only for real OS focus changes, not in-app
// focus moves. Guarded so it never fires while typing or when nothing plays.
let _autoPipActive = false;
let _autoPipPendingTimer = null;

// True if the mouse cursor is on a DIFFERENT monitor than the app window.
// Used to tell "clicked something on my other screen" (don't PiP) from
// "alt-tabbed away on this screen" (do PiP). Best-effort: if anything can't
// be resolved, returns false so auto-PiP still fires (fail-open).
async function cursorIsOnOtherMonitor() {
  try {
    const [cur, appMon, mons] = await Promise.all([
      cursorPosition(),
      currentMonitor(),
      availableMonitors().catch(() => []),
    ]);
    if (!cur || !appMon || !mons.length) return false;
    const inRect = (m) =>
      cur.x >= m.position.x && cur.x < m.position.x + m.size.width &&
      cur.y >= m.position.y && cur.y < m.position.y + m.size.height;
    const cursorMon = mons.find(inRect);
    if (!cursorMon) return false; // cursor off all screens: treat as same
    // Compare by origin (monitors are uniquely placed on the virtual desktop).
    return cursorMon.position.x !== appMon.position.x ||
           cursorMon.position.y !== appMon.position.y;
  } catch {
    return false;
  }
}

appWindow.onFocusChanged(async ({ payload: focused }) => {
  if (localStorage.getItem("autoPipOnBlur") !== "1") return;

  if (!focused) {
    if (_autoPipActive) return;
    // Don't fire when the focus loss was caused by us opening a PiP window
    // (creating a Tauri window steals focus) - otherwise a manual pop-out
    // cascades into popping out every remaining tile.
    if (multiview.isOpeningPip || playbackControls._openingPip) return;
    // Skip if the user just clicked onto another monitor (vs. genuinely
    // switching away from the app on this screen).
    if (await cursorIsOnOtherMonitor()) return;

    // Debounce: a real tab-out keeps focus away, but a screenshot-tool region
    // overlay (ShareX Ctrl+PrtScn), a notification toast, or a quick click
    // steals focus only momentarily. Wait, and only PiP if focus hasn't come
    // back. The re-focus branch below clears this timer.
    if (_autoPipPendingTimer) clearTimeout(_autoPipPendingTimer);
    _autoPipPendingTimer = setTimeout(async () => {
      _autoPipPendingTimer = null;
      // Re-check guards at fire time (state may have changed during the wait).
      if (_autoPipActive) return;
      if (multiview.isOpeningPip || playbackControls._openingPip) return;
      if (multiview.isOpen) {
        if (multiview.focusedChannel) {
          await multiview.popOutToNativePip(multiview.focusedChannel);
          _autoPipActive = true;
        }
      } else if (session.playing) {
        try { await playbackControls.enterNativePip(); _autoPipActive = true; } catch {}
      }
    }, 600);
  } else {
    // Focus came back. Cancel a pending PiP (the blip was brief - screenshot,
    // toast, etc.), and close any auto-PiP we did open.
    if (_autoPipPendingTimer) { clearTimeout(_autoPipPendingTimer); _autoPipPendingTimer = null; }
    if (_autoPipActive) {
      _autoPipActive = false;
      if (!multiview.isOpen) { try { playbackControls.closePipAnyTier?.(); } catch {} }
    }
  }
});

// Show the running app version in the window title, so which build is
// live is visible at a glance (handy for verifying an update actually
// applied). getVersion() reads the version baked in from tauri.conf.json.
getVersion()
  .then((v) => appWindow.setTitle(`Twitch Native v${v}`))
  .catch(() => {}); // non-fatal: title just stays the static default
setInterval(maybeSaveVodProgress, 15_000);

// DEBUG/TESTING ONLY - lets you trigger a real go-live notification from
// the devtools console without waiting for an opted-in channel to
// actually go live. Goes through the actual production detection/
// notification code (see debugTestGoLiveNotification in sidebar.js), not
// a hand-rolled sendNotification() call - so a successful test here is a
// real signal the feature works end to end, not just that OS
// notifications work at all.
//
// Usage from devtools console:
//   window.__testGoLiveNotification()              - first opted-in channel
//   window.__testGoLiveNotification('somechannel')  - a specific one
window.__testGoLiveNotification = (login) => sidebar.debugTestGoLiveNotification(login);

// DEBUG/TESTING ONLY - simulate the current Twitch stream ENDING, to
// test the Kick failover without waiting hours for a real stream to end.
// Feeds a genuine end-reason string into the REAL handler
// (handleStreamDead), so this exercises the actual detection +
// tryKickFailover + alias path end to end - a pass here is a real pass.
// Requires a Twitch stream to be playing (that's what "ends"); on a Kick
// or VOD session it no-ops with a note.
//
// Usage from devtools console:
//   window.__testTwitchStreamEnd()
function testTwitchStreamEnd() {
  if (!session.playing || !session.intendedChannel || session.intendedChannel.startsWith("vod:")) {
    console.warn("[test] Not watching a live Twitch stream - nothing to end.");
    setStatus("Test: not watching a live Twitch stream");
    return;
  }
  if (isKick() || session.kickFailover) {
    console.warn("[test] Already on a Kick session - the failover only runs from a live Twitch stream.");
    setStatus("Test: already on Kick - watch a Twitch stream first");
    return;
  }
  // Simulate the CAUSE, not the conclusion: starve the byte stream as an ended
  // broadcast does and let production code reach its own verdict through the
  // real path (simulateSilence -> checkForStall -> handleStreamSilent ->
  // ended-probe -> tryKickFailover). The only supplied fact is Helix's verdict
  // (_devForceOfflineFor), since Twitch won't end a stream on cue.
  console.warn(
    `[test] Starving the relay for ${session.intendedChannel} - the real detector should ` +
    `notice ~5s of silence, probe Helix (forced OFFLINE), and fail over to Kick.`,
  );
  session.streamRecoveryAttempts = 0;
  _devForceOfflineFor = session.intendedChannel;
  setStatus("Test: simulating stream end (waiting for the real detector…)");
  playbackControls.simulateRelaySilence();
}
window.__testTwitchStreamEnd = testTwitchStreamEnd;

// Dev-only visible button on the Twitch channel info bar - same trigger
// as the console helper, just faster to hit repeatedly. import.meta.env.DEV
// is true under `vite dev` and compiled OUT of production builds, so this
// button (and its listener) simply don't exist in a release binary.
if (import.meta.env?.DEV) {
  const testEndBtn = document.createElement("button");
  testEndBtn.id = "channel-info-test-end-btn";
  testEndBtn.className = "channel-info-videos-btn";
  testEndBtn.textContent = "⚡ Test failover";
  testEndBtn.title = "DEV: simulate this Twitch stream ending, to test Kick failover";
  testEndBtn.style.borderColor = "#e0b000";
  testEndBtn.style.color = "#e0b000";
  testEndBtn.addEventListener("click", () => testTwitchStreamEnd());
  // Sits next to Videos/Link Kick; only meaningful on a Twitch session,
  // so it hides on Kick sessions the same way the alias button does.
  channelInfoKickAliasBtn.after(testEndBtn);
  // Keep its visibility in lockstep with the alias button (both are
  // Twitch-only). refreshKickAliasBtn runs this hook at its end, so this
  // tracks the alias button's display without patching the function.
  const syncTestBtn = () => {
    testEndBtn.style.display = channelInfoKickAliasBtn.style.display;
  };
  setAfterAliasBtnRefresh(syncTestBtn);
  syncTestBtn();
}

const homeFeed = new HomeFeed({
  containerEl: document.getElementById("home-feed"),
  onChannelSelect: (login, stream) => {
    channelInput.value = login;
    // Kick-sourced cards carry platform:"kick" (set by kick.rs's
    // normalizers); route those to the Kick watch path. Checked on the
    // STREAM, not just the current mode, so a click on an already-
    // rendered Kick card still goes to the right place even if the
    // toggle was flipped after the grid rendered.
    if ((stream && stream.platform === "kick") || isKick()) {
      watchKickChannel(login);
    } else {
      watchChannel(login, stream);
    }
  },
});

const browsePage = new BrowsePage({
  containerEl: document.getElementById("browse-page"),
  onChannelSelect: (login, stream) => {
    channelInput.value = login;
    // Kick-sourced cards carry platform:"kick" (set by kick.rs's
    // normalizers); route those to the Kick watch path. Checked on the
    // STREAM, not just the current mode, so a click on an already-
    // rendered Kick card still goes to the right place even if the
    // toggle was flipped after the grid rendered.
    if ((stream && stream.platform === "kick") || isKick()) {
      watchKickChannel(login);
    } else {
      watchChannel(login, stream);
    }
  },
});

// IMPORTANT: both homeFeed and browsePage toggle the same shared
// #video-frame element's visibility in their own show()/hide() (since
// only one of {video, home feed, browse page} is ever visible at a time).
// Calling hide() after show() on a DIFFERENT instance would stomp on
// whichever one should actually end up visible, since they're fighting
// over the same element - browsePage.hide() must come BEFORE
// homeFeed.show(), not after, so home feed's "hide the video frame" call
// is the one that actually sticks.
const vodsPage = new VodsPage({
  containerEl: document.getElementById("vods-page"),
  videoFrameEl: document.getElementById("video-frame"),
  onVodSelect: (videoId, totalSeconds, broadcastLogin, startOffsetSeconds) => {
    // Kick cards carry "kick:<uuid>" ids (see kick_channel_videos in
    // kick.rs) - route those to the Kick VOD path; everything else is a
    // Twitch archive id and takes the original path unchanged.
    if (String(videoId).startsWith("kick:")) {
      watchKickVod(videoId, totalSeconds, startOffsetSeconds);
    } else {
      watchVod(videoId, totalSeconds, broadcastLogin, startOffsetSeconds);
    }
  },
});

browsePage.hide();
// Hand the extracted modules the collaborators they can't import without
// a cycle. Must run AFTER the page objects above exist (they're `const`s,
// so referencing them any earlier is a temporal-dead-zone ReferenceError)
// and before any click handler can fire.
initLayout({
  homeFeed,
  browsePage,
  vodsPage,
  getCurrentChannel: () => playbackControls.currentChannel,
});
initChannelInfoBar({ watchChannel, switchPage, setStatus });

vodsPage.hide();
// Reopen whatever was playing - but ONLY across an F5/reload, never across
// a genuine app launch. take_is_fresh_launch is true exactly once per
// process (see main.rs), so a reload resumes the stream while a cold start
// (close before bed, open in the morning) lands on Home rather than a
// now-offline stream. Show Home first so boot never blocks on the backend
// call; a reload then swaps the stream in a beat later.
homeFeed.show();
(async () => {
  try {
    const freshLaunch = await invoke("take_is_fresh_launch");
    if (freshLaunch) return; // cold start: stay on Home
    // Reload: replay the remembered session. It hides Home itself on
    // success; if there's nothing to restore, Home just stays put.
    restoreSession({ watchChannel, watchKickChannel, watchVod, watchKickVod });
  } catch (err) {
    console.warn("[main] fresh-launch check failed, staying on Home:", err);
  }
})();

// Tracks whichever of {home feed, browse page} is/was last shown, so the
// error-on-start and Stop paths further down can restore the correct one
// after a stream ends - without this, both would incorrectly always jump
// back to the home feed even if the user had been on the Browse page.
// Starts as "home" to match the homeFeed.show() above.

// Whether Home/Browse is the thing actually on screen right now, as
// opposed to the video (#video-frame). watchChannel() hides both pages
// directly (not through switchPage()) the moment playback starts, and from
// then on the video keeps playing in the background for as long as
// `session.playing` is true even while browsing - this was already true before
// the back-to-stream button existed, switching tabs only ever hid
// #video-frame, it never stopped playback. session.lastActivePage alone can't tell us which of
// the two is currently visible (it keeps saying "home" the whole time
// you're watching, since nothing ever changes it mid-stream), which is
// exactly why a second click on the *already*-"active" tab while watching
// used to silently no-op instead of actually bringing that page to the
// front - see the early-return guard this replaces, several lines below.

homeTab.addEventListener("click", () => switchPage("home"));
browseTab.addEventListener("click", () => switchPage("browse"));

backToStreamBtn.addEventListener("click", () => {
  if (!session.playing) return;
  // homeFeed.hide() and browsePage.hide() each restore #video-frame's
  // visibility as a side effect (see their hide() methods in home.js/
  // browse.js) - no need to touch #video-frame directly here, same as
  // switchPage() above never does either. Both calls are harmless no-ops
  // if that particular page wasn't the one currently showing.
  homeFeed.hide();
  browsePage.hide();
  vodsPage.hide();
  session.pageVisible = false;
  // Restore theater mode (switchPage turned it off on the way out - see
  // its comment) now that the video is back on screen and the sidebar
  // collapse is worth the tradeoff again.
  setTheaterMode(true);
  updateBackToStreamBtn();
  resyncChannelInfoBarVisibility();
});

// Latest Twitch login info (set on login), so views created lazily - like
// the MultiView chat - can be marked logged-in when they open.
let currentLogin = null;
const auth = new TwitchAuth({
  loginBtn,
  userMenuEl:      document.getElementById("user-menu"),
  userMenuSignout: document.getElementById("user-menu-signout"),
  statusCallback: (login, userId, displayName) => {
    chat.setLoggedIn(login, userId, displayName);
    // Remember the login so the MultiView chat (created lazily / may not
    // exist yet at first login) can be marked logged-in when it opens.
    currentLogin = { login, userId, displayName };
    if (multiview?.isOpen) multiview.setLoggedIn(login, userId, displayName);
    sidebar.onLogin();
    // homeFeed.show() at startup (above) races ahead of login completing -
    // on a fresh launch there's no token yet, so that very first fetch
    // hits Helix with no Authorization header, gets a 401, and silently
    // falls back to empty data. Without this call, the home feed never
    // tries again afterward even once a valid token exists, leaving it
    // permanently empty for the rest of the session despite login
    // succeeding moments later. refresh() re-runs the same fetch now that
    // a real token is available.
    homeFeed.refresh();
  },
});

function setStatus(text) {
  // Two kinds of non-status get no pill at all:
  //   "Idle"       - the absence of status isn't worth narrating;
  //   "Playing: x" - triple-redundant next to an input that already
  //                  reads "x" beside a button that already says Stop.
  // Playing instead lights a small live dot INSIDE the launcher (see
  // .channel-launcher.playing), so the pill is reserved for statuses
  // that carry real information: resolving, reconnecting, DVR, errors.
  const isPlayingStatus = /^Playing: /.test(text);
  statusText.textContent = (text === "Idle" || isPlayingStatus) ? "" : text;
  document.querySelector(".channel-launcher")?.classList.toggle("playing", isPlayingStatus);
}


theaterBtn.addEventListener("click", toggleTheaterModeAndResync);



chatCollapseToggle.addEventListener("click", toggleChatCollapse);
chatExpandStrip.addEventListener("click", toggleChatCollapse);

fullscreenBtn.addEventListener("click", toggleFullscreen);

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    // Both checked independently (not else-if) - theater mode and
    // fullscreen are unrelated states that can be active at the same
    // time, same as chat-collapse/header-collapse can combine with
    // either of them (see the CSS custom-property refactor for why).
    // A single Escape press exiting both at once matches what every
    // video site/app does, rather than needing two separate presses.
    if (appEl.classList.contains("theater-mode")) {
      setTheaterMode(false);
    }
    if (isAppFullscreen()) {
      toggleFullscreen();
    }
    return;
  }

  // "T" toggles theater mode, matching the official site's shortcut - but
  // only when focus isn't in a text field, so typing "t" into the channel
  // name box or chat input doesn't accidentally trigger it.
  if (e.key.toLowerCase() === "t") {
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    toggleTheaterModeAndResync();
    return;
  }

  // "F" toggles fullscreen, matching the official site's shortcut - same
  // text-field guard as "T" above.
  if (e.key.toLowerCase() === "f") {
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    toggleFullscreen();
    return;
  }

  // "M" toggles mute, matching the official site's shortcut - same
  // text-field guard as "T" above, and reuses playbackControls.toggleMute()
  // directly (the same function the mute button's own click handler
  // calls) rather than duplicating its video.muted/icon-sync logic here.
  // No separate "is anything playing" check needed: toggleMute() just sets
  // video.muted directly, which is a harmless no-op against an empty
  // <video> element if nothing's loaded yet - the same thing that already
  // happens if the mute BUTTON is clicked with nothing session.playing, so this
  // doesn't need its own guard to match.
  if (e.key.toLowerCase() === "m") {
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    playbackControls.toggleMute();
  }

  // Space bar toggles pause/play, matching the official site's shortcut.
  // Blocked when a text field is focused so typing a space in chat or the
  // channel input doesn't accidentally pause the stream.
  if (e.key === " ") {
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    e.preventDefault(); // stop the page from scrolling on space
    playbackControls.togglePause();
  }

  // ArrowLeft/ArrowRight seek backward/forward, matching the official
  // site's shortcut (5s, or 10s with Shift held - the larger step matches
  // the convention most other video sites use for a modified arrow-seek).
  // Guarded the same way as the other shortcuts above so arrow keys still
  // behave normally while typing in chat or any text field (this is also
  // why chat.js's own ArrowUp/ArrowDown history recall - a completely
  // separate feature - never conflicts: that listener is scoped to the
  // chat textarea itself and only ever sees the keypress when this
  // window-level one has already bailed out via the same tag check).
  // Seeking only makes sense once something is actually playing -
  // seekRelative() itself no-ops safely either way (videoEl.seekable is
  // empty/duration is 0 before anything's loaded), but skipping the call
  // entirely when nothing's playing avoids preventDefault()-ing the
  // arrow key's normal behavior (e.g. scrolling a focused list) for no
  // reason on pages where there's no video to seek.
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    if (!session.playing) return;
    e.preventDefault();
    const step = e.shiftKey ? 10 : 5;
    playbackControls.seekRelative(e.key === "ArrowLeft" ? -step : step);
  }
});

// Clears a stray focused text input (chat box, channel field) whenever the
// window loses focus - e.g. alt-tabbing away, clicking another app, or
// entering Picture-in-Picture (which moves focus to the OS-drawn PiP
// window). Without this, switching away and back could leave a chat input
// still "focused" but no longer actually receiving keystrokes the user
// expects to land there, silently swallowing the next keypress instead of
// an obviously-cleared field.
window.addEventListener("blur", () => {
  const tag = document.activeElement?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") {
    document.activeElement.blur();
  }
});

// Previously this file reserved a CONTROLS_BAR_HEIGHT constant and ran a
// syncVideoRegion() function that read #video-region's on-screen pixel
// rect and sent it to Rust so mpv's native window could be moved/resized
// to match. Neither is needed anymore: the controls bar is a true CSS
// overlay now, and #video-element is a normal DOM element that just
// participates in the page's own layout/sizing - there's no second
// native surface to keep in sync with it.

/**
 * Kick live-DVR resolution, called by attachKickStream for every Kick
 * session. Asks Rust (get_kick_live_dvr) for the in-progress recording
 * of the broadcast being watched; on success, arms the same
 * session.liveDvrInfo/onLiveDvrSeek machinery Twitch uses - with kick-shaped
 * state - and flips playbackControls.kickDvrAvailable so
 * seekToClickPosition/seekRelative route past-buffer seeks into the
 * swap instead of clamping. Fails soft in every case (VODs disabled on
 * the channel, recording not listed yet, no stream start time): the
 * session simply keeps the old clamp behavior, with the existing
 * onLiveDvrClamped notice explaining the limit.
 */
async function resolveKickDvr(channel, info) {
  let dvr = null;
  try {
    dvr = await invoke("get_kick_live_dvr", {
      slug: channel,
      livestreamId: info.livestream_id ?? null,
    });
  } catch (err) {
    console.log(`[kick-dvr] lookup failed (seeks will clamp to buffer): ${err}`);
    return;
  }
  if (!dvr || !dvr.proxied_vod_url) {
    console.log(`[kick-dvr] no in-progress recording for ${channel} (VODs disabled, or not listed yet)`);
    return;
  }
  // Stale guard: the user may have stopped or switched channels while
  // the two Kick lookups were in flight - same pattern as every other
  // await in the watch paths.
  // session.intendedChannel is the TWITCH name in failover/offline-entry
  // sessions, which may differ from the Kick slug via an alias - accept
  // either the direct match (Kick-mode watch) or the aliased one.
  if (
    !session.playing ||
    !session.kickFailover ||
    session.kickFailover.channel !== channel ||
    (session.intendedChannel !== channel && kickSlugFor(session.intendedChannel) !== channel)
  ) {
    return;
  }
  // The seek-bar-position -> recording-offset math needs the broadcast's
  // start wall clock; without one there's no way to know where a click
  // lands in the recording.
  const startedAtMs = info.started_at ? new Date(info.started_at).getTime() : NaN;
  if (Number.isNaN(startedAtMs)) {
    console.log("[kick-dvr] recording found but no stream start time - can't map seeks, keeping clamp behavior");
    return;
  }
  session.liveDvrInfo = {
    kick: true,
    vodUrl: dvr.proxied_vod_url, // already proxied - no resolve step at seek time
    liveUrl: info.proxied_url,   // for the "go live" return trip
    streamStartedAt: startedAtMs,
  };
  playbackControls.kickDvrAvailable = true;
  console.log(`[kick-dvr] DVR armed for ${channel}`);
}

/**
 * Shared tail of both Kick entry points (tryKickFailover for
 * mid-session stream-end, watchChannel's offline branch for entering a
 * Twitch-offline channel directly): flips the session into Kick mode,
 * attaches the feed, and swaps chat. Callers have already decided the
 * switch should happen, verified the session is still current, and
 * arranged session.playing/UI state - this does the parts common to both, so
 * the two paths always land in the identical configuration.
 */
async function attachKickStream(channel, info, statusText) {
  session.kickFailover = { channel };
  // We're on Kick now, so a reload should resume Kick - not retry the
  // Twitch channel that just ended (which would find it offline and drop
  // to Home). `channel` here is the Kick slug the failover resolved to.
  rememberSession({ kind: "kickLive", id: channel });
  // Flip the whole app into Kick mode so the chrome matches the session:
  // header reads "Kick", accent goes green, sidebar/home/browse retarget
  // to Kick - exactly the manual-toggle treatment. Without this a
  // failover (or Twitch-offline -> Kick entry) left a Kick stream session.playing
  // under a Twitch-purple header saying "Twitch", which is the mismatch
  // the manual toggle never had. setPlatform no-ops if already in Kick
  // mode (e.g. a Kick-mode direct watch), and onPlatformChange's feed
  // reloads are the right thing here too - you're on Kick now.
  setPlatform("kick");

  // Drops are a Twitch-only mechanic, so the banner must never survive a
  // hop onto Kick. watchKickChannel() already hides it on the way in, but
  // the FAILOVER path (tryKickFailover -> here) starts from a live Twitch
  // session where the banner may well be showing - and this is the shared
  // tail of both Kick entry points, so hiding it here covers both. It's a
  // no-op when the banner is already hidden.
  hideDropsBanner();
  // Clear any Twitch session's VOD-swap state - a backward seek in the
  // new Kick session must never switch the player onto the ended/stale
  // Twitch VOD these point at. resolveKickDvr below repopulates
  // session.liveDvrInfo with KICK-shaped state ({kick: true, ...}) if this
  // session's own in-progress recording can be found.
  session.liveDvrInfo = null;
  session.liveDvrM3u8Cache = null;
  playbackControls.startKick(channel, info.proxied_url);
  // Kick live-DVR: find this broadcast's in-progress recording in the
  // background (needs the videos-listing + video-source lookups, so
  // never block playback on it). Until/unless it resolves, past-buffer
  // seeks keep the clamp-with-notice behavior.
  resolveKickDvr(channel, info);
  // playbackControls.liveDvrStreamStartedAt is a SEPARATE, purely-display
  // mechanism (expands the seek bar to the full broadcast + an accurate
  // "-X:XX" behind-live readout - see pollProgress's normal-live branch)
  // that Kick can use too, unlike the VOD-swap state above: Kick's own
  // stream-start wall clock is right here in `info`, whenever kick.rs
  // managed to find one in the channel payload.
  if (info.started_at) {
    const startedAtMs = new Date(info.started_at).getTime();
    if (!Number.isNaN(startedAtMs)) {
      playbackControls.liveDvrStreamStartedAt = startedAtMs;
    }
  }
  // Swap chat over too, via chat.connectKick(): it disconnects Twitch
  // chat, RE-REGISTERS the frontend event listeners disconnect() tears
  // down (the old code here skipped that step, so the Kick client's
  // events - which ride the same "chat-message" pipeline the IRC client
  // uses - arrived with nobody listening and the pane silently stayed
  // empty), hides the input row (the Kick client is read-only), and
  // starts the Rust-side Pusher client.
  // No chatroom_id in the Kick payload -> keep Twitch chat as-is rather
  // than tearing down chat for nothing.
  if (info.chatroom_id) {
    await chat
      .connectKick(channel, info.chatroom_id, info.broadcaster_user_id, info.subscriber_badges)
      .catch((err) => console.warn("[kick] failed to start Kick chat:", err));
  }
  updateKickChannelInfoBar(channel, info);
  setStatus(statusText);
  console.warn(
    `[kick] playing Kick stream for ${channel}` +
    (info.viewer_count ? ` (${info.viewer_count.toLocaleString()} viewers)` : ""),
  );
}

// Twitch -> Kick failover: when a Twitch stream ends mid-watch, check if the
// same slug is live on Kick and swap the player onto Kick's HLS feed (via the
// existing hls.js DVR path + Rust hls-proxy). Chat stays on Twitch. Assumes
// Kick slug == Twitch login. Returns true if now on Kick; a lookup error is
// "couldn't check", never "offline".
async function tryKickFailover(channelAtDeath) {
  if (
    !session.playing ||
    !channelAtDeath ||
    session.intendedChannel !== channelAtDeath ||
    channelAtDeath.startsWith("vod:")
  ) {
    return false;
  }
  if (session.kickFailover) return true; // already on Kick for this session

  // The Kick identity may differ from the Twitch one (zackrawrr on
  // Twitch is asmongold on Kick) - kick-aliases.js holds the user-set
  // pairings; unset means the original same-name behavior.
  const kickSlug = kickSlugFor(channelAtDeath);
  if (kickSlug !== channelAtDeath) {
    console.log(`[kick] failover alias: ${channelAtDeath} (Twitch) -> ${kickSlug} (Kick)`);
  }

  let info = null;
  try {
    info = await invoke("get_kick_stream", { slug: kickSlug });
  } catch (err) {
    console.warn("[kick] live-status check failed (treating as no-failover):", err);
    return false;
  }
  if (!info) return false; // offline on Kick, or no such Kick channel

  // Re-validate after the await: the user may have stopped playback or
  // switched channels while the Kick lookup was in flight, in which
  // case this failover belongs to a session that no longer exists.
  if (!session.playing || session.intendedChannel !== channelAtDeath) return false;

  await attachKickStream(
    kickSlug,
    info,
    `Twitch stream ended — now playing ${kickSlug} on Kick`,
  );
  return true;
}

/**
 * Restarts playback at a new quality. For VODs, saves the current
 * position and resumes at the same second with the new quality.
 * For live streams, rejoins near the live edge.
 */
async function restartStreamWithQuality(quality, { auto = false } = {}) {
  if (!session.playing || !session.intendedChannel) return;
  session.currentQuality = quality;

  if (session.intendedChannel.startsWith("vod:")) {
    const videoId = session.intendedChannel.slice("vod:".length);
    const savedPosition = Math.floor(playbackControls.videoEl.currentTime);
    const vodTotalSeconds = playbackControls.vodTotalSeconds;
    try {
      const m3u8Url = await invoke("get_vod_m3u8_url", { videoId, quality });
      // The user may have switched away while the URL resolved; don't
      // reattach a VOD they've navigated off of.
      if (session.intendedChannel !== `vod:${videoId}`) return;
      // Reattach HLS.js at the saved position — no progress lost.
      playbackControls.attachStream(m3u8Url, savedPosition);
    } catch (err) {
      console.error("Failed to switch VOD quality:", err);
      setStatus(`Error switching quality: ${err}`);
    }
  } else if (session.useNativeHlsForLive) {
    // macOS native-HLS live: switch quality by resolving a fresh ad-free
    // m3u8 at the new quality and reattaching via hls.js - the live
    // counterpart of the VOD quality-switch above. No start_stream (that's
    // the MSE relay path, which isn't used here).
    const restartChannel = session.intendedChannel;
    try {
      const m3u8Url = await invoke("get_live_m3u8_url", { channel: restartChannel, quality });
      if (session.intendedChannel !== restartChannel) return;
      playbackControls.start(restartChannel, m3u8Url, quality, 0, 0, { nativeHlsLive: true });
      if (session.kickFailover) {
        invoke("stop_kick_chat").catch(() => {});
        session.kickFailover = null;
        await chat.connect(restartChannel).catch(() => {});
      }
    } catch (err) {
      if (String(err).includes("superseded")) return;
      console.error("Failed to switch live quality (native HLS):", err);
      setStatus(`Error switching quality: ${err}`);
    }
  } else {
    try {
      // (see its Rust doc comment), which kills streamlink and EOFs the
      // body the CURRENT attachment is still reading from - and that
      // attachment isn't replaced until playbackControls.start() below,
      // one await later. Left unannounced, that EOF surfaces as
      // signalDead("relay stream ended") -> handleStreamDead -> looksEnded
      // -> tryKickFailover, i.e. changing quality yanks the viewer onto
      // Kick. Tell the outgoing attachment its death is expected first.
      playbackControls.expectRelayTeardown();
      // Capture the channel this restart is FOR. start_stream takes a
      // second or two, and the user can switch to a different channel
      // while it's in flight - in which case session.intendedChannel has
      // already moved on, and attaching below with the live value would
      // play the new channel through THIS channel's relay URL. Bind it
      // once and re-check after the await.
      const restartChannel = session.intendedChannel;
      const relayUrl = await invoke("start_stream", { channel: restartChannel, quality, lowLatency: session.lowLatency });
      if (session.intendedChannel !== restartChannel) return; // superseded mid-restart
      playbackControls.lowLatency = session.lowLatency;
      playbackControls.start(restartChannel, relayUrl, quality);
      // A successful Twitch start means we're on (or back on) Twitch -
      // if this session had failed over to Kick, that's over now:
      // stop the Kick chat client and rejoin Twitch chat (which the
      // failover had disconnected).
      if (session.kickFailover) {
        invoke("stop_kick_chat").catch(() => {});
        chat.connect(restartChannel)
          .catch((err) => console.warn("[kick] failed to rejoin Twitch chat:", err));
        // We're back on a live Twitch stream - return the chrome to
        // Twitch (undoes attachKickStream's setPlatform("kick")), so the
        // header/accent/feeds match the session again.
        setPlatform("twitch");
      }
      session.kickFailover = null;
      // Quality changed: the cached DVR m3u8 (if any) is for the old
      // quality — invalidate and re-resolve in the background so DVR
      // seeking stays fast at the new quality too.
      session.liveDvrM3u8Cache = null;
      prefetchLiveDvrM3u8();
    } catch (err) {
      // Superseded by a newer start (see start_relay's ticket guard) -
      // expected during rapid switching, not a stream failure. Do nothing;
      // the newer session owns playback now.
      if (String(err).includes("superseded")) return;
      console.error("Failed to restart stream at new quality:", err);
      // "No playable streams" is streamlink's channel-is-offline message
      // - i.e. the Twitch stream has actually ENDED, not blipped. That's
      // the moment to check for a Kick simulcast still running. Keyed on
      // the offline error SPECIFICALLY and deliberately: during a
      // simulcast Kick is live too, so failing over on just any error
      // would yank the viewer off a still-working Twitch stream for a
      // transient hiccup.
      const endedOnTwitch = looksLikeStreamEnded(err);
      if (endedOnTwitch) {
        if (session.kickFailover) {
          // Already session.playing the Kick feed and Twitch is still offline
          // (user tried a quality change, which for live goes through
          // Twitch). Nothing was torn down - start_stream threw before
          // any reattach - so Kick playback continues untouched; just
          // don't leave a scary error in the status bar.
          setStatus(
            `Twitch still offline — continuing ${session.kickFailover.channel} on Kick ` +
            `(quality is automatic on the Kick feed)`,
          );
          return;
        }
        if (await tryKickFailover(session.intendedChannel)) return;
      }
      // An AUTO restart (scheduleTwitchReconnect's retry ladder) that
      // fails must hand control back to the ladder, or the recovery dies
      // right here: nothing else re-arms it, so there'd be no attempt 2,
      // and scheduleTwitchReconnect's last-ditch tryKickFailover at
      // attempt 4 would never be reached. That's how a genuinely ended
      // stream could end up doing nothing at all - one failed retry and
      // silence. A USER-initiated quality change still just reports the
      // error, since there's no ladder to return to.
      if (
        auto &&
        session.playing &&
        session.intendedChannel &&
        !session.intendedChannel.startsWith("vod:")
      ) {
        scheduleTwitchReconnect(String(err));
        return;
      }
      setStatus(`Error switching quality: ${err}`);
    }
  }
}

/**
 * Starts playback + chat for the given channel. Shared by the manual
 * Watch button and clicks on sidebar/home-feed/browse-page channel cards,
 * so all paths go through the exact same logic.
 *
 * @param {string} channel
 * @param {{tags?: string[], viewer_count?: number}|null} [stream] - the
 *   Helix stream object for this channel, if the caller already had one on
 *   hand (sidebar/home feed/browse page cards all do, including viewer_count
 *   for the drops banner's "X watching" line) - or `null` for a known-
 *   offline sidebar entry. Left undefined for the manual Watch button,
 *   which only has a typed channel name and no stream object - in that case
 *   this looks one up itself via get_stream_for_login below.
 */

// A VOD within this many seconds of its own end is treated as "finished,"
// not "paused partway through" - matches Netflix/YouTube's convention of
// not offering to resume something the user basically already watched.
const VOD_RESUME_END_THRESHOLD_SECS = 30;

/** Saves current playback position for the VOD currently session.playing, if any
 * - a no-op for live channels. Called at every point playback is about to
 * be torn down (switching to a different channel/VOD, or explicit Stop),
 * since that's the natural "this position is now final" checkpoint, plus
 * every 15s while watching (see the setInterval near the bottom of this
 * file) so a hard crash or force-quit doesn't lose more than a few
 * seconds either. */
function maybeSaveVodProgress() {
  if (!session.playing || !playbackControls.isVod || !session.intendedChannel?.startsWith("vod:")) return;
  const videoId = session.intendedChannel.slice("vod:".length);
  const positionSecs = playbackControls.lastKnownPosition;
  const totalSecs = playbackControls.vodTotalSeconds;
  if (!totalSecs) return; // nothing meaningful to compare position against
  invoke("save_vod_progress", { videoId, positionSecs, totalSecs }).catch((err) => {
    console.warn("Failed to save VOD progress:", err);
  });
}

async function watchChannel(channel, stream) {
  _devForceOfflineFor = null; // dev test override is per-session only
  if (!channel) return;
  session.intendedChannel = channel;
  if (session.kickFailover) {
    invoke("stop_kick_chat").catch(() => {});
    // Coming from a failover/Kick session into an explicit Twitch watch -
    // restore Twitch chrome (attachKickStream may have flipped to Kick).
    setPlatform("twitch");
  }
  session.kickFailover = null; // fresh session - any previous Kick failover is over

  // Stop any currently-running stream first. Without this, clicking a new
  // channel while one was already playing (from Browse, the sidebar, or
  // the home feed) would leave the old MSE feeder/video element still
  // attached to the previous stream while chat.connect() below switched
  // channels unconditionally regardless - so chat would switch channels
  // but the video would keep showing whatever was previously session.playing.
  if (session.playing) {
    playbackControls.stop();
    session.playing = false;
    syncWatchBtn();
  }

  // Hide BOTH pages, not just whichever one happens to default to active -
  // the user could be starting a stream from either the home feed or the
  // Browse page (e.g. clicking a stream card while browsing a category).
  homeFeed.hide();
  browsePage.hide();
  vodsPage.hide();
  session.pageVisible = false;
  hideDropsBanner();
  hideChannelInfoBar();
  setStatus(`Starting stream for ${channel}...`);
  videoPlaceholder.textContent = "Resolving stream...";
  videoPlaceholder.style.display = "flex";

  // Manual Watch: no stream object on hand, so look one up fresh, immediately
  // (before chat.connect and start_stream, which don't gate it and both take
  // time) so the info bar populates fast. Awaited below because we need Helix's
  // live verdict up front: an offline channel skips straight to chat-only
  // instead of failing a playback-token request.
  let streamPromise;
  if (stream !== undefined) {
    streamPromise = Promise.resolve(stream);
  } else {
    streamPromise = invoke("get_stream_for_login", { login: channel })
      .then((json) => JSON.parse(json))
      .catch((err) => {
        console.error("Failed to look up stream info for", channel, err);
        return null;
      });
  }
  streamPromise.then((s) => {
    // Stale guard: if the user switched to a different channel while this
    // particular lookup was still in flight, session.intendedChannel now points at
    // that newer channel - don't let this older resolution stomp it.
    if (session.intendedChannel !== channel) return;
    updateDropsBanner(channel, s);
    updateChannelInfoBar(channel, s);
  });

  const resolvedStream = await streamPromise;
  // Stale guard again, for this awaited copy specifically - the .then()
  // above only protects the info bar/drops banner; without this, an
  // old, slow lookup resolving after the user has already clicked a
  // second channel could still wrongly drive THIS function's own
  // live/offline branch and start_stream call for the channel they left.
  if (session.intendedChannel !== channel) return;
  // Helix's /streams returns no entry at all for an offline channel,
  // which get_stream_for_login resolves to JSON null - type !== "live"
  // also catches the rarer case of a channel that's technically present
  // in the response but not actually streaming (Helix has used other
  // type values historically), so check both rather than just truthiness.
  const isLive = Boolean(resolvedStream) && resolvedStream.type === "live";

  await chat.connect(channel);

  if (!isLive) {
    // Twitch reports the channel offline - but simulcasters often keep
    // their Kick stream going after (or instead of) the Twitch one, so
    // check Kick before settling into offline chat-only mode below.
    // This doubles as the practical way to exercise the failover
    // machinery on demand: enter any Kick-live-but-Twitch-offline
    // channel, instead of waiting hours for a live Twitch stream to
    // actually end. Lookup errors mean "couldn't check", never "not on
    // Kick" (unofficial Cloudflare-fronted API - see kick.rs), so they
    // fall through to the normal offline presentation.
    const kickSlug = kickSlugFor(channel); // alias-aware (see kick-aliases.js)
    let kickInfo = null;
    try {
      kickInfo = await invoke("get_kick_stream", { slug: kickSlug });
    } catch (err) {
      console.warn("[kick] offline-entry live check failed:", err);
    }
    // Stale guard for the await above, same reason as the two earlier
    // ones in this function: the user may have clicked another channel
    // while the Kick lookup was in flight.
    if (session.intendedChannel !== channel) return;

    if (kickInfo) {
      // Set up the live-session state, then hand off to the shared Kick attach.
      // The Twitch chat connected above gets swapped for Kick chat - a brief
      // churn accepted so the fast path doesn't wait on a Kick lookup.
      session.playing = true;
      syncWatchBtn();
      setTheaterMode(true);
      videoPlaceholder.style.display = "none";
      await attachKickStream(
        kickSlug,
        kickInfo,
        `${channel} is offline on Twitch. Playing on Kick.`,
      );
      updateBackToStreamBtn();
      resyncChannelInfoBarVisibility();
      return;
    }

    // Offline channel: stop here rather than calling start_stream at all
    // (it would just fail - there's no playback token to resolve for a
    // channel that isn't streaming) and, crucially,
    // WITHOUT touching session.pageVisible/chat - chat.connect() above already
    // succeeded and should stay exactly as visible as it would be for a
    // live channel. Previously this case wasn't handled separately at
    // all: start_stream's failure landed in the catch block below, which
    // restored the home/browse page - throwing away the chat pane (and
    // the IRC connection chat.connect() had just successfully made) for
    // no reason other than "no video to show," which is a video-only
    // problem, not a chat problem.
    setTheaterMode(false); // no video to give extra width to
    setStatus(`#${channel}`);
    videoPlaceholder.textContent = `${channel} is offline`;
    videoPlaceholder.style.display = "flex";
    updateBackToStreamBtn(); // session.playing is still false - pill stays hidden
    resyncChannelInfoBarVisibility();
    return;
  }

  // Theater mode: collapse the channels sidebar so the video gets the
  // extra width, same as clicking "Theater Mode" on the official site.
  setTheaterMode(true);
  session.currentQuality = "best";

  try {
    // Don't spawn a streamlink pipeline for a channel the user has
    // already clicked away from. start_stream takes ~1-2s (spawns
    // streamlink + ffmpeg and waits for remuxed output), so without this
    // guard, rapid switching runs every intermediate channel's pipeline
    // to completion in sequence and the player visibly crawls through
    // them one by one before reaching the last click. The Helix lookup
    // above is already guarded; this covers the far more expensive step.
    if (session.intendedChannel !== channel) return;

    // ── macOS native-HLS path ────────────────────────────────────────
    // On macOS (WebKit), the fMP4 byte-relay + MSE pipeline is unreliable
    // (see stream-player.js). Instead, resolve the channel's ad-free m3u8
    // (streamlink --twitch-disable-ads still strips ads) and play it via
    // hls.js / native HLS through attachHlsDvr - the same path Kick live
    // and live-DVR already use, which works on WebKit. Windows keeps the
    // byte-relay path (useNativeHlsForLive is false there), preserving its
    // stronger mid-stream ad splicing.
    //
    // session.useNativeHlsForLive is a runtime toggle (defaults on for
    // macOS, off elsewhere) so both approaches can be compared without a
    // rebuild - see its initialization near startup.
    if (session.useNativeHlsForLive) {
      try {
        setStatus(`Resolving ${channel}…`);
        const m3u8Url = await invoke("get_live_m3u8_url", {
          channel,
          quality: session.currentQuality,
        });
        if (session.intendedChannel !== channel) return;
        session.playing = true;
        rememberSession({ kind: "twitchLive", id: channel });
        session.liveDvrInfo = null;
        session.liveDvrM3u8Cache = null;
        playbackControls.liveDvrStreamStartedAt = null;
        syncWatchBtn();
        setStatus(`Playing: ${channel}`);
        videoPlaceholder.style.display = "none";
        // Go through start() (NOT attachHlsLive directly) so every control
        // it sets up - PiP button, hover overlay, cursor auto-hide, seek
        // bar, quality menu, progress poller - is initialized. The
        // nativeHlsLive opt just swaps the MSE attach for hls.js inside
        // attachStream; everything else is the normal live setup.
        playbackControls.start(channel, m3u8Url, session.currentQuality, 0, 0, { nativeHlsLive: true });
        updateBackToStreamBtn();
        resyncChannelInfoBarVisibility();

        // Same background live-DVR + info-bar refresh the MSE path sets up,
        // so DVR seeking and the viewer count work here too.
        invoke("get_live_vod_info", { login: channel })
          .then((raw) => {
            const info = JSON.parse(raw);
            if (session.intendedChannel === channel && info?.video_id && info?.created_at) {
              session.liveDvrInfo = {
                videoId: info.video_id,
                streamStartedAt: new Date(info.created_at).getTime(),
              };
              playbackControls.liveDvrStreamStartedAt = session.liveDvrInfo.streamStartedAt;
              prefetchLiveDvrM3u8();
            }
          })
          .catch(() => {});
        startChannelInfoRefresh(
          channel,
          () => session.playing && playbackControls.currentChannel === channel,
        );
        return;
      } catch (err) {
        if (String(err).includes("superseded")) return;
        if (session.intendedChannel !== channel) return;
        console.error("[native-hls] failed to start live:", err);
        setStatus(`Couldn't play ${channel}: ${err}`);
        videoPlaceholder.textContent = `Couldn't play ${channel}: ${err}`;
        videoPlaceholder.style.display = "flex";
        return;
      }
    }
    // ── Default (Windows) byte-relay + MSE path ──────────────────────
    const relayUrl = await invoke("start_stream", { channel, quality: session.currentQuality, lowLatency: session.lowLatency });
    // And again after: the spawn itself took real time, and the user may
    // have switched during it - don't ATTACH a superseded stream. We
    // deliberately don't stop the relay here: whichever channel the user
    // actually lands on runs its own start_stream, and start_relay reaps
    // the previous pipeline before starting (see stop_current_stream in
    // stream_relay.rs). Calling stop_stream from this stale path instead
    // could race and kill the NEWER channel's relay, which is worse than
    // briefly leaving one that the next start_stream (or Stop) reaps.
    if (session.intendedChannel !== channel) return;
    session.playing = true;
    rememberSession({ kind: "twitchLive", id: channel });
    session.liveDvrInfo = null; // clear any stale DVR info from previous channel
    session.liveDvrM3u8Cache = null;
    playbackControls.liveDvrStreamStartedAt = null;
    syncWatchBtn();
    setStatus(`Playing: ${channel}`);
    videoPlaceholder.style.display = "none";
    playbackControls.start(channel, relayUrl, session.currentQuality);
    updateBackToStreamBtn();
    resyncChannelInfoBarVisibility();

    // Fetch the live VOD info in the background so live-DVR is ready
    // the moment the user first tries to seek further back than the buffer.
    // Fire-and-forget: if this fails (VODs disabled, not yet created, etc)
    // live-DVR simply stays unavailable and seeking clamps to the buffer.
    invoke("get_live_vod_info", { login: channel })
      .then(raw => {
        const info = JSON.parse(raw);
        // Guard: only store if still watching the same channel
        if (session.intendedChannel === channel && info?.video_id && info?.created_at) {
          session.liveDvrInfo = {
            videoId: info.video_id,
            streamStartedAt: new Date(info.created_at).getTime(),
          };
          // Expand the seek bar to cover the full stream immediately
          playbackControls.liveDvrStreamStartedAt = session.liveDvrInfo.streamStartedAt;
          console.log(`[live-dvr] VOD ready: id=${info.video_id} started=${info.created_at}`);
          // Resolve the VOD's m3u8 URL now, in the background, so it's
          // already cached by the time the user actually seeks past the
          // buffer — see prefetchLiveDvrM3u8().
          prefetchLiveDvrM3u8();
        }
      })
      .catch(err => {
        console.log(`[live-dvr] No live VOD available: ${err}`);
        // Normal — streamer has VODs disabled, or Helix hasn't created the
        // entry yet (can take ~30s after stream start). DVR stays disabled.
      });

    // Keep the info bar's viewer count fresh while watching (60s cadence).
    startChannelInfoRefresh(
      channel,
      () => session.playing && playbackControls.currentChannel === channel,
    );
  } catch (err) {
    // A "superseded" error is expected, not a failure: the Rust relay
    // aborts a start_stream whose channel the user already clicked away
    // from (see start_relay's ticket guard). The newer channel's own
    // watchChannel owns the UI now, so this stale one must do NOTHING -
    // showing an error or bouncing to Home would stomp the newer session.
    if (String(err).includes("superseded")) return;
    // NOTE: this now only ever fires for a channel Helix just told us
    // IS live (the offline case returned above already) - so a failure
    // here means something else went wrong (streamlink missing/failed to
    // launch, network blip, etc), not "channel is offline." Falling back
    // to the previous page (and away from chat) is still the right call
    // for that genuine failure case - there's no point staying on a
    // watch view with neither video nor a clear reason chat alone is
    // useful, and the user can always reopen the channel to retry.
    setTheaterMode(false);
    setStatus(`Error: ${err}`);
    videoPlaceholder.textContent = `Failed to start: ${err}`;
    if (session.lastActivePage === "browse") browsePage.show();
    else if (session.lastActivePage === "vods") vodsPage.show(session.vodsChannel, { kick: session.vodsChannelIsKick });
    else homeFeed.show();
    session.pageVisible = true;
    session.intendedChannel = null;
    updateBackToStreamBtn();
    resyncChannelInfoBarVisibility();
  }
}

// Fired by Rust (eventsub.rs channel.raid) when the watched channel raids out.
// Auto-follows the raid like Twitch's own clients, rather than leaving the video
// frozen on the last frame. Guarded on session.playing + a channel match as
// defense against a stale event landing after the user switched away.
listen("eventsub-raid", (event) => {
  const { to_login, to_name, viewers } = event.payload;
  if (!session.playing || !to_login) return;
  const watching = (playbackControls.currentChannel || "").toLowerCase();
  // currentChannel can be "vod:<id>" for VOD playback, which a live raid
  // event should never match anyway, but the prefix check makes the
  // "not currently watching a live channel" case explicit rather than
  // relying on a string that happens not to match.
  if (!watching || watching.startsWith("vod:")) return;

  chat.systemLine(`Raiding to ${to_name || to_login}${viewers ? ` with ${viewers.toLocaleString()} viewers` : ""}...`);
  watchChannel(to_login);
});

/**
 * Play a Twitch VOD. Uses HLS.js pointing directly at the Twitch CDN
 * M3U8 URL (obtained via streamlink --stream-url). This replaces the
 * old relay-based approach and gives us instant seeking, correct buffer
 * management, and no timestamp overflow issues.
 */
async function watchVod(videoId, vodTotalSeconds = 0, broadcastLogin = "", startPositionSecs) {
  _devForceOfflineFor = null; // dev test override is per-session only
  if (!videoId) return;

  // startPositionSecs is undefined for a plain VOD-card click (see
  // vods.js/main.js's onVodSelect) - only THEN do we check for saved
  // progress and resume automatically. A chapter click or explicit
  // resume-from-here action always passes a real number (including
  // literal 0 for "start of VOD" / chapter 1), which must win outright
  // and never get silently overridden by older saved progress.
  if (startPositionSecs == null) {
    startPositionSecs = 0;
    try {
      const saved = await invoke("get_vod_progress", { videoId });
      if (saved && saved.position_secs < saved.total_secs - VOD_RESUME_END_THRESHOLD_SECS) {
        startPositionSecs = saved.position_secs;
      }
    } catch (err) {
      console.warn("Failed to check saved VOD progress:", err);
    }
  }

  if (session.playing) {
    maybeSaveVodProgress();
    playbackControls.stop();
    session.playing = false;
    syncWatchBtn();
  }

  homeFeed.hide();
  browsePage.hide();
  vodsPage.hide();
  session.pageVisible = false;
  session.intendedChannel = `vod:${videoId}`;
  if (session.kickFailover) invoke("stop_kick_chat").catch(() => {});
  session.kickFailover = null; // fresh session - any previous Kick failover is over
  setStatus(`Starting VOD ${videoId}…`);
  videoPlaceholder.textContent = "Resolving VOD…";
  videoPlaceholder.style.display = "flex";

  setTheaterMode(true);
  session.currentQuality = "best";

  try {
    // chat.setVodMode() and resolving the VOD's playback URL are fully
    // independent of each other - chat only needs videoId/broadcastLogin/
    // startPositionSecs, URL resolution only needs videoId/quality - so
    // there's no reason to await one before starting the other. This
    // doesn't remove the dominant cost of a slow VOD start (HLS.js's own
    // manifest fetch+parse, which can only begin once the URL is known),
    // but it does overlap chat's own setup and initial comment fetch with
    // however long URL resolution takes, instead of paying for both back
    // to back.
    const [, m3u8Url] = await Promise.all([
      chat.setVodMode(videoId, () => playbackControls.lastKnownPosition, broadcastLogin, startPositionSecs),
      invoke("get_vod_m3u8_url", { videoId, quality: session.currentQuality }),
    ]);
    // The URL resolution above can take real time (Helix + HLS manifest),
    // and the user may have clicked a different VOD or channel while it
    // was in flight. If so, intendedChannel has moved on and this attach
    // belongs to a session that no longer exists - proceeding would yank
    // the player onto the wrong VOD. The live watch paths guard every
    // await this way; the VOD paths were missing it.
    if (session.intendedChannel !== `vod:${videoId}`) return;
    session.playing = true;
    rememberSession({ kind: "twitchVod", id: videoId, vodTotalSeconds, broadcastLogin });
    syncWatchBtn();
    setStatus(`Playing VOD ${videoId}`);
    videoPlaceholder.style.display = "none";
    playbackControls.start(`vod:${videoId}`, m3u8Url, session.currentQuality, vodTotalSeconds, startPositionSecs);
    resolvePipVodUrl(videoId, m3u8Url);
    updateBackToStreamBtn();
    resyncChannelInfoBarVisibility();
    // Fire-and-forget: muted-segment markers are a nice-to-have overlay,
    // not something playback should ever wait on or fail over. Silently
    // shows no markers if the user isn't logged in (Helix only returns
    // muted_segments for a user-token request - see get_vod_muted_segments'
    // comment) or the request otherwise fails.
    invoke("get_vod_muted_segments", { videoId })
      .then((raw) => playbackControls.renderMutedSegments(JSON.parse(raw), vodTotalSeconds))
      .catch((err) => console.warn("Failed to load muted segments:", err));
  } catch (err) {
    setTheaterMode(false);
    setStatus(`Error: ${err}`);
    videoPlaceholder.textContent = `Failed to start VOD: ${err}`;
    vodsPage.show(session.vodsChannel, { kick: session.vodsChannelIsKick });
    session.pageVisible = true;
    session.intendedChannel = null;
    updateBackToStreamBtn();
    resyncChannelInfoBarVisibility();
  }
}

/**
 * Kick counterpart of watchVod above: plays a finished Kick recording
 * ("kick:<uuid>" ids from kick_channel_videos) through hls.js on Kick's
 * own (proxied) master playlist - no streamlink, no Helix. Structure
 * mirrors watchVod line for line so the two stay easy to diff; the
 * genuine differences are:
 *   - URL resolution is kick_vod_playback (uuid -> /api/v1/video ->
 *     hls-proxy) instead of get_vod_m3u8_url.
 *   - Chat is a plain "no replay available" notice (chat.setKickVodMode)
 *     - Kick has no chat-replay API to sync against playback.
 *   - No PiP low-quality pre-resolve, no muted segments, and
 *     playbackControls.start() runs with kickVod:true so none of the
 *     Twitch-only side fetches (quality probe/chapters/storyboard) fire.
 * Resume progress shares watchVod's store, keyed by the same
 * "kick:<uuid>" string the cards carry, so resume bars and auto-resume
 * work identically.
 */
async function watchKickVod(videoId, vodTotalSeconds = 0, startPositionSecs) {
  _devForceOfflineFor = null; // dev test override is per-session only
  if (!videoId) return;

  // Same resume rules as watchVod: only a plain card click (no explicit
  // start position) consults saved progress; an explicit number - even 0
  // - always wins.
  if (startPositionSecs == null) {
    startPositionSecs = 0;
    try {
      const saved = await invoke("get_vod_progress", { videoId });
      if (saved && saved.position_secs < saved.total_secs - VOD_RESUME_END_THRESHOLD_SECS) {
        startPositionSecs = saved.position_secs;
      }
    } catch (err) {
      console.warn("Failed to check saved VOD progress:", err);
    }
  }

  if (session.playing) {
    maybeSaveVodProgress();
    playbackControls.stop();
    session.playing = false;
    syncWatchBtn();
  }

  homeFeed.hide();
  browsePage.hide();
  vodsPage.hide();
  session.pageVisible = false;
  session.intendedChannel = `vod:${videoId}`;
  if (session.kickFailover) invoke("stop_kick_chat").catch(() => {});
  session.kickFailover = null; // fresh session - any previous Kick live/failover is over
  setStatus("Starting Kick VOD…");
  videoPlaceholder.textContent = "Resolving Kick VOD…";
  videoPlaceholder.style.display = "flex";

  setTheaterMode(true);
  session.currentQuality = "best";

  try {
    // Same overlap as watchVod: the chat swap and the URL resolution are
    // independent, so run them concurrently.
    const [, m3u8Url] = await Promise.all([
      chat.setKickVodMode(),
      invoke("kick_vod_playback", { videoId }),
    ]);
    // Same stale-session guard as watchVod: a slower resolution here must
    // not clobber a newer session the user started while it was in flight.
    if (session.intendedChannel !== `vod:${videoId}`) return;
    session.playing = true;
    rememberSession({ kind: "kickVod", id: videoId, vodTotalSeconds });
    syncWatchBtn();
    setStatus("Playing Kick VOD");
    videoPlaceholder.style.display = "none";
    playbackControls.start(
      `vod:${videoId}`,
      m3u8Url,
      session.currentQuality,
      vodTotalSeconds,
      startPositionSecs,
      { kickVod: true }
    );
    updateBackToStreamBtn();
    resyncChannelInfoBarVisibility();
  } catch (err) {
    setTheaterMode(false);
    setStatus(`Error: ${err}`);
    videoPlaceholder.textContent = `Failed to start Kick VOD: ${err}`;
    vodsPage.show(session.vodsChannel, { kick: session.vodsChannelIsKick });
    session.pageVisible = true;
    session.intendedChannel = null;
    updateBackToStreamBtn();
    resyncChannelInfoBarVisibility();
  }
}

/**
 * Kick-mode direct watch: the platform toggle's counterpart to
 * watchChannel(). Skips every Twitch step (Helix lookup, IRC join,
 * streamlink) and goes straight to the Kick lookup + the same shared
 * attachKickStream() the failover paths use - so a Kick-mode session
 * lands in the identical player/chat configuration as a failed-over
 * one, just without ever having been a Twitch session first.
 *
 * State arrangement mirrors watchChannel's offline->Kick branch (the
 * closest existing sibling); the stale guards mirror watchChannel's,
 * for the same reason - the user can click another card while the
 * lookup is in flight.
 */
async function watchKickChannel(channel) {
  _devForceOfflineFor = null; // dev test override is per-session only
  channel = (channel || "").trim().toLowerCase();
  if (!channel) return;
  session.intendedChannel = channel;
  if (session.kickFailover) invoke("stop_kick_chat").catch(() => {});
  session.kickFailover = null;

  if (session.playing) {
    playbackControls.stop();
    session.playing = false;
    syncWatchBtn();
  }

  homeFeed.hide();
  browsePage.hide();
  vodsPage.hide();
  session.pageVisible = false;
  hideDropsBanner();
  hideChannelInfoBar(); // clear the previous channel's; attachKickStream repopulates from the Kick payload
  setStatus(`Looking up ${channel} on Kick...`);
  videoPlaceholder.textContent = "Resolving Kick stream...";
  videoPlaceholder.style.display = "flex";

  let info = null;
  try {
    info = await invoke("get_kick_stream", { slug: channel });
  } catch (err) {
    console.warn("[kick] direct watch lookup failed:", err);
    if (session.intendedChannel !== channel) return;
    setTheaterMode(false);
    setStatus(`Couldn't reach Kick for ${channel}`);
    videoPlaceholder.textContent = `Couldn't check ${channel} on Kick — try again`;
    updateBackToStreamBtn();
    return;
  }
  if (session.intendedChannel !== channel) return; // user moved on mid-lookup

  if (!info) {
    // Live lookup said "not live" - but the channel may still EXIST,
    // and Kick chatrooms stay open when offline. Rather than a dead-end
    // "offline" message with no chat, connect the chat (read + send)
    // and show the channel's info bar, matching what kick.com does on
    // an offline channel page. get_kick_channel_chat_info returns the
    // stable channel identity regardless of live status; Ok(None) from
    // IT means a genuine 404 (no such channel), the real dead end.
    let chatInfo = null;
    try {
      chatInfo = await invoke("get_kick_channel_chat_info", { slug: channel });
    } catch (err) {
      console.warn("[kick] offline chat-info lookup failed:", err);
    }
    if (session.intendedChannel !== channel) return; // user moved on mid-lookup

    setTheaterMode(false);
    session.playing = false;
    syncWatchBtn();
    videoPlaceholder.style.display = "flex";

    if (chatInfo && chatInfo.chatroom_id) {
      setStatus(`#${channel} (Kick — offline)`);
      videoPlaceholder.textContent = `${channel} is offline — chat is live`;
      // Chat lives independently of the video: connect it so an offline
      // channel's chat is readable and (logged in) sendable.
      await chat
        .connectKick(
          channel,
          chatInfo.chatroom_id,
          chatInfo.broadcaster_user_id,
          chatInfo.subscriber_badges,
        )
        .catch((err) => console.warn("[kick] failed to start offline Kick chat:", err));
      // Populate the info bar from the offline identity we already have,
      // so the offline channel still shows its avatar and name.
      updateKickChannelInfoBar(channel, {
        display_name: chatInfo.display_name,
        avatar: chatInfo.avatar,
        verified: Boolean(chatInfo.verified),
        title: "",
        category: "",
        viewer_count: undefined,
        tags: [],
        is_mature: false,
      });
      resyncChannelInfoBarVisibility();
    } else {
      // Genuine 404 (or no chatroom) - the real "doesn't exist" case.
      setStatus(`#${channel} (Kick)`);
      videoPlaceholder.textContent = `${channel} doesn't exist on Kick`;
      hideChannelInfoBar();
    }
    updateBackToStreamBtn(); // session.playing is false - pill stays hidden
    return;
  }

  session.playing = true;
  rememberSession({ kind: "kickLive", id: channel });
  syncWatchBtn();
  setTheaterMode(true);
  session.liveDvrInfo = null; // stale session state; attachKickStream re-arms Kick DVR via resolveKickDvr
  session.liveDvrM3u8Cache = null;
  videoPlaceholder.style.display = "none";
  await attachKickStream(
    channel,
    info,
    `Now playing ${channel} on Kick`,
  );
  updateBackToStreamBtn();
  resyncChannelInfoBarVisibility();
}

// ── Platform toggle (Twitch <-> Kick) ───────────────────────────────
// The button is the trigger; platform.js owns the state; this block
// owns everything VISIBLE about a flip. Data-level rerouting needs no
// code here at all - home/browse/sidebar call feedInvoke(), which reads
// the mode at call time (see platform.js).

const platformToggleBtn = document.getElementById("platform-toggle");

// Kick login button + state (used by applyPlatformUi below, so declared
// before it runs). The full OAuth wiring is further down; these just need
// to exist before the first applyPlatformUi() call.
const kickLoginBtn = document.getElementById("kick-login-btn");
const kickUserMenuEl = document.getElementById("kick-user-menu");
const kickUserMenuSignout = document.getElementById("kick-user-menu-signout");
let kickOAuthConfigured = false; // resolved async at startup (below)
let kickLogin = null;

// Kick sign-out dropdown, mirroring TwitchAuth's user menu (auth.js): the
// username button opens a flyout with an explicit Sign out, rather than
// logging out on a single bare click. Same #user-menu CSS, same
// position-from-the-button's-rect approach.
function positionKickUserMenu() {
  const rect = kickLoginBtn.getBoundingClientRect();
  kickUserMenuEl.style.left = "";
  kickUserMenuEl.style.right = `${window.innerWidth - rect.right}px`;
  kickUserMenuEl.style.top = `${rect.bottom + 4}px`;
  kickUserMenuEl.style.bottom = "";
}
function toggleKickUserMenu() {
  const opening = !kickUserMenuEl.classList.contains("open");
  if (opening) positionKickUserMenu();
  kickUserMenuEl.classList.toggle("open", opening);
}
function closeKickUserMenu() {
  kickUserMenuEl.classList.remove("open");
}
// Close on any outside click, same as the Twitch menu.
document.addEventListener("click", () => closeKickUserMenu());
kickUserMenuSignout.addEventListener("click", async () => {
  closeKickUserMenu();
  await invoke("kick_logout").catch(() => {});
  setKickLoggedInUi(null);
});

/** Everything about the chrome that reflects the current platform:
 * the toggle's own label+border color, the launcher placeholder, and
 * the sidebar's Followed section - which now exists on BOTH platforms:
 * Twitch's is Helix-backed and needs Twitch login, Kick's is the local
 * follow list (kick-follows.js; kick.com's real follow list only
 * answers to site-session cookies, which the OAuth login can't
 * produce). Called once at startup (the saved mode may be Kick) and on
 * every flip. */
function applyPlatformUi() {
  const kick = isKick();
  // Flips every accent color in the stylesheet at once - the CSS
  // variables at the top of styles.css key off body.kick-mode.
  document.body.classList.toggle("kick-mode", kick);
  const platformLabel = platformToggleBtn.querySelector(".platform-label");
  if (platformLabel) platformLabel.textContent = kick ? "Kick" : "Twitch";
  else platformToggleBtn.textContent = kick ? "Kick" : "Twitch";
  platformToggleBtn.classList.toggle("platform-kick", kick);
  platformToggleBtn.classList.toggle("platform-twitch", !kick);
  channelInput.placeholder = kick ? "Kick channel name" : "Twitch channel name";
  // Section titles per platform: kick.com's sidebar says "Following",
  // Twitch's equivalent here has always been "Followed Channels". The
  // Twitch login prompt inside the section only applies to Twitch mode
  // (Kick's local follows need no login of any kind).
  const followedTitle = document.getElementById("followed-section-title");
  if (followedTitle) followedTitle.textContent = kick ? "Following" : "Followed Channels";
  const followedPrompt = document.getElementById("followed-login-prompt");
  if (followedPrompt) {
    followedPrompt.style.display = kick || sidebar.loggedIn ? "none" : "";
  }
  // The live rail carries each platform's own label: Twitch mode keeps
  // "Live Channels"; Kick mode matches kick.com's sidebar, which calls
  // its equivalent rail "Recommended" (styles.css restyles the header
  // and live dots to Kick's look under body.kick-mode too).
  const topLiveTitle = document.getElementById("top-live-section-title");
  if (topLiveTitle) topLiveTitle.textContent = kick ? "Recommended" : "Live Channels";
  // Login buttons swap with the mode: Twitch's own button hides in Kick
  // mode and vice-versa, so only the relevant one is offered. The Kick
  // button additionally only appears if this build can start a fresh
  // Kick login (real client secret present - kickOAuthConfigured) OR
  // the user already has a restored session (kickLogin) - see the
  // display-toggle line below for why both count.
  loginBtn.style.display = kick ? "none" : "";
  // Show the Kick button whenever this build can START a login
  // (kickOAuthConfigured) OR the user is already logged in from a
  // restored session - otherwise a build that temporarily lost its
  // OAuth config (or just hasn't finished the async config check yet)
  // hides the logged-in username pill along with the login button,
  // even though the restored session is perfectly usable for chat.
  kickLoginBtn.style.display = kick && (kickOAuthConfigured || kickLogin) ? "" : "none";
}

platformToggleBtn.addEventListener("click", () => togglePlatform());

onPlatformChange(() => {
  applyPlatformUi();
  // Feeds hold the other platform's data - drop and refetch (each
  // reload hook refetches immediately only if its page is currently
  // showing, otherwise marks itself stale for its next show()).
  homeFeed.reloadForPlatformChange();
  browsePage.reloadForPlatformChange();
  sidebar.refreshTopLive();
  sidebar.refreshFollowed(); // platform-branched inside (Kick = local follows)
  // Deliberately NOT touched: the currently-playing session, if any.
  // The toggle changes what Home/Browse/search point at going forward;
  // yanking a stream someone is actively watching because they flipped
  // a browse-mode switch would be hostile. The session keeps its own
  // platform until they pick something new.
});

// ── Kick OAuth (independent of Twitch's TwitchAuth) ──────────────────
// Kick login is its own flow (kick_oauth.rs): a green "Log in with Kick"
// button in the header (Kick mode only), an OS-browser PKCE round-trip,
// and a result event carrying the username. State here is intentionally
// minimal - the chat pane owns whether sending is enabled; this block
// just tracks logged-in/out for the button label and tells the pane.

function setKickLoggedInUi(login) {
  kickLogin = login || null;
  const loggedIn = Boolean(kickLogin);
  kickLoginBtn.classList.toggle("logged-in", loggedIn);
  kickLoginBtn.textContent = loggedIn ? kickLogin : "Log in with Kick";
  kickLoginBtn.title = loggedIn ? "Account" : "Log in with Kick";
  // The chat pane decides sendability from this plus the broadcaster id.
  chat.setKickLoggedIn(loggedIn, kickLogin);
}

kickLoginBtn.addEventListener("click", async (e) => {
  if (kickLogin) {
    // Logged in -> open the sign-out dropdown (matches the Twitch button).
    // stopPropagation so the document-level outside-click handler above
    // doesn't immediately close the menu we're opening.
    e.stopPropagation();
    toggleKickUserMenu();
    return;
  }
  try {
    await invoke("start_kick_oauth_login");
    // The browser opens; completion arrives via the kick-oauth-result
    // event below. Nothing to await here.
  } catch (err) {
    console.warn("[kick] login failed to start:", err);
  }
});

listen("kick-oauth-result", (event) => {
  const { ok, login, error } = event.payload || {};
  if (ok) {
    setKickLoggedInUi(login || "Kick user");
  } else {
    console.warn("[kick] login failed:", error);
    setKickLoggedInUi(null);
  }
});

// Startup: find out whether Kick login is even available in this build,
// then apply platform UI (which needs kickOAuthConfigured to decide the
// button), then restore any existing Kick session.
(async () => {
  try {
    kickOAuthConfigured = Boolean(await invoke("kick_oauth_configured"));
  } catch {
    kickOAuthConfigured = false;
  }
  applyPlatformUi(); // re-run now that kickOAuthConfigured is known
  // Tell the chat pane too - it decides whether Kick chat's read-only
  // composer shows as "log in to chat" (disabled) or hides with an
  // explanation (login not available in this build at all).
  chat.setKickOAuthConfigured(kickOAuthConfigured);
  // Always attempt to restore a saved session, regardless of
  // kickOAuthConfigured: that flag only gates whether a NEW login can
  // be started (needs a real client secret baked into this build), but
  // restoring an already-issued token just needs the token file on
  // disk plus a bearer-auth call - no client secret involved unless it
  // happens to be expired and need a refresh. Gating this on
  // kickOAuthConfigured meant a build that lost its OAuth config (or a
  // stale/misreported check) silently dropped an otherwise-perfectly-
  // usable login: the pill vanished and chat fell back to read-only
  // even though the saved token still worked.
  try {
    // Named kickSession, not `session` - `session` is the imported
    // app-state module (session.js), and shadowing it here would be a
    // trap for anyone later reaching for playback state in this block.
    const kickSession = await invoke("restore_kick_session");
    if (kickSession && kickSession.login) {
      setKickLoggedInUi(kickSession.login);
      applyPlatformUi(); // re-run again: kickLogin now affects the pill's visibility too
    }
  } catch {
    // Not logged in / unrecoverable - stay logged out silently.
  }
})();

applyPlatformUi();

// ── macOS native-HLS toggle ──────────────────────────────────────────
// Whether Twitch LIVE plays via native HLS / hls.js (get_live_m3u8_url +
// attachHlsDvr) instead of the fMP4 byte-relay + MSE pipeline. Defaults ON
// for macOS, where WebKit's MSE is unreliable (see stream-player.js), and
// OFF elsewhere, where the byte-relay works and gives stronger mid-stream
// ad splicing.
//
// Exposed on window so both approaches can be A/B tested from the devtools
// console WITHOUT a rebuild:
//   __setNativeHls(true)   force native HLS
//   __setNativeHls(false)  force the byte-relay + MSE path
// Change it, then reopen the stream to apply.
{
  const isMac = /Mac|iPhone|iPad/i.test(navigator.platform)
    || /Mac OS X/i.test(navigator.userAgent);
  session.useNativeHlsForLive = isMac;
  window.__setNativeHls = (on) => {
    session.useNativeHlsForLive = Boolean(on);
    console.log(
      `[native-hls] live playback path = ${session.useNativeHlsForLive ? "NATIVE HLS (hls.js)" : "byte-relay + MSE"}. Reopen the stream to apply.`,
    );
    return session.useNativeHlsForLive;
  };
  console.log(
    `[native-hls] default live path on this platform = ${session.useNativeHlsForLive ? "NATIVE HLS (hls.js)" : "byte-relay + MSE"} (toggle with __setNativeHls(true|false))`,
  );
}

/** Keeps the Watch/Stop button label in sync with playback state. */
function syncWatchBtn() {
  watchBtn.textContent = session.playing ? "Stop" : "Watch";
}

// Enter in the channel input = Watch, same as clicking the button - the
// natural "type a name, hit Enter" flow. Deliberately NOT routed through
// watchBtn.click(): while something is session.playing that button reads Stop,
// so Enter would have stopped playback instead of watching what was just
// typed. Calling the watch functions directly also makes Enter the way
// to SWITCH channels mid-playback (they handle tearing down the current
// session themselves), which the button alone never offered. The input
// blurs afterward so the player's keyboard shortcuts (space, arrows)
// take over immediately instead of typing into the launcher.
channelInput.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const channel = channelInput.value.trim();
  if (!channel) return;
  channelInput.blur();
  if (isKick()) watchKickChannel(channel);
  else watchChannel(channel);
});

watchBtn.addEventListener("click", async () => {
  if (session.playing) {
    // --- Stop ---
    maybeSaveVodProgress();
    session.intendedChannel = null;
    forgetSession(); // explicit Stop must not be undone by a later reload
    _devForceOfflineFor = null; // dev test override never survives a session
    if (session.kickFailover) invoke("stop_kick_chat").catch(() => {});
    session.kickFailover = null;
    session.liveDvrInfo = null;
    session.liveDvrM3u8Cache = null;
    await chat.disconnect();
    playbackControls.stop();
    // playbackControls.stop() only tears down the FRONTEND (aborts the
    // fetch, drops the MediaSource). The relay's streamlink process
    // survives a client disconnect by design - handle_connection exiting
    // doesn't kill it - so without this it keeps downloading the stream
    // in the background until the next start_stream reaps it or the app
    // exits. Every other stop() call site is immediately followed by a
    // start_stream/start_vod, which reaps the old process itself; this
    // is the one path that stops without starting anything, so it's the
    // one that has to say so explicitly.
    invoke("stop_stream").catch((err) =>
      console.warn("[main] failed to stop relay:", err),
    );
    session.playing = false;
    setTheaterMode(false);
    setStatus("Stopped");
    hideDropsBanner();
    hideChannelInfoBar();
    resetDropsDismissal();
    videoPlaceholder.style.display = "none";
    if (session.lastActivePage === "browse") browsePage.show();
    else if (session.lastActivePage === "vods") vodsPage.show(session.vodsChannel, { kick: session.vodsChannelIsKick });
    else homeFeed.show();
    session.pageVisible = true;
    updateBackToStreamBtn();
    syncWatchBtn();
  } else {
    // --- Watch ---
    const channel = channelInput.value.trim();
    if (isKick()) watchKickChannel(channel);
    else watchChannel(channel);
  }
});

// WebView2 sleep/wake surface-desync recovery.
//
// Symptom: PC sleeps with the app open, and on wake the web content is stuck
// at its old (smaller) size in the top-left with black margins - WebView2
// missed the resize when the display reinitialized on resume.
//
// This ONLY acts when there is a genuine desync: it compares what the webview
// believes its size is (window.innerWidth/Height, in CSS px scaled to
// physical) against the OS window's real inner size from Tauri. On a normal
// alt-tab those already match, so nothing happens - which is the fix for the
// previous version nudging the window on every focus. Only when they actually
// differ (the post-sleep case) does it nudge the window by one pixel and back
// to force WebView2 to recompute its surface.
{
  let _recovering = false;
  const recoverIfDesynced = async () => {
    if (_recovering) return;
    _recovering = true;
    try {
      const factor = window.devicePixelRatio || 1;
      const webviewPhysW = Math.round(window.innerWidth * factor);
      const inner = await appWindow.innerSize(); // physical px from Tauri
      // Allow a couple px of rounding slack; a real desync is tens-to-
      // hundreds of px off (the whole black-margin gap).
      if (Math.abs(inner.width - webviewPhysW) > 4) {
        console.log(
          `[resize-recovery] desync detected (webview ${webviewPhysW}px vs window ${inner.width}px); nudging`,
        );
        const { PhysicalSize } = await import("@tauri-apps/api/window");
        await appWindow.setSize(new PhysicalSize(inner.width + 1, inner.height));
        await appWindow.setSize(new PhysicalSize(inner.width, inner.height));
      }
    } catch (err) {
      console.warn("[resize-recovery] check failed:", err);
    } finally {
      _recovering = false;
    }
  };
  // Check when the page becomes visible or the window regains focus - these
  // are when a post-sleep desync would first be observable. The mismatch
  // guard above means a normal alt-tab is a no-op.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") recoverIfDesynced();
  });
  window.addEventListener("focus", recoverIfDesynced);
}

// Previously this file kept mpv's native window glued to #video-region
// here: a 'resize' listener, a 500ms poll as a drag-resize safety net, and
// an appWindow.onMoved() listener, all calling syncVideoRegion(). None of
// that's needed anymore - #video-element just resizes via normal CSS like
// any other element on the page, with no second native surface to keep
// positioned in lockstep with it.

// Previously this file listened for onFocusChanged here to work around a
// repaint bug specific to the native mpv embed: minimizing to tray hid
// mpv's child window along with the main window (Windows hides children
// whenever their parent is hidden), but restoring the main window didn't
// reliably bring mpv's picture back on its own - audio kept session.playing but
// the frame stayed black until something forced a repaint. That doesn't
// apply here: #video-element is normal webview content, so the webview
// repaints it the same way it repaints everything else when the window is
// shown again, with no separate native surface needing a manual nudge.


