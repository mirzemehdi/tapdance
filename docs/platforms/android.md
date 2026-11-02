# Android

How to prepare a machine to serve Android emulators to Tapdance, which app files work, where logs come
from, and what is not supported yet.

> **Status: run end to end on macOS.** Android 34 emulators leased through Tapdance on a Mac: CLI and
> MCP loops, a custom APK, a Google Play image, the browser viewer and Google's Android CLI
> ([evidence](../testing/evidence/2026-11-01-android.md)). Not yet run on a Linux/KVM worker or through
> a remote gateway. See [STATUS.md](../../STATUS.md) (P-01, D-01, D-02).

## Where Android emulators can run

| Worker OS | Works? | Acceleration | System image ABI |
| --- | --- | --- | --- |
| macOS, Apple silicon | Yes (Simlock supports it) | Apple Hypervisor framework | `arm64-v8a` |
| macOS, Intel | Yes (Simlock supports it) | Apple Hypervisor framework | `x86_64` |
| Linux x86_64 | Yes, **with KVM** | KVM (`/dev/kvm`) | `x86_64` |
| Windows | **No** (Simlock runs on macOS and Linux only) | — | — |

The machine that runs your coding agent does not need any of this when a separate worker serves the
devices; see [self-hosted overview](../deployment/self-hosted-overview.md).

## Requirements

