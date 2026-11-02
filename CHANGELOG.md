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

### Not yet proven

Android end to end, two machines over a real network, Google Cloud N2, cloud Macs, AXe, Google's Android CLI,
a full device loop over Streamable HTTP MCP, installing a custom app through a gateway, the guard's
LaunchAgent / systemd unit, and `host up` / `connect`.
See [STATUS.md](STATUS.md).

[0.1.0]: https://github.com/mirzemehdi/tapdance
