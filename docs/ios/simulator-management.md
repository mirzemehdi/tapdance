# Simulator management

Tapdance does not create, boot or delete simulators itself. [Simlock](https://github.com/callstackincubator/simlock)
(MIT, by Callstack) does that: the **worker** on each Mac host. This page explains what Simlock does
with iOS simulators, which settings matter, and how Tapdance exposes them. Facts about Simlock's
behaviour come from its documentation for `simlock@0.4.0`; Tapdance now pins `simlock@0.5.0`.

You change Simlock settings on the host with the bundled Simlock CLI, then restart the worker:

```bash
tapdance simlock -- --local config set <key> <value>
tapdance worker restart
```

`tapdance worker restart` ends running agent-device sessions on that host, so do it when no agent is
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

A simulator needs an iOS runtime on the host. Xcode's own command installs the runtime for this Xcode:

```bash
xcodebuild -downloadPlatform iOS
```

Simlock's component install picks a specific version:

```bash
tapdance devices install ios 18.5
```

`tapdance devices install <platform> <version>` runs Simlock's `component install` on the machine
where you type it. Per Simlock's docs:

- It needs about 8 GiB of free disk for an iOS runtime and refuses with `INSUFFICIENT_DISK_SPACE` if
  there is less.
- iOS 16.0 is the oldest runtime it can install. Install older ones from Xcode.
- One install runs per platform at a time; a second one waits.
- An install times out after 20 minutes by default (`downloads.timeoutMs`).
- Stopping the daemon ends an install. Run it again.
- It is safe to repeat: an installed runtime answers `already-installed`.

In [gateway mode](../deployment/gateway-mode.md), you can install a runtime on every worker at once
from the gateway machine:

```bash
tapdance simlock -- --gateway component install ios 18.5 --all-workers
```

See what an agent can lease:

```bash
tapdance devices --platform ios
```

This lists models and the runtimes they pair with. Lease a pair from that list, for example
`tapdance device lease --platform ios --device "iPhone 16" --os 18.5`. A model and a runtime can both be
listed and still not pair.

Removing a runtime is a Simlock admin task (`tapdance simlock -- --local component remove ios <version>
--dry-run` first). Simlock removes only runtimes it installed. macOS keeps its own copy of a runtime
download, which you remove in Xcode's Settings under Platforms.

## Warm spares

A first lease on a fresh host has to create and boot a simulator. On the test Mac that took about
40 seconds; a lease on an already-booted simulator took about half a second
([evidence](../testing/evidence/2026-11-01-local-ios.md)).

Simlock's warm pool keeps idle simulators booted, wiped and unleased (**warm spares**) so leases are
fast. It is on by default and learns from recent leases: it keeps as many of each kind (model, OS,
mode) booted as were leased at once at the busiest moment of the last 24 hours.

A warm spare holds memory. On a small Mac, turn the spares off on the host:

```bash
tapdance host warm ios=0
```

`tapdance host warm` with no counts shows the setting and the spares; `tapdance host warm default`
gives Simlock its learned default back. On an 8 GB rented Mac mini, a leased simulator plus a warm
spare did not fit: swap grew, `simctl` calls slowed past 30 s and leases failed. With no spare,
everything passed, but every lease was a cold boot (about 77-143 s)
([evidence](../testing/evidence/2026-11-06-rented-mac-ios.md)). On a 16 GB Mac, keep the default. On a
laptop, a spare also costs battery.

You can also name kinds to keep ready in the host's `~/.simlock/config.json`:

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
simulator, and uses only free running slots. Keep targets small: each booted simulator holds RAM.

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
  gets the worker's default, so you can make slim the default on a host:

  ```bash
  tapdance simlock -- --local config set ios.defaultMode slim
  tapdance worker restart
  ```

  This has **not** been tested with Tapdance. On an 8 GB rented Mac mini, slim did not help: the slim
  boot timed out. To let more slim simulators fit, lower
  `capacity.config.ramBudget.iosSlimBytesPerDevice`; see Simlock's capacity docs.

## Reusable or fresh simulators

By default a released simulator is wiped and reused. To give every lease a brand-new simulator that is
deleted when the lease ends:

```bash
tapdance simlock -- --local config set lease.identity.ios fresh
tapdance worker restart
```

Every lease then pays for a create and a boot unless the warm pool has one ready.

## Device sets

Simlock can keep its simulators in one of two places, set by `drivers.ios.deviceSet` on the host:

| Value | Where simulators live | Who needs it |
| --- | --- | --- |
| `simlock` (default) | `~/.simlock/devices/ios`, a set Xcode does not show | Everyone using agent-device, local or remote |
| `default` | Xcode's own set, `~/Library/Developer/CoreSimulator/Devices` | The AXe backend, which reads only this set |

`tapdance worker install --ios-backend axe` sets `default`. Under `default`, Simlock still touches only
simulators it marked as its own, but they sit next to yours: never run `xcrun simctl shutdown all` or
`erase all` on that Mac, because that stops or erases leased simulators too.

**Switching with simulators left over turns iOS off.** If the worker already created simulators under
one setting, switching leaves iOS disabled and `tapdance simlock -- --local doctor` reports
`device-set-changed`. Simlock's documented fix:

1. Set the key back to the old value and restart the worker.
2. Delete Simlock's simulators and any orphans. This ends every lease on the host and deletes the
   simulators it created (never yours):

   ```bash
   tapdance simlock -- --local nuke --delete-devices
   tapdance simlock -- --local doctor --purge-orphans
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

- Pass the `.app` **directory**, or a `.zip` that holds one. A file named `.app` is refused.
- Build for the host's architecture. Apple Silicon Macs run arm64 simulators, so make sure the build
  includes arm64 (the default for simulator builds made on Apple Silicon).
- The path is on the agent's machine (for example a Linux VPS). Tapdance uploads it to the host and
  installs it there (the guard caps uploads at 512 MB by default, `limits.maxUploadMB`).
- Proven: a custom `.app` in local mode (`examples/ios-demo`), and a 47 MB zipped `.app` uploaded from a
  Linux VPS through the guard to a rented Mac in 31-58 s
  ([evidence](../testing/evidence/2026-11-07-vps-rented-mac-ios.md)). Not run: a `.tar`, and an install
  through a gateway.
- No `.app` on the agent's machine? The host can build it from git ([host builds](../guides/host-builds.md)),
  or download the one your CI built ([CI builds](../guides/ci-builds.md)).
- Android has its own rules: an `.apk` installs as is, and an `.aab` is turned into a universal APK with
  bundletool on the agent's machine first.

## Physical iPhones

Simlock can lease enrolled physical iPhones and iPads (iOS 17 or later, USB, trusted, Developer Mode on,
unlocked), and `tapdance device lease --physical` asks for one. A physical device is not isolated from
the rest of the Mac the way a simulator is, and Simlock uninstalls apps that were not on it at
enrolment when the lease ends. This path is **not run** with Tapdance. The guard refuses physical
devices unless the host's policy sets `allow.physicalDevices: true`. Enrol devices with Simlock's own
commands; see its "Enrolling physical devices" guide.
