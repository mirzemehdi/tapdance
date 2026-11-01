# Tapdance status

What is built, what was proven on real hardware, and what is missing — one row per requirement in
[PRODUCT.md](PRODUCT.md). Update the row in the same change that changes the behaviour.

| Mark | Meaning |
| --- | --- |
| ✅ | Done and exercised on real devices/tools (evidence linked) |
| 🧪 | Implemented; covered by unit or mocked tests only |
| 🟡 | Partial, or implemented but not yet exercised for real |
| ⬜ | Not started |
| ⛔ | Blocked (reason given) |
| ❓ | Needs a product decision |

Last updated: 2026-11-01. Test host for "✅": MacBook Pro M1 Pro, 16 GB, macOS 26.5, Xcode 26.5, Simlock
0.4.0, agent-device 0.21.35, iOS 18.5 and 26.5 simulators (iPhone 16), Android 34 emulators (Pixel 8,
arm64 images, one with Google Play), AXe 1.8.0, Google's Android CLI 1.1.16717390. Evidence: [docs/testing/evidence/](docs/testing/evidence/).

## Headline

- **Working for real, on one Mac:** local worker; lease → launch → inspect → tap by text/ref → back →
  swipe → wait_for → alert check → screenshot → MP4 recording → logs/crash logs → release, through
  both the CLI and the MCP server (stdio); background keepalive; browser viewer stream + input +
  human take-over; `asc` pass-through. **Android too:** the same loop on Android 34 emulators, a custom
  APK, a Google Play system image, the viewer, and Google's Android CLI on the leased emulator
  ([evidence](docs/testing/evidence/2026-11-01-android.md)). **AXe** as the iOS UI backend, with a
  custom app's sign-in flow ([evidence](docs/testing/evidence/2026-11-01-axe.md)).
- **Proven on one machine through a real gateway:** worker joined over its outbound uplink; CLI, MCP and
  the viewer (rendered in a real browser) all worked through the gateway
  ([evidence](docs/testing/evidence/2026-11-01-gateway-single-host.md)).
- **Built but not yet proven on real infrastructure:** a real network between two machines (gateway on a
  VPS, laptop or N2 worker), Android on a Linux/KVM host, the dedicated macOS worker account.
- **Personal-Mac protection:** device-only mode (`tapdance worker guard`) passed its malicious-client
  unit tests (15 at the time of the run) and ran the full MCP loop on a real simulator
  ([evidence](docs/testing/evidence/2026-11-01-worker-guard.md)); `worker login` now refuses unless the
  owner accepts that a gateway gets command execution (`--accept-gateway-exec`).
- **Not yet run from a real agent:** every MCP run so far used a scripted MCP client; Claude Code,
  Codex and Cursor themselves have not driven Tapdance in a recorded run.
- **Not built:** remote execution targets for external tools (needs a worker-side executor),
  Windows workers, cloud-Mac provisioning integrations, hosted cloud, most of the phase 2–5 lifecycle
  features in PRODUCT.md §19 (test-framework envelope, evidence packages, replay, visual regression,
  environment controls, builds/release orchestration).

## By requirement

### Vision and model

| ID | | Notes |
| --- | --- | --- |
| P-01 | 🟡 | iOS loop ✅ on a real simulator ([evidence](docs/testing/evidence/2026-11-01-local-ios.md)). Android loop ✅ on real emulators ([evidence](docs/testing/evidence/2026-11-01-android.md)). No recorded run from a real agent (Claude Code/Codex/Cursor) yet; Linux/KVM and remote Android not run. |
| P-02 | ✅ | CLI and MCP verified for real; SDK (`@tapdance/sdk`) is what both use. |
| P-03 | 🟡 | Local ✅. Self-hosted implemented, not run across machines. |
| P-04 | ✅ | No billing, dashboard or hosted fleet code. |
| P-05 | 🧪 | `DeviceProvider` contract; `provider: "cloud"` reserved and refused with NOT_SUPPORTED. |
| P-06 | 🟡 | Same tools for local and remote by construction; remote not yet exercised. |
| P-07 | 🟡 | Architecture supports it (gateway needs no KVM); not yet proven (Q-06). |

### Reuse

| ID | | Notes |
| --- | --- | --- |
| R-01 | ✅ | Simlock audited (source + docs + live spike) — [ADR](docs/architecture-decision.md). |
| R-02 | ✅ | `docs/architecture-decision.md`. |
| R-03 | ✅ | [NOTICE.md](NOTICE.md); attribution comments where formats/ideas are used (Simlock framing, serve-sim input, Loupe hand-off, AXe, simslim). No upstream code copied. |
| R-04 | ✅ | Followed for Simlock, agent-device, AXe, asc, Loupe, simslim, Android CLI, fastlane. |
| R-05 | 🟡 | agent-device used via its typed Node API. Its own MCP server is not reused: Tapdance's MCP adds session scoping, leasing and viewer hand-off (reason in ADR). |
| R-06 | 🟡 | Loupe and simslim cloned and read. DeviceDeck reviewed from public descriptions only (not cloned). |
| R-07 | ⬜ | Ongoing practice. |

