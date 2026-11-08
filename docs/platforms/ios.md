# iOS

How to prepare a Mac to serve iOS simulators to Tapdance, which app builds work, where logs and crash
reports come from, and what is not supported yet. For cloud Macs and longer guides, see the
[iOS docs](../ios/overview.md).

> **Proven:** the local iOS loop on a MacBook Pro M1 Pro (macOS 26.5, Xcode 26.5, an iPhone 16
> simulator with iOS 18.5): launch, inspect, tap, swipe, screenshots, MP4 recording, logs and release
> through the CLI and the MCP server, and a custom simulator `.app`
> ([evidence](../testing/evidence/2026-11-01-local-ios.md)). The same loop through a gateway on that Mac
> ([evidence](../testing/evidence/2026-11-01-gateway-single-host.md)). A rented Mac mini as a host in
> device-only mode, driven from a Mac and from a Linux VPS
> ([Mac](../testing/evidence/2026-11-06-rented-mac-ios.md),
> [VPS](../testing/evidence/2026-11-07-vps-rented-mac-ios.md)). The AXe backend on one Mac
> ([evidence](../testing/evidence/2026-11-01-axe.md)). **Not run:** a Mac worker joined to a gateway
> on another machine, a custom app installed through a gateway, physical iPhones. Details in
> [STATUS.md](../../STATUS.md).

## iOS needs a Mac

The iOS Simulator runs only on macOS with Xcode. Tapdance never tries to run it on Linux or Windows,
and no VPS or KVM host can provide it. If your agent runs on a Linux VPS, a Mac must be the host: your
own Mac or a rented one, set up with [one-command host](../deployment/one-command-host.md). For a
rented Mac, follow [Scaleway Mac mini](../ios/scaleway-mac.md) (proven end to end).

