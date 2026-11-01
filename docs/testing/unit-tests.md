# Unit and integration tests

Tapdance has two kinds of automated tests. They are kept apart so that nobody mistakes a test against
a fake for proof that something works on a real device.

| Project | Files | Needs | Runs with |
| --- | --- | --- | --- |
| `unit` | `packages/*/src/**/*.test.ts` (but not `*.integration.test.ts`) | Node.js only. No Simlock, no device, no network. | `pnpm test` |
| `integration` | `packages/*/src/**/*.integration.test.ts` | A running Simlock worker on this machine and a real simulator or emulator. Skipped unless you opt in. | `pnpm test:integration` |

Both projects are defined in [`vitest.config.ts`](../../vitest.config.ts) at the repository root. The
integration project has 10-minute test and hook timeouts and runs its files one at a time
(`fileParallelism: false`), because they share one device worker.

Real-hardware procedures that are not automated live in [e2e-procedures.md](e2e-procedures.md), and
their results in [evidence/](evidence/README.md).

## Running the tests

You need Node.js 22.13 or later and pnpm 10 (the repository pins `pnpm@10.20.0` in `package.json`;
`corepack enable` gives you the right one).

```bash
pnpm install
pnpm test               # builds every package, then runs the unit project
pnpm test:integration   # builds, then runs the integration project (skipped unless opted in)
pnpm typecheck          # tsc over the CLI and MCP packages and what they depend on
```

`pnpm test` builds first because one unit test file, `packages/cli/src/cli.test.ts`, runs the built
CLI (`packages/cli/dist/main.js`) as a child process. Every other test imports the workspace packages
from source: `vitest.config.ts` maps `@tapdance/core`, `@tapdance/provider-simlock`, `@tapdance/sdk`,
`@tapdance/sdk/testing` and `@tapdance/mcp` to their `src/` folders.

To run one file or one test while you work:

```bash
pnpm exec vitest run --project unit packages/core/src/core.test.ts
pnpm exec vitest run --project unit -t "redacts Simlock secrets"
pnpm exec vitest --project unit            # watch mode
```

If you change anything under `packages/cli/src`, run `pnpm build` again before running
`cli.test.ts`, or it tests the old build.

## What the unit tests cover

84 unit tests as of 2026-11-01 (see STATUS.md, Q-01).

