// Controller for pip.html, the always-on-top PiP window. It's a separate
// webview, so everything arrives via query params from enterNativePip()
// (playback-controls.js): mode (live/vod), src (relay URL or m3u8), pos,
// volume, muted, channel. Self-sufficient once created - the main window mutes
// itself while it exists and restores on close; there's no ongoing coordination.

import { getCurrentWindow, currentMonitor, availableMonitors, primaryMonitor, PhysicalPosition, PhysicalSize } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { attachMseStream } from "./stream-player.js";
import { attachHlsVod } from "./vod-player.js";

const params  = new URLSearchParams(location.search);
// Platform theming: body.kick-mode flips every --accent in the shared
// stylesheet to Kick green (this window's volume slider uses
// accent-color: var(--accent)). Applied before first paint - this
// script runs at parse time - so the slider never flashes purple.
if (params.get("kick") === "1") document.body.classList.add("kick-mode");
const mode    = params.get("mode") || "live";
const src     = params.get("src") || "";
const pos     = parseFloat(params.get("pos") || "0") || 0;
const volume  = Math.min(1, Math.max(0, parseFloat(params.get("volume") ?? "1")));
const muted   = params.get("muted") === "1";
const channel = params.get("channel") || "";
const lowSrc  = params.get("lowsrc") || "";
const mvChannel = params.get("mvchannel") || "";
const mvQuality = params.get("mvquality") || "best";

const videoEl   = document.getElementById("pip-video");
const playBtn   = document.querySelector('[data-act="playpause"]');
const muteBtn   = document.querySelector('[data-act="mute"]');
const volSlider = document.querySelector('[data-act="volume"]');
const closeBtn  = document.getElementById("pip-close");
const pauseIcon = playBtn.querySelector(".docpip-pause-icon");
const playIcon  = playBtn.querySelector(".docpip-play-icon");
const volIcon   = muteBtn.querySelector(".docpip-vol-icon");
const mutedIcon = muteBtn.querySelector(".docpip-muted-icon");

if (channel) {
  getCurrentWindow().setTitle(`PiP — ${channel}`).catch(() => {});
  document.title = `PiP — ${channel}`;
}

videoEl.volume = volume;
videoEl.muted = muted;
volSlider.value = String(volume);

// ------------------------------------------------------------------ //
// window placement: open where the window was last closed, or bottom-
// right of the current monitor on first use. The window is CREATED
// hidden (see enterNativePip) precisely so this can run before anything
// is visible - previously the OS picked an arbitrary spot (cascade
// position, so "random places" from the user's point of view) and the
// window appeared there instantly with no way to move it first.
// Position/size persist through localStorage, which the pip page shares
// with the main window (same origin), saved continuously from this
// window's own move/resize events so whatever was true at close time is
// what's stored - no close-time hook needed.
// ------------------------------------------------------------------ //

const pipWin = getCurrentWindow();

async function placeWindow() {
  try {
    const savedSize = JSON.parse(localStorage.getItem("pipWinSize") || "null");
    if (savedSize && Number.isFinite(savedSize.width) && Number.isFinite(savedSize.height)
        && savedSize.width >= 160 && savedSize.height >= 90) {
      await pipWin.setSize(new PhysicalSize(savedSize.width, savedSize.height));
    }
    const saved = JSON.parse(localStorage.getItem("pipWinPos") || "null");
    let placed = false;
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      // Only restore a position that's still on SOME monitor - a saved
      // spot on a since-unplugged display would put the window
      // somewhere unreachable, which is strictly worse than the
      // bottom-right default. 50px of the window's top-left being
      // visible is enough to grab and move it.
      const monitors = await availableMonitors().catch(() => []);
      const onScreen = monitors.some((m) =>
        saved.x >= m.position.x - 50 && saved.x < m.position.x + m.size.width - 50 &&
        saved.y >= m.position.y - 50 && saved.y < m.position.y + m.size.height - 50);
      if (onScreen) {
        await pipWin.setPosition(new PhysicalPosition(saved.x, saved.y));
        placed = true;
      }
    }
    if (!placed) {
      const mon = await currentMonitor();
      if (mon) {
        const size = await pipWin.outerSize();
        const margin = Math.round(24 * (mon.scaleFactor || 1));
        await pipWin.setPosition(new PhysicalPosition(
          mon.position.x + mon.size.width - size.width - margin,
          mon.position.y + mon.size.height - size.height - margin,
        ));
      }
    }
  } catch (err) {
    console.warn("[pip] window placement failed (showing at default position):", err);
  } finally {
    // The finally is load-bearing: the window was created invisible, so
    // failing to reach show() would leave a playing-but-unseeable
    // zombie window.
    await pipWin.show().catch(() => {});
  }
}
placeWindow();

