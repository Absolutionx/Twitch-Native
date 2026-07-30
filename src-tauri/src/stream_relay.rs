// Spawns streamlink and relays its stdout over a local HTTP server on
// 127.0.0.1, so the webview can fetch() it (same-origin, no CORS) and feed
// the bytes to a <video> via MSE (see src/stream-player.js). streamlink is a
// plain process, so unlike a webview fetch of usher.ttvnw.net it isn't subject
// to CORS.
//
// streamlink outputs MPEG-TS or fMP4 depending on channel/CDN; MSE needs fMP4,
// so we pipe through ffmpeg (`-c copy` remux, movflags frag_keyframe+
// empty_moov+default_base_moof) before broadcasting. ffmpeg must be on PATH.

use std::collections::VecDeque;
use std::process::Stdio;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::process::{Child, Command};
use tokio::sync::{broadcast, Mutex};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// How many chunks the broadcast channel holds before it starts dropping
/// the oldest ones for slow subscribers. Each chunk is whatever size a
/// single stdout read happened to return (commonly a few KB to ~64KB) -
/// which is why the old value of 256 was far too small: at a few KB per
/// chunk and a normal live bitrate that's only ~1-2 SECONDS of headroom,
/// and a freshly-opened PiP window (subscribe -> boot webview -> parse
/// codec -> ingest the catch-up snapshot) routinely needs more than that
/// before it starts draining, making a lag - now a clean disconnect+
/// rejoin, see the Lagged branch - a coin-flip on every PiP open. 4096
/// chunks is minutes of headroom at small chunk sizes while costing
/// almost nothing: the queue holds Arc clones of chunks that mostly
/// already live in the overflow cache, so it's pointers, not copies.
const CHUNK_BUFFER_CAPACITY: usize = 4096;

/// Catch-up snapshots larger than this get trimmed to init segment +
/// newest fragment even when the cache is perfectly contiguous. Every
/// relay consumer plays at the live edge (the player seeks there the
/// moment it has ~1s buffered), so history beyond the newest fragment
/// is bytes the client downloads, appends, and immediately skips - and
/// with the overflow cache holding up to 16 MB, that dead weight was
/// measurably delaying PiP first-frame by several seconds, GROWING with
/// session age as the overflow filled (matching the field report:
/// later opens "sometimes just as long, if not longer"). 4 MB keeps the
/// original whole-cache behavior for young sessions (where it's cheap
/// and where the first-ever connection lives) while capping what any
/// established-session joiner has to swallow.
const SNAPSHOT_TAIL_TRIM_THRESHOLD: usize = 4 * 1024 * 1024;

/// Resolves a dependency binary (streamlink) to a full path. Mirrors the
/// search order the old resolve_dep() in main.rs used before this app's
/// mpv-based player was removed: PATH lookup is the common case for
/// anyone with streamlink already installed (e.g. via pip, or the
/// standalone Windows installer, both of which put it on PATH).
fn resolve_streamlink_path() -> std::path::PathBuf {
    resolve_dep_path("streamlink")
}

/// Resolves an external binary (streamlink, ffmpeg) to a path we can spawn.
///
/// On Windows and Linux a bare name is right: PATH lookup finds it, which
/// is how it's always worked here.
///
/// macOS needs more. An .app launched from Finder/Dock does NOT inherit the
/// shell's PATH - it gets a minimal system PATH that contains neither
/// /opt/homebrew/bin (Apple Silicon) nor /usr/local/bin (Intel). So a user
/// who ran `brew install streamlink ffmpeg` successfully, and can run both
/// from Terminal, still gets "streamlink not found" the moment they launch
/// the app by double-clicking it - while `npm run tauri dev` from a
/// terminal works fine, because that inherits the shell environment. That
/// asymmetry makes it a nasty one to debug, so we check the Homebrew
/// locations explicitly and only then fall back to the bare name (which
/// still covers terminal launches and anything genuinely on the system PATH).
pub(crate) fn resolve_dep_path(name: &str) -> std::path::PathBuf {
    #[cfg(target_os = "macos")]
    {
        // A Finder-launched .app gets a minimal PATH (often just
        // /usr/bin:/bin:/usr/sbin:/sbin) with none of the places these
        // tools actually install. Check the common ones explicitly.
        // Order matters: Apple Silicon Homebrew first, then Intel
        // Homebrew, then the two spots pip/pipx drop user installs.
        let home = std::env::var("HOME").unwrap_or_default();
        let candidates = [
            format!("/opt/homebrew/bin/{name}"),      // Apple Silicon brew
            format!("/usr/local/bin/{name}"),         // Intel brew
            format!("{home}/.local/bin/{name}"),      // pipx / pip --user
            format!("/opt/local/bin/{name}"),         // MacPorts
        ];
        for c in candidates {
            let p = std::path::PathBuf::from(&c);
            // is_file() follows symlinks, so a Homebrew symlink into
            // ../Cellar resolves correctly.
            if p.is_file() {
                eprintln!("[deps] resolved {name} -> {c}");
                return p;
            }
        }
        eprintln!(
            "[deps] {name} not found in known macOS locations; \
             falling back to bare name (PATH lookup)"
        );
    }
    std::path::PathBuf::from(name)
}

/// Contiguous byte cache for a single stream session. Stores every byte
/// produced since the last start_relay call in two tiers:
///
///   init_bytes   - the first INIT_SEGMENT_CACHE_CAP bytes verbatim.
///                  Always starts at stream byte 0.
///   overflow     - a bounded ring buffer of chunks produced after
///                  init_bytes is full. Older chunks are evicted once the
///                  total overflow byte count exceeds OVERFLOW_BUFFER_CAP.
///
/// Together they form a contiguous range [0, overflow_end). When a new
/// HTTP connection arrives, handle_connection sends init_bytes + all
/// overflow chunks, then subscribes to the live broadcast for what
/// follows. pump_stdout_to_broadcast holds this struct's lock while
/// sending each chunk to the broadcast channel, so the (subscribe +
/// snapshot) pair in handle_connection is always atomic with respect to
/// new broadcast sends - the live subscription picks up exactly where
/// the snapshot left off, with no gap.
///
/// WHY OVERFLOW IS NEEDED: tokio::sync::broadcast drops messages with no
/// active receivers. Between start_relay returning a URL and the
/// frontend's HTTP fetch actually landing here (~500–700 ms at typical
/// Twitch bitrates), init_bytes fills to its cap and pump_stdout keeps
/// sending to a broadcast with zero subscribers. Without the overflow
/// ring buffer, everything produced in that gap is silently lost -
/// handle_connection would send init_bytes (0–512 KB) followed by the
/// first live chunk (now at byte ~600 KB+), and that non-contiguous fMP4
/// byte stream trips the browser's chunk demuxer
/// (CHUNK_DEMUXER_ERROR_APPEND_FAILED), leaving a permanent black screen.
struct CachedStream {
    init_bytes: Vec<u8>,
    overflow: VecDeque<Arc<[u8]>>,
    /// Running total of bytes currently in overflow (to check the cap
    /// without iterating the whole deque on every write).
    overflow_byte_count: usize,
    /// True once evict_overflow_if_needed has ever dropped a chunk this
    /// session. While false, init_bytes + overflow really is the
    /// contiguous [0, now) range the struct doc describes and joiners
    /// can be fed the whole thing. Once true, that range has a hole in
    /// the middle, and any NEW connection (in practice: the PiP window
    /// joining minutes into a session - the doc comment's "never full
    /// when the first connection arrives" assumption is about the FIRST
    /// connection only) must instead get the fragment-aligned late-join
    /// payload from handle_connection, because init_bytes followed by
    /// post-eviction overflow is exactly the non-contiguous byte stream
    /// that trips CHUNK_DEMUXER_ERROR_APPEND_FAILED and blackscreens
    /// the player - confirmed in the field: PiP reopened late in a
    /// session rendered pure black while the first, early open worked.
    evicted_any: bool,
    /// Total bytes ever produced this session (init tier + overflow +
    /// evicted). overflow[0]'s absolute offset is total_bytes -
    /// overflow_byte_count, which is how latest_frag_abs (below) maps
    /// into the overflow snapshot at join time.
    total_bytes: u64,
    /// See BoxWalker - tracks the latest init segment and newest
    /// fragment offset as bytes flow, so late joins never guess.
    walker: BoxWalker,
}

impl Default for CachedStream {
    fn default() -> Self {
        CachedStream {
            init_bytes: Vec::new(),
            overflow: VecDeque::new(),
            overflow_byte_count: 0,
            evicted_any: false,
            total_bytes: 0,
            walker: BoxWalker::new(),
        }
    }
}

/// Cap on the init_bytes tier (first INIT_SEGMENT_CACHE_CAP bytes of the
/// stream are stored verbatim). The fMP4 init segment itself (ftyp + moov)
/// is typically a few KB; 512 KB is generous headroom that also captures
/// a small amount of leading media data so the player has a head-start
/// buffered range the instant it connects.
const INIT_SEGMENT_CACHE_CAP: usize = 512 * 1024;

/// Cap on the total bytes kept in the overflow ring buffer. Older chunks
/// are evicted once this limit is reached. 16 MB at a 6 Mbps stream covers
/// ~21 seconds, far more than the typical frontend connection delay, so in
/// practice the overflow buffer is never full when the first connection
/// arrives.
const OVERFLOW_BUFFER_CAP: usize = 16 * 1024 * 1024;

