# Security policy

## Reporting a vulnerability

Please report security problems privately. Do not open a public issue, discussion or pull request for
them.

- Use GitHub's private vulnerability reporting: open the repository's **Security** tab and choose
  **Report a vulnerability**.
- Include the Tapdance version (`tapdance --version`), your topology (local, laptop worker, KVM
  worker, cloud Mac), the steps to reproduce, and what an attacker gains.
- `tapdance report` output can help. It redacts tokens it recognises, but read it before you send it.
- Never include real tokens, join tokens, App Store Connect keys, signing material or other secrets.

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
laptop you join to a gateway, a Linux server with KVM, or a rented Mac. The important facts are about
the machines, not the devices.

**Leasing is not a sandbox.** A lease reserves a device for one session. It does not isolate the
agent from the machine that runs the device.

**An agent token on a Simlock worker is close to shell access as the worker daemon's user.**
Simlock's `exec` endpoint runs `adb` and `simctl` commands on the worker for a lease, and
`simctl spawn` alone can start any program there. agent-device runs on the worker too. Tapdance never
offers raw `adb`, `simctl` or shell as an MCP tool, but anyone who holds the agent token can call
Simlock's HTTP API directly. Give an agent token only to something you would let run commands on that
machine. Simlock's own documentation (gateway access control) says the same.

**A joined worker gives its gateway operator rights on that worker.** Whoever controls the gateway,
or holds an operator token for it, can lease and release any device on the worker, install and
remove runtimes, and read its configuration. Join a worker only to a gateway you trust as much as the
worker machine itself. This matters most when the worker is your personal laptop.

**Remote use needs TLS or a private network.** Simlock does not do TLS. For anything beyond one
machine, put a reverse proxy with HTTPS (for example Caddy) in front of the gateway, or keep all
traffic on a private network such as Tailscale. Tapdance refuses a `ws://` gateway URL that points
to a public host, because the join token would travel in plain text.

**Never commit tokens.** Tapdance refuses to load a config file that contains `token` or
`operatorToken`. Store tokens with `tapdance config set-token` (written to
`~/.tapdance/credentials.json` with mode 600) or pass them in `TAPDANCE_TOKEN` and
`TAPDANCE_OPERATOR_TOKEN`. `tapdance gateway setup` and `tapdance gateway token` print newly minted
tokens once, unredacted, on purpose: copy them to where they belong and do not leave them in shell
logs, CI output or issue reports.

**The app under test is untrusted input.** Text on screen and in logs can try to instruct the agent.
The MCP server tells agents to treat it as data, but Tapdance cannot stop an agent from following it.

## What Tapdance does to protect you

| Area | Protection |
| --- | --- |
| Device scope | No command or MCP tool takes a device id. Every action resolves the current session's lease. Release only targets that lease. Simlock and agent-device enforce token ownership underneath. |
| Tool surface | No raw shell, `adb` or `simctl` MCP tool. Tapdance uses Simlock `exec` internally for a fixed allowlist only (stop app, logcat dump, crash buffer, simulator log query). |
| App uploads | MCP `install_app` paths must be inside the working directory or a root listed in `TAPDANCE_ALLOWED_ROOTS`. `.ipa` and `.aab` files are refused for simulators and emulators. |
| External tools | Run with an argument array, never a shell. Only allowed environment variables are passed. Timeouts and output caps apply. Device tools act only on the leased device and refuse caller-supplied device flags. Agents may run only tools in `tools.mcpEnabled`. `asc` runs with `ASC_READ_ONLY=1` for agents unless the user lists it in `tools.allowMutation`; fastlane, which has no read-only mode, needs that listing too. |
| Secrets | Tokens are redacted from errors, logs, tool output, MCP responses and `tapdance report` (Simlock `slk_` secrets, bearer headers, PEM private keys, token-like JSON keys). The operator token is never loaded for agent sessions. |
| Worker join | `tapdance worker login` reads the join token from `TAPDANCE_WORKER_TOKEN`, stdin or a hidden prompt; there is no flag for it, so it does not land in shell history. (It is passed briefly as a process argument to the bundled `simlock config set gateway …`, so another process of the same user, or root, could see it in `ps` while that runs.) `worker login` also refuses unless you pass `--accept-gateway-exec`, acknowledging that the gateway and its agent tokens can run programs on the worker. `ws://` to public hosts is refused. |
| Browser viewer | Loopback by default; public addresses are refused. One-time key in the URL fragment, then an HttpOnly cookie. Host and Origin checks against DNS rebinding. The Simlock token stays on the server side. |
| MCP over HTTP | `tapdance mcp --http` listens on 127.0.0.1 by default and requires a bearer token (`TAPDANCE_MCP_TOKEN`, or one generated and printed once). Each MCP session gets its own Tapdance session and lease. |
| Emulation | Tapdance never falls back to software emulation when KVM is missing; it reports the problem instead. |

## What Tapdance does not protect against

- **A malicious or compromised agent with a valid agent token.** It can reach the worker as the
  daemon user through Simlock's API. Use dedicated worker machines or VMs for untrusted agents.
- **A malicious gateway operator.** A joined worker trusts its gateway.
- **Multi-tenant hosting.** Leases are not tenant isolation. A shared, hosted service needs separate
  workers or VMs per tenant. Tapdance does not offer one.
- **Network attackers when you skip TLS.** The MCP HTTP server, the viewer and Simlock speak plain
  HTTP. Use HTTPS in front of them or a private network.
- **Long-lived credentials.** Simlock tokens do not expire on their own. Revoke tokens you no longer
  need on the gateway.
- **Per-operation approval on a personal worker.** Simlock has no "ask the owner first" prompt. The
  worker owner's controls are which gateway the worker joins, Simlock's `capabilities.*` switches,
  draining, token revocation, and stopping the daemon (see STATUS.md, X-08).
- **Bypassing the viewer's human hold.** When a person takes over in `tapdance view`, Tapdance
  refuses agent input with `HUMAN_HELD`. Simlock does not enforce this, so another client using the
  same token directly is not stopped.
- **Artifacts at rest.** Screenshots, recordings and logs are plain files in per-session directories
  on your disk. They can show anything the app displayed. Protect and delete them yourself.
- **Apple signing credentials and keychains on Mac workers.** Tapdance documents guidance but does
  not manage them (STATUS.md, X-05).

For worker hardening, see [docs/deployment/worker-security.md](docs/deployment/worker-security.md).
The current state of each security requirement is in [STATUS.md](STATUS.md) under "Security".


## Personal Macs

A joined worker gives its gateway command execution on that machine. For a personal Mac use device-only mode
(`tapdance worker guard`), which enforces a local allowlist, its own revocable tokens, limits and an audit log on
the Mac itself: [docs/security/personal-mac.md](docs/security/personal-mac.md).
