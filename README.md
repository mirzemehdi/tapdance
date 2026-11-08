# Tapdance

> Let your agent put your app through its paces.

Tapdance lets an AI coding agent (Claude Code, Codex, Cursor or any MCP client) lease an Android
emulator or an iOS simulator, install your app, drive its UI, and bring back screenshots, recordings
and logs. The devices can run on your own computer or on another machine, such as a Mac mini, a Linux
server or a rented Mac. Tapdance is a CLI, an MCP server and a TypeScript SDK, free and open source
under the [GNU AGPL-3.0](LICENSE).

**Status: 0.1.0, not released yet.** The full loop runs on a Mac, and an agent on one machine has
tested real apps on devices on another (Android and iOS). Several features are unit-tested only, and
no recorded run has used Claude Code, Codex or Cursor itself as the MCP client yet. See
[what works today](#what-works-today) and [STATUS.md](STATUS.md).

## Quick start: your Mac, an iOS simulator, 5 minutes

You need macOS with Xcode and one iOS simulator runtime, and Node.js 22.13 or newer.

Tapdance is not on npm yet (the npm name `tapdance` belongs to another package). Install it from
source:

```bash
git clone https://github.com/mirzemehdi/tapdance.git
cd tapdance
mkdir -p ~/.local/bin
corepack enable --install-directory ~/.local/bin pnpm
pnpm install
pnpm build
ln -s "$PWD/packages/cli/dist/main.js" ~/.local/bin/tapdance
tapdance --version
```

`~/.local/bin` must be on your `PATH`. Then, in your app's project folder:

```bash
tapdance init --mode local --yes
tapdance config set platforms.android.enabled false
tapdance worker install
tapdance doctor
```

`init` writes `tapdance.config.json`. The second line skips the Android checks; leave it out if you
have the Android SDK. `worker install` starts the device worker on your Mac, and `doctor` checks
everything. Now lease a simulator and drive it:

```bash
tapdance device lease --platform ios --device "iPhone 16"
tapdance app launch com.apple.Preferences
tapdance ui inspect
tapdance ui tap --text General
tapdance screenshot
tapdance device release
```

The first lease boots a new simulator, so it takes about 40 seconds. Later leases reuse a booted
spare and take about half a second. The screenshot is saved under `./tapdance-artifacts/`.

Give the same tools to your agent. For Claude Code:

```bash
claude mcp add tapdance -- tapdance mcp
```

Codex, Cursor and other details: [connect your agent](docs/agents.md). Step-by-step versions:
[installation](docs/installation.md) and the [quick start guide](docs/quick-start.md).

## Choose your setup

| I want to… | Guide | Status |
| --- | --- | --- |
| Try it on my own Mac (iOS and Android) | [Local](docs/deployment/local.md) | Proven |
| Use my own Mac or Mac mini as a host for an agent elsewhere | [Host devices for a remote agent](docs/deployment/one-command-host.md) | Proven |
| Use a Linux machine with KVM as an Android host | [Linux host with KVM](docs/deployment/dedicated-linux-server.md) | Not run on bare metal (ran on Google Cloud) |
| Run Android emulators on Google Cloud | [Google Cloud N2](docs/deployment/google-cloud-n2.md) | Proven |
| Rent a Mac for iOS | [Scaleway Mac mini](docs/ios/scaleway-mac.md) · [other cloud Macs](docs/ios/other-cloud-macs.md) | Proven on Scaleway · others not run |
| Give one agent Android and iOS on two hosts | [Android and iOS](docs/guides/android-and-ios.md) | Proven |
| Wire up Claude Code, Codex or Cursor | [Connect your agent](docs/agents.md) | Scripted MCP client only |
| Pool many workers behind one address | [Gateway mode](docs/deployment/gateway-mode.md) (advanced) | One Mac only |
| Work on Tapdance itself | [CONTRIBUTING.md](CONTRIBUTING.md) | |

Remote setups use **device-only mode**: on the host, one command installs what is missing and runs
`tapdance host up`; on the agent's machine, `tapdance connect` saves the host. The agent can reach
only the host's guard, never a shell. [How it works](docs/how-it-works.md) explains the pieces, and
the [glossary](docs/glossary.md) the words.

## What works today

Proven on real devices:

- The whole test loop on a Mac, through the CLI and the MCP server: lease, install, launch, inspect,
  tap, type, swipe, wait, screenshots, MP4 recordings, logs, release.
  [iOS](docs/testing/evidence/2026-11-01-local-ios.md), [Android](docs/testing/evidence/2026-11-01-android.md).
- An agent on one machine testing a real app on a host over Tailscale: the owner's Mac, a Google Cloud
  N2 VM (Android) and a rented Scaleway Mac mini (iOS), with installs and host builds of a private app.
  [Mac](docs/testing/evidence/2026-11-02-vps-field-runs.md),
  [N2](docs/testing/evidence/2026-11-03-vps-n2-android.md),
  [rented Mac](docs/testing/evidence/2026-11-07-vps-rented-mac-ios.md).
- One agent using an Android host and an iOS host in one session
  ([evidence](docs/testing/evidence/2026-11-07-two-hosts-android-ios.md)).
- The browser viewer, with take-over and hand-back; the AXe iOS backend; `asc` pass-through.

Not proven yet:

- Claude Code, Codex or Cursor as the MCP client (only a scripted client has driven Tapdance).
- A gateway across two machines (it has run on one Mac only).
- MacStadium, AWS EC2 Mac, OVH and bare-metal Linux hosts.
- A full device loop over the Streamable HTTP MCP transport.

Not built: external tools on remote hosts, Windows hosts, and a hosted cloud.
[STATUS.md](STATUS.md) lists every feature with its evidence.

## Security in short

- **Leasing is not a sandbox.** A worker's token is close to shell access on its machine. Never expose
  a worker directly.
- **Use device-only mode for any remote host.** The guard is the only thing the agent's machine can
  reach. It allows a fixed list of device actions, with tokens you approve and revoke on the host.
- **Installing an iOS simulator app runs code on the Mac.** Host from a dedicated standard account, or
  pair with a token that cannot install (`tapdance host up --scope …`).
- **Tokens stay out of files you commit.** Tapdance refuses to load a config file that contains one.

Details: [threat model](docs/security/threat-model.md),
[device-only mode](docs/security/device-only-mode.md), [security policy](SECURITY.md).

## Documentation

Start at the [docs index](docs/README.md). Most used:
[CLI reference](docs/cli-reference.md) · [MCP tools](docs/mcp.md) ·
[configuration](docs/configuration.md) · [troubleshooting](docs/troubleshooting.md) ·
[changelog](CHANGELOG.md).

## Credits

Tapdance is a thin layer over other people's work:
[Simlock](https://github.com/callstackincubator/simlock) (leasing, workers, gateway, screen stream),
[agent-device](https://github.com/callstack/agent-device) (UI automation),
[AXe](https://github.com/cameroncooke/AXe) (optional iOS backend), and the
[App Store Connect CLI](https://github.com/rorkai/App-Store-Connect-CLI),
[fastlane](https://github.com/fastlane/fastlane), [Maestro](https://github.com/mobile-dev-inc/maestro)
and [Google's Android CLI](https://developer.android.com/cli), which it runs as external tools. The
viewer's hand-off follows [Loupe](https://github.com/bmcreations/loupe); the slim-simulator idea comes
from [simslim](https://github.com/MobAI-App/simslim); [DeviceDeck](https://github.com/devicelab-dev/DeviceDeck)
was reviewed while choosing a streaming approach. No code from these projects is copied into Tapdance.
Licenses: [NOTICE.md](NOTICE.md).

You may use, change and self-host Tapdance freely. If you offer a modified Tapdance to others as a
network service, the AGPL asks you to share your changes under the same licence.
