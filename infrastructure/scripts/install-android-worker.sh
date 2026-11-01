#!/usr/bin/env bash
# install-android-worker.sh — turn an Ubuntu x86_64 machine with KVM into a Tapdance Android worker.
#
# What it does, in order (every step is safe to run again):
#   1. checks the OS (Ubuntu 22.04 or 24.04), the CPU (x86_64 with vmx/svm) and sudo
#   2. installs KVM packages and cpu-checker, adds you to the kvm group, writes a udev rule for
#      /dev/kvm, and STOPS with a diagnostic if kvm-ok says acceleration is unusable
#   3. installs OpenJDK 17, Node.js 22 (NodeSource apt repository) and the libraries the emulator needs
#   4. downloads the Android command-line tools from Google, checks the published SHA-256, and
#      installs platform-tools, emulator and one x86_64 system image with sdkmanager
#      (licences are accepted only when you pass --accept-android-licenses, or interactively)
#   5. writes ANDROID_HOME, JAVA_HOME and PATH to ~/.config/tapdance/worker-env.sh and sources it
#      from ~/.profile and ~/.bashrc
#   6. installs Tapdance from a git checkout (the npm name "tapdance" belongs to an unrelated
#      package; Tapdance is not published to npm yet)
#   7. configures the bundled Simlock worker for a headless VM: one emulator at a time, no window
#   8. runs `tapdance worker check --android-only`, enables lingering, runs
#      `tapdance worker install --service` (systemd user service), and `emulator -accel-check`
#   9. prints the exact `tapdance worker login` command; the join token is read from stdin there,
#      never passed on the command line and never handled by this script
#
# Run it as the normal user that will own the worker (not root); it uses sudo where needed:
#
#   bash install-android-worker.sh --accept-android-licenses
#
# Status: syntax-checked with `bash -n` only. It has NOT been run on a real machine yet (no
# Android, no Linux, no N2 run so far). See STATUS.md (G-01, G-02, D-02, Q-05).
#
# Upstream projects this script drives: Simlock (https://github.com/callstackincubator/simlock, MIT)
# owns the emulators and leases; agent-device (https://github.com/callstack/agent-device, MIT)
# drives them. The Android SDK, emulator and system images are Google's, under the Android SDK
# licence you accept below.

set -euo pipefail

# ----------------------------------------------------------------------------- defaults
# Android SDK Command-line Tools for Linux, as published on https://developer.android.com/studio
# (section "Command line tools only"). Checked 2026-11-01. When Google publishes a newer build,
# pass --cmdline-tools-url and --cmdline-tools-sha256 with the values from that page.
CMDLINE_TOOLS_URL_DEFAULT="https://dl.google.com/android/repository/commandlinetools-linux-15859902_latest.zip"
CMDLINE_TOOLS_SHA256_DEFAULT="4e4c464f145a7512b57d088ac6c278c03c9eea610886b35a5e0804e74eedf583"

ANDROID_HOME_DIR="${ANDROID_HOME:-$HOME/android-sdk}"
SYSTEM_IMAGE="${TAPDANCE_SYSTEM_IMAGE:-system-images;android-35;google_apis;x86_64}"
CMDLINE_TOOLS_URL="$CMDLINE_TOOLS_URL_DEFAULT"
CMDLINE_TOOLS_SHA256="$CMDLINE_TOOLS_SHA256_DEFAULT"
ACCEPT_LICENSES=0
TAPDANCE_REPO="${TAPDANCE_REPO:-https://github.com/mirzemehdi/tapdance.git}"
TAPDANCE_REF="${TAPDANCE_REF:-main}"
TAPDANCE_SOURCE_DIR="${TAPDANCE_SOURCE_DIR:-$HOME/tapdance}"
TAPDANCE_NPM_SPEC=""
MAX_EMULATORS=1
EMULATOR_GPU="swiftshader_indirect"
INSTALL_SERVICE=1
BOOT_TEST=0
GATEWAY_URL="wss://<your-gateway-host>"
WORKER_LABEL="$(hostname -s 2>/dev/null || echo android-worker)"
NODE_MAJOR=22

ENV_FILE="$HOME/.config/tapdance/worker-env.sh"
BIN_DIR="$HOME/.local/bin"

