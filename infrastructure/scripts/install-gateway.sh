#!/usr/bin/env bash
# install-gateway.sh — set up a Tapdance gateway on an ordinary Linux VPS (no KVM needed).
#
# The gateway owns no devices. Workers (a laptop, a Mac, a KVM/N2 VM) dial out to it; agents on
# this VPS lease devices through it. Under the hood it is a Simlock gateway
# (https://github.com/callstackincubator/simlock, MIT) started by `tapdance gateway setup`.
#
# What it does (safe to run again):
#   1. checks Ubuntu 22.04/24.04 and sudo
#   2. installs Node.js 22 from the NodeSource apt repository, and git
#   3. installs Tapdance from a git checkout (the npm name "tapdance" is an unrelated package)
#   4. runs `tapdance gateway setup` once (it mints a worker join token, an agent token and an
#      operator token; the agent and operator tokens are saved to ~/.tapdance/credentials.json)
#   5. only with a flag: installs Tailscale or Caddy, or a systemd user service for the gateway
#
# The gateway listens on 127.0.0.1:4700 only. Simlock has no TLS: reach it from other machines
# through Tailscale (a private network) or an HTTPS reverse proxy such as Caddy. Never expose
# port 4700 directly to the internet: every token would travel in plain text.
#
# Status: syntax-checked with `bash -n` only. Not yet run on a real VPS. See STATUS.md (M-05, W-05).

set -euo pipefail

TAPDANCE_REPO="${TAPDANCE_REPO:-https://github.com/mirzemehdi/tapdance.git}"
TAPDANCE_REF="${TAPDANCE_REF:-main}"
TAPDANCE_SOURCE_DIR="${TAPDANCE_SOURCE_DIR:-$HOME/tapdance}"
TAPDANCE_NPM_SPEC=""
PUBLIC_URL=""
WORKER_LABEL="worker-1"
AGENT_LABEL="tapdance-agent"
WITH_TAILSCALE=0
CADDY_DOMAIN=""
INSTALL_SERVICE=0
FORCE_SETUP=0
NODE_MAJOR=22
BIN_DIR="$HOME/.local/bin"

usage() {
  cat <<EOF
Usage: install-gateway.sh [options]

  --public-url URL        the https:// address workers and remote agents will use
                          (e.g. https://gateway.example.com or https://vps.tailnet.ts.net)
  --worker-label NAME     label for the first worker's join token (default: $WORKER_LABEL)
  --agent-label NAME      label for this machine's agent token (default: $AGENT_LABEL)
  --force-setup           run 'tapdance gateway setup' again even if a gateway exists
                          (mints new tokens; the old ones stay valid until you revoke them)

  --with-tailscale        install Tailscale from its apt repository (you then run
                          'sudo tailscale up' yourself to sign in)
  --with-caddy DOMAIN     install Caddy from its apt repository and proxy DOMAIN to the gateway
                          with automatic HTTPS (DNS for DOMAIN must point here; ports 80 and 443
                          must be open)
  --service               keep the gateway running after logout and reboot
                          (systemd user service via Simlock, plus loginctl enable-linger)

  --source-dir DIR        git checkout to use or create (default: $TAPDANCE_SOURCE_DIR)
  --repo URL              git URL to clone (default: $TAPDANCE_REPO)
  --ref REF               branch or tag (default: $TAPDANCE_REF)
  --npm-spec SPEC         install from npm once Tapdance is published (never the bare "tapdance")
  -h, --help              show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --public-url) PUBLIC_URL="${2:?}"; shift 2 ;;
    --worker-label) WORKER_LABEL="${2:?}"; shift 2 ;;
    --agent-label) AGENT_LABEL="${2:?}"; shift 2 ;;
    --force-setup) FORCE_SETUP=1; shift ;;
    --with-tailscale) WITH_TAILSCALE=1; shift ;;
    --with-caddy) CADDY_DOMAIN="${2:?--with-caddy needs a domain}"; shift 2 ;;
    --service) INSTALL_SERVICE=1; shift ;;
    --source-dir) TAPDANCE_SOURCE_DIR="${2:?}"; shift 2 ;;
    --repo) TAPDANCE_REPO="${2:?}"; shift 2 ;;
    --ref) TAPDANCE_REF="${2:?}"; shift 2 ;;
    --npm-spec) TAPDANCE_NPM_SPEC="${2:?}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

