# Quick start: local mode

## What you get

One full loop on a single computer. You start the part of Tapdance that runs the phones (the
**worker**), check the setup, borrow a phone (a **lease**), install and open an app, tap through it,
take screenshots and a video, watch it live, give the phone back, and hand the whole thing to your
agent. Everything runs on this computer (`provider: "local"`).

## What you need

- Tapdance installed ([installation](installation.md)).
- For iOS: a Mac with Xcode and an iOS runtime. For Android: the Android SDK with its command-line
  tools, and KVM on Linux. See [platform tools](installation.md#platform-tools-local-mode-only).

Proven: the iOS steps below on a MacBook Pro M1 Pro with Xcode 26.5 and an iPhone 16 / iOS 18.5
simulator ([evidence](testing/evidence/2026-11-01-local-ios.md)). Android uses the same commands and ran
on the same Mac with Android 34 emulators, a custom APK and a Google Play image
([evidence](testing/evidence/2026-11-01-android.md)).

## Steps

### 1. Create a project config (optional)

```bash
cd ~/code/my-app
tapdance init --mode local --yes
```

This writes `tapdance.config.json` in the current directory with `provider: "local"`, a 30-minute lease
TTL and `./tapdance-artifacts` as the artifact folder. Without a config file Tapdance already uses
local mode, so this step only matters for project settings. See [configuration.md](configuration.md).

If this Mac has no Android command-line tools and you only want iOS, turn Android off so `doctor` does
not fail on it:

```bash
tapdance config set platforms.android.enabled false
```

### 2. Start the local worker

```bash
tapdance worker install
```

This sets up and starts the [worker](glossary.md), the program that creates, boots and wipes devices on
this computer, and runs the same checks as `tapdance worker check`. Add `--service` to start the worker
at every login.

Later, manage it with `tapdance worker start`, `stop`, `restart`, `status` and `logs`.

### 3. Check the setup

```bash
tapdance doctor
```

`doctor` checks the configuration, your [session](glossary.md), this machine (Node.js, the Android SDK
and KVM, Xcode and runtimes), the worker, the device capacity per platform, and whether this session
already holds a lease. Each failed line prints a `fix:`. It exits with code 10 when any check fails.

### 4. See what you can lease

```bash
tapdance devices --platform ios
```

This lists the device models and OS versions the worker can create, the capacity, and the running
devices. Your own simulators and AVDs are never handed out; the worker creates clean devices of its own.

### 5. Lease a device

```bash
tapdance device lease --platform ios --device "iPhone 16" --os 18.5
```

The first lease on a machine creates and boots a simulator (about 40 s on the test Mac); a warm one
comes back in under a second. The output shows the device, platform, lease id and expiry, and the
keepalive:

- By default a background **keepalive** renews the lease until you release it, until it has been unused
  for 30 minutes (`session.idleReleaseMinutes`), or until 240 minutes pass
  (`session.maxSessionMinutes`).
- `--hold` keeps the command in the foreground instead and releases the device on Ctrl-C.
- `--no-keepalive` leases without renewing; the lease then ends after its TTL (`--ttl`, default 30 min).

One session holds at most one lease. A second `device lease` in the same session fails with
`LEASE_ALREADY_HELD` (exit code 3). Every later command acts on this session's device; no command takes a
device id. How the session is decided: [session identity](cli-reference.md#session-identity).

```bash
tapdance device status
```

### 6. Install and launch an app

Start with a built-in app:

```bash
tapdance app launch com.apple.Preferences
```

For your own iOS app, build a simulator `.app` (not an `.ipa`) into `./build` inside the project, then
install it. The MCP tool `install_app` accepts only paths inside the project directory the server runs
in, so building inside the project matters once an agent does this.

```bash
xcodebuild -scheme MyApp -sdk iphonesimulator -configuration Debug -derivedDataPath ./build build
tapdance app install ./build/Build/Products/Debug-iphonesimulator/MyApp.app
tapdance app launch com.example.myapp
```

Two useful variants:

```bash
tapdance app launch com.example.myapp --relaunch
tapdance app launch com.example.myapp --url myapp://settings
```

`--relaunch` kills the app and starts it again; `--url` opens a deep link.

The path is on the machine that runs `tapdance`; the app is uploaded to the worker. Proven locally with
`examples/ios-demo` (built with `swiftc`), and through a [guard](glossary.md) from another machine (a
47 MB `.app` zip from a Linux VPS to a rented Mac,
[evidence](testing/evidence/2026-11-07-vps-rented-mac-ios.md)). Not run: an install through a gateway.

On Android, install an `.apk`, for example `app/build/outputs/apk/debug/app-debug.apk`, and launch it by
package name. An `.aab` works too: Tapdance first turns it into a universal APK with
[bundletool](https://github.com/google/bundletool), which must be on your `PATH` (or set
`tools.paths.bundletool`). Proven on a Pixel 8 emulator
([evidence](testing/evidence/2026-11-01-device-state-and-profiles.md)).

### 7. Inspect and drive the UI

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
tapdance ui type "dana@example.com" --ref @e3
tapdance ui type " more"
tapdance ui key enter
tapdance ui swipe --direction up
tapdance ui swipe --direction up --until "Privacy"
tapdance ui swipe --from 200,700 --to 200,200
```

In `ui type`, the first argument is the text. With a target (`--ref`, `--text` or `--id`) it replaces
that field's content; without one it appends to the focused field. `ui key` also takes `back`, `home`,
`dismiss_keyboard` and `app_switcher`. In `ui swipe`, `--direction` is the finger's direction: `up`
scrolls the content down.

### 8. Wait for results and handle alerts

Check the expected outcome instead of guessing from screenshots:

```bash
tapdance ui wait --text "Welcome" --timeout 15000
tapdance ui wait --absent "Loading"
tapdance ui wait --stable
```

These wait for text to appear, for text to go away, and for the UI to stop changing. `ui wait` exits 0
when the condition is met and 1 when it times out (default 10 s, at most 10 minutes).

Read and answer a permission dialog ("Allow notifications?"):

```bash
tapdance ui alert get
tapdance ui alert accept
```

`tapdance ui alert dismiss` presses the declining button instead.

### 9. Collect evidence

```bash
tapdance screenshot --note "settings, general page"
tapdance record start
tapdance record stop
tapdance logs -n 100 --app com.example.myapp
tapdance logs --crash
tapdance artifacts
```

Drive the app between `record start` and `record stop`. Screenshots (PNG), recordings (MP4) and logs
land on this machine under `./tapdance-artifacts/<session>/`, with a `manifest.json` listing each one.
`screenshot -o <path>` and `record start -o <path>` write somewhere else instead. Logs are Android
logcat or the iOS simulator's unified log; `--crash` shows Android's crash buffer or iOS faults and
crash messages from the last 10 minutes.

### 10. Watch it live (optional)

In a second terminal, in the same session:

```bash
tapdance view
```

This starts the [viewer](glossary.md) on `127.0.0.1:4710` and prints a link with a one-time key. Open
it in a browser to see the device live and tap, swipe, type or press Home/Back yourself. While you
touch the screen, agent actions are refused with `HUMAN_HELD` (exit code 11) until 15 seconds after your
last touch (`viewer.humanHoldMs`); **Hand back** returns control at once. Press Ctrl-C to stop the
viewer.

The viewer listens on loopback only. To open it from another computer, forward the port over SSH
(`ssh -L 4710:127.0.0.1:4710 <machine>`) or use `tapdance view --tailscale`
([browser access](deployment/browser-access.md)).

Proven: the page in a browser on the Mac that runs `tapdance view`, with the device on that Mac and
with the device on a remote Google Cloud N2 host in device-only mode
([evidence](testing/evidence/2026-11-03-gcp-n2-android.md)). Not run: a browser on a different computer
from the one running `tapdance view` (checked with curl only,
[evidence](testing/evidence/2026-11-03-vps-n2-android.md)).

### 11. Release

```bash
tapdance device release
```

The device is wiped: installed apps and data are gone. The background keepalive stops.

### 12. Give it to an agent

Register the MCP server with your agent, for example Claude Code, then ask it to test your app:

```bash
claude mcp add tapdance -- tapdance mcp
```

Codex and Cursor are in [agent setup](agents.md); the tools and the recommended workflow are in
[mcp.md](mcp.md).

Proven: the MCP server with a scripted MCP client on a real iOS simulator and on Android emulators.
Not run: from inside Claude Code, Codex or Cursor themselves.

## Check it worked

- `tapdance doctor` passes (exit code 0).
- `tapdance device status` showed your device while it was leased.
- `tapdance artifacts` lists the screenshot, the recording and the logs.

## If it fails

Each error prints a code and a `fix:` line. Look the code up in
[troubleshooting](troubleshooting.md), and run `tapdance doctor` again after each fix.

## Next

- Your agent: [agent setup](agents.md) for Claude Code, Codex and Cursor.
- Devices on another machine (a Mac for iOS, a Linux server for Android) while the agent runs on your
  laptop or a VPS: [one-command host](deployment/one-command-host.md).
- Every command and option: [cli-reference.md](cli-reference.md).
