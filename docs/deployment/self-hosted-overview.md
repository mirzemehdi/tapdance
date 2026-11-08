# Choose a remote setup

Use this page when your agent and your devices are on different computers. The agent runs on the
[agent's machine](../glossary.md#machines) (a laptop, or a Linux VPS). The devices run on one or more
**hosts**. Pick the row that matches the host you have.

## Pick a guide

| You have | Guide | Status |
| --- | --- | --- |
| Your own Mac or Mac mini | [Host devices for a remote agent](one-command-host.md) | ✅ Proven ([evidence](../testing/evidence/2026-11-02-vps-field-runs.md)) |
| A Linux machine with KVM (your own, a rented server, OVHcloud) | [Dedicated Linux server](dedicated-linux-server.md) | Not run |
| A Google Cloud VM | [Google Cloud N2](google-cloud-n2.md) | ✅ Proven ([evidence](../testing/evidence/2026-11-03-gcp-n2-android.md)) |
| A rented Scaleway Mac mini | [Scaleway Mac mini](../ios/scaleway-mac.md) | ✅ Proven ([evidence](../testing/evidence/2026-11-06-rented-mac-ios.md)) |
| Another cloud Mac (MacStadium, AWS EC2 Mac) | [Other cloud Macs](../ios/other-cloud-macs.md) | Not run |
| Android and iOS for one agent (two hosts) | [Android and iOS from one agent](../guides/android-and-ios.md) | ✅ Proven ([evidence](../testing/evidence/2026-11-07-two-hosts-android-ios.md)) |
| Several workers pooled behind one address | [Gateway mode](gateway-mode.md) | Advanced: run on one Mac only |

Every row except the last uses **device-only mode**: `tapdance host up` on the host and
`tapdance connect` on the agent's machine. The provider pages add only what is special about their
machine; the shared steps are in [host devices for a remote agent](one-command-host.md).

Two facts decide most choices:

- **The agent's machine needs no KVM.** It never runs an emulator. Any ordinary VPS works.
- **iOS needs a Mac host.** No Linux machine, VPS or KVM host can run the iOS Simulator.

## How device-only mode connects

```text
Agent's machine (laptop or VPS, no KVM)
  agent
    -> tapdance mcp / CLI   (provider "self-hosted", one connect target per host)
         -> https://<host>.<tailnet>.ts.net:4720   (tailscale serve on the host)
Host (Mac, Linux machine with KVM, cloud VM)
  guard :4720  (device-only policy, its own revocable pairing tokens)
    -> Simlock worker on loopback
         -> agent-device daemon, adb + Android Emulator, or simctl + iOS Simulator
```

- **Nothing is public.** The guard listens on loopback. `tailscale serve` makes it reachable inside
  your tailnet only. The agent's token is a pairing token from `host up`, not a Simlock token.
- **Several hosts work.** Run `tapdance connect` once per host. A lease goes to the first connect
  target, in the order they were added, that serves the platform and answers. A host that is down is
  skipped fast with `PROVIDER_UNREACHABLE`, and `device lease --target <name>` picks one.
- **Uploads, screenshots, recordings and logs** travel through the guard. Artifacts land under
  `tapdance-artifacts/<session>/` on the agent's machine.
- **The browser viewer** runs on the agent's machine: `tapdance view --tailscale`. See
  [browser access](browser-access.md).

## Gateway mode in brief

A Simlock gateway pools several workers behind one address; each worker dials out to it. Joining a
gateway gives the gateway, and every agent token it issues, command execution on that worker, so it is
for dedicated machines only, never a personal Mac. It is advanced and has run on one Mac only
([evidence](../testing/evidence/2026-11-01-gateway-single-host.md)): see [gateway mode](gateway-mode.md).

## TLS or a private network is required

Simlock has no TLS of its own. Tapdance refuses to send a token over plain `http://` or `ws://` to a
public address. Use one of:

- **Tailscale** (or WireGuard, or an ssh tunnel). Tapdance treats `*.ts.net` names and the
  `100.64.0.0/10`, `10/8`, `172.16/12` and `192.168/16` ranges as private. Device-only mode uses
  Tailscale.
- **Caddy** (or another reverse proxy) terminating TLS, passing WebSocket upgrades and streamed
  responses through unbuffered. This is for a gateway.

## When you are done with a rented machine

A cloud VM or rented server bills while it runs, and on most clouds its disk bills even while the VM
is stopped: stopping is not deleting. `tapdance host up` and `tapdance host status` print a `cloud VM:`
line on a detected cloud VM to remind you. When you no longer need the host:

1. Delete the VM **and its disks** in your provider's console or with its CLI (or `terraform destroy`
   if you made it with Terraform). Also delete snapshots, images and reserved IP addresses you made for
   it.
