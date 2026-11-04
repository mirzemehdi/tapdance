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

Last updated: 2026-11-04. Test host for "✅": MacBook Pro M1 Pro, 16 GB, macOS 26.5, Xcode 26.5, Simlock
0.4.0, agent-device 0.21.35, iOS 18.5 and 26.5 simulators (iPhone 16), Android 34 emulators (Pixel 8,
arm64 images, one with Google Play), AXe 1.8.0, Google's Android CLI 1.1.16717390. Linux host: a Google
Cloud `n2-standard-4` VM (europe-west1-b, Ubuntu 24.04, nested virtualization), emulator 37.2.13 with
`android-34;google_apis_playstore;x86_64`, driven from that Mac ([evidence](docs/testing/evidence/2026-11-03-gcp-n2-android.md)).
Evidence: [docs/testing/evidence/](docs/testing/evidence/).

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
- **Android on a Linux/KVM host, proven for real:** a Google Cloud N2 VM created with the Terraform
  module and set up with `scripts/host-setup.sh` and `host up`, driven from the owner's Mac over
  Tailscale in device-only mode: CLI and MCP checklists, the viewer, installs from CI, an Android build
  on the host from a private repository, the idle stop powering the VM off, and a VM restart back to
  ready in 54 s ([evidence](docs/testing/evidence/2026-11-03-gcp-n2-android.md)).
- **Built but not yet proven on real infrastructure:** gateway mode across two machines (a Simlock
  gateway on a VPS with a laptop, N2 or Mac worker joined over a real network), the dedicated macOS
  worker account.
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
| P-01 | 🟡 | iOS loop ✅ on a real simulator ([evidence](docs/testing/evidence/2026-11-01-local-ios.md)). Android loop ✅ on real emulators ([evidence](docs/testing/evidence/2026-11-01-android.md)), and on a Linux/KVM host (Google Cloud N2) from a Mac over Tailscale, CLI and MCP ([evidence](docs/testing/evidence/2026-11-03-gcp-n2-android.md)). No recorded run from a real agent (Claude Code/Codex/Cursor) yet: the MCP runs used a scripted client. |
| P-02 | ✅ | CLI and MCP verified for real; SDK (`@tapdance/sdk`) is what both use. |
| P-03 | 🟡 | Local ✅. Self-hosted in device-only mode ✅ across two machines: an agent on a VPS with a Mac host ([evidence](docs/testing/evidence/2026-11-02-vps-field-runs.md)) and a Mac with a Linux N2 host ([evidence](docs/testing/evidence/2026-11-03-gcp-n2-android.md)). Gateway mode not run across machines. |
| P-04 | ✅ | No billing, dashboard or hosted fleet code. |
| P-05 | 🧪 | `DeviceProvider` contract; `provider: "cloud"` reserved and refused with NOT_SUPPORTED. |
| P-06 | 🟡 | Same tools for local and remote by construction; the same CLI and MCP tools ran against this Mac, a Mac over Tailscale and a Google Cloud N2 VM ([evidence](docs/testing/evidence/2026-11-03-gcp-n2-android.md)). Cloud Macs, gateway workers and managed infrastructure not exercised. |
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
| M-03 | ✅ | Google Cloud N2 in device-only mode: VM from `infrastructure/terraform/google-cloud-n2`, `scripts/host-setup.sh` and `host up` on it, driven from a Mac over Tailscale ([evidence](docs/testing/evidence/2026-11-03-gcp-n2-android.md)). Joining an N2 worker to a gateway, OVH and other KVM hosts not run. |
| M-04 | ⬜ | By design (future). |
| M-05 | 🟡 | `tapdance gateway setup` ✅ on macOS; not yet run on a Linux VPS. |

### CLI

| ID | | Notes |
| --- | --- | --- |
| C-01 | ✅ | All listed commands plus `worker guard start/pair/tokens/revoke/policy/audit`, `ui wait`, `ui alert`, `ui key`, `devices install`, `artifacts`, `view`, `report`, `tools`, `tool`, `asc`, `android`, `simlock` ([evidence](docs/testing/evidence/2026-11-01-local-ios.md)). `worker connect` folded into `worker login`/`start`. |
| C-02 | 🧪 | `--json`, stdout/stderr split, exit codes (2 usage, 3 lease, 4 provider, 5 auth, 6 capacity, 7 device, 8 unsupported, 9 timeout, 10 host, 11 human-held); tested in `packages/cli/src/cli.test.ts`. Seen for real only in part (`LEASE_ALREADY_HELD` exit 3, `HUMAN_HELD` in the [evidence](docs/testing/evidence/2026-11-01-local-ios.md)). |
| C-03 | ✅ | No command takes a device id; session record + lock. |
| C-04 | 🧪 | Detached keepalive spawned on lease and exited after release on a real device ([evidence](docs/testing/evidence/2026-11-01-local-ios.md)); idle release seen for real on the N2 run: the CLI keepalive released a lease 30 min after its last use ([evidence](docs/testing/evidence/2026-11-03-gcp-n2-android.md)); renewal is tested in `packages/sdk/src/tapdance.test.ts`. `--hold`. |
| C-05 | 🟡 | doctor covers host SDKs/Xcode/KVM (local), Simlock reachability, token role, capabilities, capacity, version, workers (operator token). KVM state of *remote* workers is not reported (Simlock does not expose it). |
| C-06 | ✅ | Device/Platform/Provider/Worker/Endpoint/Status/Lease block. |
| C-07 | 🟡 | Interactive `init` written; prompts not exercised in a TTY test. |

