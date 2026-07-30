// Platform mode: "twitch" (default) or "kick", flipped by the header toggle.
// One module owns the state so every feed agrees; it resets to Twitch on each
// launch. The frontend stays platform-dumb (Rust normalizes Kick into Helix-
// shaped objects), so all this adds is feedInvoke(), which swaps a feed
// command's name for its Kick counterpart in Kick mode.

import { invoke } from "@tauri-apps/api/core";

let current = "twitch"; // always start in Twitch mode (see header comment)
const listeners = new Set();

export function isKick() {
  return current === "kick";
}

export function togglePlatform() {
  setPlatform(current === "kick" ? "twitch" : "kick");
}

export function setPlatform(p) {
  if ((p !== "twitch" && p !== "kick") || p === current) return;
  current = p;
  for (const cb of listeners) {
    try {
      cb(p);
    } catch (err) {
      console.error("[platform] change listener failed:", err);
    }
  }
}

/** Subscribe to platform flips. Fired AFTER the state change, so
 * isKick() inside the callback sees the new mode. */
export function onPlatformChange(cb) {
  listeners.add(cb);
}

// Twitch feed command -> Kick counterpart. Only DISCOVERY commands
// belong here (things that list/search content). Watch/chat/auth
// commands are deliberately absent: watching routes through
// watchKickChannel explicitly (main.js), and Twitch auth-bound features
// (followed channels, points, drops, VOD progress) have no Kick
// equivalent without Kick login, so they simply don't run in Kick mode.
const KICK_FEED_COMMANDS = {
  get_top_live_streams: "kick_top_live_streams",
  get_live_streams_page: "kick_live_streams_page",
  get_top_games: "kick_top_games",
  get_streams_for_game_id: "kick_streams_for_category",
  get_streams_for_game_names: "kick_streams_for_game_names",
  search_categories: "kick_search_categories",
  get_category_viewer_counts: "kick_category_viewer_counts",
};

/** invoke(), but feed commands transparently reroute to their Kick
 * counterparts while Kick mode is on. Anything not in the map passes
 * through untouched in both modes. */
export function feedInvoke(command, args) {
  if (current === "kick" && KICK_FEED_COMMANDS[command]) {
    return invoke(KICK_FEED_COMMANDS[command], args ?? {});
  }
  return invoke(command, args ?? {});
}
