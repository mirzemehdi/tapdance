# Host builds

An agent on a machine without Xcode (a Linux VPS, say) cannot build an iOS simulator app. The host can
build it: the agent names a git repository and a ref, the host fetches and builds it, and installs the
result on the agent's lease. The same works for Android with Gradle. Words like **host** and **lease**
are in the [glossary](../glossary.md).

> Proven: iOS builds on the owner's Mac and on a rented Mac mini from a Mac and from a Linux VPS, reused
> across the CLI and MCP ([evidence](../testing/evidence/2026-11-06-rented-mac-ios.md),
> [VPS](../testing/evidence/2026-11-07-vps-rented-mac-ios.md)); Android builds of a private repository on
> a Google Cloud N2 VM, through the CLI and MCP `build_app`
> ([evidence](../testing/evidence/2026-11-03-gcp-n2-android.md)). Unit-tested only: the Gradle daemon
> idle timeout and build files.

## What you get

- The agent runs `tapdance app build --git <url> --ref <branch>` (MCP `build_app`) and gets the app
  installed on its lease, built on the host.
- The host builds only repositories its owner allowed, and with `--protected-ref`, only reviewed
  commits.
- Credentials for private repositories stay on the host. The agent never sees them.
- Rebuilds are incremental, and a build of the same commit is reused in seconds.