pipWin.onMoved(({ payload }) => {
  try { localStorage.setItem("pipWinPos", JSON.stringify({ x: payload.x, y: payload.y })); } catch (_) {}
});

// ------------------------------------------------------------------ //
// Off-screen watchdog. placeWindow's on-a-monitor check only runs at
// OPEN time - if the monitor this window lives on goes away WHILE the
// window is open (dock unplugged, cable moved to another machine), the
// window is stranded somewhere unreachable: frameless + always-on-top +
// skip-taskbar means the OS gives the user nothing to grab it with.
// Tauri has no monitor-hotplug event to react to, so poll: every few
// seconds, verify our top-left is still on SOME monitor (same 50px
// "enough to grab" criterion as placeWindow), and if not, hop to the
// bottom-right of the primary monitor. The setPosition fires our own
// onMoved above, so the persisted position heals along with the window.
//
// The one case this cannot detect is a monitor that's input-switched
// away but still CONNECTED to this machine - the OS still enumerates
// it, so from here everything looks fine. That case is covered from the
// other side: the main window's "Bring PiP to this screen" button
// (see rescueNativePip in playback-controls.js).
// ------------------------------------------------------------------ //

const OFFSCREEN_POLL_MS = 5000;
let offscreenRescueBusy = false;
setInterval(async () => {
  if (offscreenRescueBusy) return;
  offscreenRescueBusy = true;
  try {
    const [pos, size, monitors] = await Promise.all([
      pipWin.outerPosition().catch(() => null),
      pipWin.outerSize().catch(() => null),
      availableMonitors().catch(() => []),
    ]);
    // No monitors reported at all reads as a transient enumeration
    // failure, not "every display is gone" - don't move on it.
    if (!pos || !size?.width || !monitors.length) return;
    const onScreen = monitors.some((m) =>
      pos.x >= m.position.x - 50 && pos.x < m.position.x + m.size.width - 50 &&
      pos.y >= m.position.y - 50 && pos.y < m.position.y + m.size.height - 50);
    if (onScreen) return;
    const mon = (await primaryMonitor().catch(() => null)) || monitors[0];
    console.warn("[pip] window is off every available monitor - relocating to", mon.name || "primary monitor");
    const margin = Math.round(24 * (mon.scaleFactor || 1));
    await pipWin.setPosition(new PhysicalPosition(
      mon.position.x + mon.size.width - size.width - margin,
      mon.position.y + mon.size.height - size.height - margin,
    ));
    await pipWin.show().catch(() => {}); // in case the OS hid us with the display
  } catch (_) {
    // Transient failure - the next tick tries again.
  } finally {
    offscreenRescueBusy = false;
  }
}, OFFSCREEN_POLL_MS);

