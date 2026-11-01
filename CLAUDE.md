# CLAUDE.md

See [AGENTS.md](AGENTS.md). It holds the layout, commands, invariants and testing rules for this
repository, and they apply to Claude Code in full.

## Notes for Claude Code

- **Read first:** `PRODUCT.md`, `STATUS.md`, `docs/architecture-decision.md`, then the code you will
  touch. `STATUS.md` is the truth about what works; never write docs or messages that claim more.
- **Session identity when you run the CLI.** Tapdance picks a session id from `TAPDANCE_SESSION_ID`,
  then `CLAUDE_CODE_SESSION_ID`, `CODEX_SESSION_ID` and `PI_SESSION_ID`, then a per-user identity.
  Inside Claude Code, CLI leases therefore belong to your Claude session. Set `TAPDANCE_SESSION_ID`
  to something distinct when a test needs its own lease.
- **Keep experiments out of the user's home.** Set `TAPDANCE_HOME` to a scratch directory when you
  try commands, so you do not overwrite `~/.tapdance/config.json` or `credentials.json`.
- **Safe to run without asking:** `pnpm build`, `pnpm typecheck`, `pnpm test`, and
  `node packages/cli/dist/main.js <command> --help`.
- **Ask first:** anything that starts the Simlock daemon (`worker install/start/restart`,
  `gateway setup`), leases or boots a device, `pnpm test:integration`, and anything that touches a
  real cloud account.
- **Exact syntax comes from `--help`,** not from memory. Command, flag, config key, environment
  variable and MCP tool names in docs must exist in the code.
- **When behaviour changes,** update `PRODUCT.md` (new IDs only), `STATUS.md` and the affected docs in
  the same change, and add an evidence file under `docs/testing/evidence/` for any real-device claim.
- **Never print or commit tokens.** Simlock secrets start with `slk_`. Do not echo
  `~/.tapdance/credentials.json`, Simlock token output or `asc` credentials into the conversation or
  into files.
