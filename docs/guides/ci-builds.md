# Build in CI, test with Tapdance

Build the app in your CI, then let the agent install the result on a Tapdance device. The host never
sees your source code or your build secrets. This page covers GitHub Actions in detail, and how
Codemagic and Xcode Cloud fit in.

> Proven: installing a built app on Android emulators (macOS and a Google Cloud N2 VM) and a simulator
> `.app` zip on a rented Mac from a Linux VPS; installs from CI on an Android lease of the N2 host,
> through the CLI and MCP ([evidence](../testing/evidence/2026-11-03-gcp-n2-android.md),
> [rented Mac](../testing/evidence/2026-11-07-vps-rented-mac-ios.md)). Unit-tested only: iOS installs
> from CI. Not run: the example workflows on this page, Codemagic and Xcode Cloud with Tapdance. The
> `asc` pass-through is verified for read-only commands
> ([evidence](../testing/evidence/2026-11-01-local-ios.md)).

## What you get

- **Private code stays in CI.** The host gets an APK or a simulator `.app`, not a clone of the
  repository.
- **Secrets stay in CI.** `google-services.json`, API keys and signing keys live in your CI's secret
  store, not in [build files](private-repositories.md#build-files) on a host.
- **The binary you test is the one CI made.** No difference between "it built on the host" and "it
  built in CI".

Hosted device services work the same way: BrowserStack, Sauce Labs, Firebase Test Lab, AWS Device Farm
and Appetize all take an app you have already built.

Hosted CI services (GitHub Actions macOS runners, Codemagic, Xcode Cloud) are **not** Tapdance hosts:
an agent cannot lease a simulator on them. Their job here is to produce the app.

## What you need

- A Tapdance setup with a lease: local, or a host connected with
  [`tapdance connect`](../deployment/one-command-host.md).
- A CI workflow that uploads the app as an artifact: a debug APK for Android, or a **simulator** build
  for iOS (a `.app` built with `-sdk iphonesimulator`). A signed device `.ipa` does not install on a
  simulator ([.app vs .ipa](../ios/simulator-management.md#app-vs-ipa)).
- To download the artifact: the [GitHub CLI](https://cli.github.com/) logged in on the agent's
  machine, or on the host (see [let the host fetch the artifact](#let-the-host-fetch-the-artifact)).

## Steps

1. **Add a workflow** that builds the app and uploads it. Examples:
   [Android](#a-github-actions-workflow-for-an-android-debug-apk),
   [iOS simulator](#a-github-actions-workflow-for-an-ios-simulator-app).
2. **Download the artifact on the agent's machine:**

   ```bash
   gh run list -R acme/app -w android-debug-apk -L 5
   gh run download <run-id> -R acme/app -n app-debug -D app-debug
   ```

   `gh run list` shows the latest runs and their ids. `gh run download -n` unpacks the artifact into
   the `-D` folder, so the APK keeps the name Gradle gave it. The GitHub account (or a fine-grained
   token with *Actions: Read-only* on that repository) must be able to read the run's artifacts.

3. **Install and launch it on a lease:**

   ```bash
   tapdance device lease --platform android
   tapdance app install app-debug/app-debug.apk
   tapdance app launch com.acme.app
   ```

   An agent can run these commands itself, or you hand it the path.

With a remote host you can skip steps 2 and 3: the host downloads and installs the artifact itself.
See [let the host fetch the artifact](#let-the-host-fetch-the-artifact).

## Check it worked

`tapdance app install` prints the installed package (`appId`). `tapdance app launch <appId>` starts it,
and `tapdance screenshot` shows it running.

## If it fails

- `INSTALL_FAILED_UPDATE_INCOMPATIBLE`: the app on the device was signed with another key. CI runners
  often make a new debug key per run. Run `tapdance app uninstall <appId>` first, or sign debug builds
  in CI with one shared debug keystore.
- `INSTALL_FAILED_VERSION_DOWNGRADE`: the installed app has a higher `versionCode`. Uninstall it
  first.
- "GitHub answered 404": a wrong run id or artifact name, or the token cannot read that repository.
- More: [troubleshooting](../troubleshooting.md#installs-from-ci).

## A GitHub Actions workflow for an Android debug APK

Save as `.github/workflows/android-debug-apk.yml`. Store the content of `google-services.json` as a
repository secret named `GOOGLE_SERVICES_JSON` (drop that step if the app has none). Check each
action's page for its current major version.

```yaml
name: android-debug-apk

on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5

      - uses: actions/setup-java@v5
        with:
          distribution: temurin
          java-version: "17"
          cache: gradle

      - name: Write google-services.json
        env:
          GOOGLE_SERVICES_JSON: ${{ secrets.GOOGLE_SERVICES_JSON }}
        run: printf '%s' "$GOOGLE_SERVICES_JSON" > app/google-services.json

      - name: Build the debug APK
        run: ./gradlew assembleDebug

      - uses: actions/upload-artifact@v5
        with:
          name: app-debug
          path: app/build/outputs/apk/debug/*.apk
          if-no-files-found: error
          retention-days: 7
```

- Change `app/` to your app module's folder.
- The fixed artifact name (`app-debug`) is what lets the next step find it.
- Pull requests from forks get no secrets; the `google-services.json` step then writes an empty file.
- Upload only the APK. Whoever can download the artifact gets everything in it.

## A GitHub Actions workflow for an iOS simulator app

GitHub's hosted macOS runners can build the simulator app. A minimal job (adjust the scheme, project
and Xcode selection to your project):

```yaml
jobs:
  simulator-build:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v5
      - name: Build for the iOS Simulator
        run: |
          xcodebuild build \
            -scheme MyApp \
            -sdk iphonesimulator \
            -configuration Debug \
            -derivedDataPath build
          ditto -c -k --keepParent build/Build/Products/Debug-iphonesimulator/MyApp.app MyApp.zip
      - uses: actions/upload-artifact@v5
        with:
          name: MyApp-simulator
          path: MyApp.zip
```

`ditto` keeps the `.app`'s file modes, which `actions/upload-artifact` would otherwise drop. Download
and install it on a leased simulator:

```bash
gh run download <run-id> -R acme/app -n MyApp-simulator -D MyApp-simulator
tapdance device lease --platform ios
tapdance app install MyApp-simulator/MyApp.zip
tapdance app launch com.example.MyApp
```

`tapdance app install` takes a simulator `.app`, or a `.zip` or `.tar` holding one, and uploads it to
the host. GitHub's runner images, Xcode versions and macOS minute rates change; check GitHub's
documentation and billing pages.

## Let the host fetch the artifact

The host can download the artifact itself, with its own read-only GitHub login, and install it on the
agent's lease. The app never passes through the agent's machine, and the agent needs no GitHub token.
On the N2 VM a 77 MB APK took about 8 s to download the first time and 7–12 s from the host's cache,
against 149 s to upload it from a Mac.

On the host, once (off by default). Use a fine-grained token with *Actions: Read-only* and
*Contents: Read-only* on the app's repository:

```bash
tapdance host gh-login
tapdance host artifacts enable --repo acme/app --branch main
tapdance host artifacts status --check
```

`host gh-login` reads the token with echo off and passes it to `gh auth login`. `enable` checks that
`gh` can read the repository and list its Actions artifacts, and warns with the fix when the token does
not reach them (`--no-check` skips it); `status --check` does the same later.
`tapdance host artifacts disable --repo acme/app` takes one repository off the list.

On the agent's machine, with an Android or iOS lease:

```bash
tapdance app install --from-ci acme/app --artifact app-debug --launch com.acme.app
tapdance app install --from-ci acme/app --artifact app-debug --run 1234567890
```

Without `--run` the host takes the newest successful run on `--branch` (default: the repository's
default branch) that has the artifact; forks' runs are never used.

MCP: `install_app` with `from_ci: {repo: "acme/app", artifact: "app-debug"}` (and `run` or `branch`),
plus `launch: "com.acme.app"` to relaunch it in the same call. The reply names the installed package
(`appId`, read by the host from the app) and whether the host reused its earlier download (`cached`),
so an agent can call `launch_app` without `list_apps` first.

- **The token must select the repository whose workflow made the artifact.** A token for another
  repository (another repository of the same app, say) gets "GitHub answered 404" from Tapdance. An
  organization may also have to approve the token first.
- **Debug keys differ per CI run** unless you give CI a keystore. Installing a new run's APK over an
  earlier one then fails with `INSTALL_FAILED_UPDATE_INCOMPATIBLE`, and an older run's APK (a lower
  `versionCode`) with `INSTALL_FAILED_VERSION_DOWNGRADE`. Either way the hint names the package the
  host tried to install, in the reader's syntax: `uninstall_app {app_id: "com.acme.app"}` for an MCP
  agent, `tapdance app uninstall com.acme.app` in the CLI.
- The same token also serves [host builds](private-repositories.md#a-fine-grained-github-token), which
  helps when your organization has turned deploy keys off.

### iOS installs from CI

Unit-tested only: not yet run on a Mac host.

The artifact must hold a **simulator** build: the `.app` folder
(`build/Build/Products/Debug-iphonesimulator/<App>.app` after `xcodebuild -sdk iphonesimulator
-derivedDataPath build …`), or a zip of it (`ditto -c -k --keepParent <App>.app app.zip`). The host
unpacks it and gives Mach-O files their execute bit back (`actions/upload-artifact` drops file modes).
It checks with `plutil` that `CFBundleSupportedPlatforms` says `iPhoneSimulator`, installs it with
`simctl install`, and names its bundle id. An `.ipa` or a device build is refused.

## Codemagic

[Codemagic](https://codemagic.io/) runs builds on hosted Macs from a `codemagic.yaml`. Use the same
`xcodebuild build -sdk iphonesimulator …` step, publish the zipped `.app` as a build artifact, and
download it to the agent's machine with Codemagic's artifact links or API. Codemagic has not been tried
with Tapdance; check its documentation for artifact download and pricing.

## Xcode Cloud

Xcode Cloud is Apple's CI. Apple Developer Program membership includes **25 compute hours per month**
(Apple's [Xcode Cloud page](https://developer.apple.com/xcode-cloud/), as read in November 2026; unused
hours do not roll over, and larger plans are sold as subscriptions).

Xcode Cloud workflows build, test, archive and distribute through TestFlight. Whether a given
workflow's artifacts include a simulator `.app` that Tapdance can install depends on its actions; this
has not been checked with Tapdance. List the artifacts of a run before you rely on it (below). If no
simulator build is produced, use another route for the Tapdance build and keep Xcode Cloud for tests
and distribution.

### Drive Xcode Cloud with `asc`

Tapdance does not wrap App Store Connect itself. It forwards arguments, unchanged, to the official
[App Store Connect CLI `asc`](https://github.com/rorkai/App-Store-Connect-CLI) (MIT). `asc` has an
`xcode-cloud` command group. Discover it with its own help rather than relying on this page:

```bash
tapdance asc -- xcode-cloud --help
tapdance asc -- xcode-cloud workflows --app "<APP_ID>"
tapdance asc -- xcode-cloud build-runs --help
tapdance asc -- xcode-cloud artifacts list --run-id "<BUILD_RUN_ID>"
```

Recent `asc` versions also have `asc xcode-cloud artifacts download --id <ARTIFACT_ID> --path <file>`;
check that your installed version has it with `tapdance asc -- xcode-cloud artifacts --help`. Starting
a build (`asc xcode-cloud run …`) changes state in App Store Connect.

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
  `tapdance asc -- …` directly is not put in read-only mode.
- `asc` runs on the agent's machine only (`--target control`). Running it on a host is not built.
  Commands that build, archive or sign need Xcode and therefore a Mac.

More: [external tools](../tools.md).

### `asc` credentials

`asc` uses its own authentication (`asc auth …`) with an App Store Connect API key. Tapdance never
stores, logs or returns those credentials, passes only `ASC_*` variables (plus a small base set) to the
`asc` process, and redacts PEM keys and tokens from captured output.

- Keep the `.p8` key outside any repository and readable only by your user. Never commit it.
- Give the API key the smallest App Store Connect role that does the job.
- Do not paste the key or its contents into an agent conversation.
- Do not put App Store Connect keys on a host that agents lease from: installing an iOS app there runs
  code as the hosting account.

## Who does what

| Need | Use |
| --- | --- |
| Build a simulator `.app` or an APK on every push | A CI service (GitHub Actions, Codemagic, Xcode Cloud) or your own machine |
| Run your XCTest / XCUITest suite on a schedule | The CI service |
| Let an agent explore the app, reproduce a bug, take screenshots and recordings, watch it live | Tapdance with a host |
| Manage App Store Connect, TestFlight and Xcode Cloud workflows | The official `asc` CLI, through `tapdance asc -- …` |
| Ship to the App Store | Your CI or `asc`/fastlane, under your authorization |

## Building on the host itself

An agent cannot run its own `xcodebuild` on a host: external tools run only on the agent's machine.
What it can do is a host build: once the host's owner allows the repository
(`tapdance host builds enable --repo …`), `tapdance app build --git <url>` (MCP `build_app`) clones and
builds it on the host and installs it on the lease. Run on a rented Mac mini from a Linux VPS
([evidence](../testing/evidence/2026-11-07-vps-rented-mac-ios.md)). See [host builds](host-builds.md).

You can also build on a Mac host yourself over ssh (`xcodebuild … -sdk iphonesimulator`) and copy the
`.app` to the agent's machine.

## The fix-and-retest loop

- **Android, and the agent's machine can build** (a JDK and the Android SDK; no KVM needed):
  `./gradlew assembleDebug` on the agent's machine, then `tapdance app install <apk>`. Installing again
  on the same lease replaces the app: no new lease, no new boot.
- **The agent's machine cannot build** (iOS from Linux, no SDK): push the change to a branch of an
  allowed repository and run `tapdance app build --git <url> --ref <branch>`. The host rebuilds
  incrementally. This needs a host that builds that branch (with `--protected-ref main`, only merged
  commits build). See [host builds](host-builds.md).
- **The final check before you merge or release:** build in CI, download, install, test. The binary
  you ship is the one you tested.

## Apple licensing note

CI providers handle macOS licensing for their own service. If you build your own shared or
short-duration Mac service around Tapdance hosts, review Apple's current macOS Software License
Agreement ([apple.com/legal/sla](https://www.apple.com/legal/sla/)) first.
