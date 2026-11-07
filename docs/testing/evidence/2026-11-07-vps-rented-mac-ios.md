# Evidence: iOS on a rented Scaleway Mac mini, driven from a Linux VPS — 2026-11-07

Stage 3 of [docs/hosting-plan.md](../../hosting-plan.md), repeated with a **Linux VPS** as the agent's
machine (STATUS Q-08) instead of a Mac. The host is the same Scaleway Mac mini M1-M that was set up the
day before ([2026-11-06 evidence](2026-11-06-rented-mac-ios.md)); nothing was reinstalled on it. The VPS
followed the "Variant: the agent runs on a Linux VPS" section of
[field-test-rented-mac-ios.md](../field-test-rented-mac-ios.md), which was fixed afterwards where it was
wrong (checkpoints A and B, below).

## Environment

| | |
| --- | --- |
| Host | Scaleway Mac mini **M1-M** (Apple M1, **8 GB**), `m1@51.159.121.117`, macOS 27.2, Xcode 27.0, iOS 27.0 runtime; Tapdance, worker and guard as left by the 11-06 run |
| Agent's machine | Linux VPS `ubuntu-8gb-kappmaker-bot` (Ubuntu, 8 GB, no KVM, no Xcode), tailnet address 100.74.77.19, Tapdance `5a61193` (main) built from source, CLI `packages/cli/dist/main.js`; `pnpm` through a corepack shim in `~/.local/bin` (not installed system-wide) |
| Scratch | `TAPDANCE_HOME=/home/devuser/td-stage3/home`, `TAPDANCE_SESSION_ID` `vps-cli` / `vps-mcp`; the VPS's own `~/.tapdance` untouched |
| Pairing | label `vps-agent` (guard client `gt_63edc69cb510`), endpoint `https://861eecdb-….tailc7cb50.ts.net:4720` (TLS, `tailscale serve`) |
| Device | iPhone 17 / iOS 27.0, cold leases only (`tapdance host warm android=0,ios=0` on the Mac first; worker restarted, 0 spares) |
| Network | Tailscale; the VPS was already in the owner's tailnet |

## Setup and checkpoints

