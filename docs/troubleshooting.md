# Troubleshooting

Start with:

```bash
tapdance doctor
tapdance worker check
tapdance config show
```

`doctor` runs every check and prints a fix for each failure. `worker check` checks this machine's SDKs,
KVM and Xcode and changes nothing. `config show` prints the merged configuration and where each value
came from.

Every Tapdance error has a stable code, a message and usually a `fix:` line. With `--json` the error is
`{"error": {"code", "message", "retryable", "hint", …}}` on stdout. Exit codes per code are in the
[CLI reference](cli-reference.md#exit-codes). Set `TAPDANCE_DEBUG=1` to see the underlying stack trace.
The messages below are quoted from the code, with paths and names shortened.

This page has two parts. Find the machine where you see the problem:

- **[On the agent's machine](#on-the-agents-machine)**: installing, connecting to a host, config and
  tokens, sessions and leases, apps and UI, external tools, the viewer. In local mode this is your own
  computer.
- **[On the host](#on-the-host)**: the worker, platform tools, Linux and cloud hosts, rented Macs, the
  cost guard, builds, installs from CI, the guard, gateway mode. In local mode this is also your own
  computer.

Terms (host, worker, guard, connect target) are in the [glossary](glossary.md).

## On the agent's machine

### Installation

| Symptom | Cause | Fix |
| --- | --- | --- |
| `npm install -g tapdance` installs a "Test Anything Protocol" harness | The npm name `tapdance` belongs to an unrelated package; Tapdance is not published yet. | `npm uninstall -g tapdance`, then [install from source](installation.md#from-source-the-supported-way-today). |
| Your agent cannot start `tapdance` | `tapdance` is not on the `PATH` the agent sees. | In the MCP config use `"command": "node"` and the absolute path to `packages/cli/dist/main.js`. |
| `doctor`: Node.js fails | Node older than 22.13. | Install Node.js 22.13 or later. |

### Connecting to a host

These come from `tapdance connect` and from leases that go to a [connect target](glossary.md). The
routing rule: a lease goes to the first connect target, in the order they were added, that serves the
platform and answers; a host that is down is skipped fast; `--target` picks one.

| Error | Cause | Fix |
| --- | --- | --- |
| `PROVIDER_UNREACHABLE` "Cannot lease <platform>: target <name> (<endpoint>) does not answer (…)" | That host did not answer within 5 s, and no other target serves the platform. The hint lists the targets that are up. Retryable. | On that host, `tapdance host status`; here, `tailscale status`. Retry when it is back. `tapdance doctor` shows every target. Proven: a stopped guard on a Mac gave this in under 1 s while Android on another host kept working ([evidence](testing/evidence/2026-11-07-two-hosts-android-ios.md)). |
| `PROVIDER_UNREACHABLE` "No connect target answered: …" (`devices`, `doctor`) | Every target is down, or this machine is off the tailnet. | `tailscale status` here, `tapdance host status` on each host. |
| `PROVIDER_UNREACHABLE` "Cannot reach Simlock at …" | One host (or the local worker) is not answering: daemon stopped, wrong endpoint, or the network path is down. Retryable. | Local mode: `tapdance worker start`. Remote: check the endpoint and the network path; `tapdance doctor` shows which check fails. |
| `USAGE` "No connect targets are configured, so there is no target "<name>"" | `device lease --target` (or MCP `lease_device` `target`) without any connect target. | Add the host: `tapdance connect <endpoint> < pairing-<label>.token`. Or lease without `--target`. |
| `USAGE` "No connect target is called "<name>"" | A typo, or the target was removed. | `tapdance connect --list` shows the names; pass one of them, or the endpoint. |
| `DEVICE_UNAVAILABLE` "No connect target serves <platform>" or "Target <name> is set to serve android only, not ios" | No target runs that platform, or `connect --platform` limited the one you named. | Connect a host for that platform: `tapdance connect <endpoint> --platform ios < pairing-<label>.token`. `--platform any` clears a limit. |
| `connect`: `USAGE` "<endpoint> is already target <a>, and another target is called "<b>"" | `--name` names one target and the endpoint belongs to another. | Pick another `--name`, or remove one first: `tapdance disconnect <name>`. |
| Through the guard: `AUTH_FAILED` "Missing, expired or revoked worker-guard token" | The pairing token expired or the host's owner revoked it. | On the host, issue a new token: `tapdance host up --label <agent's machine> --repair` (plain `host up` does it too when the old one expired). Copy the new `pairing-<label>.token` here, then run `tapdance connect <endpoint> < pairing-<label>.token` again. |
| `doctor`: "… serves HTTPS now" | The guard moved from http to https (HTTPS Certificates turned on, `host up` run again); the saved endpoint is still `http://`. | `tapdance connect https://<host>.ts.net:4720 < pairing-<label>.token` (the token is saved per address). |
| `connect` / `doctor` exit 10 on an iOS-only Mac: "Android emulators available" failed | Older builds counted a host with no Android SDK as broken. | Update Tapdance on the agent's machine: Android is a warning there now. |
| A long build ends with `LEASE_LOST` "Lease is not active", or the agent's commands hang and then fail all at once | The agent's machine slept: the lease was not renewed and its connections stalled (a 20 s `curl` came back after 17 minutes). | Keep the agent's machine awake (a laptop: lid open, or `caffeinate -is` while it works), then lease and build again: a finished build is reused in seconds. |

### Configuration and tokens

| Error | Cause | Fix |
| --- | --- | --- |
| `CONFIG_INVALID` "Invalid …: session.defaultTtlMinutes: …" | A key has a wrong value, or an unknown key (keys are strict). | Fix the file; `tapdance config show` shows the merged result. |
| `CONFIG_INVALID` "… is not a JSON object" | Broken JSON. | Fix it, or `tapdance init --force`. |
| `CONFIG_INVALID` "Config file … does not exist" | `--config` or `TAPDANCE_CONFIG` names a missing file. | Correct the path, or create it with `tapdance init`. |
| `CONFIG_INVALID` "Tokens must not be stored in config files" | A `token` or `operatorToken` key in a config file. | Remove it. For a host, use `tapdance connect`; for a gateway, `tapdance config set-token` or `TAPDANCE_TOKEN`. |
| `CONFIG_INVALID` "provider is self-hosted but no endpoint is set" | Self-hosted mode with no connect target and no endpoint. | Add a host with `tapdance connect <endpoint> < pairing-<label>.token`. For a gateway: `tapdance init --mode self-hosted --endpoint https://gateway.example.com`, or `TAPDANCE_ENDPOINT`. |
| `CONFIG_INVALID` "Refusing to send a token over plain HTTP to …" | `http://` to a public host. | Use `https://` behind TLS, or a private network (Tailscale, WireGuard, SSH tunnel). |
| `AUTH_FAILED` "No agent token for …" | Self-hosted mode without a token. | For a host, run `tapdance connect` again with its pairing token. For a gateway, mint one there (`tapdance gateway token --role agent --label <agent>`), then `tapdance config set-token` or `TAPDANCE_TOKEN`. |
| `AUTH_FAILED` (from a gateway) | Token missing, revoked, or minted by another daemon (Simlock tokens work only on the daemon that created them). Reported as `AUTH_FAILED`, not `LEASE_LOST`. | Store a valid agent token for this endpoint. |
| `AUTH_FAILED` "Your saved token belongs to <origin>, but the configuration points at <other> (from tapdance.config.json)" | The token is bound to the endpoint it was saved for, and a config (often a project `tapdance.config.json`) points somewhere else. No token was sent. | Run `tapdance config set-token --endpoint <other>` only if you trust that endpoint; otherwise remove `endpoint` from the project file. See [token binding](configuration.md#token-binding). |
| `CONFIG_INVALID` "This project's tapdance.config.json points at <origin>, and your token is not bound to any endpoint" | An older credentials file (no bound endpoint), or `TAPDANCE_TOKEN`, with an endpoint from a project file. | Re-run `tapdance config set-token` in the project to bind the token to that endpoint, or set `TAPDANCE_ENDPOINT`. |
| `FORBIDDEN` (lease outside this tenant) | The token is scoped to another tenant or lease (Simlock `LEASE_SCOPE_MISMATCH`). | Use a token for this gateway's tenant. |
| A `tools.*`, `ios.axePath` or `simlock.profilePath` value in `tapdance.config.json` has no effect ("Ignored … security settings are read only from ~/.tapdance/config.json") | These keys are user-only. | Set it with `tapdance config set --global <key> <value>`. See [configuration.md](configuration.md#security-settings-are-user-only). |
| `doctor`: "Token accepted … role operator" (warning) | An operator token is stored as the agent token. | Agents should use an agent token. |
| `NOT_SUPPORTED` "Tapdance Cloud is not available yet" | `provider: "cloud"` is reserved. | Use `local` or `self-hosted`. |

### Sessions and leases

| Error | Cause | Fix |
| --- | --- | --- |
| `NO_ACTIVE_LEASE` "This session holds no device" | Nothing leased, or another session leased it. | `tapdance device lease --platform …` (MCP: `lease_device`). Check which session you are in with `tapdance doctor`. |
| `LEASE_ALREADY_HELD` "This session already holds …" | One lease per session. | Use it, or `tapdance device release` first. In MCP, `lease_device` for the same platform returns the held device instead. |
| `LEASE_LOST` "The lease on … has ended" or "… ended at …: …" | The lease ended under the session: it expired, was released or idle-released, the worker restarted or was paused, or an operator ended it. The message gives the reason Tapdance saw. Anything installed was wiped. | Lease again and reinstall the app. Raise `session.defaultTtlMinutes` or keep the keepalive on. |
| The agent's CLI and MCP tools hold two different devices | Codex, pi and Cursor do not pass their session id to MCP servers. | Use one interface per session, or set the same `TAPDANCE_SESSION_ID` in the shell and the MCP config. See [session identity](cli-reference.md#session-identity). |
| Two terminals fight over one device | Without an agent session, all your terminals are one per-user session. | `export TAPDANCE_SESSION_ID=<name>` per terminal, or `--session <name>`. |
| `TIMEOUT` "Another Tapdance process is busy with this session" | Another process holds the session lock (often a lease that is still booting). | Retry in a moment. A lock left by a process that died is taken over automatically. |
| `TIMEOUT` "An earlier call in this process is still working on this session" | The same MCP server is still running an earlier call, usually a lease being granted after the client timed out. | Call again in about 30 s; the lease request keeps running and returns the device once granted. |
| `TIMEOUT` "No device was granted within N s; the request was withdrawn" | The queue did not hand out a device in time, or the link to the host dropped. Tapdance asks the host to drop the request; a host that granted it anyway keeps the device until the lease's TTL. | Retry, raise `--wait` (the Simlock provider caps it at 330 s), or free capacity. `tapdance devices` shows what runs. |
| `NO_CAPACITY` | No free device, or Simlock refused the request because no worker can run that platform right now. Retryable. | Release unused leases, wait, check `tapdance devices`, or start a worker. |
| `DEVICE_UNAVAILABLE` (Simlock `UNKNOWN_MODEL`, `RUNTIME_MISSING`, `NO_DRIVER`) | The model is unknown, its runtime or image is not installed, or the platform's tools are missing on every worker. When the backend says the device is in use (`DEVICE_IN_USE`), it is retryable. | `tapdance devices` for valid models; `tapdance devices install <ios\|android> <version>` on the host; `tapdance doctor`. |
| `DEVICE_UNAVAILABLE` "open device session failed: android device emulator-55xx is owned by session …" | An earlier session's claim on that emulator outlived its agent-device process (the worker restarted, or the host went offline mid-lease). Simlock then keeps handing out and recycling the same emulator, which looks like an emulator restarting in a loop. | Lease again: Tapdance clears such claims before each lease through a guard and on `worker start`, and retries a lease once when it meets one. By hand, on the host: `tapdance worker cleanup`. |
| `WORKER_OFFLINE` (hint: "The machine holding your device is offline; the lease stays yours …") | The worker holding the device dropped off the gateway: asleep, offline or restarting (Simlock `WORKER_UNREACHABLE`, including agent-device's "not connected to the gateway" reply). Retryable; the lease is kept. | Retry the same call in 30–60 s; do not release the device. On a Mac laptop worker, `caffeinate -is` keeps it awake. |
| `HUMAN_HELD` "A person is controlling the device in the viewer" | Someone touched the screen in `tapdance view`. Retryable. | Wait `retryAfterMs` and retry, or press **Hand back** in the viewer. A touch holds the device 15 s after the last touch (`viewer.humanHoldMs`); **Take over** holds it 10 minutes and does not lapse when the person stops touching: the message then says "took over", and only **Hand back** (or the 10 minutes) ends it. |
| The lease request line says "a first boot can take a few minutes" | The host has no device of the requested kind (model, OS version, image tag) yet, so Simlock creates one and boots it from disk; an Android device's first boot also saves its clean snapshot. Later leases of that kind restore from the snapshot ("being restored from its snapshot: usually ready in seconds") or reuse a ready spare. | Nothing; ask for a kind the host already has (`tapdance devices`) for a faster lease. |
| A lease prints "Waiting for the device to settle" or warns "The device is still busy" (or "still finishing its start-up work") | The emulator was handed out while still starting (a spare restored from Simlock's snapshot, or a guest rebooted by the previous release). On nested virtualization this takes minutes (on a Google Cloud N2 VM: 1-2.5 min after a release, about 5 min after a fresh boot). | Nothing to fix. The lease waits for boot and for no "isn't responding" dialog (up to 90 s), then checks the CPU for `session.settleSeconds` (15 s by default), ending early on 3 calm readings in a row or a clearly falling load; with the default, a guest busy from the start (first 3 readings at 80 % or more, not falling) goes out after about 5 s with the notice. Past that, commands work but can take 2-10 s each for a few more minutes. When that matters (timing-sensitive tests, a flaky first step), raise `session.settleSeconds` (up to 300; per lease `device lease --settle <s>` or MCP `settle_seconds`); `0` hands the device out as soon as it has booted. A host that does not need the Play Store should use the `google_apis` image (`scripts/host-setup.sh` installs it by default): Play images update Play services in the background after a boot, likely the main extra load. |
| `device lease` warns "The worker granted N min, less than … asked" | A guard caps leases at its `limits.maxLeaseMinutes` (60 by default). | Nothing: the keepalive (or the MCP server) renews it. The host's owner can raise the cap in `~/.tapdance/worker/policy.json`. |
| `device release` says it could not reach the worker (exit 4) | The worker or guard did not answer; the lease still stands there. | Run `tapdance device release` again once `tapdance doctor` passes; otherwise the device is freed when the lease expires. |
| The first command after a cold iOS lease: "Daemon request timed out" or "Runner command deadline exceeded" (`PROVIDER_UNREACHABLE`, retryable) | agent-device starts its test runner on the first command; on a busy 8 GB Mac that took over 90 s once. A read that meets "Runner command deadline exceeded" is retried once by itself. | Run it again. After an action (a tap, typing, an install), read the screen first (`tapdance ui inspect`): it may have acted. |
| `record stop` fails with `TIMEOUT` (after 32 min) or "Remote artifact download timed out" | The recording could not be fetched: a lost lease, a worker restarting, or a very slow link (Tapdance retries agent-device's 90 s download for up to 30 minutes). | Check `tapdance device status`. On a slow link prefer several shorter recordings over one long one. |
| A tap from a second shell waits until `ui wait` ends | A session's device calls run one at a time. | Run the tap first, or put timed taps in one `ui sequence`. |

### Apps and UI

| Error | Cause | Fix |
| --- | --- | --- |
| `APP_PATH_INVALID` "No file or bundle at …" | Wrong path, or the app is not built. | Build first; pass the build output path. |
| `APP_PATH_INVALID` "App bundles (.aab) need bundletool to become an installable APK" | An `.aab` is turned into a universal APK on this machine first, and bundletool was not found. | Install bundletool (`brew install bundletool`, or the jar from its releases with `tools.paths.bundletool` or `TAPDANCE_BUNDLETOOL`), or build an APK (`./gradlew assembleDebug`). |
| `APP_PATH_INVALID` "… is not an .apk" | Android installs `.apk` files (and `.aab`, converted with bundletool). | Use e.g. `app/build/outputs/apk/debug/app-debug.apk`. |
| `APP_PATH_INVALID` "… is a signed device build (.ipa); simulators need a simulator .app" | Device builds do not run on simulators. | Build with `-sdk iphonesimulator` and install the `.app`. |
| `APP_PATH_INVALID` "… should be an .app bundle directory" / "is not an iOS .app bundle" | Not a valid simulator app bundle. | Point at the `.app` directory from `Debug-iphonesimulator`. |
| `FORBIDDEN` "… is outside the project directory" (MCP) | `install_app` and `execute_tool` `cwd` are confined to the server's working directory. | Build inside the project, or add the folder to `TAPDANCE_ALLOWED_ROOTS` in the MCP server's environment. |
| `USAGE` "… is not a valid app id" | Package or bundle id has invalid characters. | Use e.g. `com.example.app`. |
| `ELEMENT_NOT_FOUND` | No element matches the target, or the ref is stale. | `tapdance ui inspect` (MCP: `inspect_screen`) and target by ref or exact label. |
| `ELEMENT_NOT_FOUND` "The screen changed since that inspect_screen" | The ref (`@e7~s3`) came from an older snapshot. | Inspect again and use the new ref. |
| `APP_NOT_INSTALLED` | The app is not installed on this device, or (iOS) it has no data container on the simulator. | Install it first (`tapdance app install`, MCP `install_app`); `tapdance app list` (MCP `list_apps`) shows what is installed. |
| `ELEMENT_NOT_FOUND` "No text field has focus" | `type` without a target and nothing focused. | Pass a field (`--ref`, `--text`, `--id`; MCP `into_ref` …). |
| `USAGE` "Name one target, not 2 …" / "Name a target: …" | `tap`/`type` need exactly one of text, id, ref, selector, or x and y. | Give exactly one. |
| `ui wait` exits 1 / `wait_for` returns `found: false` | The condition did not happen within the timeout (default 10 s, at most 10 minutes). | Not an error by itself: inspect the screen, take a screenshot, check logs. |
| `ui inspect` names app `android` and says a system dialog "… isn't responding" covers the screen; taps fail with "a system dialog … is in front" | System UI or Play services did not answer while the device was busy. | Tap Wait (`tapdance ui tap --id android:id/aerr_wait`, MCP `tap` with `id`), or Close app (`android:id/aerr_close`), then carry on. |
| `USAGE` "A recording is already running" / "No recording is running" | | `tapdance record stop` / `record start`. |
| `DEVICE_ERROR` "… failed: …" | The device command failed in agent-device or on the device. | Read the quoted message; check `tapdance logs` and `tapdance logs --crash`. |

### AXe iOS backend

| Error | Cause | Fix |
| --- | --- | --- |
| `NOT_SUPPORTED` "The AXe iOS backend only works when Tapdance runs on the Mac that hosts the simulator" | `ios.uiBackend: "axe"` with a remote host. | Set `ios.uiBackend` to `agent-device` for remote Macs. |
| `PROVIDER_UNAVAILABLE` "AXe is not installed on this Mac" | | `brew install cameroncooke/axe/axe`, or set `ios.axePath`. |
| `PROVIDER_UNAVAILABLE` "AXe cannot see the leased simulator" | AXe reads only Xcode's default device set. | `tapdance worker install --ios-backend axe` (sets Simlock's `drivers.ios.deviceSet` to `default`). |
| `NOT_SUPPORTED` "The AXe backend has no alert handling" / "… not agent-device selectors" | Limits of the AXe backend. | Tap the alert's button by label; target by text, id, ref or coordinates. |

### External tools

| Error | Cause | Fix |
| --- | --- | --- |
| `PROVIDER_UNAVAILABLE` "<tool> is not installed on this machine" | Not on `PATH`. | Install it (`tapdance tools doctor` prints how) or set `tools.paths.<tool>`. |
| `NOT_SUPPORTED` "<tool> does not run on <os>" | e.g. `axe` or `xcodebuild` off macOS. | Run it on a Mac. |
| `FORBIDDEN` "Agents may not run <tool> here" | Not in `tools.mcpEnabled`. | Add it to `tools.mcpEnabled` in `~/.tapdance/config.json` if you want agents to run it (a project file cannot). |
| `FORBIDDEN` "<tool> has no read-only mode, so agents need your authorization to run it" | `fastlane` or `xcodebuild` from an agent. | Add it to `tools.allowMutation` in `~/.tapdance/config.json`; the agent then passes `allow_mutation: true`. |
| asc refuses a write from an agent | Agents run asc with `ASC_READ_ONLY=1`. | Intended. To allow it, add `asc` to `tools.allowMutation` in `~/.tapdance/config.json`. |
| `FORBIDDEN` "<tool> acts on the leased device; do not pass --udid" | Tapdance adds the device itself. | Remove `--udid` / `--device`. |
| `FORBIDDEN` "This asc command emits credentials or runs shell steps; run it yourself in a terminal" | An agent called `asc auth …` (other than `auth status`), `asc workflow …` or `asc install-skills` without mutation authorized. | Run it yourself with `tapdance asc -- …` in a terminal, or authorize mutation (`tools.allowMutation` in `~/.tapdance/config.json` plus `allow_mutation: true`). |
| `FORBIDDEN` "tools.paths.<name> must point to the <name> program" | `tools.paths` names a program with another file name. | Point it at the real tool, in `~/.tapdance/config.json`. |
| `NO_ACTIVE_LEASE` "<tool> acts on the session's device; lease one first" | `axe`/`maestro` without a lease. | Lease a device first. |
| `NOT_SUPPORTED` "<tool> must run where the device is; this session's device is on a remote worker" | Lease-scoped tools need the device on this machine. | Use Tapdance's own device tools, which work with a remote host. |
| `NOT_SUPPORTED` "Execution target "…" is not available yet" | Only `control` (this machine) exists today. | Run Tapdance on the machine that has the toolchain. |
| `USAGE` "<tool> works on android devices; this session holds ios" | Platform mismatch. | Lease the right platform. |

### Viewer

| Error | Cause | Fix |
| --- | --- | --- |
| `tapdance view` says no device is leased while the agent has one | The viewer runs in a different session. | `tapdance --session <sessionId> view`, with the `sessionId` from `get_device_status`. |
| `USAGE` "Refusing to serve the viewer on public address …" | `tapdance view --host` with a public IP. | Keep `127.0.0.1` and use `ssh -L 4710:127.0.0.1:4710 <machine>`, `tapdance view --tailscale`, or a private network. |
| Viewer: `NOT_SUPPORTED` (Simlock `STREAM_UNAVAILABLE` / `INPUT_UNAVAILABLE`) | The streaming or input capability is off on the worker. | On the host, `tapdance worker install` (and `gateway setup` on a gateway). |

## On the host

### Worker

| Error | Cause | Fix |
| --- | --- | --- |
| `PROVIDER_UNAVAILABLE` "No local Simlock worker profile at ~/.simlock/agent-device-profile.json" | The local worker is not running, or was never set up with agent-device. | `tapdance worker install` (first time), or `tapdance worker start`. |
| `PROVIDER_UNAVAILABLE` "… names no agent-device URL or token" | Simlock's profile is incomplete. | `tapdance worker restart`. |
| `PROVIDER_UNAVAILABLE` "This machine's worker has joined the gateway …, so it serves agents only through the gateway" | After `worker login`, the worker's own HTTP API is off. | Use the gateway from this machine too (`tapdance init --mode self-hosted --endpoint <gateway URL>`), or `tapdance worker logout` to serve local agents again. |
| `doctor`: "agent-device served by Simlock" fails | Simlock's agent-device capability is off or cannot find agent-device. | `tapdance worker install` (points Simlock at the bundled agent-device 0.21.35 and restarts). On a gateway, enable the capability there too. |
| `doctor`: streaming / remote input warns | `capabilities.stream` / `capabilities.input` off. | `tapdance worker install` (without `--no-stream`). On a gateway, `tapdance gateway setup` enables them. |
| `doctor`: "Simlock version" warns | The endpoint runs a Simlock other than 0.5.0. | Run Simlock 0.5.0 on the gateway and every worker. See [compatibility.md](compatibility.md). |
| `PROVIDER_UNAVAILABLE` "simlock … failed: …" | A bundled Simlock command failed during `worker`/`gateway` setup. | Read the quoted Simlock message; `tapdance worker logs` shows the daemon log. |
| `DEVICE_UNAVAILABLE` "No Android device with serial emulator-…" on lease | Emulators or simulators were stopped outside Simlock (killed, `adb emu kill`, `simctl shutdown`, or the host restarted), and Simlock still believes they run. After a host start Simlock notices within about a minute and boots a new one; the lease asks again for up to 2 minutes before it fails with this. | Lease again in a minute. If it keeps failing, `tapdance worker restart` on the host (it checks Simlock's records with `doctor --fix` and keeps the learned warm spare). Last resort: `tapdance simlock -- --local nuke --yes` (ends Simlock's leases and resets its device state; without `--delete-devices` it deletes nothing; the next lease teaches the warm pool again). Stop devices with `tapdance worker stop` rather than by hand. |
| `PROVIDER_UNAVAILABLE` "refused: android is not available on this simlock"; `doctor` fails "Android emulators available … offers no android device" | The worker skipped its Android driver at start. Most often an adb server Simlock did not start was listening on Simlock's port 5038 (one left behind, or `adb -P 5038 …` run by hand), and Simlock refuses to attach to it. Its log says "Skipped Android driver: adb server unavailable … occupied". | On the host: `tapdance worker restart` (it stops that adb server first). Never run `adb -P 5038` by hand while the worker is stopped. |
| `worker start` / `restart` fails with `DAEMON_CONNECTION_LOST` | An earlier Tapdance started Simlock before the old daemon had released its socket (it can take a minute while emulators shut down). | Fixed: Tapdance now waits for the socket. With an older build, wait a minute and run `tapdance worker start` again. |
| `NOT_SUPPORTED` "Windows cannot run a Tapdance worker yet" | Simlock supports macOS and Linux only. | Use Windows as the agent's machine only (expected to work, not tested); run the worker on a Mac or a Linux machine. |

### Platform tools

| Symptom | Cause | Fix |
| --- | --- | --- |
| `doctor`: "Android SDK … not found in ANDROID_HOME, ANDROID_SDK_ROOT or ~/Library/Android/sdk" | No SDK where Tapdance and Simlock look. | Install the SDK and set `ANDROID_HOME` (required on Linux). |
| `doctor`: "command-line tools (sdkmanager, avdmanager)" missing | Simlock needs them to create emulators; the test Mac needed them installed before Android ran ([evidence](testing/evidence/2026-11-01-android.md)). | Install "Android SDK Command-line Tools (latest)" from Android Studio's SDK Manager, or unpack the download to `$ANDROID_HOME/cmdline-tools/latest`. Then `tapdance worker restart`. |
| `doctor`: platform-tools or emulator missing | SDK packages not installed. | `sdkmanager --install platform-tools` / `sdkmanager --install emulator`. |
| `doctor`: "System images … none installed" (warning) | Nothing to create an emulator from. | `tapdance devices install android 35`, or `sdkmanager "system-images;android-35;google_apis;<arm64-v8a or x86_64>"`. Accept licences first (`sdkmanager --licenses`). |
| `doctor`: "CPU virtualization flags … neither vmx nor svm" | The Linux machine exposes no hardware virtualization. | On Google Cloud use an N2 VM with nested virtualization enabled; elsewhere enable VT-x/AMD-V or choose a KVM-capable plan; or run emulators on another machine. Tapdance never falls back to software emulation. |
| `doctor`: "/dev/kvm present but not writable by this user" | Your user is not in the `kvm` group. | `sudo usermod -aG kvm $USER`, then log out and in (or `newgrp kvm`). |
| `doctor`: "/dev/kvm missing" | KVM module not loaded. | `sudo apt-get install -y qemu-kvm && sudo modprobe kvm_intel` (or `kvm_amd`). |
| `doctor`: Xcode fails | Xcode missing, not selected or not set up. | `sudo xcode-select -s /Applications/Xcode.app`, `sudo xcodebuild -license accept`, `sudo xcodebuild -runFirstLaunch`. |
| `doctor`: "Simulator runtimes … none" | No iOS runtime installed. | `xcodebuild -downloadPlatform iOS`, or `tapdance devices install ios <version>`. |
| `doctor` fails only because of Android on an iOS-only Mac | Android is enabled by default. | `tapdance config set platforms.android.enabled false`. |
| A tool you just installed is still reported missing by Simlock | Simlock detects platform tools only when its daemon starts. | `tapdance worker restart`. |

### Linux and cloud hosts (`host up`)

`host-setup.sh` and `host up` ran end to end on a Google Cloud N2 VM; the rows marked "seen on N2" are
failures met in that run ([evidence](testing/evidence/2026-11-03-gcp-n2-android.md)). The others are
unit-tested only. For a Google Cloud VM see also [the N2 guide's table](deployment/google-cloud-n2.md#troubleshooting).

| Symptom | Cause | Fix |
| --- | --- | --- |
| `host-setup.sh` lists "add <user> to the kvm group", or `doctor`: "/dev/kvm present but not writable by this user" | Your user cannot open `/dev/kvm`. | Let `host-setup.sh` fix it: it adds you to the `kvm` group and sets an ACL on `/dev/kvm` (`setfacl`), which works at once. If `setfacl` is missing (`sudo apt-get install -y acl`), or after a reboot (the ACL is gone, the group applies from your next login), log out and back in; `id -nG` should list `kvm`. |
| `host-setup.sh` notes "/dev/kvm is missing" and skips the emulator | No hardware virtualization (a cloud VM without nested virtualization, or VT-x/AMD-V off). | Use a VM type with nested virtualization (Google Cloud N2 with `--enable-nested-virtualization`) or bare metal; or use this machine as the agent's machine (`tapdance connect`). If the CPU flag is there, `sudo modprobe kvm_intel` (or `kvm_amd`). |
| Leases never finish booting on a server reached over SSH | The emulator tried to open a window on a machine with no display. `worker install` turns headless on only when `DISPLAY` and `WAYLAND_DISPLAY` are unset (it was run with X11 forwarding, for example). | `tapdance simlock -- --local config set android.emulator.headless true`, then `tapdance worker restart`. |
| The emulator starts but fails in its graphics setup (see `tapdance worker logs`) | No GPU on the machine. | `tapdance simlock -- --local config set android.emulator.gpu swiftshader_indirect`, then `tapdance worker restart`. |
| Slow taps (several seconds for a tap that changes the screen) and an idle emulator at 130 % CPU or more (seen on N2) | The emulator's `-gpu auto` on a machine without a GPU. On the N2 VM: taps 3.4–7.9 s and 136–165 % idle CPU, against 2.2–2.6 s and about 0 % with `swiftshader_indirect`. `worker install` and `host up` set it on headless Linux hosts now; hosts set up earlier keep `auto`. | With no lease running: `tapdance simlock -- --local config set android.emulator.gpu swiftshader_indirect`, then `tapdance worker restart`. The next lease cold-boots. |
| `doctor` / `host up`: "Android Emulator runs" fails with "system library libpulse.so.0 is missing" (or another library) (seen on N2) | Minimal cloud images (Ubuntu's included) lack the emulator's audio and X libraries. | `sudo apt-get install -y libpulse0 libxkbfile1 libxi6 libsm6 libice6` (Fedora: `sudo dnf install -y pulseaudio-libs libxkbfile libXi libSM libICE`). `host-setup.sh` installs them. |
| `host up` fails at the worker step: "Failed to connect to bus: No medium found" (seen on N2) | Over a non-interactive SSH session no systemd user manager runs for your account, so `systemctl --user` has no bus. | Update Tapdance: `host up` now turns on linger and waits for the user manager's bus. If linger cannot be turned on, see the next row. |
| `worker restart` over `ssh … --command` failed with "systemctl --user daemon-reload failed: Failed to connect to bus: No medium found" after "The worker's login service … is out of date", and a second `worker restart` said "Restarted" (seen on N2) | Older builds did not point `worker restart` at the user manager's bus, and Simlock's `daemon install` had already removed the old unit (`~/.config/systemd/user/com.callstack.simlock.worker.service`) when `systemctl --user` failed, so the worker ran with no login service. | `tapdance worker install --service`. Updated builds point every Simlock and `systemctl --user` call at the bus, check that `systemctl --user` answers before they install a stale service again (and change nothing when it does not), and when the install still fails say "The login service is now missing", start the worker without it, exit 10 and keep warning on `worker start`/`restart` and in `host status` until the service is back. |
| "Could not enable linger: No such file or directory", also with `sudo` (seen on N2) | A Google Cloud OS Login account: logind cannot look it up. | Run `host-setup.sh` again and answer yes when it offers `tapdance-user-manager.service` (or pass `--yes`): a system unit that starts your user manager at boot (`systemctl status tapdance-user-manager.service`). |
| `host up` warns "Could not turn on linger"; the worker and guard stop when you log out, or do not start after a reboot | systemd user services stop with your last session unless the account lingers. | `sudo loginctl enable-linger $USER`, then `tapdance host up` again. `loginctl show-user $USER --property=Linger` prints `Linger=yes` when it is on. |
| `host up` fails at the tailscale step: "tailscale serve refused this user" ("Access denied") | On Linux only root and the tailnet's operator may change `tailscale serve`. | `sudo tailscale set --operator=$USER` once, then `tapdance host up` again. |
| `host up` stops at pairing: "Pairing must be approved at this machine's terminal", right after `curl … host-setup.sh \| bash` | The script's input is the `curl` pipe, so the question cannot be answered. | Run `~/.local/bin/tapdance host up` with the same options in the same terminal. |
| `host status` says "android not available" while an emulator runs, over `ssh … --command` | The SDK was not found from a non-interactive shell (no `ANDROID_HOME`). `host status` now also looks in `~/Android/Sdk` and says when it cannot find the SDK. | Set `ANDROID_HOME`, or run `host-setup.sh` again: it sources its environment at the top of `~/.bashrc`, which ssh commands read. |
| `No space left on device` during an install, or `INSUFFICIENT_DISK_SPACE` | The disk is full: the SDK, system images and Simlock's emulators (`~/.simlock/devices`) need tens of GB. | `df -h ~` to check. Grow the disk (Google Cloud: `gcloud compute disks resize`, then restart the VM), or remove system images you do not use with `sdkmanager --uninstall`. |

### Rented Macs (macOS hosts reached over ssh)

Seen on a Scaleway Mac mini M1-M (8 GB, macOS 27.2) set up over ssh with nobody at its screen
([evidence](testing/evidence/2026-11-06-rented-mac-ios.md), [guide](ios/scaleway-mac.md)).

| Symptom | Cause | Fix |
| --- | --- | --- |
| `ssh mac 'tapdance host status'`: "command not found" (also `node`, `gh`) | zsh reads `~/.zshrc` only in interactive shells; older `host-setup.sh` runs sourced their environment there only. | Run `host-setup.sh` again (it writes `~/.tapdance/env.sh` on every run and sources it from `~/.zshenv`, with MacPorts and Homebrew on `PATH`). |
| After a reboot the agent gets no answer; on the Mac `launchctl print gui/$(id -u)` fails | The worker and guard are LaunchAgents: they start only in a logged-in session, and the Mac waits at the login window. Simulators themselves do not need one. | Automatic login for the hosting account: `infrastructure/scripts/macos-auto-login.sh <account>` (asks for the passwords), then reboot. `who` should list the account on `console`. |
| `sudo sysadminctl -autologin set …`: `SACSetAutoLoginPassword error:22`, "Automatic login is OFF" | Seen on macOS 27.2 over ssh with the right password. | `infrastructure/scripts/macos-auto-login.sh`, which writes `/etc/kcpassword` and `autoLoginUser` itself. |
| Leases fail with "Internal error" (the host log: "simctl list … timed out after 30000ms" or "Timed out waiting for device to boot"), commands time out, the Mac swaps gigabytes | 8 GB holds one iOS simulator; a leased one plus Simlock's warm spare does not fit (Simlock budgets 1.5 GB per simulator). Slim simulators did not help. | On the host: `tapdance host warm android=0,ios=0`. Leases then cold-boot (about 80-140 s on an M1). A 16 GB Mac keeps the spare. |
| `app build` of a Kotlin Multiplatform app on an iOS-only host: "SDK location not found … ANDROID_HOME" | The app's Gradle configures its Android modules even for the iOS framework. | On the host: `host-setup.sh --ios-only --android-build-sdk` (command-line tools and platform-tools, no emulator). |
| `host token` over ssh: `USAGE` "Over ssh the clipboard is this machine's, not yours" | The clipboard would be the host's. | `scp <host>:~/.tapdance/worker/pairing-<label>.token .`, or `tapdance host token --show --label <label>` once. |
| `host up --tailscale-ssh` warns that a shell over Tailscale SSH is outside the worker guard | Anyone the tailnet policy's `ssh` rule lets in, the agent's machine too, gets a shell as the hosting account, with no guard in between. | In the tailnet policy, limit the rule's `src` to your own devices (not the agent's machine) and its `users` to the hosting account (no root); or turn it off with `sudo tailscale set --ssh=false`. |
| A GitHub token appears on screen while you paste it over `ssh -t` | `gh auth login --with-token` does not hide its input. | Revoke that token, then log in with `tapdance host gh-login`, which reads it with echo off. |

### Cost guard on a cloud host

The guard's idle stop and uptime cap (`tapdance host up --idle-stop`, `--max-uptime`), and the Terraform
run-time cap and stop schedule. The idle stop powered a real N2 VM off
([evidence](testing/evidence/2026-11-03-gcp-n2-android.md)); the uptime cap is unit-tested only. See
[cost guardrails](deployment/google-cloud-n2.md#cost-guardrails).

| Symptom | Cause | Fix |
| --- | --- | --- |
| The VM stopped by itself; `tapdance doctor` on the agent's machine cannot reach the guard | A cost guard stopped it: the guard's idle stop or uptime cap, the Terraform `max_run_hours` cap (8 h after each start by default) or `stop_schedule`. | Start it again: `gcloud compute instances start tapdance-n2 --zone=us-central1-a`. The endpoint and token stay the same. With the idle stop on, it powers off again after the idle time unless an agent connects: start it when the agent is about to use it. On the VM, `tapdance host status` shows the cost guard setting and when it will power off, `tapdance worker guard audit` lists a guard stop as `TIMER host-stop` with its reason, and `~/.tapdance/worker/guard.log` has the guard's own "cost guard: powering off" line (`journalctl --user` may show nothing for an OS Login account); no `TIMER` entry means the VM-level cap, the schedule or a person stopped it. |
| `host up` warns "The cost guard cannot power this machine off yet: sudo does not let … run `sudo -n /usr/bin/systemctl poweroff` without a password"; `host status` shows the cost guard row failing; the VM never stops when idle | The sudoers rule for the stop command is missing (`host-setup.sh` installs it only on a detected cloud VM, after asking). The guard logs the failed stop once an hour and the VM keeps running. | Install the rule `host up` prints, which allows only that command: `echo '<you> ALL=(root) NOPASSWD: /usr/bin/systemctl poweroff' \| sudo tee /etc/sudoers.d/tapdance-poweroff && sudo chmod 440 /etc/sudoers.d/tapdance-poweroff && sudo visudo -cf /etc/sudoers.d/tapdance-poweroff`. Or run `host-setup.sh` again. |
| `NO_CAPACITY` "This host has run longer than its uptime cap (N h) and takes no new leases; it powers off once the running leases end" | The owner set `--max-uptime` (`hostStop.maxUptimeHours` in `~/.tapdance/worker/policy.json`). Running leases go on. | Wait for the VM to stop and start it again (the count starts again at boot), or on the VM raise or turn off the cap: `tapdance host up --max-uptime off`. |
| `USAGE` "--idle-stop and --max-uptime power the machine off, which Tapdance never does to a Mac" | Both flags are for Linux cloud VMs. | On a Mac, stop hosting with `tapdance host pause`. |
| The VM stops while you are still working with it | Nothing counted as use for the idle time: no lease, no open request with a valid token, no build. A warm spare does not count. | Keep a lease while you work, or raise the idle time: `tapdance host up --idle-stop 60` (or `off`). That keeps the host's only pairing; with several, add its `--label`. |
| `host up --idle-stop …` stops at pairing: "… is not paired, and pairing it must be approved at this machine's terminal; this host is paired as …" | `--label` named a pairing that does not exist, over ssh without a terminal. Nothing was changed. | Run the command it prints, with the pairing the host already has: `tapdance host up --label <that label> --idle-stop …`. |

### Builds on the host

See [host builds](guides/host-builds.md) and [private repositories](guides/private-repositories.md).

| Error | Cause | Fix |
| --- | --- | --- |
| `AUTH_FAILED` `git clone failed` or `git fetch failed`, with git's own line such as `Permission denied (publickey)` | The repository is private and the host's git credentials do not reach it: no `gh` login, an expired token, a token without that repository, a deploy key not added (or deploy keys turned off for the organization), or an `https://` URL with a deploy key. The hint says which auth the host used, with the deploy key's fingerprint. | Only the host's owner can fix it, on the host: `tapdance host builds status --check` shows which repositories this machine can read. Use a fine-grained read-only token (`tapdance host gh-login`, then `tapdance host builds enable --repo <https url> --git-auth gh`), a deploy key (`tapdance host builds key --repo <url>` and build with the ssh URL), or build elsewhere and `tapdance app install`. See [private repositories](guides/private-repositories.md). |
| `FORBIDDEN` "… is not on this host's build allow-list" | The repository, or that form of its URL, is not allowed. `https://` and ssh URLs of one repository are separate entries. | The owner runs `tapdance host builds enable --repo <url>` with the exact URL the agent uses. |
| "warning: some submodules could not be fetched …; building without them" | A submodule the host's credentials do not reach (another repository for a deploy key, an ssh URL with `gh`). | Nothing if the app does not need it. Otherwise add that repository to the fine-grained token. |
| `USAGE` "Build file path … is absolute", "… contains ..", "… is one of git's own files (.git, .gitmodules)" or "… has characters that are not allowed" | `host builds files add` takes a path inside the repository: no leading `/` or `~`, no `..`, nothing in `.git`, no `.gitmodules`, letters, digits, space and `_ . + @ , = -` only. | Give the path relative to the repository root, e.g. `androidApp/google-services.json`. |
| `FORBIDDEN` "Host build file … was not copied: …" | At that commit, the repository has a symlink or a folder where the build file goes, or a folder that is a symlink leading outside the checkout. | The owner removes or moves the build file: `tapdance host builds files remove --repo <url> <path>`, then adds it at another path. |
| `CONFIG_INVALID` "Host build file … is missing or changed on disk since it was added" | Its stored copy under `~/.tapdance/worker/builds/files/` was changed or deleted. | Add it again: `tapdance host builds files add --repo <url> <path> --from <file>`. |
| GitHub answers "Deploy keys are disabled for this repository" when you add the key from `host builds key --repo` (seen on N2) | The organization turned deploy keys off. | Use a fine-grained, read-only token with `--git-auth gh` instead; it also covers installs from CI. See [private repositories](guides/private-repositories.md). |
| A build fails with "The host's Android SDK has no CMake …" (or another SDK component) | The app's Gradle build needs an SDK component that Gradle does not download. | The host's owner runs the `sdkmanager` command in the hint (for example `sdkmanager "cmake;3.31.6"`), then the agent builds again. |

### Installs from CI

See [build in CI, test with Tapdance](guides/ci-builds.md).

| Error | Cause | Fix |
| --- | --- | --- |
| iOS: `USAGE` "The artifact holds an .ipa (a device build)" or "holds a iPhoneOS build, not a simulator build" | CI uploaded a device build; simulators run only `iphonesimulator` builds. | Build with `xcodebuild -sdk iphonesimulator` and upload the `.app` (or a `ditto` zip of it). |
| iOS: "The artifact holds no simulator .app" | The artifact has neither `<App>.app/Info.plist`, an `Info.plist` at its root, nor one zipped `.app`. | Upload the `.app` folder or a zip of it. |
| Android: "… holds an Android App Bundle (.aab), not an .apk" | Installs from CI take an APK. | Have the workflow upload an APK (`./gradlew assembleDebug`), or download the `.aab` and install it from the agent's machine with `tapdance app install <file.aab>` (bundletool converts it there). |
| `USAGE` "GitHub answered 404 for …: the run or artifact does not exist, or the host's token cannot read …" (seen on N2) | A wrong run id or artifact name, or the host's fine-grained token does not select that repository (for example a token for another repository of the same app), or the organization has not approved the token yet. | Check the run and the artifact name (`gh run list`, `gh run view <id>`). If they are right, the host's owner gives the token access to the repository whose workflow made the artifact, with *Actions: Read-only* and *Contents: Read-only*. `tapdance host artifacts status` on the host shows whether `gh` works. |
| Install refused with `INSTALL_FAILED_UPDATE_INCOMPATIBLE` (seen on N2, from CI and from a host build) | The app on the device was signed with another key. CI runners often make a new debug key per run, and a build on the host is signed with the host's own debug key. | `tapdance app uninstall <appId>` (MCP `uninstall_app`; the app's data goes), then install again. To avoid it, sign debug builds in CI with one shared debug keystore. |
| Install refused with `INSTALL_FAILED_VERSION_DOWNGRADE` | The installed app has a higher `versionCode`. | Uninstall it first, then install. For a build on the host or an install from CI, the hint names the package. |
| Install refused with `INSTALL_FAILED_INSUFFICIENT_STORAGE` | The emulator is full. | Release the lease for a fresh device, or uninstall apps you no longer need. |

### Guard (device-only mode)

See [device-only mode](security/device-only-mode.md).

| Error | Cause | Fix |
| --- | --- | --- |
| `FORBIDDEN` "Pairing must be approved at this machine's terminal" (`worker guard pair`) | `guard pair` was run without a terminal on stdin (from a script, pipe or service). | Run it in a terminal on the host. For scripted setup by the host's owner only, set `TAPDANCE_GUARD_PAIR_NONINTERACTIVE=1` for that one command. |
| Through the guard: `NO_CAPACITY` "This worker allows N session(s) at a time" | The guard's `limits.maxSessions` is reached (enforced even for concurrent requests). | Release a lease, or raise the limit in `~/.tapdance/worker/policy.json` on the host. |
| Through the guard: a physical iPhone or Android phone cannot be leased ("physical devices are disabled by the local policy") | Physical devices are off by default in device-only mode. | On the host, set `allow.physicalDevices` to `true` in the policy, if you want remote clients to use them. |

An expired or revoked pairing token is fixed on both machines: see
[Connecting to a host](#connecting-to-a-host).

### Gateway mode (advanced, run on one Mac only)

See [gateway mode](deployment/gateway-mode.md).

| Error | Cause | Fix |
| --- | --- | --- |
| `FORBIDDEN` "Joining a gateway gives it, and every agent token it issues, command execution on this machine …" (`worker login`) | `worker login` was run without `--accept-gateway-exec`. | Pass `--accept-gateway-exec` only on a machine dedicated to being a worker; read [gateway mode](deployment/gateway-mode.md) first. |
| `USAGE` "Refusing ws:// to public host …" (`worker login`) | The join token would travel in plain text. | Use `wss://` behind TLS, or a private address (Tailscale). |
| `FORBIDDEN` "Listing workers needs an operator token" | `workers list` (or MCP `list_workers`) through a gateway. | `tapdance config set-token --operator` for the CLI. The MCP server never loads the operator token, so `list_workers` stays unavailable through a gateway. |
| `doctor`: "Workers online" fails | No worker connected to the gateway. | Start a worker and join it: `echo '<join token>' \| tapdance worker login --accept-gateway-exec --gateway wss://… --label …` (or set `TAPDANCE_WORKER_TOKEN`). On a personal Mac use device-only mode instead ([device-only mode](security/device-only-mode.md)). |
| `FORBIDDEN` (Simlock `PASSTHROUGH_REFUSED`) or `NOT_SUPPORTED` (`UNKNOWN_PASSTHROUGH_TOOL`) | The worker does not allow that command. | A gateway worker must be joined with `tapdance worker login --accept-gateway-exec` (dedicated machines only). The guard allows only its device API, by design. |
| A worker shows `incompatible` | Gateway and worker run Simlock versions that cannot talk. | Run Simlock 0.5.0 everywhere ([compatibility.md](compatibility.md)). |

## Older builds

The bugs found by running Tapdance for real, and their fixes, are listed in
[STATUS.md](../STATUS.md#bugs-found-by-running-for-real-fixed). If you see one of them, you are on an
older build: pull and rebuild ([update](installation.md#update)).

## Reporting a problem

```bash
tapdance report --title "lease times out on N2 host" --kind bug \
  --steps "tapdance device lease --platform android" --expected "a Pixel lease" \
  --actual "$(tapdance --json device lease --platform android 2>&1)" -o report.md
```

This writes a Markdown report with versions, OS, provider, session source, the current lease and the
`doctor` results. Tokens are redacted, but read it before posting. Attach screenshots or logs with
`--evidence <comma-separated paths>`.
