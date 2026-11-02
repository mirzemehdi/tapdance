# Testing in-app purchases

How an agent tests "buy → entitlement unlocked → restore" with Tapdance: Google Play Billing on an
Android emulator, StoreKit on the iOS simulator. What is proven is in [STATUS.md](../../STATUS.md)
(D-10, U-13); the billing flows below have **not** been run end to end with a real Play Console app yet.

## Android: Play Billing on an emulator

Play Billing needs three things on the device: a Google Play system image, a Google account signed in,
and that account listed as a **license tester** for your app. Tapdance's leased emulators are wiped at
release, so the signed-in account lives in a **device profile**.

### Once, on the machine that runs the emulators

1. In Play Console, add a dedicated Google account under *Settings → License testing*, and upload a
   build with the same package name and signing key to a testing track (internal testing is enough).
   License testers pay with test cards ("Test card, always approves", "always declines", "slow").
2. Install a Play image if you have none:
   `sdkmanager "system-images;android-34;google_apis_playstore;arm64-v8a"` (x86_64 on Intel/Linux).
3. Create the profile and sign in:

   ```bash
   tapdance device profile create play-tester
   ```

   The emulator opens with a window. Sign in to the Play Store with the tester account, accept the
   terms, let Play Store update, then close the window. That state is saved. Run
   `tapdance device profile edit play-tester` later to refresh it (Play Store updates, an expired
   sign-in).

Use a dedicated test account: anyone who can lease the profile acts as it. Your password is typed in
the emulator, never given to Tapdance or the agent.

### Each test run (the agent)

```text
lease_device   { "platform": "android", "profile": "play-tester" }
install_app    { "path": "app/build/outputs/apk/release/app-release.apk" }   (signed like the Play build; .aab works with bundletool)
launch_app     { "app_id": "com.example.app" }
tap            { "text": "Start free trial" }
inspect_screen                                                          (the Play purchase sheet)
tap            { "text": "Subscribe" }
wait_for       { "text": "Premium" }
take_screenshot
release_device                                                          (the purchase and the app are thrown away; the sign-in stays in the profile)
```

If a sheet asks for the account password, or Google asks to verify the account, the agent calls
`request_human` with the reason; you do it in the emulator window and run `tapdance device done`.

Testing restore: `clear_app_data`, `launch_app`, tap *Restore purchases*, expect the entitlement.

Limits: profiles are **local only**: they work when the agent runs on the machine with the emulators,
not from a VPS through a gateway or the worker guard. They have no browser stream (watch the emulator
window), and Google may still ask for re-verification on an account that signs in from many emulators.

**Agent on a VPS?** Run the rest of the test plan on a normal lease (no `image_tag`: the lighter
`google_apis` image) and lease a Play-image device (`image_tag: "google_apis_playstore"`) only for the
purchase steps; when the test
reaches a sign-in, the agent calls `request_human` and you sign in through `tapdance view`, then press
**Hand back**. The sign-in lasts until the lease ends, so keep one lease for the whole testing session
(it is renewed in the background, up to `session.maxSessionMinutes`, 240 by default) and run every
purchase test on it: one sign-in per session, not per test.

## iOS: StoreKit testing on the simulator

StoreKit testing needs no Apple account on the simulator. It uses a StoreKit configuration file
(`.storekit`) attached to the scheme you build with:

1. In Xcode, *File → New → StoreKit Configuration File*, add your products (or sync them from App
   Store Connect), and select it under *Scheme → Run → Options → StoreKit Configuration*.
2. Build for the simulator into the project:
   `xcodebuild -scheme App -sdk iphonesimulator -derivedDataPath ./build build`.
3. The agent installs `./build/Build/Products/Debug-iphonesimulator/App.app`, launches it and taps
   through the purchase sheet like any other UI (`inspect_screen`, `tap { "text": "Subscribe" }`,
   confirm). Transactions are local to the simulator and disappear at release.

Sandbox purchases with a real App Store Connect sandbox account need a sign-in on each new simulator:
the agent calls `request_human` and you sign in through `tapdance view`. iOS device profiles are not
built yet.
