# Android

How to prepare a machine to serve Android emulators to Tapdance, which system image to use, which app
files work, where logs come from, and what is not supported yet.

> **Proven:** Android 34 emulators on a Mac (CLI and MCP loops, a custom APK, a Google Play image, the
> browser viewer, Google's Android CLI, [evidence](../testing/evidence/2026-11-01-android.md)), and on a
> Google Cloud N2 VM (Linux with KVM) as a host in device-only mode, driven over Tailscale from a Mac and
> from a Linux VPS (CLI and MCP checklists, a 77 MB APK, installs from CI, the viewer,
> [evidence](../testing/evidence/2026-11-03-gcp-n2-android.md),
> [VPS](../testing/evidence/2026-11-03-vps-n2-android.md)). **Not run:** Android through a gateway
> across two machines; physical Android phones. Details in [STATUS.md](../../STATUS.md).

## Where Android emulators can run

| Host OS | Works? | Acceleration | System image ABI |
| --- | --- | --- | --- |
| macOS, Apple silicon | Yes (Simlock supports it) | Apple Hypervisor framework | `arm64-v8a` |
| macOS, Intel | Yes (Simlock supports it) | Apple Hypervisor framework | `x86_64` |
| Linux x86_64 | Yes, **with KVM** | KVM (`/dev/kvm`) | `x86_64` |
| Windows | **No** (Simlock runs on macOS and Linux only) | — | — |

The agent's machine needs none of this when a separate host serves the devices; see
[one-command host](../deployment/one-command-host.md). On a host, `scripts/host-setup.sh` installs
everything on this page for you.

## Requirements

[Simlock](https://github.com/callstackincubator/simlock), which creates and runs the emulators, needs:

| Item | Detail |
| --- | --- |
| Android SDK | Found in `ANDROID_HOME`, then `ANDROID_SDK_ROOT`, then `~/Library/Android/sdk` (macOS only). Linux has no default: set `ANDROID_HOME`. |
| Command-line tools | `sdkmanager` and `avdmanager`, unpacked to `$ANDROID_HOME/cmdline-tools/latest`. From Android Studio's SDK Manager (SDK Tools → "Android SDK Command-line Tools (latest)") or the [command-line tools download](https://developer.android.com/studio#command-line-tools-only). Android Studio alone does not always install them; without them `tapdance doctor` fails on "command-line tools (sdkmanager, avdmanager)" and no Android device can be leased. |
| Packages | `sdkmanager --install emulator platform-tools` |
| JDK | One that `sdkmanager` runs on, with `JAVA_HOME` set. |
| System image | At least one, matching the CPU (table above). Which tag: see [system images](#system-images). |
| Licences | `sdkmanager --licenses`. Simlock refuses image installs until they are accepted. |
| Linux only | KVM, see [below](#kvm-on-linux). |

The install commands, step by step, are in [installation](../installation.md#android-macos-or-linux-with-kvm).

Simlock can also accept the SDK licences itself (read them first). Everything after `--` goes to the
bundled Simlock CLI unchanged:

```bash
tapdance simlock -- --local config set downloads.acceptAndroidLicenses true
tapdance worker restart
```

On a Linux machine with no display, emulators must run headless. `worker install` turns this on when
`DISPLAY` and `WAYLAND_DISPLAY` are unset; to set it by hand:

```bash
tapdance simlock -- --local config set android.emulator.headless true
tapdance worker restart
```

Check a machine with:

```bash
tapdance worker check
```

Add `--android-only` on a Linux machine. It reports the SDK path, `adb`, the `emulator` package, the
command-line tools, installed system images, your own AVDs, emulators on your default `adb`, and on
Linux the KVM checks. Each failure comes with a fix. After installing something, restart the worker
(`tapdance worker restart`): Simlock reads the platform tools once, at start.

## KVM on Linux

The Android Emulator on Linux needs KVM. Tapdance checks, and **never falls back to software
emulation**:

| Check | Pass | Fix when it fails |
| --- | --- | --- |
| CPU flags | `vmx` (Intel) or `svm` (AMD) in `/proc/cpuinfo` | Enable VT-x/AMD-V in firmware; on a cloud VM, enable nested virtualization (Google Cloud: an Intel N2 with `--enable-nested-virtualization`, not E2 or N2D). |
| `/dev/kvm` | Exists and is writable by the worker's user | `sudo usermod -aG kvm $USER`, then log out and in. If missing with the flags present: `sudo modprobe kvm_intel` (or `kvm_amd`). |
| `kvm-ok` | "KVM acceleration can be used" | From the `cpu-checker` package. |
| `emulator -accel-check` | Acceleration usable | Fix KVM first. |

Host guides:

- [Google Cloud N2](../deployment/google-cloud-n2.md). Proven end to end.
- [Dedicated Linux server](../deployment/dedicated-linux-server.md), with a section on OVHcloud Public
  Cloud. Not run.

## Emulators are Simlock's, not yours

Simlock creates its own emulators (under `~/.simlock/devices/android`) from the system images installed
on the machine, boots them for a lease, wipes them when the lease is released, and deletes them when
it cleans up. It **never leases the AVDs you made in Android Studio** or your running emulators
(`tapdance worker check` lists them only for information). It runs its own `adb` server on port 5038,
so `adb devices` in your shell does not show leased emulators and your own emulators are not
disturbed.

```bash
tapdance devices install android 35
tapdance devices --platform android
tapdance device lease --platform android --device "Pixel 8" --os 35
```

`devices install android 35` has Simlock install the `google_apis` image for this CPU. `devices` lists
the models, API levels and image tags you can lease. `--os` takes an API level.

Capacity: by default Simlock allows the smaller of CPU count ÷ 4 and RAM in GiB ÷ 8 emulators (at
least 1), and counts 4 GiB of RAM per emulator.

## System images

A lease uses `google_apis` unless you ask for another tag with `--image-tag` (MCP `image_tag`). Three
tiers, heaviest first:

| Tag | Has | Use it for |
| --- | --- | --- |
| `google_apis_playstore` | Play Store, Google Play services, full system UI | Play Billing purchases and restores, a Play sign-in. Nothing else. |
| `google_apis` (the default) | Google Play services (sign-in SDKs, Maps, push), full system UI, no Play Store | Normal app testing |
| `google_atd` / `aosp_atd` | Google's Automated Test Device images: Google Play services (`google_atd` only); no Play Store, no status bar or notification shade, no home screen, no keyboard app, software rendering; made to run without a window. About 600 MB instead of 1.5 GB; Google reports 33–55% faster test runs. | App logic and UI flows inside the app, when the host is short of memory or CPU |

**Use the Play Store image only when a test needs it.** Play images update Google Play services in the
background for minutes after a boot, which is likely (not proven) what keeps the guest busy longer on a
slow host. `scripts/host-setup.sh` installs `google_apis` (`--play-store` for the Play image). On a host
that has both, a lease without a tag asks for `google_apis` and says so.

To lease the Play image, install it first (Simlock's installer fetches only `google_apis`):

```bash
tapdance devices install android 34 --image-tag google_apis_playstore
tapdance device lease --platform android --image-tag google_apis_playstore
```

With `--image-tag`, `devices install` runs the SDK's `sdkmanager` instead of Simlock's installer (it may
ask you to accept a licence). An agent with a mixed test plan should lease `google_apis` for everything
else and switch to a Play lease only for the purchase steps: release, then lease again with the tag.
Simlock keeps one warm spare of each kind it has served, so a Play lease also leaves a Play spare booted;
on the host, `tapdance host warm android=0` turns spares off (it restarts the worker only when nothing
is leased).

**ATD images are the lightest:**

```bash
tapdance devices install android 34 --image-tag google_atd
tapdance device lease --platform android --image-tag google_atd
```

arm64 ATD images exist for API 30–37. **Leasing an ATD image is untested:** typing relies on
agent-device's own keyboard helper, and notification, Home and app-switcher steps cannot work without
the system UI.

## Apps: `.apk` or `.aab`

| File | Installs on an emulator? |
| --- | --- |
| `.apk` | **Yes.** For example `app/build/outputs/apk/debug/app-debug.apk` from `./gradlew assembleDebug`. |
| `.aab` (Android App Bundle) | **Yes, through bundletool.** Tapdance turns it into a universal APK on the agent's machine with [bundletool](https://developer.android.com/tools/bundletool), signed with the Android debug keystore, then uploads that. bundletool must be on `PATH`, or set `tools.paths.bundletool` (or `TAPDANCE_BUNDLETOOL`); without it the install is refused with `APP_PATH_INVALID` and a hint. Proven with bundletool 1.18.3 ([evidence](../testing/evidence/2026-11-01-device-state-and-profiles.md)). |

```bash
tapdance app install ./app/build/outputs/apk/debug/app-debug.apk
tapdance app launch com.example.app
tapdance app launch com.example.app --url "myapp://settings"
tapdance app stop com.example.app
```

The app id is the package name; `--url` opens a deep link. With a remote host, the APK is uploaded from
the agent's machine through the guard (or a gateway) to the host (agent-device caps uploads at 2 GiB).
Proven: custom APKs installed locally and through the guard from another machine (a 75 MB APK VPS →
Mac, a 77 MB APK Mac → N2). Not run: an install through a gateway.

## Driving the UI

UI automation comes from [agent-device](https://github.com/callstack/agent-device) (MIT), which Simlock
runs on the host: accessibility snapshots with refs, taps by text, id, ref or selector (coordinates as a
fallback), swipes and scrolls, typing, keys (`back`, `home`, `enter`, `dismiss_keyboard`,
`app_switcher`), screenshots (PNG) and recordings (MP4). These are the same CLI commands and MCP tools
as for iOS.

## Logs

| Command / MCP tool | Source on the host |
| --- | --- |
| `tapdance logs` / `get_logs` | `adb logcat -d -v threadtime -t <lines>` on the leased emulator |
| `tapdance logs --app <package>` | The same, filtered to the app's process id (found with `pidof`); unfiltered if the app is not running |
| `tapdance logs --crash` / `get_crash_logs` | `adb logcat -d -b crash` (the crash buffer) |

Logs are saved as artifacts on the agent's machine and the last lines are returned. Tapdance runs these
through Simlock's command endpoint as a fixed internal allowlist; there is no raw `adb` tool for agents.

## Other Android tools

| Tool | How Tapdance uses it | Status |
| --- | --- | --- |
| Google's [Android CLI](https://developer.android.com/cli) (`android`) | External tool: `tapdance android -- <args>` and the MCP `execute_tool`. During a lease, Tapdance appends `--device=<serial>` where the subcommand takes it, points adb at Simlock's port and strips inherited device selectors. | `layout --flat` ran on a leased emulator ([evidence](../testing/evidence/2026-11-01-android.md)). Not installed by Tapdance. agent-device stays the default backend. |
| [Maestro](https://github.com/mobile-dev-inc/maestro) (Apache-2.0) | External tool, scoped to the lease. | Registered; not run. |
| [fastlane](https://github.com/fastlane/fastlane) `supply` (MIT) | External tool for Google Play publishing. Agents need explicit permission (`tools.allowMutation`). | Registered; not run. |

`tapdance tools` shows which are installed and their versions. These run on the machine where
Tapdance runs, not on a remote host.

## Limitations

- Android through a gateway across two machines has not been run.
- A release wipes the emulator; within a lease use `uninstall_app` / `clear_app_data` for a fresh-install
  state. For a prepared state that survives (a signed-in Google account), use a device profile
  ([purchase testing](../guides/purchase-testing.md)); profiles are local only.
- Physical Android phones: `device lease --physical` exists and Simlock can enroll USB phones, but this
  path is untested with Tapdance.
- `tapdance doctor` on the agent's machine cannot report a **remote** host's KVM state; run
  `tapdance worker check` on the host.
- Windows cannot host emulators for Tapdance.
