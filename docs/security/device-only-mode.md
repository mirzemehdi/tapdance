# Device-only mode and the worker guard

**Principle: remote device control must not mean host control.** The agent, the agent's machine (for
example a Linux VPS), the repository and the app under test are all treated as possibly compromised.
A compromised agent's machine must not become a compromised host.

Device-only mode is how a remote agent reaches a **host**, Mac or Linux. The host runs the **guard**
(`tapdance worker guard`), the only thing the agent's machine can reach. This page is the reference for
what the guard enforces, its policy, its tokens, and how to take access away. To set up a host, follow
[host devices for a remote agent](../deployment/one-command-host.md): `tapdance host up` does all of it.
Terms are in the [glossary](../glossary.md); what a token can do per platform is in the
[threat model](threat-model.md).

> **Status: proven.** The guard ran in every field run over Tailscale: the owner's Mac driven from a
> Linux VPS ([evidence](../testing/evidence/2026-11-02-vps-field-runs.md)), a Google Cloud N2 VM and a
> rented Mac mini driven from a Mac and from a VPS
> ([N2](../testing/evidence/2026-11-03-gcp-n2-android.md),
> [rented Mac](../testing/evidence/2026-11-06-rented-mac-ios.md)), and both hosts from one agent
> ([evidence](../testing/evidence/2026-11-07-two-hosts-android-ios.md)). Malicious-client tests check the
> boundary (`packages/cli/src/guard/guard.test.ts`). Not run: the dedicated macOS account script.

## Why a guard

Simlock, the **worker** that runs the devices, has an `exec` API for `adb` and `simctl`. Simlock's own
access-control documentation says an agent token is close to shell access on the host: `simctl spawn`
starts any program as the worker's user, and there is no setting to turn `exec` off. When a worker
**joins a gateway** (`tapdance worker login`), the gateway gets operator rights on it, and every agent
token the gateway issues can reach that API. On a personal Mac that means the remote side could read
your files, SSH keys and browser data, or run code as you.

That is why `tapdance worker login` refuses unless you pass `--accept-gateway-exec`, and why the guard
exists: it sits in front of a loopback-only Simlock that has joined no gateway, and lets through only
device actions.

## Device-only mode or a gateway

| | Device-only (`host up`, the guard) | Join a gateway (`worker login --accept-gateway-exec`) |
| --- | --- | --- |
| Who decides what runs | A policy file on the host, edited only on the host | The gateway and its tokens |
| Remote shell, `simctl spawn`, host file transfer | Refused; `exec` limited to exact argument lists | Possible (Simlock `exec`) |
| Credentials | Pairing tokens (`tdg_…`) issued at the host, revocable at the host | Gateway-issued Simlock tokens |
| Network | The agent's machine reaches the guard over a private network (Tailscale) | The worker dials out to the gateway (`wss`) |
| Several hosts | Yes: each host is a **connect target** on the agent's machine; a lease goes to the first target, in the order they were added, that serves the platform and answers | Yes: one gateway, one queue across workers |
| Status | Proven across machines | Run on one Mac only |
| Use it for | Any host, and always a personal Mac | Dedicated machines you treat as fleet hardware ([gateway mode](../deployment/gateway-mode.md)) |

## How the pieces fit

On the host, `tapdance host up` installs the worker (Simlock on loopback, joined to nothing), installs the
guard as a login service (serving `127.0.0.1:4720`), pairs one agent's machine, and exposes the guard
with `tailscale serve`. It writes the **pairing token** to a mode-600 file
(`~/.tapdance/worker/pairing-<label>.token`) instead of printing it. `--label` names the agent's machine,
for example `--label my-vps`.

On the agent's machine, `tapdance connect <endpoint> < pairing-<label>.token` checks the guard and saves
it as a connect target: the endpoint in `targets` in `~/.tapdance/config.json`, and the token in
`~/.tapdance/credentials.json` (mode 600), stored under the guard's origin and sent nowhere else. Run
`connect` once per host. `tapdance connect --list` shows the targets; `tapdance disconnect <name>`
removes one. Details: [Android and iOS for one agent](../guides/android-and-ios.md).

