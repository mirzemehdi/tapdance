# One-command host: agent on one machine, devices on a Mac or Linux host

Your coding agent runs on a VPS, a laptop or any other machine. A Mac, or a Linux machine with KVM
(including a cloud VM with nested virtualization), runs the emulators and simulators. Two commands
connect them:

```bash
# on the host (Mac or Linux), in a terminal on it
tapdance host up

# on the agent's machine, with the token file the first command wrote
tapdance connect https://<host>.<tailnet>.ts.net:4720 < pairing-<label>.token
```

`host up` sets the machine up in **device-only mode** ([security/personal-mac.md](../security/personal-mac.md)):
the agent reaches it only through the worker guard, never through Simlock directly, and nothing is
opened to the public internet. This is the recommended way to host devices for an agent on another
machine. For a cloud host, follow [Google Cloud N2](google-cloud-n2.md).

> **Status: run on the owner's Mac and on a fresh Linux VM.** `host up` ran on the owner's Mac (Node.js
> and Android Studio already installed), and an agent on a Linux VPS tested a real app through it over
> Tailscale, Android and iOS, with the CLI
> ([field runs](../testing/evidence/2026-11-02-vps-field-runs.md),
> [self-test through the guard](../testing/evidence/2026-11-03-selftest-through-guard.md)).
> `scripts/host-setup.sh` and `host up` ran end to end on a fresh Google Cloud N2 VM (Ubuntu 24.04),
> including the Linux-only steps, and a Mac drove it with `connect`
> ([evidence](../testing/evidence/2026-11-03-gcp-n2-android.md)). Not yet run: a fresh Mac, `host pause`,
> `host resume` and `host down --all` (unit-tested only). See [STATUS.md](../../STATUS.md) (W-07) and
> please report what you find with `tapdance report`.

## What `host up` does

Each step prints its name. If one fails, it prints the step, the command it ran, the end of that
command's output and a fix, and exits non-zero. Running it again is safe.

| Step | What happens |
| --- | --- |
| 1. prerequisites | The checks from `tapdance worker check` (Node.js 22.13+, Android SDK with command-line tools, platform-tools, emulator, a system image, KVM on Linux; Xcode and an iOS runtime on macOS), plus a JDK check. On Linux it also reads the DMI vendor strings: a cloud VM without `/dev/kvm` is reported as unable to host Android emulators (nested virtualization is off). It **installs nothing**: if neither Android nor iOS is usable it stops and prints the install commands, with Homebrew lines on macOS. |
| 2. account | The guard's own refusals: not as root, not while this worker has joined a gateway, and not from a macOS administrator account unless you pass `--allow-admin-account`. On an admin account it stops, explains the risk, and prints the exact command to run again. Nothing has changed at this point. |
| 3. worker | Same as `tapdance worker install --service`: the bundled Simlock worker on loopback, agent-device, streaming and input on, restarted, and Simlock's login service installed. On Linux with no display (`DISPLAY` and `WAYLAND_DISPLAY` unset, as over SSH) it also sets `android.emulator.headless`, so emulators boot without a window, and `android.emulator.gpu` to `swiftshader_indirect` (with the emulator's `auto`, an N2 VM without a GPU idled at 136–165 % CPU and screen-changing taps took 3.4–7.9 s; with `swiftshader_indirect`, about 0 % and 2.2–2.6 s). On a re-run, when the worker answers and the guard service is running, it is left alone, because a restart would end the sessions of an agent using this host. |
| 4. guard service | Same as `tapdance worker guard install`: a LaunchAgent (macOS) or systemd user unit (Linux) that runs `worker guard start` at login and restarts it; then it waits until the guard answers on `127.0.0.1:4720`. A running service with an unchanged file is left alone (a restart keeps lease ownership, which the guard saves, but drops in-flight uploads). It refuses while a `worker guard start` in a terminal holds the port. On Linux it also turns on **linger** for your user (`loginctl enable-linger`), waits for the user manager's bus and points `systemctl --user` at it (over a non-interactive SSH session there is none otherwise: "Failed to connect to bus: No medium found"), so the worker and guard keep running after you log out and start at boot; if linger is refused it prints the `sudo` command. Accounts logind cannot look up (Google Cloud OS Login) cannot linger; for them `host-setup.sh` installs `tapdance-user-manager.service`, which starts the user manager at boot, and `host up` starts it. |
| 5. pairing | Issues a guard token labelled with `--label`, after you confirm at the terminal (`--yes` skips the prompt; without a terminal it needs `--yes`, and that is checked before step 1 changes anything). Without `--label` it keeps the host's only active pairing (so `host up --idle-stop 10` on a paired host changes the cost guard and pairs no one new); with no pairing yet the label is the hostname, and with several it asks you to pass `--label`. The token is written to `~/.tapdance/worker/pairing-<label>.token` with mode 600 and is **never printed**. If a valid token file for that label exists, it is kept; `--repair` revokes it and issues a new one. Tokens expire after `limits.tokenDays` (7 days by default); after that, `host up` issues a new one. |
| 6. tailscale | If `tailscale` is installed and logged in, it exposes the guard on this machine's MagicDNS name. With HTTPS certificates on the tailnet (`CertDomains` in `tailscale status --json`) it runs `tailscale serve --bg --https=4720 http://127.0.0.1:4720` and the endpoint is `https://…`; without them (the default on many tailnets) it runs `tailscale serve --bg --http=4720 …` and the endpoint is `http://<mac>.<tailnet>.ts.net:4720`, which travels inside the tailnet's WireGuard encryption and which `connect` accepts. Otherwise (or with `--no-tailscale`) it prints what to do and the endpoint stays `http://127.0.0.1:4720`, which only this machine can use. `host status` shows which mode is served; `host down` turns off either. On Linux, when `tailscale serve` is refused ("Access denied"), it stops and names the fix: `sudo tailscale set --operator=$USER` once. |
| 7. self-test | Through the guard, with the new token: lists the devices, leases an Android device (iOS if there is no Android), takes a screenshot and releases it. `--skip-self-test` keeps only the device list. The first boot of a device can take minutes, and the lease waits (up to 5 minutes) while an agent holds the guard's only session (`limits.maxSessions` is 1 by default). |
| 8. summary | Prints the block below. |

