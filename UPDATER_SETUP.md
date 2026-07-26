# Auto-updater setup (one-time)

The Windows auto-updater is fully wired up in code, but it needs a signing
keypair before it will work. This is a **one-time** setup. It is the
updater's own signature (free, built into Tauri) — NOT Windows code-signing
and nothing to do with Apple. Its only job is to prove an update genuinely
came from you, so nobody can push a malicious "update" to users.

## 1. Generate the keypair

On any machine with Node:

```
npx tauri signer generate -w tn-updater.key
```

It prints a **public key** and writes a **private key** file (and asks you
to set a password — you can leave it empty by pressing enter twice, but a
password is safer).

## 2. Add the PUBLIC key to the app

Open `src-tauri/tauri.conf.json`, find:

```json
"pubkey": "PASTE_PUBLIC_KEY_HERE"
```

Replace `PASTE_PUBLIC_KEY_HERE` with the public key it printed. Commit and
push this — the public key is safe to commit.

## 3. Add the PRIVATE key as GitHub secrets

In the GitHub repo: **Settings → Secrets and variables → Actions → New
repository secret**. Add two:

- `TAURI_SIGNING_PRIVATE_KEY` — the entire contents of the `tn-updater.key`
  file (open it in a text editor, copy everything).
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — the password you set (or leave the
  value empty if you didn't set one).

**Never commit the private key.** Keep the file somewhere safe; if you lose
it you can't push updates that existing installs will accept (you'd have to
ship a fresh installer with a new public key).

## 4. Ship an update

Each time you want to push a new version to everyone:

1. Bump `"version"` in `src-tauri/tauri.conf.json` (e.g. `2.0.0` → `2.0.1`).
   It must be higher than what users have, or they won't see it.
2. Commit, then tag and push:
   ```
   git tag v2.0.1
   git push origin v2.0.1
   ```
3. The **Release Windows** workflow builds, signs, and publishes the
   release with a `latest.json`.
4. Windows users' apps check that `latest.json` on startup, see the higher
   version, and show the in-app **Update now** button. Clicking it
   downloads, installs, and relaunches — no leaving the app.

## Notes

- macOS/Linux never check for updates (the plugin is Windows-gated in
  `main.rs`); those platforms use the GitHub Actions `.dmg` build instead.
- The very first signed release establishes the baseline. Users need to be
  on a build that already contains the public key for the updater to work,
  so the first signed installer must be distributed manually (or they
  reinstall once); every release after that updates in-app.
- If a build fails with a codesign/keychain-style error about a missing
  signing item, it means the secrets aren't set — the workflow expects them
  because the config has `createUpdaterArtifacts: true`.
