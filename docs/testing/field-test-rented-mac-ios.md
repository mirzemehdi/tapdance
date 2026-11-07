# Field test: iOS on a rented Scaleway Mac mini, end to end

> **Run twice** on a Scaleway Mac mini M1-M: from the owner's Mac (2026-11-06/07,
> [evidence](evidence/2026-11-06-rented-mac-ios.md)) and from a Linux VPS as the agent's machine
> (2026-11-07, [evidence](evidence/2026-11-07-vps-rented-mac-ios.md)). The VPS run found that checkpoints
> A and B of the VPS variant assumed the owner has a second machine; both now have a VPS-only path
> ([#126](https://github.com/mirzemehdi/tapdance/issues/126), [#127](https://github.com/mirzemehdi/tapdance/issues/127)).

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
| 2 | Rent the Mac mini in the console (or `scw apple-silicon server create`), turn on automatic deletion, add the SSH key (when the agent runs on a VPS: **the VPS's public key too**, see the variant below) | Owner | T0 |
| 3 | **ASK**: install an iOS runtime (`xcodebuild -downloadPlatform iOS`, about 8 GB) and, if needed, another Xcode with `xcodes` (owner types the Apple ID and the 2FA code) | Owner approves; owner types | Host setup |
| 4 | **ASK**: create the standard worker account and set auto-login for it (owner types its password) | Owner approves; owner types | Host setup |
| 5 | **ASK**: `host-setup.sh` / `host up` on the Mac (starts the worker and guard services) | Owner approves | Host setup |
| 6 | Log the Mac into the tailnet (open the link it prints) and approve the pairing | Owner | Host setup |
| 7 | **ASK**: each reboot of the Mac (`sudo shutdown -r now`) for the come-back test | Owner approves | Host setup |
| 8 | Host builds only: log `gh` in on the Mac with a fine-grained, read-only token for the Pianolune repository (no second machine: through the console's VNC terminal, see the variant below) | Owner types it | Before the build |
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

Read-only; the owner runs it with their own `scw` login. An agent's machine without the `scw` CLI and
the owner's Scaleway credentials (a Linux VPS, as in stage 4) exits 2 ("could not check"): there it is an
owner step, run on a machine where `scw init` was done, and the agent records "to be run by the owner".
Never ask the owner to hand over Scaleway keys for it.

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
Optional: both app checklists also install from CI (step `install_from_ci`) when you pass
`--param CI_REPO=<owner/repo> --param CI_ARTIFACT=<artifact>` (a simulator `.app` artifact; the owner runs
`tapdance host artifacts enable --repo <owner/repo>` on the Mac first). iOS installs from CI are
unit-tested only so far (STATUS F-05). Whatever stops a run, its release step still runs
(`"always": true` / `always=1`), so no lease is left behind.

Prove the leases come from the Mac: the lease reply's `Provider: Remote worker` and endpoint, and the
guard's audit log on the Mac (`tail ~/.tapdance/worker/audit.log`).

## Variant: the agent runs on a Linux VPS

The same Mac, driven from a Linux VPS in the same tailnet. Run on 2026-11-07
([evidence](evidence/2026-11-07-vps-rented-mac-ios.md)): all six checklists passed. The VPS gets ssh
access to the Mac for the pairing and the app zip; the owner keeps two steps, authorizing the VPS's key
on the Mac (checkpoint A) and the GitHub token (checkpoint B). **When the VPS is the owner's only
machine** (it was on 11-07) there is no "own machine" to run them from; use these paths instead:

- **Checkpoint A, ssh key.** Best: add the VPS's public key when renting (checkpoint 2, console SSH
  keys or `scw … create`), then nothing is left to do. Otherwise the owner opens the Mac's desktop from
  the Scaleway console (web VNC), opens Terminal and appends the key line to `~/.ssh/authorized_keys`.
  Last resort, as on 11-07: the owner gives the agent the Mac's ssh password **once** and the agent runs
  `ssh-copy-id -i ~/.ssh/rented-mac.pub m1@<mac-ip>` (or `cat … | ssh m1@<mac-ip> 'cat >> ~/.ssh/authorized_keys'`).
  Without `sshpass` on the VPS, feed the password through `SSH_ASKPASS` (a throwaway script that prints
  it, `SSH_ASKPASS_REQUIRE=force`, `DISPLAY=:0`, run with `setsid`), never on a command line; delete the
  script afterwards. Tailscale SSH is not on by default on the host (`Host key verification failed`);
  setting the host up with `host-setup.sh … --tailscale-ssh` (or `tapdance host up --tailscale-ssh`)
  turns it on, after which the VPS reaches the Mac as `ssh m1@<mac>.<tailnet>.ts.net` with no key at all
  (not yet run). [#126](https://github.com/mirzemehdi/tapdance/issues/126)
- **Checkpoint B, GitHub access.** Best without a second machine: a **deploy key made on the Mac**, so
  no secret leaves it ([#127](https://github.com/mirzemehdi/tapdance/issues/127)). The agent runs
  `tapdance host builds key --repo git@github.com:<owner>/<repo>.git` on the Mac, which prints only the
  public key and the repository's deploy-keys page; the owner adds it there, read-only, from any browser
  (a phone works), and the agent allows the ssh URL with `--git-auth deploy-key`. It covers host builds
  only (installs from CI still need `gh` with Actions read), and organizations can turn deploy keys off.
  The deploy key is unit-tested only and has not yet been run on a rented Mac (STATUS H-13); the token
  route through `host gh-login` is the one that ran (11-07). For a token instead: the owner runs `tapdance host gh-login` in the Terminal of the console's VNC
  desktop and pastes it there, so the agent never sees it. If the owner pastes the token into the
  agent's chat anyway (11-07), the agent must pipe it over ssh stdin to `tapdance host gh-login` without
  printing it, delete any temporary file, and say that the token passed through the chat; the owner
  should then revoke it after the run.

On the VPS `pnpm` may not be installed system-wide: `corepack enable --install-directory ~/.local/bin`
and `export PATH=$HOME/.local/bin:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0`. Prompt for the agent on the
VPS (fill in the Mac's address, its tailnet endpoint and your app):

```text
Repeat stage 3 of docs/hosting-plan.md from this Linux VPS as the agent's machine, against the rented
Mac mini that is already set up as an iOS host (m1@<mac-ip>). Mind its deletion time; finish an hour
before it. Read CLAUDE.md, AGENTS.md, STATUS.md, docs/testing/field-test-rented-mac-ios.md and the
latest docs/testing/evidence/*-rented-mac-ios.md first.

Setup on this VPS
- Clone mirzemehdi/tapdance (main), pnpm install && pnpm build. Use a scratch TAPDANCE_HOME (never
  ~/.tapdance) and TAPDANCE_SESSION_ID=vps-cli / vps-mcp. Check this VPS is in the owner's tailnet
  (`tailscale status` lists the Mac); if not, ask the owner to run `sudo tailscale up` here.

Checkpoint A, owner: ssh access to the Mac
- Create a key for this run (ssh-keygen -t ed25519 -f ~/.ssh/rented-mac -N "" -C vps-stage3), or reuse
  the one added when the Mac was rented, and give the owner the public key. Ask whether they have
  another machine with ssh access to the Mac. If yes, give them:
    ssh m1@<mac-ip> 'cat >> ~/.ssh/authorized_keys' <<< '<public key>'
  If not, they add the line from the Scaleway console's VNC desktop (Terminal), or, last resort, give
  you the Mac's ssh password once for `ssh-copy-id` (through SSH_ASKPASS when sshpass is missing;
  never on a command line, never printed). See "Variant: the agent runs on a Linux VPS" in the runbook.
  Wait until they confirm, then check `ssh -i ~/.ssh/rented-mac m1@<mac-ip> 'tapdance host status'`.

Checkpoint B, owner: GitHub access for host builds
- Preferred, no token anywhere (unit-tested only; not yet run on a rented Mac): on the Mac run
    tapdance host builds key --repo git@github.com:<owner>/<repo>.git
  and give the owner the public key it prints and the deploy-keys page it names. The owner adds it there
  with "Allow write access" off and tells you when. Then allow the ssh URL:
  `tapdance host builds enable --repo git@github.com:<owner>/<repo>.git --git-auth deploy-key --protected-ref main --allow-admin-account`,
  and use that ssh URL as BUILD_REPO. If adding the key fails ("Deploy keys are disabled"), or installs
  from CI are wanted too, use a token:
- Token: the owner creates a fine-grained token (the app's repository only, Contents read-only, short
  expiry) and runs `tapdance host gh-login` on the Mac: from another machine with
  `ssh -t m1@<mac-ip> 'tapdance host gh-login'`, or in the Terminal of the console's VNC desktop.
  Do not ask for the token. If the owner pastes it to you anyway, pipe it over ssh stdin to
  `tapdance host gh-login` without printing it, delete any temporary copy, and record the deviation.
  Afterwards `host status` must show `gh ok`, and the repository must be allowed:
  `tapdance host builds enable --repo <https url> --git-auth gh --protected-ref main --allow-admin-account`.

Pairing (yours, after the owner says "approve the pairing")
- ssh -i ~/.ssh/rented-mac m1@<mac-ip> 'tapdance host up --label vps-agent --allow-admin-account --skip-self-test --yes'
- scp the token file .tapdance/worker/pairing-vps-agent.token into your scratch folder (chmod 600),
  `tapdance connect https://<mac>.<tailnet>.ts.net:4720 < <that file>`. Never print the token.
  `tapdance doctor` must pass (Android is a warning on an iOS-only host).
- `host up` keeps any pairing an earlier run left on the host; list them with
  `tapdance worker guard tokens` and tell the owner which are still active.
- On an 8 GB Mac: ssh -i ~/.ssh/rented-mac m1@<mac-ip> 'tapdance host warm android=0,ios=0' before the
  checklists (no warm spare; a second simulator does not fit).

Checklists (scripts/field-test/, --param DEVICE="iPhone 17" --param OS=<runtime>), one at a time: an
8 GB Mac holds one simulator and the guard one session
  1. cli-checklist.sh base (--param PLATFORM=ios) and mcp-ios-base.json;
  2. the host build of your app (BUILD_REPO, BUILD_REF=main, BUILD_PROJECT, BUILD_SCHEME, APP_ID):
     cli-checklist.sh build and mcp-ios-build.json;
  3. app checklists with an upload: on the Mac, zip the host's newest build
     (ditto -c -k --keepParent "$(ls -td ~/.tapdance/worker/builds/*/kept/*/<App>.app | head -1)" ~/td-run/vps-app.zip),
     scp it here, then cli-checklist.sh app and mcp-ios-app.json with --param APP=<that zip>.
  A cold lease takes about 77-143 s on an M1; the first command after it 30-90 s; one iOS inspect can
  stall about 90 s on a swapping 8 GB host (#128). Always set TAPDANCE_SESSION_ID: without it the CLI
  uses your coding agent's own session id. Run each checklist with nohup and a log file, and keep this
  VPS online.
- Prove every lease comes from the Mac (Provider: Remote worker, the endpoint; the guard's audit log
  ~/.tapdance/worker/audit.log on the Mac). Record lease times, first-command latency, upload time,
  build reuse, tap/key latency, and every failure with its exact output.

Rules
- Tool bugs only; the app's own quirks are not ours. Fix what you can in a branch and open a PR; file
  issues on mirzemehdi/tapdance for the rest. Merge nothing. Commit with the owner's git identity, no
  AI attribution. Never print tokens (tdg_, slk_, github_pat_, pairing files).
- Ask the owner before anything that costs money, reboots the Mac or changes it beyond the pairing.

Finish
- Write docs/testing/evidence/<date>-vps-rented-mac-ios.md; update STATUS.md Q-08 (Linux VPS as the
  agent's machine) and this runbook where a step was wrong.
- Clean up: `tapdance device release`; on the Mac `tapdance worker guard revoke <vps-agent id>` (id from
  `tapdance worker guard tokens`), delete ~/td-run/vps-app.zip, and remove your key's line from
  ~/.ssh/authorized_keys; here delete the token copy, the scratch home and ~/.ssh/rented-mac*. If a
  GitHub token passed through the chat, remind the owner to revoke it; with a deploy key, run
  `tapdance host builds key --repo <ssh url> --remove` on the Mac and remind the owner to delete the key
  on the repository's deploy-keys page.
- Report the results table, the PR or issues, and the clean-up done.
```

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
