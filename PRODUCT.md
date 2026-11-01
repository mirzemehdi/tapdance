# Tapdance — product requirements

> "Let your agent put your app through its paces."

This file is the single list of what Tapdance must do. It merges the original brief and every addendum
the product owner has written so far, each requirement with a stable ID. [STATUS.md](STATUS.md) tracks
each ID: done and verified on real devices, done but only unit-tested, partial, not started, or blocked.
When a new requirement arrives, add it here first (new ID, never reuse one), then add its row to
STATUS.md.

**Product principle.** Tapdance orchestrates; existing tools execute; AI agents use everything through
one consistent interface. Simlock owns device orchestration, agent-device / AXe / Google's Android CLI
own device automation, Xcode builds, the official `asc` CLI owns App Store Connect, fastlane `supply`
owns Google Play publishing. Tapdance owns sessions, routing, workers, artifacts, safety and the
CLI/MCP/SDK surface. One CLI. One MCP interface. Android and iOS. Local, self-hosted or managed cloud.

Sources: the brief (B), the Google Cloud section (G), BYOI and remote workers (W), laptop-as-worker (L),
local device worker and remote emulator access (D), iOS and cloud Mac workers (I), AXe (X), App Store
Connect CLI (A), integrate existing tools (T), Google's Android CLI (N), protecting personal Macs (S),
product vision and lifecycle (V), and the owner's short notes in chat (C).

**First public release focus (owner, C):** be excellent at three things — (1) get an Android or iOS
device from any supported worker, (2) let Claude Code or Codex actually interact with the app, (3)
return useful screenshots, recordings and test evidence. Everything else is product direction, built
phase by phase (§19).

---

## 1. Vision and business model

| ID | Requirement | Src |
| --- | --- | --- |
| P-01 | Agents (Claude Code, Codex, Cursor, any MCP client) can find, lease, install, launch, inspect, tap/swipe/scroll/type, screenshot, record, read logs, run E2E flows and release Android emulators and iOS simulators. | B1 |
| P-02 | Primary interfaces: CLI, MCP server, programmatic SDK. A dashboard is not a priority. | B1 |
| P-03 | Community edition is free, open source and fully useful without an account: local devices, self-hosted Linux and Mac workers, CLI, MCP, local artifacts. | B2 |
| P-04 | Managed cloud (hosted emulators/simulators, queues, artifact storage, usage billing) is future and paid. No subscriptions, payments, commercial dashboard or hosted fleet in the MVP. | B2, B14 |
| P-05 | A hosted provider must plug in later without changing CLI commands, MCP tools or SDK contracts; the only difference is the configured provider. | B2, W2, D12 |
| P-06 | The device location is transparent to the agent: same tools whether the device is on this computer, a laptop, a home server, a Google Cloud N2, another self-hosted machine, a cloud Mac, or future managed infrastructure. | D14, I10 |
| P-07 | A developer never needs KVM on their coding VPS to test a mobile app. | D14, L |

## 2. Reuse before building

| ID | Requirement | Src |
| --- | --- | --- |
| R-01 | Investigate Simlock first (README, CLI, MCP, HTTP API, worker, gateway, config, license, code) and reuse its leasing, queueing, provisioning, worker and gateway engine. Contribute upstream where a change belongs there; fork only when necessary. | B3, B14 |
| R-02 | Record the decision in `docs/architecture-decision.md`: what is reused, what Tapdance adds, what is out of scope. | B3 |
| R-03 | Check licenses; never copy upstream code without notices; credit authors and sources wherever code or ideas are taken. | B3, C |
| R-04 | Before any new capability: search for existing tools, read their repos/docs, check license, maintenance and interfaces (CLI, SDK, MCP, HTTP); integrate; build custom code only for genuine gaps and document why. | T2, T13 |
| R-05 | Treat external tools as first-class dependencies through their official interface; reuse existing MCP servers where practical instead of competing ones. | T3, T5 |
| R-06 | Investigate DeviceDeck, Loupe (bmcreations/loupe) and simslim (MobAI-App/simslim) for streaming, co-control and simulator efficiency. | W5, C |
| R-07 | Remove Tapdance code when an upstream tool gains the capability natively; avoid compatibility layers. | T13 |

## 3. Architecture

