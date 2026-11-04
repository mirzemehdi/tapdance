# Evidence: Android on a Google Cloud N2 VM, driven from a Linux VPS, rerun — 2026-11-04

Real VM, real emulators, no mocks. Two machines: a Linux VPS as the agent's machine and a new
`n2-standard-4` VM in Google Cloud as the device host, linked over Tailscale in device-only mode. Run by
a test agent on the VPS with the owner approving each billable step. The goal was to check the fixes
merged since the [last run](2026-11-03-vps-n2-android.md) (PRs #97, #98, #99) on real hardware.
Two parts on one VM: part 1 on `main` at `c92fbed` (brief items 1, 2, 4–6, then 3), part 2 on `main` at
`4bfa377` (PR #105) on **the same VM, not a fresh one**. Result: setup, #79, #94 and the CLI and MCP
checklists passed on `c92fbed`; part 2 showed the #105 settle and inspect changes working but no shorter
busy phase. No code was changed during the run; the problems found are filed as issues.

## Environment

| Item | Value |
| --- | --- |
| Agent's machine | Linux VPS (x86_64, 8 GB, Ubuntu), Node.js 22.22.2, pnpm through corepack. Tapdance 0.1.0 at `c92fbed` (part 1), then `4bfa377` (part 2). Scratch `TAPDANCE_HOME`, session `vps-n2c`. The owner's `~/.tapdance` was not touched. |
| Device host | Google Cloud `n2-standard-4` (4 vCPU, 16 GB), zone `europe-west1-b`, Ubuntu 24.04, 64 GB `pd-balanced`, nested virtualization, inbound SSH from IAP only, OS Login account. New project and new VM for this run. Node.js 22.23.4, `gh` 2.45.0 (apt, installed by `host-setup.sh`). |
| Terraform | 1.17.1, `infrastructure/terraform/google-cloud-n2` with `max_run_hours = 6`, `on_run_limit = "DELETE"`, `budget_amount_usd = 5`. `plan` 18 to add (19 s), `apply` 104 s. |
| Simlock, agent-device | 0.5.0 with `patches/simlock@0.5.0.patch` (part 1: the #94/#79 patch; part 2: the #105 patch with dexopt), 0.21.35 |
| Emulator | 37.2.13, headless, `-gpu swiftshader_indirect`. Part 1: `android-34;google_apis_playstore;x86_64`. Part 2 added `android-34;google_apis;x86_64` (through `host-setup.sh`) and `android-35` (through `tapdance devices install android 35`). |
| Network | Tailscale with HTTPS certificates; guard endpoint `https://tapdance-n2.<tailnet>.ts.net:4720` |
| Devices | Pixel 8 / Android 34 (Play, then `google_apis`); Pixel 9 / Android 35 (`google_apis`, part 2) |
| Test apps | The Pixel launcher and Settings; Pianolune (the owner's Kotlin Multiplatform app, debug APK of about 77 MB, CI artifact `android-debug-apk`, app id `com.measify.pianolune`) |

## What ran

Times are UTC. Raw logs, `timings.csv` and the checklist `results.json` files are kept locally on the VPS.

### Part 1: `c92fbed` (VM started 20:03:40)

- **Item 1, setup** — PASS. `host-setup.sh` from `main` with `--label vps-n2c --with-gh --sdk-packages "cmake;3.31.6"`.
   One install list (Node.js 22, JDK 17, command-line tools, platform-tools, emulator, the Play image,
   `cmake;3.31.6`, Tailscale, `gh`, the kvm group), one "y"; prerequisites 99 s. The emulator's system
   libraries were then installed with `sudo` without being on that list (#100). Tapdance is now built
   before the Tailscale prompt. Owner's Tailscale login 5 min; `host up` self-test (cold boot plus clean
   baseline) 232 s. In all 11 min 59 s, about 7 min without the Tailscale wait. Checks:
   - `tapdance`, `adb`, `emulator`, `sdkmanager`, `java`, `gh` found over plain non-interactive ssh;
     `ANDROID_SDK_ROOT` set; `env.sh` sourced first in `~/.bashrc`: PASS.
   - `~/.androidrc` holds `--no-metrics`: PASS.
   - "cannot linger": once from `host-setup.sh`, once from `host up`, once per later `host up`: PASS (no spam).
   - Cloud VM line "Google Cloud, billed while running; its disk bills even when stopped…": PASS.
   - `host status` cost guard "idle stop after 30 min, uptime cap off; idle 0 min, powers off in about
     30 min (around 20:48 UTC)": PASS. `gh` row "ok logged in" once artifacts were enabled: PASS.
   - Simlock 0.5.0 in `doctor`; `NOTICE.md` lists the patch; the installed package carries the patch hash:
     PASS. `check-kvm.sh` finds `~/Android/Sdk` by itself: PASS. RAM budget "4.0 of 11.6 GB": PASS.
   - `tapdance connect` on the VPS 1.3 s; `doctor` all passed, healthz 17–92 ms. Quick lease: Ready 4.18 s,
     inspect 2.43 s, release 1.12 s.
   - Minor: the VM's `doctor` names the token "agent-device on this Mac" on a Linux host (comment on #78).
- **Item 2, #79: lease → release → lease again, then after a fresh boot** — PASS. Five commands after each
   lease: `ui inspect`, `screenshot`, `app launch com.android.settings`, `ui tap --text "Network & internet"`,
   `ui key back`. No "System UI isn't responding" dialog in any screenshot or `dumpsys window`. Commands
   took 2–10.3 s, never minutes. See the busy-phase table below. Caveats filed as #101 (settle ended on
   one calm read while the guest stayed at 91–96 %), #102 (the first inspect on every warm lease hit
   `INSTRUMENTATION_FAILED` once, hidden by the #99 retry) and #103 (the baseline settle logged nothing
   when it succeeded).

   | Lease | Lease | inspect | screenshot | launch | tap | back |
   | --- | --- | --- | --- | --- | --- | --- |
   | A1 idle spare | 4.20 s | 3.71 | 1.98 | 6.46 | 5.86 | 2.88 |
   | A2 6 s after release | 6.13 s (settle line, guest CPU 70 %) | 5.06 | 3.00 | 9.66 | 8.86 | 4.39 |
   | A3 6 s after release | 4.56 s | 4.36 | 2.67 | 9.23 | 8.89 | 4.18 |
   | B1 new qemu after `worker restart` | 52.89 s (queued, 3 settle lines) | 2.62 | 2.21 | 7.71 | 10.29 | 4.17 |
   | A4 43 s after release | 13.26 s (1 settle line, guest CPU 96 %) | 4.76 | 2.37 | 7.20 | 9.67 | 3.33 |

   `tapdance worker restart` (6.3 s) kept the learned warm spare (#91): PASS.
- **Item 4, full CLI and MCP checklists** — PASS, with one intermittent Tapdance failure (#107).

   | Run | Result | Wall |
   | --- | --- | --- |
   | `cli-checklist.sh base --param LAUNCHER_TAP=Chrome` | PASS 25/25 | 3 min 2 s |
   | `mcp-checklist.mjs mcp-base.json --param LAUNCHER_TAP=Chrome` | PASS 24/24 | 2 min 50 s |
   | `cli-checklist.sh app` | 26/28 | 2 min 49 s |
   | `mcp-checklist.mjs mcp-app.json` | 25/29 | 1 min 33 s |
   | `cli-checklist.sh build` (default task) | PASS 5/5 | 2 min 9 s |
   | `mcp-checklist.mjs mcp-build.json` | PASS 6/6 | 1 min 4 s |

   App-suite failures: `install_apk` (test setup: the APK on the VPS came from a newer CI run with
   another debug key, so `INSTALL_FAILED_UPDATE_INCOMPATIBLE`; the refusal still says `<appId>`, #109);
   `type_into_field` / `check_typed` (kit parameter: the "Your code" field is not on Pianolune's first
   screen; the miss reply listed `"Let me try"`, the #99 behaviour); MCP `launch_after_clear`
   `DEVICE_ERROR` although the app launched (#107, seen twice in four by-hand MCP cycles too).
   By hand, CLI and MCP on one lease: install by upload, install `--from-ci` (reply names
   `appId: com.measify.pianolune` and `versionCode: 3`), build from git with `gh` (`reused` flag and
   `launch` in the MCP reply, #88), launch, inspect, tap/type with and without a target (#72), swipe until
   text, timed tap sequence (9/9), rotate, screenshots, recording, logs `--contains`/`--level`, crash logs,
   links, audit, notifications, files push/pull, kill/clear, request-human (hand back, cancel, timeout),
   release: PASS. Exceptions: `--level fault` / `error` also match the word "default" (#106); the CLI and
   MCP get different build keys for one commit, so the MCP rebuilds (#104); hints pass through
   agent-device commands (#108). Gradle and Kotlin daemons were gone 10.3 min and 10.5 min after the last
   build, memory back to 5.2–5.5 GB used (#90): PASS.
- **Item 5, new behaviour** — PASS, ANR naming not exercised. A tap or type on a missing target returns
   `ELEMENT_NOT_FOUND` with `On screen: …` and `details.visible`. Inspect right after a fresh lease
   succeeded every time (2.2–5.4 s), with no uiautomator fallback. Lease progress lines appear for warm
   and cold leases (spare state, queue position, Granted, settle lines with guest CPU). Host warm
   default kept across a worker restart. No ANR appeared, so naming one (#80) was not tested.
- **Item 6, latencies** — PASS (measured); see the latency table below.
- **Item 3, #94: VM stop and start** — PASS. Two cycles, `gcloud compute instances stop`/`start`. `doctor` showed
   "0/1 running, 0 warm" (not the dead emulator); no `DEVICE_UNAVAILABLE` or "No Android device with
   serial" in CLI output, doctor polls or 300 worker log lines. See the restart table below.

### Part 2: `4bfa377`, PR #105 (same VM, 21:40–22:21)

Asked by the owner after part 1: rerun the #79 part with #105, with a model the host had never used.
This ran on **the same VM** as part 1 (already set up, with the Play image, a learned warm spare and a
warm page cache), not on a fresh VM.

- **Item 2b, update and host-setup rerun** — PASS, with #110 and #112. VPS and VM updated with `git pull --ff-only`,
   `pnpm install`, `pnpm build` (11 s on the VM). `host-setup.sh --label vps-n2c --with-gh --sdk-packages "cmake;3.31.6" --idle-stop off`:
   110 s, exit 0, listed only `system-images;android-34;google_apis;x86_64`. The emulator libraries were
   already installed, so #100's fix could not be checked. `host up` left the worker as it was, kept the
   pairing, and passed the self-test on the old Play spare. Problems: `host up` and `worker restart` kept
   running the old patched Simlock; only `tapdance worker install --service` loaded the new one (#110),
   and it dropped the learned warm spare. Leases without a tag still got the Play image (#112).
- **Item 2b, new baseline and a never-used model** — PASS for the log line; no baseline settled. Pixel 9 / 35
   (`--image-tag google_apis`) and Pixel 8 / 34 `google_apis` each got a cold boot and a new baseline
   (with a device limit of 1, Simlock deletes the other AVD). Both times the baseline gave up at the bound:
   `Android guest still busy; capturing the clean baseline anyway {… "busy": 0.9563, "dexopt": "timeout",
   "dexoptMs": 90011, "reason": "bound", "settled": false, "waitedMs": 120042}` (Pixel 9 / 35; Pixel 8 / 34:
   busy 0.9510, dexoptMs 90009, waitedMs 120048). The #103 line is logged,
   but `tapdance worker logs` (last 100 lines) no longer shows it after one lease (#111).
- **Item 2b, #79 again** — PASS. No ANR dialog in seven leases. The settle now holds the lease until the guest is
   calm ("Settled", 2–4 %) or falling ("Handing the device out while its load falls", with a warning).
   The `INSTRUMENTATION_FAILED` from #102 now happens inside the lease's warm-up, before Ready; first
   inspect on a warm lease 1.57–1.74 s.

   | Lease | Lease | End of settle | inspect | screenshot | launch | tap | back |
   | --- | --- | --- | --- | --- | --- | --- | --- |
   | A0 default, old Play spare | 65.35 s | Settled (3 %) at 43 s | 1.59 | 1.93 | 7.47 | 6.06 | 3.33 |
   | B Pixel 9 / 35, never used | 269.12 s | falling, 31 % at 28 s | 2.50 | 2.47 | 8.73 | 6.47 | 3.71 |
   | C0 Pixel 8 / 34 `google_apis`, cold | 347.54 s | falling, 37 % at 76 s | 1.57 | 2.06 | 5.91 | 6.59 | 2.79 |
   | A1 right after C0 release | 77.86 s | falling, 18 % at 71 s | 1.74 | 1.91 | 6.54 | 5.67 | 3.00 |
   | A2 right after A1 release | 92.75 s | Settled (4 %) at 80 s | 1.73 | 1.97 | 5.94 | 6.26 | 2.85 |
   | A3 right after A2 release | 75.94 s | Settled (2 %) at 64 s | 1.59 | 1.90 | 8.08 | 5.89 | 2.75 |
   | A4 idle spare, 4 min after A3 | 9.96 s | no settle needed | 1.62 | 1.93 | 5.59 | 6.51 | 2.99 |

   Answer to the owner's question: the plain image plus dexopt does not shorten the busy phase on N2.
   dexopt times out at 90 s, the baseline is still saved at about 95 % busy, and each restore replays
   about 60–90 s of busy guest. The time moved into the lease instead of the first commands.

## #79 / #101: busy phase, `c92fbed` against `4bfa377`

Busy = qemu above 50 % of one core on two reads in a row (5–10 s samples on the VM).

| Metric | `c92fbed` (Play image, no dexopt) | `4bfa377` (`google_apis`, dexopt) |
| --- | --- | --- |
| Lease right after a release | 4.6–13.3 s; guest handed out at 91–96 % with no "still busy" notice | 75.9–92.8 s; held until Settled (2–4 %) or falling (18 %) |
| Lease from an idle spare | 4.20 s | 9.96 s |
| Cold lease (new device and baseline) | 232 s (self-test); 52.9 s on a new qemu with an existing baseline | 269 s (Pixel 9 / 35), 347.5 s (Pixel 8 / 34) |
| Guest busy after a release | 65–85 s, 145 s | 61–90 s |
| Guest busy after a cold or fresh boot | about 310 s | about 355 s (incl. the 120 s baseline wait) |
| Baseline settle | no line logged (nothing logged on success then) | gave up at 120 s both times, dexopt timeout 90 s |
| First inspect after a warm lease | 3.71–5.06 s (hidden `INSTRUMENTATION_FAILED`) | 1.57–1.74 s |
| First commands (launch, tap, back) | 2–10.3 s | 2.75–8.73 s |
| ANR dialogs | 0 | 0 |

## VM restart (#94, `c92fbed`)

Seconds from `gcloud compute instances start`. A: lease after `doctor` passes. B: lease right after healthz.

| Step | A | B | Last run (round 2) |
| --- | --- | --- | --- |
| `stop` → `TERMINATED` | 59.3 | 53.2 | about 54 |
| `RUNNING` | 16.7 | 13.8 | 10.1 |
| `/v1/healthz` 200 | 44.2 | 43.7 | 36.4 |
| `doctor` passes | 51.5 | not run | 47.0 |
| Lease Ready | 117.1 (lease 65.6) | 100.2 (lease 56.4) | 210.9, after one `DEVICE_UNAVAILABLE` failure |
| First inspect / screenshot / release | 2.94 / 2.36 / 1.99 | 3.55 / 2.73 / 1.56 | — |

Start → Ready is 94–111 s faster than last run. The settle wait (#79) is now the largest part of the
lease (35–45 s).

## Checklist by interface (part 1)

| Item | CLI | MCP |
| --- | --- | --- |
| Lease, status, release; lease progress lines | PASS | PASS |
| Install by upload (77 MB) | PASS ×5 | PASS ×5 |
| Install from CI: names `appId` and `versionCode` (#89); cached; with launch | PASS | PASS (`launched`, `next: inspect_screen`) |
| Upload install refused (other signing key) | hint says `<appId>` (#109) | same |
| Build from git with `gh`, reuse, default task | PASS | PASS (`reused`, `launch`, #88); not reused after a CLI build (#104) |
| Gradle daemons gone after about 10 min idle (#90) | PASS | — |
| Launch, inspect, screenshot | PASS | PASS |
| Tap/type on a missing target lists the screen (`details.visible`) | PASS | PASS |
| Type into a named field; without a target, field focused | PASS | PASS |
| Type without a target, no field focused (#72) | PASS (`ELEMENT_NOT_FOUND`) | PASS |
| Swipe; swipe until text (both ways, not found) | PASS | PASS |
| Timed tap sequence, 9 notes at 700 ms | PASS 9/9 | PASS 9/9 |
| Rotate, recording, screenshots | PASS | PASS |
| Logs `--contains`, `-n`, cap 20000 | PASS | PASS |
| Logs `--level error` / `fault` | FAIL: matches "default" (#106) | same |
| Crash logs | PASS | PASS |
| Links, audit, notifications post and list | PASS | PASS |
| Files: Downloads; app sandbox push and pull | PASS | PASS |
| Kill, clear, relaunch | PASS | FAIL 2 of 5: launch right after clear (#107) |
| Request a human: hand back, cancel, timeout | PASS | PASS |
| ANR named by inspect, launch or a failed tap (#80) | not exercised | not exercised |

## Latency: this run against the last run

Settled numbers (more than 3 min after the lease), medians, part 1.

| What | This run CLI | This run MCP | Last run |
| --- | --- | --- | --- |
| Tap by text that changes the screen | 1.95 s (1.65–2.41, n 12) | 1.66 s (1.55–1.91, n 6) | CLI 2.0 s; MCP 1.9 s |
| Key back | 1.89 s (1.51–1.96) | 1.42 s (1.11–1.43) | CLI 1.2 s; MCP 1.6–2.1 s |
| Inspect | 0.56 s (0.52–0.62) | 0.08 s | CLI 0.50–0.61 s; MCP 0.09–0.14 s |
| Screenshot | 0.81 s (0.79–0.86) | 0.35 s (0.34–0.37) | CLI 0.9–2.2 s; MCP 0.4–0.85 s |
| Install, 77 MB upload | 4.14 s (n 5) | 3.92 s (n 5) | CLI 9.2–11.7 s; MCP 7.7–8.4 s |
| Install from CI, first | 10.78 s | — | CLI 11.4 s; MCP 10.8 s |
| Install from CI, cached | 4.46 s (n 5) | 2.43 s (n 7) | CLI 3.7 s; MCP 2.4 s |
| Build from git, first / reused | 613 s / 2.7–11.4 s | reused 2.2–11.3 s | 789 s / 2.6–16.6 s |
| Timed taps, largest start drift | 210.6 ms | 163.8 ms | 188–378 ms |
| Warm lease | 3.9 s (no settle) / 33.0 s (settle) | — | 5.0–8.1 s |
| Cold lease (kit) | 56–67 s | 30–56 s | 22.3–38.4 s |

Interaction latencies are the same as last run within noise; uploads are about twice as fast. Cold
leases are slower because the #79 settle wait adds 15–35 s by design. The first minute after a fresh
boot is still slow (swipes 10–13 s, rotate 17 s, file push 22–24 s in both base suites).

## Cost

Estimates from Google's published `europe-west1` rates, not a billing export.

| Run | VM time | Cost |
| --- | --- | --- |
| 2c (2026-11-04) | from 20:03 | see teardown |

## Results by requirement

| ID | Result | Note |
| --- | --- | --- |
| Q-05 | PASS | Repeated on a new VM with Simlock 0.5.0 and Tapdance's patch: provision, KVM, emulator, upload and CI install, build from git, launch, screenshot, release through the guard from a Linux VPS. |
| W-07 | PASS (Linux) | `host-setup.sh --with-gh --sdk-packages` on a fresh N2 VM installs `gh` and `cmake`, turns off Android CLI metrics, puts the tools on PATH for non-interactive ssh. Rerun on a set-up host: 110 s. |
| D-01 | PASS | Linux KVM emulators: Play and `google_apis` images, Android 34 and 35, Pixel 8 and Pixel 9. |
| F-05 | PASS | From-CI install names the package and version code; CLI and MCP, cached and uncached. |
| H-08 | PASS (Android) | Build from git with `gh`, CLI and MCP, reuse and launch in the reply; CLI/MCP reuse gap #104. |

## Artifacts

None committed. Logs, checklist output, `timings.csv`, CPU and memory polls and screenshots are kept
locally on the VPS in the run's scratch folder. Terraform state and `terraform.tfvars` were not committed.

## Re-run

As in the [last run](2026-11-03-vps-n2-android.md#re-run), with the setup line:

```bash
curl -fsSL https://raw.githubusercontent.com/mirzemehdi/tapdance/main/scripts/host-setup.sh | bash -s -- --label <label> --with-gh --sdk-packages "cmake;3.31.6"
```

## Not covered

- ANR naming (#80): no ANR appeared, and there was no safe way to cause one without changing the app.
- #100's fix on a fresh machine: in part 2 the emulator libraries were already installed.
- The baseline's "settled" path: in part 2 both baselines gave up at 120 s with dexopt timed out at 90 s.
- Part 2 on a fresh VM: it ran on the part 1 VM.
- Git sign-in failures (#85) and repo key removal (#87).
- The viewer, the deploy-key build route, iOS, the gateway path.
- Teardown and the final cost: recorded after this write-up.

## Issues

Filed in this run:

- #100 `host-setup.sh` installs the emulator's system libraries with `sudo` without listing them (closed by the owner)
- #101 Lease settle ends on one calm read while the guest is still busy; 90 s / 120 s bounds shorter than the busy phase on N2 (commented with part 2 results)
- #102 First `ui inspect` after every warm-spare lease fails once with `INSTRUMENTATION_FAILED` (closed by the owner; fix holds in part 2)
- #103 Baseline settle logs nothing when it succeeds (closed by the owner; line logged in part 2)
- #104 Build reuse misses between CLI and MCP (configuration "Debug" in the CLI key)
- #106 `logs --level fault` / `error` match the word "default"
- #107 `launch_app` right after `clear_app_data` intermittently fails although the app launched
- #108 Hints pass through agent-device commands the reader cannot run
- #109 Upload install refusal still says `<appId>` (#89 follow-up)
- #110 After an update, the worker keeps running the old patched Simlock
- #111 `tapdance worker logs` shows only the last 100 lines, so the baseline line is not found after a lease
- #112 Leases on a host with both images: no tag gets the Play image, `--image-tag` alone picks API 35, "warm spare is ready" for another kind

Comments: #78 (`doctor` says "agent-device on this Mac" on Linux), #79 (part 1 PASS with caveats),
#101 (part 2 results). Not reopened: #72, #82, #86, #88, #89, #90, #91, #94.
