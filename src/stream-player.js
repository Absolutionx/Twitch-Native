// Feeds a continuous fMP4 byte stream from the local Rust-side relay
// server (see src-tauri/src/stream_relay.rs) into a <video> element via
// Media Source Extensions.
//
// WHY THIS EXISTS INSTEAD OF hls.js: hls.js expects an HLS manifest
// (.m3u8) plus discrete segment URLs it fetches itself - that's the right
// tool when the player is given Twitch's own usher.ttvnw.net URL
// directly, which is what an earlier version of this app did. That
// approach hit a hard wall: browsers enforce CORS on requests made from
// page JS, and Twitch's CDN doesn't send the Access-Control-Allow-Origin
// header that would let this app's webview read the response. Routing
// through streamlink (a plain OS process, not subject to CORS at all)
// and a local relay server sidesteps that, but changes the shape of what
// the frontend receives: one continuous byte stream, not a manifest with
// separately-fetchable segments. hls.js has no mode for "just keep
// appending whatever bytes arrive" - that's exactly what MSE's
// SourceBuffer.appendBuffer() is for, so this module talks to it
// directly instead.

// Walk the fMP4 box tree for a box type (e.g. "avcC"/"hvcC"), returning its
// payload or null. Used to build the exact codec string: isTypeSupported()
// needs an exact match, and addSourceBuffer() accepts a wrong-but-constructible
// string that then fails as MEDIA_ERR_DECODE. Boxes are [size][type][payload],
// nested; this walks the tree rather than hardcoding the path.
function findBoxPayload(bytes, boxType) {
  const typeBytes = [...boxType].map((c) => c.charCodeAt(0));

  function scan(start, end) {
    let offset = start;
    while (offset + 8 <= end) {
      // Use >>> 0 to interpret as unsigned 32-bit integer. Without it, any
      // box whose size byte starts at 0x80 or above would be sign-extended
      // to a negative JS number by the << 24 shift, triggering size < 8
      // and aborting the scan for a perfectly valid box.
      const size =
        (((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0);

      if (size < 8) {
        // Truly malformed: size=0 ("extends to EOF", unresolvable in a
        // streaming context) or size=1 (64-bit largesize - not supported
        // here) both land here. Abort this level only.
        return null;
      }

      const isMatch =
        bytes[offset + 4] === typeBytes[0] &&
        bytes[offset + 5] === typeBytes[1] &&
        bytes[offset + 6] === typeBytes[2] &&
        bytes[offset + 7] === typeBytes[3];
      if (isMatch) {
        return bytes.subarray(offset + 8, offset + size);
      }

      // Container boxes worth descending into to find avcC/hvcC, which
      // live several levels deep inside moov. Anything else (mdat, free,
      // moof, etc.) is skipped - either leaf data or media bytes that
      // would be misread as box structure if descended into.
      //
      // Three different "how far to skip before children start" rules,
      // confirmed against ISO/IEC 14496-12's actual field layouts:
      //   - plain box-of-boxes (moov/trak/mdia/minf/stbl): children start
      //     immediately at +8 (right after the box's own 8-byte header).
      //   - stsd (SampleDescriptionBox) is a FullBox with its own
      //     entry_count before children: version(1)+flags(3)+entry_count(4)
      //     = 8 extra bytes, so children start at +8+8 = +16.
      //   - visual sample entries (avc1/hvc1/avc2/dvav/dvh1/hvc2/encv)
      //     have 78 bytes of fixed VisualSampleEntry fields before their
      //     own child boxes (avcC/hvcC) begin.
      const typeStr = String.fromCharCode(
        bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
      const plainContainers = ["moov", "trak", "mdia", "minf", "stbl"];
      const fullBoxContainers = ["stsd"];
      // Extended list: avc2/dvav cover Dolby Vision AVC; dvh1/hvc2 cover
      // Dolby Vision HEVC; encv covers Common Encryption-wrapped video;
      // av01 is the AV1 visual sample entry (contains av1C config box).
      const sampleEntryContainers = ["avc1", "hvc1", "hev1", "avc3", "avc2", "dvav", "dvh1", "hvc2", "encv", "av01"];

      let childStart = null;
      if (plainContainers.includes(typeStr)) childStart = offset + 8;
      else if (fullBoxContainers.includes(typeStr)) childStart = offset + 8 + 8;
      else if (sampleEntryContainers.includes(typeStr)) childStart = offset + 8 + 78;

      if (childStart !== null) {
        // KEY FIX: for known container boxes whose declared size extends
        // past the bytes we currently have, clamp the sub-scan to what we
        // do have rather than returning null for the whole level. This
        // matters when the relay sends init_bytes + overflow as one large
        // burst: the top-level scan would previously abort the moment it
        // hit a large mdat whose declared size overshot bytes.length,
        // even though moov (and avcC inside it) already appeared earlier
        // and was being scanned correctly right up until that mdat.
        //
        // For non-container boxes with offset+size > end we hit the break
        // below and stop (can't advance past a box whose end is unknown).
        const subEnd = Math.min(offset + size, end);
        const found = scan(childStart, subEnd);
        if (found) return found;
      }

      if (offset + size > end) {
        // Leaf/unknown box whose declared end is past our available data.
        // We cannot advance past it (we don't know where the next box
        // starts), so stop scanning this level.
        break;
      }
      offset += size;
    }
    return null;
  }

  return scan(0, bytes.length);
}

// Build the exact `video/mp4; codecs="..."` string from the avcC/hvcC/av1C
// config box in moov, rather than guessing. H.264: profile/constraint/level
// from avcC bytes 1-3. H.265: falls back to a Main-profile string (rare, hvcC
// is complex). AV1: parses profile/level/tier/depth per the AV1-ISOBMFF spec.
// Returns null if no recognised config box is present.
function buildCodecStringFromInitSegment(bytes) {
  const avcC = findBoxPayload(bytes, "avcC");
  if (avcC && avcC.length >= 4) {
    const profileIdc = avcC[1];
    const constraintFlags = avcC[2];
    const levelIdc = avcC[3];
    const hex = (n) => n.toString(16).padStart(2, "0");
    const avcCodec = `avc1.${hex(profileIdc)}${hex(constraintFlags)}${hex(levelIdc)}`;
    return `video/mp4; codecs="${avcCodec}, mp4a.40.2"`;
  }

  const hvcC = findBoxPayload(bytes, "hvcC");
  if (hvcC) {
    // See this function's doc comment - not fully parsed, falls back
    // to a broadly-compatible common HEVC Main profile level string.
    return 'video/mp4; codecs="hvc1.1.6.L93.B0, mp4a.40.2"';
  }

  // AV1 — Twitch has been rolling out AV1 for most channels; the av01
  // sample entry (now in sampleEntryContainers above) wraps an av1C box
  // that holds the exact profile/level/tier/bit-depth we need.
  const av1C = findBoxPayload(bytes, "av1C");
  if (av1C && av1C.length >= 4) {
    const seqProfile   = (av1C[1] >> 5) & 0x07;
    const seqLevelIdx  =  av1C[1]       & 0x1f;
    const seqTier      = (av1C[2] >> 7) & 0x01;
    const highBitdepth = (av1C[2] >> 6) & 0x01;
    const twelveBit    = (av1C[2] >> 5) & 0x01;
    const bitDepth     = highBitdepth ? (twelveBit ? 12 : 10) : 8;
    const tier = seqTier ? "H" : "M";
    const ll   = String(seqLevelIdx).padStart(2, "0");
    const dd   = String(bitDepth).padStart(2, "0");
    return `video/mp4; codecs="av01.${seqProfile}.${ll}${tier}.${dd}, mp4a.40.2"`;
  }

  return null;
}

// Attach the local relay URL to videoEl via a fresh MediaSource and pump bytes.
// Returns a controller with stop() (aborts the fetch, tears down the source
// buffer, revokes the object URL); call it before re-attaching or the old fetch
// runs forever. callbacks.isVod skips the live-edge jump (a VOD starts at 0);
// callbacks.onFatalError fires when the stream can't be played at all.
export function attachMseStream(videoEl, relayUrl, callbacks = {}) {
  const {
    isVod = false,
    onFatalError = () => {},
    onVodStartOffset = null,
    vodStartOffsetSecs = 0,   // VOD position (seconds) this relay starts from
    // Called (once) as soon as the relay has been SILENT for a few
    // seconds - well before onDead's 20s verdict. Not a death sentence:
    // playback keeps running and may recover on its own. It exists so a
    // listener can go ask an authoritative source (Helix) whether the
    // broadcast actually ended, instead of everyone waiting out a
    // timeout that is only ever a guess. Fires once per silent spell;
    // re-arms as soon as bytes flow again.
    onSilence = () => {},
    // Called (once) when the relay demonstrably stopped supplying data
    // for a LIVE stream: the HTTP body ended, the fetch failed after a
    // healthy start, or no bytes have arrived for 20s while playback
    // wants them. Distinct from onFatalError (an MSE/append-level
    // failure): onDead means the SOURCE died - streamlink exited, the
    // network dropped, the broadcast host's connection hiccuped - which
    // is recoverable by restarting the relay session, and the app
    // previously did nothing at all here ("just keep waiting", per the
    // old stall-watchdog comment), leaving the video frozen forever
    // after any blip. The owner (playback-controls -> main.js) uses
    // this to auto-restart the stream.
    onDead = null,
  } = callbacks;

  // Hard-reset the video element before creating a new MediaSource.
  // Without this, Chromium's decoder pipeline retains state from the
  // previous stream — decoded frames, timestamp expectations, error flags —
  // and when the new relay feeds data with very different timestamps
  // (e.g. after a VOD seek from 0:42 to 8:42) the pipeline throws
  // MEDIA_ERR_DECODE: "Failed to prepare video sample for decode".
  // removeAttribute + load() puts the element into a clean HAVE_NOTHING
  // state (clears videoEl.error, drains the decoder) before the new src.
  videoEl.removeAttribute("src");
  // Clear any prior <source> children from a previous ManagedMediaSource
  // attachment (see below) so they don't stack up across re-attaches.
  while (videoEl.firstChild) videoEl.removeChild(videoEl.firstChild);
  videoEl.load();

  // Pick the MediaSource implementation.
  //
  // THIS IS THE macOS BLACK-SCREEN FIX. macOS uses WKWebView (Safari's
  // engine), and WebKit's classic `MediaSource` is unreliable there: it
  // often accepts a SourceBuffer and a few appends, then fails to decode
  // and throws InvalidStateError + MEDIA_ERR_DECODE - exactly the observed
  // failure. WebKit's actually-working MSE path is `ManagedMediaSource`
  // (Safari 17+). Chromium (WebView2 on Windows) has no ManagedMediaSource
  // and its classic MediaSource works fine, so we feature-detect and use
  // whichever exists, preferring Managed when present.
  const MediaSourceImpl = window.ManagedMediaSource || window.MediaSource;
  const usingManaged = MediaSourceImpl === window.ManagedMediaSource;
  const mediaSource = new MediaSourceImpl();
  const objectUrl = URL.createObjectURL(mediaSource);

  if (usingManaged) {
    // ManagedMediaSource ONLY activates (fires sourceopen) when remote
    // playback is disabled or an AirPlay alternative exists - otherwise it
    // silently never opens. Disable remote playback to satisfy that, and
    // attach via a <source> child rather than videoEl.src, which is the
    // form WebKit's ManagedMediaSource expects.
    videoEl.disableRemotePlayback = true;
    const sourceEl = document.createElement("source");
    sourceEl.type = "video/mp4";
    sourceEl.src = objectUrl;
    videoEl.appendChild(sourceEl);
  } else {
    videoEl.src = objectUrl;
  }

  // Queue of Uint8Array chunks waiting to be appended. appendBuffer()
  // can't be called again while the SourceBuffer is still "updating"
  // (processing the previous append), so incoming fetch chunks queue up
  // here and get drained one at a time from the 'updateend' handler -
  // without this queue, calling appendBuffer() while already updating
  // throws InvalidStateError and silently drops that chunk's data.
  const pendingChunks = [];
  // Consecutive InvalidStateError retries on the current head chunk. WKWebView
  // can throw InvalidStateError on an append Chromium would accept; we retry
  // rather than drop (dropping causes a decode-fatal gap - see pumpQueue),
  // but cap the retries so a genuinely wedged SourceBuffer surfaces the
  // failure instead of spinning forever.
  let _invalidStateRetries = 0;
  const MAX_INVALID_STATE_RETRIES = 20;
  // ManagedMediaSource streaming gate. True = the managed source currently
  // permits appends (between startstreaming and endstreaming). Starts true
  // so the classic-MediaSource path, which ignores this entirely, behaves
  // exactly as before. For the managed path, the startstreaming event sets
  // it true and re-drives pumpQueue; endstreaming sets it false and we
  // simply stop appending (chunks stay queued) until streaming resumes.
  let _mmsStreaming = true;
  let sourceBuffer = null;
  let stopped = false;
  let abortController = new AbortController();
  let activeReader = null; // held so stop() can cancel it immediately
  // Set once the initial start-of-playback handling has happened (see
  // startPlaybackOnceBuffered below) - this just makes sure that initial
  // step only ever runs once per attachment, not on every appended chunk.
  let hasStartedPlayback = false;
  // Tracks currentTime across periodic checkForStall() calls, to detect
  // when playback has genuinely frozen despite data continuing to
  // arrive - see checkForStall's own comment for the full reasoning and
  // why this is needed at all (nothing else here watches for this).
  let _lastStallCheckTime = performance.now();
  let _lastStallCheckPosition = -1;

  // Seek a fresh live stream to the live edge: MSE won't do this on its own,
  // so without it the <video> sits frozen at the first buffered timestamp.
  // VODs start at 0 (no seek). Waits for MIN_BUFFER_BEFORE_START_SECONDS so we
  // don't seek past the buffered range and immediately stall.
  function startPlaybackOnceBuffered() {
    if (hasStartedPlayback) return;
    if (stopped || !sourceBuffer || sourceBuffer.updating) {
      console.log("[stream-player] startPlaybackOnceBuffered: not ready", {
        stopped,
        hasSourceBuffer: !!sourceBuffer,
        updating: sourceBuffer?.updating,
      });
      return;
    }
    const buffered = sourceBuffer.buffered;
    if (buffered.length === 0) {
      console.log("[stream-player] startPlaybackOnceBuffered: buffered.length is 0");
      return;
    }
    const start = buffered.start(buffered.length - 1);
    const end = buffered.end(buffered.length - 1);
    const MIN_BUFFER_BEFORE_START_SECONDS = 1;
    console.log("[stream-player] buffered range:", { start, end, span: end - start, rangeCount: buffered.length });
    if (end - start < MIN_BUFFER_BEFORE_START_SECONDS) return;
    hasStartedPlayback = true;
    if (isVod) {
      // VOD HLS segments retain their original timestamps from the source
      // stream (e.g. 62 s if the first segment was 62 seconds into the
      // broadcast). currentTime defaults to 0, so without an explicit seek
      // the video stalls immediately at a position where no data exists.
      // Seeking to the actual start of the buffered range fixes this.
      videoEl.currentTime = start;
      // Tell the caller the HLS base offset so it can convert chapter
      // positionMilliseconds → the correct videoEl.currentTime for seeking.
      onVodStartOffset?.(start);
    } else {
      // Live: seek close to the live edge with a small safety margin so
      // currentTime doesn't overshoot before the next chunk arrives.
      videoEl.currentTime = Math.max(start, end - 0.5);
    }
    console.log("[stream-player] starting playback, currentTime set to", videoEl.currentTime);
    videoEl.play().then(() => {
      console.log("[stream-player] play() resolved successfully");
    }).catch((err) => {
      console.warn("Autoplay was blocked:", err);
    });
  }

  /** Pulls the next queued chunk into the SourceBuffer, if it's free to
   * accept one right now. Called after every successful append or remove
   * ('updateend') and every time a new chunk is enqueued. */
  function pumpQueue() {
    if (stopped || !sourceBuffer || sourceBuffer.updating) return;
    // ManagedMediaSource (WebKit/macOS) only permits appendBuffer while it
    // is actively "streaming". Appending outside that window is rejected
    // with InvalidStateError, which poisons the buffer and causes
    // MEDIA_ERR_DECODE - the macOS black screen. Unlike classic
    // MediaSource (Chromium/Windows), where you may append any time the
    // buffer isn't updating, here we must wait for the startstreaming
    // event. When streaming pauses, chunks stay queued and the
    // startstreaming handler re-drives this pump. `_mmsStreaming` starts
    // true so the non-managed path (where it's irrelevant) is unaffected.
    // Prefer the live `streaming` property if the implementation exposes
    // it (most reliable); fall back to the event-tracked flag otherwise.
    const canAppend = typeof mediaSource.streaming === "boolean"
      ? mediaSource.streaming
      : _mmsStreaming;
    if (usingManaged && !canAppend) return;
    if (pendingChunks.length === 0) return;
    const chunk = pendingChunks.shift();
    try {
      sourceBuffer.appendBuffer(chunk);
      _invalidStateRetries = 0; // success clears the WKWebView retry counter
      if (_bytesAppended === 0) _firstAppendAt = performance.now();
      _bytesAppended += chunk.byteLength;
      console.log("[stream-player] appendBuffer called with", chunk.byteLength, "bytes, queue remaining:", pendingChunks.length);
    } catch (err) {
      if (err.name === "QuotaExceededError") {
        // The SourceBuffer is full. Put the chunk back at the FRONT of the
        // queue (don't drop it — a gap in the byte stream causes the decoder
        // to throw MEDIA_ERR_DECODE next time anything is appended), then do
        // an emergency aggressive trim. trimBuffered()'s 'updateend' handler
        // will call pumpQueue again once the removal completes, at which
        // point the buffer should have room for the chunk.
        pendingChunks.unshift(chunk);
        emergencyTrim();
      } else if (err.name === "InvalidStateError") {
        // WKWebView (Safari's engine, used on macOS - NOT Chromium like
        // Windows' WebView2) is far stricter about SourceBuffer state than
        // Chromium, and intermittently throws InvalidStateError on an
        // append that Chromium would accept - e.g. a microscopic window
        // where readyState flips or an updateend hasn't fully settled.
        //
        // The OLD code fell through to the else branch below and DROPPED
        // the chunk. That was the actual macOS black-screen cause: a
        // dropped chunk leaves a gap in the byte stream, and the decoder
        // throws MEDIA_ERR_DECODE on the very next append, which is fatal
        // and triggers the relay restart - producing exactly the observed
        // "appendBuffer ok, then InvalidStateError, then MEDIA_ERR_DECODE,
        // then auto-restart" loop that showed video as a black screen.
        //
        // Instead: keep the chunk (put it back at the front) and retry it
        // on the next pump. If the SourceBuffer is genuinely fine, the
        // updateend from the previous op - or the microtask below - drives
        // the retry; the byte stream stays contiguous so the decoder never
        // sees a gap.
        pendingChunks.unshift(chunk);
        _invalidStateRetries += 1;
        if (_invalidStateRetries > MAX_INVALID_STATE_RETRIES) {
          // Genuinely wedged - stop retrying so this surfaces as a real
          // failure (and the relay-restart path can try a clean re-attach)
          // instead of an invisible infinite spin holding the same chunk.
          _invalidStateRetries = 0;
          pendingChunks.shift(); // drop the wedged head; we're giving up on it
          if (!stopped) console.error("appendBuffer InvalidStateError exceeded retries; dropping chunk");
        } else if (!sourceBuffer.updating) {
          // Nothing will fire updateend to re-drive the queue, so nudge it
          // ourselves on the next microtask (giving WebKit's state a beat
          // to settle) rather than stalling forever.
          queueMicrotask(() => {
            if (!stopped) pumpQueue();
          });
        }
      } else {
        if (!stopped) console.error("appendBuffer failed, dropping chunk:", err);
      }
    }
  }

  // Recover a frozen <video>: currentTime can stop advancing while the relay
  // keeps flowing and appendBuffer keeps succeeding, with no error - so watch
  // for it explicitly and nudge playback back. Live MSE only; VODs use hls.js,
  // which has its own recovery.
  function checkForStall() {
    if (stopped || !hasStartedPlayback || isVod) {
      // Pre-playback watchdog: appends that succeed while buffered
      // stays EMPTY mean MSE is silently discarding every frame - the
      // signature of an init segment that doesn't describe the
      // fragments (no error fires for unknown-track frames; confirmed
      // via a field log of a PiP black screen with megabytes of clean
      // appends and "buffered.length is 0" throughout). Nothing
      // downstream can ever fix that pipeline, so after 3MB/8s of it,
      // declare the source dead - reattaching gets a coherent
      // init+fragment pair from the relay's walker-tracked snapshot.
      if (!stopped && !isVod && !hasStartedPlayback && sourceBuffer &&
          _bytesAppended > 3_000_000 &&
          performance.now() - _firstAppendAt > 8_000 &&
          sourceBuffer.buffered.length === 0) {
        signalDead(`appended ${(_bytesAppended / 1e6).toFixed(1)}MB but nothing entered the buffer (init/fragment mismatch?)`);
      }
      return;
    }
    // Byte starvation is checked BEFORE the paused early-return below:
    // a dead relay starves the download regardless of whether the video
    // element happens to be paused, and 20s of zero bytes on a live
    // stream is unambiguous (the relay ships data continuously - even a
    // quiet just-chatting stream is a constant few-hundred-KB/s).
    const silentFor = performance.now() - _lastByteAt;
    // Early warning at 5s. A live relay ships data continuously (even a
    // silent just-chatting stream is a constant few-hundred KB/s), so 5s
    // of nothing already means something is wrong - but "wrong" could
    // still be a blip, so this does NOT stop playback. It just lets the
    // listener ask Helix whether the channel is still live, which answers
    // in a fraction of a second and is authoritative. A stream that has
    // actually ended can then hand over to Kick immediately instead of
    // waiting out the 20s below and a failed restart on top of it.
    if (silentFor > 5_000 && !_silenceSignaled && !stopped && !_teardownExpected && !isVod) {
      _silenceSignaled = true;
      onSilence(Math.round(silentFor / 1000));
    }
    if (silentFor > 20_000) {
      signalDead("no bytes from relay for 20s");
      return;
    }
    if (videoEl.paused || videoEl.ended) {
      // User-paused (or genuinely ended) - not something to "fix." Reset
      // the tracker so resuming playback afterward starts a fresh
      // measurement instead of immediately looking stalled.
      _lastStallCheckPosition = videoEl.currentTime;
      _lastStallCheckTime = performance.now();
      return;
    }

    const pos = videoEl.currentTime;
    const now = performance.now();
    if (pos > _lastStallCheckPosition + 0.1) {
      // Genuinely advancing since the last check - playing normally.
      _lastStallCheckPosition = pos;
      _lastStallCheckTime = now;
      return;
    }
    if (pos < _lastStallCheckPosition) {
      // Playback moved BACKWARD, which playback alone cannot do - someone
      // seeked (ArrowLeft, the seek bar, or a programmatic rewind).
      //
      // This branch is why rewinding a live stream used to snap back to
      // the live edge a few seconds later: the baseline still held the
      // pre-seek (larger) position, so the "advancing normally" check
      // above could not match, _lastStallCheckTime was never refreshed,
      // and once it aged past STALL_THRESHOLD_MS the recovery below fired
      // and yanked currentTime to the live edge - even though playback was
      // running perfectly from the new position. Re-baselining here (and
      // on the 'seeking' event, for immediacy) makes a seek look like what
      // it is: a fresh starting point, not a frozen playhead.
      _lastStallCheckPosition = pos;
      _lastStallCheckTime = now;
      return;
    }

    // currentTime hasn't moved since the last check. Only act once it's
    // been stuck for a while, not on the very first flat reading - a
    // brief pause between this function's own 4s-interval checks is
    // normal jitter, not a real stall.
    const STALL_THRESHOLD_MS = 6_000;
    if (now - _lastStallCheckTime < STALL_THRESHOLD_MS) return;

    if (!sourceBuffer || sourceBuffer.updating) return;
    const buffered = sourceBuffer.buffered;
    if (buffered.length === 0) return;
    const latestRangeStart = buffered.start(buffered.length - 1);
    const latestRangeEnd = buffered.end(buffered.length - 1);
    if (latestRangeEnd <= pos + 1) {
      // No new data past where playback is stuck either - this is a
      // genuine relay/network outage (or the broadcast itself stalled),
      // not the "video won't resume despite data being available" case
      // this function exists for. Nothing to seek into; just keep
      // waiting, same as before this function existed.
      return;
    }

    console.warn(
      `[stream-player] STALL detected: currentTime frozen at ${pos.toFixed(1)} for ` +
      `${((now - _lastStallCheckTime) / 1000).toFixed(1)}s while buffered data reaches ` +
      `${latestRangeEnd.toFixed(1)} - forcing recovery`
    );
    // Same "near the end, small safety margin" target startPlaybackOnceBuffered
    // uses for the initial live-edge jump - close enough to "now" without
    // overshooting past what's actually buffered yet.
    videoEl.currentTime = Math.max(latestRangeStart, latestRangeEnd - 0.5);
    videoEl.play().catch((err) => console.warn("[stream-player] stall-recovery play() failed:", err));
    _lastStallCheckPosition = videoEl.currentTime;
    _lastStallCheckTime = now;
  }

  /** Removes old buffered ranges so a long-running stream doesn't grow
   * SourceBuffer memory without bound. Keeps a short trailing window
   * behind the playhead (already-played data is useless) and for VODs
   * also caps how far ahead data is buffered (streamlink sends data much
   * faster than real-time; without a forward cap the buffer fills in
   * minutes on a long VOD). */
  function trimBuffered() {
    if (stopped) return; // controller already torn down — don't touch SourceBuffer
    if (!hasStartedPlayback) return;
    if (!sourceBuffer || sourceBuffer.updating) return;
    const buffered = sourceBuffer.buffered;
    if (buffered.length === 0) return;
    const currentTime = videoEl.currentTime;

    // Trailing trim: keep TRAILING_WINDOW behind the playhead (already-
    // played data, kept around so ArrowLeft/seek-bar rewinding on a live
    // stream has somewhere to go - see seekRelative() in
    // playback-controls.js, which is clamped to exactly this buffered
    // range). 120s (was 30s, and 90s before that) trades a bit more
    // SourceBuffer memory for meaningfully more rewind room; raising this
    // further is safe too; if it ever pushes too close to the browser's
    // own SourceBuffer quota, emergencyTrim() below already exists as a
    // fallback that trims more aggressively on QuotaExceededError, so
    // this number isn't a safety limit being relaxed, just how
    // proactively memory gets freed under normal conditions.
    const TRAILING_WINDOW = 120;
    const removeEnd = currentTime - TRAILING_WINDOW;
    if (removeEnd > buffered.start(0) + 2) {
      try {
        sourceBuffer.remove(buffered.start(0), removeEnd);
        return; // remove triggers updateend → pumpQueue runs next
      } catch (err) {
        console.warn("SourceBuffer.remove (trailing) failed:", err);
      }
    }

    // Forward trim (VOD only): keep at most 3 min of data ahead.
    // For VODs, seeking already restarts the relay anyway, so there's no
    // point buffering hours ahead - it just fills the quota and crashes.
    if (isVod) {
      const MAX_FORWARD = 180; // seconds
      const fwdEnd = buffered.length > 0 ? buffered.end(buffered.length - 1) : 0;
      const fwdTrimStart = currentTime + MAX_FORWARD;
      if (fwdEnd > fwdTrimStart + 10) {
        try {
          sourceBuffer.remove(fwdTrimStart, fwdEnd);
        } catch (err) {
          console.warn("SourceBuffer.remove (forward) failed:", err);
        }
      }
    }
  }

  /** Emergency trim called when appendBuffer throws QuotaExceededError.
   * Tries trailing data first; if nothing to remove there (common at the
   * start of a VOD) falls back to trimming the forward buffer. */
  function emergencyTrim() {
    if (!sourceBuffer || sourceBuffer.updating) return;
    const buffered = sourceBuffer.buffered;
    if (buffered.length === 0) return;
    const currentTime = videoEl.currentTime;

    // Prefer removing old data behind the playhead first.
    const trailEnd = currentTime - 5;
    if (trailEnd > buffered.start(0) + 0.5) {
      try {
        sourceBuffer.remove(buffered.start(0), trailEnd);
        return; // updateend → pumpQueue retry
      } catch (err) {
        console.warn("[stream-player] emergency trail trim failed:", err);
      }
    }

    // No trailing data worth removing (playhead is near the start).
    // Trim the forward buffer instead — keep 30 s ahead and drop the
    // rest. For VODs, any discarded future data will be re-streamed
    // automatically when the relay catches up.
    const fwdEnd = buffered.end(buffered.length - 1);
    const fwdKeepUntil = currentTime + 30;
    if (fwdEnd > fwdKeepUntil + 2) {
      try {
        console.log("[stream-player] emergency forward trim", fwdKeepUntil.toFixed(1), "→", fwdEnd.toFixed(1));
        sourceBuffer.remove(fwdKeepUntil, fwdEnd);
        // updateend → pumpQueue will retry the rescued chunk
      } catch (err) {
        console.warn("[stream-player] emergency forward trim failed:", err);
      }
    }
  }

  // Run every 4 s (down from 15 s) so the buffer never fills far enough
  // to trigger QuotaExceededError in the first place. checkForStall runs
  // on this same cadence rather than a separate timer - see its own
  // comment for what it's watching for.
  const trimInterval = setInterval(() => {
    checkForStall();
    trimBuffered();
  }, 4_000);

  let _lastByteAt = performance.now();
  let _deadSignaled = false;
  // Set by expectTeardown() when the CALLER is about to kill this relay
  // on purpose (a quality switch restarts streamlink server-side). The
  // relay body EOFs either way, and an EOF is indistinguishable at this
  // layer from the stream genuinely ending - so the caller has to say so.
  // Without this, a quality change looks exactly like a stream end and
  // trips the Kick failover. Distinct from `stopped`, which is only true
  // once this attachment is fully torn down - during the restart window
  // the old attachment is still live and still draining bytes.
  let _teardownExpected = false;
  // Has onSilence already fired for the CURRENT silent spell? Reset the
  // moment bytes arrive, so a later spell can probe again.
  let _silenceSignaled = false;
  // DEV: set by simulateSilence() to reproduce a real stream end. Chunks
  // that arrive are DROPPED and _lastByteAt is left to go stale, which is
  // precisely what the player sees when a broadcast ends - the relay stops
  // supplying data without closing the connection (a real end logs "no
  // bytes from relay for 20s", not an EOF). Everything downstream - the
  // 5s onSilence probe, the 20s onDead verdict, the buffer draining and
  // the picture freezing - then happens on its own, through production
  // code paths, on real timers. Nothing is short-circuited.
  let _simulateSilence = false;
  // Counters for the pre-playback mismatch watchdog in checkForStall.
  let _bytesAppended = 0;
  let _firstAppendAt = 0;
  function signalDead(reason) {
    if (stopped || _teardownExpected || _deadSignaled || isVod || !onDead) return;
    _deadSignaled = true;
    console.warn(`[stream-player] relay source is dead (${reason})`);
    onDead(reason);
  }

  async function pumpFetch() {
    let response;
    try {
      response = await fetch(relayUrl, { signal: abortController.signal });
    } catch (err) {
      if (stopped) return; // expected - stop() aborted the fetch
      console.error("Failed to fetch relay stream:", err);
      onFatalError();
      signalDead(`relay fetch failed: ${err?.message || err}`);
      return;
    }

    console.log("[stream-player] fetch responded:", response.status, response.headers.get("content-type"));
      const snapshotNote = response.headers.get("x-relay-snapshot");
      if (snapshotNote) console.log("[stream-player] relay snapshot decision:", snapshotNote);

    if (!response.ok || !response.body) {
      console.error("Relay stream fetch returned a bad response:", response.status);
      onFatalError();
      return;
    }

    const reader = response.body.getReader();
    activeReader = reader;

    // Before the SourceBuffer can even be created, the EXACT codec
    // string this stream needs has to be read out of its own init
    // segment (see buildCodecStringFromInitSegment's doc comment for
    // why guessing isn't good enough). Bytes accumulate here, raw,
    // until that succeeds - addSourceBuffer() literally cannot happen
    // any earlier than this, since its first argument IS that codec
    // string. INIT_SEGMENT_SCAN_CAP_BYTES is a safety valve in case a
    // moov box somehow never resolves (corrupt stream, codec this parser
    // doesn't recognize at all) - without it, a stream that can truly
    // never be identified would accumulate bytes in memory forever.
    const INIT_SEGMENT_SCAN_CAP_BYTES = 2 * 1024 * 1024;
    let initSegmentChunks = [];
    let initSegmentTotalBytes = 0;
    let codecResolved = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          console.log("[stream-player] relay stream reader done");
          // A live relay body ending is never normal mid-session - the
          // pump only EOFs when streamlink exited (network drop, the
          // broadcast host's encoder hiccuping long enough for
          // streamlink to give up, or the stream genuinely ending).
          signalDead("relay stream ended");
          break;
        }
        // DEV silence simulation: throw the chunk away and DON'T touch
        // _lastByteAt, so the starvation timers age exactly as they would
        // if the relay had gone quiet for real.
        if (_simulateSilence) continue;
        _lastByteAt = performance.now();
        // Bytes are flowing again - re-arm the early-silence probe so a
        // LATER silent spell can fire it too (it's once-per-spell, not
        // once-per-attachment).
        _silenceSignaled = false;
        if (stopped) break;
        console.log("[stream-player] read chunk from relay:", value.byteLength, "bytes");

        if (!codecResolved) {
          initSegmentChunks.push(value);
          initSegmentTotalBytes += value.byteLength;

          // On the very first chunk, log the leading bytes so a failing
          // stream can be diagnosed from the console: fMP4 starts with a
          // ftyp box whose type bytes (offset 4-7) read as ASCII "ftyp"
          // (66 74 79 70); MPEG-TS starts with sync byte 0x47.
          if (initSegmentChunks.length === 1) {
            const preview = Array.from(value.slice(0, 32))
              .map((b) => b.toString(16).padStart(2, "0"))
              .join(" ");
            console.log("[stream-player] first 32 stream bytes (hex):", preview);
          }

          const combined = new Uint8Array(initSegmentTotalBytes);
          let offset = 0;
          for (const chunk of initSegmentChunks) {
            combined.set(chunk, offset);
            offset += chunk.byteLength;
          }

          const mimeType = buildCodecStringFromInitSegment(combined);
          if (mimeType) {
            console.log("[stream-player] resolved codec from init segment:", mimeType);
            codecResolved = true;
            const created = createSourceBufferOrFail(mimeType);
            if (!created) return; // onFatalError already called
            // Feed everything accumulated so far (the actual init
            // segment, plus possibly a little real media data that
            // arrived in the same chunk) into the normal queue now that
            // there's a SourceBuffer to receive it.
            pendingChunks.push(combined);
            pumpQueue();
            initSegmentChunks = []; // free the now-redundant raw accumulator
          } else if (initSegmentTotalBytes > INIT_SEGMENT_SCAN_CAP_BYTES) {
            console.error(
              "[stream-player] Could not identify stream codec (no avcC/hvcC/av1C found)" +
              " within the first",
              INIT_SEGMENT_SCAN_CAP_BYTES,
              "bytes - giving up. Check the hex dump above to confirm this is fMP4.",
            );
            onFatalError();
            return;
          }
          // Still accumulating, haven't found the codec yet - don't
          // queue/append anything until we have a SourceBuffer to
          // receive it.
          continue;
        }

        pendingChunks.push(value);
        pumpQueue();

        // VOD backpressure: streamlink delivers data far faster than
        // real-time (it reads from Twitch's CDN at full network speed).
        // Without throttling, the SourceBuffer fills its browser-imposed
        // quota (≈100-150 MB) within a few seconds of a 10-hour VOD,
        // triggering QuotaExceededError and killing the stream.
        // Solution: after each chunk, check how far ahead we've buffered.
        // If it's already 90 s ahead, pause reading until the player
        // consumes enough to drop below 60 s — keeping the buffer
        // comfortable without ever letting it overflow.
        if (isVod && hasStartedPlayback && sourceBuffer) {
          const MAX_AHEAD = 90;
          const MIN_AHEAD = 60;
          const bLen = () => sourceBuffer.buffered?.length ?? 0;
          const fwdSeconds = () =>
            bLen() > 0
              ? sourceBuffer.buffered.end(bLen() - 1) - videoEl.currentTime
              : 0;
          if (fwdSeconds() > MAX_AHEAD) {
            while (!stopped && fwdSeconds() > MIN_AHEAD) {
              await new Promise((r) => setTimeout(r, 250));
            }
          }
        }
      }
    } catch (err) {
      if (!stopped) console.error("Relay stream read error:", err);
    } finally {
      activeReader = null;
    }

    // The relay's connection ended (stream stopped, streamlink exited, or
    // a channel switch closed the old connection from the Rust side) -
    // signal end-of-stream on the MediaSource so the <video> element
    // knows playback has genuinely finished rather than just stalling
    // indefinitely waiting for more data that will never arrive on this
    // now-closed connection.
    if (!stopped && mediaSource.readyState === "open") {
      try {
        mediaSource.endOfStream();
      } catch (err) {
        console.warn("endOfStream failed (non-fatal):", err);
      }
    }
  }

  /**
   * Creates the SourceBuffer with the exact codec string resolved from
   * this stream's own init segment, wiring up its event listeners the
   * same way every attachment needs. Returns true on success; calls
   * onFatalError() and returns false if even this exact, stream-derived
   * codec string is somehow rejected (a genuinely unsupported codec -
   * e.g. an HEVC profile this webview's decoder doesn't have hardware/
   * software support for at all - rather than a guessing problem).
   */
  function createSourceBufferOrFail(mimeType) {
    try {
      sourceBuffer = mediaSource.addSourceBuffer(mimeType);
    } catch (err) {
      console.error("addSourceBuffer rejected the stream's own resolved codec:", mimeType, err);
      onFatalError();
      return false;
    }
    console.log("[stream-player] MSE attached with codec:", mimeType);
    // Diagnostics for the "video stays black even though bytes flow" case,
    // which on macOS (WKWebView, not Chromium) most often means the webview
    // accepted the SourceBuffer but can't actually DECODE the codec - Safari/
    // WKWebView's MSE codec support is narrower than Chromium's, and AV1 in
    // particular is unsupported on older Macs. isTypeSupported can even
    // return true while decode still fails, so we also check for real frames.
    try {
      console.log(
        "[stream-player] isTypeSupported:", MediaSource.isTypeSupported(mimeType),
      );
    } catch {}
    setTimeout(() => {
      if (stopped) return;
      // videoWidth stays 0 until at least one frame has actually decoded.
      // readyState >= 2 (HAVE_CURRENT_DATA) means a frame is available.
      // Both zero here, with data buffered, = decoder isn't producing frames
      // (the black-screen signature) rather than a starvation/network issue.
      console.log(
        "[stream-player] decode check:",
        "videoWidth =", videoEl.videoWidth,
        "| videoHeight =", videoEl.videoHeight,
        "| readyState =", videoEl.readyState,
        "| buffered ranges =", videoEl.buffered.length,
        "| codec =", mimeType,
      );
      if (videoEl.videoWidth === 0 && videoEl.buffered.length > 0) {
        console.error(
          "[stream-player] BLACK-SCREEN SIGNATURE: data is buffered but no frame decoded. " +
          "This webview likely cannot decode this codec (" + mimeType + ").",
        );
      }
    }, 5000);
    sourceBuffer.addEventListener("updateend", () => {
      if (stopped) return; // in-flight operation completed after stop() — ignore
      startPlaybackOnceBuffered();
      pumpQueue();
    });
    sourceBuffer.addEventListener("error", (e) => {
      console.error("SourceBuffer error:", e);
    });
    return true;
  }

  // Any seek (user or programmatic) resets the stall baseline right away.
  // The periodic check also handles backward jumps, but that only runs
  // every 4s; without this, a seek landing just before a tick could still
  // be measured against a stale pre-seek baseline.
  const onSeekResetStallBaseline = () => {
    _lastStallCheckPosition = videoEl.currentTime;
    _lastStallCheckTime = performance.now();
  };
  videoEl.addEventListener("seeking", onSeekResetStallBaseline);
  videoEl.addEventListener("seeked", onSeekResetStallBaseline);

  videoEl.addEventListener("error", () => {
    const mediaError = videoEl.error;
    const codeNames = {
      1: "MEDIA_ERR_ABORTED",
      2: "MEDIA_ERR_NETWORK",
      3: "MEDIA_ERR_DECODE",
      4: "MEDIA_ERR_SRC_NOT_SUPPORTED",
    };
    console.error(
      "[stream-player] video element error:",
      mediaError ? `code=${mediaError.code} (${codeNames[mediaError.code] || "unknown"}) message=${mediaError.message}` : mediaError,
    );
    // MEDIA_ERR_DECODE means the MSE decoder has entered a permanent error
    // state — videoEl.error is non-null and every subsequent appendBuffer
    // call will throw InvalidStateError. Stop pumping immediately so the
    // relay connection isn't held open forever just to have every chunk
    // dropped, and notify the caller so it can attempt recovery (e.g.
    // restart streamlink via a fresh start_stream Tauri call).
    // MEDIA_ERR_ABORTED (1) is expected when stop() is called explicitly,
    // so that case is intentionally excluded.
    if (mediaError && mediaError.code === MediaError.MEDIA_ERR_DECODE && !stopped) {
      stopped = true;
      abortController.abort();
      onFatalError();
    }
  });
  mediaSource.addEventListener("sourceended", () => {
    console.log("[stream-player] mediaSource sourceended");
  });
  mediaSource.addEventListener("sourceclose", () => {
    console.log("[stream-player] mediaSource sourceclose");
  });

  if (usingManaged) {
    // See _mmsStreaming: gate appends on the managed source's streaming
    // window. When it starts streaming, resume draining the queue; when it
    // stops, hold. Without this, appends outside the window throw
    // InvalidStateError on WebKit and black-screen the stream.
    mediaSource.addEventListener("startstreaming", () => {
      _mmsStreaming = true;
      if (!stopped) pumpQueue();
    });
    mediaSource.addEventListener("endstreaming", () => {
      _mmsStreaming = false;
    });
  }

  mediaSource.addEventListener("sourceopen", () => {
    if (stopped) return;
    console.log("[stream-player] mediaSource sourceopen fired");
    pumpFetch();
  }, { once: true });

  return {
    /**
     * Announces that this relay is about to be killed deliberately
     * (server-side quality restart), so the resulting EOF must NOT be
     * reported as a stream death. Playback of already-buffered bytes
     * continues untouched until the replacement attachment calls stop()
     * on this one - so there's no extra black frame from calling this.
     */
    expectTeardown() {
      _teardownExpected = true;
    },
    /** DEV ONLY (see the "Test failover" button in main.js): make this
     * attachment behave as though the broadcast just ended. */
    simulateSilence() {
      _simulateSilence = true;
    },
    stop() {
      stopped = true;
      clearInterval(trimInterval);
      videoEl.removeEventListener("seeking", onSeekResetStallBaseline);
      videoEl.removeEventListener("seeked", onSeekResetStallBaseline);
      if (activeReader) {
        try { activeReader.cancel(); } catch {}
        activeReader = null;
      }
      abortController.abort();
      try {
        if (mediaSource.readyState === "open") {
          mediaSource.endOfStream();
        }
      } catch {
        // Already closed/ended or in a state that doesn't allow this -
        // fine, we're tearing down regardless.
      }
      URL.revokeObjectURL(objectUrl);
    },
  };
}