/// Holds the currently running streamlink process (if any), the broadcast
/// sender new HTTP connections subscribe to for stream bytes, the local
/// HTTP server's bound port, and the CachedStream that guarantees every new
/// HTTP connection receives a contiguous byte range from stream byte 0 to
/// the current live position — see CachedStream's doc comment for why a
/// plain capped Vec was not sufficient.
pub struct StreamRelayState {
    /// All spawned child processes for the current stream: [ffmpeg, streamlink]
    /// for MPEG-TS input (two processes), or [streamlink] for native fMP4
    /// input (one process, no ffmpeg needed). Drained and killed on stop.
    children: Mutex<Vec<Child>>,
    chunk_tx: Mutex<Option<broadcast::Sender<Arc<[u8]>>>>,
    cache: Mutex<CachedStream>,
    port: AtomicU16,
    /// Bumped on every new stream start - lets in-flight HTTP handlers
    /// from a PREVIOUS stream notice they're stale and close themselves
    /// out, rather than continuing to serve old/wrong bytes to a client
    /// that's still connected from before a channel switch.
    generation: std::sync::atomic::AtomicU64,
    /// Serializes start_relay so two concurrent channel switches can't
    /// interleave their (stop previous -> spawn -> store children) steps.
    /// Without it, rapid switching lets an OLDER start_relay's
    /// stop_current_stream run AFTER a newer one already stored its
    /// pipeline, killing the newer relay - the client reading it then
    /// hits EOF and reports "relay stream ended", which the frontend
    /// treats as the stream having ended and fails over to Kick. Held for
    /// the whole stop+spawn+store critical section.
    start_lock: Mutex<()>,
    /// Incremented the instant a start_relay call begins (before it takes
    /// start_lock). A call captures this as its ticket; if a NEWER start
    /// has since bumped it by the time this call finishes spawning, this
    /// call is stale and aborts - killing only its OWN just-spawned
    /// pipeline rather than storing it over the newer one's.
    start_requests: std::sync::atomic::AtomicU64,
}

impl Default for StreamRelayState {
    fn default() -> Self {
        StreamRelayState {
            children: Mutex::new(Vec::new()),
            chunk_tx: Mutex::new(None),
            cache: Mutex::new(CachedStream::default()),
            port: AtomicU16::new(0),
            generation: std::sync::atomic::AtomicU64::new(0),
            start_lock: Mutex::new(()),
            start_requests: std::sync::atomic::AtomicU64::new(0),
        }
    }
}

/// Stops any currently running pipeline. Safe to call when nothing is
/// running. Does NOT stop the HTTP server itself.
async fn stop_current_stream(state: &StreamRelayState) {
    let mut children = state.children.lock().await;
    for mut child in children.drain(..) {
        let _ = child.kill().await;
    }
}

/// Outcome of format-probing the streamlink output.
///
/// The two variants exist because native fMP4 and MPEG-TS need different
/// handling:
///
///   Passthrough   – streamlink is already outputting fragmented MP4.
///                   The bytes are fed directly to the relay without any
///                   extra process. `first_chunk` contains the probe bytes
///                   (already read); `rest` is the remaining stdout.
///
///   FfmpegMediated – streamlink is outputting MPEG-TS (or some other
///                    non-fMP4 container). The bytes must go through ffmpeg
///                    to be remuxed into fragmented MP4. `ff_child`,
///                    `ff_stdout`, and `ff_stderr` are the ffmpeg process
///                    handles; `sl_child` is the streamlink process (kept
///                    so it can be killed explicitly on stop rather than
///                    relying on the EPIPE cascade from ffmpeg dying).
enum PipelineResult {
    Passthrough {
        first_chunk: Vec<u8>,
        rest: tokio::process::ChildStdout,
        sl_child: Child,
    },
    FfmpegMediated {
        ff_child: Child,
        ff_stdout: tokio::process::ChildStdout,
        ff_stderr: tokio::process::ChildStderr,
        sl_child: Child,
    },
}

/// Probes the first bytes of streamlink's output to determine the container
/// format, then either passes the stream through directly (fMP4) or routes
/// it through an ffmpeg remux process (MPEG-TS → fMP4).
///
/// WHY NOT ALWAYS USE FFMPEG: ffmpeg's `-movflags empty_moov` writes the
/// moov box before it has read the input moov. For native fMP4 input, the
/// output moov can end up with wrong or missing codec parameters, causing
/// Chrome's chunk demuxer to raise CHUNK_DEMUXER_ERROR_APPEND_FAILED on the
/// very first appendBuffer call. Passing fMP4 through unchanged avoids this
/// entirely.
///
/// WHY NO `empty_moov` FOR MPEG-TS: for MPEG-TS input, ffmpeg needs to
/// probe the stream to determine codec parameters before writing the output
/// moov. Without `empty_moov`, ffmpeg waits until it has that info and then
/// writes a proper, complete moov, which Chrome's MSE accepts. With
/// `empty_moov`, ffmpeg would write an incomplete placeholder first.
/// On macOS, ensures a child process (streamlink, ffmpeg) can find OTHER
/// binaries it needs at runtime. A Finder-launched .app has a minimal
/// PATH, and streamlink in particular shells out to ffmpeg itself for
/// muxing - so even when we launch streamlink by absolute path, its own
/// `ffmpeg` lookup fails unless we put the Homebrew/pip bin dirs on the
/// PATH we hand it. Prepends the known locations to the inherited PATH.
/// No-op on Windows/Linux, where the inherited PATH is already correct.
#[allow(unused_variables)]
fn augment_child_path(cmd: &mut Command) {
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").unwrap_or_default();
        let extra = format!(
            "/opt/homebrew/bin:/usr/local/bin:{home}/.local/bin:/opt/local/bin"
        );
        let combined = match std::env::var("PATH") {
            Ok(existing) if !existing.is_empty() => format!("{extra}:{existing}"),
            _ => extra,
        };
        cmd.env("PATH", combined);
    }
}

async fn spawn_pipeline(
    target_url: &str,
    quality: &str,
    extra_args: &[String],
) -> std::io::Result<PipelineResult> {
    // --- Streamlink ---
    let mut sl_cmd = Command::new(resolve_streamlink_path());
    sl_cmd
        .arg(target_url)
        .arg(quality)
        .arg("--stdout")
        .arg("--twitch-disable-ads")
        .args(extra_args)
        .stdout(Stdio::piped())
        // Capture streamlink's stderr instead of discarding it. When
        // streamlink launches but then fails - most commonly on macOS,
        // where a pip-installed streamlink's own Python interpreter isn't
        // on a Finder-launched app's minimal PATH, or a plugin can't
        // resolve the stream - its diagnostics are the only thing that
        // says why. Discarding them (the old Stdio::null) turned every
        // such failure into a silent black screen with no clue. The read
        // loop drains this and logs it (see below).
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        // Reap streamlink if this Child handle drops before the relay's
        // read loop takes ownership of it. Between spawn() here and that
        // hand-off there are several early returns - a failed probe read,
        // a zero-byte probe (an offline/just-ended stream, the common
        // case), a failed ffmpeg spawn - and tokio does NOT kill a child
        // on drop by default, so without this each of those orphans a
        // live streamlink process pulling the stream forever. Same class
        // of leak as the post-Stop one, on the startup error paths.
        .kill_on_drop(true);

    #[cfg(windows)]
    sl_cmd.creation_flags(CREATE_NO_WINDOW);

    augment_child_path(&mut sl_cmd);
    let mut sl_child = sl_cmd.spawn()?;
    let mut sl_stdout = sl_child
        .stdout
        .take()
        .expect("streamlink stdout not captured despite Stdio::piped()");
    // Take stderr so we can report WHY streamlink produced nothing. Spawn
    // a task to drain it concurrently with the stdout probe read below:
    // stderr must be drained even in the success path or a chatty
    // streamlink could fill the pipe buffer and block, and in the failure
    // path (probe_n == 0) its contents are exactly the diagnostic we want.
    let sl_stderr = sl_child.stderr.take();
    let stderr_handle = sl_stderr.map(|mut e| {
        tokio::spawn(async move {
            let mut buf = String::new();
            let _ = e.read_to_string(&mut buf).await;
            buf
        })
    });

    // Read up to one full pump-chunk to detect the container format.
    // Using a full 64 KB here means the probe bytes serve double-duty as
    // the first_chunk for the passthrough case (init_bytes seed + first
    // broadcast send), avoiding any extra read in start_relay.
    let mut probe = vec![0u8; 64 * 1024];
    let probe_n = sl_stdout.read(&mut probe).await?;
    if probe_n == 0 {
        // Streamlink opened its stdout but wrote nothing, then closed it.
        // Pull whatever it said on stderr so the error is actionable
        // (streamlink not finding its Python, a plugin failing to resolve
        // the stream, an auth problem) instead of a bare "no data".
        let detail = match stderr_handle {
            Some(h) => h.await.unwrap_or_default(),
            None => String::new(),
        };
        let detail = detail.trim();
        let msg = if detail.is_empty() {
            "streamlink closed its output without producing any data".to_string()
        } else {
            format!("streamlink produced no data. streamlink said: {detail}")
        };
        return Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, msg));
    }
    // Success path: don't leave the stderr drain task dangling. Detach it -
    // it finishes when streamlink eventually closes stderr, and the reaped
    // string is only needed on the failure path above.
    drop(stderr_handle);
    probe.truncate(probe_n);

    // MPEG-TS packets always start with sync byte 0x47. Everything else
    // (fMP4, ftyp box) starts with a 4-byte big-endian box size (first
    // byte 0x00 for any sane box < 16 MB). This single byte is enough
    // to reliably distinguish the two formats in practice.
    //
    // macOS override: WebKit (WKWebView, the engine on macOS) rejects
    // Twitch's raw passthrough fMP4 - confirmed via a friend's console
    // showing avc1.64002a decode as MEDIA_ERR_DECODE despite
    // isTypeSupported reporting true, then the SourceBuffer going invalid.
    // The same bytes decode fine in Chromium (WebView2 on Windows), so
    // this is a WebKit-vs-Chromium fMP4-strictness difference, not a codec
    // or dependency problem. Routing fMP4 through the SAME ffmpeg remux
    // that MPEG-TS uses re-writes it into a cleanly-structured fMP4 WebKit
    // accepts. `-c copy` keeps the identical codec - no re-encode, no
    // quality loss, negligible CPU - it just rebuilds the container boxes.
    // Only on macOS: on Windows/Linux passthrough works and is cheaper.
    #[cfg(target_os = "macos")]
    let force_remux = true;
    #[cfg(not(target_os = "macos"))]
    let force_remux = false;

    if probe[0] == 0x47 || force_remux {
        // MPEG-TS → ffmpeg remux, OR fMP4-on-macOS forced through remux.
        // No `empty_moov` here: ffmpeg probes the input stream first,
        // then writes a complete moov once it knows the codec parameters.
        // `frag_keyframe` + `default_base_moof` produce self-contained
        // fragments that MSE's SourceBuffer expects.
        let mut ff_cmd = Command::new(resolve_dep_path("ffmpeg"));
        ff_cmd
            .arg("-loglevel")
            .arg("error")
            .arg("-i")
            .arg("pipe:0")
            .arg("-c")
            .arg("copy")
            .arg("-f")
            .arg("mp4")
            .arg("-movflags")
            .arg("frag_keyframe+default_base_moof")
            .arg("pipe:1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // Same reasoning as streamlink above: reap ffmpeg on any
            // early return between here and the read loop owning it.
            .kill_on_drop(true);

        #[cfg(windows)]
        ff_cmd.creation_flags(CREATE_NO_WINDOW);

        augment_child_path(&mut ff_cmd);
        let mut ff_child = ff_cmd.spawn().map_err(|e| {
            std::io::Error::new(
                e.kind(),
                format!("Failed to launch ffmpeg (is it installed and on PATH?): {e}"),
            )
        })?;
        let mut ff_stdin = ff_child
            .stdin
            .take()
            .expect("ffmpeg stdin not captured despite Stdio::piped()");
        let ff_stdout = ff_child
            .stdout
            .take()
            .expect("ffmpeg stdout not captured despite Stdio::piped()");
        let ff_stderr = ff_child
            .stderr
            .take()
            .expect("ffmpeg stderr not captured despite Stdio::piped()");

        // Feed probe bytes (already read) + rest of streamlink's stdout
        // to ffmpeg's stdin in a background task.
        tauri::async_runtime::spawn(async move {
            let _ = ff_stdin.write_all(&probe).await;
            let _ = tokio::io::copy(&mut sl_stdout, &mut ff_stdin).await;
            // Dropping ff_stdin closes ffmpeg's stdin, causing ffmpeg to
            // flush its output and exit cleanly.
        });

        Ok(PipelineResult::FfmpegMediated {
            ff_child,
            ff_stdout,
            ff_stderr,
            sl_child,
        })
    } else {
        // Native fMP4 (or at least not MPEG-TS) – pass through directly.
        // The probe bytes are the first chunk; sl_stdout continues from
        // where the probe read left off.
        Ok(PipelineResult::Passthrough {
            first_chunk: probe,
            rest: sl_stdout,
            sl_child,
        })
    }
}