Cloud Macs carry minimum rental periods because of Apple's macOS licence terms. As of November 2026,
[Scaleway](https://www.scaleway.com/en/docs/apple-silicon/faq/) states a 24-hour minimum before a Mac
mini can be deleted, and [AWS EC2 Mac](https://aws.amazon.com/ec2/instance-types/mac/faqs/) dedicated
hosts have a 24-hour minimum allocation. Check the provider pages for current terms, and see the
[iOS docs](../ios/overview.md) for each provider.

## Requirements

| Item | Detail |
| --- | --- |
| macOS | A version your Xcode supports. Watching a simulator's screen needs macOS 14 or later (Simlock). |
| Xcode | Selected: `sudo xcode-select -s /Applications/Xcode.app`; licence accepted: `sudo xcodebuild -license accept`; first launch done: `sudo xcodebuild -runFirstLaunch`. Tested: Xcode 26.5 (17F42) with the iOS 18.5 runtime. |
| An iOS runtime | `xcodebuild -downloadPlatform iOS`, or `tapdance devices install ios <version>` (several GB; Simlock needs about 8 GiB free, downloads only when asked, and installs iOS 16.0 at the oldest). |
| Node.js | 22.13 or later. |

The commands, step by step, are in [installation](../installation.md#ios-macos-only). Then:

```bash
tapdance worker check
tapdance worker install
```

`worker check` shows the Xcode version and the simulator runtimes. `worker install` starts the
bundled worker.

## Simulators are Simlock's, not yours

[Simlock](https://github.com/callstackincubator/simlock) creates its own simulators in its own device
set (`~/.simlock/devices/ios`), boots them for a lease, wipes them on release and keeps a warm pool. It
never leases the simulators you use in Xcode.

```bash
tapdance devices --platform ios
tapdance device lease --platform ios --device "iPhone 16" --os 18.5
```

`devices` lists the models and runtimes you can lease. The first lease creates and boots a simulator
(about 40 seconds on the test Mac); a warm lease took about half a second.

[simslim](https://github.com/MobAI-App/simslim) (MIT) showed that disabling background services cuts a
simulator's memory about four times, and Simlock ships the same idea as a slim mode. Tapdance cannot
request it yet, because agent-device's lease call has no mode field; Simlock's warm-pool settings on the
host are the way to use it for now.

## Apps: simulator `.app`, not `.ipa`

| Build | Installs on a simulator? |
| --- | --- |
| Simulator `.app` bundle (a directory) | **Yes.** |
| Device `.ipa` (signed for real iPhones) | **No.** Tapdance refuses it with `APP_PATH_INVALID` before uploading. |

Build for the simulator:

```bash
xcodebuild -scheme MyApp -sdk iphonesimulator -configuration Debug -derivedDataPath build build
tapdance app install build/Build/Products/Debug-iphonesimulator/MyApp.app
tapdance app launch com.example.MyApp
```

The app id is the bundle identifier. `.app` must be the bundle directory, not a file.

**From a Linux VPS:** `xcodebuild` needs macOS, and the agent cannot run build tools of its own on a
remote Mac. Three ways instead:

- **Build on the Mac host:** the host's owner allow-lists the repository (`tapdance host builds enable
  --repo …`), and the agent runs `tapdance app build --git <url>` (MCP `build_app`); the Mac clones,
  runs `xcodebuild` for the simulator and installs the result on the lease. Proven on a rented Mac mini
  from a Mac and from a Linux VPS ([evidence](../testing/evidence/2026-11-07-vps-rented-mac-ios.md)).
  See [host builds](../guides/host-builds.md).
- **Upload a `.app`:** build it on a Mac or in CI, copy it to the VPS as an archive that keeps the bundle
  intact (for example `ditto -c -k --keepParent MyApp.app MyApp.zip` on the Mac), and `tapdance app
  install MyApp.zip`. Proven: a 47 MB `.app` zip from a Linux VPS through the guard to a rented Mac.
  Not run: a custom `.app` through a gateway.
- **Install from CI:** the host downloads a simulator `.app` your GitHub Actions run built
  (`tapdance app install --from-ci`). Unit-tested only for iOS. See [CI builds](../guides/ci-builds.md).

## Driving the UI

The default backend is [agent-device](https://github.com/callstack/agent-device) (MIT): accessibility
snapshots with refs, taps by label, id, ref or selector (coordinates as a fallback), swipes and
scrolls, typing, keys, system alerts (`tapdance ui alert get|accept|dismiss`), screenshots and MP4
recordings. It works locally and with a remote host.

[AXe](https://github.com/cameroncooke/AXe) (MIT, by Cameron Cooke) is an optional backend:

```bash
tapdance worker install --ios-backend axe
```

This sets `ios.uiBackend: "axe"` in your user config and Simlock's `drivers.ios.deviceSet` to
`default`, because AXe only sees Xcode's default device set. Limits: AXe works only when Tapdance runs
**on the same Mac** as the simulator (not with a remote host), and it takes text, id, ref or
coordinates, not agent-device selectors. Proven on a real Mac with a custom app's sign-in flow
([evidence](../testing/evidence/2026-11-01-axe.md)).

## Logs and crash reports

| Command / MCP tool | Source on the Mac host |
| --- | --- |
| `tapdance logs` / `get_logs` | `simctl spawn <simulator> log show --last 3m --style compact` (the simulator's unified log) |
| `tapdance logs --app <bundle id>` | The same, with a predicate on the app's subsystem and process name |
| `tapdance logs --crash` / `get_crash_logs` | Faults and crash or termination messages from the last 10 minutes, optionally for one app |
| `tapdance device crashes` / `crash_reports` | The full crash reports (`.ips` files) the leased simulator wrote since the lease began, from `~/Library/Logs/DiagnosticReports` on the host |

`tapdance device crashes` lists the reports, newest first, with app, exception and time. To read one:

```bash
tapdance device crashes --pull latest
```

`--pull` (MCP `crash_reports` with `pull`) saves the report as an artifact and prints the exception and
the crashed thread's top frames with their symbols. Only reports that name the leased simulator are
shown, never the host's own apps' crashes or another lease's; with a remote host they come through the
guard (`allow.logs`). Proven on a rented Mac (crash reports in the CLI and MCP checklists,
[evidence](../testing/evidence/2026-11-07-vps-rented-mac-ios.md)).

Logs and pulled reports are saved as artifacts on the agent's machine.

## App Store Connect

The official [`asc`](https://github.com/rorkai/App-Store-Connect-CLI) CLI (MIT) is the source of truth
for App Store Connect. Tapdance forwards to it unchanged (`tapdance asc -- <args>`, MCP `execute_tool`)
and uses asc's own authentication. Agents get asc's read-only mode (`ASC_READ_ONLY=1`) unless
`tools.allowMutation` lists `asc`. `asc --version` and `asc apps list` were run for real through
Tapdance with asc 5.17.1.

## Limitations

- A Mac host serving a remote agent is proven in device-only mode only (a Mac and a Linux VPS driving a
  rented Mac mini); a Mac worker joined to a gateway on another machine has not been run.
- Physical iPhones: `device lease --physical` exists and Simlock can enroll USB iPhones (iOS 17+,
  Developer Mode, trusted, unlocked), and agent-device needs signing settings for its runner on the
  host. Untested with Tapdance.
- No reset-on-request command; release wipes the simulator. Apps can be removed and reset with
  `tapdance app uninstall` / `app clear` (MCP `uninstall_app` / `clear_app_data`).
- External tools (`asc`, AXe, your own `xcodebuild`) run only on the machine where Tapdance runs, not on
  a remote Mac host. Host builds (`app build --git`, MCP `build_app`) are the exception: the Mac
  builds from a repository its owner allow-listed.
- iOS Simulator cannot run on Linux, Windows or any VPS.