| File | Tests | What it checks |
| --- | --- | --- |
| `packages/core/src/core.test.ts` | 15 | Error codes map to the documented exit codes; secrets (`slk_…`, bearer headers, token fields, private keys) are redacted from messages; config defaults, strict validation, precedence (user file ← project file ← environment) and the refusal of tokens in config files; credentials file written with mode 600; session identity order (`TAPDANCE_SESSION_ID`, then the agent's session id, then a per-user id); element target validation; the session store and the per-session artifact manifest. |
| `packages/provider-simlock/src/provider.test.ts` | 19 | Parsing Simlock's `exec` stream; refusing to send a token over plain `http://` to a public host; per-session agent-device client ids; reading Simlock's local agent-device profile; selector escaping and snapshot-to-element mapping; settle-diff summaries; app path checks (`.apk`, `.aab`, `.app`, `.ipa`); H.264 stream framing; agent-device error mapping; the Simlock HTTP client against a fake `fetch`; the AXe backend's tree flattening, UDID checks and "not installed" error. |
| `packages/sdk/src/tapdance.test.ts` | 18 | Session scoping: no device action without a lease, one lease per session, one session cannot release another's lease, stale records are replaced, `HUMAN_HELD` while a person controls the device, disabled platforms refused, one recording at a time. Keepalive: renews after a third of the TTL, defers to another live renewer, reports a lost lease, releases an idle lease. Ownership rules and concurrent leases. The provider factory has no fake cloud provider and needs an endpoint for `self-hosted`. |
| `packages/mcp/src/mcp.test.ts` | 11 | Every required MCP tool exists and none is a raw shell (`shell`, `exec`, `adb`, `simctl`, `run_on_device`); every tool has a description and refuses unknown keys; a whole agent flow over an in-memory MCP transport; install paths confined to the project; structured errors; `execute_tool` behaviour (see below). |
| `packages/cli/src/cli.test.ts` | 6 | The built CLI: version output; `NO_ACTIVE_LEASE` with exit code 3 and JSON on stdout; bad arguments exit 2; tokens refused in config; `provider: "cloud"` refused with `NOT_SUPPORTED` (exit 8); and every `` `tapdance <command>` `` named in a hint in `packages/*/src` exists in `--help`. |

Run `pnpm test` to get the current count rather than trusting this table.

## Fakes and mocks, and how they are labelled

Tapdance has no mock of Simlock, agent-device, Xcode or the Android emulator that pretends to be a
device. Tests below the provider contract use small, explicit fakes:

| Fake | Where | What it stands in for | What a passing test proves |
| --- | --- | --- | --- |
| `FakeProvider` | `packages/sdk/src/testing.ts`, exported as `@tapdance/sdk/testing` | The `DeviceProvider` contract. It keeps leases in memory, records every call in `calls`, refuses handles it did not issue, and writes a real 1×1 PNG for screenshots. Its doc comment says: "It is not a device." | That the SDK, MCP server and CLI layers above the provider behave correctly. Nothing about Simlock or a real device. |
| Fake `fetch` | `provider.test.ts`, "Simlock HTTP client" | Simlock's HTTP API responses for a handful of routes. | That Tapdance maps Simlock's error codes and network failures correctly. |
| Fake `asc` executable | `mcp.test.ts`, in the block named **"execute_tool (MOCKED executable: proves pass-through, not asc itself)"** | A shell script on a temporary `PATH` that echoes its arguments and environment, prints a fake private key and exits 3. | That arguments reach the tool unchanged (including a never-seen subcommand and shell metacharacters), that `ASC_READ_ONLY=1` is set unless the user allowed mutation in config, that parent environment secrets are not forwarded, that private keys are redacted, and that disabled tools and remote targets are refused. It proves nothing about `asc` itself. |
| A nonexistent AXe path | `provider.test.ts`, "AXe backend" | A missing AXe install. | The error message for a missing AXe. AXe itself has not been run (STATUS.md, U-02). |

Rules for new tests:

- Put anything that needs a real device, a real Simlock daemon or a real external tool in a
  `*.integration.test.ts` file, and make it skip itself (with `describe.skipIf`) unless the person
  running it opts in with an environment variable.
- When a unit test uses a fake executable or a fake service, put the word **MOCKED** in the
  `describe` name and say what the test does and does not prove, as the `execute_tool` block does.
- Never use a fake to back a "✅" in STATUS.md. Only a record in [evidence/](evidence/README.md) can.
- Prefer `FakeProvider` over new mocks. If it is missing a behaviour you need, extend it.

## The integration test

There is one: `packages/cli/src/mcp-local.integration.test.ts`. It starts the built `tapdance mcp`
over stdio as a child process, connects with the official MCP client, and runs an agent's whole loop
against a **real** device on a Simlock worker on this machine: list tools, `lease_device`, optional
`install_app`, `launch_app`, `inspect_screen`, `start_recording`, `tap`, `press_key`, `wait_for`,
`handle_alert`, `swipe`, `take_screenshot`, `stop_recording`, `get_logs`, `get_crash_logs`,
`get_test_artifacts`, `list_tools`, `execute_tool asc --version` (only if `asc` is installed),
`release_device`, and finally checks that `get_device_status` answers `NO_ACTIVE_LEASE`.

It is skipped, and reported as skipped, unless `TAPDANCE_IT_PLATFORM` is set.

| Variable | Meaning | Default |
| --- | --- | --- |
| `TAPDANCE_IT_PLATFORM` | `ios` or `android`. Required to run at all. | unset (skipped) |
| `TAPDANCE_IT_DEVICE` | Model to lease, e.g. `iPhone 16` or `Pixel 8`. | any phone |
| `TAPDANCE_IT_OS` | OS version, e.g. `18.5`, or an Android API level, e.g. `35`. | any |
| `TAPDANCE_IT_APP` | Path to an `.apk` or simulator `.app` to install first. | none; the test uses Settings |
| `TAPDANCE_IT_APP_ID` | Package or bundle id to launch. | `com.apple.Preferences` (iOS), `com.android.settings` (Android) |
| `TAPDANCE_IT_ENDPOINT` | URL of a Simlock gateway (for example `http://127.0.0.1:4700`). When set, the server runs with `TAPDANCE_PROVIDER=self-hosted` and this endpoint instead of local mode. | unset (local mode) |
| `TAPDANCE_IT_TOKEN` | Agent token for that gateway, passed to the server as `TAPDANCE_TOKEN`. Only used with `TAPDANCE_IT_ENDPOINT`. | empty |

Things to know before you run it:

- It runs in a fresh temporary `TAPDANCE_HOME` and working directory. Without
  `TAPDANCE_IT_ENDPOINT` it forces `TAPDANCE_PROVIDER=local` and tests a Simlock worker **on the same
  machine**. With `TAPDANCE_IT_ENDPOINT` and `TAPDANCE_IT_TOKEN` it runs the same loop through a
  Simlock gateway (`TAPDANCE_PROVIDER=self-hosted`). That gateway mode has been run once, with the
  gateway and the joined worker on the same Mac
  ([evidence](evidence/2026-11-01-gateway-single-host.md)); it has not been run across two machines.
  The CLI steps in [e2e-procedures.md](e2e-procedures.md) cover the two-machine setups.
- The local worker must be running with agent-device enabled: run `tapdance worker install` once.
- Because the working directory is a temporary folder, `install_app` refuses an app outside it unless
  you also set `TAPDANCE_ALLOWED_ROOTS` to the folder that holds the app, for example
  `TAPDANCE_ALLOWED_ROOTS="$(dirname "$TAPDANCE_IT_APP")"`.
- It has been run for real on iOS only (twice, on 2026-11-01). The Android path has not been run. See
  [evidence/2026-11-01-local-ios.md](evidence/2026-11-01-local-ios.md).

Example:

```bash
TAPDANCE_IT_PLATFORM=ios TAPDANCE_IT_DEVICE="iPhone 16" TAPDANCE_IT_OS=18.5 pnpm test:integration
```
