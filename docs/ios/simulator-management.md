# Simulator management

Tapdance does not create, boot or delete simulators itself. [Simlock](https://github.com/callstackincubator/simlock)
(MIT, by Callstack) does that on each Mac worker. This page explains what Simlock does with iOS
simulators, which settings matter, and how Tapdance exposes them. Facts about Simlock's behaviour come
from its documentation for `simlock@0.4.0`; Tapdance now pins `simlock@0.5.0`.

You change Simlock settings on the worker with the bundled CLI, then restart the worker:

```sh
tapdance simlock --local config set <key> <value>
tapdance worker restart
```

`tapdance worker restart` ends running agent-device sessions on that worker, so do it when no agent is
working.

## What Simlock does

| Concern | Behaviour |
| --- | --- |
| Ownership | Simlock creates its own simulators and touches only those. Your own simulators in Xcode are never leased, wiped or deleted. |
| Create and boot | A lease takes a ready simulator that fits, boots a shut-down one, or creates a new one (in that order), within the worker's capacity. |
| Wipe on release | When a lease ends (`tapdance device release`, `release_device`, or TTL expiry), the simulator is wiped. Installed apps and data are gone. By default it is then kept for the next lease. |
| Idle cleanup | An idle simulator is shut down after 10 minutes (`idle.shutdownAfterMs`) and deleted after 60 minutes (`idle.deleteAfterMs`). |
| Capacity | By default, iOS simulators are limited to half the CPU cores, with each counted at 1.5 GiB in a RAM budget of total RAM minus 4 GiB. |
| Crashes | Simlock reboots a crashed simulator under the same lease. |
| Downloads | Simlock never downloads a runtime during a Tapdance lease. Install runtimes first. |

Tapdance never takes a device id from the agent. Every command acts on the session's own lease, and
release only ever targets that lease.

## Runtimes

A simulator needs an iOS runtime on the worker. Install one with either:

```sh
xcodebuild -downloadPlatform iOS          # Xcode's own command: the runtime for this Xcode
tapdance devices install ios 18.5         # Simlock's component install, a specific version
```

`tapdance devices install <platform> <version>` runs `simlock --local component install` on the
machine where you type it. Per Simlock's docs:

- It needs about 8 GiB of free disk for an iOS runtime and refuses with `INSUFFICIENT_DISK_SPACE` if
  there is less.
- iOS 16.0 is the oldest runtime it can install. Install older ones from Xcode.
- One install runs per platform at a time; a second one waits.
- An install times out after 20 minutes by default (`downloads.timeoutMs`).
- Stopping the daemon ends an install. Run it again.
- It is safe to repeat: an installed runtime answers `already-installed`.

To install a runtime on every worker behind a gateway at once, run Simlock on the gateway machine:

```sh
tapdance simlock --gateway component install ios 18.5 --all-workers
```

See what an agent can lease:

```sh
tapdance devices --platform ios
```

This lists models and the runtimes they pair with. Lease a pair from that list, for example
`tapdance device lease --platform ios --device "iPhone 16" --os 18.5`. A model and a runtime can both be
listed and still not pair.

Removing a runtime is a Simlock admin task (`tapdance simlock --local component remove ios <version>
--dry-run` first). Simlock removes only runtimes it installed. macOS keeps its own copy of a runtime
download, which you remove in Xcode's Settings under Platforms.

## The warm pool

A first lease on a fresh worker has to create and boot a simulator. On the test Mac that took about
40 seconds; a lease on an already-booted simulator took about half a second
([evidence](../testing/evidence/2026-11-01-local-ios.md)).

Simlock's warm pool keeps idle simulators booted, wiped and unleased so leases are fast. It is on by
default and learns from recent leases: it keeps as many of each kind (model, OS, mode) booted as were
leased at once at the busiest moment of the last 24 hours. You can also name kinds to keep ready in the
worker's `~/.simlock/config.json`:

```json
{
  "warmPool": {
    "targets": [
      { "platform": "ios", "model": "iPhone 16", "osVersion": "18.5", "count": 1 }
    ]
  }
}
```

Restart the worker after editing. The warm pool never downloads a runtime, never shuts down a leased
simulator, and uses only free running slots. A booted simulator holds RAM, so on a 16 GB Mac keep
targets small. On a rented Mac that you pay for by the hour, a warm simulator costs nothing extra; on
your laptop it costs memory and battery.

`tapdance worker status` shows the warm pool's state.

## Slim simulators

[simslim](https://github.com/MobAI-App/simslim) (MIT, © 2026 Interlap) showed that an iOS simulator can
use far less memory when you turn off background services that testing does not need: about 180
launchd services, and roughly 4.0 GB down to 0.9 GB on an M1 Pro in simslim's measurements. Simlock
ships the same idea as **slim mode** and credits simslim on its prior-art page; it uses simslim's list
of services.

What to know:

- A slim simulator has widgets, Siri, Spotlight, iCloud, the App Store, mail and calendar, Safari,
  Photos, bundled apps and similar services turned off. Do not use slim mode if your app's tests rely
  on any of them.
- Slim needs an iOS 18.5 or newer runtime. On older runtimes a slim request gets a full simulator.
- A slim simulator boots twice (full, then slim), so creating one takes longer.
- **Tapdance cannot ask for slim mode per lease yet.** Tapdance leases through agent-device's
  allocation, which has no `mode` field (tracked as an upstream request). A lease that names no mode
  gets the worker's default, so you can make slim the default on a worker:

  ```sh
  tapdance simlock --local config set ios.defaultMode slim
  tapdance worker restart
  ```

  This has **not** been tested with Tapdance. To let more slim simulators fit, lower
  `capacity.config.ramBudget.iosSlimBytesPerDevice`; see Simlock's capacity docs.

## Reusable or fresh simulators

By default a released simulator is wiped and reused. To give every lease a brand-new simulator that is
deleted when the lease ends:

```sh
tapdance simlock --local config set lease.identity.ios fresh
tapdance worker restart
```

Every lease then pays for a create and a boot unless the warm pool has one ready.

## Device sets

Simlock can keep its simulators in one of two places, set by `drivers.ios.deviceSet` on the worker:

| Value | Where simulators live | Who needs it |
| --- | --- | --- |
| `simlock` (default) | `~/.simlock/devices/ios`, a set Xcode does not show | Everyone using agent-device, local or remote |
| `default` | Xcode's own set, `~/Library/Developer/CoreSimulator/Devices` | The AXe backend, which reads only this set |

`tapdance worker install --ios-backend axe` sets `default`. Under `default`, Simlock still touches only
simulators it marked as its own, but they sit next to yours: never run `xcrun simctl shutdown all` or
`erase all` on that Mac, because that stops or erases leased simulators too.

**Switching with simulators left over turns iOS off.** If the worker already created simulators under
one setting, switching leaves iOS disabled and `tapdance simlock --local doctor` reports
`device-set-changed`. Simlock's documented fix:

1. Set the key back to the old value and restart the worker.
2. Delete Simlock's simulators and any orphans. This ends every lease on the worker and deletes the
   simulators it created (never yours):

   ```sh
   tapdance simlock --local nuke --delete-devices
   tapdance simlock --local doctor --purge-orphans
   ```

3. Switch again (for AXe: `tapdance worker install --ios-backend axe`).

`invalid-device-set` means the value is not exactly `simlock` or `default`, or `drivers.ios.deviceRoot`
is set together with `default`.

## .app vs .ipa

Simulators and real iPhones take different builds:

| Build | Runs on | How to make it | Tapdance |
| --- | --- | --- | --- |
| Simulator `.app` (a directory) | iOS simulators | `xcodebuild -sdk iphonesimulator -configuration Debug ...`; the bundle is in `Build/Products/Debug-iphonesimulator/` | `tapdance app install ./MyApp.app` or `install_app` |
| Signed device `.ipa` | Physical iPhones and iPads | Archive and export with a signing identity and provisioning profile | Refused for simulators with `APP_PATH_INVALID` and a build hint |

Notes:

- Pass the `.app` **directory**. A file named `.app` is refused.
- Build for the worker's architecture. Apple Silicon workers run arm64 simulators, so make sure the
  build includes arm64 (the default for simulator builds made on Apple Silicon).
- The path is on the machine where Tapdance runs (for example the VPS). agent-device uploads it to the
  worker through Simlock (2 GiB cap) and installs it.
- Tapdance's path check also lets `.zip` and `.tar` archives through for iOS, but installing an archive
  has not been tested. Unpack it and pass the `.app`.
- Installing a custom simulator `.app` has been run in local mode (`examples/ios-demo`), but not
  through a gateway ([STATUS.md](../../STATUS.md), F-01).
- Android `.apk` and `.aab` rules are separate; `.aab` is refused.

Where a CI service can produce the simulator `.app` for you is covered in
[xcode-cloud-integration.md](xcode-cloud-integration.md).

## Physical iPhones

Simlock can lease enrolled physical iPhones and iPads (iOS 17 or later, USB, trusted, Developer Mode on,
unlocked), and `tapdance device lease --physical` asks for one. A physical device is not isolated from
the rest of the Mac the way a simulator is, and Simlock uninstalls apps that were not on it at
enrolment when the lease ends. This path is **untested** in Tapdance (STATUS D-06). Enrol devices with
Simlock's own commands; see its "Enrolling physical devices" guide.