/// Reads `child`'s stdout in a loop, publishing each chunk read to
/// `chunk_tx` and keeping `state.cache` current so every late-subscribing
/// HTTP connection sees a contiguous byte range from stream byte 0.
///
/// ATOMICITY INVARIANT (same as before, now covering two cache tiers):
/// the cache write and the chunk_tx.send() for the same chunk both happen
/// while still holding state.cache's lock. handle_connection holds the
/// same lock across its (subscribe + snapshot) pair. So at any moment:
///
///   (a) If this loop holds the lock: the new subscriber will see this
///       chunk in the cache snapshot it takes once the lock is released,
///       and its broadcast subscription starts AFTER this send - so it
///       won't receive this chunk from broadcast (already snapshotted).
///
///   (b) If handle_connection holds the lock first: it subscribes before
///       this send, so it receives this chunk via broadcast; and its
///       cache snapshot doesn't include this chunk yet - no duplication.
///
/// Either ordering is consistent and gap-free.
async fn pump_stdout_to_broadcast(
    mut stdout: Box<dyn AsyncRead + Unpin + Send + 'static>,
    chunk_tx: broadcast::Sender<Arc<[u8]>>,
    state: Arc<StreamRelayState>,
    my_generation: u64,
) {
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        match stdout.read(&mut buf).await {
            Ok(0) => break, // EOF - stream ended or process exited
            Ok(n) => {
                let mut cache = state.cache.lock().await;
                // HTTP connections have always checked the generation;
                // the pump never did - and an OLD session's pump can
                // absolutely deliver one last pipe-buffered read after
                // the new session's cache reset (its process is killed,
                // but kill->EOF isn't instant). One stale chunk keeps
                // the tier accounting self-consistent while feeding the
                // fresh BoxWalker foreign bytes at wrong offsets -
                // after which every fragment offset the walker reports
                // is shifted, every trimmed join slices into mid-media
                // garbage, and the client shows the exact pair of
                // failures from the field log (demuxer waiting forever
                // on a garbage "box" of absurd declared size, or
                // RunSegmentParserLoop failure - which one depends on
                // what the misread bytes happen to say). Timing-
                // dependent via the kill/EOF race, hence "worked great,
                // then black screens" across sessions.
                if state.generation.load(Ordering::SeqCst) != my_generation {
                    eprintln!("[stream_relay] stale pump from a previous session tried to write after restart - stopping it");
                    break;
                }

                // Walk the boxes as they flow past (cheap - header
                // parses and body skips) so join-time trimming has
                // authoritative answers. Must happen before total_bytes
                // advances: the walker's absolute offsets are defined
                // by the pre-chunk total.
                let abs_base = cache.total_bytes;
                cache.walker.feed(&buf[..n], abs_base);
                cache.total_bytes += n as u64;

                if cache.init_bytes.len() < INIT_SEGMENT_CACHE_CAP {
                    // init_bytes still has room: fill it first.
                    let space = INIT_SEGMENT_CACHE_CAP - cache.init_bytes.len();
                    let init_take = space.min(n);
                    cache.init_bytes.extend_from_slice(&buf[..init_take]);

                    if init_take < n {
                        // This chunk straddles the init_bytes/overflow
                        // boundary. The remainder goes to overflow.
                        let remainder: Arc<[u8]> = Arc::from(&buf[init_take..n]);
                        evict_overflow_if_needed(&mut cache, remainder.len());
                        cache.overflow_byte_count += remainder.len();
                        cache.overflow.push_back(remainder);
                    }
                } else {
                    // init_bytes is full; the whole chunk goes to overflow.
                    let chunk_arc: Arc<[u8]> = Arc::from(&buf[..n]);
                    evict_overflow_if_needed(&mut cache, chunk_arc.len());
                    cache.overflow_byte_count += chunk_arc.len();
                    cache.overflow.push_back(chunk_arc);
                }

                // Still holding `cache`'s lock here, deliberately - see
                // the function doc comment above.
                //
                // Errors here just mean there are currently no
                // subscribers (e.g. between a channel switch and the new
                // HTTP request landing) - not fatal, the next chunk might
                // have a subscriber by then.
                let _ = chunk_tx.send(Arc::from(&buf[..n]));
            }
            Err(e) => {
                eprintln!("[stream_relay] stdout read error (stopping pump): {e}");
                break;
            }
        }
    }
}

/// Evicts the oldest overflow chunks until adding `incoming_bytes` more
/// would not exceed OVERFLOW_BUFFER_CAP. Called while the cache lock is
/// already held, before pushing a new chunk into overflow.
fn evict_overflow_if_needed(cache: &mut CachedStream, incoming_bytes: usize) {
    while cache.overflow_byte_count + incoming_bytes > OVERFLOW_BUFFER_CAP {
        match cache.overflow.pop_front() {
            Some(evicted) => {
                cache.overflow_byte_count -= evicted.len();
                // The cache is no longer contiguous from byte 0 - see
                // evicted_any's declaration for what this changes about
                // how new connections must be served.
                cache.evicted_any = true;
            }
            None => break,
        }
    }
}

/// Incremental top-level ISO-BMFF box walker, fed every byte the pump
/// produces (in order, under the cache lock). Exists to answer the two
/// questions a late joiner needs answered CORRECTLY, not guessed:
///
///   1. What init segment describes the newest fragments? Join-time
///      parsing took the SESSION-HEAD init (bytes 0..) and glued it to
///      the newest cached fragment - but streamlink pipelines restart
///      their output mid-session (Twitch ad transitions do this),
///      emitting a fresh ftyp+moov whose track configuration the old
///      moov doesn't describe. MSE then discards every appended frame
///      for the unknown tracks WITHOUT ERRORING - appendBuffer
///      succeeds, updateend fires, and buffered stays empty forever,
///      which is precisely the field log that motivated this walker
///      (PiP black screen, "buffered.length is 0" after megabytes of
///      successful appends, main window unaffected because it consumed
///      the mid-stream init in sequence).
///   2. Where does the newest fragment start? Tracked as an absolute
///      offset while the bytes flow past, instead of pattern-searching
///      16 MB of cache at join time.
///
/// The walker only ever parses 16-byte headers and skips box bodies, so
/// its cost is a few comparisons per chunk. If it ever desyncs
/// (nonsense size, size-0 "to end of file" box), it marks itself dead
/// and joiners fall back to the full contiguous payload - degraded,
/// never wrong.
struct BoxWalker {
    state: WalkState,
    /// Most recent COMPLETE init segment: ftyp through everything
    /// preceding the first moof that follows it. Updated wholesale when
    /// a mid-stream pipeline restart emits a new ftyp.
    latest_init: Vec<u8>,
    latest_init_complete: bool,
    /// Absolute stream offset of the newest fragment (moof) start.
    latest_frag_abs: Option<u64>,
    /// In-progress init capture; promoted to latest_init by the next moof.
    capture: Option<Vec<u8>>,
    dead: bool,
}

enum WalkState {
    /// Accumulating the (8- or 16-byte) header of the box starting at
    /// absolute offset `header_abs`.
    Header { header_abs: u64, have: Vec<u8> },
    /// Inside a box body with `remaining` bytes left; `capturing` says
    /// whether those bytes belong to an init segment being captured.
    Body { remaining: u64, capturing: bool },
}

/// Init captures larger than this abort (a sane ftyp+moov is a few KB;
/// megabytes means the walker latched onto something that isn't an init
/// segment, or an absurd stream - either way, stop hoarding memory).
const INIT_CAPTURE_CAP: usize = 2 * 1024 * 1024;

impl BoxWalker {
    fn new() -> Self {
        BoxWalker {
            state: WalkState::Header { header_abs: 0, have: Vec::new() },
            latest_init: Vec::new(),
            latest_init_complete: false,
            latest_frag_abs: None,
            capture: None,
            dead: false,
        }
    }

