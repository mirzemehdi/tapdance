#!/usr/bin/env bash
# host-setup.sh — make this Mac or Linux machine a Tapdance device host in one command:
#
#   curl -fsSL https://raw.githubusercontent.com/mirzemehdi/tapdance/main/scripts/host-setup.sh | bash -s -- --label my-mac
#
# 1. Checks the prerequisites: Node.js 22.13+, git, a JDK 17+, the Android SDK (command-line tools,
#    platform-tools, emulator, the google_apis system image; --play-store for the Google Play image),
#    Tailscale, and on Linux KVM access and the emulator's system libraries. Xcode is optional (iOS); it
#    cannot be installed from a script.
# 2. Lists what is missing and asks once (or --yes). Then installs from the official sources, each
#    download checked against the checksum its publisher lists:
#      Node.js   nodejs.org tarball (SHASUMS256)            -> ~/.local/share/tapdance/node
#      JDK 17    Eclipse Temurin from api.adoptium.net       -> ~/Library/Java/JavaVirtualMachines (macOS)
#                                                               or ~/.local/share/tapdance/jdk (Linux)
#      Android   Google's command-line tools (repository XML SHA-1), then sdkmanager installs
#                platform-tools, emulator and the system image -> ~/Library/Android/sdk or ~/Android/Sdk.
#                Accepting the Android SDK licenses is part of this step. The newest command-line tools
#                are Google's Android CLI, which collects usage metrics by default: the script turns that
#                off with Google's documented setting, a `--no-metrics` line in ~/.androidrc.
#      gh        only with --with-gh: the GitHub CLI (system package, sudo; Homebrew on macOS), which
#                installs from CI (`tapdance host artifacts`) and builds with `--git-auth gh` need.
#      Tailscale macOS: `brew install --cask tailscale` when Homebrew is there (you log in in the app);
#                Linux: tailscale.com's installer, then `sudo tailscale up --operator=$USER`, which
#                prints a login link (asked first), so the guard can be served without root.
#    Only system packages (Linux: git, unzip and the emulator's libraries, named in the list, in one
#    package-manager call; Tailscale), the kvm group and, on a Linux cloud VM, a sudoers rule that
#    allows only `systemctl poweroff` (so the guard can stop the VM when it sits idle) use sudo, and
#    only after you said yes. Everything else goes into your home folder.
# 3. Installs Tapdance from source if the `tapdance` command is missing (git clone, corepack pnpm,
#    build, a link in ~/.local/bin). On Linux it then offers the Tailscale login (`sudo tailscale up`
#    waits until someone approves the machine in a browser, so it comes after the install), and runs
#    `tapdance host up` with your other arguments.
#
# The tools go into ~/.tapdance/env.sh (PATH, ANDROID_HOME, ANDROID_SDK_ROOT, JAVA_HOME). On Linux it is
# sourced at the top of ~/.bashrc, before Ubuntu's "not interactive: return" line, so commands run over
# ssh (`gcloud compute ssh --command ...`) find java, sdkmanager, adb and tapdance too.
#
# Its own options (everything else goes to `tapdance host up`):
#   --yes                install without asking (also passed on to host up)
#   --check              only report what is missing; change nothing
#   --skip-prerequisites do not check or install prerequisites
#   --prerequisites-only install the prerequisites, then stop (no Tapdance install, no host up)
#   --no-system-image    do not install the Android system image (about 1.5 GB)
#   --play-store         install the Google Play image (google_apis_playstore) instead of google_apis:
#                        only for Play Billing or Play sign-in tests. Play images update Play services
#                        in the background after boot, which keeps the guest busy longer (lease one
#                        with `tapdance device lease --image-tag google_apis_playstore`)
#   --with-gh            also install the GitHub CLI (gh) for installs from CI and builds with --git-auth gh
#   --sdk-packages LIST  also install these SDK packages, comma-separated, e.g. "cmake;3.31.6" (host
#                        builds need the app's own packages; quote the list, `;` is special in a shell)
#
# Settings: TAPDANCE_REPO (git URL; an SSH URL works for a private repository), TAPDANCE_REF (main),
# TAPDANCE_SOURCE_DIR (~/tapdance), ANDROID_API (34), ANDROID_TAG (google_apis; --play-store sets
# google_apis_playstore).
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
TAG="${ANDROID_TAG:-google_apis}"