| ID | Requirement | Src |
| --- | --- | --- |
| A-01 | TypeScript, Node.js, pnpm workspaces, official MCP TypeScript SDK, Zod, Vitest, strict TypeScript, current stable dependencies. No database unless required. | B4 |
| A-02 | Layers: core (contracts), CLI, MCP server, device-provider abstraction, SDK. | B4 |
| A-03 | Provider interface: discover, list, lease, status, renew, release, install, launch, inspect UI, interact, screenshots, recordings, logs. Initial providers: local Simlock and self-hosted Simlock gateway; future Tapdance Cloud as a documented extension point, never a fake implementation. | B8 |
| A-04 | No coupling of core logic to Google Cloud, AWS, Scaleway or any machine provider. | B8, G |
| A-05 | Separate orchestration (gateway: discovery, availability, leasing, expiry/renewal, ownership, worker registration/health, routing) from execution (worker: emulator/simulator start, install, interaction, screenshots, recordings, logs, cleanup). | W4, D2 |
| A-06 | A machine-provider abstraction for Mac hosts (create, provision, start, stop, health, connect, remove) may exist, but provider integrations come later; manual provisioning plus worker install comes first. | I4 |
| A-07 | A small tool registry tracks integration metadata (name, description, executable, install status, version, OS, preferred location, env, install docs, license, health check) — never a catalogue of the tool's commands. | T8 |
| A-08 | Keep the codebase small and maintainable; no Kubernetes or microservices. | B14 |

## 4. Deployment modes

| ID | Requirement | Src |
| --- | --- | --- |
| M-01 | Mode A, local: Tapdance and the emulator/simulator on the same machine (`tapdance init --mode local`). | W2, D12 |
| M-02 | Mode B, remote local-device: agent on an ordinary VPS (no KVM); the developer's laptop/Mac is the worker. **Core feature, implemented before requiring any cloud.** | L, D1 |
| M-03 | Mode C, bring your own cloud: worker on Google Cloud N2, OVH with confirmed nested virtualization, other KVM VPS, dedicated Linux servers, customer machines. The user pays the infrastructure provider. | W2 |
| M-04 | Mode D, managed cloud (future): same CLI/MCP; only the provider changes. | W2 |
| M-05 | The gateway can run on the existing VPS, a separate server, or later Tapdance Cloud. | D2 |

## 5. CLI

| ID | Requirement | Src |
| --- | --- | --- |
| C-01 | Commands along the lines of: `init`, `doctor`, `config`, `devices [list]`, `workers list`, `device lease --platform --device`, `device status`, `device release`, `app install`, `app launch`, `ui inspect`, `ui tap --text`, `ui swipe --direction`, `ui type`, `screenshot --output`, `record start/stop --output`, `logs`, `gateway setup`, `worker install/login/start/connect`. Adapt to real capabilities. | B5, W7, D6, I3 |
| C-02 | Human output by default; `--json`; results on stdout, progress on stderr; meaningful exit codes; clear errors with suggested fixes. | B5 |
| C-03 | Session-aware; never operates on an arbitrary device — everything is scoped to the session's lease. | B5 |
| C-04 | Automatic lease renewal while the session is active; release on graceful exit; configurable lease TTL. | B5 |
| C-05 | A useful `doctor`: gateway reachable, workers online, worker KVM, available emulators, lease state, browser viewer availability. | B5, W7 |
| C-06 | Device output shows which worker and machine provide the device (device, platform, provider, worker, status, connection). | D6 |
| C-07 | `init` offers: local device, self-hosted remote worker, Tapdance Cloud. | W7 |

## 6. MCP server

| ID | Requirement | Src |
| --- | --- | --- |
| S-01 | Official MCP TypeScript SDK; stdio for local agents and Streamable HTTP for remote hosting. | B6 |
| S-02 | Tools: `list_workers`, `list_devices`, `lease_device`, `get_device_status`, `release_device`, `install_app`, `launch_app`, `stop_app`, `inspect_screen`, `tap`, `swipe`, `type_text`, `press_key`, `take_screenshot`, `start_recording`, `stop_recording`, `get_logs`, `get_crash_logs`, `get_test_artifacts`. | B6, D7 |
| S-03 | Clear names, descriptions, strictly validated inputs; designed for agent use, not raw platform commands. | B6 |
| S-04 | Structured responses: device identity, current app, screen info, artifact paths/references, errors, relevant logs. Large recordings/logs as references, not inline. | B6, I7 |
| S-05 | Every action scoped to the session's lease; agents need not know ADB, simctl, Xcode, SSH, networking or worker processes. | B6, D7 |
| S-06 | No unrestricted shell or raw adb/simctl as default tools; never return worker enrollment secrets or SSH credentials. | B6, D11, I12 |
| S-07 | The MCP server routes through the gateway to the correct worker. | D7 |

