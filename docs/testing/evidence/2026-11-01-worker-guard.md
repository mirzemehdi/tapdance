# Evidence: worker guard (device-only mode) — 2026-11-01

Same Mac and versions as [2026-11-01-local-ios.md](2026-11-01-local-ios.md). The guard ran on
127.0.0.1:4720 in front of the local Simlock worker (not joined to any gateway), under the owner's
(administrator) account with `--allow-admin-account` — the dedicated-account setup was not tested.

## Security tests (API boundary, recording fake Simlock)

`pnpm vitest run --project unit packages/cli/src/guard` — 15 passed. A malicious client could not:
run a shell (`simctl spawn … /bin/sh`, `adb shell sh -c`, an injected package name), use `sudo`/`su`,
read files (`adb pull`, `spawn cat`, `get_app_container`, `..`/`%2F` traversal, agent-device `pull`),
delete files (`spawn rm`, `simctl delete all`, `adb shell rm`), reach the Keychain (`spawn security`,
`simctl keychain`), reach any policy/token/config/worker/update route, use or release another client's
lease, see another session's leases/stream/logs, authenticate with missing/guessed/expired tokens or
the local Simlock token, keep working after revocation, run build or code-running commands
(`install-from-source`, `replay`, `test`, `batch`, `metro`, `push`, `perf`, `trace`, `debug`,
`settings`, `doctor`, `xcodebuild`), exceed the session cap, upload past the size cap, or lease past
the TTL cap; and could not smuggle another lease id through `meta`/`flags`. In every denied case the
fake Simlock recorded no forwarded request.

## Real device run through the guard

`TAPDANCE_IT_ENDPOINT=http://127.0.0.1:4720 TAPDANCE_IT_TOKEN=<guard token> TAPDANCE_IT_APP=…/TapdanceDemo.app`
integration test: passed. Audit log: 23 allowed (allocate, open, heartbeat, upload preflight/finalize,
install, open/launch, snapshot, record, press, artifact downloads, exec `simctl spawn log show`,
`simctl terminate`, close, release), 2 denied (the client's diagnostics fetch after an expected
"alert not found" answer — that path is shared across guard clients, so it stays closed).

## Bugs found and fixed on the way

- Commands carry their lease id in `params.meta` and `params.flags`, not `params.leaseId`: the guard
  now reads all copies and requires them to agree.
- The client sends its own credential in `params.token`: replaced with the local Simlock token so the
  guard token never reaches Simlock.
- Launching a custom app took 118–196 s through the guard (9 s direct) because the request named the
  guard as `flags.daemonBaseUrl`; the guard now rewrites it to the local daemon (launch: 4 s).
- `record start` carries the client's output path as a positional; an extra guard rule refused it and
  pushed the MCP call past 60 s. Removed: agent-device's daemon writes remote outputs to its own temp
  and refuses local output paths "by command policy".
- The audit log's `token` field (holding the token *id*) was being redacted; renamed to `client`.
- Ownership was dropped on `close`, so the following `lease.release` was refused; it now ends on
  release/DELETE/expiry.

## Not covered

The dedicated `tapdance-worker` account, Tailscale exposure, a second machine as the control side,
Android through the guard.
