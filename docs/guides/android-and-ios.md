# Android and iOS from one agent

Connect one Android host and one Mac to the same agent machine. The agent leases an Android emulator
or an iOS simulator by platform, and Tapdance sends the lease to the host that serves it.

> **Status:** proven on real hosts on 2026-11-07: a Linux VPS as the agent's machine, a Google Cloud N2
> VM for Android and a rented Mac mini for iOS, both over Tailscale, through the CLI and MCP, with one
> host down ([evidence](../testing/evidence/2026-11-07-two-hosts-android-ios.md)). The Simlock gateway
> pool across machines (the other way to reach two hosts) is still not run (STATUS Q-06).

## How it works

Each host runs in device-only mode with its own worker guard and pairing token, as in
[one-command host](../deployment/one-command-host.md). On the agent's machine, run `tapdance connect`
once per host. Each host becomes a **connect target** with a name:

```bash
tapdance connect https://n2-host.<tailnet>.ts.net:4720 --name n2 < pairing-n2.token
tapdance connect https://mac-mini.<tailnet>.ts.net:4720 --name mac < pairing-mac.token
tapdance connect --list
```

```text
NAME  ENDPOINT                                   PLATFORMS  TOKEN
n2    https://n2-host.<tailnet>.ts.net:4720      any        saved (94b0a9)
mac   https://mac-mini.<tailnet>.ts.net:4720     any        saved (f14618)
Leases go to the first target (in this order) that serves the platform and has room; `--target <name>` picks one. `tapdance doctor` checks each.
```

The `TOKEN` column is the token's fingerprint, never the token; it should match what `host up` printed
on that host. To move a target to a new address (for example from an SSH tunnel to its tailnet name),
run `connect` with the new endpoint and the same `--name`: the target keeps its place and its platforms,
and the token saved for the old address is removed.

- **Routing.** A lease goes to the first target, in `connect --list` order, that answers, serves the
  platform (and the model or OS version, when the lease names one) and has a free slot or a warm spare;
  when all of them are full, to the first, where the request waits. A host with no capacity for the
  platform is skipped (choosing by free slot is unit-tested only). `tapdance device lease --target mac`
  (MCP: `lease_device` with `target`) picks a host. `--platform android` on `connect` limits a host to
  one platform; `--platform any` clears that.
- **Follow-up calls stay on the lease's host.** Install, UI, screenshots, recording, logs, files and
  release all go to the host that granted the lease, with that host's token. Each token is stored under
  its own origin in `~/.tapdance/credentials.json` (mode 600) and is never sent to another host.
- **One lease per session.** A session holds one device at a time: lease Android, work, release, then
  lease iOS. A second lease while one is held fails with `LEASE_ALREADY_HELD`. To drive a phone and an
  iPhone at the same time, run two sessions (two `TAPDANCE_SESSION_ID`s, for example two sub-agents).
- **A host that is down.** A lease for its platform fails within seconds with `PROVIDER_UNREACHABLE`
  (retryable). The error names the host and its endpoint, and says which targets are up. Tapdance never
  leases another platform instead. Leases on the other host keep working.

## Check both hosts

```bash
tapdance doctor --no-host   # one section per host, plus which host each platform's leases go to
tapdance devices            # one section per host; a host that is down shows why
```

`doctor` with both hosts up (shortened):

```text
✓ Connect targets — n2: Android; mac: iOS. Leases: Android → n2, iOS → mac

✓ Target n2 — https://n2-host.<tailnet>.ts.net:4720: up, serves android
  ✓ Token accepted — role agent, label "field-agent"
  ✓ Android emulators available — 1/1 running, 1 warm (emulator 37.2.13)
  – iOS simulators available — not on this host: it runs Linux, and iOS simulators need a Mac

✓ Target mac — https://mac-mini.<tailnet>.ts.net:4720: up, serves ios
  ✓ Token accepted — role agent, label "stage4-agent"
  – Android emulators available — not on this host: it has no Android SDK and serves ios only; Android leases go to n2
  ✓ iOS simulators available — 0/4 running, 0 warm (xcode 27.0)

✓ Device lease — none held by this session

All checks passed
```

`doctor` is OK when at least one host is usable; a host that is down is a warning. A host that does not
answer within 5 s is reported down at once.

## One session, both platforms

The proven flow, in one session (`TAPDANCE_SESSION_ID`, or the agent's own session id under MCP):

```bash
tapdance device lease --platform android     # → n2
tapdance ui inspect; tapdance screenshot -o android.png
tapdance device release
tapdance device lease --platform ios         # → mac
tapdance ui inspect; tapdance screenshot -o ios.png
tapdance device release
```

Each lease says where it went:

```text
Device:    Pixel 8
Platform:  Android 34
Provider:  Remote worker
Endpoint:  https://n2-host.<tailnet>.ts.net:4720 (target n2) (TLS)
```

Over MCP the agent calls `lease_device` with `platform` (and `target` only to pin a host); the reply's
`location` has the endpoint and the target. Measured on 2026-11-07: an Android lease from a warm spare
about 10 s, an iOS lease with a cold simulator on an 8 GB Mac 73-128 s; the first iOS command after a
cold lease can take 35-100 s while the simulator's test runner starts. A real app was built on the Mac
from git (`app build`), installed on Android from an APK (`app install`), launched and tapped through
its onboarding on both, in one session.

## When a host is down

```text
$ tapdance device lease --platform ios
› mac (https://mac-mini.<tailnet>.ts.net:4720) does not answer: …/v1/healthz answered HTTP 502
{
  "error": {
    "code": "PROVIDER_UNREACHABLE",
    "message": "Cannot lease ios: target mac (https://mac-mini.<tailnet>.ts.net:4720) does not answer (…/v1/healthz answered HTTP 502)",
    "retryable": true,
    "hint": "Up: n2 (android). Retry when mac is back (`tapdance host status` on that host, `tailscale status` here); `tapdance doctor` shows every target.",
    "details": { "platform": "ios", "target": "mac", "down": ["mac"], "up": ["n2"] }
  }
}
```

It comes back in under a second when the host refuses or resets the connection (or `tailscale serve`
answers for a stopped guard, as above), and after about 5 s when it hangs. Android leases on `n2` keep
working meanwhile, and `doctor` shows `! Target mac — … down` with "OK with 3 warning(s)".

## Remove a host

```bash
tapdance disconnect mac
```

This removes the target and its token from this machine. On the host, revoke the pairing with
`tapdance worker guard revoke <label>`.

## Older setups

A configuration from before connect targets (one `endpoint` and one token) keeps working unchanged.
The next `tapdance connect` keeps it as the first target and adds the new host after it.

`TAPDANCE_ENDPOINT`, or an `endpoint` in a project's `tapdance.config.json`, still selects a single
host and bypasses the targets.
