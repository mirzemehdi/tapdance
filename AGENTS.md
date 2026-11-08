# AGENTS.md

Instructions for coding agents (Codex, Claude Code, Cursor and others) that work **on** this
repository. If you are an agent that wants to **use** Tapdance to drive a device, run `tapdance mcp`
instead and read the MCP server's instructions.

## What this repo is

Tapdance is a CLI, MCP server and TypeScript SDK that lets AI agents lease and drive Android
emulators and iOS simulators, locally or on remote workers. Its principle is:
**Tapdance orchestrates; existing tools execute.** Simlock owns leasing, workers and the gateway.
agent-device (and optionally AXe) owns UI automation. `asc`, Google's Android CLI, fastlane, Maestro
and Xcode are run as external tools. Tapdance owns sessions, routing, safety, artifacts and the
CLI/MCP/SDK surface.

Read these before changing anything, in this order:

1. `PRODUCT.md`: requirements with stable IDs.
2. `STATUS.md`: what is proven, what is only unit-tested, what is missing. Never contradict it.
3. `docs/architecture-decision.md`: what is reused and why.

## Layout

| Path | Contents |
| --- | --- |
| `packages/core/src` | `DeviceProvider` contract (`provider.ts`), result types (`types.ts`), config schema, env overrides and credentials (`config.ts`), error codes, exit codes and secret redaction (`errors.ts`), session identity, the session store and its lock (`session-store.ts`), artifacts and their manifest (`artifacts.ts`), element targets. |
| `packages/provider-simlock/src` | The Simlock + agent-device provider (`provider.ts`), Simlock HTTP client and error mapping (`http.ts`, `agent-device-errors.ts`), the optional AXe backend (`axe.ts`), stream framing. |
| `packages/sdk/src` | `Tapdance` class (`tapdance.ts`, the session-scoped API), provider factory and token binding (`provider-factory.ts`), keepalive, host checks, the external tool registry and runner (`tools.ts`), `FakeProvider` (`testing.ts`). |
| `packages/mcp/src` | MCP tool definitions and server instructions (`tools.ts`) and transports (`server.ts`). |
| `packages/cli/src` | The `tapdance` commands (`commands-*.ts`), the browser viewer, `tapdance report`, and the worker guard for device-only mode (`guard/`: `policy.ts`, `rules.ts`, `server.ts`, `guard.test.ts`). |
| `scripts/gen-cli-index.mjs` | Generates the command index at the end of `docs/cli-reference.md` from `--help`. |
| `scripts/field-test/` | Dev tooling for field tests: the CLI and MCP checklist drivers and their JSON checklists. Not shipped. |
| `examples/` | Small demo apps used for real-device runs (`ios-demo`, `android-demo`). |
| `docs/` | User docs, ADR, test procedures, `docs/testing/evidence/`. |
| `infrastructure/` | Reference Terraform and scripts. Nothing in `packages/` may depend on it. |

## Commands

```bash
corepack enable                 # pnpm comes from the packageManager field
pnpm install
pnpm build                      # tsc -b in every package, in order
pnpm typecheck
pnpm test                       # build + unit tests (no devices needed)
pnpm test:integration           # build + real-device tests; skipped unless TAPDANCE_IT_PLATFORM is set
pnpm docs:cli                   # regenerate the command index in docs/cli-reference.md (after pnpm build)
pnpm docs:check                 # fail if that index is stale
node packages/cli/dist/main.js <command> --help
```

Run `pnpm test` after every change and keep the build green. Never skip or delete a failing test to
make a run pass; fix it or report it. When you add or change a command or flag, run `pnpm build` and
`pnpm docs:cli`; `cli.test.ts` fails when a command, MCP tool or config key is undocumented, when the
generated index is stale, or when any doc or hint names a `tapdance` command that does not exist.

## Invariants (do not break these)

1. **Never accept a device id from a caller.** No CLI command, MCP tool or SDK method takes a device,
   UDID, serial or worker id to act on. Everything resolves the current session's lease.
2. **Everything is lease-scoped.** Device methods receive the session's `LeaseHandle`. Providers
   refuse handles they did not issue. Release only ever targets the session's own lease.
3. **No raw shell tools.** Do not add an MCP tool or CLI command that runs arbitrary shell, `adb` or
   `simctl`. Internal use of Simlock `exec` stays on its fixed allowlist (see 14).
4. **No command catalogues for external tools.** `packages/sdk/src/tools.ts` is the tool registry:
   integration metadata only (executable, where it runs, install guidance, license, discovery, allowed
   environment). Never list a tool's subcommands or flags; arguments are forwarded unchanged and
   agents discover commands with the tool's own help. Run tools with argument arrays, never a shell.
   The only exceptions are the few `asc` commands refused for agents because they print credentials
   or run shell steps (`auth` other than `auth status`, `workflow`, `install-skills`).
5. **Redact secrets.** Tokens never go in config files (loading refuses them), never in logs, errors,
   MCP responses or reports. Use `redactSecrets` / `redactObject` from `@tapdance/core` on anything
   that may contain upstream output. Never return worker join tokens or the operator token to an
   agent; the operator token is loaded only for fleet views.
6. **Do not couple core logic to a cloud.** No Google Cloud, AWS or Scaleway SDKs in `packages/`.
7. **No fake implementations.** A missing backend fails with `NOT_SUPPORTED` and a hint, like
   `provider: "cloud"` does.
8. **Errors are `TapdanceError`s** with a stable code from `errors.ts`, a message a person can act on,
   and a `hint` with the fix. Only name `tapdance` commands that exist: `cli.test.ts` checks this.
9. **CLI output:** results on stdout, progress on stderr, `--json` for machines, exit codes from
   `ERROR_CODES`.
