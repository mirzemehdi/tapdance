# Try Tapdance on your own computer

In local mode your coding agent, Tapdance and the devices all run on one computer. Nothing leaves
the machine and no token is copied by hand.

Proven on a Mac (MacBook Pro M1 Pro, macOS 26.5, Xcode 26.5): iOS simulators
([evidence](../testing/evidence/2026-11-01-local-ios.md)), Android emulators
([evidence](../testing/evidence/2026-11-01-android.md)) and the AXe iOS backend
([evidence](../testing/evidence/2026-11-01-axe.md)). Not run: local mode on Linux. Android has run on
a Linux host with KVM only as a host for an agent on another machine
([Google Cloud N2](google-cloud-n2.md)).

## What you get

- iOS simulators (on a Mac) and Android emulators (on a Mac, or Linux with KVM) that your agent can
  lease, drive, screenshot and record.
- The CLI and the MCP server for Claude Code, Codex, Cursor or any MCP client.
- A live view of the device in your browser ([browser access](browser-access.md)).

Tapdance leases devices it creates itself. It never hands your own simulators or Android Studio AVDs
to an agent.

## What you need

| For | You need |
| --- | --- |
| Tapdance | macOS or Linux, Node.js 22.13 or later, Corepack (it ships with Node.js), git. |
| iOS simulators | A Mac with Xcode (tested: Xcode 26.5 on Apple silicon) and at least one iOS runtime. About 8 GiB of free disk per runtime, plus room for simulators. Watching the screen needs macOS 14 or later. |
| Android emulators | The Android SDK command-line tools (`sdkmanager`, `avdmanager`), `emulator`, `platform-tools`, a JDK with `JAVA_HOME` set, and at least one system image. On Linux also KVM. See [Android](../platforms/android.md). |

Windows cannot host devices: Simlock, which runs them, supports macOS and Linux only. Windows can run
the CLI and MCP server against a remote host.

## Steps

### 1. Install Tapdance

Tapdance is not on npm yet. Install it from source as in [installation](../installation.md), so that
`tapdance --version` works. Do not run `npm install -g tapdance`: that name belongs to another package.

### 2. Set up Xcode (iOS only)

