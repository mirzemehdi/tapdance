# Security policy

## Reporting a vulnerability

Please report security problems privately. Do not open a public issue, discussion or pull request for
them.

- Use GitHub's private vulnerability reporting: open the repository's **Security** tab and choose
  **Report a vulnerability**.
- Include the Tapdance version (`tapdance --version`), your setup (local mode, a host in device-only
  mode, gateway mode; Mac, Linux with KVM, or a rented Mac), the steps to reproduce, and what an
  attacker gains.
- `tapdance report` output can help. It redacts tokens it recognises, but read it before you send it.
- Never include real tokens (`slk_…`, `tdg_…`), join tokens, App Store Connect keys, signing material or
  other secrets.

We will acknowledge the report, agree on a fix and a disclosure date with you, and credit you unless
you prefer otherwise. Tapdance is a volunteer-run open-source project at version 0.1.0 (unreleased),
so we cannot promise a response time, but security reports come first.

If the problem is in an upstream project, report it there as well:
[Simlock](https://github.com/callstackincubator/simlock),
[agent-device](https://github.com/callstack/agent-device),
[AXe](https://github.com/cameroncooke/AXe), or
[asc](https://github.com/rorkai/App-Store-Connect-CLI).

## Supported versions

| Version | Supported |
| --- | --- |
| `main` / 0.1.x | Yes |

## Threat model in short

Tapdance lets an AI agent control mobile devices that run on machines you own: your own computer, a
Mac or Linux **host** you set up for a remote agent, or a rented Mac. The important facts are about the
hosts, not the devices.

- **Use device-only mode for a remote agent.** The host runs the **guard**, the only thing the agent's
  machine can reach. It allows a fixed list of device actions, checks a pairing token (`tdg_…`) on each
  request, and logs every request. Tokens are approved, scoped and revoked on the host. `tapdance host
  up` sets it up. See [device-only mode](docs/security/device-only-mode.md).
- **On iOS, installing an app is code execution on the Mac.** A simulator app runs as the account that
  runs the worker. So do host builds: a repository's build scripts run on the host. Host from a
  dedicated standard account, and give tokens only the scopes they need.
- **The only shell is inside an Android emulator.** `device_shell` (CLI `tapdance device shell`) runs a
  command with `adb shell` inside a leased Android emulator, never on the host. It is refused on iOS and
  on physical phones, and the host's owner can turn it off (`allow.deviceShell: false` in the guard's
  policy).
- **Leasing is not a sandbox.** A lease reserves a device for one session. It does not isolate the
  agent from the host.
- **Gateway mode trusts the gateway.** A Simlock agent token is close to shell access on the worker,
  and a worker that joins a gateway gives it operator rights; `tapdance worker login` refuses unless you
  pass `--accept-gateway-exec`. Use gateway mode only for dedicated machines. See
  [gateway mode](docs/deployment/gateway-mode.md).
- **Remote use needs TLS or a private network.** Simlock, the guard, the viewer and the MCP HTTP server
  speak plain HTTP. `host up` serves the guard over Tailscale. Tapdance refuses to send a token over
  plain `http://` or `ws://` to a public host.
- **Never commit tokens.** Tapdance refuses to load a config file that contains `token` or
  `operatorToken`. `tapdance connect` and `tapdance config set-token` store tokens in
  `~/.tapdance/credentials.json` (mode 600), each bound to its origin. `tapdance gateway setup` and
  `tapdance gateway token` print newly minted tokens once, unredacted, on purpose: copy them to where
  they belong and keep them out of shell logs, CI output and issue reports.
- **The repository is untrusted input.** A `tapdance.config.json` in a repository you open cannot set
  `tools.paths`, `tools.mcpEnabled`, `tools.allowMutation`, `ios.axePath` or `simlock.profilePath`
  (they are read only from `~/.tapdance/config.json` or the environment), and cannot redirect a saved
  token ([token binding](docs/configuration.md#token-binding)).
- **The app under test is untrusted input.** Text on screen and in logs can try to instruct the agent.
  The MCP server tells agents to treat it as data, but Tapdance cannot stop an agent from following it.

The full picture, per token and per platform: [threat model](docs/security/threat-model.md).

## What Tapdance does to protect you

| Area | Protection |
| --- | --- |
| Remote hosts | The guard: a fixed list of routes, agent-device commands and exact `exec` argument lists; per-client lease ownership; session, TTL and upload limits; refuses root, administrator accounts (unless allowed), a joined gateway, and policy files others can write; an audit log. See [device-only mode](docs/security/device-only-mode.md#what-the-guard-enforces-on-the-host). |
| Device scope | No command or MCP tool takes a device id. Every action resolves the current session's lease. Release only targets that lease. |
| Tool surface | No MCP tool for a shell on the host, `adb` or `simctl`. The only shell is `device_shell`, inside a leased Android emulator. Tapdance uses Simlock `exec` internally for one fixed list of commands (`device-commands.ts`): stopping and killing apps, logs and crash buffers, intents and deep links, files in and out of the device, notifications, app language, the status bar clock, timed taps. Settings and performance readings go through agent-device commands that the guard also allowlists. |
| App uploads | MCP `install_app` paths must be inside the working directory or a root listed in `TAPDANCE_ALLOWED_ROOTS`. A signed `.ipa` is refused for simulators. An `.aab` is turned into a universal APK with bundletool on the agent's machine before upload. |
| Host builds and installs from CI | Off by default. The host's owner allow-lists repositories (and optionally protected branches); git and GitHub credentials stay on the host. |
| External tools | Run with an argument array, never a shell. Only allowed environment variables are passed. Timeouts and output caps apply. Device tools act only on the leased device and refuse caller-supplied device flags. Agents may run only tools in `tools.mcpEnabled`. `asc` runs with `ASC_READ_ONLY=1` for agents unless the user lists it in `tools.allowMutation`; without that, agents are also refused `asc auth` (except `auth status`), `asc workflow` and `asc install-skills`, which print credentials or run shell steps. fastlane, which has no read-only mode, needs that listing too. These keys are read only from the user config. |
| Secrets | Tokens are redacted from errors, logs, tool output (including the saved output files), MCP responses and `tapdance report` (Simlock `slk_` and pairing `tdg_` secrets, bearer headers, JWTs, PEM private keys, `*_KEY_B64=` values, viewer keys, token-like JSON keys). The operator token is never loaded for agent sessions. Tokens are sent only to the origin they were saved for. |
| Browser viewer | Loopback by default; public addresses are refused. One-time key in the URL fragment, then an `HttpOnly` cookie. `Host` and `Origin` checks against DNS rebinding. The token stays on the server side. |
| MCP over HTTP | `tapdance mcp --http` listens on 127.0.0.1 by default and requires a bearer token (`TAPDANCE_MCP_TOKEN`, or one generated and printed once). Each MCP session gets its own Tapdance session and lease. |
| Emulation | Tapdance never falls back to software emulation when KVM is missing; it reports the problem instead. |

In gateway mode, `tapdance worker login` reads the worker's join token from `TAPDANCE_WORKER_TOKEN`,
stdin or a hidden prompt, never a flag, so it does not land in shell history. It is passed briefly as a
process argument to the bundled `simlock config set gateway …`, so another process of the same user, or
root, could see it in `ps` while that runs. More in [gateway mode](docs/deployment/gateway-mode.md).

## What Tapdance does not protect against

- **A malicious agent with a pairing token that allows `install`, on iOS.** The app it installs runs as
  the hosting account. Use a dedicated account, or a token without `install`.
- **A malicious or compromised agent with a Simlock agent token** (gateway mode, or a worker without a
  guard). It can reach the host as the worker's user through Simlock's API.
- **A malicious gateway operator.** A joined worker trusts its gateway.
- **Long-lived Simlock tokens.** Simlock tokens do not expire on their own; revoke the ones you no
  longer need on the gateway. (Pairing tokens expire, 7 days by default.)
- **Multi-tenant hosting.** Leases are not tenant isolation. A shared, hosted service needs separate
  hosts or VMs per tenant. Tapdance does not offer one.
- **Network attackers when you skip TLS** or a private network.
- **Build scripts.** A host build runs the repository's scripts as the hosting account, with no
  sandbox.
- **Per-operation approval.** Neither the guard nor Simlock asks the host's owner before each action.
  The owner's controls are the policy, token scopes, revocation and stopping the host.
- **Bypassing the viewer's human hold.** When a person takes over in `tapdance view`, Tapdance refuses
  agent input with `HUMAN_HELD`. Simlock does not enforce this, so another client using a token
  directly is not stopped.
- **Artifacts at rest.** Screenshots, recordings and logs are plain files in per-session directories
  on your disk. They can show anything the app displayed. Protect and delete them yourself.
- **Apple signing credentials and keychains on Mac hosts.** Tapdance documents guidance but does not
  manage them.

The current state of each security requirement is in [STATUS.md](STATUS.md) under "Security" and
"Protecting personal Macs".
