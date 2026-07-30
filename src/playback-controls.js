// Custom playback controls for the <video> element, fed via MSE from the local
// relay (stream_relay.rs, stream-player.js). streamlink's remuxed output is
// relayed over local HTTP and appended to the element with attachMseStream()
// (hls.js has no "append a continuous byte stream with no manifest" mode).
// Controls use the standard HTMLMediaElement API.

import { invoke } from "@tauri-apps/api/core";
import { fetchVodChapters, fetchVodSeekPreviewsUrl } from "./chapters.js";
import { loadVodStoryboard } from "./seek-thumbnails.js";
import { attachHlsVod } from "./vod-player.js";
import { attachMseStream } from "./stream-player.js";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { currentMonitor, PhysicalPosition, PhysicalSize } from "@tauri-apps/api/window";

const HIDE_DELAY_MS = 2000;
// Live-edge bookkeeping needs a periodic tick the same way the old mpv-IPC
// polling loop did, but here it's just reading video.currentTime/.buffered
// directly - no IPC round-trip, so this could run faster, but matching the
// old cadence keeps the seek bar/time-display updates feeling the same.
const PROGRESS_POLL_MS = 1000;
// How far behind the live edge (video.seekable's end, fed by the MSE
// feeder) counts as "still effectively live" for the Live button/time-
// display - mirrors the old mpv-side LIVE_EDGE_SAFETY margin's purpose
// (live playback is never exactly at the bleeding edge; there's always a
// small, normal amount of latency buffer).
const LIVE_EDGE_THRESHOLD_SECONDS = 2;
// How often _maybeStepUpAutoQuality() polls navigator.connection.downlink
// to check for a step-up opportunity. Deliberately much slower than the
// stall-driven step-down path (which reacts within ~3s) - a wrong step-up
// costs a visible stream restart and likely an immediate stall, so there's
// no benefit to checking faster than this, only more risk of acting on a
// momentary blip in the (already rough) downlink estimate.
const STEP_UP_CHECK_MS = 20_000;
// Minimum time that must have passed since the last detected stall (see
// _lastStallAt) before a step-up will even be considered, regardless of
// what the current downlink estimate says. A stall is ground-truth
// evidence the network just failed at the CURRENT tier; downlink jumping
// back up moments later doesn't undo that, so this is a cooldown
// independent of (and longer than) the stall counter's own 90s reset.
const STEP_UP_MIN_QUIET_MS = 60_000;
// Bandwidth a tier typically needs to play smoothly, in Mbps, keyed by
// the same leading resolution number _rankResolution() already extracts
// from labels like "1080p60"/"720p30". Figures are mid-range
// industry encoding-ladder bitrates for live H.264 (per-title/per-stream
// actual bitrate varies, which is exactly why STEP_UP_HEADROOM below
// exists as a safety margin on top of these rather than treating them as
// exact thresholds). Resolutions not in this table are scaled from the
// nearest known entry by pixel-count ratio - see _requiredMbpsForResolution().
const RESOLUTION_MBPS = {
  160: 0.4,   // audio-only-equivalent tiers some channels expose as e.g. "160p30"
  240: 0.6,
  360: 1.2,
  480: 2.0,
  720: 3.5,
  1080: 6.0,
  1440: 10.0,
  2160: 20.0,
};
// A step-up must clear the next tier's typical bitrate by this multiple,
// not just match it - matches the "upload should be ~1.4x your target
// bitrate" margin recommended for streaming TO Twitch, applied here in
// reverse for streaming FROM it, since navigator.connection.downlink is
// an estimate, not a guaranteed sustained rate, and other apps/devices on
// the same network can eat into it without this player ever finding out.
const STEP_UP_HEADROOM = 1.4;

export class PlaybackControls {
  /**
   * @param {object} [opts]
   * @param {(quality: string) => void} [opts.onQualityChange] - called
   *   when the user picks a different quality from the settings menu.
   *   Quality switching now means restarting streamlink with a different
   *   quality argument (there's no in-memory "switch rendition" the way
   *   hls.js had with its levels/currentLevel API), so this file can't
   *   just flip a property on something it owns - it has to ask main.js
   *   to redo the whole start_stream call with the new
   *   quality and feed this file the resulting fresh relay URL via
   *   start() again, the same as the very first time playback started.
   */
  constructor({ onQualityChange = () => {}, onLowLatencyChange = () => {}, onSeek = () => {}, onLiveDvrSeek = null, onLiveDvrClamped = null, onStreamDead = null, onStreamSilent = null, lowLatency = false } = {}) {
    this.onQualityChange = onQualityChange;
    // Fired when the live relay source dies (see attachMseStream's
    // onDead) so main.js can auto-restart the stream - reason string
    // passed through for its status line.
    this.onStreamDead = onStreamDead;
    // Early warning that the relay has gone quiet (see attachMseStream's
    // onSilence). NOT a death - playback continues. Lets main.js ask
    // Helix whether the broadcast actually ended, so a real stream end
    // hands over to Kick in seconds instead of waiting out onStreamDead.
    this.onStreamSilent = onStreamSilent;
    this.onLowLatencyChange = onLowLatencyChange;
    this.onSeek = onSeek;
    // Called by main.js when the live-DVR feature is available for the
    // current channel (i.e. Twitch has a currently-recording VOD). When
    // set and a seek goes past the MSE buffer start, seekToClickPosition/
    // seekRelative call this instead of clamping to the buffer edge. The
    // callback receives the target position in seconds-behind-live-edge and
    // is responsible for switching to HLS.js on the live VOD. If null,
    // live seeking clamps to the buffer start (the old behavior).
    this.onLiveDvrSeek = onLiveDvrSeek;
    // Fires when a live seek WANTED to go further back than Kick can ever
    // reach (past the actually-buffered window, with no VOD to swap onto -
    // see _isKickSession above and its use in seekToClickPosition/
    // seekRelative below), so the playhead had to clamp to the earliest
    // buffered point instead of landing where the user clicked. Purely
    // informational - lets main.js surface a status message explaining the
    // clamp instead of the seek silently doing less than it looked like it
    // would. Receives the seconds-behind-live the user asked for and the
    // seconds-behind-live actually landed on. No-op if not provided.
    this.onLiveDvrClamped = onLiveDvrClamped;
    // Reflects the current low-latency setting. Kept in sync by main.js
    // so the toggle in the quality menu shows the correct on/off state.
    this.lowLatency = lowLatency;
    this.videoFrame = document.getElementById("video-frame");
    this.videoRegion = document.getElementById("video-region");
    this.videoEl = document.getElementById("video-element");
    this.controlsBar = document.getElementById("controls-bar");
    this.playPauseBtn = document.getElementById("play-pause-btn");
    this.playIcon = document.getElementById("play-icon");
    this.pauseIcon = document.getElementById("pause-icon");
    this.centerPlayBtn = document.getElementById("center-play-btn");
    this.seekBarTrack = document.getElementById("seek-bar-track");
    this.seekBarFill = document.getElementById("seek-bar-fill");
    this.mutedSegmentsContainer = document.getElementById("seek-bar-muted-segments");
    this.seekBarTooltip = document.getElementById("seek-bar-tooltip");
    this.seekBarThumbnail = document.getElementById("seek-bar-thumbnail");
    this.timeDisplay = document.getElementById("time-display");
    this.liveBtn = document.getElementById("live-btn");
    this.muteBtn = document.getElementById("mute-btn");
    this.volumeIcon = document.getElementById("volume-icon");
    this.muteIcon = document.getElementById("mute-icon");
    this.volumeSlider = document.getElementById("volume-slider");
    this.settingsBtn = document.getElementById("settings-btn");
    this.chaptersBtn  = document.getElementById("chapters-btn");
    this.chaptersMenu = document.getElementById("chapters-menu");

    // HLS.js instance used for VOD playback (null for live streams or when
    // no VOD is playing). Seeking is just videoEl.currentTime = seconds.
    this._hlsVod = null;
    // Chapter list fetched once per VOD, cached for the session.
    this._chapters = [];
    this._chaptersLoaded = false;
    // Default no-op until _fetchStoryboard() resolves - frameFor()
    // always returning null means the hover tooltip just shows the time,
    // no thumbnail, which is the right fallback for live streams (no
    // storyboard ever exists) and before a VOD's own storyboard loads.
    this._storyboard = { frameFor: () => null };
    this.qualityMenu = document.getElementById("quality-menu");
    this.pipBtn = document.getElementById("pip-btn");
    // Rescue controls in the PiP placeholder (see index.html): recover a
    // PiP window stranded on a monitor that's been unplugged or input-
    // switched to another machine. The PiP window is frameless, always-
    // on-top, and skip-taskbar, so once it's off any visible display the
    // OS offers no way to reach it - these buttons are that way.
    this.pipBringBtn = document.getElementById("pip-bring-btn");
    this.pipCloseRemoteBtn = document.getElementById("pip-close-remote-btn");
    this.videoRegionEl = document.getElementById("video-region");

    // The MSE feeder's controller for the currently-playing stream/VOD -
    // see attachMseStream() in stream-player.js. Created fresh in start()
    // and torn down (via .stop()) in stop().
    this.mseController = null;

    this.hideTimer = null;
    this.inPip = false;
    // Document Picture-in-Picture state (see enterDocPip): the PiP
    // Window object while open (null otherwise), the videoEl's original
    // DOM position for restoring on close, an AbortController scoping
    // every PiP-only event listener (the video element SURVIVES the PiP
    // window - listeners added for PiP must not), and refs to the PiP
    // window's own controls so setVolume/setMuteIcon/setPauseIcon can
    // keep them in sync with the main window's.
    this.docPipWindow = null;
    this._docPipRestore = null;
    this._docPipAbort = null;
    // Native always-on-top PiP window (see enterNativePip) - the third
    // and final PiP tier, for webviews where neither Document PiP nor
    // classic video PiP actually works (WebView2 = every Windows build:
    // both APIs are exposed but requestWindow throws "Internal error:
    // no window" and pictureInPictureEnabled is false).
    this.nativePipWindow = null;
    this._nativePipRestore = null;
    // What attachStream/attachLiveMse/attachHlsDvr most recently fed the
    // player - live relay URL or VOD m3u8 - so enterNativePip can hand
    // the PiP window the same source. Live relay URLs are safe to share:
    // the relay is a multi-subscriber broadcast (see stream_relay.rs),
    // so the PiP window is a second consumer of the one streamlink
    // pipeline, not a second stream.
    this._currentSourceUrl = null;
    this._pipEls = null;
    this.progressInterval = null;
    this.isMuted = false;
    this.lastVolumeBeforeMute = 100;
    this.active = false;
    // Cached from the most recent pollProgress() tick, so the Live button
    // and seek bar tooltip can compute values instantly without re-reading
    // video.buffered for every mouse movement.
    this.lastKnownPosition = 0;
    this.lastKnownDuration = 0;
    // Copyright-muted VOD ranges (see renderMutedSegments), for the seek
    // bar markers and hover-tooltip label. Raw {offset, duration} pairs
    // from Helix, kept around so the hover-tooltip lookup in
    // updateSeekTooltip doesn't need them passed in separately.
    this._mutedSegments = [];
    // See pollProgress's "normal live" branch - anchors videoEl.currentTime
    // (session-relative) to the broadcast's actual absolute elapsed time
    // (wall-clock, from liveDvrStreamStartedAt). Re-derived per session by
    // attachLiveMse(); null here just means "not yet available."
    this._liveSessionAbsoluteStart = null;
    // Live-DVR state: set when the user seeks past the MSE buffer start
    // into the live stream's in-progress VOD (via HLS.js on the recording
    // VOD). Null during normal live or VOD playback. Contains:
    //   { channel, videoId, streamStartedAt (epoch ms) }
    // streamStartedAt is the VOD's created_at epoch, used to compute the
    // VOD offset for "seek to X seconds before live edge" and for mapping
    // the current VOD position back to a wall-clock time for the seek bar.
    this._liveDvr = null;
    // Set by main.js once get_live_vod_info resolves for the current channel.
    // Enables the seek bar to expand to show the full stream duration even
    // before the user first clicks into DVR mode. Also used by
    // seekToClickPosition to compute the correct VOD offset from a click.
    this.liveDvrStreamStartedAt = null;
    // True for a Kick live session (startKick/attachHlsDvr on Kick's own
    // live m3u8), false for a Twitch one. Kick has no separate on-demand
    // VOD endpoint to swap onto the way Twitch's onLiveDvrSeek does - its
    // "DVR" is just however much of the live playlist hls.js still has
    // buffered. liveDvrStreamStartedAt still gets set for Kick (from the
    // channel's stream-start wall clock, see attachKickStream in main.js)
    // purely to expand the seek bar / behind-live display to the full
    // broadcast, exactly like Twitch's pre-DVR-click display does - but
    // seeking past what's actually buffered must CLAMP for Kick instead
    // of calling onLiveDvrSeek (a no-op for Kick anyway, since main.js
    // guards it on liveDvrInfo, which is always null in Kick mode - but a
    // silent no-op is worse than the old plain-clamp behavior it would
    // otherwise replace). See seekToClickPosition/seekRelative below.
    this._isKickSession = false;
    // True once main.js has resolved an in-progress RECORDING for the
    // current Kick session (get_kick_live_dvr) - the thing that makes a
    // Twitch-style DVR swap possible on Kick after all. While false,
    // Kick seeks past the buffer keep the old clamp-with-notice
    // behavior; while true, they route into onLiveDvrSeek exactly like
    // Twitch's. Reset alongside _isKickSession everywhere.
    this.kickDvrAvailable = false;
    // The Kick rendition (level label, e.g. "720p60") the user picked
    // from the quality menu, if any. hls.js level indices are per-
    // manifest, and a Kick session attaches a fresh hls instance on
    // every live<->DVR swap - remembering the LABEL and re-matching it
    // on each manifest is what keeps a picked quality sticky across
    // those swaps. null = auto (hls.js ABR). Reset on channel change
    // only (startKick's channel-changed block), NOT on go-live/DVR
    // reattaches within the same session.
    this._kickPreferredLevelLabel = null;
    // Set by main.js right before start() is called, so the quality menu
    // knows which channel/VOD to ask get_available_qualities about.
    this.currentChannel = null;
    this.currentQuality = "best";
    // Prefetched quality list for the current channel. Populated in the
    // background by _prefetchQualities() immediately when start() is called,
    // so the settings menu renders instantly instead of waiting for a fresh
    // streamlink probe on every open. Cleared in stop() and whenever the
    // channel changes so a new channel always gets a fresh fetch.
    this.cachedQualities = null;
    this._qualitiesPromise = null;

    // Auto quality: step down on sustained buffering (_handleAutoStall), step
    // up when navigator.connection.downlink clears the next tier's bitrate and
    // there's been no recent stall (_maybeStepUpAutoQuality). _autoTierIdx
    // indexes _autoQualityTiers() ascending; -1 = 'best'. Each switch restarts
    // streamlink (no in-player ABR), so both directions are debounced, step-up
    // more conservatively than step-down.
    this.autoQualityMode = false;
    this._autoTierIdx = -1;
    this._autoStallCount = 0;
    this._autoStallDebounce = null;
    this._autoStallResetTimer = null;
    // Timestamp (Date.now()) of the most recent stall *detection* (not
    // just a 'waiting' event - the actual post-debounce stall count
    // increment). Read by _maybeStepUpAutoQuality() so a step-up never
    // fires too soon after the network just proved it couldn't keep up,
    // even if _autoStallCount has since been reset by its own 90s timer.
    this._lastStallAt = 0;
    // Recurring timer that polls for a step-up opportunity while auto
    // mode is active and not already at 'best'. Separate from the
    // stall-driven step-down path, which is event-driven, not polled.
    this._autoStepUpInterval = null;
    // Stable bound reference so we can addEventListener/removeEventListener
    // with the same function object.
    this._boundAutoStall = () => this._handleAutoStall();

    this.bindEvents();
  }