usage() {
  cat <<EOF
Usage: install-android-worker.sh [options]

Android SDK
  --accept-android-licenses   accept the Android SDK licences non-interactively. Without it, the
                              script shows sdkmanager's licence prompts when run in a terminal,
                              and stops when it is not. Read them first with:
                              \$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager --licenses
  --android-home DIR          where the SDK goes (default: $ANDROID_HOME_DIR)
  --system-image PKG          one x86_64 image (default: $SYSTEM_IMAGE)
  --cmdline-tools-url URL     override the command-line tools download
  --cmdline-tools-sha256 HEX  its SHA-256 from developer.android.com/studio; pass "print" to skip
                              the comparison and print the hash for you to check by hand

Tapdance
  --source-dir DIR            use or create a git checkout here (default: $TAPDANCE_SOURCE_DIR)
  --repo URL                  git URL to clone (default: $TAPDANCE_REPO)
  --ref REF                   branch or tag to clone (default: $TAPDANCE_REF)
  --npm-spec SPEC             install from npm instead, once Tapdance is published there (never the
                              bare name "tapdance": that npm package is an unrelated TAP harness)

Worker
  --max-emulators N           emulators that may run at once (default: 1; see the README for why)
  --emulator-gpu MODE         Simlock android.emulator.gpu (default: $EMULATOR_GPU)
  --no-service                do not install the systemd user service or enable lingering
  --boot-test                 boot one throw-away emulator to prove acceleration end to end
                              (takes a few minutes; deletes the test AVD afterwards)

Printing only (no effect on the install)
  --gateway URL               gateway address to show in the final login command
  --label NAME                worker label to show in the final login command (default: $WORKER_LABEL)

  -h, --help                  show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --accept-android-licenses) ACCEPT_LICENSES=1; shift ;;
    --android-home) ANDROID_HOME_DIR="${2:?}"; shift 2 ;;
    --system-image) SYSTEM_IMAGE="${2:?}"; shift 2 ;;
    --cmdline-tools-url) CMDLINE_TOOLS_URL="${2:?}"; shift 2 ;;
    --cmdline-tools-sha256) CMDLINE_TOOLS_SHA256="${2:?}"; shift 2 ;;
    --source-dir) TAPDANCE_SOURCE_DIR="${2:?}"; shift 2 ;;
    --repo) TAPDANCE_REPO="${2:?}"; shift 2 ;;
    --ref) TAPDANCE_REF="${2:?}"; shift 2 ;;
    --npm-spec) TAPDANCE_NPM_SPEC="${2:?}"; shift 2 ;;
    --max-emulators) MAX_EMULATORS="${2:?}"; shift 2 ;;
    --emulator-gpu) EMULATOR_GPU="${2:?}"; shift 2 ;;
    --no-service) INSTALL_SERVICE=0; shift ;;
    --boot-test) BOOT_TEST=1; shift ;;
    --gateway) GATEWAY_URL="${2:?}"; shift 2 ;;
    --label) WORKER_LABEL="${2:?}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