// ------------------------------------------------------------------ //
// Aspect-ratio snap. The video renders with object-fit:contain, so any
// window shape that doesn't match the video's aspect shows black bars
// (grow the window vertically only -> bars top and bottom, etc).
// Correcting DURING an interactive resize fights the user's drag - the
// OS applies the pointer's size and our setSize() applies the corrected
// one on alternating frames, which reads as shuddering - so the window
// snaps ONCE, shortly after the last resize event of a drag: whichever
// dimension changed proportionally more is treated as the user's
// intent and kept, and the other is recomputed from the video's actual
// aspect ratio (from loadedmetadata, so a vertical VOD snaps to a
// vertical window rather than being forced to 16:9). The same snap
// runs when metadata first arrives, which also squares up a stale
// saved size from before this feature existed.
// ------------------------------------------------------------------ //

const SNAP_MIN_WIDTH = 192;   // ~192x108 at 16:9; matches the window's minWidth
let videoAspect = 16 / 9;     // assumed until loadedmetadata reports the truth
let lastSize = null;          // most recent onResized payload (physical px)
let preDragSize = null;       // size when the current resize burst began
let snapTimer = null;
let suppressSnapUntil = 0;    // our own setSize fires onResized too - ignore it

async function snapToAspect(keepAxis) {
  const size = lastSize || (await pipWin.innerSize().catch(() => null));
  if (!size?.width || !size?.height) return;
  let w = size.width, h = size.height;
  if (keepAxis === "height") w = Math.round(h * videoAspect);
  else h = Math.round(w / videoAspect);
  if (w < SNAP_MIN_WIDTH) { w = SNAP_MIN_WIDTH; h = Math.round(w / videoAspect); }
  // Within a pixel of correct already - not worth a visible nudge (and
  // rounding disagreements must not become a correct/snap/correct loop).
  if (Math.abs(w - size.width) <= 1 && Math.abs(h - size.height) <= 1) return;
  suppressSnapUntil = Date.now() + 300;
  lastSize = { width: w, height: h };
  try {
    // If the snap GROWS the window (widen a window sitting bottom-right
    // and the corrected height extends past the screen edge), shift it
    // back on-screen - setSize anchors the top-left corner, so growth
    // is always down/right, straight toward the default corner.
    const [pos, mon] = await Promise.all([pipWin.outerPosition(), currentMonitor()]);
    if (pos && mon) {
      const maxX = mon.position.x + mon.size.width;
      const maxY = mon.position.y + mon.size.height;
      const nx = pos.x + w > maxX ? Math.max(mon.position.x, maxX - w) : pos.x;
      const ny = pos.y + h > maxY ? Math.max(mon.position.y, maxY - h) : pos.y;
      if (nx !== pos.x || ny !== pos.y) await pipWin.setPosition(new PhysicalPosition(nx, ny));
    }
  } catch (_) {}
  await pipWin.setSize(new PhysicalSize(w, h)).catch(() => {});
}

pipWin.onResized(({ payload }) => {
  try { localStorage.setItem("pipWinSize", JSON.stringify({ width: payload.width, height: payload.height })); } catch (_) {}
  const prev = lastSize;
  lastSize = { width: payload.width, height: payload.height };
  if (Date.now() < suppressSnapUntil) return; // echo of our own corrective setSize
  if (!preDragSize) preDragSize = prev || lastSize;
  clearTimeout(snapTimer);
  snapTimer = setTimeout(() => {
    const from = preDragSize;
    preDragSize = null;
    // Which axis did the user actually drag? Compare proportional (not
    // absolute) deltas so 40px on a 1400px-wide window doesn't outvote
    // 40px on a 250px-tall one. Corner drags land wherever the user
    // pulled hardest, which is the intuitive outcome.
    const dw = Math.abs(lastSize.width - from.width) / Math.max(1, from.width);
    const dh = Math.abs(lastSize.height - from.height) / Math.max(1, from.height);
    snapToAspect(dh > dw ? "height" : "width");
  }, 150);
});

videoEl.addEventListener("loadedmetadata", () => {
  if (videoEl.videoWidth > 0 && videoEl.videoHeight > 0) {
    videoAspect = videoEl.videoWidth / videoEl.videoHeight;
  }
  // Square up whatever placeWindow restored (saved sizes can predate
  // this feature or belong to a different-aspect video) - keep the
  // width the user last chose, recompute the height.
  snapToAspect("width");
});