Builds are **off by default**. A build runs the repository's own scripts on the host, so read
[trust](#trust) before you turn them on.

## What you need

- A host set up with [`tapdance host up`](../deployment/one-command-host.md), and an agent's machine
  connected to it.
- On the host, the tools the app's build needs: git; Xcode for iOS; a JDK and the Android SDK
  components the app uses for Android (Gradle does not download every SDK component). A Kotlin
  Multiplatform app also needs a JDK for its iOS build, on the `PATH` or in `JAVA_HOME` of the
  guard (the Tapdance service on the host that runs the builds). `host-setup.sh` sets this up.
  `host builds enable` checks git, Xcode, Java and `gh`.
- For a private repository, a way for the host to read it: see
  [private repositories](private-repositories.md).
- A standard (non-admin) account on the host. `host builds enable` refuses an administrator account
  without `--allow-admin-account`.

## Steps

1. **On the host, allow the repository.** Once per repository:

   ```bash
   tapdance host builds enable --repo https://github.com/acme/app --git-auth gh --protected-ref main
   ```

   `--git-auth gh` uses the host's `gh` login for a private repository; leave it out for a public one.
   `--protected-ref main` builds only commits already on `main` of the remote. The command checks that
   the host can read the repository (`git ls-remote`) and warns with the fix when it cannot.

2. **On the agent's machine, with a lease, build and launch:**

   ```bash
   tapdance device lease --platform ios
   tapdance app build --git https://github.com/acme/app --ref main --launch com.acme.app
   ```

   Use the same URL form the owner allowed: `https://` and ssh URLs of one repository are separate
   entries on the allow-list.

3. **Change, push, rebuild.** Push the change to a branch the host builds, and run `app build` again.
   With `--protected-ref main`, only merged commits build.

## Check it worked

The CLI shows the build's steps, errors and the outcome (`--verbose` shows every line). The reply names
the exact commit built, the installed app, and `reused: true` or `false`. On the host:

```bash
tapdance host builds status
```

It shows whether builds are on, the allowed repositories (with their deploy key and build files) and
the build cache. `tapdance host builds status --check` tries each repository with its auth again.

## If it fails

- `AUTH_FAILED` with git's own line (for example `Permission denied (publickey)`): the host cannot
  sign in to the repository. Only the host's owner can fix it; see
  [when a build cannot sign in](private-repositories.md#when-a-build-cannot-sign-in).
- `FORBIDDEN` "… is not on this host's build allow-list": the owner allows that exact URL with
  `host builds enable --repo <url>`.
- More: [troubleshooting](../troubleshooting.md#builds-on-the-host).

## How builds work

**Source: git only.** The host clones the repository once into `~/.tapdance/worker/builds/<repo>/`
and fetches only what changed on later builds. DerivedData and the Gradle caches stay there, so
rebuilds are incremental. `host builds status` shows the cache path.

Uploading the agent's working tree, or building from a folder already on the host, is not planned: the
code the host builds is always a commit it can name. Push the change to a branch on an allowed
repository instead (with protected refs, merge it first).

**Access.** Credentials stay on the host.

- `--git-auth gh` uses the host's `gh auth`.
- A read-only deploy key from `tapdance host builds key --repo <url>` (add its public half to the
  repository; use ssh URLs) is used for that repository's ssh URL whenever it exists.
- `--git-auth none` is for public repositories.

`host builds enable` checks that the host can read each repository with that auth (`git ls-remote`)
and warns with the fix when it cannot, for example when GitHub refuses the deploy key. `--no-check`
skips the check. A build that cannot sign in fails with `AUTH_FAILED` and git's own line, and the hint
says what to check for the key or `gh` login that was used. Step by step:
[private repositories](private-repositories.md).

**Which code.** Only repositories on the allow-list. With `--protected-ref main` the host builds only
commits already on `main` of the remote, so a compromised agent with push rights cannot get an
unreviewed branch built. The reply and the audit log name the exact commit.

**iOS.** The host runs `xcodebuild -sdk iphonesimulator -destination 'generic/platform=iOS Simulator'`.

- It signs ad hoc like Xcode's Run (`CODE_SIGN_IDENTITY=-`, no team needed), so the app keeps its
  entitlements and Keychain works.
- It builds only this Mac's simulator architecture (`ARCHS=arm64 ONLY_ACTIVE_ARCH=YES` on Apple
  silicon, as Xcode's Run does). Kotlin Multiplatform apps usually declare only `iosSimulatorArm64`.
- `--project` and `--scheme` pick the Xcode project when the repository has more than one;
  `--configuration` picks the build configuration (default `Debug`).
- `--xcode-setting KEY=VALUE` passes a build setting from a short list: `ARCHS`, `EXCLUDED_ARCHS`,
  `ONLY_ACTIVE_ARCH`, `SWIFT_ACTIVE_COMPILATION_CONDITIONS`, `GCC_PREPROCESSOR_DEFINITIONS`,
  optimization and debug-info levels, `IPHONEOS_DEPLOYMENT_TARGET`, `KOTLIN_FRAMEWORK_BUILD_TYPE`,
  bundle id and version numbers. Settings that name tools or paths are refused, because they would run
  code nobody reviewed.
- Kotlin Multiplatform apps call Gradle from a run-script phase, so the host needs a JDK on the guard's
  `PATH` or `JAVA_HOME`. On an iOS-only Mac whose app's Gradle needs an Android SDK, set the host up
  with `host-setup.sh --ios-only --android-build-sdk`.

**Android.** The host runs `./gradlew assembleDebug` (`--gradle-task` for another task, `--dir` for the
folder with `gradlew`). The newest APK under `build/outputs/apk` is installed, and the reply names its
package (`appId`).

**Gradle daemons.** A host build lets its Gradle and Kotlin daemons go after 10 idle minutes
(`-Dorg.gradle.daemon.idletimeout`, and `autoshutdownIdleSeconds` for Kotlin's), instead of Gradle's 3
hours. On a 16 GB cloud VM they held about 8 GB next to the emulator after a build (#90).

A short idle timeout rather than stopping them after every build: an agent that rebuilds within
minutes keeps a warm daemon, and nothing stops the daemons of your own builds on the same account
(`gradlew --stop` would, and it leaves Kotlin's daemon running). `host builds enable
--gradle-idle-minutes <n>` changes it. `0` builds with `--no-daemon` and compiles Kotlin inside that
one Gradle process, for hosts with little memory to spare. Unit-tested only.

**Reuse.** The last builds are kept per commit and settings (the newest three per repository, under
`kept/` in the build cache). Asking for the same commit and settings again installs that build in
seconds (`Reused the earlier build …`). Every lease is a fresh device, so this is the common case. The
reply always says `reused: true` or `false` (with `builtAt` for a reused build), so an agent knows
whether it is testing a fresh build.

**Offline host.** When the host cannot reach the git server, a full commit id it already has still
builds from its cache, with a warning. A branch name does not (the cached branch may be behind). The
error names git's own `fatal:` line and says the host's network is at fault.

**Limits.** One build at a time. The longest build is 45 minutes by default; the owner changes it with
`host builds enable --timeout-minutes <n>`. The build log streams to the agent with secrets redacted. A
failed build's error names its cause: compiler errors, Gradle's "What went wrong" and the failed build
commands.

**Policy reload.** The guard reads the build policy when it starts. `host builds enable` and
`disable` restart it when no lease is running, and say so otherwise.

## Trust

A build runs the repository's own scripts (Xcode run-script phases, Gradle) on the host as the hosting
account: code execution by design.

- Allow only repositories you trust.
- Prefer protected refs, so only reviewed commits build.
- Host from a dedicated standard account.
- A token without the `builds` scope cannot build.

Whatever the host keeps (a token, deploy keys, build files), every build can read. See the
[threat model](../security/threat-model.md) and
[if the host is compromised](private-repositories.md#if-the-host-is-compromised).

## Private repositories, build files and undo

Three ways to give the host access, from most to least access on the host. Each is described step by
step, with what a compromised host would give away, in [private repositories](private-repositories.md).

| Way | Covers |
| --- | --- |
| A fine-grained, read-only GitHub token (recommended on a cloud VM) | The repositories you select, and GitHub submodules among them |
| A deploy key per repository | That one repository. Organizations can turn deploy keys off; then use the token |
| No repository access: build in CI or on the agent's machine, then `tapdance app install` | Nothing on the host. See [build in CI](ci-builds.md) |

Commands on the host for the token way:

```bash
tapdance host gh-login
tapdance host builds enable --repo https://github.com/acme/app --git-auth gh
```

For the deploy-key way:

```bash
tapdance host builds key --repo git@github.com:acme/app.git
tapdance host builds enable --repo git@github.com:acme/app.git
```

Add the printed public key to the repository, read-only, between the two commands.

Files a repository keeps out of git (`google-services.json`, `local.properties`, `.env`) can be added
on the host as **build files**:

```bash
tapdance host builds files add --repo https://github.com/acme/app androidApp/google-services.json --from ./google-services.json
```

`list` and `remove` manage them. Only the owner can add or read them; agents cannot. They are copied
into the checkout for the build and removed after it, at most 1 MB each and 50 per repository. Details:
[build files](private-repositories.md#build-files). Credentials for a private Gradle registry go in the
hosting account's `~/.gradle/gradle.properties`.

To undo:

- `tapdance host builds disable --repo <url>` removes one URL from the allow-list (the ssh and https
  URLs are separate entries) and leaves builds on. Without `--repo` it turns builds off and keeps the
  allow-list.
- `tapdance host builds key --repo <url> --remove` deletes that repository's key and prints its
  fingerprint, so you can delete it on GitHub too.

## Run on a real repository

On the owner's Mac, an iOS build of the owner's app (Pianolune) passed through the guard in 36 s
([evidence](../testing/evidence/2026-11-03-selftest-through-guard.md)). On a rented Mac mini its iOS
build ran from a Mac and from a Linux VPS
([evidence](../testing/evidence/2026-11-06-rented-mac-ios.md),
[VPS](../testing/evidence/2026-11-07-vps-rented-mac-ios.md)). On a Google Cloud N2 VM, the Android build
of its private repository succeeded (Gradle 2 min 40 s, a reused build reinstalled in 11 s) through the
CLI and MCP `build_app` ([evidence](../testing/evidence/2026-11-03-gcp-n2-android.md)). The steps are
also unit-tested with a fake git, Xcode and Gradle.