### MCP

| ID | | Notes |
| --- | --- | --- |
| S-01 | 🟡 | stdio ✅ (full loop, [evidence](docs/testing/evidence/2026-11-01-local-ios.md)). Streamable HTTP: bearer check and read-only calls tried by hand, not recorded; full device loop not run. |
| S-02 | 🟡 | All 19 exist, plus `wait_for`, `handle_alert`, `list_tools`, `execute_tool`, `list_apps`. Called over MCP on a real device: `lease_device`, `get_device_status`, `install_app` (through the guard), `launch_app`, `inspect_screen`, `tap`, `swipe`, `press_key`, `wait_for`, `handle_alert get`, `take_screenshot`, `start_recording`, `stop_recording`, `get_logs`, `get_crash_logs`, `get_test_artifacts`, `list_tools`, `execute_tool`, `release_device` ([evidence](docs/testing/evidence/2026-11-01-local-ios.md), [guard](docs/testing/evidence/2026-11-01-worker-guard.md)). On the N2 run also `type_text` (`into_text`), `kill_app`, `clear_app_data`, `push_file`/`pull_file`, `notifications`, `opened_links`, `tap_sequence` and `install_app` with `from_ci` ([evidence](docs/testing/evidence/2026-11-03-gcp-n2-android.md)). Not called over MCP on a device: `stop_app`, `list_devices`, `list_workers`, `list_apps`. |
| S-03 | 🧪 | Strict Zod inputs (unknown keys refused); `packages/mcp/src/mcp.test.ts` checks every tool. |
| S-04 | ✅ | Settle diffs, element lists, artifact refs, screenshots inline as images, logs saved as artifacts. |
| S-05 | ✅ | No MCP tool or CLI command takes a device id; the real MCP loop ran without one ([evidence](docs/testing/evidence/2026-11-01-local-ios.md)). Handle checks unit-tested in `packages/sdk/src/tapdance.test.ts`. |
| S-06 | ✅ | No raw shell/adb/simctl tool; operator token never loaded for agents. |
| S-07 | ✅ | MCP loop passed through a real gateway (single host). |

### Platforms

| ID | | Notes |
| --- | --- | --- |
| D-01 | ✅ | macOS: Android 34 emulators created and booted by Simlock, CLI and MCP loops, custom APK, Google Play image ([evidence](docs/testing/evidence/2026-11-01-android.md)). Linux with KVM: a Google Cloud N2 VM (nested virtualization, headless emulator), CLI and MCP loops, a 77 MB APK, installs from CI ([evidence](docs/testing/evidence/2026-11-03-gcp-n2-android.md)). Physical Android phones not run. |
| D-02 | 🟡 | CPU flags, `/dev/kvm` access, `kvm-ok`, `emulator -accel-check`, and `host.kvm.emulator-libs` (`emulator -version`, naming missing system libraries); worker install refuses to pretend. Ran on a real Linux VM with KVM present; the emulator-library check came from a real failure on Ubuntu's cloud image ([evidence](docs/testing/evidence/2026-11-03-gcp-n2-android.md)). The missing-KVM path (no nested virtualization) is unit-tested only. |
| D-03 | ✅ | macOS + Xcode + Simulator: discovery, boot, `.app` install, launch, interaction, screenshots, recording, logs ([evidence](docs/testing/evidence/2026-11-01-local-ios.md)). |
| D-04 | 🧪 | `.ipa` refused for simulators with a build hint; `.aab` refused. |
| D-05 | 🟡 | Simlock creates its own emulators from installed images and never hands out the developer's AVDs (deliberate; protects personal devices). `worker check` reports SDK, images, AVDs, running emulators. Uninstall / clear-data / explicit wipe are not exposed yet. |
| D-06 | 🟡 | Via Simlock (create/boot/wipe its own simulators). Physical-device and reset-on-request paths untested. |
| D-07 | ⛔ | Windows workers: Simlock supports macOS and Linux only. Windows works as a control machine (CLI/MCP). |
| D-08 | 🟡 | See D-05. |
| D-09 | ✅ | `.aab` → universal APK with bundletool 1.18.3 before upload, installed and driven on a real Pixel 8 ([evidence](docs/testing/evidence/2026-11-01-device-state-and-profiles.md)); the missing-bundletool hint is unit-tested. |
| D-10 | ✅ | Local only, by decision. Device profiles on Android (a read-only boot of a prepared AVD) and iOS (a clone of a template simulator per lease) created and leased on one Mac; a lease's changes were discarded on both ([evidence](docs/testing/evidence/2026-11-01-device-state-and-profiles.md)). Remote leasing is out of scope: Simlock enrols only USB phones, and a profile turned into a custom system image did not carry its data (tried 2026-11-02, removed); remote agents use a fresh device and `request_human`. A real Google sign-in and Play purchase are not yet run. |

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
| U-10 | ✅ | Android shared storage push/pull locally and through the guard; iOS Photos and app Documents locally and through the guard (a guard route that resolves every path itself; `guard.test.ts` test 16) ([evidence](docs/testing/evidence/2026-11-01-device-state-and-profiles.md)). Android app-sandbox push/pull on a debug build of a real app, CLI and MCP, on the N2 host ([evidence](docs/testing/evidence/2026-11-03-gcp-n2-android.md)). |
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
| W-07 | 🟡 | `tapdance host up/status/down`, `tapdance connect`, `scripts/host-setup.sh` (prerequisite check and install with one confirmation, checksum-verified official downloads, a no-sudo pnpm shim for the build) and `scripts/host-setup.ps1`. Run for real on the owner's Mac (2026-11-02, self-test passed; fixes since: token handover, `host pause` / `host resume`, `host down --all`, `--warm`, uploads through the guard, #23). **Linux run for real (2026-11-03):** `host-setup.sh` end to end on a fresh Google Cloud N2 VM (Node.js, JDK, SDK, the system image download, emulator libraries, Tailscale login, clone and build, then `host up`) in 2 min 44 s once fixed; linger or the OS Login boot unit, headless emulators, `tailscale serve` over HTTPS, the self-test, and everything back after a VM restart; `connect` from a Mac ([evidence](docs/testing/evidence/2026-11-03-gcp-n2-android.md)). Not yet run: `host up` on a fresh Mac; `host pause`, `host resume`, `host down --all` on Linux; the no-`/dev/kvm` branch of `host-setup.sh`; any pair of machines other than VPS → Mac and Mac → N2. |

