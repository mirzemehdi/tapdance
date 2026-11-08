# Glossary

The words these docs use, and what each one means. Every page uses them the same way.

## In plain words

| You might say | These docs say |
| --- | --- |
| the phone, the device | an Android **emulator** or an iOS **simulator** |
| borrow a phone, give it back | **lease** it, **release** it |
| the machine that runs the phones | the **host** |
| the computer your agent runs on | the **agent's machine** |
| the private network between your machines | your **tailnet**, made by [Tailscale](https://tailscale.com) (free for personal use) |
| the key to your phones | the **pairing token** file |
| the lock on the machine that runs the phones | the **guard** |
| letting a remote agent use only the phones | **device-only mode** |
| the hardware feature emulators need on Linux | **KVM** |
| the Google Cloud machine type used for Android | **N2** (`n2-standard-4`) |

## Machines

**Agent's machine.** The computer where your AI agent runs, and where Tapdance's CLI or MCP server
runs for it. Your laptop, or a Linux VPS. It needs no Xcode, Android SDK or KVM when the devices are on
a host. The CLI's help sometimes says **control machine**: it means the same thing.

**Host.** The machine that runs the emulators and simulators. A Mac runs iOS simulators and Android
emulators. A Linux machine with KVM runs Android emulators. In local mode, the host and the agent's
machine are the same computer.

**Worker.** The [Simlock](https://github.com/callstackincubator/simlock) daemon on a host. It creates,
boots and wipes the devices. `tapdance worker …` commands manage it. The worker is a process; the host
is the machine.

**Gateway.** An optional Simlock server that pools several workers behind one address. Workers dial
out to it, so they need no open port. Advanced: it has run on one Mac only, not across machines. See
[gateway mode](deployment/gateway-mode.md).

## Modes

**Local mode.** The agent and the devices are on the same computer. Tapdance talks to the worker on
that computer directly. Set with `tapdance init --mode local`.

**Device-only mode.** How a remote agent reaches a host. The host runs the **guard**, and the agent's
machine can reach only the guard, never the worker or a shell. `tapdance host up` sets it up. This is
the mode proven across machines.

**Self-hosted.** The config value (`provider: "self-hosted"`) for any remote setup: connect targets in
device-only mode, or a gateway.

## Device-only mode

**Guard** (also **worker guard**). A small server on the host. It is the only thing the agent's
machine can reach. It allows a fixed list of device actions, checks a token for each request, and logs
each request in an audit log. `tapdance worker guard …` manages it; `tapdance host up` installs it.

**Pairing.** Approving one agent's machine on a host. `tapdance host up --label <name>` (or
`tapdance worker guard pair`) creates a pairing named after the agent's machine.

**Pairing token.** The secret the agent's machine uses to reach the guard. It starts with `tdg_`. The
host writes it to a file only you can read (`pairing-<label>.token`); it is never printed unless you
ask (`tapdance host token --show`). Revoke it on the host with `tapdance worker guard revoke`.

**Connect target.** A host saved on the agent's machine by `tapdance connect <endpoint>`. You can have
several, for example a Linux host for Android and a Mac for iOS. A lease goes to the first target that
serves the platform; `device lease --target <name>` picks one. `tapdance connect --list` shows them,
`tapdance disconnect <name>` removes one.

**Endpoint.** The address of a guard, gateway or worker, such as
`https://my-mac.tailnet-name.ts.net`. `tapdance host up` prints the guard's endpoint.

## Devices

**Lease.** Your session's claim on one emulator or simulator. `tapdance device lease` (MCP
`lease_device`) takes one, and `tapdance device release` (MCP `release_device`) gives it back. Every
other command acts on the current lease. No command takes a device id.

**Session.** Who holds a lease. Inside Claude Code, Codex or Pi it is the agent's session; otherwise it
is your user. `--session <id>` or `TAPDANCE_SESSION_ID` picks another. See
[session identity](cli-reference.md#session-identity).

**Keepalive.** A background process that renews the lease while you use it, and releases it after 30
minutes without use (by default).

**Warm spare.** A device the worker keeps booted so the next lease is fast. Spares use memory.
`tapdance host warm android=0,ios=0` sets how many to keep.

**Device profile.** A prepared device (for example, signed in to a test account) that a lease boots
read-only. Local mode only. See [device profiles](cli-reference.md#device-profiles).

## Working with apps

**Host build.** The host builds your app from a git repository its owner allowed, then installs it on
the lease (`tapdance app build`, MCP `build_app`). Lets an agent without Xcode test an iOS app. See
[host builds](guides/host-builds.md).

**Install from CI.** The host downloads an app your GitHub Actions run built and installs it
(`app install --from-ci`, MCP `install_app` with `from_ci`). See [CI builds](guides/ci-builds.md).

**Artifacts.** Screenshots, recordings and logs. They are saved on the agent's machine under
`tapdance-artifacts/<session>/`, with a JSON manifest.

**Viewer.** A live view of the leased device in your browser (`tapdance view`). You can watch the
agent, take over, and hand back.

**Scenario.** A YAML or JSON file of device steps that `tapdance run` replays and reports as PASS or
FAIL. See [scenarios](scenarios.md).

**External tool.** A program Tapdance runs for you with your arguments unchanged: `asc`, Google's
Android CLI, AXe, Maestro, fastlane, `xcodebuild`. See [external tools](tools.md).

## Status words

**Proven.** Run for real on real devices, with an evidence record under
[testing/evidence/](testing/evidence/README.md).

**Unit-tested only.** The code exists and its tests pass, but it has not run on real devices.

**Not run.** Written down, but nobody has followed it on real machines yet.

[STATUS.md](../STATUS.md) has the details for every feature.