    /// Feeds the next `bytes` of the stream; `abs_base` is the absolute
    /// offset of bytes[0]. Handles headers straddling chunk boundaries
    /// (chunks are arbitrary stdout read sizes, so a 16-byte header
    /// split across two chunks is routine, not an edge case).
    fn feed(&mut self, bytes: &[u8], abs_base: u64) {
        if self.dead {
            return;
        }
        let mut i: usize = 0;
        while i < bytes.len() {
            match &mut self.state {
                WalkState::Header { header_abs, have } => {
                    let need = if have.len() >= 8
                        && u32::from_be_bytes([have[0], have[1], have[2], have[3]]) == 1
                    { 16 } else { 8 };
                    let take = (need - have.len()).min(bytes.len() - i);
                    have.extend_from_slice(&bytes[i..i + take]);
                    i += take;
                    // A just-completed 8-byte header may reveal size==1
                    // (64-bit largesize) and need 8 more; loop around.
                    let need = if have.len() >= 8
                        && u32::from_be_bytes([have[0], have[1], have[2], have[3]]) == 1
                    { 16 } else { 8 };
                    if have.len() < need {
                        continue; // header still straddling into the next chunk
                    }
                    let box_start = *header_abs;
                    let header = std::mem::take(have);
                    let Some((box_type, size)) = read_box_header(&header, 0) else {
                        eprintln!("[stream_relay] box walker desynced (unparseable header at {box_start}) - late-join trimming disabled for this session");
                        self.dead = true;
                        return;
                    };
                    if size < header.len() as u64 {
                        eprintln!("[stream_relay] box walker desynced (box size {size} at {box_start}) - late-join trimming disabled for this session");
                        self.dead = true;
                        return;
                    }
                    let mut capturing = false;
                    if &box_type == b"ftyp" {
                        // New init segment beginning (session start, or a
                        // mid-stream pipeline restart - see the struct doc).
                        self.capture = Some(header.clone());
                        capturing = true;
                    } else if &box_type == b"moof" {
                        if let Some(cap) = self.capture.take() {
                            self.latest_init = cap;
                            self.latest_init_complete = true;
                        }
                        self.latest_frag_abs = Some(box_start);
                    } else if let Some(cap) = self.capture.as_mut() {
                        cap.extend_from_slice(&header);
                        capturing = true;
                    }
                    self.state = WalkState::Body {
                        remaining: size - header.len() as u64,
                        capturing,
                    };
                }
                WalkState::Body { remaining, capturing } => {
                    let take = usize::try_from(*remaining)
                        .unwrap_or(usize::MAX)
                        .min(bytes.len() - i);
                    if *capturing {
                        if let Some(cap) = self.capture.as_mut() {
                            if cap.len() + take > INIT_CAPTURE_CAP {
                                eprintln!("[stream_relay] init-segment capture exceeded {INIT_CAPTURE_CAP} bytes - aborting capture");
                                self.capture = None;
                            } else {
                                cap.extend_from_slice(&bytes[i..i + take]);
                            }
                        }
                    }
                    *remaining -= take as u64;
                    i += take;
                    if *remaining == 0 {
                        self.state = WalkState::Header {
                            header_abs: abs_base + i as u64,
                            have: Vec::new(),
                        };
                    }
                }
            }
        }
    }
}

/// Reads a top-level ISO-BMFF box header at `offset` in `bytes`.
/// Returns (box_type, total_box_size) or None if there isn't a whole,
/// sane header there. Handles the 64-bit largesize form (size == 1)
/// since some pipelines emit it for large mdat boxes.
fn read_box_header(bytes: &[u8], offset: usize) -> Option<([u8; 4], u64)> {
    let header = bytes.get(offset..offset + 8)?;
    let size32 = u32::from_be_bytes(header[0..4].try_into().ok()?) as u64;
    let box_type: [u8; 4] = header[4..8].try_into().ok()?;
    let size = if size32 == 1 {
        let large = bytes.get(offset + 8..offset + 16)?;
        u64::from_be_bytes(large.try_into().ok()?)
    } else {
        size32
    };
    if size < 8 {
        return None; // size 0 = "to end of file", never valid mid-live-stream
    }
    Some((box_type, size))
}

/// Top-level box types that can legitimately appear in the fMP4 streams
/// this relay carries (streamlink remux output). Anything else at top
/// level means we're not looking at a real box boundary.
fn is_known_top_level_box(t: &[u8; 4]) -> bool {
    matches!(
        t,
        b"ftyp" | b"moov" | b"moof" | b"mdat" | b"styp" | b"sidx" | b"free" | b"skip"
            | b"prft" | b"emsg" | b"uuid" | b"mfra" | b"meta"
    )
}

/// Forward-walks top-level boxes starting at `start`, returning every
/// (offset, type) found, or None if the walk hits anything that isn't a
/// clean, known box chain. The final box may be truncated (its declared
/// size runs past the window end) - the window's tail is the live edge,
/// mid-box by nature - but every header that IS in the window must
/// parse as a known type with sizes linking exactly. This is what makes
/// join-time re-derivation safe where BoxWalker's docs call unvalidated
/// pattern-matching "actively dangerous": a false 4CC hit inside video
/// payload has no realistic chance of chaining valid known-type headers
/// through megabytes of window, so a chain that validates end-to-end IS
/// a real box boundary.
fn validate_box_chain(window: &[u8], start: usize) -> Option<Vec<(usize, [u8; 4])>> {
    let mut boxes: Vec<(usize, [u8; 4])> = Vec::new();
    let mut saw_moof = false;
    let mut off = start;
    while off < window.len() {
        if off + 8 > window.len() {
            break; // trailing partial header - live bytes will complete it
        }
        let (box_type, size) = read_box_header(window, off)?;
        if !is_known_top_level_box(&box_type) {
            return None;
        }
        if &box_type == b"moof" {
            saw_moof = true;
        }
        boxes.push((off, box_type));
        let next = off.checked_add(usize::try_from(size).ok()?)?;
        if next > window.len() {
            break; // truncated final box - expected at the live edge
        }
        off = next;
    }
    if saw_moof { Some(boxes) } else { None }
}

/// Join-time recovery when the pump's BoxWalker can't answer (desynced,
/// init capture never completed, or its offset math diverged from the
/// cache): re-derive a decodable (init, fragment start) directly from
/// the cached window. Returns (init_found_in_window, serve_offset):
///
///   - serve_offset is the NEWEST moof of the first validated box chain
///     (the same "latest fragment" semantics the walker path serves).
///   - init is Some only if the window itself contains a complete
///     ftyp..moof init segment (a mid-stream pipeline restart landed in
///     the cache) - the freshest possible truth, which the caller must
///     prefer over any session-head init that may no longer describe
///     these fragments.
fn derive_join_facts(window: &[u8]) -> Option<(Option<Vec<u8>>, usize)> {
    let mut p = 0usize;
    let chain = loop {
        if p + 8 > window.len() {
            return None;
        }
        let cc = &window[p + 4..p + 8];
        if cc == b"moof" || cc == b"ftyp" {
            if let Some(chain) = validate_box_chain(window, p) {
                break chain; // earliest candidate that validates wins
            }
        }
        p += 1;
    };
    // Newest complete init inside the window: the last ftyp that has a
    // moof after it (the moof both terminates the init capture and
    // proves the fragment sequence started).
    let mut init_range: Option<(usize, usize)> = None;
    for (idx, (off, t)) in chain.iter().enumerate() {
        if t == b"ftyp" {
            let rest = &chain[idx + 1..];
            if let Some(pos) = rest.iter().position(|(_, tt)| tt == b"moof") {
                // Only a moov-bearing init can configure a decoder; a
                // ftyp..moof span without one isn't an init segment.
                if rest[..pos].iter().any(|(_, tt)| tt == b"moov") {
                    init_range = Some((*off, rest[pos].0));
                }
            }
        }
    }
    let last_moof = chain.iter().rev().find(|(_, t)| t == b"moof")?.0;
    Some(match init_range {
        // Fragments after an in-window init must be served under THAT
        // init; last_moof is >= the init's first moof by construction,
        // .max() is belt-and-braces.
        Some((fs, fe)) => (Some(window[fs..fe].to_vec()), last_moof.max(fe)),
        None => (None, last_moof),
    })
}

/// Extracts the session-head init segment (ftyp through everything
/// before the first fragment) from the init_bytes tier. Used as the
/// last-resort init source when neither the window nor the walker has a
/// fresher one. None if the head doesn't start at ftyp or the init runs
/// past what the tier cached (both mean it can't be trusted).
fn extract_init_from_session_head(head: &[u8]) -> Option<Vec<u8>> {
    if head.len() < 8 || &head[4..8] != b"ftyp" {
        return None;
    }
    let mut saw_moov = false;
    let mut off = 0usize;
    while off + 8 <= head.len() {
        let (box_type, size) = read_box_header(head, off)?;
        if &box_type == b"moof" || &box_type == b"styp" {
            // First fragment reached - everything before it is the init,
            // but only a moov-bearing init can configure a decoder.
            return if saw_moov && off > 0 { Some(head[..off].to_vec()) } else { None };
        }
        if !is_known_top_level_box(&box_type) {
            return None;
        }
        if &box_type == b"moov" {
            saw_moov = true;
        }
        let next = off.checked_add(usize::try_from(size).ok()?)?;
        if next > head.len() {
            // This box is cut by the tier cap. The COMPLETE boxes before
            // it are all init boxes (no moof seen yet) - a valid init if
            // moov is among them.
            return if saw_moov && off > 0 { Some(head[..off].to_vec()) } else { None };
        }
        off = next;
    }
    // Ran out of the head exactly at a box boundary (or with a partial
    // trailing header) without meeting a fragment: same reasoning.
    if saw_moov && off > 0 { Some(head[..off].to_vec()) } else { None }
}

/// How long to wait for streamlink to either produce its first byte of
/// output or exit on its own, before giving up and returning a timeout
/// error. Generous enough to cover a normal "resolve playback token +
/// start receiving the live edge" startup (a few seconds in practice),
/// without leaving the frontend's Watch button looking like it's doing
/// nothing for an unreasonable length of time if something is
/// genuinely stuck rather than just slow.
const STARTUP_TIMEOUT_SECONDS: u64 = 15;

