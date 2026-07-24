# build-windows.ps1 - Bootstrap and build the Twitch app installer on Windows.
# Run from the project root in an elevated PowerShell window:
#   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#   .\build-windows.ps1
#
# What this does:
#   1. Installs winget packages: Rust toolchain, Node.js, and VS Build Tools
#   2. Installs npm dependencies
#   3. Runs `npm run tauri build`
#   4. Prints the path to the finished .msi and .exe installers
#
# End users who install the output .msi / .exe need NONE of this -
# the installer is fully self-contained (WebView2 is bundled if missing).

Set-StrictMode -Version Latest
$ErrorActionPreference = "Continue"

function Step($msg) {
    Write-Host "`n==> $msg" -ForegroundColor Cyan
}

function Has($cmd) {
    return [bool](Get-Command $cmd -ErrorAction SilentlyContinue)
}

# ---------------------------------------------------------------------------
# 1. Winget
# ---------------------------------------------------------------------------
Step "Checking winget"
if (-not (Has "winget")) {
    Write-Error "winget not found. Install App Installer from the Microsoft Store, then re-run this script."
    exit 1
}

# ---------------------------------------------------------------------------
# 2. Node.js
# ---------------------------------------------------------------------------
Step "Checking Node.js"
if (-not (Has "node")) {
    Write-Host "Installing Node.js LTS via winget..."
    winget install --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements -e
    # Refresh PATH for this session
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("Path","User")
} else {
    Write-Host "Node.js already installed: $(node --version)"
}

# ---------------------------------------------------------------------------
# 3. Rust
# ---------------------------------------------------------------------------
Step "Checking Rust"
if (-not (Has "rustup")) {
    Write-Host "Installing Rust via rustup-init..."
    $rustupUrl = "https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe"
    $rustupExe = "$env:TEMP\rustup-init.exe"
    Invoke-WebRequest -Uri $rustupUrl -OutFile $rustupExe
    & $rustupExe -y --default-toolchain stable
    # Refresh PATH
    $env:Path = "$env:USERPROFILE\.cargo\bin;" + $env:Path
} else {
    Write-Host "Rust already installed: $(rustup --version)"
    rustup update stable
}

# ---------------------------------------------------------------------------
# 4. Microsoft C++ Build Tools (required by Rust on Windows)
# ---------------------------------------------------------------------------
Step "Checking MSVC build tools"
$vsWhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$hasMsvc = (Test-Path $vsWhere) -and (
    & $vsWhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
)
if (-not $hasMsvc) {
    Write-Host "Installing Microsoft C++ Build Tools (this may take a few minutes)..."
    winget install --id Microsoft.VisualStudio.2022.BuildTools `
        --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended" `
        --accept-package-agreements --accept-source-agreements
} else {
    Write-Host "MSVC build tools already installed."
}

# ---------------------------------------------------------------------------
# 5. WebView2 runtime (usually pre-installed on Win10 21H2+ and Win11)
# ---------------------------------------------------------------------------
Step "Checking WebView2 runtime"
$wv2Key = "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
if (-not (Test-Path $wv2Key)) {
    Write-Host "Installing WebView2 runtime..."
    $wv2Url = "https://go.microsoft.com/fwlink/p/?LinkId=2124703"
    $wv2Exe = "$env:TEMP\MicrosoftEdgeWebview2Setup.exe"
    Invoke-WebRequest -Uri $wv2Url -OutFile $wv2Exe
    & $wv2Exe /silent /install
} else {
    Write-Host "WebView2 runtime already installed."
}



# ---------------------------------------------------------------------------
# 6. npm install
# ---------------------------------------------------------------------------
Step "Installing npm dependencies"
npm install

# ---------------------------------------------------------------------------
# 7. Tauri build
# ---------------------------------------------------------------------------
Step "Building installer (this takes a few minutes on first run while Rust compiles)"
npm run tauri build
$buildExitCode = $LASTEXITCODE

# ---------------------------------------------------------------------------
# 8. Report output locations
# ---------------------------------------------------------------------------
Step "Build complete - installer locations:"
$bundleDir = "src-tauri\target\release\bundle"
$msi   = Get-ChildItem "$bundleDir\msi\*.msi"   -ErrorAction SilentlyContinue
$nsis  = Get-ChildItem "$bundleDir\nsis\*.exe"   -ErrorAction SilentlyContinue

foreach ($f in @($msi, $nsis)) {
    if ($f) { Write-Host "  $($f.FullName)" -ForegroundColor Green }
}

Write-Host "`nShare either file - end users just double-click to install, no setup required." -ForegroundColor Green

if ($buildExitCode -ne 0) {
    Write-Host "`nNote: build exited with code $buildExitCode - check output above for errors." -ForegroundColor Yellow
    exit $buildExitCode
}
