# Host devices for a remote agent

Your agent runs on one machine, the [agent's machine](../glossary.md#machines): a laptop, or a Linux
VPS. A **host** runs the emulators and simulators: your own Mac or Mac mini (iOS and Android), or a
Linux machine with KVM (Android). One command sets up the host, and one command connects the agent's
machine to it.

This is the main guide for any host. The provider pages add only what is special about their machine:
[Google Cloud N2](google-cloud-n2.md), [dedicated Linux server](dedicated-linux-server.md),
[rented Scaleway Mac mini](../ios/scaleway-mac.md) and [other cloud Macs](../ios/other-cloud-macs.md).

> Proven: an agent on a Linux VPS tested a real app on the owner's Mac, Android and iOS
> ([field runs](../testing/evidence/2026-11-02-vps-field-runs.md),
> [self-test through the guard](../testing/evidence/2026-11-03-selftest-through-guard.md)); a fresh
> Google Cloud N2 VM ([evidence](../testing/evidence/2026-11-03-gcp-n2-android.md)) and a fresh rented
> Mac mini ([evidence](../testing/evidence/2026-11-06-rented-mac-ios.md)) set up with `host-setup.sh`,
> each driven from a Mac and from a Linux VPS; one agent using two hosts at once
> ([evidence](../testing/evidence/2026-11-07-two-hosts-android-ios.md)). Unit-tested only: `host pause`,
> `host resume` and `host down --all`. Please report what you find with `tapdance report`.

## What you get

- The host runs in [device-only mode](../security/device-only-mode.md). The agent's machine reaches
  only the **guard**, a small server that allows a fixed list of device actions. It never gets a shell
  on the host.
- Nothing is opened to the internet. The guard is reachable only inside your Tailscale network.
- The agent leases devices, installs apps, taps and takes screenshots as if the devices were local.
- You can watch the device live in a browser and take over (`tapdance view --tailscale`).

## What you need

- **A host.** A Mac runs iOS simulators and Android emulators. A Linux machine needs KVM and runs
  Android emulators only. An 8 GB Mac holds one iOS simulator at a time.
- **Tailscale on both machines,** logged in to the same tailnet.
- **HTTPS Certificates turned on** for the tailnet, in the
  [Tailscale admin console](https://login.tailscale.com/admin/dns). The guard then gets an `https://`
  address and the viewer shows live video. Without them the viewer falls back to about two screenshots
  a second.
- **On the host,** nothing else up front. `host-setup.sh` installs Node.js, a JDK, the Android SDK,
  Tailscale and Tapdance. For iOS, install Xcode yourself (the App Store, or `xcodes`): it cannot be
  scripted.
- **On the agent's machine,** Node.js 22.13+ and Tapdance ([installation](../installation.md)). It can
  run macOS, Linux or Windows, and needs no Xcode, Android SDK or KVM.
- **On a Mac, a standard account** to host from is recommended, not an administrator account. See
  [the administrator question](#the-administrator-question).

## Steps

1. **On the host, run the setup.** Give `--label` the name of the agent's machine: the pairing is
   named after the machine that will use it.

   ```bash
   curl -fsSL https://raw.githubusercontent.com/mirzemehdi/tapdance/main/scripts/host-setup.sh | bash -s -- --label my-vps
   ```

   The script lists what is missing, asks once, installs it, then runs `tapdance host up` with your
   other arguments. If Tapdance is already installed, run `host up` directly:

   ```bash
   tapdance host up --label my-vps
   ```

   `host up` asks you to approve the pairing at the terminal. It ends with a block like this:

   ```text
   TAPDANCE HOST READY
   endpoint:  https://my-mac.tail1234.ts.net:4720
   token:     saved to /Users/me/.tapdance/worker/pairing-my-vps.token (mode 600), fingerprint 3fa9c2. Copy it: tapdance host token --label my-vps (over ssh: scp the file)
   devices:   android 34 (google_apis), ios 26.5
   self-test: PASS (android lease, screenshot ok)
   on the agent machine:  tapdance connect https://my-mac.tail1234.ts.net:4720 < pairing-my-vps.token
   ```

   The [pairing token](../glossary.md#device-only-mode) is written to a file only you can read. It is
   never printed.

2. **Move the token file to the agent's machine** over a private channel: `scp`, or your password
   manager. Never through a chat or a repository. For example, on the agent's machine:

   ```bash
   scp me@my-mac:~/.tapdance/worker/pairing-my-vps.token .
   ```

   At the host's own screen, `tapdance host token` copies the token to the clipboard instead. Over ssh
   it refuses (the clipboard would be the host's): use `scp`, or `tapdance host token --show` to print it
   once.

3. **On the agent's machine, connect.** Use the line `host up` printed:

   ```bash
   tapdance connect https://my-mac.tail1234.ts.net:4720 < pairing-my-vps.token
   ```

   `connect` saves the host as a [connect target](../glossary.md#device-only-mode) and the token in
   `~/.tapdance/credentials.json`. It prints the token's fingerprint: it should match the one `host up`
   printed. You can then delete the copied token file.

4. **Give your agent the device tools.** `connect` prints the MCP setup for Claude Code, Codex and
   Cursor. Details for each agent: [agents](../agents.md).

## Check it worked

On the agent's machine:

```bash
tapdance doctor --no-host
tapdance devices
tapdance device lease --platform android
tapdance screenshot -o first.png
tapdance device release
```

`doctor` should end with "All checks passed". On a Mac host you can lease `--platform ios` the same
way. The first boot of a device can take minutes.

## Add a second host

An agent's machine can use several hosts, for example a Linux host for Android and a Mac for iOS. Run
`host up` on each host and `tapdance connect` once per host. A lease goes to the first connect target,
in the order they were added, that serves the platform and answers. See
[Android and iOS from one agent](../guides/android-and-ios.md).

## Day to day on the host

| Command | What it does |
| --- | --- |
| `tapdance host status` | The state of each `host up` step, the endpoint, and memory used by devices. |
| `tapdance host token` | Copies the pairing token to hand to the agent (`--show` prints it once). |
| `tapdance host warm android=0,ios=0` | How many booted spare devices to keep. See [warm spares](#warm-spares). |
| `tapdance host builds enable --repo <url> --git-auth gh --protected-ref main` | Lets the agent build that repository's app on this host. See [builds on the host](#builds-on-the-host). |
| `tapdance worker cleanup` | Releases device claims left by a worker that restarted mid-lease. |
| `tapdance host pause` | Stops hosting for now and keeps the pairing. |
| `tapdance host resume` | Starts again after `pause`, with the same settings. |
| `tapdance host down` | Removes the guard service and its `tailscale serve` entry. Tokens are kept. |
| `tapdance host down --all` | Stops everything and revokes every token. |
| `tapdance worker guard revoke all` | Revokes every token; hosting keeps running. |

`host pause`, `host resume` and `host down --all` are unit-tested only.

To cut off one paired machine, or to see what it did, see
[take access away](../security/device-only-mode.md#take-access-away).

### Pause, resume, or stop for good

| You want to | Run on the host |
| --- | --- |
| Stop for now, come back later without pairing again | `tapdance host pause` |
| Start again exactly as before | `tapdance host resume` |
| Cut the agent's machine off but keep hosting | `tapdance worker guard revoke all` |
| Stop hosting, keep the tokens | `tapdance host down` |
| Stop hosting and revoke every token | `tapdance host down --revoke` |
| Stop everything and revoke | `tapdance host down --all` |

`host pause` stops the guard (and its `caffeinate` if you used `--keep-awake`) and turns off the
Tailscale exposure. It ends leases, shuts down the emulators and simulators the worker created (never
your own), stops the worker, and removes both login services, so nothing starts at your next login. The
pairing token is kept and still expires on its own date.

`host resume` reinstalls both services with the same flags, serves the guard on Tailscale again, and
tells you whether the token is still valid. If it expired, run `tapdance host up --repair` and
`tapdance host token`. If no pause was recorded (for example after `host down`), `resume` says so: use
`host up`, or pass `--allow-admin-account` or `--keep-awake` to `resume`.

`host down` asks first (`--yes` skips the question). It leaves the worker running for agents on the
host itself; stop it with `tapdance worker stop`. `--revoke` also revokes every paired machine and
deletes the token files. `--all` adds what `pause` does to the worker and its devices.

Stop devices with these commands rather than quitting emulators by hand. Simlock keeps records of its
devices, and a device stopped behind its back makes the next lease fail until the worker resets them.
The worker does that by itself when it starts with no lease active.

### Warm spares

The worker keeps one booted, unleased **warm spare** of each device kind it has served, so the next
lease is fast. `tapdance devices` shows it as "warm spare (booted, not in use)". `host status` shows
how much memory the devices use. A spare stays booted after its lease ends: that is the point of it.

The kind is learned from leases. The `host up` self-test leases an Android device with no model or
image tag, so it teaches the worker one kind. An agent that leases another kind (say a Pixel 7 with
`google_apis_playstore`) boots a second emulator next to it. With the default of one spare, expect up
to two emulators: the agent's and one spare.

To save memory, for example on a laptop or an 8 GB Mac:

```bash
tapdance host warm android=0,ios=0
```

Leases then cold-boot, and idle devices shut down after 10 minutes. `host warm android=1,ios=0` keeps
one Android spare only.

The worker reads these settings when it starts, and a worker restart ends running leases. So
`host warm` saves them and restarts the worker only when nothing is leased. Otherwise they apply at the
next `tapdance worker restart`, or right away with `--now`, which ends the running lease. `host up
--warm …` sets them too, but re-runs every setup step: do not use it during a test.

## A Mac that stays on

For a Mac or Mac mini that hosts devices all the time, with nobody at it:

- **Use a dedicated standard account.** Installing an iOS simulator app runs code on the Mac as the
  hosting account, so keep your own files out of that account. Create one with
  `infrastructure/scripts/macos-create-worker-account.sh` (untested), log in as it, and run
  `tapdance host up` there. If Tailscale runs as the open-source `tailscaled` daemon, let that account
  serve the guard once: `sudo tailscale set --operator=<account>`. Why: [threat model](../security/threat-model.md).
- **Turn on automatic login** for the hosting account. The worker and guard are LaunchAgents, which
  macOS starts only in a logged-in session. Without automatic login, a Mac that reboots waits at the
  login window and serves nothing. Run `infrastructure/scripts/macos-auto-login.sh <account>` (it asks
  for the passwords), reboot, and check that `who` lists the account on `console`. The script stores
  the password in `/etc/kcpassword`, which is obfuscation, not encryption: use it only on a Mac that
  holds nothing personal.
- **Keep it awake.** A sleeping Mac takes the guard offline. Agents then get a retryable error, and a
  lease that is not renewed in time expires. `tapdance host up --keep-awake` runs the guard under
  `caffeinate -i`, which prevents idle sleep. On a desktop Mac, also turn off system sleep in System
  Settings > Energy, or with `sudo pmset -a sleep 0`.
- **Expect reboots to end leases.** After a reboot, leases whose device is gone are released. With
  automatic login the worker and guard start again on their own.
- **Check it from the agent's machine** after a reboot: `tapdance doctor --no-host`.

More on the guard service and sleep: [keep the guard running](../security/device-only-mode.md#keep-the-guard-running).
A rented Mac set up over ssh: [Scaleway Mac mini](../ios/scaleway-mac.md).

## Builds on the host

An agent without Xcode (on a Linux VPS, say) cannot build an iOS simulator app. The host can build it
from a git repository its owner allowed, and install it on the agent's lease
(`tapdance app build --git <url> --ref main`). Builds are off by default. See
[host builds](../guides/host-builds.md).

## If it fails

`host up` prints each step's name. When a step fails, it prints the step, the command it ran, the end
of that command's output and a fix, and exits non-zero. Running it again is safe: finished steps are
left as they are.

- Linux and cloud hosts: [troubleshooting](../troubleshooting.md#linux-and-cloud-hosts-host-up), and
  [failures seen on a real Linux VM](#failures-seen-on-a-real-linux-vm) below.
- Macs reached over ssh: [troubleshooting](../troubleshooting.md#rented-macs-macos-hosts-reached-over-ssh).
- "Pairing must be approved at this machine's terminal" after `curl … | bash`: run
  `~/.local/bin/tapdance host up` with the same options in an interactive terminal.
- `connect` fails on an `http://` address after you turned on HTTPS Certificates: run `host up` again
  on the host, then `connect` with the new `https://` address.
- Everything else: [troubleshooting](../troubleshooting.md).

## What `host up` does

Each step prints its name.

1. **Prerequisites.** The checks from `tapdance worker check`: Node.js 22.13+, the Android SDK with
   command-line tools, platform-tools, emulator and a system image, KVM on Linux, Xcode and an iOS
   runtime on macOS, and a JDK. On Linux it also reads the DMI vendor strings: a cloud VM without
   `/dev/kvm` is reported as unable to host Android emulators (nested virtualization is off). It
   **installs nothing**. If neither Android nor iOS is usable, it stops and prints the install
   commands, with Homebrew lines on macOS.
2. **Account.** The guard's own refusals: not as root, not while this worker has joined a gateway, and
   not from a macOS administrator account unless you pass `--allow-admin-account`. On an administrator
   account it stops, explains the risk, and prints the exact command to run again. Nothing has changed
   at this point.
3. **Worker.** Same as `tapdance worker install --service`: the bundled Simlock worker on loopback,
   agent-device, streaming and input on, restarted, and Simlock's login service installed.
   - On Linux with no display (`DISPLAY` and `WAYLAND_DISPLAY` unset, as over ssh) it also sets
     `android.emulator.headless`, so emulators boot without a window, and `android.emulator.gpu` to
     `swiftshader_indirect`. With the emulator's `auto`, an N2 VM without a GPU idled at 136–165 % CPU
     and screen-changing taps took 3.4–7.9 s; with `swiftshader_indirect`, about 0 % and 2.2–2.6 s.
   - On a re-run, when the worker answers and the guard service runs, it is left alone: a restart
     would end the sessions of an agent using this host.
   - The exception is an update. When Simlock's login service still starts the Simlock of an older
     build (a new Simlock patch lands in a new folder), the worker is restarted with the service
     installed again if no lease runs, and `host up` warns if one does.
4. **Guard service.** Same as `tapdance worker guard install`: a LaunchAgent (macOS) or systemd user
   unit (Linux) that runs `worker guard start` at login and restarts it. Then it waits until the guard
   answers on `127.0.0.1:4720`.
   - A running service with an unchanged file is left alone. A restart keeps lease ownership, which
     the guard saves, but drops uploads in progress.
   - It refuses while a `worker guard start` in a terminal holds the port.
   - On Linux it turns on **linger** for your user (`loginctl enable-linger`), waits for the user
     manager's bus and points `systemctl --user` at it. Over a non-interactive ssh session there is
     none otherwise ("Failed to connect to bus: No medium found"). With linger, the worker and guard
     keep running after you log out and start at boot. If linger is refused, it prints the `sudo`
     command.
   - Accounts logind cannot look up (Google Cloud OS Login) cannot linger. For them `host-setup.sh`
     installs `tapdance-user-manager.service`, which starts the user manager at boot, and `host up`
     starts it.
5. **Pairing.** Issues a guard token labelled with `--label`, after you confirm at the terminal.
   - `--yes` skips the prompt. Without a terminal it needs `--yes`, and that is checked before step 1
     changes anything.
   - Without `--label` it keeps the host's only active pairing (so `host up --idle-stop 10` on a paired
     host changes the cost guard and pairs no one new). With no pairing yet the label is the hostname;
     with several, it asks you to pass `--label`.
   - The token is written to `~/.tapdance/worker/pairing-<label>.token` with mode 600 and is **never
     printed**. If a valid token file for that label exists, it is kept; `--repair` revokes it and
     issues a new one.
   - Tokens expire after `limits.tokenDays` (7 days by default). After that, `host up` issues a new one.
6. **Tailscale.** If `tailscale` is installed and logged in, it exposes the guard on this machine's
   MagicDNS name.
   - With HTTPS certificates on the tailnet (`CertDomains` in `tailscale status --json`) it runs
     `tailscale serve --bg --https=4720 http://127.0.0.1:4720`, and the endpoint is `https://…`.
   - Without them (the default on many tailnets) it runs `tailscale serve --bg --http=4720 …`, and the
     endpoint is `http://<host>.<tailnet>.ts.net:4720`. That travels inside the tailnet's WireGuard
     encryption, and `connect` accepts it.
   - Otherwise (or with `--no-tailscale`) it prints what to do, and the endpoint stays
     `http://127.0.0.1:4720`, which only this machine can use.
   - `host status` shows which mode is served; `host down` turns off either.
   - On Linux, when `tailscale serve` is refused ("Access denied"), it stops and names the fix:
     `sudo tailscale set --operator=$USER` once.
7. **Self-test.** Through the guard, with the new token: lists the devices, leases an Android device
   (iOS if there is no Android), takes a screenshot and releases it. `--skip-self-test` keeps only the
   device list. The first boot of a device can take minutes. The lease waits (up to 5 minutes) while an
   agent holds the guard's only session (`limits.maxSessions` is 1 by default).
8. **Summary.** Prints the ready block shown in the steps above. On a detected cloud VM it adds a
   `cloud VM:` line, and with a cost guard a `cost guard:` line.

On Linux without a display, `host up` does not offer the clipboard; it names the token file and
`host token --show`.

### Options

| Option | Meaning |
| --- | --- |
| `--label <name>` | Name of the pairing, shown in `tapdance worker guard tokens`. Name it after the agent's machine. Default: the host's only active pairing, else the hostname. A new name pairs another agent's machine. |
| `--allow-admin-account` | Run the guard from a macOS administrator account. Not recommended; see below. |
| `--no-tailscale` | Leave `tailscale serve` alone; the endpoint stays on loopback. |
| `--keep-awake` | macOS: run the guard under `caffeinate -i`. See [a Mac that stays on](#a-mac-that-stays-on). |
| `--tailscale-ssh` | Also turn on Tailscale SSH. See below. |
| `--repair` | Revoke the pairing with this label and issue a new token. |
| `--skip-self-test` | Do not lease a device at the end. |
| `--scope <areas>` | Limit the token to these policy areas, for example `interaction,inspection,screenshots,streaming,input` (no install). See the [threat model](../security/threat-model.md). |
| `--warm <counts>` | Warm spares per platform, for example `android=1,ios=0`. Re-runs every step; prefer `host warm`. |
| `--idle-stop <minutes\|off>` | Linux cloud VMs: power off after this many idle minutes. See below. |
| `--max-uptime <hours\|off>` | Linux cloud VMs: after this many hours up, take no new leases and power off when the last one ends. Off by default; refused on macOS. |
| `-y, --yes` | Approve the pairing without a prompt. You are the owner, at this machine. |

**`--tailscale-ssh`** runs `tailscale set --ssh`. Machines in your tailnet can then
`ssh <user>@<host>.<tailnet>.ts.net` without copying an ssh key, which helps when the agent's machine
is a fresh VPS. The tailnet policy's `ssh` section decides who may connect (the default lets a device's
owner in after a browser approval about every 12 hours).

A shell over Tailscale SSH is outside the guard: whatever runs on a machine the policy lets in, the
agent's own machine included, can act as the hosting account. `host up` warns about this. Limit the
`ssh` rule's `src` to your own devices (not the agent's machine) and its `users` to the hosting account
(no root). It needs the open-source `tailscaled` (Linux, or a Mac set up by `host-setup.sh` without the
Tailscale app). A refusal only warns and prints `sudo tailscale set --ssh`. To turn it off:
`sudo tailscale set --ssh=false`. Run on the N2 host up to the browser approval; an ssh login through
it was not completed.

**`--idle-stop`** powers the machine off after this many minutes with no lease, guard request or build.
It is 30 by default on a detected cloud VM, off elsewhere, and refused on macOS. It needs a sudoers rule
for `systemctl poweroff`, which `host up` prints when it is missing. See
[cost guardrails](google-cloud-n2.md#cost-guardrails). On a short-lived test VM that Terraform deletes
at a time limit, pass `off`: an idle poweroff would stop the VM instead and leave its disk billing
([field test](../testing/field-test-cloud-android.md)).

### The administrator question

The guard limits what a remote agent can ask for. But a bug in the Simulator, the emulator or the guard
itself would run with the rights of the account that runs it, and an administrator account can become
root. Installing an iOS simulator app also runs that app as the hosting account.

The recommended setup is a dedicated standard account
(`infrastructure/scripts/macos-create-worker-account.sh`, **untested**): log in as it and run
`tapdance host up` there. `host up` never falls back to an administrator account on its own. It stops
and tells you to either switch accounts or run it again with `--allow-admin-account`.

## On the agent's machine: `tapdance connect`

```bash
tapdance connect https://my-mac.tail1234.ts.net:4720 < pairing-my-vps.token
```

1. Checks that the address answers (two tries, 15 s each) before saving anything. An `http://` address
   the guard no longer serves (it switched to `https://` after HTTPS Certificates were turned on) fails
   with the `https://` command to run instead.
2. Reads the token from stdin (or a hidden prompt), never from the command line.
3. Adds the host to the connect targets (`targets` in `~/.tapdance/config.json`) and sets
   `provider: "self-hosted"`, keeping your other settings. It saves the token in
   `~/.tapdance/credentials.json` (mode 600) for that host's address only: Tapdance sends it nowhere
   else. `--name` names the target (default: the host's first DNS label); `--platform` limits it to
   `android` or `ios`.
4. Runs `tapdance doctor` (without the local host checks) and exits 10 if a check fails. It warns when
   `TAPDANCE_ENDPOINT` or the current directory's `tapdance.config.json` overrides the endpoint: those
   select a single host and bypass the targets.
5. Prints the MCP setup for Claude Code, Codex and Cursor, using `tapdance` if it is on `PATH`, or the
   absolute Node.js and CLI paths otherwise. See [agents](../agents.md), including
   `TAPDANCE_SESSION_ID` for Codex and Cursor.

`tapdance connect --list` shows the targets; `tapdance disconnect <name>` removes one and its token.
Running `connect` again with the same `--name` and a new address moves that target.

**HTTPS Certificates later.** Turning them on after `host up` changes the guard's address from
`http://` to `https://`. Run `host up` again on the host, then `connect` again on the agent's machine.
With `https://`, `tapdance view --tailscale` on the agent's machine serves the viewer over https with
live video.

## Starting from nothing: `scripts/host-setup.sh`

On a Mac or Linux machine with nothing installed:

```bash
curl -fsSL https://raw.githubusercontent.com/mirzemehdi/tapdance/main/scripts/host-setup.sh | bash -s -- --label my-vps
```

You can also clone the repository and run `bash scripts/host-setup.sh` from it. Its own options are
listed at the end of this section; every other argument goes to `tapdance host up`.

The script (`set -euo pipefail`):

1. **Checks the prerequisites:** Node.js 22.13+, git, a JDK 17+, the Android command-line tools,
   platform-tools, emulator and the `google_apis` system image (API 34 by default; `ANDROID_API`,
   `ANDROID_TAG`), Tailscale, and on Linux access to `/dev/kvm` and the emulator's system libraries.
   Xcode is optional (iOS) and only reported: the App Store cannot be scripted.
   - `--play-store` installs the Google Play image (`google_apis_playstore`) instead. Use it only when
     agents test Play Billing or a Play sign-in (they lease it with `--image-tag google_apis_playstore`).
     Play images update Google Play services in the background for minutes after a boot, which is
     likely (not proven) where the extra guest CPU on a slow host comes from.
   - Hosts set up before `google_apis` became the default keep their Play image; a new run of the
     script adds `google_apis` next to it.
2. **Lists what is missing and asks once** (on the terminal, even when piped through `curl`; `--yes`
   skips the question, `--check` only reports). Then it installs from the official sources, each
   download checked against its publisher's checksum:
   - Node.js from nodejs.org into `~/.local/share/tapdance/node`.
   - Eclipse Temurin 17 from api.adoptium.net into `~/Library/Java/JavaVirtualMachines` (macOS) or
     `~/.local/share/tapdance/jdk`.
   - Google's command-line tools (SHA-1 from Google's repository XML), then `sdkmanager` for
     platform-tools, emulator and the system image, **accepting the Android SDK licenses**, into
     `~/Library/Android/sdk` or `~/Android/Sdk`.
   - Tailscale from Homebrew (`brew install --cask tailscale`) on macOS, where you log in in the app,
     or tailscale.com's installer on Linux (piped to `sh` as Tailscale documents, with no checksum).
   - Only Linux system packages (git, unzip and the emulator libraries, in one package-manager call),
     Tailscale, the kvm group and, on a Linux cloud VM, a sudoers rule use `sudo`. The rule allows only
     `/usr/bin/systemctl poweroff` (in `/etc/sudoers.d/tapdance-poweroff`, checked with `visudo`), so
     `--idle-stop` can stop an idle VM.
   - It writes `~/.tapdance/env.sh` (`PATH`, `JAVA_HOME`, `ANDROID_HOME`, `ANDROID_SDK_ROOT`). On
     macOS it sources it from your `.zshrc`/`.bashrc`. On Linux it sources it at the top of
     `~/.bashrc` (before Ubuntu's "not interactive: return" line; `~/.zshenv` for zsh) and from
     `~/.profile`, so commands run over ssh (`ssh host 'tapdance host status'`) find the tools.
   - The newest command-line tools are Google's Android CLI, which collects usage metrics by default.
     The script adds `--no-metrics` to `~/.androidrc` (Google's documented setting; with command-line
     tools 23.0 nothing is recorded with the line), and takes it out again if `sdkmanager` stops
     working with it.
   - `--with-gh` also installs the GitHub CLI (`gh`, needed for installs from CI and builds with
     `--git-auth gh`). Without the flag it only notes that `gh` is missing.
   - `--sdk-packages "cmake;3.31.6"` installs extra SDK packages an app's build on this host needs.
3. **On Linux, gets the machine ready to host without root:**
   - **KVM:** when `/dev/kvm` is not writable, it adds you to the `kvm` group and sets an ACL on
     `/dev/kvm` for your user (`setfacl`), so this login and the systemd user services can use it at
     once. A reboot drops the ACL; the group applies from your next login. Without `/dev/kvm` at all
     it skips the emulator and the system image, installs Tapdance, and stops: that machine can only be
     the agent's machine (this branch is not yet run).
   - **Emulator libraries:** Ubuntu's cloud image lacks some libraries the emulator loads. The script
     checks the packages themselves (`libpulse0 libxkbfile1 libxi6 libsm6 libice6` with apt; dnf and
     pacman equivalents elsewhere) and installs them in the same step as git and unzip. Once the
     emulator is installed, `emulator -version` is the check; if it still fails for a library, the
     script names the packages and asks again before using `sudo`.
   - **User manager:** it asks before `sudo loginctl enable-linger $USER`. When your account cannot
     linger (Google Cloud OS Login), it asks before installing `tapdance-user-manager.service`, a system
     unit that starts your systemd user manager at boot. `--yes` answers yes. With no terminal and no
     `--yes` the step is skipped with a note, and the worker and guard stop when you log out.
4. **Installs Tapdance from source** if the `tapdance` command is missing: clones to `~/tapdance`
   (`TAPDANCE_SOURCE_DIR`, `TAPDANCE_REPO`, `TAPDANCE_REF`), puts a `pnpm` in `~/.local/bin` without
   sudo (Corepack's shim, or on a Node.js without Corepack, 25 and later, the pnpm version
   `package.json` pins, installed with npm), builds, and links `~/.local/bin/tapdance`.
5. **On Linux, logs in to Tailscale:** after asking, it runs `sudo tailscale up --operator=$USER`,
   which prints a login link to open in any browser and waits until you approve the machine. It comes
   after the install, so nothing else waits on it (with `--prerequisites-only`, before it stops). Being
   the operator lets your user run `tailscale serve`, which `host up` needs. If the machine is already
   logged in, it asks before `sudo tailscale set --operator=$USER`.
6. **Runs `tapdance host up`** with your other arguments.

Piped through `curl`, the script's input is the pipe, so it gives `host up` your terminal (`/dev/tty`)
for the pairing question. With no terminal at all (for example `gcloud compute ssh --command` without
`-t`) it stops with "Pairing must be approved at this machine's terminal": run
`~/.local/bin/tapdance host up` with the same options in an interactive terminal. `--yes` approves the
pairing up front, but also skips the install question.

Its own options: `--yes`, `--check`, `--skip-prerequisites`, `--prerequisites-only`,
`--no-system-image`, `--play-store`, `--with-gh`, `--sdk-packages <list>`, `--ios-only` and
`--android-build-sdk`.

### macOS specifics

Run on a Scaleway Mac mini ([guide](../ios/scaleway-mac.md)):

- `--ios-only` skips the Android SDK, emulator and image, and fixes what blocks iOS: the Xcode licence
  and first launch (sudo) and a missing iOS runtime (`xcodebuild -downloadPlatform iOS`, about 8 GB).
  The JDK stays: Kotlin Multiplatform apps run Gradle in their Xcode build.
- `--android-build-sdk` adds only the command-line tools and platform-tools, for such apps whose Gradle
  needs an SDK even for iOS.
- Tailscale is installed as the open-source `tailscaled` system daemon (MacPorts `port install
  tailscale` and `port load tailscale`, or Homebrew's formula and `tailscaled install-system-daemon`),
  not the Tailscale app: the daemon runs at boot with nobody logged in. Then `sudo tailscale up` prints
  a login link.
- `gh` comes from Homebrew, else MacPorts. `~/.tapdance/env.sh` is sourced from `~/.zshenv` (zsh) and
  puts MacPorts and Homebrew on `PATH`, so commands over ssh (`ssh mac 'tapdance host status'`) work.
- Xcode itself is not installed by the script (the App Store, or `xcodes` with your Apple ID).
- The worker and guard are LaunchAgents: see [a Mac that stays on](#a-mac-that-stays-on).

Run so far: on a fresh Scaleway Mac mini (macOS 27.2) over `ssh -t`, `--ios-only --with-gh` end to
end, about 13 min with the prompts ([evidence](../testing/evidence/2026-11-06-rented-mac-ios.md)).
Before that, on macOS: the check and the install of Node.js, the Android command-line tools,
platform-tools and the emulator into a scratch home (2 min 13 s), the Temurin download, and a fresh
clone and build with only that Node.js. On a fresh Google Cloud N2 VM (Ubuntu 24.04): everything,
including the system image download, Tailscale login and `host up` with its self-test; the run that
passed took 2 min 44 s once earlier attempts had downloaded the SDK
([evidence](../testing/evidence/2026-11-03-gcp-n2-android.md)).

### Failures seen on a real Linux VM

These stopped the first setup runs on the N2 VM and are handled now. On an older checkout, pull and
run the script again. Details in [troubleshooting](../troubleshooting.md#linux-and-cloud-hosts-host-up).

| Symptom | Cause | Handled by |
| --- | --- | --- |
| `host up` step 3: "Failed to connect to bus: No medium found" | No systemd user manager in a non-interactive ssh session | `host up`: linger, then waits for the user manager's bus |
| "Could not enable linger: No such file or directory" | A Google Cloud OS Login account | `host-setup.sh`: answer yes to `tapdance-user-manager.service` (or pass `--yes`) |
| The emulator does not start; "system library libpulse.so.0 is missing" | Ubuntu's cloud image lacks the emulator's libraries | `host-setup.sh` installs them; host check `host.kvm.emulator-libs` |
| Slow taps, the idle emulator at 130 % CPU or more | `-gpu auto` without a GPU | `swiftshader_indirect` on headless Linux hosts (existing hosts: see troubleshooting) |
| `doctor` exits 10 against a Linux host | iOS was counted as missing | iOS on a Linux worker is skipped ("needs a Mac") |

## Windows

Windows cannot host devices: Simlock workers run on macOS and Linux only, and `tapdance host up`
refuses with `NOT_SUPPORTED`. Windows can be the agent's machine (`tapdance connect`).
`scripts/host-setup.ps1` prints these options, including Android emulators inside WSL2 or a Linux VM
with nested virtualization (untested).

## Cloud VMs

A cloud VM can host Android emulators only with nested virtualization. The documented route is a
[Google Cloud N2](google-cloud-n2.md) VM: creating it (Terraform or `gcloud`), running
`scripts/host-setup.sh` on it over IAP SSH, and connecting the agent's machine (run end to end:
[evidence](../testing/evidence/2026-11-03-gcp-n2-android.md)). On a VM without `/dev/kvm`, `host up`
says so in step 1 and stops; Tapdance never falls back to software emulation. Keep such a VM as the
agent's machine and host the devices elsewhere.

When you are done with a rented machine, delete it and its disks: see
[when you are done with a rented machine](self-hosted-overview.md#when-you-are-done-with-a-rented-machine).

## Related

- [Choose a remote setup](self-hosted-overview.md)
- [Device-only mode and the guard](../security/device-only-mode.md)
- [Android and iOS from one agent](../guides/android-and-ios.md)
- [Host builds](../guides/host-builds.md)
- [Gateway mode](gateway-mode.md) (advanced, run on one Mac only)
