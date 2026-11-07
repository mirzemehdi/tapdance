# Local mode: devices on your own machine

In local mode, Tapdance, your coding agent and the emulator or simulator all run on one computer.
This is mode A in the [architecture decision](../architecture-decision.md) and requirement M-01 in
[PRODUCT.md](../../PRODUCT.md).

| What | Status (see [STATUS.md](../../STATUS.md)) |
| --- | --- |
| iOS simulator on macOS | Tested on a real Mac (MacBook Pro M1 Pro, macOS 26.5, Xcode 26.5, iPhone 16 / iOS 18.5). [Evidence](../testing/evidence/2026-11-01-local-ios.md). |
| Android emulator on macOS | Tested on the same Mac with Android 34 emulators, a custom APK and a Google Play image. [Evidence](../testing/evidence/2026-11-01-android.md). |
| Android emulator on Linux with KVM | Tested as a remote host (a Google Cloud N2 VM driven over Tailscale in device-only mode, [evidence](../testing/evidence/2026-11-03-gcp-n2-android.md)); an agent on the same Linux machine (local mode) not run. |
| Windows | Not supported as a device host. Windows can run the CLI and MCP server against a remote gateway only. |

## How it works

Tapdance does not drive devices itself. It ships two upstream projects as npm dependencies and talks
to them:

- [Simlock](https://github.com/callstackincubator/simlock) (MIT) runs a background daemon, the
  **worker**, that creates, boots, leases, wipes and deletes its own simulators and emulators.
- [agent-device](https://github.com/callstack/agent-device) (MIT) reads the UI tree, taps, types,
  takes screenshots and records video. Simlock runs it on the worker and fronts it.

In local mode the worker listens on loopback only. Tapdance finds it through the profile file the
worker writes (`~/.simlock/agent-device-profile.json` by default; override with the
`simlock.profilePath` config key or the `TAPDANCE_SIMLOCK_PROFILE` environment variable). No token
needs to be copied by hand.

Simlock leases **devices it creates** from the runtimes and system images installed on the machine.
It never hands your own simulators or Android Studio AVDs to an agent. `tapdance worker check` still
lists them so you can see what is installed.

## Requirements

| You want | You need |
| --- | --- |
| Tapdance itself | macOS or Linux, Node.js 22.13 or later, Corepack (ships with Node), git |
| iOS simulators | macOS with Xcode selected (`sudo xcode-select -s /Applications/Xcode.app`), its license accepted (`sudo xcodebuild -license accept`), first launch done (`sudo xcodebuild -runFirstLaunch`), and at least one iOS runtime |
| Android emulators | An Android SDK with the command-line tools (`sdkmanager`, `avdmanager`), `emulator` and `platform-tools`, a JDK with `JAVA_HOME` set, and at least one system image. On Linux also KVM. See [Android](../platforms/android.md). |

Details per platform: [Android](../platforms/android.md) and [iOS](../platforms/ios.md).

## Install

Tapdance is not published to npm yet. Install it from source:

```bash
git clone https://github.com/mirzemehdi/tapdance.git
cd tapdance
corepack enable
pnpm install
pnpm build
alias tapdance="node $PWD/packages/cli/dist/main.js"
```

## Set up

Run these from your app's project directory:

```bash
tapdance init --mode local --yes   # writes ./tapdance.config.json
tapdance worker install            # configures and starts the bundled Simlock worker
tapdance doctor                    # checks Xcode, the Android SDK, KVM, the worker and your lease
```

`tapdance worker install` sets these Simlock options and restarts the worker:

| Simlock key | Value | Why |
| --- | --- | --- |
| `capabilities.agent-device.enabled` | `true` | UI automation, app upload, screenshots and recordings |
| `capabilities.agent-device.command` | path of the bundled agent-device | so no global install is needed |
| `capabilities.stream.enabled` | `true` (`false` with `--no-stream`) | live screen for [`tapdance view`](browser-access.md) |
| `capabilities.input.enabled` | `true` (`false` with `--no-stream`) | taps and keys from the viewer |

Useful options:

- `--service` also installs the worker as a login service (launchd on macOS, a systemd user unit on
  Linux), so it starts again after you log in.
- `--ios-backend axe` switches iOS automation to [AXe](https://github.com/cameroncooke/AXe) (MIT)
  and keeps simulators in Xcode's default device set, which AXe needs. AXe ran on a real Mac with a
  custom app's sign-in flow ([evidence](../testing/evidence/2026-11-01-axe.md), STATUS.md U-02).

`tapdance doctor` on a Mac without Android command-line tools reports a failure for them. That does
not block iOS.

## First lease

```bash
tapdance device lease --platform ios --device "iPhone 16"
tapdance app launch com.apple.Preferences
tapdance ui inspect
tapdance ui tap --text General
tapdance screenshot
tapdance device release
```

The first lease creates and boots a device. On the M1 Pro test Mac this took about 40 seconds for an
iOS simulator; later leases from the warm pool took about half a second. Android emulators boot more
slowly; we have no measured figure yet.

Screenshots, recordings and logs are written to `./tapdance-artifacts/<session>/` (the
`artifacts.directory` config key, or `TAPDANCE_ARTIFACTS_DIR`). `tapdance artifacts` lists them.

## Give your agent the tools

For Claude Code:

```bash
claude mcp add tapdance -- node /absolute/path/to/tapdance/packages/cli/dist/main.js mcp
```

The MCP server uses stdio by default. Any MCP client that can start a command works the same way.
The server leases on demand through `lease_device`, renews while it runs, and releases its lease when
the client disconnects.

## Day-to-day commands

| Task | Command |
| --- | --- |
| Is the worker running? | `tapdance worker status` |
| Start, stop, restart it | `tapdance worker start`, `tapdance worker stop`, `tapdance worker restart` |
| Read its log | `tapdance worker logs` |
| What can I lease? | `tapdance devices` (add `--platform android` or `--platform ios`) |
| Install a runtime or system image | `tapdance devices install ios 26.0` or `tapdance devices install android 35` (several GB) |
| Watch the device | `tapdance view` (see [browser access](browser-access.md)) |

## Local mode and a gateway at the same time

When this machine's worker has joined a gateway (`tapdance worker login`, see
[laptop worker](laptop-worker.md)), Simlock turns its local HTTP API off. Local agents must then use
the gateway too: `tapdance init --mode self-hosted --endpoint <gateway URL>`. Run
`tapdance worker logout` to go back to local only.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `No local Simlock worker profile at …` | `tapdance worker start`, or `tapdance worker install` the first time. |
| `This machine's worker has joined the gateway …` | Use self-hosted mode against that gateway, or `tapdance worker logout`. |
| Viewer says streaming is off | `tapdance worker install` (without `--no-stream`). |
| Android: command-line tools missing | Install "Android SDK Command-line Tools (latest)" into `$ANDROID_HOME/cmdline-tools/latest`. See [Android](../platforms/android.md). |
| Android on Linux: `/dev/kvm` missing or not writable | See [Android](../platforms/android.md#kvm-on-linux). Tapdance never falls back to software emulation. |
| A bug you cannot explain | `tapdance report` writes a redacted, issue-ready report. |
