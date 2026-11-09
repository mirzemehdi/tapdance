# What you can ask your agent

Each section below is one thing you might want your agent to do. It shows what to say, what the agent
does behind the scenes, how to do the same by hand in a terminal, and what you get back.

You don't need the terminal commands to use Tapdance with an agent. They are here for scripts, for
checking a result yourself, and for when you are curious what the agent did.

**Before you start.** Tapdance is installed and connected to your agent, and a machine runs the phones.
The [README](../README.md#set-it-up-with-your-agent) has a prompt that lets your agent do the setup, and the [three steps by hand](../README.md#or-set-it-up-by-hand).

**Where results land.** Screenshots, videos and logs are saved on the computer your agent runs on, in
`tapdance-artifacts/<session>/` inside the folder where the agent was started. Each session folder has
a `manifest.json` that lists them. `tapdance artifacts` lists them too, and the agent gets the same
list with `get_test_artifacts`.

**One phone at a time.** An agent session borrows one phone at a time. To test Android and iOS, the
agent gives back the first phone before it borrows the second.

## Contents

- [Test your Android app](#test-your-android-app)
- [Build and test your iOS app](#build-and-test-your-ios-app)
- [Take a screenshot](#take-a-screenshot)
- [Record a video](#record-a-video)
- [Watch live, or take over](#watch-live-or-take-over)
- [Find out why it crashed](#find-out-why-it-crashed)
- [Make a repeatable test](#make-a-repeatable-test)
- [Check accessibility](#check-accessibility)
- [Measure performance](#measure-performance)
- [Test in-app purchases](#test-in-app-purchases)
- [Test deep links and notifications](#test-deep-links-and-notifications)
- [Build from a private repository or your CI](#build-from-a-private-repository-or-your-ci)

## Test your Android app

**Say to your agent**

> Install app-debug.apk on an Android emulator, sign up with a new account and tell me if anything
> breaks.

> Build the debug APK, open the app on an Android phone and go through the first-run screens. Take a
> screenshot of each one.

**What the agent does**

1. `lease_device` borrows an Android emulator.
2. `install_app` uploads the APK and installs it.
3. `launch_app` opens the app.
4. `inspect_screen` reads what is on the screen: buttons, fields, text.
5. `tap`, `type_text`, `swipe` and `wait_for` go through the flow.
6. `take_screenshot` saves each screen and shows it to the agent.
7. `release_device` gives the phone back.

**By hand**

```bash
tapdance device lease --platform android
tapdance app install app/build/outputs/apk/debug/app-debug.apk --launch com.example.app
tapdance ui inspect
tapdance ui tap --text "Sign up"
tapdance ui type --text "Email" "new.user@example.com"
tapdance ui wait --text "Welcome"
tapdance screenshot
tapdance device release
```

**What you get back:** the agent's verdict, and a PNG of each screen it photographed.

**React Native, Expo and other JavaScript apps:** a debug APK loads its JavaScript from
[Metro](https://metrobundler.dev) on your computer. That works when the emulator runs on the same Mac as Metro. When the phones run on another
machine, they cannot reach Metro: build a release APK instead, which carries its JavaScript inside, for
example `cd android && ./gradlew assembleRelease`. The default React Native template signs it with the
debug key. This has not been tried with Tapdance yet.

**Limits:** an `.aab` works too: it is turned into an APK with bundletool on the agent's computer.
Emulators on Google Cloud are x86_64 and emulators on Apple-silicon Macs are arm64, so an APK built for
only one ABI fails to install on the other with `INSTALL_FAILED_NO_MATCHING_ABIS`. A large APK takes a
while to upload: 77 MB took about two and a half minutes to a cloud machine.

## Build and test your iOS app

**Say to your agent**

> Build the iOS app from this repo, run it on an iPhone simulator, go through onboarding and checkout,
> and send me screenshots of each step.

> Build the iOS app from the `feature/checkout` branch on the Mac and test the new checkout screen on an
> iPhone.

**What the agent does**

It gets the app onto the simulator in one of two ways:

- **When the agent runs on your Mac,** it builds the app itself with `xcodebuild` for the simulator,
  then installs the `.app` with `install_app`.
- **When the phones run on another Mac,** `build_app` makes that Mac fetch the repository from git,
  build it and install it. The Mac's owner allows each repository once.

Then the same steps as on Android: `lease_device`, `launch_app`, `inspect_screen`, `tap`,
`type_text`, `wait_for`, `take_screenshot`, `release_device`.

Tell the agent which workspace and scheme to build, for example "build scheme MyApp-Dev from
MyApp.xcworkspace". `xcodebuild -list` shows the schemes.

**By hand, on your Mac**

```bash
xcodebuild -workspace MyApp.xcworkspace -scheme MyApp-Dev \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath ./build build
tapdance devices --platform ios
tapdance device lease --platform ios --device "iPhone 16"
tapdance app install ./build/Build/Products/Debug-iphonesimulator/MyApp.app --launch com.example.myapp
tapdance screenshot
tapdance device release
```

Use `-project MyApp.xcodeproj` instead of `-workspace` when there is no workspace. The `.app` lands in
`./build/Build/Products/<configuration>-iphonesimulator/`, named after the product, which is not always
the scheme's name. To find it, run the same `xcodebuild` line with `-showBuildSettings` and read
`BUILT_PRODUCTS_DIR` and `FULL_PRODUCT_NAME`. The bundle id for `--launch` is in the target's settings
in Xcode, or in `tapdance app list` once the app is installed. Add `build/` and `tapdance-artifacts/` to
your `.gitignore`.

`tapdance devices` lists the simulator models and iOS versions the Mac has. Ask for one of those: a
lease for a model or version that is not installed fails, with a hint.

**By hand, with the phones on another Mac**

```bash
tapdance device lease --platform ios
tapdance app build --git https://github.com/you/your-app --ref main --launch com.example.myapp
tapdance screenshot
tapdance device release
```

**What you get back:** the agent's verdict and a screenshot of each step. A build on another Mac also
reports the exact commit it built.

**Limits:** iPhone simulators need a Mac. A build for a real iPhone (`.ipa`) does not run on a
simulator. Builds on another Mac must be turned on by its owner, once per repository; see
[host builds](guides/host-builds.md). Builds on another Mac run `xcodebuild` only: React Native and
Flutter apps, which need Node.js, CocoaPods or Flutter first, have not been tried there.

## Take a screenshot

**Say to your agent**

> Send me a screenshot of the settings screen in dark mode.

> Take screenshots of the home screen in English, German and Japanese.

**What the agent does**

1. `set_device_setting` switches the phone to dark mode (`appearance`, `dark`). For another language,
   `launch_app` opens the app with a `locale`, or `set_device_setting` changes the phone's `language`.
2. `tap` and `wait_for` get to the right screen.
3. `take_screenshot` saves the PNG and shows it to the agent.

**By hand**

```bash
tapdance device setting appearance dark
tapdance app launch com.example.app --relaunch --locale de-DE
tapdance screenshot --note "settings, dark, German"
```

**What you get back:** PNG files in the session's artifacts folder.

## Record a video

**Say to your agent**

> Record a video of the login flow and give me the MP4.

> Record yourself going through checkout so I can attach the video to my pull request.

**What the agent does**

1. `start_recording` starts recording the screen.
2. It goes through the flow with `tap`, `type_text` and `wait_for`.
3. `stop_recording` stops and downloads the MP4 to the agent's computer.

**By hand**

```bash
tapdance record start
tapdance record stop
```

**What you get back:** an MP4 in the session's artifacts folder.

**Limits:** a recording still running when the phone is given back is stopped and kept.

## Watch live, or take over

**Say to your agent**

> Open a live view so I can watch, and let me take over when you get stuck.

> When you reach the Google sign-in screen, ask me to sign in, and wait until I hand back.

**What the agent does**

- **The live view:** in Claude Code, the agent can run `tapdance view` in its terminal; it prints a
  link to open in your browser. The page shows the phone live.
- **Taking over:** touching the phone in the page takes over. The agent's next action is refused, and
  it waits. **Hand back** returns control.
- **Asking you:** `request_human` asks you to do something, such as a sign-in or a purchase, and waits
  until you hand back. Your password never passes through the agent.

**By hand**

```bash
tapdance view
tapdance device request-human --reason "Sign in with the Google test account"
```

When you are done in the browser, press **Hand back**, or run `tapdance device done`. To watch an
agent's phone from your own terminal, pass its session: `tapdance --session claude-code:<id> view`.
[Connect your agent](agents.md#watching-the-agent) shows how to find the id.

**What you get back:** the live page; after a hand-off, the agent carries on from where you left the
phone.

**Limits:** when the agent's computer is a server, open the page over Tailscale with
`tapdance view --tailscale`; see the [browser viewer](deployment/browser-access.md).

## Find out why it crashed

**Say to your agent**

> The app crashes after login. Get the crash log and tell me why.

> Reproduce the crash from issue 42 on Android 14 and send me the logs.

**What the agent does**

1. It reproduces the steps with `launch_app`, `tap` and `type_text`.
2. `get_crash_logs` reads the crash: Android's crash buffer, or the iOS simulator's faults and crash
   messages.
3. On iOS, `crash_reports` lists the crash reports the simulator wrote and pulls one with a summary of
   the crashed thread.
4. `get_logs` reads the app's recent log lines, for example only errors.

**By hand**

```bash
tapdance logs --crash
tapdance logs --app com.example.app --level error
tapdance device crashes --pull latest
```

The last line is for iOS.

**What you get back:** the agent's explanation, and the logs and crash report saved as files.

## Make a repeatable test

**Say to your agent**

> Turn what you just did into a scenario file and run it again on iOS and Android.

> Write a scenario that signs in with the test account and checks the home screen, then run it.

**What the agent does**

1. It writes a scenario file by hand: a short YAML list of the same steps it used, such as
   `launch_app`, `type_text`, `tap`, `expect_visible` and `take_screenshot`. No tool records the steps
   for it. Ask it to find elements by text or accessibility id, not by the short-lived refs it uses
   while exploring: refs do not replay. On iOS, `id` matches SwiftUI's `.accessibilityIdentifier`.
2. `run_scenario`, or `tapdance run` in its terminal, replays the file and returns PASS or FAIL for
   each step. One file per platform, because each names its phone and app.

To start each run signed out, put `clear_app_data` first, and on iOS also `set_device_setting` with
`reset-keychain`.

**By hand**

```bash
tapdance run e2e/signin.android.yaml
tapdance run e2e/signin.ios.yaml
```

`tapdance run` takes one file and exits with code 12 when a step fails, so a shell loop runs a whole
folder before a release:

```bash
for f in e2e/*.ios.yaml; do tapdance run "$f" || exit 1; done
```

A scenario uses the phone the session already holds, and borrows the one it names only when the
session holds none. To run the same file on several iPhone models, borrow each one in turn with
`tapdance device lease --device …`, run the file, and give the phone back.

A scenario looks like this:

```yaml
name: Sign in
platform: android
device:
  platform: android
  device: Pixel 8
steps:
  - launch_app: { app_id: com.example.app, relaunch: true }
  - type_text: { text: ada@example.com, into_text: Email }
  - tap: { text: Sign in }
  - expect_visible: { text: "Welcome", timeout_ms: 10000 }
  - take_screenshot: { note: signed in }
```

**What you get back:** a PASS or FAIL report. A failed step comes with a screenshot and the screen's
contents, in an evidence folder.

**Limits:** `tapdance run` has passed on a real iPhone simulator and Android emulator; the MCP tool
`run_scenario` is tested with fakes only, so ask the agent to use `tapdance run`. Scenario files have no
variables: a test password in the file is committed with it, so use a test-only account. Running
scenarios on a CI runner has not been tried. [Scenarios](scenarios.md) has the full format.

## Check accessibility

**Say to your agent**

> Check the sign-up screens for accessibility problems: unlabelled buttons, small touch targets.

> Turn on the largest text size and check that no button label is cut off.

**What the agent does**

1. `audit_screen` checks the screen the way VoiceOver or TalkBack meets it: controls with nothing to
   announce, small touch targets, controls announced alike, unlabelled images.
2. `set_device_setting` changes the text size (`text-size`).
3. `take_screenshot` shows what changed.

**By hand**

```bash
tapdance ui audit
tapdance device setting text-size
tapdance screenshot
```

Run `tapdance device setting text-size` without a value to read the current size, then give the value
you want.

**What you get back:** a list of problems per screen, with the element each one is about.

## Measure performance

**Say to your agent**

> Scroll the feed for 30 seconds and tell me how many frames were janky.

> Check the app's memory before and after opening ten product pages.

**What the agent does**

1. `measure_performance` with `frames` starts from a clean count.
2. It scrolls or taps through the flow.
3. `measure_performance` with `frames` again reads janky and slow frames; with `memory` it reads the
   app's memory.

**By hand**

```bash
tapdance device perf frames --app com.example.app
tapdance device perf memory --app com.example.app
```

**What you get back:** frame counts and percentages, or memory numbers, in the agent's answer.

**Limits:** frame health works on Android emulators. iOS simulators report memory only: frame health
needs a real iPhone.

## Test in-app purchases

**Say to your agent**

> Buy the monthly subscription with the test account and check that the premium badge appears.

**What the agent does**

1. On Android, `lease_device` borrows an emulator with the Google Play image (`image_tag`
   `google_apis_playstore`), which Play Billing needs.
2. It opens the purchase screen with `launch_app` and `tap`.
3. When a sign-in or a purchase sheet needs a person, `request_human` asks you, and waits.
4. `take_screenshot` and `inspect_screen` check the result.

**By hand**

```bash
tapdance device lease --platform android --image-tag google_apis_playstore
tapdance device request-human --reason "Sign in with the Play test account"
```

**What you get back:** the agent's verdict and screenshots of the purchase.

**Limits:** iOS uses StoreKit testing, set up in your Xcode scheme. The billing flows have not yet run
end to end with a real store account. The setup for both platforms is in
[testing in-app purchases](guides/purchase-testing.md).

## Test deep links and notifications

**Say to your agent**

> Open myapp://orders/42 and check that the order screen shows order 42.

> Post a "new message from Sam" notification on the Android phone, open it, and check that it lands in
> the right chat.

**What the agent does**

1. `launch_app` opens the app with a deep link (`url`).
2. `notifications` posts a notification, lists the ones on screen, or opens one, the way a person
   would.
3. `opened_links` shows which links the app asked the system to open, such as a web page or the App
   Store.
4. `inspect_screen` and `take_screenshot` check where it landed.

**By hand**

```bash
tapdance app launch com.example.app --url "myapp://orders/42"
tapdance device notifications post --title "Sam" --text "New message"
tapdance device notifications tap --text "New message"
```

On iOS, a push goes to an app as a payload:
`tapdance device notifications post --app com.example.myapp --payload '{"aps":{"alert":"New message"}}'`.

**What you get back:** screenshots and the agent's verdict.

**Limits:** on iOS, a push arrives and shows in Notification Center, but in one run tapping it did not
open the app.

## Build from a private repository or your CI

**Say to your agent**

> Build the app from the `release/2.3` branch of our private repo on the test Mac and smoke-test it.

> Install the APK from the latest CI run on main and check the login screen.

**What the agent does**

- `build_app` makes the machine that runs the phones fetch your repository and build it. A private
  repository needs a read-only GitHub token or deploy key there, set up once by its owner.
- `install_app` with `from_ci` makes that machine download the app your GitHub Actions run built, and
  install it.

**By hand**

```bash
tapdance app build --git https://github.com/you/your-app --ref release/2.3
tapdance app install --from-ci you/your-app --artifact app-debug
```

**What you get back:** the installed app, the commit or CI run it came from, and the build log if it
fails.

**Limits:** both are turned on by the owner of the machine that runs the phones; see
[host builds](guides/host-builds.md) and [build in CI](guides/ci-builds.md). Installing an iOS app from
CI is unit-tested only.

## Something missing?

The full list of tools is in [MCP tools](mcp.md), and every command is in the
[CLI reference](cli-reference.md). If you need something Tapdance cannot do, `tapdance report` writes
an issue you can file.
