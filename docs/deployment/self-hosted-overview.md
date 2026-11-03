# Self-hosted setups: the moving parts

This page explains the machines involved when your coding agent and your devices live on different
computers, how data flows between them, and what has been tested.

## Two ways to connect them

| | Device-only host (**recommended**) | Gateway (alternative) |
| --- | --- | --- |
| Setup | `tapdance host up` on the host, `tapdance connect` on the agent's machine | `tapdance gateway setup` on the agent's VPS, `tapdance worker login --accept-gateway-exec` on each worker |
| What the agent reaches | Only the [worker guard](../security/personal-mac.md) on the host, which allows a fixed device API | The gateway, which gets **command execution** on every joined worker |
| Network | Your tailnet (Tailscale); nothing public | The worker dials out to the gateway over `wss://` (TLS) or a private network |
| Fits | One host per agent machine: your Mac, a Linux machine with KVM, a cloud VM | Several workers behind one queue, on machines dedicated to being workers |
| Proven | `host up` on the owner's Mac; an agent on a Linux VPS tested a real app through it over Tailscale ([field runs](../testing/evidence/2026-11-02-vps-field-runs.md)). Not yet on a Linux host. | Gateway and worker on **one** Mac only ([evidence](../testing/evidence/2026-11-01-gateway-single-host.md)); never across two machines. |

Pick a guide:

| Host you have | Guide |
| --- | --- |
| Your own Mac, or a Linux machine with KVM | [One-command host](one-command-host.md) |
| A Google Cloud VM | [Google Cloud N2](google-cloud-n2.md) |
| An OVHcloud Public Cloud instance | [OVHcloud Public Cloud](ovh-public-cloud.md) |
| A rented or owned Linux server | [Dedicated Linux server](dedicated-linux-server.md) |
| A cloud Mac (iOS) | [iOS overview](../ios/overview.md) |
| Several workers behind one gateway | [Laptop as a worker](laptop-worker.md) (gateway mode) |

**A personal Mac should not join a gateway.** `tapdance worker login --accept-gateway-exec` gives the
gateway, and every agent token it issues, command execution on the Mac. Read
[worker security](worker-security.md) before you join any machine to a gateway.

## The roles

