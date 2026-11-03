# Evidence: Android on a Google Cloud N2 VM, driven from a Mac — 2026-11-03

Real VM, real emulator, no mocks. Two machines: the owner's Mac as the agent's machine and an
`n2-standard-4` VM in the owner's Google Cloud project as the device host, linked over Tailscale in
device-only mode (`host up` on the VM, `connect` on the Mac). Run by the maintainers. Result: setup,
CLI, MCP, viewer, installs from CI, idle stop and VM restart passed after 16 code fixes made during
the run; a build on the host of the test app's private repository succeeded once the app's CMake was
installed on the VM.

## Environment

| Item | Value |
| --- | --- |
| Agent's machine | Owner's Mac (MacBookPro18,3), macOS 26.5. Tapdance from branch `phase2-gcp-n2` (worktree; the fixes below landed on it during the day, branch head at write-up `ce437f1`). Scratch `TAPDANCE_HOME`; sessions `n2-field-cli` and `n2-field-mcp`. The owner's `~/.tapdance` was not touched. |
| Device host | Google Cloud `n2-standard-4` (4 vCPU, 16 GB), zone `europe-west1-b`, Ubuntu 24.04 (kernel 7.0.0-1014-gcp), 64 GB `pd-balanced`, nested virtualization on, ephemeral external IP for outbound traffic, inbound SSH from IAP only. Logged in as a Google Cloud OS Login account. |
| Terraform | 1.17.1, `infrastructure/terraform/google-cloud-n2`: `terraform validate` passed; `apply` created 13 resources, with `max_run_hours = 8` (`scheduling.max_run_duration` 28,800 s, termination action STOP). |
| Installed by `scripts/host-setup.sh` | Node.js 22, Temurin 17, Android command-line tools, platform-tools, emulator 37.2.13, system image `android-34;google_apis_playstore;x86_64`, Tailscale; Tapdance cloned and built on the VM. Exact Node.js patch version not recorded. |
| Simlock, agent-device | 0.4.0, 0.21.35 |
| Emulator mode | Headless (`-no-window`). GPU `auto` (software rendering: the VM has no GPU) for most of the run; `swiftshader_indirect` for the GPU comparison at the end (step 15) |
| Network | Tailscale with HTTPS Certificates; guard endpoint `https://tapdance-n2.<tailnet>.ts.net:4720` |
| Billing guard rails | Terraform run-time cap (8 h); a USD 5 alert budget on the project (alerts only) |
| Test apps | The Pixel launcher and system apps; Pianolune (the owner's app, a debug build of about 77 MB) |

## What ran

Times are UTC.

1. **Terraform** — PASS. `apply` started 16:19:52 and finished 16:21:31 (99 s). The startup script
   (KVM packages, `/dev/kvm` rule) was done at 16:22:01.
2. **`scripts/host-setup.sh`, first runs** — FAIL, then fixed. The first run installed Node.js 22,
   Temurin 17, the command-line tools, platform-tools, emulator, system image and Tailscale (login
   link), cloned and built Tapdance, and failed at `host up` step 3 (worker): systemd user services
   over a non-interactive SSH session answered "Failed to connect to bus: No medium found". Fixes 1–5
   below came from these setup runs.
3. **`scripts/host-setup.sh`, fourth run** — PASS. 16:49:35 → 16:52:19 = **2 min 44 s**, including the
   emulator's system libraries from apt, `host up`, the first cold emulator boot and the self-test
   (PASS). It ended with the `TAPDANCE HOST READY` block.
4. **`tapdance connect` on the Mac** — PASS. `/v1/healthz` answered in 42 ms. `doctor` passed once a
   Linux worker's iOS capacity was reported as skipped ("needs a Mac") instead of failing (fix 8).
5. **CLI checklist, launcher** — PASS: `device lease`, `ui inspect`, `ui swipe`, `ui key`, `ui tap`,
   `ui wait`, back, `device orientation` (rotation), `device notifications list`, `logs`, `ui audit`,
   `device links`, `screenshot`, `record start/stop`.
6. **CLI checklist, Pianolune** — PASS: `app install` (upload from the Mac), `app install --from-ci`,
   `app launch`, `ui inspect`, `ui tap --text`, back, `ui type --text` with `ü`, `ui swipe --until` (labels
   with accents), `ui sequence` 9/9, `screenshot`, `record`, `logs --app`, `logs --crash`,
   `device push` to the app sandbox and `device pull` (content matched), `device push` to Downloads,
   `ui audit`, `app list`, `app uninstall`.
7. **MCP checklist, base** — PASS, 23/23: `lease_device`, `get_device_status`, `press_key`,
   `inspect_screen`, `take_screenshot`, `swipe`, `tap`, `wait_for`, back, rotate, `start_recording` /
   `stop_recording`, `push_file`, `notifications` post and list, `get_logs`, audit, `opened_links`,
   `get_test_artifacts`.
8. **MCP checklist, in the app** — PASS: `install_app` with `from_ci`, `launch_app`, `inspect_screen`,
   taps, `tap_sequence` 9/9, `take_screenshot`, recording, `get_logs` for the app, `get_crash_logs`,
   `push_file` to the app sandbox and `pull_file`, notifications, rotate, audit, `opened_links`,
   `kill_app`, `clear_app_data`, `type_text` with `into_text` (`ü`), `swipe`, `release_device`. The only
   failures were steps where the test script guessed the app's onboarding order wrongly, not Tapdance.
   The MCP client was a script over stdio, not a coding agent.
9. **Browser viewer** — PASS. `tapdance view` on the Mac streamed the N2 emulator live in a browser.
   When the owner took over, the agent's next action got `HUMAN_HELD`, as designed.
10. **Install from CI** — PASS on the CLI (`app install --from-ci`) and MCP (`install_app` `from_ci`): the
    VM downloaded the GitHub Actions artifact with its own `gh` login and installed the APK. Along the
    way: GitHub answered 404 while the host's fine-grained token named a different repository of the
    same app than the one whose CI made the artifact (fix 16); and an install over a build signed with
    another debug key (CI runners make a new debug key per run) was refused with
    `INSTALL_FAILED_UPDATE_INCOMPATIBLE` (fix 14).
11. **Build on the host, first attempt** — FAIL (the app's requirement, not Tapdance). The host's `gh`
    was logged in with a fine-grained, read-only token owned by the app's organization (the app's
    repository, *Contents* and *Actions* read). The clone over `https://` worked, the `Documentation`
    submodule from another organization was skipped with a warning, and Gradle ran for 8 min 43 s
    (including dependency downloads) and failed because the app's `:audioengine` module needs CMake
    3.31.6; Tapdance's hint named the `sdkmanager` command that installs it. The per-repository deploy
    key route was BLOCKED: GitHub answered "Deploy keys are disabled for this repository" (an
    organization setting).
12. **Build on the host, after installing CMake** — PASS. The owner ran `sdkmanager "cmake;3.31.6"` on
    the VM (6 s). Then, from the Mac:
    `tapdance app build --git https://github.com/<org>/Pianolune-All --ref main --dir MobileApp --launch com.measify.pianolune`
    built `main` at `4ac08b4`: Gradle `BUILD SUCCESSFUL` in 2 min 40 s. The install was refused with
    `INSTALL_FAILED_UPDATE_INCOMPATIBLE`: the CI-signed build was installed, and the host signs with its
    own debug key (fix 18). After `tapdance app uninstall com.measify.pianolune`, the same command reused
    the kept build ("Reused the earlier build … in 1 s and installed it; launched"): 11 s end to end.
    Over MCP, with reuse, 5/5 passed: `lease_device`, `build_app` (15 s, sha `4ac08b4`, installed),
    `launch_app`, `inspect_screen`, `release_device`.
13. **Idle stop** — PASS. The CLI keepalive released the last lease about 17:50, 30 min after its last
    use. The guard reported 25 min idle at 18:13 and 28 min at 18:17; the VM powered itself off at
    18:20:10 (state `TERMINATED`), and compute billing stopped.
14. **VM restart** — PASS. `gcloud compute instances start` at 18:21:06: `RUNNING` after 12 s, the guard
    answered over Tailscale after 48 s, `doctor` on the Mac passed after **54 s**. The worker, the guard
    and `tailscale serve` came back without anyone logging in (`tapdance-user-manager.service`); the
    endpoint and token on the Mac kept working. The first lease after the restart was a cold boot
    (154 s).
15. **GPU mode comparison** — PASS. The same 6 tab-switch taps in Pianolune from the Mac CLI, first
    with the emulator's `-gpu auto` (the old default), then with
    `tapdance simlock -- --local config set android.emulator.gpu swiftshader_indirect` and
    `tapdance worker restart` (no lease running). The first lease after the restart was a cold boot
    (206 s). Numbers in the measurements below. `worker install` and `host up` now set
    `android.emulator.gpu=swiftshader_indirect` together with headless on Linux without `DISPLAY` or
    `WAYLAND_DISPLAY` (fix 17).
16. **End of the run** — the VM was stopped at about 20:10. Its disk then held 19 GB of 61 GB.

## Measurements

| What | Value |
| --- | --- |
| `terraform apply` | 99 s, 13 resources |
| `host-setup.sh` (fourth run, incl. first cold boot and self-test) | 2 min 44 s |
| VM start → `doctor` passes on the Mac | 54 s (RUNNING 12 s, guard answers 48 s) |
| Warm lease | CLI 2.4–5 s; MCP 3.8–34 s (34 s when the spare had to boot) |
| Cold lease (first after a VM restart) | 154 s |
| Cold lease (first after `worker restart` with `swiftshader_indirect`) | 206 s |
| Key press | CLI 0.75–0.8 s (process start and TLS); MCP 0.1–0.2 s |
| Tap by text in the app | CLI 2.6–4 s (outliers 9–20 s when a sheet or the app opened); MCP 2–14 s |
| `inspect` | 0.8–2.6 s typical (MCP up to 15 s under load) |
| Screenshot | 1.2–2.9 s |
| Recording | start about 1 s, stop 2.5–3.8 s |
| Launcher rotation | 50 s before fix 9, 17 s after |
| Install, 77 MB APK uploaded from the Mac | 149 s |
| Install from CI on the host | first download about 8 s plus the install; cached 7–12 s |
| The same artifact downloaded on the Mac (`gh run download`) | 40 s |
| Timed taps (`ui sequence`, 9 notes at 700 ms) | 9/9, max start drift 124–181 ms |
| Emulator memory | about 3.7–4.2 GB RSS; the VM used 4.6 GB of 16 GB with one emulator |
| Emulator CPU at idle | `-gpu auto`: 136–165 % (of 400 %), load average 5–6 on 4 vCPU. `swiftshader_indirect`: about 0 % |
| 6 tab-switch taps in Pianolune, Mac CLI | `-gpu auto`: 3.4–7.9 s (median about 4.3 s). `swiftshader_indirect`: 2.2–2.6 s (median about 2.3 s) |
| Key presses in the same comparison | about 0.6–0.8 s in both modes |
| Gradle build on the host | first 8 min 43 s with dependency downloads, failed on CMake; second `BUILD SUCCESSFUL` in 2 min 40 s |
| `sdkmanager "cmake;3.31.6"` on the host | 6 s |
| Build reused from the host's cache, CLI (uninstall, then build, install, launch) | 11 s end to end ("in 1 s" for the reuse) |
| MCP `build_app` with reuse | 15 s |
| Disk used at the end | 19 GB of 61 GB |
| Idle stop | VM off 30 min after the last lease ended (lease released about 17:50, off 18:20:10) |
| Cost | The VM ran 16:21–18:20 and 18:21–about 20:10, about 3 h 50 min in all. On-demand `n2-standard-4` in `europe-west1` is about USD 0.21 an hour (estimate from published rates, not a billing export). |

Taps that change the screen are slower than key presses on this VM: nested virtualization and software
rendering. With `-gpu auto` a tap that opened a screen took 3–20 s across the checklists (key presses
0.1–0.8 s) and the idle emulator kept 1.4–1.7 vCPU busy. `swiftshader_indirect` brought the measured
tab-switch taps to 2.2–2.6 s and idle CPU to about 0 %. The checklist numbers above (taps, inspect,
leases) were taken with `-gpu auto`. Larger machine types have not been compared.

## Fixes found by running

1. **systemd user services over non-interactive SSH** had no user manager or `XDG_RUNTIME_DIR` ("Failed
   to connect to bus: No medium found"). `host up` now turns on linger, waits for
   `/run/user/<uid>/bus` and sets `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS`.
2. **OS Login accounts cannot linger:** `loginctl enable-linger` failed ("No such file or directory"),
   also with sudo. `host-setup.sh` installs `tapdance-user-manager.service`, which starts the user
   manager at boot; `host up` starts it with `sudo -n`.
3. **Emulator libraries missing on the Ubuntu cloud image** (`libpulse0 libxkbfile1 libxi6 libsm6
   libice6`). New host check `host.kvm.emulator-libs` (runs `emulator -version`); `host-setup.sh`
   installs them.
4. **`host-setup.sh` hid that check:** `pipefail` with `grep -q` swallowed the output. It now captures
   the output first.
5. **`host-setup.sh` terminal detection:** `[[ -r /dev/tty ]]` was true without a controlling terminal;
   it now opens `/dev/tty`. Piped through `curl`, `host up` gets the terminal (`< /dev/tty`), so the
   pairing can be approved.
6. **Restarting the guard over SSH** (after `host builds` or `host artifacts enable`) failed silently. It
   sets up the bus first and warns when the restart fails.
7. **`host status` over SSH** said "Failed to connect to bus"; it uses the user manager's bus now.
8. **iOS reported as a failure on a Linux worker** (`doctor` exit 10); now skipped with "needs a Mac".
9. **Rotation with the launcher in front** made three confirmation attempts (50 s); now one (17 s).
10. **First inspect after a fresh lease** failed (`INSTRUMENTATION_FAILED`, agent-device's snapshot
    helper); now one retry after 1.5 s.
11. **`host builds enable`** reset `--git-auth` and `--timeout-minutes`; it now keeps earlier values.
12. **The build JDK check ignored `JAVA_HOME`,** and `~/.tapdance/env.sh` did not put the JDK on `PATH`.
13. **The MCP outside-the-project hint** named only `install_app`; it covers `push_file` too.
14. **Android install refusals** (`INSTALL_FAILED_UPDATE_INCOMPATIBLE` from a different signing key,
    `INSTALL_FAILED_VERSION_DOWNGRADE`, `INSTALL_FAILED_INSUFFICIENT_STORAGE`) now come with a hint.
15. **gcloud quota project** (docs only): the owner's gcloud had `billing/quota_project` set to another
    project, so OS Login answered that its API was not used in that project. Pass
    `--billing-project=<PROJECT_ID>`.
16. **Private repositories on GitHub** (docs only): the app's organization had deploy keys turned off;
    a fine-grained token works for both builds and CI artifacts, and it must select the repository whose
    CI made the artifact (otherwise GitHub answers 404).
17. **Slow taps and a busy idle emulator** with `-gpu auto` on a VM without a GPU. `worker install` and
    `host up` set `android.emulator.gpu=swiftshader_indirect` with headless on Linux without a display.
18. **A host build refused for another signing key** gave no hint; the build route now carries the same
    uninstall hint as uploads and installs from CI.

Fixes 1–5 were checked by the fourth setup run, fix 2 also by the VM restart, fix 8 by `doctor` and
fix 9 by the 17 s rotation, fix 17's setting by the GPU comparison (set by hand with `tapdance
simlock`; the new `host up` default itself is unit-tested). Fixes 6, 7 and 10–13 were not re-run on the
VM after the change; fixes 14 and 18 are unit-tested or build-only.

## What failed and why

| What | Why | State |
| --- | --- | --- |
| `host up` step 3 on the first setup run | No systemd user manager bus in a non-interactive SSH session; an OS Login account cannot linger | Fixed (1, 2) |
| The emulator would not start | Ubuntu's cloud image lacks the emulator's audio and X libraries | Fixed (3, 4) |
| Pairing could not be approved through `curl \| bash` | Terminal detection | Fixed (5) |
| `doctor` exit 10 on the Mac | iOS counted as missing on a Linux host | Fixed (8) |
| `gcloud compute ssh` failed with an OS Login API error naming another project | gcloud's `billing/quota_project` setting | Docs (15) |
| Deploy key refused by GitHub | Deploy keys disabled by the organization | Docs (16); token route used |
| 404 from GitHub for a CI artifact | The fine-grained token selected another repository | Docs (16) |
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | A CI build signed with a new debug key over an app signed with another | Hint (14) |
| Host build of the test app, first attempt | The app needs CMake 3.31.6 on the host | Not Tapdance; built after `sdkmanager "cmake;3.31.6"` |
| A host build's install refused with `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | The CI-signed build was installed; the host signs with its own debug key | Hint (18); `app uninstall`, then the build reinstalled from cache |
| `ui type` without a target reported "Typed N chars" with no field focused | Nothing was typed | Not fixed; to file |
| `ui inspect`'s header named the session's app while the launcher was in front | Header wording | Not fixed; to file |
| Taps that change screens took 3–20 s; the idle emulator used 136–165 % CPU | Nested virtualization and `-gpu auto` without a GPU | Fixed (17): `swiftshader_indirect`, taps 2.2–2.6 s, idle about 0 %; larger machine types not compared |

## Results by requirement

| ID | Result | Note |
| --- | --- | --- |
| G-01 | PASS | N2 VM with nested virtualization from the Terraform module; `terraform destroy` not run. |
| G-02 | PASS | Terraform applied; `scripts/host-setup.sh` set the VM up from nothing. The gateway-join install script was not used. |
| G-03 | PASS | The guide was followed; cost figures stay estimates, with measured run times. |
| Q-05 | PASS | Provision, KVM, emulator boot, APK install, lease, launch, screenshot, release from a separate machine (a Mac, not a Linux VPS). |
| M-03 | PASS | Bring your own cloud on Google Cloud N2, device-only mode. |
| D-01 | PASS | Android emulator on Linux with KVM. |
| D-02 | PARTIAL | KVM checks passed on a real VM; the emulator-library check was added from a real failure. The missing-KVM path was not run. |
| W-07 | PASS (Linux) | `host-setup.sh` and `host up` end to end on a fresh Linux VM, including the system image download; `pause`, `resume`, `down --all` not run there. |
| V-01, V-03 | PASS | Live view on the Mac of the N2 emulator; take-over gave `HUMAN_HELD`. |
| U-10 | PASS | Android app-sandbox push and pull on a debug build. |
| C-04 | PARTIAL | Idle release by the CLI keepalive observed (30 min). |
| New: cost guard (idle stop) | PASS | The VM powered itself off 30 min after the last lease. Uptime cap not exercised. |
| New: install from CI | PASS | CLI and MCP. |
| H-08 (builds on the host) | PASS (Android) | An Android git build of a private repository on the N2 host, CLI and MCP, with reuse. iOS builds not part of this run. |
| New: private repositories | PARTIAL | Fine-grained token: clone and build ran; deploy key route blocked by the organization; build files not exercised. |

## Artifacts

None committed. Screenshots, recordings and logs from the run are kept locally on the owner's Mac in
the scratch `TAPDANCE_HOME`; sizes and hashes were not recorded.

## Re-run

Terraform variables used (in a `terraform.tfvars` that is never committed):

```hcl
project_id         = "<PROJECT_ID>"
region             = "europe-west1"
zone               = "europe-west1-b"
assign_external_ip = true
boot_disk_size_gb  = 64
```

```bash
cd infrastructure/terraform/google-cloud-n2
terraform init && terraform validate
terraform plan -out tapdance.plan && terraform apply tapdance.plan

# add --billing-project=<PROJECT_ID> if gcloud has another quota project set
gcloud compute ssh tapdance-n2 --zone=europe-west1-b --tunnel-through-iap

# on the VM, as your own user
curl -fsSL https://raw.githubusercontent.com/mirzemehdi/tapdance/main/scripts/host-setup.sh | bash -s -- --label <label>
# (before the branch is merged: .../phase2-gcp-n2/scripts/host-setup.sh with TAPDANCE_REF=phase2-gcp-n2 on bash)

# copy ~/.tapdance/worker/pairing-<label>.token to the agent's machine privately, then there:
tapdance connect https://tapdance-n2.<tailnet>.ts.net:4720 < pairing-<label>.token
tapdance doctor
tapdance mcp     # or the MCP setup that connect printed
```

Then the CLI and MCP checklists above, `tapdance view`, `tapdance host artifacts enable --repo
<owner/repo>` on the VM with `tapdance app install --from-ci <owner/repo> --artifact <name>` on the
Mac, and leave the VM idle for 30 minutes to see the idle stop.

## Not covered

- A Spot VM.
- `n2-standard-8` or any other machine type, for comparison.
- GPU modes other than `auto` and `swiftshader_indirect`; the CLI and MCP checklists re-run under
  `swiftshader_indirect` (only the 6-tap comparison ran with it).
- The gateway path (`worker login`, a Simlock gateway on another machine).
- Any pair of machines other than Mac → N2 (for example a Linux VPS as the agent's machine).
- iOS (no Mac host in this run).
- The uptime cap (`--max-uptime`), the Terraform stop schedule, and the budget alert firing.
- `terraform destroy`.
- Build files and the per-repository deploy key on a real repository; an iOS build (no Mac host).
- A coding agent (Claude Code, Codex, Cursor) as the MCP client.
- Google's Android CLI on the VM.

## Issues filed

None yet. To file:

- `ui type` without a target reports "Typed N chars" when no field has focus (nothing was typed).
- `ui inspect`'s header names the session's app while the launcher is in front.
