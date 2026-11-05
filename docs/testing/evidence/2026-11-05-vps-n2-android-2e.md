# Evidence: Android on a Google Cloud N2 VM, driven from a Linux VPS, field run 2e — 2026-11-05

Real VM, real emulators, no mocks. Two machines: a Linux VPS as the agent's machine and a new
`n2-standard-4` VM in Google Cloud as the device host, linked over Tailscale in device-only mode. Run 2e
continues [2d](2026-11-05-vps-n2-android-2d.md) (which stopped part-way when the test agent's usage limit
was reached) on a fresh VM, with `main` at `ea6ccbd`, which includes PR #115 (faster lease after a
release: early busy exit, parallel warm-up, early notices). It covers the items 2d did not reach and
re-measures the lease timing of #101 and #79 with #115. No code was changed during the run; two new
problems are filed as issues. The 2d evidence is in PR #116 (open when this was written).

## Environment

| Item | Value |
| --- | --- |
| Agent's machine | Linux VPS (x86_64, Ubuntu), Tapdance 0.1.0 at `main` `ea6ccbd`. Scratch `TAPDANCE_HOME=~/.tapdance-n2`, session `vps-n2e`. The owner's `~/.tapdance` was not touched. |
| Device host | Google Cloud `n2-standard-4` (4 vCPU, 16 GB), `europe-west1-b`, Ubuntu 24.04, nested virtualization, inbound SSH from IAP only, `/dev/kvm` present. New project `tapdance-n2e-20261105-e8eh` and new VM (created 12:20:34Z). |
| Terraform | `infrastructure/terraform/google-cloud-n2` (same module as 2d) with `max_run_hours = 4`, `on_run_limit = "DELETE"`. `plan` 18 to add, `apply` 18 added. |
| Simlock, agent-device | 0.5.0 with `patches/simlock@0.5.0.patch`, 0.21.35 |
| Emulator image | `system-images;android-34;google_apis;x86_64` (the default); the Play image was added for item 5 |
| App under test | Pianolune (`KAppMakerDeveloperApps/Pianolune-All`, CI artifact `android-debug-apk`, `com.measify.pianolune`, main at `2af7bdd49255`) |

Setup gotchas (Terraform/gcloud, not Tapdance): setting the quota-project environment variables before the
project exists makes `create`, billing link and `services enable` fail (set them only after); `services enable`
needs full API names (`compute.googleapis.com`).

## Results

