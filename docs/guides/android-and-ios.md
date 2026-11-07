# Android and iOS from one agent

Connect one Android host and one Mac to the same agent machine. The agent leases an Android emulator
or an iOS simulator by platform, and Tapdance sends the lease to the host that serves it.

> **Status:** unit-tested only. The two-host run (an Android host and a Mac in one session, and one
> host down) has not been done yet; see [STATUS.md](../../STATUS.md). Results: TBD.

## How it works

Each host runs in device-only mode with its own worker guard and pairing token, as in
[one-command host](../deployment/one-command-host.md). On the agent's machine, run `tapdance connect`
once per host. Each host becomes a **connect target** with a name:

```bash
tapdance connect https://n2-host.<tailnet>.ts.net --name n2 < pairing-n2.token
tapdance connect https://mac-mini.<tailnet>.ts.net --name mac < pairing-mac.token
tapdance connect --list
```

- **Routing.** A lease goes to the first target, in `connect --list` order, that answers and serves the
  platform (and the model or OS version, when the lease names one). `tapdance device lease --target mac`
  (MCP: `lease_device` with `target`) picks a host. `--platform android` on `connect` limits a host to
  one platform.
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

`doctor` is OK when at least one host is usable; a host that is down is a warning.

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
