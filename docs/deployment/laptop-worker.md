# Your laptop as a worker

> **Personal Mac?** Read [../security/personal-mac.md](../security/personal-mac.md) first: joining a gateway gives it command execution on the Mac; device-only mode (`tapdance worker guard`) does not.
> For device-only mode there is a one-command setup, `tapdance host up` on the Mac and
> `tapdance connect` on the VPS: see [one-command-host.md](one-command-host.md) (not run end to end
> yet). This page describes the other way, joining the laptop to a gateway.

Your coding agent runs on an ordinary VPS. Your laptop or Mac, which can already run an Android
emulator or the iOS Simulator, becomes a **worker**: it dials out to a gateway on the VPS and serves
devices to the agent there. The VPS needs no KVM, and nothing on your laptop is opened to the
internet. This is mode B (M-02 in [PRODUCT.md](../../PRODUCT.md)).

> **Status: not yet tested across two machines.** Every command on this page exists and the single-
> machine parts were run on a Mac, but the full VPS + laptop flow (Q-06) has not been run. See
> [STATUS.md](../../STATUS.md). Please report what you find with `tapdance report`.

Read [self-hosted overview](self-hosted-overview.md) for the roles, and
[worker security](worker-security.md) before you join your personal machine to anything.

## What you need

| Machine | Needs |
| --- | --- |
| VPS (agent + gateway) | Linux or macOS, Node.js 22.13+, git, Corepack. No KVM, no Android SDK, no Xcode. Either a DNS name pointing at it (for Caddy) or Tailscale. |
| Laptop (worker) | macOS (Android and iOS) or Linux (Android only), Node.js 22.13+. Android SDK with command-line tools, `emulator`, `platform-tools`, a JDK, a system image; and/or Xcode with an iOS runtime. See [Android](../platforms/android.md) and [iOS](../platforms/ios.md). |

**Windows cannot be a worker.** Simlock, which runs the worker, supports macOS and Linux only, and
`tapdance worker install` refuses on Windows. A Windows machine can still be the control machine
(CLI and MCP) against a gateway.

Install Tapdance from source on **both** machines (it is not on npm yet, so the
`gateway setup` now points to installing from source):

```bash
git clone https://github.com/tapdance-dev/tapdance.git
cd tapdance && corepack enable && pnpm install && pnpm build
alias tapdance="node $PWD/packages/cli/dist/main.js"
```

## 1. Start the gateway on the VPS

```bash
tapdance gateway setup --worker-label my-laptop --public-url https://gateway.example.com
```

This command:

1. Starts a Simlock gateway daemon, listening on `127.0.0.1:4700` only.
2. Turns on `capabilities.agent-device`, `capabilities.stream` and `capabilities.input` on the
   gateway and restarts it.
3. Mints three tokens: a **worker join token** labelled `my-laptop`, an **agent token** for this
   VPS, and an **operator token**.
4. Saves the agent and operator tokens to `~/.tapdance/credentials.json` (mode 600) and writes
   `~/.tapdance/config.json` with `provider: "self-hosted"`, `endpoint: "http://127.0.0.1:4700"`.
   Pass `--no-configure-here` to skip this.
5. Prints the worker join token **once**. Copy it somewhere safe for step 3; do not paste it into
   chat, issues or committed files.

`--public-url` only changes the instructions it prints. Those printed next steps currently contain
`npm install -g tapdance` (wrong: see above) and a `worker login` line without
`--accept-gateway-exec`; use the commands on this page instead. Need another join token later (a second
laptop, or a lost one)?

```bash
tapdance gateway token --role worker --label my-second-laptop
```

The gateway does not start again after a reboot on its own. To install it as a systemd user service
on a Linux VPS, use Simlock's own command through Tapdance's bundled copy, then keep it running
without a login session:

```bash
tapdance simlock --gateway daemon install
loginctl enable-linger "$USER"
```

This has not been tried with Tapdance. Simlock's "Running the daemon" page describes `daemon install`
for a gateway, while its "Set up a gateway" page says no gateway service file ships; check
`tapdance simlock -- --gateway daemon status` after a reboot, or use your own service manager.

## 2. Make the gateway reachable: TLS or Tailscale

