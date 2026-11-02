#!/usr/bin/env bash
# host-setup.sh — make this Mac or Linux machine a Tapdance device host in one command:
#
#   curl -fsSL https://raw.githubusercontent.com/mirzemehdi/tapdance/main/scripts/host-setup.sh | bash -s -- --label my-mac
#
# 1. Checks the prerequisites: Node.js 22.13+, git, a JDK 17+, the Android SDK (command-line tools,
#    platform-tools, emulator, a Google Play system image), Tailscale, and on Linux KVM access. Xcode is
#    optional (iOS); it cannot be installed from a script.
# 2. Lists what is missing and asks once (or --yes). Then installs from the official sources, each
#    download checked against the checksum its publisher lists:
#      Node.js   nodejs.org tarball (SHASUMS256)            -> ~/.local/share/tapdance/node
#      JDK 17    Eclipse Temurin from api.adoptium.net       -> ~/Library/Java/JavaVirtualMachines (macOS)
#                                                               or ~/.local/share/tapdance/jdk (Linux)
#      Android   Google's command-line tools (repository XML SHA-1), then sdkmanager installs
#                platform-tools, emulator and the system image -> ~/Library/Android/sdk or ~/Android/Sdk.
#                Accepting the Android SDK licenses is part of this step.
#      Tailscale macOS: `brew install --cask tailscale` when Homebrew is there; Linux: tailscale.com's
#                installer (it uses sudo). You log in yourself; the script prints how.
#    Only system packages (Linux: git, unzip; Tailscale) and the kvm group use sudo, and only after you
#    said yes. Everything else goes into your home folder.
# 3. Installs Tapdance from source if the `tapdance` command is missing (git clone, corepack pnpm,
#    build, a link in ~/.local/bin), then runs `tapdance host up` with your other arguments.
#
# Its own options (everything else goes to `tapdance host up`):
#   --yes                install without asking (also passed on to host up)
#   --check              only report what is missing; change nothing
#   --skip-prerequisites do not check or install prerequisites
#   --prerequisites-only install the prerequisites, then stop (no Tapdance install, no host up)
#   --no-system-image    do not install the Android system image (about 1.5 GB)
#
# Settings: TAPDANCE_REPO (git URL; an SSH URL works for a private repository), TAPDANCE_REF (main),
# TAPDANCE_SOURCE_DIR (~/tapdance), ANDROID_API (34), ANDROID_TAG (google_apis_playstore).
# The script never prints or stores tokens: `tapdance host up` writes the pairing token to a mode-600
# file and prints only its path. Windows: use scripts/host-setup.ps1, which explains the options.

set -euo pipefail

REPO="${TAPDANCE_REPO:-https://github.com/mirzemehdi/tapdance}"
REF="${TAPDANCE_REF:-main}"
SRC="${TAPDANCE_SOURCE_DIR:-$HOME/tapdance}"
BIN_DIR="$HOME/.local/bin"
SHARE="$HOME/.local/share/tapdance"
ENV_FILE="$HOME/.tapdance/env.sh"
API="${ANDROID_API:-34}"
TAG="${ANDROID_TAG:-google_apis_playstore}"

die() { printf 'host-setup: %s\n' "$*" >&2; exit 1; }
say() { printf 'host-setup: %s\n' "$*" >&2; }

YES=0; CHECK=0; SKIP_PREREQ=0; ONLY_PREREQ=0; NO_IMAGE=0; PASS=()
for arg in "$@"; do
  case "$arg" in
    --yes|-y) YES=1; PASS+=("--yes") ;;
    --check) CHECK=1 ;;
    --skip-prerequisites) SKIP_PREREQ=1 ;;
    --prerequisites-only) ONLY_PREREQ=1 ;;
    --no-system-image) NO_IMAGE=1 ;;
    *) PASS+=("$arg") ;;
  esac
done

OS="$(uname -s)"
case "$OS" in
  Darwin|Linux) ;;
  *) die "this script runs on macOS or Linux. On Windows run scripts/host-setup.ps1 for your options." ;;
esac
[[ ${EUID:-$(id -u)} -ne 0 ]] || die "run it as the user that will own the worker, not as root."
case "$(uname -m)" in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64|amd64) ARCH=x64 ;;
  *) die "unsupported CPU $(uname -m)" ;;
esac
if [[ "$OS" == Darwin ]]; then SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"; else SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}"; fi
ABI="$([[ $ARCH == arm64 ]] && echo arm64-v8a || echo x86_64)"
IMAGE="system-images;android-$API;$TAG;$ABI"

