# Evidence: Android on a Google Cloud N2 VM, driven from a Linux VPS, field run 2d (partial) — 2026-11-05

Real VM, real emulators, no mocks. Two machines: a Linux VPS as the agent's machine and a new
`n2-standard-4` VM in Google Cloud as the device host, linked over Tailscale in device-only mode. The
run started on 2026-11-04 (VM created 23:37:20Z) and ended on 2026-11-05. The goal was to check the
fixes merged since the [previous run](2026-11-04-vps-n2-android-rerun.md) on real hardware, mainly the
lease timing of #101 and #79.

**This run is partial.** It stopped at about 00:47Z, in the middle of its last item (the regression
checklists), because the test agent's model usage limit was reached. The owner then stopped the VM and
deleted the project (about 01:4xZ). Items 4, 5 and 6 and part of item 7 were never run; they are listed
under [Not reached](#not-reached) and stay unverified. No code was changed during the run.

## Environment

| Item | Value |
| --- | --- |
| Agent's machine | Linux VPS (x86_64, Ubuntu), Tapdance 0.1.0 at `main` `ef1f4b5` (after PR #114). Scratch `TAPDANCE_HOME=~/.tapdance-n2`, session `vps-n2d`. The owner's `~/.tapdance` was not touched. |
| Device host | Google Cloud `n2-standard-4` (4 vCPU, 16 GB), `europe-west1-b`, Ubuntu 24.04, 64 GB disk, nested virtualization, inbound SSH from IAP only. New project `tapdance-n2d-20261104-hj4e` and new VM for this run. |
| Terraform | 1.17.1, `infrastructure/terraform/google-cloud-n2` with `max_run_hours = 6`, `on_run_limit = "DELETE"`, `budget_amount_usd = 5`. `plan` 18 to add, `apply` 102 s. |
| Simlock, agent-device | 0.5.0 with `patches/simlock@0.5.0.patch`, 0.21.35 |
| Emulator image | `system-images;android-34;google_apis;x86_64` (the new default, not Play) |
| App under test | Pianolune (`KAppMakerDeveloperApps/Pianolune-All`, CI artifact `android-debug-apk`, `com.measify.pianolune`, main at `2af7bdd49255`) |

Note: `main` has moved on since this run. PR #115 (faster lease after a release: early busy exit,
parallel warm-up, early notices) was merged after `ef1f4b5`, so **this run did not test #115**.

## Results

