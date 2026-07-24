# uninstall-deps-windows.ps1 - Remove streamlink and ffmpeg on Windows, for
# testing how the app behaves on a machine that doesn't have them (it
# resolves both purely via PATH - see resolve_streamlink_path() in
# stream_relay.rs - so this only needs to make `streamlink`/`ffmpeg`
# unresolvable, which uninstalling the real packages naturally does).
#
# Checks every common install method for each tool (winget, pip/pipx,
# choco, scoop) and removes whichever are actually found, rather than
# assuming just one - a machine you've used for a while may have picked
# one up via more than one of these.
#
# Run from an elevated PowerShell window:
#   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#   .\uninstall-deps-windows.ps1

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host $msg -ForegroundColor Green }
function Skip($msg) { Write-Host $msg -ForegroundColor Yellow }
function Has($cmd)  { return [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

function Remove-Streamlink {
    Step "Removing streamlink"
    $removedAny = $false

    if (Has "winget") {
        $installed = winget list --id Streamlink.Streamlink -e 2>$null
        if ($installed -match "Streamlink") {
            winget uninstall --id Streamlink.Streamlink -e
            $removedAny = $true
        }
    }
    if (Has "pipx") {
        $pipxList = pipx list 2>$null
        if ($pipxList -match "streamlink") {
            pipx uninstall streamlink
            $removedAny = $true
        }
    }
    if (Has "pip") {
        $pipShow = pip show streamlink 2>$null
        if ($pipShow) {
            pip uninstall -y streamlink
            $removedAny = $true
        }
    }
    if (Has "choco") {
        $chocoList = choco list --local-only streamlink 2>$null
        if ($chocoList -match "streamlink") {
            choco uninstall streamlink -y
            $removedAny = $true
        }
    }
    if (Has "scoop") {
        $scoopList = scoop list streamlink 2>$null
        if ($scoopList -match "streamlink") {
            scoop uninstall streamlink
            $removedAny = $true
        }
    }

    if (-not $removedAny) {
        Skip "streamlink not found via winget/pipx/pip/choco/scoop - nothing to remove"
    }
}

function Remove-Ffmpeg {
    Step "Removing ffmpeg"
    $removedAny = $false

    if (Has "winget") {
        $installed = winget list --id Gyan.FFmpeg -e 2>$null
        if ($installed -match "FFmpeg") {
            winget uninstall --id Gyan.FFmpeg -e
            $removedAny = $true
        }
        # Some machines have it under the alternate BtbN/ffmpeg package id
        $installedAlt = winget list --id BtbN.FFmpeg -e 2>$null
        if ($installedAlt -match "FFmpeg") {
            winget uninstall --id BtbN.FFmpeg -e
            $removedAny = $true
        }
    }
    if (Has "choco") {
        $chocoList = choco list --local-only ffmpeg 2>$null
        if ($chocoList -match "ffmpeg") {
            choco uninstall ffmpeg -y
            $removedAny = $true
        }
    }
    if (Has "scoop") {
        $scoopList = scoop list ffmpeg 2>$null
        if ($scoopList -match "ffmpeg") {
            scoop uninstall ffmpeg
            $removedAny = $true
        }
    }

    if (-not $removedAny) {
        Skip "ffmpeg not found via winget/choco/scoop - nothing to remove"
        Skip "  (if it was installed by manually dropping ffmpeg.exe onto PATH,"
        Skip "   no package manager will know about it - remove that folder"
        Skip "   from PATH by hand, e.g. via 'Edit environment variables')"
    }
}

Remove-Streamlink
Remove-Ffmpeg

Step "Verifying PATH is clean"
foreach ($bin in @("streamlink", "ffmpeg")) {
    if (Has $bin) {
        $loc = (Get-Command $bin).Source
        Skip "$bin is STILL resolvable at: $loc"
        Skip "  (may be a manual install outside a package manager - remove"
        Skip "   its folder from PATH by hand, then open a fresh terminal)"
    } else {
        Ok "$bin is no longer on PATH"
    }
}

Write-Host "`nDone. Launch the app now to test its behavior without these installed." -ForegroundColor Green
Write-Host "To restore them later, see build-windows.ps1's dependency-install steps." -ForegroundColor Green
