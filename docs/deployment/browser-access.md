# Watching and driving the device in your browser

## What you get

`tapdance view` shows the session's leased emulator or simulator live in your browser while the agent
works. You can tap, swipe, scroll, type, press Home or Back, take screenshots and record, and you can
take control away from the agent and hand it back. This page calls it the **viewer**.

> **Status.** Proven on one Mac: live video, input, take-over and hand-back, with an iOS simulator and an
> Android emulator, also in a real browser ([iOS](../testing/evidence/2026-11-01-local-ios.md),
> [Android](../testing/evidence/2026-11-01-android.md),
> [browser](../testing/evidence/2026-11-01-gateway-single-host.md)). Proven across machines in
> device-only mode: a browser on a Mac streamed an emulator on a Google Cloud N2 VM live, and a person's
> take-over stopped the agent with `HUMAN_HELD` ([evidence](../testing/evidence/2026-11-03-gcp-n2-android.md));
> a simulator on a rented Mac mini followed a scripted run ([evidence](../testing/evidence/2026-11-06-rented-mac-ios.md)).
> `view --tailscale` from a Linux VPS agent was checked with curl only (frame, stream, take-over), not
> yet in a browser ([evidence](../testing/evidence/2026-11-03-vps-n2-android.md)). The screenshot
> fallback for plain `http` on a tailnet is unit-tested only.

## What you need

- A lease held by the session you want to watch. Without one, `view` fails with `NO_ACTIVE_LEASE`.
- Streaming and input turned on for the host's worker. `tapdance worker install` (and so `host up`)
  turns them on unless you pass `--no-stream`. In gateway mode, see [below](#how-it-works).
- A current browser with WebCodecs H.264 decoding (Chrome, Edge, Safari and Firefox have it). Live video
  needs `http://127.0.0.1`, `localhost` or `https://`; elsewhere the page shows refreshed screenshots.
- For an iOS simulator: macOS 14 or later on the host (a Simlock requirement).

## Steps

1. Run `tapdance view` **on the agent's machine**, as the same OS user, with the same `~/.tapdance`
   (`TAPDANCE_HOME`), and in the same session as the agent. The simplest way is to ask the agent: "run
   `tapdance view` in the background and give me the link". Its shell already carries the session (for
   Claude Code, `CLAUDE_CODE_SESSION_ID`).

2. Or, from your own terminal on the same machine, name the agent's session:

   ```bash
   tapdance --session '<session id>' view
   ```

   To find the session id, run `tapdance doctor` in the agent's environment: it prints it under
   "Session identity". `tapdance --json device status` and the MCP tool `get_device_status` include a
   `sessionId` field too. Or set the same `TAPDANCE_SESSION_ID` for the agent (its shell and MCP config)
   and for your terminal.

