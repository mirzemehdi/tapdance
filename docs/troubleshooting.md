# Troubleshooting

Start with:

```bash
tapdance doctor          # every check prints a fix when it fails
tapdance worker check    # this machine's SDKs, KVM and Xcode (changes nothing)
tapdance config show     # the merged configuration and where it came from
```

Every Tapdance error has a stable code, a message and usually a `fix:` line. With `--json` the error is
`{"error": {"code", "message", "retryable", "hint", …}}` on stdout. Exit codes per code are in the
[CLI reference](cli-reference.md#exit-codes). Add `TAPDANCE_DEBUG=1` to see the underlying stack trace.

The messages below are quoted from the code (with paths and names shortened).

## Installation

| Symptom | Cause | Fix |
| --- | --- | --- |
| `npm install -g tapdance` installs a "Test Anything Protocol" harness | The npm name `tapdance` belongs to an unrelated package; Tapdance is not published yet. | `npm uninstall -g tapdance`, then [install from source](installation.md#from-source-the-supported-way-today). |
| Your agent cannot start `tapdance` | `tapdance` is not on the `PATH` the agent sees. | In the MCP config use `"command": "node"` and the absolute path to `packages/cli/dist/main.js`. |
| `doctor`: Node.js fails | Node older than 22.13. | Install Node.js 22.13 or later. |

## Local worker

| Error | Cause | Fix |
| --- | --- | --- |
| `PROVIDER_UNAVAILABLE` "No local Simlock worker profile at ~/.simlock/agent-device-profile.json" | The local worker is not running, or was never set up with agent-device. | `tapdance worker install` (first time), or `tapdance worker start`. |
| `PROVIDER_UNAVAILABLE` "… names no agent-device URL or token" | Simlock's profile is incomplete. | `tapdance worker restart`. |
| `PROVIDER_UNAVAILABLE` "This machine's worker has joined the gateway …, so it serves agents only through the gateway" | After `worker login`, the worker's own HTTP API is off. | Use the gateway from this machine too (`tapdance init --mode self-hosted --endpoint <gateway URL>`), or `tapdance worker logout` to serve local agents again. |
| `PROVIDER_UNREACHABLE` "Cannot reach Simlock at …" | Daemon stopped, wrong endpoint, or network path down. Retryable. | Local: `tapdance worker start`. Remote: check the endpoint, the TLS proxy and the network path; `tapdance doctor` shows which check fails. |
| `doctor`: "agent-device served by Simlock" fails | Simlock's agent-device capability is off or cannot find agent-device. | `tapdance worker install` (points Simlock at the bundled agent-device 0.21.35 and restarts). On a gateway, enable the capability there too. |
| `doctor`: streaming / remote input warns | `capabilities.stream` / `capabilities.input` off. | `tapdance worker install` (without `--no-stream`). On a gateway, `tapdance gateway setup` enables them. |
| `doctor`: "Simlock version" warns | The endpoint runs a Simlock other than 0.4.0. | Run Simlock 0.4.0 on the gateway and every worker. See [compatibility.md](compatibility.md). |
| `PROVIDER_UNAVAILABLE` "simlock … failed: …" | A bundled Simlock command failed during `worker`/`gateway` setup. | Read the quoted Simlock message; `tapdance worker logs` shows the daemon log. |
| `NOT_SUPPORTED` "Windows cannot run a Tapdance worker yet" | Simlock supports macOS and Linux only. | Use Windows as a control machine only; run the worker on a Mac or a Linux machine. |

## Platform tools

| Symptom | Cause | Fix |
| --- | --- | --- |
| `doctor`: "Android SDK … not found in ANDROID_HOME, ANDROID_SDK_ROOT or ~/Library/Android/sdk" | No SDK where Tapdance and Simlock look. | Install the SDK and set `ANDROID_HOME` (required on Linux). |
| `doctor`: "command-line tools (sdkmanager, avdmanager)" missing | Simlock needs them to create emulators. This is why Android is untested on the test Mac. | Install "Android SDK Command-line Tools (latest)" from Android Studio's SDK Manager, or unpack the download to `$ANDROID_HOME/cmdline-tools/latest`. Then `tapdance worker restart`. |
| `doctor`: platform-tools or emulator missing | SDK packages not installed. | `sdkmanager --install platform-tools` / `sdkmanager --install emulator`. |
| `doctor`: "System images … none installed" (warning) | Nothing to create an emulator from. | `tapdance devices install android 35`, or `sdkmanager "system-images;android-35;google_apis;<arm64-v8a or x86_64>"`. Accept licences first (`sdkmanager --licenses`). |
| `doctor`: "CPU virtualization flags … neither vmx nor svm" | The Linux machine exposes no hardware virtualization. | On Google Cloud use an N2 VM with nested virtualization enabled; elsewhere enable VT-x/AMD-V or choose a KVM-capable plan; or run emulators on another machine. Tapdance never falls back to software emulation. |
| `doctor`: "/dev/kvm present but not writable by this user" | Your user is not in the `kvm` group. | `sudo usermod -aG kvm $USER`, then log out and in (or `newgrp kvm`). |
| `doctor`: "/dev/kvm missing" | KVM module not loaded. | `sudo apt-get install -y qemu-kvm && sudo modprobe kvm_intel` (or `kvm_amd`). |
| `doctor`: Xcode fails | Xcode missing, not selected or not set up. | `sudo xcode-select -s /Applications/Xcode.app`, `sudo xcodebuild -license accept`, `sudo xcodebuild -runFirstLaunch`. |
| `doctor`: "Simulator runtimes … none" | No iOS runtime installed. | `xcodebuild -downloadPlatform iOS`, or `tapdance devices install ios <version>`. |
| `doctor` fails only because of Android on an iOS-only Mac | Android is enabled by default. | `tapdance config set platforms.android.enabled false`. |
| A tool you just installed is still reported missing by Simlock | Simlock detects platform tools only when its daemon starts. | `tapdance worker restart`. |

## Configuration and tokens

| Error | Cause | Fix |
| --- | --- | --- |
| `CONFIG_INVALID` "Invalid …: session.defaultTtlMinutes: …" | A key has a wrong value, or an unknown key (keys are strict). | Fix the file; `tapdance config show` shows the merged result. |
| `CONFIG_INVALID` "… is not a JSON object" | Broken JSON. | Fix it, or `tapdance init --force`. |
| `CONFIG_INVALID` "Config file … does not exist" | `--config` or `TAPDANCE_CONFIG` names a missing file. | Correct the path, or create it with `tapdance init`. |
| `CONFIG_INVALID` "Tokens must not be stored in config files" | A `token` or `operatorToken` key in a config file. | Remove it; use `tapdance config set-token` or `TAPDANCE_TOKEN`. |
| `CONFIG_INVALID` "provider is self-hosted but no endpoint is set" | | `tapdance init --mode self-hosted --endpoint https://gateway.example.com`, or `TAPDANCE_ENDPOINT`. |
| `CONFIG_INVALID` "Refusing to send a token over plain HTTP to …" | `http://` to a public host. | Put TLS in front of the gateway and use `https://`, or reach it over a private network (Tailscale, WireGuard, SSH tunnel). |
| `AUTH_FAILED` "No agent token for …" | Self-hosted mode without a token. | Mint one on the gateway (`tapdance gateway token --role agent --label <agent>`), then `tapdance config set-token` or `TAPDANCE_TOKEN`. |
| `AUTH_FAILED` (from the gateway) | Token missing, revoked, or minted by another daemon (Simlock tokens work only on the daemon that created them). | Store a valid agent token for this endpoint. |
| `doctor`: "Token accepted … role operator" (warning) | An operator token is stored as the agent token. | Agents should use an agent token. |
| `NOT_SUPPORTED` "Tapdance Cloud is not available yet" | `provider: "cloud"` is reserved. | Use `local` or `self-hosted`. |

## Sessions and leases

| Error | Cause | Fix |
| --- | --- | --- |
| `NO_ACTIVE_LEASE` "This session holds no device" | Nothing leased, or another session leased it. | `tapdance device lease --platform …` (MCP: `lease_device`). Check which session you are in with `tapdance doctor`. |
| `LEASE_ALREADY_HELD` "This session already holds …" | One lease per session. | Use it, or `tapdance device release` first. In MCP, `lease_device` for the same platform returns the held device instead. |
| `LEASE_LOST` "The lease on … has ended" | Expired, released, idle-released, or the worker restarted. Anything installed was wiped. | Lease again and reinstall the app. Raise `session.defaultTtlMinutes` or keep the keepalive on. |
| The agent's CLI and MCP tools hold two different devices | Codex, pi and Cursor do not pass their session id to MCP servers. | Use one interface per session, or set the same `TAPDANCE_SESSION_ID` in the shell and the MCP config. See [session identity](cli-reference.md#session-identity). |
| Two terminals fight over one device | Without an agent session, all your terminals are one per-user session. | `export TAPDANCE_SESSION_ID=<name>` per terminal, or `--session <name>`. |
| `tapdance view` says no device is leased while the agent has one | The viewer runs in a different session. | `tapdance --session <sessionId> view`, with the `sessionId` from `get_device_status`. |
| `TIMEOUT` "Another Tapdance process is busy with this session" | Another process holds the session lock (often a lease that is still booting). | Retry in a moment. |
| `TIMEOUT` "No device was granted within N s; nothing was leased" | The queue did not hand out a device in time. | Retry, raise `--wait` (the Simlock provider caps it at 330 s), or free capacity. |
| `NO_CAPACITY` | No free device. Retryable. | Release unused leases, wait, or add a worker. |
| `DEVICE_UNAVAILABLE` (Simlock `UNKNOWN_MODEL`, `RUNTIME_MISSING`, `NO_DRIVER`) | The model is unknown, its runtime/image is not installed, or the platform's tools are missing on every worker. | `tapdance devices` for valid models; `tapdance devices install <ios\|android> <version>` on the worker; `tapdance doctor`. |
| `WORKER_OFFLINE` | The worker holding the device is asleep, offline or restarting (Simlock `WORKER_UNREACHABLE`). Retryable; the lease stays yours until it expires. | Retry shortly. On a Mac laptop worker, `caffeinate -is` keeps it awake. |
| `HUMAN_HELD` "A person is controlling the device in the viewer" | Someone touched the screen in `tapdance view`. Retryable. | Wait `retryAfterMs` (default hold 15 s after the last touch) and retry, or press "Hand back" in the viewer. |

## Apps and UI

| Error | Cause | Fix |
| --- | --- | --- |
| `APP_PATH_INVALID` "No file or bundle at …" | Wrong path, or the app is not built. | Build first; pass the build output path. |
| `APP_PATH_INVALID` "… is not an .apk" | Android needs an `.apk` (an `.aab` is refused). | Use e.g. `app/build/outputs/apk/debug/app-debug.apk`. |
| `APP_PATH_INVALID` "… is a signed device build (.ipa); simulators need a simulator .app" | Device builds do not run on simulators. | Build with `-sdk iphonesimulator` and install the `.app`. |
| `APP_PATH_INVALID` "… should be an .app bundle directory" / "is not an iOS .app bundle" | Not a valid simulator app bundle. | Point at the `.app` directory from `Debug-iphonesimulator`. |
| `FORBIDDEN` "… is outside the project directory" (MCP) | `install_app` and `execute_tool` `cwd` are confined to the server's working directory. | Build inside the project, or add the folder to `TAPDANCE_ALLOWED_ROOTS` in the MCP server's environment. |
| `USAGE` "… is not a valid app id" | Package or bundle id has invalid characters. | Use e.g. `com.example.app`. |
| `ELEMENT_NOT_FOUND` | No element matches the target, or the ref is stale. | `tapdance ui inspect` (MCP: `inspect_screen`) and target by ref or exact label. |
| `ELEMENT_NOT_FOUND` "No text field has focus" | `type` without a target and nothing focused. | Pass a field (`--ref`, `--text`, `--id`; MCP `into_ref` …). |
| `USAGE` "Name one target, not 2 …" / "Name a target: …" | `tap`/`type` need exactly one of text, id, ref, selector, or x and y. | Give exactly one. |
| `ui wait` exits 1 / `wait_for` returns `found: false` | The condition did not happen within the timeout (max 30 s). | Not an error by itself: inspect the screen, take a screenshot, check logs. |
| `USAGE` "A recording is already running" / "No recording is running" | | `tapdance record stop` / `record start`. |
| `DEVICE_ERROR` "… failed: …" | The device command failed in agent-device or on the device. | Read the quoted message; check `tapdance logs` and `tapdance logs --crash`. |

## AXe iOS backend (untested on a real Mac)

| Error | Cause | Fix |
| --- | --- | --- |
| `NOT_SUPPORTED` "The AXe iOS backend only works when Tapdance runs on the Mac that hosts the simulator" | `ios.uiBackend: "axe"` with a remote endpoint. | Set `ios.uiBackend` to `agent-device` for remote Mac workers. |
| `PROVIDER_UNAVAILABLE` "AXe is not installed on this Mac" | | `brew install cameroncooke/axe/axe`, or set `ios.axePath`. |
| `PROVIDER_UNAVAILABLE` "AXe cannot see the leased simulator" | AXe reads only Xcode's default device set. | `tapdance worker install --ios-backend axe` (sets Simlock's `drivers.ios.deviceSet` to `default`). |
| `NOT_SUPPORTED` "The AXe backend has no alert handling" / "… not agent-device selectors" | Limits of the AXe backend. | Tap the alert's button by label; target by text, id, ref or coordinates. |

## External tools

| Error | Cause | Fix |
| --- | --- | --- |
| `PROVIDER_UNAVAILABLE` "<tool> is not installed on this machine" | Not on `PATH`. | Install it (`tapdance tools doctor` prints how) or set `tools.paths.<tool>`. |
| `NOT_SUPPORTED` "<tool> does not run on <os>" | e.g. `axe` or `xcodebuild` off macOS. | Run it on a Mac. |
| `FORBIDDEN` "Agents may not run <tool> here" | Not in `tools.mcpEnabled`. | Add it to `tools.mcpEnabled` if you want agents to run it. |
| `FORBIDDEN` "<tool> has no read-only mode, so agents need your authorization to run it" | `fastlane` or `xcodebuild` from an agent. | Add it to `tools.allowMutation`; the agent then passes `allow_mutation: true`. |
| asc refuses a write from an agent | Agents run asc with `ASC_READ_ONLY=1`. | Intended. To allow it, add `asc` to `tools.allowMutation`. |
| `FORBIDDEN` "<tool> acts on the leased device; do not pass --udid" | Tapdance adds the device itself. | Remove `--udid` / `--device`. |
| `NO_ACTIVE_LEASE` "<tool> acts on the session's device; lease one first" | `axe`/`maestro` without a lease. | Lease a device first. |
| `NOT_SUPPORTED` "<tool> must run where the device is; this session's device is on a remote worker" | Lease-scoped tools need the device locally. | Use Tapdance's own device tools, which work through a gateway. |
| `NOT_SUPPORTED` "Execution target "…" is not available yet" | Only `control` exists today. | Run Tapdance on the machine that has the toolchain. |
| `USAGE` "<tool> works on android devices; this session holds ios" | Platform mismatch. | Lease the right platform. |

## Gateways, workers and the viewer (untested across machines)

| Error | Cause | Fix |
| --- | --- | --- |
| `FORBIDDEN` "Joining a gateway gives it, and every agent token it issues, command execution on this machine …" (`worker login`) | `worker login` was run without `--accept-gateway-exec`. | Pass `--accept-gateway-exec` only on a machine dedicated to being a worker; read [worker-security.md](deployment/worker-security.md) first. |
| `USAGE` "Refusing ws:// to public host …" (`worker login`) | The join token would travel in plain text. | Use `wss://` behind TLS, or a private address (Tailscale). |
| `FORBIDDEN` "Listing workers needs an operator token" | `workers list` (or MCP `list_workers`) through a gateway. | `tapdance config set-token --operator` for the CLI. The MCP server never loads the operator token, so `list_workers` stays unavailable through a gateway. |
| `doctor`: "Workers online" fails | No worker connected to the gateway. | Start a worker and join it. Note: the fix text mentions `--token …`, but `worker login` has no such option; pipe the token instead: `echo '<join token>' \| tapdance worker login --accept-gateway-exec --gateway wss://… --label …` or set `TAPDANCE_WORKER_TOKEN`. |
| A worker shows `incompatible` | Gateway and worker run Simlock versions that cannot talk. | Run Simlock 0.4.0 everywhere ([compatibility.md](compatibility.md)). |
| `USAGE` "Refusing to serve the viewer on public address …" | `tapdance view --host` with a public IP. | Keep `127.0.0.1` and use `ssh -L 4710:127.0.0.1:4710 <host>`, or a private network. |
| Viewer: `NOT_SUPPORTED` (Simlock `STREAM_UNAVAILABLE` / `INPUT_UNAVAILABLE`) | Streaming or input capability off. | `tapdance worker install` (and `gateway setup` on a gateway). |

## Bugs found by running for real (fixed)

From [STATUS.md](../STATUS.md). If you see one of these, you are on an older build: pull and rebuild.

| What happened | Cause | Fix |
| --- | --- | --- |
| Live stream answered `STREAM_UNAVAILABLE … simlock-screen-capture EACCES` | pnpm extracted Simlock's bundled capture helpers without the execute bit. | `worker install` / `worker start` restore it. |
| `worker install` failed with `DAEMON_CONNECTION_LOST` | `simlock daemon stop` returns while the old daemon drains. | Wait for `status: stopped`, then start with retries. |
| Lease refused with "this agent-device is too old for simlock" | Simlock requires a client-chosen 32-hex lease id; the message is misleading. | The provider always sends one. |
| A config written by an earlier build stopped loading | `leaseWaitSeconds` maximum lowered to 330. | Accepts up to 3600 again; the provider caps at 330. |
| `agent-device` not found by `worker install` | ESM-only package; `require.resolve` cannot see it. | Uses `import.meta.resolve`. |
| First `open` failed with `AMBIGUOUS_MATCH` | Session opened without naming the leased UDID. | Lease always opens the session with the leased device id. |

## Reporting a problem

```bash
tapdance report --title "lease times out on N2 worker" --kind bug \
  --steps "tapdance device lease --platform android" --expected "a Pixel lease" \
  --actual "$(tapdance --json device lease --platform android 2>&1)" -o report.md
```

This writes a Markdown report with versions, OS, provider, session source, the current lease and the
`doctor` results. Tokens are redacted, but read it before posting. Attach screenshots or logs with
`--evidence <comma-separated paths>`.