die() { printf 'host-setup: %s\n' "$*" >&2; exit 1; }
say() { printf 'host-setup: %s\n' "$*" >&2; }

YES=0; CHECK=0; SKIP_PREREQ=0; ONLY_PREREQ=0; NO_IMAGE=0; WITH_GH=0; EXTRA_SDK=(); PASS=()
add_sdk_packages() {
  local p; local IFS=', '
  for p in $1; do
    [[ -z "$p" ]] && continue
    # sdkmanager package paths: letters, digits and . _ - separated by ; (no shell or path tricks).
    [[ "$p" =~ ^[A-Za-z0-9._-]+(\;[A-Za-z0-9._-]+)*$ && "$p" != *..* ]] || die "--sdk-packages: \"$p\" is not an SDK package path like cmake;3.31.6"
    EXTRA_SDK+=("$p")
  done
}
while (( $# )); do
  case "$1" in
    --yes|-y) YES=1; PASS+=("--yes") ;;
    --check) CHECK=1 ;;
    --skip-prerequisites) SKIP_PREREQ=1 ;;
    --prerequisites-only) ONLY_PREREQ=1 ;;
    --no-system-image) NO_IMAGE=1 ;;
    --play-store) TAG=google_apis_playstore ;;
    --with-gh) WITH_GH=1 ;;
    --sdk-packages=*) add_sdk_packages "${1#--sdk-packages=}" ;;
    --sdk-packages) [[ $# -ge 2 ]] || die "--sdk-packages needs a list, e.g. --sdk-packages \"cmake;3.31.6\""; add_sdk_packages "$2"; shift ;;
    *) PASS+=("$1") ;;
  esac
  shift
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
# An SDK package path ("cmake;3.31.6") is installed in the folder of the same path ("cmake/3.31.6").
pkg_ok() { [[ -d "$SDK/${1//;//}" ]]; }
image_ok() { [[ -d "$SDK/system-images/android-$API/$TAG/$ABI" ]]; }
# The emulator's QEMU loads system libraries that minimal cloud images (Ubuntu on Google Cloud) lack.
# A fixed list per package manager (the same as `tapdance doctor`'s hint), checked by package, so on a
# fresh machine the list is known before the emulator is installed and goes into the one question.
EMULATOR_LIBS_APT=(libpulse0 libxkbfile1 libxi6 libsm6 libice6)
EMULATOR_LIBS_DNF=(pulseaudio-libs libxkbfile libXi libSM libICE)
EMULATOR_LIBS_PACMAN=(libpulse libxkbfile libxi libsm libice)
# The emulator libraries this machine's package manager lacks, one per line (Linux only).
missing_emulator_libs() {
  [[ "$OS" == Linux ]] || return 0
  local p st
  if command -v apt-get >/dev/null 2>&1 && command -v dpkg-query >/dev/null 2>&1; then
    for p in "${EMULATOR_LIBS_APT[@]}"; do
      st="$(dpkg-query -W -f='${Status}' "$p" 2>/dev/null || true)"
      [[ "$st" == *"install ok installed"* ]] || echo "$p"
    done
  elif command -v dnf >/dev/null 2>&1 && command -v rpm >/dev/null 2>&1; then
    for p in "${EMULATOR_LIBS_DNF[@]}"; do rpm -q "$p" >/dev/null 2>&1 || echo "$p"; done
  elif command -v pacman >/dev/null 2>&1; then
    for p in "${EMULATOR_LIBS_PACMAN[@]}"; do pacman -Q "$p" >/dev/null 2>&1 || echo "$p"; done
  fi
}
# The packages to install for the emulator: the missing ones, or the whole list when the emulator
# fails to load a library although they are all there (a library under another package name).
emulator_lib_packages() {
  local m; m="$(missing_emulator_libs)"
  if [[ -n "$m" ]]; then echo $m; return; fi
  if command -v apt-get >/dev/null 2>&1; then echo "${EMULATOR_LIBS_APT[*]}"
  elif command -v dnf >/dev/null 2>&1; then echo "${EMULATOR_LIBS_DNF[*]}"
  elif command -v pacman >/dev/null 2>&1; then echo "${EMULATOR_LIBS_PACMAN[*]}"; fi
}
emulator_libs_ok() {
  [[ "$OS" == Linux ]] || return 0
  if [[ -x "$SDK/emulator/emulator" ]]; then
    # The emulator itself is the authority once it is there.
    # Captured first: with pipefail, `grep -q` closing the pipe early would make the check pass.
    local out; out="$("$SDK/emulator/emulator" -version 2>&1 || true)"
    [[ "$out" != *"error while loading shared libraries"* ]]
    return
  fi
  # Not installed yet: check the packages, so they are listed (and asked for) up front.
  [[ -z "$(missing_emulator_libs)" ]]
}
tailscale_bin() {
  command -v tailscale 2>/dev/null && return
  [[ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]] && echo /Applications/Tailscale.app/Contents/MacOS/Tailscale && return
  return 1
}

# A Linux cloud VM, from the DMI strings (Google Cloud names itself "Google"; the rest are common clouds).
cloud_vm() {
  [[ "$OS" == Linux ]] || return 1
  local dmi; dmi="$(cat /sys/class/dmi/id/sys_vendor /sys/class/dmi/id/product_name 2>/dev/null || true)"
  [[ "$dmi" =~ Google|Amazon|EC2|Microsoft|DigitalOcean|Hetzner|OpenStack|Scaleway|Vultr|Linode|Akamai|Oracle|Alibaba ]]
}
# The guard's cost guard powers an idle cloud VM off with `sudo -n /usr/bin/systemctl poweroff`.
poweroff_rule_ok() { sudo -n -l /usr/bin/systemctl poweroff >/dev/null 2>&1; }

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
    emulator_libs_ok || { MISSING+=("emulator-libs"); SUDO_STEPS+=("emulator-libs"); }
    (( NO_IMAGE )) || image_ok || MISSING+=("system-image")
  fi
  local p; for p in "${EXTRA_SDK[@]+"${EXTRA_SDK[@]}"}"; do pkg_ok "$p" || MISSING+=("sdk:$p"); done
  tailscale_bin >/dev/null || { MISSING+=("tailscale"); [[ "$OS" == Linux ]] && SUDO_STEPS+=("tailscale"); }
  if ! command -v gh >/dev/null 2>&1; then
    if (( WITH_GH )); then MISSING+=("gh"); [[ "$OS" == Linux ]] && SUDO_STEPS+=("gh")
    else NOTES+=("gh (GitHub CLI) is not installed: installs from CI (tapdance host artifacts) and builds with --git-auth gh need it. Run this script again with --with-gh, or install it yourself"); fi
  fi
  (( ${#EXTRA_SDK[@]} )) || NOTES+=("builds on this host (tapdance host builds) also need the app's own SDK packages (for example cmake;3.31.6 for native code), or Gradle may stop on a missing one: add them with --sdk-packages \"cmake;3.31.6\"")
  if [[ "$OS" == Linux ]]; then
    if [[ ! -e /dev/kvm ]]; then
      NOTES+=("KVM: /dev/kvm is missing, so Android emulators cannot run here (a cloud VM without nested virtualization, or virtualization off in the BIOS); the emulator and system image are skipped. This machine can still be a control machine: tapdance connect <host endpoint> < pairing-<label>.token")
    elif [[ ! -r /dev/kvm || ! -w /dev/kvm ]]; then
      MISSING+=("kvm-group"); SUDO_STEPS+=("kvm-group")
    fi
    if [[ -e /dev/kvm ]] && cloud_vm && command -v sudo >/dev/null 2>&1 && ! poweroff_rule_ok; then
      MISSING+=("poweroff-rule"); SUDO_STEPS+=("poweroff-rule")
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
    kvm-group) echo "add $(id -un) to the kvm group (sudo; takes effect at once)" ;;
    emulator-libs) echo "system libraries the Android emulator needs: $(emulator_lib_packages) and what they depend on (system packages, sudo)" ;;
    gh) [[ "$OS" == Darwin ]] && echo "GitHub CLI gh (Homebrew)" || echo "GitHub CLI gh (system package, sudo)" ;;
    sdk:*) echo "Android SDK package ${1#sdk:} (sdkmanager)" ;;
    poweroff-rule) echo "a sudoers rule that lets $(id -un) run only /usr/bin/systemctl poweroff, so the guard can stop this cloud VM when it sits idle (sudo; /etc/sudoers.d/tapdance-poweroff, checked with visudo)" ;;
  esac
}