step() { printf '\n==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
die()  { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
apt_install() { sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$@"; }

if [[ -n "$CADDY_DOMAIN" && -z "$PUBLIC_URL" ]]; then PUBLIC_URL="https://$CADDY_DOMAIN"; fi
if [[ -n "$PUBLIC_URL" && "$PUBLIC_URL" != https://* ]]; then
  die "--public-url must start with https:// (workers then join with wss://). Plain http is only for private networks; leave --public-url out in that case."
fi

# ----------------------------------------------------------------------------- 1. preflight
step "Checking this machine"
[[ "$(id -u)" -ne 0 ]] || die "Run this as a normal user with sudo, not as root."
command -v sudo >/dev/null 2>&1 || die "sudo is required."
sudo -v
# shellcheck disable=SC1091
. /etc/os-release
[[ "${ID:-}" == "ubuntu" ]] || die "This script targets Ubuntu (found ${PRETTY_NAME:-unknown}). The gateway itself runs on any Linux or macOS host with Node.js 22.13+."
case "${VERSION_ID:-}" in 22.04|24.04) note "OS: $PRETTY_NAME" ;; *) die "Ubuntu 22.04 or 24.04 is required (found $VERSION_ID)." ;; esac
note "No KVM is needed here: the gateway runs no emulators."

# ----------------------------------------------------------------------------- 2. Node.js
step "Installing Node.js $NODE_MAJOR and git"
sudo apt-get update -y
apt_install ca-certificates curl gnupg git
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
fi

# ----------------------------------------------------------------------------- 3. Tapdance
step "Installing Tapdance"
mkdir -p "$BIN_DIR"
export PATH="$BIN_DIR:$PATH"
if [[ -n "$TAPDANCE_NPM_SPEC" ]]; then
  [[ "$TAPDANCE_NPM_SPEC" != "tapdance" && "$TAPDANCE_NPM_SPEC" != tapdance@* ]] || die "The npm package \"tapdance\" is an unrelated TAP test harness, not this project."
  npm install -g --prefix "$HOME/.local" "$TAPDANCE_NPM_SPEC"
else
  if [[ -f "$TAPDANCE_SOURCE_DIR/package.json" ]]; then
    note "Using the existing checkout in $TAPDANCE_SOURCE_DIR (not pulling)."
  else
    git clone --depth 1 --branch "$TAPDANCE_REF" "$TAPDANCE_REPO" "$TAPDANCE_SOURCE_DIR"
  fi
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
for rc in "$HOME/.profile" "$HOME/.bashrc"; do
  touch "$rc"
  grep -qF '# Tapdance bin' "$rc" || printf '\n# Tapdance bin\ncase ":$PATH:" in *":%s:"*) ;; *) export PATH="%s:$PATH" ;; esac\n' "$BIN_DIR" "$BIN_DIR" >>"$rc"
done
note "tapdance $(tapdance --version)"

# ----------------------------------------------------------------------------- 4. gateway setup
step "Starting the gateway"
GATEWAY_HOME="${SIMLOCK_HOME:-$HOME/.simlock}/gateway"
if [[ -f "$GATEWAY_HOME/config.json" && -f "${TAPDANCE_HOME:-$HOME/.tapdance}/credentials.json" && $FORCE_SETUP -eq 0 ]]; then
  note "A gateway already exists in $GATEWAY_HOME; not minting new tokens."
  tapdance simlock --gateway daemon start
  note "Mint a join token for another worker with:"
  note "  tapdance gateway token --role worker --label <worker-name>"
else
  SETUP_ARGS=(--worker-label "$WORKER_LABEL" --agent-label "$AGENT_LABEL")
  [[ -z "$PUBLIC_URL" ]] || SETUP_ARGS+=(--public-url "$PUBLIC_URL")
  cat <<'EOF'
    The next output contains a worker join token. It is shown once, on this terminal only.
    Give it to the person setting up that worker over a private channel. Do not commit it, paste
    it into an issue or chat, or keep it in shell history.
EOF
  tapdance gateway setup "${SETUP_ARGS[@]}"
  note "Ignore the 'npm install -g tapdance' line printed above: that npm name is an unrelated"
  note "package. Install Tapdance on the worker with infrastructure/scripts/install-android-worker.sh"
  note "(Linux) or from a git checkout (macOS) instead."
fi

if [[ $INSTALL_SERVICE -eq 1 ]]; then
  step "Keeping the gateway running after logout and reboot"
  sudo loginctl enable-linger "$USER"
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  # Simlock's `daemon install` writes a systemd user unit for the gateway role (per its
  # "Running the daemon" docs). Not yet exercised by Tapdance on a VPS.
  tapdance simlock --gateway daemon install
fi

# ----------------------------------------------------------------------------- 5. optional TLS / private network
if [[ $WITH_TAILSCALE -eq 1 ]]; then
  step "Installing Tailscale (apt repository from pkgs.tailscale.com)"
  if command -v tailscale >/dev/null 2>&1; then
    note "Tailscale already installed"
  else
    sudo mkdir -p --mode=0755 /usr/share/keyrings
    curl -fsSL "https://pkgs.tailscale.com/stable/ubuntu/${VERSION_CODENAME}.noarmor.gpg" | sudo tee /usr/share/keyrings/tailscale-archive-keyring.gpg >/dev/null
    curl -fsSL "https://pkgs.tailscale.com/stable/ubuntu/${VERSION_CODENAME}.tailscale-keyring.list" | sudo tee /etc/apt/sources.list.d/tailscale.list >/dev/null
    sudo apt-get update -y
    apt_install tailscale
  fi
  cat <<'EOF'
    Next, by hand (it opens a sign-in link):
      sudo tailscale up
      sudo tailscale serve --bg --https=443 http://127.0.0.1:4700
    Workers on the same tailnet then join with wss://<this-machine>.<tailnet>.ts.net
EOF
fi

if [[ -n "$CADDY_DOMAIN" ]]; then
  step "Installing Caddy and proxying https://$CADDY_DOMAIN to the gateway"
  if ! command -v caddy >/dev/null 2>&1; then
    apt_install debian-keyring debian-archive-keyring apt-transport-https
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
    sudo chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
    sudo apt-get update -y
    apt_install caddy
  fi
  CADDYFILE=/etc/caddy/Caddyfile
  # flush_interval -1 passes streamed responses (lease progress, screen stream) through unbuffered;
  # Caddy passes WebSocket upgrades (the worker uplink) without extra settings. See Simlock's
  # "Set up a gateway" page.
  WANT="$(printf '%s {\n\treverse_proxy 127.0.0.1:4700 {\n\t\tflush_interval -1\n\t}\n}\n' "$CADDY_DOMAIN")"
  if [[ "$(sudo cat "$CADDYFILE" 2>/dev/null || true)" != "$WANT" ]]; then
    if sudo test -f "$CADDYFILE"; then sudo cp "$CADDYFILE" "$CADDYFILE.bak.$(date +%Y%m%d%H%M%S)"; fi
    printf '%s\n' "$WANT" | sudo tee "$CADDYFILE" >/dev/null
    sudo systemctl reload caddy || sudo systemctl restart caddy
    note "Wrote $CADDYFILE (previous file backed up next to it)."
  fi
  note "Check: curl https://$CADDY_DOMAIN/v1/healthz   should print {\"ok\":true}"
fi

# ----------------------------------------------------------------------------- next steps
WS_URL="wss://<your-gateway-host>"
[[ -z "$PUBLIC_URL" ]] || WS_URL="${PUBLIC_URL/#https:/wss:}"
cat <<EOF

==> Gateway ready on 127.0.0.1:4700 (local only until you add Tailscale or an HTTPS proxy).

On each worker (laptop, Mac, KVM/N2 VM):
  install Tapdance (Linux: install-android-worker.sh), then
  tapdance worker login --accept-gateway-exec --gateway $WS_URL --label <worker-name>
  (the join token is read from a hidden prompt or stdin; mint more with
   tapdance gateway token --role worker --label <worker-name>)

On this machine:
  tapdance workers list
  tapdance devices
  tapdance doctor

Security, plainly:
  * Whoever controls this gateway, or holds an operator token for it, has operator rights on every
    joined worker. An agent token can run adb/simctl commands on workers as their daemon user.
    Leasing is not a sandbox.
  * Keep port 4700 closed to the internet. Use Tailscale or HTTPS (Caddy).
  * Never commit tokens. ~/.tapdance/credentials.json is mode 600; keep it that way.
EOF
