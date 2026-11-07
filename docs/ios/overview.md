# iOS with Tapdance: overview

This page explains what an iOS setup needs, how the pieces connect, which automation backend to pick,
and what has actually been tested. The other pages in this folder go into each part:

| Page | What it covers |
| --- | --- |
| [local-mac-worker.md](local-mac-worker.md) | Turning a Mac you own into a worker: install, runtimes, joining a gateway, keeping it awake |
| [scaleway-mac.md](scaleway-mac.md) | Renting an Apple Silicon Mac mini from Scaleway and making it a worker |
| [macstadium.md](macstadium.md) | Using a MacStadium bare-metal Mac as a worker (manual) |
| [aws-ec2-mac.md](aws-ec2-mac.md) | Using an AWS EC2 Mac dedicated host as a worker (manual) |
| [simulator-management.md](simulator-management.md) | What Simlock does with simulators, runtimes, the warm pool, slim mode, `.app` vs `.ipa` |
| [remote-browser-access.md](remote-browser-access.md) | Watching and driving a simulator from your browser |
| [xcode-cloud-integration.md](xcode-cloud-integration.md) | Xcode Cloud, Codemagic and GitHub Actions as build sources, and `asc` |

## iOS needs a Mac

The iOS Simulator ships with Xcode, and Xcode runs only on macOS on Apple hardware. So:

- An iOS simulator always runs on a Mac with Xcode installed, its license accepted and its first-launch
  setup done.
- No Linux VPS, Windows machine or Linux KVM server can host an iOS simulator. Tapdance never tries.
  On a non-Mac host, `tapdance worker check` and `tapdance doctor` report iOS as skipped:
  "needs a macOS worker with Xcode".
- Your coding agent does **not** need to run on the Mac. It can run on an ordinary Linux VPS and reach
  the Mac through a gateway.

## Architecture

```text
 Linux VPS (no KVM, no Xcode)                         Mac (Apple Silicon, Xcode)
 ┌──────────────────────────────┐                     ┌──────────────────────────────┐
 │ Coding agent (Claude Code,   │                     │ Simlock worker daemon        │
 │ Codex, Cursor, ...)          │                     │  ├─ creates/boots/wipes its  │
 │   │ MCP or CLI               │                     │  │  own iOS simulators       │
 │   ▼                          │   outbound wss://   │  ├─ agent-device daemon      │
 │ Tapdance (CLI / MCP / SDK)   │◄────────────────────┤  │  (UI, screenshots, video) │
 │   │ HTTP + agent token       │   (worker dials     │  └─ stream + input helpers   │
 │   ▼                          │    out; no inbound  │                              │
 │ Simlock gateway (127.0.0.1)  │    port on the Mac) │ iOS Simulator (iPhone 16 ...)│
 │ behind TLS or Tailscale      │                     │                              │
 └──────────────────────────────┘                     └──────────────────────────────┘
```

- **The agent** talks to Tapdance through MCP (`tapdance mcp`) or the CLI.
- **Tapdance** holds the session's lease, keeps it renewed, uploads your `.app`, and stores screenshots,
  recordings and logs on the agent's machine.
