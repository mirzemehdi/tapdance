# Evidence: bring your own cloud, self-run — 2026-11-09

Step 5.1 of [docs/hosting-plan.md](../../hosting-plan.md): `tapdance machine create / list / stop /
start / destroy` and auto mode (`tapdance machine auto`), run for real against the owner's Google Cloud
account from the owner's Mac as the agent's machine. A Claude Code session drove the commands and the
scripted CLI and MCP checklist drivers (`scripts/field-test/`); the owner created nothing by hand,
linked billing on request and approved each machine in Tailscale. The same run covered the Android part
of [#153](https://github.com/mirzemehdi/tapdance/issues/153) (0.2.x on a real host) and checked the
0.2.1 worker guard fix with a real install.

Later that day (14:39–15:35 UTC) the iOS half ran on a Scaleway Mac mini the owner had rented in the
console: `machine create --cloud scaleway --server-id` set it up and connected it, and the iOS checklists
and the iOS items of #153 ran on it ([Scaleway](#scaleway-ios)). **Not run:** renting a Mac with `create`
itself (the rent step, Scaleway's macOS install wait, the project ssh key, scheduled deletion) and
Scaleway's `destroy`: the owner kept the Mac for the rest of its paid day. Step 5.1 stays open in the
hosting plan until the rent path has run.

## Environment

| | |
| --- | --- |
| Agent's machine | The owner's MacBook (macOS), Node.js 22.22.0, gcloud 592.0.0, Tailscale 1.104.5. Tapdance branch `feat/machine-byoc` (0.2.1 plus this change, `packages/cli/dist/main.js`). Its own Tapdance host untouched: every command ran with a scratch `TAPDANCE_HOME` and its own `TAPDANCE_SESSION_ID`; no `simctl` or local worker was used |
| Cloud | A project made for the run, `tapdance-byoc-1109-03dd` (`gcloud projects create`, billing linked to the owner's billing account at their request). Zone `europe-west1-b`. The owner's gcloud default project and quota project (another project) were left as they were: Tapdance passed `--project` and, for ssh/scp, `--billing-project` |
| Machines | `n2-standard-4`, Ubuntu 24.04, 64 GB pd-balanced, nested virtualization, no service account, OS Login, Shielded VM, `--max-run-duration=8h` with STOP, a network `tapdance-android` whose one firewall rule lets only IAP's `35.235.240.0/20` reach port 22. Labels `tapdance-machine=android`, `created-by=tapdance` |
| Tapdance on the machines | `tapdance-cli@0.2.1` from npm (`host-setup.sh --tapdance-version 0.2.1`), Simlock 0.6.0, agent-device 0.21.36, emulator 37.2.13, `android-34;google_apis;x86_64`, Pixel 8 |
| Network | The owner's tailnet with HTTPS certificates; guards behind `tailscale serve` (TLS) on port 4720 |
| Window | 00:17–02:32 UTC |

## Runs

| Run | What happened |
| --- | --- |
| 1 | `machine create` on Tapdance v0.2.0. Stopped by me at step 5 when 0.2.1 was released (the owner asked for 0.2.1), then removed with `machine destroy`: VM, disk, firewall rule, subnet and network in 110 s; `gcp-leftovers.sh` exit 0. Found: `destroy` told the owner to remove a Tailscale node that had never joined (fixed) |
| A | `machine create` with 0.2.1 from npm. Step 5 failed twice and was fixed and resumed: the emulator needs **`libnss3`**, which Ubuntu 24.04's cloud image lacks (added to `host-setup.sh` and `doctor`'s hint); then the self-test emulator exited because the **systemd user manager had no `kvm` group** (it started before host-setup added the user; host-setup's `setfacl` workaround needs the `acl` package, which the image lacks). Deviation: on this VM I restarted the user manager by hand once; `host-setup.sh` now does it. Then: lease 21 s, screenshot 4.5 s, the demo APK installed **through the guard** in 2.4 s and launched, seven forged installs refused (below), release, `destroy` 123 s, leftovers exit 0 |
| B | A fresh `machine create` with the fixed scripts. Step 5 failed once more: `host up` runs in host-setup's own ssh login, which started before the `kvm` group, so its `/dev/kvm` check failed (fixed: host-setup runs `host up` under `sg kvm`). Resumed; created and connected. Steps: APIs 2 s, network 41 s, VM 11 s, ssh 31 s, setup 3 min 50 s, connect 10 s: **about 5½ minutes** of work plus the owner's Tailscale click. All four checklists, the #153 checks and auto start ran on it (below); `destroy` 106 s |
| upgrade | A machine on v0.1.1 for #153's "upgrade in place" and "mixed versions" checks. Destroyed after its VM came up: the owner decided those checks are not needed, as no 0.1.x hosts are in use |
| auto | Auto mode creating a machine from a lease (below), then idle stop and auto start; `destroy` 110 s |

Every run ended with `machine destroy`. After the last one: `infrastructure/scripts/gcp-leftovers.sh
tapdance-byoc-1109-03dd` exit 0 (no instances, disks, snapshots, images, addresses, forwarding rules,
routers or buckets), `machine list` empty, auto mode off.

## Checklists on run B (0.2.1 host, through the guard)

| Driver | Result | Lease |
| --- | --- | --- |
| MCP `mcp-base.json` (`LAUNCHER_TAP=Chrome`) | **24/24** | 23.6 s |
| MCP `mcp-app.json` (demo APK, `dev.tapdance.demo`) | **22/22**, 7 skipped (CI artifact, tap/type targets, debuggable sandbox) | 38.1 s |
| CLI `base` | **25/25** | 35.7 s |
| CLI `app` (install, uninstall) | **23/23**, 8 skipped (same) | 36.8 s |

Launcher swipes took 11–17 s, rotations to landscape 17–19 s; other steps 0.1–5 s.

## The 0.2.1 guard fix on a real host

The demo APK went up and was installed through the guard by the CLI (run A) and by MCP and the CLI
checklists (run B). Then a small client (`forged-install.mjs`, not committed) sent install requests a
malicious client might send to the real guard with this computer's real pairing token. All seven
answered **403** and none reached Simlock's `install`:

| Request | Guard's answer |
| --- | --- |
| install a path on the host, no upload id | install needs an app uploaded through this host's guard |
| install `remote:/etc/passwd` | the same |
| reinstall a host path | the same |
| install an upload id this client never made | that upload is not one of yours, or it expired |
| install with a path-traversal upload id | install needs an app uploaded through this host's guard |
| install with an install source URL | install sources are not allowed |
| `diff screenshot` | only `diff snapshot` is allowed |

## #153, Android (Simlock 0.6.0, agent-device 0.21.36)

| Item | Result |
| --- | --- |
| First lease of a device kind | The self-test's lease: about **170 s** ("Starting a device for this lease … 170 s"), under the 330 s lease wait |
| Boot snapshot CPU | `Saving the Android boot snapshot`, `busy: 0.95` |
| #139, busy warm spare | Lease right after a release (warm spare, 18.6 s): guest CPU **96 %**, the settle notice fired and the device was handed out busy after 6 s; first swipe **15.7 s**, second 10.0 s. Lease after the spare idled 5 min (11.6 s): guest CPU 55 % → **settled at 1 % in 8 s**; first swipe 8.2 s, second 6.3 s. A freshly made spare is still busy at hand-out; an idle one settles. Swipes stay 6–8 s even when settled |
| Upgrade in place | **Not run** (owner: no 0.1.x hosts in use) |
| Restart with a spare (#94 patch) | `tapdance worker restart` with one spare ready; the next lease (28 s) got a working device (screenshot, `ui inspect`): PASS |
| `worker cleanup` | After `tapdance worker restart --force` during a lease: "No stale device claims", no error. Whether claims existed before the restart was not checked: **partial**. Observed: right after the forced restart, `device status` on the agent's machine still said `Ready`; `device release` then said the lease "had already ended on the worker" |
| Disk | The seed AVD is 3.0 GB; a full copy on the 64 GB pd-balanced disk took **34.5 s** (about 87 MB/s). Leases from a warm spare do not wait for it |
| `host warm` | `host warm android=1,ios=0` restarted the worker and `host warm` read it back. The read-out shows Simlock's reserved running slots (`android 0, ios 2`: the limit minus the spares asked for), not the spare counts, which reads as wrong at first sight |
| `doctor` | `Simlock version — 0.6.0 (worker mode); Tapdance is tested with 0.6.0` |
| Mixed versions | **Not run** (owner: no 0.1.x hosts in use) |
| Second worker | `SIMLOCK_HOME=~/sl2 tapdance simlock -- daemon start`: refused, "another Simlock worker runs for this user (pid …); stop it first"; the main worker kept serving |
| CLI and MCP checklists | All four Android checklists pass (above) |

## Auto mode

`tapdance machine auto on --platform android --project … --zone europe-west1-b --idle-stop 10 --yes`, then:

| Check | Result |
| --- | --- |
| A lease with the machine stopped (`machine stop android`, 54 s) | "Auto mode: starting machine android"; the guard answered **44 s** after the start; lease 99 s in all, notice "Started machine android for this lease in 44 s" |
| A lease with no machine (after `machine destroy android`) | Answered in **3 s** with `PROVIDER_UNAVAILABLE`, retryable: "Creating machine android for android: a Google Cloud N2 VM … (about 10 minutes in all)", and started `machine create` in the background. A script acting as an agent leased every 60 s; each answer said how many steps were done and, once the setup printed it, carried the Tailscale approval link. The fifth lease after the approval got a device (`tapdance-android-2`), screenshot, release |
| The same create, fresh VM | Steps 2 s, 37 s, 12 s, ssh 92 s, setup 30 min 26 s (about 25 min of it waiting for the approval: I failed to pass the link on to the owner in time), connect 12 s. Its setup log shows `running host up with the kvm group (sg kvm)` and the self-test PASS, with no manual step: the run B fixes work on a clean VM |
| Idle stop | Last activity 02:15:40 UTC; the host powered the VM off at **02:27:08** (11 min 28 s, limit 10 min) |
| A lease after the idle stop | Started the VM; guard answered in **39 s**; lease 97 s in all |

## Scaleway (iOS)

| | |
| --- | --- |
| Mac | The owner's Mac mini **M2-L** (M2 Pro, 16 GB), `apple-silicon-wizardly-shirley`, zone **`fr-par-1`**, rented in the console at 14:39 UTC (24-hour commitment, automatic deletion off). macOS 27.2, Xcode 27.0, iOS 27.0 runtime, iPhone 17 |
| Agent's machine | The owner's Mac, `scw` 2.65.2 (Homebrew; logged in by the owner with `scw init`), scratch `TAPDANCE_HOME` |
| Tapdance on the Mac | `tapdance-cli@0.2.1` from npm, Simlock 0.6.0, agent-device 0.21.36 |

**Finding first:** `scw apple-silicon server list zone=all` returned nothing while this Mac ran in
`fr-par-1`; `zone=fr-par-1` listed it. `scaleway-leftovers.sh` and `machine destroy`'s check used
`zone=all`, so they would have reported "nothing left" while it billed. Fixed: every Mac zone is asked by
name (the script then listed the Mac, `exit 1`). Stock on 2026-11-09: in `fr-par-1` only M4-S (low); in
`fr-par-3` M2-M; M1-M out of stock in both. `create` now rents the cheapest offer in stock unless
`--type`/`--zone` say otherwise.

`tapdance machine create --cloud scaleway --server-id 55b6b4f7-… --label byoc-mac --yes` (new option):

| Step | Time |
| --- | --- |
| ssh key for the Mac (not added to the project: an already rented Mac does not take project keys) | 0 s |
| Use the Mac (nothing rented, deletion schedule unchanged) | 0 s |
| Reach it: the owner's own keys were refused, so Tapdance's key was added with **one password login** (the password from Scaleway's API, handed to ssh through a throwaway `SSH_ASKPASS` helper; never printed or stored); then key login | 3 s |
| Automatic login (`macos-auto-login.sh --password-stdin`), a temporary sudo rule, a restart through `scw`, the console login checked | 2 min 40 s |
| `host-setup.sh --ios-only`: Xcode first launch, the iOS runtime, Tailscale (owner approved the link), `tapdance-cli@0.2.1`, `host up` with the self-test (first iOS lease about 60 s) | 5 min 48 s |
| `connect` | 5 s |
| **In all** | **8 min 37 s** |

Checklists, through the guard on that Mac:

| Driver | Result | Notes |
| --- | --- | --- |
| MCP `mcp-ios-base.json` | **29/30**, re-run **30/30** | The first run's `tap "Settings"` on the Home Screen got `ELEMENT_NOT_FOUND`: right after a fresh boot the accessibility tree held only status-bar items. The CLI tapped it 3 min later, and the re-run passed (5.9 s) |
| MCP `mcp-ios-app.json` (`TapdanceDemo.app`, `dev.tapdance.demo`) | **28/28**, 3 skipped | upload and install 32.7 s; recording, launch with console, launch in de-DE |
| CLI `base` (`PLATFORM=ios`) | **31/31** | |
| CLI `app` | **32/32**, 3 skipped | install 12.7 s; uninstall |

Leases: 1.4–6 s from a warm spare (the 16 GB Mac keeps one), 60–86 s when none was ready (clone and boot).

**#153, iOS:**

| Item | Result |
| --- | --- |
| Simulators | Simlock does not log the clone time on its own; a lease without a ready spare (clone + boot) took 60–86 s, the first lease of the kind about 60 s |
| Landscape taps (#56 patch) | The demo's sign-in in landscape-left: typing into both fields and tapping "Sign in" landed, "Welcome, ada@example.com" in 0.5 s. **Partial**: the demo is a SwiftUI app, not one on the legacy compatibility screen the patch is for |
| agent-device 0.21.36 | `handle_alert get` works (no alert was shown, so handling one was not exercised). A snapshot deeper than 64 levels: **not run** (no such app in the repository) |
| Through the worker guard | A recording, screenshots and an app upload and install: PASS |
| `host warm` / `doctor` | `host warm` read the default spare (`iPhone 17 / 27.0 (learned)`); `doctor` from the agent's machine: target `ios` up, guard answered in 54 ms, agent-device served |

The Mac was kept for the rest of its paid day at the owner's request, so its `destroy` and the
Scaleway leftovers check after it are not in this record. `scaleway-leftovers.sh` lists it (exit 1)
until it is deleted.

## Tailscale

`tailscale logout` on the machine (run by `destroy`) worked each time, but the tailnet kept every machine
listed as offline: `tapdance-android`, `tapdance-android-1` and `tapdance-android-2` were still in
`tailscale status` afterwards, and new machines got `-1`, `-2` names because the old entry was still
there. Removing a node needs the Tailscale API and a key, which Tapdance does not ask for, so `destroy`
now says "logged out" and names the entry to delete in the admin console, and the record keeps the
name Tailscale really gave the machine. The three entries are the owner's to delete.

## Measured

| What | Time |
| --- | --- |
| `machine create` on a fresh project, work only (run B) | about 5½ min (APIs 2 s, network 41 s, VM 11 s, ssh 31 s, setup 3 min 50 s, connect 10 s), plus the Tailscale approval |
| `machine destroy` | 106–123 s, then the leftovers check |
| `machine stop` | 54 s |
| Auto start of a stopped VM to a guard that answers | 39–44 s |
| First lease of a device kind | about 170 s |
| Warm lease | 11.6–38 s |
| Idle stop | 11 min 28 s after the last lease ended (limit 10 min) |

## Cost

Scaleway: the owner's Mac mini M2-L, rented by them, EUR 0.21 an hour before VAT, at least EUR 5.04.
Google Cloud: about 106 VM-minutes in all (run 1 ≈ 5, A ≈ 17, B ≈ 32, upgrade ≈ 4, auto ≈ 48) at about USD 0.21 an
hour for an `n2-standard-4` in europe-west1, plus disks and IPs for the same time: **about USD 0.40**.
An estimate from list prices; the billing page was not read. The project remains, empty (no cost).

## Bugs found and fixed in this change

1. `host-setup.sh`: the emulator needs `libnss3` (added for apt, dnf and pacman, and to `doctor`'s hint).
2. `host-setup.sh`: without `setfacl`, the systemd user manager kept running without the `kvm` group; it
   is now restarted after the group is added.
3. `host-setup.sh`: `host up` ran in a login that predated the `kvm` group; it now runs under `sg kvm`.
4. `machine create`: gcloud's own quota project (another project) broke OS Login for ssh; ssh and scp
   now pass `--billing-project` and the OS Login API is turned on.
5. `machine create` showed host up's ACL page as the approval link; only `/a/` login links count.
6. `machine destroy` claimed to remove the Tailscale node; it says "logged out" and what to delete.
7. `machine destroy` listed another machine of Tapdance's as "not made by Tapdance".
8. The auto-start notice said "it had stopped itself" when the owner had stopped it.
9. Scaleway: `zone=all` hides Macs in `fr-par-1` from `scw` lists; `machine` and `scaleway-leftovers.sh`
   now ask each Mac zone by name, and `create` picks the cheapest offer in stock.
10. `machine create` could not set up a Mac the person had rented: `--server-id` (with a one-time password
    login to add the key).
11. `host warm` read back Simlock's held-back slots; it now shows the spares it set.

## Open, not fixed here

- After `tapdance worker restart --force` mid-lease, Simlock still listed the lease (so `device status`
  said Ready) while agent-device had dropped its session (so `release` said it had already ended).

- The Tailscale node stays listed after `destroy` (above).
- Auto mode needs a person to approve each new machine's Tailscale link, so an unattended agent waits
  until they do; `--tailscale-key` cannot be used for a background create without storing the key.
- #139 still reproduces on 0.6.0 (above). `host warm`'s read-out shows reserved slots, not spares.
  `device status` said `Ready` right after a forced worker restart had ended the lease.

## How to re-run

1. `gcloud projects create <id>`, link billing, `gcloud auth login`; Tailscale on the agent's machine.
2. `export TAPDANCE_HOME=<scratch>`, then `tapdance machine create --cloud gcp --project <id> --zone
   europe-west1-b --yes` and approve the Tailscale link it prints.
3. `scripts/field-test/mcp-checklist.mjs` and `cli-checklist.sh` as in their README, against that home.
4. `tapdance machine auto on --platform android --project <id> --idle-stop 10 --yes`; `machine stop`,
   then lease; `machine destroy`, then lease every minute until it works; leave it idle; lease again.
5. `tapdance machine destroy android --yes`, `tapdance machine auto off`,
   `infrastructure/scripts/gcp-leftovers.sh <id>` until it exits 0; delete the offline Tailscale entries.