The worker must reach the gateway over TLS or a private network. Tapdance refuses `ws://` to a public
address because the join token would travel in plain text. Pick one.

### Option A: Caddy with a public DNS name

Point `gateway.example.com` at the VPS, open ports 80 and 443 in its firewall, install
[Caddy](https://caddyserver.com/), and use this Caddyfile (from Simlock's gateway docs):

```text
gateway.example.com {
	reverse_proxy 127.0.0.1:4700 {
		flush_interval -1
	}
}
```

Caddy gets a certificate on its own, passes WebSocket upgrades, and `flush_interval -1` passes
streamed responses (lease progress, the live screen) through without buffering. Workers then use
`wss://gateway.example.com`. When Caddy reloads, it drops open WebSockets; workers reconnect within
30 seconds.

### Option B: Tailscale

Put both the VPS and the laptop in the same [Tailscale](https://tailscale.com/) tailnet, enable
HTTPS certificates for the tailnet in the Tailscale admin console, then on the VPS:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:4700
```

Workers then use `wss://<vps-name>.<tailnet>.ts.net`. Nothing is exposed to the public internet.
Whether `tailscale serve` passes Simlock's long-lived WebSocket and streamed responses without
trouble has **not been verified** yet.

Do not set Simlock's `http.host` to `0.0.0.0` on a public VPS: every token would then cross the
internet unencrypted.

## 3. Prepare the laptop

```bash
tapdance worker check     # SDK, images, AVDs, Xcode and runtimes, KVM on Linux
tapdance worker install   # bundled Simlock worker: agent-device, stream and input on; starts it
```

Add `--service` to `worker install` to start the worker at login (a launchd LaunchAgent on macOS, a
systemd user unit on Linux). A macOS LaunchAgent runs only while your user is logged in at the
screen.

Simlock creates its **own** emulators and simulators from the system images and runtimes you have
installed. It never leases the AVDs you made in Android Studio or the simulators you use in Xcode, so
an agent cannot touch them. Install an image or runtime it can use with, for example,
`tapdance devices install android 35` or `tapdance devices install ios 18.5`.

## 4. Join the gateway

Run this on the laptop. Without piped input it prompts for the join token with hidden input, which
keeps the token out of your shell history:

```bash
tapdance worker login --accept-gateway-exec --gateway wss://gateway.example.com --label my-laptop
```

`--accept-gateway-exec` is required. It is your acknowledgement that the gateway, and every agent
token it issues, can run programs on this laptop as your user (Simlock's exec; `simctl spawn` starts
any program). Without it, `worker login` refuses with `FORBIDDEN`. Read
[worker-security.md](worker-security.md) before you pass it, and prefer a dedicated user account or a
dedicated machine.

You can also pipe the token on stdin (`--token-stdin` is the default when stdin is piped), or set
`TAPDANCE_WORKER_TOKEN` for one command.

`worker login` sets these Simlock options on the laptop and restarts the worker:

| Simlock key | Value |
| --- | --- |
| `http.enabled` | `false` (a joined worker is reached only through its gateway) |
| `capabilities.agent-device.enabled` and `.command` | on, bundled agent-device |
| `capabilities.stream.enabled`, `capabilities.input.enabled` | on, unless you pass `--no-viewer` |
| `gateway` | `{"url": "wss://…", "token": "…", "label": "my-laptop"}` |

Simlock keeps the join token in plain text in `~/.simlock/config.json`, readable only by your user.
The first worker that joins with a token is paired with it; another machine using the same token is
refused.

**While joined, agents on the laptop itself must also go through the gateway**, because the laptop's
own HTTP API is off: `tapdance init --mode self-hosted --endpoint <gateway https URL>` plus an agent
token of their own.

## 5. Check and lease from the VPS

```bash
tapdance workers list                       # my-laptop should show "connected"
tapdance devices                            # models and OS versions it can serve
tapdance doctor                             # gateway reachable, token role, capabilities, lease
tapdance device lease --platform android    # or --platform ios on a Mac worker
tapdance app install ./app/build/outputs/apk/debug/app-debug.apk
tapdance screenshot
tapdance device release
```

`tapdance gateway status` shows the same worker list from the gateway's side. For the agent, add the
MCP server on the VPS (`claude mcp add tapdance -- node /path/to/tapdance/packages/cli/dist/main.js mcp`);
the tools are the same as in local mode.

## Reconnects, sleep and going offline

- **Network drops:** the worker redials by itself after 1 second, doubling to at most 30 seconds
  between tries. It needs no inbound port, so changing Wi-Fi networks is fine.
- **While the laptop is away**, the gateway marks it `disconnected` and sends it no new leases.
  Existing leases keep running on the laptop. Tapdance reports commands on them as `WORKER_OFFLINE`
  (exit code 4, marked retryable) and keeps the lease record. If the lease is not renewed before its
  time to live runs out, it expires on the worker.
- **Sleep takes the worker offline.** On macOS, keep it awake while agents work:

  ```bash
  caffeinate -is
  ```

  `-i` prevents idle sleep and `-s` prevents system sleep while on AC power. Closing the lid still
  sleeps most MacBooks unless they run in clamshell mode with power and an external display. On
  Linux, `systemd-inhibit --what=idle:sleep --why="tapdance worker" sleep infinity` does the same
  job while it runs. In device-only mode, `tapdance worker guard install --keep-awake` runs the guard
  service under `caffeinate -i` instead (see
  [Keep the guard running](../security/personal-mac.md#keep-the-guard-running); untested).
- **A reboot** ends leases whose device was not running afterwards (Simlock releases them with reason
  `device-lost`). Start the worker again, or use `--service`.

## What the gateway can do to your laptop

Say this plainly to yourself before joining:

- **A joined worker gives its gateway operator rights on it.** Anyone who controls the gateway, or
  holds an operator token for it, can lease and release any device on your laptop, install and remove
  runtimes and images there, and read the worker's configuration.
- **Every agent token on the gateway is close to shell access on your laptop as your user.** Simlock
  runs `adb` and `simctl` commands for a lease's holder on the worker, and `simctl spawn` can start any
  program. Tapdance's own MCP tools expose no raw shell, but whoever holds the token can call Simlock
  directly.
- **Leasing is not a sandbox.** Your personal AVDs and simulators are not handed out, but your files
  are readable by anything that runs as your user.
- **There is no per-operation "allow this?" prompt on the worker** (X-08 is blocked upstream).

Your controls as the laptop owner:

| You want to | Do |
| --- | --- |
| Stop serving for now | `tapdance worker stop` (leases on it end when their TTL runs out) |
| Turn off the live screen and remote input | `tapdance worker login … --no-viewer`, or `tapdance worker install --no-stream` before joining |
| Leave the gateway for good | `tapdance worker logout`, then on the gateway: `tapdance simlock --gateway token list` and `tapdance simlock --gateway token revoke <id>` |
| Stop new leases but let current ones finish (gateway side) | `tapdance simlock --gateway worker drain <worker id>` |

For stronger separation, run the worker under a separate macOS or Linux user account that has none of
your personal files. We have not tested that setup.

## Troubleshooting

Read the worker's log on the laptop with `tapdance worker logs`.

| The log or command says | Meaning | Fix |
| --- | --- | --- |
| `Uplink to gateway established` | Joined. | Nothing. |
| `Uplink … failed; retrying`, `HTTP 401` | The gateway does not know the token (typo, revoked, minted on another gateway). | Mint a new one with `tapdance gateway token --role worker --label …` and log in again. |
| `Uplink … failed; retrying`, `HTTP 403` | Not a worker token, or already paired with another worker. | Mint a new worker token for this laptop. |
| `Uplink … failed` with another reason | The laptop cannot reach the gateway. | Check the URL, DNS, and that the proxy passes WebSocket upgrades. |
| `Refusing ws:// to public host …` | You gave a plain `ws://` address on the internet. | Use `wss://` behind Caddy, or Tailscale. |
| `workers list` shows `incompatible` | Gateway and worker run Simlock versions that cannot talk. | Use the same Tapdance build on both (it pins Simlock 0.4.0). |
| Lease commands fail with `WORKER_OFFLINE` | The laptop is asleep or offline. | Wake it; retry. |
| `stream unavailable` in the viewer | Streaming is off on the worker or gateway. | Log in again without `--no-viewer`; `gateway setup` enables it on the gateway. |