# /dev/tty is "readable" by permissions even without a controlling terminal; opening it tells.
have_tty() { { : < /dev/tty; } 2>/dev/null; }

ask() {
  (( YES )) && return 0
  # Piped through curl, stdin is this script: ask on the terminal.
  have_tty || die "no terminal to ask on; run again with --yes to install, or --check to only report"
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
        const arch = /<host-arch>(\w+)<\/host-arch>/.exec(a[1])?.[1];
        // A package can list one archive per CPU (macOS: x64 and aarch64): take the one for this CPU.
        if (os === process.argv[2] && url && sha && (!arch || arch === process.argv[3])) { console.log(url + " " + sha); process.exit(0); }
      }
    }' "$TMP/repo.xml" "$host" "$([[ $ARCH == arm64 ]] && echo aarch64 || echo x64)")"
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
  # Under `curl | bash` stdin is this script: sdkmanager must not read it.
  "$SDK/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$SDK" "$@" < /dev/null
}

# The newest command-line tools are Google's Android CLI, which collects usage metrics unless told
# not to. Its documented switch is --no-metrics, and ~/.androidrc applies a flag to every invocation
# (https://developer.android.com/tools/agents/android-cli). The `sdkmanager` wrapper rejects
# --no-metrics on its own command line, so check that it still runs with the file; if not, take the
# line out again and say so.
android_metrics_off() {
  local rc="$HOME/.androidrc" sdkm="$SDK/cmdline-tools/latest/bin/sdkmanager"
  grep -qsxF -- "--no-metrics" "$rc" && return 0
  local home; home="$(java_home)" && export JAVA_HOME="$home"
  local before=0; "$sdkm" --version >/dev/null 2>&1 < /dev/null && before=1
  local existed=0; [[ -e "$rc" ]] && existed=1
  printf -- '--no-metrics\n' >> "$rc"
  if (( before )) && ! "$sdkm" --version >/dev/null 2>&1 < /dev/null; then
    grep -vxF -- "--no-metrics" "$rc" > "$TMP/androidrc" || true
    if (( existed )); then cat "$TMP/androidrc" > "$rc"; else rm -f "$rc"; fi
    NOTES+=("Android CLI metrics: sdkmanager did not run with --no-metrics in $rc, so the line was taken out again; turn metrics off as Google's Android CLI documentation says")
    return 0
  fi
  say "turned off the Android CLI's usage metrics (--no-metrics in $rc)"
}

