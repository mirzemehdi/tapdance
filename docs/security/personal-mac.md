# Using a personal Mac as a worker

**Principle: remote device control must not mean host control.** A coding agent on a VPS, the VPS
itself, the repository and the app under test are all treated as possibly compromised. A compromised
VPS must not become a compromised Mac.

This page explains the risk, the two ways to connect a Mac, and the device-only mode that enforces the
boundary on the Mac itself. Requirement IDs refer to [PRODUCT.md](../../PRODUCT.md) §H; what is
verified is in [STATUS.md](../../STATUS.md).

## The risk

Simlock, which runs the simulators, has an `exec` API for `adb`/`simctl`. Simlock's own access-control
documentation says an agent token is close to shell access on the worker: `simctl spawn` starts any
program as the worker's user. When a worker **joins a gateway** (`tapdance worker login`), the
gateway gets operator rights on it, and every agent token the gateway issues can reach that API. On a
personal Mac that means the remote side could read your files, SSH keys and browser data, or run code
as you. Simulator apps are not sandboxed from the host the way apps on a phone are, either.

That is why `tapdance worker login` refuses unless you pass `--accept-gateway-exec`, and why the
recommended setup for a personal Mac is **device-only mode**.

## The two ways to connect a Mac

| | Join a gateway (`worker login --accept-gateway-exec`) | Device-only (`worker guard`) |
| --- | --- | --- |
| Who decides what runs | The gateway and its tokens | A policy file on the Mac, edited only on the Mac |
| Remote shell / `simctl spawn` / file transfer | Possible (Simlock exec) | Refused; exec limited to exact argument lists |
| Credentials | Gateway-issued Simlock tokens | Guard tokens issued at the Mac (`guard pair`), revocable at the Mac |
| Network | Worker dials out to the gateway (`wss`) | Control machine reaches the guard over a private network (Tailscale) |
| Fleet features (one gateway, many workers, one queue) | Yes | No: the control machine points at this Mac directly |
| Use it for | Dedicated machines you treat as part of the fleet | Your own Mac |

## Device-only mode

```bash
# once, as an administrator: a standard account with nothing personal in it
infrastructure/scripts/macos-create-worker-account.sh

# as the tapdance-worker account
tapdance worker install                       # Simlock on loopback; do NOT join a gateway
tapdance worker guard policy                  # review ~/.tapdance/worker/policy.json
tapdance worker guard start                   # serves 127.0.0.1:4720
tapdance worker guard pair --label my-vps     # approve the control machine; prints a token once
tailscale serve --bg --https=4720 http://127.0.0.1:4720

# on the VPS
tapdance init --mode self-hosted --endpoint https://<mac>.<tailnet>.ts.net:4720 --yes
tapdance config set-token                     # paste the guard token; it is bound to the guard URL
tapdance doctor
```

`tapdance host up` runs the Mac side of this in one command (worker, guard service, pairing,
`tailscale serve`, a self-test) and writes the token to a mode-600 file instead of printing it;
`tapdance connect` does the VPS side. See [one-command host](../deployment/one-command-host.md). Neither
has been run end to end yet.

### Keep the guard running

`tapdance worker guard start` runs in the foreground and stops when its terminal closes. To keep it
running, install it as a login service of the worker account:

```bash
tapdance worker guard install                 # add --allow-admin-account only if you accepted that risk
tapdance worker guard uninstall               # stop it and remove the service; tokens and policy stay
```

`install` makes the same refusals as `guard start` (root, a joined gateway, an administrator account
without `--allow-admin-account`), and refuses while a `worker guard start` in a terminal holds the
port. Running it again with unchanged settings leaves a running guard alone (a restart would forget
which client owns which lease). Otherwise it:

- **macOS:** writes the LaunchAgent `~/Library/LaunchAgents/dev.tapdance.guard.plist` (mode 644, label
  `dev.tapdance.guard`, `RunAtLoad` and `KeepAlive`), loads it with `launchctl bootstrap gui/<uid>`
  (falling back to `launchctl load -w`), and logs to `~/Library/Logs/tapdance-guard.log`. A
  LaunchAgent runs while the account is logged in at the screen; with Fast User Switching the worker
  account can stay logged in in the background. Run `install` from that account's own login session,
  not over plain SSH or `sudo`.
- **Linux:** writes `~/.config/systemd/user/tapdance-guard.service` (`Restart=on-failure`), then runs
  `systemctl --user daemon-reload`, `enable` and `restart`. Logs: `journalctl --user -u tapdance-guard.service`.
  On a headless machine, or to keep it running after you log out, enable lingering once:
  `loginctl enable-linger $USER`.

The service runs `worker guard start` with the Node.js binary and the absolute path of the Tapdance
build that ran `install`, so install it again after moving the checkout or upgrading Node.js. Its
environment is fixed: a `PATH` with the Android SDK's `platform-tools`, `emulator` and
`cmdline-tools/latest/bin`, that Node.js, and `/usr/bin:/bin:/usr/sbin:/sbin`, plus `ANDROID_HOME`,
`TAPDANCE_HOME` and `SIMLOCK_HOME` when set. No token and no `TAPDANCE_GUARD_PAIR_NONINTERACTIVE` is
ever written into it. The guard also needs the Simlock worker running; `tapdance worker install --service`
installs Simlock's own login service.

**Sleep.** A sleeping Mac takes the guard offline. `tapdance worker guard install --keep-awake` runs the
guard under `/usr/bin/caffeinate -i`, which prevents idle sleep while the guard runs. It does not stop
sleep when you close a MacBook's lid (unless it runs in clamshell mode with power and an external
display), and it keeps the Mac awake for as long as the service runs, so use it on a Mac that stays
plugged in. On Linux `--keep-awake` changes nothing; use
`systemd-inhibit --what=idle:sleep --why="tapdance worker guard" sleep infinity` while you need it.