# ----------------------------------------------------------------------------- helpers
step() { printf '\n==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
die()  { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

apt_install() {
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$@"
}

# Prints the package name apt can install: the first argument when it has a candidate, else the
# second. Ubuntu 24.04 made some names virtual (qemu-kvm, libasound2), and apt refuses those.
pick_pkg() {
  local candidate
  candidate="$(apt-cache policy "$1" 2>/dev/null | awk '/Candidate:/ {print $2}')"
  if [[ -n "$candidate" && "$candidate" != "(none)" ]]; then echo "$1"; else echo "$2"; fi
}

# Runs a command with the kvm group even when this login predates `usermod -aG kvm`.
kvm_run() {
  if id -nG | grep -qw kvm; then
    "$@"
  else
    local cmd
    cmd="$(printf '%q ' env "PATH=$PATH" "ANDROID_HOME=$ANDROID_HOME" "ANDROID_SDK_ROOT=$ANDROID_SDK_ROOT" \
      "JAVA_HOME=$JAVA_HOME" "HOME=$HOME" "XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-}" "$@")"
    sg kvm -c "$cmd"
  fi
}

kvm_diagnostic() {
  cat >&2 <<'EOF'

Hardware acceleration (KVM) is not usable on this machine. Stopping here on purpose:
Tapdance never falls back to software emulation (it is far too slow for an agent to use).

What to check:
  * CPU flags: grep -Ewo 'vmx|svm' /proc/cpuinfo | sort -u   (empty = no virtualization exposed)
  * Kernel:    lsmod | grep kvm ; ls -l /dev/kvm ; sudo dmesg | grep -i kvm
  * kvm-ok:    kvm-ok

On Google Cloud:
  * The VM must be N2 (Intel), created with nested virtualization enabled. N2D, E2, Arm and
    most AMD machine types do not support it. infrastructure/terraform/google-cloud-n2 sets this.
  * From your laptop, check the instance:
      gcloud compute instances describe INSTANCE --zone ZONE \
        --format='value(advancedMachineFeatures.enableNestedVirtualization)'
  * Check the organization policy is not blocking it:
      gcloud resource-manager org-policies describe \
        constraints/compute.disableNestedVirtualization --project PROJECT_ID --effective
Elsewhere: ask your provider whether nested virtualization is enabled for your plan, or enable
VT-x/AMD-V in the firmware on bare metal.

For a full report run: bash check-kvm.sh   (in the same folder as this script, or
/opt/tapdance/check-kvm.sh on a VM made with the Tapdance Terraform)
EOF
  exit 1
}

# ----------------------------------------------------------------------------- 1. preflight
step "Checking this machine"
[[ "$(id -u)" -ne 0 ]] || die "Run this as the normal user that will own the worker, not as root. It uses sudo itself."
command -v sudo >/dev/null 2>&1 || die "sudo is required."
sudo -v || die "This user needs sudo rights (on Google Cloud with OS Login: roles/compute.osAdminLogin)."
[[ -r /etc/os-release ]] || die "Cannot read /etc/os-release."
# shellcheck disable=SC1091
. /etc/os-release
[[ "${ID:-}" == "ubuntu" ]] || die "Ubuntu is required (found ${PRETTY_NAME:-unknown})."
case "${VERSION_ID:-}" in
  22.04|24.04) note "OS: $PRETTY_NAME" ;;
  *) die "Ubuntu 22.04 or 24.04 is required (found $VERSION_ID)." ;;
esac
[[ "$(uname -m)" == "x86_64" ]] || die "x86_64 is required (found $(uname -m)). Android x86_64 system images need an x86_64 KVM host."
if ! grep -Eqw 'vmx|svm' /proc/cpuinfo; then
  note "Neither vmx nor svm is present in /proc/cpuinfo."
  kvm_diagnostic
fi
note "CPU virtualization: $(grep -Ewo 'vmx|svm' /proc/cpuinfo | sort -u | tr '\n' ' ')"
[[ "$MAX_EMULATORS" =~ ^[1-9][0-9]*$ ]] || die "--max-emulators must be a positive integer."
[[ "$SYSTEM_IMAGE" == system-images\;*\;x86_64 ]] || die "--system-image must be an x86_64 image, e.g. system-images;android-35;google_apis;x86_64"

# ----------------------------------------------------------------------------- 2. KVM
step "Installing KVM packages and fixing /dev/kvm access"
sudo apt-get update -y
QEMU_PKG="$(pick_pkg qemu-kvm qemu-system-x86)"
apt_install "$QEMU_PKG" cpu-checker ca-certificates curl gnupg unzip git
getent group kvm >/dev/null || sudo groupadd --system kvm
if ! id -nG "$USER" | grep -qw kvm; then
  sudo usermod -aG kvm "$USER"
  note "Added $USER to the kvm group (new logins get it; this script uses 'sg kvm' meanwhile)."
fi
UDEV_RULE=/etc/udev/rules.d/65-tapdance-kvm.rules
UDEV_CONTENT='KERNEL=="kvm", GROUP="kvm", MODE="0660", OPTIONS+="static_node=kvm"'
if [[ "$(cat "$UDEV_RULE" 2>/dev/null || true)" != "$UDEV_CONTENT" ]]; then
  echo "$UDEV_CONTENT" | sudo tee "$UDEV_RULE" >/dev/null
  note "Wrote $UDEV_RULE"