| Role | What it is | Runs | Needs KVM? |
| --- | --- | --- | --- |
| **Developer VPS / control machine** | Where your coding agent (Claude Code, Codex, Cursor, …) runs and your app is built. | Tapdance CLI and MCP server, your build tools. In the gateway model, usually also the gateway. | **No** |
| **Worker guard** | Device-only mode: the one endpoint a remote agent reaches on a host, in front of the host's own worker. It allows a fixed device API and refuses everything else. | `tapdance worker guard start`, as a login service set up by `tapdance host up`. | — |
| **Gateway** (alternative) | A [Simlock](https://github.com/callstackincubator/simlock) daemon in gateway mode. It owns no devices. It keeps the queue, the leases and the list of workers, and routes each request to the right worker. | `simlock --gateway` (Tapdance bundles it). Node.js 22.13+. | **No** |
| **Worker** (the host) | A machine that owns devices: your laptop, a Mac, a KVM Linux VM or server. In device-only mode the agent reaches it through the guard; in the gateway model it dials out to the gateway. | A Simlock worker daemon plus [agent-device](https://github.com/callstack/agent-device). Android SDK and/or Xcode. | Linux workers: **yes**. macOS uses Apple's Hypervisor framework. |
| **Emulator / simulator** | The device itself. Simlock creates it from an installed system image or runtime, leases it, wipes it on release. | Android Emulator (macOS or Linux) or iOS Simulator (macOS only). | — |
| **Developer's browser** | Where a person watches the device and takes over. | Any browser with WebCodecs, on any computer. | No |

Two consequences matter most:

- **Your coding VPS needs no KVM.** It never runs an emulator. Any ordinary VPS works for the agent
  (and the gateway, if you use one) (requirement P-07).
- **iOS needs a Mac worker.** No Linux machine, VPS or KVM host can run the iOS Simulator.

## Device-only host: how the pieces connect

```text
Agent's machine (VPS or laptop, no KVM)
  coding agent
    -> tapdance mcp / CLI   (provider "self-hosted", endpoint = the guard's tailnet address)
         -> https://<host>.<tailnet>.ts.net:4720   (tailscale serve on the host)
Host (Mac, Linux machine with KVM, N2 VM)
  worker guard :4720  (device-only policy, its own revocable tokens)
    -> Simlock worker on loopback
         -> agent-device daemon, adb + Android Emulator, or simctl + iOS Simulator
```

- **Nothing is public.** The guard listens on loopback; `tailscale serve` makes it reachable inside
  your tailnet only. The agent's token is a guard token from `host up`, not a Simlock token.
- **Uploads, screenshots, recordings and logs** travel the same way as through a gateway, and land
  under `artifacts.directory/<session>/` on the agent's machine.
- Setup and day-to-day commands: [one-command host](one-command-host.md).

## Gateway (alternative): how the pieces connect

The gateway can run on the developer VPS (the simplest choice, and what `tapdance gateway setup`
does), or on a separate small server. Both are fine; the rest of this section assumes it shares the
VPS.

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

## Gateway tokens

| Token | Made with | Held by | Gives |
| --- | --- | --- | --- |
| Worker join token | `tapdance gateway setup` (first one) or `tapdance gateway token --role worker --label <name>` | One worker, in `~/.simlock/config.json` | Opening that one worker's uplink. Paired with the first worker that uses it. |
| Agent token | `tapdance gateway setup` (for the VPS) or `tapdance gateway token --role agent --label <name>` | The agent's machine, in `~/.tapdance/credentials.json` (mode 600) or `TAPDANCE_TOKEN` | Leasing devices and running commands on them, on **any** worker of the gateway. Close to shell access on the worker that holds the lease. |
| Operator token | `tapdance gateway setup` or `--role operator` | You, for `tapdance workers list` and fleet views | Everything, for every lease and worker. Tapdance never loads it for agent commands or MCP tools. |

Simlock stores only hashes of tokens on the gateway. A token works only on the daemon that minted it.
Give each concurrent agent its own agent token: Simlock treats one token as one requester, and by
default a requester holds one lease at a time.

## Gateway setup at a glance

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

## When you are done with a rented machine

A cloud VM or rented server bills while it runs, and on most clouds its disk bills even while the VM
is stopped: stopping is not deleting. `tapdance host up` and `tapdance host status` print a `cloud VM:`
line on a detected cloud VM to remind you. When you no longer need the host:

1. Delete the VM **and its disks** in your provider's console or with its CLI (or `terraform destroy`
   if you made it with Terraform). Also delete snapshots, images and reserved IP addresses you made for
   it.
2. Check in the provider's console or billing page that nothing from it is left. On Google Cloud,
   `bash infrastructure/scripts/gcp-leftovers.sh <PROJECT_ID>` lists what can still bill and exits 0 only
   when nothing is left ([Google Cloud N2: tear down](google-cloud-n2.md#tear-down)).
3. Remove the machine from your tailnet in the
   [Tailscale admin console](https://login.tailscale.com/admin/machines), and revoke any token you gave
   it (for example a GitHub token for installs from CI).

Most providers' budget alerts only send e-mails; set one anyway. A Mac or a server you own costs
nothing extra here: stop hosting with `tapdance host pause` or `tapdance host down`.

## What has been tested

From [STATUS.md](../../STATUS.md):

| Path | Status |
| --- | --- |
| Device-only host (`host up` + `connect`), agent on a Linux VPS, host on a Mac, over Tailscale | **Run by the owner**: about a day of Android and iOS testing of a real app with the CLI ([field runs](../testing/evidence/2026-11-02-vps-field-runs.md)), and a tool self-test through the guard ([evidence](../testing/evidence/2026-11-03-selftest-through-guard.md)). An MCP client on the VPS was not used. |
| `host up` on a Linux host or a cloud VM | **Run** on a fresh Google Cloud N2 VM with `scripts/host-setup.sh`, driven from a Mac with `connect` ([evidence](../testing/evidence/2026-11-03-gcp-n2-android.md)). |
| Google Cloud N2 host | **Run once end to end**: Terraform, setup, CLI and MCP checklists, viewer, installs from CI, idle stop and restart ([evidence](../testing/evidence/2026-11-03-gcp-n2-android.md)). |
| Gateway + joined worker on **one** Mac | **Verified**: CLI loop, MCP over stdio and the viewer in a real browser all worked through the gateway ([evidence](../testing/evidence/2026-11-01-gateway-single-host.md)). |
| Gateway + worker on two machines | **Not tested.** Same code path, but no real network between them yet; Q-06 is pending. |
| `tapdance gateway setup` on a VPS | Run on macOS only; **not run on a Linux VPS**. |
| `tapdance worker login` across machines | Implemented, **not run across machines**. |
| Android end to end | **Verified on a Mac** ([evidence](../testing/evidence/2026-11-01-android.md)) and on a Linux host, a Google Cloud N2 VM ([evidence](../testing/evidence/2026-11-03-gcp-n2-android.md)). |
| Browser viewer | Stream, input and take-over verified **on one Mac** (scripted, and in a real browser through a gateway on that Mac); see STATUS.md V-02 for use over a tailnet. |
| Streamable HTTP MCP (`tapdance mcp --http`) | **Partly verified**: 401 without the token, tools listed, `list_devices` and `get_device_status` worked; a full device loop over HTTP not run. |
| Windows as a worker | Not supported (Simlock runs on macOS and Linux only). |

If you try any of these, please file what happened with `tapdance report`.
