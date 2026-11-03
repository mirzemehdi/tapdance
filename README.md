# Tapdance

> Let your agent put your app through its paces.

Tapdance lets an AI coding agent (Claude Code, Codex, Cursor or any MCP client) lease an Android
emulator or an iOS simulator, install an app, drive its UI, and collect screenshots, recordings and
logs. It is a CLI, an MCP server and a TypeScript SDK. The device can be on your own computer, on your
laptop serving a remote agent, on a self-hosted Linux machine with KVM, or on a rented Mac. The agent
uses the same commands and tools in every case.

**Product principle: Tapdance orchestrates; existing tools execute.** Device leasing, workers and the
gateway come from [Simlock](https://github.com/callstackincubator/simlock). UI automation comes from
[agent-device](https://github.com/callstack/agent-device), with optional backends such as
[AXe](https://github.com/cameroncooke/AXe). App Store Connect work goes through the official
[`asc`](https://github.com/rorkai/App-Store-Connect-CLI) CLI, Android work can go through
[Google's Android CLI](https://developer.android.com/cli), and Xcode builds. Tapdance adds sessions,
routing, safety checks, artifacts, a browser viewer and one consistent CLI/MCP/SDK surface on top.

Tapdance is free and open source under the [MIT license](LICENSE). It needs no account.

> **Status: 0.1.0, unreleased.** The full loop works on one Mac with iOS simulators and Android
> emulators, locally and through a gateway on the same Mac. An agent on a Linux VPS has tested a real
> app on a Mac through the worker guard over Tailscale, Android and iOS
> ([field runs](docs/testing/evidence/2026-11-02-vps-field-runs.md)). Linux workers, a gateway across two
> machines, and cloud workers are implemented or documented but **not yet proven**. Many recent
> features are unit-tested only. Read [STATUS.md](STATUS.md) before you rely on anything.

## Quick start (local, macOS, iOS simulator)

This path is tested end to end on a Mac. You need macOS with Xcode and at least one iOS simulator
runtime installed, Node.js 22.13 or newer, and Corepack (it ships with Node).

Tapdance is not published to npm yet. The npm name `tapdance` belongs to an unrelated package today,
so do not `npm install -g tapdance`. Install from source:

```bash
git clone https://github.com/mirzemehdi/tapdance.git
cd tapdance
corepack enable --install-directory ~/.local/bin pnpm   # no sudo; plain `corepack enable` also works if it may write next to node
pnpm install
pnpm build
mkdir -p ~/.local/bin
ln -s "$PWD/packages/cli/dist/main.js" ~/.local/bin/tapdance   # ~/.local/bin must be on your PATH
tapdance --version
```

Then, from your app's project directory:

```bash
tapdance init --mode local --yes        # writes tapdance.config.json
tapdance config set platforms.android.enabled false   # iOS only: skip Android checks
tapdance worker install                 # configures and starts the bundled Simlock worker
tapdance doctor                         # checks Xcode, SDKs, the worker and your lease
tapdance device lease --platform ios --device "iPhone 16"
tapdance app launch com.apple.Preferences
tapdance ui inspect                     # elements with refs, roles and labels
tapdance ui tap --text General
tapdance screenshot                     # saved under ./tapdance-artifacts/<session>/
tapdance device release
```

The first lease creates and boots a simulator, so it takes longer (about 40 seconds on the M1 Pro
test machine). Later leases from the warm pool take about half a second. Leave Android enabled if you
have the Android SDK command-line tools; otherwise `doctor` reports them as missing. The
[installation guide](docs/installation.md) and the [quick start](docs/quick-start.md) cover each step
in more detail.

To give an agent the same abilities, run the MCP server. For Claude Code:

```bash
claude mcp add tapdance -- tapdance mcp
```

If your agent does not inherit your shell's `PATH`, use the absolute path instead:
`node /absolute/path/to/tapdance/packages/cli/dist/main.js mcp`.

The agent then gets tools for the whole test loop:

- **Device:** `lease_device`, `release_device`, `list_devices`.
- **Apps:** `install_app` (`.app`, `.apk`, `.aab`), `build_app` (build on the device's host from git), `launch_app` (deep links, arguments, intents, `locale`), `stop_app`, `kill_app`, `uninstall_app`, `clear_app_data`, `list_apps`.
- **UI:** `inspect_screen`, `tap`, `tap_sequence` (timed taps for rhythm and timing tests), `type_text`, `swipe`, `press_key`, `wait_for`, `handle_alert`.
- **Device state:** `set_device_setting`, `push_file`, `pull_file`, `clipboard`, `notifications`, `measure_performance`, `device_shell` (inside an Android emulator only).
- **Evidence:** `take_screenshot`, `start_recording`/`stop_recording`, `get_logs`, `get_test_artifacts`.
- **People and plans:** `request_human` (a sign-in or purchase sheet a person should do), `run_scenario`.

The full list is in [docs/mcp.md](docs/mcp.md). Run `tapdance view` to watch the device in your
browser, take over, and hand back. `install_app` accepts only paths inside the project, so build there
(iOS: `xcodebuild … -sdk iphonesimulator -derivedDataPath ./build`).

Android leases use the lighter `google_apis` image unless the agent asks for another: the Play Store
image (`image_tag: "google_apis_playstore"`) only for Play Billing and Play sign-in tests, Google's ATD
test images (`google_atd`) for the lightest app-only runs ([image tiers](docs/platforms/android.md)).

The MCP server has been verified with a scripted MCP client on a real iOS simulator; it has not yet
been run from inside Claude Code, Codex or Cursor. Android has run on Android 34 emulators on a Mac
([evidence](docs/testing/evidence/2026-11-01-android.md)), not yet on a Linux worker (see
[STATUS.md](STATUS.md) P-01, D-02). Testing in-app purchases: [purchase testing](docs/guides/purchase-testing.md).

### Agent on a VPS, devices on your Mac

On a Mac (or Linux machine) with nothing installed, one line installs the prerequisites (after one
confirmation), Tapdance itself, and runs `host up`:

```bash
curl -fsSL https://raw.githubusercontent.com/mirzemehdi/tapdance/main/scripts/host-setup.sh | bash -s -- --label my-mac
```

With Tapdance already installed:

```bash
tapdance host up --label my-vps                     # on the Mac: worker, guard, pairing, Tailscale, self-test
tapdance connect <endpoint host up printed> < pairing-<label>.token   # on the VPS
```

`host up` sets up device-only mode step by step and prints the `connect` line to paste on the agent's
machine; the token goes to a mode-600 file, never to the terminal. Turn on **HTTPS Certificates** in the
Tailscale admin first: the guard then gets an `https://` address and `tapdance view --tailscale` on the
VPS shows live video. `--scope interaction,inspection,screenshots,streaming,input` issues a token that
cannot install apps ([why that matters on iOS](docs/security/threat-model.md)).

On the VPS the agent works as it would locally. An agent without Xcode gets an iOS app onto the Mac's
simulator with `tapdance app build --git <repo> --ref main` (or MCP `build_app`) once the Mac's owner
allows that repository ([builds on the host](docs/deployment/one-command-host.md#builds-on-the-host)).

#### Day-to-day control on the Mac

| Command | What it does |
| --- | --- |
| `tapdance host status` | State of each `host up` step: worker, guard, pairing, Tailscale, memory used by devices. |
| `tapdance host token` | Copies the pairing token to the clipboard to hand to the agent (`--show` prints it once). |
| `tapdance host warm android=0,ios=0` | How many booted spare devices to keep (memory vs. lease speed); restarts the worker only when nothing is leased. |
| `tapdance host builds enable --repo <url> --git-auth gh --protected-ref main` | Let the agent build that repository's app on this Mac (off by default; `disable`, `status`, `key`). |
| `tapdance worker cleanup` | Release device claims left by a worker that restarted mid-lease (the guard also does it before each lease). |
| `tapdance host pause` | Stop for now, keep the pairing: the guard (and its `caffeinate`), the Tailscale exposure, the worker and every emulator/simulator stop, and nothing restarts at login. The VPS can no longer reach the Mac. |
| `tapdance host resume` | Start again after `pause`, with the same settings; the agent reconnects with its existing token while it is still valid. |
| `tapdance host down` | Stop hosting: remove the guard service and its `tailscale serve` entry (tokens kept unless `--revoke`). |
| `tapdance host down --all` | Stop everything and take access away: guard, Tailscale exposure, worker, devices, and revoke every token. Pair again with `host up`. |
| `tapdance worker guard revoke all` | Revoke every token only; hosting keeps running. |

Details and what each one leaves behind: [Take access away](docs/security/personal-mac.md#take-access-away)
and [Pause, resume, or stop for good](docs/deployment/one-command-host.md#pause-resume-or-stop-for-good).

`host up` has run on the owner's Mac (with Node and Android Studio already installed) and an agent on a
VPS has tested through it for a day ([field runs](docs/testing/evidence/2026-11-02-vps-field-runs.md)).
Not yet run: a fresh Mac, Linux hosts, builds on the host with a real repository; `pause`, `resume` and
`down --all` are unit-tested only. See [one-command host](docs/deployment/one-command-host.md). For
devices on a VM in your own Google Cloud project, see [Google Cloud N2](docs/deployment/google-cloud-n2.md)
(written, not yet run end to end).

## Deployment modes

| Mode | Agent runs on | Devices run on | Config | Tested today (see [STATUS.md](STATUS.md)) |
| --- | --- | --- | --- | --- |
| Local | Your Mac or Linux machine | The same machine | `provider: "local"` | **iOS simulator on macOS: yes**, on one Mac ([evidence](docs/testing/evidence/2026-11-01-local-ios.md)). **Android emulator on macOS: yes** ([evidence](docs/testing/evidence/2026-11-01-android.md)); Linux not run. |
| Laptop as remote worker | An ordinary VPS (no KVM needed) that also runs the gateway | Your laptop or Mac, which dials out to the gateway | `provider: "self-hosted"` | Gateway + joined worker + CLI, MCP and viewer worked with **both on one Mac** ([evidence](docs/testing/evidence/2026-11-01-gateway-single-host.md)). **Not yet tested across two machines over a real network.** |
| Self-hosted KVM worker (Google Cloud N2 first; OVH, dedicated Linux) | A VPS | A Linux machine with KVM, set up with `tapdance host up` (device-only) | `provider: "self-hosted"`, endpoint = guard URL | Guide, Terraform and the Linux steps of `host up` written. **Never provisioned; Android not run on Linux.** |
| Personal Mac, device-only | A VPS | Your Mac, reached over Tailscale through `tapdance worker guard` (one command: `tapdance host up`) | `provider: "self-hosted"`, endpoint = guard URL | Full MCP loop through the guard on one Mac ([evidence](docs/testing/evidence/2026-11-01-worker-guard.md)). **An agent on a VPS tested a real app through it over Tailscale**, Android and iOS, with the CLI ([field runs](docs/testing/evidence/2026-11-02-vps-field-runs.md)). |
| Cloud Mac worker (Scaleway, MacStadium, AWS EC2 Mac) | A VPS | A rented Mac | `provider: "self-hosted"` | Documentation only. **Not exercised.** |
| Managed cloud | Anywhere | Hosted by Tapdance | `provider: "cloud"` | **Not built.** The value is reserved and fails with `NOT_SUPPORTED`. |

Windows can run the CLI and MCP server as a control machine, but it cannot be a worker: Simlock
supports macOS and Linux workers only.

## How it fits together

```text
  AI agent (Claude Code, Codex, Cursor, ...)      a person (CLI, browser viewer)
        |  MCP: stdio or Streamable HTTP               |
        v                                              v
  +------------------------------------------------------------------+
  | Tapdance (control machine: your laptop or a VPS)                 |
  |   CLI  |  MCP server  |  SDK                                     |
  |   sessions, lease keepalive, artifacts, viewer, external tools   |
  |   DeviceProvider contract -> provider-simlock                    |
  +--------------------------------+---------------------------------+
                                   |  HTTP(S) + agent token
                                   |  (Simlock API + agent-device proxy)
                                   v
  +------------------------------------------------------------------+
  | Simlock gateway (optional; any Node host, no KVM needed)         |
  |   leases, queue, worker registry, routing                        |
  +--------------------------------+---------------------------------+
                                   ^  worker dials OUT over wss://
                                   |  (join token; no inbound port)
  +--------------------------------+---------------------------------+
  | Simlock worker (Mac: iOS + Android; Linux with KVM: Android)     |
  |   creates, boots and wipes its own simulators and emulators      |
  |   agent-device: UI tree, taps, typing, screenshots, video        |
  +--------------------------------+---------------------------------+
                                   v
               iOS simulator (simctl)  /  Android emulator (adb)
```

In local mode there is no gateway: Tapdance talks straight to the Simlock worker on the same machine.
The [architecture decision record](docs/architecture-decision.md) explains what Tapdance reuses, what
it adds, and why.

## What Tapdance adds

- **Session-scoped device access.** No command or MCP tool takes a device id. Everything acts on the
  lease held by the current session, and release only targets that lease.
- **An agent-grade tool surface.** Semantic taps by text, id, ref or selector, with coordinates as a
  fallback. Settle diffs after actions. Strict input validation. No host shell: the only shell is
  `device_shell`, inside a leased Android emulator's own VM.
- **Device state without a catalogue of hacks.** Settings, files (including the iOS Files app),
  clipboard, notifications, app locale, kill like a user, timed tap sequences; anything else Android
  can do goes through `device_shell`.
- **People in the loop.** `request_human` asks a person to sign in or approve a purchase in the viewer
  and waits until they hand back; passwords never pass through the agent.
- **Lease lifecycle for one-shot CLIs.** A detached keepalive renews the lease, releases idle leases
  after 30 minutes by default, and stops when the session releases.
- **Artifacts on the agent's machine.** Screenshots, MP4 recordings and logs land under
  `tapdance-artifacts/<session>/` with a JSON manifest.
- **A browser viewer.** `tapdance view` streams the leased device's screen to your browser from a
  small server that listens on loopback by default, accepts input, and lets you take over from the agent and hand back.
- **Guided self-hosting.** `tapdance host up` sets up a Mac for a remote agent in one command;
  `tapdance gateway setup`, `tapdance worker login` and `tapdance worker check` wrap Simlock's commands
  and add the host checks it lacks, such as KVM diagnostics.
- **A guard for personal Macs.** The worker guard exposes a device API, not a host API: an allowlist,
  per-token scopes, local approval of pairings, an audit log, and builds only from repositories the
  owner allows.
- **External tools without a command catalogue.** `tapdance tool <name> -- <args>` and the MCP
  `execute_tool` tool forward arguments unchanged to `asc`, `android`, `axe`, `maestro`, `fastlane`
  or `xcodebuild` (agents get `fastlane` and `xcodebuild` only when the user lists them in
  `tools.mcpEnabled` in `~/.tapdance/config.json`). Agents discover commands with the tool's own `--help`.
- **Field reports.** `tapdance report` writes a redacted, issue-ready bug report.

## CLI at a glance

Run `tapdance <command> --help` for every option. Global flags: `--json`, `--config <path>`,
`--session <id>`, `--quiet`.

| Area | Commands |
| --- | --- |
| Setup | `init`, `doctor`, `config show / path / set / set-token [--endpoint <url>]` |
| Devices | `devices [list]`, `devices install <platform> <version> [--image-tag <tag>]`, `workers list` |
| Lease | `device lease`, `device status`, `device renew`, `device release`, `device profile create / edit / list / delete` |
| Device state | `device setting`, `device push / pull`, `device clipboard`, `device notifications`, `device perf`, `device shell` |
| People | `device request-human [--no-wait \| --cancel]`, `device done`, `view [--tailscale]` |
| Apps | `app install <path>`, `app build --git <url> --ref <ref>`, `app launch <appId>`, `app stop / kill / uninstall / clear <appId>`, `app list` |
| UI | `ui inspect`, `ui tap`, `ui sequence`, `ui swipe`, `ui type`, `ui wait`, `ui alert`, `ui key` |
| Evidence | `screenshot`, `record start / stop`, `logs`, `artifacts` |
| Scenarios | `run <scenario.yaml>` |
| Personal-Mac host | `host up / status / token / warm / builds / pause / resume / down [--all]`; `connect <endpoint>` on the agent's machine |
| Self-hosting | `gateway setup / token / status`, `worker check / install / login / logout / start / stop / status / logs / restart / cleanup`, `simlock`, `worker guard start / pair / tokens / revoke / policy / audit` |
| External tools | `tools list / doctor / versions`, `tool <name> -- <args>`, `asc -- <args>`, `android -- <args>` |
| Agents | `mcp` (stdio), `mcp --http` (Streamable HTTP) |
| Reporting | `report` |

Results go to stdout and progress to stderr. Exit codes: 2 usage or config, 3 lease, 4 provider or
worker, 5 auth, 6 capacity, 7 device or element, 8 not supported, 9 timeout, 10 host check,
11 a person is holding the device in the viewer, 12 scenario failed, 13 cancelled.

## What works today, and what is not proven yet

Working for real, on one Mac (macOS 26.5, Xcode 26.5, iPhone 16 simulator on iOS 18.5, Android 34 emulators):

- lease, launch, inspect, tap by text and ref, back, swipe, wait, alert check, screenshot, MP4
  recording, logs and crash logs, release, through both the CLI and the MCP server over stdio;
- uploading, installing and driving a custom simulator `.app` (the demo in `examples/ios-demo`);
- the background keepalive;
- the browser viewer's stream, input and human take-over;
- `asc` pass-through;
- device-only mode (`tapdance worker guard`): the full MCP loop through the guard on one Mac, plus
  malicious-client unit tests ([evidence](docs/testing/evidence/2026-11-01-worker-guard.md));
- Android emulators: the device loop, app install (APK and `.aab`), device settings, files, shell and
  device profiles ([Android](docs/testing/evidence/2026-11-01-android.md),
  [device state](docs/testing/evidence/2026-11-01-device-state-and-profiles.md)).

Proven from a second machine: an agent on an Ubuntu VPS drove a real app on the Mac through the guard
over Tailscale, Android and iOS (installs of 75 MB APKs, about 1,000 calls per run, timed taps playing a
rhythm-game lesson on time), with the CLI
([field runs](docs/testing/evidence/2026-11-02-vps-field-runs.md)).

Also proven on that Mac, through a real Simlock gateway with the worker joined over its outbound
uplink (both daemons on the same machine): the CLI loop, the MCP integration test, and the viewer in
a real browser ([evidence](docs/testing/evidence/2026-11-01-gateway-single-host.md)).

Built but **not yet proven** on real infrastructure:

- a gateway on a VPS with a joined laptop, N2 or Mac worker across a real network;
- Android on a Linux worker;
- Google's Android CLI;
- a full device loop over the Streamable HTTP MCP transport (its bearer-token check and basic calls
  have run; a whole lease-to-release loop has not);
- the MCP server from inside a real agent (Claude Code, Codex or Cursor): only a scripted MCP client
  has driven it;
- the dedicated macOS worker account, and `host up` on a fresh Mac;
- builds on the host from a real repository, scoped tokens, `view --tailscale`, and the newest iOS
  features (Files app, clipboard, locale, Notification Center): unit-tested only;
- installing a custom app through a gateway.

Not built: running external tools on remote workers, Windows workers, cloud-Mac provisioning, and the
hosted cloud. [STATUS.md](STATUS.md) has one row per requirement in [PRODUCT.md](PRODUCT.md), with
evidence for every "done" claim.

## Security in one paragraph

Leasing is not a sandbox. An agent token on a Simlock worker is close to shell access as the user who
runs the worker daemon, and a worker joined to a gateway gives that gateway the same reach — so
`tapdance worker login` refuses unless you pass `--accept-gateway-exec`, and is meant for dedicated
machines. **On a personal Mac use device-only mode**: `tapdance worker guard` is the only endpoint the
remote side reaches; it enforces a local policy, its own revocable tokens approved at the Mac, an
allowlisted device API, limits and an audit log
([docs/security/personal-mac.md](docs/security/personal-mac.md)). Even through the guard, **installing
an iOS simulator app runs code on the Mac** as the account that hosts it (simulator apps are not
sandboxed from macOS): host from a dedicated standard account, or give the agent a token without
install (`host up --scope …`). What each area allows, per platform:
[docs/security/threat-model.md](docs/security/threat-model.md). Use TLS or a private network such as
Tailscale for anything beyond one machine; Tapdance refuses `ws://` to public hosts. Never commit
tokens: Tapdance refuses to load a config file that contains one. A saved token is sent only to the
endpoint it was saved for, and a project `tapdance.config.json` cannot change which programs agents may
run (those settings live in `~/.tapdance/config.json`). Full threat model:
[SECURITY.md](SECURITY.md).

## Documentation

| Topic | Where |
| --- | --- |
| Requirements and status | [PRODUCT.md](PRODUCT.md), [STATUS.md](STATUS.md) |
| Getting started | [Installation](docs/installation.md), [quick start](docs/quick-start.md), [troubleshooting](docs/troubleshooting.md) |
| Reference | [CLI reference](docs/cli-reference.md), [MCP server and tools](docs/mcp.md), [configuration](docs/configuration.md), [external tools](docs/tools.md), [scenarios](docs/scenarios.md), [compatibility matrix](docs/compatibility.md) |
| Agent setup | [Claude Code](docs/agents/claude-code.md), [Codex](docs/agents/codex.md), [Cursor](docs/agents/cursor.md) |
| Platforms | [Android](docs/platforms/android.md) (image tiers), [iOS](docs/platforms/ios.md) |
| Guides | [Testing in-app purchases](docs/guides/purchase-testing.md), [build in CI, test with Tapdance](docs/guides/ci-builds.md), [private repositories for builds on the host](docs/guides/private-repositories.md) |
| Security | [Threat model](docs/security/threat-model.md), [personal Mac and the worker guard](docs/security/personal-mac.md), [security policy](SECURITY.md) |
| Architecture | [Architecture decision record](docs/architecture-decision.md) |
| Deployment | [Local](docs/deployment/local.md), [one-command host](docs/deployment/one-command-host.md), [self-hosted overview](docs/deployment/self-hosted-overview.md), [laptop as a worker](docs/deployment/laptop-worker.md), [Google Cloud N2](docs/deployment/google-cloud-n2.md), [OVH Public Cloud](docs/deployment/ovh-public-cloud.md), [dedicated Linux server](docs/deployment/dedicated-linux-server.md), [worker security](docs/deployment/worker-security.md), [browser access](docs/deployment/browser-access.md) |
| iOS and Mac workers | [Overview](docs/ios/overview.md), [local Mac worker](docs/ios/local-mac-worker.md), [simulator management](docs/ios/simulator-management.md), [remote browser access](docs/ios/remote-browser-access.md), [Scaleway Mac mini](docs/ios/scaleway-mac.md), [MacStadium](docs/ios/macstadium.md), [AWS EC2 Mac](docs/ios/aws-ec2-mac.md), [Xcode Cloud](docs/ios/xcode-cloud-integration.md) |
| Infrastructure as code | [Terraform for a Google Cloud N2 worker](infrastructure/terraform/google-cloud-n2/README.md) (never applied yet) |
| Testing | [Unit tests](docs/testing/unit-tests.md), [end-to-end procedures](docs/testing/e2e-procedures.md), [field testing](docs/testing/field-testing.md), [evidence](docs/testing/evidence/README.md) |
| Project | [Contributing](CONTRIBUTING.md), [security policy](SECURITY.md), [changelog](CHANGELOG.md), [notices and licenses](NOTICE.md) |
| Rules for coding agents working on this repo | [AGENTS.md](AGENTS.md), [CLAUDE.md](CLAUDE.md) |

## Credits

Tapdance is a thin layer over other people's work. Thank you to:

- [Simlock](https://github.com/callstackincubator/simlock) (MIT) for leasing, workers, the gateway,
  device lifecycle, and the screen stream and input sockets the viewer uses.
- [agent-device](https://github.com/callstack/agent-device) (MIT) for UI snapshots, selectors,
  gestures, app upload and artifact download.
- [AXe](https://github.com/cameroncooke/AXe) (MIT), the optional iOS Simulator backend.
- [App Store Connect CLI](https://github.com/rorkai/App-Store-Connect-CLI) (MIT), [fastlane](https://github.com/fastlane/fastlane)
  (MIT), [Maestro](https://github.com/mobile-dev-inc/maestro) (Apache-2.0) and
  [Google's Android CLI](https://developer.android.com/cli), which Tapdance runs as external tools.
- [Loupe](https://github.com/bmcreations/loupe) (Apache-2.0), whose human/agent hand-off model the
  viewer follows; [simslim](https://github.com/MobAI-App/simslim) (MIT) for the slim-simulator idea;
  [DeviceDeck](https://github.com/devicelab-dev/DeviceDeck) (Apache-2.0), reviewed while choosing a
  streaming approach.

No code from these projects is copied into Tapdance. See [NOTICE.md](NOTICE.md) for licenses.
