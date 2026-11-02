# 2026-11-02: field runs, agent on a VPS, devices on a Mac over Tailscale

**Source:** reports a coding agent filed while it tested the Pianolune app from an Ubuntu VPS, in
[issue #13](https://github.com/mirzemehdi/tapdance/issues/13) and in its verification comments on the
issues listed below. The maintainers did not repeat these runs; the numbers are the agent's.

## Setup

- **Control machine:** Ubuntu VPS, Tapdance CLI only (no MCP), `provider: "self-hosted"`.
- **Host:** the owner's Mac, set up with `scripts/host-setup.sh … --allow-admin-account --keep-awake` and later `tapdance host up`; worker guard as a LaunchAgent; Simlock 0.4.0.
- **Link:** Tailscale, first `http://<mac>.ts.net:4720`, later `https://…:4720` after HTTPS Certificates were turned on.
- **Devices:** Pixel 7 and Pixel 8, API 34 (`google_apis` and `google_apis_playstore`); iPhone 17, iOS 26.5.
- **Tapdance versions:** from b223db3 to c851e1c during the day.

## What ran

| Run | What | Result |
| --- | --- | --- |
| Android run 1 (interim) | Lease, inspect, tap, type, keys, alerts, screenshot, `device shell`, `device push`, app launch/clear, crash logs; Pianolune onboarding through the paywall | Worked; problems filed as #23, #24, #26, #27, #28 |
| Android run 2 | About 1,000 tool calls: 75 MB APK install through the guard (104 s), clear/launch/stop, push ×5 and pull, settings, alerts, `ui wait --stable`, element states, viewer in screenshot mode and over https | 25 pass, 6 fail, 42 blocked (app results); Tapdance problems filed as #29–#35 |
| Android run 3 | Leases on the Play and the default image after the stale-claim fix; recording start/stop (13 parts over 50 min) | Leases granted first try (#31, #36 verified); recording worked (#32 verified) |
| iOS run | Lease, app clear/stop/launch/relaunch, deep links, launch arguments, push to Photos, settings (appearance, text size, orientation, location, permissions, Face ID, keychain, status-bar time), `ui wait`, recording (29 s MP4), `request-human` | Worked; gaps filed as #45–#50 |
| Verification of #42–#44 | `app kill` ×4 (portrait and landscape; 7 reminder alarms kept); `ui sequence`: a Pianolune lesson played in time, 70/70 notes, mean drift 24 ms, max 40 ms; `ui wait` 65 s | #43 passed; #42 found a 32-bit timing bug (fixed afterwards); #44 partly |

## Latency, VPS → Mac (run 2)

| Call | n | Median | p90 |
| --- | --- | --- | --- |
| `ui` (tap, inspect, type, key, swipe, wait) | 640 | 852 ms | 2.3 s |
| `screenshot` | 270 | 2.0 s | 2.9 s |
| `device …` (shell, setting, push) | 67 | ~0.6 s | 1.6 s |
| `app` (launch, stop, clear) | 10 | 3.3 s | 7.1 s |
| `app install` (75 MB) | 1 | 104 s | |
| Lease (warm spare) | 3 | 96–101 s | |

## Not covered

- An MCP client on the VPS: every run used the CLI.
- Builds on the host (#45), `view --tailscale`, and the fixes after c851e1c.
- A fresh Mac: the host already had Node and Android Studio.
