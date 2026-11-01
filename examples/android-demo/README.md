# Android demo app

A one-screen sign-in form (Email, Password, Sign in, result text) for exercising Tapdance on an Android
emulator. Built with the Android SDK's own tools — `aapt2`, `javac`, `d8`, `zipalign`, `apksigner` —
so it needs no Gradle and no resources. Needs a JDK (17+), build-tools and an `android-34`+ platform.

```bash
examples/android-demo/build.sh   # prints the path to build/TapdanceDemo.apk (debug-signed)
```

```bash
tapdance device lease --platform android --device "Pixel 8"
tapdance app install examples/android-demo/build/TapdanceDemo.apk
tapdance app launch dev.tapdance.demo
tapdance ui type "ada@example.com" --text Email
tapdance ui type "secret1" --text Password
tapdance ui tap --text "Sign in"
tapdance ui wait --text "Welcome, ada@example.com"
tapdance screenshot
tapdance device release
```

Or replay the same flow from a scenario file, which builds a PASS/FAIL report with evidence (see
[docs/scenarios.md](../../docs/scenarios.md); not yet run on a real emulator):

```bash
tapdance run examples/android-demo/signin.scenario.yaml
```

Integration test: `TAPDANCE_IT_PLATFORM=android TAPDANCE_IT_APP=examples/android-demo/build/TapdanceDemo.apk
TAPDANCE_IT_APP_ID=dev.tapdance.demo pnpm test:integration`.

`./build.sh --aab` also builds `build/TapdanceDemo.aab` with bundletool (set `BUNDLETOOL` to its .jar, or
put it in `~/.tapdance/tools/bundletool/`). `tapdance app install build/TapdanceDemo.aab` turns it back
into a universal APK before uploading.