### Architecture

| ID | | Notes |
| --- | --- | --- |
| A-01 | ✅ | TS 7, pnpm 10, MCP SDK 1.32.2, Zod 4, Vitest 5, strict mode. No database. |
| A-02 | ✅ | `packages/{core,provider-simlock,sdk,mcp,cli}`. |
| A-03 | 🧪 | Full contract incl. `waitFor`, `alert`, `viewer`; `FakeProvider` for tests. |
| A-04 | ✅ | No cloud SDKs in `packages/`. |
| A-05 | ✅ | Delegated to Simlock's gateway/worker split. |
| A-06 | ⬜ | Deferred on purpose (I14 puts manual Mac provisioning first). |
| A-07 | 🧪 | `packages/sdk/src/tools.ts`: metadata only (asc, android, axe, maestro, fastlane, xcodebuild). |
| A-08 | ✅ | Basis: five small packages and two processes (CLI, MCP server); no Kubernetes, no services of its own, no database. |

### Deployment modes

| ID | | Notes |
| --- | --- | --- |
| M-01 | ✅ | iOS ([evidence](docs/testing/evidence/2026-11-01-local-ios.md)) and Android ([evidence](docs/testing/evidence/2026-11-01-android.md)) on the same Mac. |
| M-02 | 🟡 | Gateway + joined worker + self-hosted provider ✅ on one Mac ([evidence](docs/testing/evidence/2026-11-01-gateway-single-host.md)). Two machines over a real network pending (Q-06). |
| M-03 | 🟡 | Same code path as M-02; N2 Terraform/scripts in `infrastructure/`. Not provisioned. |
| M-04 | ⬜ | By design (future). |
| M-05 | 🟡 | `tapdance gateway setup` ✅ on macOS; not yet run on a Linux VPS. |

### CLI

| ID | | Notes |
| --- | --- | --- |
| C-01 | ✅ | All listed commands plus `worker guard start/pair/tokens/revoke/policy/audit`, `ui wait`, `ui alert`, `ui key`, `devices install`, `artifacts`, `view`, `report`, `tools`, `tool`, `asc`, `android`, `simlock` ([evidence](docs/testing/evidence/2026-11-01-local-ios.md)). `worker connect` folded into `worker login`/`start`. |
| C-02 | 🧪 | `--json`, stdout/stderr split, exit codes (2 usage, 3 lease, 4 provider, 5 auth, 6 capacity, 7 device, 8 unsupported, 9 timeout, 10 host, 11 human-held); tested in `packages/cli/src/cli.test.ts`. Seen for real only in part (`LEASE_ALREADY_HELD` exit 3, `HUMAN_HELD` in the [evidence](docs/testing/evidence/2026-11-01-local-ios.md)). |
| C-03 | ✅ | No command takes a device id; session record + lock. |
| C-04 | 🧪 | Detached keepalive spawned on lease and exited after release on a real device ([evidence](docs/testing/evidence/2026-11-01-local-ios.md)); renewal and idle release (30 min) not observed on a device, tested in `packages/sdk/src/tapdance.test.ts`. `--hold`. |
| C-05 | 🟡 | doctor covers host SDKs/Xcode/KVM (local), Simlock reachability, token role, capabilities, capacity, version, workers (operator token). KVM state of *remote* workers is not reported (Simlock does not expose it). |
| C-06 | ✅ | Device/Platform/Provider/Worker/Endpoint/Status/Lease block. |
| C-07 | 🟡 | Interactive `init` written; prompts not exercised in a TTY test. |

### MCP

| ID | | Notes |
| --- | --- | --- |
| S-01 | 🟡 | stdio ✅ (full loop, [evidence](docs/testing/evidence/2026-11-01-local-ios.md)). Streamable HTTP: bearer check and read-only calls tried by hand, not recorded; full device loop not run. |
| S-02 | 🟡 | All 19 exist, plus `wait_for`, `handle_alert`, `list_tools`, `execute_tool`, `list_apps`. Called over MCP on a real device: `lease_device`, `get_device_status`, `install_app` (through the guard), `launch_app`, `inspect_screen`, `tap`, `swipe`, `press_key`, `wait_for`, `handle_alert get`, `take_screenshot`, `start_recording`, `stop_recording`, `get_logs`, `get_crash_logs`, `get_test_artifacts`, `list_tools`, `execute_tool`, `release_device` ([evidence](docs/testing/evidence/2026-11-01-local-ios.md), [guard](docs/testing/evidence/2026-11-01-worker-guard.md)). Not called over MCP on a device: `stop_app`, `type_text`, `list_devices`, `list_workers`, `list_apps`. |
| S-03 | 🧪 | Strict Zod inputs (unknown keys refused); `packages/mcp/src/mcp.test.ts` checks every tool. |
| S-04 | ✅ | Settle diffs, element lists, artifact refs, screenshots inline as images, logs saved as artifacts. |
| S-05 | ✅ | No MCP tool or CLI command takes a device id; the real MCP loop ran without one ([evidence](docs/testing/evidence/2026-11-01-local-ios.md)). Handle checks unit-tested in `packages/sdk/src/tapdance.test.ts`. |
| S-06 | ✅ | No raw shell/adb/simctl tool; operator token never loaded for agents. |
| S-07 | ✅ | MCP loop passed through a real gateway (single host). |

