// drops-banner.js — the "this channel has Drops enabled" bar above the video.
//
// See drops.js for WHY this exists: playback through the streamlink relay
// never registers watch-time toward Twitch Drops no matter how long
// someone watches, so a drops-enabled channel needs to say so and offer a
// route to a surface where it actually counts.
//
// Self-contained: owns its DOM, its listeners, and its one piece of state.

import { openUrl } from "@tauri-apps/plugin-opener";
import { streamHasDropsEnabled } from "./drops.js";
import { formatViewerCount } from "./format.js";

const dropsBanner = document.getElementById("drops-banner");
const dropsBannerLink = document.getElementById("drops-banner-link");
const dropsBannerViewers = document.getElementById("drops-banner-viewers");
const dropsBannerDismiss = document.getElementById("drops-banner-dismiss");
const channelInput = document.getElementById("channel-input");

// The login the user explicitly dismissed the banner for. Re-rendering
// (the 500ms resync loop, switching away and back) must not pop it open
// again against that choice - but a genuinely different channel
// re-evaluates fresh, since the dismissal was about that channel, not
// about banners in general.
let manuallyDismissedFor = null;

export function updateDropsBanner(channel, stream) {
  const normalized = channel.toLowerCase();
  const dropsEnabled = Boolean(stream && streamHasDropsEnabled(stream));
  if (!dropsEnabled || manuallyDismissedFor === normalized) {
    dropsBanner.style.display = "none";
    return;
  }
  dropsBannerLink.href = `https://www.twitch.tv/${encodeURIComponent(channel)}`;
  dropsBannerViewers.textContent =
    typeof stream.viewer_count === "number"
      ? `\u2022 ${formatViewerCount(stream.viewer_count)} watching on Twitch`
      : "";
  dropsBanner.style.display = "flex";
}

/** Clears the "user dismissed this" memory. Called on Stop: the dismissal
 * was about one channel in one session, so a fresh session re-evaluates
 * from scratch rather than inheriting a stale "don't show me this". */
export function resetDropsDismissal() {
  manuallyDismissedFor = null;
}

export function hideDropsBanner() {
  dropsBanner.style.display = "none";
}

// target="_blank" does nothing in a Tauri webview (no second tab, and the
// navigation is blocked by default). Intercepting the click and handing
// the URL to openUrl() is what actually reaches the real browser. The
// href is still set normally above so it stays right-click-copyable.
dropsBannerLink.addEventListener("click", (e) => {
  e.preventDefault();
  openUrl(dropsBannerLink.href).catch((err) => {
    console.error("Failed to open Twitch link in browser:", err);
  });
});

dropsBannerDismiss.addEventListener("click", () => {
  manuallyDismissedFor = channelInput.value.trim().toLowerCase() || null;
  hideDropsBanner();
});