  bindEvents() {
    // Bound to videoFrame (the shared parent of both #video-region and
    // .controls-bar), not just videoRegion - binding only to videoRegion
    // meant moving the mouse onto the controls bar itself counted as
    // "leaving" videoRegion, immediately triggering hideControls() even
    // though the cursor was sitting right on the seek bar.
    this.videoFrame.addEventListener("mousemove", () => this.showControls());
    this.videoFrame.addEventListener("mouseleave", () => this.hideControls());

    this.playPauseBtn.addEventListener("click", () => this.togglePause());
    // Note: clicking the video itself intentionally does NOT toggle pause.
    // Live streams have no meaningful "pause then resume" - pausing just
    // freezes on the last frame while the live broadcast continues, so
    // accidental clicks (e.g. trying to interact with the chat or controls)
    // are a nuisance rather than a useful gesture. The dedicated play/pause
    // button in the controls bar is still available for the rare intentional
    // case.
    this.centerPlayBtn.addEventListener("click", () => this.togglePause());

    this.muteBtn.addEventListener("click", () => this.toggleMute());

    // The volume slider's 'input' event fires continuously while
    // dragging. video.volume is a plain synchronous property set (no IPC
    // round-trip to debounce against anymore), so this no longer needs
    // the timer-based debouncing the old mpv-IPC version required to
    // avoid flooding the pipe - every input event can just set
    // video.volume directly and stay perfectly in sync with the slider.
    this.volumeSlider.addEventListener("input", (e) => {
      this.setVolume(Number(e.target.value));
    });

    this.seekBarTrack.addEventListener("click", (e) => {
      this.seekToClickPosition(e);
    });

    this.seekBarTrack.addEventListener("mousemove", (e) => {
      this.updateSeekTooltip(e);
    });
    this.seekBarTrack.addEventListener("mouseleave", () => {
      this.seekBarTooltip.classList.remove("visible");
      this.seekBarThumbnail.classList.remove("visible");
    });

    this.liveBtn.addEventListener("click", () => this.jumpToLive());

    this.pipBtn?.addEventListener("click", () => this.togglePip());
    this.pipBringBtn?.addEventListener("click", () => this.rescueNativePip());
    this.pipCloseRemoteBtn?.addEventListener("click", () => this.closePipAnyTier());
    // A "pip"-labeled window can outlive our handle to it (the main
    // webview reloaded while PiP was open) - without re-adopting it, the
    // placeholder/rescue UI never shows and the pip button would try to
    // CREATE a pip rather than close the one that's already running.
    this._adoptStrayPip();
    this.settingsBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleQualityMenu();
    });

    this.chaptersBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleChaptersMenu();
    });

    // Close any open menus when clicking anywhere outside them.
    document.addEventListener("click", () => {
      this.qualityMenu.classList.remove("open");
      this.chaptersMenu?.classList.remove("open");
    });

    // Keep the play/pause icon and center button in sync with whatever
    // actually changed video.paused - not just our own button clicks, but
    // also the video element's own state changes (e.g. autoplay starting,
    // or a future keyboard shortcut acting on video.play()/.pause()
    // directly rather than through togglePause()).
    this.videoEl.addEventListener("play", () => this.setPauseIcon(false));
    this.videoEl.addEventListener("pause", () => this.setPauseIcon(true));

    // Exiting native Picture-in-Picture other than via our own pipBtn
    // (e.g. the OS-drawn PiP window's own close button) needs to be
    // reflected back in our UI state - see togglePip()/applyPipUiState().
    this.videoEl.addEventListener("leavepictureinpicture", () => {
      this.applyPipUiState(false);
    });
  }

  // @param channel          the channel being watched
  // @param relayUrl         local relay URL from start_stream (127.0.0.1:PORT)
  // @param quality          initial quality label (highlight only; switching is
  //                         a fresh start_stream on the Rust side)
  // @param vodTotalSeconds  Helix VOD duration, ground truth for the seek bar
  // @param opts.kickVod     Kick recording off a proxied master playlist. Seeks
  //                         are identical, but Twitch-only side fetches (quality
  //                         probe, chapters, storyboard) must not fire; quality
  //                         uses the hls.js level menu instead.
  start(channel, url, quality = "best", vodTotalSeconds = 0, startPositionSecs = 0, opts = {}) {
    const kickVod = Boolean(opts.kickVod);
    // macOS native-HLS live path (see attachStream): live m3u8 via hls.js
    // instead of the MSE relay, but all the control/UI setup start() does
    // is identical, which is exactly why the native-HLS branch must go
    // through start() and not around it (skipping start() was what left
    // PiP, the hover overlay, and the cursor auto-hide uninitialized).
    this._nativeHlsLive = Boolean(opts.nativeHlsLive);
    this.active = true;
    // Clear the quality cache when switching to a different channel so the
    // new channel gets its own fresh probe. Keep it for same-channel calls
    // (quality switches restart the stream but don't change what qualities
    // are available - no need to re-probe). Also exit auto mode on a real
    // channel switch; keep it for same-channel quality-step restarts.
    if (channel !== this.currentChannel) {
      this.cachedQualities = null;
      this._qualitiesPromise = null;
      this._disableAutoMode();
      // Markers are tied to a specific VOD's muted_segments - a same-
      // channel restart (quality switch) keeps the same VOD, but a real
      // channel switch means whatever's here belongs to the old one.
      // main.js re-fetches and calls renderMutedSegments again once the
      // new VOD's data is ready; this just prevents the stale markers
      // from being visible in the meantime.
      this.renderMutedSegments([], 0);
    }
    this.currentChannel = channel;
    // False for every Twitch stream/VOD; true for a Kick VOD (see the
    // kickVod param above). With isVod=true alongside it, the flag's
    // live-session seek-clamp branches are unreachable (VOD seeks take
    // the isVod path first) - its only live effect here is routing the
    // quality menu to _loadKickQualityMenu.
    this._isKickSession = kickVod;
    this.kickDvrAvailable = false;
    // When in auto mode, keep displaying 'auto' as the active quality even
    // though the stream is actually playing at a specific resolution tier.
    if (!this.autoQualityMode) {
      this.currentQuality = quality;
    }
    // Channels prefixed with "vod:" are past broadcasts - they have a
    // fixed duration and no live edge, so live-specific UI is hidden.
    this.isVod = channel.startsWith("vod:");
    this.vodTotalSeconds = vodTotalSeconds;
    this._chapters = [];
    this._chaptersLoaded = false;
    // Reset so a new VOD doesn't briefly show the previous one's stale
    // thumbnails while its own storyboard loads.
    this._storyboard = { frameFor: () => null };
    if (this.chaptersBtn) this.chaptersBtn.style.display = "none";
    if (this.chaptersMenu) { this.chaptersMenu.innerHTML = ""; this.chaptersMenu.classList.remove("open"); }
    this.liveBtn.style.display = this.isVod ? "none" : "";
    this.showControls();

    this.attachStream(url, startPositionSecs);

    if (this.progressInterval) clearInterval(this.progressInterval);
    this.progressInterval = setInterval(() => this.pollProgress(), PROGRESS_POLL_MS);

    // Kick VODs: no streamlink probe (the quality menu reads hls.js
    // levels instead - see kickVod above), no GQL chapters, no
    // storyboard - all three are Twitch APIs that would just 4xx (or
    // probe the wrong site entirely) for a Kick uuid.
    if (!kickVod && !this.cachedQualities && !this._qualitiesPromise) {
      this._prefetchQualities();
    }

    // For VODs, fetch chapters and the seek-preview storyboard in the
    // background so they're ready by the time the user looks for them.
    // Live streams (not yet in DVR mode) never get here at all - Twitch
    // doesn't generate storyboards for an in-progress broadcast, only
    // finished/recording VODs, so there's nothing to fetch for live.
    if (this.isVod && !kickVod) {
      this._fetchChapters();
      this._fetchStoryboard();
    }
  }

  /**
   * Tears down any previous MSE attachment and attaches a fresh one to
   * relayUrl via attachMseStream() (see stream-player.js) - mirrors the
   * "one feeder per source, not reused" lifecycle hls.js instances had in
   * the previous version of this file.
  /** Attaches a stream source to the video element.
   * - VODs: uses HLS.js pointed at a CDN M3U8 URL. Seeking is instant;
   *   HLS.js manages all buffering. Pass startPositionSecs to jump to a
   *   specific VOD second on load.
   * - Live: uses the custom Rust relay + MSE pipeline (low-latency).
   */
  attachStream(url, startPositionSecs = 0) {
    this._currentSourceUrl = url;
    // A source change makes an open native PiP window stale (it's
    // playing the OLD relay/VOD, which for quality switches is about to
    // be torn down server-side) - close it; the user can re-open on the
    // new source with one click.
    this._closeNativePip();
    if (this._nativeHlsLive) {
      // macOS native-HLS live path: a real live m3u8 played via hls.js /
      // native HLS instead of the MSE relay. Live-edge buffering, no
      // MSE controller. See attachHlsLive / the useNativeHlsForLive
      // toggle in main.js. Everything else start() sets up (controls,
      // PiP, hover overlay, poller, quality menu) is identical.
      if (this.mseController) {
        this.mseController.stop();
        this.mseController = null;
      }
      if (this._hlsVod) {
        this._hlsVod.destroy();
        this._hlsVod = null;
      }
      this._hlsVod = attachHlsVod(this.videoEl, url, {
        startPosition: -1,
        liveEdge: true,
        onFatalError: (data) => {
          console.error("[hls.js] fatal in live:", data);
          this.onStreamDead?.("hls.js live pipeline failed");
        },
      });
    } else if (this.isVod) {
      // Tear down any existing HLS.js instance first.
      if (this._hlsVod) {
        this._hlsVod.destroy();
        this._hlsVod = null;
      }
      this._hlsVod = attachHlsVod(this.videoEl, url, {
        startPosition: startPositionSecs,
        onFatalError: (data) => console.error("[hls.js] fatal:", data),
      });
    } else {
      // Live: relay + MSE.
      if (this.mseController) {
        this.mseController.stop();
        this.mseController = null;
      }
      this.mseController = attachMseStream(this.videoEl, url, {
        isVod: false,
        onFatalError: () => {
          console.error("MSE stream attachment failed fatally for", url);
          // An append-level failure leaves the pipeline just as dead as
          // a vanished relay (a poisoned demuxer never recovers on its
          // own) - route it into the same auto-restart.
          this.onStreamDead?.("MSE pipeline failed");
        },
        onDead: (reason) => this.onStreamDead?.(reason),
        onSilence: (secs) => this.onStreamSilent?.(secs),
      });
    }
  }

  // Switch to hls.js on a VOD URL for live-DVR: tear down the MSE relay, attach
  // at the given offset, keep isVod false so the live UI stays. No storyboard
  // fetch - Twitch's storyboard CDN 403s for an in-progress broadcast's VOD.
  // Start a Kick HLS feed (Twitch -> Kick failover; attachKickStream in main.js
  // is the only caller). start()'s bookkeeping minus attachStream: Kick is a
  // plain live HLS playlist, so it plays through hls.js (attachHlsDvr at -1 =
  // live edge). Both failover entry points land here for an identical config.
  startKick(channel, url) {
    this.active = true;
    if (channel !== this.currentChannel) {
      // Same reset start() does on a real channel switch - see its
      // comments for why each of these can't be left stale.
      this.cachedQualities = null;
      this._qualitiesPromise = null;
      this._disableAutoMode();
      this.renderMutedSegments([], 0);
      this._kickPreferredLevelLabel = null; // new channel, fresh quality choice
    }
    this.currentChannel = channel;
    this.isVod = false;
    // See this flag's own comment (constructor) - drives Kick-specific
    // clamp-instead-of-DVR-swap handling in seekToClickPosition/seekRelative.
    this._isKickSession = true;
    // Resolved (or not) per session by main.js AFTER this returns - a
    // previous session's availability must never leak into a new one.
    this.kickDvrAvailable = false;
    this.vodTotalSeconds = 0;
    // Chapters/storyboard belong to a Twitch VOD - a Kick feed has
    // neither, and for the mid-session failover case whatever is here
    // belongs to the Twitch stream that just ended.
    this._chapters = [];
    this._chaptersLoaded = false;
    this._storyboard = { frameFor: () => null };
    if (this.chaptersBtn) this.chaptersBtn.style.display = "none";
    if (this.chaptersMenu) {
      this.chaptersMenu.innerHTML = "";
      this.chaptersMenu.classList.remove("open");
    }
    this.liveBtn.style.display = "";
    // Live-DVR bookkeeping belongs to a Twitch session. In Kick mode
    // the seek bar must reflect the hls.js buffer only - stale values
    // here would drive the behind-live/duration math in pollProgress
    // off the ENDED Twitch stream's timeline.
    this._liveDvr = null;
    this.liveDvrStreamStartedAt = null;
    this._liveSessionAbsoluteStart = null;
    this.showControls();
    this.attachHlsDvr(url, -1);
    if (this.progressInterval) clearInterval(this.progressInterval);
    this.progressInterval = setInterval(() => this.pollProgress(), PROGRESS_POLL_MS);
  }

  attachHlsDvr(vodUrl, vodOffsetSecs) {
    this._currentSourceUrl = vodUrl;
    this._closeNativePip();
    if (this.mseController) {
      this.mseController.stop();
      this.mseController = null;
    }
    if (this._hlsVod) {
      this._hlsVod.destroy();
      this._hlsVod = null;
    }
    this._hlsVod = attachHlsVod(this.videoEl, vodUrl, {
      startPosition: vodOffsetSecs,
      onFatalError: (data) => console.error("[hls.js] fatal in DVR:", data),
      // Twitch's onLiveDvrSeek swaps onto a finite in-progress RECORDING
      // (a real archived VOD, just not finished yet) - ordinary VOD
      // buffer behavior is correct there. Kick's startKick() calls this
      // same method for its actually-live m3u8 (offset -1 = hls.js
      // default/live edge) - see liveEdge's doc comment in vod-player.js.
      // A Kick DVR attach (onLiveDvrSeek with a real >= 0 offset into
      // the recording) is the RECORDING case, not the live one, so the
      // offset sign is what distinguishes the two within a Kick session.
      liveEdge: this._isKickSession && vodOffsetSecs < 0,
    });
    // Every Kick attach (live start, DVR entry, go-live return) builds a
    // new hls instance - re-pin the user's picked rendition on it.
    if (this._isKickSession) this._applyKickPreferredLevel();
  }

  /** Switches back to the MSE relay for live playback, tearing down HLS.js.
   * Used when returning from live-DVR to the real live stream. */
  /**
   * Tells the CURRENT live relay attachment (if any) that it's about to
   * be killed on purpose, so its EOF isn't mistaken for the Twitch
   * stream ending. Must be called before anything that restarts
   * streamlink server-side - i.e. before invoke("start_stream") on a
   * channel that's already playing - because that kills the old relay
   * while this attachment is still reading from it. A no-op on VODs
   * (HLS.js, no relay) and when nothing is attached.
   */
  expectRelayTeardown() {
    this.mseController?.expectTeardown?.();
  }

  /** DEV ONLY: make the live relay attachment act as though the broadcast
   * ended (bytes stop arriving, connection stays open). Drives the real
   * silence/death detectors rather than faking their conclusions. */
  simulateRelaySilence() {
    this.mseController?.simulateSilence?.();
  }

  attachLiveMse(relayUrl) {
    // Reaching the live relay at all only ever happens for a Twitch
    // session (see this method's own header comment) - belt-and-braces
    // reset alongside start()'s own, so a stale true from a previous Kick
    // session can never linger into a Twitch one.
    this._isKickSession = false;
    this.kickDvrAvailable = false;
    if (this._hlsVod) {
      this._hlsVod.destroy();
      this._hlsVod = null;
    }
    if (this.mseController) {
      this.mseController.stop();
      this.mseController = null;
    }
    // See pollProgress's "normal live" branch for what this anchors -
    // must be re-derived for every fresh session (a stale value from a
    // previous session/channel would silently corrupt the "how far
    // behind live" calculation for the new one).
    this._liveSessionAbsoluteStart = null;
    this._currentSourceUrl = relayUrl;
    this._closeNativePip();
    this.mseController = attachMseStream(this.videoEl, relayUrl, {
      isVod: false,
      onFatalError: () => {
        console.error("MSE stream attachment failed fatally for", relayUrl);
          // An append-level failure leaves the pipeline just as dead as
          // a vanished relay (a poisoned demuxer never recovers on its
          // own) - route it into the same auto-restart.
          this.onStreamDead?.("MSE pipeline failed");
      },
      onDead: (reason) => this.onStreamDead?.(reason),
      onSilence: (secs) => this.onStreamSilent?.(secs),
    });
  }

  /** Toggles the browser's native Picture-in-Picture for #video-element.
   * This replaces the old approach (detaching mpv's native HWND into a
   * separate always-on-top Win32 popup window via SetParent) - a real
   * <video> element gets this almost for free through the standard
   * Picture-in-Picture Web API, no custom window-management code needed. */
  async togglePip() {
    try {
      if (this.nativePipWindow) {
        // Restoration lives in the tauri://destroyed handler (see
        // enterNativePip), which fires for our button and the window's
        // own X alike - single path for every close route.
        this._closeNativePip();
      } else if (this.docPipWindow) {
        // Same single-path principle: restoration happens in the doc-PiP
        // window's own pagehide handler (see enterDocPip).
        this.docPipWindow.close();
      } else if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        this.applyPipUiState(false);
      } else {
        // The native always-on-top window (enterNativePip) is the FIRST
        // choice, not the fallback, and Document PiP is only attempted
        // if the native window itself fails to open. This inverts the
        // original order deliberately: the old capability-probe design
        // ("try Document PiP once, latch _docPipBroken on failure")
        // assumed WebView2's requestWindow failure was a fixed property
        // of the webview - but it demonstrably is NOT. Observed in the
        // field on the same build and same machine: requestWindow
        // sometimes succeeds and sometimes throws its "Internal error:
        // no window" InvalidStateError, so probe-first produced a
        // coin-flip between two visually different PiP windows across
        // sessions ("sometimes the old pip, sometimes the new pip").
        // The native window is the one tier that can't be flaky - it's
        // a real OS window, not a webview API - so leading with it is
        // what makes the button deterministic.
        try {
          await this.enterNativePip();
        } catch (err) {
          console.warn("Native PiP window failed, falling back to webview PiP tiers:", err?.message || err);
          if (window.documentPictureInPicture && !this._docPipBroken) {
            // Document PiP (Chromium 116+): hosts our own DOM, so the
            // mini-player gets real controls (see enterDocPip). Kept as
            // the first fallback because when it works it shares the
            // main video element - no second stream consumer at all.
            try {
              await this.enterDocPip();
            } catch (err2) {
              this._docPipBroken = true;
              console.warn("Document PiP also unavailable (falling back to classic video PiP):", err2?.message || err2);
              // Don't leak a half-built doc-PiP window if a later setup
              // step failed after requestWindow succeeded
              // (_restoreFromDocPip is null-guarded at every stage).
              if (this.docPipWindow) {
                try { this.docPipWindow.close(); } catch (_) {}
                this._restoreFromDocPip();
              }
              if (document.pictureInPictureEnabled) {
                await this.videoEl.requestPictureInPicture();
                this.applyPipUiState(true);
              } else {
                console.warn("Picture-in-Picture is not supported in this webview.");
              }
            }
          } else if (document.pictureInPictureEnabled) {
            await this.videoEl.requestPictureInPicture();
            this.applyPipUiState(true);
          } else {
            console.warn("Picture-in-Picture is not supported in this webview.");
          }
        }
      }
    } catch (err) {
      console.error("togglePip failed:", err);
    }
  }

  /**
   * Opens the native always-on-top PiP window (pip.html) - the tier that
   * works everywhere, because it's a real OS window rather than a
   * webview API that WebView2 merely pretends to have (see togglePip).
   *
   * The window plays its own copy of the current source (live: second
   * subscriber of the relay broadcast; VOD: own hls.js on the same CDN
   * URL, started at the main player's current position), and the main
   * video keeps playing MUTED underneath - kept running rather than
   * paused so (a) live stays at the live edge, and (b) closing PiP is an
   * instant unmute with zero pipeline work. Volume/mute state carries
   * into the PiP window and the pre-PiP state is restored on close.
   */
  async enterNativePip() {
    if (!this._currentSourceUrl) {
      console.warn("PiP: no active stream source to hand to the PiP window.");
      return;
    }
    // A "pip"-labeled window can outlive our handle to it (webview
    // reload during dev, a creation that raced teardown) - and window
    // labels are unique, so creating over a stale one fails outright.
    // Adopt-and-close any stray before creating fresh.
    const stale = await WebviewWindow.getByLabel("pip").catch(() => null);
    if (stale) {
      await stale.close().catch(() => {});
    }
    const params = new URLSearchParams({
      mode: this._hlsVod ? "vod" : "live",
      src: this._currentSourceUrl,
      pos: String(this.videoEl.currentTime || 0),
      volume: String(this.videoEl.volume),
      muted: this.videoEl.muted ? "1" : "0",
      channel: (this.currentChannel || "").replace(/^vod:/, ""),
      // The PiP window is its OWN document - the main window's
      // body.kick-mode (what flips every --accent to Kick green) does
      // not reach it, so its accent-colored controls (the volume
      // slider) rendered Twitch purple during Kick sessions. pip.js
      // reads this and applies the class to its own body.
      kick: this._isKickSession ? "1" : "0",
    });
    // VOD: hand the pip the pre-resolved LOW quality playlist if one is
    // cached (see resolvePipVodUrl in main.js) - the pip prefers it and
    // falls back to the main-quality src above if it fails.
    if (this._hlsVod) {
      const vid = (this.currentChannel || "").replace(/^vod:/, "");
      try {
        const cached = JSON.parse(localStorage.getItem(`pipVodLowUrl:${vid}`) || "null");
        // Port match = minted by this app session; see resolvePipVodUrl
        // in main.js for why a stale session's URL is a dead localhost
        // port, not just a lower-quality stream.
        const samePort = cached?.url && this._currentSourceUrl &&
          new URL(cached.url).port === new URL(this._currentSourceUrl).port;
        if (samePort && Date.now() - cached.ts < 3 * 3600_000) {
          params.set("lowsrc", cached.url);
        }
      } catch (_) {}
    }
    const win = new WebviewWindow("pip", {
      url: `pip.html?${params}`,
      // True 16:9. The old 302 height was the doc-pip's "16:9 plus a
      // controls strip" shape, but in THIS window the controls are a
      // hover overlay on top of the video (see pip.html), so the video
      // fills the whole window and 480x302 showed ~16px of letterbox
      // out of the box. pip.js also snaps the window to the video's
      // real aspect after any user resize.
      width: 480,
      height: 270,
      // Floor stops resizes into unusable slivers and gives pip.js's
      // aspect snap a sane minimum to work against.
      minWidth: 192,
      minHeight: 108,
      alwaysOnTop: true,
      decorations: false,
      resizable: true,
      // Maximize makes no sense for an aspect-locked floating player,
      // and a maximize/restore cycle leaves the window misshapen (the
      // restore's resize event runs the aspect snap against whichever
      // axis the maximize distorted). The drag-region double-click that
      // used to trigger this is intercepted in pip.js (it pauses now);
      // this shuts the door on the OS-level routes (Win+Up, snap
      // layouts, aero shake targets) as well.
      maximizable: false,
      // false = the window gets a taskbar button and an alt-tab entry
      // (titled "PiP — channel", see pip.js). This was originally true,
      // but on Windows skipTaskbar applies WS_EX_TOOLWINDOW, which
      // removes the window from alt-tab along with the taskbar - and a
      // frameless always-on-top window with NO alt-tab entry is
      // unreachable the moment its monitor goes away (the whole reason
      // rescueNativePip exists). Alt-tab-without-taskbar isn't a
      // combination the OS or Tauri offers, so we take both: it also
      // means alt-tab focus + Win+Shift+arrow works as a manual rescue.
      skipTaskbar: false,
      title: "PiP",
      // Created INVISIBLE on purpose: pip.js restores the last-used
      // position (or computes the bottom-right default) and only then
      // shows the window - otherwise the OS places it at its own
      // cascade position first and the window visibly teleports.
      visible: false,
    });
    await new Promise((resolve, reject) => {
      win.once("tauri://created", resolve);
      win.once("tauri://error", (e) => reject(new Error(e?.payload ?? "PiP window creation failed")));
    });
    this.nativePipWindow = win;
    this._nativePipRestore = { muted: this.videoEl.muted };
    this.videoEl.muted = true;
    this.applyPipUiState(true);
    // Fires for every way the window can die - our toggle button
    // (_closeNativePip), its own X, or the OS - so, like the doc-pip
    // pagehide handler, restoration lives in exactly one place.
    win.once("tauri://destroyed", () => {
      if (this.nativePipWindow !== win) return; // a newer PiP already replaced this one
      this.nativePipWindow = null;
      if (this._nativePipRestore) {
        this.videoEl.muted = this._nativePipRestore.muted;
        this._nativePipRestore = null;
      }
      this.applyPipUiState(false);
    });
  }

  /** Closes the native PiP window if open. Safe to call at any time;
   * state restoration happens in the tauri://destroyed handler set up in
   * enterNativePip, not here. */
  _closeNativePip() {
    if (this.nativePipWindow) {
      this.nativePipWindow.close().catch(() => {});
    }
  }

  /**
   * Moves the native PiP window onto the SAME monitor as the main window
   * (bottom-right, same corner as first-run placement) and shows/focuses
   * it. This is the recovery path for a PiP stranded on a display that's
   * been unplugged or input-switched to another machine: the window is
   * frameless + always-on-top + skip-taskbar, so the OS offers no
   * alt-tab entry, taskbar button, or title bar to reach it with.
   *
   * Looks the window up by label rather than using this.nativePipWindow
   * so it also works on a stray window whose handle we lost to a webview
   * reload. Moving it fires the pip page's own onMoved handler, which
   * updates the persisted position - so the NEXT PiP opens on the
   * visible monitor too, instead of restoring the dead spot.
   */
  async rescueNativePip() {
    const win = this.nativePipWindow
      || await WebviewWindow.getByLabel("pip").catch(() => null);
    if (!win) {
      // Nothing to rescue - the UI was stale; square it up.
      this.applyPipUiState(false);
      return;
    }
    try {
      // currentMonitor() is relative to the calling webview's window,
      // i.e. THIS (main) window's monitor - which is by definition one
      // the user can see, since they just clicked a button on it.
      const mon = await currentMonitor();
      if (!mon) return;
      // A size saved on a big external display may not fit the screen
      // we're rescuing onto (e.g. a laptop panel) - shrink to fit first
      // so "bottom-right with margin" can't still hang off-screen.
      let w = 480, h = 270;
      const size = await win.outerSize().catch(() => null);
      if (size?.width && size?.height) { w = size.width; h = size.height; }
      const maxW = Math.round(mon.size.width * 0.9);
      const maxH = Math.round(mon.size.height * 0.9);
      if (w > maxW || h > maxH) {
        const scale = Math.min(maxW / w, maxH / h);
        w = Math.max(192, Math.round(w * scale));
        h = Math.max(108, Math.round(h * scale));
        await win.setSize(new PhysicalSize(w, h)).catch(() => {});
      }
      const margin = Math.round(24 * (mon.scaleFactor || 1));
      await win.setPosition(new PhysicalPosition(
        mon.position.x + mon.size.width - w - margin,
        mon.position.y + mon.size.height - h - margin,
      ));
      // show() covers the edge case of a window that died between its
      // hidden creation and placeWindow's show; setFocus makes the
      // rescue visibly land ("there it is") and lets keyboard/drag work
      // immediately.
      await win.show().catch(() => {});
      await win.setFocus().catch(() => {});
    } catch (err) {
      console.warn("PiP rescue failed:", err?.message || err);
    }
  }

  /** Close button in the PiP placeholder: closes whichever PiP tier is
   * actually open (the placeholder shows for all three), including a
   * stray native window we lost the handle to. */
  async closePipAnyTier() {
    if (this.nativePipWindow) { this._closeNativePip(); return; }
    if (this.docPipWindow) { this.docPipWindow.close(); return; }
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture().catch(() => {});
      this.applyPipUiState(false);
      return;
    }
    const stray = await WebviewWindow.getByLabel("pip").catch(() => null);
    if (stray) await stray.close().catch(() => {});
    this.applyPipUiState(false);
  }

  /**
   * Re-adopts a "pip"-labeled window that survived a main-webview reload
   * (dev reload, crash-recovery reload). Without this, nativePipWindow
   * is null while the window still exists: the placeholder/rescue UI
   * never appears and togglePip would CREATE a new PiP - which
   * enterNativePip does by closing the stray and reopening at the saved
   * position, i.e. right back on the unreachable monitor.
   *
   * Adoption is deliberately minimal: track the handle, show the in-PiP
   * UI, clear both when it dies. There's no mute state to restore -
   * the pre-PiP state belonged to the previous page lifetime.
   */
  async _adoptStrayPip() {
    if (this.nativePipWindow) return;
    const stray = await WebviewWindow.getByLabel("pip").catch(() => null);
    if (!stray || this.nativePipWindow) return; // second check: enterNativePip may have raced us
    this.nativePipWindow = stray;
    this._nativePipRestore = null;
    this.applyPipUiState(true);
    stray.once("tauri://destroyed", () => {
      if (this.nativePipWindow !== stray) return;
      this.nativePipWindow = null;
      this.applyPipUiState(false);
    });
  }


  /**
   * Opens a Document Picture-in-Picture window and MOVES the live <video>
   * element into it, alongside a custom mini controls bar (play/pause,
   * mute, volume slider - the slider being the whole reason this exists,
   * see togglePip). Moving the element is the API's designed usage and
   * playback continues uninterrupted in Chromium; crucially nothing here
   * touches videoEl.src or calls load(), which WOULD reset the MSE
   * pipeline feeding it.
   *
   * Everything is restored by the pagehide handler at the bottom: that
   * fires for every way the window can close (our pip button, the PiP
   * window's own close button, stop() below), so restore logic lives in
   * exactly one place.
   */
  async enterDocPip() {
    const pipWin = await window.documentPictureInPicture.requestWindow({
      width: 480,
      height: 302, // 16:9 video + the 32px controls bar
    });
    this.docPipWindow = pipWin;
    this._docPipAbort = new AbortController();
    const signal = this._docPipAbort.signal;

    // Copy the app's stylesheets into the PiP document so the controls
    // pick up the same theme (.docpip-* rules live in styles.css like
    // everything else). Rule-by-rule copy rather than cloning <link>
    // nodes: the PiP document's base URL isn't the app's, so relative
    // hrefs wouldn't resolve - and everything is same-origin here, so
    // cssRules access can't throw for the fallback reason it usually
    // would.
    for (const sheet of document.styleSheets) {
      try {
        const style = pipWin.document.createElement("style");
        style.textContent = [...sheet.cssRules].map((r) => r.cssText).join("\n");
        pipWin.document.head.appendChild(style);
      } catch (_) {
        if (sheet.href) {
          const link = pipWin.document.createElement("link");
          link.rel = "stylesheet";
          link.href = sheet.href;
          pipWin.document.head.appendChild(link);
        }
      }
    }

    // Remember where the video came from so it can be put back exactly -
    // nextSibling included, since #video-region has other children (the
    // center play button, the PiP placeholder) and order matters to CSS.
    this._docPipRestore = {
      parent: this.videoEl.parentNode,
      nextSibling: this.videoEl.nextSibling,
    };

    const doc = pipWin.document;
    doc.body.className = "docpip-body";
    // Same reason as enterNativePip's `kick` param: the copied
    // stylesheet includes the body.kick-mode variable overrides, but
    // this separate document's body needs the class for them to apply -
    // otherwise the volume slider's accent-color resolves to the :root
    // default (Twitch purple) mid-Kick-session.
    if (this._isKickSession) doc.body.classList.add("kick-mode");
    doc.body.appendChild(this.videoEl); // implicit adoptNode; playback continues

    const bar = doc.createElement("div");
    bar.className = "docpip-controls";
    // Small inline SVGs rather than cloning the main window's - those
    // carry ids (#volume-icon etc.) that must stay unique per document,
    // and the paths are tiny.
    bar.innerHTML = `
      <button class="docpip-btn" data-act="playpause" title="Play/Pause">
        <svg class="docpip-pause-icon" viewBox="0 0 24 24" width="16" height="16"><path d="M6 4h4v16H6zM14 4h4v16h-4z" fill="currentColor"/></svg>
        <svg class="docpip-play-icon" viewBox="0 0 24 24" width="16" height="16" style="display:none"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>
      </button>
      <button class="docpip-btn" data-act="mute" title="Mute/Unmute">
        <svg class="docpip-vol-icon" viewBox="0 0 24 24" width="16" height="16"><path d="M3 9v6h4l5 5V4L7 9H3z" fill="currentColor"/></svg>
        <svg class="docpip-mute-icon" viewBox="0 0 24 24" width="16" height="16" style="display:none"><path d="M3 9v6h4l5 5V4L7 9H3zm13.6 3 2.7-2.7-1.4-1.4-2.7 2.7-2.7-2.7-1.4 1.4 2.7 2.7-2.7 2.7 1.4 1.4 2.7-2.7 2.7 2.7 1.4-1.4-2.7-2.7z" fill="currentColor"/></svg>
      </button>
      <input class="docpip-volume volume-slider" type="range" min="0" max="130" title="Volume" />
    `;
    doc.body.appendChild(bar);

    this._pipEls = {
      slider: bar.querySelector(".docpip-volume"),
      volIcon: bar.querySelector(".docpip-vol-icon"),
      muteIcon: bar.querySelector(".docpip-mute-icon"),
      playIcon: bar.querySelector(".docpip-play-icon"),
      pauseIcon: bar.querySelector(".docpip-pause-icon"),
    };
    // Initial state mirrors the main window's right now.
    this._pipEls.slider.value = this.volumeSlider.value;
    this._syncPipMuteIcon(this.isMuted);
    this._syncPipPauseIcon(this.videoEl.paused);

    // The slider drives the exact same path as the main window's slider
    // (including the unmute-on-volume-up behavior) - setVolume() then
    // mirrors the value back onto BOTH sliders, so the two can never
    // disagree regardless of which one was dragged.
    this._pipEls.slider.addEventListener("input", (e) => {
      this.setVolume(Number(e.target.value));
    }, { signal });
    bar.querySelector('[data-act="mute"]').addEventListener("click", () => {
      this.toggleMute();
    }, { signal });
    bar.querySelector('[data-act="playpause"]').addEventListener("click", () => {
      this.togglePause();
    }, { signal });
    // Same "reflect whatever actually changed video.paused" reasoning as
    // the main window's listeners in bindEvents() - but these two are
    // PiP-scoped (AbortController) because the video element outlives
    // the PiP window and must not accumulate a listener pair per PiP
    // session.
    this.videoEl.addEventListener("play", () => this._syncPipPauseIcon(false), { signal });
    this.videoEl.addEventListener("pause", () => this._syncPipPauseIcon(true), { signal });

    pipWin.addEventListener("pagehide", () => this._restoreFromDocPip(), { signal });

    this.applyPipUiState(true);
  }

  /** Puts the video element back where enterDocPip took it from and
   * clears all PiP-scoped state/listeners. Runs on the PiP window's
   * pagehide - the single choke point for every close path. */
  _restoreFromDocPip() {
    const restore = this._docPipRestore;
    if (restore?.parent) {
      restore.parent.insertBefore(this.videoEl, restore.nextSibling);
    }
    this._docPipAbort?.abort();
    this._docPipAbort = null;
    this._docPipRestore = null;
    this._pipEls = null;
    this.docPipWindow = null;
    this.applyPipUiState(false);
  }

  _syncPipMuteIcon(muted) {
    if (!this._pipEls) return;
    this._pipEls.volIcon.style.display = muted ? "none" : "block";
    this._pipEls.muteIcon.style.display = muted ? "block" : "none";
    // Tooltip carries the actual level rather than just "Volume". The
    // slider runs 0-130 like the main one (values above 100 are the
    // boost range), so the percentage is the raw value, not a 0-1
    // fraction. This sync method is already called from every path
    // that changes mute state, and setVolume mirrors values onto both
    // sliders through the same flow - so updating here plus reading
    // the slider's own mirrored value keeps the tooltip truthful for
    // drags on either slider and for mute toggles alike.
    this._pipEls.slider.title = muted
      ? "Muted"
      : `${Math.round(Number(this._pipEls.slider.value))}%`;
  }

  _syncPipPauseIcon(paused) {
    if (!this._pipEls) return;
    this._pipEls.playIcon.style.display = paused ? "block" : "none";
    this._pipEls.pauseIcon.style.display = paused ? "none" : "block";
  }

  /** Updates all the PiP-related UI (button state, placeholder) to match
   * the given in-PiP state. Shared by togglePip (manual button click) and
   * the leavepictureinpicture listener (OS-drawn PiP window closed some
   * other way, e.g. its own close button), since both need to land on
   * exactly the same visual end state. */
  applyPipUiState(inPip) {
    this.inPip = inPip;
    // "Bring PiP to this screen" only makes sense for the native window
    // tier - doc-pip and classic video PiP are OS/browser-managed
    // windows Tauri can't reposition. The close button stays for all
    // tiers (closePipAnyTier handles each).
    if (this.pipBringBtn) {
      this.pipBringBtn.style.display = (inPip && this.nativePipWindow) ? "" : "none";
    }
    if (inPip) {
      this.pipBtn?.classList.add("pip-active");
      this.pipBtn?.setAttribute("title", "Return from Picture in Picture");
      // Show the PiP placeholder so the blank video area isn't confusing.
      this.videoRegionEl?.classList.add("in-pip");
      // Hide the controls bar - there's no video to hover over anymore.
      this.videoFrame.classList.remove("controls-visible");
    } else {
      this.pipBtn?.classList.remove("pip-active");
      this.pipBtn?.setAttribute("title", "Picture in Picture");
      this.videoRegionEl?.classList.remove("in-pip");
    }
  }

  stop() {
    if (this.docPipWindow) {
      // close() fires the PiP window's pagehide, whose handler
      // (_restoreFromDocPip) synchronously puts the video element back
      // in the main DOM - which must happen BEFORE the src teardown
      // below so load() runs on an element that's back in its real home.
      this.docPipWindow.close();
    }
    this._closeNativePip();
    if (this.inPip) {
      this.inPip = false;
      this.pipBtn?.classList.remove("pip-active");
      this.pipBtn?.setAttribute("title", "Picture in Picture");
      this.videoRegionEl?.classList.remove("in-pip");
    }
    if (document.pictureInPictureElement === this.videoEl) {
      document.exitPictureInPicture().catch(() => {});
    }
    this.active = false;
    if (this.progressInterval) {
      clearInterval(this.progressInterval);
      this.progressInterval = null;
    }
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    if (this._hlsVod) {
      this._hlsVod.destroy();
      this._hlsVod = null;
    }
    if (this.mseController) {
      this.mseController.stop();
      this.mseController = null;
    }
    this.videoEl.removeAttribute("src");
    this.videoEl.load();
    this.videoFrame.classList.remove("controls-visible");
    this.setPauseIcon(false);
    this.seekBarFill.style.width = "0%";
    this.renderMutedSegments([], 0);
    this.isVod = false;
    this.vodTotalSeconds = 0;
    this._liveDvr = null;
    this.liveDvrStreamStartedAt = null;
    this.liveBtn.style.display = "";
    this.timeDisplay.textContent = "live";
    this.liveBtn.classList.remove("at-live-edge");
    this.lastKnownPosition = 0;
    this.lastKnownDuration = 0;
    this._liveSessionAbsoluteStart = null;
    this.qualityMenu.classList.remove("open");
    this.qualityMenu.innerHTML = "";
    this.cachedQualities = null;
    this._qualitiesPromise = null;
    this._disableAutoMode();
  }

  /** Shows/hides the quality dropdown. Opening it renders from the
   * prefetched cache if ready (instant), or waits for the in-flight
   * prefetch if it's still running (brief "Loading…" then instant). */
  toggleQualityMenu() {
    const opening = !this.qualityMenu.classList.contains("open");
    if (opening) {
      this.positionQualityMenu();
      this.loadQualityMenu();
    }
    this.qualityMenu.classList.toggle("open", opening);
  }

  /**
   * Positions the quality menu as a horizontal flyout extending leftward
   * from the settings button, vertically centered on it. The controls bar
   * always has horizontal width to spare, so this is the same every time,
   * just computed from the button's current on-screen position (which
   * changes if the window is resized/moved).
   */
  positionQualityMenu() {
    const buttonRect = this.settingsBtn.getBoundingClientRect();

    this.qualityMenu.style.left = "";
    this.qualityMenu.style.right = `${window.innerWidth - buttonRect.right}px`;
    // Open upward: bottom of menu sits 4px above the top of the button.
    this.qualityMenu.style.bottom = `${window.innerHeight - buttonRect.top + 4}px`;
    this.qualityMenu.style.top = "";
    this.qualityMenu.style.transform = "";
  }

  /** Removes the "audio_only" entry streamlink includes in its qualities
   * list - there's no video for the player to show with it (it strips
   * out picture and probably crashes/black-screens the in-DOM <video>
   * element this app actually feeds), so it was never a meaningful
   * choice in the quality menu, just a confusing one. _autoQualityTiers()
   * already filtered this same entry out for the auto step-up/step-down
   * logic; calling this helper at both points qualities get resolved
   * (_prefetchQualities() and loadQualityMenu()'s fallback path) means
   * cachedQualities itself never contains "audio_only" at all, so every
   * consumer - the menu, auto mode, anything added later - is covered by
   * construction rather than needing its own filter. */
  _stripAudioOnly(qualities) {
    if (!Array.isArray(qualities)) return qualities;
    return qualities.filter((q) => q !== "audio_only");
  }

  /** Fires the streamlink quality probe in the background and caches the
   * result. Called once from start() so the result is ready by the time
   * the user opens the settings menu. The returned promise is stored in
   * this._qualitiesPromise so loadQualityMenu() can await it if the user
   * opens the menu before the probe finishes. */
  _prefetchQualities() {
    if (!this.currentChannel) return;
    this._qualitiesPromise = (
      this.isVod
        ? invoke("get_available_vod_qualities", {
            videoId: this.currentChannel.replace(/^vod:/, ""),
          })
        : invoke("get_available_qualities", { channel: this.currentChannel })
    )
      .then((qualities) => {
        this.cachedQualities = Array.isArray(qualities) ? this._stripAudioOnly(qualities) : null;
        this._qualitiesPromise = null;
        return this.cachedQualities;
      })
      .catch((err) => {
        console.error("[quality prefetch] failed:", err);
        this._qualitiesPromise = null;
        return null;
      });
  }

  /**
   * Opens the quality dropdown. If the prefetch has already resolved the
   * menu renders without any "Loading…" flash. If the prefetch is still
   * in flight the menu shows "Loading…" and renders the moment it resolves
   * (usually a fraction of a second later since the probe started at stream
   * launch). A full fresh fetch is only done as a last resort (prefetch
   * never started, e.g. a codepath that skips start()).
   */
  async loadQualityMenu() {
    if (!this.currentChannel) return;

    // Kick sessions play hls.js directly on Kick's own master playlist,
    // which already lists every rendition - quality here means picking
    // an hls.js LEVEL, not restarting a streamlink relay (there is no
    // streamlink in a Kick session, and get_available_qualities would
    // probe twitch.tv/<slug>: the wrong site entirely). Twitch and its
    // relay-restart machinery below stay untouched.
    if (this._isKickSession) {
      this._loadKickQualityMenu();
      return;
    }

    // Already cached - render immediately with zero latency.
    if (this.cachedQualities) {
      this._renderQualityItems(this.cachedQualities);
      return;
    }

    this.qualityMenu.innerHTML = '<div class="quality-menu-empty">Loading…</div>';

    let qualities;
    try {
      if (this._qualitiesPromise) {
        // Prefetch in progress - await it instead of starting a duplicate probe.
        qualities = await this._qualitiesPromise;
      } else {
        // Fallback: start a fresh fetch (shouldn't normally happen).
        qualities = this.isVod
          ? await invoke("get_available_vod_qualities", {
              videoId: this.currentChannel.replace(/^vod:/, ""),
            })
          : await invoke("get_available_qualities", { channel: this.currentChannel });
      }
    } catch (err) {
      console.error("Failed to load qualities:", err);
      this.qualityMenu.innerHTML = '<div class="quality-menu-empty">Failed to load</div>';
      return;
    }
    qualities = this._stripAudioOnly(qualities);

    if (!qualities || qualities.length === 0) {
      this.qualityMenu.innerHTML = '<div class="quality-menu-empty">No qualities found</div>';
      return;
    }

    this._renderQualityItems(qualities);
  }

  /** Kick counterpart of loadQualityMenu's fetch step: the "fetch" is
   * just reading this._hlsVod.levels, populated by hls.js from the
   * master playlist at MANIFEST_PARSED. If that hasn't happened yet
   * (menu opened in the first moments of playback), show Loading and
   * re-render the moment it does - the same UX as the Twitch prefetch
   * still being in flight. */
  _loadKickQualityMenu() {
    const hls = this._hlsVod;
    if (!hls) {
      // Native-HLS fallback path (attachHlsVod returned null): the
      // <video> element owns rendition choice, nothing to offer.
      this.qualityMenu.innerHTML =
        '<div class="quality-menu-empty">Quality selection unavailable</div>';
      return;
    }
    if (!Array.isArray(hls.levels) || hls.levels.length === 0) {
      this.qualityMenu.innerHTML = '<div class="quality-menu-empty">Loading…</div>';
      // 'hlsManifestParsed' === Hls.Events.MANIFEST_PARSED - string
      // literal so this file doesn't need its own hls.js import
      // (vod-player.js owns that dependency).
      hls.once("hlsManifestParsed", () => {
        // Only if the user still has the menu open on the same session.
        if (this._isKickSession && this.qualityMenu.classList.contains("open")) {
          this._renderKickQualityItems();
        }
      });
      return;
    }
    this._renderKickQualityItems();
  }

  /** Human label for one hls.js level. Kick's IVS playlists usually
   * carry a NAME attribute ("1080p60", "480p30", ...); fall back to
   * height+fps, then bitrate, so a schema change degrades to something
   * still meaningful rather than blank pills. */
  _kickLevelLabel(level) {
    const name = level?.attrs?.NAME || level?.name;
    if (name) return String(name);
    if (level?.height) {
      const fps =
        level.frameRate && Math.round(level.frameRate) > 30
          ? String(Math.round(level.frameRate))
          : "";
      return `${level.height}p${fps}`;
    }
    if (level?.bitrate) return `${Math.round(level.bitrate / 1000)} kbps`;
    return "Unknown";
  }

  /** Renders the Kick quality pills: Auto (hls.js ABR) + one pill per
   * level, highest first. Same pill classes as the Twitch renderer so
   * the menu looks identical; no Low Latency toggle (that's a
   * streamlink/relay concept with no Kick equivalent). */
  _renderKickQualityItems() {
    const hls = this._hlsVod;
    if (!hls) return;
    this.qualityMenu.innerHTML = "";

    const pillsRow = document.createElement("div");
    pillsRow.className = "quality-menu-pills";

    const auto = hls.autoLevelEnabled;

    const autoItem = document.createElement("button");
    autoItem.className = "quality-menu-item" + (auto ? " active" : "");
    autoItem.textContent = "Auto";
    autoItem.title = "Adaptive — picks the rendition for current bandwidth";
    autoItem.addEventListener("click", (e) => {
      e.stopPropagation();
      this._selectKickLevel(-1);
    });
    pillsRow.appendChild(autoItem);

    const sep = document.createElement("div");
    sep.className = "quality-menu-sep";
    pillsRow.appendChild(sep);

    // Display order: highest first (resolution, then bitrate as the
    // tiebreaker) - indices into hls.levels are preserved via map.
    const orderedIdxs = hls.levels
      .map((_, i) => i)
      .sort(
        (a, b) =>
          (hls.levels[b].height || 0) - (hls.levels[a].height || 0) ||
          (hls.levels[b].bitrate || 0) - (hls.levels[a].bitrate || 0)
      );
    for (const i of orderedIdxs) {
      const item = document.createElement("button");
      item.className = "quality-menu-item";
      if (!auto && hls.currentLevel === i) item.classList.add("active");
      item.textContent = this._kickLevelLabel(hls.levels[i]);
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        this._selectKickLevel(i);
      });
      pillsRow.appendChild(item);
    }

    this.qualityMenu.appendChild(pillsRow);
  }

  /** Applies a Kick quality pick: -1 = auto (hls.js ABR), otherwise an
   * index into this._hlsVod.levels. currentLevel (not nextLevel) so the
   * switch is immediate - hls.js flushes the forward buffer and fetches
   * the new rendition from the current position, matching how a quality
   * click feels on Twitch. */
  _selectKickLevel(idx) {
    const hls = this._hlsVod;
    if (!hls) return;
    hls.currentLevel = idx;
    this._kickPreferredLevelLabel =
      idx === -1 ? null : this._kickLevelLabel(hls.levels[idx]);
    // Kept for display parity (anything showing currentQuality) - the
    // Twitch restart machinery never reads it during a Kick session.
    this.currentQuality = idx === -1 ? "auto" : this._kickPreferredLevelLabel;
    this.qualityMenu.classList.remove("open");
  }

  /** Re-applies the remembered Kick rendition on a freshly-attached hls
   * instance (every live<->DVR swap creates one; level indices don't
   * survive across manifests, labels do). Called from attachHlsDvr for
   * Kick sessions; a no-op when the user hasn't picked one (auto). */
  _applyKickPreferredLevel() {
    const wanted = this._kickPreferredLevelLabel;
    const hls = this._hlsVod;
    if (!wanted || !hls) return;
    const apply = () => {
      if (this._hlsVod !== hls) return; // superseded by another attach
      const idx = hls.levels.findIndex(
        (lv) => this._kickLevelLabel(lv) === wanted
      );
      if (idx >= 0) {
        hls.currentLevel = idx;
      }
      // No exact match (renditions can differ between the live playlist
      // and the recording): stay on auto rather than guessing wrong.
    };
    if (Array.isArray(hls.levels) && hls.levels.length > 0) apply();
    else hls.once("hlsManifestParsed", apply);
  }

  /** Renders the quality pill buttons from a resolved qualities array,
   * plus the Low Latency toggle below them (live streams only). */
  _renderQualityItems(qualities) {
    this.qualityMenu.innerHTML = "";

    const pillsRow = document.createElement("div");
    pillsRow.className = "quality-menu-pills";

    // --- Auto quality (live only) ---
    if (!this.isVod) {
      const autoItem = document.createElement("button");
      autoItem.className = "quality-menu-item" + (this.autoQualityMode ? " active" : "");
      autoItem.textContent = "Auto";
      autoItem.title = "Starts at best quality, steps down automatically when buffering";
      autoItem.addEventListener("click", (e) => {
        e.stopPropagation();
        this.selectQuality("auto");
      });
      pillsRow.appendChild(autoItem);

      const sep = document.createElement("div");
      sep.className = "quality-menu-sep";
      pillsRow.appendChild(sep);
    }

    // --- Specific quality options ---
    // Reversed for DISPLAY only (highest resolution first, matching how
    // most viewers scan a quality list top-to-bottom) - qualities itself
    // must stay in the ascending order Rust returns it in, since
    // _autoQualityTiers() elsewhere indexes into that same ascending
    // order for its step-up/step-down logic. Spreading into a new array
    // before reversing (not qualities.reverse()) avoids mutating
    // whatever this.cachedQualities-derived array was passed in.
    const ordered = ["best", ...[...qualities].reverse()];
    for (const quality of ordered) {
      const item = document.createElement("button");
      item.className = "quality-menu-item";
      // In auto mode no specific quality is highlighted; 'Auto' row is.
      if (!this.autoQualityMode && quality === this.currentQuality) {
        item.classList.add("active");
      }
      item.textContent =
        quality === "best" ? "Best" : quality === "worst" ? "Worst" : quality;
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        this.selectQuality(quality);
      });
      pillsRow.appendChild(item);
    }
    this.qualityMenu.appendChild(pillsRow);

    // --- Low Latency toggle (live streams only) ---
    if (!this.isVod) {
      const divider = document.createElement("div");
      divider.className = "quality-menu-divider";
      this.qualityMenu.appendChild(divider);

      const toggle = document.createElement("button");
      toggle.className = "quality-menu-toggle" + (this.lowLatency ? " on" : "");
      toggle.title = "Reduces stream delay to ~3-5 s (requires stream restart)";

      const switchPip = document.createElement("span");
      switchPip.className = "quality-toggle-switch";

      const label = document.createElement("span");
      label.textContent = "Low Latency";

      toggle.appendChild(switchPip);
      toggle.appendChild(label);

      toggle.addEventListener("click", (e) => {
        e.stopPropagation();
        this.lowLatency = !this.lowLatency;
        toggle.classList.toggle("on", this.lowLatency);
        this.onLowLatencyChange(this.lowLatency);
        this.qualityMenu.classList.remove("open");
      });

      this.qualityMenu.appendChild(toggle);
    }
  }

  // ---------------------------------------------------------------------------
  // Auto quality — adaptive step-down on stalls, step-up on sustained
  // good network conditions (see the constructor comment above for the
  // full reasoning on why the two directions use different signals).
  // ---------------------------------------------------------------------------

  /** Enables auto mode: starts listening for stall events on the video,
   * and starts the step-up polling timer. */
  _enableAutoMode() {
    this.autoQualityMode = true;
    this._autoTierIdx   = -1; // -1 = currently at 'best'
    this._autoStallCount = 0;
    this._lastStallAt = 0;
    clearTimeout(this._autoStallDebounce);
    clearTimeout(this._autoStallResetTimer);
    this.videoEl.addEventListener("waiting", this._boundAutoStall);

    clearInterval(this._autoStepUpInterval);
    this._autoStepUpInterval = setInterval(
      () => this._maybeStepUpAutoQuality(),
      STEP_UP_CHECK_MS,
    );
  }

  /** Disables auto mode, removes stall listeners, and stops the step-up
   * polling timer. */
  _disableAutoMode() {
    if (!this.autoQualityMode) return;
    this.autoQualityMode  = false;
    this._autoTierIdx     = -1;
    this._autoStallCount  = 0;
    this._lastStallAt = 0;
    clearTimeout(this._autoStallDebounce);
    clearTimeout(this._autoStallResetTimer);
    this._autoStallDebounce  = null;
    this._autoStallResetTimer = null;
    this.videoEl.removeEventListener("waiting", this._boundAutoStall);

    clearInterval(this._autoStepUpInterval);
    this._autoStepUpInterval = null;
  }

  /**
   * Called whenever the video fires 'waiting'. Uses a 3-second debounce to
   * distinguish a real sustained stall from a brief network jitter blip:
   * if the video is still in a low-readyState after 3 s, count it as a
   * stall. Two stalls within 90 s → step down one quality tier.
   */
  _handleAutoStall() {
    if (!this.autoQualityMode) return;
    clearTimeout(this._autoStallDebounce);
    this._autoStallDebounce = setTimeout(() => {
      if (!this.autoQualityMode) return;
      // Only act if the video is genuinely still buffering (readyState < 3).
      if (this.videoEl.readyState < HTMLVideoElement.HAVE_FUTURE_DATA) {
        this._autoStallCount++;
        // Recorded regardless of whether this particular stall crosses
        // the step-down threshold below - _maybeStepUpAutoQuality() uses
        // this on its own to refuse a step-up shortly after ANY stall,
        // not just after a full step-down cycle.
        this._lastStallAt = Date.now();
        // Reset the stall counter after 90 s of smooth playback so old
        // stalls don't accumulate against a later, unrelated network blip.
        clearTimeout(this._autoStallResetTimer);
        this._autoStallResetTimer = setTimeout(() => {
          this._autoStallCount = 0;
        }, 90_000);

        if (this._autoStallCount >= 2) {
          this._autoStallCount = 0;
          this._stepDownAutoQuality();
        }
      }
    }, 3000);
  }

  /**
   * Steps down one quality tier. Tiers are sorted lowest-to-highest by
   * resolution number so we can just decrement the index. When at 'best'
   * we jump to the top named tier first; at the bottom we give up.
   */
  _stepDownAutoQuality() {
    const tiers = this._autoQualityTiers();
    if (!tiers.length) return;

    if (this._autoTierIdx === -1) {
      // Currently at 'best' — move to the highest specific tier.
      this._autoTierIdx = tiers.length - 1;
    } else if (this._autoTierIdx > 0) {
      this._autoTierIdx--;
    } else {
      return; // already at the lowest; nothing lower to try
    }

    const next = tiers[this._autoTierIdx];
    console.log(`[auto quality] buffering — stepping down to ${next}`);
    this.onQualityChange(next); // triggers restartStreamWithQuality in main.js
  }

  /**
   * Returns the browser's current downlink bandwidth estimate in Mbps via
   * the (Chromium-only) Network Information API, or null if unsupported -
   * Firefox and Safari don't implement navigator.connection at all, and
   * even in Chromium it's an estimate built from recent transfers, not a
   * guarantee, which is why _maybeStepUpAutoQuality() additionally
   * requires a stall-free quiet period before trusting it for a step-up.
   * Returning null (rather than e.g. 0 or Infinity) lets the caller treat
   * "no signal available" distinctly from "signal says bandwidth is bad" -
   * see its use below, where null means step-up is simply never attempted
   * on an unsupported browser rather than either always or never firing.
   */
  _estimateDownlinkMbps() {
    const conn = navigator.connection
      || navigator.mozConnection
      || navigator.webkitConnection;
    if (!conn || typeof conn.downlink !== "number") return null;
    return conn.downlink;
  }

  /**
   * Looks up RESOLUTION_MBPS for an exact match, or - for a resolution not
   * in the table (e.g. a channel exposing an unusual tier) - scales from
   * the nearest known entry by the ratio of resolution numbers squared
   * (bitrate need scales roughly with pixel count, not linear resolution
   * height), so an unlisted tier still gets a sane estimate instead of
   * silently falling back to undefined/NaN and never stepping up past it.
   */
  _requiredMbpsForResolution(res) {
    if (RESOLUTION_MBPS[res] != null) return RESOLUTION_MBPS[res];
    const known = Object.keys(RESOLUTION_MBPS).map(Number);
    const nearest = known.reduce((a, b) =>
      Math.abs(b - res) < Math.abs(a - res) ? b : a
    );
    const scale = (res * res) / (nearest * nearest);
    return RESOLUTION_MBPS[nearest] * scale;
  }

  // Polled while auto mode is active. Steps up one tier (never straight to
  // 'best') when: not already at top, no stall in STEP_UP_MIN_QUIET_MS, and
  // navigator.connection.downlink clears the next tier's bitrate by
  // STEP_UP_HEADROOM. One tier at a time so a wrong guess costs one restart.
  // No downlink support (Firefox/Safari) means this no-ops, leaving step-down.
  _maybeStepUpAutoQuality() {
    if (!this.autoQualityMode) return;
    if (this._autoTierIdx === -1) return; // already at 'best'

    if (Date.now() - this._lastStallAt < STEP_UP_MIN_QUIET_MS) return;

    const tiers = this._autoQualityTiers();
    if (!tiers.length) return;

    // _autoTierIdx indexes into tiers when not at 'best' (-1). The tier
    // ABOVE the current one is index + 1; tiers.length means "above the
    // highest specific tier," i.e. 'best' itself.
    const nextIdx = this._autoTierIdx + 1;
    const movingToBest = nextIdx >= tiers.length;
    const nextLabel = movingToBest ? "best" : tiers[nextIdx];

    const downlinkMbps = this._estimateDownlinkMbps();
    if (downlinkMbps == null) return; // unsupported browser - never guess blind

    // 'best' has no known resolution number to look up - use the highest
    // specific tier's requirement as the bar to clear, since 'best' is
    // never lower bitrate than that by definition.
    const targetRes = movingToBest
      ? this._rankResolution(tiers[tiers.length - 1])
      : this._rankResolution(nextLabel);
    const requiredMbps = this._requiredMbpsForResolution(targetRes);

    if (downlinkMbps < requiredMbps * STEP_UP_HEADROOM) return;

    this._autoTierIdx = movingToBest ? -1 : nextIdx;
    console.log(
      `[auto quality] network supports more (~${downlinkMbps.toFixed(1)} Mbps) ` +
      `— stepping up to ${nextLabel}`
    );
    this.onQualityChange(nextLabel);
  }

  /** Shared resolution-number extraction, used by both _autoQualityTiers()'s
   * sort and the step-up bitrate lookup above, so the two can never drift
   * out of sync with each other on what "the resolution" of a label means. */
  _rankResolution(q) {
    const m = q.match(/^(\d+)/);
    return m ? +m[1] : 0;
  }

  /**
   * Returns the cached qualities sorted ascending by resolution
   * (worst→best). The audio_only filter here is now a defensive
   * backstop, not the primary mechanism - _stripAudioOnly() already
   * removes it at the source (see _prefetchQualities()/
   * loadQualityMenu()), so cachedQualities itself shouldn't contain it
   * by the time this runs. Kept anyway in case cachedQualities is ever
   * set from a path that bypasses that filter.
   */
  _autoQualityTiers() {
    if (!this.cachedQualities) return [];
    return [...this.cachedQualities]
      .filter((q) => q !== "audio_only")
      .sort((a, b) => this._rankResolution(a) - this._rankResolution(b));
  }

  // ---------------------------------------------------------------------------
  // VOD chapters
  // ---------------------------------------------------------------------------

  /** Fetches chapter markers from the Twitch GQL API and, if any exist,
   * shows the chapters button and caches the list. */
  async _fetchChapters() {
    if (!this.isVod || !this.currentChannel) return;
    const videoId = this.currentChannel.replace(/^vod:/, "");

    if (this.chaptersBtn) {
      this.chaptersBtn.style.display = "";
      this.chaptersBtn.style.opacity = "0.4";
      this.chaptersBtn.title = "Chapters (loading…)";
    }

    try {
      const chapters = await fetchVodChapters(videoId);
      if (!chapters.length) {
        if (this.chaptersBtn) this.chaptersBtn.style.display = "none";
        return;
      }
      this._chapters      = chapters;
      this._chaptersLoaded = true;
      if (this.chaptersBtn) {
        this.chaptersBtn.style.display = "";
        this.chaptersBtn.style.opacity = "";
        this.chaptersBtn.title = `Chapters (${chapters.length})`;
      }
    } catch (err) {
      console.error("[chapters] fetch failed:", err);
      if (this.chaptersBtn) this.chaptersBtn.style.display = "none";
    }
  }

  /** Fetches the VOD's storyboard (seek-preview thumbnails) in the
   * background - see seek-thumbnails.js. VOD-only: tried extending this
   * to live-DVR mode too, but confirmed via testing that Twitch's
   * storyboard CDN 403s for the underlying VOD while the broadcast is
   * still live, even with the Referer header that fixed the same
   * endpoint for finished VODs - storyboards likely aren't generated (or
   * exposed) until a broadcast actually ends. Never throws or blocks
   * anything: loadVodStoryboard() itself already resolves to a no-op
   * (frameFor() always null) on any failure, and a stale videoId/isVod
   * guard below drops the result if the user has already navigated away
   * by the time this resolves, so there's nothing more to guard here. */
  async _fetchStoryboard() {
    if (!this.isVod || !this.currentChannel) return;
    const videoId = this.currentChannel.replace(/^vod:/, "");
    const seekPreviewsUrl = await fetchVodSeekPreviewsUrl(videoId).catch((err) => {
      console.warn("[seek-thumbnails] failed to fetch seekPreviewsURL:", err);
      return null;
    });
    const storyboard = await loadVodStoryboard(seekPreviewsUrl);
    // Stale guard: only apply if still on the same VOD this was fetched for.
    if (this.isVod && this.currentChannel === `vod:${videoId}`) {
      this._storyboard = storyboard;
    }
  }

  /** Formats a seconds value as H:MM:SS (or M:SS for < 1 hour). */
  _formatChapterTime(totalSec) {
    const s = Math.floor(totalSec % 60);
    const m = Math.floor((totalSec / 60) % 60);
    const h = Math.floor(totalSec / 3600);
    const mm = String(m).padStart(2, "0");
    const ss = String(s).padStart(2, "0");
    return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
  }

  /** Returns the current playback position in VOD-relative seconds
   * (i.e. removes the HLS timestamp offset). */
  _vodPositionSec() {
    // HLS.js sets videoEl.currentTime in VOD seconds (0 = start of VOD).
    return this.videoEl.currentTime || 0;
  }

  /** Index of the chapter currently playing (-1 if no chapters). */
  _activeChapterIndex() {
    if (!this._chapters.length) return -1;
    const pos = this._vodPositionSec();
    let active = 0;
    for (let i = 0; i < this._chapters.length; i++) {
      if (this._chapters[i].positionSec <= pos) active = i;
    }
    return active;
  }

  toggleChaptersMenu() {
    if (!this._chaptersLoaded) return;
    const opening = !this.chaptersMenu.classList.contains("open");
    if (opening) {
      this._renderChapters();
      this._positionChaptersMenu();
    }
    this.chaptersMenu.classList.toggle("open", opening);
  }

  _positionChaptersMenu() {
    const rect = this.chaptersBtn.getBoundingClientRect();
    this.chaptersMenu.style.right  = `${window.innerWidth - rect.right}px`;
    this.chaptersMenu.style.bottom = `${window.innerHeight - rect.top + 6}px`;
    this.chaptersMenu.style.left   = "";
    this.chaptersMenu.style.top    = "";
  }

  _renderChapters() {
    this.chaptersMenu.innerHTML = "";
    const activeIdx = this._activeChapterIndex();
    this._chapters.forEach((ch, i) => {
      const item = document.createElement("button");
      item.className = "chapters-item" + (i === activeIdx ? " active" : "");

      const timeEl = document.createElement("span");
      timeEl.className = "chapters-item-time";
      timeEl.textContent = this._formatChapterTime(ch.positionSec);

      const titleEl = document.createElement("span");
      titleEl.className = "chapters-item-title";
      titleEl.textContent = ch.title;

      item.appendChild(timeEl);
      item.appendChild(titleEl);
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        // HLS.js handles seeking to any position instantly.
        this.videoEl.currentTime = ch.positionSec;
        this.onSeek(this.videoEl.currentTime);
        this.chaptersMenu.classList.remove("open");
      });
      this.chaptersMenu.appendChild(item);
    });

    // Scroll the active chapter into view.
    const activeEl = this.chaptersMenu.querySelector(".chapters-item.active");
    activeEl?.scrollIntoView({ block: "nearest" });
  }

  /**
   * Switches quality. If 'auto' is selected, enables adaptive mode which
   * starts at 'best' and steps down on sustained buffering. Selecting any
   * specific quality exits auto mode.
   */
  selectQuality(quality) {
    this.qualityMenu.classList.remove("open");
    if (quality === "auto") {
      if (this.autoQualityMode) return; // already in auto, no-op
      this.currentQuality = "auto";
      this._enableAutoMode();
      this.onQualityChange("best"); // start at highest, step down if needed
      return;
    }
    // Manual selection → exit auto mode so the user stays at their choice.
    this._disableAutoMode();
    if (quality === this.currentQuality) return;
    this.currentQuality = quality;
    this.onQualityChange(quality);
  }

  showControls() {
    if (!this.active) return;
    this.videoFrame.classList.add("controls-visible");
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => this.hideControls(), HIDE_DELAY_MS);
  }

  hideControls() {
    this.videoFrame.classList.remove("controls-visible");
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
  }

  togglePause() {
    if (this.videoEl.paused || this.videoEl.ended) {
      this.videoEl.play().catch((err) => console.error("play() failed:", err));
    } else {
      this.videoEl.pause();
    }
    // setPauseIcon is also called by the 'play'/'pause' event listeners in
    // bindEvents - calling it here too keeps the icon snappy rather than
    // waiting a tick for the event to fire, while the listeners remain the
    // source of truth for any state change not triggered by this method.
    this.setPauseIcon(this.videoEl.paused);
  }

  setPauseIcon(paused) {
    this.playIcon.style.display = paused ? "block" : "none";
    this.pauseIcon.style.display = paused ? "none" : "block";
    this.centerPlayBtn.style.display = paused ? "flex" : "none";
  }

  toggleMute() {
    this.isMuted = !this.isMuted;
    this.videoEl.muted = this.isMuted;
    this.setMuteIcon(this.isMuted);
  }

  setMuteIcon(muted) {
    this.volumeIcon.style.display = muted ? "none" : "block";
    this.muteIcon.style.display = muted ? "block" : "none";
    this._syncPipMuteIcon(muted);
  }

  /** @param {number} volume - 0 to 130, matching the slider's range in
   * index.html. HTMLMediaElement.volume only accepts 0..1, so values above
   * 100 (a "boost above 100%" the old mpv --volume-max=130 setup allowed)
   * can't be represented the same way here - clamped to 100 instead, since
   * the web <video> element has no native equivalent of mpv's software
   * volume amplification past unity gain. */
  setVolume(volume) {
    const clamped = Math.min(100, Math.max(0, volume));
    this.videoEl.volume = clamped / 100;
    // Mirror the raw (pre-clamp) value onto both sliders so the main
    // window's and the Document PiP window's volume UIs always agree no
    // matter which one was dragged - assigning .value doesn't re-fire
    // 'input', so there's no feedback loop.
    this.volumeSlider.value = volume;
    if (this._pipEls) {
      this._pipEls.slider.value = volume;
      // Keep the tooltip in step with the mirrored value on plain
      // volume drags too - _syncPipMuteIcon (which also writes this
      // title) only runs when MUTE state changes, and most drags don't
      // change it.
      if (!this.isMuted || volume > 0) {
        this._pipEls.slider.title = `${Math.round(volume)}%`;
      }
    }
    if (volume > 0 && this.isMuted) {
      this.isMuted = false;
      this.videoEl.muted = false;
      this.setMuteIcon(false);
    }
  }

  /**
   * seekable's range spans the WHOLE stream (0 to live edge) even after
   * trimBuffered() (stream-player.js) has evicted old data from the
   * SourceBuffer - seekable reflects the MediaSource's duration, not what
   * data is actually still present to play. So target-reachability checks
   * use this (the real, currently-appended ranges) instead of seekable.
   * Returns the buffered range containing (or nearest to) currentTime,
   * since that's the contiguous window playback can actually reach
   * without stalling on evicted data.
   */
  _getActualBufferedRange() {
    const buffered = this.videoEl.buffered;
    if (!buffered || buffered.length === 0) return null;
    const currentTime = this.videoEl.currentTime;
    for (let i = 0; i < buffered.length; i++) {
      if (buffered.start(i) <= currentTime && currentTime <= buffered.end(i)) {
        return { start: buffered.start(i), end: buffered.end(i) };
      }
    }
    // Fallback: playhead isn't inside any buffered range (shouldn't
    // normally happen) — use the most recent range, since that's the one
    // nearest the live edge.
    const last = buffered.length - 1;
    return { start: buffered.start(last), end: buffered.end(last) };
  }

  /**
   * Kick-session counterpart to _getActualBufferedRange() above. Kick's
   * live session runs on hls.js (attachHlsDvr/startKick), not the raw
   * MSE relay _getActualBufferedRange was built to work around - hls.js
   * computes `seekable` from the live playlist's OWN sliding window
   * (Kick's CDN retains more than a plain live playlist so Kick's own
   * player can rewind - see liveEdge in vod-player.js), independent of
   * how much of that window is still sitting in the decode buffer.
   * Trusting seekable here is what actually lets a Kick session rewind
   * as far back as Kick's manifest allows, rather than clamping at
   * whatever backBufferLength happened to still have decoded - a seek
   * anywhere in this range makes hls.js fetch the fragment fresh if it's
   * no longer buffered, same as scrubbing backward in any HLS VOD.
   * Falls back to the buffered-range check if seekable is ever empty
   * (e.g. right at attach, before hls.js has parsed the manifest).
   */
  _getKickSeekableRange() {
    const seekable = this.videoEl.seekable;
    if (seekable && seekable.length > 0) {
      const end = seekable.end(seekable.length - 1);
      return { start: seekable.start(0), end };
    }
    return this._getActualBufferedRange();
  }

  // Seek live playback within what the MSE feeder has buffered. Twitch live is
  // limited to that window (streamlink emits one byte stream from the live edge;
  // there's no on-demand segment fetch, and trimBuffered() evicts past
  // TRAILING_WINDOW). Kick, though it shares this branch, has a real server-side
  // DVR window via hls.js, so it can seek anywhere still in that window.
  seekToClickPosition(event) {
    const rect = this.seekBarTrack.getBoundingClientRect();
    const clickRatio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));

    if (this.isVod) {
      // With HLS.js, seeking is instant — just set currentTime.
      // HLS.js handles loading segments around the new position automatically.
      const total = this.videoEl.duration || this.vodTotalSeconds || 0;
      if (total <= 0) return;
      this.videoEl.currentTime = clickRatio * total;
      this.onSeek(this.videoEl.currentTime);
    } else if (this._liveDvr) {
      // Already in live-DVR mode: seek bar spans stream start to now.
      const streamStartedAt = this._liveDvr.streamStartedAt;
      const totalSecs = (Date.now() - streamStartedAt) / 1000;
      const targetVodOffset = clickRatio * totalSecs;
      this.videoEl.currentTime = targetVodOffset;
      this.onSeek(this.videoEl.currentTime);
    } else {
      // Live: seek within the reachable window, OR trigger live-DVR.
      const seekable = this.videoEl.seekable;
      if (!seekable || seekable.length === 0) return;
      const end = seekable.end(seekable.length - 1);

      // Twitch's raw MSE relay: seekable spans the WHOLE session even
      // after data's been trimmed out of the SourceBuffer, so the
      // actually-buffered range (not seekable's start) is the real
      // earliest reachable position there. Kick runs on hls.js instead,
      // whose seekable IS accurate for a live playlist (reflects the
      // manifest's own sliding DVR window, not just what's currently
      // decoded) - see _getKickSeekableRange's own comment.
      const actualRange = this._isKickSession
        ? this._getKickSeekableRange()
        : this._getActualBufferedRange();
      const start = actualRange ? actualRange.start : end;
      const bufferDuration = end - start;
      if (bufferDuration <= 0) return;

      console.log(`[live-dvr] seekToClickPosition: clickRatio=${clickRatio.toFixed(3)} liveDvrStreamStartedAt=${this.liveDvrStreamStartedAt} onLiveDvrSeek=${!!this.onLiveDvrSeek} start=${start.toFixed(1)} end=${end.toFixed(1)} currentTime=${this.videoEl.currentTime.toFixed(1)}`);

      if (this.liveDvrStreamStartedAt && this.onLiveDvrSeek) {
        // Seek bar spans the full stream: map clickRatio to VOD time.
        const streamDuration = (Date.now() - this.liveDvrStreamStartedAt) / 1000;
        const targetStreamPos = clickRatio * streamDuration;
        const secondsBehindLive = streamDuration - targetStreamPos;

        console.log(`[live-dvr] streamDuration=${streamDuration.toFixed(1)} targetStreamPos=${targetStreamPos.toFixed(1)} secondsBehindLive=${secondsBehindLive.toFixed(1)} bufferDuration=${bufferDuration.toFixed(1)}`);

        if (secondsBehindLive < 10) {
          // Near the live edge: just jump to live edge in the buffer
          console.log(`[live-dvr] → jumping to live edge`);
          this.videoEl.currentTime = end;
        } else if (secondsBehindLive <= bufferDuration) {
          // Within the actually-buffered window: seek directly without
          // switching to DVR
          const absoluteTarget = end - secondsBehindLive;
          console.log(`[live-dvr] → seeking within buffer to ${absoluteTarget.toFixed(1)}`);
          this.videoEl.currentTime = Math.min(end, Math.max(start, absoluteTarget));
        } else if (this._isKickSession && !this.kickDvrAvailable) {
          // Kick session with no resolved recording to swap onto (VODs
          // disabled on the channel, or the lookup hasn't succeeded) -
          // the furthest back it can go is whatever hls.js still has
          // from the live playlist, so clamp there with a notice. When
          // kickDvrAvailable IS set, this falls through to the same
          // onLiveDvrSeek trigger Twitch uses (main.js branches on the
          // session's platform inside the handler).
          console.log(`[live-dvr] → Kick (no DVR source): clamping to earliest buffered point (${start.toFixed(1)})`);
          this.videoEl.currentTime = start;
          if (this.onLiveDvrClamped) {
            this.onLiveDvrClamped({
              requestedSecondsBehindLive: secondsBehindLive,
              landedSecondsBehindLive: end - start,
            });
          }
        } else {
          // Past the actually-buffered window: trigger live-DVR
          console.log(`[live-dvr] → triggering DVR with secondsBehindLive=${secondsBehindLive.toFixed(1)}`);
          this.onLiveDvrSeek(secondsBehindLive);
        }
      } else {
        // No DVR info: plain live seek within the actually-buffered window
        const target = start + clickRatio * bufferDuration;
        console.log(`[live-dvr] → no DVR, seeking within buffer window to ${target.toFixed(1)}`);
        this.videoEl.currentTime = Math.min(end, Math.max(start, target));
      }
    }
  }

  /**
   * Seeks forward/backward by `deltaSeconds` from the current position -
   * backs the ArrowLeft/ArrowRight keyboard shortcuts in main.js. Mirrors
   * seekToClickPosition() immediately above (same live/VOD branching, same
   * live-buffer limitation - see its comment for the full reasoning),
   * just driven by a relative delta from the current position instead of
   * an absolute click-ratio along the seek bar.
   */
  seekRelative(deltaSeconds) {
    if (this.isVod || this._liveDvr) {
      // VOD or live-DVR: HLS.js handles arbitrary seeking.
      const total = this._liveDvr
        ? (Date.now() - this._liveDvr.streamStartedAt) / 1000
        : (this.videoEl.duration || this.vodTotalSeconds || 0);
      if (total <= 0) return;
      const target = this.videoEl.currentTime + deltaSeconds;
      this.videoEl.currentTime = Math.min(total, Math.max(0, target));
      this.onSeek(this.videoEl.currentTime);
    } else {
      const seekable = this.videoEl.seekable;
      if (!seekable || seekable.length === 0) return;
      const end = seekable.end(seekable.length - 1);

      // Same fix as seekToClickPosition: Kick's hls.js seekable is
      // accurate (reflects the live manifest's own DVR window); Twitch's
      // raw MSE relay needs the actually-buffered range instead, since
      // its seekable still reports the whole session even after data's
      // been trimmed out of the SourceBuffer.
      const actualRange = this._isKickSession
        ? this._getKickSeekableRange()
        : this._getActualBufferedRange();
      const start = actualRange ? actualRange.start : end;
      if (end - start <= 0) return;
      const target = this.videoEl.currentTime + deltaSeconds;
      // ArrowLeft past the buffer start: trigger live-DVR if available.
      // For Kick that means kickDvrAvailable (an in-progress recording
      // was resolved for this session); without one it clamps with a
      // notice like the no-onLiveDvrSeek case below always has.
      if (target < start && this.onLiveDvrSeek && (!this._isKickSession || this.kickDvrAvailable)) {
        // How far behind the live edge the user is trying to go —
        // current position minus the delta, measured from live edge.
        const secondsBehindLive = (end - this.videoEl.currentTime) + Math.abs(deltaSeconds);
        this.onLiveDvrSeek(secondsBehindLive);
      } else {
        if (target < start && this._isKickSession && !this.kickDvrAvailable && this.onLiveDvrClamped) {
          const secondsBehindLive = (end - this.videoEl.currentTime) + Math.abs(deltaSeconds);
          this.onLiveDvrClamped({
            requestedSecondsBehindLive: secondsBehindLive,
            landedSecondsBehindLive: end - start,
          });
        }
        this.videoEl.currentTime = Math.min(end, Math.max(start, target));
      }
    }
    this.showControls();
  }

  /** Shows a timestamp tooltip above the seek bar tracking the cursor's x position. */
  updateSeekTooltip(event) {
    const duration = this.lastKnownDuration;
    if (duration <= 0) {
      this.seekBarTooltip.classList.remove("visible");
      this.seekBarThumbnail.classList.remove("visible");
      return;
    }

    const rect = this.seekBarTrack.getBoundingClientRect();
    const hoverRatio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const hoverSeconds = hoverRatio * duration;

    if (this.isVod) {
      const total = this.vodTotalSeconds || duration;
      const absSeconds = hoverRatio * total;
      const muted = this._mutedSegments.some(
        (seg) => absSeconds >= (seg.offset ?? 0) && absSeconds < (seg.offset ?? 0) + (seg.duration ?? 0)
      );
      this.seekBarTooltip.textContent = muted
        ? `${this.formatDuration(absSeconds)} (Muted)`
        : this.formatDuration(absSeconds);

      this._updateSeekThumbnail(absSeconds);
    } else {
      // For live, show how far behind the live edge the cursor is.
      const behindSeconds = Math.max(0, duration - hoverSeconds);
      this.seekBarTooltip.textContent = behindSeconds < 1 ? "live" : `-${this.formatDuration(behindSeconds)}`;
      // No storyboard ever exists for a live stream, including live-DVR
      // mode - Twitch's storyboard CDN 403s for the underlying VOD while
      // the broadcast is still in progress (confirmed via testing), so
      // this isn't fetched for DVR at all - see attachHlsDvr's comment.
      this._updateSeekThumbnail(null);
    }

    // Position the tooltip AND thumbnail horizontally at the cursor,
    // clamped so neither overflows past either edge of the track.
    const offsetX = event.clientX - rect.left;
    const clampedOffsetX = Math.min(Math.max(offsetX, 20), rect.width - 20);
    this.seekBarTooltip.style.left = `${clampedOffsetX}px`;
    this.seekBarThumbnail.style.left = `${clampedOffsetX}px`;
    this.seekBarTooltip.classList.add("visible");
  }

  /** Shows/hides and positions the storyboard thumbnail image for the
   * given absolute VOD position - shared by updateSeekTooltip's VOD and
   * live-DVR branches. Pass null to force-hide (e.g. live, not in DVR
   * mode - no storyboard ever exists there, see _storyboard's own
   * comments for why). */
  _updateSeekThumbnail(absSeconds) {
    const frame = absSeconds == null ? null : this._storyboard.frameFor(absSeconds);
    if (frame) {
      this.seekBarThumbnail.style.width = `${frame.width}px`;
      this.seekBarThumbnail.style.height = `${frame.height}px`;
      this.seekBarThumbnail.style.backgroundImage = `url("${frame.url}")`;
      this.seekBarThumbnail.style.backgroundPosition = `${frame.backgroundX}px ${frame.backgroundY}px`;
      this.seekBarThumbnail.classList.add("visible");
    } else {
      this.seekBarThumbnail.classList.remove("visible");
    }
  }

  /** Formats seconds as m:ss for tooltip/display purposes (e.g. 95 -> "1:35"). */
  formatDuration(totalSeconds) {
    const total = Math.max(0, Math.round(totalSeconds));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) {
      return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    }
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  /** Jumps to the live edge. In normal live mode, seeks to the end of the
   * MSE buffer. In live-DVR mode (watching the in-progress VOD via HLS.js),
   * fires onLiveDvrSeek(0) to signal "go back to live relay" - main.js
   * handles tearing down HLS.js and reconnecting the MSE feeder. */
  jumpToLive() {
    if (this._liveDvr) {
      // Signal main.js to switch back to the live relay (0 = live edge)
      if (this.onLiveDvrSeek) this.onLiveDvrSeek(0);
      return;
    }
    // Uses the ACTUAL buffered range, not videoEl.seekable - seekable
    // reports the whole MediaSource range regardless of what
    // trimBuffered() (stream-player.js) has evicted from the
    // SourceBuffer, same reason seekToClickPosition/seekRelative had to
    // stop using it (see their own comments). Jumping to seekable's
    // stale/wrong "end" instead of where data actually is would seek
    // into a gap with nothing there to play - confirmed as the reason
    // clicking Live did nothing during a stall: the click "worked" in
    // the sense that currentTime changed, but landed somewhere with no
    // buffered data, so playback never actually resumed.
    const actualRange = this._getActualBufferedRange();
    if (!actualRange) return;
    this.videoEl.currentTime = actualRange.end;
    // Drop the behind-live anchor so pollProgress re-derives it against
    // this new position. Without it the readout kept whatever drift had
    // accumulated (see the anchor block in pollProgress) and stayed stuck
    // at something like "-11:36" even though playback had gone live.
    this._liveSessionAbsoluteStart = null;
    // Force a resume in case the element's own internal state got stuck
    // "waiting" during the stall in a way a bare currentTime change
    // doesn't clear on its own (see the stall-recovery watchdog in
    // stream-player.js for the automatic version of this same nudge).
    this.videoEl.play().catch(() => {});
  }

  /**
   * Draws red markers over the seek bar for copyright-muted VOD ranges
   * (see main.js's call to get_vod_muted_segments) and stores the raw
   * segment list so updateSeekTooltip can label them on hover.
   *
   * @param {{offset: number, duration: number}[]} segments - Helix's
   *   muted_segments shape, both fields in seconds.
   * @param {number} totalDurationSecs - the VOD's total length, to
   *   convert each segment's absolute offset/duration into a percentage
   *   of the seek bar's width.
   */
  renderMutedSegments(segments, totalDurationSecs) {
    this._mutedSegments = segments || [];
    this.mutedSegmentsContainer.innerHTML = "";
    if (!totalDurationSecs || totalDurationSecs <= 0 || this._mutedSegments.length === 0) return;

    for (const seg of this._mutedSegments) {
      const offset = seg.offset ?? 0;
      const duration = seg.duration ?? 0;
      if (duration <= 0) continue;
      // Clamp to the bar's own [0, total] range - Twitch's data has been
      // seen to include a segment extending slightly past a VOD's
      // reported duration (rounding on their end, not ours), which
      // would otherwise overflow the bar's width past 100%.
      const startPct = Math.max(0, Math.min(100, (offset / totalDurationSecs) * 100));
      const endPct = Math.max(0, Math.min(100, ((offset + duration) / totalDurationSecs) * 100));
      if (endPct <= startPct) continue;

      const marker = document.createElement("div");
      marker.className = "seek-bar-muted-segment";
      marker.style.left = `${startPct}%`;
      marker.style.width = `${endPct - startPct}%`;
      this.mutedSegmentsContainer.appendChild(marker);
    }
  }

  pollProgress() {
    if (!this.active) return;

    const position = this.videoEl.currentTime;
    let duration;

    if (this.isVod) {
      duration = this.vodTotalSeconds || this.videoEl.duration || 0;
    } else if (this._liveDvr) {
      // Live-DVR: duration is the full stream length so far.
      duration = (Date.now() - this._liveDvr.streamStartedAt) / 1000;
    } else {
      const seekable = this.videoEl.seekable;
      if (seekable && seekable.length > 0) {
        duration = seekable.end(seekable.length - 1) - seekable.start(seekable.length - 1);
      } else {
        duration = 0;
      }
    }

    this.lastKnownPosition = position;
    this.lastKnownDuration = duration;

    if (this.isVod || this._liveDvr) {
      const vodPosSecs = position;
      const total = this._liveDvr ? duration : (this.videoEl.duration || this.vodTotalSeconds || 0);
      const ratio = total > 0 ? Math.min(1, Math.max(0, vodPosSecs / total)) : 0;
      this.seekBarFill.style.width = `${ratio * 100}%`;
      if (this._liveDvr) {
        const behindLive = Math.max(0, duration - position);
        this.timeDisplay.textContent = behindLive < 5
          ? "live"
          : `-${this.formatDuration(Math.round(behindLive))}`;
        this.liveBtn.classList.toggle("at-live-edge", behindLive < 5);
      } else {
        this.timeDisplay.textContent =
          `${this.formatDuration(vodPosSecs)} / ${this.formatDuration(total)}`;
      }
    } else {
      // Normal live, not yet in DVR mode. currentTime is session-relative
      // (ffmpeg rebases fMP4 timestamps to ~0), so seekable.end() - currentTime
      // measures buffering lag, not how far behind the broadcast you are. Anchor
      // against wall-clock instead (liveDvrStreamStartedAt), derived from
      // currentTime when first available so it's agnostic to the timeline.
      if (this.liveDvrStreamStartedAt) {
        // Re-anchor whenever playback sits at the buffered live edge. Otherwise
        // behindSeconds (wall-clock elapsed minus media time advanced) banks
        // every stall/pause permanently and drifts unbounded. Sitting at the
        // buffered end is "live" for this session, so re-anchoring there makes
        // the readout self-correcting; seeking back freezes the anchor so it
        // correctly reports how far back the user went.
        const liveRange = this._getActualBufferedRange();
        const atBufferedLiveEdge =
          liveRange && position >= liveRange.end - LIVE_EDGE_THRESHOLD_SECONDS;
        if (this._liveSessionAbsoluteStart == null || atBufferedLiveEdge) {
          // "Absolute broadcast-relative position corresponding to
          // videoEl.currentTime === 0" - i.e. how far into the broadcast
          // this session started, working backward from right now.
          this._liveSessionAbsoluteStart =
            (Date.now() - this.liveDvrStreamStartedAt) / 1000 - position;
        }
        const absolutePosition = this._liveSessionAbsoluteStart + position;
        const broadcastElapsedNow = (Date.now() - this.liveDvrStreamStartedAt) / 1000;
        // The hover tooltip (updateSeekTooltip) reads lastKnownDuration
        // as "the scale the whole bar's width represents" - it was still
        // holding the small ~120s MSE buffer-window value computed
        // earlier in this function, even though the bar itself is drawn
        // spanning the full broadcast once DVR info is available. That
        // mismatch is what produced tooltip values like "-1:15" when
        // hovering near the very start of a bar visually representing a
        // multi-hour stream. Overriding it here keeps both the fill/text
        // above and the hover tooltip using the same broadcast-relative
        // scale - nothing else reads lastKnownDuration (grep confirms
        // updateSeekTooltip is its only consumer), so this is safe.
        this.lastKnownDuration = broadcastElapsedNow;
        const behindSeconds = Math.max(0, broadcastElapsedNow - absolutePosition);
        const ratio = broadcastElapsedNow > 0
          ? Math.min(1, Math.max(0, absolutePosition / broadcastElapsedNow))
          : 1;
        this.seekBarFill.style.width = `${ratio * 100}%`;
        this.timeDisplay.textContent = behindSeconds < LIVE_EDGE_THRESHOLD_SECONDS
          ? "live"
          : `-${this.formatDuration(behindSeconds)}`;
        this.liveBtn.classList.toggle("at-live-edge", behindSeconds < LIVE_EDGE_THRESHOLD_SECONDS);
      } else {
        // No DVR info yet - the first ~30-60s of a session, before
        // Twitch's own VOD-ready check (see main.js) resolves. Falls
        // back to the session-relative calc, which is harmless this
        // early since genuine behind-live distance is necessarily small
        // moments after joining regardless of which timeline it's
        // measured against.
        const seekable = this.videoEl.seekable;
        const liveEdge = seekable && seekable.length > 0
          ? seekable.end(seekable.length - 1)
          : position;
        const behindSeconds = Math.max(0, liveEdge - position);
        const ratio = duration > 0 ? Math.min(1, Math.max(0, position / duration)) : 1;
        this.seekBarFill.style.width = `${ratio * 100}%`;
        this.timeDisplay.textContent = behindSeconds < LIVE_EDGE_THRESHOLD_SECONDS
          ? "live"
          : `-${this.formatDuration(behindSeconds)}`;
        this.liveBtn.classList.toggle("at-live-edge", behindSeconds < LIVE_EDGE_THRESHOLD_SECONDS);
      }
    }
  }
}
