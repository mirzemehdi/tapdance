# iOS

How to prepare a Mac to serve iOS simulators to Tapdance, which app builds work, where logs come from,
and what is not supported yet. For cloud Macs and longer guides, see the [iOS docs](../ios/overview.md).

> **Status: the local iOS loop is tested.** On a MacBook Pro M1 Pro (macOS 26.5, Xcode 26.5) Tapdance
> leased an iPhone 16 simulator (iOS 18.5) and ran launch, inspect, tap, swipe, screenshots, MP4
> recording, logs and release through the CLI and the MCP server
> ([evidence](../testing/evidence/2026-11-01-local-ios.md)). A custom simulator `.app` was also
> installed and driven locally, and the same loop ran through a gateway with the worker on the same Mac
> ([evidence](../testing/evidence/2026-11-01-gateway-single-host.md)). Not yet tested: a Mac worker
> serving a Linux VPS over a real network (Q-08), installing a custom app through a gateway, AXe,
> physical iPhones. See
> [STATUS.md](../../STATUS.md).

## iOS needs a Mac

The iOS Simulator runs only on macOS with Xcode. Tapdance never tries to run it on Linux or Windows,
and no VPS or KVM host can provide it. If your agent runs on a Linux VPS, a Mac must be the worker:
your own Mac ([laptop worker](../deployment/laptop-worker.md)) or a cloud Mac.

Cloud Macs carry minimum rental periods because of Apple's macOS licence terms. As of November 2026,
[Scaleway](https://www.scaleway.com/en/docs/apple-silicon/faq/) states a 24-hour minimum before a Mac
mini can be deleted, and [AWS EC2 Mac](https://aws.amazon.com/ec2/instance-types/mac/faqs/) dedicated
hosts have a 24-hour minimum allocation. Check the provider pages for current terms, and see the
[iOS docs](../ios/overview.md) for each provider.

## Requirements

| Item | Detail |
| --- | --- |
| macOS | A version your Xcode supports. Watching a simulator's screen needs macOS 14 or later (Simlock). |
| Xcode | Selected: `sudo xcode-select -s /Applications/Xcode.app`; licence accepted: `sudo xcodebuild -license accept`; first launch done: `sudo xcodebuild -runFirstLaunch`. |
| An iOS runtime | `xcodebuild -downloadPlatform iOS`, or `tapdance devices install ios <version>` (Simlock needs about 8 GiB free; iOS 16.0 is the oldest it installs). |
| Node.js | 22.13 or later. |

```bash
tapdance worker check       # Xcode version, available simulator runtimes
tapdance worker install     # starts the bundled Simlock worker with agent-device, stream, input
```

## Simulators are Simlock's, not yours

[Simlock](https://github.com/callstackincubator/simlock) creates its own simulators in its own device
set (`~/.simlock/devices/ios`), boots them for a lease, wipes them on release and keeps a warm pool. It
never leases the simulators you use in Xcode.

```bash
tapdance devices --platform ios                                   # models and runtimes you can lease
tapdance device lease --platform ios --device "iPhone 16" --os 18.5
```

The first lease creates and boots a simulator (about 40 seconds on the test Mac); a warm lease took
about half a second.

[simslim](https://github.com/MobAI-App/simslim) (MIT) showed that disabling background services cuts a
simulator's memory about four times, and Simlock ships the same idea as a slim mode. Tapdance cannot
request it yet, because agent-device's lease call has no mode field; Simlock's warm-pool settings on the
worker are the way to use it for now.

## Apps: simulator `.app`, not `.ipa`

| Build | Installs on a simulator? |
| --- | --- |
| Simulator `.app` bundle (a directory) | **Yes.** |
| Device `.ipa` (signed for real iPhones) | **No.** Tapdance refuses it before uploading. |

Build for the simulator:

```bash
xcodebuild -scheme MyApp -sdk iphonesimulator -configuration Debug -derivedDataPath build build
tapdance app install build/Build/Products/Debug-iphonesimulator/MyApp.app
tapdance app launch com.example.MyApp
```

The app id is the bundle identifier. `.app` must be the bundle directory, not a file.

**From a Linux VPS:** `xcodebuild` needs macOS, and Tapdance cannot yet run build tools on a remote Mac
worker (E-04). Build the `.app` on a Mac or in CI, copy it to the VPS as an archive that keeps the
bundle intact (for example `ditto -c -k --keepParent MyApp.app MyApp.zip` on the Mac, then unzip on the
VPS), and install the unpacked `.app` directory from there. The upload goes through the gateway to the
Mac worker. Installing a custom `.app` has been run locally only, not through a gateway (F-01).

## Driving the UI

The default backend is [agent-device](https://github.com/callstack/agent-device) (MIT): accessibility
snapshots with refs, taps by label, id, ref or selector (coordinates as a fallback), swipes and
scrolls, typing, keys, system alerts (`tapdance ui alert get|accept|dismiss`), screenshots and MP4
recordings. It works locally and through a gateway.

[AXe](https://github.com/cameroncooke/AXe) (MIT, by Cameron Cooke) is an optional backend:

```bash
tapdance worker install --ios-backend axe
```

This sets `ios.uiBackend: "axe"` in your user config and Simlock's `drivers.ios.deviceSet` to
`default`, because AXe only sees Xcode's default device set. Limits: AXe works only when Tapdance runs
**on the same Mac** as the simulator (not through a gateway), and it takes text, id, ref or
coordinates, not agent-device selectors. It is written and unit-tested but **has not run on a real
Mac** (U-02, Q-09).

## Logs

| Command / MCP tool | Source on the Mac worker |
| --- | --- |
| `tapdance logs` / `get_logs` | `simctl spawn <simulator> log show --last 3m --style compact` (the simulator's unified log) |
| `tapdance logs --app <bundle id>` | The same, with a predicate on the app's subsystem and process name |
| `tapdance logs --crash` / `get_crash_logs` | Faults and crash or termination messages from the last 10 minutes, optionally for one app |

Full crash reports (`.ips` files) stay on the worker, in `~/Library/Logs/DiagnosticReports`; Tapdance
says so in the crash-log result but does not copy them. Logs are saved as artifacts on the agent's
machine.

## App Store Connect

The official [`asc`](https://github.com/rorkai/App-Store-Connect-CLI) CLI (MIT) is the source of truth
for App Store Connect. Tapdance forwards to it unchanged (`tapdance asc -- <args>`, MCP `execute_tool`)
and uses asc's own authentication. Agents get asc's read-only mode (`ASC_READ_ONLY=1`) unless
`tools.allowMutation` lists `asc`. `asc --version` and `asc apps list` were run for real through
Tapdance with asc 5.17.1.

## Limitations

- A Mac worker serving a remote agent has not been tested (Q-08).
- Physical iPhones: `device lease --physical` exists and Simlock can enroll USB iPhones (iOS 17+,
  Developer Mode, trusted, unlocked), and agent-device needs signing settings for its runner on the
  worker. Untested with Tapdance.
- No reset-on-request or uninstall command; release wipes the simulator.
- Build tools (`xcodebuild`, `asc`, AXe) run only on the machine where Tapdance runs, not on a remote
  Mac worker.
- iOS Simulator cannot run on Linux, Windows or any VPS.
