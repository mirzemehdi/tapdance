# Watching and driving an iOS simulator from your browser

`tapdance view` opens a live view of the session's leased device in your browser. You can watch the
agent work, tap and type yourself, take over, and hand control back. This page covers iOS simulators;
the same viewer serves Android emulators.

Status ([STATUS.md](../../STATUS.md), V-01 to V-05): on one Mac, the stream, the input socket and the
human take-over were verified with a script acting as a browser
([evidence](../testing/evidence/2026-11-01-local-ios.md)), and the page was then opened in a real
browser through a gateway running on the same Mac: the picture was live and a click tapped the device
([evidence](../testing/evidence/2026-11-01-gateway-single-host.md)). Viewing from another computer,
and any setup across two machines, have **not** been tested yet.

## How it works

```text
 Your laptop browser ──(SSH tunnel or Tailscale)──► tapdance view (127.0.0.1:4710, on the agent's machine)
                                                        │  holds the Simlock token server-side
                                                        ▼
                                                 Simlock gateway ──► Mac worker ──► simulator
                                                 GET  /v1/leases/{id}/stream   (H.264 video)
                                                 WS   /v1/leases/{id}/input    (touches, keys, buttons)
```

- `tapdance view` runs on the machine where the agent and Tapdance run (the VPS, or the Mac in local
  mode). It proxies [Simlock](https://github.com/callstackincubator/simlock)'s lease stream and input
  socket and adds the token itself, so the browser never sees it.
- The page decodes the H.264 stream with the browser's WebCodecs API. Use a current browser with
  WebCodecs support.
- On an iOS simulator, touches reach the device through a helper process that Simlock starts for the
  lease. It shows no picture of its own.

## Before you start

Streaming and input are off by default in Simlock. Tapdance turns them on:

| Machine | Command | Turns on streaming and input unless |
| --- | --- | --- |
| Mac worker | `tapdance worker install` | you pass `--no-stream` |
| Mac worker joining a gateway | `tapdance worker login ...` | you pass `--no-viewer` |
| Gateway | `tapdance gateway setup` | (always on) |

Through a gateway, both the gateway and the lease's worker need streaming and input on. If the worker
has them off, the viewer gets `STREAM_UNAVAILABLE` or `INPUT_UNAVAILABLE` from Simlock.

The simulator stream needs macOS 14 or later on the worker (a Simlock requirement).

## Open the viewer

Lease a device first (the agent usually has), then on the agent's machine:

```sh
tapdance view
```

The viewer shows the lease of **the session it runs as**. Inside the agent's own environment (for
example a shell the agent started) that is the agent's session. In your own terminal it is your
per-user CLI session, which holds no lease. To watch the agent's device from your terminal, pass the
agent's session id, on the same machine and user account as the agent (session records live in
`~/.tapdance`):

```sh
tapdance view --session <agent-session-id>
```

The id is the `sessionId` field in `get_device_status` (MCP) or `tapdance --json device status` run in
the agent's environment. Alternatively, set the same `TAPDANCE_SESSION_ID` for the agent (shell and MCP
config) and for your terminal.

It prints a link such as `http://127.0.0.1:4710/#<one-time key>`. The key in the URL fragment logs the
page in once and is swapped for an HttpOnly cookie. It stops working when `tapdance view` exits or the
lease ends. Stop it with Ctrl-C.

### From another computer

The viewer listens on loopback only by default. Reach it one of two ways:

**SSH tunnel (simplest):**

```sh
ssh -L 4710:127.0.0.1:4710 <user>@<vps>
```

Then open the printed link on your laptop.

**Private network:** start it on a private address, such as the VPS's Tailscale address:

```sh
tapdance view --host 100.101.102.103 --port 4710
```

`tapdance view` refuses public addresses. `--host 0.0.0.0` is accepted with a warning, because anyone
who can reach the port and has the link can then control the device; avoid it. Change the default port
with `--port`, the `viewer.port` config key, or `TAPDANCE_VIEWER_PORT`.

