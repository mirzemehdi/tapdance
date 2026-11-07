# CLI reference

Every `tapdance` command in version 0.1.0, taken from the real `--help` output and the code in
`packages/cli/src`. Run `tapdance <command> --help` for the same text on your machine.

Commands that act on a device (`device`, `app`, `ui`, `screenshot`, `record`, `logs`, `artifacts`,
`view`) always act on **this session's** leased device. None of them takes a device or lease id.

## Global options

These go before the command (`tapdance --json device status`). Commander also accepts most of them
after the command, but put them first for pass-through commands (`asc`, `android`, `tool`, `simlock`).

| Option | Meaning |
| --- | --- |
| `-v, --version` | Print the version (`0.1.0`). |
| `--json` | Print machine-readable JSON on stdout. See [JSON output](#json-output). |
| `-c, --config <path>` | Use this config file instead of the nearest `tapdance.config.json`. |
| `--session <id>` | Act as this session. See [Session identity](#session-identity). |
| `-q, --quiet` | No progress messages on stderr. |
| `-h, --help` | Help for any command. |

## Command overview

| Area | Commands |
| --- | --- |
| Setup | [`init`](#init), [`doctor`](#doctor), [`config`](#config) |
| Discovery | [`devices`](#devices), [`workers`](#workers) |
| Lease | [`device lease / status / renew / release`](#device) |
| Apps | [`app install / launch / stop / list`](#app) |
| UI | [`ui inspect / tap / swipe / type / wait / alert / key`](#ui) |
| Evidence | [`screenshot`](#screenshot), [`record start / stop`](#record), [`logs`](#logs), [`artifacts`](#artifacts) |
| Device state | [`device setting / push / pull / notifications / perf / shell`](#device-state) |
| Scenarios | [`run`](#run) |
| Human access | [`view`](#view) |
| Workers and gateways | [`worker …`](#worker), [`gateway …`](#gateway), [`simlock`](#simlock) |
| Hosting for a remote agent | [`host up / status / down`](#host), [`connect`](#connect) |
| External tools | [`tools`](#tools), [`tool`](#tool-asc-android), [`asc`](#tool-asc-android), [`android`](#tool-asc-android) |
| Agents | [`mcp`](#mcp) |
| Feedback | [`report`](#report) |

## Setup

### `init`

```text
tapdance init [--mode <mode>] [--endpoint <url>] [--artifacts <dir>] [--ttl <minutes>] [--global] [--force] [-y]
```

Creates `tapdance.config.json` in the current directory, or `~/.tapdance/config.json` with `--global`.

| Option | Default | Meaning |
| --- | --- | --- |
| `--mode <mode>` | asks, else `local` | `local`, `self-hosted` or `cloud`. `cloud` is refused with `NOT_SUPPORTED` (not available yet). |
| `--endpoint <url>` | | Self-hosted: Simlock gateway or worker URL, e.g. `https://gateway.example.com`. Required with `--mode self-hosted` when not prompting. |
| `--artifacts <dir>` | `./tapdance-artifacts` | Where screenshots, recordings and logs go. |
| `--ttl <minutes>` | `30` | Default lease TTL. |
| `--global` | | Write the per-user config instead of the project one. |
| `--force` | | Overwrite an existing file. Without it, an existing file is a `USAGE` error. |
| `-y, --yes` | | Accept defaults and never prompt. |

In an interactive terminal without `--mode`, `init` offers: 1) local device, 2) self-hosted worker,
3) Tapdance Cloud (not available). For self-hosted it also asks for the agent token (hidden input) and
stores it in `~/.tapdance/credentials.json` with mode 600. The interactive prompts have not been
exercised in an automated TTY test yet (STATUS C-07).

### `doctor`

```text
tapdance doctor [--no-host]
```

Checks configuration and its sources, the session identity, this machine (Node.js version, Android SDK
and its packages, system images, KVM on Linux, Xcode and simulator runtimes; Windows is reported as not
a worker), whether the Simlock worker or gateway answers `/v1/healthz` (two tries of up to 15 s each, of which at most 10 s to connect; a first
connection through `tailscale serve` can be slow; the time is shown, a failure names the limit that fired, and an `http://` endpoint that now
serves HTTPS is named as such), the token's role, whether
agent-device, streaming and input are available, capacity per platform (a platform with room but no device on offer fails: the worker skipped that
driver, so leases would be refused), the Simlock version (warns if
it is not 0.5.0), AXe when `ios.uiBackend` is `axe`, workers online (when an operator token is stored),
and this session's lease.

Host checks run by default in local mode only. `--no-host` skips them. Exit code 10 when any check
fails, 0 otherwise (warnings do not fail). `doctor` and `workers list` load the operator token when one
is stored; no other command, and never the MCP server, loads it.

KVM state of *remote* workers is not reported: Simlock does not expose it (STATUS C-05).

### `config`

| Command | Meaning |
| --- | --- |
| `tapdance config` / `config show` | Print the merged configuration, the files it came from, the resolved artifacts directory, and which credential sources exist (token values are redacted). |
| `tapdance config path` | Print the project config, user config and credentials file locations, marking absent ones. |
| `tapdance config set <key> <value> [--global]` | Set a dotted key in the nearest `tapdance.config.json` (or the user config with `--global`). The value is parsed as JSON when it can be (`45`, `false`, `["asc"]`), otherwise taken as a string. The result is validated before it is written. Keys containing `token` or `secret` are refused. |
| `tapdance config set-token [--operator] [--endpoint <url>]` | Store the agent token (or, with `--operator`, an operator token) in `~/.tapdance/credentials.json`, mode 600, bound to the origin of `--endpoint` (default: the endpoint currently configured for self-hosted mode). Tapdance sends the token only to that origin; see [token binding](configuration.md#token-binding). Plain `http://` to a public host is refused. Reads the token from stdin when piped, otherwise prompts with hidden input. Never pass it as an argument. |

```bash
tapdance config set session.defaultTtlMinutes 45
tapdance config set --global tools.allowMutation '["asc"]'
printf '%s' "$AGENT_TOKEN" | tapdance config set-token --endpoint https://gateway.example.com
```

`config set` writes the project file unless you pass `--global`. The security keys `tools.paths`,
`tools.mcpEnabled`, `tools.allowMutation`, `ios.axePath` and `simlock.profilePath` take effect only in
the user file (`--global`) or the environment; in a project file they are ignored with a warning
([why](configuration.md#security-settings-are-user-only)). See [configuration.md](configuration.md) for
every key.

## Discovery

### `devices`

```text
tapdance devices [-p, --platform <android|ios>]
tapdance devices list [-p, --platform <android|ios>]
tapdance devices install <platform> <version> [--image-tag <tag>]
```

`devices` (or `devices list`) shows, per platform, capacity (running, limit, warm, leased), the models
and OS versions that can be leased, Android image tags, running devices and the queue depth.

`devices install ios 18.5` or `devices install android 35` installs an iOS runtime or Android system
image **on this machine's worker** by running the bundled `simlock --local component install`. Downloads
are several GB. Android images need their SDK licences accepted first (see
[installation.md](installation.md#android-macos-or-linux-with-kvm)). Simlock's installer fetches only `google_apis`; with
`--image-tag google_apis_playstore`, `google_atd` or `aosp_atd`, Tapdance runs the SDK's `sdkmanager`
for `system-images;android-<version>;<tag>;<host ABI>` instead (it may ask you to accept a licence).
See [platforms/android.md](platforms/android.md) for which tier to use.

### `workers`

```text
tapdance workers [list]
```

Lists the machines that run devices: id or label, connection (`connected`, `disconnected`,
`incompatible`, or `self` for a local worker), Android and iOS running/limit, leases, host, and whether
agent-device and streaming are available. In local mode it shows this machine. Through a gateway it
needs an operator token (`tapdance config set-token --operator`), otherwise it fails with `FORBIDDEN`.

## Lease

### `device`

```text
tapdance device lease -p <android|ios> [-d <model>] [--os <version>] [--image-tag <tag>] [--physical]
                      [--profile <name>] [--ttl <minutes>] [--wait <seconds>] [--no-keepalive] [--hold]
tapdance device status
tapdance device renew [--ttl <minutes>]
tapdance device release
tapdance device request-human --reason <text> [--wait <seconds> | --no-wait]
tapdance device request-human --cancel
tapdance device clipboard <get | set <text>>
tapdance device crashes [--app <id>] [--pull <name|latest>] [-o <file>]
tapdance device links [--minutes <n>]
tapdance device done
```

| `device lease` option | Meaning |
| --- | --- |
| `-p, --platform` | Required. `android` or `ios`. |
| `-d, --device <model>` | Model, e.g. `"Pixel 8"` or `"iPhone 16"`. See `tapdance devices`. |
| `--os <version>` | OS version or range; for Android, the API level. |
| `--image-tag <tag>` | Android system image tag, e.g. `google_apis_playstore`. Leave it out for normal testing: on a host that has both a Play image and `google_apis` (a host set up before `host-setup.sh` installed `google_apis`, then set up again), Tapdance asks for `google_apis` and says so; on a host with one kind, Simlock picks it. With a tag (given or chosen) and no `--os`, Tapdance asks for the host's default API level (the one `tapdance devices` shows as default) when that tag is installed there, instead of the newest level that has it. The "a warm spare is ready" line counts only a spare of the requested tag. |
| `--physical` | Lease an enrolled physical device instead. Untested. |
| `--profile <name>` | Boot a [device profile](#device-profiles) from this machine instead of a Simlock device. |
| `--ttl <minutes>` | Lease TTL, 1–240. Default `session.defaultTtlMinutes` (30). |
| `--wait <seconds>` | How long to wait in the queue, 0–3600. Default `session.leaseWaitSeconds` (330). The Simlock provider waits at most 330 s. |
| `--settle <seconds>` | Android emulators: how long to check the guest's CPU after it has booted with no dialog in front, 0–300. Default `session.settleSeconds` (15). `0` skips the CPU check. |
| `--no-keepalive` | Do not renew in the background. The lease ends after its TTL unless you run `device renew`. |
| `--hold` | Stay in the foreground, renew, and release on Ctrl-C. |

`device links` lists the links apps asked the system to open in the last minutes (default 5, at most
30): `mailto:`, App Store, Settings and web links, whether anything opened them and in which app, and for
`mailto:` the address and subject. It checks a link-out where nothing handles it, such as "Contact us"
on a simulator, which has no Mail app. On iOS the log has the whole URL when the open fails (the app
logs it); for a web page that opened, iOS logs only the scheme and the app that took it, and Safari has
the address: `ui inspect --app com.apple.mobilesafari`. Android
masks most of a link's data in logcat.

`device crashes` (iOS) lists the crash reports (`.ips`) the leased simulator wrote since the lease
began, newest first, with app, exception and time; `--pull <name>` (or `latest`) saves one as an
artifact and prints the exception and the crashed thread's top frames, with their symbols (a debug
build's own frames are named). Only reports that name the lease's simulator are shown, never the
host's own apps' crashes or another lease's; remotely they come through a worker guard (`allow.logs`).

Without `--hold` or `--no-keepalive` (and with `session.keepalive` true), `lease` starts a detached
keepalive process and returns. The keepalive checks every TTL/6 (between 5 and 60 s), renews when a
third of the TTL has passed, and stops when the session releases, the lease is lost, the lease has not
been used for `session.idleReleaseMinutes` (it then releases it), or `session.maxSessionMinutes` passes
(the lease then expires on its own).

A session that already holds a lease gets `LEASE_ALREADY_HELD` (exit 3) from `device lease`.

While it waits, `device lease` prints progress on stderr: what the request waits for, read from the
host's devices of the requested kind (a warm spare is ready; a released device is being restored from
its snapshot, usually seconds on Android; a stopped one starts, usually under a minute; only with no
device of that kind on the host, a first boot that can take a few minutes; through a worker guard,
which shows only your own devices, "usually under a minute, longer on a first boot"), the request's
place in the queue or that a device is being started, and, for an Android emulator, how long it waits
for the device to settle. An emulator handed out while still starting waits up to 90 s for boot to
complete and for no "isn't responding" or crash dialog to be in front (an "isn't responding" dialog is
answered with Wait); then its CPU is checked for up to `--settle` seconds (default
`session.settleSeconds`, 15), ending early on 3 calm readings in a row or a clearly falling load. With
15 s or less, a guest whose first 3 readings are all 80 % or more and not falling is handed out after
about 5 s instead of waiting the check out; a larger `--settle` waits for it. A device still busy is
handed out with a warning (in `--json`, `notices`), printed as soon as the check ends: commands work but
can take 2-10 s each for a few more minutes. Meanwhile the lease reads the screen once and discards
it, so the first `ui inspect` is quick; that runs alongside the CPU check (at most 15 s), and a step
that takes more than about 5 s prints a "Still …" line. When a host that just started still lists its old emulator ("No Android device with
serial …"), the lease asks again every 10 s for up to 2 minutes while the host boots a new one.

`device status` shows the device, platform and OS, provider and worker, endpoint and whether it is TLS,
loopback or a private network, state, lease id and minutes left, a running recording, and a human hold
from the viewer. If the lease has ended it fails with `LEASE_LOST` and clears the session record.

`device renew` extends the lease now (optionally with a new TTL). `device release` releases this
session's device; it is wiped. Releasing when nothing is held is not an error. When the worker cannot
be reached, `release` says so, exits 4 and keeps the lease record: run it again once the worker answers
(otherwise the worker frees the device when the lease expires).

`device request-human` is the CLI form of the MCP tool `request_human`: it shows `--reason` in the
viewer's banner (and on stderr), then waits until the person presses **Hand back** in `tapdance view` or
runs `tapdance device done`. Default wait 600 s (10–1800). It prints the reason once, then a short
counter once a minute. Exit 0 when handed back, 9 (`TIMEOUT`) when nobody did, 13 (`CANCELLED`) when
the request was cancelled; Ctrl-C (or SIGTERM) stops waiting and withdraws the request. `--no-wait`
opens the request and returns at once: `device status` then shows "waiting for a person" or "handed
back at …", so an agent can keep working. `--cancel` withdraws the open request (plans changed); a
waiting `request-human` in another process then exits 13. Use it for a Google sign-in, a password sheet
or a CAPTCHA: the person types secrets on the device, never in chat.

`device clipboard get` prints what is on the device clipboard (what a Copy button or the share sheet
copied); `device clipboard set <text>` puts text there before a paste test.

`device done` tells the agent you finished what it asked for with `request_human` (for example
signing in); the viewer's **Hand back** does the same.

### Device profiles

```text
tapdance device profile create <name> [-p <android|ios>] [--image-tag <tag>] [--os <version>] [--device <model>] [--no-edit]
tapdance device profile edit <name>
tapdance device profile list
tapdance device profile delete <name>
```

A profile is an Android emulator you set up once and that leases boot from: for example signed in to a
Google Play license-tester account for Play Billing tests, with settings and Play Store updates done.
`create` makes an AVD from an installed system image (`google_apis_playstore` and the highest
installed API by default; `sdkmanager` installs more) in Tapdance's own AVD home
(`~/.tapdance/profiles/android/avd`, never next to your own AVDs), then opens it with a window: set it
up and close the window to save. `edit` opens it again the same way. `device lease -p android
--profile <name>` boots it **read-only**: everything a lease changes (installs, purchases, data) is
thrown away at release, so every lease starts from the saved state.

**iOS profiles** (`-p ios`) are a template simulator `tapdance-profile-<name>` (Xcode's default device
set, `iPhone 16` and the newest runtime by default). `create` then `edit` boots it in Simulator; set it
up and press Enter in the terminal. Each lease clones the template, boots the clone and deletes it at
release, so nothing a lease does reaches the template.

Profiles run on the machine where Tapdance runs, outside Simlock (Simlock enrols only USB phones and
wipes its own emulators), and are driven by agent-device directly. They have no browser stream: watch
the emulator's window. They are **local only** by design: an agent on another machine (a VPS through a
gateway or the worker guard) cannot lease them; there it uses a fresh device and `request_human` for a
sign-in. Your
credentials never pass through Tapdance: you type them in the emulator. Use a dedicated test account:
anyone who can lease the profile acts as that account.

`TAPDANCE_PROFILE_HEADLESS=1` boots profiles without a window (scripts, CI).

### Device state

```text
tapdance device setting <name> [value] [--app <id>] [--permission <p>] [--lat <n> --lon <n>]
tapdance device push <path> --to <downloads|pictures|documents|app_sandbox|files> [--app <id>] [--name <n>]
tapdance device pull [devicePath] [--app <id> --path <relative>] [--files <name>] [-o <file>]
tapdance device notifications <list|open|close|post|tap> [--app <id>] [--title <t>] [--text <t>] [--payload <json>]
tapdance device perf <frames|memory> [--app <id>]
tapdance device shell [--stdin <file>] [--timeout <seconds>] -- <command…>
```

These act on the leased device through Simlock's lease exec or agent-device, so they work for a device
on a remote worker too; a worker in device-only mode decides with its policy (`allow.settings`,
`allow.files`, `allow.inspection` (reading an emulator's notifications), `allow.notifications` (posting
them, and reading a physical phone's; off by default), `allow.perf`). Every change ends with the lease:
the device is wiped on release.

- `setting`: `wifi`, `bluetooth`, `airplane`, `mobile-data`, `animations` (`on`/`off`; on the iOS
  simulator `wifi`/`airplane` are refused, because it uses the Mac's network and cannot go offline, and
  `animations` has no switch), `location`
  (`on`/`off`, or `--lat`/`--lon`), `appearance` (`light`/`dark`/`toggle`), `text-size`, `faceid`/`touchid`
  (iOS), `fingerprint` (Android), `permission <grant|deny|reset> --permission <p> --app <id>`,
  `reset-keychain` (iOS), `orientation` (`portrait`, `landscape` = `landscape-left`, `landscape-right`,
`portrait-upside-down`; without a value it reads portrait or landscape from the screen size),
`status-bar-time <HH:MM|clear>` (iOS), `language <locale>` (iOS: the device-wide language and region,
e.g. `de-DE`, what Settings › General › Language sets; apps take it when they start, so relaunch them;
without a value it reads it; on Android use `app launch --locale`), `browser-first-run off` (Android: Chrome opens links without its
welcome, sign-in, default-browser and notifications screens; through Chrome's command-line file and the
notification permission, so on emulator images, which allow it). Other Android settings
  (density, locale, time zone, …) go through `device shell`. Without a value it
  reads the setting where the platform can. The iOS simulator's clock is the Mac's and cannot be
  changed per lease (test "next day" rules on Android with root, or with a debug date in the app). iOS
  notification permission is not in `simctl privacy`: to deny it, drive Settings › Apps › <app> ›
  Notifications (the switch row is tapped at its toggle); for a fresh prompt, `app uninstall` and install
  again (`app build` reinstalls from the host's cache in seconds). A combination a platform cannot do fails with
  `NOT_SUPPORTED` and says what to do instead. Common Android settings through `device shell` (standard
  Android shell commands, not each one run with Tapdance yet):

  | Want | Command |
  | --- | --- |
  | Font scale 2.0 | `device shell -- settings put system font_scale 2.0` |
  | Density | `device shell -- wm density 420` (`wm density reset` to undo) |
  | TalkBack on (when the image has the Android Accessibility Suite) | `device shell -- settings put secure enabled_accessibility_services com.google.android.marvin.talkback/com.google.android.marvin.talkback.TalkBackService`, then `-- settings put secure accessibility_enabled 1` |
  | Move the clock (needs root: `google_apis` images, not `google_apis_playstore`) | `device shell -- settings put global auto_time 0`, then `-- su 0 date 1103190026` (MMDDhhmmYY) |

- `push`: Android shared storage (media-scanned) or a debuggable app's sandbox, up to 24 MB; iOS Photos,
  `--to files` (the Files app's On My iPhone, which every app's document picker sees: use it for import
  tests), or an app's Documents (a remote simulator needs a worker guard).
- `pull`: Android shared storage (`/sdcard/Download/…` and the other media folders) or `--app` with
  `--path`; iOS `--app` with `--path` inside its container, or `--files <name>` from On My iPhone
  (remote: through a worker guard). Saved as an
  artifact.
- `notifications`: `list` (Android), `open`/`close` the shade (Android) or Notification Center (iOS: a
  swipe from the top-left edge; with the app killed the session switches to SpringBoard, which draws
  it, so `ui inspect --all` reads the notifications), `post` a shell notification (Android) or, with
  `--app` and `--payload`, a push payload (the way to test pushes on the iOS simulator). `tap --text
  <text>` opens the notification whose text contains it, the way a person does: on iOS a real swipe
  right across it in Notification Center (a tap there only selects it), which opens the app even when
  it was killed; on Android a tap in the shade. A banner can also be tapped while it shows: `ui sequence`
  with `--orientation portrait` and a tap at the top of the screen.
- `shell` (Android emulators only): runs the command with `adb shell` **inside the leased emulator**
  (its own VM, wiped at release; never this machine), e.g. `tapdance device shell -- dumpsys
  media.audio_flinger` or `-- wm density 320`. Exit code 1 when the command fails. Refused on iOS and on
  physical phones.
- `perf frames`: frame health of the foreground app since the last reading; `perf memory`: a memory
  sample. Launch the app with `app launch` first.
- There is no audio command: agent-device's audio probe records the host's system audio with
  ScreenCaptureKit (macOS Screen Recording permission), which Tapdance does not use.

## Apps

### `app`

```text
tapdance app install <path> [--app-id <id>] [--launch <appId>]
tapdance app install --from-ci <owner/repo> --artifact <name> [--run <id> | --branch <name>] [--launch <appId>]
tapdance app launch <appId> [--relaunch] [--url <url>] [--arg <arg>]... [--locale <l>] [--console]
                     [--intent-action <a>] [--intent-data <uri>] [--intent-component <c>] [--intent-extra <k=v>]...
tapdance app stop <appId>
tapdance app kill <appId>
tapdance app build --git <url> --ref <ref> [--project <path>] [--scheme <s>] [--configuration <c>] [--xcode-setting <K=V>]...
                  [--gradle-task <t>] [--dir <path>] [--launch <appId>] [--verbose]
tapdance app uninstall <appId>
tapdance app clear <appId>
tapdance app list
```

`install` uploads and installs an `.apk` or `.aab` (Android) or a simulator `.app` bundle (iOS) from
this machine. An `.aab` is first turned into a universal APK with
[bundletool](https://github.com/google/bundletool) (`tools.paths.bundletool`, `TAPDANCE_BUNDLETOOL`, or
`bundletool` on `PATH`), signed with the Android debug keystore; without bundletool it is refused with
`APP_PATH_INVALID` and an install hint. An `.ipa` on a simulator is refused. `--app-id` gives the
package or bundle id when the backend needs it.

`install --from-ci` installs an app that your CI built instead of a local file: the device's host
downloads the GitHub Actions artifact `--artifact` with its own `gh` login and installs its newest
`.apk` (Android) or its simulator `.app` (iOS, #121: the `.app` folder, an artifact that is the `.app`'s
own contents, or one zipped `.app` inside it; a device build or an `.ipa` is refused; unit-tested only). `--run` names the workflow run; otherwise the host takes the newest
successful run on `--branch` (default: the repository's default branch) that has the artifact. Give a
path or `--from-ci`, not both. It needs a worker guard whose owner allowed the repository with
`tapdance host artifacts enable`. The Android path ran on a Google Cloud N2
host ([evidence](testing/evidence/2026-11-03-gcp-n2-android.md)). For example:

```bash
tapdance app install --from-ci acme/app --artifact app-debug --launch com.acme.app
```

The reply names the installed package and its `versionCode`, which the host reads from the APK's
manifest (unit-tested only). When the device refuses the APK (`INSTALL_FAILED_VERSION_DOWNGRADE`, or a
build signed with another key), the hint names that package: `tapdance app uninstall <package>`, then
install again. An upload from a path names it too (from `--app-id`, adb's message or the APK's
manifest); when nothing names it, the hint says `tapdance app list` shows it. `--launch` warns when it names another app than the one installed.

`launch` starts or brings an installed app to the front; `--relaunch` kills and restarts it; `--url`
opens a deep link; `--arg` passes launch arguments (and relaunches). The `--intent-*` options start an
explicit Android intent instead. `stop` force-stops it (on Android that also cancels its alarms and
jobs). `kill` ends it the way a user does by swiping it away: Home, then `am stop-app` (Android 14+) or
a memory trim and `am kill`, keeping its alarms and jobs; it then checks the process is gone and exits 7
with the surviving pid when something (a foreground service) keeps it alive. On iOS both use the
simulator's terminate.

`launch --locale de-DE` runs the app in that language: on iOS through the launch arguments
`-AppleLanguages (de)` and `-AppleLocale de_DE`, on Android 13+ by setting the app's own locale (`cmd
locale set-app-locales`) and relaunching it.

`launch --console` (iOS) relaunches the app with its stdout and stderr written to files on the Mac:
`print` and Kotlin's `println` go to stdout, which the simulator's system log does not keep.
`tapdance logs --app <id>` then adds the captured lines after the system log (stdout, then stderr). Each
launch starts a fresh capture; through a worker guard the guard chooses the files (one pair per lease,
under `~/.tapdance/worker/console`) and only the lease's token can read them. On Android, `println`
and `Log` lines are already in logcat.

`build` (through a worker guard whose owner turned builds on) builds the app on the machine that runs
the leased device, from an allow-listed git repository and ref, and installs it on the lease; the log
streams as progress and the reply names the exact commit. This is how an agent without Xcode gets an
iOS app onto a remote simulator. See [Builds on the host](deployment/one-command-host.md#builds-on-the-host).
The reply says whether the host built it or reused its earlier build of the same commit and settings
(`reused`, with `builtAt`; a build from MCP `build_app` counts, and an option left out equals its default), the ref you asked for next to the exact commit, and on Android the installed
package (`appId`). When the host cannot sign in to the repository the error is `AUTH_FAILED` (exit 5),
not `DEVICE_ERROR`: it prints git's own line (`Permission denied (publickey)`, `Repository not found`)
and a hint for the auth the host used (its deploy key and fingerprint, or `gh`); only the host's owner
can fix it. Unit-tested only. `uninstall` removes it. `clear` clears its data
(first-launch state); on iOS the keychain is shared, see `device setting reset-keychain`. `list` lists
the apps the automation backend sees.

## UI

### `ui`

```text
tapdance ui inspect [--all] [--compact] [--bounds] [--system] [--app <id>]
tapdance ui audit [--app <id>]
tapdance ui tap  (<ref> | --text <t> | --id <id> | --ref <ref> | --selector <s> | --x <x> --y <y>) [--no-settle] [--settle-ms <ms>] [--inject]
tapdance ui type <text> [--text <t> | --id <id> | --ref <ref> | --selector <s> | --x <x> --y <y>] [--delay-ms <ms>]
tapdance ui swipe (--direction <up|down|left|right> [--amount <0.1-0.8>] [--until <text>] | --from <x,y> --to <x,y>)
tapdance ui wait  (--text <text> | --absent <text> | --stable) [--timeout <ms>]
tapdance ui sequence <file.json> [--start-on-text <text>] [--offset-ms <ms>] [--wait <seconds>] [--orientation <o>]
tapdance ui alert <get|accept|dismiss>
tapdance ui key   <back|home|enter|dismiss_keyboard|app_switcher>
```

**Targets.** `tap` and `type` take exactly one target: `--text` (visible text or accessibility label),
`--id` (accessibility identifier or Android resource id), `--ref` (from `ui inspect`, e.g. `@e7`),
`--selector` (an [agent-device](https://github.com/callstack/agent-device) selector such as
`role="button" label="Next"`), or `--x` and `--y` together as a fallback. Zero or two targets is a
`USAGE` error. With the AXe iOS backend, selectors are `NOT_SUPPORTED`.

| Command | Notes |
| --- | --- |
| `ui inspect` | `--app <id>` switches to that app as it is (no relaunch) and reads it: on iOS every read brings the session's app to the front, so after a link-out use `--app com.apple.mobilesafari`, and for the Home Screen `--app com.apple.springboard`; later reads stay on it until you launch your app. Elements with ref, role, label, value, identifier and state (`[checked]`, `[unchecked]`, `[selected]`, `[focused]`, `[expanded]`), in the default view and with `--all`. `--all` includes non-interactive elements; `--compact` leaves out unlabelled containers (the bulk of a Compose or SwiftUI tree); `--bounds` prints each element's `(x,y w×h)` in pixels, for coordinate taps on canvases (`--json` always includes them as `rect`). `--system` (Android) reads every window with `uiautomator dump` (it stops agent-device's snapshot helper first, which holds the one UiAutomation connection; the next normal inspect starts it again) instead: what the normal view misses, such as a Chrome Custom Tab (a `browser: <url>` note shows its address bar) or a system picker. Its refs are `@u<n>` and cannot be tapped; tap `--x`/`--y` at the centre of the bounds, or `--text … --inject`. On Android the header names the app whose elements are on screen: when none belong to the session's app (the launcher after Back), it names that app instead and a note says the session's app is not in front. On Android, when the automation helper cannot read the screen, Tapdance retries (0.5, 1, 2 s) and then reads a uiautomator dump, with a warning that its refs cannot be tapped. |
| `ui tap` | A ref from `ui inspect` may be the argument (`ui tap @e3`, the same as `--ref @e3`); other text there is refused with a pointer to `--text`. Waits for the UI to settle and lists what changed. `--no-settle` skips that. `--settle-ms <ms>` also waits up to that long for the UI to come to rest (a tap that auto-advances to the next screen after an animation) and prints `screen changed: <its first labels>` or `same screen`. On Android system screens that ignore the automation helper's touches (the file picker `DocumentsUI`, the share sheet), a settled tap that changed nothing is repeated once as a raw `input tap` and says so. `--inject` (Android) taps with a raw input event at the element's centre from the start. On iOS, a tap on a switch row that changed nothing is repeated at the row's toggle (the row's centre is its label). A `--text` target that is not on screen, or not tappable where it is (under a toolbar), is scrolled into view first (down the list, then up) and tapped where it then is; text that is only part of a label matches too, and the reply says so. On iOS, a settled tap that changed nothing and opened a link in another app (Safari) puts that app back in front (the settle read had brought your app back) and says so. A target that is not found fails naming the labels on screen (`On screen: …`); `ui type` with a target does the same. |
| `ui audit` | Accessibility check of the screen, from the accessibility tree: controls with nothing to announce (error, exit 1), touch targets under 44 pt (iOS) or 48 dp (Android), several controls announced alike, unlabelled images (info: fine if decorative). The iOS simulator has no VoiceOver, so this is how an agent checks "every control is announced"; it cannot judge colour contrast or clipped text. Controls cut off by a screen or list edge or under a tab/navigation bar are not judged; the summary line names them so you can scroll them into view. |
| `ui type <text>` | With a target, focuses the field and replaces its content; without one, appends to the focused field. On Android, typing without a target fails (`ELEMENT_NOT_FOUND`) when the screen shows a text field but no focused element and the keyboard is down, instead of reporting characters that went nowhere; pass `--text`, `--ref` or `--id`. `--delay-ms` pauses between keystrokes, for fields that drop fast input (Compose Multiplatform on iOS). After a fill, Tapdance reads the field back: if it does not hold exactly the typed text, it fills again at 80 ms and then 150 ms between keystrokes, and fails with what the field shows if it still differs (secure fields are not read back). |
| `ui swipe` | `--direction` is the finger's direction: `up` scrolls content down. `--until <text>` scrolls one swipe at a time (at most 10) until an element whose label or value contains the text (any case) is on screen; a list row whose label merges several texts still matches. It stops with `ELEMENT_NOT_FOUND` at the end of the list. `--from`/`--to` take points like `120,640`. |
| `ui wait` | Exactly one condition. `--timeout` defaults to 10000, at most 600000 (10 minutes; long waits run as 30 s waits in a row). Exits 1 on timeout. `--stable` reads the screen repeatedly and succeeds once its content (roles, labels, ids, values, states) has not changed for one second; positions are ignored, so a moving background does not count. On timeout it says the UI is still changing. |
| `ui sequence` | Timed taps next to the device, so the network adds no delay between them (rhythm games, timing-graded input). The file is a JSON list `[{"t":0,"x":120,"y":900},{"t":480,"x":240,"y":900,"hold":200}]`: `t` in ms from the start, ascending; `hold` makes a long press (at most 500 taps, 10 minutes). **Android:** one shell script inside the emulator; each tap starts in the background at its time (Android's `input` then takes a few tens of ms to deliver it); through a worker guard it needs `allow.deviceShell`. **iOS:** touches through the simulator's input channel (what the live viewer uses, not XCTest, whose taps take 300–450 ms each), scheduled on the Mac: by the worker guard (`allow.interaction` and `allow.input`) or by Tapdance itself in local mode; x and y are the points `ui inspect --bounds` shows. In landscape the device is taken as turned `landscape-left` (Tapdance's "landscape", and what most apps that force landscape use); `--orientation landscape-right` for the other way. With `--orientation` given, nothing is read from the app first (a read brings the session's app to the front), so use `--orientation portrait` for taps outside your app: a banner, Notification Center, the Home Screen. On iOS a step with `toX`/`toY` is a drag to that point over `hold` ms (default 250): a swipe at a set time. The reply gives every tap's `actualMs` and `driftMs`. `--start-on-text` waits for that text first (one round trip) and starts `--offset-ms` after. |
| `ui alert` | `get` shows a system alert's title, message and buttons; `accept` presses the allowing button, `dismiss` the declining one. Not available with the AXe backend. |
| `ui key` | `back` is Android back or iOS in-app back. `dismiss_keyboard` presses the keyboard's own hide key; the iPhone keyboard has none, so on iOS it is refused with a hint (tap the app's Done control or an empty spot above the keyboard). |

## Evidence

### `screenshot`

```text
tapdance screenshot [-o, --output <path>] [--note <text>]
```

Saves a PNG to the session's artifact folder, or to `--output`. Prints the path.

### `record`

```text
tapdance record start [-o, --output <path>]
tapdance record stop
```

Records the screen to MP4. The path is chosen at `start`; `record stop -o` is accepted but ignored.
Starting twice, or stopping with no recording running, is a `USAGE` error. Releasing the device stops a
running recording. On a remote worker, agent-device downloads the video within 90 s; a longer download
(a long recording over a slow link) is retried by Tapdance with up to 30 minutes, so the file is not
lost. `record stop` gives up after 32 minutes.

### `logs`

```text
tapdance logs [-n, --lines <n>] [--app <id>] [--crash] [--contains <text>] [--level error|fault]
```

Recent device logs (Android logcat, iOS simulator unified log), default 200 lines, at most 20000.
`--app` filters to one app (iOS: its subsystem or its process, the app's executable name). On iOS the
system log has the app's `os_log`/`NSLog` lines, not `print`/`println` output, which goes to stdout.
`--crash` shows Android's crash buffer or iOS faults and crash messages from the last 10 minutes; for
the full iOS crash report use `device crashes`. The output is also saved as an artifact.

`--contains` keeps lines that contain the text (case-insensitive, 1–200 characters; it matches the
tag and level as well as the message). `--level error` keeps Android `E` and `F` lines (the logcat line's
own level decides, so an `I` line that mentions an exception is left out) and, on iOS, error and fault
lines plus lines with the words error, fault, fatal or exception; `--level fault` keeps Android `F`
lines and `E` lines that say fatal or crash, and iOS fault lines plus lines with fault, fatal or crash.
"default" does not count as "fault". With either filter,
`-n` counts matching lines, and on Android Tapdance reads the whole logcat buffer rather than the last
N lines, so a search reaches as far back as the device keeps logs; the footer says how many lines
matched and the time of the oldest line in the buffer. On iOS the window stays the last 3 minutes (10
with `--crash`). Logcat's separate `events` buffer is not read; use
`tapdance device shell -- logcat -d -b events` for it. These match MCP `get_logs` `contains` and
`level`.

### `artifacts`

```text
tapdance artifacts
```

Lists this session's screenshots, recordings and logs with their paths, from the session folder's
`manifest.json`.

## Scenarios

### `run`

```text
tapdance run <file> [--keep-lease] [--continue-on-failure]
```

Replays a scenario file (YAML or JSON; format in [scenarios.md](scenarios.md)) on this session's
device and prints one line per step (✓/✗, name, milliseconds), then PASS or FAIL and the path of
`report.md`. If the session holds no device and the scenario has a `device:` block, that device is
leased for the run and released at the end; `--keep-lease` keeps it and renews it in the background.
A failed step gets a screenshot and the full UI tree in the run's evidence folder
(`<artifacts>/<session>/runs/<time>-<name>/`, listed by `tapdance artifacts`) and stops the run;
`--continue-on-failure` runs every step anyway. With `--json` the full report goes to stdout and the
step lines to stderr. Exit code 0 on PASS, 12 on FAIL, 2 for an invalid scenario file, and the usual
codes when the run cannot start (3 when there is no device and nothing to lease).

## Human access

### `view`

```text
tapdance view [--host <host>] [--port <port>] [--allow-host <name>]...
tapdance view --tailscale [--port <port>]
```

Serves a live view of this session's device on `127.0.0.1:4710` (from `viewer.host` and `viewer.port`)
and prints a link with a one-time key. The page shows the live screen and accepts tap, swipe, scroll,
keys, Home/Back, screenshots and recordings. A touch takes control from the agent for
`viewer.humanHoldMs` (agent calls get `HUMAN_HELD`); **Take over** holds it for 10 minutes whether or
not the person touches the screen (the error then says "took over"); "Hand back" returns it.

Public addresses are refused. `--host 0.0.0.0` is allowed with a warning: anyone who can reach the
port and has the link can control the device. Prefer loopback plus `ssh -L` or a private network. Stops
on Ctrl-C. Needs Simlock's `stream` and `input` capabilities (on after `tapdance worker install`).

Bound to a tailnet address, the page also answers to this machine's Tailscale names (its MagicDNS name,
short name and 100.x addresses, from `tailscale status`) and prints the link with the MagicDNS name;
`--allow-host` adds other names. The key in the link works while the viewer runs (it is not single-use);
anyone with the link can control the device.

Browsers allow the live video decoder (WebCodecs) only on `https://` or `localhost`. Opened over plain
`http://` on another address (a tailnet IP or name), the page switches to **screenshot mode**: about two
refreshed screenshots per second, with a banner saying why; tap, type, Take over and Hand back still
work. For live video, open it through `ssh -L` (localhost) or behind HTTPS. Startup errors show in the
banner instead of leaving the page on "loading…".

`--tailscale` does the HTTPS part: the viewer listens on loopback, `tailscale serve --bg --https=<port>`
exposes it on this machine's tailnet name, and the printed link is `https://<name>.ts.net:<port>/#k=…`
(live video). It fetches the page once first, so the certificate is issued before you open it, and
removes the serve entry on Ctrl-C. It needs MagicDNS and **HTTPS Certificates** on the tailnet
(<https://login.tailscale.com/admin/dns>); without them it says so. If `tailscale serve` is refused for
your user, it tries `sudo -n tailscale serve` (passwordless sudo) and prints the command it ran;
otherwise run `sudo tailscale set --operator=$USER` once.

Behind a `tailscale serve` (or another proxy) you set up yourself on another port, the page answers
to this machine's tailnet names on any port; `--allow-host` names are compared without a port too. A
refused name gets `403` with the `Host` it saw and the `--allow-host` to add.

## Workers and gateways

These commands manage the bundled Simlock daemons on this machine. Two-machine setups (gateway on a
VPS, worker on a laptop or a Google Cloud N2 VM) are implemented but **have not been tested across
machines yet** ([STATUS.md](../STATUS.md), M-02, Q-06). The deployment guides in
[deployment/](deployment/) describe the full procedure.

### `worker`

| Command | Meaning |
| --- | --- |
| `worker check [--android-only]` | Check this machine can run emulators/simulators: Node, Android SDK, images, AVDs, KVM, Xcode. Exit 10 if a KVM check fails. Changes nothing. |
| `worker install [--no-stream] [--ios-backend <agent-device\|axe>] [--service]` | Configure the bundled Simlock worker (agent-device on, pointing at the bundled agent-device; stream and input on unless `--no-stream`), restart it, and print the host checks. `--ios-backend axe` also sets Simlock's `drivers.ios.deviceSet` to `default` and `ios.uiBackend: "axe"` in `~/.tapdance/config.json`. `--service` installs a launchd / systemd `--user` login service. Refused on Windows. |
| `worker login --accept-gateway-exec --gateway <url> [--label <name>] [--token-stdin] [--no-viewer]` | Join a gateway. `--accept-gateway-exec` is required: without it the command refuses with `FORBIDDEN`, because a joined gateway, and every agent token it issues, can run programs on this machine (Simlock's exec; `simctl spawn` starts any program). Pass it only on a machine you dedicate to being a worker. The worker dials out over an authenticated WebSocket; no inbound port is opened. The URL must be `wss://`, or `ws://` to a private address (loopback, RFC 1918, Tailscale 100.64/10 or `*.ts.net`); `http(s)://` is converted. The join token comes from `TAPDANCE_WORKER_TOKEN`, else stdin when piped (`--token-stdin` documents that), else a hidden prompt. `--no-viewer` leaves stream and input off. |
| `worker logout` | Leave the gateway, turn the worker's own HTTP API back on, restart. Revoke the join token on the gateway afterwards. |
| `worker guard start` / `pair [--scope <areas>]` / `tokens` / `revoke` / `policy` / `audit` | Device-only mode (verified on one Mac with a real simulator, H-02, and over Tailscale in the field runs with a Mac, a Google Cloud N2 VM and a rented Mac mini as hosts; the dedicated-account script is untested). A local server in front of the Simlock worker that remote control machines reach instead of a gateway, enforcing a policy file on the worker. `pair` must run in a terminal on the Mac (unless `TAPDANCE_GUARD_PAIR_NONINTERACTIVE` is set) and prints a token once. See [security/personal-mac.md](security/personal-mac.md). |
| `worker guard install [--allow-admin-account] [--keep-awake]` / `worker guard uninstall` | Keep the guard running as a login service of this account: a LaunchAgent `dev.tapdance.guard` (`~/Library/LaunchAgents/dev.tapdance.guard.plist`, RunAtLoad + KeepAlive, log `~/Library/Logs/tapdance-guard.log`) on macOS, or `~/.config/systemd/user/tapdance-guard.service` (`Restart=on-failure`, log `~/.tapdance/worker/guard.log`, moved to `guard.log.1` at 5 MB when the service is installed; the user journal is not always kept on cloud VMs) on Linux. Same refusals as `guard start`, and refused while a `guard start` in a terminal holds the port; an unchanged running service is left alone. `--allow-admin-account` is passed on to `guard start`; `--keep-awake` runs it under `caffeinate -i` on macOS (no effect on Linux). Exit 4 if the guard does not answer within 20 s. `uninstall` stops it and removes the file; tokens and policy stay. Refused on Windows (`NOT_SUPPORTED`). `host up` installs the guard this way: it ran on a Google Cloud N2 VM (systemd) and a rented Mac mini (LaunchAgent), and the guard came back after a restart of each (W-07). See [security/personal-mac.md](security/personal-mac.md#keep-the-guard-running). |
| `worker cleanup` | Release device claims left behind by agent-device processes that have gone (a worker restart, the machine going offline mid-lease). Such a claim blocks the next lease of that emulator with "owned by session …". Only claims whose owner process is provably dead are touched; an unfinished screen recording of such a session is set aside (renamed `*.abandoned-<time>`) so its claim can go. `worker start`/`restart` and the worker guard (before each lease) do this on their own. |
| `worker start` / `stop` / `status` / `restart` | Start, stop, show, or restart the worker daemon. `status --json` returns Simlock's JSON. `restart` ends agent-device sessions on the worker. `start` and `restart` check the worker's login service first: when it starts another Simlock than this Tapdance ships (after `git pull && pnpm install` with a new Simlock patch, pnpm puts it in a new `simlock@…_patch_hash=…` folder, and the unit or plist still names the old one) or a Node or Simlock that is gone, they install it again (Simlock's `daemon install`: rewrites `~/.config/systemd/user/com.callstack.simlock.worker.service` or `~/Library/LaunchAgents/com.callstack.simlock.worker.plist` and reloads systemd/launchd) instead of starting the old one, and say so. Simlock's config, including the warm-spare settings, is not touched, and its device records are checked with `doctor --fix`, never reset, so learned spares are kept. On Linux, before that install, they set up the user manager (linger, its bus; this works over a non-interactive `ssh … --command`) and check that `systemctl --user` answers; when it does not they stop with exit 10 and change nothing. If the install still fails, the worker is started without the service, the error says the login service is now missing and to run `tapdance worker install --service`, and the exit code is 10 (`HOST_CHECK_FAILED`); `start`, `restart` and `host status` then warn until a login service is installed again. |
| `worker logs [-n, --lines <n>] [--contains <text>] [--since <when>]` | Print the worker daemon's log, read from Simlock's `daemon.log` (and `daemon.log.1`, where Simlock moves it at 5 MB): the last 100 lines by default, up to 5000 with `-n`; with a filter, the last `n` matching lines. `--contains` keeps lines containing the text (case-insensitive, like `tapdance logs`); `--since` keeps lines from the last `30s`, `10m`, `2h` or `1d`, or since an ISO time. For example `tapdance worker logs --contains "clean baseline"` finds the line Simlock logs when it saves a device's clean snapshot, however many lines came after it. `--json` returns `{ path, lines }`. |

**Security.** Joining gives the gateway operator rights on this machine's devices: whoever controls the
gateway or holds an operator token for it can lease any device here, install runtimes and read the
worker's configuration. Agents with gateway tokens can run commands on this machine as the user who runs
the worker daemon. While joined, this machine's own HTTP API is off, so local agents must use the
gateway too (`tapdance init --mode self-hosted --endpoint …`). On a Mac laptop, keep it awake while
agents work (`caffeinate -is`); sleep takes the worker offline.

### `gateway`

| Command | Meaning |
| --- | --- |
| `gateway setup [--worker-label <name>] [--agent-label <name>] [--public-url <url>] [--no-configure-here]` | Start a Simlock gateway on this machine (listening on `127.0.0.1:4700`), enable agent-device, stream and input, and mint a worker join token, an agent token and an operator token. Unless `--no-configure-here`, it writes `provider: "self-hosted"`, `endpoint: "http://127.0.0.1:4700"` to `~/.tapdance/config.json` and saves the agent and operator tokens to `~/.tapdance/credentials.json`. Prints the worker join token once and the next steps (Caddy or `tailscale serve` for TLS). Defaults: `worker-1`, `tapdance-agent`. |
| `gateway token --role <worker\|agent\|operator> --label <name>` | Mint one more token on this machine's gateway and print it once. |
| `gateway status` | Show the gateway's workers (`simlock --gateway worker list`). |

A gateway needs no KVM, so an ordinary VPS works. It has no TLS of its own: put a TLS proxy in front of
it or keep it on a private network such as Tailscale. Never commit tokens.

### `simlock`

```text
tapdance simlock -- <simlock arguments>
```

Runs the Simlock 0.5.0 CLI bundled with Tapdance (with Tapdance's patch), for operators. Put `--` before Simlock's own options
(`tapdance simlock -- --version`), or Tapdance parses them itself. Agents should not need it.

## Hosting for a remote agent

One command per side for device-only mode: `host up` on the Mac or Linux machine that runs the
devices, `connect` on the machine where the agent runs. Run end to end on the owner's Mac and on a
Google Cloud N2 VM driven from a Mac ([evidence](testing/evidence/2026-11-03-gcp-n2-android.md)), and on a
rented Scaleway Mac mini set up over ssh for iOS ([evidence](testing/evidence/2026-11-06-rented-mac-ios.md);
over ssh `host up` does not offer the clipboard: copy the token file with `scp`); `pause`,
`resume` and `down --all` are unit-tested only ([STATUS.md](../STATUS.md), W-07). Full guide: [deployment/one-command-host.md](deployment/one-command-host.md).

### `host`

| Command | Meaning |
| --- | --- |
| `host up [--label <name>] [--allow-admin-account] [--no-tailscale] [--keep-awake] [--tailscale-ssh] [--repair] [--skip-self-test] [--warm android=N,ios=M] [--scope <areas>] [--idle-stop <minutes\|off>] [--max-uptime <hours\|off>] [-y, --yes]` | Eight steps, each printed with its name: prerequisites (the `worker check` checks plus a JDK check and, on Linux, cloud-VM detection; installs nothing and prints install commands), account (root, joined gateway, administrator refusals; on an admin account it stops and prints the exact command to run again with `--allow-admin-account`), worker (`worker install --service`, which on Linux without a display also sets headless emulators with the `swiftshader_indirect` GPU mode; left alone on a re-run when it already runs with the guard service, except that a login service still starting another Simlock than this Tapdance's, as after an update, is installed again with a worker restart when no lease runs, and only warned about while one does), guard service (`worker guard install`), pairing (a guard token labelled with `--label`; without it, the host's only active pairing is kept, so `host up --idle-stop 10` never pairs a new machine, and with none it is the hostname; several pairings and no `--label` are refused. Approved at a terminal or with `--yes`, and a run that would need approval without a terminal is refused before any step changes anything, naming the pairing the host already has. The token is written to `~/.tapdance/worker/pairing-<label>.token` with mode 600 and never printed; a valid token file is kept, `--repair` revokes and reissues), tailscale (`tailscale serve --bg --https=4720 http://127.0.0.1:4720` and the MagicDNS endpoint; `--http` with a warning recommending HTTPS Certificates when the tailnet has none; or loopback with instructions when Tailscale is missing, logged out or `--no-tailscale`; with `--tailscale-ssh` also `tailscale set --ssh`, so tailnet machines can `ssh <user>@<name>` without copying keys: a refusal only warns, naming `sudo tailscale set --ssh` or, with the Tailscale app on macOS, that it needs the open-source `tailscaled`; who may connect is the tailnet policy's `ssh` section; unit-tested, not yet run on a host, #126), self-test (through the guard with the new token: list devices, lease Android or else iOS, screenshot, release; `--skip-self-test` keeps only the device list), summary (the `TAPDANCE HOST READY` block with the `tapdance connect` line, a security note on what the token allows (the iOS simulator sentence on macOS only), and on Tailscale a suggested ACL). At the end it offers to copy the token to the clipboard, except on Linux without a display or without a clipboard tool, where it points at the token file and `host token --show` instead. `--scope` limits a newly issued pairing token to those policy areas (see [threat model](security/threat-model.md)). `--idle-stop` and `--max-uptime` set the cost guard (`hostStop` in the guard policy; Linux only, refused on macOS): power the machine off after that many minutes with no lease, guard request or build (30 by default on a detected cloud VM, off elsewhere), and after that many hours up take no new leases and power off when the last one ends (off by default). The stop command is fixed (`sudo -n /usr/bin/systemctl poweroff`); when sudo does not allow it, `host up` prints the one sudoers rule to add. A changed setting restarts an idle guard; the ready block shows it on a `cost guard:` line ([cost guardrails](deployment/google-cloud-n2.md#cost-guardrails)). On a detected cloud VM the block adds a `cloud VM:` line: it bills while running, its disk bills even when stopped, and where to read how to delete it ([tear down](deployment/google-cloud-n2.md#tear-down) on Google Cloud, otherwise [the overview](deployment/self-hosted-overview.md#when-you-are-done-with-a-rented-machine)). For a short-lived test host, pass `--idle-stop off` with Terraform's ephemeral mode ([field test](testing/field-test-cloud-android.md)). A failed step prints the step, the command, the tail of its output and a fix, and exits with the error's code. Refused on Windows (`NOT_SUPPORTED`). |
| `host status` | Each step's state on this machine (prerequisites, account, worker, guard service, cost guard, pairings, Tailscale) and the endpoint. The prerequisites row says `ios needs a Mac` on Linux, and when the Android SDK is not found from this shell it says so (it also looks in `~/Android/Sdk`, so a command over ssh without a login profile still finds what `host-setup.sh` installed). The worker row reads Simlock's RAM budget from `capacity.ramBudget`. The cost guard row shows the idle stop and uptime cap, how long the host has been idle and when it will power off (`idle 1 min, powers off in about 9 min (around 15:43 UTC)`; the guard checks once a minute and the shutdown takes a minute or two more), and fails when sudo does not allow the stop command. On a detected cloud VM a `cloud VM` row says what still bills and links the tear-down steps. When builds with `--git-auth gh` or installs from CI are on, a `gh` row says whether `gh auth status` works (`host up` warns when it does not). |
| `host pause` | Stop hosting for now and keep the pairing: removes the guard's login service (and its `caffeinate`), turns off `tailscale serve`, ends the worker's leases, shuts down the emulators and simulators it created, stops the worker and removes its login service, so nothing starts at your next login. Records how the guard ran in `~/.tapdance/worker/paused.json`. The VPS cannot reach this machine until `resume`. |
| `host resume [--allow-admin-account] [--keep-awake]` | Start hosting again the way it ran before `pause` (the flags are remembered from `pause`; pass them when no pause was recorded, or use `host up` after `host down`). It checks the account before starting anything: reinstalls the worker's and the guard's login services (with `--allow-admin-account` / `--keep-awake` as before), resets stale device records, serves the guard on Tailscale again, and says whether the pairing token is still valid (if not: `host up --repair`, then `host token`). |
| `host warm <android=N,ios=M> [--now]` | Set how many booted spare devices the worker keeps, without re-running `host up`. Simlock reads this at start and a restart ends running leases, so it saves the setting and restarts the worker only when nothing is leased; otherwise it says it applies at the next `worker restart`. `--now` restarts anyway (ending running leases). |
| `host warm default [--now]` | Back to Simlock's default: one booted spare of each device kind a lease used (learned from leases). Removes the `warmPool.enabled` and `warmPool.reserveRunning.*` keys `host warm` wrote to `~/.simlock/config.json` and restarts like `host warm`. |
| `host warm` | Show the warm-spare setting (Simlock's default, set by `host warm`, or off) and the spares the worker keeps now, with how many are ready. |
| `host builds enable --repo <url>… [--git-auth gh\|deploy-key\|none] [--protected-ref <branch>]… [--timeout-minutes <n>] [--gradle-idle-minutes <n>] [--no-check] [--allow-admin-account]` / `host builds disable [--repo <url>]…` / `host builds status [--check]` / `host builds key [--repo <url>] [--remove]` | Let the agent build apps on this machine from allow-listed git repositories ([Builds on the host](deployment/one-command-host.md#builds-on-the-host)). Off by default. `enable` adds to the allow-list and sets `--git-auth` for every repository on it, then checks that this machine can read each `--repo` with that auth (`git ls-remote <url> HEAD` with the same key or `gh`) and prints a warning with the fix when it cannot; `--no-check` skips that, for offline setup. `--gradle-idle-minutes` sets how long an idle Gradle and Kotlin daemon of an Android build stays alive (default 10; 0 builds with `--no-daemon`). `disable` turns builds off and keeps the list; `disable --repo <url>` removes that URL from the list and leaves builds on (the ssh and https URLs of a repository are separate entries). `key` creates a read-only deploy key and prints its public half and fingerprint; with `--repo` the key is for that repository only and its ssh builds use it whatever `--git-auth` says (GitHub accepts a deploy key on one repository). `key --remove` deletes the key (with `--repo`, that repository's; without, the shared one) and prints its fingerprint so you delete it on GitHub too. `status` lists each repository with its deploy key (`not used (https)` next to an https URL) and number of build files; `--check` adds whether this machine can read it. Output keeps the repository's case as you typed it. `enable` and `disable` restart the guard when no lease is running. See [private repositories](guides/private-repositories.md). |
| `host builds files add --repo <url> <path-in-repo> [--from <file>]` / `host builds files list [--repo <url>]` / `host builds files remove --repo <url> <path-in-repo>` | Build files: config a repository keeps out of git (`google-services.json`, `local.properties`, `.env`), copied into the checkout before each build of that repository and removed after it. `add` reads `--from` or stdin (at most 1 MB, 50 files per repository) and refuses absolute paths, `..`, `.git` and `.gitmodules`; `list` shows path, size and the start of the sha256, never the content. Owner-only: no guard route or MCP tool reads or writes them. |
| `host artifacts enable --repo <owner/repo>… [--branch <name>]… [--max-mb <n>] [--no-check]` / `host artifacts disable [--repo <owner/repo>]…` / `host artifacts status [--check]` | Let the agent install apps your CI built (`app install --from-ci`: Android APKs, iOS simulator `.app`s): this machine downloads the GitHub Actions artifact with its own `gh` login (use a fine-grained, read-only token: Actions: read, Contents: read) and installs it on the agent's lease (an APK on Android, a simulator `.app` on iOS). Off by default (`allow.artifacts` and `artifacts` in the guard policy). `--branch` limits installs to runs on those branches (it replaces the list); forks' runs are never used. `--max-mb` caps the artifact and APK size (default 512). `enable` then checks that `gh` can read each `--repo` and list its Actions artifacts and warns with the fix when it cannot (`--no-check` skips it). `disable --repo` removes repositories from the list and leaves installs from CI on. `status` shows the allow-list, the download cache (newest 3 per repository) and whether `gh` is signed in; `--check` also tries each repository. `enable` and `disable` restart the guard when no lease is running. Ran for Android on a Google Cloud N2 host ([evidence](testing/evidence/2026-11-03-gcp-n2-android.md)); iOS is unit-tested only (F-05). |
| `host gh-login` | Logs this machine's `gh` in to github.com with a token it reads with echo off at the terminal (or from stdin: `tapdance host gh-login < token-file`), for builds with `--git-auth gh` and installs from CI. The token goes to `gh auth login --with-token` on stdin and is never printed; `gh auth login --with-token` alone echoes a pasted token over `ssh -t` (#122). Then it runs `gh auth status`. Ran on a rented Mac mini with the token piped over ssh stdin; `host status` then showed `gh` ok ([evidence](testing/evidence/2026-11-07-vps-rented-mac-ios.md)). |
| `host token [--label <name>] [--copy \| --show]` | Hand the pairing token over: copies it to the clipboard (`pbcopy`, `wl-copy`/`xclip`/`xsel`) by default (over ssh it refuses with `USAGE`, since the clipboard would be the host's: `scp` the file or use `--show`); `--show` prints it once with a warning. Prints a 6-character fingerprint (SHA-256) that `connect` prints too, so both sides can check they hold the same token without showing it. `host up` also offers to copy it at the end. |
| `host down [--revoke] [--all] [-y, --yes]` | Remove the guard service and `tailscale serve` for the guard's port, after a confirmation (`--yes` skips it; required without a terminal). `--revoke` also revokes every guard token and deletes the pairing token files. `--all` is everything: `--revoke`, plus end the worker's leases, shut down the devices it created, stop it and remove its login service. Without `--all` the worker keeps running. To come back later without re-pairing, use `host pause` / `host resume` instead. |

### `connect`

```text
tapdance connect <endpoint> < pairing-<label>.token
```

On the agent's machine (macOS, Linux or Windows): first checks that `<endpoint>/v1/healthz` answers
(two tries, 15 s each) and saves nothing if it does not; an `http://` address that the guard now serves
over HTTPS fails with the `https://` command to use. Then it reads the guard token from stdin (or a hidden
prompt; never from argv), sets `provider: "self-hosted"` and the endpoint in `~/.tapdance/config.json`
(other keys kept), saves the token to `~/.tapdance/credentials.json` (mode 600) bound to the endpoint's
origin, runs `doctor` without host checks, and prints MCP setup for Claude Code, Codex and Cursor
(`tapdance mcp`, or absolute Node.js and CLI paths when `tapdance` is not on `PATH`). Warns when the
current directory's `tapdance.config.json` or `TAPDANCE_ENDPOINT` overrides the endpoint. Exit 10 when a
check fails. Plain `http://` is accepted only for private addresses.

## External tools

See [tools.md](tools.md) for how pass-through, discovery and read-only policy work.

### `tools`

| Command | Meaning |
| --- | --- |
| `tools` / `tools list` | Table of registered tools: installed or missing, version, where it runs, homepage. |
| `tools doctor` | Per tool: description, where it runs, license, discovery commands, install command when missing, notes. |
| `tools versions` | Same table as `tools list`. |

### `tool`, `asc`, `android`

```text
tapdance tool <name> [--target <target>] [--timeout <seconds>] -- <tool arguments>
tapdance asc     [--target <target>] [--timeout <seconds>] -- <asc arguments>
tapdance android [--target <target>] [--timeout <seconds>] -- <android arguments>
```

Runs the installed executable with the arguments after `--` unchanged (an argument array, never a
shell). Output streams to your terminal; with `--json` it is captured and returned as JSON instead.
Tapdance exits with the tool's own exit code. `--target` accepts only `control` (this machine) today;
anything else is `NOT_SUPPORTED`. `--timeout` defaults to 600 s.

```bash
tapdance asc -- --help
tapdance --json asc -- apps list --output json
tapdance tool maestro -- test flows/login.yaml
```

From the CLI, a human is in charge: `asc` runs without Tapdance forcing read-only mode. The read-only
policy applies to agents calling `execute_tool` over MCP.

## Agents

### `mcp`

```text
tapdance mcp [--http] [--host <host>] [--port <port>]
```

Runs the MCP server. stdio by default. `--http` serves Streamable HTTP on `--host` (default
`127.0.0.1`) and `--port` (default `4711`) at `/mcp`, behind a bearer token: `TAPDANCE_MCP_TOKEN` if set,
otherwise a random token printed once on stderr. Global `--config` and `--session` apply to stdio. See
[mcp.md](mcp.md).

## Feedback

### `report`

```text
tapdance report [--title <text>] [--kind <bug|missing-feature|docs|field-test>] [--steps <text>]
                [--expected <text>] [--actual <text>] [--evidence <paths>] [-o, --output <file>]
```

Writes a redacted, issue-ready Markdown report: your text, Tapdance/Simlock/agent-device/Node versions,
OS, provider, endpoint host, session source, the current lease, and the `doctor` results. With
`--output` it writes a file for `gh issue create --body-file`. Tokens are redacted, but read the text
before posting it anywhere.

## JSON output

With `--json`:

- The result is one JSON document on **stdout**. Secrets in it are redacted.
- Progress messages and warnings still go to **stderr** (silence them with `--quiet`).
- A Tapdance error is printed on **stdout** as
  `{"error": {"code", "message", "retryable", "retryAfterMs"?, "hint"?, "details"?}}`, and the exit code
  is set as in the table below.
- Argument errors caught by the parser itself (an unknown option, a missing required option) are plain
  text on stderr with exit code 2, even with `--json`.
- `gateway token --json` prints Simlock's token JSON, including the secret, on purpose.

Without `--json`, results are human-readable text on stdout, and errors are printed on stderr as
`error [CODE] message` plus a `fix:` line. Set `TAPDANCE_DEBUG=1` to also print the underlying stack, and
`NO_COLOR=1` to turn colours off.

## Exit codes

From `packages/core/src/errors.ts`:

| Exit | Codes | Typical cause |
| --- | --- | --- |
| 0 | | Success. |
| 1 | `INTERNAL` | Unexpected failure. Also: `ui wait` timed out (not an error code). |
| 2 | `USAGE`, `CONFIG_INVALID`, `APP_PATH_INVALID` | Bad arguments, invalid config, wrong app file type. Also parser errors. |
| 3 | `NO_ACTIVE_LEASE`, `LEASE_ALREADY_HELD`, `LEASE_LOST` | No lease yet, one already held, or the lease ended. |
| 4 | `PROVIDER_UNREACHABLE`, `PROVIDER_UNAVAILABLE`, `WORKER_OFFLINE` | Worker or gateway not answering, a missing capability or tool, the worker holding the device is offline. |
| 5 | `AUTH_FAILED`, `FORBIDDEN` | Missing, revoked or wrong token; an action this caller may not do. |
| 6 | `NO_CAPACITY`, `DEVICE_UNAVAILABLE` | No free device, unknown model, missing runtime or image. |
| 7 | `DEVICE_ERROR`, `ELEMENT_NOT_FOUND`, `APP_NOT_INSTALLED` | The device command failed; the target element is not on screen. (`APP_NOT_INSTALLED` is defined but not raised by the current provider.) |
| 8 | `NOT_SUPPORTED` | Not available in this setup (Tapdance Cloud, remote tool targets, AXe through a gateway). |
| 9 | `TIMEOUT` | No device granted in time, another Tapdance process busy with the session. |
| 10 | `HOST_CHECK_FAILED` | `doctor` found a failing check, or `worker check` found a KVM failure. (The code itself is defined; these commands set exit 10 directly.) |
| 11 | `HUMAN_HELD` | A person is controlling the device in the viewer. Retry after `retryAfterMs`. |
| 13 | `CANCELLED` | `device request-human` was cancelled (`--cancel` from another call, or Ctrl-C). |
| 12 | `SCENARIO_FAILED`, `ASSERTION_FAILED` | `run`: the scenario ran and a step failed. (`ASSERTION_FAILED` appears on a failed expectation inside the report, not as a command error.) |

Pass-through commands (`tool`, `asc`, `android`, `simlock`, `devices install`) exit with the wrapped
program's exit code.

These codes are **retryable by default** (the same call may succeed later without changes):
`PROVIDER_UNREACHABLE`, `WORKER_OFFLINE`, `NO_CAPACITY`, `HUMAN_HELD`, `TIMEOUT`. A lease the host
refuses with an internal error (Simlock's `INTERNAL`, for example `simctl` timing out on an overloaded
8 GB Mac) is `PROVIDER_UNAVAILABLE` and retryable too, and agent-device's "Daemon request timed out" (the
first iOS command after a cold lease on a small Mac) is a retryable `PROVIDER_UNREACHABLE`. Fixes for
each are in [troubleshooting.md](troubleshooting.md).

## Session identity

A session owns at most one lease, and its device calls run one at a time: a `ui tap` sent from a
second shell while `ui wait` or `ui sequence` runs starts when that call ends. To act during a long wait,
use `ui sequence` (it runs on the device) or `device shell` with an on-device `nohup` command.

Every CLI call and MCP server works out which session it belongs to, in this order:

| Order | Source | Session id |
| --- | --- | --- |
| 1 | `--session <id>` (CLI and stdio `mcp`) | `<id>` |
| 2 | `TAPDANCE_SESSION_ID` | its value |
| 3 | `CLAUDE_CODE_SESSION_ID` | `claude-code:<value>` |
| 4 | `CODEX_SESSION_ID` | `codex:<value>` |
| 5 | `PI_SESSION_ID` | `pi:<value>` |
| 6a | CLI fallback | a per-user id stored in `~/.tapdance/identity.json` (`cli:<user>-<random>`) |
| 6b | stdio MCP fallback | one id per server process (`mcp:<pid>-<random>`) |
| — | Streamable HTTP MCP | always one id per MCP client session (`mcp-http:<random>`); the rules above do not apply |

Ids outside `[A-Za-z0-9._:-]{1,128}` are replaced by a hash. The order of 3–5 matches Simlock's.

Consequences:

- Inside one Claude Code session, every `tapdance` call, sub-agents included, is the same session, and a
  CLI lease and the MCP tools see the same device.
- A person typing in several terminals is **one** session (one lease) unless each terminal sets
  `TAPDANCE_SESSION_ID` or passes `--session`.
- Codex and pi do not pass their session ids to MCP servers they start. Under them, the MCP server has
  its own per-process identity, separate from the CLI's. Use either the CLI or the MCP server within one
  agent session, or set the same `TAPDANCE_SESSION_ID` in both the shell and the MCP server config.
- When the MCP server shuts down, it releases only a lease that its own process created. A lease made
  by the CLI in the same session stays.
- `tapdance doctor` prints the session id and where it came from.

Session records live in `~/.tapdance/sessions/` (or `$TAPDANCE_HOME/sessions/`), one file per session
plus a lock file, so parallel processes of one session cannot lease twice.

<!-- BEGIN GENERATED COMMAND INDEX (pnpm docs:cli) -->

## Command index

Every command, with its exact `--help` output. Generated from the CLI; do not edit by hand.

### `tapdance init`

```text
Usage: tapdance init [options]

Create tapdance.config.json for this project (or ~/.tapdance/config.json with
--global)

Options:
  --mode <mode>      device infrastructure: local | self-hosted | cloud
  --endpoint <url>   self-hosted: Simlock gateway or worker URL, e.g.
                     https://gateway.example.com
  --artifacts <dir>  where screenshots, recordings and logs go (default:
                     "./tapdance-artifacts")
  --ttl <minutes>    default lease TTL (default: "30")
  --global           write the per-user config instead of the project one
  --force            overwrite an existing file
  -y, --yes          accept defaults, never prompt
  -h, --help         display help for command
```

### `tapdance doctor`

```text
Usage: tapdance doctor [options]

Check configuration, this machine, the worker/gateway, tokens and the current
lease

Options:
  --no-host   skip checks of this machine's SDKs and KVM
  -h, --help  display help for command
```

### `tapdance config`

```text
Usage: tapdance config [options] [command]

Show or change configuration and credentials

Options:
  -h, --help                   display help for command

Commands:
  show                         Print the merged configuration and where it came
                               from
  path                         Print config and credential file locations
  set [options] <key> <value>  Set a key in the nearest tapdance.config.json (or
                               --global), e.g. session.defaultTtlMinutes 45
  set-token [options]          Store the agent token (or --operator token) in
                               ~/.tapdance/credentials.json, mode 600. Reads
                               stdin or prompts.
  help [command]               display help for command
```

### `tapdance config show`

```text
Usage: tapdance config show [options]

Print the merged configuration and where it came from

Options:
  -h, --help  display help for command
```

### `tapdance config path`

```text
Usage: tapdance config path [options]

Print config and credential file locations

Options:
  -h, --help  display help for command
```

### `tapdance config set`

```text
Usage: tapdance config set [options] <key> <value>

Set a key in the nearest tapdance.config.json (or --global), e.g.
session.defaultTtlMinutes 45

Options:
  --global    edit the per-user config
  -h, --help  display help for command
```

### `tapdance config set-token`

```text
Usage: tapdance config set-token [options]

Store the agent token (or --operator token) in ~/.tapdance/credentials.json,
mode 600. Reads stdin or prompts.

Options:
  --operator        store an operator token (only needed for `workers list` on a
                    gateway)
  --endpoint <url>  the gateway or worker the token is for; Tapdance sends it
                    nowhere else (default: the configured self-hosted endpoint)
  -h, --help        display help for command
```

### `tapdance devices`

```text
Usage: tapdance devices [options] [command]

List device models you can lease and what is running

Options:
  -p, --platform <platform>               android or ios
  -h, --help                              display help for command

Commands:
  install [options] <platform> <version>  Install an iOS runtime or Android system image on this worker (several GB; Simlock never downloads on its own)
  list [options]                          Same as `tapdance devices`
```

### `tapdance devices install`

```text
Usage: tapdance devices install [options] <platform> <version>

Install an iOS runtime or Android system image on this worker (several GB;
Simlock never downloads on its own)

Options:
  --image-tag <tag>  Android: another image than google_apis
                     (google_apis_playstore, google_atd, aosp_atd); installed
                     with the SDK's sdkmanager
  -h, --help         display help for command
```

### `tapdance devices list`

```text
Usage: tapdance devices list [options]

Same as `tapdance devices`

Options:
  -p, --platform <platform>  android or ios
  -h, --help                 display help for command
```

### `tapdance workers`

```text
Usage: tapdance workers [options] [command]

Machines that run devices (this machine, laptops, cloud VMs) and whether they
are online

Options:
  -h, --help      display help for command

Commands:
  list            List workers
  help [command]  display help for command
```

### `tapdance workers list`

```text
Usage: tapdance workers list [options]

List workers

Options:
  -h, --help  display help for command
```

### `tapdance device`

```text
Usage: tapdance device [options] [command]

Lease, inspect and release this session's device

Options:
  -h, --help                        display help for command

Commands:
  lease [options]                   Lease one emulator or simulator for this
                                    session
  request-human [options]           Ask a person to do something on the device
                                    (sign in, approve a purchase, solve a
                                    check); waits until they hand back, or
                                    returns at once with --no-wait
  clipboard <action> [text]         Read (get) or write (set <text>) the device
                                    clipboard: paste flows, checking what a Copy
                                    button copied
  storekit [action] [file]          Not available: StoreKit configuration files
                                    need Xcode's scheme; says what to use
                                    instead
  links [options]                   Links apps asked the system to open lately
                                    (mailto:, App Store, Settings, web): scheme,
                                    URL and whether anything opened it; checks a
                                    link-out on a simulator without Mail
  crashes [options]                 iOS: list the leased simulator's crash
                                    reports (.ips) since the lease began, or
                                    pull one with a summary of the crashed
                                    thread
  done                              Tell the agent you finished what it asked
                                    for (request_human), e.g. after signing in
  profile                           Device profiles: an emulator you set up once
                                    (signed in, configured) that leases boot
                                    from
  status                            Show this session's device and lease
  renew [options]                   Extend this session's lease now
  release                           Release this session's device (it is wiped)
  setting [options] <name> [value]  Change (or, without a value, read) a device
                                    setting: wifi, bluetooth, airplane,
                                    mobile-data, location, animations,
                                    appearance, text-size, faceid, touchid,
                                    fingerprint, permission, reset-keychain,
                                    orientation, status-bar-time,
                                    browser-first-run, language. Values: on|off
                                    for the switches; appearance
                                    light|dark|toggle; orientation
                                    portrait|landscape|landscape-left|landscape-right|portrait-upside-down;
                                    browser-first-run off. The iOS simulator's
                                    clock is the Mac's and cannot be set
  push [options] <path>             Copy a file onto the device (Android shared
                                    storage or a debuggable app's sandbox; iOS
                                    Photos, the Files app, or an app's
                                    Documents)
  pull [options] [devicePath]       Copy a file from the device into this
                                    session's artifacts
  notifications [options] <action>  list | open | close | post | tap
                                    notifications on the device (tap --text
                                    opens one the way a person does)
  shell [options] <command...>      Android emulators: run a command with `adb
                                    shell` inside the leased emulator (not on
                                    this machine)
  perf [options] <metric>           Measure frames (frame health since the last
                                    reading) or memory
  help [command]                    display help for command
```

### `tapdance device lease`

```text
Usage: tapdance device lease [options]

Lease one emulator or simulator for this session

Options:
  -p, --platform <platform>  android or ios
  -d, --device <model>       model, e.g. "Pixel 8" or "iPhone 16"
  --os <version>             OS version or range (Android: API level)
  --image-tag <tag>          Android system image tag; leave it out for normal
                             testing (google_apis, lighter).
                             google_apis_playstore only when the test needs the
                             Play Store (billing, Play sign-in)
  --physical                 lease an enrolled physical device instead
  --profile <name>           boot a device profile from this machine (read-only:
                             the lease's changes are discarded)
  --ttl <minutes>            lease time to live in minutes
  --wait <seconds>           how long to wait in the queue
  --settle <seconds>         Android emulator: how long to check the guest's CPU
                             after boot before handing it out, 0-300 (0 skips
                             the check)
  --no-keepalive             do not renew in the background (the lease expires
                             after its TTL)
  --hold                     stay in the foreground, renew, and release on
                             Ctrl-C
  -h, --help                 display help for command
```

### `tapdance device request-human`

```text
Usage: tapdance device request-human [options]

Ask a person to do something on the device (sign in, approve a purchase, solve a
check); waits until they hand back, or returns at once with --no-wait

Options:
  --reason <text>   what the person should do; shown in the viewer
  --wait <seconds>  how long to wait (10-1800) (default: "600")
  --no-wait         open the request and return; `device status` shows whether
                    it was handed back
  --cancel          withdraw the open request (a waiting request-human exits 13)
  -h, --help        display help for command
```

### `tapdance device clipboard`

```text
Usage: tapdance device clipboard [options] <action> [text]

Read (get) or write (set <text>) the device clipboard: paste flows, checking
what a Copy button copied

Options:
  -h, --help  display help for command
```

### `tapdance device storekit`

```text
Usage: tapdance device storekit [options] [action] [file]

Not available: StoreKit configuration files need Xcode's scheme; says what to
use instead

Options:
  -h, --help  display help for command
```

### `tapdance device links`

```text
Usage: tapdance device links [options]

Links apps asked the system to open lately (mailto:, App Store, Settings, web):
scheme, URL and whether anything opened it; checks a link-out on a simulator
without Mail

Options:
  --minutes <n>  how far back to look (1-30) (default: "5")
  -h, --help     display help for command
```

### `tapdance device crashes`

```text
Usage: tapdance device crashes [options]

iOS: list the leased simulator's crash reports (.ips) since the lease began, or
pull one with a summary of the crashed thread

Options:
  --app <appId>        only this app's reports
  --pull <name>        save this report (a name from the list, or latest)
  -o, --output <path>  where to save the pulled report
  -h, --help           display help for command
```

### `tapdance device done`

```text
Usage: tapdance device done [options]

Tell the agent you finished what it asked for (request_human), e.g. after
signing in

Options:
  -h, --help  display help for command
```

### `tapdance device profile`

```text
Usage: tapdance device profile [options] [command]

Device profiles: an emulator you set up once (signed in, configured) that leases
boot from

Options:
  -h, --help               display help for command

Commands:
  create [options] <name>  Create a profile (Android emulator or iOS simulator),
                           then open it to set up (sign in, settings) and save
  edit <name>              Open the profile writable with a window; what you do
                           is kept when you close it
  list                     List device profiles on this machine
  delete <name>            Delete a profile and its emulator data
  help [command]           display help for command
```

### `tapdance device profile create`

```text
Usage: tapdance device profile create [options] <name>

Create a profile (Android emulator or iOS simulator), then open it to set up
(sign in, settings) and save

Options:
  -p, --platform <platform>  android or ios (default: "android")
  --image-tag <tag>          Android system image tag (default:
                             "google_apis_playstore")
  --os <version>             Android API level or iOS version (default: the
                             newest installed)
  --device <model>           avdmanager device id (Android, default pixel_8) or
                             simulator model (iOS, default "iPhone 16")
  --no-edit                  only create it; set it up later with `device
                             profile edit`
  -h, --help                 display help for command
```

### `tapdance device profile edit`

```text
Usage: tapdance device profile edit [options] <name>

Open the profile writable with a window; what you do is kept when you close it

Options:
  -h, --help  display help for command
```

### `tapdance device profile list`

```text
Usage: tapdance device profile list [options]

List device profiles on this machine

Options:
  -h, --help  display help for command
```

### `tapdance device profile delete`

```text
Usage: tapdance device profile delete [options] <name>

Delete a profile and its emulator data

Options:
  -h, --help  display help for command
```

### `tapdance device status`

```text
Usage: tapdance device status [options]

Show this session's device and lease

Options:
  -h, --help  display help for command
```

### `tapdance device renew`

```text
Usage: tapdance device renew [options]

Extend this session's lease now

Options:
  --ttl <minutes>  new time to live in minutes
  -h, --help       display help for command
```

### `tapdance device release`

```text
Usage: tapdance device release [options]

Release this session's device (it is wiped)

Options:
  -h, --help  display help for command
```

### `tapdance device setting`

```text
Usage: tapdance device setting [options] <name> [value]

Change (or, without a value, read) a device setting: wifi, bluetooth, airplane,
mobile-data, location, animations, appearance, text-size, faceid, touchid,
fingerprint, permission, reset-keychain, orientation, status-bar-time,
browser-first-run, language. Values: on|off for the switches; appearance
light|dark|toggle; orientation
portrait|landscape|landscape-left|landscape-right|portrait-upside-down;
browser-first-run off. The iOS simulator's clock is the Mac's and cannot be set

Options:
  --app <appId>              the app a permission or locale applies to
  --permission <permission>  for `setting permission <grant|deny|reset>`:
                             camera, microphone, photos, notifications,
                             location…
  --lat <latitude>           for `setting location`: move the device here
  --lon <longitude>          for `setting location`
  -h, --help                 display help for command
```

### `tapdance device push`

```text
Usage: tapdance device push [options] <path>

Copy a file onto the device (Android shared storage or a debuggable app's
sandbox; iOS Photos, the Files app, or an app's Documents)

Options:
  --to <destination>  downloads, pictures, documents, app_sandbox, or files
                      (iOS: Files › On My iPhone, seen by document pickers)
  --app <appId>       app for app_sandbox (and iOS documents)
  --name <name>       file name on the device
  -h, --help          display help for command
```

### `tapdance device pull`

```text
Usage: tapdance device pull [options] [devicePath]

Copy a file from the device into this session's artifacts

Options:
  --app <appId>          read from this app's sandbox/container
  --path <relativePath>  with --app: path inside it, e.g. files/export.json or
                         Documents/export.json
  --files <name>         iOS: a file in Files › On My iPhone
  -o, --out <file>       write here instead of the artifacts directory
  -h, --help             display help for command
```

### `tapdance device notifications`

```text
Usage: tapdance device notifications [options] <action>

list | open | close | post | tap notifications on the device (tap --text opens
one the way a person does)

Options:
  --app <appId>     filter (list) or the app a push payload goes to (post)
  --title <title>   post: title
  --text <text>     post: body; tap: text of the notification to open
  --payload <json>  post: a push payload (APNs-style JSON) delivered to --app
  -h, --help        display help for command
```

### `tapdance device shell`

```text
Usage: tapdance device shell [options] <command...>

Android emulators: run a command with `adb shell` inside the leased emulator
(not on this machine)

Options:
  --stdin <file>       pass this text file on stdin (binary: base64 it and
                       decode on the device with `base64 -d`)
  --timeout <seconds>  default 120
  -h, --help           display help for command
```

### `tapdance device perf`

```text
Usage: tapdance device perf [options] <metric>

Measure frames (frame health since the last reading) or memory

Options:
  --app <appId>  app to measure (default: the foreground app)
  -h, --help     display help for command
```

### `tapdance app`

```text
Usage: tapdance app [options] [command]

Install, launch and stop apps on the leased device

Options:
  -h, --help                display help for command

Commands:
  install [options] [path]  Upload and install an app: Android .apk or .aab (an
                            .aab becomes a universal APK with bundletool on this
                            machine); iOS simulator .app bundle, or a .zip or
                            .tar holding one (.ipa on a physical iPhone only).
                            With --from-ci instead of a path: the device's host
                            downloads the app from a GitHub Actions artifact
                            with its own credentials and installs it (an Android
                            APK, or an iOS simulator .app)
  launch [options] <appId>  Launch an installed app
  uninstall <appId>         Remove an installed app
  clear <appId>             Clear an app's data (first-launch state); iOS also:
                            device setting reset-keychain
  build [options]           Build the app on the machine that runs the leased
                            device, from a git repository its owner
                            allow-listed, and install it there (an agent without
                            Xcode can test iOS)
  kill <appId>              End an app the way a user does (Home, then gone;
                            alarms and jobs kept, unlike stop) and check its
                            process is gone
  stop <appId>              Force-stop an app (also cancels its alarms and jobs
                            on Android; `app kill` ends it like a user)
  list                      List apps the automation backend sees
  help [command]            display help for command
```

### `tapdance app install`

```text
Usage: tapdance app install [options] [path]

Upload and install an app: Android .apk or .aab (an .aab becomes a universal APK
with bundletool on this machine); iOS simulator .app bundle, or a .zip or .tar
holding one (.ipa on a physical iPhone only). With --from-ci instead of a path:
the device's host downloads the app from a GitHub Actions artifact with its own
credentials and installs it (an Android APK, or an iOS simulator .app)

Options:
  --app-id <id>      package / bundle id, when the backend needs it
  --from-ci <repo>   install from the user's CI instead of a path (an APK, or an
                     iOS simulator .app): a GitHub repository (owner/repo or
                     URL) on the host's allow-list (`tapdance host artifacts
                     enable`)
  --artifact <name>  with --from-ci: the artifact's name
                     (actions/upload-artifact name)
  --run <id>         with --from-ci: the workflow run id (default: the newest
                     successful run on --branch)
  --branch <name>    with --from-ci: take the newest successful run on this
                     branch (default: the repository's default branch)
  --launch <appId>   launch this app once it is installed
  -h, --help         display help for command
```

### `tapdance app launch`

```text
Usage: tapdance app launch [options] <appId>

Launch an installed app

Options:
  --relaunch                      kill and restart it
  --url <url>                     deep link to open
  --arg <arg>                     launch argument passed to the app (repeatable;
                                  implies --relaunch)
  --intent-action <action>        Android: start an explicit intent with this
                                  action
  --intent-data <uri>             Android: intent data URI
  --intent-component <component>  Android: component, e.g.
                                  com.example/.MainActivity
  --intent-extra <key=value>      Android: string extra (repeatable)
  --locale <locale>               run the app in this language, e.g. de-DE (iOS:
                                  launch arguments; Android 13+: the app's own
                                  locale)
  --console                       iOS: relaunch with the app's stdout/stderr
                                  (print, println) captured; `logs --app` then
                                  includes them
  -h, --help                      display help for command
```

### `tapdance app uninstall`

```text
Usage: tapdance app uninstall [options] <appId>

Remove an installed app

Options:
  -h, --help  display help for command
```

### `tapdance app clear`

```text
Usage: tapdance app clear [options] <appId>

Clear an app's data (first-launch state); iOS also: device setting
reset-keychain

Options:
  -h, --help  display help for command
```

### `tapdance app build`

```text
Usage: tapdance app build [options]

Build the app on the machine that runs the leased device, from a git repository
its owner allow-listed, and install it there (an agent without Xcode can test
iOS)

Options:
  --git <url>                  repository URL (must be on the host's build
                               allow-list)
  --ref <ref>                  branch, tag or commit sha; the reply names the
                               exact commit built
  --project <path>             iOS: .xcodeproj or .xcworkspace inside the
                               repository (found when there is only one)
  --scheme <name>              iOS: Xcode scheme (default: the project's name)
  --configuration <name>       iOS: build configuration (default: "Debug")
  --gradle-task <task>         Android: Gradle task (default: "assembleDebug")
  --dir <path>                 Android: folder with gradlew inside the
                               repository
  --xcode-setting <KEY=VALUE>  iOS: extra build setting, repeatable (ARCHS,
                               EXCLUDED_ARCHS, ONLY_ACTIVE_ARCH,
                               SWIFT_ACTIVE_COMPILATION_CONDITIONS,
                               KOTLIN_FRAMEWORK_BUILD_TYPE and a few more)
                               (default: [])
  --launch <appId>             launch this app once it is installed
  --verbose                    show every build log line (default: steps, errors
                               and the outcome)
  -h, --help                   display help for command
```

### `tapdance app kill`

```text
Usage: tapdance app kill [options] <appId>

End an app the way a user does (Home, then gone; alarms and jobs kept, unlike
stop) and check its process is gone

Options:
  -h, --help  display help for command
```

### `tapdance app stop`

```text
Usage: tapdance app stop [options] <appId>

Force-stop an app (also cancels its alarms and jobs on Android; `app kill` ends
it like a user)

Options:
  -h, --help  display help for command
```

### `tapdance app list`

```text
Usage: tapdance app list [options]

List apps the automation backend sees

Options:
  -h, --help  display help for command
```

### `tapdance ui`

```text
Usage: tapdance ui [options] [command]

Inspect and drive the leased device's UI

Options:
  -h, --help                 display help for command

Commands:
  audit [options]            Accessibility audit of the screen: unlabelled
                             controls, small touch targets, controls announced
                             alike, unlabelled images (what VoiceOver or
                             TalkBack would trip over)
  inspect [options]          List on-screen elements with refs, roles and labels
  tap [options] [ref]        Tap one element (a ref from `ui inspect` may be
                             given as the argument: `ui tap @e7`)
  swipe [options]            Swipe by finger direction (up scrolls content down)
                             or between two points
  type [options] <text>      Type text; with a target, replace that field's
                             content
  wait [options]             Wait for text to appear (--text), disappear
                             (--absent), or the UI to settle (--stable)
  alert <action>             Read (get) or answer (accept, dismiss) a system
                             alert
  sequence [options] <file>  Run timed taps (rhythm and timing games): a JSON
                             list of {t, x, y, hold?} with t in ms from the
                             start; Android inside the emulator, iOS through the
                             simulator's touch input on the host
  key <key>                  Press back, home, enter, dismiss_keyboard or
                             app_switcher
  help [command]             display help for command
```

### `tapdance ui audit`

```text
Usage: tapdance ui audit [options]

Accessibility audit of the screen: unlabelled controls, small touch targets,
controls announced alike, unlabelled images (what VoiceOver or TalkBack would
trip over)

Options:
  --app <appId>  audit this app instead of the session's (switches to it as it
                 is)
  -h, --help     display help for command
```

### `tapdance ui inspect`

```text
Usage: tapdance ui inspect [options]

List on-screen elements with refs, roles and labels

Options:
  --all          include non-interactive elements
  --compact      leave out unlabelled containers (useful with --all on Compose
                 or SwiftUI screens)
  --bounds       show each element's position and size in pixels (x,y w×h);
                 --json always includes them as rect
  --system       Android: every window as the system sees it (uiautomator), e.g.
                 a Chrome Custom Tab and its URL, or a system picker; refs are
                 not tappable
  --app <appId>  switch to this app as it is (no relaunch) and read it, e.g.
                 com.apple.mobilesafari after a link-out; later reads stay on it
                 until you launch yours
  -h, --help     display help for command
```

### `tapdance ui tap`

```text
Usage: tapdance ui tap [options] [ref]

Tap one element (a ref from `ui inspect` may be given as the argument: `ui tap
@e7`)

Options:
  --text <text>          visible text or accessibility label
  --id <id>              accessibility identifier / resource id
  --ref <ref>            ref from `ui inspect`, e.g. @e7
  --selector <selector>  agent-device selector
  --x <x>                x coordinate (fallback)
  --y <y>                y coordinate (fallback)
  --no-settle            do not wait for the UI to settle
  --settle-ms <ms>       also wait up to this long for the UI to come to rest
                         and report whether the screen changed (a tap that
                         auto-advances)
  --inject               Android: tap with a raw input event (`input tap`) at
                         the element's centre, for system screens that ignore
                         normal taps
  -h, --help             display help for command
```

### `tapdance ui swipe`

```text
Usage: tapdance ui swipe [options]

Swipe by finger direction (up scrolls content down) or between two points

Options:
  --direction <dir>    up, down, left or right
  --amount <fraction>  0.1–0.8 of the screen
  --until <text>       with --direction: keep scrolling until this text is
                       visible
  --from <x,y>         start point
  --to <x,y>           end point
  -h, --help           display help for command
```

### `tapdance ui type`

```text
Usage: tapdance ui type [options] <text>

Type text; with a target, replace that field's content

Options:
  --text <text>          visible text or accessibility label
  --id <id>              accessibility identifier / resource id
  --ref <ref>            ref from `ui inspect`, e.g. @e7
  --selector <selector>  agent-device selector
  --x <x>                x coordinate (fallback)
  --y <y>                y coordinate (fallback)
  --delay-ms <ms>        pause between keystrokes, for fields that drop fast
                         input (a fill that drops characters is retried once at
                         80 ms on its own)
  -h, --help             display help for command
```

### `tapdance ui wait`

```text
Usage: tapdance ui wait [options]

Wait for text to appear (--text), disappear (--absent), or the UI to settle
(--stable)

Options:
  --text <text>
  --absent <text>
  --stable
  --timeout <ms>   milliseconds, at most 600000 (10 minutes) (default: "10000")
  -h, --help       display help for command
```

### `tapdance ui alert`

```text
Usage: tapdance ui alert [options] <action>

Read (get) or answer (accept, dismiss) a system alert

Options:
  -h, --help  display help for command
```

### `tapdance ui sequence`

```text
Usage: tapdance ui sequence [options] <file>

Run timed taps (rhythm and timing games): a JSON list of {t, x, y, hold?} with t
in ms from the start; Android inside the emulator, iOS through the simulator's
touch input on the host

Options:
  --start-on-text <text>  wait for this text first, then start
  --offset-ms <ms>        start this long after the text appeared (or after now)
                          (default: "0")
  --wait <seconds>        how long to wait for --start-on-text (default: "60")
  --orientation <o>       iOS: which way the device is turned when the app
                          forces landscape (landscape-left, the default for a
                          landscape screen, or landscape-right)
  -h, --help              display help for command
```

### `tapdance ui key`

```text
Usage: tapdance ui key [options] <key>

Press back, home, enter, dismiss_keyboard or app_switcher

Options:
  -h, --help  display help for command
```

### `tapdance screenshot`

```text
Usage: tapdance screenshot [options]

Save a PNG of the screen (artifacts dir by default)

Options:
  -o, --output <path>  where to write the PNG
  --note <text>        what it shows
  -h, --help           display help for command
```

### `tapdance record`

```text
Usage: tapdance record [options] [command]

Record the screen to MP4

Options:
  -h, --help       display help for command

Commands:
  start [options]
  stop [options]
  help [command]   display help for command
```

### `tapdance record start`

```text
Usage: tapdance record start [options]

Options:
  -o, --output <path>  where to write the MP4
  -h, --help           display help for command
```

### `tapdance record stop`

```text
Usage: tapdance record stop [options]

Options:
  -o, --output <path>  ignored: the path is chosen at start
  -h, --help           display help for command
```

### `tapdance logs`

```text
Usage: tapdance logs [options]

Recent device logs (logcat / simulator log), saved as an artifact

Options:
  -n, --lines <n>    how many lines (at most 20000); with a filter, how many
                     matching lines (default: "200")
  --app <id>         only this app
  --crash            crash buffer / faults only
  --contains <text>  only lines containing this text (case-insensitive); on
                     Android searches the whole logcat buffer
  --level <level>    only error lines (error) or faults and crashes (fault)
  -h, --help         display help for command
```

### `tapdance artifacts`

```text
Usage: tapdance artifacts [options]

Screenshots, recordings and logs from this session

Options:
  -h, --help  display help for command
```

### `tapdance run`

```text
Usage: tapdance run [options] <file>

Replay a scenario file (.yaml or .json) on this session's device and report
PASS/FAIL with evidence

Options:
  --keep-lease           keep a device the scenario leased instead of releasing
                         it at the end
  --continue-on-failure  run every step even after one fails
  -h, --help             display help for command
```

### `tapdance worker`

```text
Usage: tapdance worker [options] [command]

Run this machine as a device worker (your laptop, a Mac, a KVM server)

Options:
  -h, --help         display help for command

Commands:
  guard              Device-only access for remote agents: the only endpoint
                     they reach on this machine, enforcing a local policy
  check [options]    Check this machine can run emulators/simulators: SDKs,
                     images, KVM, Xcode
  install [options]  Configure the bundled Simlock worker: agent-device, live
                     streaming and input on; then start it
  login [options]    Join a gateway: the worker dials out over an authenticated
                     WebSocket; no inbound port is opened
  logout             Leave the gateway and serve local agents only
  start              Start the worker daemon
  stop               Stop the worker: end its leases, stop the daemon and shut
                     down the emulators and simulators it created
  status             Show the worker's devices, leases and capabilities
  logs [options]     Print the worker daemon log (the last 100 lines unless -n
                     says otherwise), optionally filtered
  cleanup            Release device claims left by agent-device processes that
                     have gone (a worker restart, the machine going offline
                     mid-lease); live owners are never touched
  restart [options]  Restart the worker daemon (ends agent-device sessions on
                     it; a login service left from an older Tapdance is
                     installed again); refuses while leases run unless --force
  help [command]     display help for command
```

### `tapdance worker guard`

```text
Usage: tapdance worker guard [options] [command]

Device-only access for remote agents: the only endpoint they reach on this
machine, enforcing a local policy

Options:
  -h, --help         display help for command

Commands:
  start [options]    Serve the device-only API (loopback by default; expose it
                     with Tailscale, never publicly)
  install [options]  Keep the guard running: a LaunchAgent (macOS) or systemd
                     user unit (Linux) that starts it at login and restarts it
  uninstall          Stop the guard service and remove its LaunchAgent / systemd
                     user unit (tokens and policy are kept)
  pair [options]     Approve a control machine locally: prints a revocable
                     device-only token once
  tokens             List paired control machines
  revoke <id>        Revoke a paired control machine immediately (or `all`)
  policy             Show the local policy and its file
  audit [options]    Show recent remote requests and decisions
  help [command]     display help for command
```

### `tapdance worker guard start`

```text
Usage: tapdance worker guard start [options]

Serve the device-only API (loopback by default; expose it with Tailscale, never
publicly)

Options:
  --allow-admin-account  run even though this account is an administrator (not
                         recommended)
  -h, --help             display help for command
```

### `tapdance worker guard install`

```text
Usage: tapdance worker guard install [options]

Keep the guard running: a LaunchAgent (macOS) or systemd user unit (Linux) that
starts it at login and restarts it

Options:
  --allow-admin-account  run even though this account is an administrator (not
                         recommended)
  --keep-awake           macOS: run the guard under `caffeinate -i` so idle
                         sleep does not take it offline
  -h, --help             display help for command
```

### `tapdance worker guard uninstall`

```text
Usage: tapdance worker guard uninstall [options]

Stop the guard service and remove its LaunchAgent / systemd user unit (tokens
and policy are kept)

Options:
  -h, --help  display help for command
```

### `tapdance worker guard pair`

```text
Usage: tapdance worker guard pair [options]

Approve a control machine locally: prints a revocable device-only token once

Options:
  --label <name>   who it is for, e.g. hetzner-vps
  --days <n>       lifetime in days (policy maximum applies)
  --scope <areas>  limit this token to these policy areas, e.g.
                   interaction,inspection,screenshots (default: everything the
                   policy allows)
  -h, --help       display help for command
```

### `tapdance worker guard tokens`

```text
Usage: tapdance worker guard tokens [options]

List paired control machines

Options:
  -h, --help  display help for command
```

### `tapdance worker guard revoke`

```text
Usage: tapdance worker guard revoke [options] <id>

Revoke a paired control machine immediately (or `all`)

Options:
  -h, --help  display help for command
```

### `tapdance worker guard policy`

```text
Usage: tapdance worker guard policy [options]

Show the local policy and its file

Options:
  -h, --help  display help for command
```

### `tapdance worker guard audit`

```text
Usage: tapdance worker guard audit [options]

Show recent remote requests and decisions

Options:
  -n, --lines <n>  how many (default: "50")
  -h, --help       display help for command
```

### `tapdance worker check`

```text
Usage: tapdance worker check [options]

Check this machine can run emulators/simulators: SDKs, images, KVM, Xcode

Options:
  --android-only  skip iOS checks
  -h, --help      display help for command
```

### `tapdance worker install`

```text
Usage: tapdance worker install [options]

Configure the bundled Simlock worker: agent-device, live streaming and input on;
then start it

Options:
  --no-stream              leave screen streaming and input off
  --ios-backend <backend>  agent-device (default; works through gateways) or axe
                           (Tapdance on this Mac only) (default: "agent-device")
  --service                also install it as a login service (launchd / systemd
                           --user)
  -h, --help               display help for command
```

### `tapdance worker login`

```text
Usage: tapdance worker login [options]

Join a gateway: the worker dials out over an authenticated WebSocket; no inbound
port is opened

Options:
  --gateway <url>        gateway address, e.g. wss://gateway.example.com
  --label <name>         name shown in `tapdance workers list`
  --token-stdin          read the join token from stdin (default when stdin is
                         piped)
  --no-viewer            leave live streaming and remote input off
  --accept-gateway-exec  acknowledge that a joined gateway (and its agent
                         tokens) can run programs on this machine
  -h, --help             display help for command
```

### `tapdance worker logout`

```text
Usage: tapdance worker logout [options]

Leave the gateway and serve local agents only

Options:
  -h, --help  display help for command
```

### `tapdance worker start`

```text
Usage: tapdance worker start [options]

Start the worker daemon

Options:
  -h, --help  display help for command
```

### `tapdance worker stop`

```text
Usage: tapdance worker stop [options]

Stop the worker: end its leases, stop the daemon and shut down the emulators and
simulators it created

Options:
  -h, --help  display help for command
```

### `tapdance worker status`

```text
Usage: tapdance worker status [options]

Show the worker's devices, leases and capabilities

Options:
  -h, --help  display help for command
```

### `tapdance worker logs`

```text
Usage: tapdance worker logs [options]

Print the worker daemon log (the last 100 lines unless -n says otherwise),
optionally filtered

Options:
  -n, --lines <n>    how many lines (at most 5000); with a filter, how many
                     matching lines (default: "100")
  --contains <text>  only lines containing this text (case-insensitive), e.g.
                     "clean baseline"
  --since <when>     only lines from the last 30s, 10m, 2h or 1d, or since an
                     ISO time such as 2026-11-04T21:54:00Z
  -h, --help         display help for command
```

### `tapdance worker cleanup`

```text
Usage: tapdance worker cleanup [options]

Release device claims left by agent-device processes that have gone (a worker
restart, the machine going offline mid-lease); live owners are never touched

Options:
  -h, --help  display help for command
```

### `tapdance worker restart`

```text
Usage: tapdance worker restart [options]

Restart the worker daemon (ends agent-device sessions on it; a login service
left from an older Tapdance is installed again); refuses while leases run unless
--force

Options:
  --force     restart even while devices are leased (their agents lose them)
  -h, --help  display help for command
```

### `tapdance simlock`

```text
Usage: tapdance simlock [options] [args...]

Run the Simlock CLI bundled with Tapdance (for operators; agents should not need
it)

Options:
  -h, --help  display help for command
```

### `tapdance gateway`

```text
Usage: tapdance gateway [options] [command]

Run a gateway on this machine (an ordinary VPS is fine: it needs no KVM)

Options:
  -h, --help       display help for command

Commands:
  setup [options]  Start a Simlock gateway, enable agent-device + streaming,
                   mint tokens, and point this machine's Tapdance at it
  token [options]  Mint a token on this machine's gateway (printed once)
  status           Show the gateway's workers, devices and queue
  help [command]   display help for command
```

### `tapdance gateway setup`

```text
Usage: tapdance gateway setup [options]

Start a Simlock gateway, enable agent-device + streaming, mint tokens, and point
this machine's Tapdance at it

Options:
  --worker-label <name>  label for the first worker's join token (default:
                         "worker-1")
  --agent-label <name>   label for this machine's agent token (default:
                         "tapdance-agent")
  --public-url <url>     the https:// address workers and remote agents will use
                         (after you add TLS)
  --no-configure-here    do not write ~/.tapdance config/credentials for this
                         machine
  -h, --help             display help for command
```

### `tapdance gateway token`

```text
Usage: tapdance gateway token [options]

Mint a token on this machine's gateway (printed once)

Options:
  --role <role>   worker (to join a worker), agent (one per agent), or operator
  --label <name>  who it is for
  -h, --help      display help for command
```

### `tapdance gateway status`

```text
Usage: tapdance gateway status [options]

Show the gateway's workers, devices and queue

Options:
  -h, --help  display help for command
```

### `tapdance host`

```text
Usage: tapdance host [options] [command]

Set up this Mac or Linux machine as a device host for a remote agent, in one
command

Options:
  -h, --help               display help for command

Commands:
  up [options]             Worker, guard service, pairing, Tailscale and a
                           self-test, step by step; prints a block to paste to
                           the agent's machine
  pause                    Stop hosting for now, keeping the pairing: the guard
                           (and caffeinate), Tailscale exposure, the worker and
                           its devices stop, and nothing restarts at login
  resume [options]         Start hosting again after `host pause`, the same way
                           as before (guard flags, Tailscale, login services)
  warm [options] [counts]  Set how many booted spare devices the worker keeps
                           (e.g. android=0,ios=0), or `default` for Simlock's
                           own (one spare per device kind leases used), without
                           re-running host up; restarts the worker only when
                           nothing is leased. With no counts, shows the current
                           setting and spares
  builds                   Let the agent build apps on this machine from
                           allow-listed git repositories (off by default)
  gh-login                 Log this machine's gh in with a GitHub token read
                           with echo off (or from stdin), for builds with
                           --git-auth gh and installs from CI; never prints the
                           token
  artifacts                Let the agent install the APKs and iOS simulator apps
                           your CI built (GitHub Actions artifacts), downloaded
                           by this machine with its own gh (off by default)
  token [options]          Hand a pairing token to the agent: copy it to the
                           clipboard (default) or show it once
  status                   Show the state of each `host up` step on this machine
  down [options]           Stop hosting: remove the guard service and `tailscale
                           serve` for its port (tokens are kept unless --revoke)
  help [command]           display help for command
```

### `tapdance host up`

```text
Usage: tapdance host up [options]

Worker, guard service, pairing, Tailscale and a self-test, step by step; prints
a block to paste to the agent's machine

Options:
  --label <name>             name for the control machine's pairing (default:
                             the pairing this host already has, if only one;
                             else this machine's hostname)
  --allow-admin-account      run the guard from an administrator account (not
                             recommended)
  --no-tailscale             do not expose the guard with `tailscale serve`; the
                             endpoint stays on loopback
  --keep-awake               macOS: run the guard under `caffeinate -i` so idle
                             sleep does not take it offline
  --tailscale-ssh            also turn on Tailscale SSH (`tailscale set --ssh`),
                             so machines in the tailnet can ssh in without
                             copying keys; the tailnet policy decides who may
  --repair                   revoke the existing pairing with this label and
                             issue a new token
  --skip-self-test           do not lease a device through the guard at the end
  --scope <areas>            limit the pairing token to these policy areas, e.g.
                             interaction,inspection,screenshots,streaming,input
                             (no install: it cannot put apps on the devices)
  --warm <counts>            booted spare devices kept ready for fast leases,
                             per platform, e.g. android=1,ios=0 (0 frees the
                             memory; default: Simlock keeps one per device kind
                             used)
  --idle-stop <minutes|off>  Linux cloud VMs: power the machine off after this
                             many minutes with no lease, request or build
                             (default on a detected cloud VM: 30; elsewhere off;
                             refused on macOS)
  --max-uptime <hours|off>   Linux cloud VMs: after this many hours up, take no
                             new leases and power off when the last one ends
                             (default off; refused on macOS)
  -y, --yes                  approve pairing without a prompt (you are at this
                             machine)
  -h, --help                 display help for command
```

### `tapdance host pause`

```text
Usage: tapdance host pause [options]

Stop hosting for now, keeping the pairing: the guard (and caffeinate), Tailscale
exposure, the worker and its devices stop, and nothing restarts at login

Options:
  -h, --help  display help for command
```

### `tapdance host resume`

```text
Usage: tapdance host resume [options]

Start hosting again after `host pause`, the same way as before (guard flags,
Tailscale, login services)

Options:
  --allow-admin-account  run the guard from an administrator account (remembered
                         from `host pause` when it was used)
  --keep-awake           macOS: run the guard under `caffeinate -i` (remembered
                         from `host pause` when it was used)
  -h, --help             display help for command
```

### `tapdance host warm`

```text
Usage: tapdance host warm [options] [counts]

Set how many booted spare devices the worker keeps (e.g. android=0,ios=0), or
`default` for Simlock's own (one spare per device kind leases used), without
re-running host up; restarts the worker only when nothing is leased. With no
counts, shows the current setting and spares

Options:
  --now       restart the worker even if a lease is running (that ends the
              lease)
  -h, --help  display help for command
```

### `tapdance host builds`

```text
Usage: tapdance host builds [options] [command]

Let the agent build apps on this machine from allow-listed git repositories (off
by default)

Options:
  -h, --help         display help for command

Commands:
  enable [options]   Allow builds from these repositories (git mode): the agent
                     sends a repo and ref, this machine fetches and builds it
  disable [options]  Turn builds off (the allow-list is kept); with --repo,
                     remove only those repositories from the allow-list and
                     leave builds on
  status [options]   Show whether builds are on, the allowed repositories (with
                     their deploy key and build files) and the build cache;
                     --check also tries each repository with its auth
  key [options]      Create a read-only deploy key and print its public half to
                     add to the repository; --repo makes one for that repository
                     only (GitHub accepts a deploy key on one repository);
                     --remove deletes it
  files              Files this machine copies into the checkout before each
                     build of a repository: config kept out of git
                     (google-services.json, local.properties, .env). Only you
                     add or read them; agents cannot
  help [command]     display help for command
```

### `tapdance host builds enable`

```text
Usage: tapdance host builds enable [options]

Allow builds from these repositories (git mode): the agent sends a repo and ref,
this machine fetches and builds it

Options:
  --repo <url>               repository allowed to be built (repeatable)
  --git-auth <mode>          how git reaches private repositories: gh (this
                             machine's `gh auth`, e.g. a fine-grained read-only
                             token), deploy-key (`host builds key`), or none; a
                             repository's own key from `host builds key --repo`
                             is used whenever it exists (default: keep the
                             current setting, else none)
  --protected-ref <branch>   only build commits already on this branch of the
                             remote, e.g. main (repeatable)
  --timeout-minutes <n>      longest build (default: keep the current setting,
                             else 45)
  --gradle-idle-minutes <n>  Android: minutes an idle Gradle and Kotlin daemon
                             of a host build stays alive, 0 for none (default:
                             keep the current setting, else 10)
  --no-check                 skip checking that this machine can read each
                             --repo with that auth (git ls-remote)
  --allow-admin-account      accept the risk of building on an administrator
                             account
  -h, --help                 display help for command
```

### `tapdance host builds disable`

```text
Usage: tapdance host builds disable [options]

Turn builds off (the allow-list is kept); with --repo, remove only those
repositories from the allow-list and leave builds on

Options:
  --repo <url>  remove this URL from the allow-list, exactly as `host builds
                status` lists it (repeatable; the ssh and https URLs are
                separate entries)
  -h, --help    display help for command
```

### `tapdance host builds status`

```text
Usage: tapdance host builds status [options]

Show whether builds are on, the allowed repositories (with their deploy key and
build files) and the build cache; --check also tries each repository with its
auth

Options:
  --check     check that this machine can read each repository with the auth its
              builds use (git ls-remote; needs the network)
  -h, --help  display help for command
```

### `tapdance host builds key`

```text
Usage: tapdance host builds key [options]

Create a read-only deploy key and print its public half to add to the
repository; --repo makes one for that repository only (GitHub accepts a deploy
key on one repository); --remove deletes it

Options:
  --repo <url>  the repository this key is for; its ssh builds use it whatever
                --git-auth says
  --remove      delete the key (with --repo: that repository's own key; without:
                the shared deploy_key) and print its fingerprint, to delete it
                on the git server too
  -h, --help    display help for command
```

### `tapdance host builds files`

```text
Usage: tapdance host builds files [options] [command]

Files this machine copies into the checkout before each build of a repository:
config kept out of git (google-services.json, local.properties, .env). Only you
add or read them; agents cannot

Options:
  -h, --help                       display help for command

Commands:
  add [options] <path-in-repo>     Add or replace a build file: its content
                                   comes from --from or stdin (at most 1 MB, 50
                                   files per repository)
  list [options]                   List build files: path, size and the start of
                                   the sha256, never their content
  remove [options] <path-in-repo>  Remove a build file; the next build runs
                                   without it
  help [command]                   display help for command
```

### `tapdance host gh-login`

```text
Usage: tapdance host gh-login [options]

Log this machine's gh in with a GitHub token read with echo off (or from stdin),
for builds with --git-auth gh and installs from CI; never prints the token

Options:
  -h, --help  display help for command
```

### `tapdance host artifacts`

```text
Usage: tapdance host artifacts [options] [command]

Let the agent install the APKs and iOS simulator apps your CI built (GitHub
Actions artifacts), downloaded by this machine with its own gh (off by default)

Options:
  -h, --help         display help for command

Commands:
  enable [options]   Allow installs from these repositories' GitHub Actions
                     artifacts: this machine downloads them with its `gh auth`
                     and installs the APK or simulator .app on the agent's lease
  disable [options]  Turn installs from CI off (the allow-list is kept); with
                     --repo, remove only those repositories from the list and
                     leave installs from CI on
  status [options]   Show whether installs from CI are on, the allowed
                     repositories and branches, the download cache and whether
                     this machine's gh is signed in; --check also tries each
                     repository's artifacts
  help [command]     display help for command
```

### `tapdance host artifacts enable`

```text
Usage: tapdance host artifacts enable [options]

Allow installs from these repositories' GitHub Actions artifacts: this machine
downloads them with its `gh auth` and installs the APK or simulator .app on the
agent's lease

Options:
  --repo <owner/repo>  GitHub repository (owner/repo or its https://github.com
                       URL), repeatable
  --branch <name>      only artifacts of runs on this branch, e.g. main
                       (repeatable; replaces the list)
  --max-mb <n>         largest artifact, and APK or unpacked .app, in MB
                       (default 512)
  --no-check           skip checking that this machine's gh can read each --repo
                       and its Actions artifacts
  -h, --help           display help for command
```

### `tapdance host artifacts disable`

```text
Usage: tapdance host artifacts disable [options]

Turn installs from CI off (the allow-list is kept); with --repo, remove only
those repositories from the list and leave installs from CI on

Options:
  --repo <owner/repo>  remove this repository from the list (repeatable)
  -h, --help           display help for command
```

### `tapdance host artifacts status`

```text
Usage: tapdance host artifacts status [options]

Show whether installs from CI are on, the allowed repositories and branches, the
download cache and whether this machine's gh is signed in; --check also tries
each repository's artifacts

Options:
  --check     check that this machine's gh can read each repository and its
              Actions artifacts (needs the network)
  -h, --help  display help for command
```

### `tapdance host token`

```text
Usage: tapdance host token [options]

Hand a pairing token to the agent: copy it to the clipboard (default) or show it
once

Options:
  --label <name>  which pairing (default: the only one, or this machine's
                  hostname)
  --copy          copy it to the clipboard (the default)
  --show          print it once (it stays in your terminal's scrollback)
  -h, --help      display help for command
```

### `tapdance host status`

```text
Usage: tapdance host status [options]

Show the state of each `host up` step on this machine

Options:
  -h, --help  display help for command
```

### `tapdance host down`

```text
Usage: tapdance host down [options]

Stop hosting: remove the guard service and `tailscale serve` for its port
(tokens are kept unless --revoke)

Options:
  --revoke    also revoke every paired control machine and delete the pairing
              token files
  --all       everything: --revoke, plus end the worker's leases, shut down the
              emulators and simulators it created, stop it and remove its login
              service
  -y, --yes   do not ask for confirmation
  -h, --help  display help for command
```

### `tapdance connect`

```text
Usage: tapdance connect [options] <endpoint>

On the agent's machine: use a host's guard (reads the token from stdin), check
it, and print MCP setup for Claude Code, Codex and Cursor

Options:
  -h, --help  display help for command
```

### `tapdance view`

```text
Usage: tapdance view [options]

Open a live view of this session's device in your browser (watch the agent, take
over, hand back)

Options:
  --host <host>        address to listen on (loopback by default; use SSH -L or
                       Tailscale to reach it)
  --port <port>        port to listen on
  --allow-host <name>  another name the page may be opened by (repeatable); this
                       machine's Tailscale names are allowed already
  --tailscale          serve the page over https on this machine's tailnet name
                       (tailscale serve), for live video; needs HTTPS
                       Certificates on the tailnet
  -h, --help           display help for command
```

### `tapdance report`

```text
Usage: tapdance report [options]

Write a redacted, issue-ready bug report (environment, versions, doctor, lease)
to stdout or a file

Options:
  --title <text>       one-line summary
  --kind <kind>        bug | missing-feature | docs | field-test (default:
                       "bug")
  --steps <text>       what you ran, in order
  --expected <text>    what should have happened
  --actual <text>      what happened instead (paste the error)
  --evidence <paths>   comma-separated artifact paths (screenshots, logs) to
                       list
  -o, --output <file>  write to this file (for `gh issue create --body-file`)
  -h, --help           display help for command
```

### `tapdance tools`

```text
Usage: tapdance tools [options] [command]

External tools Tapdance can run for you, and whether they are installed here

Options:
  -h, --help      display help for command

Commands:
  list            Registered tools and install state
  doctor          Install state, versions, discovery commands and install
                  guidance
  versions        Installed versions
  help [command]  display help for command
```

### `tapdance tools list`

```text
Usage: tapdance tools list [options]

Registered tools and install state

Options:
  -h, --help  display help for command
```

### `tapdance tools doctor`

```text
Usage: tapdance tools doctor [options]

Install state, versions, discovery commands and install guidance

Options:
  -h, --help  display help for command
```

### `tapdance tools versions`

```text
Usage: tapdance tools versions [options]

Installed versions

Options:
  -h, --help  display help for command
```

### `tapdance tool`

```text
Usage: tapdance tool [options] <name> [args...]

Run an external tool with arguments unchanged: tapdance tool asc -- apps list

Options:
  --target <target>    where to run it: control (this machine; default)
  --timeout <seconds>  stop it after this long (default 600)
  -h, --help           display help for command
```

### `tapdance asc`

```text
Usage: tapdance asc [options] [args...]

Run the installed asc CLI with arguments unchanged (tapdance asc -- --help)

Options:
  --target <target>    where to run it: control (this machine; default)
  --timeout <seconds>  stop it after this long (default 600)
  -h, --help           display help for command
```

### `tapdance android`

```text
Usage: tapdance android [options] [args...]

Run the installed android CLI with arguments unchanged (tapdance android --
--help)

Options:
  --target <target>    where to run it: control (this machine; default)
  --timeout <seconds>  stop it after this long (default 600)
  -h, --help           display help for command
```

### `tapdance mcp`

```text
Usage: tapdance mcp [options]

Run the MCP server (stdio by default) so an agent gets Tapdance's device tools

Options:
  --http         serve Streamable HTTP instead of stdio
  --host <host>  HTTP: address to listen on (default: "127.0.0.1")
  --port <port>  HTTP: port (default: "4711")
  -h, --help     display help for command
```

<!-- END GENERATED COMMAND INDEX -->