- **The gateway** is a [Simlock](https://github.com/callstackincubator/simlock) daemon (MIT) that owns no
  devices. It queues lease requests and routes them to workers. `tapdance gateway setup` starts one.
- **The Mac worker** is a Simlock worker joined to the gateway with `tapdance worker login`. It dials
  out to the gateway over an authenticated WebSocket, so the Mac needs no inbound port.
- **[agent-device](https://github.com/callstack/agent-device)** (MIT) runs on the worker. Simlock fronts
  it, so Tapdance on the VPS can upload the app, read the accessibility tree, tap, type, swipe, and
  download screenshots and MP4 recordings back to the VPS.

You can also run everything on one Mac (local mode): the agent, Tapdance and the worker on the same
machine, with no gateway. The recommended setup for a remote agent is device-only mode instead (`host up`
on the Mac, `connect` on the agent's machine): see [one-command-host.md](../deployment/one-command-host.md).

Why Tapdance is built this way, and what it adds on top of Simlock and agent-device, is in the
[architecture decision record](../architecture-decision.md).

## iOS automation backends

Tapdance has one set of platform-neutral tools (`inspect_screen`, `tap`, `swipe`, `type_text`,
`take_screenshot`, and so on). On iOS, the work behind them is done by one of two backends. You choose
with the `ios.uiBackend` config key.

| | agent-device (default) | AXe (opt-in) |
| --- | --- | --- |
| Config | `ios.uiBackend: "agent-device"` | `ios.uiBackend: "axe"` |
| Upstream | [callstack/agent-device](https://github.com/callstack/agent-device), MIT | [cameroncooke/AXe](https://github.com/cameroncooke/AXe), MIT (bundles Meta's IDB, MIT) |
| Where Tapdance runs | Anywhere: on the Mac, or on a VPS through a gateway | Only on the Mac that hosts the simulator |
| Simlock device set | Simlock's own set (default) or Xcode's default set | Must be Xcode's default set: `drivers.ios.deviceSet default` |
| How to enable | `tapdance worker install` | `tapdance worker install --ios-backend axe`, plus `brew install cameroncooke/axe/axe` |
| Tested for real | Yes, on one Mac (see below) | No |

Why AXe is limited: AXe drives the simulator through CoreSimulator on the Mac it runs on, so it cannot
reach a simulator on another machine. It also reads only Xcode's default device set, while Simlock keeps
its simulators in a separate set by default. `tapdance worker install --ios-backend axe` therefore sets
Simlock's `drivers.ios.deviceSet` to `default` and writes `ios.uiBackend: "axe"` to
`~/.tapdance/config.json`. If you use AXe with a remote Mac worker, Tapdance refuses with
`NOT_SUPPORTED` and tells you to set `ios.uiBackend` back to `"agent-device"`.

Switching the device set has side effects; read
[simulator-management.md](simulator-management.md#device-sets) before you do it on a Mac that already
has Simlock simulators.

## What is verified today

[STATUS.md](../../STATUS.md) is the source of truth. As of 2026-11-01:

| Flow | State | Evidence |
| --- | --- | --- |
| Local mode on one Mac (MacBook Pro M1 Pro, macOS 26.5, Xcode 26.5, iPhone 16 / iOS 18.5 simulator): lease, launch, inspect, tap, swipe, screenshot, MP4, logs, crash logs, release, through the CLI and MCP over stdio | Verified | [2026-11-01-local-ios.md](../testing/evidence/2026-11-01-local-ios.md) |
| Browser viewer (`tapdance view`) stream, input and human take-over, on the same Mac | Verified (scripted, and in a real browser through a gateway on the same Mac) | same, and [2026-11-01-gateway-single-host.md](../testing/evidence/2026-11-01-gateway-single-host.md) |
| `asc` pass-through (`tapdance asc -- ...`) | Verified for read-only commands | same |
| Installing a custom simulator `.app` (`examples/ios-demo`) in local mode | Verified locally; not yet run through a gateway | STATUS F-01 |
| Gateway + joined Mac worker, both on the same Mac (CLI, MCP stdio, viewer) | Verified | [2026-11-01-gateway-single-host.md](../testing/evidence/2026-11-01-gateway-single-host.md) |
| Agent on another Mac → rented Scaleway Mac mini, device-only mode over Tailscale (CLI and MCP, host build of a private app) | Verified once | [2026-11-06-rented-mac-ios.md](../testing/evidence/2026-11-06-rented-mac-ios.md) |
| Linux VPS agent → separate Mac worker | Device-only mode verified: a VPS drove a rented Scaleway Mac mini (CLI and MCP, host build, `.app` upload) ([2026-11-07-vps-rented-mac-ios.md](../testing/evidence/2026-11-07-vps-rented-mac-ios.md)); gateway mode **not tested** | STATUS Q-08 |
| AXe backend | **Not tested** (written and unit-tested only) | STATUS U-02, Q-09 |
| Scaleway Mac mini M1-M | Verified once ([guide](scaleway-mac.md)) | STATUS G-05, G-06 |
| MacStadium, AWS EC2 Mac | **Not tested**; these pages are written from provider docs (same steps as Scaleway) | STATUS G-05 |
| Physical iPhone leases | **Not tested** | STATUS D-06 |
| Streamable HTTP MCP (`tapdance mcp --http`) | Partly verified (auth, tool list, read calls); full device loop not run | STATUS S-01 |

Treat every two-machine and cloud-Mac procedure in this folder as a careful plan, not a proven recipe.
If you run one, please file what happened with `tapdance report`.

## Security in one paragraph

Read this before you join a Mac to anything. An agent token that can lease on a Simlock worker is
close to shell access on that Mac as the user that runs the daemon (Simlock's `exec` and agent-device
can run commands and install apps there). A joined worker gives its gateway operator rights over it:
whoever controls the gateway can lease, release, install runtimes and read the worker's config.
Leasing is **not** a sandbox. Use a dedicated macOS user (or a dedicated Mac) for the worker, keep the
gateway behind TLS or on a private network such as Tailscale, and never commit tokens. Tapdance
stores tokens in `~/.tapdance/credentials.json` (mode 600) or reads them from `TAPDANCE_TOKEN`; it
refuses config files that contain a token.

## Apple licensing note

Apple's macOS Software License Agreement limits how Macs may be leased and virtualized. Cloud Mac
providers enforce a 24-hour minimum rental for this reason (Scaleway and AWS both cite it). Before you
offer Macs to other people as a shared or short-duration service, review the current macOS license
([apple.com/legal/sla](https://www.apple.com/legal/sla/)) with someone qualified to read it. Tapdance's
managed cloud is future work and does not exist yet.
