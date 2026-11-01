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
| Human access | [`view`](#view) |
| Workers and gateways | [`worker …`](#worker), [`gateway …`](#gateway), [`simlock`](#simlock) |
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
a worker), whether the Simlock worker or gateway answers `/v1/healthz`, the token's role, whether
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
| `tapdance config set-token [--operator]` | Store the agent token (or, with `--operator`, an operator token) in `~/.tapdance/credentials.json`, mode 600. Reads the token from stdin when piped, otherwise prompts with hidden input. Never pass it as an argument. |

```bash
tapdance config set session.defaultTtlMinutes 45
tapdance config set tools.allowMutation '["asc"]'
printf '%s' "$AGENT_TOKEN" | tapdance config set-token
```

See [configuration.md](configuration.md) for every key.

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
                      [--ttl <minutes>] [--wait <seconds>] [--no-keepalive] [--hold]
tapdance device status
tapdance device renew [--ttl <minutes>]
tapdance device release
```

| `device lease` option | Meaning |
| --- | --- |
| `-p, --platform` | Required. `android` or `ios`. |
| `-d, --device <model>` | Model, e.g. `"Pixel 8"` or `"iPhone 16"`. See `tapdance devices`. |
| `--os <version>` | OS version or range; for Android, the API level. |
| `--image-tag <tag>` | Android system image tag, e.g. `google_apis_playstore`. |
| `--physical` | Lease an enrolled physical device instead. Untested. |
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
session's device; it is wiped. Releasing when nothing is held is not an error.

## Apps

### `app`

```text
tapdance app install <path> [--app-id <id>]
tapdance app launch <appId> [--relaunch] [--url <url>]
tapdance app stop <appId>
tapdance app list
```

`install` uploads and installs an `.apk` (Android) or a simulator `.app` bundle (iOS) from this machine.
An `.ipa` on a simulator and an `.aab` are refused with `APP_PATH_INVALID`. `--app-id` gives the
package or bundle id when the backend needs it.

`launch` starts or brings an installed app to the front; `--relaunch` kills and restarts it; `--url`
opens a deep link. `stop` force-stops it. `list` lists the apps the automation backend sees.

## UI

### `ui`

```text
tapdance ui inspect [--all]
tapdance ui tap  (--text <t> | --id <id> | --ref <ref> | --selector <s> | --x <x> --y <y>) [--no-settle]
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
| `ui inspect` | Elements with ref, role, label, value and identifier. `--all` includes non-interactive elements. |
| `ui tap` | Waits for the UI to settle and lists what changed. `--no-settle` skips that. |
| `ui type <text>` | With a target, focuses the field and replaces its content; without one, appends to the focused field. |
| `ui swipe` | `--direction` is the finger's direction: `up` scrolls content down. `--until` keeps scrolling until the text is visible. `--from`/`--to` take points like `120,640`. |
| `ui wait` | Exactly one condition. `--timeout` defaults to 10000, at most 30000. Exits 1 on timeout. |
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

## Human access

### `view`

```text
tapdance view [--host <host>] [--port <port>]
```

Serves a live view of this session's device on `127.0.0.1:4710` (from `viewer.host` and `viewer.port`)
and prints a link with a one-time key. The page shows the live screen and accepts tap, swipe, scroll,
keys, Home/Back, screenshots and recordings. A touch takes control from the agent for
`viewer.humanHoldMs` (agent calls get `HUMAN_HELD`); "Hand back" returns it.

Public addresses are refused. `--host 0.0.0.0` is allowed with a warning: anyone who can reach the
port and has the link can control the device. Prefer loopback plus `ssh -L` or a private network. Stops
on Ctrl-C. Needs Simlock's `stream` and `input` capabilities (on after `tapdance worker install`).

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
| `worker guard start` / `pair` / `tokens` / `revoke` / `policy` / `audit` | **Preview, untested, still being written.** Device-only mode: a local server in front of the Simlock worker that remote control machines reach instead of a gateway, enforcing a policy file on the worker. See [security/personal-mac.md](security/personal-mac.md). |
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
  --operator  store an operator token (only needed for `workers list` on a
              gateway)
  -h, --help  display help for command
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
  -h, --help       display help for command

Commands:
  lease [options]  Lease one emulator or simulator for this session
  status           Show this session's device and lease
  renew [options]  Extend this session's lease now
  release          Release this session's device (it is wiped)
  help [command]   display help for command
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
  --ttl <minutes>            lease time to live in minutes
  --wait <seconds>           how long to wait in the queue
  --no-keepalive             do not renew in the background (the lease expires
                             after its TTL)
  --hold                     stay in the foreground, renew, and release on
                             Ctrl-C
  -h, --help                 display help for command
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
  --relaunch   kill and restart it
  --url <url>  deep link to open
  -h, --help   display help for command
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
  stop               Stop the worker daemon (leases on it end when their TTL
                     runs out)
  status             Show the worker's devices, leases and capabilities
  logs               Print the worker daemon log
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
  -h, --help       display help for command

Commands:
  start [options]  Serve the device-only API (loopback by default; expose it
                   with Tailscale, never publicly)
  pair [options]   Approve a control machine locally: prints a revocable
                   device-only token once
  tokens           List paired control machines
  revoke <id>      Revoke a paired control machine immediately (or `all`)
  policy           Show the local policy and its file
  audit [options]  Show recent remote requests and decisions
  help [command]   display help for command
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

Stop the worker daemon (leases on it end when their TTL runs out)

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

### `tapdance view`

```text
Usage: tapdance view [options]

Open a live view of this session's device in your browser (watch the agent, take
over, hand back)

Options:
  --host <host>  address to listen on (loopback by default; use SSH -L or
                 Tailscale to reach it)
  --port <port>  port to listen on
  -h, --help     display help for command
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