/// Races reading the first chunk of `stdout` against `child` exiting on
/// its own, with an overall timeout - this is what turns a streamlink
/// failure that happens AFTER start_relay would otherwise have already
/// returned success (wrong quality, channel went offline between the
/// Helix check and here, any other Twitch-plugin-side error) into a
/// real error message instead of a relay URL that just silently never
/// produces any bytes.
///
/// On success, returns the first chunk read (which the caller must not
/// drop - it has to be the first thing fed to the broadcast channel/init
/// cache, or that data is lost) along with the still-open stdout handle
/// to keep reading from.
async fn wait_for_first_chunk_or_exit(
    child: &mut Child,
    mut stdout: tokio::process::ChildStdout,
    mut stderr: tokio::process::ChildStderr,
) -> Result<(Vec<u8>, tokio::process::ChildStdout), String> {
    let mut buf = vec![0u8; 64 * 1024];
    let timeout_sleep = tokio::time::sleep(std::time::Duration::from_secs(STARTUP_TIMEOUT_SECONDS));

    let select_result: Result<Vec<u8>, String> = tokio::select! {
        read_result = stdout.read(&mut buf) => {
            match read_result {
                Ok(0) => Err("pipeline closed its output without producing any data".to_string()),
                Ok(n) => Ok(buf[..n].to_vec()),
                Err(e) => Err(format!("Failed to read pipeline output: {e}")),
            }
        }
        wait_result = child.wait() => {
            // The process exited before ever producing output -
            // whatever it printed to stderr is almost certainly
            // the actual reason (e.g. "error: No playable streams
            // found on this URL", "error: Unable to open URL",
            // an invalid-quality message, etc.).
            let mut stderr_output = String::new();
            let _ = stderr.read_to_string(&mut stderr_output).await;
            let status_desc = match wait_result {
                Ok(status) => format!("exited with {status}"),
                Err(e) => format!("wait() failed: {e}"),
            };
            if stderr_output.trim().is_empty() {
                Err(format!("pipeline (ffmpeg) {status_desc} before producing any output"))
            } else {
                Err(format!("pipeline (ffmpeg) {status_desc}: {}", stderr_output.trim()))
            }
        }
        _ = timeout_sleep => {
            Err(format!(
                "Timed out after {STARTUP_TIMEOUT_SECONDS}s waiting for the stream pipeline to start producing output"
            ))
        }
    };

    match select_result {
        Ok(first_chunk) => Ok((first_chunk, stdout)),
        Err(e) => Err(e),
    }
}

/// Starts (or restarts) the relay for `target_url`, returning the local
/// HTTP URL the frontend should point its <video>/MSE feeder at.
///
/// Idempotent with respect to the HTTP server: the first call binds a
/// fresh ephemeral port and spawns the accept-loop task; subsequent calls
/// (channel switches) reuse that same port/server and just swap out which
/// streamlink process + broadcast channel is currently "live", bumping
/// `generation` so old connections know to stop.
pub async fn start_relay(
    state: Arc<StreamRelayState>,
    target_url: String,
    quality: String,
    extra_args: Vec<String>,
) -> Result<String, String> {
    // Claim a ticket the instant we're called, BEFORE contending for the
    // lock. If another start_relay is claimed after this, our ticket is no
    // longer the newest and we're stale - checked after spawning below.
    let my_ticket = state.start_requests.fetch_add(1, Ordering::SeqCst) + 1;

    // Serialize the whole stop+spawn+store critical section. Without this,
    // two rapid channel switches interleave: an older call's
    // stop_current_stream can run after a newer call already stored its
    // pipeline, killing the newer relay - whose client then hits EOF,
    // reports "relay stream ended", and the frontend fails over to Kick.
    // (This is exactly the "switch fast, last stream fails over" bug.)
    let _start_guard = state.start_lock.lock().await;

    // If a newer start_relay claimed a ticket while we waited for the
    // lock, don't even bother spawning - the newer one owns the session.
    if state.start_requests.load(Ordering::SeqCst) != my_ticket {
        return Err("superseded by a newer stream start".to_string());
    }

    // Stop whatever was running before - same reasoning as the old
    // start_stream's "already running" guard avoidance: switching
    // channels while one is active must not leave the previous
    // streamlink process running alongside the new one.
    stop_current_stream(&state).await;

    let pipeline = spawn_pipeline(&target_url, &quality, &extra_args)
        .await
        .map_err(|e| format!("Failed to launch stream pipeline: {e}"))?;

    // Resolve the pipeline into (first_chunk, fmp4_stream, children).
    // For native fMP4 (Passthrough), the probe bytes are already the first
    // chunk and we skip the wait step entirely.
    // For MPEG-TS (FfmpegMediated), we race a read of ffmpeg's stdout
    // against ffmpeg exiting to detect startup failures early.
    let (first_chunk, fmp4_stream, mut pipeline_children) = match pipeline {
        PipelineResult::Passthrough { first_chunk, rest, sl_child } => {
            let stream: Box<dyn AsyncRead + Unpin + Send + 'static> = Box::new(rest);
            (first_chunk, stream, vec![sl_child])
        }
        PipelineResult::FfmpegMediated { mut ff_child, ff_stdout, ff_stderr, sl_child } => {
            let (first_chunk, rest_stdout) =
                match wait_for_first_chunk_or_exit(&mut ff_child, ff_stdout, ff_stderr).await {
                    Ok(result) => result,
                    Err(e) => {
                        let _ = ff_child.kill().await;
                        return Err(e);
                    }
                };
            let stream: Box<dyn AsyncRead + Unpin + Send + 'static> = Box::new(rest_stdout);
            (first_chunk, stream, vec![ff_child, sl_child])
        }
    };

    // Spawning took real time (streamlink launch + first-chunk wait). If a
    // newer start_relay claimed its ticket meanwhile, WE are stale: storing
    // our children/chunk_tx now would make us the "current" relay over the
    // newer one, and our later stop_current_stream (or the newer call's)
    // would then kill whichever pipeline the user actually wants. Kill our
    // own just-spawned processes and abort instead. (kill_on_drop would
    // reap them anyway, but do it explicitly and promptly.)
    if state.start_requests.load(Ordering::SeqCst) != my_ticket {
        for mut child in pipeline_children.drain(..) {
            let _ = child.kill().await;
        }
        return Err("superseded by a newer stream start".to_string());
    }

    let (chunk_tx, _initial_rx) = broadcast::channel(CHUNK_BUFFER_CAPACITY);

    {
        let mut guard = state.children.lock().await;
        *guard = pipeline_children;
    }
    {
        let mut guard = state.chunk_tx.lock().await;
        *guard = Some(chunk_tx.clone());
    }
    {
        // Fresh stream, fresh cache - clear both tiers and seed init_bytes
        // with the first chunk we already read above (see
        // pump_stdout_to_broadcast's call below, which resumes reading
        // AFTER this chunk - it must not be read twice, and must not be
        // dropped, since it very likely contains the fMP4 init segment).
        let mut cache = state.cache.lock().await;
        cache.init_bytes.clear();
        cache.init_bytes.extend_from_slice(&first_chunk);
        cache.overflow.clear();
        cache.overflow_byte_count = 0;
        // Fresh session, fresh contiguity - see evicted_any's declaration.
        cache.evicted_any = false;
        cache.total_bytes = first_chunk.len() as u64;
        cache.walker = BoxWalker::new();
        cache.walker.feed(&first_chunk, 0);
    }
    state.generation.fetch_add(1, Ordering::SeqCst);
    // The first chunk's bytes need a subscriber-visible path too, same
    // as every later chunk gets via pump_stdout_to_broadcast - sending it
    // here, before any HTTP connection could possibly have subscribed
    // yet, is fine precisely because handle_connection's snapshot-then-
    // subscribe sequence (see its doc comment) reads init_cache under the
    // same lock this chunk was just written under, so it'll see this
    // chunk in its snapshot regardless of subscribing before or after
    // this particular send.
    let _ = chunk_tx.send(Arc::from(first_chunk.as_slice()));

    // Generation captured synchronously AFTER this session's bump, so
    // the guard inside the pump is exact even if the task's first poll
    // is delayed.
    let pump_generation = state.generation.load(Ordering::SeqCst);
    tauri::async_runtime::spawn(pump_stdout_to_broadcast(fmp4_stream, chunk_tx, state.clone(), pump_generation));

    // First call: bind the HTTP server and start accepting connections.
    // Reading port with a SeqCst load/compare-exchange-style check avoids
    // accidentally binding a second listener if this is somehow called
    // twice concurrently before the first bind finishes.
    ensure_listener_running(&state).await?;

    let port = state.port.load(Ordering::SeqCst);
    Ok(format!("http://127.0.0.1:{port}/stream"))
}

/// Binds the hls-proxy / relay HTTP listener if it isn't already running
/// (i.e. if state.port is still 0). Called from both start_relay (for live
/// streams) and get_vod_m3u8_url (for VODs) - without this, watching a VOD
/// on a fresh launch where no live stream was ever started leaves port=0 and
/// makes the proxy URL unusable (black screen).
async fn ensure_listener_running(state: &Arc<StreamRelayState>) -> Result<(), String> {
    if state.port.load(Ordering::SeqCst) == 0 {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| format!("Failed to bind local relay server: {e}"))?;
        let bound_port = listener
            .local_addr()
            .map_err(|e| e.to_string())?
            .port();
        state.port.store(bound_port, Ordering::SeqCst);

        let accept_state = state.clone();
        tauri::async_runtime::spawn(async move {
            run_accept_loop(listener, accept_state).await;
        });
    }
    Ok(())
}

/// Accepts incoming connections forever, spawning a handler task for each.
/// Runs for the lifetime of the app once started - see start_relay's
/// "first call binds, later calls reuse" comment for why this only ever
/// starts once despite start_relay being called on every channel switch.
// ---------------------------------------------------------------------------
// HLS proxy — fetches Twitch CDN URLs with CORS headers so HLS.js can work
// ---------------------------------------------------------------------------

/// Percent-encodes a string for use as a URL query-parameter value.
fn pct_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9'
            | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => {
                out.push('%');
                out.push(char::from_digit((b >> 4) as u32, 16).unwrap().to_ascii_uppercase());
                out.push(char::from_digit((b & 0xf) as u32, 16).unwrap().to_ascii_uppercase());
            }
        }
    }
    out
}

