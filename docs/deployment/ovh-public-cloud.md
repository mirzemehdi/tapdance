# Android host on OVHcloud Public Cloud

This guide covers hosting Android emulators on an [OVHcloud Public Cloud](https://www.ovhcloud.com/en/public-cloud/)
instance. It is mode C in [PRODUCT.md](../../PRODUCT.md) ("OVH with confirmed nested
virtualization").

> **Status: not tested.** Nobody has run Tapdance on OVHcloud yet. See [STATUS.md](../../STATUS.md).

## First, confirm that the instance can run KVM

An Android emulator on Linux needs KVM. On a Public Cloud instance (itself a virtual machine), that
means the hypervisor must expose nested virtualization. In November 2026 we could not find OVHcloud
documentation that promises nested virtualization on Public Cloud instances, for any flavor. So treat
it as **unknown until you have checked it on the exact flavor and region you will use**.

Public Cloud instances can be billed by the hour, which makes the check cheap:

1. Create an hourly-billed instance: Ubuntu 24.04, a general-purpose flavor with at least 4 vCPU and
   16 GB RAM (for example `b3-16`), and your SSH key.
2. SSH in and run:

   ```bash
   grep -cwE 'vmx|svm' /proc/cpuinfo   # 0 means no virtualization extensions are exposed
   ls -l /dev/kvm
   sudo apt-get update && sudo apt-get install -y cpu-checker && kvm-ok
   ```

3. Decide:
   - `vmx` or `svm` present, `/dev/kvm` exists and `kvm-ok` says "KVM acceleration can be used":
     continue below. Still benchmark one emulator boot before relying on it.
   - Anything else: **stop here and delete the instance.** Do not try to run the emulator without
     acceleration; Tapdance will not provision devices in software emulation. Use an OVHcloud
     **Bare Metal** dedicated server instead, which runs Linux directly on hardware with VT-x/AMD-V:
     see [dedicated Linux server](dedicated-linux-server.md).

`tapdance worker check --android-only` (after installing Tapdance) runs the same checks and prints a
fix for each failure.

## Set it up as a host

Once KVM is confirmed, the steps are the same as on a Google Cloud N2 VM, in device-only mode: one
script installs everything and runs `tapdance host up`, and your agent's machine connects over
Tailscale. Follow these sections of [Google Cloud N2](google-cloud-n2.md), over ordinary SSH instead
of IAP:

1. [Run the setup script](google-cloud-n2.md#run-the-setup-script) as your own user (not root), with
   a `--label` such as `ovh-1`. It installs an x86_64 system image, logs the instance into your tailnet,
   and runs `host up`.
2. [Copy the token to the agent machine](google-cloud-n2.md#copy-the-token-to-the-agent-machine) with
   `scp`, then delete the copies.
3. [Connect the agent machine](google-cloud-n2.md#connect-the-agent-machine) and
   [lease a device](google-cloud-n2.md#first-lease).

None of this has run on OVHcloud. The [troubleshooting table](google-cloud-n2.md#troubleshooting)
covers KVM access, headless emulators, linger and Tailscale. To join the instance to a gateway
instead, see [Alternative: join a gateway](google-cloud-n2.md#alternative-join-a-gateway).

## Network and firewall

A Public Cloud instance normally gets a public IPv4 address. The host needs **no inbound port**:
Tailscale connects outbound, and `tailscale serve` exposes the guard inside your tailnet only. Allow
only SSH in, ideally only from your own address:

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow from <your-ip> to any port 22 proto tcp
sudo ufw enable
```

You can also use OpenStack security groups on the instance's network port. Never open the guard's
port (4720) to the internet.

## Costs and billing (November 2026 estimates)

- A `b3-16` (4 vCPU, 16 GB) cost roughly €75–90 per month on-demand in the price trackers we checked
  in November 2026, with hourly billing available and lower prices on a 12-month commitment. OVHcloud
  raised Public Cloud prices on 1 October 2026. Check the
  [Public Cloud prices page](https://www.ovhcloud.com/en/public-cloud/prices/) for your region.
- **A powered-off instance is still billed** at its normal rate; its resources stay reserved.
- **Shelving** an hourly-billed instance keeps its disk as a snapshot, releases the rest, and bills
  only the snapshot. See OVHcloud's
  [shelve or pause an instance](https://docs.ovhcloud.com/en/guides/public-cloud/compute/suspend-or-pause-an-instance)
  guide. Leases on the worker end, because their emulators are gone when it comes back.
- Deleting the instance stops instance billing; delete its snapshots and any extra volumes too.

When you retire the instance, also remove it from your tailnet in the Tailscale admin console. If
you joined it to a gateway instead, revoke its join token there
(`tapdance simlock --gateway token list`, then `token revoke <id>`).
