# Gateway mode (advanced)

> **Run on one Mac only.** A gateway and a joined worker ran on the same Mac, with the CLI, the MCP
> server and the viewer all working through the gateway
> ([evidence](../testing/evidence/2026-11-01-gateway-single-host.md)). Gateway mode has never run
> across two machines.
>
> **A gateway gets command execution on every worker that joins it.** That is why
> `tapdance worker login` refuses unless you pass `--accept-gateway-exec`.
>
> **For a remote agent, use device-only mode instead:** `tapdance host up` on the host and
> `tapdance connect` on the agent's machine ([host devices for a remote agent](one-command-host.md)).
> That path is proven across machines, and the agent reaches only a fixed device API.

A [gateway](../glossary.md) is a [Simlock](https://github.com/callstackincubator/simlock) server that
pools several workers behind one address. Each worker dials out to the gateway, so the worker needs no
open port. Agents talk to the gateway, and the gateway routes each lease to a worker.

## What you get

- One queue for several workers: Macs for iOS, Macs or Linux machines with KVM for Android.
- Workers that open no inbound port. They connect out to the gateway and reconnect on their own.
- The same CLI commands and MCP tools as in local mode.

## What you need

| Machine | Needs |
| --- | --- |
| Gateway | Linux or macOS, Node.js 22.13 or later, git, Corepack. No KVM, no Android SDK, no Xcode. It is usually the agent's machine, for example a Linux VPS. `tapdance gateway setup` has run on macOS only. |
| Each worker | macOS (Android and iOS) or Linux with KVM (Android only), Node.js 22.13 or later, and the SDKs for its platforms: see [Android](../platforms/android.md) and [iOS](../platforms/ios.md). Use a machine, or a user account, that holds nothing personal. |
| Network | When the worker is on another machine: TLS in front of the gateway (Caddy and a DNS name), or a private network such as Tailscale. |

Windows cannot be a worker: Simlock runs on macOS and Linux only, and `tapdance worker install`
refuses on Windows. A Windows machine is expected to run the CLI and MCP server against a gateway, but this has not been tested.

Install Tapdance from source on every machine ([installation](../installation.md)). It is not on npm
yet. Use the same Tapdance build everywhere: it pins Simlock 0.6.0, and gateway and worker must run
versions that can talk to each other.

## Steps

### 1. Start the gateway

On the gateway machine:

```bash
tapdance gateway setup --worker-label office-mac --public-url https://gateway.example.com
```

This command:

1. Starts a Simlock gateway that listens on `127.0.0.1:4700` only.
2. Turns on agent-device, live streaming and remote input on the gateway, and restarts it.
3. Mints three tokens: a **worker join token** labelled `office-mac`, an **agent token** for this
   machine, and an **operator token**.
4. Saves the agent and operator tokens in `~/.tapdance/credentials.json` (mode 600). It writes
   `~/.tapdance/config.json` with `provider: "self-hosted"` and `endpoint: "http://127.0.0.1:4700"`.
   Pass `--no-configure-here` to skip this step.
5. Prints the worker join token once. Keep it for step 4. Never paste it into a chat, an issue or a
   committed file.

`--public-url` only changes the instructions it prints: the worker's `worker login` line then names
your public address. `--agent-label` names this machine's agent token.

A project's own `tapdance.config.json` takes precedence over `~/.tapdance/config.json`. If a project
was set up with `--mode local`, point it at the gateway there:

```bash
tapdance init --mode self-hosted --endpoint http://127.0.0.1:4700 --force
```

The gateway does not start again after a reboot on its own. Simlock's own service command, through
Tapdance's bundled copy, may do it. This has not been tried with Tapdance:

```bash
tapdance simlock --gateway daemon install
loginctl enable-linger "$USER"
```

Simlock's docs disagree on whether a gateway service file ships. After a reboot, check with
`tapdance simlock -- --gateway daemon status`, or use your own service manager.

### 2. Make the gateway reachable

Skip this step when the worker runs on the gateway machine itself.

Simlock has no TLS of its own. `tapdance worker login` refuses a plain `ws://` address on the
internet, because the join token would travel in plain text. Plain `ws://` works only for private
addresses: loopback, a Tailscale `100.x.y.z` address, `*.ts.net` names, and the `10/8`, `172.16/12`
and `192.168/16` ranges. Tapdance also refuses to send any token over plain `http://` to a public
address. Never set Simlock's `http.host` to `0.0.0.0` on a public machine.

**Option A: Caddy and a DNS name.** Point `gateway.example.com` at the gateway machine, open ports 80
and 443, install [Caddy](https://caddyserver.com/), and use this Caddyfile (from Simlock's gateway
docs):

```text
gateway.example.com {
	reverse_proxy 127.0.0.1:4700 {
		flush_interval -1
	}
}
```

Caddy gets a certificate on its own and passes WebSocket upgrades. `flush_interval -1` passes streamed
responses (lease progress, the live screen) through without buffering. Workers then use
`wss://gateway.example.com`. A Caddy reload drops open WebSockets; workers reconnect within
30 seconds.

**Option B: Tailscale.** Put the gateway machine and every worker in one
[Tailscale](https://tailscale.com/) tailnet. Turn on HTTPS Certificates in the tailnet's DNS settings.
Then, on the gateway machine:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:4700
```

Workers then use `wss://<gateway-name>.<tailnet>.ts.net`. Nothing is public. Whether
`tailscale serve` passes Simlock's long-lived WebSocket and streamed responses well has not been
checked.

### 3. Prepare each worker

On the worker:

```bash
tapdance worker check
tapdance worker install --service
```

`worker check` reports the SDKs, images, Xcode, runtimes, and KVM on Linux. `worker install` sets up
the bundled Simlock worker with agent-device, streaming and input, and starts it. `--service` starts
it at login (a launchd LaunchAgent on macOS, a systemd user unit on Linux). A LaunchAgent runs only
while the user is logged in.

Simlock creates its own emulators and simulators from installed images and runtimes. Install one
with, for example:

```bash
tapdance devices install android 35
```

or `tapdance devices install ios 18.5` on a Mac.

On a Linux server with no display, turn on headless emulators before the first lease:

```bash
tapdance simlock -- --local config set android.emulator.headless true
```

An older install script for Ubuntu servers, `infrastructure/scripts/install-android-worker.sh`, is
kept for this path. It has been syntax-checked only, never run.

### 4. Join the worker to the gateway

On the gateway machine, mint a join token for each further worker (step 1 printed the first one):

```bash
tapdance gateway token --role worker --label office-mac
```

On the worker, join. Without piped input it asks for the token with hidden input, which keeps it out
of your shell history:

```bash
tapdance worker login --accept-gateway-exec --gateway wss://gateway.example.com --label office-mac
```

You can also pipe the token in (`--token-stdin` is the default when stdin is piped), or set
`TAPDANCE_WORKER_TOKEN` for this one command.

`--accept-gateway-exec` is required. It says you accept that the gateway, and every agent token it
issues, can run programs on this machine as the worker's user. Without it, `worker login` refuses with
`FORBIDDEN`. Read [what the gateway can do to a worker](#what-the-gateway-can-do-to-a-worker) first.

`worker login` sets these Simlock options and restarts the worker:

| Simlock key | Value |
| --- | --- |
| `http.enabled` | `false`: a joined worker is reached only through its gateway |
| `capabilities.agent-device.enabled` and `.command` | on, the bundled agent-device |
| `capabilities.stream.enabled`, `capabilities.input.enabled` | on, unless you pass `--no-viewer` |
| `gateway` | the URL, the join token and the label |

Simlock keeps the join token in plain text in `~/.simlock/config.json`, readable only by the worker's
user. The first worker that uses a token is paired with it; another machine with the same token is
refused.

### 5. Add agents on other machines (optional)

The gateway machine already has an agent token from step 1. For an agent on another machine, mint one
token per agent on the gateway machine:

```bash
tapdance gateway token --role agent --label my-laptop
```

On that agent's machine, point Tapdance at the gateway's TLS address and store the token. The token
is read from stdin, or from a hidden prompt:

```bash
tapdance init --mode self-hosted --endpoint https://gateway.example.com
tapdance config set-token --endpoint https://gateway.example.com
```

`config set-token` saves the token in `~/.tapdance/credentials.json` (mode 600), and Tapdance sends it
to that endpoint only. Add `--global` to `init` to write the per-user config instead of the project's
`tapdance.config.json`. To list workers from this machine as well, store an operator token with
`tapdance config set-token --operator`.

Give each agent its own token: Simlock treats one token as one requester, and by default a requester
holds one lease at a time.

### Gateway and worker on one Mac (the run that was proven)

The [evidence run](../testing/evidence/2026-11-01-gateway-single-host.md) had both on one Mac, with no
TLS step, because loopback is private:

```bash
tapdance gateway setup --worker-label mac-local
tapdance gateway token --role worker --label mac-local | tapdance worker login --accept-gateway-exec --gateway ws://127.0.0.1:4700 --label mac-local
tapdance workers list
```

## Check it worked

On the gateway machine:

```bash
tapdance workers list
tapdance devices
tapdance doctor
tapdance device lease --platform android
tapdance app install ./app/build/outputs/apk/debug/app-debug.apk
tapdance screenshot
tapdance device release
```

`workers list` should show your worker as `connected`; it needs the operator token that
`gateway setup` saved. `tapdance gateway status` shows the workers, devices and queue from the
gateway's side. Use `--platform ios` with a Mac worker.

For your agent, add the MCP server on the gateway machine (see [connect your agent](../agents.md)).
The tools are the same as in local mode.

App uploads go agent → gateway → worker; agent-device caps them at 2 GiB. Screenshots, recordings and
logs come back to the agent's machine, under `artifacts.directory/<session>/`. Full iOS crash reports
(`.ips`) stay on the worker. The viewer streams through the gateway; see
[browser access](browser-access.md).

## Tokens

| Token | Made with | Held by | Gives |
| --- | --- | --- | --- |
| Worker join token | `gateway setup` (the first one), or `gateway token --role worker --label <name>` | One worker, in `~/.simlock/config.json` (plain text, readable only by its user) | Opening that one worker's uplink, and only for the worker it is paired with. |
| Agent token | `gateway setup` (for the gateway machine), or `gateway token --role agent --label <name>` | The agent's machine, in `~/.tapdance/credentials.json` (mode 600), or `TAPDANCE_TOKEN` | Leasing devices and running commands on them, on any worker of the gateway. Close to shell access on the worker that holds the lease. |
| Operator token | `gateway setup`, or `gateway token --role operator` | You, in `~/.tapdance/credentials.json` (`operatorToken`), or `TAPDANCE_OPERATOR_TOKEN` | Everything, for every lease and every worker. |

The gateway stores only hashes of tokens, in `~/.simlock/gateway`. A token works only on the gateway
that minted it.

Tapdance loads the operator token only for fleet views (`tapdance workers list`, `doctor`). Device
commands and MCP tools never get it, so the MCP tool `list_workers` stays unavailable through a
gateway. Config files never hold tokens: use `tapdance config set-token` or the environment variables.

If a token leaks, revoke it on the gateway machine:

```bash
tapdance simlock --gateway token list
tapdance simlock --gateway token revoke <token-id>
```

## What the gateway can do to a worker

Read this before you join any machine:

- **The gateway gets operator rights on the worker.** Whoever controls the gateway, or holds an
  operator token for it, can lease and release any device on the worker, install and remove runtimes
  and images, and read the worker's configuration.
- **Every agent token is close to shell access on the worker**, as the worker's user. Simlock runs
  `adb` and `simctl` commands on the worker for whoever holds a lease, and `simctl spawn` can start any
  program. Tapdance's MCP tools expose no raw shell, but a token holder can call Simlock directly and
  skip Tapdance's guard rails.
- **Leasing is not a sandbox.** Your own AVDs and simulators are never handed out, but anything that
  runs as the worker's user can read that user's files. Two agents on one worker are not isolated
  from each other.
- **There is no per-operation approval prompt** on the worker.

So join only a gateway you control, on a worker machine that holds nothing personal: no SSH keys,
signing certificates or cloud credentials. On a personal Mac, use
[device-only mode](../security/device-only-mode.md). Running the worker under a separate user account
has not been tested. The [threat model](../security/threat-model.md) covers the risks in general.

## Your controls as the worker's owner

| You want to | Do |
| --- | --- |
| Stop serving now | `tapdance worker stop` (leases on it end when their time to live runs out) |
| Turn the live screen and remote input off | `tapdance worker login … --no-viewer`, or `tapdance worker install --no-stream` before joining |
| Let current leases finish, take no new ones (on the gateway) | `tapdance simlock --gateway worker drain <worker-id>` |
| Revoke an agent (on the gateway) | `tapdance simlock --gateway token revoke <token-id>` |
| See what happened | `tapdance worker logs`, and on the gateway `tapdance simlock --gateway events` |
| Leave the gateway | [Leave the gateway](#leave-the-gateway) |

Simlock's `capabilities.tunnel` module reverses device ports to a lease holder's machine. It is off by
default and Tapdance never turns it on. Leave it off.

## Reconnects, sleep and going offline

- **Network drops.** The worker redials after 1 second, doubling up to 30 seconds between tries. It
  needs no inbound port, so a change of Wi-Fi network is fine.
- **While a worker is away**, the gateway marks it `disconnected` and sends it no new leases. Its
  leases keep running. Tapdance reports commands on them as `WORKER_OFFLINE` (exit code 4, retryable)
  and keeps the lease. A lease that is not renewed before its time to live runs out expires.
- **Sleep takes a Mac worker offline.** Keep it awake while agents work with `caffeinate -is` (it
  does not stop a closed laptop lid, except in clamshell mode with power and an external display). On
  Linux, `systemd-inhibit --what=idle:sleep --why="tapdance worker" sleep infinity` does the same while
  it runs. For a Mac that stays on, see [host devices for a remote agent](one-command-host.md).
- **A reboot** ends leases whose device was not running afterwards (Simlock releases them with reason
  `device-lost`). Start the worker again, or install it with `--service`.

## Local agents on a joined worker

While a worker is joined, its own Simlock HTTP API is off. An agent on the worker machine itself must
then go through the gateway too, with an agent token of its own:

```bash
tapdance init --mode self-hosted --endpoint https://gateway.example.com
```

[Leave the gateway](#leave-the-gateway) to go back to local mode.

## Leave the gateway

On the worker:

```bash
tapdance worker logout
```

The worker goes back to serving local agents only. Then revoke its join token on the gateway machine:

```bash
tapdance simlock --gateway token list
tapdance simlock --gateway token revoke <token-id>
```

## If it fails

Read the worker's log with `tapdance worker logs`.

| The log or command says | Meaning | Fix |
| --- | --- | --- |
| `Uplink to gateway established` | Joined. | Nothing. |
| `Uplink … failed; retrying`, `HTTP 401` | The gateway does not know the token: a typo, revoked, or minted on another gateway. | Mint a new one with `tapdance gateway token --role worker --label …` and log in again. |
| `Uplink … failed; retrying`, `HTTP 403` | Not a worker token, or already paired with another worker. | Mint a new worker token for this machine. |
| `Uplink … failed` with another reason | The worker cannot reach the gateway. | Check the URL and DNS, and that the proxy passes WebSocket upgrades. |
| `FORBIDDEN` "Joining a gateway gives it … command execution" | `worker login` without `--accept-gateway-exec`. | Pass it only on a machine dedicated to being a worker. |
| `Refusing ws:// to public host …` | A plain `ws://` address on the internet. | Use `wss://` behind Caddy, or Tailscale. |
| `workers list` shows `incompatible` | Gateway and worker run Simlock versions that cannot talk. | Use the same Tapdance build on both. |
| `FORBIDDEN` "Listing workers needs an operator token" | No operator token on this machine. | `tapdance config set-token --operator`. |
| `This machine's worker has joined the gateway …` | A local agent on a joined worker. | See [local agents on a joined worker](#local-agents-on-a-joined-worker), or `tapdance worker logout`. |
| Lease commands fail with `WORKER_OFFLINE` | The worker is asleep, offline, or stopped. | Wake it and check `tapdance worker status`; the worker reconnects on its own. |
| `stream unavailable` in the viewer | Streaming is off on the worker or the gateway. | Log in again without `--no-viewer`; `gateway setup` turns it on at the gateway. |

More errors: [troubleshooting](../troubleshooting.md), section "Gateways, workers, the guard and the
viewer".
If you try gateway mode across machines, please file what happened with `tapdance report`.
