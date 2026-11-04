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
  `systemctl --user daemon-reload`, `enable` and `restart`. Logs: `~/.tapdance/worker/guard.log` (earlier installs: `journalctl --user -u tapdance-guard.service`).
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

### Take access away

Everything here runs on your Mac; nothing the paired machine sends can undo it.

| You want to | Run (on the Mac) | Effect |
| --- | --- | --- |
| See who is paired | `tapdance worker guard tokens` | Each pairing's id, label and expiry. |
| See what they did | `tapdance worker guard audit` | Every request, allowed or refused (no tokens, no file contents). |
| Cut off one machine | `tapdance worker guard revoke <id>` | Its token stops working on its next request. Hosting continues for others. |
| Cut off every machine | `tapdance worker guard revoke all` | All tokens stop working. Pair again with `tapdance host up` (or `worker guard pair`). |
| Pause, keep the pairing | `tapdance host pause` | Guard (and `caffeinate`), Tailscale exposure, worker and its devices stop; nothing restarts at login. `tapdance host resume` brings it all back. |
| Stop hosting | `tapdance host down --revoke` | Revokes every token, removes the guard's login service and the Tailscale exposure. |
| Stop everything | `tapdance host down --all` | `--revoke`, plus ends leases, shuts down the worker's devices, stops it and removes its login service. |
| Stop the devices | `tapdance worker stop` | Ends leases, stops the worker and shuts down the emulators and simulators it created. |
| Instantly, without a terminal | Quit or disconnect Tailscale | The paired machine can no longer reach your Mac at all. |

Tokens also expire on their own: 7 days by default. Set `limits.tokenDays` (1–90) in
`~/.tapdance/worker/policy.json` for shorter pairings; it applies to tokens issued afterwards.

### What the guard enforces, on the Mac

- **Its own credentials.** Tokens are created only by `guard pair` on the Mac; it requires a terminal
  unless `TAPDANCE_GUARD_PAIR_NONINTERACTIVE=1` is set (for scripted setup by the Mac's owner; never set
  it in a service environment). Tokens are stored as SHA-256 hashes (mode 600), expire (7 days by
  default, policy maximum 90), and are checked on every request, so `tapdance worker guard revoke <id>` (or `all`) stops a client on its next request. The
  local Simlock token never leaves the Mac.
- **A device API, not a host API.** Only these routes exist: health, identity, status, catalog, your leases (get, release, stream, input, events, exec), agent-device RPC,
  app upload, artifact download. Anything else is `404`.
- **Allowlisted agent-device commands**, grouped under policy switches: session (open/close),
  inspection, install, interaction, screenshots, recording, logs, `settings`, `perf`, `notifications`.
  `settings` passes only device settings (never the macOS host permissions `accessibility`,
  `screen-recording`, `input-monitoring`); `perf` only `perf frames` and `perf memory sample` (no
  xctrace/simpleperf profiles, no output paths); `push` only an app id and an inline JSON payload.
  Commands that run code, touch files on the Mac or capture the host — `batch`, `replay`, `test`,
  `install-from-source`, `metro`, `trace`, `debug`, `doctor`, `audio` (it records the Mac's own audio
  with Screen Recording permission) and anything unknown — are refused.
- **Exact `exec` argument lists** (one shared list, `device-commands.ts`, checked against the guard by a
  test). Allowed: `simctl terminate <bundle id>`, `simctl spawn log show` with Tapdance's fixed flags,
  `simctl status_bar override --time HH:MM` / `clear`; `adb shell am force-stop <package>`,
  `adb shell pidof <package>`, `adb logcat` with fixed flags, `adb shell am start -W` with validated
  intent fields, `input tap <x> <y>` (a raw tap, for system screens that ignore the automation helper),
  `dumpsys window displays` (which app is in front), `dumpsys notification`, the notification
  shade, a shell test notification, and files: base64 on stdin or stdout to `/sdcard/{Download,
  Pictures,DCIM,Documents,Movies,Music}/<name>` or a debuggable app's own `files/`, `cache/`,
  `databases/`, `shared_prefs/`, `no_backup/` (24 MB at most). Values that reach the emulator's own
  shell are validated and single-quoted. No `adb push`/`pull` of Mac paths, no `simctl addmedia` or
  `spawn`, no host shell.