2. Check in the provider's console or billing page that nothing from it is left. On Google Cloud,
   `bash infrastructure/scripts/gcp-leftovers.sh <PROJECT_ID>` lists what can still bill and exits 0 only
   when nothing is left; run it before deleting the project
   ([Google Cloud N2: tear down](google-cloud-n2.md#tear-down)).
3. Remove the machine from your tailnet in the
   [Tailscale admin console](https://login.tailscale.com/admin/machines), and revoke any token you gave
   it (for example a GitHub token for installs from CI). Cloud CLI logins made for the machine can go
   too: a `gcloud auth login` covers your whole Google account and does not expire on its own.
   `bash infrastructure/scripts/revoke-run-credentials.sh` asks before revoking each.
4. On the agent's machine, remove the connect target: `tapdance disconnect <name>`.

Most providers' budget alerts only send e-mails; set one anyway. A Mac or a server you own costs
nothing extra here: stop hosting with `tapdance host pause` or `tapdance host down`.

## What has been tested

From [STATUS.md](../../STATUS.md):

| Path | Status |
| --- | --- |
| Agent on a Linux VPS, host on the owner's Mac | Proven: about a day of Android and iOS testing of a real app with the CLI ([field runs](../testing/evidence/2026-11-02-vps-field-runs.md)), and a tool self-test through the guard ([evidence](../testing/evidence/2026-11-03-selftest-through-guard.md)). |
| `host up` on a Linux cloud VM | Proven on a fresh Google Cloud N2 VM with `host-setup.sh`, driven from a Mac ([evidence](../testing/evidence/2026-11-03-gcp-n2-android.md)) and from a Linux VPS ([evidence](../testing/evidence/2026-11-03-vps-n2-android.md)). Terraform, the CLI and MCP checklists, the viewer, installs from CI, idle stop and restart ran too. |
| `host up` on a rented Mac | Proven on a fresh Scaleway Mac mini M1-M with `host-setup.sh --ios-only`, driven from a Mac ([evidence](../testing/evidence/2026-11-06-rented-mac-ios.md)) and from a Linux VPS ([evidence](../testing/evidence/2026-11-07-vps-rented-mac-ios.md)). |
| One agent, two hosts (N2 for Android, rented Mac for iOS) | Proven through the CLI and MCP, with one host down ([evidence](../testing/evidence/2026-11-07-two-hosts-android-ios.md)). |
| Bare-metal Linux, OVHcloud, MacStadium, AWS EC2 Mac | Not run. |
| Gateway and joined worker on one Mac | Proven: CLI loop, MCP over stdio and the viewer ([evidence](../testing/evidence/2026-11-01-gateway-single-host.md)). |
| Gateway and worker on two machines; `gateway setup` on a Linux VPS; `worker login` across machines | Not run. |
| Browser viewer | Stream, input and take-over on one Mac; a browser on the agent's Mac streamed devices on an N2 VM and a rented Mac over Tailscale. From a VPS agent, checked with curl only. |
| Streamable HTTP MCP (`tapdance mcp --http`) | Partly: 401 without the token, tools listed, `list_devices` and `get_device_status` worked; a full device loop over HTTP not run. |
| Windows as a host | Not supported: Simlock runs workers on macOS and Linux only. Windows works as an agent's machine. |

If you try any of these, please file what happened with `tapdance report`.
