@echo off
REM uninstall-deps-windows.bat - Remove streamlink and ffmpeg on Windows,
REM for testing how the app behaves on a machine that doesn't have them
REM (it resolves both purely via PATH - see resolve_streamlink_path() in
REM stream_relay.rs - so this only needs to make streamlink/ffmpeg
REM unresolvable, which uninstalling the real packages naturally does).
REM
REM Checks every common install method for each tool (winget, pip/pipx,
REM choco, scoop) and removes whichever are actually found, rather than
REM assuming just one - a machine you've used a while may have picked one
REM up via more than one of these.
REM
REM Right-click this file and "Run as administrator" (winget/choco/scoop
REM uninstalls of system-wide packages need it; skip if you know yours
REM are user-scoped installs).

setlocal enabledelayedexpansion

echo.
echo ==^> Removing streamlink
echo.

set FOUND_STREAMLINK=0

where winget >nul 2>nul
if %errorlevel% equ 0 (
    winget list --id Streamlink.Streamlink -e >nul 2>nul
    if !errorlevel! equ 0 (
        winget uninstall --id Streamlink.Streamlink -e
        set FOUND_STREAMLINK=1
    )
)

where pipx >nul 2>nul
if %errorlevel% equ 0 (
    pipx list 2>nul | findstr /i "streamlink" >nul
    if !errorlevel! equ 0 (
        pipx uninstall streamlink
        set FOUND_STREAMLINK=1
    )
)

where pip >nul 2>nul
if %errorlevel% equ 0 (
    pip show streamlink >nul 2>nul
    if !errorlevel! equ 0 (
        pip uninstall -y streamlink
        set FOUND_STREAMLINK=1
    )
)

where choco >nul 2>nul
if %errorlevel% equ 0 (
    choco list --local-only streamlink 2>nul | findstr /i "streamlink" >nul
    if !errorlevel! equ 0 (
        choco uninstall streamlink -y
        set FOUND_STREAMLINK=1
    )
)

where scoop >nul 2>nul
if %errorlevel% equ 0 (
    scoop list streamlink 2>nul | findstr /i "streamlink" >nul
    if !errorlevel! equ 0 (
        scoop uninstall streamlink
        set FOUND_STREAMLINK=1
    )
)

if !FOUND_STREAMLINK! equ 0 (
    echo streamlink not found via winget/pipx/pip/choco/scoop - nothing to remove
)

echo.
echo ==^> Removing ffmpeg
echo.

set FOUND_FFMPEG=0

where winget >nul 2>nul
if %errorlevel% equ 0 (
    winget list --id Gyan.FFmpeg -e >nul 2>nul
    if !errorlevel! equ 0 (
        winget uninstall --id Gyan.FFmpeg -e
        set FOUND_FFMPEG=1
    )
    winget list --id BtbN.FFmpeg -e >nul 2>nul
    if !errorlevel! equ 0 (
        winget uninstall --id BtbN.FFmpeg -e
        set FOUND_FFMPEG=1
    )
)

where choco >nul 2>nul
if %errorlevel% equ 0 (
    choco list --local-only ffmpeg 2>nul | findstr /i "ffmpeg" >nul
    if !errorlevel! equ 0 (
        choco uninstall ffmpeg -y
        set FOUND_FFMPEG=1
    )
)

where scoop >nul 2>nul
if %errorlevel% equ 0 (
    scoop list ffmpeg 2>nul | findstr /i "ffmpeg" >nul
    if !errorlevel! equ 0 (
        scoop uninstall ffmpeg
        set FOUND_FFMPEG=1
    )
)

if !FOUND_FFMPEG! equ 0 (
    echo ffmpeg not found via winget/choco/scoop - nothing to remove
    echo   ^(if it was installed by manually dropping ffmpeg.exe onto PATH,
    echo    no package manager will know about it - remove that folder
    echo    from PATH by hand, e.g. via "Edit environment variables"^)
)

echo.
echo ==^> Verifying PATH is clean
echo.

where streamlink >nul 2>nul
if %errorlevel% equ 0 (
    echo streamlink is STILL resolvable:
    where streamlink
    echo   ^(may be a manual install outside a package manager - remove its
    echo    folder from PATH by hand, then open a fresh Command Prompt^)
) else (
    echo streamlink is no longer on PATH
)

where ffmpeg >nul 2>nul
if %errorlevel% equ 0 (
    echo ffmpeg is STILL resolvable:
    where ffmpeg
    echo   ^(may be a manual install outside a package manager - remove its
    echo    folder from PATH by hand, then open a fresh Command Prompt^)
) else (
    echo ffmpeg is no longer on PATH
)

echo.
echo Done. Launch the app now to test its behavior without these installed.
echo To restore them later, see build-windows.ps1's dependency-install steps.
echo.
pause
