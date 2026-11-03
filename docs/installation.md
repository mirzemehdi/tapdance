# Installation

This page installs the `tapdance` command (CLI and MCP server) and the platform tools a machine needs
before it can run Android emulators or iOS simulators. For the first end-to-end run, continue with the
[quick start](quick-start.md).

## What you install

Tapdance 0.1.0 is one Node.js package, `tapdance` (in `packages/cli`), with four workspace packages
behind it (`@tapdance/core`, `@tapdance/provider-simlock`, `@tapdance/sdk`, `@tapdance/mcp`). It ships
two upstream projects as pinned npm dependencies, so you do not install them separately:

| Bundled | Version | What it does for Tapdance | License |
| --- | --- | --- | --- |
| [Simlock](https://github.com/callstackincubator/simlock) | 0.4.0 (exact) | Creates, leases, queues and cleans up emulators and simulators; runs the worker and gateway daemons. | MIT |
| [agent-device](https://github.com/callstack/agent-device) | 0.21.35 (exact) | UI snapshots, taps, typing, screenshots, MP4 recording, app upload and log download. | MIT |

`tapdance worker install` points Simlock at the bundled agent-device, and `tapdance simlock …` runs the
bundled Simlock CLI, so neither needs a global install. The [architecture decision](architecture-decision.md)
explains why Tapdance builds on these two projects.

Nothing else is bundled. Xcode, the Android SDK, a JDK and the optional external tools (`asc`, AXe,
Google's Android CLI, Maestro, fastlane) are yours to install; see [tools.md](tools.md).

## Requirements

| Machine role | OS | Needs |
| --- | --- | --- |
| Control machine (runs the CLI or MCP server for an agent) | macOS, Linux, Windows | Node.js 22.13 or later |
| Local worker for iOS simulators | macOS only | Node.js 22.13+, Xcode with at least one iOS runtime |
| Local worker for Android emulators | macOS, or Linux with KVM | Node.js 22.13+, Android SDK with command-line tools, `emulator`, `platform-tools`, a system image, a JDK |
| Gateway | macOS or Linux | Node.js 22.13+ only. A gateway runs no devices, so it needs no KVM, Xcode or Android SDK. |

Windows cannot be a worker: Simlock supports macOS and Linux only. `tapdance worker install` refuses
on Windows, and `tapdance doctor` says so. Windows works as a control machine.

Tested so far: local iOS and Android workers on an Apple-silicon Mac with Node 22.22.0
([iOS](testing/evidence/2026-11-01-local-ios.md), [Android](testing/evidence/2026-11-01-android.md)).
A Linux worker has not been run. See [compatibility.md](compatibility.md) and
[STATUS.md](../STATUS.md) for what is and is not proven.

## Install the CLI

### From npm: not available yet

Tapdance is **not published to npm yet**. Be careful: the npm name `tapdance` currently belongs to an
unrelated package (a Test Anything Protocol harness, checked on 2026-11-01), so `npm install -g tapdance`
installs the wrong program today. The CLI package is named `@tapdance/cli` (the command is still
`tapdance`); until it is published, install from source.

### From source (the supported way today)

You need Node.js 22.13+ and pnpm 10 (the repository pins `pnpm@10.20.0`; Corepack provides it). The
build's own scripts call `pnpm`, so it must be on your PATH: `corepack enable` puts it next to Node
(which may need sudo); `corepack enable --install-directory ~/.local/bin pnpm` puts it in your home
folder instead.

```bash
git clone https://github.com/mirzemehdi/tapdance.git   # the repository URL declared in package.json
cd tapdance
corepack enable --install-directory ~/.local/bin pnpm   # ~/.local/bin must be on your PATH
pnpm install
pnpm build
node packages/cli/dist/main.js --version                 # prints 0.1.0
```

Put `tapdance` on your `PATH`. `packages/cli/dist/main.js` has a `#!/usr/bin/env node` line and is
executable, so a symlink works:

```bash
mkdir -p ~/.local/bin
ln -s "$PWD/packages/cli/dist/main.js" ~/.local/bin/tapdance
tapdance --version
```

(`~/.local/bin` must be on your `PATH`.) Alternatively, call `node /absolute/path/to/packages/cli/dist/main.js`
everywhere this documentation says `tapdance`, including in MCP configurations.

After `git pull`, run `pnpm install && pnpm build` again. The symlink keeps pointing at the new build.

To check the build, `pnpm test` runs the unit tests. `pnpm test:integration` drives a real device and
needs a running local worker; see the [evidence page](testing/evidence/2026-11-01-local-ios.md) for the
exact command.

## Platform prerequisites

Run `tapdance worker check` at any point. It checks Node.js, the Android SDK, KVM (on Linux) and Xcode
on this machine and prints a fix for each failure. It changes nothing.

### iOS (macOS only)

Simlock creates simulators only on runtimes that are already installed. Set up Xcode once:

```bash
# 1. Install Xcode from the App Store or developer.apple.com, then:
sudo xcode-select -s /Applications/Xcode.app
sudo xcodebuild -license accept
sudo xcodebuild -runFirstLaunch
# 2. Install an iOS simulator runtime if Xcode has none:
xcodebuild -downloadPlatform iOS
# 3. Check:
xcrun simctl list runtimes
tapdance worker check
```

You can also install a runtime through Simlock with `tapdance devices install ios <version>` (several
GB; Simlock downloads only when asked). Tested: Xcode 26.5 (17F42) with the iOS 18.5 runtime.

Simulators run `.app` bundles built for the simulator. A signed device `.ipa` does not install on a
simulator; Tapdance refuses it with `APP_PATH_INVALID`.

### Android (macOS, or Linux with KVM)

Run end to end on Android 34 emulators on a Mac ([evidence](testing/evidence/2026-11-01-android.md));
**not yet run on a Linux machine** (see [STATUS.md](../STATUS.md), D-01, D-02). The Linux requirements
below come from Simlock's documentation and Tapdance's own checks.

Simlock needs the **SDK command-line tools** (`sdkmanager` and `avdmanager`) to create emulators. Android
Studio alone does not always install them. Without them, `tapdance doctor` fails on "command-line tools
(sdkmanager, avdmanager)" and no Android device can be leased.

1. Install an Android SDK (Android Studio, or the
   [command-line tools download](https://developer.android.com/studio#command-line-tools-only)). Unpack
   the command-line tools to `$ANDROID_HOME/cmdline-tools/latest`, or in Android Studio open SDK Manager →
   SDK Tools → "Android SDK Command-line Tools (latest)".
2. Set `ANDROID_HOME`. Tapdance and Simlock look in `ANDROID_HOME`, then `ANDROID_SDK_ROOT`, then
   `~/Library/Android/sdk` (macOS only). On Linux there is no default, so `ANDROID_HOME` is required.
3. Install a JDK and set `JAVA_HOME` (Simlock's requirement, so `sdkmanager` can run).
4. Install the packages and a system image:

   ```bash
   sdkmanager --install emulator platform-tools
   sdkmanager --licenses
   sdkmanager "system-images;android-35;google_apis;arm64-v8a"   # use x86_64 on Intel/AMD machines
   ```

   Or let Simlock install an image: `tapdance devices install android 35`. Simlock refuses image
   installs until the SDK licences are accepted: run `sdkmanager --licenses` yourself, or set Simlock's
   `downloads.acceptAndroidLicenses` switch with
   `tapdance simlock -- --local config set downloads.acceptAndroidLicenses true` and then
   `tapdance worker restart`. (Everything after `--` goes to the bundled Simlock CLI unchanged.)
5. On Linux, the machine must expose hardware virtualization: a `vmx` or `svm` CPU flag and a
   `/dev/kvm` your user can write (`sudo usermod -aG kvm $USER`, then log in again). Tapdance never falls
   back to software emulation; `tapdance worker check` reports each KVM fact it measured.
6. If you installed a tool while the worker daemon was running, restart it: `tapdance worker restart`.
   Simlock looks for platform tools only when its daemon starts.

Simlock leases emulators **it creates** from the installed system images. It never hands out your own
AVDs or running emulators; `tapdance worker check` lists them only for information.

## Hosting devices for an agent on another machine

When the agent runs on one machine (a VPS, a laptop) and the devices on another, you do not need to
follow the steps above by hand on the host. One script installs the prerequisites, Tapdance itself,
and runs `tapdance host up`, which sets up the worker, the worker guard, a pairing token and Tailscale;
on the agent's machine, `tapdance connect` uses it.

- **A Mac or a Linux machine with KVM:** [one-command host](deployment/one-command-host.md). Run on the
  owner's Mac; Linux not yet run.
- **A cloud VM in your own Google Cloud project:** [Google Cloud N2](deployment/google-cloud-n2.md).
  Written, not yet run end to end.

The agent's machine needs only Node.js and Tapdance (this page) and must be in the same tailnet.

## Next

- [Quick start](quick-start.md): local mode, first lease to release.
- [Configuration](configuration.md): config files, tokens, environment variables.
- Agent setup: [Claude Code](agents/claude-code.md), [Codex](agents/codex.md), [Cursor](agents/cursor.md).
- [Troubleshooting](troubleshooting.md).
