# Build in CI, test with Tapdance

Build the app in your CI, then let the agent install the result on a Tapdance device. The device host
never sees your source code or your build secrets.

> **Status:** `tapdance app install` has run on real Android emulators on macOS and on a Google Cloud N2
> VM, and installs from CI (`app install --from-ci`, MCP `install_app` `from_ci`) ran with the CLI and
> MCP on that VM ([evidence](../testing/evidence/2026-11-03-gcp-n2-android.md), [STATUS.md](../../STATUS.md) F-05).
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

The device's host can download the artifact itself, with its own read-only GitHub login, and install
the APK on the agent's Android lease. The APK never passes through the agent's machine, and the agent
needs no GitHub token. On the N2 VM a 77 MB APK took about 8 s to download the first time and 7–12 s
from the host's cache, against 149 s to upload it from a Mac.

On the host, once (off by default):

```bash
# a fine-grained token: Actions: Read-only and Contents: Read-only on the app's repository
read -rsp "GitHub token: " t && echo && printf '%s' "$t" | gh auth login --with-token; unset t
tapdance host artifacts enable --repo acme/app --branch main
tapdance host artifacts status --check
```

`enable` checks that `gh` can read the repository and list its Actions artifacts, and warns with the fix
when the token does not reach them (`--no-check` skips it); `status --check` does the same later.
`tapdance host artifacts disable --repo acme/app` takes one repository off the list.

On the agent's machine, with an Android lease:

```bash
tapdance app install --from-ci acme/app --artifact app-debug --launch com.acme.app
tapdance app install --from-ci acme/app --artifact app-debug --run 1234567890   # a given run
```

Without `--run` the host takes the newest successful run on `--branch` (default: the repository's
default branch) that has the artifact; forks' runs are never used. MCP: `install_app` with
`from_ci: {repo: "acme/app", artifact: "app-debug"}` (and `run` or `branch`), plus `launch:
"com.acme.app"` to relaunch it in the same call. The reply names the installed package (`appId`,
read by the host from the APK's manifest) and whether the host reused its earlier download (`cached`),
so an agent can call `launch_app` without `list_apps` first.

- **The token must select the repository whose workflow made the artifact.** A token for another
  repository (another repository of the same app, say) gets "GitHub answered 404" from Tapdance. An
  organization may also have to approve the token first.
- **Debug keys differ per CI run** unless you give CI a keystore. Installing a new run's APK over an
  earlier one then fails with `INSTALL_FAILED_UPDATE_INCOMPATIBLE`: `tapdance app uninstall <appId>`
  first, or sign debug builds in CI with one shared debug keystore. An older run's APK (a lower
  `versionCode`) fails with `INSTALL_FAILED_VERSION_DOWNGRADE`. Either way the hint names the package
  the host tried to install, in the reader's syntax: `uninstall_app {app_id: "com.acme.app"}` for an MCP
  agent, `tapdance app uninstall com.acme.app` in the CLI.
- The same token also serves [builds on the host](private-repositories.md#a-fine-grained-github-token),
  which helps when your organization has turned deploy keys off.

## iOS

A later phase (a simulator `.app` built on a macOS runner).

## The fix-and-retest loop

| Setup | Fastest loop |
| --- | --- |
| Android, and the agent's machine can build (a JDK and the Android SDK; no KVM needed) | `./gradlew assembleDebug` on the agent's machine, then `tapdance app install <apk>`. Installing again on the same lease replaces the app: no new lease, no new boot. |
| The agent's machine cannot build (iOS from Linux, no SDK) | Push the change to a branch of an allow-listed repository and run `tapdance app build --git <url> --ref <branch>`; the host rebuilds incrementally. This needs a host that builds that branch (with `--protected-ref main`, only merged commits build). See [builds on the host](../deployment/one-command-host.md#builds-on-the-host). |
| The final check before you merge or release | Build in CI, download, install, test: the binary you ship is the one you tested. |