```text
TAPDANCE HOST READY
endpoint:  https://my-mac.tail1234.ts.net:4720
token:     saved to /Users/me/.tapdance/worker/pairing-my-mac.token (mode 600), fingerprint 3fa9c2. Copy it: tapdance host token --label my-mac
devices:   android 34 (google_apis_playstore), ios 26.5
self-test: PASS (android lease, screenshot ok)
on the agent machine:  tapdance connect https://my-mac.tail1234.ts.net:4720 < pairing-my-mac.token
```

Copy the token file to the agent's machine over a private channel (`scp`, your password manager), not
through chat or a repository. `tapdance host token` copies it to the clipboard (`--show` prints it
once), and `connect` prints the same fingerprint so you can compare. On Linux without a display (a
server over ssh) `host up` does not offer the clipboard; it names the token file and `host token --show`.

### Options

| Option | Meaning |
| --- | --- |
| `--label <name>` | Name of the pairing, shown in `tapdance worker guard tokens`. Default: the host's only active pairing, else the hostname. A new name pairs another control machine. |
| `--allow-admin-account` | Run the guard from a macOS administrator account. Not recommended; see below. |
| `--no-tailscale` | Leave `tailscale serve` alone; the endpoint stays on loopback. |
| `--keep-awake` | macOS: run the guard under `caffeinate -i` (see [Keep the guard running](../security/personal-mac.md#keep-the-guard-running)). |
| `--repair` | Revoke the pairing with this label and issue a new token. |
| `--skip-self-test` | Do not lease a device at the end. |
| `--idle-stop <minutes\|off>` | Linux cloud VMs: power the machine off after this many minutes with no lease, guard request or build. 30 by default on a detected cloud VM, off elsewhere; refused on macOS. Needs a sudoers rule for `systemctl poweroff`, which `host up` prints when it is missing. See [cost guardrails](google-cloud-n2.md#cost-guardrails). On a short-lived test VM that Terraform deletes at a time limit, pass `off`: an idle poweroff would stop the VM instead and leave its disk billing ([field test](../testing/field-test-cloud-android.md)). |
| `--max-uptime <hours\|off>` | Linux cloud VMs: after this many hours up, take no new leases and power off when the last one ends. Off by default; refused on macOS. |
| `-y, --yes` | Approve the pairing without a prompt. You are the owner, at this machine. |

### The administrator question

The guard limits what a remote agent can ask for, but a bug in the Simulator, the emulator or the
guard itself would run with the rights of the account that runs it, and an administrator account can
become root. The recommended setup is a dedicated standard account
(`infrastructure/scripts/macos-create-worker-account.sh`, **untested**): log in as it and run
`tapdance host up` there. `host up` never falls back to an administrator account on its own; it stops
and tells you to either switch accounts or run it again with `--allow-admin-account`.

## On the agent's machine: `tapdance connect`

```bash
tapdance connect https://my-mac.tail1234.ts.net:4720 < pairing-my-mac.token
```

1. Checks that the address answers (two tries, 15 s each) before saving anything. An `http://` address
   the guard no longer serves (it switched to `https://` after HTTPS Certificates were turned on) fails
   with the `https://` command to run instead.
2. Reads the token from stdin (or a hidden prompt), never from the command line.
3. Writes `provider: "self-hosted"` and the endpoint to `~/.tapdance/config.json`, keeping your other
   settings, and saves the token to `~/.tapdance/credentials.json` (mode 600) bound to that endpoint:
   Tapdance sends it nowhere else. This is the per-user equivalent of
   `tapdance init --mode self-hosted --endpoint <url> --yes` followed by `tapdance config set-token --endpoint <url>`;
   a project's own `tapdance.config.json` still wins inside that project, and `connect` warns when the
   current directory has one.
4. Runs `tapdance doctor` (without the local host checks) and exits 10 if a check fails.
5. Prints the MCP setup for Claude Code, Codex and Cursor, using `tapdance` if it is on `PATH`, or
   the absolute Node.js and CLI paths otherwise. See [agents/](../agents/) for the details, including
   `TAPDANCE_SESSION_ID` for Codex and Cursor.

The agent's machine can be macOS, Linux or Windows. It needs Node.js 22.13+ and Tapdance, and must be
in the same tailnet as the host.

**Recommended: turn on HTTPS Certificates** for the tailnet (<https://login.tailscale.com/admin/dns>)
before `host up`. The guard then gets an `https://` address, and on the agent's machine
`tapdance view --tailscale` serves the viewer over https with live video; over plain http the viewer
falls back to about two screenshots a second. Turning them on later changes the guard's address from
`http://` to `https://`: run `host up` again, then `connect` again on the agent's machine.

## Check and stop

```bash
tapdance host status            # each step's state on this machine, and the endpoint
tapdance host down              # remove the guard service and `tailscale serve` for :4720
tapdance host down --revoke     # also revoke every paired control machine and delete the token files
```

To cut off a paired machine without stopping, or to see what it did, see
[Take access away](../security/personal-mac.md#take-access-away).

`host down` asks first (`--yes` skips the question). It leaves the Simlock worker running for local
agents; stop it with `tapdance worker stop`.

## Pause, resume, or stop for good

| You want to | Run (on the Mac) |
| --- | --- |
| Stop for now, come back later without re-pairing | `tapdance host pause` |
| Start again exactly as before | `tapdance host resume` |
| Hand the token to the agent | `tapdance host token` (copies it; `--show` prints it) |
| Cut the VPS off but keep hosting | `tapdance worker guard revoke all` |
| Stop everything and revoke | `tapdance host down --all` |

`host pause` stops the guard (and its `caffeinate` when you used `--keep-awake`), turns off the
Tailscale exposure, ends leases, shuts down the emulators and simulators the worker created (never your
own), stops the worker, and removes both login services, so nothing starts at your next login. The
pairing token is kept and still expires on its own date. `host resume` reinstalls both services with
the same flags (if no pause was recorded, for example after `host down`, it says so: use `host up`, or
pass `--allow-admin-account` / `--keep-awake` to `resume`), serves the guard on Tailscale again, and tells you whether the token is still valid; if
it expired, run `tapdance host up --repair` and `tapdance host token`.

Stop devices this way rather than quitting emulators by hand: Simlock keeps records of its devices, and
a device stopped behind its back makes the next lease fail until the worker resets them (it does that by
itself when it starts with no lease active).

## Warm spares

Simlock keeps one booted, unleased **warm spare** of each device kind it has served, so the next lease
is fast. `tapdance devices` shows it as "warm spare (booted, not in use)" and `host status` shows how
much memory the devices use. A spare stays booted after its lease ends: that is the point of it. The kind
is learned from leases, so the `host up` self-test (an Android device with no model or image tag)
teaches it one kind, and an agent that leases another kind (say a Pixel 7 with
`google_apis_playstore`) boots a second emulator next to it. With the default of one spare, expect up to
two emulators: the agent's and one spare. On a laptop, `tapdance host warm android=0,ios=0` turns spares
off (leases then cold-boot; idle devices shut down after 10 minutes), and `host warm android=1,ios=0`
keeps one Android spare only. Simlock reads these settings when the worker starts, and a worker restart
ends running leases, so `host warm` saves them and restarts the worker only when nothing is leased;
otherwise they apply at the next `tapdance worker restart` (or right away with `--now`, which ends the
running lease). `host up --warm …` sets them too, but re-runs every setup step: do not use it during a
test.

## Builds on the host

An agent on a machine without Xcode (a Linux VPS) cannot produce an iOS simulator app. The host can
build it: the agent names a git repository and a ref, the host fetches and builds it, and installs the
result on the agent's lease (issue #45). **Off by default.**

```bash
# on the host, once per repository
tapdance host builds enable --repo https://github.com/acme/app --git-auth gh --protected-ref main
```

```bash
# on the agent's machine, with a lease
tapdance app build --git https://github.com/acme/app --ref main --launch com.acme.app
```

- **Source:** git only for now. The host clones the repository once into
  `~/.tapdance/worker/builds/<repo>/` and fetches only what changed on later builds; DerivedData and the
  Gradle caches stay there, so rebuilds are incremental. `host builds status` shows the cache path.
- **Access:** credentials stay on the host. `--git-auth gh` uses the host's `gh auth`; a read-only
  deploy key from `tapdance host builds key --repo <url>` (add its public half to the repository; use
  ssh URLs) is used for that repository's ssh URL whenever it exists; `none` for public repositories.
  `host builds enable` then checks that this machine can read each repository with that auth
  (`git ls-remote`) and warns with the fix when it cannot, for example when GitHub refuses the deploy
  key; `--no-check` skips the check, and `host builds status --check` runs it again later. A build that
  cannot sign in fails with `AUTH_FAILED` and git's own line (`Permission denied (publickey)`), and the
  hint says what to check for the key or `gh` login that was used. See
  [private repositories](#private-repositories) below.
- **Which code:** only repositories on the allow-list. With `--protected-ref main` the host builds only
  commits already on `main` of the remote, so a compromised agent with push rights cannot get an
  unreviewed branch built. The reply and the audit log name the exact commit.
- **iOS:** `xcodebuild -sdk iphonesimulator -destination 'generic/platform=iOS Simulator'`, signed
  ad-hoc like Xcode's Run (`CODE_SIGN_IDENTITY=-`, no team needed) so the app keeps its entitlements
  and Keychain works, building only this Mac's simulator arch (`ARCHS=arm64 ONLY_ACTIVE_ARCH=YES`
  on Apple silicon, as Xcode's Run does; Kotlin Multiplatform apps usually declare only
  `iosSimulatorArm64`). `--project` and `--scheme` when the repository has more than one Xcode
  project. `--xcode-setting KEY=VALUE` passes a build setting from a short list (`ARCHS`,
  `EXCLUDED_ARCHS`, `ONLY_ACTIVE_ARCH`, `SWIFT_ACTIVE_COMPILATION_CONDITIONS`,
  `GCC_PREPROCESSOR_DEFINITIONS`, optimization and debug-info levels, `IPHONEOS_DEPLOYMENT_TARGET`,
  `KOTLIN_FRAMEWORK_BUILD_TYPE`, bundle id and version numbers); settings that name tools or paths
  are refused, because they would run code nobody reviewed. Kotlin Multiplatform apps call Gradle from a run-script phase, so the host needs a JDK on the
  guard's `PATH` or `JAVA_HOME`; `host builds enable` checks git, Xcode, Java and `gh`.
- **Android:** `./gradlew assembleDebug` (`--gradle-task`, `--dir` for the folder with `gradlew`); the
  newest APK under `build/outputs/apk` is installed, and the reply names its package (`appId`).
- **Gradle daemons:** a host build lets its Gradle and Kotlin daemons go after 10 idle minutes
  (`-Dorg.gradle.daemon.idletimeout`, and `autoshutdownIdleSeconds` for Kotlin's), instead of Gradle's
  3 hours. On a 16 GB cloud VM they held about 8 GB next to the emulator after a build (#90). A short
  idle timeout rather than stopping them after every build: an agent that rebuilds within minutes
  keeps a warm daemon, and nothing stops the daemons of your own builds on the same account
  (`gradlew --stop` would, and it leaves Kotlin's daemon running). `host builds enable
  --gradle-idle-minutes <n>` changes it; `0` builds with `--no-daemon` and compiles Kotlin inside that
  one Gradle process, for hosts with little memory to spare. Unit-tested only.
- **Reuse:** the last builds are kept per commit and settings (the newest three per repository, under
  `kept/` in the build cache). Asking for the same commit and settings again installs that build in
  seconds (`Reused the earlier build …`); every lease is a fresh device, so this is the common case.
  The reply always says `reused: true` or `false` (with `builtAt` for a reused build), so an agent
  knows whether it is testing a fresh build.
- **Offline host:** when the host cannot reach the git server, a full commit id it already has still
  builds from its cache with a warning; a branch name does not (the cached branch may be behind). The
  error names git's own `fatal:` line and says the host's network is at fault.
- **Limits:** one build at a time, `--timeout-minutes` (45 by default), the build log streams to the
  agent with secrets redacted. The CLI shows steps, errors and the outcome (`--verbose` for every
  line); a failed build's error names its cause: compiler errors, Gradle's "What went wrong" and the
  failed build commands.
- **Trust:** a build runs the repository's own scripts (Xcode run-script phases, Gradle) on the host as
  the hosting account: code execution by design. Allow only repositories you trust, prefer protected
  refs, and host from a dedicated standard account; `host builds enable` refuses an administrator
  account without `--allow-admin-account`. A token without the `builds` scope cannot build. See the
  [threat model](../security/threat-model.md). The guard reads the policy when it starts:
  `host builds enable`/`disable` restart it when no lease is running, and say so otherwise.

Builds come from git only: the code the host builds is always a commit it can name. Uploading the
agent's working tree or building from a folder already on the host is not planned; push the change to
a branch on an allow-listed repository instead (with protected refs, merge it first).

**Run on a real repository:** on the owner's Mac, Pianolune's clone, checkout and xcodebuild ran;
the iOS build failed in its Kotlin framework step on the simulator arch (#53, fixed, waiting for a re-run).
On a Google Cloud N2 VM, the Android build of Pianolune's private repository succeeded (Gradle 2 min
40 s, a reused build reinstalled in 11 s) through the CLI and MCP `build_app`
([evidence](../testing/evidence/2026-11-03-gcp-n2-android.md)). The steps are also unit-tested with a
fake git, Xcode and Gradle.

### Private repositories

Three ways, from most to least access on the host. Each is described step by step, with what a
compromised host would give away, in [private repositories](../guides/private-repositories.md).

| Way | Commands on the host | Covers |
| --- | --- | --- |
| A fine-grained, read-only GitHub token (recommended on a cloud VM) | `gh auth login --with-token`, then `tapdance host builds enable --repo https://github.com/acme/app --git-auth gh` | The repositories you select, and GitHub submodules among them |
| A deploy key per repository | `tapdance host builds key --repo git@github.com:acme/app.git`, add the public key read-only, then `host builds enable --repo git@github.com:acme/app.git` | That one repository. Organizations can turn deploy keys off; then use the token |
| No repository access | None: build in CI or on the agent's machine, then `tapdance app install` ([build in CI](../guides/ci-builds.md)) | Nothing on the host |

To undo: `tapdance host builds disable --repo <url>` removes one URL from the allow-list (the ssh and
https URLs are separate entries) and leaves builds on; `tapdance host builds key --repo <url> --remove`
deletes that repository's key and prints its fingerprint, so you can delete it on GitHub too.

Files a repository keeps out of git (`google-services.json`, `local.properties`, `.env`) can be added
on the host as **build files**: `tapdance host builds files add --repo <url> <path-in-repo> --from <file>`
(`list`, `remove`). Only the owner can add or read them; agents cannot. They are copied into the
checkout for the build and removed after it, at most 1 MB each and 50 per repository. Credentials for a
private Gradle registry go in the hosting account's `~/.gradle/gradle.properties`.

## Starting from nothing: `scripts/host-setup.sh`

On a Mac or Linux machine with nothing installed:

```bash
curl -fsSL https://raw.githubusercontent.com/mirzemehdi/tapdance/main/scripts/host-setup.sh | bash -s -- --label my-mac
```

You can also clone the repository and run `bash scripts/host-setup.sh` from it.

The script (`set -euo pipefail`):

1. **Checks the prerequisites:** Node.js 22.13+, git, a JDK 17+, the Android command-line tools,
   platform-tools, emulator and a Google Play system image (API 34 by default; `ANDROID_API`,
   `ANDROID_TAG`), Tailscale, and on Linux access to `/dev/kvm`. Xcode is optional (iOS) and is only
   reported: the App Store cannot be scripted.
2. **Lists what is missing and asks once** (on the terminal, even when piped through `curl`;
   `--yes` skips the question, `--check` only reports). Then it installs from the official sources,
   each download checked against its publisher's checksum: Node.js from nodejs.org into
   `~/.local/share/tapdance/node`; Eclipse Temurin 17 from api.adoptium.net into
   `~/Library/Java/JavaVirtualMachines` (macOS) or `~/.local/share/tapdance/jdk`; Google's command-line
   tools (SHA-1 from Google's repository XML), then `sdkmanager` for platform-tools, emulator and the
   system image, **accepting the Android SDK licenses**, into `~/Library/Android/sdk` or `~/Android/Sdk`.
   Only Linux system packages (git, unzip), Tailscale, the kvm group and, on a Linux cloud VM, a
   sudoers rule that allows only `/usr/bin/systemctl poweroff` (in `/etc/sudoers.d/tapdance-poweroff`,
   checked with `visudo`, so `--idle-stop` can stop an idle VM) use `sudo`. Tailscale comes from
   Homebrew (`brew install --cask tailscale`) on macOS, where you log in in the app, or tailscale.com's
   installer on Linux. It writes `~/.tapdance/env.sh` (PATH, `JAVA_HOME`, `ANDROID_HOME`,
   `ANDROID_SDK_ROOT`) and sources it from your `.zshrc`/`.bashrc` on macOS; on Linux at the top of
   `~/.bashrc` (before Ubuntu's "not interactive: return" line; `~/.zshenv` for zsh) and from
   `~/.profile`, so commands run over SSH (`ssh host 'tapdance host status'`) find the tools.
   The newest command-line tools are Google's Android CLI, which collects usage metrics by default: the
   script adds `--no-metrics` to `~/.androidrc` (Google's documented setting; the `sdkmanager` wrapper
   itself rejects that flag) and takes it out again if `sdkmanager` stops working with it.
   `--with-gh` also installs the GitHub CLI (`gh`, needed for installs from CI and builds with
   `--git-auth gh`; without the flag it only notes that `gh` is missing), and
   `--sdk-packages "cmake;3.31.6"` installs extra SDK packages an app's build on this host needs.
3. **On Linux, gets the machine ready to host without root:**
   - **KVM:** when `/dev/kvm` is not writable, it adds you to the `kvm` group and sets an ACL on
     `/dev/kvm` for your user (`setfacl`), so this login and the systemd user services can use it at
     once, without logging out. A reboot drops the ACL; the group stays and applies from your next
     login. Without `/dev/kvm` at all it skips the emulator and the system image, installs Tapdance,
     and stops: that machine can only be the agent's machine.
   - **Emulator libraries:** when `emulator -version` fails for a missing system library (Ubuntu's cloud
     image lacks them), it installs `libpulse0 libxkbfile1 libxi6 libsm6 libice6` with apt (dnf and
     pacman equivalents elsewhere).
   - **User manager:** when your account cannot linger (Google Cloud OS Login), it installs
     `tapdance-user-manager.service`, a system unit that starts your systemd user manager at boot.
4. **Installs Tapdance from source** if the `tapdance` command is missing: clones to `~/tapdance`
   (`TAPDANCE_SOURCE_DIR`, `TAPDANCE_REPO`, `TAPDANCE_REF`), puts Corepack's `pnpm` shim in
   `~/.local/bin` (no sudo), builds, and links `~/.local/bin/tapdance`.
5. **On Linux, logs in to Tailscale:** after asking, it runs `sudo tailscale up --operator=$USER`,
   which prints a login link to open in any browser and waits until you approve the machine; it comes
   after the install, so nothing else waits on it (with `--prerequisites-only`, before it stops). Being
   the operator lets your user run `tailscale serve`, which `host up` needs. If the machine is already
   logged in, it only runs `sudo tailscale set --operator=$USER`.
6. **Runs `tapdance host up`** with your other arguments. On Linux `host up` then turns on linger and,
   with no display, headless emulators (see the table above).

Its own options: `--yes`, `--check`, `--skip-prerequisites`, `--prerequisites-only`,
`--no-system-image`, `--with-gh`, `--sdk-packages <list>`.

Run so far: on macOS, the check and the install of Node.js, the Android command-line tools,
platform-tools and the emulator into a scratch home (2 min 13 s), the Temurin download, and a fresh
clone and build with only that Node.js. On a fresh Google Cloud N2 VM (Ubuntu 24.04): everything,
including the system image download, Tailscale login and `host up` with its self-test; the run that
passed took 2 min 44 s once earlier attempts had downloaded the SDK
([evidence](../testing/evidence/2026-11-03-gcp-n2-android.md)). Not yet run: a fresh Mac end to end.

Piped through `curl`, the script's input is the pipe; it gives `host up` your terminal (`/dev/tty`), so
you can approve the pairing there. If it still stops with "Pairing must be approved at this machine's
terminal" (no terminal at all, for example `gcloud compute ssh --command` without `-t`), run
`~/.local/bin/tapdance host up` (with the same options) in an interactive terminal; finished steps are
left as they are. `--yes` approves it up front, but also skips the install question.

### Failures seen on a real Linux VM

These stopped the first setup runs on the N2 VM and are handled now; on an older checkout, pull and run
the script again. Details in [troubleshooting](../troubleshooting.md#linux-and-cloud-hosts-host-up).

| Symptom | Cause | Handled by |
| --- | --- | --- |
| `host up` step 3: "Failed to connect to bus: No medium found" | No systemd user manager in a non-interactive SSH session | `host up`: linger, then waits for the user manager's bus |
| "Could not enable linger: No such file or directory" | A Google Cloud OS Login account | `host-setup.sh`: `tapdance-user-manager.service` |
| The emulator does not start; "system library libpulse.so.0 is missing" | Ubuntu's cloud image lacks the emulator's libraries | `host-setup.sh` installs them; host check `host.kvm.emulator-libs` |
| Slow taps, the idle emulator at 130 % CPU or more | `-gpu auto` without a GPU | `swiftshader_indirect` on headless Linux hosts (existing hosts: see troubleshooting) |
| `doctor` exits 10 against a Linux host | iOS was counted as missing | iOS on a Linux worker is skipped ("needs a Mac") |

## Windows

Windows cannot host devices: Simlock workers run on macOS and Linux only, and `tapdance host up`
refuses with `NOT_SUPPORTED`. Windows can be the agent's machine (`tapdance connect`).
`scripts/host-setup.ps1` prints these options, including Android emulators inside WSL2 or a Linux VM
with nested virtualization (untested).

## Cloud VMs

A cloud VM can host Android emulators only with nested virtualization. The documented route is a Google
Cloud N2 VM: [Google Cloud N2](google-cloud-n2.md) walks through creating it (Terraform or `gcloud`),
running `scripts/host-setup.sh` on it over IAP SSH, and connecting the agent's machine (run end to end
from a Mac: [evidence](../testing/evidence/2026-11-03-gcp-n2-android.md)). On a VM without `/dev/kvm`, `host up` says so in step 1 and stops; Tapdance never falls
back to software emulation. In that case keep the VM as the agent's machine and host the devices
elsewhere.

## Related

- [Device-only mode and the worker guard](../security/personal-mac.md)
- [Google Cloud N2 host](google-cloud-n2.md)
- [Your laptop as a worker (gateway mode)](laptop-worker.md)
- [Self-hosted overview](self-hosted-overview.md)