10. **Never fall back to software emulation** when KVM is missing. Report it.
11. **A repository's config is not trusted.** `tools.paths`, `tools.mcpEnabled`,
    `tools.allowMutation`, `ios.axePath`, `simlock.profilePath` and `viewer.host` are read only from
    `~/.tapdance/config.json` or the environment. A saved token is sent only to the endpoint origin it
    was saved for. Do not add a config key that lets a project file choose an executable or where a
    token goes.
12. **The worker guard is the boundary on a personal Mac.** `packages/cli/src/guard/` allows routes,
    agent-device commands and `exec` argument lists explicitly; anything not listed is refused. Add to
    an allowlist only with a matching malicious-client test in `guard.test.ts`, and never let a
    denied request reach Simlock.
13. **Never need a macOS privacy permission on the worker host.** Nothing Tapdance runs may require
    Screen Recording, Accessibility, Input Monitoring, Microphone or similar TCC grants for Node or the
    worker (for example agent-device's audio probe, which captures host audio with ScreenCaptureKit).
    Device capture goes through simctl/adb and Simlock. The guard refuses such commands.
14. **Device-level commands go through `device-commands.ts`.** Each one is a fixed shape built there
    and accepted by the guard's `execOf`; add both together, with a test that the builder's output
    passes the guard and injection attempts do not.

## Tests and evidence

- Unit tests live in `packages/*/src/**/*.test.ts`. Integration tests live in
  `*.integration.test.ts` and touch real devices.
- **Label mocked tests.** Any test that uses `FakeProvider`, a mocked transport or a fake executable
  says so in its name or a comment.
- **Never claim a real-device result from a mocked test.** A STATUS.md row becomes ✅ only with an
  evidence file in `docs/testing/evidence/YYYY-MM-DD-<topic>.md` (environment, what ran, how to re-run,
  what is not covered).
- To run the real integration test on a Mac with Xcode (this boots a simulator; ask the user first):

  ```bash
  pnpm build
  node packages/cli/dist/main.js worker install
  TAPDANCE_IT_PLATFORM=ios TAPDANCE_IT_DEVICE="iPhone 16" TAPDANCE_IT_OS=18.5 pnpm test:integration
  ```

  Optional: `TAPDANCE_IT_APP` (an `.apk` or simulator `.app`) and `TAPDANCE_IT_APP_ID`;
  `TAPDANCE_IT_ENDPOINT` and `TAPDANCE_IT_TOKEN` run the same loop through a gateway. Use
  `TAPDANCE_IT_PLATFORM=android` for Android (run on a Mac with Android 34 emulators, STATUS Q-02).

## Keep PRODUCT.md, STATUS.md and docs in sync

Change them **in the same change** as the code:

- New requirement: add it to `PRODUCT.md` with a new ID (never reuse or renumber), then a row in
  `STATUS.md`.
- Behaviour change: update the `STATUS.md` row and its "Last updated" date, and every doc that shows
  the affected command, flag, config key, environment variable or MCP tool.
- Docs must never claim more than `STATUS.md`. Proven for real: Android (macOS and a Google Cloud N2
  VM), AXe, the Android CLI on a local lease, a rented Scaleway Mac, and two machines over Tailscale
  in device-only mode (worker guard). **Not** proven yet: a gateway with a joined worker across two
  machines (it has run on one Mac only), MacStadium and AWS EC2 Mac, the full device loop over
  Streamable HTTP MCP, and a real agent (Claude Code, Codex, Cursor) as the MCP client; say so
  wherever you describe them.
- Credit upstream projects with links when you describe or follow their behaviour, and update
  `NOTICE.md` when you add a dependency or external tool.

## Commits and pull requests

- No AI attribution anywhere: no `Co-Authored-By` lines for an AI, no "Generated with …" footers, no
  mention of an AI tool or agent in commit messages, PR descriptions, code comments, docs or evidence
  records. Commits use the repository owner's own git identity.
- Do not commit, push or rewrite history unless the owner asks.

## Ask before you

- start Simlock daemons, boot simulators or emulators, or run the integration test;
- run `terraform plan/apply` or anything that touches a real cloud account;
- add a dependency (check its license and maintenance, pin an exact version, and add it to
  `NOTICE.md`);
- change the public surface: CLI command names, MCP tool names or inputs, SDK signatures, config keys.

## Cloud resources for tests

When the owner approves creating cloud resources for a test (a Google Cloud VM, a project, a budget):

- Follow [docs/testing/field-test-cloud-android.md](docs/testing/field-test-cloud-android.md): ephemeral
  mode (`on_run_limit = "DELETE"` with `max_run_hours`), a budget alert, and its checkpoints.
- Record each resource you create (name, when, how to delete it) as you create it.
- Never end a session leaving billable resources behind unless the owner said to keep them. Tear down
  with `terraform destroy`, then run `infrastructure/scripts/gcp-leftovers.sh <PROJECT_ID>` until it
  exits 0.
- Tell the owner the final state: what was created and deleted, the leftovers check's result, what is
  theirs to remove (Tailscale machine, GitHub token, project), and the estimated cost.
- Cloud credentials are the owner's: never ask for, print or store them, and never add a cloud SDK or
  credential handling to `packages/` (invariant 6).

## Style

- TypeScript in strict mode, ESM, Node 22.13+. Zod for config and MCP inputs; MCP inputs are
  `.strict()` so unknown keys fail.
- Exact version pins in `package.json`.
- Keep it small. If an upstream tool can do it, integrate the tool; if upstream should do it, open an
  upstream issue and note it in `STATUS.md`. Remove Tapdance code when upstream gains the feature.
- Plain, short English in docs and messages. Commands and flags in docs must match `--help`.
