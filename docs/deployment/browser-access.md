# Watching and driving the device in your browser

`tapdance view` shows the session's leased emulator or simulator live in your browser while the agent
works. You can tap, swipe, scroll, type, press Home or Back, take screenshots and record, and you can
take control away from the agent and hand it back.

## Status

From [STATUS.md](../../STATUS.md) (V-01 to V-05, Q-07), as of 2026-11-07:

| What | Verified? |
| --- | --- |
| Live H.264 video proxied from Simlock's lease stream and decoded with WebCodecs | Yes, on one Mac with an iOS simulator ([evidence](../testing/evidence/2026-11-01-local-ios.md)) |
| Input socket (touches reach the device) | Yes, on one Mac, scripted |
| Human touch blocks the agent with `HUMAN_HELD` | Yes, on one Mac, scripted |
| Login with the one-time key, cookie, refusal without it | Yes, on one Mac, scripted |
| The page in a real browser (live picture, a click tapped the device, status panel updated) | Yes, on one Mac, through a gateway running on that Mac ([evidence](../testing/evidence/2026-11-01-gateway-single-host.md)) |
| Viewing from another computer (SSH tunnel or Tailscale) | Reported by the field test: the tailnet IP worked but a plain-`http` page could not decode video and the MagicDNS name was refused; both fixed (screenshot mode, tailnet names allowed; unit-tested). Live video from another computer needs `ssh -L` or HTTPS. |
| Android emulator stream | Yes, on one Mac: live stream, Home, tap, Screenshot and recording buttons ([evidence](../testing/evidence/2026-11-01-android.md)) |
| A device on another machine (device-only mode, over Tailscale) | Yes: a browser on a Mac streamed an emulator on a Google Cloud N2 VM live, and the owner's take-over gave `HUMAN_HELD` ([evidence](../testing/evidence/2026-11-03-gcp-n2-android.md)); a simulator on a rented Mac mini followed a scripted run ([evidence](../testing/evidence/2026-11-06-rented-mac-ios.md)) |
| `view --tailscale` from a VPS agent | Checked with curl only: frame, stream, take-over gave `HUMAN_HELD` ([evidence](../testing/evidence/2026-11-03-vps-n2-android.md)); not yet in a browser |

## How it works

```text
your browser ──► tapdance view (127.0.0.1:4710 on the agent's machine)
                    │  holds the Simlock token server-side
                    ├─► GET  /v1/leases/<id>/stream   (H.264 video)
                    └─► WS   /v1/leases/<id>/input    (touches, keys, buttons)
                          via the gateway to the worker, or the local worker
```

- `tapdance view` runs **on the machine where Tapdance and the agent run** (your Mac in local mode,
  the VPS in self-hosted mode), not on the worker.
- It proxies Simlock's per-lease screen stream and input socket. The browser never receives a Simlock
  token and never talks to ADB or `simctl`.
- Video comes from Simlock's stream (`capabilities.stream`); input goes to Simlock's input socket
  (`capabilities.input`). Both must be **on, on the worker and on the gateway**:
  - `tapdance worker install` turns them on for a worker (unless `--no-stream`).
  - `tapdance worker login` turns them on for a joined worker (unless `--no-viewer`).
  - `tapdance gateway setup` turns them on for the gateway.
  - If they are off, the page shows "Live streaming is off on this worker" or "Input is unavailable on
    this worker".
- Simlock's own console can also show a device's screen, but it is view-only and needs an operator
  token, which is why Tapdance builds on the per-lease endpoints instead.