### Browser viewer

| ID | | Notes |
| --- | --- | --- |
| V-01 | ✅ | `tapdance view`: real H.264 frames (meta, avcC, keyframes) proxied from Simlock's lease stream and decoded in the browser with WebCodecs ([evidence](docs/testing/evidence/2026-11-01-local-ios.md)). |
| V-02 | 🟡 | stream, tap, status ✅ ([evidence](docs/testing/evidence/2026-11-01-gateway-single-host.md)); Home, tap, Screenshot and Start/Stop recording buttons ✅ on Android ([evidence](docs/testing/evidence/2026-11-01-android.md)); a browser on the Mac streamed an emulator on the N2 VM live ([evidence](docs/testing/evidence/2026-11-03-gcp-n2-android.md)). Back/Apps are Android-only (disabled for iOS). | Over a tailnet: MagicDNS names are allowed and pages that cannot decode video (plain http off localhost) fall back to refreshed screenshots (`viewer.test.ts`; not yet seen in the owner's browser).
| V-03 | ✅ | A touch sets a human hold; the agent's next tap failed with `HUMAN_HELD` (retryable). Take over / Hand back. Advisory: enforced by Tapdance, not by Simlock. |
| V-04 | ✅ | Loopback-only, one-time key in the URL fragment, HttpOnly cookie, Host/Origin checks; token stays server-side. |
| V-05 | ✅ | Simlock console is view-only/operator-only; lease stream + input socket used instead (ADR). |

### Artifacts

| ID | | Notes |
| --- | --- | --- |
| F-01 | 🟡 | ✅ local: a custom simulator `.app` (examples/ios-demo) and a custom APK (examples/android-demo) uploaded, installed, launched, filled, tapped, verified with `ui wait`, screenshot returned ([iOS](docs/testing/evidence/2026-11-01-local-ios.md), [Android](docs/testing/evidence/2026-11-01-android.md)). Through the worker guard from another machine: a 75 MB APK VPS → Mac ([evidence](docs/testing/evidence/2026-11-02-vps-field-runs.md)) and a 77 MB APK Mac → N2 in 149 s ([evidence](docs/testing/evidence/2026-11-03-gcp-n2-android.md)). A custom-app install through a gateway was not run. |
| F-02 | ✅ | `LocalArtifactStore` + manifest per session; `ArtifactStore` interface. |
| F-03 | ⬜ | Uploads/downloads pass through the gateway (agent-device proxy). |
| F-04 | 🟡 | Per-session directories on the user's disk; viewer serves only manifest entries. |
| F-05 | ✅ | `app install --from-ci` and MCP `install_app` `from_ci` on an Android lease of the N2 host: the host downloaded the GitHub Actions artifact with its own `gh` (first about 8 s, cached 7–12 s) and installed it ([evidence](docs/testing/evidence/2026-11-03-gcp-n2-android.md)). Allow-list, size cap, fork and zip checks unit-tested with a fake `gh` (`ci-artifacts.test.ts`). |

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
| G-01 | ✅ | `n2-standard-4`, Ubuntu 24.04, 64 GB `pd-balanced`, nested virtualization, KVM, SDK/emulator/image, Simlock worker, outbound-only networking with IAP SSH: created once with Terraform 1.17.1 (`validate` passed, 13 resources) and run as an Android host; stopped by its idle stop and started again ([evidence](docs/testing/evidence/2026-11-03-gcp-n2-android.md)). `terraform destroy` not yet run. |
| G-02 | ✅ | `infrastructure/terraform/google-cloud-n2/` applied once; `scripts/host-setup.sh` checked and installed everything on the VM, ran `host up` and health-checked an emulator boot (self-test) ([evidence](docs/testing/evidence/2026-11-03-gcp-n2-android.md)). By design it pairs a worker guard instead of joining a gateway; the gateway-join script (`infrastructure/scripts/install-android-worker.sh`) has not been run. |
| G-03 | ✅ | `docs/deployment/google-cloud-n2.md` followed end to end ([evidence](docs/testing/evidence/2026-11-03-gcp-n2-android.md)). Measured: setup 2 min 44 s, VM start → ready 54 s, idle stop 30 min after the last lease, 19 GB of the 64 GB disk used after the run. Prices are estimates from Google's published rates (about USD 0.21/h for `n2-standard-4` in europe-west1, disk about USD 0.21/day for 64 GB), not a billing export. |
| G-04 | 🟡 | Written; untested procedures. |
| G-05 | 🟡 | Written; Scaleway/MacStadium/AWS steps not exercised. |
| G-06 | 🟡 | Docs only. |
| G-07 | 🟡 | Idle stop ✅: the guard powered the N2 VM off 30 min after the last lease ended, and the worker, guard and Tailscale came back after a start ([evidence](docs/testing/evidence/2026-11-03-gcp-n2-android.md)). Terraform `max_run_hours = 8` set on the VM, not reached. Uptime cap, stop schedule and budget alert unit-tested or not triggered (`host-stop.test.ts`, `host.test.ts`, `guard.test.ts`). |
| G-08 | 🧪 | Not run on a cloud yet. `cloud VM:` line in the `host up` ready block and a `cloud VM` row in `host status` (`host.test.ts`); Terraform `on_run_limit = "DELETE"` (ephemeral mode) passes `terraform validate` (1.17.1), not applied; `infrastructure/scripts/gcp-leftovers.sh` run only against a stand-in for `gcloud` (none left: exit 0; leftovers: exit 1; a failed list: exit 2); tear-down docs in `google-cloud-n2.md#tear-down` and `self-hosted-overview.md`. |
| O-01 | ✅ | Basis: every listed document exists — README, installation, quick start, CLI reference, MCP, Claude Code/Codex/Cursor pages, Android and iOS pages, self-hosted guides, ADR, CONTRIBUTING, SECURITY, LICENSE (AGPL-3.0-only). `cli.test.ts` checks that every command, MCP tool and config key is documented. |
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
| Q-05 | ✅ | Provisioned with Terraform, KVM verified, emulator booted, APK installed (upload and from CI), launch, screenshot, release, all through the worker guard from a separate machine over Tailscale ([evidence](docs/testing/evidence/2026-11-03-gcp-n2-android.md)). The agent's machine was the owner's Mac, not a Linux VPS. |
| Q-06 | 🟡 | Same flow ✅ on one host through a real gateway. Two machines over a real network ✅ in device-only mode (VPS → Mac guard over Tailscale, [evidence](docs/testing/evidence/2026-11-02-vps-field-runs.md); Mac → N2 guard, [evidence](docs/testing/evidence/2026-11-03-gcp-n2-android.md)); the gateway mode across two machines is still not run. |
| Q-07 | 🟡 | Device-only variant only: an N2 host driven from a Mac, with the viewer on that Mac streaming the N2 emulator live and the owner's take-over giving `HUMAN_HELD` ([evidence](docs/testing/evidence/2026-11-03-gcp-n2-android.md)). The gateway, an agent on a VPS and a browser on a third machine not run. |
| Q-08 | ⛔ | Needs a VPS; the test Mac can be the Mac worker. |
| Q-09 | ✅ | AXe sign-in flow on the demo app ([evidence](docs/testing/evidence/2026-11-01-axe.md)). |
| Q-10 | ⛔ | The N2 host now exists (Q-05), but the Android CLI was not run on it: external tools run on the control machine only, and a remote lease needs a worker-side executor (E-04). The Android CLI part is proven locally (U-05). |
| Q-11 | 🟡 | `pnpm test` is run during development and the build is kept green; there is no CI yet. |
| Q-12 | 🧪 | [field-test-cloud-android.md](docs/testing/field-test-cloud-android.md) and `scripts/field-test/`, generalised from the drivers of the 2026-11-03 run. Not run in this form: the checklists pass the offline `--check` against the MCP tool schemas; the MCP driver ran against a server with no device, the CLI driver against a stand-in CLI. |

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
| H-08 | 🟡 | Device-only by default; builds only after the owner runs `host builds enable` on the host (Android git builds ✅ on the N2 host, [evidence](docs/testing/evidence/2026-11-03-gcp-n2-android.md)). VM-isolated builds not started. |
| H-09 | ⬜ | Documentation only; AXe not installed on the test Mac. |
| H-10 | 🟡 | Profiles documented (docs/security/personal-mac.md); multi-tenant not built. |
| H-11 | ✅ | `~/.tapdance/worker/audit.log` (600), no secrets; `worker guard audit`, `tokens`, `revoke`. |
| H-12 | 🧪 | Malicious-client tests against the API boundary in `packages/cli/src/guard/guard.test.ts`, using a recording fake Simlock (not OS/virtualization). |
| H-13 | 🟡 | A fine-grained read-only token (`--git-auth gh`) cloned and built a private repository on the N2 host over `https://`; a submodule the token did not cover was skipped with a warning ([evidence](docs/testing/evidence/2026-11-03-gcp-n2-android.md)). Per-repository deploy keys (`host builds key --repo`) unit-tested only (`build.test.ts`, fake git): the real attempt was refused because the organization disabled deploy keys. |
| H-14 | 🧪 | `host builds files add/list/remove`: copied into the checkout for the build and removed after it, path and symlink refusals, no guard route; `build.test.ts`, `guard.test.ts`, `cli.test.ts` (fake git and Gradle). Not run on a real repository. |

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
| Y-12 | 🟡 | Device profiles on Android and iOS, local only (D-10). Snapshots of arbitrary states are not built. |
| Y-13 | 🟡 | Guard audit log and progress messages; no per-operation metadata envelope. |
| Y-14 | ⬜ | |
| Y-15 | ⬜ | |
| Y-16 | 🟡 | Session ids and artifact ids exist; `session`/`artifacts get`/`workers status` commands do not. |
| Y-17 | 🟡 | Phase 1 mostly in place (see above and [ROADMAP.md](ROADMAP.md)); remote machines proven in device-only mode, Linux/KVM on a Google Cloud N2 VM ([evidence](docs/testing/evidence/2026-11-03-gcp-n2-android.md)); gateway mode across machines pending. |

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
| K-02 | ✅ | An agent on an Ubuntu VPS tested a real app (Pianolune) on the owner's Mac through the worker guard over Tailscale, Android and iOS, about 1,000 calls per run, and filed issues #13–#52 ([evidence](docs/testing/evidence/2026-11-02-vps-field-runs.md), reported by that agent). Runbook in [docs/testing/field-testing.md](docs/testing/field-testing.md). |
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
| Guard forwards agent-device upload headers; a 31 MB APK installed through a real guard (#23) | H-06 | ✅ | `guard.test.ts` 17; real run 2026-11-02 |
| One-command host (`host up/status/down`, `connect`): Tailscale parsing, ready block, step-failure formatting, Windows refusal, cloud-VM detection | W-07 | 🧪 | `packages/cli/src/host/host.test.ts` |
| One agent-device session per lease (was one per Tapdance session), so a new lease never inherits an earlier lease's unfinished recording or claim (#31, #32) | W-04 | 🧪 | `packages/provider-simlock/src/provider.test.ts` |
| Stale device claims released before each lease through the guard, at `worker start`/`restart`, by `worker cleanup`, and by a local lease; a lease that meets one retries once. Unfinished recordings of dead sessions set aside. Run once by hand on the field-test Mac (2026-11-02): both stuck claims released, the next lease attached (#31, #36) | W-04, H-06 | 🧪 | `packages/provider-simlock/src/stale-claims.test.ts` (real agent-device against a temp Simlock home) |
| `device request-human` on the CLI (#33) | U-13 | 🧪 | build + `--help`; same SDK path as the MCP tool |
| Android raw taps: a settled tap that changed nothing on the file picker or share sheet is repeated as `input tap`; `ui tap --inject` / MCP `inject` (#34) | Y-04 | 🧪 | guard template test; not yet run on DocumentsUI |
| `view --tailscale` (https via `tailscale serve`, live video); `host up` recommends HTTPS Certificates (#30) | V-01 | 🧪 | build + `--help`; not yet run on a tailnet |
| `doctor` retries a slow first `/v1/healthz` and names an http→https switch; `connect` probes the address before saving (#37, #38) | W-07 | 🧪 | `provider.test.ts` "doctor reachability" |
| `ui inspect --bounds`; `ui swipe --until` matches part of a label and stops at the end of a list; emulator notification lists readable through the guard by default (#35) | Y-04, H-06 | 🧪 | `guard.test.ts` 14 |
| `device release` reports an unreachable worker (exit 4) and keeps the record to retry | C-04 | 🧪 | build |
| `doctor` fails, `devices` notes and `host up` warns when a platform has capacity but no device on offer; `worker start/restart` stop a stray adb server on Simlock's port even without `adb-server.json`. Restart verified on the field-test Mac 2026-11-02 (Android back in the catalog) (#39) | W-04 | ✅ / 🧪 | `provider.test.ts` "platform on offer" |
| Field-run fixes: `ui sequence` timing in microseconds from the start (Android's shell arithmetic is 32-bit, #42); orientation read, Chrome notifications promo skipped, `inspect --system` via a file after stopping agent-device's helper (#44); `record stop` retries a timed-out remote download for up to 30 min (#51); quiet exit on EPIPE (#52) | Y-04, F-02 | 🧪 | `provider.test.ts`; sequence script run in bash with a fake clock; not yet re-run on a device |
| Builds on the host from allow-listed git repositories (`host builds`, `app build`, MCP `build_app`): clone/fetch cache, exact sha, protected refs, xcodebuild for the simulator or Gradle, install on the lease, streamed log (#45) | H-08 | ✅ / 🧪 | `build.test.ts` (fake git/Xcode/Gradle), `guard.test.ts` 16d. **Android ✅ on the N2 host:** a private repository cloned over `https://` with a fine-grained token, Gradle `BUILD SUCCESSFUL` in 2 min 40 s (after the owner installed the app's CMake), installed and launched; the kept build reused in 11 s (CLI) and through MCP `build_app` 5/5 ([evidence](docs/testing/evidence/2026-11-03-gcp-n2-android.md)). iOS: attempted on the owner's Mac (#53), no successful real build yet |
| Scoped guard tokens (`pair --scope`, `host up --scope`), threat model doc, host up security note and Tailscale ACL hint, token age in `host status` (#46) | H-05 | 🧪 | `guard.test.ts` 16c |
| iOS Files app destination for `device push --to files` / `pull --files` (#47) | U-08 | 🧪 | `guard.test.ts` 16b |
| iOS: wifi/airplane refused instead of faked; status-bar time read and H:MM; clipboard; `app launch --locale`; push to simulators allowed by default; iOS Notification Center open/close; `perf memory` through the guard (#48, #49) | U-08 | 🧪 | `provider.test.ts`, `guard.test.ts`; not yet run on a device |
| iOS: `alert get` reads a system alert from the screen when agent-device misses it; Home Screen inspect hint; `app list` from simctl; keyboard-occluded taps at the centre; system-app uninstall refusal (#50) | Y-04 | 🧪 | `provider.test.ts`; not yet run on a device |
| Viewer: allowed names match on any port (behind `tailscale serve` on another port), 403 names the Host; `view --tailscale` falls back to `sudo -n tailscale serve` (#40) | V-01 | 🧪 | `viewer.test.ts` |
| `device request-human`: reason printed once, a counter once a minute, `--no-wait` + `device status`, `--cancel` (exit 13 `CANCELLED`) (#41) | U-13 | 🧪 | `tapdance.test.ts` |
| `app kill` / MCP `kill_app`: Home, `am stop-app` or trim + kill, pid check (#43) | Y-04 | 🧪 | `provider.test.ts`, guard test 14; not yet run on a device |
| `ui sequence` / MCP `tap_sequence`: timed taps as one script inside the emulator, with start times and drift (#42) | Y-04 | 🧪 | `provider.test.ts`; not yet run on a device |
| `ui wait` up to 10 min; `orientation landscape`; `device setting browser-first-run off`; `ui inspect --system` (uiautomator, Custom Tab URL) (#44) | Y-04 | 🧪 | `provider.test.ts`; not yet run on a device |
| Android image tiers: agents told to lease `google_apis_playstore` only when a test needs the Play Store; `devices install --image-tag google_atd` (ATD test images). Leasing an ATD image is untested. | R-06 | 🧪 | build + `--help` |
| `host-setup.sh` on Linux (#19): end to end on a fresh N2 VM with `/dev/kvm`, including the system image download ([evidence](docs/testing/evidence/2026-11-03-gcp-n2-android.md)); without `/dev/kvm` it skips the emulator and system image and stops before `host up` | W-07 | ✅ / 🧪 | Real run with KVM; the no-KVM branch `bash -n` only |
| Cost guard for cloud hosts: the guard's idle stop and uptime cap (`host up --idle-stop`, `--max-uptime`, `hostStop` in the guard policy), the poweroff sudoers rule from `host-setup.sh`, Terraform `max_run_hours`, `stop_schedule` and budget | G-07 | ✅ / 🧪 | Idle stop ✅ on Google Compute Engine: the N2 VM powered itself off 30 min after the last lease ([evidence](docs/testing/evidence/2026-11-03-gcp-n2-android.md)). Uptime cap 🧪 (`host-stop.test.ts`, `host.test.ts`, `guard.test.ts`); Terraform cap set, not reached |
| Cloud cost guardrails: `cloud VM:` line in `host up` and `host status` on a detected cloud VM; Terraform `on_run_limit` (`"DELETE"`: the VM and its disk are deleted at `max_run_hours`) with `destroy_command`, `leftovers_check` and `teardown` outputs; `infrastructure/scripts/gcp-leftovers.sh`; field-test runbook and `scripts/field-test/` checklist drivers | G-08, Q-12 | 🧪 | `host.test.ts`; `terraform validate`; the leftovers script against a stand-in `gcloud`; checklists `--check`ed offline. None of it run on a cloud yet |
| Install from CI (`app install --from-ci`, MCP `install_app` `from_ci`, `host artifacts enable/disable/status`) | F-05 | ✅ | CLI and MCP on the N2 host ([evidence](docs/testing/evidence/2026-11-03-gcp-n2-android.md)); refusals with a fake `gh` in `ci-artifacts.test.ts` |
| Per-repository deploy keys (`host builds key --repo`) | H-13 | 🧪 | `build.test.ts` (fake git). The deploy key route was not exercised for real: the test app's organization has deploy keys turned off |
| Build files (`host builds files add/list/remove`), dot-folders such as `.github/` allowed, `.git` and `.gitmodules` refused | H-14 | 🧪 | `build.test.ts`, `guard.test.ts`, `cli.test.ts` |
| Linux user services without a login session: linger, wait for the user manager's bus, `XDG_RUNTIME_DIR` / `DBUS_SESSION_BUS_ADDRESS` for `systemctl --user`; `tapdance-user-manager.service` for OS Login accounts that cannot linger | W-07 | ✅ | Fourth `host-setup.sh` run on the N2 VM and the VM restart ([evidence](docs/testing/evidence/2026-11-03-gcp-n2-android.md)) |
| Emulator system libraries: host check `host.kvm.emulator-libs`, `host-setup.sh` installs them; the check's output captured before matching (pipefail) | D-02, W-07 | ✅ | `host-checks.test.ts`; fourth `host-setup.sh` run on the N2 VM |
| `host-setup.sh` finds the terminal by opening `/dev/tty` and gives `host up` the terminal under `curl \| bash` | W-07 | ✅ | Pairing approved during the fourth run on the N2 VM |
| Headless Linux hosts run the emulator with `swiftshader_indirect` (`worker install`, `host up`) | D-01, W-07 | ✅ / 🧪 | Measured on the N2 VM with the setting made by hand: taps 2.2–2.6 s instead of 3.4–7.9 s, idle CPU about 0 % instead of 136–165 % ([evidence](docs/testing/evidence/2026-11-03-gcp-n2-android.md)); the new default `host.test.ts` |
| `doctor` and `devices`: iOS on a Linux worker is skipped ("needs a Mac"), not a failure | C-05 | ✅ | `provider.test.ts`; `doctor` passed from the Mac against the N2 host |
| Rotation with the launcher in front: one attempt (50 s → 17 s) | Y-04 | ✅ | Measured on the N2 host |
| Guard restart over SSH sets up the user manager's bus first and warns on failure; `host status` over SSH reads the guard service through that bus | W-07 | 🧪 | Build only; found on the N2 host, not re-run there |
| First `inspect` after a fresh lease retried once on agent-device's `INSTRUMENTATION_FAILED` | Y-04 | 🧪 | Build only; found on the N2 host, not re-run there |
| `host builds enable` keeps earlier `--git-auth` and `--timeout-minutes`; the build JDK check honours `JAVA_HOME`; `env.sh` puts the JDK on `PATH`; the MCP outside-the-project hint covers `push_file` | H-08, S-04 | 🧪 | Build only; found on the N2 host |
| Android install refusals name the fix (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`, `VERSION_DOWNGRADE`, `INSUFFICIENT_STORAGE`), for uploads, installs from CI and host builds | F-01, F-05, H-08 | 🧪 | `provider.test.ts`; the signature refusal itself was met on the N2 host, from CI and from a host build |
| Android `ui type` / MCP `type_text` without a target refuses (`ELEMENT_NOT_FOUND`, hint to pass a target) when the snapshot shows a text field and no focused element (agent-device sets `focused` only when true) and the keyboard status says the keyboard is down; types as before when it cannot tell (#72, reopened by the VPS + N2 run) | Y-04 | 🧪 | `provider.test.ts` (mocked agent-device client with the real snapshot shape); the first fix failed on the N2 host, this one not re-run there |
| `logs --contains` / `--level` on the CLI; with a filter, Android searches the whole logcat buffer (CLI and MCP `get_logs`/`get_crash_logs`); `-n` up to 20000; `type_text` drops agent-device's "resolved to TextView" warning when the field reads back; `doctor` names the timeout that fired (#82) | C-01, S-02, Y-04, C-05 | 🧪 | `provider.test.ts`, `guard.test.ts`, `cli.test.ts`, `mcp.test.ts` (fake provider); found on the N2 host, not re-run there |
| Android `ui inspect` / MCP `inspect_screen` names the app whose elements are on screen (the launcher after Back) when none belong to the session's app, with a note (#73) | Y-04 | 🧪 | `provider.test.ts` (mocked agent-device client); found on the N2 host, not re-run there |
| An Android emulator lease waits up to 90 s for the guest to settle (boot complete, no "isn't responding" dialog, guest CPU at most 50 % between two reads); a System UI ANR dialog is answered with Wait; past 90 s the device is handed out with a notice (CLI warning, MCP `lease_device` `notices`, SDK `notices`). New fixed device command `GUEST_STATE`, accepted by the guard as inspection (#79) | W-04, Y-04, H-06 | 🧪 | `guest-settle.test.ts`, `provider.test.ts`, `guard.test.ts` 14 (mocked device and client); the 50 % threshold is not yet calibrated on a real host |
| An "isn't responding" or crash dialog is named by `ui inspect` / `inspect_screen` (app `android`, advice to tap Wait or Close app), by `app launch` / `launch_app` (warning) and by a tap whose target is not found (message and hint), instead of a plain miss (#80) | Y-04 | 🧪 | `guest-settle.test.ts`, `provider.test.ts` (mocked); found on the N2 host, not re-run there |
| `host warm default` removes the warm-pool keys `host warm` wrote (Simlock's learned default again); `host warm` with no counts shows the setting and the spares. `worker start`/`restart` and `host warm` reconcile Simlock's records with `doctor --fix` instead of `nuke`, so the learned spare survives a restart; `nuke` only when the doctor cannot run (#91) | W-04, W-07 | 🧪 | `host.test.ts` (config edit and wording); the restart path is build-only, not yet run on a host |
| The lease request line says whether a warm spare is ready; while Simlock queues or starts a device, a progress line every stage change or 15 s (from Simlock's `waiting` list) (#92) | C-02, W-06 | 🧪 | `provider.test.ts` (mocked Simlock HTTP) |
| A lease that meets "No Android device with serial …" (a host that just started still lists its old emulator as ready) asks again every 10 s for up to 2 min, then fails `DEVICE_UNAVAILABLE` with a hint saying the host just started (#94) | W-03, W-04 | 🧪 | `provider.test.ts` (mocked); `doctor` still counts that stale device as running (Simlock's status, upstream) |
| `host-setup.sh`: env file at the top of `~/.bashrc` and `ANDROID_SDK_ROOT` (ssh commands find the tools), Android CLI metrics off in `~/.androidrc`, `--with-gh`, `--sdk-packages`, Tailscale login after the Tapdance install (#77, #84) | W-07 | 🧪 | `bash -n`; the option parsing, package check and `.bashrc` rewrite run in a scratch home; not re-run on a VM |
| `check-kvm.sh` finds `~/Android/Sdk` and calls a missing `/dev/kvm` access before setup expected; motd, `next_steps` and docs run it after `host-setup.sh` (#84) | G-02 | 🧪 | `bash -n` only |
| `host up` on headless Linux: no clipboard offer, no iOS sentence or "this Mac", linger line once (#78); `host status`: `capacity.ramBudget`, iOS "needs a Mac", the SDK found in `~/Android/Sdk` (#81) | W-07, C-05 | 🧪 | `host.test.ts`, `host-checks.test.ts` |
| `host up` without `--label` keeps the host's only pairing; a run needing pairing approval without a terminal is refused before any change (#93) | W-07, G-07 | 🧪 | `host.test.ts` (label choice and refusal text) |
| Guard log file `~/.tapdance/worker/guard.log` on Linux; `host status` says when an idle host powers off; diagnostics of a token's own failed allocate allowed for 10 min (#95) | G-07, H-06 | 🧪 | `service.test.ts`, `host.test.ts`, `guard.test.ts` (malicious-client test 20, mocked Simlock) |
| `gcp-leftovers.sh`: warnings kept out of the rows, partial lists and a `DELETE_REQUESTED` project reported as could-not-check (#83); `revoke-run-credentials.sh` for the logins a cloud run leaves (#76) | G-08, Q-12 | 🧪 | Both against a stand-in `gcloud` (clean, warning, deleted, leftover; `--check`) |
| Host builds that cannot sign in to git: `AUTH_FAILED` (`details.reason: GIT_AUTH`, the auth used and the deploy key's fingerprint) instead of `DEVICE_ERROR`; git's own `Permission denied (publickey)` / `Repository not found` line in the error and the quiet log; a hint for the auth used (its own or the shared deploy key, `gh`, an https URL next to a key, ssh without a key) that mentions organizations turning deploy keys off (#85) | H-08, H-13 | 🧪 | `build.test.ts` (fake git), `guard.test.ts` 16g; found on the N2 host, not re-run there |
| `host builds enable` and `host artifacts enable` check access per repository (`git ls-remote` with the build's key or `gh`; `gh api` for the repository and its Actions artifacts) and warn with the fix, `--no-check` to skip; `status --check` runs it again; `host builds key` says organizations can turn deploy keys off; github.com submodules with ssh URLs fetched over https in `--git-auth gh` mode (#86) | H-08, H-13, F-05 | 🧪 | `build.test.ts`, `ci-artifacts.test.ts` (fake git and `gh`), `cli.test.ts` (no git on `PATH`); not run against GitHub |
| Repository case kept in `host builds key`, `host artifacts` and hints (only key and cache folder names are lower-case); `host builds key --repo <url> --remove` (prints the fingerprint), `host builds disable --repo`, `host artifacts disable --repo`; `not used (https)` in `host builds status` for an https URL next to a deploy key, which an https clone no longer gets (#87) | H-08, H-13, F-05 | 🧪 | `build.test.ts`, `host/builds.test.ts`, `cli.test.ts` |
| MCP `build_app` and `install_app` take `launch` (relaunch after install, like `--launch`); `build_app` always says `reused` (with `builtAt`) and the `ref`; replies name the installed Android package (`appId`, `versionCode`, read from the APK's manifest on the host) and `next` names `launch_app` with it (#88, #89) | S-02, F-05, H-08 | 🧪 | `mcp.test.ts` (FakeProvider), `guard.test.ts` 16f/16g, `apk-manifest.test.ts` (an APK made by aapt2 36.0.0 and synthetic manifests); not run on a device |
| Install refusals (`VERSION_DOWNGRADE`, signature mismatch) name the package the host tried to install, with MCP syntax in MCP replies and CLI syntax in the CLI (#89) | F-01, F-05, H-08 | 🧪 | `provider.test.ts`, `guard.test.ts`, `mcp.test.ts`; found on the N2 host, not re-run there |
| Host Android builds let idle Gradle and Kotlin daemons go after 10 minutes (`-Dorg.gradle.daemon.idletimeout`, Kotlin `autoshutdownIdleSeconds`) instead of holding about 8 GB for Gradle's 3 hours; `builds.gradleDaemonIdleMinutes` / `host builds enable --gradle-idle-minutes` (0: `--no-daemon`, Kotlin in-process) (#90) | H-08 | 🧪 | `build.test.ts`, `guard.test.ts` 16g (fake Gradle: the arguments only). Not measured on a host: whether the daemons exit on time is untested |

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
| Every lease of two emulators failed with "owned by session …", and Simlock kept recycling them (looked like an emulator restarting in a loop) | Claims of a dead agent-device daemon, kept because that session's screen recording never finished; one agent-device session name was reused for every lease | Per-lease session names; stale-claim cleanup before leases (#31, #32, #36) |
| `host up` on a Linux VM failed at the worker step: "Failed to connect to bus: No medium found" | Over non-interactive SSH there is no systemd user manager or `XDG_RUNTIME_DIR` | Turn on linger, wait for the user manager's bus, point `systemctl --user` at it ([N2 run](docs/testing/evidence/2026-11-03-gcp-n2-android.md)) |
| `loginctl enable-linger` failed with "No such file or directory", also with sudo | logind cannot look up Google Cloud OS Login accounts | `host-setup.sh` installs `tapdance-user-manager.service`, which starts the user manager at boot |
| The emulator did not start on Ubuntu's cloud image | Missing `libpulse0 libxkbfile1 libxi6 libsm6 libice6`; `pipefail` with `grep -q` hid the check | Host check `host.kvm.emulator-libs`; `host-setup.sh` installs them and captures the output first |
| Pairing could not be approved when `host-setup.sh` came through `curl` | `[[ -r /dev/tty ]]` was true without a controlling terminal | Open `/dev/tty` to test it; `host up` runs with `< /dev/tty` |
| `doctor` exited 10 against a Linux host | iOS counted as missing on a machine that cannot have it | Skipped with "needs a Mac" |
| Rotating with the launcher in front took 50 s on the N2 emulator | Three confirmation attempts on a screen that does not rotate | One attempt (17 s) |
| Screen-changing taps took 3.4–7.9 s and the idle emulator used 136–165 % CPU on the N2 VM | `-gpu auto` on a machine without a GPU | `swiftshader_indirect` on headless Linux hosts: 2.2–2.6 s, about 0 % idle |
