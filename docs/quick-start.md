# Quick start: local mode

This walks through one full loop on a single machine: start a local worker, check the setup, lease a
device, launch an app, drive its UI, collect evidence, watch it live, and release it. Everything runs
on this computer (mode A, `provider: "local"`).

The iOS steps below are the path that has been run for real, on a MacBook Pro M1 Pro with Xcode 26.5
and an iPhone 16 / iOS 18.5 simulator ([evidence](testing/evidence/2026-11-01-local-ios.md)). Android
uses the same commands and has run on the same Mac with Android 34 emulators, a custom APK
(`examples/android-demo`) and a Google Play image ([evidence](testing/evidence/2026-11-01-android.md)).
Not yet run: Android on a Linux/KVM worker and Android through a remote gateway (D-02, M-02).

Before you start, [install Tapdance](installation.md) and the platform tools (Xcode for iOS; the Android
SDK with command-line tools for Android).

## 1. Create a project config (optional)

```bash
cd ~/code/my-app
tapdance init --mode local --yes
```

This writes `tapdance.config.json` in the current directory with `provider: "local"`, a 30-minute lease
TTL and `./tapdance-artifacts` as the artifact folder. Without any config file Tapdance already
defaults to local mode, so this step only matters when you want project-specific settings. See
[configuration.md](configuration.md).

If this Mac has no Android command-line tools and you only want iOS, turn Android off so `doctor` does
not fail on it:

```bash
tapdance config set platforms.android.enabled false
```

## 2. Start the local worker

```bash
tapdance worker install
```

This configures the Simlock worker bundled with Tapdance: it turns on Simlock's agent-device front
(pointing it at the bundled agent-device), live screen streaming and remote input, then restarts the
worker daemon. It also runs the same host checks as `tapdance worker check`. Add `--service` to install
the daemon as a login service (launchd on macOS, systemd `--user` on Linux) so it starts with your
session.

Later you can use `tapdance worker start`, `stop`, `restart`, `status` and `logs`.

## 3. Check the setup

```bash
tapdance doctor
```

`doctor` checks the configuration, the session identity, this machine (Node.js, Android SDK and KVM,
Xcode and runtimes), whether the Simlock worker answers, whether the token is accepted, whether
agent-device, streaming and input are available, device capacity per platform, the Simlock version, and
whether this session already holds a lease. Each failed line prints a `fix:`. The command exits with
code 10 when any check fails.

## 4. See what you can lease

```bash
tapdance devices --platform ios
```

This lists the device models and OS versions the worker can create, current capacity, and running
devices. Your own simulators and AVDs are never handed out; Simlock creates clean devices of its own.

## 5. Lease a device

```bash
tapdance device lease --platform ios --device "iPhone 16" --os 18.5
```

The first lease on a machine creates and boots a simulator (about 40 s on the test Mac); a warm one
comes back in under a second. The output shows the device, platform, which worker provides it, the
endpoint, the lease id and expiry, and the keepalive:

- By default a detached **keepalive** process renews the lease in the background until you release it,
  until it has been unused for 30 minutes (`session.idleReleaseMinutes`), or until 240 minutes pass
  (`session.maxSessionMinutes`).
- `--hold` keeps the command in the foreground instead and releases the device when you press Ctrl-C.
- `--no-keepalive` leases without renewing; the lease then ends after its TTL (`--ttl`, default 30 min).