fi
if [[ ! -e /dev/kvm ]]; then
  if grep -qw vmx /proc/cpuinfo; then sudo modprobe kvm_intel || true; else sudo modprobe kvm_amd || true; fi
fi
sudo udevadm control --reload-rules
sudo udevadm trigger --name-match=kvm || true
[[ -e /dev/kvm ]] || { note "/dev/kvm does not exist after loading the kvm modules."; kvm_diagnostic; }
if ! KVM_OK_OUT="$(sudo kvm-ok 2>&1)"; then
  printf '%s\n' "$KVM_OK_OUT" | sed 's/^/    kvm-ok: /' >&2
  kvm_diagnostic
fi
note "kvm-ok: $(printf '%s\n' "$KVM_OK_OUT" | tail -n1)"
# shellcheck disable=SC2016
sg kvm -c 'test -r /dev/kvm && test -w /dev/kvm' || { note "$USER cannot open /dev/kvm read-write even with the kvm group."; kvm_diagnostic; }

# ----------------------------------------------------------------------------- 3. JDK, Node, emulator libs
step "Installing OpenJDK 17 and the libraries the emulator loads"
ALSA_PKG="$(pick_pkg libasound2 libasound2t64)"
apt_install openjdk-17-jdk-headless "$ALSA_PKG" libpulse0 libnss3 libxcomposite1 libxcursor1 libxi6 \
  libxtst6 libxdamage1 libxrandr2 libxkbfile1 libgl1 libegl1 libgbm1 libdrm2
JAVA_HOME_DIR="/usr/lib/jvm/java-17-openjdk-amd64"
[[ -x "$JAVA_HOME_DIR/bin/java" ]] || die "OpenJDK 17 was installed but $JAVA_HOME_DIR/bin/java is missing."

step "Installing Node.js $NODE_MAJOR (NodeSource apt repository)"
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local v major minor
  v="$(node -p 'process.versions.node' 2>/dev/null)" || return 1
  major="${v%%.*}"; minor="${v#*.}"; minor="${minor%%.*}"
  (( major > 22 || (major == 22 && minor >= 13) ))
}
if node_ok; then
  note "Node.js $(node -v) already installed"
else
  sudo install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | sudo gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  sudo tee /etc/apt/sources.list.d/nodesource.sources >/dev/null <<EOF
Types: deb
URIs: https://deb.nodesource.com/node_${NODE_MAJOR}.x/
Suites: nodistro
Components: main
Signed-By: /etc/apt/keyrings/nodesource.gpg
EOF
  sudo apt-get update -y
  apt_install nodejs
  node_ok || die "Node.js 22.13 or later is required; found $(node -v 2>/dev/null || echo none)."
  note "Node.js $(node -v)"
fi

# ----------------------------------------------------------------------------- 4. Android SDK
step "Installing the Android command-line tools into $ANDROID_HOME_DIR"
export ANDROID_HOME="$ANDROID_HOME_DIR"
export ANDROID_SDK_ROOT="$ANDROID_HOME_DIR"
export JAVA_HOME="$JAVA_HOME_DIR"
export PATH="$BIN_DIR:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
SDKMANAGER="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"
if [[ -x "$SDKMANAGER" ]]; then
  note "Already installed: $SDKMANAGER"
else
  mkdir -p "$ANDROID_HOME/cmdline-tools"
  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TMP_DIR"' EXIT
  note "Downloading $CMDLINE_TOOLS_URL"
  curl -fL --retry 3 -o "$TMP_DIR/cmdline-tools.zip" "$CMDLINE_TOOLS_URL"
  ACTUAL_SHA="$(sha256sum "$TMP_DIR/cmdline-tools.zip" | awk '{print $1}')"
  if [[ "$CMDLINE_TOOLS_SHA256" == "print" ]]; then
    note "SHA-256 of the download: $ACTUAL_SHA"
    note "Compare it by hand with the value on https://developer.android.com/studio (Command line tools only)."
  elif [[ "$ACTUAL_SHA" != "$CMDLINE_TOOLS_SHA256" ]]; then
    die "SHA-256 mismatch for the command-line tools.
  expected: $CMDLINE_TOOLS_SHA256
  actual:   $ACTUAL_SHA
