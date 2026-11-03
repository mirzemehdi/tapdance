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
  [Simlock](https://github.com/callstackincubator/simlock) 0.4.0 and
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

### Not yet proven

Android end to end, two machines over a real network, Google Cloud N2, cloud Macs, AXe, Google's Android CLI,
a full device loop over Streamable HTTP MCP, installing a custom app through a gateway, the guard's
LaunchAgent / systemd unit, and `host up` / `connect`.
See [STATUS.md](STATUS.md).

[0.1.0]: https://github.com/mirzemehdi/tapdance
