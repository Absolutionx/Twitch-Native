#!/usr/bin/env bash
# uninstall-deps-unix.sh — Remove streamlink and ffmpeg on macOS/Linux, for
# testing how the app behaves on a machine that doesn't have them (it
# resolves both purely via PATH - see resolve_streamlink_path() in
# stream_relay.rs - so this only needs to make `streamlink`/`ffmpeg`
# unresolvable, which uninstalling the real packages naturally does).
#
# Checks every common install method for each tool (a machine you've used
# for a while may have picked one up via more than one - e.g. both a
# system package AND a pip install shadowing it on PATH) and removes
# whichever are actually found, rather than assuming just one.
#
# Run from anywhere:
#   chmod +x uninstall-deps-unix.sh && ./uninstall-deps-unix.sh

set -uo pipefail   # NOT -e: a missing package manager/tool for one method
                    # shouldn't abort checking the rest

BOLD="\033[1m"
CYAN="\033[36m"
GREEN="\033[32m"
YELLOW="\033[33m"
RESET="\033[0m"

step() { echo -e "\n${BOLD}${CYAN}==> $1${RESET}"; }
ok()   { echo -e "${GREEN}$1${RESET}"; }
skip() { echo -e "${YELLOW}$1${RESET}"; }
has()  { command -v "$1" &>/dev/null; }

OS="$(uname -s)"

remove_streamlink() {
  step "Removing streamlink"
  local removed_any=false

  if has pipx && pipx list 2>/dev/null | grep -q streamlink; then
    pipx uninstall streamlink && removed_any=true
  fi
  if has pip3 && pip3 show streamlink &>/dev/null; then
    pip3 uninstall -y streamlink && removed_any=true
  fi
  if has pip && pip show streamlink &>/dev/null; then
    pip uninstall -y streamlink && removed_any=true
  fi
  if [[ "$OS" == "Darwin" ]] && has brew && brew list streamlink &>/dev/null; then
    brew uninstall streamlink && removed_any=true
  fi
  if [[ "$OS" == "Linux" ]] && has apt-get && dpkg -l streamlink &>/dev/null; then
    sudo apt-get remove -y streamlink && removed_any=true
  fi
  if [[ "$OS" == "Linux" ]] && has snap && snap list streamlink &>/dev/null; then
    sudo snap remove streamlink && removed_any=true
  fi

  if [[ "$removed_any" == false ]]; then
    skip "streamlink not found via pipx/pip/brew/apt/snap - nothing to remove"
  fi
}

remove_ffmpeg() {
  step "Removing ffmpeg"
  local removed_any=false

  if [[ "$OS" == "Darwin" ]] && has brew && brew list ffmpeg &>/dev/null; then
    brew uninstall ffmpeg && removed_any=true
  fi
  if [[ "$OS" == "Linux" ]] && has apt-get && dpkg -l ffmpeg &>/dev/null; then
    sudo apt-get remove -y ffmpeg && removed_any=true
  fi
  if [[ "$OS" == "Linux" ]] && has snap && snap list ffmpeg &>/dev/null; then
    sudo snap remove ffmpeg && removed_any=true
  fi
  if [[ "$OS" == "Linux" ]] && has dnf && rpm -q ffmpeg &>/dev/null; then
    sudo dnf remove -y ffmpeg && removed_any=true
  fi

  if [[ "$removed_any" == false ]]; then
    skip "ffmpeg not found via brew/apt/snap/dnf - nothing to remove"
  fi
}

remove_streamlink
remove_ffmpeg

step "Verifying PATH is clean"
for bin in streamlink ffmpeg; do
  if has "$bin"; then
    skip "$bin is STILL resolvable at: $(command -v "$bin")"
    skip "  (may be a manual install outside a package manager, or a shell"
    skip "   hash cache - try opening a fresh terminal, or check with"
    skip "   'type -a $bin' to see every match on PATH)"
  else
    ok "$bin is no longer on PATH"
  fi
done

echo -e "\nDone. Launch the app now to test its behavior without these installed."
echo "To restore them later, see build-unix.sh's dependency-install steps."