3. Open the link it prints, such as:

   ```text
   Viewer: http://127.0.0.1:4710/#k=<one-time key>
   ```

   From another computer, see [From another computer](#from-another-computer).

4. Ctrl-C stops the viewer and clears any hold. So does the lease ending.

| Option | Default | Config key / env |
| --- | --- | --- |
| `--host <host>` | `127.0.0.1` | `viewer.host` |
| `--port <port>` | `4710` | `viewer.port`, `TAPDANCE_VIEWER_PORT` |
| `--allow-host <name>` | none | Another name the page may be opened by (repeatable). This machine's Tailscale names are allowed already. |
| `--tailscale` | off | Serve the page over `https://` on this machine's tailnet name, for live video from another device. |
| How long one touch holds off the agent | 15 s | `viewer.humanHoldMs` |

## Check it worked

The page shows the device's screen moving, and a status panel with the device, the lease and whether a
recording runs. Under the screen, a `Stream:` line shows what the host sends, for example
`Stream: 332×720 h264, 12.0 fps, 48 kbit/s from the host`. A static screen sends almost nothing, which is
normal. Tap something: the device should react.

## From another computer

The viewer runs on the agent's machine, not on the host. Reach it in one of three ways.

### SSH port forwarding (recommended)

On your own computer:

```bash
ssh -L 4710:127.0.0.1:4710 you@agent-machine
```

Then open the printed link (`http://127.0.0.1:4710/#k=…`) in your local browser. You get live video,
SSH encrypts the traffic, and nothing is exposed on the agent's machine. If port 4710 is busy locally,
forward another port (`-L 5710:127.0.0.1:4710`) and change the port in the link.

### Tailscale over HTTPS: `--tailscale`

If the agent's machine and your device are in the same tailnet:

```bash
tapdance view --tailscale
```

The viewer stays on loopback, and `tailscale serve` publishes it at
`https://<agent machine>.<tailnet>.ts.net:4710` for devices in your tailnet. You get live video. It
needs MagicDNS and HTTPS Certificates turned on for the tailnet, and a user allowed to change serve
settings: the Tailscale operator (`sudo tailscale set --operator=$USER`, once) or passwordless
`sudo tailscale`, which the viewer tries next. Ctrl-C removes the serve entry. `--tailscale` cannot be
combined with `--host`.

### Tailscale address over plain HTTP

```bash
tapdance view --host 100.101.102.103
```

Bind the agent machine's tailnet address. The link names the machine's MagicDNS name, and both the
name and the address are accepted. Tailscale encrypts the traffic, but browsers do not allow the video
decoder on plain `http` off localhost, so the page shows refreshed screenshots instead of live video.
Use `--tailscale` or SSH for live video.

To open the page by another name (your own DNS name, a proxy), add `--allow-host <name>`.

`--host 0.0.0.0` is accepted with a warning: anyone who can reach the port and has the link controls
the device. Prefer the ways above. Public addresses are refused.

## Take over and hand back

- **Any touch** in the page (tap, swipe, scroll, key) sets a *human hold* for `viewer.humanHoldMs`
  (15 s by default), renewed as you keep touching.
- **Take over** sets a hold for 10 minutes.
- **Hand back** clears the hold at once.
- While a hold lasts, the agent's device actions fail with `HUMAN_HELD` (CLI exit code 11), marked
  retryable, with `retryAfterMs` telling it when to try again. `get_device_status` shows
  `humanHoldUntil`, so the agent can see that a person is driving.
- **Hand back** also answers an agent waiting in `request_human` (`tapdance device request-human`);
  unit-tested only.

The hold is **advisory and enforced by Tapdance**, not by Simlock: it lives in the session record under
`~/.tapdance`. It stops Tapdance's CLI and MCP tools in that session. It does not stop a program that
calls Simlock or agent-device directly with a token, and it does not apply to other sessions.

The hand-off follows the model of [Loupe](https://github.com/bmcreations/loupe) (Apache-2.0) by
bmcreations: a human touch takes control, agent input is refused with a retry time, and "hand back"
returns control. Tapdance uses Loupe as a design reference only; no code is copied.

## What else the page does

Screenshots and recordings started from the page are saved as artifacts of the session, next to the
agent's (`tapdance artifacts` lists them), and the page can open the session's recent artifacts.

## On an iOS simulator

| Control | iOS simulator |
| --- | --- |
| Live picture | Yes |
| Tap, swipe, drag | Yes |
| Scroll (mouse wheel) | Yes, sent as a finger drag |
| Home button | Yes |
| Back and Apps buttons | Disabled: Simlock drops `back`, `app_switcher` and `lock` on iOS. Use in-app navigation, or let the agent use `press_key back`. |
| Keyboard typing | Works on iOS 26 and older runtimes. On iOS 27 and newer runtimes the simulator ignores injected keys, and Simlock drops them. Let the agent type with `type_text`. |
| Screenshot | Yes, saved as a session artifact |
| Start / stop recording | Yes, MP4 saved as a session artifact |
| Artifacts and status panel | Yes |

On an iOS simulator, touches reach the device through a helper process that Simlock starts for the
lease. These limits come from Simlock's "Watching the screen" documentation.

**Physical iPhones.** Simlock can stream one only when the host runs Xcode 27 or later and the iPhone
runs iOS 27 or later. Simlock accepts no input for a physical iPhone, so the viewer can only watch it.
Physical-device leases have not been run with Tapdance.

## Picture quality and load

The host's worker (Simlock) encodes the screen. Its defaults:

| Setting (on the host) | Default | Range |
| --- | --- | --- |
| `capabilities.stream.maxDimension` | 720 px on the longer side | 96-4096 |
| `capabilities.stream.bitrateKbps` | 1500 | 100-40000 |
| `capabilities.stream.fps` | 30 | 1-60 |

Per Simlock's docs, a busy screen costs about 1.4 Mbit/s and an idle one 25 to 90 kbit/s. Each iOS
capture uses about 50 to 80 MB of memory on the host, and each open viewer tab is a separate capture.

Read the `Stream:` line under the screen. A small size means the host's encoder setting; a low rate
while the screen moves means the host or the network. For a sharper picture of a tall iPhone screen, on
the host:

```bash
tapdance simlock -- --local config set capabilities.stream.maxDimension 1280
tapdance simlock -- --local config set capabilities.stream.bitrateKbps 3000
tapdance worker restart
```

A bigger picture costs the host CPU and memory: on an 8 GB Mac that is already swapping, keep the
defaults.

## How it works

```text
your browser ──► tapdance view (127.0.0.1:4710 on the agent's machine)
                    │  holds the token server-side
                    ├─► GET  /v1/leases/<id>/stream   (H.264 video)
                    └─► WS   /v1/leases/<id>/input    (touches, keys, buttons)
                          to the guard on the host (device-only mode),
                          a gateway, or the local worker
```

- `tapdance view` runs **on the agent's machine** (your Mac in local mode, the agent's machine in
  device-only mode), not on the host.
- It proxies Simlock's per-lease screen stream and input socket. The browser never receives a token and
  never talks to ADB or `simctl`.
- Video comes from Simlock's stream (`capabilities.stream`); input goes to Simlock's input socket
  (`capabilities.input`). Both must be on for the host's worker, and in gateway mode on the gateway too:
  - `tapdance worker install` turns them on for a worker (unless `--no-stream`).
  - `tapdance worker login` turns them on for a worker joining a gateway (unless `--no-viewer`).
  - `tapdance gateway setup` turns them on for the gateway.
  - If they are off, the page shows "Live streaming is off on this worker" or "Input is unavailable on
    this worker".
- Simlock's own web console can also show a device's screen, but it is view-only and needs an operator
  token, which agents should never hold. That is why Tapdance builds on the per-lease endpoints instead.

## How the link is protected

- The server listens on loopback by default and **refuses public addresses**. Private addresses
  (`10/8`, `172.16/12`, `192.168/16`, Tailscale's `100.64/10`, `*.ts.net`) are accepted.
- The key is in the URL **fragment** (`#k=…`), which browsers do not send to servers or put in
  `Referer`. The page posts it once to `/api/login` and gets an `HttpOnly`, `SameSite=Strict` cookie.
- Every request checks the `Host` header against DNS rebinding: loopback names, the address you bound,
  this machine's tailnet names and addresses, and `--allow-host` names are accepted (on any port). State
  changes also check the `Origin`.
- The key is random per run. It stops working when `tapdance view` exits or the lease ends.
- The token stays inside `tapdance view`; the browser gets only a session cookie.
- Anyone who has the link and can reach the port controls the device while it runs. Treat the link
  like a password: do not paste it into chats or tickets, and do not put the viewer behind a public
  proxy.
- Whoever drives the device can do anything the app under test allows, including signing in with test
  accounts stored in it.

## If it fails

| You see | Fix |
| --- | --- |
| `Refusing to serve the viewer on public address …` | Keep the default `127.0.0.1` and use `ssh -L`, `--tailscale`, or bind a private address. |
| `NO_ACTIVE_LEASE` | The viewer runs in a different session. Use `--session`, or have the agent run it. |
| `Open the link tapdance view printed.` (401) | Open the full link including `#k=…`; a link from an earlier run no longer works. |
| `unexpected Host header` (403) | You opened it by a name the viewer does not know. Use the printed link, or add the name with `--allow-host`. |
| Screenshots refresh instead of live video | The page is on plain `http` off localhost. Use `ssh -L` or `view --tailscale`. |
| `This tailnet has no HTTPS certificates …` | Turn on HTTPS Certificates in the Tailscale admin console, or use `ssh -L`. |
| `tailscale serve failed` | Allow your user once: `sudo tailscale set --operator=$USER`. |
| "Live streaming is off on this worker", or a black screen | Turn on `capabilities.stream` (see [How it works](#how-it-works)), then restart the worker. `tapdance worker start` also restores the capture helper's execute bit. |
| Video plays but taps do nothing | `capabilities.input` is off on the worker or gateway. Check `tapdance worker status` on the host. |
| Typing does nothing on iOS | iOS 27 and newer runtimes ignore injected keys. Let the agent type with `type_text`. |
| The agent reports `HUMAN_HELD` | You touched the screen. Press **Hand back**, or wait `viewer.humanHoldMs`. |
| Video is blurry or blocky | Read the `Stream:` line. 720 px on the longer side is the host's default; raise `capabilities.stream.maxDimension` and `bitrateKbps` (see [Picture quality](#picture-quality-and-load)). |
| The page goes blank after a while | The lease ended or the host is unreachable. Check `tapdance device status`. |

More: [troubleshooting](../troubleshooting.md).
