# Field test: iOS on a rented Scaleway Mac mini, end to end

> **Draft, written before the first run (2026-11-06).** It is the plan the owner approves before
> anything is rented. Sections marked _(after the run)_ are filled in from the evidence record.

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

## Setup, checklists, measurements _(after the run)_

Filled in from the evidence record: the exact commands, in order, that worked on a blank Mac mini.