If Google published a newer build, pass --cmdline-tools-url and --cmdline-tools-sha256 with the
values from https://developer.android.com/studio. Otherwise do not continue."
  else
    note "SHA-256 matches the published checksum."
  fi
  unzip -q "$TMP_DIR/cmdline-tools.zip" -d "$TMP_DIR/unpacked"
  rm -rf "$ANDROID_HOME/cmdline-tools/latest"
  mv "$TMP_DIR/unpacked/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"
  rm -rf "$TMP_DIR"
  trap - EXIT
fi

step "Android SDK licences"
licenses_accepted() { [[ -f "$ANDROID_HOME/licenses/android-sdk-license" ]]; }
if [[ $ACCEPT_LICENSES -eq 1 ]]; then
  note "--accept-android-licenses given: accepting every Android SDK licence sdkmanager shows."
  # `yes` dies of SIGPIPE when sdkmanager exits; only sdkmanager's exit status matters here.
  LICENSE_STATUS=0
  set +o pipefail
  yes | "$SDKMANAGER" --licenses >/dev/null || LICENSE_STATUS=$?
  set -o pipefail
  [[ $LICENSE_STATUS -eq 0 ]] || die "sdkmanager --licenses failed (exit $LICENSE_STATUS)."
elif [[ -t 0 ]]; then
  note "Read each licence and answer y to accept it (or re-run with --accept-android-licenses)."
  "$SDKMANAGER" --licenses || true
else
  licenses_accepted || die "The Android SDK licences are not accepted. Read them with
  $SDKMANAGER --licenses
and accept them there, or re-run this script with --accept-android-licenses."
fi
licenses_accepted || die "The Android SDK licence was not accepted; sdkmanager cannot install packages."

step "Installing platform-tools, emulator and $SYSTEM_IMAGE"
"$SDKMANAGER" --install "platform-tools" "emulator" "$SYSTEM_IMAGE"
[[ -x "$ANDROID_HOME/emulator/emulator" ]] || die "The emulator package did not install."

step "Checking the emulator's own view of acceleration (emulator -accel-check)"
ACCEL_OUT="$(kvm_run "$ANDROID_HOME/emulator/emulator" -accel-check 2>&1 || true)"
if ! grep -q "is installed and usable" <<<"$ACCEL_OUT"; then
  printf '%s\n' "$ACCEL_OUT" | sed 's/^/    emulator: /' >&2
  kvm_diagnostic
fi
note "$(grep 'is installed and usable' <<<"$ACCEL_OUT" | head -n1)"

# ----------------------------------------------------------------------------- 5. profile
step "Writing $ENV_FILE"
mkdir -p "$(dirname "$ENV_FILE")" "$BIN_DIR"
cat >"$ENV_FILE" <<EOF
# Written by Tapdance's install-android-worker.sh. Safe to edit.
export ANDROID_HOME="$ANDROID_HOME"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export JAVA_HOME="$JAVA_HOME"
case ":\$PATH:" in
  *":$ANDROID_HOME/emulator:"*) ;;
  *) export PATH="$BIN_DIR:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:\$PATH" ;;
esac
EOF
for rc in "$HOME/.profile" "$HOME/.bashrc"; do
  touch "$rc"
  if ! grep -qF "$ENV_FILE" "$rc"; then
    printf '\n# Tapdance Android worker\n[ -f "%s" ] && . "%s"\n' "$ENV_FILE" "$ENV_FILE" >>"$rc"
    note "Sourced from $rc"
  fi
done

# ----------------------------------------------------------------------------- 6. Tapdance
step "Installing Tapdance"
if [[ -n "$TAPDANCE_NPM_SPEC" ]]; then
  [[ "$TAPDANCE_NPM_SPEC" != "tapdance" && "$TAPDANCE_NPM_SPEC" != tapdance@* ]] || die "The npm package \"tapdance\" is an unrelated TAP test harness, not this project. Install from git (the default) until Tapdance is published under its own name."
  npm install -g --prefix "$HOME/.local" "$TAPDANCE_NPM_SPEC"
