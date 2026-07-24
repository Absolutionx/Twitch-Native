#!/usr/bin/env bash
# build-unix.sh — Bootstrap and build the Twitch app installer on macOS or Linux.
# Run from the project root:
#   chmod +x build-unix.sh && ./build-unix.sh
#
# What this does:
#   1. Installs system dependencies (Linux: apt; macOS: Homebrew + Xcode CLT)
#   2. Installs Rust via rustup if missing
#   3. Installs Node.js if missing
#   4. Installs npm dependencies
#   5. Runs `npm run tauri build`
#   6. Prints the path to the finished installer
#
# End users who install the output package need NONE of this.

set -euo pipefail

BOLD="\033[1m"
CYAN="\033[36m"
GREEN="\033[32m"
RESET="\033[0m"

step() { echo -e "\n${BOLD}${CYAN}==> $1${RESET}"; }
ok()   { echo -e "${GREEN}$1${RESET}"; }
has()  { command -v "$1" &>/dev/null; }

OS="$(uname -s)"

# ---------------------------------------------------------------------------
# 1. System dependencies
# ---------------------------------------------------------------------------
step "Installing system dependencies"

if [[ "$OS" == "Linux" ]]; then
    if ! has apt-get; then
        echo "This script supports Debian/Ubuntu. On other distros, install the"
        echo "equivalents of: libwebkit2gtk-4.1-dev libxdo-dev libssl-dev"
        echo "libayatana-appindicator3-dev librsvg2-dev build-essential curl"
        exit 1
    fi
    sudo apt-get update -q
    sudo apt-get install -y \
        libwebkit2gtk-4.1-dev \
        libxdo-dev \
        libssl-dev \
        libayatana-appindicator3-dev \
        librsvg2-dev \
        build-essential \
        curl \
        wget \
        file \
        patchelf

elif [[ "$OS" == "Darwin" ]]; then
    # Xcode Command Line Tools
    if ! xcode-select -p &>/dev/null; then
        step "Installing Xcode Command Line Tools"
        xcode-select --install
        echo "Re-run this script after the Xcode CLT installation completes."
        exit 0
    fi
    ok "Xcode CLT already installed."
fi

# ---------------------------------------------------------------------------
# 2. Rust
# ---------------------------------------------------------------------------
step "Checking Rust"
if ! has rustup; then
    echo "Installing Rust via rustup..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
    # Source cargo env for the rest of this script
    # shellcheck source=/dev/null
    source "$HOME/.cargo/env"
else
    ok "Rust already installed: $(rustup --version)"
    rustup update stable
fi

# Make sure cargo is on PATH even if rustup was already installed
export PATH="$HOME/.cargo/bin:$PATH"

# ---------------------------------------------------------------------------
# 3. Node.js
# ---------------------------------------------------------------------------
step "Checking Node.js"
if ! has node; then
    if [[ "$OS" == "Darwin" ]]; then
        if ! has brew; then
            echo "Installing Homebrew..."
            /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
        fi
        brew install node
    else
        # Use NodeSource for Debian/Ubuntu
        curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
        sudo apt-get install -y nodejs
    fi
else
    ok "Node.js already installed: $(node --version)"
fi

# ---------------------------------------------------------------------------
# 4. npm install
# ---------------------------------------------------------------------------
step "Installing npm dependencies"
npm install

# ---------------------------------------------------------------------------
# 5. Tauri build
# ---------------------------------------------------------------------------
step "Building installer (first run compiles all Rust dependencies — takes a few minutes)"
npm run tauri build

# ---------------------------------------------------------------------------
# 6. Report output locations
# ---------------------------------------------------------------------------
step "Build complete — installer locations:"
BUNDLE="src-tauri/target/release/bundle"

if [[ "$OS" == "Darwin" ]]; then
    find "$BUNDLE/dmg" -name "*.dmg" 2>/dev/null | while read -r f; do
        ok "  $f"
    done
    # macOS app bundle (unpackaged, for local testing)
    find "$BUNDLE/macos" -name "*.app" 2>/dev/null | while read -r f; do
        ok "  $f  (app bundle — share the .dmg above for distribution)"
    done
else
    find "$BUNDLE/deb"      -name "*.deb"      2>/dev/null | while read -r f; do ok "  $f"; done
    find "$BUNDLE/appimage" -name "*.AppImage" 2>/dev/null | while read -r f; do ok "  $f"; done
    find "$BUNDLE/rpm"      -name "*.rpm"      2>/dev/null | while read -r f; do ok "  $f"; done
fi

echo ""
ok "Share the installer above — end users just open it to install, no setup required."
