# iOS simulators on a rented Scaleway Mac mini

You have no spare Mac. You rent a Mac mini from Scaleway, make it an iOS host with one script, and your
agent (on your laptop, a Linux VPS, anywhere in your tailnet) leases iOS simulators on it through the
worker guard: `host-setup.sh` → `host up` → `connect`, the same path as
[one-command-host.md](../deployment/one-command-host.md).

> **Status: run end to end once (2026-11-06/07).** A Mac mini **M1-M** (8 GB) with macOS 27.2 and
> Xcode 27.0 in `fr-par-3`, set up over ssh with nobody at the screen, served iOS 27 simulators to an
> agent on a Mac over Tailscale: the CLI and MCP checklists, a reboot with the worker, guard and
> Tailscale coming back, and builds of a private Kotlin Multiplatform app on the Mac
> ([evidence](../testing/evidence/2026-11-06-rented-mac-ios.md)). Not run: other offers (M2, M4), other
> macOS versions, a Linux VPS as the agent's machine, the standard-account setup. Prices are
> Scaleway's published rates. See [STATUS.md](../../STATUS.md) (G-05, Q-08).

> **For a test run** (an agent or you trying this for a day), follow
> [field-test-rented-mac-ios.md](../testing/field-test-rented-mac-ios.md): the checkpoints, the
> resource log, and a teardown that ends with nothing left that bills.

## The path at a glance

| Step | Where | Time (measured) |
| --- | --- | --- |
| 1. Rent the Mac mini, turn on automatic deletion | Scaleway console | macOS install: about 1 h |
| 2. Xcode first launch, an iOS runtime | ssh | runtime: 8 GB in 1 min 44 s |
| 3. Automatic login | ssh (you type the password) | 1 min, plus a reboot |
| 4. `host-setup.sh --ios-only` (Node.js, JDK, Tailscale, `gh`, Tapdance, `host up`) | ssh | about 13 min with the prompts |
| 5. `tapdance connect` | the agent's machine | 17 s |

## Which Mac mini

Scaleway's Apple silicon offers, read on 2026-11-06 (excluding VAT; [pricing](https://www.scaleway.com/en/pricing/apple-silicon/)):

