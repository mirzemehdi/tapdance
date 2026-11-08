# End-to-end procedures on real hardware

These are the step-by-step procedures for proving Tapdance works on real machines, real emulators and
real simulators. Each one names the requirement IDs from [PRODUCT.md](../../PRODUCT.md) it proves.

**Procedures 1, 2 and 7 have been run** (on 2026-11-01, one Mac). Procedures 5 and 6 have been run
only in their device-only variant (the worker guard over Tailscale, set up with `host up`, instead of a
gateway); as written, with a gateway, they have not. Procedures 3, 4 and 8 have **not** been run as
written. Where a step is likely to need adjusting, it says so. If you run one, write an evidence record (see
[evidence/README.md](evidence/README.md)) and update [STATUS.md](../../STATUS.md). If a step is
wrong, file an issue (see [field-testing.md](field-testing.md)).

Every real run across machines used device-only mode, through the runbooks listed in
[field-testing.md](field-testing.md#runbooks): an N2 VM ([field-test-cloud-android.md](field-test-cloud-android.md)),
a rented Mac ([field-test-rented-mac-ios.md](field-test-rented-mac-ios.md)) and both at once. The gateway
procedures below (4, and 5 and 6 as written) are kept for the gateway route, which has run on one Mac
only.

| # | Procedure | Machines | Proves | State on 2026-11-08 |
| --- | --- | --- | --- | --- |
| 1 | [iOS simulator on macOS](#1-ios-simulator-on-macos) | 1 Mac | Q-03, M-01, D-03, V-01, V-03 | Run. [Evidence](evidence/2026-11-01-local-ios.md) |
| 2 | [Android emulator on macOS](#2-android-emulator-on-macos) | 1 Mac | Q-03, D-01 | Run. [Evidence](evidence/2026-11-01-android.md) |
| 3 | [Android emulator on Linux with KVM](#3-android-emulator-on-linux-with-kvm) | 1 Linux box | Q-03, D-01, D-02 | Not run as written; Android on a Linux/KVM VM ran in device-only mode from another machine (see 5) |
| 4 | [Two-machine laptop worker](#4-two-machine-laptop-worker-q-06) | VPS + laptop | Q-06, M-02, P-07, W-01, W-03, F-01 | Not run |
| 5 | [Google Cloud N2 worker](#5-google-cloud-n2-worker-q-05-q-07) | VPS + N2 VM (+ laptop browser) | Q-05, Q-07, G-01, M-03 | Device-only variant run (guard over Tailscale, from a Mac and from a VPS). [Evidence](evidence/2026-11-03-gcp-n2-android.md), [VPS](evidence/2026-11-03-vps-n2-android.md). The gateway route not run |
| 6 | [Mac worker from a Linux VPS](#6-mac-worker-from-a-linux-vps-q-08) | VPS + Mac | Q-08, D-04 | Device-only variant run (a VPS and a rented Mac mini, guard over Tailscale). [Evidence](evidence/2026-11-07-vps-rented-mac-ios.md). The gateway route not run |
| 7 | [AXe on a real Mac](#7-axe-on-a-real-mac-q-09) | 1 Mac (+ VPS for artifacts) | Q-09, U-02 | Run (local part; the VPS part is copying artifacts by hand). [Evidence](evidence/2026-11-01-axe.md) |
| 8 | [Android CLI on an N2 worker](#8-android-cli-on-an-n2-worker-q-10) | N2 VM (+ VPS) | Q-10, U-04, U-05 | Not run on an N2 worker; the Android CLI part ran on a local lease ([evidence](evidence/2026-11-01-android.md)); the "routed from a VPS" part is blocked (E-04) |

## Before any procedure

### What the pieces are

Tapdance is a thin layer over two upstream projects. Knowing which one does what helps you read
failures:

- [Simlock](https://github.com/callstackincubator/simlock) (MIT) owns devices: it creates, boots,
  leases and wipes emulators and simulators on a **worker**, and a **gateway** routes leases to
  workers that dial out to it. Tapdance bundles `simlock@0.5.0` (with its own patch); `tapdance simlock -- …` runs it.
- [agent-device](https://github.com/callstack/agent-device) (MIT) drives the UI, uploads apps and
  downloads screenshots and recordings. Simlock runs it on each worker.
- Tapdance adds the session-scoped CLI, MCP server and SDK, the keepalive, the artifact store, the
  browser viewer, host checks (KVM, SDKs, Xcode) and guided gateway/worker setup.

See [architecture-decision.md](../architecture-decision.md) for the full split.

### Install Tapdance from the repository on every machine

Every machine in a procedure (VPS, laptop, Mac, N2 VM) needs Node.js 22.13 or later, git, and a
build of this repository:

```bash
git clone https://github.com/mirzemehdi/tapdance.git
cd tapdance
corepack enable          # gives you the pnpm version pinned in package.json
pnpm install
pnpm build
```

Then put the `tapdance` command on your `PATH`. A small wrapper works in every shell, including the
non-interactive shells coding agents use:

```bash
mkdir -p "$HOME/.local/bin"
printf '#!/bin/sh\nexec node "%s/packages/cli/dist/main.js" "$@"\n' "$PWD" > "$HOME/.local/bin/tapdance"
chmod +x "$HOME/.local/bin/tapdance"
export PATH="$HOME/.local/bin:$PATH"     # add this line to ~/.profile or ~/.zshrc too
tapdance --version                       # prints 0.1.0
```

Linking the package globally with pnpm (after `pnpm setup`) may also work, but the wrapper above runs
exactly the build in your clone.

> **Do not run `npm install -g tapdance`.** On 2026-11-01 the npm package named `tapdance` is an
> unrelated project (a Test Anything Protocol harness, version 5.1.1). Tapdance is not published to
> npm yet (its package will be `@tapdance/cli`); install from the repository as above. No Tapdance
> hint prints a global npm install (`cli.test.ts` checks this).

### Habits for every run

- Use `--json` when you want output you can paste into a record. Results go to stdout, progress to
  stderr.
- Note every exit code (`echo $?`). Tapdance's codes: 2 usage/config, 3 lease, 4 provider/worker
  unreachable, 5 auth, 6 capacity, 7 device/element, 8 not supported, 9 timeout, 10 host check failed,
  11 a person is holding the device in the viewer.
- Set `TAPDANCE_DEBUG=1` to print the underlying cause's stack trace on errors.
- Give each run its own session id so leases do not collide: `export TAPDANCE_SESSION_ID=e2e-$(date +%s)`.
- Never paste a token, a join token, or a viewer link (its `#` fragment is a login key) into a record,
  an issue or a chat.

### Security facts to keep in mind

- **Leasing is not a sandbox.** An agent token on a Simlock worker is close to shell access on that
  machine as the user the Simlock daemon runs as (Simlock's `exec` and agent-device). Only give agent
  tokens to agents you would let run commands on that machine.
- **A joined worker gives its gateway operator rights.** Whoever controls the gateway, or holds an
  operator token for it, can lease and release any device on the worker, install and remove runtimes,
  and read its configuration. Join a worker only to a gateway you trust as much as the worker itself.
  (Simlock documents this in "Join workers to a gateway".)
- **Remote use needs TLS or a private network.** Simlock does not do TLS. Put a reverse proxy such as
  Caddy in front of the gateway, or keep everything on a private network such as
  [Tailscale](https://tailscale.com/). `tapdance worker login` refuses `ws://` to a public host, and
  the provider refuses to send a token over plain `http://` to a public host.
- **Never commit tokens.** Tapdance keeps them in `~/.tapdance/credentials.json` (mode 600) or in
  `TAPDANCE_TOKEN` / `TAPDANCE_OPERATOR_TOKEN`, and refuses them in config files. Simlock keeps a
  worker's join token in `~/.simlock/config.json`.

---

## 1. iOS simulator on macOS

**State:** run on 2026-11-01. [Evidence](evidence/2026-11-01-local-ios.md). Proves Q-03 (iOS part),
M-01, D-03; the viewer steps cover V-01 and V-03.

### Topology

One Mac. Tapdance (CLI or MCP), the Simlock worker and the simulator all run on it. Provider `local`.

```
Mac: agent ─▶ tapdance ─▶ local Simlock worker (+ agent-device) ─▶ iOS simulator
```

### Prerequisites

| Need | How to check | How to fix |
| --- | --- | --- |
| macOS with Xcode selected | `xcode-select -p`, `xcodebuild -version` | `sudo xcode-select -s /Applications/Xcode.app` |
| Xcode license accepted, first launch done | `tapdance worker check` | `sudo xcodebuild -license accept`, `sudo xcodebuild -runFirstLaunch` |
| At least one iOS runtime | `xcrun simctl list runtimes` | Xcode → Settings → Platforms, or `tapdance devices install ios <version>` |
| Node.js 22.13+, Tapdance built | `tapdance --version` | [Install Tapdance](#install-tapdance-from-the-repository-on-every-machine) |

### Steps

Run these from a scratch project folder (the artifacts land in `./tapdance-artifacts/`):

```bash
mkdir -p ~/td-e2e && cd ~/td-e2e
export TAPDANCE_SESSION_ID=e2e-ios-$(date +%s)

tapdance init --mode local -y
tapdance worker check                  # Xcode, runtimes; Android lines may fail on a Mac without the SDK
tapdance worker install                # enables agent-device, stream and input on the local Simlock worker; starts it
tapdance doctor
tapdance devices --platform ios        # pick a model and OS that are listed

tapdance device lease --platform ios --device "iPhone 16" --os 18.5
tapdance device status
tapdance --json device lease --platform ios   # second lease in the same session: must be refused
echo "exit: $?"                               # expect 3

tapdance app launch com.apple.Preferences
tapdance ui inspect
tapdance ui tap --text General
tapdance ui key back
tapdance ui swipe --direction up
tapdance ui wait --stable
tapdance ui alert get
tapdance record start
tapdance screenshot --note "Settings after swipe"
tapdance record stop
tapdance logs -n 50
tapdance logs --crash -n 20
tapdance artifacts
tapdance device release
tapdance --json device status; echo "exit: $?"   # expect NO_ACTIVE_LEASE, exit 3
```

Optional: install your own simulator build. This ran with the demo app in `examples/ios-demo`
([evidence](evidence/2026-11-01-local-ios.md)), and through the guard from another machine
([evidence](evidence/2026-11-07-vps-rented-mac-ios.md)); STATUS.md F-01:

```bash
xcodebuild -project MyApp.xcodeproj -scheme MyApp -sdk iphonesimulator -configuration Debug -derivedDataPath build
tapdance app install build/Build/Products/Debug-iphonesimulator/MyApp.app
tapdance app launch com.example.MyApp
```

Optional: the browser viewer (V-01, V-03). With a lease held:

```bash
tapdance view          # prints a loopback link; its #fragment is a one-time login key
```

Open the link in a browser on the same Mac. Tap in the page, then run `tapdance ui tap --text General`
in a terminal within 15 seconds: it must fail with `HUMAN_HELD` (exit 11, retryable). Use
"Take over" and "Hand back" in the page.

### The automated version

The same loop, through the MCP server over stdio, is the integration test
`packages/cli/src/mcp-local.integration.test.ts` (details in [unit-tests.md](unit-tests.md)):

```bash
cd /path/to/tapdance
tapdance worker install      # once
TAPDANCE_IT_PLATFORM=ios TAPDANCE_IT_DEVICE="iPhone 16" TAPDANCE_IT_OS=18.5 pnpm test:integration
```

To include a custom app, add `TAPDANCE_IT_APP=/abs/path/MyApp.app TAPDANCE_IT_APP_ID=com.example.MyApp`.
The test runs in a temporary folder and allows the app's folder itself (it sets
`TAPDANCE_ALLOWED_ROOTS` to it).

### Expected results

- `worker install` ends with "Worker is running."
- `doctor` passes "Simlock … reachable", "Token accepted", "agent-device served by Simlock" and "iOS
  simulators available". On a Mac without the Android command-line tools it reports those as
  failures and exits 10; that is expected (it happened in the 2026-11-01 run). To silence it, run
  `tapdance config set platforms.android.enabled false`.
- The first lease takes up to about a minute (Simlock creates and boots a simulator; 40 s in the
  spike), a warm lease under a second. The lease block shows Device, Platform, Provider, Worker
  ("this machine"), Endpoint, Status and Lease, and a Keepalive line with a pid.
- The second lease fails with `LEASE_ALREADY_HELD`, exit 3.
- `ui tap --text General` returns a short list of what changed on screen.
- The screenshot is a PNG over 1 KB; the recording is an MP4 (2.6 MB in the 2026-11-01 run).
- After `device release`, the keepalive process has exited (`ps -p <pid>` finds nothing) and
  `device status` answers `NO_ACTIVE_LEASE`.
- The integration test reports 1 passed (it took 70–82 s on an M1 Pro).

### Evidence to capture

`tapdance --json doctor`, the lease block, `tapdance --json artifacts`, the PNG, the MP4's size, the
integration test summary line, and `tapdance report` output for the environment section.

### Record

`docs/testing/evidence/YYYY-MM-DD-local-ios.md`. Note anything that differs from the 2026-11-01 run,
especially Xcode, iOS runtime and Simlock versions.

---

## 2. Android emulator on macOS

**State:** run on 2026-11-01 after installing the Android SDK command-line tools on the test Mac
([evidence](evidence/2026-11-01-android.md)). Proves Q-03 (Android on macOS) and D-01.

### Topology

One Mac, provider `local`, as in procedure 1 but with an Android emulator.

### Prerequisites

Simlock's requirements for Android: an Android SDK with the command-line tools, the `emulator` and
`platform-tools` packages, and a JDK with `JAVA_HOME` set. Simlock never installs these for you.

1. **Android SDK.** Android Studio installs one at `~/Library/Android/sdk`. Without Android Studio,
   pick a folder and download the "Command line tools only" package from
   <https://developer.android.com/studio#command-line-tools-only>.
2. **Command-line tools in the right place.** Tapdance and Simlock look for
   `$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager`. In Android Studio: Settings → Languages &
   Frameworks → Android SDK → SDK Tools → "Android SDK Command-line Tools (latest)". From the zip:

   ```bash
   export ANDROID_HOME="$HOME/Library/Android/sdk"
   mkdir -p "$ANDROID_HOME/cmdline-tools"
   unzip ~/Downloads/commandlinetools-mac-*_latest.zip -d /tmp/clt
   mv /tmp/clt/cmdline-tools "$ANDROID_HOME/cmdline-tools/latest"
   ```

   A Homebrew cask install of the command-line tools puts them outside `$ANDROID_HOME`, which
   Tapdance's check does not find.
3. **A JDK.** Android Studio bundles one:

   ```bash
   export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
   ```

   Put both exports in `~/.zshrc`. The Simlock daemon reads them when it starts.
4. **Emulator and platform tools, and the SDK licences:**

   ```bash
   "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --install emulator platform-tools
   "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --licenses
   ```

### Steps

```bash
mkdir -p ~/td-e2e-android && cd ~/td-e2e-android
export TAPDANCE_SESSION_ID=e2e-android-mac-$(date +%s)

tapdance worker check --android-only   # every host.android.* line should pass
tapdance init --mode local -y
tapdance worker install                # restarts the daemon so it sees the new SDK
tapdance devices install android 35    # Simlock installs the google_apis image for this Mac's CPU (several GB)
tapdance devices --platform android    # note the model names and API levels listed
tapdance doctor

tapdance device lease --platform android --os 35
tapdance device status
tapdance app launch com.android.settings
tapdance ui inspect
tapdance ui tap --ref @e3              # pick a ref from the inspect output
tapdance ui key back
tapdance ui swipe --direction up
tapdance record start
tapdance screenshot --note "Android settings"
tapdance record stop
tapdance logs -n 100
tapdance logs --crash
tapdance app install ./app-debug.apk   # any debug APK you built, e.g. ./gradlew assembleDebug
tapdance app launch com.example.app    # its package name
tapdance app stop com.example.app
tapdance artifacts
tapdance device release
```

Then the automated loop:

```bash
cd /path/to/tapdance
TAPDANCE_IT_PLATFORM=android TAPDANCE_IT_OS=35 pnpm test:integration
```

If `devices install` fails with `LICENSE_NOT_ACCEPTED`, run `sdkmanager --licenses` again (or see
Simlock's "Runtimes and images" page for `downloads.acceptAndroidLicenses`), then
`tapdance worker restart`.

### Expected results

- `worker check --android-only` passes Android SDK, platform-tools, emulator package, command-line
  tools and system images. On Apple silicon the image ABI is `arm64-v8a`.
- The lease block shows Platform Android, API 35, Worker "this machine".
- `logs` returns logcat lines; `logs --crash` reads the crash buffer (often empty).
- `app install` with an `.aab` converts it to a universal APK with bundletool on this machine and
  installs that (STATUS.md D-09). Without bundletool it fails with `APP_PATH_INVALID` (exit 2) and a
  hint to install bundletool or build an APK.
- The integration test reports 1 passed.

Simlock creates its own emulators from installed images. It does **not** lease your existing AVDs;
`worker check` lists them only for information (STATUS.md D-05).

### Evidence to capture

`tapdance --json worker check --android-only`, `tapdance --json devices --platform android`, the lease
block, screenshot, MP4 size, logcat excerpt (no personal data), integration test summary.

### Record

`docs/testing/evidence/YYYY-MM-DD-android.md`. Update STATUS.md D-01 and P-01.

---

## 3. Android emulator on Linux with KVM

**State:** not run as written (an agent on the Linux machine itself). A Google Cloud N2 VM with KVM ran
Android as a remote host in device-only mode, and its KVM checks ran there (STATUS.md D-01, D-02;
[evidence](evidence/2026-11-03-gcp-n2-android.md)); the missing-KVM path is unit-tested only. Proves
Q-03 (Android on Linux), D-01, D-02.

### Topology

One x86_64 Linux machine with hardware virtualization: a desktop, a dedicated server, or a VM with
nested virtualization. Provider `local`.

### Prerequisites

| Need | How to check |
| --- | --- |
| CPU virtualization flags | `grep -cE 'vmx|svm' /proc/cpuinfo` prints more than 0 |
| `/dev/kvm` exists and your user can open it | `ls -l /dev/kvm`; `id` shows the `kvm` group |
| `kvm-ok` passes | `sudo apt-get install -y cpu-checker && kvm-ok` |
| Node.js 22.13+, git, unzip, a JDK 17 or later | `node --version`, `java -version` |

Install on Ubuntu 24.04:

```bash
sudo apt-get update
sudo apt-get install -y git unzip cpu-checker openjdk-17-jdk-headless
sudo usermod -aG kvm "$USER"            # then log out and back in
export ANDROID_HOME="$HOME/android-sdk"
export JAVA_HOME="$(dirname "$(dirname "$(readlink -f "$(command -v java)")")")"
mkdir -p "$ANDROID_HOME/cmdline-tools"
# Download "Command line tools only" for Linux from https://developer.android.com/studio#command-line-tools-only
unzip commandlinetools-linux-*_latest.zip -d /tmp/clt
mv /tmp/clt/cmdline-tools "$ANDROID_HOME/cmdline-tools/latest"
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --install emulator platform-tools
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --licenses
```

On Linux there is no default SDK location, so `ANDROID_HOME` must be set in the environment the
Simlock daemon starts from (for example in `~/.profile`).

### Steps

```bash
export TAPDANCE_SESSION_ID=e2e-android-linux-$(date +%s)
tapdance worker check --android-only   # exit 10 if any KVM check fails
tapdance init --mode local -y
tapdance worker install
tapdance devices install android 35
tapdance doctor
```

Then the same lease → launch → inspect → tap → swipe → screenshot → record → logs → install APK →
release sequence as [procedure 2](#2-android-emulator-on-macos), and the integration test with
`TAPDANCE_IT_PLATFORM=android`.

**Negative check (D-02).** On a machine or VM **without** KVM (for example, an ordinary VPS), run:

```bash
tapdance worker check --android-only; echo "exit: $?"
tapdance worker install
```

`worker check` must fail the KVM lines and exit 10. `worker install` must warn that hardware
acceleration is missing and that emulators will not be provisioned (no software fallback). No lease
should ever produce a software-emulated device.

### Expected results

- The four KVM checks pass: CPU virtualization flags, `/dev/kvm`, `kvm-ok`, Android Emulator
  acceleration (`emulator -accel-check`).
- The image ABI is `x86_64`.
- The rest as in procedure 2.

### Evidence to capture

The KVM check output (`tapdance --json worker check --android-only`), `uname -a`, CPU model
(`lscpu | head -20`), the negative-check output if you ran it, plus procedure 2's evidence.

### Record

`docs/testing/evidence/YYYY-MM-DD-local-android-linux-kvm.md`. Update STATUS.md D-01, D-02.

---

## 4. Two-machine laptop worker (Q-06)

**State:** not run. Proves Q-06, M-02, P-07, and exercises W-01, W-03, W-04, F-01, S-07, C-06.

> Gateway route, never run across machines. To reach a host from another machine today, use
> device-only mode: [one-command-host.md](../deployment/one-command-host.md), the route the 2026-11-02
> run used ([evidence](evidence/2026-11-02-vps-field-runs.md)).

### Topology

```
VPS (Linux, no KVM)                              Laptop (macOS or Linux)
  Claude Code (agent)                              Simlock worker (+ agent-device)
  tapdance CLI / MCP                               Android emulator (and/or iOS simulator on a Mac)
  Simlock gateway on 127.0.0.1:4700   ◀── wss ──   dials out; no inbound port
  TLS: Caddy, or Tailscale
```

The laptop opens no ports and needs no router change. The VPS needs no KVM: the gateway runs no
devices. Optionally a browser on the laptop watches through an SSH tunnel to the VPS.

### Prerequisites

- **VPS:** Linux, Node.js 22.13+, Tapdance built. A way for the laptop to reach it securely, one of:
  - a DNS name pointing at the VPS and [Caddy](https://caddyserver.com/) installed (ports 80 and 443
    open), or
  - [Tailscale](https://tailscale.com/) on both machines, with HTTPS certificates enabled for the
    tailnet.
- **Laptop:** procedure 2 (Mac) or 3 (Linux) prerequisites done, so `tapdance worker check` passes
  for Android. For iOS on a Mac, procedure 1's prerequisites.
- A debug APK on the VPS, e.g. `~/td-e2e/app-debug.apk`.

### Steps

**On the VPS — start the gateway:**

```bash
tapdance gateway setup --worker-label my-laptop --public-url https://gw.example.com
```

It starts a Simlock gateway on `127.0.0.1:4700`, enables agent-device, stream and input, mints a
worker join token, an agent token and an operator token, and saves the agent and operator tokens in
`~/.tapdance/credentials.json` with `provider: "self-hosted"` and `endpoint: http://127.0.0.1:4700`.
It prints the worker join token **once**. Copy it to the laptop by a private channel (not chat, not
an issue, not a commit).

**On the VPS — make the gateway reachable over TLS** (pick one):

```bash
# Caddy: put this in /etc/caddy/Caddyfile, then: sudo systemctl reload caddy
gw.example.com {
	reverse_proxy 127.0.0.1:4700 {
		flush_interval -1
	}
}

# or Tailscale:
sudo tailscale serve --bg --https=443 http://127.0.0.1:4700
```

Check from the laptop: `curl -fsS https://gw.example.com/v1/healthz` (or the `*.ts.net` name).

**On the laptop — install the worker and join:**

```bash
tapdance worker check
tapdance worker install
tapdance devices install android 35            # before joining; several GB
tapdance worker login --accept-gateway-exec --gateway wss://gw.example.com --label my-laptop
# paste the join token at the hidden prompt
```

To avoid a prompt, pipe the token from a file or a password manager, or set `TAPDANCE_WORKER_TOKEN`
for that one command. Do not put it on the command line, where it lands in shell history.

On a Mac, keep it awake while agents work: `caffeinate -is` in a terminal. A closed lid or sleep takes
the worker offline.

**On the VPS — check the fleet:**

```bash
tapdance workers list            # uses the operator token gateway setup saved; my-laptop: connected
tapdance doctor --no-host        # --no-host: the VPS has no SDKs and does not need them
tapdance devices --platform android
```

**On the VPS — drive it through MCP (the point of Q-06):**

```bash
cd ~/td-e2e
claude mcp add tapdance -- tapdance mcp
```

Restart Claude Code, then ask it to: lease an Android device, install `./app-debug.apk`, launch it,
inspect the screen, tap something by text, type into a field, take a screenshot, record a short MP4,
read logs, list artifacts, and release the device. The tool names it should use are
`lease_device`, `install_app`, `launch_app`, `inspect_screen`, `tap`, `type_text`, `take_screenshot`,
`start_recording`, `stop_recording`, `get_logs`, `get_test_artifacts`, `release_device`.

The same with the CLI, if you want a scripted run:

```bash
export TAPDANCE_SESSION_ID=e2e-laptop-$(date +%s)
tapdance device lease --platform android --os 35
tapdance device status                         # Worker: my-laptop
tapdance app install ./app-debug.apk           # uploaded through the gateway to the laptop
tapdance app launch com.example.app
tapdance ui inspect
tapdance ui tap --text "Sign in"
tapdance ui type "hello@example.com" --text Email
tapdance record start
tapdance screenshot --note "remote screenshot"
tapdance record stop
tapdance logs --app com.example.app
tapdance artifacts                             # files are on the VPS
tapdance device release
```

**Resilience checks (W-03, W-04):**

1. With a lease held, turn the laptop's network off for about 30 seconds. A command from the VPS
   during the outage should fail with `WORKER_OFFLINE` (exit 4, `retryable: true`). Turn the network
   back on; within about 30 seconds `tapdance workers list` shows `connected` again and the next
   command works on the same lease.
2. Lease, then kill the MCP server (quit Claude Code). The MCP server releases its lease on graceful
   shutdown; after a crash, the lease must expire after its TTL. Check with
   `tapdance simlock -- --gateway status` (operator view) that nothing stays leased.

**Optional viewer:** on the VPS run `tapdance view` while a lease is held. On the laptop run
`ssh -L 4710:127.0.0.1:4710 <vps>` and open the link `tapdance view` printed (4710 is the default
viewer port, so the link works unchanged through the tunnel). Watch, tap, take over, hand back.

**Cleanup:**

```bash
# laptop
tapdance worker logout
# VPS
tapdance simlock -- --gateway token list
tapdance simlock -- --gateway token revoke <worker token id>
```

### Expected results

- `workers list` shows `my-laptop: connected`.
- The lease block on the VPS shows Worker `my-laptop` and the gateway Endpoint.
- The APK installs on the laptop's emulator; screenshots, MP4 and logs appear under
  `~/td-e2e/tapdance-artifacts/<session>/` **on the VPS**, listed in its manifest.
- No inbound port was opened on the laptop (check with `lsof -iTCP -sTCP:LISTEN` on a Mac or
  `ss -ltn` on Linux before and after: nothing new listens on a public interface).
- After release, `tapdance device status` answers `NO_ACTIVE_LEASE`.

### Evidence to capture

`tapdance --json workers list`, the lease block, the MCP transcript (the agent's tool calls and
results, tokens removed), `tapdance --json artifacts`, file sizes and hashes of the artifacts on the
VPS, the resilience-check outputs, and the listening-ports output before/after.

### Record

`docs/testing/evidence/YYYY-MM-DD-laptop-worker.md`. Update STATUS.md Q-06, M-02, P-07, W-01, W-03,
S-07 and F-01 (only if a custom APK was installed).

---

## 5. Google Cloud N2 worker (Q-05, Q-07)

> **Use the device-only runbook instead:** [field-test-cloud-android.md](field-test-cloud-android.md)
> is what ran (from a Mac and from a Linux VPS). The gateway route below has never run across
> machines.

**State:** not run as written (through a gateway). The device-only variant ran: an N2 VM made with the
Terraform module and set up with `scripts/host-setup.sh` and `host up`, driven over Tailscale from a
Mac and from a Linux VPS ([evidence](evidence/2026-11-03-gcp-n2-android.md),
[VPS](evidence/2026-11-03-vps-n2-android.md); runbook:
[field-test-cloud-android.md](field-test-cloud-android.md)). Proves Q-05; with the browser part, Q-07
(needs a GCP project with billing and nested virtualization allowed).

### Topology

```
VPS (no KVM): agent + tapdance + gateway  ◀── wss ──  N2 VM: Simlock worker + Android emulator (KVM)
      ▲
      └── ssh -L from a separate laptop: browser viewer (Q-07)
```

### Prerequisites

- The VPS from procedure 4, with a gateway already set up and reachable over TLS.
- A Google Cloud project with billing, the Compute Engine API enabled, quota for an
  `n2-standard-4`, and an organisation policy that allows nested virtualization.
- The owner's explicit go-ahead: **this costs money.** As a dated estimate (November 2026), an
  `n2-standard-4` in `us-central1` is about US$0.19 per hour on demand (about US$140 per 730-hour
  month), plus the boot disk, which keeps billing while the VM is stopped. Check current prices at
  <https://cloud.google.com/compute/vm-instance-pricing> and the
  [pricing calculator](https://cloud.google.com/products/calculator).
- Use an N2 machine type. Do not substitute N2D or E2 (G-01).

### Steps

1. **Provision** the VM with the Terraform in
   [`infrastructure/terraform/google-cloud-n2/`](../../infrastructure/terraform/google-cloud-n2/README.md),
   following [docs/deployment/google-cloud-n2.md](../deployment/google-cloud-n2.md). Keep
   `terraform.tfvars` and the state out of git (the repository's `.gitignore` already excludes them).
2. **Verify KVM on the VM** (Q-05 "verify KVM"):

   ```bash
   grep -cE 'vmx|svm' /proc/cpuinfo
   ls -l /dev/kvm
   kvm-ok
   ```

3. **Install the Android SDK and Tapdance** on the VM as in [procedure 3](#3-android-emulator-on-linux-with-kvm)
   (or with the install script under `infrastructure/scripts/`, see the Terraform README), then:

   ```bash
   tapdance worker check --android-only
   tapdance worker install
   tapdance devices install android 35
   ```

   On the VPS: `tapdance gateway token --role worker --label n2-worker-1` (printed once). On the VM:

   ```bash
   tapdance worker login --accept-gateway-exec --gateway wss://gw.example.com --label n2-worker-1
   ```

4. **Lease from the VPS** (Q-05):

   ```bash
   tapdance workers list                         # n2-worker-1: connected
   tapdance devices --platform android           # pick a Pixel model from the list
   tapdance device lease --platform android --device "Pixel 8" --os 35
   tapdance app install ./app-debug.apk
   tapdance app launch com.example.app
   tapdance screenshot --note "N2 emulator"
   tapdance device release
   ```

5. **Q-07 additions** — repeat step 4 through MCP from Claude Code on the VPS (as in procedure 4),
   and while the lease is held:
   - On the VPS: `tapdance view`.
   - On a **separate** laptop: `ssh -L 4710:127.0.0.1:4710 <vps>`, open the link, watch the agent,
     tap and swipe from the browser, take over, hand back, take a screenshot and start/stop a
     recording from the page.
   - Check that the MP4, screenshots and logs are on the VPS.
6. **Clean up:** release, `tapdance worker logout` on the VM, revoke the worker token on the VPS,
   then destroy the VM with Terraform (owner's go-ahead) and confirm in the Cloud Console that no
   disk or static IP is left billing.

### Expected results

- All four KVM checks pass on the VM. If `/dev/kvm` is missing, nested virtualization is not enabled
  for the VM; `worker install` must refuse to pretend and no emulator should start.
- First emulator boot on the N2 is slower than on a laptop; record the time from lease request to
  lease block.
- `workers list` shows `n2-worker-1: connected`; the lease block shows that worker.
- Q-07: the browser shows live video; the agent's next action after a human touch fails with
  `HUMAN_HELD` until the hold ends or the person hands back.

### Evidence to capture

Machine type, zone, image and disk from `terraform output` (no project id), KVM check output, boot
time, lease block, artifacts with hashes, a screenshot of the browser viewer (crop out the URL bar —
the link contains a login key), the hourly cost you were billed if known.

### Record

`docs/testing/evidence/YYYY-MM-DD-gateway-n2-android.md` (the device-only runs are named
`gcp-n2-android` from a Mac and `vps-n2-android` from a VPS; see [evidence/README.md](evidence/README.md)).
Update STATUS.md Q-05, Q-07, G-01, G-02, M-03.

---

## 6. Mac worker from a Linux VPS (Q-08)

> **Use the device-only runbook instead:** [field-test-rented-mac-ios.md](field-test-rented-mac-ios.md)
> is what ran (from a Mac and from a Linux VPS). The gateway route below has never run across
> machines.

**State:** not run as written (through a gateway). The device-only variant ran: a Linux VPS drove a
rented Scaleway Mac mini through the worker guard over Tailscale, CLI and MCP, a host build and a
47 MB `.app` upload ([evidence](evidence/2026-11-07-vps-rented-mac-ios.md); runbook:
[field-test-rented-mac-ios.md](field-test-rented-mac-ios.md)). Proves Q-08, and checks D-04 (simulator
`.app` vs device `.ipa`).

### Topology

```
Linux VPS: agent + tapdance + gateway  ◀── wss ──  Mac (own Mac mini, laptop, or a cloud Mac):
                                                     Xcode + Simlock worker + iOS simulator
```

The VPS cannot build iOS apps or run simulators. The `.app` is built on a Mac and copied to the VPS;
Tapdance then uploads it from the VPS through the gateway to the Mac worker.

### Prerequisites

- The VPS and gateway from procedure 4.
- A Mac meeting procedure 1's prerequisites, with Tapdance built.
- A simulator build of an app on the VPS. Build it on a Mac, then copy it:

  ```bash
  xcodebuild -project MyApp.xcodeproj -scheme MyApp -sdk iphonesimulator -configuration Debug -derivedDataPath build
  scp -r build/Build/Products/Debug-iphonesimulator/MyApp.app <vps>:~/td-e2e/
  ```

  The build's CPU architecture must match the Mac worker (Apple silicon simulators run arm64 builds).
- **If the Mac is rented**, know the allocation terms before you start (estimates as of November 2026;
  check the provider's page):
  - Scaleway Mac mini: billed hourly with a **24-hour minimum** allocation (Apple's macOS licence;
    you cannot delete the machine earlier), see <https://www.scaleway.com/en/docs/apple-silicon/faq>.
    The M2 was listed at about €0.17 per hour on Scaleway's (French) product page,
    <https://www.scaleway.com/fr/mac-mini-m2/>.
  - AWS EC2 Mac: runs only on a Dedicated Host with a **24-hour minimum** allocation before the host
    can be released; billed per second after that.
    <https://aws.amazon.com/ec2/dedicated-hosts/pricing/>
  Never store AWS credentials in plain text on the VPS or the Mac.

### Steps

On the Mac:

```bash
tapdance worker check
tapdance worker install
tapdance devices --platform ios                       # confirm the runtime you want is listed
```

On the VPS, mint a join token for this worker (printed once):

```bash
tapdance gateway token --role worker --label mac-1
```

Back on the Mac, join with it:

```bash
tapdance worker login --accept-gateway-exec --gateway wss://gw.example.com --label mac-1
caffeinate -is                                         # in its own terminal, while testing
```

On the VPS, through MCP in Claude Code (the requirement) and/or the CLI:

```bash
export TAPDANCE_SESSION_ID=e2e-mac-$(date +%s)
cd ~/td-e2e
tapdance workers list                                  # mac-1: connected
tapdance device lease --platform ios --device "iPhone 16"
tapdance app install ./MyApp.app
tapdance app launch com.example.MyApp
tapdance ui inspect
tapdance ui tap --text "Continue"
tapdance record start
tapdance screenshot --note "iOS via gateway"
tapdance record stop
tapdance logs --app com.example.MyApp
tapdance artifacts
tapdance --json app install ./MyApp.ipa; echo "exit: $?"   # D-04: must be refused
tapdance device release
```

Run the MCP version too: `claude mcp add tapdance -- tapdance mcp`, restart Claude Code, and ask it to
do the same loop. The MCP server only installs apps inside its working directory or a folder listed
in `TAPDANCE_ALLOWED_ROOTS`.

### Expected results

- `mac-1: connected`; the lease block shows Worker `mac-1`.
- The `.app` installs and launches; artifacts appear on the VPS.
- The `.ipa` is refused with `APP_PATH_INVALID` (exit 2) and a hint to build for the simulator.

### Evidence to capture

As procedure 4, plus Xcode and runtime versions on the Mac, and the `.app`'s size. If the Mac is
rented, the provider, machine type and start/end times (the 24-hour minimum matters for cost).

### Record

`docs/testing/evidence/YYYY-MM-DD-gateway-mac-ios.md` (the device-only runs are named `rented-mac-ios`
and `vps-rented-mac-ios`). Update STATUS.md Q-08, F-01, D-04.

---

## 7. AXe on a real Mac (Q-09)

**State:** run on 2026-11-01 ([evidence](evidence/2026-11-01-axe.md)). Proves Q-09 and U-02.

[AXe](https://github.com/cameroncooke/AXe) (MIT, Cameron Cooke) is a CLI that drives iOS simulators
through accessibility: describe the UI, tap by label, type, take screenshots and record video. Tapdance
can use it as the iOS UI backend instead of agent-device.

### Important limits

- **AXe works only when Tapdance runs on the Mac that hosts the simulator** (provider `local`). It does
  not work through a gateway. Q-09 asks for "artifacts to VPS"; with AXe that means copying them from
  the Mac yourself (step 7 below). Routing AXe from a remote agent is not built.
- **AXe reads only Xcode's default device set.** `tapdance worker install --ios-backend axe` therefore
  sets Simlock's `drivers.ios.deviceSet` to `default`, so Simlock's simulators live next to your own in
  `~/Library/Developer/CoreSimulator/Devices`. Simlock still only touches simulators it created.
- **Switching the device set on a Mac that already has Simlock simulators turns iOS off** until the
  old ones are cleaned up (Simlock reports `device-set-changed`). Simlock's documented fix deletes
  Simlock's own simulators (not yours) — see "Switch the device set" in Simlock's "Build and run your
  app" page. Do it only on a Mac where losing Simlock-created simulators is fine.

### Steps

1. **Install AXe** (the owner decides whether to trust the tap):

   ```bash
   brew install cameroncooke/axe/axe
   axe --version
   axe list-simulators
   ```

2. **Switch the worker to AXe:**

   ```bash
   tapdance worker install --ios-backend axe
   tapdance doctor            # "AXe (iOS UI backend)" shows the AXe version
   ```

   If `doctor` says iOS simulators are unavailable with `device-set-changed`, follow Simlock's
   clean-up (run its commands through `tapdance simlock -- --local …`), then run
   `tapdance worker install --ios-backend axe` again.
3. **Lease and record the UDID:**

   ```bash
   export TAPDANCE_SESSION_ID=e2e-axe-$(date +%s)
   tapdance device lease --platform ios --device "iPhone 16"
   tapdance --json device status         # note the device id (UDID)
   xcrun simctl list devices booted      # the same UDID should be booted
   ```

4. **Drive it:**

   ```bash
   tapdance app launch com.apple.Preferences
   tapdance ui inspect                   # refs look like @a2, @a3 (AXe backend)
   tapdance ui tap --text General
   tapdance ui key home
   tapdance app launch com.apple.Preferences
   tapdance ui tap --text "Search"       # or any text field you find with ui inspect
   tapdance ui type "Wi-Fi"
   tapdance record start
   tapdance screenshot --note "AXe screenshot"
   tapdance record stop
   tapdance artifacts
   ```

5. **Check targeting:** boot a second simulator of your own in Xcode before step 4. It must not be
   touched: no taps, no text, no recording.
6. **Release:** `tapdance device release`.
7. **Artifacts to the VPS:** `scp -r ./tapdance-artifacts/<session> <vps>:~/td-e2e/axe/`.
8. **Switch back** when finished. Release every lease first; switching again needs the same
   device-set clean-up as before:

   ```bash
   tapdance config set ios.uiBackend agent-device --global
   tapdance simlock -- --local config set drivers.ios.deviceSet simlock
   tapdance worker restart
   tapdance doctor
   ```

### Expected results

- `doctor` shows the AXe version. Without AXe, it reports "not installed" and AXe actions fail with
  `PROVIDER_UNAVAILABLE` and an install hint.
- `ui inspect` returns elements with `@a…` refs and labels; `ui tap --text General` opens General.
- Typing reaches the focused field. Screenshot is a PNG; recording is an MP4.
- Your own simulator is unaffected.

### Evidence to capture

`axe --version`, macOS and Xcode versions, `tapdance --json doctor`, the UDID, inspect output, PNG,
MP4 size and hash, and confirmation of step 5.

### Record

`docs/testing/evidence/YYYY-MM-DD-axe.md`. Update STATUS.md U-02 and Q-09 (state that the VPS part was
a manual copy).

---

## 8. Android CLI on an N2 worker (Q-10)

**State:** not run on an N2 worker, and **partly blocked**. The Android CLI itself ran on a local lease
on a Mac ([evidence](evidence/2026-11-01-android.md)). Proves (part of) Q-10, U-04, U-05.

Google's [Android CLI](https://developer.android.com/tools/agents/android-cli) (`android`) is an
agent-oriented CLI with commands such as `android layout`, `android input tap|text|swipe|key|scroll`,
`android screen capture` and `android emulator …`. Tapdance runs it unchanged with
`tapdance android -- <args>` (or MCP `execute_tool` with `tool: "android"`), appends
`--device=<serial>` to subcommands that take it and sets `ANDROID_ADB_SERVER_PORT`, so the CLI acts on
the session's leased emulator and not on another device. Verified locally with `layout --flat`
([evidence](evidence/2026-11-01-android.md)); not yet on a Linux/KVM worker.

### What is blocked

Q-10 asks for the Android CLI on an N2 worker, **routed from a different VPS**. Tapdance runs external
tools only on the control machine today (`--target control`); running them on a remote worker needs a
worker-side executor that does not exist (STATUS.md E-04). So the routed part cannot be tested yet.
What can be tested is the CLI on the N2 VM itself, with Tapdance there acting as a local agent.

### Steps (on the N2 VM)

1. Do procedure 5 steps 1–3, but **do not** run `worker login` yet (a joined worker turns off its
   local HTTP API, so local agents would have to go through the gateway). If it is already joined,
   run `tapdance worker logout` first.
2. Install the Android CLI from <https://developer.android.com/tools/agents/android-cli>, then:

   ```bash
   android -V                 # version
   tapdance tools versions    # android should be listed as installed
   ```

3. Lease and drive with the CLI:

   ```bash
   export TAPDANCE_SESSION_ID=e2e-android-cli-$(date +%s)
   tapdance init --mode local -y
   tapdance device lease --platform android --os 35
   tapdance android -- layout -h          # read the real syntax first
   tapdance android -- layout
   tapdance android -- screen capture -h
   tapdance android -- input tap -h
   ```

   Then run `layout`, an `input tap` on an element from the layout, an `input text`, and a
   `screen capture` with the arguments the help shows (including an annotated capture if offered).
4. **Check U-05:** before leasing, note `adb devices` on the VM's default adb server. After the
   commands, confirm that no second emulator was started (`tapdance devices`, and the CLI's own
   `android emulator list`), and that the commands acted on the leased emulator (the screenshot shows
   it). Without a lease, a device command through `tapdance android --` should fail rather than pick
   some other device.
5. Release, then (optionally) `tapdance worker login` again for the other procedures.

### Expected results

- `tapdance android -- …` passes arguments through unchanged and preserves the CLI's stdout, stderr
  and exit code.
- Device commands hit the leased emulator only. If they do not, that is a U-05 bug: file it.

### Evidence to capture

Android CLI version, every command with its exit code and (trimmed) output, the captured images,
`adb devices` and `tapdance devices` before and after.

### Record

`docs/testing/evidence/YYYY-MM-DD-android-cli-n2.md`. Update STATUS.md U-04, U-05; leave Q-10 as
partial and say that the routed part is blocked on E-04.

---

## Credits

Tapdance builds on, and these procedures describe the behaviour of:
[Simlock](https://github.com/callstackincubator/simlock) (MIT),
[agent-device](https://github.com/callstack/agent-device) (MIT),
[AXe](https://github.com/cameroncooke/AXe) (MIT),
[Google's Android CLI](https://developer.android.com/tools/agents/android-cli),
and, for the viewer's take-over design, [Loupe](https://github.com/bmcreations/loupe) (Apache-2.0).
