# Contributing

Thanks for considering a contribution! This is a hobby project, so please
keep expectations calibrated accordingly — response times may be slow.

## Before opening a PR

- Run the app locally (`npm run tauri dev`) and confirm the change works
  for at least one live channel and one VOD, since the frontend and
  streaming layer are tightly coupled and hard to unit test in
  isolation.
- Keep frontend modules focused: prefer adding a new file under `src/`
  (or `src/chat/`) over growing an existing one past a few hundred
  lines, unless the logic genuinely belongs together.
- Match the existing comment style: comments here tend to explain *why*
  a piece of code exists (the constraint or bug it's working around),
  not just *what* it does. If you're fixing a subtle bug, a short note
  on the root cause is more useful to future readers than a changelog
  entry.
- Rust changes should pass `cargo check` in `src-tauri/` before
  submitting.

## Reporting bugs

Please include:
- OS and version
- Steps to reproduce
- Relevant console output (DevTools → Console in the app, or the
  terminal if running via `npm run tauri dev`)

## Known non-goals

- Making Twitch Drops or Channel Points work through this app's relay.
  See the README's "Known limitations" section for why this isn't a bug
  to be fixed — it would require impersonating parts of Twitch's
  official client that this project deliberately doesn't reimplement.
