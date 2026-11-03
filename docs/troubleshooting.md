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
| `DEVICE_UNAVAILABLE` "No Android device with serial emulator-…" on lease | Emulators or simulators were stopped outside Simlock (killed, `adb emu kill`, `simctl shutdown`), and Simlock still believes they run. | `tapdance simlock -- --local nuke --yes` (ends Simlock's leases and resets its device state; without `--delete-devices` it deletes nothing), then lease again. Stop devices with `tapdance worker stop` rather than by hand. |
| `worker start` / `restart` fails with `DAEMON_CONNECTION_LOST` | An earlier Tapdance started Simlock before the old daemon had released its socket (it can take a minute while emulators shut down). | Fixed: Tapdance now waits for the socket. With an older build, wait a minute and run `tapdance worker start` again. |
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

## Linux and cloud hosts (`host up`, not yet run on Linux)

The fixes below exist in `scripts/host-setup.sh` and `tapdance host up`; they are unit-tested only.
For a Google Cloud VM see also [the N2 guide's table](deployment/google-cloud-n2.md#troubleshooting).

| Symptom | Cause | Fix |
| --- | --- | --- |
| `host-setup.sh` lists "add <user> to the kvm group", or `doctor`: "/dev/kvm present but not writable by this user" | Your user cannot open `/dev/kvm`. | Let `host-setup.sh` fix it: it adds you to the `kvm` group and sets an ACL on `/dev/kvm` (`setfacl`), which works at once. If `setfacl` is missing (`sudo apt-get install -y acl`), or after a reboot (the ACL is gone, the group applies from your next login), log out and back in; `id -nG` should list `kvm`. |
| `host-setup.sh` notes "/dev/kvm is missing" and skips the emulator | No hardware virtualization (a cloud VM without nested virtualization, or VT-x/AMD-V off). | Use a VM type with nested virtualization (Google Cloud N2 with `--enable-nested-virtualization`) or bare metal; or use this machine as the agent's machine (`tapdance connect`). If the CPU flag is there, `sudo modprobe kvm_intel` (or `kvm_amd`). |
| Leases never finish booting on a server reached over SSH | The emulator tried to open a window on a machine with no display. `worker install` turns headless on only when `DISPLAY` and `WAYLAND_DISPLAY` are unset (it was run with X11 forwarding, for example). | `tapdance simlock -- --local config set android.emulator.headless true`, then `tapdance worker restart`. |
| The emulator starts but fails in its graphics setup (see `tapdance worker logs`) | No GPU on the machine. | `tapdance simlock -- --local config set android.emulator.gpu swiftshader_indirect`, then `tapdance worker restart`. |
| `host up` warns "Could not turn on linger"; the worker and guard stop when you log out, or do not start after a reboot | systemd user services stop with your last session unless the account lingers. | `sudo loginctl enable-linger $USER`, then `tapdance host up` again. `loginctl show-user $USER --property=Linger` prints `Linger=yes` when it is on. |
| `host up` fails at the tailscale step: "tailscale serve refused this user" ("Access denied") | On Linux only root and the tailnet's operator may change `tailscale serve`. | `sudo tailscale set --operator=$USER` once, then `tapdance host up` again. |
| `host up` stops at pairing: "Pairing must be approved at this machine's terminal", right after `curl … host-setup.sh \| bash` | The script's input is the `curl` pipe, so the question cannot be answered. | Run `~/.local/bin/tapdance host up` with the same options in the same terminal. |
| `No space left on device` during an install, or `INSUFFICIENT_DISK_SPACE` | The disk is full: the SDK, system images and Simlock's emulators (`~/.simlock/devices`) need tens of GB. | `df -h ~` to check. Grow the disk (Google Cloud: `gcloud compute disks resize`, then restart the VM), or remove system images you do not use with `sdkmanager --uninstall`. |

## Cost guard on a cloud host (unit-tested only)

The guard's idle stop and uptime cap (`tapdance host up --idle-stop`, `--max-uptime`), and the Terraform
run-time cap and stop schedule. See [cost guardrails](deployment/google-cloud-n2.md#cost-guardrails).

| Symptom | Cause | Fix |
| --- | --- | --- |
| The VM stopped by itself; `tapdance doctor` on the agent's machine cannot reach the guard | A cost guard stopped it: the guard's idle stop or uptime cap, the Terraform `max_run_hours` cap (8 h after each start by default) or `stop_schedule`. | Start it again: `gcloud compute instances start tapdance-n2 --zone=us-central1-a`. The endpoint and token stay the same. On the VM, `tapdance host status` shows the cost guard setting and `tapdance worker guard audit` lists a guard stop as `TIMER host-stop` with its reason; no such entry means the VM-level cap, the schedule or a person stopped it. |
| `host up` warns "The cost guard cannot power this machine off yet: sudo does not let … run `sudo -n /usr/bin/systemctl poweroff` without a password"; `host status` shows the cost guard row failing; the VM never stops when idle | The sudoers rule for the stop command is missing (`host-setup.sh` installs it only on a detected cloud VM, after asking). The guard logs the failed stop once an hour and the VM keeps running. | Install the rule `host up` prints, which allows only that command: `echo '<you> ALL=(root) NOPASSWD: /usr/bin/systemctl poweroff' \| sudo tee /etc/sudoers.d/tapdance-poweroff && sudo chmod 440 /etc/sudoers.d/tapdance-poweroff && sudo visudo -cf /etc/sudoers.d/tapdance-poweroff`. Or run `host-setup.sh` again. |
| `NO_CAPACITY` "This host has run longer than its uptime cap (N h) and takes no new leases; it powers off once the running leases end" | The owner set `--max-uptime` (`hostStop.maxUptimeHours` in `~/.tapdance/worker/policy.json`). Running leases go on. | Wait for the VM to stop and start it again (the count starts again at boot), or on the VM raise or turn off the cap: `tapdance host up --max-uptime off`. |
| `USAGE` "--idle-stop and --max-uptime power the machine off, which Tapdance never does to a Mac" | Both flags are for Linux cloud VMs. | On a Mac, stop hosting with `tapdance host pause`. |
| The VM stops while you are still working with it | Nothing counted as use for the idle time: no lease, no open request with a valid token, no build. A warm spare does not count. | Keep a lease while you work, or raise the idle time: `tapdance host up --idle-stop 60` (or `off`). |

## Builds on the host

See [builds on the host](deployment/one-command-host.md#builds-on-the-host) and
[private repositories](guides/private-repositories.md).

| Error | Cause | Fix |
| --- | --- | --- |
| `git clone failed` or `git fetch failed`, with a hint that starts "This host could not sign in to …" | The repository is private and the host's git credentials do not reach it: no `gh` login, an expired token, a token without that repository, a deploy key not added, or an `https://` URL with a deploy key. | Only the host's owner can fix it. Use a fine-grained read-only token (`gh auth login --with-token`, then `tapdance host builds enable --repo <https url> --git-auth gh`), a deploy key (`tapdance host builds key --repo <url>` and build with the ssh URL), or build elsewhere and `tapdance app install`. See [private repositories](guides/private-repositories.md). |
| `FORBIDDEN` "… is not on this host's build allow-list" | The repository, or that form of its URL, is not allowed. `https://` and ssh URLs of one repository are separate entries. | The owner runs `tapdance host builds enable --repo <url>` with the exact URL the agent uses. |
| "warning: some submodules could not be fetched …; building without them" | A submodule the host's credentials do not reach (another repository for a deploy key, an ssh URL with `gh`). | Nothing if the app does not need it. Otherwise add that repository to the fine-grained token. |
| `USAGE` "Build file path … is absolute", "… contains ..", "… is one of git's own files (.git, .gitmodules)" or "… has characters that are not allowed" | `host builds files add` takes a path inside the repository: no leading `/` or `~`, no `..`, nothing in `.git`, no `.gitmodules`, letters, digits, space and `_ . + @ , = -` only. | Give the path relative to the repository root, e.g. `androidApp/google-services.json`. |
| `FORBIDDEN` "Host build file … was not copied: …" | At that commit, the repository has a symlink or a folder where the build file goes, or a folder that is a symlink leading outside the checkout. | The owner removes or moves the build file: `tapdance host builds files remove --repo <url> <path>`, then adds it at another path. |
| `CONFIG_INVALID` "Host build file … is missing or changed on disk since it was added" | Its stored copy under `~/.tapdance/worker/builds/files/` was changed or deleted. | Add it again: `tapdance host builds files add --repo <url> <path> --from <file>`. |

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
| `AUTH_FAILED` (from the gateway) | Token missing, revoked, or minted by another daemon (Simlock tokens work only on the daemon that created them). Reported as `AUTH_FAILED`, not `LEASE_LOST`. | Store a valid agent token for this endpoint. |
| `AUTH_FAILED` "Your saved token belongs to <origin>, but the configuration points at <other> (from tapdance.config.json)" | The token is bound to the endpoint it was saved for, and a config (often a project `tapdance.config.json`) points somewhere else. No token was sent. | Run `tapdance config set-token --endpoint <other>` only if you trust that endpoint; otherwise remove `endpoint` from the project file. See [token binding](configuration.md#token-binding). |
| `CONFIG_INVALID` "This project's tapdance.config.json points at <origin>, and your token is not bound to any endpoint" | An older credentials file (no bound endpoint), or `TAPDANCE_TOKEN`, with an endpoint from a project file. | Re-run `tapdance config set-token` in the project to bind the token to that endpoint, or set `TAPDANCE_ENDPOINT`. |
| `FORBIDDEN` (lease outside this tenant) | The token is scoped to another tenant or lease (Simlock `LEASE_SCOPE_MISMATCH`). | Use a token for this gateway's tenant. |
| A `tools.*`, `ios.axePath` or `simlock.profilePath` value in `tapdance.config.json` has no effect ("Ignored … security settings are read only from ~/.tapdance/config.json") | These keys are user-only. | Set it with `tapdance config set --global <key> <value>`. See [configuration.md](configuration.md#security-settings-are-user-only). |
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
| `TIMEOUT` "Another Tapdance process is busy with this session" | Another process holds the session lock (often a lease that is still booting). | Retry in a moment. A lock left by a process that died is taken over automatically. |
| `TIMEOUT` "An earlier call in this process is still working on this session" | The same MCP server is still running an earlier call, usually a lease being granted after the client timed out. | Call again in about 30 s; the lease request keeps running and returns the device once granted. |
| `TIMEOUT` "No device was granted within N s; nothing was leased" | The queue did not hand out a device in time. | Retry, raise `--wait` (the Simlock provider caps it at 330 s), or free capacity. |
| `NO_CAPACITY` | No free device, or Simlock refused the request because no worker can run that platform right now. Retryable. | Release unused leases, wait, check `tapdance devices`, or start a worker. |
| `DEVICE_UNAVAILABLE` (Simlock `UNKNOWN_MODEL`, `RUNTIME_MISSING`, `NO_DRIVER`) | The model is unknown, its runtime/image is not installed, or the platform's tools are missing on every worker. When the backend says the device is in use (`DEVICE_IN_USE`), it is retryable. | `tapdance devices` for valid models; `tapdance devices install <ios\|android> <version>` on the worker; `tapdance doctor`. |
| `WORKER_OFFLINE` (hint: "The machine holding your device is offline; the lease stays yours …") | The worker holding the device dropped off the gateway: asleep, offline or restarting (Simlock `WORKER_UNREACHABLE`, including agent-device's "not connected to the gateway" reply). Retryable; the lease is kept. | Retry the same call in 30–60 s; do not release the device. On a Mac laptop worker, `caffeinate -is` keeps it awake. |
| `HUMAN_HELD` "A person is controlling the device in the viewer" | Someone touched the screen in `tapdance view`. Retryable. | Wait `retryAfterMs` (default hold 15 s after the last touch) and retry, or press "Hand back" in the viewer. |

## Leases

| Error | Cause | Fix |
| --- | --- | --- |
| `LEASE_LOST` "The lease on … ended at …: …" | The device's lease ended under the session: it expired, the worker restarted or was paused, an operator ended it. The message gives the reason Tapdance saw. | Lease a new device; anything installed on the old one was wiped. |
| `device lease` warns "The worker granted N min, less than … asked" | A worker in device-only mode caps leases at its `limits.maxLeaseMinutes` (60 by default). | Nothing: the keepalive (or the MCP server) renews it. The owner can raise the cap in `~/.tapdance/worker/policy.json`. |
| `DEVICE_UNAVAILABLE` "open device session failed: android device emulator-55xx is owned by session …" | An earlier session's claim on that emulator outlived its agent-device process (the worker restarted, or the Mac went offline mid-lease). Simlock then keeps handing out and recycling the same emulator, which looks like an emulator restarting in a loop. | Lease again: Tapdance clears such claims before each lease through a worker guard and on `worker start`, and retries a lease once when it meets one. By hand, on the worker machine: `tapdance worker cleanup`. |
| `PROVIDER_UNAVAILABLE` "refused: android is not available on this simlock"; `doctor` fails "Android emulators available … offers no android device" | The worker skipped its Android driver at start. Most often an adb server Simlock did not start was listening on Simlock's port 5038 (one left behind, or `adb -P 5038 …` run by hand), and Simlock refuses to attach to it. Its log says "Skipped Android driver: adb server unavailable … occupied". | On the worker machine: `tapdance worker restart` (it stops that adb server first). Never run `adb -P 5038` by hand while the worker is stopped. |
| `device release` says it could not reach the worker (exit 4) | The worker or guard did not answer; the lease still stands there. | Run `tapdance device release` again once `tapdance doctor` passes; otherwise the device is freed when the lease expires. |
| `doctor`: "… serves HTTPS now" | The guard moved from http to https (HTTPS Certificates turned on, `host up` run again); the saved endpoint is still `http://`. | `tapdance connect https://<host>.ts.net:4720 < pairing-<label>.token` (the token is saved per address). |
| `record stop` fails with `TIMEOUT` (after 32 min) or "Remote artifact download timed out" | The recording could not be fetched: a lost lease, a worker restarting, or a very slow link (Tapdance retries agent-device's 90 s download with up to 30 minutes). | Check `tapdance device status`. On a slow link prefer several shorter recordings over one long one. |
| A tap from a second shell waits until `ui wait` ends | A session's device calls run one at a time. | Run the tap first, or put timed taps in one `ui sequence`. |

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
| `ELEMENT_NOT_FOUND` "The screen changed since that inspect_screen" | The ref (`@e7~s3`) came from an older snapshot. | Inspect again and use the new ref. |
| `APP_NOT_INSTALLED` | The app id is not installed on this device. | Install it first (`tapdance app install`, MCP `install_app`); `tapdance app list` (MCP `list_apps`) shows what is installed. |
| `ELEMENT_NOT_FOUND` "No text field has focus" | `type` without a target and nothing focused. | Pass a field (`--ref`, `--text`, `--id`; MCP `into_ref` …). |
| `USAGE` "Name one target, not 2 …" / "Name a target: …" | `tap`/`type` need exactly one of text, id, ref, selector, or x and y. | Give exactly one. |
| `ui wait` exits 1 / `wait_for` returns `found: false` | The condition did not happen within the timeout (max 30 s). | Not an error by itself: inspect the screen, take a screenshot, check logs. |
| `USAGE` "A recording is already running" / "No recording is running" | | `tapdance record stop` / `record start`. |
| `DEVICE_ERROR` "… failed: …" | The device command failed in agent-device or on the device. | Read the quoted message; check `tapdance logs` and `tapdance logs --crash`. |

## AXe iOS backend

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
| `FORBIDDEN` "Agents may not run <tool> here" | Not in `tools.mcpEnabled`. | Add it to `tools.mcpEnabled` in `~/.tapdance/config.json` if you want agents to run it (a project file cannot). |
| `FORBIDDEN` "<tool> has no read-only mode, so agents need your authorization to run it" | `fastlane` or `xcodebuild` from an agent. | Add it to `tools.allowMutation` in `~/.tapdance/config.json`; the agent then passes `allow_mutation: true`. |
| asc refuses a write from an agent | Agents run asc with `ASC_READ_ONLY=1`. | Intended. To allow it, add `asc` to `tools.allowMutation` in `~/.tapdance/config.json`. |
| `FORBIDDEN` "<tool> acts on the leased device; do not pass --udid" | Tapdance adds the device itself. | Remove `--udid` / `--device`. |
| `FORBIDDEN` "This asc command emits credentials or runs shell steps; run it yourself in a terminal" | An agent called `asc auth …` (other than `auth status`), `asc workflow …` or `asc install-skills` without mutation authorized. | Run it yourself with `tapdance asc -- …` in a terminal, or authorize mutation (`tools.allowMutation` in `~/.tapdance/config.json` plus `allow_mutation: true`). |
| `FORBIDDEN` "tools.paths.<name> must point to the <name> program" | `tools.paths` names a program with another file name. | Point it at the real tool, in `~/.tapdance/config.json`. |
| `NO_ACTIVE_LEASE` "<tool> acts on the session's device; lease one first" | `axe`/`maestro` without a lease. | Lease a device first. |
| `NOT_SUPPORTED` "<tool> must run where the device is; this session's device is on a remote worker" | Lease-scoped tools need the device locally. | Use Tapdance's own device tools, which work through a gateway. |
| `NOT_SUPPORTED` "Execution target "…" is not available yet" | Only `control` exists today. | Run Tapdance on the machine that has the toolchain. |
| `USAGE` "<tool> works on android devices; this session holds ios" | Platform mismatch. | Lease the right platform. |

## Gateways, workers, the guard and the viewer (untested across machines)

| Error | Cause | Fix |
| --- | --- | --- |
| `FORBIDDEN` "Joining a gateway gives it, and every agent token it issues, command execution on this machine …" (`worker login`) | `worker login` was run without `--accept-gateway-exec`. | Pass `--accept-gateway-exec` only on a machine dedicated to being a worker; read [worker-security.md](deployment/worker-security.md) first. |
| `USAGE` "Refusing ws:// to public host …" (`worker login`) | The join token would travel in plain text. | Use `wss://` behind TLS, or a private address (Tailscale). |
| `FORBIDDEN` "Listing workers needs an operator token" | `workers list` (or MCP `list_workers`) through a gateway. | `tapdance config set-token --operator` for the CLI. The MCP server never loads the operator token, so `list_workers` stays unavailable through a gateway. |
| `doctor`: "Workers online" fails | No worker connected to the gateway. | Start a worker and join it: `echo '<join token>' \| tapdance worker login --accept-gateway-exec --gateway wss://… --label …` (or set `TAPDANCE_WORKER_TOKEN`). On a personal Mac use device-only mode instead ([personal-mac.md](security/personal-mac.md)). |
| `FORBIDDEN` (Simlock `PASSTHROUGH_REFUSED`) or `NOT_SUPPORTED` (`UNKNOWN_PASSTHROUGH_TOOL`) | The worker does not allow that command. | A gateway worker must be joined with `tapdance worker login --accept-gateway-exec` (dedicated machines only). The worker guard allows only its device API, by design. |
| `FORBIDDEN` "Pairing must be approved at this machine's terminal" (`worker guard pair`) | `guard pair` was run without a terminal on stdin (from a script, pipe or service). | Run it in a terminal on the Mac. For scripted setup by the Mac's owner only, set `TAPDANCE_GUARD_PAIR_NONINTERACTIVE=1` for that one command. |
| Through the guard: `NO_CAPACITY` "This worker allows N session(s) at a time" | The guard's `limits.maxSessions` is reached (enforced even for concurrent requests). | Release a lease, or raise the limit in `~/.tapdance/worker/policy.json` on the Mac. |
| Through the guard: a physical iPhone or Android phone cannot be leased ("physical devices are disabled by the local policy") | Physical devices are off by default in device-only mode. | On the Mac, set `allow.physicalDevices` to `true` in the policy, if you want remote clients to use them. |
| Through the guard: `AUTH_FAILED` (guard `UNAUTHENTICATED` "Missing, expired or revoked worker-guard token") | The guard token expired or was revoked. | Pair again at the Mac (`tapdance worker guard pair`) and store the new token with `tapdance config set-token`. |
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
