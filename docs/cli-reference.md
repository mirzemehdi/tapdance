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
| Device state | [`device setting / push / pull / notifications / perf / audio`](#device-state) |
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
a worker), whether the Simlock worker or gateway answers `/v1/healthz` (two tries of 15 s, since a first
connection through `tailscale serve` can be slow; the time is shown, and an `http://` endpoint that now
serves HTTPS is named as such), the token's role, whether
agent-device, streaming and input are available, capacity per platform, the Simlock version (warns if
it is not 0.4.0), AXe when `ios.uiBackend` is `axe`, workers online (when an operator token is stored),
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
tapdance devices install <platform> <version>
```

`devices` (or `devices list`) shows, per platform, capacity (running, limit, warm, leased), the models
and OS versions that can be leased, Android image tags, running devices and the queue depth.

`devices install ios 18.5` or `devices install android 35` installs an iOS runtime or Android system
image **on this machine's worker** by running the bundled `simlock --local component install`. Downloads
are several GB. Android images need their SDK licences accepted first (see
[installation.md](installation.md#android-macos-or-linux-with-kvm)).

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
tapdance device request-human --reason <text> [--wait <seconds>]
tapdance device done
```

| `device lease` option | Meaning |
| --- | --- |
| `-p, --platform` | Required. `android` or `ios`. |
| `-d, --device <model>` | Model, e.g. `"Pixel 8"` or `"iPhone 16"`. See `tapdance devices`. |
| `--os <version>` | OS version or range; for Android, the API level. |
| `--image-tag <tag>` | Android system image tag, e.g. `google_apis_playstore`. |
| `--physical` | Lease an enrolled physical device instead. Untested. |
| `--profile <name>` | Boot a [device profile](#device-profiles) from this machine instead of a Simlock device. |
| `--ttl <minutes>` | Lease TTL, 1–240. Default `session.defaultTtlMinutes` (30). |
| `--wait <seconds>` | How long to wait in the queue, 0–3600. Default `session.leaseWaitSeconds` (330). The Simlock provider waits at most 330 s. |
| `--no-keepalive` | Do not renew in the background. The lease ends after its TTL unless you run `device renew`. |
| `--hold` | Stay in the foreground, renew, and release on Ctrl-C. |

Without `--hold` or `--no-keepalive` (and with `session.keepalive` true), `lease` starts a detached
keepalive process and returns. The keepalive checks every TTL/6 (between 5 and 60 s), renews when a
third of the TTL has passed, and stops when the session releases, the lease is lost, the lease has not
been used for `session.idleReleaseMinutes` (it then releases it), or `session.maxSessionMinutes` passes
(the lease then expires on its own).

A session that already holds a lease gets `LEASE_ALREADY_HELD` (exit 3) from `device lease`.

`device status` shows the device, platform and OS, provider and worker, endpoint and whether it is TLS,
loopback or a private network, state, lease id and minutes left, a running recording, and a human hold
from the viewer. If the lease has ended it fails with `LEASE_LOST` and clears the session record.

`device renew` extends the lease now (optionally with a new TTL). `device release` releases this
session's device; it is wiped. Releasing when nothing is held is not an error. When the worker cannot
be reached, `release` says so, exits 4 and keeps the lease record: run it again once the worker answers
(otherwise the worker frees the device when the lease expires).

`device request-human` is the CLI form of the MCP tool `request_human`: it shows `--reason` in the
viewer's banner (and on stderr), then waits until the person presses **Hand back** in `tapdance view` or
runs `tapdance device done`. Default wait 600 s (10–1800). Exit 0 when handed back, 9 (`TIMEOUT`) when
nobody did; Ctrl-C stops waiting and clears the request. Use it for a Google sign-in, a password sheet
or a CAPTCHA: the person types secrets on the device, never in chat.

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
tapdance device push <path> --to <downloads|pictures|documents|app_sandbox> [--app <id>] [--name <n>]
tapdance device pull [devicePath] [--app <id> --path <relative>] [-o <file>]
tapdance device notifications <list|open|close|post> [--app <id>] [--title <t>] [--text <t>] [--payload <json>]
tapdance device perf <frames|memory> [--app <id>]
tapdance device shell [--stdin <file>] [--timeout <seconds>] -- <command…>
```

These act on the leased device through Simlock's lease exec or agent-device, so they work for a device
on a remote worker too; a worker in device-only mode decides with its policy (`allow.settings`,
`allow.files`, `allow.inspection` (reading an emulator's notifications), `allow.notifications` (posting
them, and reading a physical phone's; off by default), `allow.perf`). Every change ends with the lease:
the device is wiped on release.

- `setting`: `wifi`, `bluetooth`, `airplane`, `mobile-data`, `animations` (`on`/`off`), `location`
  (`on`/`off`, or `--lat`/`--lon`), `appearance` (`light`/`dark`/`toggle`), `text-size`, `faceid`/`touchid`
  (iOS), `fingerprint` (Android), `permission <grant|deny|reset> --permission <p> --app <id>`,
  `reset-keychain` (iOS), `orientation`, `status-bar-time <HH:MM|clear>` (iOS). Other Android settings
  (density, locale, time zone, …) go through `device shell`. Without a value it
  reads the setting where the platform can. A combination a platform cannot do fails with
  `NOT_SUPPORTED` and says what to do instead. Common Android settings through `device shell` (standard
  Android shell commands, not each one run with Tapdance yet):

  | Want | Command |
  | --- | --- |
  | Font scale 2.0 | `device shell -- settings put system font_scale 2.0` |
  | Density | `device shell -- wm density 420` (`wm density reset` to undo) |
  | TalkBack on (when the image has the Android Accessibility Suite) | `device shell -- settings put secure enabled_accessibility_services com.google.android.marvin.talkback/com.google.android.marvin.talkback.TalkBackService`, then `-- settings put secure accessibility_enabled 1` |
  | Move the clock (needs root: `google_apis` images, not `google_apis_playstore`) | `device shell -- settings put global auto_time 0`, then `-- su 0 date 1103190026` (MMDDhhmmYY) |

- `push`: Android shared storage (media-scanned) or a debuggable app's sandbox, up to 24 MB; iOS Photos
  or an app's Documents (a remote simulator needs a worker guard).
- `pull`: Android shared storage (`/sdcard/Download/…` and the other media folders) or `--app` with
  `--path`; iOS `--app` with `--path` inside its container (remote: through a worker guard). Saved as an
  artifact.
- `notifications`: `list` (Android), `open`/`close` the shade (Android), `post` a shell notification
  (Android) or, with `--app` and `--payload`, a push payload (the way to test pushes on the iOS simulator).
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
tapdance app install <path> [--app-id <id>]
tapdance app launch <appId> [--relaunch] [--url <url>] [--arg <arg>]...
                     [--intent-action <a>] [--intent-data <uri>] [--intent-component <c>] [--intent-extra <k=v>]...
tapdance app stop <appId>
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

`launch` starts or brings an installed app to the front; `--relaunch` kills and restarts it; `--url`
opens a deep link; `--arg` passes launch arguments (and relaunches). The `--intent-*` options start an
explicit Android intent instead. `stop` force-stops it. `uninstall` removes it. `clear` clears its data
(first-launch state); on iOS the keychain is shared, see `device setting reset-keychain`. `list` lists
the apps the automation backend sees.

## UI

### `ui`

```text
tapdance ui inspect [--all] [--compact] [--bounds]
tapdance ui tap  (--text <t> | --id <id> | --ref <ref> | --selector <s> | --x <x> --y <y>) [--no-settle] [--settle-ms <ms>] [--inject]
tapdance ui type <text> [--text <t> | --id <id> | --ref <ref> | --selector <s> | --x <x> --y <y>]
tapdance ui swipe (--direction <up|down|left|right> [--amount <0.1-0.8>] [--until <text>] | --from <x,y> --to <x,y>)
tapdance ui wait  (--text <text> | --absent <text> | --stable) [--timeout <ms>]
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
| `ui inspect` | Elements with ref, role, label, value, identifier and state (`[checked]`, `[unchecked]`, `[selected]`, `[focused]`, `[expanded]`), in the default view and with `--all`. `--all` includes non-interactive elements; `--compact` leaves out unlabelled containers (the bulk of a Compose or SwiftUI tree); `--bounds` prints each element's `(x,y w×h)` in pixels, for coordinate taps on canvases (`--json` always includes them as `rect`). |
| `ui tap` | Waits for the UI to settle and lists what changed. `--no-settle` skips that. `--settle-ms <ms>` also waits up to that long for the UI to come to rest (a tap that auto-advances to the next screen after an animation) and prints `screen changed: <its first labels>` or `same screen`. On Android system screens that ignore the automation helper's touches (the file picker `DocumentsUI`, the share sheet), a settled tap that changed nothing is repeated once as a raw `input tap` and says so. `--inject` (Android) taps with a raw input event at the element's centre from the start. |
| `ui type <text>` | With a target, focuses the field and replaces its content; without one, appends to the focused field. |
| `ui swipe` | `--direction` is the finger's direction: `up` scrolls content down. `--until <text>` scrolls one swipe at a time (at most 10) until an element whose label or value contains the text (any case) is on screen; a list row whose label merges several texts still matches. It stops with `ELEMENT_NOT_FOUND` at the end of the list. `--from`/`--to` take points like `120,640`. |
| `ui wait` | Exactly one condition. `--timeout` defaults to 10000, at most 30000. Exits 1 on timeout. `--stable` reads the screen repeatedly and succeeds once its content (roles, labels, ids, values, states) has not changed for one second; positions are ignored, so a moving background does not count. On timeout it says the UI is still changing. |
| `ui alert` | `get` shows a system alert's title, message and buttons; `accept` presses the allowing button, `dismiss` the declining one. Not available with the AXe backend. |
| `ui key` | `back` is Android back or iOS in-app back. |

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
running recording.

### `logs`

```text
tapdance logs [-n, --lines <n>] [--app <id>] [--crash]
```

Recent device logs (Android logcat, iOS simulator unified log), default 200 lines, at most 5000.
`--app` filters to one app; `--crash` shows Android's crash buffer or iOS faults and crash messages from
the last 10 minutes. The output is also saved as an artifact.

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
`viewer.humanHoldMs` (agent calls get `HUMAN_HELD`); "Hand back" returns it.

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
your user, run `sudo tailscale set --operator=$USER` once. Not yet tested on a real tailnet.

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
| `worker guard start` / `pair` / `tokens` / `revoke` / `policy` / `audit` | Device-only mode (verified on one Mac with a real simulator: H-02; dedicated-account script and Tailscale exposure untested). A local server in front of the Simlock worker that remote control machines reach instead of a gateway, enforcing a policy file on the worker. `pair` must run in a terminal on the Mac (unless `TAPDANCE_GUARD_PAIR_NONINTERACTIVE` is set) and prints a token once. See [security/personal-mac.md](security/personal-mac.md). |
| `worker guard install [--allow-admin-account] [--keep-awake]` / `worker guard uninstall` | Keep the guard running as a login service of this account: a LaunchAgent `dev.tapdance.guard` (`~/Library/LaunchAgents/dev.tapdance.guard.plist`, RunAtLoad + KeepAlive, log `~/Library/Logs/tapdance-guard.log`) on macOS, or `~/.config/systemd/user/tapdance-guard.service` (`Restart=on-failure`) on Linux. Same refusals as `guard start`, and refused while a `guard start` in a terminal holds the port; an unchanged running service is left alone. `--allow-admin-account` is passed on to `guard start`; `--keep-awake` runs it under `caffeinate -i` on macOS (no effect on Linux). Exit 4 if the guard does not answer within 20 s. `uninstall` stops it and removes the file; tokens and policy stay. Refused on Windows (`NOT_SUPPORTED`). Not yet installed on a real machine (H-03). See [security/personal-mac.md](security/personal-mac.md#keep-the-guard-running). |
| `worker cleanup` | Release device claims left behind by agent-device processes that have gone (a worker restart, the machine going offline mid-lease). Such a claim blocks the next lease of that emulator with "owned by session …". Only claims whose owner process is provably dead are touched; an unfinished screen recording of such a session is set aside (renamed `*.abandoned-<time>`) so its claim can go. `worker start`/`restart` and the worker guard (before each lease) do this on their own. |
| `worker start` / `stop` / `status` / `logs` / `restart` | Start, stop, show, print the log of, or restart the worker daemon. `status --json` returns Simlock's JSON. `restart` ends agent-device sessions on the worker. |

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

Runs the Simlock 0.4.0 CLI bundled with Tapdance, for operators. Put `--` before Simlock's own options
(`tapdance simlock -- --version`), or Tapdance parses them itself. Agents should not need it.

## Hosting for a remote agent

One command per side for device-only mode: `host up` on the Mac or Linux machine that runs the
devices, `connect` on the machine where the agent runs. **Built and unit-tested only; not yet run end
to end** ([STATUS.md](../STATUS.md), W-07). Full guide: [deployment/one-command-host.md](deployment/one-command-host.md).

### `host`

| Command | Meaning |
| --- | --- |
| `host up [--label <name>] [--allow-admin-account] [--no-tailscale] [--keep-awake] [--repair] [--skip-self-test] [--warm android=N,ios=M] [-y, --yes]` | Eight steps, each printed with its name: prerequisites (the `worker check` checks plus a JDK check and, on Linux, cloud-VM detection; installs nothing and prints install commands), account (root, joined gateway, administrator refusals; on an admin account it stops and prints the exact command to run again with `--allow-admin-account`), worker (`worker install --service`; left alone on a re-run when it already runs with the guard service), guard service (`worker guard install`), pairing (a guard token labelled with the hostname or `--label`, approved at a terminal or with `--yes`, written to `~/.tapdance/worker/pairing-<label>.token` with mode 600 and never printed; a valid token file is kept, `--repair` revokes and reissues), tailscale (`tailscale serve --bg --https=4720 http://127.0.0.1:4720` and the MagicDNS endpoint; `--http` with a warning recommending HTTPS Certificates when the tailnet has none; or loopback with instructions when Tailscale is missing, logged out or `--no-tailscale`), self-test (through the guard with the new token: list devices, lease Android or else iOS, screenshot, release; `--skip-self-test` keeps only the device list), summary (the `TAPDANCE HOST READY` block with the `tapdance connect` line). A failed step prints the step, the command, the tail of its output and a fix, and exits with the error's code. Refused on Windows (`NOT_SUPPORTED`). |
| `host status` | Each step's state on this machine (prerequisites, account, worker, guard service, pairings, Tailscale) and the endpoint. |
| `host pause` | Stop hosting for now and keep the pairing: removes the guard's login service (and its `caffeinate`), turns off `tailscale serve`, ends the worker's leases, shuts down the emulators and simulators it created, stops the worker and removes its login service, so nothing starts at your next login. Records how the guard ran in `~/.tapdance/worker/paused.json`. The VPS cannot reach this machine until `resume`. |
| `host resume [--allow-admin-account] [--keep-awake]` | Start hosting again the way it ran before `pause` (the flags are remembered from `pause`; pass them when no pause was recorded, or use `host up` after `host down`). It checks the account before starting anything: reinstalls the worker's and the guard's login services (with `--allow-admin-account` / `--keep-awake` as before), resets stale device records, serves the guard on Tailscale again, and says whether the pairing token is still valid (if not: `host up --repair`, then `host token`). |
| `host token [--label <name>] [--copy \| --show]` | Hand the pairing token over: copies it to the clipboard (`pbcopy`, `wl-copy`/`xclip`/`xsel`) by default; `--show` prints it once with a warning. Prints a 6-character fingerprint (SHA-256) that `connect` prints too, so both sides can check they hold the same token without showing it. `host up` also offers to copy it at the end. |
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
| 12 | `SCENARIO_FAILED`, `ASSERTION_FAILED` | `run`: the scenario ran and a step failed. (`ASSERTION_FAILED` appears on a failed expectation inside the report, not as a command error.) |

Pass-through commands (`tool`, `asc`, `android`, `simlock`, `devices install`) exit with the wrapped
program's exit code.

These codes are **retryable by default** (the same call may succeed later without changes):
`PROVIDER_UNREACHABLE`, `WORKER_OFFLINE`, `NO_CAPACITY`, `HUMAN_HELD`, `TIMEOUT`. Fixes for each are in
[troubleshooting.md](troubleshooting.md).

## Session identity

A session owns at most one lease. Every CLI call and MCP server works out which session it belongs to,
in this order:

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
  -p, --platform <platform>     android or ios
  -h, --help                    display help for command

Commands:
  install <platform> <version>  Install an iOS runtime or Android system image
                                on this worker (several GB; Simlock never
                                downloads on its own)
  list [options]                Same as `tapdance devices`
```

### `tapdance devices install`

```text
Usage: tapdance devices install [options] <platform> <version>

Install an iOS runtime or Android system image on this worker (several GB;
Simlock never downloads on its own)

Options:
  -h, --help  display help for command
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
                                    (sign in, approve a purchase, solve a check)
                                    and wait until they hand back
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
                                    orientation, status-bar-time
  push [options] <path>             Copy a file onto the device (Android shared
                                    storage or a debuggable app's sandbox; iOS
                                    Photos or an app's Documents)
  pull [options] [devicePath]       Copy a file from the device into this
                                    session's artifacts
  notifications [options] <action>  list | open | close | post notifications on
                                    the device
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
  --image-tag <tag>          Android system image tag, e.g.
                             google_apis_playstore
  --physical                 lease an enrolled physical device instead
  --profile <name>           boot a device profile from this machine (read-only:
                             the lease's changes are discarded)
  --ttl <minutes>            lease time to live in minutes
  --wait <seconds>           how long to wait in the queue
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
check) and wait until they hand back

Options:
  --reason <text>   what the person should do; shown in the viewer
  --wait <seconds>  how long to wait (10-1800) (default: "600")
  -h, --help        display help for command
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
fingerprint, permission, reset-keychain, orientation, status-bar-time

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
sandbox; iOS Photos or an app's Documents)

Options:
  --to <destination>  downloads, pictures, documents or app_sandbox
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
  -o, --out <file>       write here instead of the artifacts directory
  -h, --help             display help for command
```

### `tapdance device notifications`

```text
Usage: tapdance device notifications [options] <action>

list | open | close | post notifications on the device

Options:
  --app <appId>     filter (list) or the app a push payload goes to (post)
  --title <title>   post: title
  --text <text>     post: body
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
  install [options] <path>  Upload and install an .apk (Android) or simulator
                            .app (iOS)
  launch [options] <appId>  Launch an installed app
  uninstall <appId>         Remove an installed app
  clear <appId>             Clear an app's data (first-launch state); iOS also:
                            device setting reset-keychain
  stop <appId>              Force-stop an app
  list                      List apps the automation backend sees
  help [command]            display help for command
```

### `tapdance app install`

```text
Usage: tapdance app install [options] <path>

Upload and install an .apk (Android) or simulator .app (iOS)

Options:
  --app-id <id>  package / bundle id, when the backend needs it
  -h, --help     display help for command
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

### `tapdance app stop`

```text
Usage: tapdance app stop [options] <appId>

Force-stop an app

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
  -h, --help             display help for command

Commands:
  inspect [options]      List on-screen elements with refs, roles and labels
  tap [options]          Tap one element
  swipe [options]        Swipe by finger direction (up scrolls content down) or
                         between two points
  type [options] <text>  Type text; with a target, replace that field's content
  wait [options]         Wait for text to appear (--text), disappear (--absent),
                         or the UI to settle (--stable)
  alert <action>         Read (get) or answer (accept, dismiss) a system alert
  key <key>              Press back, home, enter, dismiss_keyboard or
                         app_switcher
  help [command]         display help for command
```

### `tapdance ui inspect`

```text
Usage: tapdance ui inspect [options]

List on-screen elements with refs, roles and labels

Options:
  --all       include non-interactive elements
  --compact   leave out unlabelled containers (useful with --all on Compose or
              SwiftUI screens)
  --bounds    show each element's position and size in pixels (x,y w×h); --json
              always includes them as rect
  -h, --help  display help for command
```

### `tapdance ui tap`

```text
Usage: tapdance ui tap [options]

Tap one element

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
  --timeout <ms>   at most 30000 (default: "10000")
  -h, --help       display help for command
```

### `tapdance ui alert`

```text
Usage: tapdance ui alert [options] <action>

Read (get) or answer (accept, dismiss) a system alert

Options:
  -h, --help  display help for command
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
  -n, --lines <n>  how many lines (default: "200")
  --app <id>       only this app
  --crash          crash buffer / faults only
  -h, --help       display help for command
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
  logs               Print the worker daemon log
  cleanup            Release device claims left by agent-device processes that
                     have gone (a worker restart, the machine going offline
                     mid-lease); live owners are never touched
  restart            Restart the worker daemon (ends agent-device sessions on
                     it)
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
  --label <name>  who it is for, e.g. hetzner-vps
  --days <n>      lifetime in days (policy maximum applies)
  -h, --help      display help for command
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

Print the worker daemon log

Options:
  -h, --help  display help for command
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

Restart the worker daemon (ends agent-device sessions on it)

Options:
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
  -h, --help        display help for command

Commands:
  up [options]      Worker, guard service, pairing, Tailscale and a self-test,
                    step by step; prints a block to paste to the agent's machine
  pause             Stop hosting for now, keeping the pairing: the guard (and
                    caffeinate), Tailscale exposure, the worker and its devices
                    stop, and nothing restarts at login
  resume [options]  Start hosting again after `host pause`, the same way as
                    before (guard flags, Tailscale, login services)
  token [options]   Hand a pairing token to the agent: copy it to the clipboard
                    (default) or show it once
  status            Show the state of each `host up` step on this machine
  down [options]    Stop hosting: remove the guard service and `tailscale serve`
                    for its port (tokens are kept unless --revoke)
  help [command]    display help for command
```

### `tapdance host up`

```text
Usage: tapdance host up [options]

Worker, guard service, pairing, Tailscale and a self-test, step by step; prints
a block to paste to the agent's machine

Options:
  --label <name>         name for the control machine's pairing (default: this
                         machine's hostname)
  --allow-admin-account  run the guard from an administrator account (not
                         recommended)
  --no-tailscale         do not expose the guard with `tailscale serve`; the
                         endpoint stays on loopback
  --keep-awake           macOS: run the guard under `caffeinate -i` so idle
                         sleep does not take it offline
  --repair               revoke the existing pairing with this label and issue a
                         new token
  --skip-self-test       do not lease a device through the guard at the end
  --warm <counts>        booted spare devices kept ready for fast leases, per
                         platform, e.g. android=1,ios=0 (0 frees the memory;
                         default: Simlock keeps one per device kind used)
  -y, --yes              approve pairing without a prompt (you are at this
                         machine)
  -h, --help             display help for command
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
