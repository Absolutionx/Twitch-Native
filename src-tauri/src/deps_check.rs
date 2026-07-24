// deps_check.rs — detects whether streamlink and ffmpeg are on PATH, and
// on Windows, can install them via winget if missing.
//
// Neither is installed by the built app itself - Tauri's NSIS/MSI
// bundler has no built-in "install another vendor's package" step, and
// hand-writing that into a raw NSIS install script isn't something this
// codebase can verify actually compiles/runs without a real Windows
// build environment on hand. Doing it here instead, as a check the app
// itself runs on startup and can act on, is testable the same way every
// other command in this codebase is, and works identically regardless
// of whether someone installed via the .msi, unzipped a portable build,
// or is running via `cargo run` in dev - unlike an installer-time hook,
// which only ever runs once, at install time, and couldn't recover if a
// user later removed one of these tools some other way.

use serde::Serialize;
use tokio::process::Command;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Serialize)]
pub struct DepsStatus {
    streamlink: bool,
    ffmpeg: bool,
}

/// True if `bin version_flag` spawns and runs at all - regardless of
/// exit code. Both streamlink and ffmpeg exit 0 for these flags in
/// practice, but even a nonzero exit still proves the binary is on PATH
/// and executable, which is all this needs to confirm. A spawn failure
/// (ErrorKind::NotFound, the overwhelmingly common case - "not on PATH")
/// is the only outcome that actually means "not installed."
async fn is_on_path(bin: &str, version_flag: &str) -> bool {
    // Resolve exactly the way we LAUNCH it (stream_relay::resolve_dep_path).
    // If detection used a bare name while playback used the Homebrew path,
    // the two would disagree on macOS: the deps banner would nag that
    // streamlink/ffmpeg are missing even though playback finds them fine.
    let mut cmd = Command::new(crate::stream_relay::resolve_dep_path(bin));
    cmd.arg(version_flag)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .stdin(std::process::Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.status().await.is_ok()
}

#[tauri::command]
pub async fn check_stream_deps() -> Result<DepsStatus, String> {
    let (streamlink, ffmpeg) = tokio::join!(
        is_on_path("streamlink", "--version"),
        is_on_path("ffmpeg", "-version"),
    );
    Ok(DepsStatus { streamlink, ffmpeg })
}

/// Installs whichever of streamlink/ffmpeg check_stream_deps() finds
/// missing, via winget - Windows only. winget has no equivalent on
/// macOS/Linux; those are covered by build-unix.sh and the README's
/// Homebrew/apt instructions instead, which is why this returns an
/// informative error rather than attempting anything on those platforms.
#[cfg(windows)]
#[tauri::command]
pub async fn install_stream_deps() -> Result<String, String> {
    let status = check_stream_deps().await?;
    let mut messages = Vec::new();

    if !status.streamlink {
        messages.push(run_winget_install("Streamlink.Streamlink", "streamlink").await?);
    }
    if !status.ffmpeg {
        messages.push(run_winget_install("Gyan.FFmpeg", "ffmpeg").await?);
    }

    if messages.is_empty() {
        return Ok("Already installed.".to_string());
    }

    // See refresh_current_process_path()'s comment - without this, the
    // newly-installed tools would be invisible to this already-running
    // process until it's restarted, even though winget succeeded.
    refresh_current_process_path().await?;
    messages.push("Ready to stream.".to_string());
    Ok(messages.join(" "))
}

#[cfg(not(windows))]
#[tauri::command]
pub async fn install_stream_deps() -> Result<String, String> {
    Err("Automatic install is only available on Windows (via winget). \
On macOS: brew install streamlink ffmpeg. \
On Linux: use your distro's package manager - see the README."
        .to_string())
}

#[cfg(windows)]
async fn run_winget_install(package_id: &str, display_name: &str) -> Result<String, String> {
    // Uninstall first, tolerating any failure (including "not found" -
    // that's the expected/common case, and fine). This exists because
    // winget's `install` auto-redirects to an upgrade attempt whenever
    // its own package database still has an entry for that id, even if
    // the actual files/PATH entry are long gone (e.g. removed by
    // something other than winget itself, like this project's own
    // uninstall-deps-windows scripts not fully deregistering it with
    // winget) - and when there's no newer version to upgrade TO, winget
    // treats that as a hard failure (APPINSTALLER_CLI_ERROR_UPDATE_-
    // NOT_APPLICABLE) instead of a no-op success, even though nothing
    // about the actual "is streamlink present and on PATH" question is
    // affected either way. Forcing a clean uninstall-then-install
    // sidesteps that state-mismatch entirely rather than trying to
    // detect and special-case every way winget's db can drift from
    // reality.
    let mut uninstall_cmd = Command::new("winget");
    uninstall_cmd.args(["uninstall", "--id", package_id, "-e", "--silent", "--accept-source-agreements"]);
    uninstall_cmd.creation_flags(CREATE_NO_WINDOW);
    let uninstall_output = uninstall_cmd.output().await;
    // Logged (stdout, visible in the `npm run tauri dev` terminal) AND
    // kept as a summary string for the final error message below -
    // needed either way, since the previous version silently discarded
    // this entirely, giving zero visibility into whether this step even
    // ran, found anything, or failed on its own, which is exactly what's
    // needed to diagnose why forcing a clean uninstall-then-install
    // didn't resolve the "already installed, no upgrade available"
    // error it was meant to fix. A built (non-dev) app has no visible
    // console for println! to reach, so the summary is also folded into
    // the error text itself rather than relying on the log alone.
    let uninstall_summary = match &uninstall_output {
        Ok(out) => {
            let combined = [
                String::from_utf8_lossy(&out.stdout).trim().to_string(),
                String::from_utf8_lossy(&out.stderr).trim().to_string(),
            ]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" | ");
            let summary = format!(
                "uninstall exit={:?}{}",
                out.status.code(),
                if combined.is_empty() { String::new() } else { format!(" ({combined})") }
            );
            println!("[deps_check] winget {summary}");
            summary
        }
        Err(e) => {
            let summary = format!("uninstall failed to spawn: {e}");
            println!("[deps_check] winget {summary}");
            summary
        }
    };

    let mut cmd = Command::new("winget");
    cmd.args([
        "install",
        "--id",
        package_id,
        "-e",
        "--accept-package-agreements",
        "--accept-source-agreements",
        "--silent",
    ]);
    cmd.creation_flags(CREATE_NO_WINDOW);
    let output = cmd.output().await.map_err(|e| {
        // Distinct from a nonzero exit below - this specifically means
        // winget itself couldn't even be spawned (ErrorKind::NotFound in
        // practice), i.e. it isn't installed. winget ships as "App
        // Installer" via the Microsoft Store and is preinstalled on
        // current Windows 10/11, but older/de-bloated Windows 10 images
        // can be missing it.
        format!(
            "Couldn't run winget ({e}) - it may not be installed. \
             Get it from the Microsoft Store (\"App Installer\"), or \
             install {display_name} manually."
        )
    })?;
    if output.status.success() {
        Ok(format!("Installed {display_name}."))
    } else {
        // winget frequently writes its actual diagnostic text ("No
        // package found matching input criteria", agreement prompts,
        // dependency errors, etc.) to STDOUT, not stderr - a previous
        // version of this only surfaced stderr, which is why the error
        // shown to the user came through with nothing useful after the
        // package name. Both streams are included now, plus the exit
        // code, so there's always something actionable to see even if
        // one stream is empty.
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let combined = [stdout.trim(), stderr.trim()]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" | ");
        let detail = if combined.is_empty() {
            // Both streams empty with a nonzero exit is a real winget
            // behavior, not a bug in this code - it can happen when
            // winget needs interactive elevation/UAC it didn't get
            // running as a hidden background process. Worth knowing if
            // this shows up: the fix would be re-spawning winget with
            // an explicit elevation request rather than anything
            // fixable by parsing output that was never produced.
            "no output from winget - it may need to run elevated \
             (try installing manually from an admin terminal instead)"
                .to_string()
        } else {
            combined
        };
        Err(format!(
            "winget failed installing {display_name} (exit code {}): {detail} [{uninstall_summary}]",
            output.status.code().map_or("unknown".to_string(), |c| c.to_string())
        ))
    }
}

