# One-command host: agent on a VPS, devices on your Mac

Your coding agent runs on a VPS (or any other machine). Your Mac, or a Linux machine with KVM, runs
the emulators and simulators. Two commands connect them:

```bash
# on the Mac (or Linux host), in a local terminal
tapdance host up

# on the agent's machine, with the token file the first command wrote
tapdance connect https://<mac>.<tailnet>.ts.net:4720 < pairing-<label>.token
```

`host up` sets the machine up in **device-only mode** ([security/personal-mac.md](../security/personal-mac.md)):
the agent reaches it only through the worker guard, never through Simlock directly, and nothing is
opened to the public internet.

> **Status: `host up` not run end to end yet.** `host up`, `host status`, `host down`, `connect`,
> `worker guard install` and `scripts/host-setup.sh` were built and unit-tested (the pure parts:
> service files, Tailscale parsing, the final block, error formatting, platform refusal). None of them
> has been run on a fresh machine, through Tailscale, or across two machines. The individual steps
> they reuse (`worker install`, `worker guard start`, `worker guard pair`) ran on one Mac
> ([evidence](../testing/evidence/2026-11-01-worker-guard.md)). See [STATUS.md](../../STATUS.md) (W-07,
> H-03) and please report what you find with `tapdance report`.

## What `host up` does

Each step prints its name. If one fails, it prints the step, the command it ran, the end of that
command's output and a fix, and exits non-zero. Running it again is safe.

| Step | What happens |
| --- | --- |
| 1. prerequisites | The checks from `tapdance worker check` (Node.js 22.13+, Android SDK with command-line tools, platform-tools, emulator, a system image, KVM on Linux; Xcode and an iOS runtime on macOS), plus a JDK check. On Linux it also reads the DMI vendor strings: a cloud VM without `/dev/kvm` is reported as unable to host Android emulators (nested virtualization is off). It **installs nothing**: if neither Android nor iOS is usable it stops and prints the install commands, with Homebrew lines on macOS. |
| 2. account | The guard's own refusals: not as root, not while this worker has joined a gateway, and not from a macOS administrator account unless you pass `--allow-admin-account`. On an admin account it stops, explains the risk, and prints the exact command to run again. Nothing has changed at this point. |
| 3. worker | Same as `tapdance worker install --service`: the bundled Simlock worker on loopback, agent-device, streaming and input on, restarted, and Simlock's login service installed. On a re-run, when the worker answers and the guard service is running, it is left alone, because a restart would end the sessions of an agent using this host. |
| 4. guard service | Same as `tapdance worker guard install`: a LaunchAgent (macOS) or systemd user unit (Linux) that runs `worker guard start` at login and restarts it; then it waits until the guard answers on `127.0.0.1:4720`. A running service with an unchanged file is left alone (the guard keeps lease ownership in memory). It refuses while a `worker guard start` in a terminal holds the port. |
| 5. pairing | Issues a guard token labelled with this machine's hostname (or `--label`), after you confirm at the terminal (`--yes` skips the prompt; without a terminal it needs `--yes`). The token is written to `~/.tapdance/worker/pairing-<label>.token` with mode 600 and is **never printed**. If a valid token file for that label exists, it is kept; `--repair` revokes it and issues a new one. Tokens expire after `limits.tokenDays` (7 days by default); after that, `host up` issues a new one. |
| 6. tailscale | If `tailscale` is installed and logged in, it exposes the guard on this machine's MagicDNS name. With HTTPS certificates on the tailnet (`CertDomains` in `tailscale status --json`) it runs `tailscale serve --bg --https=4720 http://127.0.0.1:4720` and the endpoint is `https://…`; without them (the default on many tailnets) it runs `tailscale serve --bg --http=4720 …` and the endpoint is `http://<mac>.<tailnet>.ts.net:4720`, which travels inside the tailnet's WireGuard encryption and which `connect` accepts. Otherwise (or with `--no-tailscale`) it prints what to do and the endpoint stays `http://127.0.0.1:4720`, which only this machine can use. `host status` shows which mode is served; `host down` turns off either. |
| 7. self-test | Through the guard, with the new token: lists the devices, leases an Android device (iOS if there is no Android), takes a screenshot and releases it. `--skip-self-test` keeps only the device list. The first boot of a device can take minutes, and the lease waits (up to 5 minutes) while an agent holds the guard's only session (`limits.maxSessions` is 1 by default). |
| 8. summary | Prints the block below. |

```text
TAPDANCE HOST READY
endpoint:  https://my-mac.tail1234.ts.net:4720
token:     written to /Users/me/.tapdance/worker/pairing-my-mac.token (mode 600) — send it to your agent privately
devices:   android 34 (google_apis_playstore), ios 26.5
self-test: PASS (android lease, screenshot ok)
on the agent machine:  tapdance connect https://my-mac.tail1234.ts.net:4720 < pairing-my-mac.token
```

