# Evidence: iOS on a rented Scaleway Mac mini (M1-M), driven from a Mac — 2026-11-06/07

Stage 3 of [docs/hosting-plan.md](../../hosting-plan.md). A Mac mini rented from Scaleway was made an iOS
host over ssh with nobody at its screen, following [docs/ios/scaleway-mac.md](../../ios/scaleway-mac.md)
as it was rewritten during the run, and the owner's Mac (acting as the agent's machine) drove it over
Tailscale through the CLI and the MCP server (stdio). Every fix below is on branch
`test/scaleway-m1-ios`.

## Environment

| | |
| --- | --- |
| Host | Scaleway Mac mini **M1-M** (`Macmini9,1`, Apple M1, 8 cores, **8 GB**, 256 GB), zone `fr-par-3`, created 2026-11-06 about 14:55 UTC with automatic deletion after 24 h |
| macOS / Xcode | macOS 27.2 (26B123), Xcode 27.0 (27A266a, preinstalled by Scaleway, licence accepted), iOS 27.0 simulator runtime (24A434, arm64) |
| Account | `m1`, administrator (Scaleway's), sudo needs its password; hosted with `--allow-admin-account` |
| Host software | Tapdance from the branch (Node.js 22.23.4, Temurin 17.0.21, Simlock 0.5.0 with Tapdance's patch, agent-device 0.21.35), `tailscaled` 1.104.5 and `gh` 2.103.3 from MacPorts 2.12.7 |
| Agent's machine | The owner's MacBook (macOS 26.5), scratch `TAPDANCE_HOME`, `TAPDANCE_SESSION_ID` `stage3-cli` / `stage3-mcp`; its own Tapdance host untouched |
| Network | Tailscale, guard served with `tailscale serve` over HTTPS (tailnet HTTPS certificates on), direct IPv6 path |

## Timeline and setup measurements

| Step | Result | Time |
| --- | --- | --- |
| macOS 27.2 install by Scaleway (not the default version) | SSH answered | about 1 h (console said "around two hours") |
| Read-only survey | Xcode present, no iOS runtime, first launch not done, no Homebrew, MacPorts present, `m1` admin, sleep off, FileVault off, SIP on, MDM enrolled, nobody logged in (`gui/501` missing) | |
| `xcodebuild -downloadPlatform iOS -architectureVariant arm64` | iOS 27.0 installed, no Apple ID | 1 min 44 s for 8 GB |
| `sudo xcodebuild -runFirstLaunch` | done (owner typed the password) | |
| Simulator with nobody logged in | `simctl create/boot`, Home Screen rendered about 60 s after boot finished, `simctl io screenshot` and `launch` worked over ssh | boot 30-39 s |
| `sudo sysadminctl -autologin set -userName m1 -password -` | **failed twice**: `SACSetAutoLoginPassword error:22`, password right | |
| `infrastructure/scripts/macos-auto-login.sh m1` (new) | after a console reboot `m1` on `console`, `gui/501` exists | reboot → ssh about 30 s |
| `host-setup.sh --ios-only --with-gh --allow-admin-account --label stage3-agent` (branch) | Node.js, JDK, Tailscale and `gh` from MacPorts (binary archives), Tapdance clone and build, Tailscale login, `host up`: worker, guard service, pairing, `tailscale serve` (https), self-test **PASS** (iOS lease, screenshot) | about 13 min (20:57 → 21:10 UTC) with the owner's prompts |
| `tapdance connect` on the agent's machine | token accepted, healthz 48 ms; exited 10 until the doctor fix (below) | 17 s |
| Disk | 194 GB free → 175 GB free after setup, runtime, runs and builds | |

## Checklists from the agent's machine

The drivers in `scripts/field-test/` with `PLATFORM=ios` (CLI) and `checklists/mcp-ios-base.json` (MCP,
stdio), iPhone 17 / iOS 27.0. Every lease came from the rented Mac (`Provider: Remote worker`,
endpoint `https://861eecdb-….tailc7cb50.ts.net:4720`, the guard's audit log on the Mac lists each call).

| Run | Warm spares | Result | Notes |
| --- | --- | --- | --- |
| CLI base, first | default (1) | 22/28 | the checklist read the Home Screen without `--app com.apple.springboard` and used Android-only notification steps: checklist fixed |
| CLI base | default (1) | 29/31 | lease from the spare **2.4 s**; `devices` timed out and the first `key_home` took 91 s and failed: a second simulator (the new spare) was booting on 8 GB |
| MCP base | default (1) | 0/2 | lease refused: Simlock `INTERNAL` "simctl list -j devicetypes runtimes timed out after 30000ms" (memory); Tapdance reported it as `USAGE`: fixed |
| CLI base | slim default | 3/4 | slim lease: "Timed out waiting for device to boot" (slim boots twice) |
| **CLI base** | **0** (`host warm android=0,ios=0`) | **31/31** | cold lease 76.6 s; first command after it 31.8 s |
| **MCP base** | **0** | **29/30** | cold lease 90.9 s; first command after it timed out at 90 s ("Daemon request timed out"): made retryable |

Steps that passed in the CLI run: doctor, devices, lease, status, Home key, inspect (SpringBoard),
screenshot, swipes, tap "Settings", `ui wait --stable`, rotate landscape/portrait, push notification to
Settings, Notification Center open/read/close, recording (MP4), push to Files, alert read, language
read (`en-FR`), crash reports, logs, accessibility audit (Settings), opened links, artifacts, release.

## Memory on 8 GB

| State | Used | Compressed | Swap |
| --- | --- | --- | --- |
| Idle, no simulator | 2.7-3.8 GB | 0.1-0.3 GB | 0.4-0.8 GB |
| One iOS 27 simulator booted | 6.2-7.5 GB | up to 3.7 GB | 1.7-3.0 GB |
| One leased + one warm spare booting | 7.5 GB, 0.2 GB free | 3.7 GB | up to 2 GB of 2 GB, then grown; `simctl` calls over 30 s |
| Kotlin Multiplatform build next to a leased simulator | 7.5 GB | 3.6 GB | up to 3.9 GB |

Simlock's RAM budget counts 1.5 GB per iOS simulator (4.0 GB total on this Mac), so it allows a second
one that does not fit. Conclusion: on the M1-M keep no warm spare (`host warm ios=0`); 16 GB offers are
the ones to use for warm spares.

## Over plain `ssh host 'cmd'` (no login shell) and the reboot

- Before the fix, `tapdance`, `node` and `gh` were not on `PATH` in `ssh host 'cmd'` (zsh reads
  `~/.zshrc` only in interactive shells): fixed (`~/.zshenv`, MacPorts on `PATH`).
- After it: `tapdance host status`, `tapdance host builds enable` (it restarted the guard) and
  `tapdance worker restart` (rc 0, 6 s, a new worker pid; the ssh session's launchd context is
  `Background`, the LaunchAgents live in the auto-login session `gui/501`) all worked over plain ssh.
- `host up` itself ran in an interactive `ssh -t` session.
- Reboot with every service installed: _(pending)_.

## Host build of a private app

Pianolune (`KAppMakerDeveloperApps/Pianolune-All`, Kotlin Multiplatform, `MobileApp/iosApp/iosApp.xcodeproj`,
scheme `iosApp`, bundle id `com.measify.pianolune`), allowed with `host builds enable --git-auth gh
--protected-ref main` after `gh` was logged in on the Mac with a fine-grained read-only token.

| Attempt | Result |
| --- | --- |
| 1 | clone, checkout of `b7853bd` (main), `xcodebuild` started; Gradle failed configuring `:audioengine`: "SDK location not found" (the app's Android module needs an SDK even for the iOS build). 3 min 24 s. Fix: `--android-build-sdk` (command-line tools and platform-tools, 210 MB, 14 s) and a build hint |
| 2, 3 | did not reach the host: the agent's machine was asleep (one `curl --max-time 20` returned after 1055 s) |
| 4 | _(pending)_ |

Installing the app from a CI artifact was not run: `app install --from-ci` takes Android APKs only, and
Pianolune's CI builds no iOS simulator app ([#121](https://github.com/mirzemehdi/tapdance/issues/121)).

## Tool bugs found and fixed (branch `test/scaleway-m1-ios`)

1. `host-setup.sh` always installed the Android SDK, emulator and image: `--ios-only`; it also checks the
   Xcode licence, first launch and an iOS runtime.
2. Tailscale on macOS only through Homebrew's cask (the GUI app, which needs someone at the screen):
   MacPorts or Homebrew `tailscaled` as a system daemon; the CLI finds it in `/opt/local/bin`.
3. `gh` on macOS only through Homebrew: MacPorts.
4. Tools not on `PATH` for commands over ssh on macOS: `~/.zshenv`, MacPorts and Homebrew bins.
5. Auto-login: `sysadminctl` fails on macOS 27.2 over ssh: `infrastructure/scripts/macos-auto-login.sh`.
6. `connect`/`doctor` exited 10 on an iOS-only Mac: Android without an SDK is a warning there.
7. A lease refused with Simlock's internal error was `USAGE`: `PROVIDER_UNAVAILABLE`, retryable.
8. agent-device's "Daemon request timed out" was `DEVICE_ERROR`: `PROVIDER_UNREACHABLE`, retryable.
9. `host up` offered to copy the token to the clipboard over ssh (the host's pasteboard): not over ssh.
10. A Kotlin Multiplatform iOS build on an iOS-only host: `--android-build-sdk` and a hint naming it.

Seen, not fixed: the iOS field-test checklists needed SpringBoard reads (`--app com.apple.springboard`)
and Notification Center steps (the tools behave as documented); `gh auth login --with-token` echoes the
token over `ssh -t` (#122); when the agent's machine dropped off mid-lease, the CLI said "nothing was
leased" while the host had granted the lease, which then ran until its TTL.

## Cost

M1-M at EUR 0.11/hour: the 24-hour minimum is EUR 2.64 excluding VAT (EUR 3.17 with 20 % VAT); deleted by
Scaleway's automatic deletion at 24 h. No Private Network, no extra disk, no traffic charges listed.
_(Final: from the Scaleway billing page after deletion.)_

## How to re-run

[docs/testing/field-test-rented-mac-ios.md](../field-test-rented-mac-ios.md).

## Not covered

Other Scaleway offers (16 GB and up), macOS 26 / Xcode 26 on a rented Mac, `xcodes`, the standard-account
setup (`macos-create-worker-account.sh`), a Linux VPS as the agent's machine, the browser viewer against
this host, `host pause` / `resume` / `down --all` on it, installs from CI for iOS, AWS EC2 Mac and
MacStadium.