else
  if [[ -f "$TAPDANCE_SOURCE_DIR/package.json" ]]; then
    note "Using the existing checkout in $TAPDANCE_SOURCE_DIR (not pulling; update it yourself with git)."
  else
    note "Cloning $TAPDANCE_REPO ($TAPDANCE_REF) into $TAPDANCE_SOURCE_DIR"
    git clone --depth 1 --branch "$TAPDANCE_REF" "$TAPDANCE_REPO" "$TAPDANCE_SOURCE_DIR"
  fi
  # pnpm comes from Corepack (bundled with Node 22) at the version package.json pins; npx is the
  # fallback when a Node build ships without Corepack.
  if command -v corepack >/dev/null 2>&1; then PNPM=(corepack pnpm); else PNPM=(npx --yes pnpm@10.20.0); fi
  (
    cd "$TAPDANCE_SOURCE_DIR"
    export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
    "${PNPM[@]}" install --frozen-lockfile
    "${PNPM[@]}" build
  )
  CLI_MAIN="$TAPDANCE_SOURCE_DIR/packages/cli/dist/main.js"
  [[ -f "$CLI_MAIN" ]] || die "Build finished but $CLI_MAIN is missing."
  cat >"$BIN_DIR/tapdance" <<EOF
#!/usr/bin/env bash
exec node "$CLI_MAIN" "\$@"
EOF
  chmod 0755 "$BIN_DIR/tapdance"
fi
command -v tapdance >/dev/null 2>&1 || die "tapdance is not on PATH ($BIN_DIR)."
note "tapdance $(tapdance --version)"

# ----------------------------------------------------------------------------- 7. Simlock settings
step "Configuring the Simlock worker for a headless VM"
# One emulator at a time (see the Terraform README: 4 vCPUs / 16 GB fit one emulator well, and
# a second would make both slow enough for agent timeouts). Raise it with --max-emulators only
# after you have measured a larger machine.
CAPACITY_JSON="{\"strategy\":\"fixed\",\"config\":{\"maxRunning\":$MAX_EMULATORS,\"android\":{\"maxRunning\":$MAX_EMULATORS,\"maxDevices\":$MAX_EMULATORS}}}"
tapdance simlock --local config set capacity "$CAPACITY_JSON"
tapdance simlock --local config set android.emulator.headless true
tapdance simlock --local config set android.emulator.gpu "$EMULATOR_GPU"
tapdance simlock --local config set android.emulator.audio false
tapdance simlock --local config set android.emulator.bootAnimation false

# ----------------------------------------------------------------------------- 8. checks + service
step "tapdance worker check --android-only"
CHECK_JSON="$(kvm_run tapdance --json worker check --android-only)" || {
  kvm_run tapdance worker check --android-only || true
  die "tapdance worker check reported a KVM failure (exit code 10). Nothing more will be installed."
}
kvm_run tapdance worker check --android-only || true
FAILED="$(printf '%s' "$CHECK_JSON" | node -e '
  let s = ""; process.stdin.on("data", (c) => (s += c)).on("end", () => {
    const d = JSON.parse(s); const checks = d.checks ?? d.result?.checks ?? [];
    console.log(checks.filter((c) => c.status === "fail").map((c) => c.id).join(" "));
  });' 2>/dev/null || echo "unparsed")"
if [[ "$FAILED" == "unparsed" ]]; then
  note "Could not read the JSON check result; review the table above before continuing."
elif [[ -n "$FAILED" ]]; then
  die "tapdance worker check failed: $FAILED. Fix those items (the table above has the fix for each) and run this script again."
fi

if [[ $INSTALL_SERVICE -eq 1 ]]; then
  step "Enabling lingering so the worker survives logout and reboot"
  sudo loginctl enable-linger "$USER"
  UID_NUM="$(id -u)"
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$UID_NUM}"
  sudo systemctl start "user@$UID_NUM.service"
  # The user's systemd manager keeps the groups it started with. If it started before we added the
  # kvm group, the worker service would not be able to open /dev/kvm: restart the manager once.
  MANAGER_PID="$(systemctl show "user@$UID_NUM.service" -p MainPID --value)"
  KVM_GID="$(getent group kvm | cut -d: -f3)"
  if [[ -n "$MANAGER_PID" && "$MANAGER_PID" != "0" ]] && ! awk '/^Groups:/' "/proc/$MANAGER_PID/status" | grep -qw "$KVM_GID"; then
    note "Restarting your systemd user manager so it gets the kvm group"
    sudo systemctl restart "user@$UID_NUM.service"
  fi

  step "tapdance worker install --service"
  kvm_run tapdance worker install --service
