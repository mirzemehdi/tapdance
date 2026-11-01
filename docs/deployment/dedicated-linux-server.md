# Android worker on a dedicated Linux server

A physical Linux machine is the simplest place to run Android emulators: there is no nested
virtualization to negotiate, KVM runs directly on the hardware. This guide fits a rented bare-metal
server (OVHcloud Bare Metal, Hetzner, and similar), a machine in your office, or a home server behind
a router. Mode C in [PRODUCT.md](../../PRODUCT.md).

> **Status: not tested.** The worker code path is the same as for the laptop and Google Cloud
> workers, and none of them has been run across two machines yet. See [STATUS.md](../../STATUS.md).

## What you need

| Item | Requirement |
| --- | --- |
| CPU | x86_64 with Intel VT-x or AMD-V, **enabled in the BIOS/UEFI**. Both Intel and AMD work on bare metal. |
| RAM | 16 GB or more. Simlock counts 4 GiB per Android emulator and keeps 4 GiB for the OS. |
| Disk | 100 GB or more free, SSD or NVMe. Each system image is a few GB, and Simlock's emulators (`~/.simlock/devices/android`) grow. |
| OS | Ubuntu 24.04 LTS is what our script targets. Other distributions work if you install the equivalent packages by hand. |
| Network | Outbound HTTPS to your gateway. **No inbound port** is needed, so a home server behind NAT works without port forwarding. |
| Software | Node.js 22.13+, a JDK, the Android SDK command-line tools, `emulator`, `platform-tools`, a system image. |

Windows servers cannot be workers: Simlock runs on macOS and Linux only.

## Prepare the machine

Create a dedicated user for the worker. It needs the `kvm` group and **no sudo rights**: anything an
agent token can make the worker run, runs as this user (see [worker security](worker-security.md)).

```bash
sudo adduser --disabled-password tapdance
sudo usermod -aG kvm tapdance
sudo loginctl enable-linger tapdance    # its systemd user services run without a login session
sudo -iu tapdance
```

Check hardware acceleration:

```bash
grep -cwE 'vmx|svm' /proc/cpuinfo   # 0: virtualization is off in firmware, or the CPU lacks it
ls -l /dev/kvm
sudo apt-get install -y cpu-checker && kvm-ok    # run this one from an admin account
```

If the flags are missing on a machine you control, enable "Intel Virtualization Technology" /
"SVM Mode" in the firmware setup. On a rented server, ask the provider. If `/dev/kvm` is missing while
the flags are present, load the module (`sudo modprobe kvm_intel` or `sudo modprobe kvm_amd`).

## Install and join

The software steps are identical to the Google Cloud guide; run them as the `tapdance` user:

1. [Install the software](google-cloud-n2.md#install-the-software): the script
   `infrastructure/scripts/install-android-worker.sh` (written for Ubuntu, syntax-checked only) or the
   manual steps. Use x86_64 system images.
2. Make the emulator headless if the server has no display:
   `tapdance simlock config set android.emulator.headless true`.
3. `tapdance worker install --service` so the worker starts with the machine (with linger on).
4. `tapdance devices install android 35` (or another API level). Simlock creates its own emulators
   from installed images; you do not make AVDs.
5. `tapdance worker login --accept-gateway-exec --gateway wss://gateway.example.com --label office-server` with a join token
   from `tapdance gateway token --role worker --label office-server` on the gateway.

Then check from the VPS with `tapdance workers list` and `tapdance devices`, and lease as usual.
`tapdance doctor` on the VPS does not report a remote worker's KVM state (Simlock does not expose it);
run `tapdance worker check --android-only` on the server for that.

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
agent is working.

## Firewall

Nothing on the worker needs to accept connections. Allow SSH from your own addresses only:

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow from <your-ip> to any port 22 proto tcp
sudo ufw enable
```

Never expose `adb` (ports 5037, 5555), Simlock's adb server (port 5038 by default), or emulator
console ports to the network.

## Disk housekeeping

`~/.simlock/devices` can grow to tens of gigabytes. Do not delete folders in it by hand while the
worker runs. Use Simlock's own commands, for example `tapdance simlock cleanup`; see Simlock's cleanup
documentation for what each one removes.

## Costs

Dedicated server prices vary too much by provider, country and hardware generation for a useful
estimate here. Compare offers on the providers' own pages, and check whether setup fees and minimum
contract lengths apply. A machine you already own costs only power and bandwidth; viewer video at
Simlock's default bitrate of 1,500 kbps is roughly 0.7 GB per hour of watching.