mkdir -p "$BIN_DIR"
export PATH="$BIN_DIR:$SHARE/node/bin:$PATH"
[[ -f "$ENV_FILE" ]] && . "$ENV_FILE"

# ---------------------------------------------------------------- checks

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local v; v="$(node -p 'process.versions.node')"; local major="${v%%.*}" rest="${v#*.}"; local minor="${rest%%.*}"
  (( major > 22 || (major == 22 && minor >= 13) ))
}
java_home() {
  if [[ -n "${JAVA_HOME:-}" && -x "$JAVA_HOME/bin/java" ]]; then echo "$JAVA_HOME"; return; fi
  if [[ "$OS" == Darwin ]]; then /usr/libexec/java_home -v 17+ 2>/dev/null && return; fi
  [[ -x "$SHARE/jdk/bin/java" ]] && { echo "$SHARE/jdk"; return; }
  return 1
}
jdk_ok() {
  local home; home="$(java_home)" || return 1
  local v; v="$("$home/bin/java" -version 2>&1 | head -1 | sed -E 's/.*version "([0-9]+).*/\1/')"
  [[ "$v" =~ ^[0-9]+$ ]] && (( v >= 17 ))
}
cmdline_ok() { [[ -x "$SDK/cmdline-tools/latest/bin/sdkmanager" ]]; }
pkg_ok() { [[ -d "$SDK/$1" ]]; }
image_ok() { [[ -d "$SDK/system-images/android-$API/$TAG/$ABI" ]]; }
tailscale_bin() {
  command -v tailscale 2>/dev/null && return
  [[ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]] && echo /Applications/Tailscale.app/Contents/MacOS/Tailscale && return
  return 1
}

MISSING=(); SUDO_STEPS=(); NOTES=()
check_all() {
  MISSING=(); SUDO_STEPS=(); NOTES=()
  node_ok || MISSING+=("node")
  if ! command -v git >/dev/null 2>&1; then
    if [[ "$OS" == Darwin ]]; then NOTES+=("git: run \`xcode-select --install\` (Apple's Command Line Tools), then this script again"); else MISSING+=("git"); SUDO_STEPS+=("git"); fi
  fi
  if [[ "$OS" == Linux ]] && ! command -v unzip >/dev/null 2>&1; then MISSING+=("unzip"); SUDO_STEPS+=("unzip"); fi
  jdk_ok || MISSING+=("jdk")
  cmdline_ok || MISSING+=("android-cmdline-tools")
  pkg_ok platform-tools || MISSING+=("platform-tools")
  # Without KVM no emulator can run on Linux: skip the emulator and its ~1.5 GB image.
  local no_kvm=0
  [[ "$OS" == Linux && ! -e /dev/kvm ]] && no_kvm=1
  if (( ! no_kvm )); then
    pkg_ok emulator || MISSING+=("emulator")
    (( NO_IMAGE )) || image_ok || MISSING+=("system-image")
  fi
  tailscale_bin >/dev/null || { MISSING+=("tailscale"); [[ "$OS" == Linux ]] && SUDO_STEPS+=("tailscale"); }
  if [[ "$OS" == Linux ]]; then
    if [[ ! -e /dev/kvm ]]; then
      NOTES+=("KVM: /dev/kvm is missing, so Android emulators cannot run here (a cloud VM without nested virtualization, or virtualization off in the BIOS); the emulator and system image are skipped. This machine can still be a control machine: tapdance connect <host endpoint> < pairing-<label>.token")
    elif [[ ! -r /dev/kvm || ! -w /dev/kvm ]]; then
      MISSING+=("kvm-group"); SUDO_STEPS+=("kvm-group")
    fi
  fi
  if [[ "$OS" == Darwin ]] && ! xcrun simctl help >/dev/null 2>&1; then
    NOTES+=("Xcode (optional, for iOS simulators): install it from the App Store; Android works without it")
  fi
}

describe() {
  case "$1" in
    node) echo "Node.js 22 LTS (nodejs.org tarball into $SHARE/node)" ;;
    git) echo "git (system package, sudo)" ;;
    unzip) echo "unzip (system package, sudo)" ;;
    jdk) [[ "$OS" == Darwin ]] && echo "JDK 17 (Eclipse Temurin into ~/Library/Java/JavaVirtualMachines)" || echo "JDK 17 (Eclipse Temurin into $SHARE/jdk)" ;;
    android-cmdline-tools) echo "Android command-line tools (Google, into $SDK/cmdline-tools/latest)" ;;
    platform-tools) echo "Android platform-tools (sdkmanager; accepts the Android SDK licenses)" ;;
    emulator) echo "Android emulator (sdkmanager)" ;;
    system-image) echo "Android system image $IMAGE (sdkmanager, about 1.5 GB)" ;;
    tailscale) [[ "$OS" == Darwin ]] && echo "Tailscale (Homebrew cask; you log in afterwards)" || echo "Tailscale (tailscale.com installer, sudo; you log in afterwards)" ;;
    kvm-group) echo "add $(id -un) to the kvm group (sudo; log out and in afterwards)" ;;
  esac
}