/// Re-reads PATH from the registry (both the machine-wide and per-user
/// scopes, same two sources Windows itself merges when building a fresh
/// process's environment - see MS docs on environment variable
/// precedence) and applies the result to THIS process, so a subsequent
/// Command::new("streamlink")/("ffmpeg") call in this same running app
/// instance can immediately find what winget just installed.
///
/// winget updates the registry's PATH value, but per how Windows process
/// creation works, an already-running process keeps whatever PATH block
/// it was launched with - nothing re-reads the registry into a live
/// process automatically. Shells out to PowerShell's
/// [System.Environment]::GetEnvironmentVariable rather than adding a
/// registry-access crate (e.g. winreg) as a new Cargo dependency this
/// codebase can't currently verify compiles (no working Rust toolchain
/// new enough for this project's other dependencies was available where
/// this was written - see the project's own dev notes); this reuses the
/// same Command-spawning pattern already used throughout stream_relay.rs
/// instead of introducing a new kind of risk.
#[cfg(windows)]
async fn refresh_current_process_path() -> Result<(), String> {
    let mut cmd = Command::new("powershell");
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')",
    ]);
    cmd.creation_flags(CREATE_NO_WINDOW);
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to refresh PATH: {e}"))?;
    if !output.status.success() {
        return Err("Failed to read updated PATH from the registry".to_string());
    }
    let new_path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if new_path.is_empty() {
        // Don't apply an empty PATH - that would make EVERYTHING
        // unresolvable for the rest of this process's life, which is far
        // worse than just leaving the stale-but-nonempty PATH in place
        // and asking the user to restart the app instead.
        return Err("Registry PATH read came back empty - not applying".to_string());
    }
    std::env::set_var("PATH", new_path);
    Ok(())
}