| Step | Result |
| --- | --- |
| VPS in the tailnet | `tailscale status` listed the Mac's machine; nothing to do |
| **Checkpoint A** (ssh access to the Mac) | **Failed as written.** The runbook told the owner to run `ssh m1@<mac> 'cat >> ~/.ssh/authorized_keys' <<< '<key>'` "on their own machine"; in a VPS-only setup the owner has no other machine with ssh access. Tailscale SSH is not enabled on the host (`Host key verification failed` over the tailnet name). Workaround: the owner gave the Mac's Scaleway ssh password once, and the VPS appended its new key with a one-time password login. `sshpass` is not installed on the VPS, so the password went through `SSH_ASKPASS` (a throwaway script, `SSH_ASKPASS_REQUIRE=force`), never on a command line. Afterwards key-only ssh worked. [#126](https://github.com/mirzemehdi/tapdance/issues/126) |
| **Checkpoint B** (GitHub access for host builds) | **Deviated.** The runbook says the owner runs `ssh -t m1@<mac> 'tapdance host gh-login'` and the agent never handles the token; again there was no second machine. The owner pasted a fine-grained read-only token into the agent's chat; the agent piped it over ssh stdin to `tapdance host gh-login` without printing it and deleted the temporary file. Scope checked: `KAppMakerDeveloperApps/Pianolune-All` readable, `Zenbo-All` 404. [#127](https://github.com/mirzemehdi/tapdance/issues/127) |
| `host builds enable --repo …Pianolune-All --git-auth gh --protected-ref main --allow-admin-account` | `host status`: `gh ok` |
| `tapdance host up --label vps-agent --allow-admin-account --skip-self-test --yes` over plain ssh | Left the existing pairing, worker and guard as they were and added the `vps-agent` pairing. The 11-06 pairing `stage3-agent` stays active alongside it (two agents can now reach this host until one is revoked). |
| Token to the VPS | `scp` of `pairing-vps-agent.token` into the scratch folder, mode 600, never printed |
| `tapdance connect https://861eecdb-….tailc7cb50.ts.net:4720 < <token file>` | accepted; `doctor` passed (provider `self-hosted` → the Mac's endpoint; Android a warning on this iOS-only host) |
| `tapdance host warm android=0,ios=0` on the Mac | worker restarted, no spare (8 GB, as recommended by the 11-06 run) |

## Checklists from the VPS

The drivers in `scripts/field-test/`, one run at a time (one simulator on 8 GB, one guard session), all
under `nohup` with logs to files. Window 11:20:06 – 11:49:02 UTC, about 29 minutes for all six runs.

| Run | Result | Lease | First command | Upload + install | Build | Other latencies |
| --- | --- | --- | --- | --- | --- | --- |
| CLI base (`cli-checklist.sh base`) | **31/31** | 100.0 s | `ui key home` 45.1 s | – | – | tap 9.95 s; key 2.2 / 1.8 s; inspect 5.7 s; screenshot 3.2 s; swipe 5.2 s |
| MCP base (`mcp-ios-base.json`) | **30/30** | 100.5 s | `key_home` 77.0 s (under the 90 s timeout) | – | – | tap 8.3 s; key 0.57 / 0.54 s; inspect 6.3 s; screenshot 4.5 s |
| CLI build (`cli-checklist.sh build`) | **6/6** | 97.5 s | `app build` step 209 s | – | built in 189 s (new commit `c1512722`, Gradle 1 min 46 s, warm DerivedData); reused in 1 s (step 6.9 s with install and launch) | inspect 17.5 s; screenshot 2.7 s |
| MCP build (`mcp-ios-build.json`) | **7/7** | 119.3 s | `build_app` 36.2 s | – | `reused: true` (7 s; the CLI run's build of 11:34:52); again reused in 1 s (step 3.3 s) | inspect 16.4 s; screenshot 2.5 s |
| CLI app (`cli-checklist.sh app`) | **31/31**, 3 skipped | 89.5 s | `app install` 58.4 s | 58.4 s (47 MB zip) | – | inspect 23.2 s; screenshot 4.6 s; swipe 6.7 s |
| MCP app (`mcp-ios-app.json`) | **27/27**, 3 skipped | 87.4 s | `install_app` 31.2 s | 31.2 s (upload 11:45:40 → install 11:45:44 → done 11:46:10) | – | inspect **95.9 s** (see below); screenshot 1.9 s; swipe 2.0 s |

Skipped steps need optional parameters that were not set (`TAP_TEXT`, `TYPE_INTO`, `SEQUENCE_FILE` /
`check_typed`), as on 11-06. The app zip: `ditto` of the newest kept `Pianolune.app` (commit `c1512722`)
on the Mac, 46,818,569 bytes in 4.5 s; `scp` Mac → VPS 1.2 s; the same sha256 on both ends.

Steps that passed include, besides the 11-06 list: build from git on the host and reuse across CLI and
MCP, upload of a 47 MB `.app` zip from Linux, launch with console, alert read, recording, app and crash
logs, crash reports, push to Documents / Files, relaunch in de-DE, rotate, audit, opened links, app
list, kill, clear data, uninstall, artifacts back on the VPS, release.

## Provider proof

- Every lease reply named the Mac: CLI `Provider:  Remote worker` / `Endpoint:  https://861eecdb-….tailc7cb50.ts.net:4720 (TLS)`;
  MCP `"provider": "simlock"`, `"location": {"kind": "remote", "endpoint": "https://861eecdb-….tailc7cb50.ts.net:4720"}`.
- The guard's audit log on the Mac (`~/.tapdance/worker/audit.log`): **202 new lines** during the
  window, every one from client `gt_63edc69cb510` (the `vps-agent` pairing) with `decision allow`;
  **six** `lease.allocate` / `lease.release` pairs whose lease ids and times match the runs:

  | Run | Lease id | Allocate → release (UTC) |
  | --- | --- | --- |
  | CLI base | `0713ef14…` | 11:20:09 → 11:24:56 |
  | MCP base | `11d5e3be…` | 11:25:09 → 11:29:57 |
  | CLI build | `3fc16ece…` | 11:30:06 → 11:35:41 |
  | MCP build | `c766f287…` | 11:35:56 → 11:39:09 |
  | CLI app | `ca3b313d…` | 11:39:36 → 11:43:59 |
  | MCP app | `7121b1bd…` | 11:44:12 → 11:49:02 |

- The build ran on the Mac: `xcodebuild` in `/Users/m1/.tapdance/worker/builds/4d1efcbbb0f2c33b/…`.
- At the end `device status` answered `NO_ACTIVE_LEASE` for `vps-cli` and `vps-mcp`, and no keepalive
  process was left on the VPS.

## Memory on the Mac

| When | Used / free | Compressor | Swap |
| --- | --- | --- | --- |
| Before (no simulator) | 7424 MB / 251 MB | | 136 MB |
| During MCP base (one simulator) | 7497 MB | 3592 MB | 3259 of 4096 MB |
| After (no simulator, worker idle) | 3906 MB / 3769 MB | | 1638 MB |

Disk: 170 GiB free before, 167 GiB after.

## Compared with 11-06 (a Mac as the agent's machine)

| | 11-06, Mac agent | 11-07, Linux VPS agent |
| --- | --- | --- |
| Cold lease (no spare) | 77-143 s | 87-119 s |
| First command after a cold lease | CLI 31.8 s; MCP timed out at 90 s once | CLI 45 s; MCP 77 s, no timeout |
| Upload + install of the 47 MB zip | 105-109 s | 31-58 s |
| Host build | first 9 min 3 s (cold), reused 1-2 s | 189 s (new commit, warm caches), reused 1 s, also across CLI → MCP |
| Pass counts | CLI base 31/31, MCP base 29/30, CLI build 6/6, MCP build 7/7, CLI app 31/31, MCP app 27/27 | CLI base 31/31, **MCP base 30/30**, CLI build 6/6, MCP build 7/7, CLI app 31/31, MCP app 27/27 |

The agent's operating system made no difference to the tool: the same drivers ran unchanged on Linux.
The latencies are set by the 8 GB host, not by the agent's machine.

## Failures and observations

No step failed.

1. **MCP `inspect_screen` stalled 95.9 s (passed).** The audit log shows a `snapshot` call at
   11:46:35.9 and a second at 11:48:07.4 (about 91.5 s later), after `launch_app` with console at
   11:46:24: the first read hung until the ~90 s daemon request timeout and the retry answered quickly.
   Tapdance's own retry (`packages/provider-simlock/src/provider.ts`, `inspect`) is Android-only, so it
   was most likely agent-device's daemon client. The CLI equivalent took 23 s. Environment-leaning
   (swap nearly full), possible tool issue: the agent gets no signal for 90 s.
   [#128](https://github.com/mirzemehdi/tapdance/issues/128)
2. **First command after a cold lease:** CLI 45 s, MCP 77 s, the same pattern as 11-06, within the
   90 s timeout this time. Environment (8 GB host, swap 3.2 of 4 GB).
3. **Wrong hint:** `device status` with no lease said "Lease one first: `tapdance device lease
   --platform android`" on an iOS-only setup. Fixed on this branch: the hint names the platforms the
   configuration enables (`--platform ios` when only iOS is on, else `--platform android|ios`).
4. The CLI build's 189 s is not a cold build (DerivedData and Gradle caches from earlier runs); the cold
   9-minute figure was not measured again.
5. Checkpoints A and B (above) assumed a second machine: [#126](https://github.com/mirzemehdi/tapdance/issues/126),
   [#127](https://github.com/mirzemehdi/tapdance/issues/127). The runbook now has a VPS-only path.
6. `host up` for a second agent on a host that already has a pairing leaves the old pairing active
   (`stage3-agent` from 11-06). Expected, but the runbook's clean-up now says to check
   `tapdance worker guard tokens` for leftovers from earlier runs.

No Pianolune quirks were seen (no tap or type steps ran on the app).

## How to re-run

[docs/testing/field-test-rented-mac-ios.md](../field-test-rented-mac-ios.md), "Variant: the agent runs on
a Linux VPS".

## Not covered

A cold host build from a Linux agent, a warm-spare lease (8 GB: no spare), the browser viewer from the
VPS, gateway mode (e2e procedure 6), `app install --from-ci` for iOS, a Mac with 16 GB or more, and a
reboot of the Mac during this run.