/// Decodes a percent-encoded query-parameter value.
fn pct_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = String::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let h = char::from(bytes[i + 1]).to_digit(16);
            let l = char::from(bytes[i + 2]).to_digit(16);
            if let (Some(h), Some(l)) = (h, l) {
                out.push(((h * 16 + l) as u8) as char);
                i += 3;
                continue;
            }
        }
        out.push(if bytes[i] == b'+' { ' ' } else { bytes[i] as char });
        i += 1;
    }
    out
}

/// Returns everything up to and including the last `/` of a URL (the base
/// directory), used to resolve relative segment paths in an M3U8 playlist.
fn m3u8_base(url: &str) -> &str {
    url.rfind('/').map(|i| &url[..=i]).unwrap_or(url)
}

/// Rewrites every URI in an M3U8 playlist to go through the local proxy.
/// Handles:
///  - Bare segment lines (relative or absolute paths)
///  - `#EXT-X-MAP:URI="…"` init-segment attributes
fn rewrite_m3u8(content: &str, base_url: &str, proxy_base: &str) -> String {
    let mut out = String::with_capacity(content.len() * 2);
    for line in content.lines() {
        let t = line.trim();
        if t.is_empty() {
            out.push('\n');
        } else if !t.starts_with('#') {
            // Media segment (relative or absolute URL)
            let abs = if t.starts_with("http") {
                t.to_owned()
            } else {
                format!("{base_url}{t}")
            };
            out.push_str(&format!("{proxy_base}/hls-proxy?url={}\n", pct_encode(&abs)));
        } else if t.starts_with("#EXT-X-MAP:") {
            // Init-segment reference — rewrite URI="…" inside the tag
            out.push_str(&rewrite_tag_uri(t, base_url, proxy_base));
            out.push('\n');
        } else {
            out.push_str(line);
            out.push('\n');
        }
    }
    out
}

/// Rewrites the `URI="…"` attribute inside an HLS tag line (e.g. EXT-X-MAP).
fn rewrite_tag_uri(tag: &str, base_url: &str, proxy_base: &str) -> String {
    const MARK: &str = "URI=\"";
    if let Some(s) = tag.find(MARK) {
        let uri_start = s + MARK.len();
        if let Some(uri_len) = tag[uri_start..].find('"') {
            let uri = &tag[uri_start..uri_start + uri_len];
            let abs = if uri.starts_with("http") {
                uri.to_owned()
            } else {
                format!("{base_url}{uri}")
            };
            let proxied = format!("{proxy_base}/hls-proxy?url={}", pct_encode(&abs));
            return format!(
                "{}URI=\"{}\"{}",
                &tag[..s],
                proxied,
                &tag[uri_start + uri_len + 1..]
            );
        }
    }
    tag.to_owned()
}

/// Max attempts for the upstream CDN fetch below, and the backoff between
/// them. This targets a real, observed failure mode: some VOD/segment CDN
/// edges intermittently fail to connect (DNS hiccup, a slow/flaky edge,
/// connection reset) - reqwest's send() returns Err outright in that case,
/// which is categorically different from the CDN actually responding with
/// an error status (e.g. a real 403). A connection-level failure is
/// exactly what manifests in the browser as a bare CORS rejection with no
/// underlying HTTP status to show, because the old code's error path
/// returned a response with no Access-Control-Allow-Origin header at all
/// (the one below now always includes it - see handle_hls_proxy) - and
/// it's also exactly the kind of thing a quick retry fixes, matching the
/// reported "switching to a different VOD and back made it start working"
/// behavior far better than a fixed permission/access-restriction
/// explanation would (that wouldn't be intermittent, and would always
/// reproduce on the same VOD). A genuine non-2xx HTTP response (the CDN
/// actually answering with e.g. 403) is NOT retried here - retrying that
/// would just slow down a real error for no benefit - only the connection
/// itself failing to complete is.
const HLS_PROXY_MAX_ATTEMPTS: u32 = 3;
const HLS_PROXY_RETRY_DELAY_MS: u64 = 250;
/// Generous but bounded - VOD manifest/segment fetches should complete
/// well under this on any working connection; a request hung this long is
/// failing, not just slow, and should free up the attempt for a retry
/// rather than leave the browser's own (unpredictable, often much longer)
/// XHR timeout to be the only thing that ever gives up.
const HLS_PROXY_TIMEOUT_SECS: u64 = 15;

/// Handles a `GET /hls-proxy?url=ENCODED_URL` request. Fetches the target
/// from Twitch's CDN and returns it with `Access-Control-Allow-Origin: *`.
/// For M3U8 playlists, all segment/map URIs are rewritten through this proxy
/// so subsequent segment fetches from HLS.js also go through localhost.
async fn handle_hls_proxy(
    socket: &mut tokio::net::TcpStream,
    state: &Arc<StreamRelayState>,
    path: &str,
) -> std::io::Result<()> {
    // Extract ?url= query parameter
    let raw_url = path.split('?').nth(1)
        .and_then(|q| q.split('&').find(|p| p.starts_with("url=")))
        .map(|p| pct_decode(&p[4..]))
        .unwrap_or_default();

    if raw_url.is_empty() || !raw_url.starts_with("http") {
        // Every error response below includes the CORS header, even this
        // one - a 400 with no Access-Control-Allow-Origin would surface
        // in the browser as a CORS policy violation, masking what's
        // actually a 400, the same confusing-symptom problem this whole
        // function's error paths had for every other status before this.
        let resp = b"HTTP/1.1 400 Bad Request\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: 0\r\n\r\n";
        socket.write_all(resp).await?;
        return Ok(());
    }

    let port = state.port.load(Ordering::Relaxed);
    let proxy_base = format!("http://127.0.0.1:{port}");

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(HLS_PROXY_TIMEOUT_SECS))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[hls-proxy] failed to build HTTP client: {e}");
            let resp = b"HTTP/1.1 500 Internal Server Error\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: 0\r\n\r\n";
            socket.write_all(resp).await?;
            return Ok(());
        }
    };

    let mut last_err: Option<reqwest::Error> = None;
    let mut response = None;
    for attempt in 1..=HLS_PROXY_MAX_ATTEMPTS {
        let fetch = client
            .get(&raw_url)
            // Pass headers that Twitch's CDN expects from a browser player.
            .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
            .header("Origin", "https://player.twitch.tv")
            .header("Referer", "https://player.twitch.tv/")
            .send()
            .await;

        match fetch {
            Ok(r) => {
                response = Some(r);
                break;
            }
            Err(e) => {
                eprintln!(
                    "[hls-proxy] fetch attempt {attempt}/{HLS_PROXY_MAX_ATTEMPTS} \
                     failed for {raw_url}: {e}"
                );
                last_err = Some(e);
                if attempt < HLS_PROXY_MAX_ATTEMPTS {
                    tokio::time::sleep(std::time::Duration::from_millis(
                        HLS_PROXY_RETRY_DELAY_MS,
                    ))
                    .await;
                }
            }
        }
    }

    let response = match response {
        Some(r) => r,
        None => {
            eprintln!(
                "[hls-proxy] all {HLS_PROXY_MAX_ATTEMPTS} attempts failed for {raw_url}: \
                 {}",
                last_err.map(|e| e.to_string()).unwrap_or_default()
            );
            let resp = b"HTTP/1.1 502 Bad Gateway\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: 0\r\n\r\n";
            socket.write_all(resp).await?;
            return Ok(());
        }
    };

    // The CDN responded, but not successfully (e.g. a real 403/404) - this
    // is NOT retried (see HLS_PROXY_MAX_ATTEMPTS' comment), but it IS a
    // meaningfully different failure than the connection-level one above,
    // so it gets its own status passed through rather than being flattened
    // into a generic 502 - lets the browser console show the real status
    // instead of every kind of failure looking identical.
    if !response.status().is_success() {
        let status = response.status();
        eprintln!("[hls-proxy] upstream returned {status} for {raw_url}");
        let resp = format!(
            "HTTP/1.1 {} {}\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: 0\r\n\r\n",
            status.as_u16(),
            status.canonical_reason().unwrap_or("Error"),
        );
        socket.write_all(resp.as_bytes()).await?;
        return Ok(());
    }

    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_owned();

    let is_playlist = raw_url.contains(".m3u8")
        || content_type.contains("mpegURL")
        || content_type.contains("m3u8");

    let body_bytes = match response.bytes().await {
        Ok(b) => b,
        Err(e) => {
            eprintln!("[hls-proxy] body error: {e}");
            let resp = b"HTTP/1.1 502 Bad Gateway\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: 0\r\n\r\n";
            socket.write_all(resp).await?;
            return Ok(());
        }
    };

    let (out_type, out_body): (&str, Vec<u8>) = if is_playlist {
        let text = String::from_utf8_lossy(&body_bytes);
        let base = m3u8_base(&raw_url);
        let rewritten = rewrite_m3u8(&text, base, &proxy_base);
        ("application/x-mpegURL; charset=utf-8", rewritten.into_bytes())
    } else {
        // Segment file — pass through as-is.
        ("video/mp4", body_bytes.to_vec())
    };

    let header = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {out_type}\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        out_body.len()
    );
    socket.write_all(header.as_bytes()).await?;
    socket.write_all(&out_body).await?;
    Ok(())
}

async fn run_accept_loop(listener: TcpListener, state: Arc<StreamRelayState>) {
    loop {
        match listener.accept().await {
            Ok((socket, _addr)) => {
                let state = state.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = handle_connection(socket, state).await;
                });
            }
            Err(e) => {
                eprintln!("[stream_relay] accept() error: {e}");
            }
        }
    }
}

