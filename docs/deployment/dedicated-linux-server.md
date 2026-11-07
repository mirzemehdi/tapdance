# Android host on a dedicated Linux server

A physical Linux machine is the simplest place to run Android emulators: there is no nested
virtualization to negotiate, KVM runs directly on the hardware. This guide fits a rented bare-metal
server (OVHcloud Bare Metal, Hetzner, and similar), a machine in your office, or a home server behind
a router. Mode C in [PRODUCT.md](../../PRODUCT.md).

> **Status: not tested on a dedicated server.** The recommended path below (`scripts/host-setup.sh`
> and `tapdance host up`) ran end to end on a Linux VM with KVM, a Google Cloud N2 VM, which then served
> Android emulators to a Mac and a Linux VPS over Tailscale
> ([evidence](../testing/evidence/2026-11-03-gcp-n2-android.md)). Bare-metal servers, OVH, Hetzner and
> home servers have not been run. See [STATUS.md](../../STATUS.md) (W-07, M-03).

The recommended setup is **device-only**: the server runs the emulators behind the worker guard, and
your agent's machine reaches it over Tailscale with `tapdance connect`. Joining the server to a gateway
instead is described [at the end](#alternative-join-a-gateway).

## What you need

| Item | Requirement |
| --- | --- |
| CPU | x86_64 with Intel VT-x or AMD-V, **enabled in the BIOS/UEFI**. Both Intel and AMD work on bare metal. |
| RAM | 16 GB or more. Simlock counts 4 GiB per Android emulator and keeps 4 GiB for the OS. |
| Disk | 100 GB or more free, SSD or NVMe. Each system image is a few GB, and Simlock's emulators (`~/.simlock/devices/android`) grow. |
| OS | Ubuntu 24.04 LTS is what our script targets. Other distributions work if you install the equivalent packages by hand. |
| Network | Outbound internet access for Tailscale and the downloads. **No inbound port** is needed, so a home server behind NAT works without port forwarding. |
| Software | Installed by the setup script: Node.js 22.13+, a JDK, the Android SDK command-line tools, `emulator`, `platform-tools`, a system image, Tailscale and Tapdance. |

Windows servers cannot be workers: Simlock runs on macOS and Linux only.

## Prepare the machine

Create a dedicated user for the devices. It needs the `kvm` group and **no sudo rights**: anything a
paired agent can make the worker run, runs as this user (see [worker security](worker-security.md)).
From an admin account, do the steps that need root once:

```bash
sudo adduser --disabled-password tapdance
sudo usermod -aG kvm tapdance
sudo loginctl enable-linger tapdance    # its systemd user services run without a login session
sudo apt-get install -y git unzip curl
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --operator=tapdance   # open the link it prints; --operator lets tapdance run `tailscale serve`
```

Check hardware acceleration:

```bash
grep -cwE 'vmx|svm' /proc/cpuinfo   # 0: virtualization is off in firmware, or the CPU lacks it
ls -l /dev/kvm
sudo apt-get install -y cpu-checker && kvm-ok
```

If the flags are missing on a machine you control, enable "Intel Virtualization Technology" /
"SVM Mode" in the firmware setup. On a rented server, ask the provider. If `/dev/kvm` is missing while
the flags are present, load the module (`sudo modprobe kvm_intel` or `sudo modprobe kvm_amd`).

## Set it up as a host

Log in as the `tapdance` user with a real login session: SSH with a key, or
`sudo machinectl shell tapdance@` (from the `systemd-container` package). The worker and guard are
systemd user services, and `sudo -iu tapdance` does not give them the session they need. Then:

```bash
curl -fsSL https://raw.githubusercontent.com/mirzemehdi/tapdance/main/scripts/host-setup.sh | bash -s -- --label office-server
```

It installs Node.js, a JDK, the Android SDK, an x86_64 system image and Tapdance into the user's home
(it asks once; saying yes accepts the Android SDK licenses), then runs `tapdance host up`: the worker
(headless when there is no display), the guard service, a pairing token in
`~/.tapdance/worker/pairing-office-server.token`, `tailscale serve` on port 4720, and a self-test. The
steps are the same as on a cloud VM; [Google Cloud N2](google-cloud-n2.md#run-the-setup-script)
describes each one, and the [troubleshooting table](google-cloud-n2.md#troubleshooting) covers KVM,
headless, linger and Tailscale problems.

Copy the token to the agent's machine privately (`scp`), then there:

```bash
tapdance connect https://<server>.<tailnet>.ts.net:4720 < pairing-office-server.token
tapdance device lease --platform android
```

`tapdance devices install android 35` (on the server) adds another Android version. Simlock creates
its own emulators from installed images; you do not make AVDs.

## Capacity

Simlock decides how many emulators may run from the machine's size: by default the smaller of
CPU count ÷ 4 and RAM in GiB ÷ 8, at least 1. A 16-core, 64 GB server therefore allows 4. You can set
a fixed limit after you have measured how many emulators the machine runs well:

```bash
tapdance simlock config set capacity.config.limits.android.maxDevices 2
tapdance simlock config set capacity.config.limits.android.maxRunning 2
tapdance worker restart
```

See Simlock's [capacity docs](https://github.com/callstackincubator/simlock) for the full set of
`capacity.*` and `warmPool.*` keys. Restarting ends agent-device sessions on the worker; do it when no
agent is working. The worker guard also allows one session at a time by default: raise
`limits.maxSessions` in `~/.tapdance/worker/policy.json` to let more leases through
([device-only mode](../security/personal-mac.md)).

## Firewall

Nothing on the worker needs to accept connections. Allow SSH from your own addresses only:

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow from <your-ip> to any port 22 proto tcp
sudo ufw enable
```

Tailscale needs no inbound rule. Never expose the guard (port 4720) outside the tailnet, nor `adb`
(ports 5037, 5555), Simlock's adb server (port 5038 by default), or emulator console ports.

## Disk housekeeping

`~/.simlock/devices` can grow to tens of gigabytes. Do not delete folders in it by hand while the
worker runs. Use Simlock's own commands, for example `tapdance simlock cleanup`; see Simlock's cleanup
documentation for what each one removes.

## Costs

Dedicated server prices vary too much by provider, country and hardware generation for a useful
estimate here. Compare offers on the providers' own pages, and check whether setup fees and minimum
contract lengths apply. A machine you already own costs only power and bandwidth; viewer video at
Simlock's default bitrate of 1,500 kbps is roughly 0.7 GB per hour of watching.

## Alternative: join a gateway

A server dedicated to being a worker can instead join a Simlock gateway on your VPS: the gateway then
has one queue for several workers, but it (and every agent token it issues) gets command execution on
the server. This path has **not been run across two machines**. Install the software with the legacy
script `infrastructure/scripts/install-android-worker.sh` (written for Ubuntu, syntax-checked only),
run `tapdance simlock -- --local config set android.emulator.headless true` if the server has no
display, `tapdance worker install --service`, and join with
`tapdance worker login --accept-gateway-exec --gateway wss://gateway.example.com --label office-server`
using a join token from `tapdance gateway token --role worker --label office-server` on the gateway.
See [laptop worker](laptop-worker.md) for the gateway side and [worker security](worker-security.md).
