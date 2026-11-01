# iOS demo app

A one-screen SwiftUI sign-in form for exercising Tapdance end to end on an iOS simulator: labelled
fields with accessibility identifiers (`email`, `password`, `sign-in`, `result`) and a result text.

Build (macOS with Xcode; no Xcode project needed):

```bash
examples/ios-demo/build.sh   # prints the path to build/TapdanceDemo.app
```

Drive it:

```bash
tapdance device lease --platform ios --device "iPhone 16"
tapdance app install examples/ios-demo/build/TapdanceDemo.app
tapdance app launch dev.tapdance.demo
tapdance ui type "ada@example.com" --id email
tapdance ui type "secret1" --id password
tapdance ui tap --text "Sign in"
tapdance ui wait --text "Welcome, ada@example.com"
tapdance screenshot
tapdance device release
```

Or ask your agent: *"Lease an iOS simulator, install examples/ios-demo/build/TapdanceDemo.app, sign in
as ada@example.com with password secret1, and confirm the welcome message with a screenshot."*

The integration test can use it too: `TAPDANCE_IT_APP=examples/ios-demo/build/TapdanceDemo.app
TAPDANCE_IT_APP_ID=dev.tapdance.demo`.
