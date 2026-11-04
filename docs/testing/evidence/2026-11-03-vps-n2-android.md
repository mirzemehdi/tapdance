# Evidence: Android on a Google Cloud N2 VM, driven from a Linux VPS — 2026-11-03

Real VMs, real emulators, no mocks. Two machines: a Linux VPS as the agent's machine and an
`n2-standard-4` VM in Google Cloud as the device host, linked over Tailscale in device-only mode. Run by
a test agent on the VPS with the owner approving each billable step, in two rounds:
2026-11-03 (checklists, viewer) and 2026-11-04 (a fresh VM: cold lease, install from CI, build from
git, idle stop, VM restart). Result: CLI and MCP checklists, installs, builds from git with a token, the
idle stop and a VM restart passed; the deploy-key route was blocked by a GitHub organization setting;
`terraform destroy` and the leftovers check left nothing behind. No code was changed during the run;
the problems found are filed as issues.

## Environment

| Item | Value |
| --- | --- |
| Agent's machine | Linux VPS (x86_64, 8 GB, Ubuntu), Node.js 22.22.2, pnpm through corepack. Tapdance `main` at `9d6d322` (includes `70d5606`). Scratch `TAPDANCE_HOME`; sessions `vps-n2` and `vps-n2-idle`. The owner's `~/.tapdance` was not touched. |
| Device host | Google Cloud `n2-standard-4` (4 vCPU, 16 GB), zone `europe-west1-b`, Ubuntu 24.04.5, 64 GB `pd-balanced`, nested virtualization, ephemeral external IP, inbound SSH from IAP only, OS Login account. One new VM and one new project per round. |
| Terraform | 1.17.1, `infrastructure/terraform/google-cloud-n2` with `max_run_hours = 6`, `on_run_limit = "DELETE"` (ephemeral mode), `budget_amount_usd = 5`. Round 2: `plan` 18 to add, `apply` 101 s. |
| Installed by `scripts/host-setup.sh` | Node.js 22, Temurin 17, command-line tools, platform-tools, emulator 37.2.13, `android-34;google_apis_playstore;x86_64`, Tailscale, Tapdance built on the VM. Installed by hand: `gh` 2.45.0 (apt) and `cmake;3.31.6` (`sdkmanager`), 8 s each. |
| Simlock, agent-device | 0.4.0, 0.21.35 |
| Emulator mode | Headless, `-gpu swiftshader_indirect` (set by `host up`: `simlock config set android.emulator.gpu swiftshader_indirect`) |
| Network | Tailscale with HTTPS certificates; guard endpoint `https://tapdance-n2.<tailnet>.ts.net:4720` |
| Device | Pixel 8, Android 34, `emulator-5586` (the only emulator on the VM) |
| Test apps | The Pixel launcher; Pianolune (the owner's Kotlin Multiplatform app, debug APK of about 77 MB) |

## What ran

Times are UTC. Raw logs, `timings.csv` and the checklist `results.json` files are kept locally on the VPS.

### Round 1 (2026-11-03, VM started 20:55:41, destroyed 01:32–01:34)

1. **Lease is on the N2 VM** — PASS. `device status --json` named the N2 endpoint; on the VM
   `adb -P 5038 devices -l` listed only `emulator-5586` (`sdk_gphone64_x86_64`, x86_64, Android 14,
   API 34) and one `qemu-system-x86_64-headless` process.
2. **Field-test kit, unchanged** (`scripts/field-test/`):

   | Run | Result | Wall |
   | --- | --- | --- |
   | `cli-checklist.sh base --param LAUNCHER_TAP=Chrome` | PASS 25/25 | 2 min 20 s |
   | `mcp-checklist.mjs mcp-base.json --param LAUNCHER_TAP=Chrome` | PASS 24/24 | 2 min 7 s |
   | `cli-checklist.sh app` (APK upload, `TAP_TEXT="Let me try"`, `DEBUGGABLE=1`) | PASS 25/25, 3 skipped (CI, `TYPE_INTO`, `SEQUENCE_FILE`) | 1 min 58 s |
   | `mcp-checklist.mjs mcp-app.json`, same parameters | FAIL 25/26: `tap_text` hit a "System UI isn't responding" dialog right after the lease (#79, #80) | 1 min 50 s |

3. **Extra items by hand** (CLI) and through an MCP stdio client script — see the checklist table below.
4. **Viewer** — PASS. `tapdance view --tailscale` on the VPS: `/` 200, `/api/status` and `/api/frame`
   401 without the key, 200 after `POST /api/login`; `/api/frame` PNG 531 KB (0.87 s first, 0.03 s
   after); `/stream` delivered bytes. `/api/takeover` made the agent's next `ui key` fail with
   `HUMAN_HELD` (exit 11); `/api/handback` let it go on and answered an open request-human. After
   SIGINT, `tailscale serve status` showed no serve config. Checked with curl, not a browser.
5. **Teardown** — PASS. `terraform destroy`: "Destroy complete! Resources: 18 destroyed." (about 2 min,
   VM deleted 01:32:26–01:33:18). `infrastructure/scripts/gcp-leftovers.sh <project>`: exit 0, every
   kind "none"; direct `gcloud` lists and `gcloud storage buckets list` empty; the USD 5 budget gone.
   Then billing unlinked and the project deleted. `gcp-leftovers.sh` run again after the delete: exit 2
   "could not check 4 kind(s)" (#83). `tapdance doctor` afterwards: exit 10, endpoint unreachable.

### Round 2 (2026-11-04, VM started 14:30:54, deleted 16:05:38)

6. **Terraform and host setup** — PASS. `apply` 14:29:33 → 14:31:14 (101 s, 18 resources; startup
   script done about 49 s after start). `host-setup.sh --label vps-n2 --idle-stop off`: prerequisites in
   about 90 s, then it waited about 7 min for the owner's Tailscale login, then built Tapdance and ran
   `host up` (pairing approved at the VM's terminal, self-test PASS); 12 min 12 s in all. `cost_guards`
   output: "deletes the VM and its disk 6 h after each start". The `host up` ready block and
   `host status` showed the `cloud VM:` line. `tapdance connect` on the VPS 5 s, `doctor` all passed.
7. **Cold lease** — PASS. With `host warm android=0,ios=0` on the VM (no qemu running), see timings.
   The warm pool was restored from a copy of `~/.simlock/config.json` afterwards (#91).
8. **Install from CI** — PASS, CLI and MCP. `host artifacts enable --repo <org>/Pianolune-All --branch main`;
   `app install --from-ci` took the newest successful run on `main` by itself. A failed run, a wrong
   artifact name and a missing `--artifact` were refused with exit 2 and a clear fix. Launch verified
   (`ui inspect` showed the app's welcome screen).
9. **Build from git, deploy key** — BLOCKED. `host builds key --repo git@github.com:<org>/Pianolune-All.git`
   made the key (1.0 s); adding it on GitHub answered `HTTP 422 ... Deploy keys are disabled for this
   repository` (organization setting, left unchanged). The build then failed as expected: CLI exit 7
   `DEVICE_ERROR git clone failed (exit 128)`, MCP the same with `Permission denied (publickey)` in
   `details.tail` (#85, #86).
10. **Build from git, `gh` token** — PASS, CLI and MCP. `host builds enable --repo https://github.com/<org>/Pianolune-All --git-auth gh --protected-ref main`
    with a fine-grained read-only token on the VM. `app build --git ... --ref main --dir MobileApp --gradle-task :androidApp:assembleDebug --launch com.measify.pianolune`:
    Gradle `BUILD SUCCESSFUL in 12m 42s` (fresh `~/.gradle`), installed and launched. Later runs reused
    the build. A ref not on `main` was refused: exit 5 `FORBIDDEN ... is not on a protected branch (main)`
    in 1.3 s; a branch that is an ancestor of `main` was allowed. A submodule with an ssh URL was
    skipped with a warning.
11. **Idle stop** — PASS. `host up --label vps-n2 --idle-stop 10`; nothing touched the guard afterwards.
    The guard's `TIMER host-stop` "idle for 10 min (limit 10 min)" ran `sudo -n /usr/bin/systemctl poweroff`,
    and the VM went `TERMINATED`. Without `--label` the same command exits 5 after it has already
    changed the setting (#93). Invalid values (`0.5`, `1441`, `-1`, `abc`) are refused with exit 2.
12. **VM restart** — PASS with one failure. `gcloud compute instances start`; `doctor` passed, but the
    lease right after it failed with `DEVICE_UNAVAILABLE` "No Android device with serial emulator-5586"
    (#94); a lease 20 s later booted a new emulator. The idle stop was turned off again
    (`host up --label vps-n2 --idle-stop off`, 3.9 s) and stayed off after the reboot.
13. **Teardown** — PASS. `gh` logged out on the VM, then `terraform destroy` (18 resources destroyed);
    `gcp-leftovers.sh` exit 0 before the project delete; billing unlinked; project deleted; the `gcloud`
    logins on the VPS revoked.

## Checklist by interface

| Item | CLI | MCP |
| --- | --- | --- |
| Lease, status, release | PASS | PASS (also auto-release when the server exits) |
| Install by upload (77 MB) | PASS ×4 | PASS ×4 |
| Install from CI (cached and uncached, refusals) | PASS | PASS |
| Build from git with a `gh` token, reuse, protected ref | PASS | PASS (no `launch` field, no "reused" in the reply: #88) |
| Build from git with a deploy key | BLOCKED (organization setting) | BLOCKED |
| Launch, inspect, screenshot | PASS | PASS |
| Tap by text, ref, x,y; stale ref refused with a hint | PASS | PASS (text) |
| Type into a named field, `ü` read back | PASS | PASS (false TextView warning: #82) |
| Type without a target, no field focused | FAIL: "Typed 23 chars", exit 0, nothing typed (#72) | FAIL: `ok: true`, nothing typed (#72) |
| Swipe; swipe until text (accents, both ways, not found) | PASS | PASS |
| Timed tap sequence, 9 notes at 700 ms | PASS 9/9 | PASS 9/9 |
| Rotate, recording, logs, app logs, crash logs | PASS | PASS |
| Links, audit, notifications post and list | PASS | PASS |
| Files: Downloads; app sandbox push and pull, content compared | PASS | PASS |
| Kill, clear, relaunch, uninstall, app list | PASS | PASS |
| Inspect names the app in front (#73) | PASS | PASS |
| Request a human: hand back, cancel, timeout | PASS | PASS |
| Cold lease | PASS | not run |
| Viewer: login, frame, stream, take-over → `HUMAN_HELD` | PASS (curl) | — |

## Latency: VPS → N2 compared with Mac → N2

Settled numbers from round 1 (not the first 1–3 min after a lease, see #79). The Mac column is from
the [2026-11-03 Mac run](2026-11-03-gcp-n2-android.md), which used `-gpu auto` for most numbers; this
run used `swiftshader_indirect` throughout.

| What | VPS → N2 | Mac → N2 |
| --- | --- | --- |
| `/v1/healthz` (from `doctor`) | 19–90 ms | 42 ms |
| Tailscale TSMP ping | 14 ms | not measured |
| Warm lease, CLI | 5.0–8.1 s (server side 1.9–2.4 s) | 2.4–5 s |
| Key press | CLI 0.5–3.0 s (median 1.2 s); MCP back key 1.6–2.1 s | CLI 0.75–0.8 s; MCP 0.1–0.2 s |
| Inspect | CLI 0.50–0.61 s; MCP 0.09–0.14 s | 0.8–2.6 s |
| Screenshot | CLI 0.9–2.2 s; MCP 0.4–0.85 s | 1.2–2.9 s |
| Tap by text that changes the screen | CLI 1.7–3.3 s (median 2.0 s); MCP tab taps 1.2–2.8 s (median 1.9 s) | CLI 2.6–4 s (`-gpu auto`); 2.2–2.6 s (`swiftshader_indirect`) |
| Install, 77 MB APK uploaded from the agent's machine | CLI 9.2–11.7 s; MCP 7.7–8.4 s | 149 s |
| Timed taps, largest start drift | 188–378 ms | 124–181 ms |
| Right after a release (guest still booting, #79) | lease 12–19 s, inspect 13–14 s, launch 14–22 s | not seen |

The upload difference is the agent machine's own uplink (a data-centre VPS against a home connection).
Idle qemu on the N2 used about 23 % of a core (RSS 4.2 GB); the Mac run measured about 0 % with
`swiftshader_indirect`.

## Timings (round 2)

| What | Value |
| --- | --- |
| Cold lease, warm pool off, page cache warm | 22.3 s (granted +9.3 s, ready +22.2 s); then inspect 7.2 s |
| Cold lease, page cache dropped (`drop_caches`, close to a VM restart) | 38.4 s (granted +24.6 s); then inspect 13.4 s |
| First lease after `worker restart` (learned spare lost, #91) | 27.5 s |
| First lease after a real VM restart | 141.8 s (server 126 s, a full boot); ready 210.9 s after the start command |
| Mac run for comparison | 154 s after a VM restart; 206 s after a `worker restart` |
| Install from CI, CLI | first 11.4 s (44 MB download + install); cached 3.7 s |
| Install from CI, MCP | cached 2.4 s; uncached download 10.8 s (that install was refused as a downgrade) |
| Build from git, first | 789 s end to end; Gradle 762 s with an empty `~/.gradle` (2.4 GB downloaded) |
| Build from git, reused | CLI `--ref main` 16.6 s, full sha 11.4 s, short sha without launch 2.6 s; MCP 15.9 s |
| Build from git, branch below `main` (new commit) | 112.6 s (Gradle 1 min 47 s) |
| Host during the first build | load peak 9.7 on 4 vCPU, memory peak 12.5 of 16 GB, no swap; screenshots 1.9–2.2 s; daemons kept about 8 GB afterwards (#90) |
| Idle stop, limit 10 min | last activity 15:33:03.6 → poweroff 15:43:40.7 (10 min 37 s, 60 s check) → `TERMINATED` 15:45:18.7: 12 min 15 s in all |
| VM restart (start command at T0) | command returns +9.0 s, `RUNNING` +10.1 s, Tailscale and HTTPS answer +36.4 s, `doctor` passes +47.0 s (Mac run: 54 s) |
| `gcloud compute instances stop` | 54 s to `TERMINATED` |
| `host up --label … --idle-stop 10` / `--idle-stop off --skip-self-test` | 11.0 s with self-test / 3.9 s |

## Cost

Estimates from Google's published `europe-west1` rates (`n2-standard-4` about USD 0.21/h, `pd-balanced`
about USD 0.11/GB-month, external IPv4 about USD 0.005/h), not a billing export.

| Round | VM time | Cost |
| --- | --- | --- |
| 1 (2026-11-03) | 20:55 → 01:33, about 4 h 37 min | about USD 1.04 (VM 0.97, disk 0.05, IP 0.02), plus small egress |
| 2 (2026-11-04) | 14:30 → 16:05 in three running windows (stopped by idle stop at 15:45, then a manual stop and start), about 1 h 33 min running | about USD 0.35 (VM 0.33, disk 0.015, IP 0.008), plus small egress |
| Total | | about USD 1.39 |

These are estimates; the Billing console has the final numbers.

## Results by requirement

| ID | Result | Note |
| --- | --- | --- |
| Q-05 | PASS | Repeated with a Linux VPS as the agent's machine: provision, KVM, emulator, upload and CI install, launch, screenshot, release through the guard. |
| G-01 | PASS | Two VMs created with Terraform and `terraform destroy` run on both: 18 resources destroyed each time, `gcp-leftovers.sh` clean before the project delete, billing unlinked, both projects deleted. |
| G-07 | PARTIAL | Idle stop again (10 min, VM off 12 min 15 s after the last activity). `max_run_hours = 6` with `DELETE` set, not reached. Budget created by Terraform, no alert triggered. Uptime cap not run. |
| G-08 | PARTIAL | `cloud VM:` line seen in `host up` and `host status`; ephemeral mode applied; `gcp-leftovers.sh` exit 0 after destroy (exit 2 after the project delete, #83). The `DELETE` at the cap did not fire. |
| H-08 | PASS (Android) | Build from git with a `gh` token, CLI and MCP, reuse, protected ref refused. Deploy-key route BLOCKED by the organization. |
| F-05 | PASS | CLI and MCP from a VPS agent, cached and uncached. |
| D-01 | PASS | Linux KVM emulator with `swiftshader_indirect` set by `host up` on a fresh VM; both checklists under it. |
| Q-07 | PARTIAL | Viewer served from the VPS over Tailscale, checked with curl (frame, stream, take-over). No browser, no gateway. |
| Q-12 | PARTIAL | The runbook's VPS variant and the `scripts/field-test/` drivers ran for real (base 25/25 and 24/24, app 25/25 and 25/26). Runbook errors filed as #83 and #84. |

## Artifacts

None committed. Logs, checklist output, `timings.csv` and screenshots are kept locally on the VPS in the
run's scratch folder; sizes and hashes were not recorded. Terraform state and `terraform.tfvars` were
not committed.

## Re-run

Follow [field-test-cloud-android.md](../field-test-cloud-android.md), section "Variant: the agent runs
on a Linux VPS", with these variables in a `terraform.tfvars` that is never committed:

```hcl
project_id         = "<PROJECT_ID>"
region             = "europe-west1"
zone               = "europe-west1-b"
assign_external_ip = true
boot_disk_size_gb  = 64
max_run_hours      = 6
on_run_limit       = "DELETE"
budget_amount_usd  = 5
billing_account    = "<BILLING_ACCOUNT>"
```

```bash
# on the VM
curl -fsSL https://raw.githubusercontent.com/mirzemehdi/tapdance/main/scripts/host-setup.sh | bash -s -- --label <label> --idle-stop off
# on the VPS
tapdance connect https://tapdance-n2.<tailnet>.ts.net:4720 < pairing-<label>.token
bash scripts/field-test/cli-checklist.sh base --param LAUNCHER_TAP=Chrome
node scripts/field-test/mcp-checklist.mjs scripts/field-test/checklists/mcp-base.json --param LAUNCHER_TAP=Chrome
# idle stop: on the VM, keep the label
tapdance host up --label <label> --idle-stop 10
# teardown
terraform destroy && bash infrastructure/scripts/gcp-leftovers.sh <PROJECT_ID>
```

## Not covered

- The deploy-key build route: the organization has deploy keys turned off, and the setting was not
  changed. Build files (`host builds` with a build file) were not exercised either.
- Ephemeral mode actually firing: neither VM reached the 6 h `DELETE` cap.
- The uptime cap (`--max-uptime`), the Terraform stop schedule and a budget alert firing.
- A clean warm-lease number from the VPS after the cold-lease test (two test agents shared one session id).
- The cold-lease MCP path, and `tapdance view` in a real browser from the VPS.
- A coding agent as the MCP client (the MCP runs used a script over stdio).
- iOS, the gateway path, a Spot VM and other machine types.
- Teardown revoking the credentials by itself (#76); in this run `gh` on the VM and `gcloud` on the VPS
  were logged out by hand.

## Issues filed

- #72 `ui type` without a target reports success when no field has focus (reopened: still on a real emulator)
- #76 Cloud host teardown should revoke the credentials the run created
- #77 `host-setup.sh` on headless Linux: no metrics opt-out for the new sdkmanager, no gh or cmake, tools not on PATH over non-interactive ssh
- #78 `host up` on headless Linux: clipboard offer, "this Mac", iOS sandbox note, "cannot linger" 3 times
- #79 Lease right after a release gets a guest that is still booting
- #80 A system ANR dialog over the app is not reported by inspect, launch or the failed tap
- #81 `host status` on Linux: "android not available" while an emulator runs, and "? of ? GB budget"
- #82 Small output fixes: false TextView warning, CLI `logs` has no `--contains`, doctor timeout text
- #83 Cloud runbook: emulator process name, `adb -P 5038`, `gcp-leftovers.sh` after the project delete
- #84 `check-kvm.sh` looks in `~/android-sdk` and runs before host-setup; host-setup waits for the Tailscale login
- #85 `app build`: git sign-in failure is `DEVICE_ERROR`, hint ignores the repo key, CLI hides the cause
- #86 `host builds enable` does not check repo access; org-disabled deploy keys and ssh submodules not covered
- #87 Build repo keys: lowercased repo, no way to remove a key or an allowed repo
- #88 MCP `build_app` / `install_app`: no launch option, no "reused" in the reply
- #89 Install results: from-CI install does not name the package; downgrade hint placeholder
- #90 Host builds leave Gradle and Kotlin daemons holding about 8 GB
- #91 Warm pool: `host warm` cannot restore the learned default; a worker restart forgets the learned spare
- #92 Lease prints no boot progress between Granted and Ready
- #93 `host up --idle-stop` without `--label` tries a new pairing and fails after the change was applied
- #94 After a VM start, the first lease fails with `DEVICE_UNAVAILABLE` (stale emulator record)
- #95 Idle stop: guard log lost on the VM, no time left in `host status`, diagnostics refused after a failed lease, restart docs
