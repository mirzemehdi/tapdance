# Linux box with KVM as a host

A Linux machine with KVM can host Android emulators for an agent on another machine. This guide fits
a rented bare-metal server (OVHcloud Bare Metal, Hetzner and similar), a machine in your office, a
home server behind a router, or a cloud VM with nested virtualization. On physical hardware KVM runs
directly, with no nested virtualization to negotiate.

Proven: `scripts/host-setup.sh` and `tapdance host up` on a Google Cloud N2 VM, which then served
Android emulators to a Mac and a Linux VPS over Tailscale
([evidence](../testing/evidence/2026-11-03-gcp-n2-android.md)). Not run: bare-metal servers, OVHcloud,
Hetzner, home servers, and the separate no-sudo user this page sets up.

## What you get

- Android emulators on your own Linux machine, in [device-only mode](../glossary.md): the agent's
  machine reaches only the guard, which allows a fixed device API.
- No inbound port. The agent's machine connects through your Tailscale tailnet with
  `tapdance connect`.

iOS needs a Mac. For iOS too, add a Mac host as a second connect target
([Android and iOS from one agent](../guides/android-and-ios.md)).

## What you need

| Item | Requirement |
| --- | --- |
| CPU | x86_64 with Intel VT-x or AMD-V, **turned on in the BIOS/UEFI**. Intel and AMD both work on bare metal. |
| RAM | 16 GB or more. Simlock runs at most the smaller of CPU count ÷ 4 and RAM in GiB ÷ 8 emulators (at least 1). It also counts 4 GiB of RAM for each running emulator and keeps 4 GiB for the OS. A 16-core, 64 GB server therefore allows 4. |
| Disk | 100 GB or more free, SSD or NVMe. Each system image is a few GB, and Simlock's emulators (`~/.simlock/devices/android`) grow. |
| OS | Ubuntu 24.04 LTS is what the setup script targets. Other distributions work if you install the equivalent packages by hand. |
| Network | Outbound internet access for Tailscale and the downloads. A home server behind NAT works without port forwarding. |
| Accounts | An admin account with sudo, for the one-time root steps. A [Tailscale](https://tailscale.com/) account, with the agent's machine logged into the same tailnet. |

The setup script installs the rest into the host user's home folder: Node.js 22.13 or later, a JDK,
the Android SDK command-line tools, `emulator`, `platform-tools`, a system image and Tapdance.

Windows cannot host devices: Simlock runs on macOS and Linux only.

## Steps

### 1. Check hardware acceleration

From the admin account:

```bash
grep -cwE 'vmx|svm' /proc/cpuinfo
ls -l /dev/kvm
sudo apt-get install -y cpu-checker
kvm-ok
```

The first line prints `0` when virtualization is off in the firmware or the CPU lacks it. On a
machine you control, turn on "Intel Virtualization Technology" or "SVM Mode" in the firmware setup. On
a rented server, ask the provider. If the flags are there but `/dev/kvm` is missing, load the module
with `sudo modprobe kvm_intel` or `sudo modprobe kvm_amd`.

Do not go on without `/dev/kvm`. Tapdance never falls back to software emulation.

### 2. Create the host user and do the root steps

Run the devices as a dedicated user, `tapdance`, with **no sudo rights**. Anything a paired agent can
make the worker run, runs as this user.

`host-setup.sh` uses sudo for a few steps: system packages (git, unzip, and the emulator's libraries
`libpulse0 libxkbfile1 libxi6 libsm6 libice6`), the Tailscale install and login, the `kvm` group, and
linger, which keeps the worker and guard running without a login session. On a machine it detects as
a cloud VM it also asks for a sudoers rule for `systemctl poweroff` (the idle stop). A user without
sudo cannot do these. So do them first, once, from the admin account:

```bash
sudo adduser --disabled-password tapdance
sudo usermod -aG kvm tapdance
sudo loginctl enable-linger tapdance
sudo apt-get update
sudo apt-get install -y git unzip curl libpulse0 libxkbfile1 libxi6 libsm6 libice6
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --operator=tapdance
```

The last command prints a link. Open it in a browser and log in to the tailnet your agent's machine is
in. `--operator=tapdance` lets the `tapdance` user run `tailscale serve` without root, which
`host up` needs.

The other way is to give `tapdance` sudo for the setup run, then take it away again
(`sudo deluser "tapdance" sudo`). The script then asks before each sudo step. Only do this on a machine
that holds nothing else.

### 3. Run the setup script as the host user

Log in as `tapdance` with a real login session: SSH with a key, or
`sudo machinectl shell tapdance@` (from the `systemd-container` package). The worker and guard are
systemd user services, and `sudo -iu tapdance` does not give them the session they need.

First check that nothing needing sudo is left. `--check` changes nothing:

```bash
curl -fsSL https://raw.githubusercontent.com/mirzemehdi/tapdance/main/scripts/host-setup.sh | bash -s -- --check
```

If it lists git, unzip, emulator libraries, Tailscale or the kvm group, do that step from the admin
account. Then run the setup:

```bash
curl -fsSL https://raw.githubusercontent.com/mirzemehdi/tapdance/main/scripts/host-setup.sh | bash -s -- --label my-vps
```

`--label` names the pairing after the agent's machine that will use it (here `my-vps`). The script
asks once, then installs Node.js, a JDK, the Android SDK, an x86_64 system image and Tapdance into the
home folder. Saying yes accepts the Android SDK licences. Then it runs `tapdance host up`: the worker
(headless when there is no display), the guard service, a pairing token in
`~/.tapdance/worker/pairing-my-vps.token`, `tailscale serve` on port 4720, and a self-test that leases
an emulator through the guard. [Google Cloud N2](google-cloud-n2.md#run-the-setup-script) describes
each step and the block it prints at the end.

### 4. Connect the agent's machine

Copy the token file to the agent's machine over a private channel (`scp`), never through a chat or an
issue. Then, on the agent's machine:

```bash
tapdance connect https://<server>.<tailnet>.ts.net:4720 < pairing-my-vps.token
rm pairing-my-vps.token
tapdance device lease --platform android
```

`connect` adds the server as a [connect target](../glossary.md), runs `tapdance doctor`, and prints
the MCP setup for your agent. Details: [host devices for a remote agent](one-command-host.md).

## Check it worked

- The setup ended with `TAPDANCE HOST READY` and `self-test: PASS`.
- `tapdance host status` on the server shows every row `ok`.
- `tapdance doctor` on the agent's machine passes, and a lease returns an Android emulator.

`tapdance devices install android 35` on the server adds another Android version. Simlock creates its
own emulators from installed images; you do not make AVDs.

## Capacity

Simlock decides how many emulators may run from the machine's size (see [What you need](#what-you-need)).
After you have measured how many the machine runs well, you can set a fixed limit:

```bash
tapdance simlock config set capacity.config.limits.android.maxDevices 2
tapdance simlock config set capacity.config.limits.android.maxRunning 2
tapdance worker restart
```

Simlock's [capacity docs](https://github.com/callstackincubator/simlock) list the `capacity.*` and
`warmPool.*` keys. A restart ends agent-device sessions on the worker, so do it when no agent works.

The guard also allows one session at a time by default. Raise `limits.maxSessions` in
`~/.tapdance/worker/policy.json` to let more leases through
([device-only mode](../security/device-only-mode.md)).

## Firewall

Nothing on the host needs to accept connections. Allow SSH from your own addresses only:

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow from <your-ip> to any port 22 proto tcp
sudo ufw enable
```

Tailscale needs no inbound rule. Never expose the guard (port 4720) outside the tailnet, nor `adb`
(ports 5037 and 5555), Simlock's adb server (port 5038 by default), or emulator console ports.

## Disk housekeeping

`~/.simlock/devices` can grow to tens of gigabytes. Do not delete folders in it by hand while the
worker runs. Use Simlock's own commands, for example `tapdance simlock cleanup`; Simlock's cleanup
docs say what each one removes.

## Costs

Dedicated server prices vary too much by provider, country and hardware for a useful estimate here.
Compare offers on the providers' own pages, and check setup fees and minimum contract lengths. A
machine you already own costs only power and bandwidth. Viewer video at Simlock's default bitrate of
1,500 kbps is roughly 0.7 GB per hour of watching.

## Other Linux cloud VMs (OVH and others)

Not run on OVHcloud or any cloud other than Google Cloud.

A cloud instance is itself a virtual machine, so the emulator needs **nested virtualization** from the
provider. In November 2026 we found no OVHcloud documentation that promises it on Public Cloud
instances, for any flavor. Treat it as unknown until you have checked the exact flavor and region.

1. **Check KVM first, cheaply.** Create an hourly-billed instance: Ubuntu 24.04, at least 4 vCPU and
   16 GB RAM (on OVHcloud, for example `b3-16`), and your SSH key. Run the checks in
   [step 1](#1-check-hardware-acceleration). Go on only if `vmx` or `svm` is there, `/dev/kvm` exists
   and `kvm-ok` says "KVM acceleration can be used". Still time one emulator boot before relying on
   it. Otherwise delete the instance, and use a bare-metal server instead (OVHcloud Bare Metal, for
   example).
2. **Set it up** as in [step 3](#3-run-the-setup-script-as-the-host-user), over ordinary SSH, as your
   own user (not root). With sudo on your user, the script does the root steps itself, asking first.
   It detects OpenStack-based clouds such as OVHcloud Public Cloud as a cloud VM, so it also offers the
   `systemctl poweroff` rule, and `host up` turns on the idle stop (30 minutes without use powers the
   instance off; `--idle-stop off` turns it off). On OVHcloud, and on any provider that bills stopped
   instances, the idle stop saves nothing: delete the instance to stop billing.
3. **Connect** as in [step 4](#4-connect-the-agents-machine).

Firewall: the instance needs no inbound port. Allow only SSH, ideally from your own address, with
`ufw` as [above](#firewall) or with OpenStack security groups. Never open port 4720 to the internet.

Costs on OVHcloud (November 2026 estimates):

- A `b3-16` (4 vCPU, 16 GB) cost roughly EUR 75–90 a month on demand in the price trackers we checked,
  with hourly billing available and lower prices on a 12-month commitment. OVHcloud raised Public Cloud
  prices on 1 October 2026. Check the [prices page](https://www.ovhcloud.com/en/public-cloud/prices/)
  for your region.
- **A powered-off instance is still billed** at its normal rate; its resources stay reserved. So on
  OVHcloud the idle stop does not save money.
- **Shelving** an hourly-billed instance keeps its disk as a snapshot, releases the rest, and bills
  only the snapshot. See OVHcloud's
  [shelve or pause an instance](https://docs.ovhcloud.com/en/guides/public-cloud/compute/suspend-or-pause-an-instance)
  guide. Leases end, because their emulators are gone when it comes back.
- Deleting the instance stops instance billing. Delete its snapshots and extra volumes too, and remove
  it from your tailnet in the Tailscale admin console.

[When you are done with a rented machine](self-hosted-overview.md#when-you-are-done-with-a-rented-machine)
has the full clean-up list.

## Gateway mode

A server can instead join a Simlock gateway as a worker. That gives the gateway command execution on
the server, and it has never run across two machines. See [gateway mode](gateway-mode.md).

## If it fails

[Google Cloud N2 troubleshooting](google-cloud-n2.md#troubleshooting) covers KVM access, missing
emulator libraries, headless emulators, linger and Tailscale; most rows apply to any Linux host. The
Linux rows in [troubleshooting](../troubleshooting.md) cover `host up`.

| Symptom | Fix |
| --- | --- |
| The setup script asks for a sudo password as `tapdance` | A root step is missing. Run `--check`, and do the listed step from the admin account ([step 2](#2-create-the-host-user-and-do-the-root-steps)). |
| `host up` fails at the worker step: "Failed to connect to bus" | No systemd user session. Log in over SSH or with `machinectl shell`, not `sudo -iu`, and check `loginctl show-user tapdance --property=Linger` prints `Linger=yes`. |
| `host up` fails at the tailscale step: "tailscale serve refused this user" | From the admin account: `sudo tailscale set --operator=tapdance`. Then `host up` again. |
