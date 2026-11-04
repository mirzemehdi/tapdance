# ADR 0001 — Build Tapdance on Simlock and agent-device

- Status: Accepted
- Date: 2026-11-01
- Deciders: Tapdance maintainers

## Context

Tapdance lets an AI coding agent lease an Android emulator or iOS simulator, install an app,
drive its UI, and collect screenshots, recordings and logs. It must work in three deployment
modes with one CLI/MCP/SDK surface:

- **A — Local:** devices on the developer's own machine.
- **B — Bring your own infrastructure (BYOI):** the agent runs on an ordinary VPS (no KVM); devices
  run on separate workers the developer owns — a KVM Linux box (Google Cloud N2, OVH, bare metal) or
  the developer's own laptop/Mac.
- **C — Managed cloud (future, paid):** hosted devices; only the configured provider changes.

Before writing code we audited two existing Callstack projects. Findings below come from reading
their source and docs at the versions named, and from running them on a real Mac (macOS 26.5,
Xcode 26.5, M1 Pro) — not from their marketing.

### Simlock (`callstackincubator/simlock`, npm `simlock@0.4.0`, repo HEAD `a345362`)

License: **MIT** (© 2026 Szymon Chmal). Vendored third-party parts inside it (scrcpy server,
serve-sim capture) are Apache-2.0 with their own NOTICE files; Tapdance does not copy them.

What it already does, verified:

| Concern | Simlock capability |
| --- | --- |
| Device lifecycle | Creates, boots, wipes, deletes its own simulators/emulators in an isolated device set / adb server. Never touches devices it did not create. Warm pool, idle cleanup, crash reboot under the same lease. |
| Leasing | Exclusive leases with TTL (default 15 min, max 4 h), renew, release, expiry; FIFO queue; per-requester limits; idempotency keys. |
| Fleet | A **gateway** daemon owns no devices; **workers dial out** to it over an authenticated WebSocket (`/v1/uplink`). No inbound port on the worker. Reconnect with backoff; disconnected workers are marked and get no new requests; leases on them answer `WORKER_UNREACHABLE` until they return. Join tokens are per-worker, paired to the worker id, revocable. |
| Access control | Token roles `agent`, `operator`, `worker`; only hashes stored; tokens work only on the daemon that minted them; an agent token sees only its own leases. |
| HTTP API | `/v1/lease-requests`, `/v1/leases/{id}` (+`renew`, `exec`, `events`, `stream`, `input`, `rotate`), `/v1/status`, `/v1/catalog`, `/v1/identity`, `/v1/healthz`, `/v1/workers` (admin). Same API on a worker and a gateway. No TLS built in — put Caddy (or similar) in front, or keep it on a private network. |
| Exec | Runs one `adb`/`simctl` command on the worker for a lease, device filled in, dangerous verbs refused. Paths are on the worker, output is text only (binary stdout breaks), no upload. **Effectively shell access to the worker as the daemon user** — Simlock's docs say so. |
| Screen | `GET /v1/leases/{id}/stream`: H.264 (AVCC + avcC description) in a 5-byte-header framing, holder-readable. `WS /v1/leases/{id}/input`: serve-sim input protocol (touch, buttons, HID keys); Android input via a control-only scrcpy server. Both off by default (`capabilities.stream.enabled`, `capabilities.input.enabled`). The built-in console is **view-only** and operator-only. |
| MCP | `simlock mcp`: a handful of low-level tools (five in 0.4.0; HEAD adds `rotate_device`) including `run_on_device` (raw adb/simctl). |
| Hosts | Workers: macOS (iOS + Android) and Linux (Android). Gateway: any Node 22.13+ host. **No Windows support.** |
| Programmatic | `simlock/client` — local socket only. |

What it does not do: upload an app from the agent's machine, read the UI tree, tap by selector,
return binary artifacts (screenshots/videos) to a remote caller, or offer an agent-level tool
surface. Its own docs point to agent-device for that.

