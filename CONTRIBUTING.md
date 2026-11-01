# Contributing to Tapdance

Thank you for helping. Tapdance is small on purpose: it composes existing tools and adds sessions,
routing, safety and one CLI/MCP/SDK surface. Before you write code, read:

1. [PRODUCT.md](PRODUCT.md): every requirement, each with a stable ID.
2. [STATUS.md](STATUS.md): what is real, what is only unit-tested, and what is missing.
3. [docs/architecture-decision.md](docs/architecture-decision.md): why Tapdance is built on Simlock
   and agent-device, and what it deliberately does not do.

If you use a coding agent, point it at [AGENTS.md](AGENTS.md). It holds the same rules in a form
agents follow.

## Set up

You need Node.js 22.13 or newer. pnpm comes through Corepack, pinned by the `packageManager` field in
`package.json` (pnpm 10.20.0).

```bash
corepack enable
pnpm install
pnpm build          # builds every package in dependency order (tsc -b)
pnpm typecheck      # type-checks the CLI and MCP packages and everything they reference
```

To run the CLI you just built:

```bash
node packages/cli/dist/main.js --help
```

## Repository layout

| Path | What it holds |
| --- | --- |
| `packages/core` | Contracts: the `DeviceProvider` interface, config schema and loading, errors and exit codes, session identity and records, artifacts, element targets. No I/O to devices. |
| `packages/provider-simlock` | The only provider today. Talks to a Simlock worker or gateway and to agent-device through Simlock's proxy. Optional AXe backend. |
| `packages/sdk` | The `Tapdance` class used by the CLI and MCP server, the provider factory, keepalive, host checks (Xcode, Android SDK, KVM), and the external tool registry. `@tapdance/sdk/testing` exports `FakeProvider`. |
| `packages/mcp` | MCP tool definitions (`tools.ts`) and the stdio and Streamable HTTP server. |
| `packages/cli` | The `tapdance` command, the browser viewer, `tapdance report`, and the worker guard for device-only mode (`src/guard/`). |
| `scripts/` | `gen-cli-index.mjs`: generates the command index in `docs/cli-reference.md` (`pnpm docs:cli`; `pnpm docs:check` fails when it is stale). |
| `docs/` | User documentation, the ADR, test procedures and evidence. |
| `infrastructure/` | Reference Terraform and install scripts. Nothing in `packages/` depends on it. |

## Tests

There are two kinds of tests, and they are kept apart on purpose.

| | Unit tests | Integration tests |
| --- | --- | --- |
| Files | `packages/*/src/**/*.test.ts` | `packages/*/src/**/*.integration.test.ts` |
| Command | `pnpm test` (builds first) | `pnpm test:integration` (builds first) |
| Devices | None. Use `FakeProvider` and mocked executables. | Real devices through a real Simlock worker. |
| When | Every change. Must pass before review. | Before claiming anything works on a device. |

Unit tests that stand in for a real device, worker or external tool must say so in the test name or
a comment ("mocked executable", "FakeProvider"). A mocked test never justifies a ✅ in STATUS.md.

`packages/cli/src/cli.test.ts` runs the built CLI. One of its checks walks `tapdance --help` and fails
if any source file or doc names a `tapdance` command that does not exist, so keep hints and messages
honest. Another fails when a command, MCP tool or config key is undocumented or the generated command
index is stale: after adding a command or flag, run `pnpm build && pnpm docs:cli`.

### Running the real integration test

The integration test drives the built `tapdance mcp` over stdio against a Simlock worker on your
machine. It is skipped (and reported as skipped) unless you opt in.

```bash
pnpm build
node packages/cli/dist/main.js worker install   # enables agent-device, streaming and input on the local worker
TAPDANCE_IT_PLATFORM=ios TAPDANCE_IT_DEVICE="iPhone 16" TAPDANCE_IT_OS=18.5 pnpm test:integration
```

| Variable | Meaning |
| --- | --- |
| `TAPDANCE_IT_PLATFORM` | `ios` or `android`. Required; without it the test is skipped. |
| `TAPDANCE_IT_DEVICE` | Device model, for example `iPhone 16` or `Pixel 8`. |
| `TAPDANCE_IT_OS` | OS version (Android: API level). |
| `TAPDANCE_IT_APP` | Optional path to an `.apk` or simulator `.app` to install. |
| `TAPDANCE_IT_APP_ID` | Optional package or bundle id for that app. |
| `TAPDANCE_IT_ENDPOINT` | Optional gateway or worker URL. When set, the test runs through it with `provider: "self-hosted"` instead of the local worker. |
| `TAPDANCE_IT_TOKEN` | The agent token for `TAPDANCE_IT_ENDPOINT`. Never commit it or paste it into evidence. |

So far only iOS on macOS has been run: once against the local worker, and once through a gateway and
joined worker on the same Mac. Android and a real two-machine network have not. If you run it on Android, or on any setup STATUS.md
lists as untested, please record the result as evidence (next section), whether it passed or not.

## Real-device claims need evidence

Tapdance never claims a real-device result it cannot show. If your change moves a STATUS.md row to ✅,
or a document says something "works", add an evidence file in
[docs/testing/evidence/](docs/testing/evidence/) named `YYYY-MM-DD-<topic>.md`, and link it from the
row. Follow [the existing example](docs/testing/evidence/2026-11-01-local-ios.md):