let feeder = null;
// Live-relay self-healing: the relay now deliberately CLOSES a
// subscriber that lags (see stream_relay.rs's Lagged branch - closing
// beats splicing a byte gap into the stream), and a freshly-opened PiP
// window is the most likely subscriber to lag. So dying is a normal,
// expected event here, and the recovery is simply to reattach: the
// relay's fragment-aligned late-join path hands every reconnect a
// clean, decodable stream. Budgeted so a relay that's genuinely gone
// (main window closed the session) doesn't retry forever.
let deadRetries = 0;
let lastDeadAt = 0;
function attachLiveFeeder() {
  feeder = attachMseStream(videoEl, src, {
    isVod: false,
    onFatalError: () => handleFeederDeath("MSE pipeline failed"),
    onDead: (reason) => handleFeederDeath(reason),
  });
}

// MultiView PiP: resolve the live HLS m3u8 ourselves (the channel/quality
// come in as params - the URL is too big to pass directly), then play it via
// attachHlsVod, the same native-HLS path MultiView tiles use.
async function attachMvLiveFeeder() {
  let url;
  try {
    url = await invoke("get_live_m3u8_url", { channel: mvChannel, quality: mvQuality });
  } catch (err) {
    console.error("[pip:mv] couldn't resolve stream:", err);
    return;
  }
  feeder = attachHlsVod(videoEl, url, {
    startPosition: -1, // live edge
    onFatalError: () => handleFeederDeath("HLS pipeline failed"),
    smallPlayer: true,
    logPrefix: "[pip:mv]",
  });
}
function handleFeederDeath(reason) {
  const now = Date.now();
  if (now - lastDeadAt > 60_000) deadRetries = 0; // a healthy minute resets the budget
  if (deadRetries >= 5) {
    console.error(`[pip] stream died (${reason}) and retry budget is exhausted - giving up. Close and reopen PiP to retry.`);
    return;
  }
  deadRetries++;
  lastDeadAt = now;
  const delay = Math.min(1000 * deadRetries, 5000);
  console.warn(`[pip] stream died (${reason}) - reattaching in ${delay}ms (attempt ${deadRetries}/5)`);
  try { feeder?.stop?.(); } catch (_) {}
  setTimeout(() => attachLiveFeeder(), delay);
}
function attachVodFeeder(url, isLowQuality) {
  feeder = attachHlsVod(videoEl, url, {
    startPosition: mode === "vod" && videoEl.currentTime > 0 ? videoEl.currentTime : pos,
    onFatalError: (data) => {
      if (isLowQuality) {
        // The pre-resolved low-quality URL can outlive its token or 404
        // in ways the main-quality URL (in active use by the main
        // player) can't - fall back to that known-good URL once rather
        // than dying.
        console.warn("[pip] low-quality playlist failed - falling back to main-quality URL:", data?.details);
        try { feeder?.destroy?.(); } catch (_) {}
        attachVodFeeder(src, false);
      } else {
        console.error("[pip] hls.js fatal:", data);
      }
    },
    smallPlayer: true,
    logPrefix: "[pip:hls]",
  });
}
if (mode === "mv") {
  // mv resolves its own URL from mvchannel/mvquality (no src param).
  try { attachMvLiveFeeder(); }
  catch (err) { console.error("[pip] mv feeder attach failed:", err); }
} else if (src) {
  try {
    if (mode === "vod") {
      // Prefer the pre-resolved low-quality playlist (right-sized
      // segments for a small window - see resolvePipVodUrl in main.js);
      // src remains the fallback.
      attachVodFeeder(lowSrc || src, Boolean(lowSrc));
    } else {
      attachLiveFeeder();
    }
  } catch (err) {
    // A feeder failure must not skip the control wiring below (close/drag),
    // or the window becomes uncloseable.
    console.error("[pip] feeder attach failed:", err);
  }
} else {
  console.error("[pip] opened without a src param - nothing to play.");
}

