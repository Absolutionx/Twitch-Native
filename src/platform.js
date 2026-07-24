// Platform mode: "twitch" (default) or "kick", flipped by the header
// toggle next to Browse. One module owns the state so home/browse/
// sidebar/main all agree. The choice deliberately does NOT survive
// restarts: the app always launches in Twitch mode, and Kick is an
// opt-in flip per session.
//
// The design principle for Kick mode is that the FRONTEND stays
// platform-dumb: the Rust side normalizes every Kick payload into
// Helix-shaped objects (see the discovery section of kick.rs), so the
// card renderers/grids never branch. All this module adds on top of
// state is feedInvoke(), a one-line indirection that swaps a Twitch
// feed command's NAME for its Kick counterpart when Kick mode is on -
// same arguments, same response envelope, by construction on the Rust
// side.

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
