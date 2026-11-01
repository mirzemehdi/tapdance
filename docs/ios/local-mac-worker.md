# Your Mac as an iOS worker

This page turns a Mac you own (a MacBook, a Mac mini under your desk, a Mac Studio) into a Tapdance
worker. The worker runs iOS simulators for agents: either agents on the same Mac (local mode), or an
agent on a Linux VPS that reaches the Mac through a gateway.

Status: local mode on one Mac is verified
([evidence](../testing/evidence/2026-11-01-local-ios.md)). Joining a Mac to a gateway on a separate
VPS is implemented but **not yet tested** across two machines ([STATUS.md](../../STATUS.md), M-02 and
Q-08).

## What you need

| Item | Requirement |
| --- | --- |
| Hardware | A Mac. Apple Silicon is what has been tested (M1 Pro, 16 GB). |
| macOS | A version your Xcode supports. Tested: macOS 26.5. The live screen stream needs macOS 14 or later (a Simlock requirement). |
| Xcode | Installed, selected, license accepted, first launch done. Tested: Xcode 26.5. |
| iOS runtime | At least one. Tested: iOS 18.5. |
| Node.js | 22.13 or later. |
| Disk | Xcode itself, plus about 8 GiB free per iOS runtime you install, plus room for simulators. |

Windows cannot be a worker: Simlock runs on macOS and Linux only.

## 1. Set up Xcode

