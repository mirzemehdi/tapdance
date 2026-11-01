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
| 3 | Project config `tapdance.config.json` | The nearest one found walking up from the working directory (like git finds `.git`). Replaced by `--config <path>` or `TAPDANCE_CONFIG`, which must exist. |
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

## Keys

### Provider

| Key | Default | Values | Meaning |
| --- | --- | --- | --- |
| `provider` | `"local"` | `local`, `self-hosted`, `cloud` | `local`: the Simlock worker on this machine. `self-hosted`: a Simlock gateway or worker at `endpoint`. `cloud`: reserved for a future hosted provider; refused today with `NOT_SUPPORTED`. |
| `endpoint` | none | `http://` or `https://` URL | Base URL of the Simlock gateway or worker for `self-hosted`, e.g. `https://gateway.example.com`. Plain `http://` is refused unless the host is private (loopback, RFC 1918, link-local, Tailscale's 100.64.0.0/10, `*.ts.net`), because the token would travel unencrypted. |
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

### iOS backend

| Key | Default | Values | Meaning |
| --- | --- | --- | --- |
| `ios.uiBackend` | `"agent-device"` | `agent-device`, `axe` | How Tapdance drives iOS simulators. `agent-device` works locally and through gateways. `axe` uses [AXe](https://github.com/cameroncooke/AXe) and works only when Tapdance runs on the Mac hosting the simulator; it is written and unit-tested but has not run on a real Mac yet (STATUS U-02). |
| `ios.axePath` | none | path | The `axe` executable, when it is not on `PATH`. |

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
| `tools.paths` | `{}` | Absolute executable paths per tool, e.g. `{"asc": "/opt/homebrew/bin/asc"}`, when a tool is not on `PATH`. |

See [tools.md](tools.md).

### Simlock

| Key | Default | Meaning |
| --- | --- | --- |
| `simlock.profilePath` | `$SIMLOCK_HOME/agent-device-profile.json` (`~/.simlock/…`) | Local mode only: where the local Simlock worker writes the agent-device URL and token Tapdance connects with. |

## Credentials

Tokens never go in config files. A config file containing `token` or `operatorToken` at the top level is
refused, and `tapdance config set` refuses keys containing "token" or "secret".

| Credential | Used for | Where it comes from (later wins) |
| --- | --- | --- |
| Agent token | `self-hosted` mode: every device call to the gateway or worker | `~/.tapdance/credentials.json` `"token"`, then `TAPDANCE_TOKEN` |
| Operator token | `tapdance workers list` and the workers check in `doctor` through a gateway | `~/.tapdance/credentials.json` `"operatorToken"`, then `TAPDANCE_OPERATOR_TOKEN` |

Store them with:

```bash
printf '%s' "$AGENT_TOKEN" | tapdance config set-token
printf '%s' "$OPERATOR_TOKEN" | tapdance config set-token --operator
```

The credentials file is written with mode 600 in a directory with mode 700. `tapdance gateway setup`
fills it for the gateway machine unless you pass `--no-configure-here`.

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
| `~/.tapdance/credentials.json` | Tokens, mode 600. Never commit or share. |
| `~/.tapdance/identity.json` | The per-user CLI session id. |
| `~/.tapdance/sessions/` | One record per session's lease, its lock file, and the viewer's human-hold file. |
| `<artifacts.directory>/<session>/` | Screenshots, recordings, logs, external tool output, `manifest.json`. Add the folder to `.gitignore`. |
