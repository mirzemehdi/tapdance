# Evidence: gateway + joined worker on one Mac — 2026-11-01

Real Simlock gateway, real outbound worker uplink, real iOS simulator; both daemons on the same Mac
(not two machines). This exercises the exact code path of the VPS + laptop-worker setup (PRODUCT
M-02/Q-06) except the network between them. Same environment as
[2026-11-01-local-ios.md](2026-11-01-local-ios.md).

## Steps and results

1. `tapdance gateway setup --worker-label mac-local` (scratch `TAPDANCE_HOME`): gateway started on
   127.0.0.1:4700 with agent-device, stream and input enabled; worker, agent and operator tokens
   minted; agent + operator tokens stored 0600; config set to `self-hosted` → `http://127.0.0.1:4700`.
2. `tapdance gateway token --role worker --label mac-local` piped into
   `tapdance worker login --gateway ws://127.0.0.1:4700 --label mac-local`: worker HTTP turned off,
   capabilities on, daemon restarted; uplink established.
3. `tapdance workers list`: `mac-local … connected  android 0/2  ios 2/5  agent-device available  stream available`.
4. `tapdance doctor --no-host`: agent-device, stream and input reported as available "on mac-local".
5. CLI through the gateway: `device lease --platform ios --device "iPhone 16" --os 18.5` → *Provider:
   Remote worker "mac-local"*; `app launch`, `ui tap --text General` (diff), `ui wait --text About`
   (found in 42 ms), `screenshot` (PNG downloaded to the agent side), `logs` (exec relayed by the
   gateway), `device release`.
6. MCP over stdio through the gateway: `TAPDANCE_IT_ENDPOINT=http://127.0.0.1:4700` integration test —
   the full loop of the local run, passed in 103 s.
7. Viewer through the gateway: stream 200 (h264 332×720 meta, avcC, keyframe), input admitted, a
   browser touch produced `HUMAN_HELD` (retryAfterMs ≈ 6600) for the agent; then opened in a real
   Chromium-based browser pane: the simulator rendered live, a click on the picture tapped
   "AutoFill & Passwords" on the device, and the panel showed *Control: you, briefly*.
8. `tapdance worker logout` and gateway stop: the worker returned to standalone mode with HTTP on.

## Bugs this run found (fixed in the same change)

- `gateway setup` printed the join token as `[REDACTED]` (output redaction), so the worker joined
  with a literal placeholder and the gateway answered 401. Secret-handing commands now print
  unredacted, on purpose and only there.
- `doctor` against a gateway reported agent-device/stream/input as missing: a gateway reports
  capabilities per worker. It now merges the connected workers' capabilities (operator token).
- The viewer's Back/Apps buttons do nothing on iOS simulators (Simlock acts on Home only there);
  they are now disabled for iOS.

## Not covered

A real network between gateway and worker (latency, NAT, TLS proxy, reconnect after sleep), a
non-macOS gateway host, Android.