ask() {
  (( YES )) && return 0
  # Piped through curl, stdin is this script: ask on the terminal.
  [[ -r /dev/tty ]] || die "no terminal to ask on; run again with --yes to install, or --check to only report"
  printf '%s [y/N] ' "$1" > /dev/tty
  local answer; read -r answer < /dev/tty
  [[ "$answer" =~ ^[Yy] ]]
}

# ---------------------------------------------------------------- installs

fetch() { curl -fsSL --retry 3 -o "$2" "$1"; }
sha_of() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
sha1_of() { if command -v sha1sum >/dev/null 2>&1; then sha1sum "$1" | cut -d' ' -f1; else shasum -a 1 "$1" | cut -d' ' -f1; fi; }
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

install_node() {
  local os; os="$([[ "$OS" == Darwin ]] && echo darwin || echo linux)"
  local base="https://nodejs.org/dist/latest-v22.x"
  fetch "$base/SHASUMS256.txt" "$TMP/SHASUMS256.txt"
  local line; line="$(grep -E " node-v22\.[0-9.]+-$os-$ARCH\.tar\.gz$" "$TMP/SHASUMS256.txt" | head -1)"
  [[ -n "$line" ]] || die "no Node.js 22 build for $os-$ARCH on nodejs.org"
  local sum="${line%% *}" file="${line##* }"
  say "downloading $file"
  fetch "$base/$file" "$TMP/$file"
  [[ "$(sha_of "$TMP/$file")" == "$sum" ]] || die "checksum mismatch for $file"
  rm -rf "$SHARE/node" && mkdir -p "$SHARE/node"
  tar -xzf "$TMP/$file" -C "$SHARE/node" --strip-components=1
  for b in node npm npx corepack; do ln -sf "$SHARE/node/bin/$b" "$BIN_DIR/$b"; done
  hash -r
}

