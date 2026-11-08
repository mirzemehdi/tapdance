# How Tapdance works

What the pieces are, how an agent reaches a device, and what Tapdance adds on top of the tools it
uses. Words in bold are defined in the [glossary](glossary.md).

## The idea

**Tapdance orchestrates; existing tools execute.** Tapdance does not boot devices or tap screens
itself. It uses:

- [Simlock](https://github.com/callstackincubator/simlock) for leasing, the **worker** that creates
  and wipes devices, and the optional **gateway**.
- [agent-device](https://github.com/callstack/agent-device) for UI automation: the screen's elements,
  taps, typing, screenshots and video. [AXe](https://github.com/cameroncooke/AXe) is an optional iOS
  backend.
- External tools, run with your arguments unchanged: the
  [App Store Connect CLI](https://github.com/rorkai/App-Store-Connect-CLI) (`asc`),
  [Google's Android CLI](https://developer.android.com/cli), Maestro, fastlane and `xcodebuild`.

Tapdance adds sessions, routing, safety checks, artifacts, a browser viewer, and one CLI, MCP server
and TypeScript SDK on top. The [architecture decision record](architecture-decision.md) explains what
is reused and why.

## Three ways to run it

### Local mode: everything on one computer

```text
  your agent ──MCP──> Tapdance ──> worker ──> simulator / emulator
  (all on your Mac)
```

The agent, Tapdance and the devices share one machine. Proven on a Mac with iOS simulators and
Android emulators. Guide: [local](deployment/local.md).

### Device-only mode: the agent elsewhere, devices on a host

```text
  agent's machine                         host (Mac, or Linux with KVM)
  ┌──────────────────────┐   Tailscale    ┌───────────────────────────────┐
  │ your agent           │   (private,    │ guard ──> worker ──> devices  │
  │   └─MCP─> Tapdance ──┼──  HTTPS)  ───>│ (only this is reachable)      │
  └──────────────────────┘                └───────────────────────────────┘
```

The host runs the **guard**, the only thing the agent's machine can reach. The guard allows a fixed
list of device actions, checks a **pairing token** on each request, and keeps an audit log. The agent
never gets a shell on the host. `tapdance host up` sets up the host; `tapdance connect` sets up the
agent's machine.

An agent's machine can connect to several hosts at once, for example a Linux host for Android and a
Mac for iOS. Each one is a **connect target**, and a lease goes to the host that serves the platform.

This is the mode proven across machines: a Linux VPS and a Mac as the agent's machine; the owner's
Mac, a Google Cloud N2 VM and a rented Scaleway Mac mini as hosts; and one agent using two hosts at
once. Guides: [host devices for a remote agent](deployment/one-command-host.md),
[Android and iOS for one agent](guides/android-and-ios.md).

### Gateway mode (advanced)

```text
  agent's machine ──> gateway <── worker on host A
                              <── worker on host B   (workers dial out; no open port)
```

A Simlock gateway pools several workers behind one address. A worker that joins a gateway gives the
gateway command execution on its machine, so it is for dedicated machines only. Gateway mode has run
on one Mac only, never across machines. Guide: [gateway mode](deployment/gateway-mode.md).

## Which setups have run for real

| Setup | Agent runs on | Devices run on | Status |
| --- | --- | --- | --- |
| Local | Your Mac | The same Mac | Proven: iOS ([evidence](testing/evidence/2026-11-01-local-ios.md)) and Android ([evidence](testing/evidence/2026-11-01-android.md)). Local mode on Linux: not run. |
| Your own Mac as a host | A Linux VPS | Your Mac, through the guard | Proven, Android and iOS ([evidence](testing/evidence/2026-11-02-vps-field-runs.md)). |
| Linux host with KVM | A Mac or a Linux VPS | A Google Cloud N2 VM | Proven, Android ([from a Mac](testing/evidence/2026-11-03-gcp-n2-android.md), [from a VPS](testing/evidence/2026-11-03-vps-n2-android.md)). Bare-metal Linux and OVH: not run. |
| Rented Mac | A Mac or a Linux VPS | A Scaleway Mac mini M1-M | Proven, iOS ([from a Mac](testing/evidence/2026-11-06-rented-mac-ios.md), [from a VPS](testing/evidence/2026-11-07-vps-rented-mac-ios.md)). MacStadium and AWS EC2 Mac: not run. |
| Two hosts, one agent | A Linux VPS | N2 for Android, rented Mac for iOS | Proven ([evidence](testing/evidence/2026-11-07-two-hosts-android-ios.md)). |
| Gateway | Anywhere | Workers joined to a gateway | Proven on one Mac only ([evidence](testing/evidence/2026-11-01-gateway-single-host.md)). Across machines: not run. |
| Managed cloud | Anywhere | Hosted by Tapdance | Not built. `provider: "cloud"` fails with `NOT_SUPPORTED`. |

Windows can be an agent's machine (CLI and MCP server) but not a host: Simlock runs workers on macOS
and Linux only.

[STATUS.md](../STATUS.md) has the details for every feature.

## What Tapdance adds

- **Access scoped to the session.** No command or MCP tool takes a device id. Everything acts on the
  **lease** held by the current **session**, and release only targets that lease.
- **Tools made for agents.** Taps by text, id, ref or selector, with coordinates as a fallback. A short
  summary of what changed after each action. Strict input checks. No shell on the host: the only shell
  is `device_shell`, inside a leased Android emulator.
- **Device state.** Settings, files (including the iOS Files app), clipboard, notifications, app
  language, killing an app like a user would, and timed tap sequences.
- **People in the loop.** `request_human` asks a person to sign in or approve a purchase in the
  **viewer**, and waits until they hand back. Passwords never pass through the agent.
- **Leases that look after themselves.** A background **keepalive** renews the lease, releases it
  after 30 minutes without use (by default), and stops when the session releases.
- **Artifacts on the agent's machine.** Screenshots, MP4 recordings and logs land under
  `tapdance-artifacts/<session>/` with a JSON manifest.
- **A browser viewer.** `tapdance view` shows the leased device live. You can watch, take over and
  hand back.
- **Guided hosting.** `tapdance host up` sets up a host for a remote agent in one command, and
  `scripts/host-setup.sh` installs what it needs first. `tapdance worker check` adds host checks that
  Simlock lacks, such as KVM diagnostics.
- **A guard for hosts.** The guard exposes device actions, not the host: an allow-list, per-token
  scopes, pairings approved at the host, an audit log, and **host builds** only from repositories the
  owner allows.
- **External tools without a command list.** `tapdance tool <name> -- <args>` and the MCP
  `execute_tool` tool pass arguments unchanged to `asc`, `android`, `axe`, `maestro`, `fastlane` or
  `xcodebuild`. Agents read each tool's own `--help`. See [external tools](tools.md).
- **Bug reports.** `tapdance report` writes a redacted, issue-ready report.

## Inside the agent's machine

```text
  AI agent (Claude Code, Codex, Cursor, …)      a person (CLI, browser viewer)
        │  MCP: stdio or Streamable HTTP              │
        ▼                                             ▼
  ┌───────────────────────────────────────────────────────────────┐
  │ Tapdance: CLI · MCP server · SDK                              │
  │   sessions, keepalive, artifacts, viewer, external tools      │
  │   connect targets and routing → Simlock provider              │
  └──────────────────────────────┬────────────────────────────────┘
                                 │ HTTPS + token
                                 ▼
         guard on a host (device-only)  ·  gateway  ·  local worker
```

The CLI and the MCP server both use the same SDK (`@tapdance/sdk`), so they behave the same. The code
layout is in [CONTRIBUTING.md](../CONTRIBUTING.md).