// ------------------------------------------------------------------ //
// controls (mirrors the docpip controls bar behavior in
// playback-controls.js's enterDocPip, minus the parts that only make
// sense when sharing the main window's video element)
// ------------------------------------------------------------------ //

function syncPlayIcon() {
  pauseIcon.style.display = videoEl.paused ? "none" : "";
  playIcon.style.display  = videoEl.paused ? "" : "none";
}
function syncMuteIcon() {
  volIcon.style.display   = videoEl.muted ? "none" : "";
  mutedIcon.style.display = videoEl.muted ? "" : "none";
}
videoEl.addEventListener("play", syncPlayIcon);
videoEl.addEventListener("pause", syncPlayIcon);
videoEl.addEventListener("volumechange", syncMuteIcon);
syncPlayIcon();
syncMuteIcon();

function togglePlayPause() {
  if (videoEl.paused) videoEl.play().catch(() => {});
  else videoEl.pause();
}
playBtn.addEventListener("click", togglePlayPause);

// Double-click on the stage = play/pause, NOT maximize. The stage is a
// data-tauri-drag-region, and Tauri's injected drag-region script maps
// a double-click mousedown (e.detail === 2) on such an element to
// internal_toggle_maximize - which is nonsense for this window: the
// maximize/restore resize events then collide with the aspect-snap
// logic above (snap fires on the restore, keeps whichever axis the
// maximize distorted more, and the window comes back misshapen).
// Tauri's listener is on document in the BUBBLE phase, so a CAPTURE
// listener runs first; stopImmediatePropagation keeps the event from
// ever reaching it. Match Tauri's own condition exactly (left button,
// e.target itself carries the attribute - not closest()) so behavior
// over the control buttons, which lack the attribute, is untouched.
document.addEventListener("mousedown", (e) => {
  if (e.detail === 2 && e.button === 0 && e.target?.hasAttribute?.("data-tauri-drag-region")) {
    e.preventDefault();
    e.stopImmediatePropagation();
    togglePlayPause();
  }
}, true);
muteBtn.addEventListener("click", () => { videoEl.muted = !videoEl.muted; });
const volBubble = document.getElementById("pip-vol-bubble");
function showVolBubble(fraction, pct) {
  const sliderRect = volSlider.getBoundingClientRect();
  const barRect = volSlider.parentElement.getBoundingClientRect();
  volBubble.style.left = `${sliderRect.left - barRect.left + fraction * sliderRect.width}px`;
  volBubble.textContent = `${pct}%`;
  volBubble.style.display = "block";
}
volSlider.addEventListener("input", () => {
  videoEl.volume = parseFloat(volSlider.value);
  if (videoEl.volume > 0) videoEl.muted = false;
  // While dragging, the bubble tracks the THUMB (the actual value being
  // set) rather than the raw pointer x - identical for a mouse mid-bar,
  // but stays correct when the pointer overshoots past either end.
  const v = parseFloat(volSlider.value);
  showVolBubble(v, Math.round(v * 100));
});
volSlider.addEventListener("mousemove", (e) => {
  const rect = volSlider.getBoundingClientRect();
  const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  showVolBubble(frac, Math.round(frac * 100));
});
volSlider.addEventListener("mouseleave", () => { volBubble.style.display = "none"; });
closeBtn.addEventListener("click", () => {
  getCurrentWindow().close().catch(() => {});
});

// Belt and braces: tear the feeder down on pagehide so the relay
// subscription / hls.js instance doesn't linger for the brief window
// between the page dying and the process going with it.
window.addEventListener("pagehide", () => {
  try { feeder?.stop?.(); feeder?.destroy?.(); } catch (_) {}
});