# One package-manager call for every system package in the list (git, unzip, emulator-libs), so the
# libraries named in the question are installed in the same sudo step.
install_system_packages() {
  local pkgs=() s p
  for s in "$@"; do
    case "$s" in
      git|unzip) pkgs+=("$s") ;;
      emulator-libs) for p in $(emulator_lib_packages); do pkgs+=("$p"); done ;;
    esac
  done
  (( ${#pkgs[@]} )) || return 0
  if command -v apt-get >/dev/null 2>&1; then sudo apt-get update -qq && sudo apt-get install -y "${pkgs[@]}"
  elif command -v dnf >/dev/null 2>&1; then sudo dnf install -y "${pkgs[@]}"
  elif command -v pacman >/dev/null 2>&1; then sudo pacman -S --noconfirm "${pkgs[@]}"
  else die "install ${pkgs[*]} with your package manager, then run this script again"; fi
}

# After sdkmanager: the emulator just installed still cannot load a library (one the package check
# could not see). Name the packages and ask again before using sudo; never install unannounced.
emulator_libs_after_install() {
  emulator_libs_ok && return 0
  local pkgs; pkgs="$(emulator_lib_packages)"
  [[ -n "$pkgs" ]] || die "the emulator cannot load a system library: install what \`$SDK/emulator/emulator -version\` reports missing, then run this script again"
  say "the Android emulator still cannot load a system library; it needs: $pkgs (system packages, sudo)"
  ask "Install them now?" || die "not installed. Install them yourself, then run this script again."
  install_system_packages emulator-libs
}

install_gh() {
  if [[ "$OS" == Darwin ]]; then
    if command -v brew >/dev/null 2>&1; then brew install gh
    else NOTES+=("gh: install it from https://cli.github.com (no Homebrew here)"); fi
    return 0
  fi
  if command -v apt-get >/dev/null 2>&1; then sudo apt-get update -qq && sudo apt-get install -y gh
  elif command -v dnf >/dev/null 2>&1; then sudo dnf install -y gh
  elif command -v pacman >/dev/null 2>&1; then sudo pacman -S --noconfirm github-cli
  else NOTES+=("gh: install it with your package manager (https://cli.github.com)"); fi
}

install_tailscale() {
  if [[ "$OS" == Darwin ]]; then
    if command -v brew >/dev/null 2>&1; then brew install --cask tailscale
    else NOTES+=("Tailscale: install it from https://tailscale.com/download/mac (no Homebrew here)"); return 0; fi
    NOTES+=("Tailscale: open the Tailscale app and log in, then run this script again to expose the guard")
  else
    curl -fsSL https://tailscale.com/install.sh | sh
  fi
}

# Linux cloud VM: let this user power the machine off (and nothing else as root), so the guard's cost
# guard (`tapdance host up --idle-stop`) can stop an idle VM. Written under a name sudo ignores (it has
# a dot), checked with visudo, then moved into place: a bad file never reaches sudo's include dir.
install_poweroff_rule() {
  local rule; rule="$(id -un) ALL=(root) NOPASSWD: /usr/bin/systemctl poweroff"
  local staged=/etc/sudoers.d/tapdance-poweroff.new
  printf '%s\n' "$rule" > "$TMP/tapdance-poweroff"
  if sudo install -m 440 -o root -g root "$TMP/tapdance-poweroff" "$staged" && sudo visudo -cf "$staged" >/dev/null; then
    sudo mv "$staged" /etc/sudoers.d/tapdance-poweroff
  else
    sudo rm -f "$staged"
    NOTES+=("poweroff rule: not installed (visudo refused it); the guard cannot stop this VM when idle until you add: $rule")
  fi
}

# Linux: join the tailnet (tailscale up prints a login link to open in any browser) and make this user
# the operator, since tailscaled lets only root and the operator run `tailscale serve`.
linux_tailscale() {
  [[ "$OS" == Linux ]] || return 0
  local ts; ts="$(tailscale_bin)" || return 0
  local me; me="$(id -un)"
  if ! "$ts" status >/dev/null 2>&1; then
    if ask "Log this machine into your tailnet now? (sudo tailscale up; it prints a link to open in a browser)"; then
      sudo "$ts" up --operator="$me"
    else
      NOTES+=("Tailscale: run \`sudo tailscale up --operator=$me\` and open the link, then run this script again to expose the guard")
    fi
  elif ! "$ts" debug prefs 2>/dev/null | grep -q "\"OperatorUser\": \"$me\""; then
    say "letting $me run tailscale serve (sudo tailscale set --operator=$me)"
    sudo "$ts" set --operator="$me"
  fi
}

write_env_file() {
  mkdir -p "$(dirname "$ENV_FILE")"
  {
    echo "# Written by Tapdance's host-setup.sh: tools it installed in your home folder."
    echo "export PATH=\"$BIN_DIR:$SHARE/node/bin:$SDK/platform-tools:$SDK/emulator:$SDK/cmdline-tools/latest/bin:\$PATH\""
    echo "export ANDROID_HOME=\"$SDK\""
    echo "export ANDROID_SDK_ROOT=\"$SDK\""
    local home; if home="$(java_home)"; then echo "export JAVA_HOME=\"$home\""; echo "export PATH=\"$home/bin:\$PATH\""; fi
  } > "$ENV_FILE"
  local source_line; source_line="[ -f \"$ENV_FILE\" ] && . \"$ENV_FILE\""
  if [[ "$OS" == Linux && "${SHELL:-}" != */zsh ]]; then
    # Ubuntu's .bashrc returns early when not interactive, and bash reads .bashrc (not .profile) for a
    # command run over ssh: the line must come before that guard, so it goes at the very top.
    local rc="$HOME/.bashrc"
    if ! head -n 2 "$rc" 2>/dev/null | grep -qs "tapdance/env.sh"; then
      { printf '# Tapdance (host-setup.sh): first, so commands over ssh find the tools too.\n%s\n' "$source_line"
        grep -v -e "tapdance/env.sh" -e "^# Tapdance (host-setup.sh)" "$rc" 2>/dev/null || true; } > "$TMP/bashrc"
      cat "$TMP/bashrc" > "$rc"
      say "added $ENV_FILE at the top of $rc (new shells and ssh commands pick up the tools)"
    fi
  fi
  local rcs=()
  if [[ "$OS" == Linux ]]; then
    # zsh reads .zshenv in every shell, ssh commands included; login shells (`bash -lc`) read .profile.
    [[ "${SHELL:-}" == */zsh ]] && rcs+=("$HOME/.zshenv")
    rcs+=("$HOME/.profile")
  else
    rcs+=("$([[ "${SHELL:-}" == */zsh ]] && echo "$HOME/.zshrc" || echo "$HOME/.bashrc")")
  fi
  local f; for f in "${rcs[@]}"; do
    if ! grep -qs "tapdance/env.sh" "$f"; then
      printf '\n%s\n' "$source_line" >> "$f"
      say "added $ENV_FILE to $f (new shells pick up the tools)"
    fi
  done
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
    # System packages first (unzip is needed for the command-line tools), all in one sudo step.
    install_system_packages "${MISSING[@]}"
    for m in "${MISSING[@]}"; do
      case "$m" in
        node) install_node ;;
        jdk) node_ok || install_node; install_jdk ;;
        android-cmdline-tools) node_ok || install_node; install_cmdline_tools; android_metrics_off ;;
        gh) install_gh ;;
        tailscale) install_tailscale ;;
        kvm-group)
          sudo usermod -aG kvm "$(id -un)"
          # The group applies to new logins only; an ACL lets this login and its running systemd user
          # manager (which starts the worker) use /dev/kvm now. A reboot drops the ACL; the group remains.
          if ! { command -v setfacl >/dev/null 2>&1 && sudo setfacl -m "u:$(id -un):rw" /dev/kvm; }; then
            NOTES+=("log out and back in so the kvm group applies, then run this script again")
          fi ;;
        poweroff-rule) install_poweroff_rule ;;
      esac
    done
    SDK_PKGS=()
    pkg_ok platform-tools || SDK_PKGS+=("platform-tools")
    pkg_ok emulator || SDK_PKGS+=("emulator")
    (( NO_IMAGE )) || image_ok || SDK_PKGS+=("$IMAGE")
    for p in "${EXTRA_SDK[@]+"${EXTRA_SDK[@]}"}"; do pkg_ok "$p" || SDK_PKGS+=("$p"); done
    (( ${#SDK_PKGS[@]} )) && sdkmanager_install "${SDK_PKGS[@]}"
    # The emulator just installed may still miss a library the package check could not see.
    emulator_libs_after_install
    write_env_file
    check_all
    for n in "${NOTES[@]+"${NOTES[@]}"}"; do say "note: $n"; done
    remaining=(); for m in "${MISSING[@]+"${MISSING[@]}"}"; do [[ "$m" == tailscale || "$m" == kvm-group || "$m" == poweroff-rule || "$m" == gh ]] || remaining+=("$m"); done
    (( ${#remaining[@]} == 0 )) || die "still missing after installing: ${remaining[*]}"
  fi
  # --prerequisites-only stops here, so it offers the Tailscale login now. A full run offers it after
  # the Tapdance install: `sudo tailscale up` waits until someone approves the machine.
  if (( ONLY_PREREQ && ! CHECK )); then linux_tailscale; fi
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

# Linux: log in to the tailnet now. It blocks until the machine is approved in a browser, so it comes
# after the install (nothing waits on it) and before host up, the first step that needs Tailscale.
(( SKIP_PREREQ )) || linux_tailscale

if [[ "$OS" == Linux && ! -e /dev/kvm ]]; then
  say "no /dev/kvm: this machine cannot run emulators, so it cannot host devices. Tapdance is installed;"
  say "use it as the agent's machine instead: tapdance connect <host endpoint> < pairing-<label>.token"
  exit 0
fi
# Linux: the worker and guard are systemd user units, so this account's user manager must run without a
# login (after logout, at boot). Linger does that, but logind cannot look up some accounts (Google Cloud
# OS Login users: "Could not enable linger: No such file or directory"); then a small system unit starts
# the user manager at boot instead.
linux_user_manager() {
  [[ "$OS" == Linux && -e /dev/kvm ]] || return 0
  local me uid; me="$(id -un)"; uid="$(id -u)"
  lingers() { loginctl show-user "$me" --property=Linger 2>/dev/null | grep -q '=yes'; }
  lingers && return 0
  loginctl enable-linger "$me" 2>/dev/null || sudo loginctl enable-linger "$me" 2>/dev/null || true
  lingers && { say "turned on linger for $me"; return 0; }
  say "logind cannot keep $me lingering (an OS Login account?); starting its user manager from a system unit at boot"
  printf '[Unit]\nDescription=Tapdance: user manager for %s (runs the worker and guard without a login)\nAfter=systemd-user-sessions.service\n\n[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart=/bin/systemctl start user@%s.service\n\n[Install]\nWantedBy=multi-user.target\n' "$me" "$uid" \
    | sudo tee /etc/systemd/system/tapdance-user-manager.service >/dev/null
  sudo systemctl daemon-reload && sudo systemctl enable --now tapdance-user-manager.service
}
linux_user_manager

# Piped through curl, stdin is this script: give host up the terminal so it can ask to approve pairing.
if [[ ! -t 0 ]] && have_tty; then exec "${TAPDANCE[@]}" host up "${PASS[@]+"${PASS[@]}"}" < /dev/tty; fi
exec "${TAPDANCE[@]}" host up "${PASS[@]+"${PASS[@]}"}"