### agent-device (`callstack/agent-device`, npm `agent-device@0.21.35`)

License: **MIT**. A device-automation layer for agents: accessibility snapshots with refs,
selector-based press/fill, scroll, swipe, type, screenshots, recordings (MP4), app logs, replay
scripts — with a typed Node.js API (`createAgentDeviceClient`) and its own MCP server.

Simlock runs agent-device daemons on every worker (on by default on a standalone worker, opt-in on a
joined worker) and fronts them at `/v1/agent-device/*`. Through that proxy:

- `leases.allocate` **is** a Simlock lease (queued, provisioned, owned by the token, visible in
  `simlock status`). The client must choose the lease id (Tapdance sends 32 lowercase hex) or Simlock
  refuses with a misleading "agent-device is too old" message.
- `apps.install` **uploads the app from the caller's machine** to the worker (Simlock caps the
  proxy's artifact *downloads* at 2 GiB and an `/rpc` body at 1 MiB).
- Screenshots and recordings are **downloaded back to the caller's paths**.
- Every command renews the Simlock lease while it runs.

Spike results on this Mac (local Simlock worker, `agent-device` via proxy, iPhone 16 / iOS 18.5):
first lease 40 s (provision + boot), warm lease 0.5 s; `open` → 17-node interactive snapshot →
`press label="General"` (with settle diff) → `back` → `scroll` → MP4 recording (6 MB) → screenshot
PNG → app logs path → release. `POST /v1/leases/{id}/exec` with the same token works on a lease
agent-device allocated.

### Other candidates for browser streaming

- **DeviceDeck** (devicelab-dev, Apache-2.0, v1.0.1): serves a local simulator/emulator in a browser
  with a DOM mirror and MCP. Single host, one simulator + one emulator per Mac, no lease/gateway
  model, one contributor. Not selected: it would be a second device owner competing with Simlock.
