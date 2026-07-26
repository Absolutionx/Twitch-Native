// update-banner.js — the "a new version is available" banner + one-click
// in-app update. Windows only.
//
// The Tauri updater plugin is registered only on Windows (see main.rs), so
// check() here would just error on macOS/Linux - we skip it entirely on
// those platforms. macOS is distributed via the GitHub Actions .dmg and
// updates by re-downloading, not through this path.
//
// Flow: on startup, ask the updater if a newer version exists (compared to
// the running app's version, against the latest.json on GitHub Releases).
// If so, show a banner with an "Update now" button. Clicking it downloads
// and installs the update with a live progress readout, then relaunches
// into the new version - all without leaving the app.
//
// Self-contained like deps-banner.js: owns its DOM and listeners, shares
// no state. main.js just calls checkForUpdate() at startup.

import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { platform } from "@tauri-apps/plugin-os";

const appEl = document.getElementById("app");

let _bannerEl = null;
let _updating = false;

function buildBanner(version, onUpdate) {
  const bar = document.createElement("div");
  bar.className = "update-banner";
  bar.innerHTML = `
    <div class="update-banner-text">
      <strong>Update available</strong>
      <span class="update-banner-version">Version ${version} is ready to install.</span>
    </div>
    <div class="update-banner-progress" style="display:none">
      <div class="update-banner-progress-bar"></div>
      <span class="update-banner-progress-label">Starting…</span>
    </div>
    <button class="update-banner-btn">Update now</button>
    <button class="update-banner-dismiss" title="Later">&times;</button>
  `;
  bar.querySelector(".update-banner-btn").addEventListener("click", onUpdate);
  bar.querySelector(".update-banner-dismiss").addEventListener("click", () => {
    if (!_updating) hideUpdateBanner();
  });
  return bar;
}

function hideUpdateBanner() {
  if (_bannerEl) {
    _bannerEl.remove();
    _bannerEl = null;
  }
}

/**
 * Checks for an update and, if one exists, shows the banner. Fails OPEN:
 * any error (no endpoint, offline, plugin missing on this platform) just
 * means no banner, never a blocked or broken startup.
 */
export async function checkForUpdate() {
  try {
    // Windows-only: the updater plugin isn't registered elsewhere.
    if (platform() !== "windows") return;

    const update = await check();
    if (!update?.available) return;

    const onUpdate = async () => {
      if (_updating) return;
      _updating = true;
      const btn = _bannerEl.querySelector(".update-banner-btn");
      const dismiss = _bannerEl.querySelector(".update-banner-dismiss");
      const progress = _bannerEl.querySelector(".update-banner-progress");
      const progressBar = _bannerEl.querySelector(".update-banner-progress-bar");
      const progressLabel = _bannerEl.querySelector(".update-banner-progress-label");
      btn.disabled = true;
      btn.style.display = "none";
      dismiss.style.display = "none";
      progress.style.display = "flex";

      let downloaded = 0;
      let contentLength = 0;
      try {
        // downloadAndInstall streams progress events as it goes, then
        // installs. On Windows (NSIS "passive" mode) the installer runs
        // and the app relaunches into the new version below.
        await update.downloadAndInstall((event) => {
          switch (event.event) {
            case "Started":
              contentLength = event.data.contentLength || 0;
              progressLabel.textContent = "Downloading…";
              break;
            case "Progress":
              downloaded += event.data.chunkLength || 0;
              if (contentLength > 0) {
                const pct = Math.min(100, Math.round((downloaded / contentLength) * 100));
                progressBar.style.width = `${pct}%`;
                progressLabel.textContent = `Downloading… ${pct}%`;
              }
              break;
            case "Finished":
              progressBar.style.width = "100%";
              progressLabel.textContent = "Installing…";
              break;
          }
        });

        progressLabel.textContent = "Restarting…";
        await relaunch();
      } catch (err) {
        console.error("[updater] install failed:", err);
        _updating = false;
        progress.style.display = "none";
        btn.style.display = "";
        btn.disabled = false;
        dismiss.style.display = "";
        btn.textContent = "Retry update";
      }
    };

    hideUpdateBanner();
    _bannerEl = buildBanner(update.version, onUpdate);
    appEl.appendChild(_bannerEl);
  } catch (err) {
    // No endpoint yet, offline, not configured, wrong platform - all fine.
    console.log("[updater] no update / check skipped:", err?.message || err);
  }
}