/// Serves one HTTP connection: sends a minimal chunked-transfer-encoding
/// response header, then forwards every broadcast chunk it receives as an
/// HTTP chunk, until the underlying streamlink process's generation
/// changes (channel switch) or the socket write fails (client
/// disconnected/navigated away).
///
/// This is a deliberately minimal hand-rolled HTTP/1.1 response - no
/// request parsing beyond "a connection arrived," no routing, since the
/// only thing ever fetched from this server is this one continuous
/// stream endpoint. Pulling in a full HTTP framework (axum/hyper) for
/// exactly one endpoint that never needs request routing, headers
/// inspection, or anything else a framework provides would be a lot of
/// dependency weight for nothing it'd actually use.
async fn handle_connection(
    mut socket: TcpStream,
    state: Arc<StreamRelayState>,
) -> std::io::Result<()> {
    // Read the HTTP request to determine which handler to use.
    // (Previously this was a discard; now we need the path.)
    let mut req_buf = [0u8; 8192];
    let n = socket.read(&mut req_buf).await.unwrap_or(0);
    let req_str = std::str::from_utf8(&req_buf[..n]).unwrap_or("");
    let path = req_str.lines().next()
        .and_then(|l| l.split_whitespace().nth(1))
        .unwrap_or("/stream");

    // Route: /hls-proxy?url=… proxies a Twitch CDN request with CORS headers.
    // All other paths fall through to the existing stream relay.
    if path.starts_with("/hls-proxy") {
        return handle_hls_proxy(&mut socket, &state, path).await;
    }

    let my_generation = state.generation.load(Ordering::SeqCst);

    // Subscribe to the broadcast channel AND snapshot both cache tiers
    // (init_bytes + overflow) while holding the cache lock. This is the
    // same atomicity guarantee as before, now covering both tiers:
    // pump_stdout holds the same lock while sending each chunk, so the
    // subscription point is guaranteed to be exactly contiguous with the
    // end of the overflow snapshot — no byte is missed, and no byte is
    // sent twice.
    let (mut rx, init_bytes, overflow_chunks, cache_has_gap, walker_facts, walker_fallback_init) = {
        let tx_guard = state.chunk_tx.lock().await;
        let tx = match tx_guard.as_ref() {
            Some(tx) => tx,
            None => {
                // Nothing has ever started streaming yet - respond with a
                // plain 503 rather than hanging the connection forever.
                let _ = socket
                    .write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n")
                    .await;
                return Ok(());
            }
        };
        let cache_guard = state.cache.lock().await;
        let init_bytes = cache_guard.init_bytes.clone();
        let overflow_chunks: Vec<Arc<[u8]>> = cache_guard.overflow.iter().cloned().collect();
        let walker_facts = if cache_guard.walker.dead || !cache_guard.walker.latest_init_complete {
            None
        } else {
            cache_guard.walker.latest_frag_abs.map(|frag_abs| {
                (cache_guard.walker.latest_init.clone(), frag_abs, cache_guard.total_bytes)
            })
        };
        // Snapshotted separately from walker_facts: even when the frag
        // OFFSET is unusable (evicted, or the offset math diverged), a
        // complete latest_init is still the best record of the current
        // decoder config - the re-derivation path below pairs it with a
        // boundary it finds on its own.
        let walker_fallback_init = if !cache_guard.walker.dead && cache_guard.walker.latest_init_complete {
            Some(cache_guard.walker.latest_init.clone())
        } else {
            None
        };
        (tx.subscribe(), init_bytes, overflow_chunks, cache_guard.evicted_any, walker_facts, walker_fallback_init)
    };


    // Decide the catch-up bytes this connection gets before going live.
    // Contiguous cache (first connection, or joining within the overflow
    // window): init_bytes + overflow verbatim. Gapped cache (a late joiner,
    // e.g. PiP opening mid-session): init + post-eviction overflow has a hole
    // that decodes to a black screen, so rebuild from the true init segment
    // plus cached data at a validated moof boundary; fall back to the
    // contiguous payload if a parse fails.
    let overflow_total: usize = overflow_chunks.iter().map(|c| c.len()).sum();
    let want_trim = cache_has_gap || overflow_total > SNAPSHOT_TAIL_TRIM_THRESHOLD;
    // Three tiers, most-trusted first:
    //   1. Walker-aligned: latest init + newest fragment from the box walker.
    //   2. Re-derived: when the walker can't answer, re-derive the boundary
    //      from the cached bytes via validate_box_chain (init from the window,
    //      the walker's latest, or the session head).
    //   3. Full contiguous payload - only when the cache is truly contiguous;
    //      a gapped stream is the CHUNK_DEMUXER_ERROR_APPEND_FAILED poison. If
    //      gapped and underivable, refuse with a 503 so the client retries
    //      against a fresher cache.
    let decided: Option<(Vec<u8>, Vec<Arc<[u8]>>, String)> = if want_trim {
        // Flattened once; both the walker-aligned path and the
        // re-derivation recovery index into the same window.
        // overflow[0] sits at absolute offset total_bytes - overflow_total.
        let flat: Vec<u8> = overflow_chunks.iter().flat_map(|c| c.iter().copied()).collect();
        let aligned = walker_facts.and_then(|(latest_init, frag_abs, total_bytes)| {
            let overflow_start_abs = total_bytes - overflow_total as u64;
            if frag_abs < overflow_start_abs {
                return None; // newest fragment already evicted (huge fragment or tiny cache)
            }
            let window_off = usize::try_from(frag_abs - overflow_start_abs).ok()?;
            if window_off >= flat.len() {
                return None;
            }
            // Self-check: the walker SAYS this offset is a moof; a
            // fragment start that isn't one means the walker's
            // world-model has diverged from the cache contents (e.g.
            // the stale-pump corruption fixed in
            // pump_stdout_to_broadcast) - hand over to re-derivation.
            let tail = &flat[window_off..];
            if tail.len() >= 8 && &tail[4..8] == b"moof" {
                Some((latest_init, window_off))
            } else {
                eprintln!(
                    "[stream_relay] walker-aligned offset isn't a moof (head {:02x?}) - re-deriving from cache",
                    &tail[..12.min(tail.len())]
                );
                None
            }
        });
        match aligned {
            Some((init_seg, window_off)) => {
                let note = format!(
                    "trimmed({}); init={}B tail={}B discarded={}B",
                    if cache_has_gap { "gap" } else { "large" },
                    init_seg.len(), flat.len() - window_off, window_off
                );
                Some((init_seg, vec![Arc::from(&flat[window_off..])], note))
            }
            None => match derive_join_facts(&flat) {
                Some((window_init, window_off)) => {
                    let (init_src, init_seg) = match window_init {
                        Some(seg) => ("window", Some(seg)),
                        None => match walker_fallback_init {
                            Some(seg) => ("walker", Some(seg)),
                            None => ("session-head", extract_init_from_session_head(&init_bytes)),
                        },
                    };
                    match init_seg {
                        Some(init_seg) => {
                            let note = format!(
                                "rederived({}); init[{}]={}B tail={}B discarded={}B",
                                if cache_has_gap { "gap" } else { "large" },
                                init_src, init_seg.len(), flat.len() - window_off, window_off
                            );
                            Some((init_seg, vec![Arc::from(&flat[window_off..])], note))
                        }
                        // Boundary found but no init segment from any
                        // source - undecodable either way.
                        None if cache_has_gap => None,
                        None => Some((
                            init_bytes.clone(), overflow_chunks.clone(),
                            format!("full-contiguous(no-init-derivable); overflow={overflow_total}B"),
                        )),
                    }
                }
                // No validated boundary in the window at all. Contiguous
                // cache: the full payload is valid, just big - serve it.
                // Gapped cache: refuse rather than poison.
                None if cache_has_gap => None,
                None => Some((
                    init_bytes.clone(), overflow_chunks.clone(),
                    format!("full-contiguous(underivable); overflow={overflow_total}B"),
                )),
            },
        }
    } else {
        Some((
            init_bytes.clone(), overflow_chunks.clone(),
            format!("full-contiguous; init={}B overflow={}B", init_bytes.len(), overflow_total),
        ))
    };
    let (first_payload, second_payload, snapshot_note): (Vec<u8>, Vec<Arc<[u8]>>, String) = match decided {
        Some(t) => t,
        None => {
            eprintln!(
                "[stream_relay] gapped cache and no decodable join payload derivable - refusing with 503 so the client retries against a fresher cache"
            );
            let _ = socket
                .write_all(b"HTTP/1.1 503 Service Unavailable\r\nRetry-After: 1\r\nContent-Length: 0\r\n\r\n")
                .await;
            return Ok(());
        }
    };
    eprintln!("[stream_relay] joiner snapshot: {snapshot_note}");

    // Written only now, because the snapshot decision above rides along
    // as a diagnostic header: the PiP window's console prints it (see
    // stream-player.js), so black-screen reports carry the relay's own
    // account of what it served without needing terminal access.
    let header = format!(concat!(
        "HTTP/1.1 200 OK\r\n",
        "Content-Type: video/mp4\r\n",
        "Cache-Control: no-store\r\n",
        "Access-Control-Allow-Origin: *\r\n",
        "Access-Control-Expose-Headers: X-Relay-Snapshot\r\n",
        "X-Relay-Snapshot: {}\r\n",
        "Transfer-Encoding: chunked\r\n",
        "Connection: close\r\n",
        "\r\n",
    ), snapshot_note.replace(['\r', '\n'], " "));
    socket.write_all(header.as_bytes()).await?;

    // Send the head payload as one HTTP chunk.
    if !first_payload.is_empty() {
        let size_line = format!("{:x}\r\n", first_payload.len());
        socket.write_all(size_line.as_bytes()).await?;
        socket.write_all(&first_payload).await?;
        socket.write_all(b"\r\n").await?;
    }

    // Send the catch-up chunks (contiguous mode: bytes
    // INIT_SEGMENT_CACHE_CAP..subscription_point; gapped mode: the
    // single fragment-aligned slice) before switching to the live
    // broadcast. In both modes the subscription point is exactly
    // contiguous with the end of this data (the snapshot + subscribe
    // pair is atomic - see above), so the SourceBuffer receives a
    // gap-free fMP4 byte stream from its very first box onward.
    for chunk in &second_payload {
        let size_line = format!("{:x}\r\n", chunk.len());
        if socket.write_all(size_line.as_bytes()).await.is_err() {
            let _ = socket.write_all(b"0\r\n\r\n").await;
            return Ok(());
        }
        if socket.write_all(chunk).await.is_err() {
            let _ = socket.write_all(b"0\r\n\r\n").await;
            return Ok(());
        }
        if socket.write_all(b"\r\n").await.is_err() {
            let _ = socket.write_all(b"0\r\n\r\n").await;
            return Ok(());
        }
    }

    loop {
        // A channel switch bumped the generation counter - this
        // connection belongs to a now-stale stream and should stop
        // rather than keep forwarding (now-wrong) bytes from whatever
        // process happens to currently hold chunk_tx.
        if state.generation.load(Ordering::SeqCst) != my_generation {
            break;
        }

        match rx.recv().await {
            Ok(chunk) => {
                let size_line = format!("{:x}\r\n", chunk.len());
                if socket.write_all(size_line.as_bytes()).await.is_err() {
                    break;
                }
                if socket.write_all(&chunk).await.is_err() {
                    break;
                }
                if socket.write_all(b"\r\n").await.is_err() {
                    break;
                }
            }
            // Lagged: this connection fell behind the broadcast buffer's
            // capacity. The old handling here was `continue` ("losing a
            // little buffered history is far less disruptive than
            // dropping the connection") - which is exactly wrong for
            // this data: resuming from wherever the channel skips to
            // splices a BYTE GAP into the middle of an fMP4 stream, and
            // a non-contiguous byte stream poisons the client's chunk
            // demuxer (CHUNK_DEMUXER_ERROR_APPEND_FAILED - the same
            // failure mode CachedStream's docs describe), after which
            // the video plays out its buffer and freezes forever.
            // Confirmed in the field via the PiP window, which is
            // practically designed to lag on open: it subscribes, then
            // boots an entire webview and ingests the multi-MB catch-up
            // snapshot while live chunks pile into its queue.
            // Terminating instead is the CLEAN recovery: both windows
            // auto-reattach, and the fragment-aligned late-join path
            // hands the reconnect a decodable stream. Never corrupt a
            // stream you could instead end honestly.
            Err(broadcast::error::RecvError::Lagged(skipped)) => {
                eprintln!("[stream_relay] subscriber lagged by {skipped} chunks - closing its connection so it can rejoin cleanly");
                break;
            }
            Err(broadcast::error::RecvError::Closed) => break,
        }
    }

    // Best-effort final chunk terminator - ignore errors, the client may
    // already be gone by this point.
    let _ = socket.write_all(b"0\r\n\r\n").await;
    Ok(())
}

