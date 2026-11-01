# Xcode Cloud, Codemagic and GitHub Actions

Hosted CI services build and test iOS apps on Macs they own. They are useful next to Tapdance, but
they are **not** Tapdance workers: you cannot join them to a gateway, and an agent cannot lease a
simulator on them (PRODUCT E-10). Their job in a Tapdance setup is to **produce the app** that a
Tapdance worker then installs and an agent drives.

Status: this is documentation only ([STATUS.md](../../STATUS.md), E-10). None of these flows has been
run end to end with Tapdance. The `asc` pass-through itself is verified for read-only commands
([evidence](../testing/evidence/2026-11-01-local-ios.md)).

## Who does what

| Need | Use |
| --- | --- |
| Build a simulator `.app` on every push | A CI service (GitHub Actions macOS runner, Codemagic, Xcode Cloud) or your Mac |
| Run your XCTest / XCUITest suite on a schedule | The CI service |
| Let an agent explore the app, reproduce a bug, take screenshots and recordings, watch it live | Tapdance with a Mac worker |
| Manage App Store Connect, TestFlight and Xcode Cloud workflows | The official `asc` CLI, through `tapdance asc -- ...` |
| Ship to the App Store | Your CI or `asc`/fastlane, under your authorization |

## What Tapdance needs from the build

An iOS **simulator** build: a `.app` directory built with `-sdk iphonesimulator`, for the worker's
architecture (arm64 on Apple Silicon). A signed device `.ipa` does not install on a simulator, and
Tapdance refuses it with `APP_PATH_INVALID`. Details in
[simulator-management.md](simulator-management.md#app-vs-ipa).

The `.app` must be on the machine where Tapdance runs (for example your Linux VPS). Tapdance uploads it
to the worker through Simlock and agent-device.

## GitHub Actions

GitHub's hosted macOS runners can build the simulator app and upload it as a workflow artifact. A
minimal job (adjust the scheme, project and Xcode selection to your project):

```yaml
jobs:
  simulator-build:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - name: Build for the iOS Simulator
        run: |
          xcodebuild build \
            -scheme MyApp \
            -sdk iphonesimulator \
            -configuration Debug \
            -derivedDataPath build
          tar -czf MyApp-simulator.tar.gz -C build/Build/Products/Debug-iphonesimulator MyApp.app
      - uses: actions/upload-artifact@v4
        with:
          name: MyApp-simulator
          path: MyApp-simulator.tar.gz
```

On the VPS, download the artifact (for example with `gh run download <run-id> -n MyApp-simulator`),
unpack it and install it on the leased simulator:

```sh
tar -xzf MyApp-simulator.tar.gz
tapdance app install ./MyApp.app
tapdance app launch com.example.MyApp
```

Packing the `.app` in a tarball keeps its file permissions and symlinks intact. GitHub's runner images,
Xcode versions and macOS minute rates change; check GitHub's documentation and billing pages.

## Codemagic

[Codemagic](https://codemagic.io/) runs builds on hosted Macs from a `codemagic.yaml`. Use the same
`xcodebuild build -sdk iphonesimulator ...` step, publish the tarred `.app` as a build artifact, and
download it to the VPS with Codemagic's artifact links or API. Codemagic has not been tried with
Tapdance; check its documentation for artifact download and pricing.

## Xcode Cloud

Xcode Cloud is Apple's CI. Apple Developer Program membership includes **25 compute hours per month**
(Apple's [Xcode Cloud page](https://developer.apple.com/xcode-cloud/), as read in November 2026; unused
hours do not roll over, and larger plans are sold as subscriptions).

Xcode Cloud workflows build, test, archive and distribute through TestFlight. Whether a given workflow's
artifacts include a simulator `.app` that Tapdance can install depends on its actions; this has not
been checked with Tapdance. List the artifacts of a run before you rely on it (see below). If no
simulator build is produced, use one of the other routes for the Tapdance build and keep Xcode Cloud for
tests and distribution.

### Driving Xcode Cloud with `asc`

Tapdance does not wrap App Store Connect itself. It forwards arguments, unchanged, to the official
[App Store Connect CLI `asc`](https://github.com/rorkai/App-Store-Connect-CLI) (MIT). `asc` has an
`xcode-cloud` command group. Discover it with its own help rather than relying on this page:

```sh
tapdance asc -- xcode-cloud --help
tapdance asc -- xcode-cloud workflows --app "<APP_ID>"
tapdance asc -- xcode-cloud build-runs --help
tapdance asc -- xcode-cloud artifacts list --run-id "<BUILD_RUN_ID>"
```

Recent `asc` versions also have `asc xcode-cloud artifacts download --id <ARTIFACT_ID> --path <file>`;
check that your installed version has it with `tapdance asc -- xcode-cloud artifacts --help`. Starting
a build (`asc xcode-cloud run ...`) changes state in App Store Connect.

From an agent over MCP, the same calls go through `execute_tool`:

```json
{ "tool": "asc", "args": ["xcode-cloud", "workflows", "--app", "<APP_ID>", "--output", "json"] }
```

How Tapdance guards `asc`:

- MCP calls run with `ASC_READ_ONLY=1`, `asc`'s own read-only switch, so `asc` refuses anything that
  writes to App Store Connect. Listing workflows, runs and artifacts still works.
- To let an agent trigger a run or change anything, the user must list `asc` in
  `tools.allowMutation` in `~/.tapdance/config.json`, **and** the agent must pass `allow_mutation: true`
  on that call.
- The read-only default applies to MCP calls. A person, or an agent with shell access, running
  `tapdance asc -- ...` directly is not put in read-only mode.
- `asc` runs on the control machine only (`--target control`). Running it on a remote worker is not
  built (STATUS E-04). Commands that build, archive or sign need Xcode and therefore a Mac.

### `asc` credentials

`asc` uses its own authentication (`asc auth ...`) with an App Store Connect API key. Tapdance never
stores, logs or returns those credentials, passes only `ASC_*` variables (plus a small base set) to the
`asc` process, and redacts PEM keys and tokens from captured output.

- Keep the `.p8` key outside any repository and readable only by your user. Never commit it.
- Give the API key the smallest App Store Connect role that does the job.
- Do not paste the key or its contents into an agent conversation.
- Do not put App Store Connect keys on a Mac worker that agents lease: an agent token there is close to
  shell access as the worker's user.

## Building on the Mac worker itself

You can also build on the worker Mac over SSH (`xcodebuild ... -sdk iphonesimulator`) and copy the
`.app` to the VPS. An agent on the VPS cannot run `xcodebuild` on the worker through Tapdance today:
external tools run only on the control machine (STATUS E-04).

## Apple licensing note

CI providers handle macOS licensing for their own service. If you build your own shared or
short-duration Mac service around Tapdance workers, review Apple's current macOS Software License
Agreement ([apple.com/legal/sla](https://www.apple.com/legal/sla/)) first.
