# Notices

Tapdance is licensed under the [MIT license](LICENSE), Copyright (c) 2026 Tapdance contributors.

Tapdance copies no source code from the projects below. It depends on some of them as npm packages,
runs others as separate executables, and follows the published formats or designs of a few. Each
dependency's own license file travels inside its package. This file lists them so you can check
the terms in one place.

## Runtime dependencies (npm)

These are installed with Tapdance. Versions are the exact pins in `packages/*/package.json` at
0.1.0.

| Package | Version | License | Copyright | Used for |
| --- | --- | --- | --- | --- |
| [simlock](https://github.com/callstackincubator/simlock) | 0.4.0 | MIT | Szymon Chmal | Device leasing, queue, workers, gateway, simulator/emulator lifecycle, screen stream and input sockets. Bundled with the CLI and run as its own daemon. |
| [agent-device](https://github.com/callstack/agent-device) | 0.21.35 | MIT | Callstack | UI snapshots, selectors, gestures, typing, app upload, screenshots, MP4 recordings, app logs. |
| [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) | 1.32.2 | MIT | Anthropic, PBC | The MCP server (stdio and Streamable HTTP). |
| [zod](https://github.com/colinhacks/zod) | 4.6.7 | MIT | Colin McDonnell | Config and MCP input validation. |
| [commander](https://github.com/tj/commander.js) | 15.0.0 | MIT | TJ Holowaychuk | CLI parsing. |
| [ws](https://github.com/websockets/ws) | 8.22.1 | MIT | Einar Otto Stangvik and contributors | WebSockets for the browser viewer's input proxy. |

Transitive dependencies (for example Simlock's `hono`, `jose` and `@agent-device/proxy`) carry
their own licenses in their packages. `pnpm licenses list` prints the full set for your install.

### Third-party components shipped inside those packages

Some packages above ship code from other projects, with their own notices:

- **Simlock** vendors a [scrcpy](https://github.com/Genymobile/scrcpy) server (Apache-2.0, with
  BSD-3-Clause parts) for Android screen capture and control, and a capture and encoder pipeline
  derived from [serve-sim](https://github.com/EvanBacon/serve-sim) (Apache-2.0, Evan Bacon) for iOS
  Simulator streaming, plus a small piece from idevice (MIT). The notices and verbatim license texts
  are in `simlock/dist/vendor/scrcpy/` and `simlock/dist/vendor/screen-capture/` (`NOTICE.md` and
  `LICENSES/`) inside the installed package.
- **agent-device** includes a Simulator accessibility bridge adapted from Meta's
  [idb](https://github.com/facebook/idb) (MIT); its notice is `apple/snapshot-bridge/LICENSE.idb`
  inside the installed package.

Tapdance does not modify or redistribute these components separately; they reach you inside the
upstream packages, with those packages' notices.

## Formats and designs Tapdance follows

Tapdance wrote its own code for these, from published formats or descriptions. Source files that
rely on them say so in a comment.

| Source | License | What Tapdance takes |
| --- | --- | --- |
| [Simlock](https://github.com/callstackincubator/simlock) stream framing | MIT | The browser viewer decodes Simlock's lease stream format: a 5-byte frame header, an avcC description, and AVCC NAL payloads. |
| [serve-sim](https://github.com/EvanBacon/serve-sim) input protocol | Apache-2.0 | The viewer sends touch, button and key messages in the format Simlock's input socket accepts, which is serve-sim's. |
| [Loupe](https://github.com/bmcreations/loupe) (bmcreations) | Apache-2.0 | The human/agent hand-off model: a human touch takes over, agent input is refused with `HUMAN_HELD` and a retry time, and the human hands back. |
| [simslim](https://github.com/MobAI-App/simslim) (Interlap) | MIT | The idea of slimming iOS simulators by disabling background services. Simlock already offers this as its slim mode; Tapdance recommends it and does not reimplement it. |
| [AXe](https://github.com/cameroncooke/AXe) (Cameron Cooke) | MIT | Tapdance's optional iOS backend calls the `axe` executable and maps its output. AXe itself is not bundled. |

[DeviceDeck](https://github.com/devicelab-dev/DeviceDeck) (Apache-2.0) was reviewed when choosing a
streaming approach. Nothing from it is used.

## External tools Tapdance runs but does not bundle

You install these yourself. Tapdance finds them on `PATH` (or at a path you configure in
`tools.paths`) and runs them with an argument array, never through a shell. Their licenses and terms
apply to your use of them.

| Tool | License or terms | Install |
| --- | --- | --- |
| [asc](https://github.com/rorkai/App-Store-Connect-CLI), the App Store Connect CLI | MIT (Rudrank Riyam) | `brew install asc`, or see the project site |
| [AXe](https://github.com/cameroncooke/AXe) | MIT (Cameron Cooke); bundles Meta idb (MIT) | `brew install cameroncooke/axe/axe` |
| [Android CLI](https://developer.android.com/cli) (`android`) | Google's Android CLI terms | See developer.android.com |
| [fastlane](https://github.com/fastlane/fastlane) | MIT | `brew install fastlane` or `gem install fastlane` |
| [Maestro](https://github.com/mobile-dev-inc/maestro) | Apache-2.0 | See the Maestro docs |
| [Xcode](https://developer.apple.com/xcode/) (`xcodebuild`, `simctl`) | Apple's Xcode and SDK license | Mac App Store or developer.apple.com |
| Android SDK, emulator and platform tools | Android Software Development Kit License Agreement | Android Studio or the command-line tools |

Simlock drives Xcode's `simctl` and the Android SDK's `adb` and emulator on workers. Tapdance never
redistributes Xcode, the Android SDK or system images.

## Trademarks

Android is a trademark of Google LLC. iOS, Xcode and Mac are trademarks of Apple Inc. Other names are
trademarks of their owners. Tapdance is not affiliated with Google, Apple, Callstack or the other
projects named here.