Copy the token file to the agent's machine over a private channel (`scp`, your password manager), not
through chat or a repository.

### Options

| Option | Meaning |
| --- | --- |
| `--label <name>` | Name of the pairing, shown in `tapdance worker guard tokens`. Default: the hostname. |
| `--allow-admin-account` | Run the guard from a macOS administrator account. Not recommended; see below. |
| `--no-tailscale` | Leave `tailscale serve` alone; the endpoint stays on loopback. |
| `--keep-awake` | macOS: run the guard under `caffeinate -i` (see [Keep the guard running](../security/personal-mac.md#keep-the-guard-running)). |
| `--repair` | Revoke the pairing with this label and issue a new token. |
| `--skip-self-test` | Do not lease a device at the end. |
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

1. Reads the token from stdin (or a hidden prompt), never from the command line.
2. Writes `provider: "self-hosted"` and the endpoint to `~/.tapdance/config.json`, keeping your other
   settings, and saves the token to `~/.tapdance/credentials.json` (mode 600) bound to that endpoint:
   Tapdance sends it nowhere else. This is the per-user equivalent of
   `tapdance init --mode self-hosted --endpoint <url> --yes` followed by `tapdance config set-token --endpoint <url>`;
   a project's own `tapdance.config.json` still wins inside that project, and `connect` warns when the
   current directory has one.
3. Runs `tapdance doctor` (without the local host checks) and exits 10 if a check fails.
4. Prints the MCP setup for Claude Code, Codex and Cursor, using `tapdance` if it is on `PATH`, or
   the absolute Node.js and CLI paths otherwise. See [agents/](../agents/) for the details, including
   `TAPDANCE_SESSION_ID` for Codex and Cursor.

The agent's machine can be macOS, Linux or Windows. It needs Node.js 22.13+ and Tapdance, and must be
in the same tailnet as the host.

## Check and stop

```bash
tapdance host status            # each step's state on this machine, and the endpoint
tapdance host down              # remove the guard service and `tailscale serve` for :4720
tapdance host down --revoke     # also revoke every paired control machine and delete the token files
```

`host down` asks first (`--yes` skips the question). It leaves the Simlock worker running for local
agents; stop it with `tapdance worker stop`.

## Starting from nothing: `scripts/host-setup.sh`

On a Mac or Linux machine with nothing installed:

```bash
curl -fsSL https://raw.githubusercontent.com/mirzemehdi/tapdance/main/scripts/host-setup.sh | bash -s -- --label my-mac
```

(While the repository is private, someone with access fetches it with `gh api
repos/mirzemehdi/tapdance/contents/scripts/host-setup.sh -H "Accept: application/vnd.github.raw" | bash
-s -- --label my-mac`, or clones it and runs `bash scripts/host-setup.sh`; `TAPDANCE_REPO` takes an SSH URL.)

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
   Only Linux system packages (git, unzip), Tailscale and the kvm group use `sudo`. Tailscale comes from
   Homebrew (`brew install --cask tailscale`) on macOS or tailscale.com's installer on Linux; logging in
   is yours. It writes `~/.tapdance/env.sh` (PATH, `JAVA_HOME`, `ANDROID_HOME`) and sources it from
   your `.zshrc`/`.bashrc`.
3. **Installs Tapdance from source** if the `tapdance` command is missing: clones to `~/tapdance`
   (`TAPDANCE_SOURCE_DIR`, `TAPDANCE_REPO`, `TAPDANCE_REF`), puts Corepack's `pnpm` shim in
   `~/.local/bin` (no sudo), builds, and links `~/.local/bin/tapdance`.
4. **Runs `tapdance host up`** with your other arguments.

Its own options: `--yes`, `--check`, `--skip-prerequisites`, `--prerequisites-only`,
`--no-system-image`.

Run so far: the check and the install of Node.js, the Android command-line tools, platform-tools and
the emulator into a scratch home on macOS (2 min 13 s), the Temurin download, and a fresh clone and
build with only that Node.js. Not yet run: the system image download, Linux, and `host up` end to end.

## Windows

Windows cannot host devices: Simlock workers run on macOS and Linux only, and `tapdance host up`
refuses with `NOT_SUPPORTED`. Windows can be the agent's machine (`tapdance connect`).
`scripts/host-setup.ps1` prints these options, including Android emulators inside WSL2 or a Linux VM
with nested virtualization (untested).

## Cloud VMs

A cloud VM can host Android emulators only with nested virtualization (for example a Google Cloud N2
VM created with `--enable-nested-virtualization`; see [google-cloud-n2.md](google-cloud-n2.md)). On a
VM without `/dev/kvm`, `host up` says so in step 1 and stops; Tapdance never falls back to software
emulation. In that case keep the VM as the agent's machine and host the devices on your Mac.

## Related

- [Device-only mode and the worker guard](../security/personal-mac.md)
- [Your laptop as a worker (gateway mode)](laptop-worker.md)
- [Self-hosted overview](self-hosted-overview.md)