The LaunchAgent and the systemd unit are covered by unit tests of the generated files only; neither
has been installed on a real machine yet.

### What the guard enforces, on the Mac

- **Its own credentials.** Tokens are created only by `guard pair` on the Mac; it requires a terminal
  unless `TAPDANCE_GUARD_PAIR_NONINTERACTIVE=1` is set (for scripted setup by the Mac's owner; never set
  it in a service environment). Tokens are stored as SHA-256 hashes (mode 600), expire (7 days by
  default, policy maximum 90), and are checked on every request, so `tapdance worker guard revoke <id>` (or `all`) stops a client on its next request. The
  local Simlock token never leaves the Mac.
- **A device API, not a host API.** Only these routes exist: health, identity, status, catalog, your leases (get, release, stream, input, events, exec), agent-device RPC,
  app upload, artifact download. Anything else is `404`.
- **Allowlisted agent-device commands**, grouped under policy switches: session (open/close),
  inspection, install, interaction, screenshots, recording, logs. Commands that run code or touch files
  — `batch`, `replay`, `test`, `install-from-source`, `metro`, `push`, `perf`, `trace`, `debug`,
  `settings`, `doctor` and anything unknown — are refused.
- **Exact `exec` argument lists.** Allowed: `simctl terminate <bundle id>`, `simctl spawn log show`
  with Tapdance's fixed flags, `adb shell am force-stop <package>`, `adb shell pidof <package>`,
  `adb logcat` with fixed flags. No `spawn` of anything else, no `pull`/`push`, no stdin, no shell.
- **Lease ownership per client.** A client can act only on leases it allocated; lease ids repeated in
  `params`, `meta` and `flags` must all match; another client's lease answers `404`/`403`. An allocate
  that Simlock answers with an error never leaves the lease id owned by that client.
- **Each client sees only its own work.** `/v1/status` shows a client only its own leases, its own
  queued requests and the devices tied to its leases.
- **Simulators and emulators only, by default.** Physical iPhones and Android phones enrolled with
  Simlock cannot be leased through the guard unless the policy sets `allow.physicalDevices: true`
  (default `false`).
- **Limits.** At most `limits.maxSessions` leases at once (default 1), enforced even when several
  allocate requests arrive at the same moment; lease TTL capped at `limits.maxLeaseMinutes` (default
  60); uploads capped at `limits.maxUploadMB` (default 512).
- **Refuses unsafe setups.** It will not start as root, from an administrator account (unless you pass
  `--allow-admin-account`), when the local worker has joined a gateway, when Simlock is not on loopback,
  or when the policy/token files are writable by other users.
- **Audit log.** `~/.tapdance/worker/audit.log` (mode 600) records every request: client id, route,
  command, allow/deny and reason — never tokens or bodies. `tapdance worker guard audit` shows it.

### What it does not do (yet)

- **Builds.** Only the `device-only` profile exists. Remote Xcode builds are refused; an
  approved-build profile and isolated builds in disposable macOS VMs (Virtualization.framework) are
  not implemented (H-08). Building an untrusted Xcode project runs its Run Script phases with your
  build user's rights; Tapdance does not sandbox builds.
- **Mutual TLS, replay protection, short-lived per-session tokens.** Transport security comes from
  Tailscale (WireGuard). Guard tokens are bearer tokens with an expiry (H-05).
- **Per-session staging directories and storage quotas on the Mac.** Uploads and artifacts live in
  agent-device's own directories under the worker account; Tapdance caps upload size but not total
  disk use (H-06, H-07). Recording duration is not capped.
- **Upload/artifact ownership (known gap).** Upload and artifact ids are random but not yet bound to a
  client token by the guard.
- **OS or virtualization vulnerabilities.** The tests prove the API boundary only. A bug in the
  Simulator, CoreSimulator, agent-device or macOS is outside it; the dedicated account limits the
  damage.

### Evidence

- Security tests act as a malicious client against the guard (`packages/cli/src/guard/guard.test.ts`;
  15 at the time of the recorded run, more since):
  arbitrary shell, `sudo`, reading personal files, deleting files, Keychain, changing policy or minting
  tokens, using another client's lease, seeing another session's leases/stream/logs, missing/wrong/
  expired tokens, revocation, build commands, session/upload/TTL limits, conflicting lease ids. They
  run against a recording fake Simlock, so they also prove denied requests never reach Simlock. Later
  tests cover physical-device leases, concurrent allocates against the session limit, the filtered
  status (other clients' queued requests) and allocates answered with an error; these are unit tests
  only (🧪 in STATUS.md).
- The full MCP agent loop ran through the guard against a real simulator (custom app upload and
  install, interaction, recording, screenshot, logs, release) with nothing denied but a diagnostics
  fetch ([evidence](../testing/evidence/2026-11-01-worker-guard.md)).
- The dedicated-account script, Tailscale exposure, the guard's LaunchAgent / systemd unit
  (`worker guard install`) and `tapdance host up` are **untested**.

## Profiles

| Profile | Status |
| --- | --- |
| Local device-only (your own Mac) | `worker guard`, as above |
| Self-hosted remote worker (Mac mini, cloud Mac) | Same guard and dedicated account; or join a gateway on a machine you treat as fleet hardware |
| Managed multi-tenant cloud | Not built. Needs per-customer short-lived environments, strict limits, network restrictions and audited operations; a guard plus a lease is **not** enough for strangers' code |
