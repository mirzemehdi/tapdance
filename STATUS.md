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
0.4.0, agent-device 0.21.35, iOS 18.5 simulator (iPhone 16). Evidence: [docs/testing/evidence/](docs/testing/evidence/).

## Headline

- **Working for real, on one Mac:** local worker; lease → launch → inspect → tap by text/ref → back →
  swipe → wait_for → alert check → screenshot → MP4 recording → logs/crash logs → release, through
  both the CLI and the MCP server (stdio); background keepalive; browser viewer stream + input +
  human take-over; `asc` pass-through.
- **Proven on one machine through a real gateway:** worker joined over its outbound uplink; CLI, MCP and
  the viewer (rendered in a real browser) all worked through the gateway
  ([evidence](docs/testing/evidence/2026-11-01-gateway-single-host.md)).
- **Built but not yet proven on real infrastructure:** a real network between two machines (gateway on a
  VPS, laptop or N2 worker), Android end to end (this Mac lacks the Android command-line tools Simlock
  needs), AXe (not installable here without changing Homebrew's tap-trust setting), Google's Android
  CLI (not installed), the dedicated macOS worker account.
- **Personal-Mac protection:** device-only mode (`tapdance worker guard`) passed 15 malicious-client
  tests and ran the full MCP loop on a real simulator
  ([evidence](docs/testing/evidence/2026-11-01-worker-guard.md)); `worker login` now refuses unless the
  owner accepts that a gateway gets command execution (`--accept-gateway-exec`).
- **Not built:** remote execution targets for external tools (needs a worker-side executor),
  Windows workers, cloud-Mac provisioning integrations, hosted cloud, most of the phase 2–5 lifecycle
  features in PRODUCT.md §19 (test-framework envelope, evidence packages, replay, visual regression,
  environment controls, builds/release orchestration).

## By requirement

### Vision and model

| ID | | Notes |
| --- | --- | --- |
| P-01 | 🟡 | iOS loop ✅ on a real simulator. Android loop implemented on the same code path, not yet run (no Android cmdline-tools on the test Mac). |
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
| A-08 | ✅ | |

### Deployment modes

| ID | | Notes |
| --- | --- | --- |
| M-01 | ✅ | iOS on the test Mac. |
| M-02 | 🟡 | Gateway + joined worker + self-hosted provider ✅ on one Mac ([evidence](docs/testing/evidence/2026-11-01-gateway-single-host.md)). Two machines over a real network pending (Q-06). |
| M-03 | 🟡 | Same code path as M-02; N2 Terraform/scripts in `infrastructure/`. Not provisioned. |
| M-04 | ⬜ | By design (future). |
| M-05 | 🟡 | `tapdance gateway setup` ✅ on macOS; not yet run on a Linux VPS. |

### CLI

| ID | | Notes |
| --- | --- | --- |
| C-01 | ✅ | All listed commands plus `worker guard start/pair/tokens/revoke/policy/audit`, `ui wait`, `ui alert`, `ui key`, `devices install`, `artifacts`, `view`, `report`, `tools`, `tool`, `asc`, `android`, `simlock`. |
| C-02 | ✅ | `--json`, stdout/stderr split, exit codes (2 usage, 3 lease, 4 provider, 5 auth, 6 capacity, 7 device, 8 unsupported, 9 timeout, 10 host, 11 human-held); tested in `cli.test.ts`. |
| C-03 | ✅ | No command takes a device id; session record + lock. |
| C-04 | ✅ | Detached keepalive verified (spawned, renews when due, killed on release); `--hold`; idle release after 30 min. |
| C-05 | 🟡 | doctor covers host SDKs/Xcode/KVM (local), Simlock reachability, token role, capabilities, capacity, version, workers (operator token). KVM state of *remote* workers is not reported (Simlock does not expose it). |
| C-06 | ✅ | Device/Platform/Provider/Worker/Endpoint/Status/Lease block. |
| C-07 | 🟡 | Interactive `init` written; prompts not exercised in a TTY test. |

### MCP

| ID | | Notes |
| --- | --- | --- |
| S-01 | ✅ | stdio ✅ (full loop). Streamable HTTP ✅: 401 without the bearer token, 23 tools listed, real `list_devices`/`get_device_status` calls; a full device loop over HTTP not yet run. |
| S-02 | ✅ | All 19 plus `wait_for`, `handle_alert`, `list_tools`, `execute_tool`. |
| S-03 | ✅ | Strict Zod inputs (unknown keys refused). |
| S-04 | ✅ | Settle diffs, element lists, artifact refs, screenshots inline as images, logs saved as artifacts. |
| S-05 | ✅ | |
| S-06 | ✅ | No raw shell/adb/simctl tool; operator token never loaded for agents. |
| S-07 | ✅ | MCP loop passed through a real gateway (single host). |

### Platforms

| ID | | Notes |
| --- | --- | --- |
| D-01 | 🟡 | Implemented (agent-device + allowlisted logcat/force-stop). ⛔ on the test Mac: Simlock needs Android cmdline-tools (`sdkmanager`/`avdmanager`), which are not installed; doctor reports it. |
| D-02 | 🧪 | CPU flags, `/dev/kvm` access, `kvm-ok`, `emulator -accel-check`; worker install refuses to pretend. Needs a Linux run. |
| D-03 | ✅ | |
| D-04 | 🧪 | `.ipa` refused for simulators with a build hint; `.aab` refused. |
| D-05 | 🟡 | Simlock creates its own emulators from installed images and never hands out the developer's AVDs (deliberate; protects personal devices). `worker check` reports SDK, images, AVDs, running emulators. Uninstall / clear-data / explicit wipe are not exposed yet. |
| D-06 | 🟡 | Via Simlock (create/boot/wipe its own simulators). Physical-device and reset-on-request paths untested. |
| D-07 | ⛔ | Windows workers: Simlock supports macOS and Linux only. Windows works as a control machine (CLI/MCP). |
| D-08 | 🟡 | See D-05. |

### Interaction backends

| ID | | Notes |
| --- | --- | --- |
| U-01 | ✅ | text/id/ref/selector targets; coordinates as fallback. |
| U-02 | 🟡 | AXe backend written (`ios.uiBackend: "axe"`): inspect, tap by label/id/ref/point, swipe, type via stdin, home, screenshot, MP4 via detached `record-video`; unit-tested. ⛔ not run: `brew install` was refused by Homebrew's tap-trust policy on the test Mac. AXe reads only Xcode's default device set, so the worker needs `drivers.ios.deviceSet default` (`worker install --ios-backend axe` sets it). Works only when Tapdance runs on the Mac hosting the simulator. |
| U-03 | ❓ | `ios_*` tool names vs a platform-independent interface. Current choice: one set of platform-neutral tools whose iOS backend can be AXe. Adding `ios_*` aliases is cheap if wanted. |
| U-04 | 🟡 | Registered as an external tool (`tapdance android -- …`, `execute_tool`); agent-device stays the default Android backend until the Android CLI is evaluated on a real install. |
| U-05 | 🧪 | `ANDROID_SERIAL` + Simlock's adb port injected; inherited selectors stripped; without a lease the serial is set to an invalid id so device commands fail. Unverified against the real CLI. |
| U-06 | 🟡 | Maestro registered (lease-scoped). XCTest/Espresso orchestration not started. |

### Workers and gateway

| ID | | Notes |
| --- | --- | --- |
| W-01 | 🟡 | `worker login` requires `--accept-gateway-exec`. Outbound authenticated uplink ✅ on one host (token-authenticated; a bad token gave 401). `ws://` refused to public hosts. TLS/real network untested. |
| W-02 | 🟡 | Per-worker join tokens minted by `gateway setup` / `gateway token`, read from stdin. The worker does not request its own token (a person carries it). |
| W-03 | 🟡 | Simlock's behaviour; Tapdance maps `WORKER_UNREACHABLE` to retryable `WORKER_OFFLINE` and keeps leases through brief outages. Untested. |
| W-04 | 🟡 | TTL + keepalive + idle release + owner-scoped MCP shutdown; per-session lock. Interrupted-allocation cleanup relies on Simlock cancelling on disconnect. |
| W-05 | 🟡 | `gateway setup` ✅ on macOS (tokens, capabilities, config); Caddy/Tailscale steps untested. |
| W-06 | 🟡 | See C-05. |

### Browser viewer

| ID | | Notes |
| --- | --- | --- |
| V-01 | ✅ | `tapdance view`: real H.264 frames (meta, avcC, keyframes) proxied from Simlock's lease stream and decoded in the browser with WebCodecs ([evidence](docs/testing/evidence/2026-11-01-local-ios.md)). |
| V-02 | ✅ | Opened in a real browser through the gateway: live picture, a click tapped the device, status panel updated. Back/Apps are Android-only (disabled for iOS). Recording/screenshot buttons call the same SDK paths as the CLI. |
| V-03 | ✅ | A touch sets a human hold; the agent's next tap failed with `HUMAN_HELD` (retryable). Take over / Hand back. Advisory: enforced by Tapdance, not by Simlock. |
| V-04 | ✅ | Loopback-only, one-time key in the URL fragment, HttpOnly cookie, Host/Origin checks; token stays server-side. |
| V-05 | ✅ | Simlock console is view-only/operator-only; lease stream + input socket used instead (ADR). |

### Artifacts

| ID | | Notes |
| --- | --- | --- |
| F-01 | 🟡 | ✅ local: a custom simulator `.app` (examples/ios-demo) uploaded, installed, launched, filled, tapped, verified with `ui wait`, screenshot returned. Same upload path through the gateway is used for the device but a custom-app install via gateway was not run; Android APK not run. |
| F-02 | ✅ | `LocalArtifactStore` + manifest per session; `ArtifactStore` interface. |
| F-03 | ⬜ | Uploads/downloads pass through the gateway (agent-device proxy). |
| F-04 | 🟡 | Per-session directories on the user's disk; viewer serves only manifest entries. |

### External tools

| ID | | Notes |
| --- | --- | --- |
| E-01 | ✅ | `runTool`: argument arrays, approved env, timeouts, output caps with full output saved, exit codes; real `asc --version` and `asc apps list` run. |
| E-02 | ✅ | `tools list/doctor/versions`, `tool <name> --`, `asc --`, `android --`. |
| E-03 | 🧪 | `execute_tool` / `list_tools`; a never-seen subcommand forwarded unchanged (mocked executable test). |
| E-04 | ⛔ | Control machine only. Remote targets need a worker-side executor; Simlock's exec allows only adb/simctl/devicectl. Options in the ADR. |
| E-05 | 🟡 | Agents run `asc` with `ASC_READ_ONLY=1` (asc's own guard) unless `tools.allowMutation` lists asc and the call asks. `asc install-skills` not automated. |
| E-06 | 🟡 | fastlane registered; agents need explicit authorization (no read-only mode). |
| E-07 | ⬜ | Android CLI install on workers and its skills/plugins not automated. |
| E-08 | 🟡 | Detection and versions; no update command; compatibility matrix in [docs/compatibility.md](docs/compatibility.md). |
| E-09 | 🧪 | Parent env not forwarded; PEM keys and tokens redacted. |
| E-10 | ⬜ | Docs only. |

### Security

| ID | | Notes |
| --- | --- | --- |
| X-01 | ✅ | |
| X-02 | ✅ | |
| X-03 | 🟡 | App paths validated and confined for MCP; no wipe/reset operation exposed. |
| X-04 | 🟡 | TLS via a proxy or a private network; Simlock tokens are long-lived (not short-lived session credentials). |
| X-05 | ⬜ | Documented guidance only. |
| X-06 | ✅ | |
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
| O-01 | ✅ | |
| O-02 | ✅ | `CLAUDE.md`, `AGENTS.md`; a test fails when code names a `tapdance` command that does not exist. |
| O-03 | ✅ | This file and PRODUCT.md. |
| O-04 | ✅ | `.github/ISSUE_TEMPLATE/*`, `tapdance report`, [field-testing runbook](docs/testing/field-testing.md). |

### Testing and proof

| ID | | Notes |
| --- | --- | --- |
| Q-01 | ✅ | 84 unit tests (core, provider, SDK, MCP, CLI, 15 guard security tests). |
| Q-02 | 🟡 | Real: Simlock + iOS through MCP stdio (`pnpm test:integration` with `TAPDANCE_IT_PLATFORM=ios`). Mocked and labelled: provider fakes, tool executables. |
| Q-03 | 🟡 | Procedures in `docs/testing/e2e-procedures.md`; only the macOS-iOS one has been run. |
| Q-04 | ✅ | Every claim here names its evidence. |
| Q-05 | ⛔ | Needs a GCP project with billing and nested virtualization allowed. |
| Q-06 | 🟡 | Same flow ✅ on one host through a real gateway; the two-machine run needs a non-KVM VPS (the test Mac can be the laptop). |
| Q-07 | ⛔ | Needs Q-05/Q-06 infrastructure. |
| Q-08 | ⛔ | Needs a VPS; the test Mac can be the Mac worker. |
| Q-09 | ⛔ | Needs AXe installed (your Homebrew tap-trust decision). |
| Q-10 | ⛔ | Needs Q-05 plus the Android CLI. |
| Q-11 | ✅ | |

### Protecting personal Macs

| ID | | Notes |
| --- | --- | --- |
| H-01 | 🟡 | Device-only mode treats the control side as untrusted; joining a gateway (which does give it exec) now needs `--accept-gateway-exec`. |
| H-02 | ✅ | `worker guard`: route allowlist, agent-device command allowlist, exact exec argument lists, no caller paths except the client-side output paths agent-device already refuses to honour; real MCP loop passed through it ([evidence](docs/testing/evidence/2026-11-01-worker-guard.md)). |
| H-03 | 🟡 | Guard refuses root and admin accounts (override flag); `infrastructure/scripts/macos-create-worker-account.sh` written, **untested**; LaunchAgent not provided yet. |
| H-04 | 🧪 | `~/.tapdance/worker/policy.json`, refused if group/other-writable; no remote route to it. One profile (`device-only`). |
| H-05 | 🟡 | Local `guard pair` (TTY required), hashed tokens, expiry, immediate revocation, per-client lease ownership. No mutual TLS, replay protection or per-session short-lived tokens (Tailscale provides transport security). |
| H-06 | 🟡 | Per-client lease isolation and filtered status; per-session staging directories and quotas on the Mac are agent-device's, not enforced by Tapdance; upload/artifact ids not bound to a client. |
| H-07 | 🟡 | Session cap, lease TTL cap, upload size cap. No recording-duration or disk quota. |
| H-08 | 🟡 | Device-only only; builds refused. Approved-build and VM-isolated builds not started. |
| H-09 | ⬜ | Documentation only; AXe not installed on the test Mac. |
| H-10 | 🟡 | Profiles documented (docs/security/personal-mac.md); multi-tenant not built. |
| H-11 | ✅ | `~/.tapdance/worker/audit.log` (600), no secrets; `worker guard audit`, `tokens`, `revoke`. |
| H-12 | ✅ | 15 malicious-client tests against the API boundary (not OS/virtualization). |

### Product direction (phased)

| ID | | Notes |
| --- | --- | --- |
| Y-01 | 🟡 | Device loop and asc pass-through exist; builds/release orchestration not started. |
| Y-02 | 🟡 | doctor covers this machine and, with an operator token, gateway workers' capabilities; no per-worker SDK/KVM detail and no mandatory/optional labels yet. |
| Y-03 | ⬜ | Inventory lists models/OS/capacity; no capability query. |
| Y-04 | 🟡 | Interactive-only element lists with refs, ids, labels; no pagination/summary. |
| Y-05 | 🟡 | Screenshots are artifacts with a session manifest and optional note; inline image by default in MCP (`include_image: false` to skip). No annotations or comparison. |
| Y-06 | ⬜ | |
| Y-07 | 🟡 | Maestro/xcodebuild reachable through `execute_tool`; no result envelope. |
| Y-08 | 🟡 | Per-session artifact folder + manifest; no packaged run with metadata. |
| Y-09 | ⬜ | |
| Y-10 | ⬜ | Only orientation-free basics (keys, alerts). |
| Y-11 | 🟡 | Agent vs human hold (take over / hand back); no read-only or paused states. |
| Y-12 | ⬜ | |
| Y-13 | 🟡 | Guard audit log and progress messages; no per-operation metadata envelope. |
| Y-14 | ⬜ | |
| Y-15 | ⬜ | |
| Y-16 | 🟡 | Session ids and artifact ids exist; `session`/`artifacts get`/`workers status` commands do not. |
| Y-17 | 🟡 | Phase 1 mostly in place (see above); Android and remote-machine proofs pending. |

### Landscape

| ID | | Notes |
| --- | --- | --- |
| Z-01 | 🟡 | mobile-mcp reviewed from its README (not cloned). Positioning recorded in the ADR. |
| Z-02 | ❓ | Mobdev not found; need a link. |
| Z-03 | ✅ | Loupe, simslim cloned and read; others noted. |

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
| First `open` failed with `AMBIGUOUS_MATCH` | Session opened without naming the leased UDID | Lease always opens the session with the leased device id |