| # | Item | Result |
| --- | --- | --- |
| 1 | Setup on a fresh VM | PASS |
| 2 | Lease timing after #115 (#101, #79) | PASS: 16.0-22.0 s right after a release, mean 20.4 s (target 10-25 s; 2d 35-43 s) |
| 2 | Settle controls (`--settle 60`, `--settle 0`, MCP default) | PASS |
| 3 | `daemon.log.1` rotation (#111) | PASS (rotation happens when the daemon opens its log, so it needed a worker restart) |
| 4 | Stale Simlock service refresh (#110) | `host up` route PASS; `worker restart` route FAIL (filed as #118) |
| 5 | Image choice (#112) | PASS, with minor notes |
| 6 | Pianolune: #104, #106, #107, #108, #109, MCP build | PASS; MCP build checklist 6/6 |
| 7 | VM stop/start then lease (#94) | PASS |

New issues: [#117](https://github.com/mirzemehdi/tapdance/issues/117) (a lease right after a release says "no spare is ready ... a few minutes"
though the device comes back from its snapshot in about 4 s) and [#118](https://github.com/mirzemehdi/tapdance/issues/118) (`worker restart`: the stale-service refresh
fails without a user bus and leaves no login service).

## Item 1: setup

`host-setup.sh` from `main` on the VM through IAP SSH, 12:22:08Z start. Install list shown at once, one "y".

| Step | 2e | 2d |
| --- | --- | --- |
| Prerequisites "y" to Tailscale prompt | 107 s | 120 s |
| Self-test (cold lease, first boot and clean baseline) | 126 s (lease 107 s) | 168 s (132 s) |
| Whole run, owner's login wait included | 406 s (114 s of it waiting; about 292 s without) | 388 s |

- PASS self-test exit 0, "self-test: PASS (android lease, screenshot ok)".
- PASS #115 in the self-test: it now prints the "Still attaching the automation session" lines, the
  "Waiting for the device to settle (guest CPU 97 %...)" line, "Handing the device out while it is still busy
  (guest CPU 96 % ... waited 6 s)" and the slow-start warning, then the screenshot. 2d dropped these.
- PASS pairing from the VPS (`tapdance connect`, token piped over ssh and never printed), `doctor` all
  checks passed, one warm Android spare.
- PASS `gh` login on the host (token piped by stdin), allow-lists for artifacts and builds enabled for
  `KAppMakerDeveloperApps/Pianolune-All`, `host up --idle-stop off --skip-self-test`.

## Item 2: lease timing (#115)

Driver: leases, runs `ui inspect`, a screenshot, an app launch, a tap and Back, checks the VM for an
"isn't responding" dialog and ANRs, then releases. Every re-lease started 0.5-1 s after the previous
release (A1: 7 s after A0's). 12:30-12:39Z.

| Lease | Kind | Lease s | Busy notice at (s) | Notice to Ready (s) | qemu % at Ready | First inspect s | Screenshot / launch / tap / back s |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A0 | idle spare (guest CPU 59 %) | 10.01 | none, "Settled" at 9.5 | - | 168 | 1.41 | 1.61 / 5.14 / 5.11 / 2.11 |
| A1 | right after release | 15.95 | 14.6 | 0.8 | 367 | 2.76 | 2.84 / 8.82 / 10.08 / 2.68 |
| A2 | right after release | 21.96 | 19.4 | 1.9 | 387 | 3.40 | 2.77 / 8.79 / 8.24 / 2.82 |
| A3 | right after release | 21.57 | 19.7 | 1.3 | 381 | 2.56 | 2.84 / 8.51 / 11.26 / 3.86 |
| A4 | right after release | 20.61 | 18.1 | 1.9 | 370 | 3.05 | 2.69 / 7.61 / 7.26 / 2.82 |
| A5 | right after release | 21.78 | 19.7 | 1.5 | 368 | 2.61 | 2.80 / 8.69 / 8.91 / 2.84 |
| S60a | `--settle 60`, 30 s after A5's release | 17.04 | "Settled (guest CPU 34 %; waited 8 s)" | - | - | 1.98 | 1.90 / 5.66 / 7.32 / 4.47 |
| S60b | `--settle 60`, right after release | 40.97 | falling-load notice at 29 s (49 %, down from 93 %); "Still settling" at 17 s | - | - | 2.06 | 1.74 / 5.00 / 6.48 / 2.81 |
| S0a | `--settle 0`, right after release | 23.82 | none, no settle lines | - | - | 2.39 | 3.02 / 7.99 / 8.05 / 3.85 |
| MCP | `lease_device`, no `settle_seconds`, right after release | 24.75 | `notices`: still busy after 6 s, handed out | - | - | 2.12 | - |

Where a re-lease goes (A1-A5, CLI timestamps): request to Granted 0.9-4.2 s, attach (Granted to "Waiting
for the device to settle") 10.0-13.9 s, CPU check 3.3-3.4 s (the first 3 readings were 95 % or more and
not falling, so the guest was handed out with the busy notice and warning), then Ready 0.8-1.9 s later
(the warm-up; the helper's first read still fails with a 5xx on every lease, as in 2d). 2d: CPU check
15-16 s, warm-up 6-9 s. The attach phase (10-14 s; 2d 8.5-15 s) is now the largest part. The notice is
printed 0.8-1.9 s before Ready; the "Still attaching the automation session" lines appear during attach.

Verdicts:

- **PASS** lease right after a release 10-25 s: 15.95 / 21.96 / 21.57 / 20.61 / 21.78 s, mean 20.4 s (2d
  35.1-43.0 s; the #115 changelog expected 18-28 s). The idle spare (A0) takes 10.0 s (2d 10.3 s).
- **PASS** early busy hand-out: every busy re-lease printed the notice and warning after 5-6 s of checks.
- **PASS** no "isn't responding" dialog on any lease (window dump and `am_anr` log empty on every check).
- **PASS** commands work while the guest is busy: inspect 2.6-3.4 s, launch 7.6-8.8 s, tap 7.3-11.3 s, back
  2.7-3.9 s, about the same as 2d.
- **PASS** controls: `--settle 60` still waits (S60b 41.0 s, with "Still settling" and the falling-load
  notice; S60a ended early on a calm 34 % reading after 8 s because it started 30 s after the release, so
  it met a calmer guest than 2d's S60a); `--settle 0` takes 23.8 s with no settle lines; the MCP default
  takes 24.75 s with the notice in `notices`.
- Cold lease: the self-test's first lease (first boot and baseline) took 107 s; item 5 measured 123.6-140.7 s
  for new kinds (below).
- Not re-measured: a long idle before a lease. Each release restores the snapshot, so the next lease lands
  in the busy phase (qemu about 370 % through each cycle, as in 2d).
- New, low: the first request line says "no spare is ready, so a device has to start: this can take a few
  minutes" on A2, A3 and A5 although the device is restored from its snapshot in about 4 s: #117.

## Item 3: `daemon.log.1` rotation (#111)

Read first: in Simlock 0.5.0 (`NodeFileLogSink`) the file size is read once when the log is opened, then
counted in memory, and rotation (`daemon.log` to `daemon.log.1`) happens on a write when the size would pass
`log.rotateBytes` (default 5 MiB). So appending to a running daemon's file does not rotate it; the next
daemon start does.

Method: the real baseline line was already in the log (self-test, 12:28:19Z). Appended 17,027 valid JSON
filler lines (147,014 to 5,448,328 bytes) while the worker ran, then `tapdance worker restart` (4.6 s, no lease held).

- PASS rotation: `daemon.log` 3,653 bytes and fresh, `daemon.log.1` 5,449,541 bytes ending in "Daemon stopped".
- PASS `tapdance worker logs -n 5000 --contains baseline` finds the "Capturing the Android clean baseline"
  line, which now lives only in `daemon.log.1`.
- PASS a missing `daemon.log.1`: "no matching lines in .../daemon.log", exit 0, no crash. `--since 20s` and
  `--since <ISO>` filter correctly.
- Cleanup: filler removed from `daemon.log.1`; logs normal again. Worker after restart kept the warm
  spare, `doctor` all checks passed.
- Note: rotating by hand needs a worker restart. `worker logs` handles both files.

## Item 4: stale Simlock service refresh (#110)

The VM clone is shallow, so the old install was made with `git fetch --depth 1 origin 4bfa377... && git
checkout FETCH_HEAD` (unit `patch_hash=c76b69d8`, a learned spare in place), then back to `main`
(`patch_hash=4857eade`), `pnpm install --frozen-lockfile`, `pnpm build`.

- **PASS route 1, `tapdance host up` (6.5 s):** printed "The worker's login service ... is out of date: it
  starts simlock 0.5.0 (patch c76b69d8), this Tapdance ships simlock 0.5.0 (patch 4857eade). Installing it
  again from this Tapdance; warm-spare settings and learned spares are kept." Afterwards the unit and the
  running process carry `4857eade`, `doctor` shows Simlock 0.5.0 and passes, `host warm` still lists Pixel 8 /
  34 (learned) ready 1, and a lease said "a warm spare is ready" (22.5 s to Ready).
- Also: with `main`'s CLI, `worker install --service` on a current unit says "left as is" and keeps the spare.
  (It is the older CLI's install that drops the spare.)
- **FAIL route 2, `tapdance worker restart` on the VM over a non-login ssh session**, twice: the same
  "out of date" line, then `[PROVIDER_UNAVAILABLE] simlock --local daemon install failed ... systemctl
  --user daemon-reload failed: Failed to connect to bus: No medium found` (exit 4). Cause: `worker restart`
  does not set up the user bus (`prepareLinuxUserServices` / `useUserBus` run only in the `worker install`
  path and in `host up`), so `XDG_RUNTIME_DIR` is unset. Worse, the old unit file was removed before the
  failure, so the login service was gone; a second `worker restart` said "Restarted" and did not recreate
  it, with no hint. The daemon itself kept running the new patch with the spare. Recovery:
  `tapdance worker install --service`. Filed as #118.

Final VM state: `main`, built, unit `4857eade`, `doctor` passes, learned spare ready.

## Item 5: image choice (#112)

`yes | tapdance devices install android 34 --image-tag google_apis_playstore` took 45 s (both images now under
android-34). All leases Pixel 8 / Android 34.

| Lease | Notes | Ready |
| --- | --- | --- |
| no tag | "Using the google_apis image (this host also has google_apis_playstore; ask for that image tag when the test needs the Play Store), API 34, the host's default"; "no spare is ready" (true: the spare was the old "(no image tag)" one) | 140.7 s (cold) |
| `--image-tag google_apis` | "Using API 34, the host's default" (no image line); "no spare is ready" (the spare had just been consumed) | 22.0 s |
| `--image-tag google_apis_playstore` | "Using API 34, the host's default"; "no spare is ready" (the spare was the other kind); new AVD, device limit 1 so only the Play AVD remained | 128.4 s (cold) |
| no tag again | image line again; "no spare is ready" (the spare was the Play one) | 123.6 s (cold, the cost of switching kind) |
| no tag, `google_apis` spare ready | "a warm spare is ready"; AVD config `image.sysdir.1=system-images/android-34/google_apis/x86_64/` | 13.8 s |

`host warm` shows the tag per spare ("google_apis (learned): ready 1", "google_apis_playstore (learned): ready 0").

- **PASS**: no tag gets `google_apis` and says so; `--image-tag google_apis` keeps API 34; the warm-spare
  line appears only when the tag matches; `host warm` shows tags.
- Minor: the Play lease says only "Using API 34, the host's default" (no mention of the Play image); a stale
  "(no image tag) (learned): ready 0" row stays in `host warm` from before the fix; `device status` shows no image tag.

## Item 6: Pianolune checks

Main `ea6ccbd` on the VM; Pianolune at `2af7bdd49255`.

- **PASS #104 (host build, then MCP build reuses it):** `app build ... --launch` (CLI build checklist) 5/5; built
  `androidApp-debug.apk` in 491 s (2d 649 s). `mcp-build.json` on the same commit 6/6 (wall 47.8 s, 2c 1 min
  4 s): `build_app` 4.8 s with `reused: true`, installed, launch 14.3 s, first lease 25 s.
- **PASS #106:** `logs --level error -n 200` (201 lines) and `-n 5000`: every line has level `E`; `--level fault`
  says "no matching lines". The word "default" appears in 2 of 72 lines only as message text. MCP `get_logs` has the same shape.
- **PASS #107:** MCP `kill_app` + `clear_app_data` + `launch_app` five times: 5/5 ok, no `DEVICE_ERROR`, no
  warning. Launch 9.4, 12.6, 10.3, 29.6, 5.8 s (one slow but ok; 2c failed 2 of 5). `clear_app_data` 0.7-1.4 s.
- **PASS #108 and #109:** every hint, next-step and error text in the run's output names a tool or command that
  exists (`install_app`, `list_apps`, `inspect_screen`, `launch_app`, `ui inspect`, `ui wait`, `host warm`, `worker
  logs`, ...), no `<appId>` placeholder, no `snapshot -i`, `--debug` or `find <`.
- Latency, median of five (CLI includes process start):

| Command | 2e CLI | 2c CLI | 2e MCP | 2c MCP |
| --- | --- | --- | --- | --- |
| tap | 2.13 s (first 4.91) | 1.95 s | 2.42 s (first 3.99) | 1.66 s |
| key / back | 2.02 s | - | 1.48 s | 1.42 s |
| inspect | 0.51 s | 0.56 s | 0.087 s | 0.08 s |
| screenshot | 0.89 s | 0.81 s | 0.43 s | 0.35 s |

  Taps are about 10-45 % slower than 2c; the rest is within noise.
- Setup note (not a bug): each new lease is a clean device, so the host-built APK is not kept across leases;
  the first MCP run failed `APP_NOT_INSTALLED` until `build_app` (reused, 4.6 s) ran inside the lease. The CLI
  reused path takes 21.6 s in a fresh lease (install and launch).

## Item 7: VM stop then start, then lease (#94)

One stop/start, 13:28-13:31Z.

| Step (s from start) | 2e | 2c |
| --- | --- | --- |
| stop to TERMINATED | 53.6 | 53-59 |
| RUNNING | 11.4 | 13.8-16.7 |
| `tailscale ping` | 35.6 | - |
| healthz 200 | 41.9 | 43.7-44.2 |
| `doctor` passes (first poll) | 43.9 | 51.5 |
| lease Ready | 91.8 (lease 47.4) | 100-117 |
| inspect / screenshot / tap / release | 2.48 / 3.60 / 6.68 / 1.65 | 2.9 / 2.4 / - / 2.0 |

- **PASS**: the first `doctor` poll said "Android emulators available - 0/1 running, 0 warm" (the dead emulator
  is not reported running, the patched startup pass), no `DEVICE_UNAVAILABLE` or "No Android device with
  serial" anywhere in the raw output, and the lease succeeded. The busy hand-out (#115) printed its warning
  after 6 s; the tap took 6.7 s while busy.

## Issues

- Opened: #117 (misleading "no spare is ready ... a few minutes" line on a fast re-lease), #118 (`worker
  restart` stale-service refresh fails without a user bus and leaves no login service).
- #79 and #101: the lease timing is now within target (16-22 s, mean 20.4 s) with #115; both closed with this
  run's numbers.

## Cost

Estimates from Google's published `europe-west1` rates, not a billing export.

| Run | VM time | Cost |
| --- | --- | --- |
| 2e (2026-11-05) | 12:20:58–13:29:38Z and 13:29:46–13:33:36Z, about 1.21 h | about USD 0.27 (VM 0.25, 64 GB disk 0.01, external IP 0.01; egress not measured) |

Teardown: `terraform destroy` (18 destroyed), `gcp-leftovers.sh` exit 0, budget gone, billing unlinked, project deleted (DELETE_REQUESTED). `revoke-run-credentials.sh`: gcloud logins and application-default credentials revoked, the run's Tapdance profile removed; `--check` shows nothing left.

## Results by requirement

| ID | Result | Note |
| --- | --- | --- |
| W-07 | PASS (Linux) | `host-setup.sh` on a fresh VM, self-test with the #115 notices, 126 s; `host up` refreshes a stale login service (#110). |
| W-04 | PASS (partly) | `worker logs` over a rotated log (#111). The `worker restart` refresh route fails without a user bus (#118). |
| D-01 | PASS | `google_apis` default and the Play image side by side; the lease says which it picked (#112). |
| G-07 / W-03 | PASS | A lease right after a VM stop/start works with no `DEVICE_UNAVAILABLE` (#94). |
| H-08 | PASS | CLI host build 491 s, then MCP `build_app` reuses it (5 s). |