[Simlock](https://github.com/callstackincubator/simlock), which creates and runs the emulators, needs:

| Item | Detail |
| --- | --- |
| Android SDK | Found in `ANDROID_HOME`, then `ANDROID_SDK_ROOT`, then `~/Library/Android/sdk` (macOS). Linux has no default: set `ANDROID_HOME`. |
| Command-line tools | `sdkmanager` and `avdmanager`, unpacked to `$ANDROID_HOME/cmdline-tools/latest`. From Android Studio's SDK Manager ("Android SDK Command-line Tools (latest)") or the [command-line tools download](https://developer.android.com/studio#command-line-tools-only). |
| Packages | `sdkmanager --install emulator platform-tools` |
| JDK | One that `sdkmanager` runs on, with `JAVA_HOME` set. |
| System image | At least one, matching the CPU (table above). |
| Licences | `sdkmanager --licenses`, or let Simlock accept them: `tapdance simlock config set downloads.acceptAndroidLicenses true` (read them first). |
| Linux only | KVM, see below. Headless emulators on machines without a display: `tapdance simlock config set android.emulator.headless true`. |

Check a machine with:

```bash
tapdance worker check            # add --android-only on a Linux box
```

It reports the SDK path, `adb`, the `emulator` package, the command-line tools, installed system
images, your own AVDs, emulators on your default `adb`, and on Linux the KVM checks. Each failure comes
with a fix. After installing something, restart the worker (`tapdance worker restart`): Simlock
reads the platform tools once, at start.

## KVM on Linux

The Android Emulator on Linux needs KVM. Tapdance checks, and **never falls back to software
emulation**:

| Check | Pass | Fix when it fails |
| --- | --- | --- |
| CPU flags | `vmx` (Intel) or `svm` (AMD) in `/proc/cpuinfo` | Enable VT-x/AMD-V in firmware; on a cloud VM, enable nested virtualization (Google Cloud: an Intel N2 with `--enable-nested-virtualization`, not E2 or N2D). |
| `/dev/kvm` | Exists and is writable by the worker's user | `sudo usermod -aG kvm $USER`, then log out and in. If missing with the flags present: `sudo modprobe kvm_intel` (or `kvm_amd`). |
| `kvm-ok` | "KVM acceleration can be used" | From the `cpu-checker` package. |
| `emulator -accel-check` | Acceleration usable | Fix KVM first. |

Host guides: [Google Cloud N2](../deployment/google-cloud-n2.md),
[OVHcloud Public Cloud](../deployment/ovh-public-cloud.md),
[dedicated Linux server](../deployment/dedicated-linux-server.md).

## Emulators are Simlock's, not yours

Simlock creates its own emulators (under `~/.simlock/devices/android`) from the system images installed
on the machine, boots them for a lease, wipes them when the lease is released, and deletes them when
it cleans up. It **never leases the AVDs you made in Android Studio**, and it runs its own `adb` server
on port 5038, so `adb devices` in your shell does not show leased emulators and your own emulators are
not disturbed.

```bash
tapdance devices install android 35      # Simlock installs the google_apis image for this CPU
tapdance devices --platform android      # models, API levels, image tags you can lease
tapdance device lease --platform android --device "Pixel 8" --os 35
tapdance device lease --platform android --image-tag google_apis_playstore   # needs that image installed
```

`--os` takes an API level. An image with another tag (for example `google_apis_playstore`) must be
installed with `sdkmanager` first; Simlock's installer fetches only `google_apis`.

**Use the Play Store image only when a test needs it.** Without `--image-tag`, Simlock picks
`google_apis`: Google Play services (sign-in SDKs, Maps, push) without the Play Store app, and lighter
on the host. `google_apis_playstore` is for tests that need the Play Store itself: Play Billing
purchases and restores, or a Play sign-in. An agent that runs a mixed test plan should lease
`google_apis` for everything else and switch to a Play lease only for the purchase steps (release,
then lease again with the tag). Simlock keeps one warm spare of each kind it has served, so a Play lease
also leaves a Play spare booted until it idles out; `tapdance host up --warm android=0` turns spares
off.

Capacity: by default Simlock allows the smaller of CPU count ÷ 4 and RAM in GiB ÷ 8 emulators (at
least 1), and counts 4 GiB of RAM per emulator.

## Apps: `.apk`, not `.aab`

| File | Installs on an emulator? |
| --- | --- |
| `.apk` | **Yes.** For example `app/build/outputs/apk/debug/app-debug.apk` from `./gradlew assembleDebug`. |
| `.aab` (Android App Bundle) | **No.** Tapdance refuses it before uploading. Build an APK, or turn the bundle into a universal APK with [bundletool](https://developer.android.com/tools/bundletool) (`build-apks --mode=universal`). |

```bash
tapdance app install ./app/build/outputs/apk/debug/app-debug.apk
tapdance app launch com.example.app
tapdance app launch com.example.app --url "myapp://settings"   # deep link
tapdance app stop com.example.app
```

The app id is the package name. In a self-hosted setup the APK is uploaded from the agent's machine
through the gateway to the worker (agent-device caps uploads at 2 GiB). Installing an Android APK has
not been exercised yet (F-01).

## Driving the UI

UI automation comes from [agent-device](https://github.com/callstack/agent-device) (MIT), which Simlock
runs on the worker: accessibility snapshots with refs, taps by text, id, ref or selector (coordinates
as a fallback), swipes and scrolls, typing, keys (`back`, `home`, `enter`, `dismiss_keyboard`,
`app_switcher`), screenshots (PNG) and recordings (MP4). These are the same CLI commands and MCP tools
as for iOS.

## Logs

| Command / MCP tool | Source on the worker |
| --- | --- |
| `tapdance logs` / `get_logs` | `adb logcat -d -v threadtime -t <lines>` on the leased emulator |
| `tapdance logs --app <package>` | The same, filtered to the app's process id (found with `pidof`); unfiltered if the app is not running |
| `tapdance logs --crash` / `get_crash_logs` | `adb logcat -d -b crash` (the crash buffer) |

Logs are saved as artifacts on the agent's machine and the last lines are returned. Tapdance runs these
through Simlock's command endpoint as a fixed internal allowlist; there is no raw `adb` tool for agents.

## Other Android tools

| Tool | How Tapdance uses it | Status |
| --- | --- | --- |
| Google's [Android CLI](https://developer.android.com/cli) (`android`) | External tool: `tapdance android -- <args>` and the MCP `execute_tool`. During a lease, Tapdance appends `--device=<serial>` where the subcommand takes it, points adb at Simlock's port and strips inherited device selectors. | `layout --flat` ran on a leased emulator ([evidence](../testing/evidence/2026-11-01-android.md)). Not installed by Tapdance (E-07). agent-device stays the default backend. |
| [Maestro](https://github.com/mobile-dev-inc/maestro) (Apache-2.0) | External tool, scoped to the lease. | Registered; not run. |
| [fastlane](https://github.com/fastlane/fastlane) `supply` (MIT) | External tool for Google Play publishing. Agents need explicit permission (`tools.allowMutation`). | Registered; not run. |

`tapdance tools` shows which are installed and their versions. These run on the machine where
Tapdance runs, not on a remote worker (E-04).

## Limitations

- Linux/KVM workers and remote Android not yet run (see the status note at the top).
- A release wipes the emulator; within a lease use `uninstall_app` / `clear_app_data` for a fresh-install
  state. For a prepared state that survives (a signed-in Google account), use a device profile
  ([purchase testing](../guides/purchase-testing.md)).
- Physical Android phones: `device lease --physical` exists and Simlock can enroll USB phones, but this
  path is untested with Tapdance.
- `tapdance doctor` on the agent's machine cannot report a **remote** worker's KVM state; run
  `tapdance worker check` on the worker.
- Windows cannot host emulators for Tapdance.