install_jdk() {
  local os; os="$([[ "$OS" == Darwin ]] && echo mac || echo linux)"
  local arch; arch="$([[ $ARCH == arm64 ]] && echo aarch64 || echo x64)"
  fetch "https://api.adoptium.net/v3/assets/latest/17/hotspot?os=$os&architecture=$arch&image_type=jdk&vendor=eclipse" "$TMP/jdk.json"
  local link sum name
  link="$(node -e 'const a=JSON.parse(require("fs").readFileSync(process.argv[1]));const p=a[0].binary.package;console.log(p.link)' "$TMP/jdk.json")"
  sum="$(node -e 'const a=JSON.parse(require("fs").readFileSync(process.argv[1]));console.log(a[0].binary.package.checksum)' "$TMP/jdk.json")"
  name="$(node -e 'const a=JSON.parse(require("fs").readFileSync(process.argv[1]));console.log(a[0].binary.package.name)' "$TMP/jdk.json")"
  [[ "$link" == https://github.com/adoptium/* ]] || die "unexpected JDK download location: $link"
  say "downloading $name"
  fetch "$link" "$TMP/$name"
  [[ "$(sha_of "$TMP/$name")" == "$sum" ]] || die "checksum mismatch for $name"
  mkdir -p "$TMP/jdk" && tar -xzf "$TMP/$name" -C "$TMP/jdk"
  local top; top="$(ls "$TMP/jdk" | head -1)"
  if [[ "$OS" == Darwin ]]; then
    # The user's own JavaVirtualMachines folder: /usr/libexec/java_home (and so the Android tools) finds it.
    mkdir -p "$HOME/Library/Java/JavaVirtualMachines"
    rm -rf "$HOME/Library/Java/JavaVirtualMachines/$top"
    mv "$TMP/jdk/$top" "$HOME/Library/Java/JavaVirtualMachines/"
    export JAVA_HOME="$HOME/Library/Java/JavaVirtualMachines/$top/Contents/Home"
  else
    rm -rf "$SHARE/jdk" && mkdir -p "$SHARE" && mv "$TMP/jdk/$top" "$SHARE/jdk"
    export JAVA_HOME="$SHARE/jdk"
  fi
}

install_cmdline_tools() {
  local host; host="$([[ "$OS" == Darwin ]] && echo macosx || echo linux)"
  fetch "https://dl.google.com/android/repository/repository2-3.xml" "$TMP/repo.xml"
  # The newest cmdline-tools archive for this host, with the SHA-1 Google lists next to it.
  local pick; pick="$(node -e '
    const xml = require("fs").readFileSync(process.argv[1], "utf8");
    const pkgs = [...xml.matchAll(/<remotePackage path="cmdline-tools;([0-9.]+)">([\s\S]*?)<\/remotePackage>/g)]
      .filter((m) => !/<channelRef ref="channel-[1-3]"/.test(m[2]))
      .sort((a, b) => b[1].localeCompare(a[1], undefined, { numeric: true }));
    for (const [, , body] of pkgs) {
      for (const a of body.matchAll(/<archive>([\s\S]*?)<\/archive>/g)) {
        const os = /<host-os>(\w+)<\/host-os>/.exec(a[1])?.[1];
        const url = /<url>([^<]+)<\/url>/.exec(a[1])?.[1];
        const sha = /<checksum[^>]*>([0-9a-f]{40})<\/checksum>/.exec(a[1])?.[1];
        if (os === process.argv[2] && url && sha) { console.log(url + " " + sha); process.exit(0); }
      }
    }' "$TMP/repo.xml" "$host")"
  [[ -n "$pick" ]] || die "could not find Android command-line tools for $host in Google's repository"
  local url="${pick%% *}" sum="${pick##* }"
  say "downloading Android command-line tools ($url)"
  fetch "https://dl.google.com/android/repository/$url" "$TMP/cmdline.zip"
  [[ "$(sha1_of "$TMP/cmdline.zip")" == "$sum" ]] || die "checksum mismatch for $url"
  rm -rf "$TMP/cmdline" && mkdir -p "$TMP/cmdline" && unzip -q "$TMP/cmdline.zip" -d "$TMP/cmdline"
  mkdir -p "$SDK/cmdline-tools" && rm -rf "$SDK/cmdline-tools/latest"
  mv "$TMP/cmdline/cmdline-tools" "$SDK/cmdline-tools/latest"
}

sdkmanager_install() {
  local home; home="$(java_home)" || die "a JDK 17+ is needed for sdkmanager"
  export JAVA_HOME="$home" ANDROID_HOME="$SDK"
  say "accepting the Android SDK licenses and installing: $*"
  yes 2>/dev/null | "$SDK/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$SDK" --licenses >/dev/null || true
  "$SDK/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$SDK" "$@"
}

install_system_packages() {
  local pkgs=()
  for s in "$@"; do case "$s" in git|unzip) pkgs+=("$s") ;; esac; done
  (( ${#pkgs[@]} )) || return 0
  if command -v apt-get >/dev/null 2>&1; then sudo apt-get update -qq && sudo apt-get install -y "${pkgs[@]}"
  elif command -v dnf >/dev/null 2>&1; then sudo dnf install -y "${pkgs[@]}"
  elif command -v pacman >/dev/null 2>&1; then sudo pacman -S --noconfirm "${pkgs[@]}"
  else die "install ${pkgs[*]} with your package manager, then run this script again"; fi
}

install_tailscale() {
  if [[ "$OS" == Darwin ]]; then
    if command -v brew >/dev/null 2>&1; then brew install --cask tailscale
    else NOTES+=("Tailscale: install it from https://tailscale.com/download/mac (no Homebrew here)"); return 0; fi
    NOTES+=("Tailscale: open the Tailscale app and log in, then run this script again to expose the guard")
  else
    curl -fsSL https://tailscale.com/install.sh | sh
    NOTES+=("Tailscale: run \`sudo tailscale up\` and open the login link, then run this script again to expose the guard")
  fi
}

write_env_file() {
  mkdir -p "$(dirname "$ENV_FILE")"
  {
    echo "# Written by Tapdance's host-setup.sh: tools it installed in your home folder."
    echo "export PATH=\"$BIN_DIR:$SHARE/node/bin:$SDK/platform-tools:$SDK/emulator:$SDK/cmdline-tools/latest/bin:\$PATH\""
    echo "export ANDROID_HOME=\"$SDK\""
    local home; if home="$(java_home)"; then echo "export JAVA_HOME=\"$home\""; fi
  } > "$ENV_FILE"
  local rc; rc="$([[ "${SHELL:-}" == */zsh ]] && echo "$HOME/.zshrc" || echo "$HOME/.bashrc")"
  if ! grep -qs "tapdance/env.sh" "$rc"; then
    printf '\n[ -f "%s" ] && . "%s"\n' "$ENV_FILE" "$ENV_FILE" >> "$rc"
    say "added $ENV_FILE to $rc (new shells pick up the tools)"
  fi
  . "$ENV_FILE"
}

# ---------------------------------------------------------------- prerequisites

if (( ! SKIP_PREREQ )); then
  check_all
  for n in "${NOTES[@]+"${NOTES[@]}"}"; do say "note: $n"; done
  if (( ${#MISSING[@]} == 0 )); then
    say "prerequisites: all present"
  else
    say "missing:"
    for m in "${MISSING[@]}"; do say "  - $(describe "$m")"; done
    (( CHECK )) && exit 0
    if (( ${#SUDO_STEPS[@]} )); then say "these steps ask for your password (sudo): ${SUDO_STEPS[*]}"; fi
    ask "Install them now?" || die "nothing installed. Run again when ready, or install them yourself (docs/installation.md)."
    for m in "${MISSING[@]}"; do
      case "$m" in
        node) install_node ;;
        jdk) node_ok || install_node; install_jdk ;;
        android-cmdline-tools) node_ok || install_node; install_cmdline_tools ;;
        git|unzip) install_system_packages "$m" ;;
        tailscale) install_tailscale ;;
        kvm-group) sudo usermod -aG kvm "$(id -un)"; NOTES+=("log out and back in so the kvm group applies, then run this script again") ;;
      esac
    done
    SDK_PKGS=()
    pkg_ok platform-tools || SDK_PKGS+=("platform-tools")
    pkg_ok emulator || SDK_PKGS+=("emulator")
    (( NO_IMAGE )) || image_ok || SDK_PKGS+=("$IMAGE")
    (( ${#SDK_PKGS[@]} )) && sdkmanager_install "${SDK_PKGS[@]}"
    write_env_file
    check_all
    for n in "${NOTES[@]+"${NOTES[@]}"}"; do say "note: $n"; done
    remaining=(); for m in "${MISSING[@]+"${MISSING[@]}"}"; do [[ "$m" == tailscale || "$m" == kvm-group ]] || remaining+=("$m"); done
    (( ${#remaining[@]} == 0 )) || die "still missing after installing: ${remaining[*]}"
  fi
elif (( CHECK )); then
  die "--check and --skip-prerequisites together check nothing"
fi
(( CHECK || ONLY_PREREQ )) && exit 0

# ---------------------------------------------------------------- Tapdance itself

TAPDANCE=()
if command -v tapdance >/dev/null 2>&1 && tapdance host --help >/dev/null 2>&1; then
  TAPDANCE=(tapdance)
else
  node_ok || die "Node.js 22.13 or later is required (https://nodejs.org)."
  command -v git >/dev/null 2>&1 || die "git is required (macOS: xcode-select --install; Linux: your package manager)."
  command -v corepack >/dev/null 2>&1 || die "corepack is missing from this Node.js install; install Node.js from nodejs.org (it ships corepack)."

  if [[ -d "$SRC/.git" ]]; then
    say "using the existing checkout in $SRC (not updating it; run git pull there yourself)"
  elif [[ -e "$SRC" ]]; then
    die "$SRC exists and is not a git checkout; set TAPDANCE_SOURCE_DIR to another directory."
  else
    say "cloning $REPO ($REF) into $SRC"
    git clone --branch "$REF" --depth 1 "$REPO" "$SRC"
  fi

  # The build's own scripts call `pnpm`: put corepack's pnpm shim in ~/.local/bin (no sudo).
  export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  corepack enable --install-directory "$BIN_DIR" pnpm
  hash -r
  say "installing dependencies and building (pnpm $(cd "$SRC" && pnpm --version))"
  (cd "$SRC" && pnpm install --frozen-lockfile && pnpm build)

  MAIN="$SRC/packages/cli/dist/main.js"
  [[ -f "$MAIN" ]] || die "the build did not produce $MAIN"
  chmod +x "$MAIN"
  ln -sf "$MAIN" "$BIN_DIR/tapdance"
  say "linked $BIN_DIR/tapdance -> $MAIN"
  TAPDANCE=(node "$MAIN")
fi

if [[ "$OS" == Linux && ! -e /dev/kvm ]]; then
  say "no /dev/kvm: this machine cannot run emulators, so it cannot host devices. Tapdance is installed;"
  say "use it as the agent's machine instead: tapdance connect <host endpoint> < pairing-<label>.token"
  exit 0
fi
exec "${TAPDANCE[@]}" host up "${PASS[@]+"${PASS[@]}"}"
