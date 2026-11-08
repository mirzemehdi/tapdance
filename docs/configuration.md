# Configuration

Tapdance reads JSON config files, a separate credentials file, and environment variables. Every key and
default below comes from `packages/core/src/config.ts`. Unknown keys are refused, so a typo fails with
`CONFIG_INVALID` instead of being ignored.

## Files and precedence

Later sources override earlier ones. Objects are merged key by key; arrays and plain values are
replaced.

| Order | Source | Notes |
| --- | --- | --- |
| 1 | Built-in defaults | The tables below. |
| 2 | User config `~/.tapdance/config.json` | `$TAPDANCE_HOME/config.json` when `TAPDANCE_HOME` is set. Written by `init --global`, `gateway setup` and `worker install --ios-backend axe`. |
| 3 | Project config `tapdance.config.json` | The nearest one found walking up from the working directory (like git finds `.git`). Replaced by `--config <path>` or `TAPDANCE_CONFIG`, which must exist. The [security settings](#security-settings-are-user-only) are ignored here. |
| 4 | Environment variables | Highest. See [environment variables](#environment-variables). |

Relative paths in `artifacts.directory` resolve against the folder of the project config file, or the
working directory when there is none.

Inspect the result with:

```bash
tapdance config show     # merged config, the files it came from, artifacts dir, credential sources
tapdance config path     # where the project, user and credential files are
```

Change values with `tapdance config set <key> <value>` (project file) or `--global` (user file), or edit
the JSON. A minimal project file:

```json
{
  "provider": "local",
  "session": { "defaultTtlMinutes": 30 },
  "artifacts": { "directory": "./tapdance-artifacts" }
}
```

`tapdance init` also writes a `$schema` key pointing at a JSON schema URL for editors. That schema file
is not part of this repository yet, so editor validation may not work.

## Security settings are user-only

A project `tapdance.config.json` comes with the repository you open, and you may not have written it.
These keys decide which programs run as you and where Simlock is reached, so Tapdance reads them
**only** from the user config (`~/.tapdance/config.json`, written with `tapdance config set --global
<key> <value>`) or from the environment:

| Key | Why it is user-only |
| --- | --- |
| `tools.paths` | Could point `asc` at any program, which agents would then run as you. |
| `tools.mcpEnabled` | Could let agents run `fastlane` or `xcodebuild`. |
| `tools.allowMutation` | Could lift the read-only switches on tools. |
| `ios.axePath` | Could point the AXe backend at any program. |
| `simlock.profilePath` | Could redirect the local worker profile, and with it where device calls and the local token go. |

When a project file sets one of them, the value is ignored and a warning names the file:
"Ignored tools.paths from …/tapdance.config.json: security settings are read only from
~/.tapdance/config.json (`tapdance config set --global`) or the environment". The warnings are part of the resolved configuration (`warnings`); the
ignored value never takes effect. In addition, a `tools.paths.<name>` entry must point to a program called `<name>` (with an optional
`.exe`/`.cmd` suffix); anything else is refused with `FORBIDDEN`.

## Keys

### Provider

| Key | Default | Values | Meaning |
| --- | --- | --- | --- |
| `provider` | `"local"` | `local`, `self-hosted`, `cloud` | `local`: the Simlock worker on this machine. `self-hosted`: a Simlock gateway or worker at `endpoint`. `cloud`: reserved for a future hosted provider; refused today with `NOT_SUPPORTED`. |
| `endpoint` | none | `http://` or `https://` URL | Base URL of the Simlock gateway or worker for `self-hosted`, e.g. `https://gateway.example.com`. Plain `http://` is refused unless the host is private (loopback, RFC 1918, link-local, Tailscale's 100.64.0.0/10, `*.ts.net`), because the token would travel unencrypted. |
| `targets` | none | list of `{name, endpoint, platforms?}` | Several self-hosted hosts at once, written by [`tapdance connect`](cli-reference.md#connect): a lease goes to the first target that serves its platform, or to `--target <name>`. `platforms` (`["android"]`, `["ios"]`) limits what is routed to that host. Read only from `~/.tapdance/config.json`: a project file's `targets` is ignored with a warning. When set, `endpoint` in the user file is ignored; `TAPDANCE_ENDPOINT` or a project file's `endpoint` still selects one host. |
| `platforms.android.enabled` | `true` | boolean | `false` refuses Android leases and skips Android host checks in `doctor`. |
| `platforms.ios.enabled` | `true` | boolean | Same for iOS. |

### Session and lease

| Key | Default | Range | Meaning |
| --- | --- | --- | --- |
| `session.defaultTtlMinutes` | `30` | 1–240 | Lease time to live when `--ttl` / `ttl_minutes` is not given. |
| `session.keepalive` | `true` | boolean | After `device lease`, renew in a detached background process. |
| `session.maxSessionMinutes` | `240` | 1–1440 | The keepalive stops renewing after this long; the lease then expires on its own. |
| `session.leaseWaitSeconds` | `330` | 0–3600 | How long a lease request may wait in the queue. The Simlock provider caps it at 330 s. |
| `session.idleReleaseMinutes` | `30` | 0–1440 | Release a lease nobody has used for this long. `0` never. Enforced by the background keepalive and the MCP server (not by `device lease --hold`). |
| `session.settleSeconds` | `15` | 0–300 | Android emulators: once the leased guest has booted with no "isn't responding" or crash dialog in front (waited for up to 90 s, an ANR answered with Wait), how long the lease checks its CPU before handing it out. 3 calm readings in a row or a clearly falling load end the check early; a guest still busy goes out with a notice (commands work, 2-10 s each for a few minutes). With 15 or less, a guest whose first 3 readings are all 80 % or more and not falling goes out at once (after about 5 s) with that notice, since it stays busy far longer than the check (55-60 s after a release on a Google Cloud N2 VM); a larger value waits for it instead. The snapshot-helper warm-up (#102, at most 15 s) runs alongside this check, so a lease takes about the longer of the two. `0` skips the CPU check (the boot and dialog checks still run). Raise it when the first minute's slower commands matter (timing-sensitive tests); each lease then waits up to that long on a busy host. `device lease --settle` and MCP `lease_device` `settle_seconds` override it per lease. A project file may set it. |

### iOS backend

| Key | Default | Values | Meaning |
| --- | --- | --- | --- |
| `ios.uiBackend` | `"agent-device"` | `agent-device`, `axe` | How Tapdance drives iOS simulators. `agent-device` works locally and through gateways. `axe` uses [AXe](https://github.com/cameroncooke/AXe) and works only when Tapdance runs on the Mac hosting the simulator; it ran on a real Mac with a custom app's sign-in flow ([evidence](testing/evidence/2026-11-01-axe.md), STATUS U-02). |
| `ios.axePath` | none | path | The `axe` executable, when it is not on `PATH`. User config only ([why](#security-settings-are-user-only)). |

### Artifacts

| Key | Default | Meaning |
| --- | --- | --- |
| `artifacts.directory` | `"./tapdance-artifacts"` | Where screenshots, recordings and logs go. Each session gets a subfolder with a `manifest.json`. |

### Browser viewer

| Key | Default | Range | Meaning |
| --- | --- | --- | --- |
| `viewer.host` | `"127.0.0.1"` | | Address `tapdance view` listens on. Public addresses are refused. |
| `viewer.port` | `4710` | 0–65535 | Port for `tapdance view`. |
| `viewer.humanHoldMs` | `15000` | 0–600000 | How long a person's touch blocks agent input (`HUMAN_HELD`). |

### External tools

| Key | Default | Meaning |
| --- | --- | --- |
| `tools.mcpEnabled` | `["asc", "android", "axe", "maestro"]` | Tools agents may run through MCP `execute_tool`. |
| `tools.allowMutation` | `[]` | Tools agents may run without their read-only switch (`asc`), or at all when they have none (`fastlane`, `xcodebuild`). The agent must still pass `allow_mutation: true`. |
| `tools.paths` | `{}` | Absolute executable paths per tool, e.g. `{"asc": "/opt/homebrew/bin/asc"}`, when a tool is not on `PATH`. The file name must match the tool. |

All three are read only from the user config or the environment
([why](#security-settings-are-user-only)), for example
`tapdance config set --global tools.allowMutation '["asc"]'`. See [tools.md](tools.md).

### Simlock

| Key | Default | Meaning |
| --- | --- | --- |
| `simlock.profilePath` | `$SIMLOCK_HOME/agent-device-profile.json` (`~/.simlock/…`) | Local mode only: where the local Simlock worker writes the agent-device URL and token Tapdance connects with. User config or `TAPDANCE_SIMLOCK_PROFILE` only ([why](#security-settings-are-user-only)). |

## Credentials

Tokens never go in config files. A config file containing `token` or `operatorToken` at the top level is
refused, and `tapdance config set` refuses keys containing "token" or "secret".

| Credential | Used for | Where it comes from (later wins) |
| --- | --- | --- |
| Agent token | `self-hosted` mode: every device call to the gateway or worker | `~/.tapdance/credentials.json` `"token"` (bound to `"endpoint"`), then `TAPDANCE_TOKEN` |
| Connect target tokens | `self-hosted` mode with `targets`: calls to each target | `~/.tapdance/credentials.json` `"tokens"`, a map from origin to token written by `tapdance connect`; each goes only to its origin. `TAPDANCE_TOKEN` is not used for targets. |
| Operator token | `tapdance workers list` and the workers check in `doctor` through a gateway | `~/.tapdance/credentials.json` `"operatorToken"` (bound to `"operatorEndpoint"`), then `TAPDANCE_OPERATOR_TOKEN` |

Store them with:

```bash
printf '%s' "$AGENT_TOKEN" | tapdance config set-token --endpoint https://gateway.example.com
printf '%s' "$OPERATOR_TOKEN" | tapdance config set-token --operator --endpoint https://gateway.example.com
```

The credentials file is written with mode 600 in a directory with mode 700. `tapdance gateway setup`
fills it for the gateway machine unless you pass `--no-configure-here`.

### Token binding

`tapdance config set-token` stores the token together with the origin (scheme, host and port) of the
endpoint it is for: `--endpoint <url>`, or by default the endpoint currently configured for
self-hosted mode. It prints "Saved agent token for <origin> to <file>". When no endpoint is known, the
token is saved without an origin and works like an older credentials file (below). Tapdance sends a
bound token only to its origin:

- If the configured `endpoint` has a different origin, the call fails with `AUTH_FAILED` "Your saved
  token belongs to <origin>, but the configuration points at <other origin> (from <source>)", where
  the source is `tapdance.config.json`, `TAPDANCE_ENDPOINT` or your user config, and no token is
  sent. This stops a project `tapdance.config.json` from redirecting your token to a server
  of its choosing. If you trust the new endpoint, run
  `tapdance config set-token --endpoint <origin>` again; otherwise remove `endpoint` from the project
  file.
- A credentials file written before token binding (no `endpoint` in it) still works, but only with an
  endpoint from the user config or `TAPDANCE_ENDPOINT`. An endpoint from a project file fails with
  `CONFIG_INVALID` ("This project's tapdance.config.json points at <origin>, and your token is not
  bound to any endpoint") until you re-run `tapdance config set-token` in that project to bind the token, or
  set `TAPDANCE_ENDPOINT`.
- A token from `TAPDANCE_TOKEN` has no bound origin and follows the same rule as an older file.
- The operator token works the same way with `operatorEndpoint`.

`set-token` validates the URL and refuses plain `http://` to a public host, as the `endpoint` key does.

Local mode needs no token from you: Tapdance reads the local worker's agent-device profile
(`simlock.profilePath`).

What the tokens can do, plainly:

- An **agent token** on a Simlock worker or gateway is close to **shell access on the worker** as the
  user who runs the worker daemon. Simlock's documentation says to treat it that way. Leasing is not a
  sandbox. Give one token per agent and revoke it when done.
- An **operator token** can lease and release any device, install runtimes and read configuration on
  every worker behind the gateway. Agents never get it: the MCP server and device commands do not load
  it.
- A **worker join token** joins one worker to a gateway. A joined worker gives that gateway operator
  rights on its devices.
- Never commit any of them. Use TLS or a private network (for example Tailscale) between machines.

## Environment variables

### Configuration overrides

| Variable | Overrides | Notes |
| --- | --- | --- |
| `TAPDANCE_HOME` | `~/.tapdance` | Folder for the user config, credentials, `identity.json` and `sessions/`. |
| `TAPDANCE_CONFIG` | nearest `tapdance.config.json` | Path to the project config. `--config` wins over it. |
| `TAPDANCE_PROVIDER` | `provider` | |
| `TAPDANCE_ENDPOINT` | `endpoint` | |
| `TAPDANCE_ARTIFACTS_DIR` | `artifacts.directory` | |
| `TAPDANCE_TTL_MINUTES` | `session.defaultTtlMinutes` | Must be an integer. |
| `TAPDANCE_SETTLE_SECONDS` | `session.settleSeconds` | Must be an integer, 0–300. |
| `TAPDANCE_VIEWER_PORT` | `viewer.port` | Must be an integer. |
| `TAPDANCE_SIMLOCK_PROFILE` | `simlock.profilePath` | |

### Secrets

| Variable | Meaning |
| --- | --- |
| `TAPDANCE_TOKEN` | Agent token for a self-hosted gateway or worker. |
| `TAPDANCE_OPERATOR_TOKEN` | Operator token for fleet views. |
| `TAPDANCE_MCP_TOKEN` | Bearer token for `tapdance mcp --http`. Without it, one is generated and printed once. |
| `TAPDANCE_WORKER_TOKEN` | Join token for `tapdance worker login`; otherwise read from stdin or a prompt. |

### Behaviour

| Variable | Meaning |
| --- | --- |
| `TAPDANCE_SESSION_ID` | Session identity. Overrides the agent's own session variable. See [session identity](cli-reference.md#session-identity). |
| `CLAUDE_CODE_SESSION_ID`, `CODEX_SESSION_ID`, `PI_SESSION_ID` | Read, in that order, when `TAPDANCE_SESSION_ID` is unset. Set by the agent tools, not by you. |
| `TAPDANCE_ALLOWED_ROOTS` | Extra directories (colon-separated; semicolon on Windows) from which the MCP server accepts `install_app` paths and `execute_tool` `cwd`, besides its working directory. |
| `TAPDANCE_DEBUG` | Any value: print the underlying stack trace with CLI errors. |
| `TAPDANCE_GUARD_PAIR_NONINTERACTIVE` | Any value: lets `tapdance worker guard pair` (and the pairing step of `tapdance host up`) run without a terminal on stdin. For scripted setup by the Mac's owner only; never set it in a service environment, because anything that can then run `guard pair` can mint a token. |
| `TAPDANCE_GUARD_DEBUG` | Any value, in the environment of `tapdance worker guard start`: the guard prints, on stderr, each request it forwards to Simlock with its method, path, content type and timings, and for every refused agent-device RPC the request's shape (key names and value types, three levels deep, never the values) so a missing allowlist entry can be found. Off by default. |
| `NO_COLOR` | Any value: no colours in CLI output. |

### Read from the platform tools

| Variable | Meaning |
| --- | --- |
| `SIMLOCK_HOME` | Simlock's data folder (default `~/.simlock`): the local agent-device profile, Simlock's config and its private adb server port. |
| `ANDROID_HOME`, `ANDROID_SDK_ROOT` | Android SDK location, checked in that order; then `~/Library/Android/sdk` on macOS. |

### Integration tests only

`TAPDANCE_IT_PLATFORM`, `TAPDANCE_IT_DEVICE`, `TAPDANCE_IT_OS`, `TAPDANCE_IT_APP`, `TAPDANCE_IT_APP_ID`
control `pnpm test:integration` (see the [evidence page](testing/evidence/2026-11-01-local-ios.md)).

## Files Tapdance writes

| Path | Contents |
| --- | --- |
| `tapdance.config.json` | Project config (`init`, `config set`). Safe to commit; it holds no secrets. |
| `~/.tapdance/config.json` | User config. |
| `~/.tapdance/credentials.json` | Tokens and the endpoint origin each one is bound to, mode 600. Never commit or share. |
| `~/.tapdance/identity.json` | The per-user CLI session id. |
| `~/.tapdance/sessions/` | One record per session's lease, its lock file, and the viewer's human-hold file. |
| `<artifacts.directory>/<session>/` | Screenshots, recordings, logs, external tool output, `manifest.json`. Add the folder to `.gitignore`. |
