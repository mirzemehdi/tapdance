# Android and iOS from one agent

Connect two hosts to one agent's machine: a Linux host for Android and a Mac for iOS, for example. The
agent leases an Android emulator or an iOS simulator by platform, and Tapdance sends the lease to the
host that serves it. Terms like **host**, **connect target** and **lease** are in the
[glossary](../glossary.md).

> Proven on 2026-11-07: a Linux VPS as the agent's machine, a Google Cloud N2 VM for Android and a
> rented Mac mini for iOS, both over Tailscale, through the CLI and MCP, with one host down
> ([evidence](../testing/evidence/2026-11-07-two-hosts-android-ios.md)). Unit-tested only: preferring a
> host with a free slot, and moving an older single-endpoint setup to connect targets. The gateway pool
> across machines (the other way to reach two hosts) is not run.

## What you get

- One agent, both platforms: `tapdance device lease --platform android` goes to the Android host,
  `--platform ios` to the Mac.
- Each host keeps its own guard and pairing token. A token is never sent to another host.
- A host that is down does not break the other: its leases fail fast, the other host keeps working.

## What you need

- Two hosts, each set up with `tapdance host up` as in
  [host devices for a remote agent](../deployment/one-command-host.md). A Mac serves iOS (and Android,
  if its Android SDK is installed); a Linux host with KVM serves Android.
- Both hosts and the agent's machine in the same tailnet.
- The pairing token file from each host.

## Steps

1. **On each host, pair the agent's machine.** Use the agent's machine's name as the label on both:

   ```bash
   tapdance host up --label my-vps
   ```

2. **Copy both token files to the agent's machine,** under different names so they do not overwrite
   each other:

   ```bash
   scp me@n2-host:~/.tapdance/worker/pairing-my-vps.token pairing-n2.token
   scp me@mac-mini:~/.tapdance/worker/pairing-my-vps.token pairing-mac.token
   ```

3. **On the agent's machine, connect each host once,** with a name:

   ```bash
   tapdance connect https://n2-host.<tailnet>.ts.net:4720 --name n2 < pairing-n2.token
   tapdance connect https://mac-mini.<tailnet>.ts.net:4720 --name mac < pairing-mac.token
   ```

   Each host becomes a connect target. The order you add them in is the order leases try them.

4. **List the targets:**

   ```bash
   tapdance connect --list
   ```

   ```text
   NAME  ENDPOINT                                   PLATFORMS  TOKEN
   n2    https://n2-host.<tailnet>.ts.net:4720      any        saved (94b0a9)
   mac   https://mac-mini.<tailnet>.ts.net:4720     any        saved (f14618)
   Leases go to the first target (in this order) that serves the platform; `--target <name>` picks one. `tapdance doctor` checks each.
   ```

   The `TOKEN` column is the token's fingerprint, never the token. It should match what `host up`
   printed on that host.

## Check it worked

```bash
tapdance doctor --no-host
tapdance devices
```

`doctor` shows one section per host, plus which host each platform's leases go to. `devices` shows one
section per host; a host that is down shows why. `doctor` with both hosts up (shortened):

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

Then run both platforms in one session:

```bash
tapdance device lease --platform android
tapdance ui inspect
tapdance screenshot -o android.png
tapdance device release
tapdance device lease --platform ios
tapdance ui inspect
tapdance screenshot -o ios.png
tapdance device release
```

Each lease says where it went:

```text
Device:    Pixel 8
Platform:  Android 34
Provider:  Remote worker
Endpoint:  https://n2-host.<tailnet>.ts.net:4720 (target n2) (TLS)
```

Over MCP the agent calls `lease_device` with `platform` (and `target` only to pin a host). The reply's
`location` has the endpoint and the target.

## How leases are routed

- **Which host.** A lease goes to the first connect target, in the order they were added, that serves
  the platform (and the model or OS version, when the lease names one) and answers. A host that is down
  is skipped fast with `PROVIDER_UNREACHABLE`. `tapdance device lease --target mac` (MCP:
  `lease_device` with `target`) picks one host.
- **Free slots** (unit-tested only). Among the hosts that serve the platform, a host with a free slot
  or a warm spare is preferred; when all are full, the lease waits on the first. A host with no
  capacity for the platform is skipped.
- **Limit a host to one platform.** `tapdance connect <endpoint> --name n2 --platform android`.
  `--platform any` clears the limit.
- **Follow-up calls stay on the lease's host.** Install, UI, screenshots, recording, logs, files and
  release all go to the host that granted the lease, with that host's token. Each token is stored for
  its own address in `~/.tapdance/credentials.json` (mode 600).
- **One lease per session.** A session holds one device at a time: lease Android, work, release, then
  lease iOS. A second lease while one is held fails with `LEASE_ALREADY_HELD`. To drive a phone and an
  iPhone at the same time, run two sessions (two `TAPDANCE_SESSION_ID`s, for example two sub-agents).
- **Move a host to a new address** (for example from an ssh tunnel to its tailnet name): run `connect`
  with the new endpoint and the same `--name`. The target keeps its place and its platforms, and the
  token saved for the old address is removed.

Measured on 2026-11-07: an Android lease from a warm spare took about 10 s, an iOS lease with a cold
simulator on an 8 GB Mac 73-128 s. The first iOS command after a cold lease can take 35-100 s while the
simulator's test runner starts. A real app was built on the Mac from git (`app build`), installed on
Android from an APK (`app install`), launched and tapped through its onboarding on both, in one
session.

## If it fails

**A host is down.** A lease for its platform fails within seconds with `PROVIDER_UNREACHABLE`
(retryable). The error names the host and its endpoint, and says which targets are up. Tapdance never
leases another platform instead. Leases on the other host keep working.

```text
tapdance device lease --platform ios
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
answers for a stopped guard, as above), and after about 5 s when it hangs. `doctor` shows
`! Target mac — … down` with "OK with 3 warning(s)". On that host, run `tapdance host status`.

**`connect` fails for the second host** with a wrong token: the token file is from another host or
pairing. Copy the right `pairing-<label>.token` from that host.

**The first iOS command after a cold lease fails** with a deadline or timeout error: the simulator's
test runner was still starting. Run it again.

More: [troubleshooting](../troubleshooting.md#sessions-and-leases).

## Remove a host

On the agent's machine:

```bash
tapdance disconnect mac
```

This removes the target and its token from this machine. On the host, revoke the pairing:

```bash
tapdance worker guard revoke <id>
```

`tapdance worker guard tokens` lists each pairing's id and label.

## Older setups

A configuration from before connect targets (one `endpoint` and one token) keeps working unchanged.
The next `tapdance connect` keeps it as the first target and adds the new host after it.

`TAPDANCE_ENDPOINT`, or an `endpoint` in a project's `tapdance.config.json`, still selects a single
host and bypasses the targets.