## 7. Platforms

| ID | Requirement | Src |
| --- | --- | --- |
| D-01 | Android: SDK, emulator, ADB; emulator on Linux with KVM and on macOS; physical devices where the backend supports them; APK install, launch, interaction, accessibility, screenshots, recording, logcat. | B7 |
| D-02 | Diagnose missing KVM with a fix; never assume nested virtualization; never silently fall back to software emulation. | B7, G, W3 |
| D-03 | iOS: macOS only with Xcode, Simulator, simctl; discovery, boot, install `.app`, launch, interaction, screenshots, recording, logs. Never attempt iOS Simulator on Linux/Windows. | B7, I1 |
| D-04 | Clearly distinguish simulator `.app` builds from signed device `.ipa` builds. | B7, I5 |
| D-05 | Android worker on a laptop: discover SDK, ADB, running emulators, AVDs, physical devices; report model, version, resolution, state; start/create/stop/restart emulators; wipe only on explicit request; install/uninstall/launch/stop apps; clear data when authorized; taps, swipes, scroll, text, keys, accessibility; screenshots, recording, logcat, crash info. | D4 |
| D-06 | iOS worker on a Mac: detect Xcode versions, runtimes, available and booted simulators, UDID, model, runtime, resolution, state; create/boot/wait/health/shutdown/reset (explicit)/delete Tapdance-managed simulators; install `.app`, launch, terminate, bundle ids, crashes. | I3, I5 |
| D-07 | Worker host OS: macOS (Android + iOS), Linux (Android), Windows (Android initially; validate what the backend supports). | L, D2 |
| D-08 | Discover existing installed emulators and simulators without recreating the developer's environment. | D2 |
| D-09 | `install_app` accepts an Android App Bundle (`.aab`) by building a universal APK with bundletool on the control machine before upload; without bundletool, a clear install hint. | C (issue #7) |
| D-10 | Device profiles: an Android emulator the owner prepares once (signed in to a test account, settings, Play Store updates) that leases boot from read-only, so every lease starts from that state and keeps nothing; not blocked by Simlock, which neither enrols nor keeps such emulators. Credentials never pass through Tapdance. | C (issue #18) |

## 8. Device interaction backends

| ID | Requirement | Src |
| --- | --- | --- |
| U-01 | Prefer semantic interaction (accessibility labels/identifiers, selectors) over coordinates; coordinates remain as fallback. | B10, I6 |
| U-02 | AXe is the preferred iOS Simulator interaction backend (inspect, semantic tap, gestures, text, buttons, screenshots, MP4, streaming). Simlock leases, simctl handles lifecycle, Tapdance unifies. Detect AXe version, check macOS/Xcode compatibility, target only the leased UDID, handle AXe errors and disconnects, record the AXe version per worker, preserve its MIT notice. | X |
| U-03 | AXe-named MCP tools were requested (`ios_inspect_screen`, `ios_tap`, `ios_swipe`, `ios_drag`, `ios_type`, `ios_press_button`, `ios_screenshot`, `ios_record_start/stop`, `ios_stream_start`, `ios_get_simulators`) while the same message requires a platform-independent public interface. **Open decision** (see STATUS.md). | X |
| U-04 | Google's official Android CLI (`android`) is the preferred Android interaction backend (layout, input, annotated screenshots, emulators, builds, profiling, docs, skills); retain ADB/other backends only for gaps. | N |
| U-05 | For Simlock-leased Android devices, Android CLI must operate on the assigned device and never allocate a second one. | N |
| U-06 | Investigate XCTest/XCUITest, DeviceDeck and Maestro/Espresso; orchestrate established frameworks rather than build a new one. | I6, T1 |
| U-07 | A typed, allowlisted, audited device-command channel (adb/simctl through Simlock's lease exec) that reaches remote leased devices the same way as local ones, scoped to the leased device, never a host shell; external tools that would run on the wrong machine fail fast and name the remote-capable tools. | C (issue #14) |
| U-08 | App reset and launch control on the leased device: uninstall, clear data, iOS keychain reset, launch arguments, Android explicit intents. | C (issue #4) |
| U-09 | Device settings: network, permissions, appearance, text size, biometrics, location, orientation, density, locale, time zone, status-bar time; unsupported combinations answer NOT_SUPPORTED with an alternative. | C (issue #6) |
| U-10 | Files to and from the device: shared storage (media-scanned) and debuggable app sandboxes on Android; Photos and app containers on local iOS simulators; pulled files become artifacts. | C (issue #5) |
| U-11 | Notifications: list, open/close the shade, post a test notification, deliver a push payload; off by default on personal Macs. | C (issue #9) |
| U-12 | Measurements: frame health and memory of the foreground app. Audio capture, microphone injection and virtual MIDI devices are requested (issues #8, #16) and not built; any audio path must not capture the host's own audio or need macOS Screen Recording permission. | C (issues #17, #8, #16) |
| U-13 | Asking a person: the agent requests a human action on the device (sign in, approve a purchase sheet) and waits until the person hands back in the viewer or marks it done; passwords are typed on the device, never in chat. | C (issue #15) |

## 9. Workers, gateway and networking

| ID | Requirement | Src |
| --- | --- | --- |
| W-01 | Workers connect outbound to the gateway over an authenticated, persistent, TLS connection; no public ADB, emulator, worker-management or Mac management ports; no router port forwarding; no public SSH to the laptop. | W4, L, D3, I2 |
| W-02 | Unique worker identities; unique, revocable enrollment credentials; `worker install` / `login` / `start` (or `connect`) UX; the worker requests an enrollment token from the gateway. | W7, D6, I3 |
| W-03 | Gateway detects disconnected workers and marks their devices unavailable; workers reconnect automatically; heartbeats; worker and device health checks; explicit reporting when a laptop goes offline. | W4, D10 |
| W-04 | Lease expiry and renewal; graceful worker shutdown; device cleanup; recovery from interrupted sessions; never leave devices permanently reserved after an agent disconnects or a worker crashes; never release devices of other active sessions. | D10 |
| W-05 | `gateway setup` explains deploying a gateway on the existing VPS or configuring an existing Simlock gateway; Tailscale or another private network supported for initial setups. | W7, G |
| W-06 | The CLI reports gateway reachability, online workers, KVM per worker, available emulators, lease state and viewer availability. | W7 |
| W-07 | One-command host setup: `host up` on a Mac or Linux machine checks prerequisites (installing no SDKs), installs the worker and the guard as a login service, pairs a control machine with local approval, exposes the guard over Tailscale when available, self-tests a lease through the guard, and prints a paste-back block with the endpoint and the path of a mode-600 token file (never the token); `host status` / `host down` inspect and undo it; `connect` on the agent's machine reads the token from stdin, configures and checks Tapdance, and prints MCP setup. Refused on Windows with NOT_SUPPORTED; a VM without nested virtualization is reported as unable to host Android emulators. | C (issue #19) |

## 10. Browser viewer (human access)

| ID | Requirement | Src |
| --- | --- | --- |
| V-01 | Watch the device live from the developer's own browser while the agent works ("at any time I should be able to watch what it does"). | W5, D8, I8, C |
| V-02 | Tap, swipe, scroll, text input, screenshots, start/stop recordings, device status, session information. | W5, I8 |
| V-03 | Take over from the agent and hand back, without conflicting simultaneous input; human and agent share the same authorized session. | D8, I8 |
| V-04 | No direct browser connection to ADB; authenticated streaming/control endpoint through the gateway or a secure proxy; video separate from API traffic where possible. | W5 |
| V-05 | Verify what Simlock's console/streaming actually supports; evaluate DeviceDeck, Loupe and AXe streaming; build only the missing parts; do not claim the Android CLI or AXe alone provide a multi-user browser console. | W5, X, N |

## 11. Artifacts and transfer

| ID | Requirement | Src |
| --- | --- | --- |
| F-01 | VPS-built APK (or iOS `.app`) transferred securely to the worker, installed, tested; screenshots, recordings and logs returned to the VPS and the browser viewer. | W6, D9, I13 |
| F-02 | Local artifact storage first; an extensible storage interface for S3/R2 later; no large videos in a database. | W6 |
| F-03 | Consider short-lived signed transfers or direct encrypted channels so large binaries need not traverse the control plane. | D3 |
| F-04 | Artifacts restricted to the owning user/session. | W9 |

## 12. External tool integrations

| ID | Requirement | Src |
| --- | --- | --- |
| E-01 | Generic executable integration: discovery, install detection, version, availability, help discovery, argument forwarding unchanged (argument arrays, never a shell), approved env, working directory, stdout/stderr/exit-code preservation, long-running processes, cancellation, timeouts, structured results, artifact collection. | T4, A2 |
| E-02 | CLI: `tapdance tools list|doctor|versions|install-guidance`, `tapdance tool <name> -- <args>`, plus shortcuts like `tapdance asc -- …` and `tapdance android -- …`. | T4, A2, N |
| E-03 | MCP: a generic execute tool taking tool, target, args (array), cwd, approved env; returning stdout, stderr, exit status, artifact references, metadata. Its schema must not change when upstream adds commands. | T5, A3, N |
| E-04 | Execution targets: control machine and authorized remote workers (Mac worker for Xcode-dependent commands, Android worker for device commands); route to the machine where the device or toolchain is; transfer inputs/outputs securely. | A4, T7, N |
| E-05 | App Store Connect: the official `asc` CLI (rorkai/App-Store-Connect-CLI) is the source of truth; no Tapdance command catalogue; expose `asc --help`, `search`, `schema`, `capabilities`, `install-skills`, `<command> --help`; use asc's own auth (`asc auth …`); preserve `--read-only`, `--confirm`, `--strict-auth`; agents default to read-only; mutations need user authorization; no hardcoded allowlist that blocks new commands. | A |
| E-06 | Google Play publishing: evaluate fastlane `supply`; generic forwarding; no duplicate Play Console implementation. | N |
| E-07 | Google's Android CLI installed on local machines, self-hosted Android workers and N2 workers; its agent skills/plugins installed for Claude Code and Codex rather than recreated. | N |
| E-08 | Version detection, compatibility checks, update discovery, user-controlled upgrades and pinning, never silently replace a working install; maintain a compatibility matrix (Simlock, AXe, Android SDK, Xcode, asc, Android CLI). | A6, T9, N |
| E-09 | Never log credentials or return them through MCP; never reuse another customer's credentials; credentials scoped per user and machine. | A7, T10 |
| E-10 | CI services (Xcode Cloud, Codemagic, GitHub Actions) are optional integrations, not Mac worker providers. | I9 |

## 13. Security

| ID | Requirement | Src |
| --- | --- | --- |
| X-01 | Operate only on devices leased by the current session; stable requester identities; one agent cannot release another's device; TTL and renewal. | B11 |
| X-02 | Never expose ADB or simulator control publicly without authentication; no shared worker credentials in MCP responses; no secrets in logs or committed config. | B11, B9 |
| X-03 | Validate app paths and tool inputs; restrict destructive operations (wipe, reset) to explicitly managed devices and explicit authorization. | B11, D11 |
| X-04 | TLS; authenticated workers and browser users; short-lived device access credentials; per-session permissions; no unauthenticated worker API; a worker executes only gateway-authorized operations. | W9, D11 |
| X-05 | Protect Apple signing credentials and keychains; separate customer workspaces; clean up temporary environments. | I12 |
| X-06 | Generic tool execution is never unrestricted remote shell: approved executables, argument arrays, timeouts, resource limits, protected env, workspace-restricted file access, cancellation. | T10 |
| X-07 | Say plainly that leasing is not a sandbox; a multi-tenant hosted service needs stronger isolation; investigate Apple's macOS licensing before shared or short-duration Mac rentals. | B11, W9, I12 |
| X-08 | An explicit local confirmation/authorization option for sensitive operations on a personal-machine worker. | L |

## 14. Infrastructure and deployment docs

| ID | Requirement | Src |
| --- | --- | --- |
| G-01 | Google Cloud N2 as the first documented Android worker: n2-standard-4, Ubuntu 24.04, 50–100 GB SSD, nested virtualization, KVM/QEMU, Android SDK/emulator/image, AVD, Simlock worker, outbound secure connection, least-privilege firewall, shutdown/deletion. N2D/E2 must not be substituted. One emulator per VM until benchmarked. | G, W3 |
| G-02 | Terraform at `infrastructure/terraform/google-cloud-n2/` (main.tf, variables.tf, outputs.tf, README.md) plus a manual install script that checks OS, CPU flags, `/dev/kvm`, KVM permissions, installs cmdline-tools, platform-tools, an image, creates an AVD, installs/configures the Simlock worker, joins the gateway, and health-checks an emulator boot. | G, W3 |
| G-03 | `docs/deployment/google-cloud-n2.md` with prerequisites, IAM, billing/quota, machine creation, nested virtualization, software, emulator, Simlock, connecting Tapdance, screenshots/recordings, shutdown/deletion, troubleshooting, realistic cost examples with caveats, and what keeps billing when stopped. | G, W8 |
| G-04 | Deployment docs: `local.md`, `self-hosted-overview.md`, `google-cloud-n2.md`, `ovh-public-cloud.md`, `dedicated-linux-server.md`, `worker-security.md`, `browser-access.md`, explaining VPS vs gateway vs worker vs emulator vs browser and that the VPS needs no KVM. | W8 |
| G-05 | iOS docs: `docs/ios/overview.md`, `local-mac-worker.md`, `scaleway-mac.md`, `macstadium.md`, `aws-ec2-mac.md`, `simulator-management.md`, `remote-browser-access.md`, `xcode-cloud-integration.md` — prerequisites, Xcode versions, runtimes, Apple account, registration, network, leasing, artifacts, troubleshooting, costs and allocation terms (Scaleway minimum rental, AWS dedicated-host minimums). Do not imply any VPS can host iOS. | I11 |
| G-06 | Scaleway Mac mini (M2, 16 GB, 256 GB) is the first documented cloud Mac; MacStadium and AWS EC2 Mac documented as manual options; never store AWS credentials in plaintext. | I4 |

## 15. Documentation and open-source quality

| ID | Requirement | Src |
| --- | --- | --- |
| O-01 | README, installation, quick start, CLI reference, MCP integration, Claude Code / Codex / Cursor setup, Android setup, iOS setup, self-hosted worker guide, architecture, contributing, security policy, license (permissive, after reviewing dependency licenses). | B13 |
| O-02 | CLAUDE.md / AGENTS.md so contributors' agents follow the repo's rules; docs kept in sync with behaviour; never claim unsupported features. | B16, C |
| O-03 | `PRODUCT.md` (this file) capturing every requirement, and a status file showing what is and is not implemented. | C |
| O-04 | Issue templates and a `tapdance report` flow so field testers (including the owner's VPS agent) open issues with what happened, what was expected, steps and evidence; real users' missing features flow in as issues. | C |

## 16. Testing and proof

| ID | Requirement | Src |
| --- | --- | --- |
| Q-01 | Unit tests: CLI args, provider interface, lease lifecycle, identity, MCP schemas, errors, config, JSON output. | B12 |
| Q-02 | Integration tests: Simlock connectivity, discovery, lease/release, install, screenshot, recording, logs; external tools (discovery, version, help, forwarding, output, exit codes, env, location, a new mock subcommand without code changes, no credential leaks). Mocks clearly labelled. | B12, A10, T12 |
| Q-03 | Documented E2E procedures: Android emulator on Linux with KVM, Android emulator on macOS, iOS simulator on macOS. | B12 |
| Q-04 | Never claim a real-device test passed when it was mocked. | B12, T12 |
| Q-05 | Proof — N2: provision, verify KVM, boot Pixel emulator, install APK, connect to Simlock, lease from a separate Linux VPS, launch, screenshot, release. | G |
| Q-06 | Proof — laptop worker: non-KVM VPS with Claude Code + gateway; laptop with emulator + worker (outbound); register, discover, lease from VPS via MCP, APK transfer/install, launch, UI interaction, screenshot, recording, logs, artifacts back on VPS, release. Two separate machines. | L, D13 |
| Q-07 | Proof — BYOI full: as Q-06 with an N2 worker, plus a browser on a separate laptop viewing and driving the live emulator, recording, MP4/screenshot/logs on the VPS, cleanup. | W10 |
| Q-08 | Proof — iOS: Linux VPS with Claude Code; separate Mac mini with Xcode and worker; register, discover, lease, `.app` transfer, install, launch, MCP interaction, screenshot, recording, logs, artifacts back, release. | I13 |
| Q-09 | Proof — AXe on a real Mac: discover via Simlock, lease, UDID, AXe inspect, tap by label, text, screenshot, MP4, artifacts to VPS, release. | X |
| Q-10 | Proof — Android CLI on an N2 worker with a Simlock-assigned emulator, routed from a different VPS: layout, interactions, annotated screenshots, results back. Genuine CLI, not mocks. | N |
| Q-11 | Run tests at every stage; keep the project buildable; never skip failing tests silently. | B15, B16 |

## 17. Ways of working (owner's notes)

| ID | Requirement | Src |
| --- | --- | --- |
| K-01 | Use subagents and workflows to review the work from several perspectives (architecture, developer, ease of use, documentation, coding agent, and anything missed), with a prompt-architect step first. | C |
| K-02 | The owner will hand the finished repo to an agent on a real VPS for field testing; it files GitHub issues for real problems (what failed, what was expected, how to reproduce). | C |
| K-03 | After the first slice, report: what was built, decisions, files, install/run commands, tests and results, what works on Android, what needs macOS, limitations, next milestone. | B16 |

## 18. Protecting personal Macs (host security)

| ID | Requirement | Src |
| --- | --- | --- |
| H-01 | Threat model: the VPS, agent, repository, uploaded app and every remote request may be malicious. Remote device control must not imply host control; a compromised VPS must not become a compromised Mac. | S1, S13 |
| H-02 | The worker exposes a narrow, typed device API (discover, lease, boot/shutdown the assigned simulator, install an uploaded artifact, launch, inspect, gestures, screenshots, recordings, simulator logs, release) and never arbitrary shell, SSH, sudo, arbitrary or home-directory file access, host deletion, Keychain, host shutdown, other apps, AppleScript/GUI automation. No caller-supplied filesystem paths: artifact ids mapped to worker staging; fixed executables and argument arrays. | S2 |
| H-03 | A dedicated standard (non-admin) `tapdance-worker` macOS account with no personal files, iCloud, Apple credentials, SSH keys, Keychain access or signing certificates; dependencies installed by an admin; worker never as root; unprivileged LaunchAgent; documented setup and removal. | S3 |
| H-04 | A local permission policy, administered only on the Mac, that remote requests cannot change or loosen; multiple locally authorized profiles. | S4 |
| H-05 | Pairing needs local approval; unique worker identity; one-time enrollment; revocable credentials; mutual authentication where appropriate; short-lived session tokens; per-lease authorization and scopes; expiry; replay protection; local disconnect/revoke; each operation validated on the worker. | S5 |
| H-06 | Per-session staging directories, no path traversal, upload type/size validation, unique session ids, no cross-session access, storage quotas, automatic cleanup, artifacts only for the owning session, no personal directories mounted. | S6 |
| H-07 | Resource limits: concurrent simulators, active sessions, upload size, recording duration, artifact storage, temp space, process monitoring, session timeouts, cleanup, health checks. | S7 |
| H-08 | Device-only mode by default (no remote builds, no code execution); approved-build mode only after explicit local authorization with a warning about Run Script phases; isolated-build mode investigated with disposable macOS VMs (Virtualization.framework), with Apple licensing documented. Never claim ordinary Xcode builds are sandboxed. | S8 |
| H-09 | macOS privacy permissions (Accessibility, screen capture) granted only to the worker account and required binaries; only the leased simulator targeted; the app's sandbox is not treated as host isolation. | S9 |
| H-10 | Profiles: local device-only, self-hosted remote worker, managed multi-tenant (strong isolation, short-lived environments, strict limits, no credential sharing, auditable, network restrictions); the personal-Mac model is not enough for multi-tenant hosting. | S10 |
| H-11 | Local audit log of pairing, authorization changes, sessions, leases, installs, build approvals, resets, recordings, terminations, revocations — never keys, passwords, tokens or app contents; the owner can inspect and revoke independently of the VPS. | S11 |
| H-12 | Security tests with a deliberately malicious client: no shell, no sudo, no home reads, no deletes outside the workspace, no Keychain, no policy changes, lease scoped to its simulator, no cross-session artifacts, expired credentials rejected, revocation immediate, builds refused in device-only mode, limits enforced. API-level tests are distinguished from OS/virtualization vulnerabilities. | S12 |

## 19. Product direction: the mobile lifecycle (phased)

| ID | Requirement | Src |
| --- | --- | --- |
| Y-01 | Lifecycle coverage over time: development (discover projects, build with native tools, install, launch/terminate, sessions), exploration, testing, debugging, release (archives, signed IPA, APK/AAB, asc, Play tooling) — orchestrated, not reimplemented. | V2 |
| Y-02 | `tapdance doctor` across all configured workers, not just this machine; for each missing dependency: what, which machine, why, mandatory or optional, how to install, how to verify. | V3 |
| Y-03 | Capability model per worker and device (platform, model, OS/runtime, resolution, interaction, screenshot/recording support, build/test capabilities, tool versions, location, resources) and queries such as "which device supports iOS 27 and screen recording?" returning only genuinely compatible devices. | V4 |
| Y-04 | Concise structured UI inspection (roles, labels, ids, enabled state) with filtering/pagination/summaries; semantic, identifier, text and resource-id selectors; coordinate fallback; never invent accessibility data. | V5 |
| Y-05 | Screenshots as first-class artifacts with metadata (device, platform, OS, app version, session, timestamp, test step), annotations/highlighting where supported, history per session, comparison; return references and let the agent pick which images to view. | V6 |
| Y-06 | Visual regression using existing image-comparison libraries: annotated diffs, machine-readable results, tolerance for animation and dynamic content. | V6 |
| Y-07 | Repeatable testing through existing frameworks (Maestro, XCTest/XCUITest, Espresso, UI Automator, Detox, Patrol, Appium) via their native CLIs, capability-based; a common result envelope (test, session, framework, platform, device, status, duration, failure, screenshot/recording/log refs, original result files) that preserves `.xcresult`, JUnit, Maestro reports. | V7 |
| Y-08 | Evidence packages per test run (summary, environment, screenshots, recordings, accessibility, logs, native results, metadata incl. git commit/branch, build, device, OS, resolution, bundle id, framework, tool versions, timestamps, failures); "give me the evidence for the failed test" works. | V8 |
| Y-09 | Session replay reflecting the underlying framework (e.g. converting a successful exploratory session into a Maestro flow); dependencies on auth, network, location, time made visible; no claim of perfect replay. | V9 |
| Y-10 | Device environment controls (location, network, orientation, appearance, locale, timezone, time, battery, permissions, camera, biometrics, deep links, data reset, background/foreground) through native tooling, checked against capabilities, each answering succeeded / unsupported / needs permission / needs restart / needs physical device / needs another OS. | V10 |
| Y-11 | Explicit interaction states: agent-controlled, human-controlled, read-only viewing, paused, disconnected; no conflicting input. | V11 |
| Y-12 | Device snapshots and reproducible states (pre-installed app, logged-in account, onboarding state, permissions, locale, data fixtures) using native capabilities; no portable-snapshot promises across models/runtimes; cleanup/reset policies. | V12 |
| Y-13 | Observability: per-operation metadata (operation, status, worker, device, duration, timestamp), logs across VPS/gateway/worker/simulator, resource reporting, job cancellation, failed-provisioning recovery, recording recovery; minimal telemetry, no private app data uploaded by default. | V13 |
| Y-14 | Workflow orchestration: identify platform and environment, build, install, test, collect evidence, report, let the agent fix, repeat, prepare release artifacts, ask authorization before publishing — composable, never blocking direct use of native tools. | V14 |
| Y-15 | `tapdance project inspect`: project name, platforms, framework, package/bundle ids, build tools, test frameworks, workers, devices, build configurations, integration status — no guessing. | V15 |
| Y-16 | Consistent session, job, worker and artifact ids; commands such as `session status`, `session logs`, `artifacts list/get`, `workers status`; auditable history without sensitive data. | V16 |
| Y-17 | Roadmap phases: (1) foundations — CLI, MCP, local Android and Mac workers, remote workers, Simlock, Android CLI, AXe, discovery/leasing, screenshots, recordings, logs, capabilities, doctor, secure connectivity; (2) testing — structured UI, semantic interaction, Maestro/XCTest/Espresso, result envelope, evidence, replay, cleanup; (3) debugging — visual regression, failure diagnosis, annotations, environment controls, snapshots, human takeover, streaming; (4) lifecycle — Android/iOS builds, archives, asc, fastlane, release preflight, publish authorization; (5) infrastructure — multiple workers, pools, scheduling, resources, BYOI automation, cloud provisioning, managed Android/Mac, metering. | V19 |

## 20. Landscape (keep current)

| ID | Note | Src |
| --- | --- | --- |
| Z-01 | **mobile-mcp** (mobile-next/mobile-mcp, Apache-2.0, ~10k stars): an MCP server for iOS/Android simulators, emulators and real devices on one machine, built on `mobilecli`, with its own paid device cloud. Strong overlap at the tool layer. Tapdance's difference must stay in self-hosted fleets (Simlock), remote personal-machine workers with a local security boundary, lease/session safety, evidence and human take-over — and it should consider mobile-mcp/mobilecli as a candidate backend rather than compete tool for tool. | C |
| Z-02 | **Mobdev** (named by the owner as a free Mac app with relay-based remote access): not yet located or evaluated — needs a link. | C |
| Z-03 | Also seen: Loupe, DeviceDeck, serve-sim, SimDeck, simpod, sim-use, Argent, agent-device's own MCP server, Simlock's MCP server. | C |