### Platforms

| ID | | Notes |
| --- | --- | --- |
| D-01 | 🟡 | ✅ on macOS: Android 34 emulators created and booted by Simlock, CLI and MCP loops, custom APK, Google Play image ([evidence](docs/testing/evidence/2026-11-01-android.md)). Linux worker not run (D-02). |
| D-02 | 🧪 | CPU flags, `/dev/kvm` access, `kvm-ok`, `emulator -accel-check`; worker install refuses to pretend. Needs a Linux run. |
| D-03 | ✅ | macOS + Xcode + Simulator: discovery, boot, `.app` install, launch, interaction, screenshots, recording, logs ([evidence](docs/testing/evidence/2026-11-01-local-ios.md)). |
| D-04 | 🧪 | `.ipa` refused for simulators with a build hint; `.aab` refused. |
| D-05 | 🟡 | Simlock creates its own emulators from installed images and never hands out the developer's AVDs (deliberate; protects personal devices). `worker check` reports SDK, images, AVDs, running emulators. Uninstall / clear-data / explicit wipe are not exposed yet. |
| D-06 | 🟡 | Via Simlock (create/boot/wipe its own simulators). Physical-device and reset-on-request paths untested. |
| D-07 | ⛔ | Windows workers: Simlock supports macOS and Linux only. Windows works as a control machine (CLI/MCP). |
| D-08 | 🟡 | See D-05. |
| D-09 | 🧪 | `.aab` → universal APK with bundletool before upload; unit-tested with a fake bundletool (`packages/sdk/src/tools.test.ts`). No real bundletool run. |
| D-10 | 🟡 | Device profiles on Android (a read-only boot of a prepared AVD) and iOS (a clone of a template simulator per lease) created and leased on one Mac; a lease's changes were discarded on both ([evidence](docs/testing/evidence/2026-11-01-device-state-and-profiles.md)). Not yet: a real Google sign-in and Play purchase, and profiles through the guard or a gateway (Simlock enrols only USB phones; next idea: turn a profile into a custom system image Simlock can lease by tag). |

### Interaction backends