One session holds at most one lease. A second `device lease` in the same session fails with
`LEASE_ALREADY_HELD` (exit code 3). Every later command acts on this session's device; no command takes a
device id. How a "session" is decided is explained in the [CLI reference](cli-reference.md#session-identity).

```bash
tapdance device status
```

## 6. Install and launch an app

The tested path launches a built-in app:

```bash
tapdance app launch com.apple.Preferences
```

For your own app, build a simulator `.app` (not an `.ipa`) and install it. The path is on the machine
running `tapdance`; the app is uploaded to the worker. This was run locally with examples/ios-demo; not
yet through a gateway. (That demo is built with `swiftc`; the `xcodebuild` line below is the usual
command for an Xcode project.)

Build into `./build` inside the project, so the `.app` lands inside it. The MCP tool `install_app`
accepts only paths inside the project directory the server runs in.

```bash
xcodebuild -scheme MyApp -sdk iphonesimulator -configuration Debug -derivedDataPath ./build build
tapdance app install ./build/Build/Products/Debug-iphonesimulator/MyApp.app
tapdance app launch com.example.myapp
tapdance app launch com.example.myapp --relaunch        # kill and start again
tapdance app launch com.example.myapp --url myapp://settings   # open a deep link
```

On Android, install an `.apk`, for example `app/build/outputs/apk/debug/app-debug.apk`, and
launch it by package name. An `.aab` is refused.

## 7. Inspect and drive the UI

```bash
tapdance ui inspect
```

This prints the interactive elements on screen, each with a ref such as `@e7`, a role, its label and
its accessibility identifier. Add `--all` to include non-interactive elements. Refs change when the
screen changes, so inspect again after navigating.

Tap one element, preferably by label or ref; coordinates are a fallback:

```bash
tapdance ui tap --text General
tapdance ui tap --ref @e7
tapdance ui tap --id login_button
tapdance ui tap --x 120 --y 640
```

A tap waits for the UI to settle and prints what changed (`--no-settle` skips the wait).

Type, press keys and swipe:

```bash
tapdance ui type "dana@example.com" --ref @e3   # replace the content of field @e3
tapdance ui type " more"                        # append to the focused field
tapdance ui key enter                           # also: back, home, dismiss_keyboard, app_switcher
tapdance ui swipe --direction up                # finger moves up: content scrolls down
tapdance ui swipe --direction up --until "Privacy"
tapdance ui swipe --from 200,700 --to 200,200
```

In `ui type`, the first argument is the text to type; `--text` (like `--ref` and `--id`) names the
field to type into.

## 8. Wait for results and handle alerts

Check the expected outcome instead of guessing from screenshots:

```bash
tapdance ui wait --text "Welcome" --timeout 15000   # appears
tapdance ui wait --absent "Loading"                 # goes away
tapdance ui wait --stable                           # UI stops changing
```

`ui wait` exits 0 when the condition is met and 1 when it times out (at most 30 000 ms).

A permission dialog ("Allow notifications?") is read and answered with:

```bash
tapdance ui alert get
tapdance ui alert accept     # or dismiss
```

## 9. Collect evidence

```bash
tapdance screenshot --note "settings, general page"
tapdance record start
#   ... drive the app ...
tapdance record stop
tapdance logs -n 100 --app com.example.myapp
tapdance logs --crash
tapdance artifacts
```

Screenshots (PNG), recordings (MP4) and logs land on this machine under
`./tapdance-artifacts/<session>/`, with a `manifest.json` listing each one. `screenshot -o <path>` and
`record start -o <path>` write somewhere else instead. Logs are Android logcat or the iOS simulator's
unified log; `--crash` shows Android's crash buffer or iOS faults and crash messages from the last 10
minutes.

## 10. Watch it live (optional)

In a second terminal, in the same session:

```bash
tapdance view
```

This starts a small web server on `127.0.0.1:4710` and prints a link with a one-time key. Open it in a
browser to see the device live and tap, swipe, type or press Home/Back yourself. While you touch the
screen, agent actions are refused with `HUMAN_HELD` (exit code 11) for 15 seconds after your last
touch (`viewer.humanHoldMs`); "Hand back" returns control at once. Press Ctrl-C to stop the viewer.

The viewer listens on loopback only. To reach it from another computer, forward the port over SSH
(`ssh -L 4710:127.0.0.1:4710 <host>`) or use a private network. Stream and input were verified with a
scripted client, and the page was used in a real browser on the same Mac (through a gateway on that
Mac). Using it from a second computer has not been tested yet (V-01, V-02).

## 11. Release

```bash
tapdance device release
```

The device is wiped: installed apps and data are gone. The background keepalive stops.

## 12. Give it to an agent

Register the MCP server with your agent, then ask it to test your app:

```bash
claude mcp add tapdance -- tapdance mcp
```

See [mcp.md](mcp.md) for the tools and the recommended workflow, and the setup pages for
[Claude Code](agents/claude-code.md), [Codex](agents/codex.md) and [Cursor](agents/cursor.md).

The MCP server has been verified with a scripted MCP client on a real iOS simulator; it has not yet
been run from inside Claude Code, Codex or Cursor. It has run on Android 34 emulators on a Mac
([evidence](testing/evidence/2026-11-01-android.md)), not yet on a Linux worker (see
[STATUS.md](../STATUS.md) P-01, D-02).

## Where next

- Remote devices (an agent on a VPS, devices on your laptop or a KVM server): the guides in
  [deployment/](deployment/). These setups are implemented but not yet tested across two machines.
- Every command and option: [cli-reference.md](cli-reference.md).
- Something failed: [troubleshooting.md](troubleshooting.md).