The human/agent hand-off follows the model of [Loupe](https://github.com/bmcreations/loupe)
(Apache-2.0) by bmcreations: a human touch takes control, agent input is refused with a retry time,
and "hand back" returns control. Tapdance uses Loupe as a design reference only; no code is copied.

## Start it

`tapdance view` shows **the current session's** lease. It must run as the same OS user, with the same
`~/.tapdance` (`TAPDANCE_HOME`), and in the same session as the agent.

The simplest way is to ask the agent to run it, because its shell already carries the session (for
Claude Code, `CLAUDE_CODE_SESSION_ID`): "run `tapdance view` in the background and give me the link".

From your own terminal on the same machine, name the agent's session explicitly:

```bash
tapdance --session '<session id>' view
```

To find the session id: `tapdance doctor` run by the agent prints it under "Session identity", and the
device summary from `tapdance --json device status` or the MCP tool `get_device_status` includes a
`sessionId` field. If the session holds no lease, `view` fails with `NO_ACTIVE_LEASE`.

The command prints a link such as:

```text
Viewer: http://127.0.0.1:4710/#k=<one-time key>
```

| Option | Default | Config key / env |
| --- | --- | --- |
| `--host <host>` | `127.0.0.1` | `viewer.host` |
| `--port <port>` | `4710` | `viewer.port`, `TAPDANCE_VIEWER_PORT` |
| How long one touch holds off the agent | 15 s | `viewer.humanHoldMs` |

Ctrl-C stops the viewer and clears any hold.

## How the link is protected

- The server listens on loopback by default and **refuses public addresses**. Private addresses
  (`10/8`, `172.16/12`, `192.168/16`, Tailscale's `100.64/10`, `*.ts.net`) are accepted.
- The key is in the URL **fragment** (`#k=…`), which browsers do not send to servers or put in
  `Referer`. The page posts it once to `/api/login` and gets an `HttpOnly`, `SameSite=Strict` cookie.
- Every request checks the `Host` header (against DNS rebinding) and, for state changes, the `Origin`.
- The key is random per run. It stops working when `tapdance view` exits or the lease ends.
- Anyone who has the link and can reach the port controls the device while it runs. Do not paste it
  into chats or tickets.

## From another computer

The viewer stays on loopback on the agent's machine. Reach it in one of two ways.

### SSH port forwarding (recommended)

On your own computer:

```bash
ssh -L 4710:127.0.0.1:4710 you@your-vps
```

Then open the printed link (`http://127.0.0.1:4710/#k=…`) in your local browser. Traffic is
encrypted by SSH, and nothing is exposed on the VPS. If port 4710 is busy locally, forward another
local port (`-L 5710:127.0.0.1:4710`) and change the port in the link.

### Tailscale

If the VPS and your computer are in the same tailnet, bind the viewer to the VPS's Tailscale address:

```bash
tapdance view --host 100.101.102.103
```

Open the link exactly as printed (with that IP). The `Host` check accepts loopback names and the
address you bound, so opening it through a MagicDNS name instead of the IP is refused. Plain `http` is
acceptable here because Tailscale encrypts the traffic.

`--host 0.0.0.0` is accepted with a warning, but the `Host` check still accepts only loopback names
and `0.0.0.0`, so other computers are refused. Use one of the two methods above.

## Take over and hand back

- **Any touch** in the page (tap, swipe, scroll, key) sets a *human hold* for `viewer.humanHoldMs`
  (15 s by default), renewed as you keep touching.
- **Take over** sets a hold for 10 minutes.
- **Hand back** clears the hold at once.
- While a hold lasts, the agent's device actions fail with `HUMAN_HELD` (CLI exit code 11), marked
  retryable, with `retryAfterMs` telling it when to try again. `get_device_status` shows
  `humanHoldUntil`, so the agent can see that a person is driving.

The hold is **advisory and enforced by Tapdance**, not by Simlock: it lives in the session record under
`~/.tapdance`. It stops Tapdance's CLI and MCP tools in that session. It does not stop a program that
calls Simlock or agent-device directly with the token, and it does not apply to other sessions.

## What else the page does

Screenshots and recordings started from the page are saved as artifacts of the session, next to the
agent's (`tapdance artifacts` lists them), and the page can open the session's recent artifacts. A
status panel shows the device, the lease and whether a recording is running. The page needs a browser
with WebCodecs H.264 decoding (current Chrome, Edge, Safari and Firefox have it).

Under the screen a line shows what the host sends: the picture size, frames per second and kbit/s
(`Stream: 332×720 h264, 12.0 fps, 48 kbit/s from the host`). A small size means the host's encoder
setting; a low rate while the screen moves means the host or the network. The encoder runs on the host
(Simlock), with these defaults: the longer side at most **720 px**, **1500 kbit/s**, **30 fps**. A
static screen sends almost nothing, which is normal. For a sharper picture of a tall iPhone screen, on
the host:

```bash
tapdance simlock -- config set capabilities.stream.maxDimension 1280
tapdance simlock -- config set capabilities.stream.bitrateKbps 3000
tapdance worker restart
```

(`fps` takes 1-60, `bitrateKbps` 100-40000, `maxDimension` 96-4096.) A bigger picture costs the host CPU
and memory: on an 8 GB Mac that is already swapping, keep the defaults.

## Troubleshooting

| You see | Fix |
| --- | --- |
| `Refusing to serve the viewer on public address …` | Keep the default `127.0.0.1` and use `ssh -L`, or bind a private address. |
| `NO_ACTIVE_LEASE` | The viewer runs in a different session. Use `--session`, or have the agent run it. |
| `Open the link tapdance view printed.` (401) | Open the full link including `#k=…`; a link from an earlier run no longer works. |
| `unexpected Host header` (403) | You opened it by a different host name than the one bound. Use the printed link. |
| "Live streaming is off on this worker" | Turn on `capabilities.stream` on the worker and gateway (see above), then restart them. |
| Video is blurry or blocky (#130) | Read the `Stream:` line under the screen. A size of 720 px on the longer side is the host's default; raise `capabilities.stream.maxDimension` and `bitrateKbps` (see "What else the page does"). |
| Video plays but taps do nothing | `capabilities.input` is off on the worker or gateway. |
| The page goes blank after a while | The lease ended or the worker disconnected. Check `tapdance device status`. |