Install Xcode from the Mac App Store or [developer.apple.com/download](https://developer.apple.com/download/).
Then select it, accept its licence and run its first-launch setup:

```bash
sudo xcode-select -s /Applications/Xcode.app
sudo xcodebuild -license accept
sudo xcodebuild -runFirstLaunch
xcodebuild -version
```

### 3. Install an iOS runtime or an Android image

Simlock creates devices only from runtimes and images that are already installed. A lease never
downloads one. For iOS, use Xcode's own command:

```bash
xcodebuild -downloadPlatform iOS
```

Or ask Tapdance for a version (several GB each):

```bash
tapdance devices install ios 18.5
tapdance devices install android 35
```

For iOS this runs Simlock's component install: it needs about 8 GiB free, installs iOS 16.0 or later,
runs one download per platform at a time, and gives up after 20 minutes by default. See
[simulator management](../ios/simulator-management.md#runtimes).

### 4. Check the machine

```bash
tapdance worker check
```

It reports Node.js, Xcode and its runtimes, the Android SDK, images and AVDs, and KVM on Linux. Pass
`--android-only` to skip the iOS checks. On a Mac without the Android tools the Android lines fail;
that does not block iOS.

### 5. Install the worker

```bash
tapdance worker install
```

This sets up the [worker](../glossary.md): the Simlock daemon bundled with Tapdance. It sets these
Simlock options and starts the daemon:

| Simlock key | Value | Why |
| --- | --- | --- |
| `capabilities.agent-device.enabled` | `true` | UI automation, app upload, screenshots and recordings |
| `capabilities.agent-device.command` | the bundled agent-device | so no global install is needed |
| `capabilities.stream.enabled` | `true` | the live screen for [`tapdance view`](browser-access.md) |
| `capabilities.input.enabled` | `true` | taps and keys from the viewer |

Useful options:

- `--service` also installs the worker as a login service (launchd on macOS, a systemd user unit on
  Linux), so it starts again when you log in.
- `--no-stream` leaves streaming and input off. The viewer then does not work.
- `--ios-backend axe` uses AXe for iOS. See [AXe for iOS](#axe-for-ios-optional).

### 6. Point Tapdance at the worker

From your app's project folder:

```bash
tapdance init --mode local --yes
tapdance doctor
```

`init` writes `./tapdance.config.json`. `doctor` checks Xcode, the Android SDK, KVM, the worker and
your lease.

### 7. Lease a device

```bash
tapdance device lease --platform ios --device "iPhone 16"
tapdance app launch com.apple.Preferences
tapdance ui inspect
tapdance ui tap --text General
tapdance screenshot
tapdance device release
```

The first lease creates and boots a device. On the test Mac that took about 40 seconds for an iOS
simulator; later leases from the warm pool took about half a second. Android emulators boot more
slowly; there is no measured figure for the Mac yet.

Use `--platform android` for an emulator, and `--os <version>` to pick an installed version.

### 8. Give your agent the tools

For Claude Code:

```bash
claude mcp add tapdance -- node /absolute/path/to/tapdance/packages/cli/dist/main.js mcp
```

Codex, Cursor and other clients: [connect your agent](../agents.md). The MCP server uses stdio. It
leases on demand through `lease_device`, renews while it runs, and releases its lease when the client
disconnects.

### AXe for iOS (optional)

[AXe](https://github.com/cameroncooke/AXe) (MIT) can replace agent-device for iOS UI automation. It
works only when Tapdance and the agent run on the Mac that hosts the simulator. Install it, then
switch:

```bash
brew install cameroncooke/axe/axe
tapdance worker install --ios-backend axe
```

The second command sets Simlock's `drivers.ios.deviceSet` to `default`, because AXe reads only Xcode's
default device set, and writes `ios.uiBackend: "axe"` to `~/.tapdance/config.json`. It refuses while
Simlock's own device set still holds simulators; see
[simulator management](../ios/simulator-management.md#device-sets) for the clean-up. AXe 1.8.0 ran on
the test Mac with a custom app's sign-in flow ([evidence](../testing/evidence/2026-11-01-axe.md)).

## Check it worked

- `tapdance doctor` passes for the platform you use.
- `tapdance screenshot` saved a file under `./tapdance-artifacts/<session>/`. `tapdance artifacts`
  lists what the session saved. The folder is the `artifacts.directory` config key, or
  `TAPDANCE_ARTIFACTS_DIR`.
- `tapdance view` shows the device live in your browser.

## Day-to-day commands

| Task | Command |
| --- | --- |
| Is the worker running? | `tapdance worker status` |
| Start, stop, restart it | `tapdance worker start`, `tapdance worker stop`, `tapdance worker restart` |
| Read its log | `tapdance worker logs` |
| What can I lease? | `tapdance devices` (add `--platform android` or `--platform ios`) |
| Install another runtime or image | `tapdance devices install ios 26.0`, `tapdance devices install android 35` |
| Watch the device | `tapdance view` |
| The bundled Simlock CLI, for operators | `tapdance simlock <args>`, for example `tapdance simlock --local doctor` |

`tapdance worker restart` ends agent-device sessions on the worker. A lease on a stopped worker ends
when its time to live runs out.

## How it works

Tapdance does not drive devices itself. It uses two upstream projects, both MIT, shipped as npm
dependencies:

- [Simlock](https://github.com/callstackincubator/simlock) runs the worker, which creates, boots,
  leases, wipes and deletes its own simulators and emulators.
- [agent-device](https://github.com/callstack/agent-device) reads the UI tree, taps, types, takes
  screenshots and records video. Simlock runs it on the worker.

In local mode the worker listens on loopback only. Tapdance finds it through the profile file the
worker writes (`~/.simlock/agent-device-profile.json` by default; override it with the
`simlock.profilePath` config key or `TAPDANCE_SIMLOCK_PROFILE`). See [how it works](../how-it-works.md)
for the other modes.

## If it fails

| Symptom | Fix |
| --- | --- |
| `tapdance worker check` fails on Xcode | Run the three `sudo` commands in [step 2](#2-set-up-xcode-ios-only). |
| "Simulator runtimes: none", or a lease fails because a runtime is missing | Install one ([step 3](#3-install-an-ios-runtime-or-an-android-image)), then lease with `--os` set to an installed version. |
| `No local Simlock worker profile at …` | `tapdance worker start`, or `tapdance worker install` the first time. |
| Viewer says streaming is off | `tapdance worker install` without `--no-stream`. |
| Viewer or stream fails with `EACCES` on `simlock-screen-capture` | The package manager dropped the execute bit on Simlock's helpers. `tapdance worker start` or `tapdance worker install` restores it. |
| iOS turned off after `--ios-backend axe` (`device-set-changed`) | Simulators are left in Simlock's own device set. See [simulator management](../ios/simulator-management.md#device-sets). |
| `This machine's worker has joined the gateway …` | This worker joined a gateway, which turns its local API off. Run `tapdance worker logout`, or see [gateway mode](gateway-mode.md#local-agents-on-a-joined-worker). |
| Android: command-line tools missing | Install "Android SDK Command-line Tools (latest)" into `$ANDROID_HOME/cmdline-tools/latest`. See [Android](../platforms/android.md). |
| Android on Linux: `/dev/kvm` missing or not writable | See [KVM on Linux](../platforms/android.md#kvm-on-linux). Tapdance never falls back to software emulation. |
| A bug you cannot explain | `tapdance report` writes a redacted, issue-ready report. |

More: [troubleshooting](../troubleshooting.md).

## Next

- Let an agent on another machine use this computer's devices:
  [host devices for a remote agent](one-command-host.md). It also covers keeping a Mac awake and
  running after a restart.
- The words used here: [glossary](../glossary.md).