/// Asks streamlink to resolve a VOD's authenticated CDN playlist URL
/// without downloading anything, then wraps it in the local HLS proxy so
/// HLS.js can fetch playlists and segments through localhost (bypassing
/// Twitch's missing CORS headers on their CDN).
#[tauri::command]
pub async fn get_vod_m3u8_url(
    video_id: String,
    quality: String,
    state: tauri::State<'_, Arc<StreamRelayState>>,
) -> Result<String, String> {
    let target = format!("https://www.twitch.tv/videos/{video_id}");
    let mut cmd = Command::new(resolve_streamlink_path());
    cmd.arg(&target)
        .arg(&quality)
        .arg("--stream-url")
        .arg("--twitch-disable-ads")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());

    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    augment_child_path(&mut cmd);
    let output = cmd.output().await.map_err(|e| e.to_string())?;

    let cdn_url = String::from_utf8(output.stdout)
        .map_err(|e| e.to_string())?
        .lines()
        .find(|l| l.starts_with("http"))
        .map(str::to_owned)
        .ok_or_else(|| {
            let stderr = String::from_utf8_lossy(&output.stderr);
            format!("streamlink produced no URL: {stderr}")
        })?;

    // Wrap in the local proxy so HLS.js fetches through localhost,
    // sidestepping Twitch CDN's missing CORS headers.
    proxied_hls_url(&state, &cdn_url).await
}

/// Live-channel counterpart of get_vod_m3u8_url: resolves a LIVE channel's
/// ad-free HLS playlist URL (via streamlink, so --twitch-disable-ads still
/// does its ad-stripping) and wraps it in the local proxy for CORS.
///
/// This exists for the macOS native-HLS playback path. On macOS the app
/// plays live through hls.js / native HLS (attachHlsDvr) instead of the
/// fMP4 byte-relay + MSE pipeline, because WebKit's MSE is unreliable
/// (classic MediaSource half-works then decode-fails; ManagedMediaSource
/// has strict append-timing rules). Native HLS on WebKit is
/// hardware-accelerated and sidesteps that entire class of problem.
///
/// AD NOTE: ad-stripping is preserved because it happens in streamlink
/// (--twitch-disable-ads selects the ad-reduced variant during URL
/// resolution), exactly as it does for the byte-relay path. The one
/// difference from the pipe-based path: streamlink is not kept in the loop
/// to splice out ads injected mid-stream after resolution, so dynamically-
/// stitched ads *could* leak where the pipe path would have caught them.
/// This is the known trade-off of the native-HLS approach, and why the
/// byte-relay path is kept as the default on Windows.
#[tauri::command]
pub async fn get_live_m3u8_url(
    channel: String,
    quality: String,
    state: tauri::State<'_, Arc<StreamRelayState>>,
) -> Result<String, String> {
    let target = format!("https://www.twitch.tv/{channel}");
    let mut cmd = Command::new(resolve_streamlink_path());
    cmd.arg(&target)
        .arg(&quality)
        .arg("--stream-url")
        .arg("--twitch-disable-ads")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());

    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    augment_child_path(&mut cmd);
    let output = cmd.output().await.map_err(|e| e.to_string())?;

    let cdn_url = String::from_utf8(output.stdout)
        .map_err(|e| e.to_string())?
        .lines()
        .find(|l| l.starts_with("http"))
        .map(str::to_owned)
        .ok_or_else(|| {
            let stderr = String::from_utf8_lossy(&output.stderr);
            format!("streamlink produced no URL: {stderr}")
        })?;

    proxied_hls_url(&state, &cdn_url).await
}

/// Builds a localhost hls-proxy URL for an arbitrary upstream HLS URL,
/// starting the proxy listener first if it isn't running yet. That
/// ensure step matters: on a fresh launch where playback starts through
/// here without start_relay ever having run, state.port is still 0 and
/// any URL built from it is unusable (black screen).
///
/// Shared by get_vod_m3u8_url above and the Kick failover (kick.rs) -
/// the proxy itself is host-agnostic (it fetches whatever ?url= says
/// with browser headers and rewrites playlist URIs recursively through
/// itself), so non-Twitch HLS rides through it exactly the same way.
pub(crate) async fn proxied_hls_url(
    state: &Arc<StreamRelayState>,
    upstream: &str,
) -> Result<String, String> {
    ensure_listener_running(state).await?;
    let port = state.port.load(Ordering::Relaxed);
    Ok(format!(
        "http://127.0.0.1:{port}/hls-proxy?url={}",
        pct_encode(upstream)
    ))
}

#[tauri::command]
pub async fn start_stream(
    state: tauri::State<'_, Arc<StreamRelayState>>,
    channel: String,
    quality: Option<String>,
    low_latency: Option<bool>,
) -> Result<String, String> {
    let target = format!("https://www.twitch.tv/{channel}");
    let mut extra_args: Vec<String> = Vec::new();
    if low_latency == Some(true) {
        // Enables Twitch's native low-latency mode (TLLS): smaller HLS
        // segments and a tighter PLR delay target, typically reducing
        // stream delay from ~10-15 s down to ~3-5 s. Only meaningful for
        // live channels only; VODs don't go through the relay at all.
        extra_args.push("--twitch-low-latency".to_string());
    }
    start_relay(
        state.inner().clone(),
        target,
        quality.unwrap_or_else(|| "best".to_string()),
        extra_args,
    )
    .await
}

/// Tauri command: stops whatever is currently relaying, if anything.
/// Called on Stop / before switching to a different channel/VOD from the
/// frontend's side (start_stream also stops the previous one
/// themselves, but an explicit Stop button needs this even when nothing
/// new is about to start).
#[tauri::command]
pub async fn stop_stream(state: tauri::State<'_, Arc<StreamRelayState>>) -> Result<(), String> {
    // Bump the start-request counter so any start_relay currently spawning
    // (e.g. the user hit Stop while a channel was still starting up) sees
    // itself superseded and aborts, rather than completing and storing a
    // fresh relay that then plays after the user asked to stop.
    state.start_requests.fetch_add(1, Ordering::SeqCst);
    stop_current_stream(state.inner()).await;
    Ok(())
}

/// Runs `streamlink <target_url>` with NO quality argument and no
/// --stdout, which makes it just print the available stream names and
/// exit immediately without ever actually starting playback - this is
/// streamlink's own documented behavior for "list what's available," the
/// same thing you see if you run it by hand with no quality picked.
///
/// Deliberately parses streamlink's stable plain-text line rather than
/// --json: streamlink's plain "Available streams: ..." line has been
/// shown in every version of its own documentation for years with an
/// unchanged format, while the exact JSON schema for this specific
/// no-quality-argument case isn't pinned down anywhere as clearly enough
/// to risk silently breaking if it differs from what's assumed here.
async fn list_available_qualities(target_url: &str) -> Result<Vec<String>, String> {
    let mut cmd = Command::new(resolve_streamlink_path());
    cmd.arg(target_url).stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null());

    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    augment_child_path(&mut cmd);
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to run streamlink: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    let line = stdout
        .lines()
        .find(|line| line.contains("Available streams:"))
        .ok_or_else(|| {
            format!(
                "Could not find available streams (target may be offline). stdout: {stdout} stderr: {stderr}"
            )
        })?;

    let list_part = line
        .split("Available streams:")
        .nth(1)
        .ok_or("Malformed 'Available streams:' line")?;

    // Each entry looks like "1080p60 (best)" or "audio_only" - strip the
    // optional "(best)"/"(worst)" annotation streamlink prints inline
    // next to the highest/lowest-ranked entries, keeping just the plain
    // quality name itself.
    let qualities: Vec<String> = list_part
        .split(',')
        .map(|entry| {
            entry
                .trim()
                .split_whitespace()
                .next()
                .unwrap_or("")
                .to_string()
        })
        .filter(|q| !q.is_empty())
        .collect();

    Ok(qualities)
}

/// Tauri command: lists available qualities for a live channel.
#[tauri::command]
pub async fn get_available_qualities(channel: String) -> Result<Vec<String>, String> {
    list_available_qualities(&format!("https://www.twitch.tv/{channel}")).await
}

/// Tauri command: lists available qualities for a VOD.
#[tauri::command]
pub async fn get_available_vod_qualities(video_id: String) -> Result<Vec<String>, String> {
    list_available_qualities(&format!("https://www.twitch.tv/videos/{video_id}")).await
}