| ID | | Notes |
| --- | --- | --- |
| U-01 | ✅ | text/id/ref/selector targets; coordinates as fallback. |
| U-02 | ✅ | AXe backend (`ios.uiBackend: "axe"`): lease, install, launch, inspect, type into fields found by text, tap, `ui wait`, screenshot, MP4 ([evidence](docs/testing/evidence/2026-11-01-axe.md)). AXe reads only Xcode's default device set, so the worker needs `drivers.ios.deviceSet default`; `worker install --ios-backend axe` sets it and refuses while Simlock's own set still holds simulators. Works only when Tapdance runs on the Mac hosting the simulator.
| U-03 | ❓ | `ios_*` tool names vs a platform-independent interface. Current choice: one set of platform-neutral tools whose iOS backend can be AXe. Adding `ios_*` aliases is cheap if wanted. |
| U-04 | 🟡 | `tapdance android -- …` / `execute_tool` run Google's Android CLI 1.1.16717390 against the leased emulator ([evidence](docs/testing/evidence/2026-11-01-android.md)). agent-device stays the default Android UI backend; the Android CLI is not yet a backend of its own. |
| U-05 | ✅ | The Android CLI ignores `ANDROID_SERIAL`, so Tapdance appends `--device=<leased serial>` to subcommands whose `--help` lists `--device` and refuses a caller-chosen `--device`; Simlock's adb port is injected and inherited selectors are stripped. Unit tests in `packages/sdk/src/tools.test.ts`; `layout --flat` ran on the leased emulator ([evidence](docs/testing/evidence/2026-11-01-android.md)). |
| U-06 | 🟡 | Maestro registered (lease-scoped). XCTest/Espresso orchestration not started. |
| U-07 | ✅ | One allowlist (`device-commands.ts`) used by the provider and checked by the guard (`guard.test.ts` test 14: every builder's output passes, injection attempts do not). Ran through a real guard ([evidence](docs/testing/evidence/2026-11-01-device-state-and-profiles.md)). External tools on a remote lease fail fast and name these tools. |
| U-08 | ✅ | uninstall, clear data, keychain reset, launch arguments (iOS), intents (Android) on real devices ([evidence](docs/testing/evidence/2026-11-01-device-state-and-profiles.md)). |
| U-09 | ✅ | Settings on Android and iOS ([evidence](docs/testing/evidence/2026-11-01-device-state-and-profiles.md)); bluetooth, mobile data, biometrics and location not exercised. |
| U-10 | ✅ | Android shared storage push/pull locally and through the guard; iOS Photos and app container locally ([evidence](docs/testing/evidence/2026-11-01-device-state-and-profiles.md)). Android app-sandbox push/pull not exercised (needs a debuggable app using `run-as`). |
| U-11 | 🟡 | Android post/list/open/close and an iOS push payload ([evidence](docs/testing/evidence/2026-11-01-device-state-and-profiles.md)). Reading iOS Notification Center is by `inspect_screen` only. |
| U-12 | 🟡 | `perf frames` and `perf memory` on Android; `perf memory` on iOS. iOS frame health is not available on simulators (agent-device supports it on real iPhones only) and says so ([evidence](docs/testing/evidence/2026-11-01-device-state-and-profiles.md)). Audio and MIDI are left to `device_shell` (U-14). |
| U-14 | ✅ | `tapdance device shell` on a real Pixel 8: getprop, `wm density`, a pipe inside the emulator, stdin; refused on iOS ([evidence](docs/testing/evidence/2026-11-01-device-state-and-profiles.md)). Guard allow/deny incl. phones and the off switch: `guard.test.ts` 14–15. |
| U-13 | ✅ | A real round trip: an SDK process waited in `requestHuman` on a leased iPhone 16 until `tapdance device done` from another process answered it (5 s) ([evidence](docs/testing/evidence/2026-11-01-device-state-and-profiles.md)). The viewer's Hand back answers it the same way (unit-tested). |

### Workers and gateway

| ID | | Notes |
| --- | --- | --- |
| W-01 | 🟡 | `worker login` requires `--accept-gateway-exec`. Outbound authenticated uplink ✅ on one host (token-authenticated; a bad token gave 401). `ws://` refused to public hosts. TLS/real network untested. |
| W-02 | 🟡 | Per-worker join tokens minted by `gateway setup` / `gateway token`, read from stdin. The worker does not request its own token (a person carries it). |
| W-03 | 🟡 | Simlock's behaviour; Tapdance maps `WORKER_UNREACHABLE` (and agent-device's "not connected to the gateway" reply) to retryable `WORKER_OFFLINE` and keeps leases through brief outages; the keepalive keeps retrying until the lease would expire. Unit-tested only (`provider.test.ts`, `tapdance.test.ts`); no real outage tested. |
| W-04 | 🟡 | TTL + keepalive + idle release + owner-scoped MCP shutdown; per-session lock. Interrupted-allocation cleanup relies on Simlock cancelling on disconnect. |
| W-05 | 🟡 | `gateway setup` ✅ on macOS (tokens, capabilities, config); Caddy/Tailscale steps untested. |
| W-06 | 🟡 | See C-05. |
| W-07 | 🧪 | `tapdance host up/status/down`, `tapdance connect`, `scripts/host-setup.sh` and `scripts/host-setup.ps1` written. Unit tests cover the pure parts only (`packages/cli/src/host/host.test.ts`: Tailscale status parsing, final block, step-failure formatting, Windows refusal, cloud-VM detection, MCP snippets). `connect` was run once against an unreachable endpoint in a scratch home (config, mode-600 credentials, doctor failure, snippets). `host up` has **not** been run on any machine; Tailscale, the self-test lease through the guard, and two machines are unproven. The setup script is checked with `bash -n` only. |

### Browser viewer

| ID | | Notes |
| --- | --- | --- |
| V-01 | ✅ | `tapdance view`: real H.264 frames (meta, avcC, keyframes) proxied from Simlock's lease stream and decoded in the browser with WebCodecs ([evidence](docs/testing/evidence/2026-11-01-local-ios.md)). |
| V-02 | 🟡 | stream, tap, status ✅ ([evidence](docs/testing/evidence/2026-11-01-gateway-single-host.md)); Home, tap, Screenshot and Start/Stop recording buttons ✅ on Android ([evidence](docs/testing/evidence/2026-11-01-android.md)); second computer untested. Back/Apps are Android-only (disabled for iOS). |
| V-03 | ✅ | A touch sets a human hold; the agent's next tap failed with `HUMAN_HELD` (retryable). Take over / Hand back. Advisory: enforced by Tapdance, not by Simlock. |
| V-04 | ✅ | Loopback-only, one-time key in the URL fragment, HttpOnly cookie, Host/Origin checks; token stays server-side. |
| V-05 | ✅ | Simlock console is view-only/operator-only; lease stream + input socket used instead (ADR). |

### Artifacts

