// Shared "what is currently playing" state, in one object so every module gets
// a live, writable view (`import { session }`). An object rather than exported
// `let`s because ES module bindings are read-only to importers. Only put
// cross-module state here; single-module state stays private to that module.

export const session = {
  // --- Playback ---------------------------------------------------------

  /** Is a stream/VOD currently playing? */
  playing: false,

  /** The channel (or "vod:<id>") the user MEANT to be watching. Async
   * callbacks re-check this after every await: if it changed mid-flight,
   * the work belongs to a session that no longer exists and is dropped.
   * That's what stops a slow request from a previous channel clobbering
   * the current one. */
  intendedChannel: null,

  /** The quality string streamlink was last launched with. Switching
   * quality relaunches streamlink entirely rather than flipping an HLS
   * level, so there's no "current rendition" to read off the player -
   * this IS the record of it. */
  currentQuality: "best",

  /** Twitch's low-latency mode (TLLS). Persisted across restarts. */
  lowLatency: localStorage.getItem("lowLatency") === "true",

  // --- Live DVR ---------------------------------------------------------

  /** Live-DVR info for the current live stream, or null. */
  liveDvrInfo: null,

  /** Cached DVR playlist, keyed by videoId+quality so a stale entry (e.g.
   * after a quality change) is never reused. { videoId, quality, url }. */
  liveDvrM3u8Cache: null,

  /** Rate-limits the "clamped to the start of the DVR window" notice. */
  lastLiveDvrClampNoticeAt: 0,

  // --- Kick failover ----------------------------------------------------

  /** Set when the Twitch stream ended and playback failed over to the
   * streamer's Kick simulcast. Null whenever we're on Twitch. */
  kickFailover: null,

  // --- Reconnect budget -------------------------------------------------
  //
  // A stream that dies immediately after every restart means something is
  // actually wrong (channel offline, streamlink broken) - so give up after
  // 4 attempts inside a 2-minute window rather than restart-looping
  // forever. Any 2 minutes of health resets the budget.

  streamRecoveryAttempts: 0,
  lastStreamRecoveryAt: 0,

  // --- Navigation -------------------------------------------------------

  /** Which page to return to when the user leaves the player. */
  lastActivePage: "home",

  /** Is a page (home/browse/vods) showing over the player? */
  pageVisible: true,

  /** The channel whose VODs the VODs page is currently showing. */
  vodsChannel: null,
  vodsChannelIsKick: false,
};
