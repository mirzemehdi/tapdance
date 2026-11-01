# Self-hosted setups: the moving parts

This page explains the machines involved when your coding agent and your devices live on different
computers, how data flows between them, and what has been tested. Pick a concrete guide afterwards:

| Worker you have | Guide |
| --- | --- |
| Your own laptop or Mac | [Laptop as a worker](laptop-worker.md) |
| A Google Cloud VM | [Google Cloud N2](google-cloud-n2.md) |
| An OVHcloud Public Cloud instance | [OVHcloud Public Cloud](ovh-public-cloud.md) |
| A rented or owned Linux server | [Dedicated Linux server](dedicated-linux-server.md) |
| A cloud Mac (iOS) | [iOS overview](../ios/overview.md) |

Read [worker security](worker-security.md) before you join any machine to a gateway.

## The roles

| Role | What it is | Runs | Needs KVM? |
| --- | --- | --- | --- |
| **Developer VPS / control machine** | Where your coding agent (Claude Code, Codex, Cursor, …) runs and your app is built. | Tapdance CLI and MCP server, your build tools. Usually also the gateway. | **No** |
| **Gateway** | A [Simlock](https://github.com/callstackincubator/simlock) daemon in gateway mode. It owns no devices. It keeps the queue, the leases and the list of workers, and routes each request to the right worker. | `simlock --gateway` (Tapdance bundles it). Node.js 22.13+. | **No** |
| **Worker** | A machine that owns devices: your laptop, a Mac, a KVM Linux VM or server. It dials out to the gateway. | A Simlock worker daemon plus [agent-device](https://github.com/callstack/agent-device). Android SDK and/or Xcode. | Linux workers: **yes**. macOS uses Apple's Hypervisor framework. |
| **Emulator / simulator** | The device itself. Simlock creates it from an installed system image or runtime, leases it, wipes it on release. | Android Emulator (macOS or Linux) or iOS Simulator (macOS only). | — |
| **Developer's browser** | Where a person watches the device and takes over. | Any browser with WebCodecs, on any computer. | No |

Two consequences matter most:

- **Your coding VPS needs no KVM.** It never runs an emulator. Any ordinary VPS works for the agent
  and the gateway (requirement P-07).
- **iOS needs a Mac worker.** No Linux machine, VPS or KVM host can run the iOS Simulator.

The gateway can run on the developer VPS (the simplest choice, and what `tapdance gateway setup`
does), or on a separate small server. Both are fine; the rest of this page assumes it shares the VPS.

## How the pieces connect

```text
Developer VPS (no KVM)
  coding agent
    -> tapdance mcp / CLI
         -> http://127.0.0.1:4700  Simlock gateway
                                     ^
                                     | Caddy (TLS) or Tailscale in front
                                     |
            wss://<gateway>/v1/uplink  (opened OUTBOUND by the worker, kept open)
                                     |
Worker (laptop, N2 VM, Linux server, Mac)
  Simlock worker daemon
    -> agent-device daemon  (UI tree, taps, uploads, screenshots, video)
    -> adb + Android Emulator, or simctl + iOS Simulator

Developer's browser (any computer)
  -> ssh -L 4710:127.0.0.1:4710 vps   (or Tailscale)
       -> tapdance view on the VPS (loopback :4710)
            -> gateway -> worker: lease stream + input socket
```

- **The worker opens the connection.** It dials `wss://<gateway>/v1/uplink` with a per-worker join
  token and keeps the WebSocket open. The worker needs **no inbound port**, no router port forwarding
  and no public SSH. If the connection drops, Simlock redials after 1 second, doubling up to
  30 seconds between tries.
- **The agent talks to the gateway**, not to the worker. On the VPS that is
  `http://127.0.0.1:4700` (loopback). An agent on another machine would use the gateway's
  `https://` address and its own agent token.
- **Control traffic** (lease, renew, release, tap, inspect) goes agent → gateway → uplink → worker.
- **App uploads** go the same way. `tapdance app install ./app-debug.apk` on the VPS uploads the
  file through agent-device's proxy on the gateway to the worker (agent-device caps uploads at
  2 GiB). There is no separate direct transfer channel yet (F-03 in STATUS.md).
- **Artifacts come back to the VPS.** Screenshots, MP4 recordings and logs are downloaded to the
  machine running Tapdance, under `artifacts.directory/<session>/`. Full iOS crash reports (`.ips`)
  stay on the worker.
- **Live video** for the browser viewer is Simlock's lease stream (H.264), relayed by the gateway and
  proxied by `tapdance view` on the VPS. The browser never sees a Simlock token and never talks to
  ADB. See [browser access](browser-access.md).

## Tokens

| Token | Made with | Held by | Gives |
| --- | --- | --- | --- |
| Worker join token | `tapdance gateway setup` (first one) or `tapdance gateway token --role worker --label <name>` | One worker, in `~/.simlock/config.json` | Opening that one worker's uplink. Paired with the first worker that uses it. |
| Agent token | `tapdance gateway setup` (for the VPS) or `tapdance gateway token --role agent --label <name>` | The agent's machine, in `~/.tapdance/credentials.json` (mode 600) or `TAPDANCE_TOKEN` | Leasing devices and running commands on them, on **any** worker of the gateway. Close to shell access on the worker that holds the lease. |
| Operator token | `tapdance gateway setup` or `--role operator` | You, for `tapdance workers list` and fleet views | Everything, for every lease and worker. Tapdance never loads it for agent commands or MCP tools. |

Simlock stores only hashes of tokens on the gateway. A token works only on the daemon that minted it.
Give each concurrent agent its own agent token: Simlock treats one token as one requester, and by
default a requester holds one lease at a time.

## Setup at a glance

On the VPS:

```bash
tapdance gateway setup --worker-label my-laptop --public-url https://gateway.example.com
# then add Caddy or Tailscale in front of 127.0.0.1:4700 (see the worker guides)
```

On the worker:

```bash
tapdance worker check
tapdance worker install
echo '<join token>' | tapdance worker login --accept-gateway-exec --gateway wss://gateway.example.com --label my-laptop
```

Back on the VPS:

```bash
tapdance workers list
tapdance devices
tapdance device lease --platform android
```

`gateway setup` writes `~/.tapdance/config.json` with `provider: "self-hosted"` and
`endpoint: "http://127.0.0.1:4700"`, and saves the agent and operator tokens in
`~/.tapdance/credentials.json`. A project's own `tapdance.config.json` takes precedence over that
file; if your project was initialised with `--mode local`, re-run
`tapdance init --mode self-hosted --endpoint http://127.0.0.1:4700 --force` there.

## TLS or a private network is required

Simlock has no TLS of its own. Tapdance refuses to send a token over plain `http://` or `ws://` to a
public address. Use one of:

- **Caddy** (or another reverse proxy) on the gateway machine, terminating TLS and passing WebSocket
  upgrades and streamed responses through unbuffered.
- **Tailscale** (or WireGuard, or an SSH tunnel). Tapdance treats `*.ts.net` names and the
  `100.64.0.0/10`, `10/8`, `172.16/12`, `192.168/16` ranges as private.

## What has been tested

From [STATUS.md](../../STATUS.md), as of 2026-11-01:

| Path | Status |
| --- | --- |
| Gateway + joined worker on **one** Mac | **Verified**: CLI loop, MCP over stdio and the viewer in a real browser all worked through the gateway ([evidence](../testing/evidence/2026-11-01-gateway-single-host.md)). |
| Gateway + worker on two machines | **Not tested.** Same code path, but no real network between them yet; Q-06 is pending a real VPS and laptop. |
| `tapdance gateway setup` on a VPS | Run on macOS only; **not run on a Linux VPS**. |
| `tapdance worker login` across machines | Implemented, **not run across machines**. |
| Android end to end | Implemented, **not run** (no Android command-line tools on the test Mac). |
| Google Cloud N2 worker | Terraform and scripts written, **nothing provisioned**. |
| Browser viewer | Stream, input and take-over verified **on one Mac** (scripted, and in a real browser through a gateway on that Mac); not yet used from another computer. |
| Streamable HTTP MCP (`tapdance mcp --http`) | **Partly verified**: 401 without the token, tools listed, `list_devices` and `get_device_status` worked; a full device loop over HTTP not run. |
| Windows as a worker | Not supported (Simlock runs on macOS and Linux only). |

If you try any of these, please file what happened with `tapdance report`.