By hand, `host up` amounts to `tapdance worker install`, `tapdance worker guard install`,
`tapdance worker guard pair --label my-vps` and `tailscale serve --bg --https=4720 http://127.0.0.1:4720`.

## Keep the guard running

`tapdance worker guard start` runs in the foreground and stops when its terminal closes. `host up`
installs the guard as a login service of the hosting account instead, which you can also do by hand:

```bash
tapdance worker guard install
tapdance worker guard uninstall
```

Add `--allow-admin-account` to `install` only if you accepted that risk. `uninstall` stops the guard and
removes the service; tokens and policy stay.

`install` makes the same refusals as `guard start` (root, a joined gateway, an administrator account
without `--allow-admin-account`), and refuses while a `worker guard start` in a terminal holds the
port. Running it again with unchanged settings leaves a running guard alone (a restart would forget
which client owns which lease). Otherwise it writes:

- **macOS:** the LaunchAgent `~/Library/LaunchAgents/dev.tapdance.guard.plist` (mode 644, label
  `dev.tapdance.guard`, `RunAtLoad` and `KeepAlive`), loaded with `launchctl bootstrap gui/<uid>`
  (falling back to `launchctl load -w`), logging to `~/Library/Logs/tapdance-guard.log`. A LaunchAgent
  runs while the account is logged in. With Fast User Switching a hosting account can stay logged in in
  the background; on a Mac with nobody at the screen, turn on automatic login (see
  [Scaleway, step 3](../ios/scaleway-mac.md#3-automatic-login)).
- **Linux:** `~/.config/systemd/user/tapdance-guard.service` (`Restart=on-failure`), then
  `systemctl --user daemon-reload`, `enable` and `restart`. Logs: `~/.tapdance/worker/guard.log`
  (earlier installs: `journalctl --user -u tapdance-guard.service`). On a headless machine, or to keep it
  running after you log out, lingering must be on (`loginctl enable-linger $USER`); `host-setup.sh`
  handles it.

`host up` installed the guard this way on a Google Cloud N2 VM (systemd) and a rented Mac mini
(LaunchAgent), and the guard came back after a restart of each.

The service runs `worker guard start` with the Node.js binary and the absolute path of the Tapdance
build that ran `install`, so install it again after moving the checkout or upgrading Node.js. Its
environment is fixed: a `PATH` with the Android SDK's `platform-tools`, `emulator` and
`cmdline-tools/latest/bin`, that Node.js, and `/usr/bin:/bin:/usr/sbin:/sbin`, plus `ANDROID_HOME`,
`TAPDANCE_HOME` and `SIMLOCK_HOME` when set. No token and no `TAPDANCE_GUARD_PAIR_NONINTERACTIVE` is
ever written into it. The guard also needs the worker running; `tapdance worker install --service`
installs Simlock's own login service.

**Sleep.** A sleeping Mac takes the guard offline. `tapdance worker guard install --keep-awake` (or
`host up --keep-awake`) runs the guard under `/usr/bin/caffeinate -i`, which prevents idle sleep while
the guard runs. It does not stop sleep when you close a MacBook's lid (unless it runs in clamshell mode
with power and an external display), and it keeps the Mac awake for as long as the service runs, so use
it on a Mac that stays plugged in. On Linux `--keep-awake` changes nothing; use
`systemd-inhibit --what=idle:sleep --why="tapdance worker guard" sleep infinity` while you need it.

## Take access away

Everything here runs on the host; nothing the paired machine sends can undo it.

| You want to | Run (on the host) | Effect |
| --- | --- | --- |
| See who is paired | `tapdance worker guard tokens` | Each pairing's id, label, scopes and expiry. |
| See what they did | `tapdance worker guard audit` | Every request, allowed or refused (no tokens, no file contents). |
| Cut off one machine | `tapdance worker guard revoke <id>` | Its token stops working on its next request. Hosting continues for others. |
| Cut off every machine | `tapdance worker guard revoke all` | All tokens stop working. Pair again with `tapdance host up` (or `worker guard pair`). |
| Pause, keep the pairing | `tapdance host pause` | Guard (and `caffeinate`), Tailscale exposure, worker and its devices stop; nothing restarts at login. `tapdance host resume` brings it all back. |
| Stop hosting | `tapdance host down --revoke` | Revokes every token, removes the guard's login service and the Tailscale exposure. |
| Stop everything | `tapdance host down --all` | `--revoke`, plus ends leases, shuts down the worker's devices, stops it and removes its login service. |
| Stop the devices | `tapdance worker stop` | Ends leases, stops the worker and shuts down the emulators and simulators it created. |
| Instantly, without a terminal | Quit or disconnect Tailscale | The paired machine can no longer reach the host at all. |

Tokens also expire on their own: 7 days by default. Set `limits.tokenDays` (1–90) in
`~/.tapdance/worker/policy.json` for shorter pairings; it applies to tokens issued afterwards.

## Scoped tokens

`tapdance worker guard pair --label ci --scope interaction,inspection,screenshots` (or
`host up --scope …`) issues a token limited to those policy areas: the host policy and the token's
scopes must both allow a request. A token without `install` cannot put apps on the devices, by upload,
by a host build or from CI. That matters most for iOS, where an installed simulator app runs as the
hosting account ([threat model](threat-model.md)). Scope names are the `allow` switches of the policy
file. `worker guard tokens` lists each token's scopes; `host status` shows the pairing's age and expiry.
`host up` keeps a valid pairing as it is: pass `--repair` with `--scope` to reissue it with scopes.

## The policy file

`~/.tapdance/worker/policy.json` on the host. Only the host's owner edits it; the guard refuses it when
other users can write it, and no remote route can read or change it. `tapdance worker guard policy`
shows it.

| Key | Default | What it allows |
| --- | --- | --- |
| `allow.install` | `true` | Installing apps on a lease (upload, host build, from CI) |
| `allow.interaction`, `inspection`, `screenshots`, `recording`, `logs`, `streaming`, `input` | `true` | Driving, reading and watching the device |
| `allow.settings` | `true` | Device settings (never the host's privacy permissions) |
| `allow.files` | `true` | Files in and out of the device (shared storage, a debuggable app's sandbox, iOS Photos, Files and app containers) |
| `allow.perf` | `true` | Frame and memory readings |
| `allow.deviceShell` | `true` | `adb shell` inside a leased Android emulator |
| `allow.notifications` | `false` | Posting notifications, and reading a physical phone's |
| `allow.physicalDevices` | `false` | Leasing phones enrolled with Simlock |
| `allow.builds` | `false` | [Host builds](../guides/host-builds.md) from allow-listed repositories (`tapdance host builds enable`) |
| `allow.artifacts` | `false` | Installs from CI (`tapdance host artifacts enable`); a token also needs `install` |
| `limits.maxSessions` | `1` | Leases at once, enforced even when allocate requests arrive together |
| `limits.maxLeaseMinutes` | `60` | Lease TTL cap |
| `limits.maxUploadMB` | `512` | Upload size cap |
| `limits.tokenDays` | `7` | Token lifetime (1–90) |

The file also holds `builds` (repositories, protected refs, git auth), `artifacts` (repositories,
branches, size cap) and `hostStop` (the idle stop on Linux cloud VMs); the `host builds`, `host artifacts`
and `host up --idle-stop` commands write them.

## What the guard enforces, on the host

- **Its own credentials.** Tokens are created only by `guard pair` on the host; it requires a terminal
  unless `TAPDANCE_GUARD_PAIR_NONINTERACTIVE=1` is set (for scripted setup by the host's owner; never set
  it in a service environment). Tokens are stored as SHA-256 hashes (mode 600), expire, and are checked
  on every request, so `tapdance worker guard revoke <id>` (or `all`) stops a client on its next
  request. The local Simlock token never leaves the host.
- **A device API, not a host API.** Only these routes exist: health, identity, status, catalog; your
  own leases (get, release, stream, input, events, exec, files, crash reports, app console output,
  timed taps, and host builds and installs from CI when the owner turned them on); agent-device RPC, app
  upload and artifact download; and the diagnostics of your own failed allocate (for 10 minutes).
  Anything else is `404`.
- **Allowlisted agent-device commands**, grouped under policy switches: session (open/close),
  inspection, install, interaction, screenshots, recording, logs, `settings`, `perf`, `notifications`.
  `settings` passes only device settings (never the macOS host permissions `accessibility`,
  `screen-recording`, `input-monitoring`); `perf` only `perf frames` and `perf memory sample` (no
  xctrace/simpleperf profiles, no output paths); `push` only an app id and an inline JSON payload.
  Commands that run code, touch files on the host or capture the host (`batch`, `replay`, `test`,
  `install-from-source`, `metro`, `trace`, `debug`, `doctor`, `audio`, which records the Mac's own audio
  with Screen Recording permission, and anything unknown) are refused.
- **Exact `exec` argument lists** (one shared list, `device-commands.ts`, checked against the guard by a
  test). Allowed: `simctl terminate <bundle id>`, `simctl spawn log show` with Tapdance's fixed flags,
  `simctl status_bar override --time HH:MM` / `clear`; `adb shell am force-stop <package>`,
  `adb shell pidof <package>`, `adb logcat` with fixed flags, `adb shell am start -W` with validated
  intent fields, `input tap <x> <y>` (a raw tap, for system screens that ignore the automation helper),
  `dumpsys window displays` (which app is in front), `dumpsys notification`, the notification shade, a
  shell test notification, and files: base64 on stdin or stdout to `/sdcard/{Download,
  Pictures,DCIM,Documents,Movies,Music}/<name>` or a debuggable app's own `files/`, `cache/`,
  `databases/`, `shared_prefs/`, `no_backup/` (24 MB at most). Values that reach the emulator's own
  shell are validated and single-quoted. No `adb push`/`pull` of host paths, no `simctl addmedia` or
  `spawn` of anything else, no host shell.
- **Files for leased iOS simulators** (`allow.files`): `POST/GET /v1/leases/<id>/files` with a
  destination kind (`photos`, or `documents` + an app id), a plain file name or a path inside the app's
  `Documents`, `Library` or `tmp`. The guard asks the simulator (through Simlock) where that app's
  container is, follows links before checking the result is still inside it, refuses to write through a
  link, stages Photos uploads in its own mode-700 folder and deletes them. A client never names a path on
  the host.
- **A shell inside leased emulators** (`allow.deviceShell`, default `true`): any `adb shell …` on an
  emulator the client leased. It runs in the emulator's own Android VM, which is wiped at release, not
  on the host. It is refused on iOS (a simulator shell would be a Mac shell) and on physical phones, and
  everything that reaches the host (`adb push`/`pull`, `install` of host paths, `forward`/`reverse`,
  `emu` console commands, any `simctl spawn`) stays refused. Like any app installed on the emulator,
  code in it can reach the host's loopback services through the emulator's network (10.0.2.2); set
  `allow.deviceShell: false` (and `allow.install: false`) if that matters on your host.
- **Lease ownership per client.** A client can act only on leases it allocated; lease ids repeated in
  `params`, `meta` and `flags` must all match; another client's lease answers `404`/`403`. An allocate
  that Simlock answers with an error never leaves the lease id owned by that client.
- **Each client sees only its own work.** `/v1/status` shows a client only its own leases, its own
  queued requests and the devices tied to its leases.
- **Stale device claims.** Before each lease it does what `tapdance worker cleanup` does (at most every
  15 s): claims left by agent-device processes that have gone, which would block the next lease of that
  device, are released. Live owners are never touched. The remote client cannot do this itself.
- **Uploads and artifacts belong to their client.** An upload must name one of the caller's own leases;
  its upload id is bound to that client, so another client cannot add bytes to it, finalize it or
  install it. Artifact ids are learned from the replies to a client's own commands; any other id
  (another client's, or a guess) answers 404.
- **Simulators and emulators only, by default.** Physical iPhones and Android phones enrolled with
  Simlock cannot be leased through the guard unless the policy sets `allow.physicalDevices: true`.
- **Limits.** `limits.maxSessions`, `limits.maxLeaseMinutes` and `limits.maxUploadMB` (see the policy
  table).
- **Refuses unsafe setups.** It will not start as root, from an administrator account (unless you pass
  `--allow-admin-account`), when the local worker has joined a gateway, when Simlock is not on loopback,
  or when the policy or token files are writable by other users.
- **Audit log.** `~/.tapdance/worker/audit.log` (mode 600) records every request: client id, route,
  command, allow/deny and reason, never tokens or bodies. `tapdance worker guard audit` shows it.

## What it does not do (yet)

- **Isolated builds.** Builds are off by default; the owner can allow them from listed git repositories
  ([host builds](../guides/host-builds.md)). They run with the hosting account's rights: a repository's
  Run Script phases and Gradle scripts are code execution on the host. Builds in disposable VMs are not
  implemented; Tapdance does not sandbox builds.
- **An allow-list of apps** a token may install. The guard sees an upload, not the app inside it.
- **Per-request approval** by the host's owner (for example, approving an install in the viewer).
- **Mutual TLS, replay protection, short-lived per-session tokens.** Transport security comes from
  Tailscale (WireGuard). Pairing tokens are bearer tokens with an expiry.
- **Per-session staging directories and storage quotas.** Uploads and artifacts live in agent-device's
  own directories under the hosting account; Tapdance caps upload size but not total disk use.
  Recording duration is not capped.
- **Ownership after a restart.** Lease ownership (and which leases are physical phones) is kept in
  `~/.tapdance/worker/leases.json` (mode 600), so a guard restart or update does not cut a running agent
  off; leases that ended meanwhile are dropped. Upload and artifact ownership live in memory: after a
  restart, earlier uploads and artifacts belong to nobody and are refused.
- **OS or virtualization vulnerabilities.** The tests prove the API boundary only. A bug in the
  Simulator, CoreSimulator, the Android emulator, agent-device or the OS is outside it; a dedicated
  hosting account limits the damage.

## How it was tested

- Malicious-client tests against the guard (`packages/cli/src/guard/guard.test.ts`): arbitrary shell,
  `sudo`, reading personal files, deleting files, Keychain, changing policy or minting tokens, using
  another client's lease, seeing another session's leases, stream or logs, missing, wrong or expired
  tokens, revocation, build commands, session, upload and TTL limits, conflicting lease ids, physical
  devices, concurrent allocates, filtered status. They run against a recording fake Simlock, so they
  also prove denied requests never reach Simlock.
- The full MCP agent loop ran through the guard against a real simulator (custom app upload and install,
  interaction, recording, screenshot, logs, release) with nothing denied but a diagnostics fetch
  ([evidence](../testing/evidence/2026-11-01-worker-guard.md)).
- The field runs listed under Status at the top of this page.
- The dedicated-account script (`infrastructure/scripts/macos-create-worker-account.sh`) is **not
  run**.

## Profiles

| Profile | Status |
| --- | --- |
| Your own Mac or Linux machine as a host | Device-only mode, as above. Prefer a dedicated standard account. |
| A dedicated host (Mac mini, cloud Mac, cloud VM) | Device-only mode, proven; or join a gateway on a machine you treat as fleet hardware (run on one Mac only). |
| Managed multi-tenant cloud | Not built. Needs per-customer short-lived environments, strict limits, network restrictions and audited operations; a guard plus a lease is **not** enough for strangers' code. |