| # | Item | Result |
| --- | --- | --- |
| 1 | Setup on a fresh VM (`host-setup.sh --label vps-n2d --with-gh --sdk-packages "cmake;3.31.6"`) | PASS |
| 2 | Lease timing (#101, #79) | Re-lease after release FAIL against the 10-25 s target; the other sub-items PASS |
| 3 | Baseline log and log options (#103, #111) | PASS |
| 4 | Stale Simlock service refresh (#110) | Not reached |
| 5 | Image tag choice (#112) | Not reached |
| 6 | VM stop/start then lease (#94) | Not reached |
| 7 | Regression checklists | CLI base 25/25, CLI app 27/27 (1 skipped), CLI build 5/5, MCP base 24/24, MCP app 27/27 (2 skipped); #107 PASS; other spot-checks not reached |

## Item 1: setup

`host-setup.sh` from `main`, run on the VM through IAP SSH. 23:40:51Z start, TAPDANCE HOST READY at
23:47:19Z, exit 0. Total 6 min 28 s, of which 52 s waiting for the owner's Tailscale login (last run
11 min 59 s, with about 5 min waiting). Self-test 168 s (last run 232 s); its cold lease took 132 s
including the first boot, the clean baseline and the restore.

- PASS #100: the emulator libraries (`libpulse0 libxkbfile1 libxi6 libsm6 libice6`) are in the install
  list and in the single `sudo` line, before "Install them now?". No unlisted `sudo` after "y".
- PASS default image is `google_apis` (install list, `doctor`, only that image directory on disk).
- PASS `gh` 2.45.0 and `cmake;3.31.6` installed by the script.
- PASS tools resolve over non-interactive SSH (`java`, `sdkmanager`, `adb`, `emulator`, `tapdance`, `gh`, `pnpm`).
- PASS Android CLI metrics turned off (`~/.androidrc`), one linger line per command, cost guard line
  ("idle 0 min, powers off in about 29 min"), RAM budget line.
- PASS Simlock 0.5.0 patched (the pnpm unit name carries the patch hash), `doctor` all checks passed.
- PASS pairing from the VPS: `tapdance connect` 0.70 s, fingerprint matched, `doctor` all pass.
- PASS allow-lists for artifacts and builds enabled; idle stop switched off for the run; the learned
  warm spare (`android Pixel 8 / 34`) kept.

Gaps seen, not filed as issues: the self-test printed "Waiting for the device to settle" and no outcome
line before [8/8] (its path did not print lease notices; PR #115 addresses this), and `host warm` shows
the learned spare as "(no image tag)" although it is `google_apis` (relevant to #112, item 5 not reached).

## Item 2: lease timing (#101, #79)

Driver: a script that leases, runs `ui inspect`, a screenshot, an app launch, a tap and Back, checks
the VM for an "isn't responding" dialog and ANRs, then releases. Every lease started 0.5 s after the
previous release. Run 23:51Z to 00:17Z.

| Lease | Kind | Lease s | Settle outcome | First inspect s |
| --- | --- | --- | --- | --- |
| A0 | idle spare, calm | 10.3 | no settle lines | 1.57 |
| A1 | spare restored 9 s earlier | 35.1 | notice after 16 s | 2.83 |
| A2 | right after release | 42.8 | notice after 17 s | 3.91 |
| A3 | right after release | 42.1 | notice after 16 s | 3.28 |
| A4 | right after release | 36.4 | notice after 16 s | 3.80 |
| A5 | right after release | 43.0 | notice after 16 s | 3.52 |
| B1 | `host warm android=0` (qemu gone), new qemu from the baseline | 40.7 | notice after 16 s | 3.43 |
| C1 | never-used Pixel 7: new AVD and baseline | 158.3 | notice after 16 s | 3.20 |
| P8 | Pixel 8 again (its AVD removed by C1, device limit 1): new AVD and baseline | 161.1 | notice after 17 s | 2.75 |
| S60a, S60b | `--settle 60` | 39.4, 69.6 | "Still settling" every ~15 s, ended early on a falling load (29 s, 45 s) with the falling notice | 1.83, 1.82 |
| S0a, S0b | `--settle 0` | 26.6, 22.9 | no CPU-check lines, no notice | 3.55, 3.16 |
| MCP | `settle_seconds` 60 / 0 / default | 42.0 / 31.2 / 43.2 | notice (falling) / no `notices` / notice (still busy) | 1.09 / 2.12 / 2.38 |

Where the time goes on a lease right after a release (A2-A5, daemon log): snapshot restore 3.4-3.6 s,
attach `apps.open` 8.5-14.8 s (idle spare: about 1.5 s), CPU check 15-16 s, snapshot-helper warm-up
6-9 s (its first read fails on every lease with `INSTRUMENTATION_FAILED` after 2.3-2.7 s, then a retry
takes 3.8-5.6 s). Sum 35-43 s. With `--settle 0` the lease takes 23-27 s: attach and warm-up alone.
The restored guest stays busy for about 55-60 s after each release (about 3 min after a first boot), so
an immediate re-lease always lands in the busy phase.

Verdicts:

- **FAIL (improved)**: lease right after a release is 35-43 s (mean 39.9 s) against the 10-25 s target.
  Last run: 76-93 s, so about twice as fast, but above target. The idle spare (A0, 10.3 s) meets it.
- PASS: a busy guest goes out with the notice after at most 16-17 s of CPU checks, every time.
- PASS: cold lease well under 330 s. B1 (qemu gone, restored from the baseline) 40.7 s; never-used
  model 158.3 s and 161.1 s, full first boots (last run 269.1 and 347.5 s). B1 is not a full Android
  cold boot; C1 and P8 are.
- PASS: never-used model. New AVD, `Capturing the Android clean baseline` logged with `busy` 0.96,
  no settle or dexopt wait.
- PASS: no "isn't responding" dialog on any lease (window dump empty, screenshots show the home
  screen). Background broadcast ANRs (`gms.persistent`, `gms`) are logged 5-15 s after every restore,
  not only after the first boot; silent, Android-side.
- PASS (calm) / expected (busy): first inspect 1.1-1.8 s on a calm guest, 2.8-3.9 s on a busy one.
  No inspect failed; the helper's failure now happens inside the lease.
- PASS: the settle setting is honoured on CLI and MCP, in both directions (60 waits and ends early on a
  falling load, 0 skips the check and gives the fastest lease but slower first commands, 11-14 s launch).
- Also seen: after C1 the Pixel 8 AVD was gone (device limit 1), and default leases with no `--device`
  then got the Pixel 7 spare, not the host's Pixel 8 default. Relevant to #112.

Issue comments: [#101](https://github.com/mirzemehdi/tapdance/issues/101#issuecomment-6645979365)
(timing table, phase breakdown, late notice, self-test drops notices, ANRs after every restore) and
[#102](https://github.com/mirzemehdi/tapdance/issues/102#issuecomment-6645979705) (the helper's first
start still fails on every lease; the cost moved into the lease). #79 and #101 stay open.

## Item 3: baseline log (#103, #111)

- PASS `tapdance worker logs -n 500 --contains baseline` found the line for each new device kind after
  about 25 leases and 2 worker restarts: `Capturing the Android clean baseline {"avdName":"simlock_55d1...","busy":0.97}`
  (self-test) and `... "busy":0.96` (C1); P8's third line (0.91) came after the check. The last run's
  tail of 100 lines had lost it (#111).
- PASS no settle or dexopt wait: `--contains` settle / dexopt / "still busy" over 5000 lines found nothing.
- PASS options: `--contains` is case-insensitive, `-n 3` gives 3 lines, `--since 2h`, `--since 10m` and an
  ISO time filter correctly; bad values exit 2 with a usage message (`--since 5x`, `-n 0`, `-n abc`);
  `--help` documents all three. Log rotation (`daemon.log.1`) not exercised.

## Item 7: regression checklists (partly reached)

Pianolune APK from CI run 41896119365 (main at `2af7bdd49255`), used for the installs.

| Checklist | Result |
| --- | --- |
| CLI base | 25/25 passed |
| CLI app | 27/27 passed, 1 skipped (typing needs a target field, not set) |
| CLI build (host build from the private repo) | 5/5 passed; cold build 648.8 s (the CLI reports 637 s on the host), installed and launched, inspect 1.2 s, screenshot 1.2 s |
| MCP base | 24/24 passed |
| MCP app | 27/27 passed, 2 skipped (`type_into_field`, `check_typed`, same reason) |

Spot-checks: #107 PASS (`app launch` straight after `app clear` succeeded, 6.4-11.2 s). #104, #106, #108
and #109 were not reached; the MCP `build_app` checklist was not run.

Hand-timed command latency on a restored, still-busy guest (CLI, `raw/item7/hand-cli.log`,
`lat-cli.log`):

| Command | Seconds |
| --- | --- |
| `ui tap --text` | 1.9-3.5 (the first 3.5, then 1.9-2.4) |
| `ui key back` | 1.7-1.9 |
| `ui inspect` | 0.51-0.58 |
| `screenshot` | 0.75-1.07 |
| `app install` of an upload / `--from-ci` (cached) | 3.2-4.7 / 3.2-4.3 |
| `app launch` after `app clear` | 6.4-11.3 |
| `app kill` / `app clear` | 1.1-1.3 / 0.9-1.1 |

MCP on the same kind of guest: `tap` 1.5-1.8 s, `press_key` 1.2-1.3 s, `inspect_screen` 55-63 ms,
`take_screenshot` 330-353 ms. A lease through the CLI with a warm spare took 33.2-37.0 s.

## Not reached

These remain **unverified**:

- Item 4 (#110): refresh of a stale Simlock service after pull and build, `doctor` showing the patch,
  learned spare surviving.
- Item 5 (#112): lease with no `--image-tag` saying it got `google_apis`, `--image-tag google_apis`
  keeping the host default, the "warm spare is ready" line only when it matches.
- Item 6 (#94): VM stop/start, `doctor`, immediate lease.
- Item 7: the MCP `build_app` check, and the spot-checks #104 (CLI build then MCP build reports
  "reused"), #106 (`logs --level error` has no "default" lines), #108 and #109 (no hint names a missing
  command or an `<appId>` placeholder).
- The early busy exit, parallel warm-up and early notices of PR #115 (merged after `ef1f4b5`).

## Teardown and cost

- The owner stopped the VM and deleted the project; Resource Manager reports the project "has been
  deleted" and billing is disabled. `gcp-leftovers.sh` was not run (the project was already gone).
- `revoke-run-credentials.sh` was run: no gcloud logins left, ADC revoked, the run's profile removed.
- Cost estimate: about USD 0.50 (about 2.1 h of `n2-standard-4` at about USD 0.21/h, plus disk and IP).
  No billing export, so this is an estimate. The USD 5 budget and `max_run_hours = 6` were never close.
