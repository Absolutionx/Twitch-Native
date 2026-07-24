/**
 * VOD playback via HLS.js.
 *
 * Live streams use the custom Rust relay + MSE pipeline (low-latency,
 * handles Twitch's fMP4/MPEG-TS quirks). For VODs, HLS.js is the right
 * tool: it speaks fMP4 HLS natively, manages its own buffer, and
 * makes seeking instant — just set videoEl.currentTime and it handles
 * loading the right segments automatically. No relay restarts, no
 * timestamp headaches, no QuotaExceededError.
 *
 * Usage:
 *   const hls = attachHlsVod(videoEl, m3u8Url, { startPosition: 0 });
 *   // … later …
 *   hls.destroy();  // or call destroyHlsVod()
 */

import Hls from "hls.js";

export { Hls };

/**
 * Attaches HLS.js to the video element for VOD playback.
 *
 * @param {HTMLVideoElement} videoEl
 * @param {string}           m3u8Url       - authenticated CDN playlist URL
 * @param {object}           [opts]
 * @param {number}           [opts.startPosition=0]  - VOD second to start from
 * @param {(data:any)=>void} [opts.onFatalError]      - called on unrecoverable error
 * @returns {Hls|null} HLS instance (null if native HLS is used as fallback)
 */
export function attachHlsVod(videoEl, m3u8Url, {
  startPosition = 0,
  onFatalError   = null,
  // Small-window mode (the PiP window passes this): cap the quality
  // level to the player's actual rendered size and keep buffers modest.
  // Without it, hls.js's default startLevel picks the FIRST variant in
  // the manifest - which for Twitch VODs is source quality - so a
  // 480px-wide window was fetching multi-MB source segments plus the
  // full playlist while sharing the webviews' single 6-connections-per-
  // host Chromium pool with the main player's own 60s-lookahead hls.js.
  // Confirmed in the field as multi-second (15s+) black screens on PiP
  // open, with the shared HTTP cache making LATER opens mysteriously
  // faster. Right-sized segments are ~an order of magnitude smaller,
  // which fixes both the fetch time and the contention.
  smallPlayer = false,
  // True for Kick's live session (attachHlsDvr/startKick in
  // playback-controls.js) - a REAL live m3u8 with its own rolling DVR
  // window (Kick's CDN keeps more than a normal live sliding window so
  // its own player can rewind - see the [live-dvr] discussion this
  // option grew out of), not a finite VOD. backBufferLength: 30 below
  // was written for scrubbing an already-complete Twitch VOD, where it
  // only trims memory (a seek past it just triggers a fresh fetch from
  // the still-fully-listed manifest, so nothing is actually lost). On a
  // live playlist that assumption still holds for FETCHING - hls.js
  // will refetch any fragment still in the current level's sliding
  // window regardless of backBufferLength - but keeping a wider back
  // buffer here avoids unnecessary re-fetch churn/stalls on every
  // backward scrub within that window, since this session is expected
  // to sit and rewind repeatedly rather than play through once.
  liveEdge = false,
  // Prefix for the startup-timing logs below, so the pip window's hls
  // output is distinguishable from the main player's.
  logPrefix = "[hls.js]",
} = {}) {
  if (!Hls.isSupported()) {
    // Native HLS (Safari / some Chromium builds). Seeking still just works.
    videoEl.src = m3u8Url;
    if (startPosition > 0) {
      videoEl.addEventListener("loadedmetadata", () => {
        videoEl.currentTime = startPosition;
      }, { once: true });
    }
    videoEl.play().catch(() => {});
    return null;
  }

  const hls = new Hls({
    // Jump straight to startPosition instead of always buffering from 0.
    startPosition,
    enableWorker: true,

    // Buffer config — 30 s of already-played footage is enough for smooth
    // backward scrubs without hogging memory; 60 s ahead keeps seeking
    // within a buffer range instant. Small-player mode trims all of it:
    // a PiP window doesn't scrub, and every second it prefetches is
    // bandwidth taken from the main player on the same connection pool.
    // liveEdge (Kick's live-DVR session) instead keeps as much back
    // buffer as Kick's own manifest window allows - see liveEdge's doc
    // comment above for why 30s is the wrong default there.
    backBufferLength:   smallPlayer ? 10 : (liveEdge ? Infinity : 30),
    maxBufferLength:    smallPlayer ? 20 : 60,
    maxMaxBufferLength: smallPlayer ? 40 : 120,

    // See smallPlayer's doc comment - pick a level that matches the
    // actual rendered size instead of the manifest's first (source
    // quality) variant.
    capLevelToPlayerSize: smallPlayer,

    // Twitch fMP4 segments sometimes have large pts/dts gaps at ad or
    // chapter boundaries — don't be strict about that.
    maxFragLookUpTolerance: 0.5,
  });

  hls.loadSource(m3u8Url);
  hls.attachMedia(videoEl);

  // Startup-stage timing: when a black screen lingers, these three lines
  // say WHICH stage ate the time (playlist fetch/parse vs first fragment
  // vs decode-to-first-frame) instead of leaving it a mystery.
  const t0 = performance.now();
  const sinceStart = () => `+${((performance.now() - t0) / 1000).toFixed(1)}s`;
  hls.once(Hls.Events.MANIFEST_PARSED, (_, data) => {
    console.log(`${logPrefix} ${sinceStart()} manifest parsed (${data?.levels?.length ?? "?"} levels)`);
  });
  hls.once(Hls.Events.FRAG_BUFFERED, () => {
    console.log(`${logPrefix} ${sinceStart()} first fragment buffered`);
  });
  videoEl.addEventListener("playing", () => {
    console.log(`${logPrefix} ${sinceStart()} first frame playing`);
  }, { once: true });

  hls.once(Hls.Events.MANIFEST_PARSED, () => {
    videoEl.play().catch(() => {});
  });

  // Bounded network-error recovery. The old handling retried network
  // errors via startLoad() UNCONDITIONALLY and never reached
  // onFatalError for them - correct for a mid-stream fragment blip,
  // but for a manifest that can never load (confirmed field case: a
  // URL pointing at a dead localhost proxy port from a previous app
  // session) it spun ERR_CONNECTION_REFUSED forever, and the caller's
  // fallback URL logic never got the chance to run. Manifest-stage
  // failures get 2 retries (they either work immediately or never
  // will); mid-stream network errors keep the generous retry but are
  // capped at 5 consecutive, with any successfully buffered fragment
  // resetting the count.
  let manifestRetries = 0;
  let consecutiveNetErrors = 0;
  hls.on(Hls.Events.FRAG_BUFFERED, () => { consecutiveNetErrors = 0; });
  hls.on(Hls.Events.ERROR, (_, data) => {
    if (!data.fatal) return;
    console.error(`${logPrefix} fatal error:`, data.type, data.details);
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
      const manifestStage = data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR
        || data.details === Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT
        || data.details === Hls.ErrorDetails.MANIFEST_PARSING_ERROR;
      if (manifestStage ? ++manifestRetries > 2 : ++consecutiveNetErrors > 5) {
        console.error(`${logPrefix} network-error retries exhausted - giving up on this URL`);
        onFatalError?.(data);
        return;
      }
      hls.startLoad();
    } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
      hls.recoverMediaError();
    } else {
      onFatalError?.(data);
    }
  });

  return hls;
}
