# iOS with Tapdance: overview

Where iOS simulators can run, how a remote agent reaches them, which automation backend to pick, and
what has been tested. Words such as **host**, **guard** and **connect target** are defined in the
[glossary](../glossary.md).

## Pick your page

| You have | Go to |
| --- | --- |
| A Mac, and the agent runs on it | [Local](../deployment/local.md) |
| A Mac, and the agent runs elsewhere (a laptop, a Linux VPS) | [Host devices for a remote agent](../deployment/one-command-host.md) |
| No Mac: rent one | [Scaleway Mac mini](scaleway-mac.md) (proven) or [other cloud Macs](other-cloud-macs.md) (MacStadium, AWS EC2 Mac; not run) |
| Android and iOS for one agent | [Android and iOS for one agent](../guides/android-and-ios.md) |

More iOS pages:

- [Simulator management](simulator-management.md): runtimes, warm spares, slim mode, `.app` vs `.ipa`.
- [Browser viewer](../deployment/browser-access.md): watch and drive a simulator from your browser.
- [CI builds](../guides/ci-builds.md): Xcode Cloud, Codemagic and GitHub Actions as build sources,
  and `asc`.
- [Host builds](../guides/host-builds.md): the Mac builds your app from git, so an agent without Xcode
  can test it.

## iOS needs a Mac

The iOS Simulator ships with Xcode, and Xcode runs only on macOS on Apple hardware. So:

- An iOS simulator always runs on a Mac with Xcode installed, its license accepted and its first-launch
  setup done.
- No Linux or Windows machine can host an iOS simulator. Tapdance never tries. On a non-Mac host,
  `tapdance worker check` and `tapdance doctor` report iOS as skipped, not as a failure.
- Your agent does **not** need to run on the Mac. It can run on a Linux VPS and reach the Mac in
  device-only mode.

## How a remote agent reaches the Mac

```text
 agent's machine (laptop or Linux VPS;          Mac host (Apple Silicon, Xcode)
 no Xcode needed)                               ┌──────────────────────────────────┐
 ┌──────────────────────────────┐   Tailscale   │ guard  (the only thing reachable)│
 │ your agent (Claude Code,     │   (private,   │   │                              │
 │ Codex, Cursor, ...)          │    HTTPS)     │   ▼                              │
 │   │ MCP or CLI               │               │ worker (Simlock, loopback only)  │
 │   ▼                          │               │   ├─ creates, boots and wipes    │
 │ Tapdance (CLI / MCP / SDK) ──┼──────────────>│   │  its own iOS simulators      │
 │   connect target + pairing   │               │   └─ agent-device (UI, video)    │
 │   token (tdg_…)              │               │ iOS Simulator (iPhone …)         │
 └──────────────────────────────┘               └──────────────────────────────────┘
```

- **The agent** talks to Tapdance through MCP (`tapdance mcp`) or the CLI.
- **Tapdance** on the agent's machine holds the session's lease, keeps it renewed, uploads your `.app`,
  and saves screenshots, recordings and logs on the agent's machine.
- **The guard** on the Mac is the only thing the agent's machine can reach. It allows a fixed list of
  device actions, checks the pairing token on each request, and logs every request. It never gives a
  shell on the Mac. `tapdance host up` installs it; `tapdance connect` on the agent's machine saves the
  Mac as a connect target.