else
  step "tapdance worker install (no service)"
  kvm_run tapdance worker install
fi

step "Final acceleration check"
ACCEL_OUT="$(kvm_run "$ANDROID_HOME/emulator/emulator" -accel-check 2>&1 || true)"
grep -q "is installed and usable" <<<"$ACCEL_OUT" || kvm_diagnostic
note "$(grep 'is installed and usable' <<<"$ACCEL_OUT" | head -n1)"

# ----------------------------------------------------------------------------- optional boot test
if [[ $BOOT_TEST -eq 1 ]]; then
  step "Boot test: one throw-away emulator (separate AVD folder, deleted afterwards)"
  BOOT_DIR="$(mktemp -d)"
  BOOT_PORT=5584
  cleanup_boot() {
    "$ANDROID_HOME/platform-tools/adb" -s "emulator-$BOOT_PORT" emu kill >/dev/null 2>&1 || true
    sleep 3
    rm -rf "$BOOT_DIR"
  }
  trap cleanup_boot EXIT
  export ANDROID_AVD_HOME="$BOOT_DIR"
  echo no | "$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager" create avd -n tapdance-boot-test -k "$SYSTEM_IMAGE" >/dev/null
  # -accel on: fail instead of falling back to software emulation.
  kvm_run env ANDROID_AVD_HOME="$BOOT_DIR" "$ANDROID_HOME/emulator/emulator" -avd tapdance-boot-test -port "$BOOT_PORT" \
    -no-window -no-audio -no-snapshot -no-boot-anim -gpu "$EMULATOR_GPU" -accel on >"$BOOT_DIR/emulator.log" 2>&1 &
  START=$SECONDS
  BOOTED=0
  while (( SECONDS - START < 600 )); do
    if [[ "$("$ANDROID_HOME/platform-tools/adb" -s "emulator-$BOOT_PORT" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == "1" ]]; then
      BOOTED=1; break
    fi
    sleep 5
  done
  if [[ $BOOTED -eq 1 ]]; then
    note "Emulator booted in $((SECONDS - START)) s."
  else
    tail -n 30 "$BOOT_DIR/emulator.log" >&2 || true
    die "The test emulator did not finish booting within 10 minutes (log above)."
  fi
  cleanup_boot
  trap - EXIT
  unset ANDROID_AVD_HOME
fi

# ----------------------------------------------------------------------------- 9. next steps
cat <<EOF

==> Done. This machine is a Tapdance Android worker serving local agents.

Open a new shell (or run: . "$ENV_FILE") so ANDROID_HOME and tapdance are on PATH.

Join it to your gateway. The gateway must be reachable over TLS (wss://) or a private network
such as Tailscale; Tapdance refuses ws:// to a public address.

  1. On the gateway machine, mint a join token for this worker (shown once):
       tapdance gateway token --role worker --label $WORKER_LABEL

  2. On this machine, join. The token is read from a hidden prompt (or from stdin when piped),
     never from the command line:
       tapdance worker login --accept-gateway-exec --gateway $GATEWAY_URL --label $WORKER_LABEL

     From your laptop over IAP SSH instead (stdin is passed through):
       read -rs TOKEN && printf '%s\n' "\$TOKEN" | gcloud compute ssh INSTANCE --zone ZONE --tunnel-through-iap \\
         --command 'bash -lc "tapdance worker login --accept-gateway-exec --gateway $GATEWAY_URL --label $WORKER_LABEL --token-stdin"'; unset TOKEN

  3. On the gateway: tapdance workers list && tapdance devices

Security, plainly:
  * A joined worker gives the gateway operator rights here. Anyone holding an agent token for that
    gateway can run adb commands on this machine as $USER (Simlock exec, agent-device).
    Leasing is not a sandbox. Use this VM only for testing, with no other secrets on it.
  * Never commit the join token or paste it into an issue. Revoke a leaked one on the gateway:
      tapdance simlock --gateway token list ; tapdance simlock --gateway token revoke <id>
EOF