- **Files for leased iOS simulators** (`allow.files`): `POST/GET /v1/leases/<id>/files` with a
  destination kind (`photos`, or `documents` + an app id), a plain file name or a path inside the app's
  `Documents`, `Library` or `tmp`. The guard asks the simulator (through Simlock) where that app's
  container is, follows links before checking the result is still inside it, refuses to write through a
  link, stages Photos uploads in its own mode-700 folder and deletes them. A client never names a path on
  the Mac.
- **A shell inside leased emulators** (`allow.deviceShell`, default `true`): any `adb shell …` on an
  emulator the client leased. It runs in the emulator's own Android VM, which is wiped at release, not
  on the Mac. It is refused on physical phones, and everything that reaches the Mac (`adb push`/`pull`,
  `install` of Mac paths, `forward`/`reverse`, `emu` console commands, any `simctl spawn`) stays
  refused. Like any app installed on the emulator, code in it can reach the Mac's loopback services
  through the emulator's network (10.0.2.2); set `allow.deviceShell: false` (and `allow.install:
  false`) if that matters on your Mac.
- **Lease ownership per client.** A client can act only on leases it allocated; lease ids repeated in
  `params`, `meta` and `flags` must all match; another client's lease answers `404`/`403`. An allocate
  that Simlock answers with an error never leaves the lease id owned by that client.
- **Each client sees only its own work.** `/v1/status` shows a client only its own leases, its own
  queued requests and the devices tied to its leases.
- **Policy switches for the new areas.** `allow.settings`, `allow.files` and `allow.perf` default to
  `true`. Reading an emulator's or simulator's notification list is part of `allow.inspection`; posting
  notifications, and reading a physical phone's (they can hold the owner's private text), need
  `allow.notifications`, which defaults to `false`.
- **Stale device claims.** Before each lease it does what `tapdance worker cleanup` does (at most every
  15 s): claims left by agent-device processes that have gone, which would block the next lease of that
  emulator, are released. Live owners are never touched. The remote client cannot do this itself.
- **Uploads and artifacts belong to their client.** An upload must name one of the caller's own leases;
  its upload id is bound to that client, so another client cannot add bytes to it, finalize it or
  install it. Artifact ids are learned from the replies to a client's own commands; any other id
  (another client's, or a guess) answers 404.
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

### Scoped tokens

`tapdance worker guard pair --label ci --scope interaction,inspection,screenshots` (or `host up --scope …`)
issues a token limited to those policy areas: the host policy and the token's scopes must both allow a
request. A token without `install` cannot put apps on the devices, which matters most for iOS, where an
installed simulator app runs as this Mac account ([threat model](threat-model.md)). Scope names are the
`allow` switches of the policy file. `worker guard tokens` lists each token's scopes; `host status` shows
the pairing's age and expiry. `host up` keeps a valid pairing as it is: pass `--repair` with `--scope` to
reissue it with scopes.

### What it does not do (yet)

- **Isolated builds.** Builds are off by default; the owner can allow them from listed git
  repositories (`tapdance host builds enable`, [Builds on the host](../deployment/one-command-host.md#builds-on-the-host)).
  They run with the hosting account's rights: a repository's Run Script phases and Gradle scripts are
  code execution on the Mac. Builds in disposable macOS VMs (Virtualization.framework) are not
  implemented (H-08); Tapdance does not sandbox builds.
- **Mutual TLS, replay protection, short-lived per-session tokens.** Transport security comes from
  Tailscale (WireGuard). Guard tokens are bearer tokens with an expiry (H-05).
- **Per-session staging directories and storage quotas on the Mac.** Uploads and artifacts live in
  agent-device's own directories under the worker account; Tapdance caps upload size but not total
  disk use (H-06, H-07). Recording duration is not capped.
- **Ownership after a restart.** Lease ownership (and which leases are physical phones) is kept in
  `~/.tapdance/worker/leases.json` (mode 600), so a guard restart or update does not cut a running agent
  off; leases that ended meanwhile are dropped. Upload and artifact ownership live in memory: after a
  restart, earlier uploads and artifacts belong to nobody and are refused.
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