- **Loupe** ([bmcreations/loupe](https://github.com/bmcreations/loupe), Apache-2.0, Go, commit `8b46068`):
  streams Android devices/emulators and iOS simulators from a **Mac** to a browser at 60 fps
  (WebTransport, WebSocket fallback) and lets a person and an agent share a device: the browser shows
  the agent's cursor and "claude is driving", a human touch takes over and agent input is refused with
  `humanHeld` plus a retry time, and "hands off" refuses agents entirely. Not selected as the device
  owner: it is a single-host macOS service that drives the user's own AVDs/adb directly, so it would
  compete with Simlock for the same devices and has no Linux worker or gateway lease model. **Adopted as
  a design reference** for the viewer's human/agent hand-off (`HUMAN_HELD`, take-over, hand-back).
- **simslim** ([MobAI-App/simslim](https://github.com/MobAI-App/simslim), MIT, © 2026 Interlap):
  disables ~180 background launchd services in an iOS simulator, cutting memory ~4× (4.0 → 0.9 GB on an
  M1 Pro). Simlock already ships the same idea as `--mode slim` (Simlock ADR 0002, credited in its
  prior-art page). Tapdance does not expose it yet because agent-device's lease allocation, which
  Tapdance uses, has no `mode` field; recommended for macOS workers via Simlock warm-pool targets, and
  tracked as an upstream request.
- serve-sim, SimDeck, simpod, tapflow exist; Simlock already embeds a patched serve-sim capture and
  its input protocol, so adopting any of them would duplicate what the gateway already relays.

## Decision

**Tapdance does not reimplement orchestration, leasing, queuing, workers, gateways or device
automation.** It is a thin, opinionated layer that composes Simlock (orchestration, fleet, streaming)
and agent-device (automation, upload/download), and adds what neither has:

1. **One stable contract** (`DeviceProvider` in `@tapdance/core`) so the CLI, MCP server and SDK never
   name Simlock. The first implementation, `@tapdance/provider-simlock`, serves both mode A (local
   worker) and mode B (remote worker or gateway) — they differ only in endpoint and token. A future
   `tapdance-cloud` provider implements the same interface; config `provider: "cloud"` is reserved and
   currently fails with a clear "not available" error. No fake cloud provider exists.
2. **Session-scoped safety.** Every device command resolves the *active lease of the current session*
   from a session record; there is no command or tool that takes an arbitrary device id. Release only
   ever targets the session's own lease, and Simlock/agent-device enforce token ownership underneath.
   Session identity: `TAPDANCE_SESSION_ID` → `CLAUDE_CODE_SESSION_ID` → `CODEX_SESSION_ID` →
   `PI_SESSION_ID` → a per-user CLI identity (MCP: per server process).
3. **Agent-grade tools, no raw shell.** MCP and CLI expose install/launch/stop, inspect, tap (by
   text/id/selector/ref, coordinates as fallback), swipe/scroll, type, keys, screenshots, recordings,
   logs and crash logs. Tapdance uses Simlock `exec` internally only for a fixed allowlist (stop app,
   logcat dump, crash buffer, simulator log query). Raw `adb`/`simctl` is never an MCP tool.
4. **Lease lifecycle for one-shot CLIs.** `tapdance device lease` returns immediately and starts a
   detached keepalive that heartbeats every TTL/3, stops when the session releases, the lease is lost,
   or `session.maxSessionMinutes` passes. `--hold` keeps the lease in the foreground and releases on Ctrl-C.
   The MCP server renews in-process and releases on shutdown.
5. **Artifacts.** Screenshots, recordings and logs land on the agent's machine (agent-device downloads
   them) under `artifacts.directory/<session>/` with a JSON manifest, behind an `ArtifactStore`
   interface so a hosted provider can use S3/R2 later. Nothing is stored in a database.
6. **Browser viewer.** `tapdance view` runs a small loopback-only web server that proxies the lease's
   Simlock `stream` and `input` endpoints, holding the token server-side, and serves a WebCodecs page
   (live H.264, tap/swipe/scroll, keyboard, Home/Back, screenshot, lease status). The developer reaches
   it through SSH port-forwarding or a private network — never a public port, never ADB.
7. **Guided BYOI setup.** `tapdance gateway setup`, `tapdance worker login` and `tapdance worker check`
   wrap Simlock's own commands (start gateway, enable `agent-device`/`stream`/`input`, mint tokens, set
   the worker's `gateway` uplink, restart) and add host checks Simlock lacks: CPU virtualization flags,
   `/dev/kvm` access, `kvm-ok`, `emulator -accel-check`. Provisioning stops on missing acceleration;
   Tapdance never falls back to software emulation.
8. **Infrastructure as reference, not dependency.** Terraform for Google Cloud N2 and a provider-agnostic
   Ubuntu install script live under `infrastructure/`. Nothing in `packages/` knows about any cloud.

### Your laptop as a worker

The "local worker" the BYOI spec asks for is a **Simlock worker joined to a gateway**: it dials out to
`wss://<gateway>/v1/uplink` with a per-worker join token, needs no inbound port, reconnects on its
own, and runs agent-device so the VPS can upload APKs and get artifacts back. `tapdance worker login`
does the setup on macOS/Linux. Differences from the wording of the spec, stated plainly:

- Simlock leases **devices it creates** from installed system images/runtimes; it does not hand out
  the developer's personal AVDs or simulators. That protects the developer's own devices from agents.
  `tapdance worker check` still reports the SDK, installed images, AVDs and running emulators.
- **Windows is not supported** as a worker: Simlock and its emulator driver run on macOS and Linux
  only. A Windows worker would need a separate device owner; it is out of scope until Simlock adds it.
- Simlock has no per-operation "local confirmation" prompt. The worker owner's controls are: what the
  worker is joined to, `capabilities.*` switches, draining (`simlock worker drain`), token revocation,
  and stopping the daemon.

## Consequences

- Tapdance stays small: five packages, most of the code is mapping, validation, output and safety.
- Tapdance inherits Simlock's and agent-device's release cadence. We pin exact versions
  (`simlock@0.4.0` at this decision, `simlock@0.5.0` since 2026-11-04; `agent-device@0.21.35`) and test
  against them. A fix that belongs in Simlock or agent-device but cannot wait for a release ships as a
  pnpm patch in `patches/` (applied by `pnpm install`, listed in NOTICE.md) rather than a fork: today
  one for agent-device (#56) and one for Simlock (#94, #79).
- Leasing is **not a sandbox**. An agent token on a worker is close to shell access as the daemon user
  (Simlock `exec`, agent-device). Multi-tenant hosting (mode C) needs per-tenant workers or VMs, not
  just leases. Tapdance documents this and does not claim isolation.
- Features that need Simlock changes (Windows workers, per-operation approval on the worker, binary
  exec output) are upstream contributions, not Tapdance forks.

## Later decisions (same day)

### External tools: a registry, not command catalogues

The owner asked that the official App Store Connect CLI (`asc`, rorkai/App-Store-Connect-CLI, MIT),
Google's Android CLI, AXe, Maestro, fastlane and xcodebuild be usable by agents without Tapdance
reimplementing them. Tapdance keeps a small **tool registry** (`packages/sdk/src/tools.ts`) with
metadata only — executable, OS, where it must run, install guidance, license, discovery commands, the
environment it may see — and forwards arguments unchanged with `execFile`-style argument arrays.
A subcommand added upstream works the day the user updates the tool. Agents reach it through one MCP
tool, `execute_tool`, whose schema never changes.

Safety comes from policy, not allowlists of subcommands:
- agents may run only tools listed in `tools.mcpEnabled`; that key, `tools.allowMutation` and
  `tools.paths` are read only from the user's own config, never from a repository's
  `tapdance.config.json`;
- `asc` runs under its own `ASC_READ_ONLY=1` for agents unless the user lists it in
  `tools.allowMutation` *and* the call asks (`allow_mutation`); fastlane has no read-only mode, so
  agents need that authorization to run it at all; without it, the few `asc` commands that print
  credentials or run shell steps (`auth` other than `auth status`, `workflow`, `install-skills`) are
  refused;
- tools that act on a device (AXe, Maestro, Android CLI) are **lease-scoped**: Tapdance appends or sets
  the leased device (`--udid`, `--device`; for the Android CLI `--device=<serial>` on subcommands
  that list it, plus Simlock's private `ANDROID_ADB_SERVER_PORT`), strips inherited selectors and refuses caller-supplied ones;
- the parent environment is not forwarded except a base set and the tool's own prefix (`ASC_*`);
  output is capped, saved in full as an artifact, and redacted (tokens, PEM private keys).

### AXe as an iOS backend

AXe (cameroncooke/AXe, MIT; bundles Meta IDB) is supported as `ios.uiBackend: "axe"`. Two facts from
its source shape that: it reads only Xcode's **default** CoreSimulator device set (it passes
`deviceSetPath: nil`), while Simlock keeps its simulators in a private set by default — so a worker
using AXe must set `drivers.ios.deviceSet default`; and AXe drives CoreSimulator on the Mac it runs on,
so it works only when Tapdance runs on that Mac. agent-device stays the default because it already
works through gateways. The owner also listed `ios_*` MCP tool names; they conflict with the
requirement for a platform-independent interface, so Tapdance keeps one neutral tool set whose iOS
backend may be AXe, and treats aliases as an open product decision.

### Remote execution targets: a real gap

Running `asc`, AXe, the Android CLI or xcodebuild **on a remote worker** needs something on that worker
that accepts authorized commands. Simlock's `exec` deliberately allows only `adb`, `simctl` and
`devicectl`. Options, in order of preference: (1) an upstream Simlock feature for operator-declared
tools on `exec`; (2) a small Tapdance worker sidecar reachable only through the gateway's
authenticated relay; (3) SSH, rejected because it would hand agents a shell. Until then
`execute_tool` runs on the control machine only and says so (`NOT_SUPPORTED`). Device work on remote
workers is unaffected: it goes through agent-device and Simlock.

### Google's Android CLI

Registered as an external tool, lease-scoped through adb's environment. Its public docs do not publish
device-selection flags, and it is not installed on the test machine, so its device targeting is
**unverified** and agent-device remains the default Android backend until a real run.

### Personal Macs: a worker guard (genuine gap, built)

Requirement H (PRODUCT.md §18) says remote device control must not imply host control, enforced on the
Mac. Simlock 0.4.0 cannot do that (nor 0.5.0, which has no setting to turn `exec` off): its `exec` route is reachable by any agent token, `simctl spawn`
starts any program (its docs say so), there is no switch to disable it, and a joined worker gives the
gateway operator rights. Contributing exec scopes upstream is the right long-term fix, but no released
Simlock has them, so Tapdance builds the missing piece:

- **`tapdance worker guard`** runs on the Mac under a dedicated standard account, in front of a
  loopback-only, *unjoined* Simlock. It speaks the subset of Simlock's HTTP API that Tapdance's provider
  uses, so the control machine's `self-hosted` provider needs no changes.
- It issues its own tokens after local approval, keeps the policy on the Mac, allowlists routes,
  agent-device commands and exact `exec` argument lists, binds leases to clients, caps sessions, lease
  TTLs and uploads, and writes a local audit log.
- Network: the control machine reaches it over a private network (Tailscale). That trades the gateway's
  fleet features (one queue across workers) for a boundary the Mac enforces; for dedicated hardware the
  gateway path remains, behind an explicit `--accept-gateway-exec`.
- Proven by malicious-client unit tests (`guard.test.ts`) and a real MCP loop through it; untested: the dedicated account,
  Tailscale exposure, Android through it.

### Landscape: mobile-mcp and others

mobile-next/mobile-mcp (Apache-2.0, ~10k stars) already gives agents a broad single-machine MCP tool
set for iOS/Android simulators, emulators and real devices, built on `mobilecli`, plus a paid device
cloud. Tapdance should not compete tool for tool. Its reason to exist is what neither mobile-mcp nor
agent-device's own MCP covers: self-hosted fleets and queues (Simlock), personal machines as remote
workers with a host boundary they enforce, session/lease safety for parallel agents, evidence and
artifacts back on the control machine, human take-over, and one orchestration surface over external
tools. `mobilecli` is a candidate interaction backend to evaluate next to agent-device and AXe.
"Mobdev" (named by the owner) has not been located yet.

## What is reused, added, and out of scope

| Reused from Simlock | Reused from agent-device | Added by Tapdance | Out of scope (MVP) |
| --- | --- | --- | --- |
| Leasing, TTL, queue, warm pool, cleanup | UI tree snapshots, refs, selectors | `DeviceProvider` contract + session scoping | Billing, subscriptions, dashboard |
| Gateway, worker uplink, tokens | press/fill/type/scroll/swipe/keys | Agent-oriented CLI with `--json`, exit codes | Hosted fleet, multi-tenancy, Kubernetes |
| Emulator/simulator drivers | App upload, artifact download | Agent-oriented MCP (stdio + Streamable HTTP) | Windows workers |
| Screen stream + input sockets | Screenshots, MP4 recording, app logs | Keepalive, artifacts manifest, browser viewer | Own device drivers or streaming stack |
| `exec` (internal allowlist only) | | KVM diagnostics, guided gateway/worker setup, Terraform | Replacing Android Emulator or Xcode |

## Attribution

Tapdance depends on Simlock and agent-device as npm packages and copies no code from either. Both are
MIT; their license notices travel inside their packages. `NOTICE.md` lists them. The browser viewer's
decoder is written from Simlock's published framing (5-byte header, avcC description, AVCC NAL
payloads) and the serve-sim input message format, not copied from their sources.