- **Environment:** host, OS, CPU, Xcode or Android SDK versions, Simlock and agent-device versions,
  device model and OS, and the topology (which machine runs the agent, the gateway and the worker).
- **What ran:** the exact commands or MCP calls, in order, with the results that matter.
- **Re-run:** commands someone else can use to repeat it.
- **Not covered:** what this run does not prove.

Remove tokens, hostnames you do not want public, and personal data before you commit. `tapdance
report` output is already redacted, but read it anyway.

## Adding a provider

A provider is how Tapdance reaches devices. The CLI, MCP server and SDK only talk to the
`DeviceProvider` interface in `packages/core/src/provider.ts`, so a new provider must not need any
change to commands, tool names or SDK method signatures.

1. Create `packages/provider-<name>/` with the same `package.json`, `tsconfig.json` and build setup
   as `packages/provider-simlock`.
2. Implement `DeviceProvider`. Every device method receives the `LeaseHandle` your `lease` returned.
   Refuse handles you did not issue, and act only on the device that lease names. Map backend errors
   to `TapdanceError` codes from `packages/core/src/errors.ts`; mark transient ones `retryable`.
3. Add the provider kind to `PROVIDER_KINDS` in `packages/core/src/config.ts` (the `cloud` value is
   already reserved for a future hosted provider) and map it in
   `packages/sdk/src/provider-factory.ts`. That file is the only place config chooses a provider.
4. Add the package to the TypeScript references of the packages that use it and to the alias list in
   `vitest.config.ts`.
5. Write unit tests with mocked transports, labelled as mocked. Then run the real flow and add
   evidence before marking anything ✅.
6. Never ship a fake implementation behind a real-looking name. If the backend does not exist yet,
   fail with `NOT_SUPPORTED` and a hint, as `provider: "cloud"` does today.

## Adding an external tool

External tools (asc, Google's Android CLI, AXe, Maestro, fastlane, xcodebuild) are listed in
`packages/sdk/src/tools.ts`. The registry holds **integration metadata only**: name, description,
executable, homepage, license, supported OS, where it runs, version arguments, discovery commands,
install guidance, allowed environment variables, and an optional read-only switch.

**Do not add a catalogue of the tool's commands, subcommands or flags.** Arguments are forwarded
unchanged, so a subcommand added upstream works as soon as the user installs it. Agents learn
commands from the tool's own help, which you list in `discovery`.

To add a tool:

1. Append a `ToolSpec` to `TOOLS` in `packages/sdk/src/tools.ts`.
2. Choose `location`: `control` (runs on the machine running Tapdance), `mac` (needs Xcode), or `lease`
   (acts on the leased device). For `lease` tools, set `platforms`, and either `deviceArgs` (Tapdance
   appends the leased device id) with `refusedArgs` (so callers cannot pass their own), or `deviceEnv`
   for tools that pick the device from the environment.
3. List only the environment variables the tool needs in `env`. The parent environment is not
   forwarded otherwise.
4. If the tool has its own read-only mode, set `readOnlyEnv`. Agent calls through MCP use it unless
   the user lists the tool in `tools.allowMutation`. If it has none, say in `notes` that agents need
   explicit authorization.
5. Decide whether agents may run it by default. The default for `tools.mcpEnabled` is in
   `packages/core/src/config.ts`; leave a mutating tool out of it.
6. Add a unit test with a mocked executable (labelled), including an unknown subcommand forwarded
   unchanged and no credentials in the output.
7. Add the tool to [NOTICE.md](NOTICE.md) and the compatibility matrix in
   [docs/compatibility.md](docs/compatibility.md).

## Keeping PRODUCT.md, STATUS.md and the docs in sync

Behaviour, requirements, status and docs change in the **same pull request**.

- **A new requirement:** add it to PRODUCT.md first, with a new ID in the right section. Never reuse
  or renumber an ID. Then add its row to STATUS.md.
- **A behaviour change:** update the STATUS.md row's mark and notes, and update every doc that shows
  the affected command, flag, config key, environment variable or MCP tool.
- **Status marks:** ✅ only with linked evidence from real devices or tools; 🧪 for unit or mocked
  tests only; 🟡 for partial or not yet exercised; ⬜ not started; ⛔ blocked, with the reason;
  ❓ needs a product decision.
- **Update the "Last updated" date** at the top of STATUS.md.
- **Docs must not claim more than STATUS.md does.** If a procedure is untested, say so in the doc.

## Upstream first

If a change belongs in Simlock, agent-device, AXe or another upstream project, open an issue or pull
request there and link it from STATUS.md. Tapdance does not fork upstream projects to add features,
and removes its own code when an upstream tool gains the capability.

## Pull requests and issues

- Use the [pull request template](.github/pull_request_template.md). It contains the checklist.
- Commit messages and PR descriptions carry no AI attribution (no AI `Co-Authored-By` lines or
  "Generated with" footers), also when a coding agent helped.
- Report bugs, missing features and field-test findings with the
  [issue templates](.github/ISSUE_TEMPLATE/). `tapdance report` writes a redacted report you can paste.
- Report security problems privately, as described in [SECURITY.md](SECURITY.md).

By contributing, you agree that your contributions are licensed under the [MIT license](LICENSE).