Install Xcode from the Mac App Store or from [developer.apple.com/download](https://developer.apple.com/download/)
(an Apple ID is required). Then:

```sh
sudo xcode-select -s /Applications/Xcode.app
sudo xcodebuild -license accept
sudo xcodebuild -runFirstLaunch
xcodebuild -version
```

## 2. Install an iOS runtime

Simlock creates simulators only on runtimes that are already installed. Tapdance's leases never ask
Simlock to download one, so install what you need first. Either use Xcode's own command:

```sh
xcodebuild -downloadPlatform iOS
```

or ask the bundled Simlock to install a specific version:

```sh
tapdance devices install ios 18.5
```

`tapdance devices install` runs Simlock's `component install` on this Mac. Per the
[Simlock docs](https://github.com/callstackincubator/simlock): it needs about 8 GiB of free disk, iOS
16.0 is the oldest runtime it can install, one download runs per platform at a time, and an install
times out after 20 minutes by default. See [simulator-management.md](simulator-management.md#runtimes)
for more.

## 3. Install Tapdance and check the Mac

Install the CLI from source, as in [installation.md](../installation.md): clone the repository, run
`pnpm install && pnpm build`, and link `packages/cli/dist/main.js` onto your `PATH` as `tapdance`.
Tapdance is not on npm yet. Do **not** run `npm install -g tapdance`: that npm name belongs to an
unrelated package (Tapdance's will be `@tapdance/cli`).

Then check the machine:

```sh
tapdance worker check
```

On a Mac this reports Node.js, Xcode, and the available simulator runtimes, plus Android checks. Pass
`--android-only` to skip the iOS checks, or read the Android lines and ignore them if you only want iOS.

## 4. Install the worker

```sh
tapdance worker install
```

This configures the Simlock worker that ships with Tapdance and starts it:

- turns on Simlock's `agent-device` capability and points it at the bundled agent-device,
- turns on live screen streaming and remote input (`capabilities.stream.enabled`,
  `capabilities.input.enabled`) for the [browser viewer](remote-browser-access.md),
- restarts the daemon and prints its status.

Options (from `tapdance worker install --help`):

| Option | Effect |
| --- | --- |
| `--no-stream` | Leave screen streaming and input off. The browser viewer will not work. |
| `--ios-backend <backend>` | `agent-device` (default; works through gateways) or `axe` (only when Tapdance and the agent run on this Mac). |
| `--service` | Also install the worker as a login service (launchd), so it starts when you log in. |

### Choosing `--ios-backend axe`

Use AXe only if your agent runs on this same Mac. The command:

1. sets Simlock's `drivers.ios.deviceSet` to `default`, because AXe reads only Xcode's default device
   set, and
2. writes `ios.uiBackend: "axe"` to `~/.tapdance/config.json`.

You also need AXe itself:

```sh
brew install cameroncooke/axe/axe
```

AXe's README states support for Xcode 26 and Xcode 27. The AXe backend has **not** been run on a real
Mac yet (STATUS U-02). If this Mac already has Simlock simulators in Simlock's own device set, the
switch can leave iOS turned off; see
[simulator-management.md](simulator-management.md#device-sets) for the clean-up steps.

## 5a. Use it locally

If the agent runs on this Mac:

```sh
tapdance init --mode local
tapdance doctor
tapdance device lease --platform ios --device "iPhone 16" --os 18.5
tapdance ui inspect
tapdance screenshot
tapdance device release
```

For MCP, add `tapdance mcp` to your agent's MCP configuration; the agent then gets `lease_device`,
`install_app`, `inspect_screen`, `tap`, `take_screenshot`, `release_device` and the other tools.

## 5b. Join a gateway (serve a remote agent)

The gateway usually runs on the VPS where your agent runs (`tapdance gateway setup`; it needs no KVM
and no Xcode). It must be reachable from the Mac over TLS (`wss://`) or a private network such as
Tailscale.

1. On the gateway machine, mint a join token for this Mac. It is printed once:

   ```sh
   tapdance gateway token --role worker --label my-mac
   ```

   `tapdance gateway setup` also prints one join token for the first worker.

2. On the Mac, join. Pipe the token in so it does not land in your shell history:

   ```sh
   pbpaste | tapdance worker login --accept-gateway-exec --gateway wss://gateway.example.com --label my-mac
   ```

   You can also set `TAPDANCE_WORKER_TOKEN` or type the token at the prompt. `tapdance worker login`
   refuses `ws://` to a public address, because the token would travel in plain text. Plain `ws://` is
   accepted only for private addresses (for example a Tailscale `100.x.y.z` address).

   `--accept-gateway-exec` is required. It acknowledges that the gateway, and every agent token it
   issues, can run programs on this Mac as the worker's user (Simlock's exec; `simctl spawn` starts any
   program). Without it the command refuses with `FORBIDDEN`. On a personal Mac, use a dedicated macOS
   user for the worker, or do not join a gateway at all.

3. On the gateway machine, check that the Mac is connected:

   ```sh
   tapdance workers list
   tapdance devices --platform ios
   ```

   `tapdance workers list` needs an operator token; `tapdance gateway setup` saves one on the gateway
   machine.

What joining changes on the Mac:

- The worker opens no inbound port. It dials out and reconnects on its own (1 s, doubling up to 30 s).
- The Mac's own Simlock HTTP API is turned off while joined. Agents on the Mac itself must then go
  through the gateway too (`tapdance init --mode self-hosted --endpoint https://gateway.example.com`).
- `--no-viewer` on `worker login` leaves streaming and remote input off.
- **The gateway gets operator rights over this Mac's devices**, and anyone with an agent token on the
  gateway can run commands here as your user through Simlock and agent-device. Join only a gateway you
  control. See the security notes below.

To leave the gateway:

```sh
tapdance worker logout
```

Then revoke the join token on the gateway machine:

```sh
tapdance simlock --gateway token list
tapdance simlock --gateway token revoke <token-id>
```

## 6. Keep the Mac awake

A sleeping Mac takes the worker offline. Agents then get `WORKER_OFFLINE` (retryable), and a lease
that is not renewed before its TTL runs out expires.

- While agents work on a laptop, run `caffeinate -is` in a terminal (`tapdance worker login` reminds
  you). `caffeinate` does not stop a closed lid from sleeping a laptop, unless the laptop runs in
  clamshell mode (on power, with an external display attached).
- On a desktop Mac that serves as a permanent worker, turn off system sleep in System Settings >
  Energy, or with `sudo pmset -a sleep 0`.
- Install the worker as a login service (`tapdance worker install --service`) so it comes back after a
  restart. A launchd login service starts when the user logs in, so a Mac that reboots to the login
  window needs automatic login, or someone to log in, before the worker runs.

## Day-to-day commands

| Command | What it does |
| --- | --- |
| `tapdance worker status` | Devices, leases and capabilities on this worker |
| `tapdance worker logs` | The worker daemon log |
| `tapdance worker stop` / `start` / `restart` | Control the daemon. `restart` ends agent-device sessions on it. Leases on a stopped worker end when their TTL runs out. |
| `tapdance devices install ios <version>` | Install another runtime |
| `tapdance simlock <args>` | The bundled Simlock CLI, for operators (for example `tapdance simlock --local doctor`) |

## Security notes for a personal Mac

- Leasing is not a sandbox. An agent with a lease can run `simctl` commands through Simlock and drive
  agent-device on your Mac as the user running the daemon. Run the worker under a separate macOS user
  account if this Mac also holds your personal data, SSH keys or signing certificates.
- Simlock never hands out your own simulators: it creates and manages its own. That protects your
  devices, not the rest of your account.
- Simlock has no per-operation "approve on the Mac" prompt (STATUS X-08). Your controls are: which
  gateway you join, the `capabilities.*` switches, draining the worker, revoking its token, and
  stopping the daemon.
- For your options on a personal Mac, including device-only mode (`tapdance worker guard`, verified
  on one Mac; Tailscale exposure untested), see [personal-mac.md](../security/personal-mac.md).
- Never commit tokens. Tapdance keeps them in `~/.tapdance/credentials.json` (mode 600) or reads
  `TAPDANCE_TOKEN`; Simlock stores the join token in `~/.simlock/config.json`, readable only by your
  user.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `tapdance worker check` fails on Xcode | Xcode not selected, license not accepted, or first launch not run | Run the three `sudo` commands in step 1 |
| "Simulator runtimes: none" | No iOS runtime installed | `xcodebuild -downloadPlatform iOS` or `tapdance devices install ios <version>` |
| Lease fails because a runtime is missing | Simlock does not download during a lease | Install the runtime first, then lease with `--os` set to an installed version |
| Viewer or stream fails with `EACCES` on `simlock-screen-capture` | The package manager dropped the execute bit on Simlock's helpers | `tapdance worker start` or `tapdance worker install` restores it |
| Mac not listed in `tapdance workers list` | Token wrong or revoked (HTTP 401), token paired with another machine (HTTP 403), or the Mac cannot reach the gateway | Read `tapdance worker logs`; mint a new token with `tapdance gateway token --role worker`; check the URL and that your proxy passes WebSocket upgrades |
| `WORKER_OFFLINE` on the agent side | The Mac slept, lost network, or the daemon stopped | Wake the Mac, check `tapdance worker status`; the worker reconnects on its own |
| iOS turned off after `--ios-backend axe` | Simulators left in Simlock's own device set (`device-set-changed`) | See [simulator-management.md](simulator-management.md#device-sets) |