| ID | | Notes |
| --- | --- | --- |
| F-01 | 🟡 | ✅ local: a custom simulator `.app` (examples/ios-demo) and a custom APK (examples/android-demo) uploaded, installed, launched, filled, tapped, verified with `ui wait`, screenshot returned ([iOS](docs/testing/evidence/2026-11-01-local-ios.md), [Android](docs/testing/evidence/2026-11-01-android.md)). A custom-app install through a gateway was not run. |
| F-02 | ✅ | `LocalArtifactStore` + manifest per session; `ArtifactStore` interface. |
| F-03 | ⬜ | Uploads/downloads pass through the gateway (agent-device proxy). |
| F-04 | 🟡 | Per-session directories on the user's disk; viewer serves only manifest entries. |

### External tools

| ID | | Notes |
| --- | --- | --- |
| E-01 | 🧪 | `runTool`: argument arrays, approved env, timeouts, output caps with full output saved, exit codes. Real `asc --version` and `asc apps list` ran ([evidence](docs/testing/evidence/2026-11-01-local-ios.md)); timeouts and output caps are unit-tested only (`packages/mcp/src/mcp.test.ts`, `packages/sdk/src/tools.test.ts`). |
| E-02 | ✅ | `tools list/doctor/versions`, `tool <name> --`, `asc --`, `android --` ([evidence](docs/testing/evidence/2026-11-01-local-ios.md)). Install guidance is part of `tools doctor`; no separate `install-guidance` command. |
| E-03 | 🧪 | `execute_tool` / `list_tools`; a never-seen subcommand forwarded unchanged (mocked executable test). |
| E-04 | ⛔ | Control machine only. Remote targets need a worker-side executor; Simlock's exec allows only adb/simctl/devicectl. Options in the ADR. |
| E-05 | 🟡 | Agents run `asc` with `ASC_READ_ONLY=1` (asc's own guard) unless `tools.allowMutation` lists asc and the call asks. `asc install-skills` not automated. |
| E-06 | 🟡 | fastlane registered; agents need explicit authorization (no read-only mode). Not planned for iOS (`asc` covers App Store Connect). For Google Play, gradle-play-publisher or the Play Developer API come first; fastlane `supply` only for teams already on fastlane ([ROADMAP.md](ROADMAP.md)). |
| E-07 | ⬜ | Android CLI install on workers and its skills/plugins not automated. |
| E-08 | 🟡 | Detection and versions; no update command; compatibility matrix in [docs/compatibility.md](docs/compatibility.md). |
| E-09 | 🧪 | Parent env not forwarded; PEM keys and tokens redacted. |
| E-10 | ⬜ | Docs only. |

### Security

| ID | | Notes |
| --- | --- | --- |
| X-01 | 🧪 | Session-scoped leases, one session cannot release another's, TTL and renewal: `packages/sdk/src/tapdance.test.ts`; per-client lease ownership in the guard: `packages/cli/src/guard/guard.test.ts`. On a device only `LEASE_ALREADY_HELD` was seen. |
| X-02 | 🟡 | Real: the viewer refused requests before login, and a gateway uplink with a bad token got 401 ([evidence](docs/testing/evidence/2026-11-01-local-ios.md), [gateway](docs/testing/evidence/2026-11-01-gateway-single-host.md)). Redaction, tokens refused in config files and the operator token never reaching agents are unit-tested (`packages/core/src/core.test.ts`, `packages/mcp/src/mcp.test.ts`). |
| X-03 | 🟡 | App paths validated and confined for MCP; no wipe/reset operation exposed. |
| X-04 | 🟡 | TLS via a proxy or a private network; Simlock tokens are long-lived (not short-lived session credentials). |
| X-05 | ⬜ | Documented guidance only. |
| X-06 | 🧪 | Approved executables, argument arrays, timeouts, protected env, workspace-confined `cwd`: `packages/mcp/src/mcp.test.ts` (MOCKED executable) and `packages/sdk/src/tools.test.ts`. |
| X-07 | ✅ | Stated in README, ADR and worker-security docs. |
| X-08 | 🟡 | Device-only mode: a local policy with per-capability switches, owner-approved pairing and local revocation (`worker guard`). No interactive per-operation prompt. |

### Infrastructure and docs

| ID | | Notes |
| --- | --- | --- |
| G-01 | 🟡 | Terraform + scripts written; nothing provisioned (needs your GCP project). |
| G-02 | 🟡 | As G-01. Scripts syntax-checked only; the install script prints the join command for a person to run (token never in a script) and boots a test emulator only with `--boot-test`. |
| G-03 | 🟡 | Written; cost figures are estimates to re-check against the GCP calculator. |
| G-04 | 🟡 | Written; untested procedures. |
| G-05 | 🟡 | Written; Scaleway/MacStadium/AWS steps not exercised. |
| G-06 | 🟡 | Docs only. |
| O-01 | ✅ | Basis: every listed document exists — README, installation, quick start, CLI reference, MCP, Claude Code/Codex/Cursor pages, Android and iOS pages, self-hosted guides, ADR, CONTRIBUTING, SECURITY, MIT LICENSE. `cli.test.ts` checks that every command, MCP tool and config key is documented. |
| O-02 | ✅ | `CLAUDE.md`, `AGENTS.md`; a test fails when code names a `tapdance` command that does not exist. |
| O-03 | ✅ | This file and PRODUCT.md. |
| O-04 | ✅ | `.github/ISSUE_TEMPLATE/*`, `tapdance report`, [field-testing runbook](docs/testing/field-testing.md). |

### Testing and proof

| ID | | Notes |
| --- | --- | --- |
| Q-01 | 🧪 | Unit tests in `packages/core/src/core.test.ts`, `packages/provider-simlock/src/provider.test.ts`, `packages/sdk/src/tapdance.test.ts`, `packages/mcp/src/mcp.test.ts`, `packages/cli/src/cli.test.ts` and `packages/cli/src/guard/guard.test.ts`; the count is whatever `pnpm test` reports. |
| Q-02 | 🟡 | Real: Simlock + iOS and Android through MCP stdio (`pnpm test:integration` with `TAPDANCE_IT_PLATFORM=ios` or `android`, each with a custom app). Mocked and labelled: provider fakes, tool executables. |
| Q-03 | 🟡 | Procedures in `docs/testing/e2e-procedures.md`; only the macOS-iOS one has been run. |
| Q-04 | ✅ | Every ✅ here links evidence or states a one-line basis for a non-device requirement; results from fakes are 🧪. |
| Q-05 | ⛔ | Needs a GCP project with billing and nested virtualization allowed. |
| Q-06 | 🟡 | Same flow ✅ on one host through a real gateway; the two-machine run needs a non-KVM VPS (the test Mac can be the laptop). |
| Q-07 | ⛔ | Needs Q-05/Q-06 infrastructure. |
| Q-08 | ⛔ | Needs a VPS; the test Mac can be the Mac worker. |
| Q-09 | ✅ | AXe sign-in flow on the demo app ([evidence](docs/testing/evidence/2026-11-01-axe.md)). |
| Q-10 | ⛔ | Needs Q-05 (the Android CLI part is proven locally, U-05). |
| Q-11 | 🟡 | `pnpm test` is run during development and the build is kept green; there is no CI yet. |

### Protecting personal Macs

| ID | | Notes |
| --- | --- | --- |
| H-01 | 🟡 | Device-only mode treats the control side as untrusted; joining a gateway (which does give it exec) now needs `--accept-gateway-exec`. |
| H-02 | ✅ | `worker guard`: route allowlist, agent-device command allowlist, exact exec argument lists, no caller paths except the client-side output paths agent-device already refuses to honour; real MCP loop passed through it ([evidence](docs/testing/evidence/2026-11-01-worker-guard.md)). |
| H-03 | 🟡 | Guard refuses root and admin accounts (override flag); `infrastructure/scripts/macos-create-worker-account.sh` written, **untested**. `tapdance worker guard install` / `uninstall` write an unprivileged LaunchAgent (`dev.tapdance.guard`, RunAtLoad + KeepAlive) or a systemd user unit, with the same refusals as `guard start`; the generated files and the launchctl/systemctl calls are unit-tested against fakes (`packages/cli/src/guard/service.test.ts`), **never installed on a real machine**. |
| H-04 | 🧪 | `~/.tapdance/worker/policy.json`, refused if group/other-writable; no remote route to it. One profile (`device-only`). |
| H-05 | 🟡 | Local `guard pair` (TTY required unless TAPDANCE_GUARD_PAIR_NONINTERACTIVE is set), hashed tokens, expiry, immediate revocation, per-client lease ownership. No mutual TLS, replay protection or per-session short-lived tokens (Tailscale provides transport security). |
| H-06 | 🟡 | Per-client lease isolation and filtered status; uploads must name the client's own lease, and upload and artifact ids are bound to the client that created them (a full MCP loop passed through a real guard with no denials: [evidence](docs/testing/evidence/2026-11-01-device-state-and-profiles.md)). Per-session staging directories and quotas on the Mac are agent-device's, not enforced by Tapdance. |
| H-07 | 🟡 | Session cap, lease TTL cap, upload size cap. No recording-duration or disk quota. |
| H-08 | 🟡 | Device-only only; builds refused. Approved-build and VM-isolated builds not started. |
| H-09 | ⬜ | Documentation only; AXe not installed on the test Mac. |
| H-10 | 🟡 | Profiles documented (docs/security/personal-mac.md); multi-tenant not built. |
| H-11 | ✅ | `~/.tapdance/worker/audit.log` (600), no secrets; `worker guard audit`, `tokens`, `revoke`. |
| H-12 | 🧪 | Malicious-client tests against the API boundary in `packages/cli/src/guard/guard.test.ts`, using a recording fake Simlock (not OS/virtualization). |

### Product direction (phased)

| ID | | Notes |
| --- | --- | --- |
| Y-01 | 🟡 | Device loop and asc pass-through exist; builds/release orchestration not started. |
| Y-02 | 🟡 | doctor covers this machine and, with an operator token, gateway workers' capabilities; no per-worker SDK/KVM detail and no mandatory/optional labels yet. |
| Y-03 | ⬜ | Inventory lists models/OS/capacity; no capability query. |
| Y-04 | 🟡 | Interactive-only element lists with refs, ids, labels; no pagination/summary. |
| Y-05 | 🟡 | Screenshots are artifacts with a session manifest and optional note; inline image by default in MCP (`include_image: false` to skip). No annotations or comparison. |
| Y-06 | ⬜ | |
| Y-07 | 🟡 | Maestro/xcodebuild reachable through `execute_tool`; no result envelope for them. Tapdance's own scenario files (`tapdance run`) return a PASS/FAIL report with per-step results; FakeProvider tests only, not run on a device. |
| Y-08 | 🟡 | Per-session artifact folder + manifest. `tapdance run` writes an evidence folder per scenario run (report.json, report.md, failure screenshot and UI tree, device, OS, app id, repository commit, Tapdance and Node versions); FakeProvider tests only. No app version, logs or native framework results yet. |
| Y-09 | 🟡 | Scenario files replay a saved flow through Tapdance's own device calls (`tapdance run`, SDK `runScenario`); `scenarioFromToolCalls` turns MCP tool calls into a scenario and notes what will not replay (refs, external tools). No conversion to Maestro flows. The iOS sign-in example passed on a real simulator ([evidence](docs/testing/evidence/2026-11-01-device-state-and-profiles.md)); the Android one passed too (8/8, 24.6 s) once the overloaded Mac was idle. |
| Y-10 | 🟡 | Device settings, permissions, locale, time zone, orientation, appearance, location, biometrics, data reset and deep links/intents (U-08, U-09); battery and camera not covered. |
| Y-11 | 🟡 | Agent vs human hold (take over / hand back); no read-only or paused states. |
| Y-12 | 🟡 | Android device profiles (D-10): a prepared emulator booted read-only per lease. iOS and remote profiles not built. |
| Y-13 | 🟡 | Guard audit log and progress messages; no per-operation metadata envelope. |
| Y-14 | ⬜ | |
| Y-15 | ⬜ | |
| Y-16 | 🟡 | Session ids and artifact ids exist; `session`/`artifacts get`/`workers status` commands do not. |
| Y-17 | 🟡 | Phase 1 mostly in place (see above and [ROADMAP.md](ROADMAP.md)); remote-machine and Linux/KVM proofs pending. |

### Landscape

| ID | | Notes |
| --- | --- | --- |
| Z-01 | 🟡 | mobile-mcp reviewed from its README (not cloned). Positioning recorded in the ADR. |
| Z-02 | ❓ | Mobdev not found; need a link. |
| Z-03 | ✅ | Loupe, simslim cloned and read; others noted. |

### Process (owner notes)

| ID | | Notes |
| --- | --- | --- |
| K-01 | 🟡 | Multi-perspective review (architecture, developer, ease of use, docs, coding agent) is in use; no recorded review artifact in the repository. |
| K-02 | ⬜ | Field test on a real VPS by an agent filing issues: pending. Runbook in [docs/testing/field-testing.md](docs/testing/field-testing.md). |
| K-03 | 🟡 | No first-slice report file in the repository; this file, PRODUCT.md and the evidence records hold the facts it covers. |

## Changes in this round (unit-tested only)

Behaviour changed after the first evidence was recorded. The real iOS and Android MCP loops passed
again after these changes (see the re-run sections of the evidence files), but the specific failure
paths below were exercised only by unit tests.

| Change | Requirement IDs | | Test |
| --- | --- | --- | --- |
| agent-device's "not connected to the gateway" reply, and Simlock `WORKER_UNREACHABLE`, map to retryable `WORKER_OFFLINE`; token and tenant problems map to `AUTH_FAILED`/`FORBIDDEN` instead of `LEASE_LOST`; refused no-capacity requests map to `NO_CAPACITY` | W-03, C-02 | 🧪 | `packages/provider-simlock/src/provider.test.ts` |
| A recording still running at release is stopped and kept as an artifact; a failed stop no longer blocks the next recording; parallel artifact records keep every manifest entry | F-02, Y-05 | 🧪 | `packages/sdk/src/tapdance.test.ts`, `packages/core/src/core.test.ts` |
| Session lock: atomic acquisition with an owner token, safe stale takeover, heartbeat during long calls | C-03, W-04 | 🧪 | `packages/core/src/core.test.ts` |
| Renewal: an ended lease reports `LEASE_LOST`; idle release never crashes the MCP server and waits while a person holds the device | C-04, W-04 | 🧪 | `packages/sdk/src/tapdance.test.ts`, `packages/mcp/src/mcp.test.ts` |
| Agent token bound to its endpoint origin (`config set-token --endpoint`); security keys (`tools.*`, `ios.axePath`, `simlock.profilePath`) ignored in project config | X-02, E-09 | 🧪 | `packages/core/src/core.test.ts`, SDK tests, `packages/cli/src/cli.test.ts` |
| More secret shapes redacted (`tdg_`, JWTs, `*_KEY_B64=`, viewer keys) including in saved tool output; agent `asc auth`/`workflow`/`install-skills` refused without authorization | E-09, E-05 | 🧪 | `packages/core/src/core.test.ts`, `packages/sdk/src/tools.test.ts`, `packages/sdk/src/tapdance.test.ts` |
| Worker guard: physical devices refused unless `allow.physicalDevices`; session limit holds under concurrent allocates; status filtered to the client's own queued requests and devices | H-06, H-07 | 🧪 | `packages/cli/src/guard/guard.test.ts` |
| Scenario files and `tapdance run`: YAML/JSON schema with MCP step names, replay through the SDK, PASS/FAIL report with failure screenshot and UI tree, `continue_on_failure`, exit code 12 (`SCENARIO_FAILED`), recorder from MCP tool calls. Not yet run on a real device. | Y-07, Y-08, Y-09 | 🧪 | `packages/sdk/src/scenario.test.ts`, `packages/cli/src/cli.test.ts` |
| MCP: `list_apps`, short log replies (`contains`, `level`), action replies with `screenChanged`/`resolvedBy`/`typed`, stale refs refused, progress notifications | S-02, S-04, Y-04 | 🧪 | `packages/mcp/src/mcp.test.ts`, `packages/provider-simlock/src/provider.test.ts` |
| Worker guard as a login service (`worker guard install/uninstall`): plist and systemd unit text, launchctl/systemctl calls against a fake runner, no tokens in the service environment | H-03 | 🧪 | `packages/cli/src/guard/service.test.ts` |
| One-command host (`host up/status/down`, `connect`): Tailscale parsing, ready block, step-failure formatting, Windows refusal, cloud-VM detection | W-07 | 🧪 | `packages/cli/src/host/host.test.ts` |

## Bugs found by running for real (fixed)

| What happened | Cause | Fix |
| --- | --- | --- |
| Live stream answered `STREAM_UNAVAILABLE … simlock-screen-capture EACCES` | pnpm extracted Simlock's bundled capture helpers without the execute bit | `worker install/start` restores it |
| `worker install` failed with `DAEMON_CONNECTION_LOST` | `simlock daemon stop` returns while the old daemon drains | Wait for `status: stopped`, then start with retries |
| `gateway setup` printed the join token as `[REDACTED]`; the worker's uplink got 401 | Output redaction applied to the one command meant to hand out a secret | `secretResult` path for secret-handing commands only |
| `doctor` against a gateway said agent-device/stream/input missing | Gateways report capabilities per worker | Merge connected workers' capabilities |
| Viewer Back/Apps did nothing on iOS | Simlock acts on Home only for iOS simulators | Buttons disabled for iOS |
| Custom-app launch took 2–3 min through the worker guard | The request named the guard as `daemonBaseUrl` | Guard rewrites it to the local daemon (4 s) |
| Guard refused real agent-device commands | Lease id travels in `params.meta`/`params.flags` | Read all copies; require them to agree |
| `alert get` with no alert failed instead of answering "none" | agent-device says `alert not found` | Mapped to `present: false` |
| Lease refused with "this agent-device is too old for simlock" | Simlock requires a client-chosen 32-hex lease id; the message is misleading | Provider always sends one |
| A config written by an earlier build stopped loading | `leaseWaitSeconds` max lowered to 330 | Accept up to 3600; the provider caps at 330 |
| `agent-device` not found by `worker install` | ESM-only package, `require.resolve` cannot see it | `import.meta.resolve` |
| Google's Android CLI on a lease: "Multiple devices are currently online" | It ignores `ANDROID_SERIAL` | Append `--device=<serial>` where the subcommand's `--help` lists it |
| AXe `describe-ui` failed right after launch ("No translation object") | The app's accessibility tree was not ready | Retry for up to 8 s |
| AXe `tap --label Email` missed a SwiftUI text field | The field has a placeholder, no label | Resolve text targets in AXe's tree and tap the centre |
| `devices` showed no OS versions | Simlock 0.4 lists runtimes as strings | Read both shapes; show the default |
| `devices` showed shut-down emulators as "leased" | Simlock's `used` counts existing devices | Count leases |
| `logs --app` returned everything when the app was not running | No pid to filter on | Say so in the reply |
| Switching to AXe's device set left iOS disabled | Simlock refuses the switch while its own set holds simulators | `worker install --ios-backend axe` refuses first and prints the migration |
| Android stayed off after a restart ("port occupied") | Simlock's adb server outlived the daemon | `worker restart` stops it |
| First `open` failed with `AMBIGUOUS_MATCH` | Session opened without naming the leased UDID | Lease always opens the session with the leased device id |
