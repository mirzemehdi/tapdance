# Installation

This page installs the `tapdance` command (the CLI and the MCP server) and, where a machine runs
devices, the platform tools it needs. Terms such as **host** and **agent's machine** are explained in
the [glossary](glossary.md).

## Which setup are you?

Pick the row that describes the machine you are installing on. It tells you which parts of this page
you need.

| This machine is… | Install | Then |
| --- | --- | --- |
| **One computer for everything** (local mode): the agent and the emulators or simulators run here | [The CLI](#install-the-cli), then the [platform tools](#platform-tools-local-mode-only) for iOS, Android or both | [Quick start](quick-start.md) |
| **The agent's machine** for a remote host: your laptop or, for example, a Linux VPS | [The CLI](#install-the-cli) only. No Xcode, Android SDK or KVM. | `tapdance connect`, see [Connect to a remote host](#connect-to-a-remote-host) |
| **The host** for a remote agent: a Mac, or a Linux machine with KVM | Nothing by hand: one script installs the platform tools and Tapdance, then runs `tapdance host up` | [One-command host](deployment/one-command-host.md) |

For a host in the cloud, the guides also create the machine: [Google Cloud N2](deployment/google-cloud-n2.md)
(Android) and [Scaleway Mac mini](ios/scaleway-mac.md) (iOS).

## What you need

| Machine | OS | Needs |
| --- | --- | --- |
| Agent's machine | macOS, Linux, Windows | Node.js 22.13 or later |
| Host or local machine for iOS simulators | macOS only | Node.js 22.13+, Xcode with at least one iOS runtime |
| Host or local machine for Android emulators | macOS, or Linux with KVM | Node.js 22.13+, the Android SDK with command-line tools, `emulator`, `platform-tools`, a system image, a JDK |
| [Gateway](glossary.md) (advanced, run on one Mac only) | macOS or Linux | Node.js 22.13+ only. A gateway runs no devices, so it needs no KVM, Xcode or Android SDK. |

Windows cannot run devices: Simlock, which runs them, supports macOS and Linux only.
`tapdance worker install` refuses on Windows, and `tapdance doctor` says so. Windows as the agent's
machine has not been tested.

Proven: local iOS and Android on an Apple-silicon Mac ([iOS](testing/evidence/2026-11-01-local-ios.md),
[Android](testing/evidence/2026-11-01-android.md)); a Google Cloud N2 VM (Ubuntu 24.04, KVM) and a
rented Mac mini as hosts, with a Mac or a Linux VPS as the agent's machine
([N2](testing/evidence/2026-11-03-vps-n2-android.md),
[rented Mac](testing/evidence/2026-11-07-vps-rented-mac-ios.md)). See
[compatibility.md](compatibility.md) and [STATUS.md](../STATUS.md) for the details.

## Install the CLI

### From npm

```bash
npm install -g tapdance-cli
tapdance --version
```

The package is `tapdance-cli`; the command it installs is `tapdance`. Do not run `npm install -g
tapdance`: that name belongs to an unrelated package (a Test Anything Protocol harness). The npm package
carries the same patched Simlock and agent-device as a source build, so both run the same code.

Install from source, below, to work on Tapdance itself or to try a change before it is released.

### From source

You need Node.js 22.13+ and pnpm 10. The repository pins `pnpm@10.20.0`, and Corepack provides it.

1. Get the code:

   ```bash
   git clone https://github.com/mirzemehdi/tapdance.git
   cd tapdance
   ```

2. Turn on pnpm. The build's own scripts call `pnpm`, so it must be on your `PATH`. `corepack enable`
   puts it next to Node.js, which may need sudo. Without sudo, put it in your home folder instead
   (`~/.local/bin` must be on your `PATH`):

   ```bash
   corepack enable --install-directory ~/.local/bin pnpm
   ```

3. Install and build:

   ```bash
   pnpm install
   pnpm build
   node packages/cli/dist/main.js --version
   ```

   The last line prints `0.1.0`.

4. Put `tapdance` on your `PATH`. `packages/cli/dist/main.js` starts with `#!/usr/bin/env node` and is
   executable, so a symlink works:

   ```bash
   mkdir -p ~/.local/bin
   ln -s "$PWD/packages/cli/dist/main.js" ~/.local/bin/tapdance
   tapdance --version
   ```

   If `~/.local/bin` is not on your `PATH`, add it in your shell profile, for example
   `export PATH="$HOME/.local/bin:$PATH"`. Or skip the symlink and use
   `node /absolute/path/to/packages/cli/dist/main.js` wherever these docs say `tapdance`, including in
   MCP configurations.

### Update

From npm:

```bash
npm install -g tapdance-cli@latest
```

From source:

```bash
git pull
pnpm install
pnpm build
```

The symlink keeps pointing at the new build. On a machine that runs devices, then restart the worker so
it runs the new build's Simlock:

```bash
tapdance worker restart
```

On a host set up with `host up`, run `tapdance host up` again instead. Both reinstall the worker's login
service when it still names the old Simlock folder, and both keep the warm-spare settings.

## Connect to a remote host

On the agent's machine, after installing the CLI, add the host as a
[connect target](glossary.md). The host's owner gives you the pairing token file that `host up`
wrote (`pairing-<label>.token`), and both machines must be in the same tailnet:

```bash
tapdance connect https://<host>.<tailnet>.ts.net:4720 < pairing-my-vps.token
```

Run it once per host. The full walk-through is in
[one-command host](deployment/one-command-host.md); several hosts at once (for example one for
Android and a Mac for iOS) are in [Android and iOS from one agent](guides/android-and-ios.md).

## Platform tools (local mode only)

On a remote host, `scripts/host-setup.sh` installs all of this for you
([one-command host](deployment/one-command-host.md)). In local mode, install what you need by hand.

`tapdance worker check` checks Node.js, the Android SDK, KVM (on Linux) and Xcode on this machine and
prints a fix for each failure. It changes nothing, so run it at any point.

### iOS (macOS only)

Simulators are created only on runtimes that are already installed. Set up Xcode once:

1. Install Xcode from the App Store or developer.apple.com.
2. Select it, accept the licence and finish its first launch:

   ```bash
   sudo xcode-select -s /Applications/Xcode.app
   sudo xcodebuild -license accept
   sudo xcodebuild -runFirstLaunch
   ```

3. Install an iOS simulator runtime if Xcode has none:

   ```bash
   xcodebuild -downloadPlatform iOS
   ```

4. Check:

   ```bash
   xcrun simctl list runtimes
   tapdance worker check
   ```

Details (app builds, the AXe backend, logs): [iOS](platforms/ios.md).

### Android (macOS, or Linux with KVM)

1. Install the Android SDK **with its command-line tools** (`sdkmanager`, `avdmanager`). Android Studio
   alone does not always install them: in its SDK Manager, open SDK Tools and tick "Android SDK
   Command-line Tools (latest)". Or unpack the
   [command-line tools download](https://developer.android.com/studio#command-line-tools-only) to
   `$ANDROID_HOME/cmdline-tools/latest`.
2. Set `ANDROID_HOME`. It is required on Linux; on macOS `~/Library/Android/sdk` is found without it.
3. Install a JDK and set `JAVA_HOME`, so `sdkmanager` can run.
4. Install the packages and a system image (use `x86_64` instead of `arm64-v8a` on Intel and AMD
   machines):

   ```bash
   sdkmanager --install emulator platform-tools
   sdkmanager --licenses
   sdkmanager "system-images;android-35;google_apis;arm64-v8a"
   ```

5. On Linux only: the machine needs hardware virtualization and a `/dev/kvm` your user can write:

   ```bash
   sudo usermod -aG kvm $USER
   ```

   Then log out and in again. Tapdance never falls back to software emulation.
6. If the worker was already running, restart it so it finds the new tools:

   ```bash
   tapdance worker restart
   ```

Details (where the SDK is searched, which image tier to install, letting Simlock install images,
KVM checks): [Android](platforms/android.md).

## Check it worked

```bash
tapdance --version
tapdance doctor
```

`tapdance --version` prints `0.1.0`. `tapdance doctor` prints one line per check and a `fix:` for each
failure. In local mode, start the worker first (`tapdance worker install`, step 2 of the
[quick start](quick-start.md)).

## If it fails

See [Troubleshooting](troubleshooting.md#installation). The most common problems: `tapdance` is not on
the `PATH` your agent sees (use the absolute `node … main.js` form in the MCP config), and a Node.js
older than 22.13.

## What the package contains

Tapdance 0.1.0 is one Node.js package, `tapdance` (in `packages/cli`), with four workspace packages
behind it (`@tapdance/core`, `@tapdance/provider-simlock`, `@tapdance/sdk`, `@tapdance/mcp`). It ships
two upstream projects as pinned npm dependencies, so you do not install them yourself:

| Bundled | Version | What it does for Tapdance | License |
| --- | --- | --- | --- |
| [Simlock](https://github.com/callstackincubator/simlock) | 0.5.0 (exact, with Tapdance's patch) | Creates, leases, queues and cleans up emulators and simulators; runs the worker and gateway daemons. | MIT |
| [agent-device](https://github.com/callstack/agent-device) | 0.21.35 (exact, with Tapdance's patch) | UI snapshots, taps, typing, screenshots, MP4 recording, app upload and log download. | MIT |

`tapdance worker install` points Simlock at the bundled agent-device, and `tapdance simlock …` runs the
bundled Simlock CLI, so neither needs a global install. `pnpm install` applies Tapdance's own patches to
both (`patches/`, listed in [NOTICE.md](../NOTICE.md#patches-to-dependencies)); a Simlock installed
another way does not have them. The [architecture decision](architecture-decision.md) explains why
Tapdance builds on these two projects, and [compatibility.md](compatibility.md) lists the versions.

Nothing else is bundled. Xcode, the Android SDK, a JDK and the optional external tools (`asc`, AXe,
Google's Android CLI, Maestro, fastlane) are yours to install; see [tools.md](tools.md).

To check the build itself, `pnpm test` runs the unit tests. `pnpm test:integration` drives a real
device and needs a running local worker; see [CONTRIBUTING.md](../CONTRIBUTING.md).

## Next

- [Quick start](quick-start.md): local mode, from the first lease to release.
- [Agent setup](agents.md): Claude Code, Codex, Cursor.
- [Configuration](configuration.md): config files, tokens, environment variables.
- [Troubleshooting](troubleshooting.md).