| Offer | Chip, RAM, disk | Per hour | 24-hour minimum | For Tapdance |
| --- | --- | --- | --- | --- |
| **M1-M** | M1, 8 GB, 256 GB | EUR 0.11 | EUR 2.64 | Works, **one simulator at a time** (see [8 GB](#8-gb-one-simulator-at-a-time)) |
| M2-M | M2, 16 GB, 256 GB | EUR 0.17 | EUR 4.08 | Recommended for a warm spare or builds next to a simulator (not run) |
| M2-L | M2 Pro, 16 GB, 512 GB | EUR 0.21 | EUR 5.04 | Room for more runtimes (not run) |
| M4-S / M4-SP | M4, 16 GB, 256/512 GB | EUR 0.22 / 0.24 | EUR 5.28 / 5.76 | Faster builds (not run) |
| M4-M | M4, 32 GB, 1 TB | EUR 0.29 | EUR 6.96 | Several simulators at once (not run) |
| M4-XL | M4 Pro, 64 GB, 2 TB | EUR 0.49 | EUR 11.76 | More than a test needs |
| **M2-L-ASAHI** | | | | **Not usable:** Asahi Linux only, no macOS, no Xcode |

- **The 24-hour minimum.** Scaleway refuses to delete a Mac mini running macOS until 24 hours after it
  was created (Apple's licence), and bills it **until it is deleted, also while it is powered off**.
  There is no idle stop: `host up --idle-stop` is refused on macOS, and powering off would not stop
  billing anyway. Turn on **automatic deletion** when you create it (below).
- **Traffic, the public IPv4 and the disk** are included; the pricing page lists no per-GB price.
  Private Networks (EUR 0.03/h) are not needed: Tailscale connects the machines.
- **macOS version.** Pick one whose Xcode you want: Scaleway preinstalls the newest Xcode that macOS
  supports (macOS 27.2 came with Xcode 27.0). A version other than the default took about an hour to
  install.

## 1. Rent it

In the console, **Bare Metal > Apple silicon > Create Mac mini**: the offer, the macOS version,
**No commitment**, Private Networks off, your **SSH key** (add it to the project first), and
**automatic deletion after 24 hours**. With the CLI, `scw apple-silicon server update <id>
schedule-deletion=true zone=<zone>` turns it on later.

The Overview page shows the IP, the user (`m1`, an administrator), its password (also the sudo and VNC
password) and the VNC port (it was 59010, not 5900). Keep the password out of chats and repositories.

What you get: Xcode (licence already accepted), MacPorts (not on `PATH` over ssh; no Homebrew),
Scaleway's agent and MDM profile, FileVault off, sleep off, automatic restart after a power failure on.
SIP cannot be turned off.

```bash
ssh -i ~/.ssh/<your-key> m1@<mac-ip>
```

## 2. Xcode and an iOS runtime

Over ssh, as `m1` (the script in step 4 does both too, asking first):

```bash
sudo xcodebuild -runFirstLaunch
xcodebuild -downloadPlatform iOS -architectureVariant arm64
```

No Apple ID is needed for the runtime. To install another Xcode, use
[xcodes](https://github.com/XcodesOrg/xcodes) (your Apple ID and 2FA code, typed by you), then the two
commands above; not run in this setup.

## 3. Automatic login

iOS simulators boot and run over ssh with nobody logged in (checked: a simulator booted, its Home Screen
rendered and screenshots worked). What needs a login is the **worker and guard**: they are LaunchAgents,
which macOS starts in a logged-in user's session. Without automatic login, after a reboot the Mac sits
at the login window and nothing serves your agent.

```bash
scp infrastructure/scripts/macos-auto-login.sh m1@<mac-ip>:
ssh -t m1@<mac-ip> 'bash macos-auto-login.sh m1'
```

It asks for the sudo password, then for `m1`'s login password (both the console's password), checks it,
and writes `/etc/kcpassword` and `autoLoginUser`. Apple's own `sudo sysadminctl -autologin set` failed
on macOS 27.2 over ssh with `SACSetAutoLoginPassword error:22` although the password was right. Reboot
(the console's **Reboot** needs no password), then check:

```bash
ssh m1@<mac-ip> 'who; launchctl print gui/$(id -u) >/dev/null && echo "login session: yes"'
```

`m1` on `console` means it worked. `/etc/kcpassword` is obfuscation, not encryption: use automatic login
only on a Mac that holds nothing of yours, like this one.

## 4. Host setup

```bash
ssh -t m1@<mac-ip>
curl -fsSL https://raw.githubusercontent.com/mirzemehdi/tapdance/main/scripts/host-setup.sh -o host-setup.sh
bash host-setup.sh --ios-only --with-gh --allow-admin-account --label my-agent
```

- `--ios-only`: no Android emulator or system image. Add `--android-build-sdk` if the agent will build a
  **Kotlin Multiplatform** app on the Mac: its Gradle step configures the Android modules even for the
  iOS app and stops with "SDK location not found" without an SDK (the command-line tools and
  platform-tools, 210 MB, no emulator).
- `--allow-admin-account`: `m1` is an administrator. On a rented Mac that holds nothing of yours, that
  is acceptable; on a Mac with your own data, host from a standard account
  (`infrastructure/scripts/macos-create-worker-account.sh`, untested).
- Tailscale comes from MacPorts as the open-source `tailscaled`, a system daemon that runs at boot with
  nobody logged in (the Tailscale app would need someone at the screen). The script asks for the sudo
  password, then prints a login link: open it in your browser and approve the machine.
- `host up` then installs the worker and guard services, asks you to approve the pairing, serves the
  guard on Tailscale (`https://` when the tailnet has HTTPS certificates) and runs a self-test lease.

Copy the token file to the agent's machine with `scp` (over ssh, `host up` does not offer the
clipboard: it would be the Mac's):

```bash
scp m1@<mac-ip>:.tapdance/worker/pairing-my-agent.token .
```

### Private repositories for host builds

`--git-auth gh` needs `gh` logged in on the Mac with a fine-grained, read-only token for the one
repository (Contents: read-only, short expiry). `gh auth login --with-token` **echoes what you paste**
over `ssh -t`; read it hidden instead (#122):

```bash
read -rs T && printf '%s\n' "$T" | gh auth login --hostname github.com --with-token; unset T
tapdance host builds enable --repo https://github.com/<owner>/<repo> --git-auth gh --protected-ref main --allow-admin-account
```

## 5. Connect the agent's machine

```bash
tapdance connect https://<mac>.<tailnet>.ts.net:4720 < pairing-my-agent.token
```

`doctor` then shows iOS available and Android as a warning ("not on this host"). From there it is the
usual flow: `tapdance device lease --platform ios`, `app build --git …` or `app install <app.zip>`,
`ui inspect`, … or the same through `tapdance mcp`. On iOS, the Home Screen is read with
`ui inspect --app com.apple.springboard`.

Commands over plain `ssh mac 'tapdance …'` work (`host status`, `worker restart`, `host builds …`):
the script sources its environment from `~/.zshenv`.

## 8 GB: one simulator at a time

On the M1-M, a leased simulator plus Simlock's warm spare (a second booted simulator) filled the 8 GB:
swap grew to 2-4 GB, `simctl` calls took over 30 s and leases failed ("Internal error"). Slim
simulators did not help (the slim boot timed out). With **no warm spare** everything passed:

```bash
ssh mac 'tapdance host warm android=0,ios=0'
```

The cost: every lease is a cold boot (77-109 s measured) and the first command after it can take 30 s
or more while agent-device starts its runner. On a 16 GB offer, keep the default spare.

## Reboot

<!-- filled in from the reboot test -->

## Stop paying: delete it

Powering off does not stop billing; only deletion does.

1. On the agent's machine: `tapdance device release`.
2. On the Mac, if you keep it longer: `tapdance host down --all`.
3. Delete the Mac mini: console **Delete** (after the 24 hours), or let automatic deletion do it. It wipes
   the disk (and with it the `gh` login, the pairing token and the auto-login password) and takes about
   30 minutes.
4. Check with your own `scw` login that nothing is left:

   ```bash
   infrastructure/scripts/scaleway-leftovers.sh
   ```

5. Yours to remove: the Tailscale machine (admin console), the GitHub token, the token file on the
   agent's machine.

## Apple licensing note

The 24-hour minimum exists because of Apple's macOS licence. Renting a Mac for your own testing is what
Scaleway sells. Offering short shared Mac sessions to other people needs its own review of the licence
([apple.com/legal/sla](https://www.apple.com/legal/sla/)).
