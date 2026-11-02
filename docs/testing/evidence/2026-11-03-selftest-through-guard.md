# 2026-11-03: tool self-test through the worker guard, with Pianolune as the test app

**Source:** the owner's checklist `TAPDANCE_SELFTEST_PIANOLUNE.md`, run by the maintainers on the
owner's Mac. The client was a separate Tapdance CLI (own `TAPDANCE_HOME`, own session id, own guard
token `claude-selftest`) talking to the worker guard on `http://127.0.0.1:4720`, the same API a remote
agent uses (only the network hop differs).

## Setup

- **Host:** the owner's Mac (MacBookPro18,3, macOS 26.5), worker guard as a LaunchAgent, Simlock 0.4.0,
  agent-device 0.21.35. Host at c31bcd1 for the guard and worker; the client ran the working tree as
  the fixes below landed (up to acd285d).
- **Devices:** iPhone 17, iOS 26.5 simulator; Pixel, API 34 emulator (`google_apis`).
- **App:** Pianolune 4ac08b4 (`KAppMakerDeveloperApps/Pianolune-All` `main`), built on the host with
  `app build`.

## Results

| # | Check | Result | Evidence |
| --- | --- | --- | --- |
| A1 (#57) | `app build` iOS, then onboarding to Home | Pass | Built in 36 s (`ARCHS=arm64`, `CODE_SIGN_IDENTITY=-`); the binary has a `__TEXT,__entitlements` section; 0 `-34018` lines in `logs --app`; Home lists the songs (API reached). |
| A2/A3 (#56) | Taps in landscape | Cause found, fix not yet live | Runner log `point=(-22.0,437.0) reference=(0.0,0.0,874.0,402.0) orientation=3`: rotated against the runner's 320 pt legacy screen. A tap pre-shifted by 82 pt landed. The pnpm patch (c554547) is on the host, but the worker still ran the old agent-device folder (fixed in d98ee9f, needs `worker restart`). |
| A5 (#58) | `ui type` into a Compose field | Pass | "WRONGCODE1 Für Elise 2026": first fill dropped characters, the automatic retry at 80 ms filled all 25. |
| A6 (#58) | `ui key dismiss_keyboard` | Not possible (documented) | Refused with the reason (the iPhone keyboard has no hide key). Tapping static text above it does not close a Compose field's keyboard either. |
| A7 (#58) | Toggle a switch | Pass | `#settings_reduce_motion` flips and reads `[selected]`. Found: a row hidden under the tab bar reports "Tapped" with no effect. |
| A8 (#58) | Link-out to Safari | Pass (after a fix) | Safari stays in front after the tap. Any read brought Pianolune back; `ui inspect --app com.apple.mobilesafari` (added) reads "Terms · Pianolune". |
| A9 (#50) | `ui alert get` / `accept` | Pass | Title, message and "Don’t Allow, Allow"; accept pressed Allow. |
| A10 (#50) | Inspect on the Home Screen | Pass (after a fix) | Clear hint; `ui inspect --app com.apple.springboard` reads the Home Screen. |
| A12 (#49) | Push with the app killed, open Notification Center, read, tap | Partial | Post and open work with the app killed (open switches to SpringBoard on its own, 2/2), the notification is readable ("PIANOLUNE, now, Pianolune, Practice time"). Tapping it expands the group but does not open the app. |
| A13 (#49) | Reset notification permission | Not supported | Refused: not in `simctl privacy`; reinstall is the workaround. |
| A14 (#49) | Device-wide language | Not built | `device setting locale` does not exist (per-app `app launch --locale` does). |
| A18 (#59) | Crash reports | Partial | `device crashes` through the guard answers correctly; the same code lists the two real Pianolune reports for that simulator and none for another. No new crash happened during the lease (the download did not crash this time). |
| A22 (#47) | Files push and pull | Pass | `device pull --files song.mid` saved a `.mid`. |
| A23 | Text size while the app runs | Pass (after a fix) | `accessibility-extra-extra-extra-large` applied live; a read now prints "Text size is …". |
| B1 | `app build` Android | Fail (host setup) | `> [CXX1300] CMake '3.31.6' was not found in SDK`: the host has no CMake. The error now ends with the `sdkmanager "cmake;3.31.6"` command (acd285d). |
| B3 | `ui sequence` 0/3000/6000 ms | Pass | actualMs 20.8 / 3067.4 / 6027.3. |
| B4 | `record start`, about 3 minutes with the screen moving, `record stop` | Pass | 184 s of wall time gave a 170.5 s file (ffprobe). Android's `screenrecord` writes a frame only when the screen changes, so a still stretch at the end is not in the file: that explains run 4's 87.7 s for 125 s. |
| B7 | Orientation read, font scale | Pass | "The screen is portrait (1080×2400)"; `settings put system font_scale 2.0` read back 2.0; text size reads "Text size is large". |
| B8 | Notifications through the guard | Pass | Post, `list` ("com.android.shell: Practice — Time to play"), open and close the shade, permission reset for Chrome. |
| B9 | TalkBack | Not on this image | The `google_apis` image has no TalkBack package (the Play image has Google's accessibility suite). Labels come from `ui inspect`. |
| C2 | Two sessions at once | Blocked by policy | The guard allows one session (`limits.maxSessions` 1); the refusal now says which setting to raise. |
| C3 | Lease an Android version that is not installed | Pass | Refused in 1.3 s ("Runtime missing for android 28"); nothing leased or booted afterwards. |
| C4 | Idle host | Pass | With warm spares at 0, both platforms showed 0 running about a minute after release. |

## Not run

- A4, A14, A15, A16, A17 (stdout), A19, A20, A21: not built. A15 (the clock) and A16 (offline) cannot be
  done per simulator, because the simulator uses the Mac's clock and network.
- B1, B2, B5, B6: the host has no CMake 3.31.6, so the Android build stops.
- B10: needs a person to sign in a license tester.
- C1 (worker restart mid-command) and C5 (scoped token): need the owner to restart the worker and to
  pair a scoped token.

