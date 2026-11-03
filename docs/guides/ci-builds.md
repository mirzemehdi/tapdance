# Build in CI, test with Tapdance

Build the app in your CI, then let the agent install the result on a Tapdance device. The device host
never sees your source code or your build secrets.

> **Status:** installing an APK with `tapdance app install` has run on a real Android emulator on macOS;
> Android on a Linux host (such as an N2 VM) has not run yet ([STATUS.md](../../STATUS.md), D-01, D-02).
> The workflow on this page is an example: it has not been run as part of Tapdance's own tests.

## Why

- **Private code stays in CI.** The host gets an APK, not a clone of the repository.
- **Secrets stay in CI.** `google-services.json`, API keys and signing keys live in your CI's secret
  store, not in [build files](private-repositories.md#build-files) on a host.
- **The binary you test is the one CI made.** No difference between "it built on the host" and "it
  built in CI".

Hosted device services work the same way: BrowserStack, Sauce Labs, Firebase Test Lab, AWS Device Farm
and Appetize all take an app you have already built.

## A GitHub Actions workflow for an Android debug APK

Save as `.github/workflows/android-debug-apk.yml`. Store the content of `google-services.json` as a
repository secret named `GOOGLE_SERVICES_JSON` (drop that step if the app has none). Check each action's
page for its current major version.

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

## Install it on a device (works today)

On the agent's machine, with the [GitHub CLI](https://cli.github.com/) logged in to an account (or a
fine-grained token with *Actions: Read-only* on that repository) that can read the run's artifacts:

```bash
gh run list -R acme/app -w android-debug-apk -L 5          # the latest runs and their ids
gh run download <run-id> -R acme/app -n app-debug -D app-debug

tapdance device lease --platform android
tapdance app install app-debug/app-debug.apk
tapdance app launch com.acme.app
```

`gh run download -n` unpacks the artifact into the `-D` folder, so the APK keeps the name Gradle gave
it. An agent can run these commands itself, or you hand it the path.

## Let the host fetch the artifact

(being added: `app install --from-ci`)

## iOS

A later phase (a simulator `.app` built on a macOS runner).

## The fix-and-retest loop

| Setup | Fastest loop |
| --- | --- |
| Android, and the agent's machine can build (a JDK and the Android SDK; no KVM needed) | `./gradlew assembleDebug` on the agent's machine, then `tapdance app install <apk>`. Installing again on the same lease replaces the app: no new lease, no new boot. |
| The agent's machine cannot build (iOS from Linux, no SDK) | Push the change to a branch of an allow-listed repository and run `tapdance app build --git <url> --ref <branch>`; the host rebuilds incrementally. This needs a host that builds that branch (with `--protected-ref main`, only merged commits build). See [builds on the host](../deployment/one-command-host.md#builds-on-the-host). |
| The final check before you merge or release | Build in CI, download, install, test: the binary you ship is the one you tested. |
