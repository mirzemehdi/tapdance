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
- `--json` output, results on stdout and progress on stderr, and stable exit codes (2 to 11).
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

### Not yet proven

Android end to end, two machines over a real network, Google Cloud N2, cloud Macs, AXe, Google's Android CLI,
a full device loop over Streamable HTTP MCP, installing a custom app through a gateway, the guard's
LaunchAgent / systemd unit, and `host up` / `connect`.
See [STATUS.md](STATUS.md).

[0.1.0]: https://github.com/tapdance-dev/tapdance
