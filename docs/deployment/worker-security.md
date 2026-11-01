# Worker security

This page says plainly what a Tapdance worker exposes, who can do what to it, and how to keep it
contained. It applies to every worker: your laptop, a Mac, a Google Cloud VM, an OVHcloud instance or a
dedicated server. Most of the behaviour described here belongs to
[Simlock](https://github.com/callstackincubator/simlock) (MIT), which runs the worker and the
gateway; Tapdance adds guard rails on top but does not change Simlock's trust model.

## The four facts to remember

1. **An agent token is close to shell access on the worker, as the user running the worker daemon.**
   Simlock runs `adb` and `simctl` commands on the worker for a lease's holder, and agent-device runs
   there too. `simctl spawn` alone can start any program; `adb pull` and similar commands read and
   write files as that user. This holds through a gateway: the command runs on whichever worker holds
   the lease. Simlock's own docs say to treat an agent token like shell access.
2. **A joined worker gives its gateway operator rights.** Whoever controls the gateway, or holds an
   operator token for it, can lease and release any device on the worker, install and remove runtimes
   and images, and read the worker's configuration. Join a worker only to a gateway you trust as much
   as the worker itself. `tapdance worker login` refuses unless you pass `--accept-gateway-exec`, so
   that joining is always a deliberate choice.
3. **Leasing is not a sandbox.** A lease reserves a device for one requester; it does not isolate the
   requester from the machine. Two agents on one worker are not isolated from each other's files. A
   multi-tenant service would need a separate worker or VM per tenant.
4. **Remote use needs TLS or a private network.** Simlock has no TLS of its own. Put Caddy (or another
   reverse proxy) in front of the gateway, or use Tailscale, WireGuard or an SSH tunnel. Tapdance
   refuses to send a token over plain `http://` or `ws://` to a public address.

**On a personal Mac, use device-only mode.** Run `tapdance worker guard` and let the control machine
reach the guard over a private network, rather than joining a gateway with
`tapdance worker login --accept-gateway-exec`, which gives the gateway command execution on the Mac.
The guard enforces a local policy, its own revocable tokens approved at the Mac, an allowlisted device
API, limits and an audit log. It was verified on one Mac with a real simulator; the dedicated-account
script and Tailscale exposure are untested. See [personal-mac.md](../security/personal-mac.md).

## Tokens and where they live

| Token | Who has it | Stored at | If it leaks |
| --- | --- | --- | --- |
| Agent token | Each agent's machine | `~/.tapdance/credentials.json` (mode 600), or `TAPDANCE_TOKEN` | Holder can lease devices and run commands on any worker of that gateway. Revoke it. |
| Operator token | You | `~/.tapdance/credentials.json` (`operatorToken`), or `TAPDANCE_OPERATOR_TOKEN` | Full control of the gateway and all its workers. Revoke it. |
| Worker join token | One worker | `~/.simlock/config.json` on the worker, plain text, readable only by its user | Only opens that worker's uplink, and only for the worker it is paired with. Revoke it and mint a new one. |
| Gateway's copies | The gateway | Hashes only, in `~/.simlock/gateway` | — |
| Viewer key | One browser | URL fragment, then an HttpOnly cookie; dies with `tapdance view` | Control of that one leased device until the viewer stops. |
| MCP HTTP bearer | Remote MCP clients | `TAPDANCE_MCP_TOKEN` or printed at start | Acts as an agent through that MCP server. |
| Worker-guard token (`tdg_…`) | One control machine paired with a Mac in device-only mode | `~/.tapdance/credentials.json` on the control machine, bound to the guard URL; only a hash on the Mac | The guard's device API on that Mac, within its policy. `tapdance worker guard revoke <id>` on the Mac. |

Rules Tapdance enforces:

- Config files never hold tokens. Loading a config with `token` or `operatorToken` in it fails, and
  `tapdance config set` refuses token-like keys. Use `tapdance config set-token` (hidden input or
  stdin) or environment variables.
- Error messages, `tapdance report` output and tool output redact Simlock secrets (`slk_…`), bearer
  headers and private keys.
- The operator token is loaded only for fleet views (`tapdance workers list`, `doctor`); MCP tools and
  device commands never get it.
- MCP tools never return enrollment secrets, and there is no MCP tool for raw shell, `adb` or `simctl`.
  Tapdance uses Simlock's command endpoint internally for a fixed list only: stopping an app, a logcat
  dump, the crash buffer, the simulator log query.

What it cannot enforce: someone who holds an agent token can call Simlock's HTTP API directly and
skip Tapdance's guard rails. That is why fact 1 matters.

**Never commit tokens.** That includes `.env` files, Terraform variable files and state, CI logs and
screenshots of terminals. If one leaks, revoke it:

```bash
tapdance simlock --gateway token list
tapdance simlock --gateway token revoke <token id>
```

## Running a worker safely

| Do | Why |
| --- | --- |
| Run the worker under a dedicated OS user with no sudo, on servers (`tapdance` in the [dedicated server guide](dedicated-linux-server.md)). | Commands run as this user; keep your files and admin rights out of reach. |
| On a personal laptop, consider a separate user account for the worker. See [personal-mac.md](../security/personal-mac.md). | Same reason. Untested with Tapdance. |
| Open no inbound ports on the worker. | It dials out to the gateway. SSH only from your own addresses or IAP. |
| Never expose `adb`, the emulator console, Simlock's adb server port (5038) or Simlock's HTTP port on a network. | They are unauthenticated or token-only device control. |
| Mint one agent token per agent and label it. | You can revoke one without breaking the others, and Simlock gives each token one lease at a time by default. |
| Keep cloud credentials, signing keys and personal secrets off workers. | Anything the daemon user can read, an agent can read. |
| For iOS workers, keep Apple signing certificates and App Store Connect keys off the worker unless that machine must sign builds; prefer a separate keychain and account. | Same reason (X-05 is documentation-only today). |
| Keep Tapdance (and so Simlock) the same version on gateway and workers. | Incompatible versions refuse to talk, and old versions miss fixes. Tapdance pins Simlock 0.4.0. |

## The worker owner's controls

Simlock has **no per-operation approval prompt** on the worker ("allow this agent to install X?").
That requirement (X-08) is blocked upstream. What you can do instead:

| Control | Command |
| --- | --- |
| Turn the live screen and remote input off | `tapdance worker login … --no-viewer` or `tapdance worker install --no-stream` |
| Stop serving now | `tapdance worker stop` |
| Stop taking new leases, let current ones finish (gateway side) | `tapdance simlock --gateway worker drain <worker id>` |
| Leave the gateway | `tapdance worker logout`, then revoke the join token on the gateway |
| Revoke an agent | `tapdance simlock --gateway token revoke <token id>` |
| See what happened | `tapdance worker logs`, and on the gateway `tapdance simlock --gateway events` |

Simlock also has a `capabilities.tunnel` module that reverses device ports to a lease holder's machine.
It is off by default and Tapdance does not turn it on; leave it off unless you need it.

## Devices and data

- Simlock leases only devices it created. Your own AVDs and Xcode simulators are never handed out.
- A released device is wiped. Installed apps and their data are gone.
- Simlock refuses dangerous verbs through its command endpoint, but that is a narrow filter, not a
  security boundary.
- Artifacts (screenshots, recordings, logs) are written on the agent's machine under
  `artifacts.directory/<session>/`. They can contain whatever was on screen, including test account
  details; treat the directory as sensitive and keep it out of git.

## Browser viewer

`tapdance view` listens on loopback by default, refuses public addresses, carries a one-time key in
the URL fragment, swaps it for an HttpOnly cookie, and checks `Host` and `Origin` headers. Anyone with
the link and network access to the port can control the leased device while the viewer runs. See
[browser access](browser-access.md).

## What has been verified

Token handling, redaction and the refusal of plain-text remote URLs are covered by unit tests. The
viewer's key, cookie and checks were exercised on one Mac. No two-machine setup has been run yet. See
[STATUS.md](../../STATUS.md) (X-01 to X-08, W-01).