## What you can do on an iOS simulator

| Control | iOS simulator |
| --- | --- |
| Live picture | Yes |
| Tap, swipe, drag | Yes |
| Scroll (mouse wheel) | Yes, sent as a finger drag |
| Home button | Yes |
| Back and Apps buttons | No effect: Simlock drops `back`, `app_switcher` and `lock` on iOS. Use in-app navigation, or let the agent use `press_key back`. |
| Keyboard typing | Works on iOS 26 and older runtimes. On iOS 27 and newer runtimes the simulator ignores injected keys; Simlock drops them. Let the agent type with `type_text`. |
| Screenshot | Yes, saved as a session artifact |
| Start / stop recording | Yes, MP4 saved as a session artifact |
| Artifacts and status panel | Yes |

These iOS input limits come from Simlock's "Watching the screen" documentation.

## Taking over from the agent

The viewer follows the human/agent hand-off model of [Loupe](https://github.com/bmcreations/loupe)
(Apache-2.0):

- When you touch the screen (or press **Take over**), you hold the device. While you hold it, the
  agent's UI actions fail with `HUMAN_HELD` (CLI exit code 11). The error is retryable and carries a
  `retryAfterMs` hint.
- A touch holds the device for `viewer.humanHoldMs` (15 seconds by default) after your last input.
- **Hand back** returns control to the agent at once.
- `get_device_status` tells the agent whether a person is in control.

This hold is enforced by Tapdance, not by Simlock. It stops agents that use Tapdance; it does not stop
someone who calls Simlock directly with a token.

## Bandwidth and load

Simlock encodes the screen on the worker. Its defaults and documented costs:

| Setting (on the worker) | Default |
| --- | --- |
| `capabilities.stream.maxDimension` | 720 px on the longest side |
| `capabilities.stream.bitrateKbps` | 1500 |
| `capabilities.stream.fps` | 30 |

A busy screen costs about 1.4 Mbit/s; an idle one 25 to 90 kbit/s. Each iOS capture uses about 50 to
80 MB of memory on the worker, and each open viewer tab is a separate capture. Change the settings with
`tapdance simlock --local config set <key> <value>` and `tapdance worker restart`.

## Physical iPhones

Simlock can stream a physical iPhone only when the worker runs **Xcode 27 or later** and the iPhone
runs **iOS 27 or later**. Simlock does not accept input for a physical iPhone, so the viewer can only
watch it. Physical-device leases have not been tested with Tapdance (STATUS D-06).

## Simlock's own console

Simlock also has a web console that shows any running device's screen. It is view-only and needs an
operator token, which agents should never hold. `tapdance view` exists because the console cannot be
used to drive a lease and is meant for operators.

## Security

- The viewer controls the device. Treat the link like a password and never post it in a channel.
- Keep the viewer on loopback or a private network. Do not put it behind a public proxy.
- The agent token stays inside `tapdance view`; the browser gets only a session cookie.
- Whoever can drive the simulator can do anything the app under test allows, including signing in with
  test accounts stored in it.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `tapdance view` fails before printing a link | No device leased for this session | Lease one first, with the same session (`--session` or the agent's session id) |
| Black screen, `STREAM_UNAVAILABLE` | Streaming off on the worker or gateway, or the capture helper is not executable | `tapdance worker install` (or `worker login` without `--no-viewer`); `tapdance worker start` restores the helper's execute bit |
| Picture works, taps do nothing | Input off on the worker or gateway | As above; check `tapdance worker status` |
| Typing does nothing | iOS 27+ runtime | Let the agent type with `type_text` |
| Agent reports `HUMAN_HELD` | You touched the screen | Press **Hand back**, or wait `viewer.humanHoldMs` |
| Link stopped working | `tapdance view` exited or the lease ended | Run `tapdance view` again |
