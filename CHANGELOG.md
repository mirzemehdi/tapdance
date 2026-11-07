# Changelog

All notable changes to Tapdance are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Until 1.0, minor versions may change command flags,
config keys and MCP tool inputs.

What has been proven on real devices is tracked in [STATUS.md](STATUS.md), not here. An entry in this
file means the code exists, not that it has been tested on every platform.

## [0.1.0] - Unreleased

First slice. Tested end to end on one Mac: iOS simulators against the local worker
([evidence](docs/testing/evidence/2026-11-01-local-ios.md)), through a gateway with a joined worker
([evidence](docs/testing/evidence/2026-11-01-gateway-single-host.md)) and through device-only mode
([evidence](docs/testing/evidence/2026-11-01-worker-guard.md)); Android emulators
([evidence](docs/testing/evidence/2026-11-01-android.md)); AXe as the iOS UI backend
([evidence](docs/testing/evidence/2026-11-01-axe.md)). Not yet run across two machines or on Linux.

### Added

- Five packages: `@tapdance/core` (contracts, config, errors, sessions, artifacts),
  `@tapdance/provider-simlock`, `@tapdance/sdk`, `@tapdance/mcp`, and the `tapdance` CLI.
- A `DeviceProvider` contract with one implementation backed by
  [Simlock](https://github.com/callstackincubator/simlock) 0.5.0 (patched, see below) and
  [agent-device](https://github.com/callstack/agent-device) 0.21.35, serving both local workers and
  self-hosted gateways. `provider: "cloud"` is reserved and fails with `NOT_SUPPORTED`.
- CLI commands: `init`, `doctor`, `config`, `devices`, `workers`, `device lease/status/renew/release`,
  `app install/launch/stop/list`, `ui inspect/tap/swipe/type/wait/alert/key`, `screenshot`,
  `record start/stop`, `logs`, `artifacts`, `view`, `report`, `gateway setup/token/status`,
  `worker check/install/login/logout/start/stop/status/logs/restart`, `simlock`,
  `tools list/doctor/versions`, `tool`, `asc`, `android`, and `mcp`.
- `--json` output, results on stdout and progress on stderr, and stable exit codes (2 to 12).
- Scenario files ([docs/scenarios.md](docs/scenarios.md)): `tapdance run <file>` replays a YAML or JSON
  flow on the session's device and writes a PASS/FAIL report with an evidence folder; exit code 12
  (`SCENARIO_FAILED`) on a failed step. SDK: `runScenario`, `loadScenario`, `scenarioFromToolCalls`.
  Tested against FakeProvider only.
- Device-only mode for personal Macs (`tapdance worker guard`); `worker login` requires
  `--accept-gateway-exec`.
- `devices install`, MCP `list_apps`, and `config set-token --endpoint` (a token bound to its endpoint).
- Google's Android CLI targets the leased emulator with `--device=<serial>`; AXe finds SwiftUI text
  fields by placeholder and waits for a just-launched app's accessibility tree.
- An MCP server over stdio and Streamable HTTP (bearer token) with the tools `list_workers`,
  `list_devices`, `lease_device`, `get_device_status`, `release_device`, `install_app`, `launch_app`,
  `stop_app`, `inspect_screen`, `tap`, `swipe`, `wait_for`, `handle_alert`, `type_text`, `press_key`,
  `take_screenshot`, `start_recording`, `stop_recording`, `get_logs`, `get_crash_logs`, `list_tools`,
  `execute_tool` and `get_test_artifacts`.
- Session-scoped leases with a detached keepalive, `--hold`, idle release and a per-session lock.
- Local artifact storage with a per-session manifest.
- A loopback browser viewer (`tapdance view`) with live H.264 video, input, and human take-over and
  hand-back (`HUMAN_HELD`).
- Host checks for Xcode, the Android SDK and KVM, with no software-emulation fallback.
- Guided self-hosting: `gateway setup`, `gateway token`, `worker login` (outbound `wss://` uplink).
- An external tool registry (metadata only) for `asc`, `android`, `axe`, `maestro`, `fastlane` and
  `xcodebuild`, with argument forwarding, approved environment, timeouts and `asc` read-only by
  default for agents.
- An optional AXe backend for iOS simulators (`ios.uiBackend: "axe"`); not yet run on a real install.
- `tapdance report` for redacted, issue-ready bug reports, and GitHub issue templates.
- Reference Terraform and install scripts for a Google Cloud N2 Android worker (not yet provisioned).
- `worker guard install` / `uninstall`: the worker guard as a LaunchAgent (`dev.tapdance.guard`) or
  systemd user unit, with `--keep-awake` (`caffeinate -i`) on macOS.
- One-command host setup: `host up` / `status` / `down` on the device machine, `connect` on the
  agent's machine, and `scripts/host-setup.sh` / `scripts/host-setup.ps1`.

### Added in the field-test round (issues #1–#19)

- Device-state tools through one allowlisted device-command channel that also works through the worker
  guard: `set_device_setting`, `push_file`/`pull_file`, `notifications`, `uninstall_app`,
  `clear_app_data`, `measure_performance`, `launch_app` arguments and Android intents; CLI `device
  setting|push|pull|notifications|perf`, `app uninstall|clear`.
- Worker guard: uploads and artifacts bound to the client that created them; policy switches
  `allow.settings`, `allow.files`, `allow.notifications` (off by default), `allow.perf`.
- `.aab` installs via bundletool.
- Android device profiles (`device profile create|edit|list|delete`, `device lease --profile`), booted
  read-only so every lease starts from the prepared state.
- `request_human` (MCP), `device done` (CLI) and the viewer's Hand back answering it.
- Scenario files and `tapdance run` / `run_scenario` with a PASS/FAIL report (exit code 12).
- `host up|status|down`, `connect`, `worker guard install|uninstall`, `scripts/host-setup.sh`.
- Docs: Android proven locally; repository URL `github.com/mirzemehdi/tapdance`; purchase-testing guide.

### Added after the first field run (issues #20–#25)

- Guard forwards agent-device's upload headers: app installs through the guard work for large apps.
- `tapdance host pause` / `host resume`, `host down --all`, `host token` (clipboard, fingerprint),
  `host up --warm android=N,ios=M`; `worker stop` also shuts down the worker's devices, and `worker start`
  resets stale device records when nothing is leased.
- Viewer: Tailscale names allowed, screenshot mode where browsers forbid the video decoder, errors in
  the banner.
- `host-setup.sh` installs prerequisites (one confirmation, checksummed official downloads); pnpm
  without sudo; Tailscale without HTTPS certificates served over HTTP inside the tailnet.

### After field runs 2 and 3 (issues #30–#38)

- `device request-human` (the CLI form of `request_human`), `worker cleanup` (release device claims of
  dead agent-device processes), `view --tailscale` (the viewer over https through `tailscale serve`),
  `ui inspect --bounds`, `ui tap --inject` and MCP `tap` `inject` (Android raw input taps).
- Fixed: leases failing with "owned by session …" while emulators were recycled in a loop (one
  agent-device session per lease; stale claims released before each lease through the guard, at
  `worker start` and for local leases); `ui tap` ignored by the Android file picker and share sheet (a
  tap that changed nothing there is repeated as a raw input event); `ui swipe --until` missing rows
  whose label merges several texts; `doctor` calling a slow-to-connect https guard unreachable;
  `connect` saving an address that does not answer or an `http://` one the guard no longer serves;
  `device release` printing "Released" when the worker could not be reached; `host-setup.sh`
  downloading the emulator and a 1.5 GB image on Linux without KVM.
- Changed: an emulator's notification list is readable through a worker guard by default
  (`allow.inspection`); posting, and reading a physical phone's, still need `allow.notifications`.

### After field run 3 (issues #39–#44)

- `host warm`, `app kill` (MCP `kill_app`), `ui sequence` (MCP `tap_sequence`), `ui inspect --system`
  (MCP `inspect_screen` `system`), `device setting browser-first-run off`, `device request-human
  --no-wait` / `--cancel` (exit 13 `CANCELLED`), `devices install --image-tag` (Play Store and ATD images).
- Changed: `ui wait` / `wait_for` up to 10 minutes; `orientation landscape` means `landscape-left`;
  the viewer accepts its allowed names on any port; `view --tailscale` tries `sudo -n tailscale serve`.
- Fixed: Android missing when a stray adb server sat on Simlock's port (`worker start/restart` stop it;
  `doctor` and `devices` say so); `host up`'s run-again hint dropping `--warm`.

### After the iOS field run (issues #45–#50)

- Builds on the host from allow-listed git repositories: `host builds enable|disable|status|key`,
  `app build`, MCP `build_app` (off by default; protected refs; credentials stay on the host).
- Scoped guard tokens (`worker guard pair --scope`, `host up --scope`); `docs/security/threat-model.md`.
- iOS: `device push --to files` / `pull --files` (Files app), `device clipboard`, `app launch --locale`,
  Notification Center open/close, `app list` from simctl, alert get from the screen, status-bar time read.
- Changed: iOS wifi/airplane are refused (the simulator cannot go offline) instead of faking the status
  bar; posting a notification to a simulator or emulator needs `interaction`, not `notifications`.
- Fixed: `perf memory` refused by the guard.

### After verifying #42–#44 (issues #51, #52)

- Fixed: `ui sequence` firing early after gaps of 2.15 s or more (32-bit shell arithmetic); `ui inspect
  --system` failing (UiAutomation held by agent-device's helper, no /dev/tty); `record stop` losing a long
  recording to agent-device's 90 s download limit; the CLI crashing on EPIPE when piped to `head`.
- Added: reading `device setting orientation`; `browser-first-run off` also skips Chrome's notifications
  promo; builds tolerate a submodule the host cannot fetch; the guard service PATH includes Homebrew and
  `JAVA_HOME`.

### Field run 4 (issue #53)

- Fixed: iOS builds compiled x86_64 as well and failed for Kotlin Multiplatform apps that declare only
  `iosSimulatorArm64`; builds now use the host's simulator arch only. A failed build's error names its
  cause (compiler errors, Gradle's "What went wrong", the failed build commands) instead of a raw tail.
- Added: `app build --xcode-setting KEY=VALUE` (MCP `xcode_settings`, a short allow-list of keys) and
  `--verbose`; by default the CLI shows only steps, errors and the outcome.
- Fixed: a guard restart (an update) cut a running agent off its lease ("not this token's lease"); the
  guard now keeps lease ownership in `~/.tapdance/worker/leases.json`. agent-device's diagnostics for a
  failed request were refused by the guard; they now reach the session's owner.
- Fixed (#57): iOS builds were unsigned, so the app had no entitlements and Keychain failed (-34018);
  they are now signed ad-hoc like Xcode's Run (checked on Pianolune: `application-identifier` embedded).
- Fixed (#59): `logs --app` on iOS matched the bundle id's last word instead of the app's executable
  (`Pianolune`); asking for more than 5000 log lines now says it was capped.
- Fixed (#50, #49): `ui alert get` missed a system alert that agent-device answered "no alert" for
  without an error; reading the screen with the app killed gives the "launch it again" hint;
  Notification Center no longer needs a snapshot to find the screen size.
- Added (#58): `ui type --delay-ms` (MCP `delay_ms`), with one automatic retry at 80 ms when a fill
  drops characters; iOS switch rows are tapped at the toggle when a tap on the row changed nothing;
  `dismiss_keyboard` on iOS says why it cannot work (the iPhone keyboard has no hide key) and what to do.
- Fixed (#56): iOS taps did nothing in landscape. agent-device 0.21.35's runner rotated taps against
  its own screen, which runs in a 320 pt legacy compatibility size, so a landscape tap at (437, 342)
  went to (-22, 437). Tapdance ships a pnpm patch (`patches/agent-device@0.21.35.patch`) that rotates
  against the app's window instead. The cause and a corrected tap were checked on an iPhone 17
  simulator; the patched runner itself waits for the host update.
- Added (#59): `device crashes [--app] [--pull <name|latest>]` / MCP `crash_reports`: the leased iOS
  simulator's crash reports (.ips) since the lease began, pulled as artifacts with a summary of the
  exception and the crashed thread. Through a worker guard only reports naming the lease's simulator
  are served.
- Fixed: after a `pnpm install` that moved agent-device (a new version or patch), the worker kept
  running the old copy, because `worker install` stored its absolute path in Simlock's config.
  `worker start` and `worker restart` now point Simlock at the agent-device this Tapdance ships.
- Added (self-test, #58/#49/#50): `ui inspect --app <id>` (MCP `inspect_screen app_id`) switches to that
  app as it is and reads it: Safari after a link-out (any plain read brings the session's app back to
  the front), or `com.apple.springboard` for the Home Screen. `notifications open/close` on iOS with the
  app killed switch to SpringBoard on their own, so Notification Center can be read. A setting read
  prints its value ("Text size is large").
- Added: a Gradle build that stops on an Android SDK package the host lacks (CMake, an NDK, a platform)
  now ends with the exact `sdkmanager` command to run on the host (seen in the self-test: Pianolune's
  audio engine needs CMake 3.31.6). The hint says only the host's owner can do it, and how to ask.
- Fixed (self-test C1): a worker restart during a lease left the lease alive but its device gone, and
  every command failed with "refused: simlock picks the device" (USAGE). That is now LEASE_LOST with
  the fix, and the client clears its session. `worker restart` refuses while leases run unless `--force`.
- Fixed (self-test C5): a release whose calls both failed (the guard restarting mid-release) printed
  "Released" and forgot the lease while the guard still held it, so the next lease hit the session
  limit. It is now kept for another release. A token whose scopes refuse an area that the policy allows
  is told so, with the `worker guard pair --scope` that would allow it, instead of being sent to a
  policy switch that is already on; an upload refused by the guard arrives as FORBIDDEN, not DEVICE_ERROR.
- Fixed (self-test B2): on Android, `ui tap --settle-ms` summarised the status bar first and counted a
  clock tick as "screen changed"; the status bar is left out of both.
- Added (#59): `app launch <id> --console` (MCP `launch_app console`) on iOS relaunches the app with its
  stdout and stderr captured on the Mac, and `logs --app` adds them: `print`/`println` lines (for
  Pianolune: its `Api: REQUEST/RESPONSE` lines) that the system log never has. Through a worker guard,
  `POST/GET /v1/leases/<id>/console`, files chosen by the guard.
- Added (#58): `ui sequence` / MCP `tap_sequence` on iOS. Touches go through the simulator's input
  channel (the live viewer's, not XCTest, whose taps take 300–450 ms each), scheduled on the Mac by the
  worker guard (`POST /v1/leases/<id>/touches`) or by Tapdance in local mode. Measured on an iPhone 17
  simulator: 14 taps at 250 ms, largest start drift 4 ms; timed taps on Pianolune's buttons landed in
  portrait and landscape. `--orientation` for apps that force landscape-right.
- Added (#60): `ui audit` / MCP `audit_screen`, an accessibility check from the accessibility tree
  (unlabelled controls, small touch targets, controls announced alike, unlabelled images), for what a
  manual test would do with VoiceOver, which the iOS simulator does not have.
- Fixed (#58): `ui tap --text` on a row below the fold or under a toolbar failed; it now scrolls the
  text into view (and matches text that is part of a label) and taps it there.
- Added (#60): `device links` / MCP `opened_links`: the links apps asked the system to open, whether
  anything opened them and in which app, and `mailto:` address and subject. Checked on Pianolune:
  "Contact us" → `mailto:team@measify.com (nothing handles it)`, Terms → `https (opened in com.apple.mobilesafari)`.
- Added (#49): `device setting language <locale>` on iOS, the device-wide language (checked: Settings
  came up as "Einstellungen" with de-DE). `device notifications tap --text <text>` (MCP `notifications`
  action `tap`) opens a notification the way a person does: on iOS a real swipe right in Notification
  Center, which opened Pianolune after it was killed; a banner tap through `ui sequence --orientation
  portrait` opened it from the Home Screen. Timed iOS steps can drag (`toX`/`toY`), and with
  `--orientation` nothing is read from the app first.

### Self-test run 5 (issues #61–#65)

- Fixed (#61): a build whose `git fetch` failed said only "git fetch failed (exit 128)"; the message now
  ends with git's `fatal:` line and says the host's network is at fault (details.reason HOST_NETWORK). A
  full commit id the host already has builds from its cache when the fetch fails, and builds are kept
  per commit and settings, so the same request reinstalls the earlier build in seconds.
- Fixed (#62): `device setting time|clock|date|voiceover|talkback|locale` and `device storekit` answer
  NOT_SUPPORTED with why and what to use instead, not "Unknown setting".
- Fixed (#63): `record stop` exited 7 ("terminated") although the video was saved complete. A cut
  download is fetched again with Tapdance's long download, and a complete MP4 already on disk is kept.
- Fixed (#64): `ui audit` flagged Android targets of exactly 48 dp, iOS controls inside a bigger row,
  and their "0" values as duplicates; sizes are compared in whole dp and nested controls are left out.
- Fixed (#65): rotating an Android emulator right after `app kill` failed with "adb timed out after
  1ms"; it now tries three times with longer pauses and trusts the screen's shape in the end.

### Self-test run 5b (issues #58, #66–#68)

- Fixed (#58): a Compose field could report "Filled 25 chars" while holding other text; the field is now
  read back after a fill, refilled at 80 ms and 150 ms between keystrokes, and the fill fails with what
  the field shows if it still differs. On iOS a settled tap that opened a link in Safari no longer leaves
  your app in front: Safari is brought back and the reply says so.
- Fixed (#66): an Android build that Gradle found up to date failed with "no new .apk was found"; the
  APK on disk is installed.
- Fixed (#67): "Remote daemon is unavailable" for one call is retried once after a short pause, and the
  hint no longer names agent-device internals.
- Fixed (#68): `device links` showed web links as a bare `https:`: the log filter missed Launch
  Services' "url scheme" lines (case); the app that took the link shows again.

### Phase 2b cloud field test, round 2: builds and installs (issues #85–#90)

- `host up` warns, and `host status` shows a `gh` row, when builds with `--git-auth gh` or installs from
  CI are on and `gh auth status` fails (#77). `host-setup.sh` picks the command-line tools archive for the
  machine's CPU (an Apple silicon Mac got the x86_64 one); its `~/.androidrc` metrics opt-out is verified
  with command-line tools 23.0.
- Simlock 0.5.0, the latest release (was 0.4.0).
- Tapdance patches Simlock 0.5.0 (`patches/simlock@0.5.0.patch`, applied by `pnpm install`; MIT, listed
  in NOTICE.md). Fixed (#94): after the host restarts, Simlock's startup pass, and `simlock doctor`
  without `--fix`, move an Android record that still says `ready` but has no emulator to `shutdown`
  before the daemon reports `running`, so `doctor` no longer counts a dead emulator and the warm pool
  boots the spare again instead of a lease meeting "No Android device with serial …". Tapdance's
  10 s retry of that error stays as a safety net. A host whose Simlock login service was installed
  before this change still starts the copy it was installed from (the patched copy lives in another
  `node_modules/.pnpm` folder): run `tapdance worker install --service` once to install it again.
- Fixed (#79, Simlock patch): Simlock captures an Android device's clean baseline snapshot only from a
  settled guest: before the capture (once, on the device's first boot) it waits, at most 120 s, until the
  guest CPU was busy at most 50 % for two 1 s intervals. A baseline saved mid-dexopt made every warm
  spare and reclaim restored from it start busy. Other boots and reclaims do not wait; Tapdance's own
  90 s settle wait on lease covers them. Existing baselines are kept. Tested with mocks only.

- Changing the host policy (`host builds`, `host artifacts`) restarts the guard only when the installed guard
  serves the same `TAPDANCE_HOME`; a run with a scratch home no longer restarts the machine's real guard.

- A host build that cannot sign in to git fails with `AUTH_FAILED` (`details.reason: GIT_AUTH`) instead
  of `DEVICE_ERROR`. The error and the CLI's quiet log show git's own line (`Permission denied
  (publickey)`, `Repository not found`), and the hint fits the auth the host used: its deploy key with
  the key's fingerprint and whether the organization allows deploy keys, `gh`, or an https URL next to
  a deploy key (#85).
- `host builds enable` checks that the host can read each `--repo` with that auth (`git ls-remote`) and
  `host artifacts enable` that `gh` can read each repository's Actions artifacts; both warn with the fix
  (`--no-check` skips). `host builds status --check` and `host artifacts status --check` run the check
  again. In `--git-auth gh` mode, github.com submodules listed with ssh URLs are fetched over https
  (#86).
- `host builds key --repo <url> --remove` deletes a repository's key and prints its fingerprint;
  `host builds disable --repo <url>` and `host artifacts disable --repo <owner/repo>` remove one entry
  and leave the rest on. Output keeps the repository's case; `host builds status` says `not used
  (https)` for an https URL next to a deploy key, and an https clone no longer gets the ssh key (#87).
- MCP `build_app` and `install_app` take `launch` (relaunch after install). `build_app` replies always
  carry `reused` (with `builtAt`) and `ref`; build and install-from-CI replies name the installed
  Android package (`appId`, `versionCode`), read from the APK's manifest on the host (#88, #89).
- Install refusals (`INSTALL_FAILED_VERSION_DOWNGRADE`, another signing key) name the package and use
  MCP syntax in MCP replies and `tapdance` commands in the CLI (#89).
- Host Android builds let idle Gradle and Kotlin daemons go after 10 minutes instead of Gradle's 3
  hours; `host builds enable --gradle-idle-minutes <n>` (policy `builds.gradleDaemonIdleMinutes`; 0
  builds with `--no-daemon`) (#90).

### Licence

- Changed: Tapdance is now licensed under the GNU AGPL-3.0-only (was MIT). Self-hosting and changes
  stay free; a modified Tapdance offered to others as a network service must share its source.
  Copies obtained under MIT up to commit b3ec7e3 keep the MIT terms.

### Self-test run 7 (issue #69)

- Fixed (#69): `ui audit` still flagged rows hidden behind a tab bar, rows cut at the top of a scrolled
  list, and slivers at a list's bottom edge (size and, on iOS, a missing label). A control is now left
  unjudged when it touches the screen's top or bottom, is covered by a tab, navigation or tool bar (also
  a Compose or SwiftUI tab row with no bar element), touches its list's or a bar's edge and looks cut,
  or is the first or last of several rows alike and clearly shorter. The report lists them as
  `partlyHidden`; the CLI names them.

### Self-test run 6 (issues #65, #69, #70)

- Fixed (#65): rotating an Android emulator on the Home Screen failed with "adb timed out after 1ms":
  the Pixel launcher does not rotate, so there is nothing to confirm. Tapdance now says the rotation is
  set and the Home Screen stays portrait; an app locked to one orientation gets that reason instead.
- Fixed (#69): `ui audit` judged the size of rows cut off by the top or bottom edge by their visible
  part only; those are no longer measured.
- Fixed (#70): after a `mailto:` tap, the link check could report an earlier web link from the same few
  seconds and bring Safari forward; only the latest link request counts now.
- Fixed: `ui alert accept`/`dismiss` with no alert on screen answered "main thread execution timed out";
  it now answers "No alert".

### Phase 2: Android host on a Google Cloud N2 VM

Run on a real `n2-standard-4` VM driven from a Mac over Tailscale
([evidence](docs/testing/evidence/2026-11-03-gcp-n2-android.md)).

- Added: a cost guard for cloud device hosts. The worker guard powers a Linux cloud VM off after
  `host up --idle-stop <minutes>` with no lease, request or build (30 by default on a detected cloud VM),
  and `--max-uptime <hours>` stops new leases past a cap; `host-setup.sh` adds the one sudoers rule for
  `systemctl poweroff`; the Terraform module sets `max_run_hours` (8), and optionally `stop_schedule` and
  a budget alert. The idle stop powered the N2 VM off for real; the uptime cap is unit-tested.
- Added: cloud cost guardrails, not yet run on a cloud. On a detected cloud VM, `host up`'s ready block
  and `host status` say that the VM bills while running and its disk even when stopped, and link the
  tear-down steps. The Terraform module's `on_run_limit = "DELETE"` (ephemeral mode) deletes the VM and
  its disk at `max_run_hours`, and new outputs print the destroy command, the leftovers check and every
  tear-down step. `infrastructure/scripts/gcp-leftovers.sh <project>` lists what can still bill in a
  project (VMs in any state, disks, snapshots, images, addresses, routers and NATs) and exits non-zero
  while anything is left; `--delete-project` only prints the command.
- Added: a field-test kit for cloud Android hosts:
  [field-test-cloud-android.md](docs/testing/field-test-cloud-android.md) (checkpoints, costs, the VPS
  variant, an evidence template and a mandatory teardown) and `scripts/field-test/` (CLI and MCP
  checklist drivers with timed PASS/FAIL tables). AGENTS.md and CLAUDE.md tell agents to leave no
  billable resources behind.
- Added: install from CI. `app install --from-ci <owner/repo> --artifact <name>` and MCP `install_app`
  `from_ci` have the device's host download a GitHub Actions artifact with its own `gh` and install the
  APK; the owner allows repositories with `host artifacts enable`. Ran with the CLI and MCP on the N2 VM.
- Added: private-repository builds on the host: a deploy key per repository (`host builds key --repo`),
  owner-only build files (`host builds files add/list/remove`), and a sign-in failure hint naming the
  three ways out. With a fine-grained token, an Android build of a private repository ran on the N2 VM
  (CLI and MCP); deploy keys and build files are unit-tested.
- Added: Linux host support in `host up` and `host-setup.sh`: headless emulators with
  `swiftshader_indirect` when there is no display, linger or a boot unit for the user manager, `tailscale
  up --operator`, kvm access without logging out, the emulator's system libraries.
- Added: docs: one path for a Google Cloud N2 host with measured numbers and a "parking the VM" table,
  [build in CI, test with Tapdance](docs/guides/ci-builds.md),
  [private repositories](docs/guides/private-repositories.md), and troubleshooting rows from the run.
- Fixed: `host up` over non-interactive SSH failed with "Failed to connect to bus: No medium found"; it
  turns on linger, waits for the user manager's bus and points `systemctl --user` at it.
- Fixed: Google Cloud OS Login accounts cannot linger ("No such file or directory");
  `host-setup.sh` installs `tapdance-user-manager.service` to start the user manager at boot.
- Fixed: the emulator did not start on Ubuntu's cloud image (missing `libpulse0 libxkbfile1 libxi6
  libsm6 libice6`); new host check `host.kvm.emulator-libs`, and `host-setup.sh` installs them and no
  longer hides the check under `pipefail`.
- Fixed: `host-setup.sh` detected a terminal that was not there; it now opens `/dev/tty`, and through
  `curl | bash` `host up` gets the terminal so the pairing can be approved.
- Fixed: restarting the guard over SSH (after `host builds` or `host artifacts enable`) failed silently,
  and `host status` over SSH said "Failed to connect to bus".
- Fixed: `doctor` failed (exit 10) on a Linux worker because iOS was missing; it is skipped with "needs
  a Mac".
- Fixed: rotation with the launcher in front made three attempts (50 s on a nested emulator); now one
  (17 s).
- Fixed: the first inspect after a fresh lease failed with `INSTRUMENTATION_FAILED`; it is retried once.
- Fixed: `host builds enable` reset `--git-auth` and `--timeout-minutes`; the build JDK check ignored
  `JAVA_HOME`; `env.sh` did not put the JDK on `PATH`; the MCP outside-the-project hint now covers
  `push_file`.
- Fixed: Android install refusals (`INSTALL_FAILED_UPDATE_INCOMPATIBLE` from a CI build or a host build
  with another debug key, `INSTALL_FAILED_VERSION_DOWNGRADE`, `INSTALL_FAILED_INSUFFICIENT_STORAGE`) name
  the fix, for uploads, installs from CI and builds on the host.
- Fixed: on a VM without a GPU the emulator's `-gpu auto` kept it at 136–165 % CPU when idle and
  screen-changing taps took 3.4–7.9 s; headless Linux hosts now use `swiftshader_indirect` (about 0 %
  idle, taps 2.2–2.6 s on the N2 VM).
- Fixed (#72): on Android, `ui type` and MCP `type_text` without a target answered "Typed N chars" when
  no text field had focus and nothing was typed. When the screen shows no focused field, they now fail
  with `ELEMENT_NOT_FOUND` and a hint to pass the field (`--text`/`--ref`/`--id`, MCP
  `into_text`/`into_ref`/`into_id`); when the screen does not say, they type as before.
- Fixed (#73): on Android, `ui inspect` and MCP `inspect_screen` named the session's app while the
  launcher was in front. When no element on screen belongs to the session's app, the app most elements
  belong to is named instead, with a note that the session's app is not in front.

### After the VPS + N2 field run (issues #72, #82)

- Fixed (#72, reopened): the no-focus check never fired on a real emulator, because agent-device's
  Android snapshot sets `focused` only on the element that has focus and leaves the key out elsewhere.
  A screen with a text field and no focused element now counts as "no focus". Before refusing, Tapdance
  asks agent-device for the keyboard status (`dumpsys input_method`): when the keyboard is up, some
  view takes text, so it types as before.
- `tapdance logs` gains `--contains <text>` (case-insensitive) and `--level error|fault`, like MCP
  `get_logs`. A filtered search on Android reads the whole logcat buffer instead of the last N lines,
  and the reply says how many lines matched and how far back the buffer goes; MCP `get_logs` and
  `get_crash_logs` search the same way. `-n` goes up to 20000 lines (was 5000).
- Fixed (#82): MCP `type_text` with a field passed on agent-device's warning that the target "resolved
  to android.widget.TextView" although Tapdance had read the text back from the field; the warning is
  dropped when the read-back matches.
- Fixed (#82): `doctor` said "15 s each" when the 10 s connect timeout had fired; it names the limit
  that fired.
### Field run 2b on the N2 VM: leases on a slow or just-started host (#79, #80, #91, #92, #94)

Found on a Google Cloud N2 host with nested-virtualization emulators; the fixes are unit-tested with
mocked devices and not yet re-run on a host.

- Fixed (#79): a lease taken right after a release, or from a spare restored from Simlock's snapshot,
  was handed out while the guest was still starting (commands took 12-25 s, and a "System UI isn't
  responding" dialog covered the app). An Android emulator lease now waits up to 90 s for boot
  completion, no "isn't responding" dialog (answered with Wait) and a calm guest CPU; past that it is
  handed out with a notice (CLI warning, `notices` in MCP `lease_device` and the SDK's `lease()`).
- Fixed (#80): an "isn't responding" or crash dialog in front is named by `ui inspect` /
  `inspect_screen` (app `android`, with what to tap), `app launch` / `launch_app` (a warning) and a tap
  whose target is not found, instead of a generic miss.
- Added (#91): `tapdance host warm default` goes back to Simlock's default spares (it removes the keys
  `host warm` wrote), and `tapdance host warm` with no counts shows the setting and the spares.
- Fixed (#91): `worker restart`, `worker start` and `host warm` reset Simlock's device records with
  `nuke`, which also forgot the learned spare, so the next lease was cold. They now run Simlock's
  `doctor --fix`, which corrects stale records and keeps what the warm pool learned.
- Fixed (#92): a lease printed nothing between "Requesting" and "Granted", and always said "a new device
  can take a few minutes". The request line now says whether a warm spare is ready, and while Simlock
  queues or starts a device a progress line names the stage.
- Fixed (#94): right after a host started, the first lease failed with `DEVICE_UNAVAILABLE` "No Android
  device with serial …" (Simlock still listed the emulator from before the restart). The lease now asks
  again every 10 s for up to 2 min while the host boots a new one, and a final failure says the host
  just started instead of "check selectors".
### Phase 2b field run: cloud host setup and teardown (issues #76, #77, #78, #81, #83, #84, #93, #95)

Unit-tested or checked against a stand-in `gcloud`; not yet re-run on a cloud VM.

- Fixed (#77): `host-setup.sh` sources `~/.tapdance/env.sh` at the top of `~/.bashrc` (before Ubuntu's
  "not interactive" guard) and exports `ANDROID_SDK_ROOT`, so commands over ssh find `java`,
  `sdkmanager`, `adb` and `tapdance`. It turns off the Android CLI's usage metrics with `--no-metrics`
  in `~/.androidrc` (the new `sdkmanager` wrapper rejects the flag itself) and takes the line out again
  if `sdkmanager` stops working with it. New options: `--with-gh` installs the GitHub CLI, and
  `--sdk-packages "cmake;3.31.6"` installs extra SDK packages for builds on the host; without them it
  notes what installs from CI and host builds need. `sdkmanager` no longer reads the script's stdin
  under `curl | bash`.
- Fixed (#84): `host-setup.sh` offers the Tailscale login after installing Tapdance, so the clone and
  build no longer wait for someone to approve the machine. `check-kvm.sh` looks for the SDK in
  `~/Android/Sdk` (then `~/android-sdk`), says that "cannot open /dev/kvm" is expected before
  `host-setup.sh`, and the Terraform motd, `next_steps` and docs run it after the setup script.
- Fixed (#78): `host up` on Linux without a display or clipboard tool no longer offers the clipboard
  (it names the token file and `host token --show`); the security note mentions iOS simulators only on
  macOS, and the Tailscale ACL hint says "this machine" on Linux; the linger line prints once.
- Fixed (#81): `host status` reads Simlock's RAM budget from `capacity.ramBudget` (it showed "? of ? GB")
  and leaves it out when Simlock keeps none; iOS on Linux "needs a Mac"; the Android SDK is also found in
  `~/Android/Sdk` (it said "android not available" over ssh while an emulator ran), and the row says
  when the SDK cannot be found from this shell.
- Fixed (#93): `host up --idle-stop N` without `--label` keeps the host's only pairing instead of
  pairing the hostname; several pairings and no `--label` are refused; a run that would need pairing
  approval without a terminal is refused before any step changes anything, naming the existing pairing.
- Fixed (#95): the Linux guard service also logs to `~/.tapdance/worker/guard.log` (the user journal is
  not kept for OS Login accounts); installing the service moves a log over 5 MB to `guard.log.1`.
  Existing services are rewritten, and so restarted, at the next `host up`. `host status` says when an
  idle host will power off. The guard lets a token fetch the diagnostics of its own failed
  `lease.allocate` for 10 minutes (it refused them, so the client lost why the lease failed), until the
  lease id is granted to anyone.
- Fixed (#83): `gcp-leftovers.sh` keeps gcloud's warnings out of the rows (two warning lines were
  reported as "2 LEFT"), treats "Some requests did not succeed" as could-not-check, and says so when the
  project is already `DELETE_REQUESTED`. The runbook names the emulator process
  (`qemu-system-x86_64-headless`), uses `adb -P 5038` on the VM, and runs the leftovers check before the
  project is deleted; the Terraform README writes the script's path from the repository root.
- Added (#76): `infrastructure/scripts/revoke-run-credentials.sh`, which after a teardown asks before
  revoking the `gcloud` logins and application-default credentials and deleting the run's scratch
  `TAPDANCE_HOME`, then prints what is still credentialed and what only the owner can remove (the GitHub
  token, the Tailscale machine). The runbook and the tear-down docs gained that step and a note on the
  scope and lifetime of `gcloud` logins.

### Ideas from phone-harness

- A tap or a targeted `type` whose target is not found fails naming what is on screen (`On screen: "…"`,
  the full list in `details.visible`), so an agent can retarget without another inspect.
- Android `inspect` backs off (0.5, 1, 2 s) when agent-device's snapshot helper fails to start or to see
  an idle UI, then reads a plain uiautomator dump, marked `source: "uiautomator"` with a warning that
  its refs cannot be tapped. Was: one retry after 1.5 s, then an error.
- Not ported: an element-tree cache. A Tapdance tap reads nothing before it acts (agent-device resolves
  the target on the host in one call), so there is no repeated read to cache; `settle_ms` / `--no-settle`
  already trade the after-tap diff for speed.

### Phase 2c field run on the N2 VM (issues #100-#103)

Found on a Google Cloud N2 host (nested virtualization, Play image) with the agent on a Linux VPS; the
fixes are unit-tested with mocked devices, a scripted Simlock driver and a stand-in `dpkg-query`, and
not yet re-run on a host.

- Fixed (#101): the lease's settle wait ended on one calm 1.5 s reading, so devices went out at 91-96 %
  guest CPU without a notice. It now needs 3 calm intervals in a row, or a clearly falling load (handed
  out with a short notice). The bound stays at 90 s on purpose (the busy phase was 65-145 s after a
  release and about 5 min after a fresh boot, while commands still took 2-10 s); past it the notice
  gives the last and recent CPU and says commands can take 2-10 s each for a few more minutes. A wait
  that reported progress ends with a "Settled" line.
- Changed (#101, Simlock patch): before saving a device's clean baseline, Simlock runs Android's
  background app optimisation (`cmd package bg-dexopt-job`, at most 90 s) so restored copies do not
  redo it, then waits for a calm guest; both share the existing 120 s bound, which is not raised to the
  measured ~5 min because a new host's first lease would then pass the 330 s lease wait. Existing
  baselines are kept.
- Changed (#101): `scripts/host-setup.sh` installs the `google_apis` system image by default;
  `--play-store` (or `ANDROID_TAG=google_apis_playstore`) installs the Play image instead. Play images
  update Play services in the background after a boot, likely the main source of the extra guest CPU
  (not proven). A host set up earlier keeps its Play image; running the script again adds `google_apis`.
- Fixed (#102): the first `ui inspect` after every warm lease failed once inside the worker
  (`INSTRUMENTATION_FAILED`) and the retry added 2-3 s. The lease now reads the screen once after the
  settle wait and discards it (errors swallowed, bounded), so the agent's first inspect works at once.
- Fixed (#103): the Simlock patch logs the baseline settle every time: "Android guest settled before
  the clean baseline" (info) or the "still busy" warning, with the wait, the last CPU reading and the
  dexopt result, in `tapdance worker logs`.
- Changed (#101, #79): the lease's settle wait is short by default and configurable. An Android
  emulator lease still waits up to 90 s for boot complete and no "isn't responding" or crash dialog in
  front (a System UI ANR answered with Wait), and still warms the snapshot helper (#102); the CPU check
  after that now lasts at most `session.settleSeconds` (new, default 15, 0–300; `0` skips it;
  `TAPDANCE_SETTLE_SECONDS`, `device lease --settle <seconds>`, MCP `lease_device` `settle_seconds`,
  SDK `settleSeconds`), still ending early on 3 calm readings or a falling load. Was: up to 90 s of
  CPU checking, which on the N2 VM most leases would have spent in full although commands on the busy
  guest already took only 2-10 s. A device still busy goes out with a notice that says so and that
  commands may be slower for a few minutes.
- Fixed (#100): `host-setup.sh` installed the emulator's system libraries with `sudo` after the
  question without listing them (on a fresh machine the check needed the emulator first). It now checks
  the packages directly (`dpkg-query`, `rpm`, `pacman`), names them in the list and the sudo line, and
  installs them in the same package-manager call as git and unzip; a library still missing after the
  SDK install is named and asked for again.

### Field run 3 on the N2 VM (issues #104, #106-#109)

Found with a Linux VPS agent (CLI and MCP) and a Google Cloud N2 Android host; the fixes are
unit-tested with mocked clients and adb, and not yet re-run on a host.

- Fixed (#104): a host build from the CLI and one from MCP `build_app` of the same commit did not reuse
  each other. The build key hashed the request as sent: the CLI sent its defaults (`configuration`
  Debug, `gradleTask` assembleDebug, also on Android), MCP sent only what it was given. The key now
  holds the effective settings (the defaults filled in, only the platform's own options, `dir` in one
  spelling), and `app build` sends only options that differ from the defaults. Builds kept before this
  change get a new key once, so the first build of each commit after the update builds again.
- Fixed (#106): `logs --level fault` (MCP `get_logs level`) matched "fault" inside "default", which
  Android logs at every level (86 % of its matches on the N2 host). A logcat line's own level now
  decides: `error` keeps E and F lines, `fault` keeps F lines and E lines that say fatal or crash; an I
  line that mentions an exception is no longer an error. iOS lines keep the word match (NSLog writes
  errors at the default level), without "default".
- Fixed (#107): `launch_app` right after `clear_app_data` failed now and then with "Android helper could
  not launch the application" or "snapshot helper session request timed out" although the app
  started. On such a helper failure Tapdance looks at the focused window (0.5, 1.5, 3 s); when the app
  is in front the launch succeeds with a warning, otherwise it opens once more before it fails. A
  failed launch's hint says to check the screen instead of "Retry with --debug".
- Fixed (#108): hints passed on agent-device's own fixes, which name its CLI (`snapshot -i`,
  `find <text>`, `--debug`, its diagnostics log). Every sentence of an agent-device hint that names its
  syntax is now dropped (also from the hints of successful taps and waits); plain advice ("Narrow the
  query") is kept. `cli.test.ts` checks that code hints name only MCP tools that exist and no
  agent-device syntax, and runs agent-device's real hints through the error mapping.
- Fixed (#109): a refused upload install (`app install <path>`, MCP `install_app {path}`) still said
  `<appId>`. The package now comes from the caller's id, adb's "Existing package …" text or the
  uploaded APK's manifest, and is in `details.appId`; when nothing names it, the CLI hint says
  `tapdance app list` shows it instead of a placeholder. Other hints that printed a placeholder for a
  value they had (the repository URL in build-file hints, the app id for `logs --app`) now print it.

### Field run 4 on the N2 VM (issues #101, #110-#112)

From a re-run on the Google Cloud N2 host with the #105 Simlock patch; the changes are unit-tested
with fakes and not yet re-run on a host.

- Removed (#101, #79, Simlock patch): the wait for a calm guest before Simlock saves a device's clean
  baseline (at most 120 s) and the `cmd package bg-dexopt-job` step before it (at most 90 s). Measured
  on N2: the dexopt job timed out at 90 s both times, the wait gave up at 120 s every time with the
  guest still ~95 % busy, cold leases grew to 269-348 s (past the 330 s lease wait), and restores
  still replayed 61-90 s of busy guest. They cost time and gained nothing, so baseline capture is
  upstream 0.5.0's again. The #94 reconcile fix stays. The patch now only logs one info line at the
  capture, "Capturing the Android clean baseline", with the guest CPU then (one `/proc/stat` sample
  pair, about a second) (#103). Tapdance's own lease settle check is unchanged.
- Fixed (#110): after `git pull && pnpm install` with a new Simlock patch, the worker's systemd unit
  (or launchd plist) still started the old `simlock@…_patch_hash=…` folder, through `worker restart`
  and `host up` too; only `worker install --service` rewrote it. `worker start`/`restart`, `host up`
  (a running worker, when no lease runs; it warns otherwise) and `host resume` now compare the service
  with this Tapdance's Simlock and Node and, when it is stale, start the worker with Simlock's
  `daemon install` (rewrite and reload) instead, saying so. Warm-spare settings are untouched and the
  device records are checked with `doctor --fix` only, so learned spares are kept. `worker install
  --service` skips its second `daemon install` when the service is already current.
- Fixed (#111): `worker logs` printed Simlock's last 100 lines only, so the documented "clean
  baseline" check found nothing after one lease. It now reads `daemon.log` (and `daemon.log.1`)
  itself and takes `-n/--lines` (up to 5000), `--contains` and `--since`.
- Fixed (#112): on a host with both the Play image and `google_apis`, a lease without `--image-tag`
  got the old Play device, `--image-tag google_apis` alone got Pixel 9 / API 35 instead of the host's
  default, and "a warm spare is ready" was said for a spare of another kind. A lease without a tag now
  asks for `google_apis` when the host also has a Play image (and says so), a tag without `--os` asks
  for the host's default API level when the tag is installed there, the spare line counts only spares
  of the requested tag, and `host warm` shows each Android spare's tag.

### Field run 2d on the N2 VM: faster lease after a release (issues #101, #102)

A lease right after a release took 35-43 s on the N2 VM (restore 3.5 s, attaching automation on the
busy guest 8.5-15 s, the CPU check 15-16 s, the snapshot-helper warm-up 6-9 s). Unit-tested with mocked
devices, a mocked provider and a fake clock; not yet re-run on a host.

- Changed (#101): early busy exit. With `session.settleSeconds` at 15 or less (the default), a guest
  whose first 3 CPU readings are all 80 % or more and not falling is handed out at once, after about
  5 s, with the "still busy" notice; on the VM such a guest stayed busy for another 55-60 s, so the rest
  of the check only delayed the same notice. A larger value (`--settle`, `settle_seconds`) still waits.
  Boot-complete and dialog checks still run first.
- Changed (#102): the snapshot-helper warm-up runs alongside the CPU check, from the first probe that
  reads the guest booted with nothing in front, instead of after it; the whole warm-up is bounded at
  15 s (was 20 s per read) and a dialog is answered only after it. Its first read still fails on a
  restored spare and the retry stays.
- Fixed: the lease's notices are printed as soon as the settle wait ends (they came 6-9 s late, after
  the warm-up), `host up`'s self-test prints them instead of dropping them, and attaching automation or
  the warm-up print a "Still …" line every 5 s. SDK `lease` takes `onNotice`.
- Expected for a lease right after a release: about 3.5 + 8.5-15 + 6-9 s, roughly 18-28 s (not yet
  measured).

### Field run 2e on the N2 VM (issues #117, #118)

Unit-tested with a fake Simlock status, a fake runner and fake files; not yet re-run on a host.

- Fixed (#117): a lease right after a release said "no spare is ready, so a device has to start: this
  can take a few minutes" while the emulator was restored from its snapshot (Granted in about 4 s,
  Ready in about 21 s). The request line now reads the host's devices in Simlock's status: a released
  device being reclaimed says it is being restored from its snapshot (usually seconds on Android, under
  a minute for an iOS erase and boot), a free device of that kind counts as a ready spare, a stopped
  one says "usually under a minute, longer on a first boot", and only a host with no device of the
  requested kind says a first boot can take a few minutes. Without device information (Simlock's
  status cannot be read, or a worker guard, which lists only the client's own devices) the line says
  "usually under a minute, longer on a first boot". A queued request waiting on a reclaim says so.
- Fixed (#118): over a non-interactive ssh command, `worker restart` with a stale login service (#110)
  failed in Simlock's `daemon install` ("Failed to connect to bus: No medium found"), which had
  already removed the old unit; a second `worker restart` then said "Restarted" with no login service
  and no warning. Every Tapdance call to Simlock (start, stop, install, uninstall) and to
  `systemctl --user` for the guard now points at the user manager's bus first. Before a stale service
  is installed again, `worker start`/`restart`, `host up` and `host resume` set up the user manager
  and check that `systemctl --user` answers, and refuse with nothing changed when it does not. If the
  install still fails, the worker is started without the service, the command says the login service
  is now missing and prints `tapdance worker install --service`, and exits non-zero (10,
  `HOST_CHECK_FAILED`); later `worker start`, `worker restart` and `host status` warn until a service
  is installed again.

### Stage 3: iOS on a rented Scaleway Mac mini (issues #121, #122)

Run on a Scaleway Mac mini M1-M (8 GB, macOS 27.2, Xcode 27.0) set up over ssh, driven from a Mac
over Tailscale ([evidence](docs/testing/evidence/2026-11-06-rented-mac-ios.md)).

- Added: `host-setup.sh --ios-only` (no Android SDK, emulator or image; checks and fixes the Xcode
  licence, first launch and an iOS runtime) and `--android-build-sdk` (command-line tools and
  platform-tools only, for Kotlin Multiplatform builds of the iOS app).
- Added: `infrastructure/scripts/macos-auto-login.sh`, automatic login over ssh (writes `/etc/kcpassword`
  and `autoLoginUser`; `sysadminctl -autologin` failed on macOS 27.2 with error 22), so the worker and
  guard LaunchAgents start after a reboot with nobody at the screen.
- Added: `infrastructure/scripts/scaleway-leftovers.sh`, a read-only check for Mac minis and Private
  Networks left in a Scaleway account; `docs/testing/field-test-rented-mac-ios.md`; iOS field-test
  checklists (`PLATFORM=ios` in `cli-checklist.sh`, `mcp-ios-base/app/build.json`).
- Changed: on macOS `host-setup.sh` installs Tailscale as the open-source `tailscaled` system daemon
  (MacPorts, else Homebrew) instead of the Tailscale app, which needs someone logged in; `gh` from
  MacPorts when there is no Homebrew; `~/.tapdance/env.sh` is sourced from `~/.zshenv` and puts
  MacPorts and Homebrew on `PATH`, so `ssh mac 'tapdance …'` works, and it is rewritten on every run.
- Fixed: `connect` and `doctor` exited 10 against an iOS-only Mac (Android without an SDK is a warning
  there; a host with an SDK that offers no Android still fails, #39). `devices` says the same.
- Fixed: a lease refused with Simlock's internal error ("simctl list … timed out" on an overloaded 8 GB
  Mac) was `USAGE`; it is `PROVIDER_UNAVAILABLE`, retryable, with a hint for small Macs. agent-device's
  "Daemon request timed out" is `PROVIDER_UNREACHABLE`, retryable.
- Fixed: `host up` over ssh no longer offers to copy the token to the clipboard (the host's).
- Added: a build that fails with Gradle's "SDK location not found" names `--android-build-sdk`.
- Docs: `docs/ios/scaleway-mac.md` rewritten around `host-setup.sh` → `host up` → `connect` (offers,
  the 24-hour minimum, automatic deletion, auto-login, 8 GB: no warm spare); troubleshooting for
  rented Macs.

### Not yet proven

A gateway across two machines over a real network, Google's Android CLI on a remote host, a full
device loop over Streamable HTTP MCP, installing a custom app through a gateway, MacStadium and AWS EC2
Mac, a 16 GB rented Mac, and a coding agent as the MCP client.
See [STATUS.md](STATUS.md).

[0.1.0]: https://github.com/mirzemehdi/tapdance
