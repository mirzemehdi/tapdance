# iOS compatibility-screen demo app

A one-screen UIKit app for two agent-device checks that need an unusual app
([#153](https://github.com/mirzemehdi/tapdance/issues/153)):

- **No launch screen** in its Info.plist, so iOS runs it on the legacy compatibility screen: letterboxed,
  in a 320×480-point window scaled to the device. Taps there must be mapped from the app's points to the
  screen's.
- **A chain of 80 nested views** with identifiers (`level-1` … `level-80`, then `deep-leaf`), so the
  accessibility tree is deeper than 64 levels.

It has a "Tap me" button (`tap-me`) that counts taps into a label (`result`, "Taps: N").

Build (macOS with Xcode; no Xcode project needed):

```bash
examples/ios-compat-demo/build.sh   # prints the path to build/TapdanceCompat.app
```

Drive it:

```bash
tapdance device lease --platform ios
tapdance app install examples/ios-compat-demo/build/TapdanceCompat.app
tapdance app launch dev.tapdance.compat
tapdance ui inspect                      # deep-leaf and level-80 are listed
tapdance ui tap --id tap-me
tapdance ui wait --text "Taps: 1"
tapdance device setting orientation landscape
tapdance ui tap --id tap-me
tapdance device release
```

Result on 2026-11-09 (Scaleway Mac mini M2-L, iOS 27.0, agent-device 0.21.36 with Tapdance's #56 patch):
the deep tree is read (84 elements, `deep-leaf` included), but **taps miss in both orientations**: they
land at the app's own coordinates instead of the scaled, letterboxed position on screen
([evidence](../../docs/testing/evidence/2026-11-09-byoc-self-run.md)).