- **The worker** is a [Simlock](https://github.com/callstackincubator/simlock) daemon (MIT) on the Mac,
  on loopback only. It creates, boots and wipes the simulators.
- **[agent-device](https://github.com/callstack/agent-device)** (MIT) runs on the Mac too. Through the
  guard, Tapdance uploads the app, reads the screen's elements, taps, types and swipes, and downloads
  screenshots and MP4 recordings to the agent's machine.

In local mode, the agent, Tapdance and the worker are all on one Mac, with no guard. Gateway mode
(workers joined to a Simlock gateway) is advanced and has run on one Mac only: see
[gateway mode](../deployment/gateway-mode.md).

Why Tapdance is built this way is in the [architecture decision record](../architecture-decision.md).

## iOS automation backends

Tapdance has one set of platform-neutral tools (`inspect_screen`, `tap`, `swipe`, `type_text`,
`take_screenshot`, and so on). On iOS, one of two backends does the work. The `ios.uiBackend` config key
picks it.

| | agent-device (default) | AXe (opt-in) |
| --- | --- | --- |
| Config | `ios.uiBackend: "agent-device"` | `ios.uiBackend: "axe"` |
| Upstream | [callstack/agent-device](https://github.com/callstack/agent-device), MIT | [cameroncooke/AXe](https://github.com/cameroncooke/AXe), MIT (bundles Meta's IDB, MIT) |
| Where Tapdance runs | Anywhere: on the Mac, or on another machine through the guard | Only on the Mac that hosts the simulator |
| Simlock device set | Simlock's own set (default) or Xcode's default set | Must be Xcode's default set: `drivers.ios.deviceSet default` |
| How to enable | `tapdance worker install` | `tapdance worker install --ios-backend axe`, plus `brew install cameroncooke/axe/axe` |
| Tested for real | Yes: on one Mac, and on Mac hosts in device-only mode | Yes, on one Mac: a custom app's sign-in flow ([evidence](../testing/evidence/2026-11-01-axe.md)) |

Why AXe is limited: AXe drives the simulator through CoreSimulator on the Mac it runs on, so it cannot
reach a simulator on another machine. It also reads only Xcode's default device set, while Simlock keeps
its simulators in a separate set by default. `tapdance worker install --ios-backend axe` therefore sets
Simlock's `drivers.ios.deviceSet` to `default` and writes `ios.uiBackend: "axe"` to
`~/.tapdance/config.json`. With a remote Mac, Tapdance refuses AXe with `NOT_SUPPORTED` and tells you to
set `ios.uiBackend` back to `"agent-device"`.

Switching the device set has side effects. Read
[simulator-management.md](simulator-management.md#device-sets) before you do it on a Mac that already
has Simlock simulators.

## What is tested

As of 2026-11-07 ([STATUS.md](../../STATUS.md) has the details):

- **Proven, local mode on one Mac** (MacBook Pro M1 Pro, macOS 26.5, Xcode 26.5, iPhone 16 with iOS
  18.5): lease, install a custom `.app`, launch, inspect, tap, swipe, screenshot, MP4, logs, crash logs,
  release, through the CLI and MCP over stdio ([evidence](../testing/evidence/2026-11-01-local-ios.md)).
  The browser viewer and read-only `asc` commands on the same Mac. The AXe backend
  ([evidence](../testing/evidence/2026-11-01-axe.md)).
- **Proven, device-only mode with a rented Mac:** a Scaleway Mac mini M1-M driven from a Mac
  ([evidence](../testing/evidence/2026-11-06-rented-mac-ios.md)) and from a Linux VPS
  ([evidence](../testing/evidence/2026-11-07-vps-rented-mac-ios.md)): CLI and MCP, host builds of a
  private app, and a 47 MB `.app` zip uploaded from Linux.
- **Proven, two hosts for one agent:** a Linux VPS leased Android on a Google Cloud N2 VM and iOS on the
  rented Mac in one session, through the CLI and MCP, with one host down
  ([evidence](../testing/evidence/2026-11-07-two-hosts-android-ios.md)).
- **Proven on one Mac only:** gateway mode ([evidence](../testing/evidence/2026-11-01-gateway-single-host.md)).
- **Not run:** gateway mode across machines, MacStadium and AWS EC2 Mac, physical iPhones, installs of
  an iOS app from CI on a Mac host, the full device loop over Streamable HTTP MCP (`tapdance mcp
  --http`).

If you run something listed as not run, please file what happened with `tapdance report`.

## Security in short

On iOS, installing an app is code execution on the Mac: a simulator app runs as an ordinary macOS
process under the account that runs the worker. Host from a dedicated account, or a Mac that holds
nothing of yours, and give a pairing token only the areas it needs (`host up --scope`). The
[threat model](../security/threat-model.md) explains what a token can do and what limits it.

## Apple licensing note

Apple's macOS Software License Agreement limits how Macs may be leased and virtualized. Cloud Mac
providers enforce a 24-hour minimum rental for this reason (Scaleway and AWS both cite it). Before you
offer Macs to other people as a shared or short-duration service, review the current macOS license
([apple.com/legal/sla](https://www.apple.com/legal/sla/)) with someone qualified to read it. Tapdance's
managed cloud is future work and does not exist yet.
