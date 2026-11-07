# Field test: iOS on a rented Scaleway Mac mini, end to end

> **Run once (2026-11-06/07)** on a Scaleway Mac mini M1-M from the owner's Mac
> ([evidence](evidence/2026-11-06-rented-mac-ios.md)). A Linux VPS as the agent's machine follows the same
> steps (the agent's side is `tapdance connect` and the drivers in `scripts/field-test/`); not run yet.

The agent's machine (a Mac or a Linux VPS) drives iOS simulators on a Mac mini rented from Scaleway,
over Tailscale, through the worker guard (`host up` → `connect`). This runbook is the rented-Mac
counterpart of [field-test-cloud-android.md](field-test-cloud-android.md): the same ground rules,
checkpoints and resource log, with the differences a rented Mac brings.

**What is different from the N2 VM:**
- **It cannot delete itself early.** Scaleway refuses deletion until 24 hours after creation
  (Apple's macOS licence) and bills until it is deleted, **also while it is powered off**. There is no
  idle stop (`--idle-stop` is refused on macOS, and stopping would not stop billing anyway). The
  safety net is Scaleway's **scheduled deletion**: turned on at creation, Scaleway deletes the Mac
  mini as soon as the 24 hours are up.
- Access is SSH (and VNC for a desktop), as the admin user `m1`; nobody is at the screen.
- The Mac comes with Xcode (the newest one its macOS supports), MacPorts and `scw-agent`; no
  Homebrew. MDM profiles block some admin actions, SIP cannot be turned off, FileVault is off.

## Ground rules

- Ask the owner at every **ASK** checkpoint below; never rent, extend or reboot without a yes.
- Never ask for, print or store the owner's Scaleway credentials, Apple ID, GitHub token, the Mac's
  sudo/VNC password, or Tapdance tokens (`slk_`, `tdg_`, pairing files). The Scaleway API returns the
  sudo password and a VNC URL with the password in it: never paste `scw ... get` output anywhere.
- The agent's machine uses a scratch `TAPDANCE_HOME` and its own `TAPDANCE_SESSION_ID`; its own
  Tapdance host (if any) stays untouched.
- Prove every lease comes from the rented Mac (the endpoint in `doctor`, the device's host in the
  lease reply, `worker status` on the rented Mac).
- Record each resource in the resource log when it is created.

## Checkpoints

| # | Checkpoint | Who | When |
| --- | --- | --- | --- |
| 1 | **ASK**: this plan: offer (M1-M), zone, macOS version, scheduled deletion on, the cost, the account question, and that teardown is part of the run | Owner approves | Before renting |
| 2 | Rent the Mac mini in the console (or `scw apple-silicon server create`), turn on automatic deletion, add the SSH key | Owner | T0 |
| 3 | **ASK**: install an iOS runtime (`xcodebuild -downloadPlatform iOS`, about 8 GB) and, if needed, another Xcode with `xcodes` (owner types the Apple ID and the 2FA code) | Owner approves; owner types | Host setup |
| 4 | **ASK**: create the standard worker account and set auto-login for it (owner types its password) | Owner approves; owner types | Host setup |
| 5 | **ASK**: `host-setup.sh` / `host up` on the Mac (starts the worker and guard services) | Owner approves | Host setup |
| 6 | Log the Mac into the tailnet (open the link it prints) and approve the pairing | Owner | Host setup |
| 7 | **ASK**: each reboot of the Mac (`sudo shutdown -r now`) for the come-back test | Owner approves | Host setup |
| 8 | Host builds only: log `gh` in on the Mac with a fine-grained, read-only token for the Pianolune repository | Owner pastes it | Before the build |
| 9 | **ASK**: anything that extends the run (cancelling scheduled deletion, a second Mac, a bigger offer) | Owner approves | Any time |
| 10 | Teardown: release, `host down --all`, sign out of the Apple ID, delete the Mac mini (or let scheduled deletion do it), leftovers check, Tailscale machine, GitHub token, pairing files | Agent runs what it can; owner the rest | Before T0+24 h, also after a failure |

## Costs

Scaleway's published prices, read on 2026-11-06, excluding VAT (20 % in France):

| Item | Cost | Bills while |
| --- | --- | --- |
| Mac mini **M1-M** (Apple M1, 8 CPU / 8 GPU cores, **8 GB RAM**, 256 GB SSD, 1 Gbps) | EUR 0.11/hour, EUR 75/month; **24-hour minimum: EUR 2.64** (EUR 3.17 with VAT) | from creation until deletion, also powered off |
| Mac mini M2-M (16 GB RAM, 256 GB) for comparison | EUR 0.17/hour; 24 h: EUR 4.08 | same |
| Disk | included (256 GB, cannot be extended) | |
| Public IPv4 and traffic | included; the pricing page lists no per-GB price, 1 Gbps port | |
| Private Network for Apple silicon | EUR 0.03/hour, **not used** (Tailscale instead) | only if enabled |
| Tailscale, Apple ID, GitHub token | free | |

A run that ends within the first 24 hours costs EUR 2.64 + VAT. Each further started hour is EUR 0.11.

## Resource log

| Resource | Name / id | Created (UTC) | How to delete | Deleted (UTC) |
| --- | --- | --- | --- | --- |
| Mac mini | `tapdance-m1` (id from the console) | | owner: console Delete, or `scw apple-silicon server delete <id> zone=<zone>` after `deletable_at`; scheduled deletion does it at T0+24 h | |
| Scheduled deletion | on the Mac mini | | owner: turned on at creation; `scw apple-silicon server update <id> schedule-deletion=false` cancels it (checkpoint 9) | |
| SSH key in the Scaleway project | name only | | owner: console, Project > SSH keys (keep it if you use it elsewhere) | |
| Apple ID session on the Mac (only if `xcodes` was used) | the Apple ID's name only | | `xcodes signout` on the Mac; owner: appleid.apple.com > Devices if it shows | |
| Tailscale machine | `tapdance-m1` | | owner: Tailscale admin console, Machines | |
| GitHub fine-grained token | name only, never the value | | owner: GitHub settings, Developer settings | |
| Pairing token copies | file paths on the agent's machine | | `rm` | |
| Scratch `TAPDANCE_HOME` on the agent's machine | path | | `rm -rf` | |

Deleting the Mac mini wipes its disk, so everything on it (Xcode session, `gh` login, the worker
account, tokens, caches) goes with it. The rows above are what lives **outside** the Mac.

## Timeline

| When | What |
| --- | --- |
| T0 | Rent, scheduled deletion on, SSH in. Note `deletable_at`. |
| T0 → +1 h | Xcode check, iOS runtime install, worker account, auto-login, no sleep |
| +1 → +3 h | `host-setup.sh` → `host up`; services over plain `ssh host 'cmd'` and an interactive shell; reboot with nobody logged in; worker, guard and Tailscale back |
| +3 → +8 h | From the agent's machine: `connect`, the CLI and MCP checklists, the host build of Pianolune, the CI artifact install, measurements |
| +8 → +20 h | Fixes, re-runs, docs |
| **+20 h at the latest** | Teardown steps and leftovers check to the owner; release everything |
| +24 h | Scaleway deletes the Mac mini (scheduled deletion); the owner runs the leftovers check until it exits 0 |

## Leftovers check

Read-only; the owner runs it with their own `scw` login:

```bash
infrastructure/scripts/scaleway-leftovers.sh
```

It lists Apple silicon servers in every zone (any state) and Private Networks, printing names, ids,
types, states and `deletable_at` only (never the VNC URL or sudo password the API also returns). Exit
0: nothing left; 1: something is left (the delete commands are printed); 2: could not check.

## Setup on the Mac (checkpoints 2-8)

Everything below runs from the agent's machine over ssh; `ssh -t` where a password or a question is
typed. Use the owner's key: `ssh -i ~/.ssh/<key> m1@<mac-ip>`.

1. **Survey, read-only:** `sw_vers; xcodebuild -version; xcrun simctl runtime list; df -h /;
   launchctl print gui/$(id -u)` (missing: nobody logged in).
2. **Xcode and a runtime (checkpoint 3):** `ssh -t mac 'sudo xcodebuild -runFirstLaunch'`, then
   `ssh mac 'xcodebuild -downloadPlatform iOS -architectureVariant arm64'` (8 GB, under 2 min). The
   script in step 4 does both too.
3. **Automatic login (checkpoint 4, the owner types the password twice):** copy
   `infrastructure/scripts/macos-auto-login.sh` over and run `ssh -t mac 'bash macos-auto-login.sh m1'`.
   The owner presses **Reboot** in the console (no password); afterwards `who` lists `m1` on `console`.
4. **Host setup (checkpoints 5-6):**

   ```bash
   ssh -t mac 'curl -fsSL https://raw.githubusercontent.com/mirzemehdi/tapdance/main/scripts/host-setup.sh -o host-setup.sh && script -q setup.log bash host-setup.sh --ios-only --with-gh --allow-admin-account --label <agent>'
   ```

   `script` keeps a terminal for the prompts and logs the run for the timings. Add `--android-build-sdk`
   when the test app is Kotlin Multiplatform. The owner answers the install question, types the sudo
   password (MacPorts installs), opens the Tailscale login link, and approves the pairing.
5. **8 GB Macs:** `ssh mac 'tapdance host warm android=0,ios=0'` before the checklists.
6. **Token to the agent's machine:** `scp mac:.tapdance/worker/pairing-<agent>.token <scratch>/` (mode 600; never
   print it).
7. **Host builds (checkpoint 8):** the owner logs `gh` in with a hidden read
   (`ssh -t mac 'tapdance host gh-login'`; `gh auth login --with-token` alone echoes the token), then
   `ssh mac 'tapdance host builds enable --repo https://github.com/<owner>/<repo> --git-auth gh --protected-ref main --allow-admin-account'`.

## Connect and run the checklists

On the agent's machine, with a scratch home and its own session ids; keep it awake for the whole run
(a laptop that sleeps stops renewing the lease and stalls every connection):

```bash
export TAPDANCE_HOME=<scratch>/td-home
node packages/cli/dist/main.js connect https://<mac>.<tailnet>.ts.net:4720 < <scratch>/pairing-<agent>.token
P=(--param DEVICE="iPhone 17" --param OS=<runtime>)
TAPDANCE_SESSION_ID=field-cli scripts/field-test/cli-checklist.sh base out/cli-base --param PLATFORM=ios "${P[@]}"
TAPDANCE_SESSION_ID=field-mcp node scripts/field-test/mcp-checklist.mjs scripts/field-test/checklists/mcp-ios-base.json out/mcp-base "${P[@]}"
B=(--param BUILD_REPO=https://github.com/<owner>/<repo> --param BUILD_REF=main --param BUILD_PROJECT=<path>.xcodeproj --param BUILD_SCHEME=<scheme> --param APP_ID=<bundle id>)
TAPDANCE_SESSION_ID=field-cli scripts/field-test/cli-checklist.sh build out/cli-build --param PLATFORM=ios "${P[@]}" "${B[@]}"
TAPDANCE_SESSION_ID=field-mcp node scripts/field-test/mcp-checklist.mjs scripts/field-test/checklists/mcp-ios-build.json out/mcp-build "${P[@]}" "${B[@]}"
```

For the app checklists, zip the host's build (`ssh mac 'cd <kept build dir> && ditto -c -k --keepParent <App>.app ~/app.zip'`,
the folder is under `~/.tapdance/worker/builds/*/kept/`), `scp` it over, and pass `--param APP=app.zip
--param APP_ID=<bundle id>` to `cli-checklist.sh app` and `mcp-ios-app.json`. That also tests the upload.

