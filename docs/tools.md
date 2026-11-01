# External tools

Tapdance does not reimplement App Store Connect, Google Play publishing, Android tooling or E2E test
frameworks. It runs the official tools you install, with your arguments passed through unchanged, and
adds the guard rails an agent needs: which tools agents may run, read-only by default, and device
commands limited to the session's leased device.

The registry in `packages/sdk/src/tools.ts` holds only integration metadata (executable, where it runs,
how to discover its commands, install hint, license). It is deliberately **not** a catalogue of each
tool's commands: a subcommand a tool adds upstream works the day you install that version, without a
Tapdance release.

## Registered tools

| Tool | Executable | Runs | OS | Read-only for agents | Agents allowed by default | Project and license |
| --- | --- | --- | --- | --- | --- | --- |
| App Store Connect CLI | `asc` | this machine | macOS, Linux, Windows | yes, `ASC_READ_ONLY=1` | yes | [rorkai/App-Store-Connect-CLI](https://github.com/rorkai/App-Store-Connect-CLI), MIT |
| Google's Android CLI | `android` | against the leased Android device | macOS, Linux, Windows | no read-only mode; lease-scoped | yes | [developer.android.com/cli](https://developer.android.com/tools/agents/android-cli), Google's terms |
| AXe | `axe` | against the leased iOS simulator | macOS | no read-only mode; lease-scoped | yes | [cameroncooke/AXe](https://github.com/cameroncooke/AXe), MIT (bundles Meta IDB, MIT) |
| Maestro | `maestro` | against the leased device | macOS, Linux, Windows | no read-only mode; lease-scoped | yes | [mobile-dev-inc/maestro](https://github.com/mobile-dev-inc/maestro), Apache-2.0 |
| fastlane | `fastlane` | this machine | macOS, Linux | no read-only mode: needs `tools.allowMutation` | no | [fastlane/fastlane](https://github.com/fastlane/fastlane), MIT |
| xcodebuild | `xcodebuild` | this machine (a Mac) | macOS | no read-only mode: needs `tools.allowMutation` | no | Apple's Xcode license |

Status ([STATUS.md](../STATUS.md), E-01 to E-08): `asc` 5.17.1 was run for real through Tapdance
(`--version` and `apps list`); `xcodebuild` (Xcode 26.5) was detected by `tapdance tools` but not run
through it. AXe, Google's Android CLI, Maestro and fastlane are registered but **not tested**
with Tapdance: they were not installed on the test machine. The Android CLI's device targeting
(`ANDROID_SERIAL`) is unverified against a real install.

Check what is installed here:

```bash
tapdance tools            # table: installed or missing, version, where it runs
tapdance tools doctor     # plus discovery commands, install hints and notes
```

## How pass-through works

```bash
tapdance asc -- apps list --output json
tapdance android -- --help
tapdance tool maestro -- test flows/login.yaml
tapdance --json tool fastlane -- action supply
```

- Everything after `--` reaches the tool unchanged, as an argument array. No shell is involved, so
  quoting, globbing and `;` have no special meaning.
- `asc` and `android` have their own shortcuts; every registered tool works with `tapdance tool <name>`.
- The tool's stdout, stderr and exit code are preserved. In the terminal, output streams through and
  `tapdance` exits with the tool's exit code. With `--json`, output is captured and returned as JSON
  (`exitCode`, `stdout`, `stderr`, `durationMs`, `timedOut`, …), and the full output is also written to
  files in the session's artifact folder.
- `--timeout <seconds>` stops the tool after that long (default 600 s): SIGTERM, then SIGKILL 5 s later.
- `tools.paths` in the config gives an absolute executable path when a tool is not on `PATH`.
- The tool gets a reduced environment: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `TMPDIR`,
  `TERM`, `TZ`, plus its own variables (`ASC_*` for asc; `ANDROID_*`, `JAVA_HOME`, `GRADLE_*` for the
  Android CLI; `MAESTRO_*`, `JAVA_HOME`, `ANDROID_HOME`, `ANDROID_SDK_ROOT` for Maestro; `FASTLANE_*`,
  `SUPPLY_*`, `LC_ALL`, `GEM_*`, `BUNDLE_*` for fastlane; `DEVELOPER_DIR` for xcodebuild). Anything else,
  including your other tokens, is not passed on. Known secret shapes (Simlock tokens, bearer headers,
  PEM private keys, `token=`/`password=` values) are redacted in captured output.

Agents use the same mechanism through the MCP tools `list_tools` and `execute_tool`; see
[mcp.md](mcp.md#execute_tool-policy).

## Discovering commands

Tapdance does not list or describe a tool's commands. Agents and people use the tool's own discovery:

| Tool | Discovery |
| --- | --- |
| `asc` | `asc --help`, `asc search "<what you want to do>" --output json`, `asc <command> --help`, `asc docs`, `asc install-skills` |
| `android` | `android --help`, `android <command> --help` |
| `axe` | `axe --help`, `axe <command> --help` |
| `maestro` | `maestro --help`, `maestro test --help` |
| `fastlane` | `fastlane actions`, `fastlane action supply`, `fastlane supply --help` |
| `xcodebuild` | `xcodebuild -help`, `xcodebuild -list` |

Through MCP an agent calls, for example, `execute_tool` with `{"tool": "asc", "args": ["search",
"upload a build", "--output", "json"]}`. `list_tools` returns the same discovery list.

## Read-only and mutation policy

From the CLI, you are in charge: Tapdance does not force read-only mode.

For agents (MCP `execute_tool`):

1. The tool must be in `tools.mcpEnabled` (default `asc`, `android`, `axe`, `maestro`). Otherwise
   `FORBIDDEN`.
2. Calls are read-only unless the tool is in `tools.allowMutation` **and** the agent passes
   `allow_mutation: true`.
   - Without that authorization, `asc` runs with `ASC_READ_ONLY=1`. That is asc's own guard: it refuses every mutating App
     Store Connect request (POST, PATCH, PUT, DELETE) before sending it. asc's other safety flags
     (`--read-only`, `--confirm`, `--strict-auth`) are passed through untouched if the agent uses them.
   - `fastlane` and `xcodebuild` have no read-only mode, so agents cannot run them at all until the user
     lists them in `tools.allowMutation` (and enables them in `tools.mcpEnabled`).
   - Device tools (`android`, `axe`, `maestro`) are not read-only; they are confined to the leased
     device instead.

Example: let agents upload TestFlight builds with asc, and run fastlane for Play uploads:

```json
{
  "tools": {
    "mcpEnabled": ["asc", "android", "axe", "maestro", "fastlane"],
    "allowMutation": ["asc", "fastlane"]
  }
}
```

asc and fastlane use their own authentication (`asc auth …`, fastlane's API key files). Tapdance never
stores or forwards those credentials, beyond the tool's own environment prefix.

## Lease scoping

Tools marked "against the leased device" act only on this session's device:

| Tool | How Tapdance targets the lease | Without a lease |
| --- | --- | --- |
| `axe` | Appends `--udid <leased simulator>`; a `--udid` you pass is refused with `FORBIDDEN`. iOS leases only. | `NO_ACTIVE_LEASE` |
| `maestro` | Appends `--device <leased device>`; `--device` or `--udid` you pass is refused. | `NO_ACTIVE_LEASE` |
| `android` | Sets `ANDROID_SERIAL` to the leased emulator and `ANDROID_ADB_SERVER_PORT` to Simlock's private adb server; inherited `ANDROID_SERIAL`, `ANDROID_ADB_SERVER_PORT` and `ANDROID_ADB_SERVER_ADDRESS` are removed. Android leases only. | Runs, with `ANDROID_SERIAL` set to an id that matches no device, so device-free commands (docs, project setup) work and device commands fail. |

These tools need direct access to the device, so they work only where the device runs: when the
session's lease is on a **remote** worker, they fail with `NOT_SUPPORTED`. Tapdance's own device tools
(`tap`, `inspect_screen`, screenshots, logs) do work through a gateway.

A person holding the device in the viewer blocks agent calls to these tools with `HUMAN_HELD`.

## Execution targets

| Target | Status |
| --- | --- |
| `control` (the machine running `tapdance`) | Available. The default and the only target today. |
| A remote Mac worker (for Xcode-dependent commands) | Not built. Needs a worker-side executor; Simlock's `exec` allows only `adb`, `simctl` and `devicectl`. |
| A remote Android worker (for device commands) | Not built, same reason. |

Any other `--target` / `target` value fails with `NOT_SUPPORTED`. Until remote targets exist, run
Tapdance on the Mac (or worker) itself for those commands. See STATUS E-04 and the
[architecture decision](architecture-decision.md).

## Installing the tools

Tapdance does not install them. Install hints from the registry:

| Tool | Install |
| --- | --- |
| `asc` | `brew install asc`, or see [asccli.sh](https://asccli.sh/) for other platforms |
| `android` | [developer.android.com/tools/agents/android-cli/download](https://developer.android.com/tools/agents/android-cli/download); `android init` sets up its agent skill |
| `axe` | `brew install cameroncooke/axe/axe` |
| `maestro` | `curl -fsSL https://get.maestro.mobile.dev \| bash` |
| `fastlane` | `brew install fastlane` or `gem install fastlane` |
| `xcodebuild` | Install Xcode, then `sudo xcode-select -s /Applications/Xcode.app` |

Tapdance detects installed versions (`tapdance tools versions`) but has no update command: upgrading or
pinning a tool is up to you. Supported versions are in [compatibility.md](compatibility.md).

## AXe as the iOS UI backend

Separately from pass-through, AXe can replace agent-device as the backend behind Tapdance's own iOS tools
(`ios.uiBackend: "axe"`, set by `tapdance worker install --ios-backend axe`). It works only when Tapdance
runs on the Mac hosting the simulator, needs Simlock's `drivers.ios.deviceSet` set to `default` (AXe sees
only Xcode's default device set), and has no alert handling or selector support. It is unit-tested only;
installing AXe on the test Mac was blocked by Homebrew's tap-trust policy (STATUS U-02, Q-09).
