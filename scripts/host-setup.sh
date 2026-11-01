#!/usr/bin/env bash
# host-setup.sh — make this Mac or Linux machine a Tapdance device host in one command.
#
# If the `tapdance` command is missing, it installs Tapdance from source (git clone, corepack pnpm
# install, build, and a symlink in ~/.local/bin), then runs `tapdance host up` with every argument you
# pass, for example:
#
#   bash scripts/host-setup.sh --label my-vps
#
# It installs no SDKs, never uses sudo, and never prints or stores tokens itself: `tapdance host up`
# writes the pairing token to a mode-600 file and prints only its path.
#
# Settings (environment variables):
#   TAPDANCE_REPO        git URL to clone   (default: https://github.com/mirzemehdi/tapdance)
#   TAPDANCE_REF         branch or tag      (default: main)
#   TAPDANCE_SOURCE_DIR  checkout directory (default: ~/tapdance)
#
# Status: checked with `bash -n` only. Not yet run end to end on a fresh machine (see STATUS.md).
# Windows: use scripts/host-setup.ps1, which explains the options.

set -euo pipefail

REPO="${TAPDANCE_REPO:-https://github.com/mirzemehdi/tapdance}"
REF="${TAPDANCE_REF:-main}"
SRC="${TAPDANCE_SOURCE_DIR:-$HOME/tapdance}"
BIN_DIR="$HOME/.local/bin"

die() { printf 'host-setup: %s\n' "$*" >&2; exit 1; }
say() { printf 'host-setup: %s\n' "$*" >&2; }

case "$(uname -s)" in
  Darwin|Linux) ;;
  *) die "this script runs on macOS or Linux. On Windows run scripts/host-setup.ps1 for your options." ;;
esac

if [[ ${EUID:-$(id -u)} -eq 0 ]]; then
  die "run it as the user that will own the worker, not as root."
fi

TAPDANCE=()
if command -v tapdance >/dev/null 2>&1 && tapdance host --help >/dev/null 2>&1; then
  TAPDANCE=(tapdance)
else
  command -v git >/dev/null 2>&1 || die "git is required (macOS: xcode-select --install; Linux: your package manager)."
  command -v node >/dev/null 2>&1 || die "Node.js 22.13 or later is required (https://nodejs.org)."
  NODE_VERSION="$(node -p 'process.versions.node')"
  NODE_MAJOR="${NODE_VERSION%%.*}"
  NODE_MINOR="${NODE_VERSION#*.}"; NODE_MINOR="${NODE_MINOR%%.*}"
  if (( NODE_MAJOR < 22 || (NODE_MAJOR == 22 && NODE_MINOR < 13) )); then
    die "Node.js $NODE_VERSION is too old; Tapdance needs 22.13 or later."
  fi
  command -v corepack >/dev/null 2>&1 || die "corepack is missing from this Node.js install; install Node.js from nodejs.org (it ships corepack)."

  if [[ -d "$SRC/.git" ]]; then
    say "using the existing checkout in $SRC (not updating it; run git pull there yourself)"
  elif [[ -e "$SRC" ]]; then
    die "$SRC exists and is not a git checkout; set TAPDANCE_SOURCE_DIR to another directory."
  else
    say "cloning $REPO ($REF) into $SRC"
    git clone --branch "$REF" --depth 1 "$REPO" "$SRC"
  fi

  say "installing dependencies and building (corepack pnpm)"
  export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  (cd "$SRC" && corepack pnpm install --frozen-lockfile && corepack pnpm build)

  MAIN="$SRC/packages/cli/dist/main.js"
  [[ -f "$MAIN" ]] || die "the build did not produce $MAIN"
  chmod +x "$MAIN"
  mkdir -p "$BIN_DIR"
  ln -sf "$MAIN" "$BIN_DIR/tapdance"
  say "linked $BIN_DIR/tapdance -> $MAIN"
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) say "add $BIN_DIR to your PATH to use the tapdance command in new shells" ;;
  esac
  TAPDANCE=(node "$MAIN")
fi

exec "${TAPDANCE[@]}" host up "$@"
