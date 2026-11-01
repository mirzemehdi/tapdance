# Evidence: device-state tools, the guard's device channel, device profiles — 2026-11-01

Real emulators and simulators, no mocks. Same Mac as [2026-11-01-local-ios.md](2026-11-01-local-ios.md)
(MacBook Pro M1 Pro, macOS 26.5, Xcode 26.5, Simlock 0.4.0, agent-device 0.21.35). Scratch
`TAPDANCE_HOME`s; the demo apps in `examples/`.

## Android, local worker (Pixel 8, Android 34)

`device push hello-qa.txt --to downloads` then `device pull /sdcard/Download/hello-qa.txt`: the pulled
artifact contained the original text. Settings: `appearance dark`, `density 320` and `reset`,
`airplane on/off`, `time-zone Asia/Tokyo` (read back with `getprop persist.sys.timezone`),
`locale de-DE --app dev.tapdance.demo`, `permission grant --permission notifications`, `orientation
landscape-left` / `portrait`. `app launch --intent-action android.intent.action.MAIN
--intent-component dev.tapdance.demo/.MainActivity`. `device perf frames` after a normal launch and a
swipe returned frame counts and the worst windows (gfxinfo framestats). `notifications post` then
`notifications list` showed the posted title and text; `notifications open` then `ui inspect --all`
showed the System UI shade.

Found and fixed: setting the time zone did nothing until Android's automatic time zone was turned off
(now done first); orientation once missed agent-device's own confirmation budget (now retried once);
`perf frames` needs the app opened through `launch_app`, not an intent.

## iOS, local worker (iPhone 16, iOS 26.5)

`appearance dark`, `status-bar-time 09:41`, `permission grant --permission photos`, `text-size large`,
`reset-keychain`; `device push <png> --to pictures` (Photos), `device push qa-seed.json --to documents
--app dev.tapdance.demo` and `device pull --app dev.tapdance.demo --path Documents/qa-seed.json`;
`notifications post --app … --payload '{"aps":…}'` (push payload); `app launch … --arg -AppleLanguages
--arg "(de)"`; `app clear`, `app uninstall` (gone from `app list`); `density` correctly refused with
`NOT_SUPPORTED`.

## Through the worker guard (device-only mode, one Mac)

A guard on `127.0.0.1:4731` in front of the local Simlock, `allow.notifications: true`, one paired
client:

- The MCP integration test (`TAPDANCE_IT_ENDPOINT` = the guard) with the demo APK passed in 124 s:
  upload and install (upload bound to the client), interaction, screenshot and recording downloads
  (artifacts bound to the client), logs, release. The audit log had no denials.
- Through the same guard: file push and pull (contents round-tripped), `appearance`, `density`,
  `time-zone`, `locale`, notification post and list, intent launch, `perf frames`, `app clear`,
  `app uninstall`. No denials.

## Device profiles (Android)

`device profile create qa-play --no-edit` created `tapdance-qa-play` from
`system-images;android-34;google_apis_playstore;arm64-v8a` in the scratch home's AVD folder. The
profile was set up headless (`TAPDANCE_PROFILE_HEADLESS=1 device profile edit`): the demo APK
installed, then the emulator closed. Then twice: `device lease -p android --profile qa-play` →
`dev.tapdance.demo` present → `app uninstall dev.tapdance.demo` (gone) → `device release`. The next
lease had the app again, so the lease's change was discarded and the profile's state kept. Launch,
inspect, type and tap worked on a profile lease; no agent-device device claim remained after release.

Found and fixed: `avdmanager` silently created nothing when the AVD folder did not exist; `app list`
needed the device named on the local agent-device daemon; one agent-device session name per emulator
port, so an earlier process's session cannot block a later lease. Simlock's `device add` refused the
profile emulator ("only USB-connected devices can be enrolled"), which is why profiles run outside
Simlock.

Not covered: a real Google sign-in and a Play Billing purchase (needs the owner's license-tester
account and a Play Console app), profiles through the guard or a gateway, `.aab` conversion with a real
bundletool (unit-tested with a fake), and two machines.

## Scenarios (`tapdance run`)

`tapdance run examples/ios-demo/signin.scenario.yaml` leased an iPhone 16 (iOS 26.5), installed the
demo app and passed all 8 steps (expect the email field, type email and password by id, tap Sign in,
expect "Welcome, ada@example.com", screenshot) in 44.8 s, writing `report.json`/`report.md` to the run's
evidence folder. The Android example failed at its first `type_text` with an adb timeout while a
leftover Google Play emulator used ~490% CPU on the test Mac; it has not passed yet.

## Removed after this run

`device audio` / `audio_levels`: agent-device's audio probe records the Mac's own system audio with
ScreenCaptureKit, and macOS asked for Screen Recording permission for Node (denied by the owner). The
tool, the CLI command and the guard allowance are gone.
