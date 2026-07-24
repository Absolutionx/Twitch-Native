# Twitch Native

A lightweight native desktop client for watching Twitch streams and VODs,
built with [Tauri](https://tauri.app) (Rust) + vanilla JS. Full chat
(including BTTV/7TV emotes and AutoMod), live-DVR seeking on in-progress
streams, and a much smaller memory footprint than watching in a browser.

> **Status:** proof-of-concept / hobby project, not affiliated with or
> endorsed by Twitch Interactive, Inc.

## Why this exists

Watching Twitch in a browser tab typically costs 1.5–2.5GB of RAM once
you account for the browser's renderer process, Twitch's full web app
bundle, ads infrastructure, and chat rendering. This app instead:

1. Uses [streamlink](https://streamlink.github.io/) as a subprocess to
   pull the raw stream,
2. Relays it over a local HTTP server to a `<video>` element via the
   [Media Source Extensions](https://developer.mozilla.org/en-US/docs/Web/API/Media_Source_Extensions_API)
   API,
3. Renders chat and UI natively, with no browser chrome or ads SDK.

Typical memory usage lands around 30MB.

## Known limitations

- **Twitch Drops and Channel Points do not accrue while watching through
  this app.** Both are tracked by a "minute watched" heartbeat that only
  the official Twitch player emits — this app plays real video from a
  real stream, but that specific signal isn't part of what streamlink
  relays, so Twitch's backend has no way to know you're watching. If a
  drop matters to you, watch that stream in a browser or the official
  app instead.
- **Live seeking is limited to a rolling ~2 minute buffer** unless the
  streamer has VODs enabled, in which case seeking further back
  transparently switches to HLS.js against the in-progress VOD (see the
  comments above `seekToClickPosition` in `src/playback-controls.js`).
  There's an unavoidable few-seconds delay the first time you do this
  per session, since it involves resolving a CDN URL; subsequent seeks
  reuse a cached URL and are much faster.
- Windows, macOS, and Linux are all targeted by the build scripts, but
  this has had the most real-world testing on Windows.

## Getting started

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Rust](https://www.rust-lang.org/tools/install) (stable toolchain)
- [streamlink](https://streamlink.github.io/install.html), available on
  your `PATH`
- `ffmpeg`, available on your `PATH` (only needed for channels whose
  stream isn't already fragmented MP4 — see comments in
  `src-tauri/src/stream_relay.rs`)

### Setup

```bash
npm install
npm run tauri dev
```

To build a distributable installer, use the platform build script from
the project root instead of `tauri build` directly — it also bootstraps
missing system dependencies:

```bash
# macOS / Linux
./build-unix.sh

# Windows (PowerShell)
./build-windows.ps1
```

### Logging in

Login uses Twitch's standard OAuth implicit-grant flow via your system's
default browser (not an embedded webview — see the comment block at the
top of `src-tauri/src/oauth.rs` for why). No client secret is involved;
the `CLIENT_ID` values in this repo are public identifiers, not
credentials, and are safe to keep in source control. If you fork this
project for real-world use, you may want to
[register your own Twitch application](https://dev.twitch.tv/console/apps)
and swap in your own client ID.

## Project structure

```
src/                    Frontend (vanilla JS, no framework)
  main.js                Application entry point / state orchestration
  stream-player.js        MSE feeder for the live relay
  playback-controls.js    Seek bar, quality menu, live-DVR handoff
  chat.js                  Chat connection lifecycle + message pipeline
  chat/                    Chat feature mixins (see file header comments):
                             chat-emotes.js, chat-badges.js, chat-automod.js,
                             chat-usercard.js, chat-mod-actions.js,
                             chat-link-preview.js, chat-autocomplete.js,
                             shared.js
  auth.js, sidebar.js, home.js, browse.js, vods.js, vod-player.js,
  chapters.js, drops.js   Feature-specific UI modules

src-tauri/src/          Backend (Rust)
  main.rs                 Tauri app setup, command registration, and the
                            Helix (Twitch REST API) commands
  stream_relay.rs         Spawns streamlink/ffmpeg, relays bytes over HTTP
  chat.rs                 IRC WebSocket connection
  oauth.rs                Native-browser OAuth flow
  eventsub.rs              Twitch EventSub (go-live notifications, raids)
  seventv_events.rs        7TV real-time emote updates
  link_preview.rs          Chat link hover-preview metadata fetching
  tray.rs                  System tray icon/menu
  notify_prefs.rs          Persisted per-channel notification preferences
```

> **Note on `main.rs`:** the Helix API commands (followed channels, stream
> lookups, VOD listings, etc.) and moderation commands (ban/timeout/delete)
> currently live directly in `main.rs` rather than their own modules. They
> share private state (`ChatState`) that would need its fields promoted to
> `pub(crate)` to split safely — a reasonable follow-up PR, just one this
> cleanup pass didn't make blindly without a compiler on hand to verify it.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[MIT](./LICENSE) — see that file for the full text. Twitch, the Twitch
logo, and related marks are trademarks of Twitch Interactive, Inc.; this
project is an independent, unofficial client.

## Kick support

The platform toggle in the header (right of **Browse**) switches the whole
app between Twitch and Kick: home feed, browse/categories/search, the
sidebar's live channels, and the watch box. Twitch is the default (purple
border); Kick mode turns the border green.

### Kick login (optional — needed only to type in Kick chat)

Watching Kick streams and reading Kick chat need no login. **Sending** chat
messages does. Kick uses OAuth 2.1 with PKCE and, unlike Twitch's implicit
flow, requires a client secret even for desktop apps.

To enable it:

1. Register an app at <https://kick.com/settings/developer>.
2. Set its redirect URI to exactly `http://localhost:17544/`.
3. Request the `user:read` and `chat:write` scopes.
4. Put the credentials in `src-tauri/src/kick_oauth.rs`:
   - `CLIENT_ID`
   - `CLIENT_SECRET`  (replace the `REPLACE_WITH_KICK_CLIENT_SECRET` placeholder)
5. Rebuild.

Until step 4 is done, `kick_oauth_configured()` returns false and the app
simply hides the "Log in with Kick" button — Kick chat stays read-only
rather than offering a login that could only fail. Tokens are stored in
`kick_oauth_token.json` in the app's local data dir, separate from the
Twitch token, and are refreshed automatically when they expire (~1 hour).