Prove the leases come from the Mac: the lease reply's `Provider: Remote worker` and endpoint, and the
guard's audit log on the Mac (`tail ~/.tapdance/worker/audit.log`).

## Reboot (checkpoint 7)

The owner presses **Reboot** in the console. Then, without logging in anywhere:
`ssh mac 'who; tapdance host status'` (every row `ok`, `tailscale … serving :4720`), and from the
agent's machine `tapdance doctor` and one lease.

## Measurements to record

| What | Where it comes from |
| --- | --- |
| macOS install, runtime download, `host-setup.sh` time | the console, `runtime.log`, `setup.log` timestamps |
| Reboot → ssh, reboot → `host status` all ok | your clock |
| Lease: cold, from a warm spare, right after a release | the `lease` steps |
| First command after a lease, tap, key, inspect, screenshot | the drivers' tables |
| Host build: first, reused | the `build` steps |
| Memory and swap per simulator | `top -l 1 -n 0 \| grep PhysMem; sysctl vm.swapusage` on the Mac |
| Disk | `df -h /` before and after |
| Cost | the Scaleway billing page after deletion |

## Teardown (checkpoint 10)

1. On the agent's machine: `tapdance device release` for each session.
2. Scheduled deletion removes the Mac mini at T0+24 h; to delete as soon as allowed, console **Delete**
   or `scw apple-silicon server delete <id> zone=<zone>` after `deletable_at`.
3. The owner runs `infrastructure/scripts/scaleway-leftovers.sh` until it exits 0.
4. The owner removes the Tailscale machine, revokes the GitHub token, and deletes the token copies and the
   scratch home on the agent's machine. Deletion wipes everything on the Mac itself.
5. Write the final state and cost into the evidence record.
