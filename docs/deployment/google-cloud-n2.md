# Android worker on Google Cloud N2

This guide runs Android emulators on a Google Cloud Compute Engine VM with nested virtualization, and
joins it as a worker to a Tapdance gateway. Your coding agent stays on its ordinary VPS (no KVM
there); the N2 VM only runs emulators. Requirements G-01 to G-03 in [PRODUCT.md](../../PRODUCT.md).

> **Status: written, not provisioned.** The Terraform in
> [`infrastructure/terraform/google-cloud-n2/`](../../infrastructure/terraform/google-cloud-n2/) and
> the script `infrastructure/scripts/install-android-worker.sh` have been written and syntax-checked
> only. No N2 VM has been created, and Android has not yet run end to end anywhere (Q-05 is blocked
> on a GCP project with billing). Cost figures are estimates. See [STATUS.md](../../STATUS.md).

Before you start, read [self-hosted overview](self-hosted-overview.md) for the roles and
[worker security](worker-security.md) for what joining a worker means.

## The machine

| Choice | Value | Why |
| --- | --- | --- |
| Machine type | `n2-standard-4` (4 vCPU, 16 GB RAM, Intel) | Nested virtualization works on Intel N2. Simlock's default capacity on 4 vCPU / 16 GB is one emulator, which matches "one emulator per VM until benchmarked". |
| OS | Ubuntu 24.04 LTS (`ubuntu-2404-lts-amd64` image family) | x86_64, current LTS. |
| Boot disk | 50–100 GB, `pd-balanced` (or `pd-ssd`) | SDK, one or two system images, and Simlock's emulators (`~/.simlock/devices`) grow quickly. |
| Nested virtualization | On (`--enable-nested-virtualization`) | Without it there is no `/dev/kvm` and the emulator cannot run accelerated. |
| Inbound firewall | SSH only, ideally only from Google's IAP range | The worker dials out to the gateway; it needs no inbound port. |

### Why not E2 or N2D

Google's [nested virtualization overview](https://docs.cloud.google.com/compute/docs/instances/nested-virtualization/overview)
lists what does not support it: **E2** VMs, memory-optimized VMs, Arm VMs, and VMs on **AMD**
processors (with N4D as the one AMD exception at the time of writing). N2D is AMD-based, so do not
substitute N2D or E2 for N2 to save money: the emulator will have no hardware acceleration, and
Tapdance refuses to fall back to software emulation. Other Intel series may work, but this guide
documents N2 only. Google also notes that nested VMs can be 10% or more slower for CPU-bound work.

## Prerequisites

- A Google Cloud project with **billing enabled**.
- The [gcloud CLI](https://cloud.google.com/sdk/docs/install), logged in (`gcloud auth login`) and
  pointed at the project (`gcloud config set project <PROJECT_ID>`).
- [Terraform](https://developer.hashicorp.com/terraform/install) if you use the Terraform route.
- A running Tapdance gateway that the VM can reach over TLS or Tailscale. See steps 1–2 of
  [laptop worker](laptop-worker.md); the gateway side is identical.
- A worker join token for this VM:
  `tapdance gateway token --role worker --label gcp-n2-1` (run on the gateway machine).

### IAM roles

In a personal project, Owner covers everything. In an organization, the person setting up needs
roughly:

| Task | Role |
| --- | --- |
| Enable the Compute Engine API | Service Usage Admin (`roles/serviceusage.serviceUsageAdmin`) |
| Create, stop, delete VMs and disks | Compute Instance Admin v1 (`roles/compute.instanceAdmin.v1`) |
| Attach a service account to the VM | Service Account User (`roles/iam.serviceAccountUser`) |
| Create firewall rules | Compute Security Admin (`roles/compute.securityAdmin`) or Compute Network Admin |
| SSH through IAP | IAP-secured Tunnel User (`roles/iap.tunnelResourceAccessor`) |
| Change the nested virtualization org policy | `orgpolicy.policy.set` on the project, folder or org (Organization Policy Administrator) |

The VM itself needs no Google Cloud permissions. Give it a service account with no roles, or none at
all; never put cloud credentials on a worker.

### Enable the API and check quota

```bash
gcloud services enable compute.googleapis.com
gcloud compute regions describe us-central1 | grep -B1 -A1 -E "metric: (CPUS|N2_CPUS)$"
```

You need at least 4 free `N2_CPUS` (and `CPUS`) in the region. New projects sometimes have low
limits; request more under **IAM & Admin → Quotas & system limits**.

### Check the nested virtualization org policy

An organization can forbid nested virtualization with the boolean constraint
`compute.disableNestedVirtualization`. Check the effective value for your project:

```bash
gcloud resource-manager org-policies describe \
  constraints/compute.disableNestedVirtualization --project=<PROJECT_ID> --effective
```

If the output shows `booleanPolicy: enforced: true`, VMs with nested virtualization cannot be
created. Someone with `orgpolicy.policy.set` can allow it for this project:

```bash
gcloud resource-manager org-policies disable-enforce \
  compute.disableNestedVirtualization --project=<PROJECT_ID>
```

Ask your security team first; see Google's
[managing the constraint](https://docs.cloud.google.com/compute/docs/instances/nested-virtualization/managing-constraint)
page.

## Create the VM

### Route 1: Terraform

The reference module lives in
[`infrastructure/terraform/google-cloud-n2/`](../../infrastructure/terraform/google-cloud-n2/).
Its `README.md` and `variables.tf` list the inputs (project, region and zone, disk size, and so on);
this page does not repeat them so they cannot drift.

```bash
cd infrastructure/terraform/google-cloud-n2
terraform init
terraform plan     # read it: one n2-standard-4 VM with nested virtualization, disk, firewall
terraform apply
```

The module never takes a join token: you join the worker yourself over IAP SSH after `apply`, so the
token stays out of Terraform state and instance metadata. Still, never commit Terraform state or a
`terraform.tfvars` with your project or billing details.

### Route 2: gcloud by hand

```bash
gcloud compute instances create tapdance-n2-1 \
  --zone=us-central1-a \
  --machine-type=n2-standard-4 \
  --enable-nested-virtualization \
  --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud \
  --boot-disk-size=100GB --boot-disk-type=pd-balanced \
  --no-service-account --no-scopes \
  --tags=tapdance-worker
```

Allow SSH only through [IAP TCP forwarding](https://cloud.google.com/iap/docs/using-tcp-forwarding)
(Google's range `35.235.240.0/20`), not from the whole internet:

```bash
gcloud compute firewall-rules create tapdance-worker-ssh-iap \
  --network=default --direction=INGRESS --action=allow --rules=tcp:22 \
  --source-ranges=35.235.240.0/20 --target-tags=tapdance-worker
gcloud compute ssh tapdance-n2-1 --zone=us-central1-a --tunnel-through-iap
```

The `default` network in a new project also has a `default-allow-ssh` rule open to `0.0.0.0/0`.
Delete or narrow it if this project hosts nothing else that needs it.

The VM keeps an ephemeral external IP for outbound traffic (gateway, package and SDK downloads).
Without one you would need Cloud NAT, which costs extra.

## Verify KVM on the VM

```bash
grep -cw vmx /proc/cpuinfo      # anything but 0 means nested virtualization is on
ls -l /dev/kvm                  # must exist
sudo apt-get update && sudo apt-get install -y cpu-checker
kvm-ok                          # "KVM acceleration can be used"
```

If `/dev/kvm` exists but is owned by the `kvm` group and your user cannot write it:

```bash
sudo usermod -aG kvm "$USER"    # then log out and back in
```

`tapdance worker check --android-only` runs the same checks (CPU flags, `/dev/kvm` access, `kvm-ok`
and, once the SDK is there, `emulator -accel-check`) and prints a fix for each failure.

## Install the software

### With the script

[`infrastructure/scripts/install-android-worker.sh`](../../infrastructure/scripts/install-android-worker.sh)
is a provider-agnostic Ubuntu script. It checks the OS, CPU flags, `/dev/kvm` and KVM permissions;
installs the Android command-line tools (checking Google's published SHA-256), platform-tools, the
emulator and one x86_64 system image; installs Tapdance from a git checkout; configures the bundled
Simlock worker for a headless VM; and installs it as a systemd user service. With `--boot-test` it also
boots a throw-away emulator to prove acceleration. It does **not** join the gateway and never handles
the join token: at the end it prints the `tapdance worker login` command for you to run (`--gateway`
and `--label` only change that printed command). The Terraform module copies it to
`/opt/tapdance/install-android-worker.sh` on the VM. Run it as the user that will own the worker, for
example `bash install-android-worker.sh --accept-android-licenses` (read the licences first), and see
`--help` for every option. It has only been syntax-checked so far.

### By hand

These are the steps the script automates.

1. **Packages and a JDK** (`sdkmanager` needs one; Simlock needs `JAVA_HOME`):

   ```bash
   sudo apt-get install -y git unzip openjdk-17-jdk-headless
   ```

2. **Node.js 22.13 or later**, for example from [nodejs.org](https://nodejs.org/) or your preferred
   package source. Check with `node --version`.

3. **Android SDK command-line tools.** Download the Linux "command line tools only" zip from
   [developer.android.com](https://developer.android.com/studio#command-line-tools-only) and unpack it
   so that `sdkmanager` ends up at `$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager`:

   ```bash
   export ANDROID_HOME="$HOME/android-sdk"
   mkdir -p "$ANDROID_HOME/cmdline-tools"
   unzip commandlinetools-linux-*_latest.zip -d "$ANDROID_HOME/cmdline-tools"
   mv "$ANDROID_HOME/cmdline-tools/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"
   ```

   Add these to `~/.profile` so the worker daemon sees them (Simlock has no default SDK location on
   Linux):

   ```bash
   export ANDROID_HOME="$HOME/android-sdk"
   export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
   export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"
   ```

4. **Emulator and platform-tools, and the licences:**

   ```bash
   sdkmanager --install emulator platform-tools
   sdkmanager --licenses           # read and accept
   ```

5. **Tapdance** from source (it bundles Simlock and agent-device):

   ```bash
   git clone https://github.com/tapdance-dev/tapdance.git
   cd tapdance && corepack enable && pnpm install && pnpm build
   alias tapdance="node $PWD/packages/cli/dist/main.js"
   ```

6. **The worker**, headless (the VM has no display), as a systemd user service that survives logout:

   ```bash
   tapdance worker check --android-only
   tapdance simlock --local config set android.emulator.headless true
   tapdance worker install --service
   loginctl enable-linger "$USER"
   ```

   The service saves `ANDROID_HOME`, `JAVA_HOME` and `PATH` as they are when you run
   `worker install --service`. Run it again after changing them.

## Emulators: Simlock creates them

You do not create AVDs by hand. Simlock creates its own emulators (under `~/.simlock/devices/android`)
from the **system images installed on the machine**, boots them on demand, wipes them on release and
never touches AVDs it did not create. On an N2 VM the images must be **x86_64**; Simlock's installer
picks the image for the machine's own CPU architecture.

```bash
tapdance devices install android 35   # the google_apis x86_64 image for API 35, about 2 GB free disk needed
tapdance devices                      # models, API levels and image tags it can lease
```

If the install fails with `LICENSE_NOT_ACCEPTED`, run `sdkmanager --licenses`, or let Simlock accept
them for you (read them first):
`tapdance simlock config set downloads.acceptAndroidLicenses true`, then `tapdance worker restart`.

To lease an image with a different tag (for example `google_apis_playstore`), install it yourself with
`sdkmanager "system-images;android-35;google_apis_playstore;x86_64"` and lease with
`--image-tag google_apis_playstore`.

## Join the gateway

On the VM, with the join token you minted on the gateway:

```bash
tapdance worker login --accept-gateway-exec --gateway wss://gateway.example.com --label gcp-n2-1
```

It prompts for the token with hidden input (or reads it from stdin, or from `TAPDANCE_WORKER_TOKEN`).
Use the gateway's `wss://` address behind Caddy, or its `*.ts.net` name if the VM is in your
Tailscale tailnet. The VM opens the connection outbound; nothing listens on it.

## Connect Tapdance and use it

On the VPS where your agent runs:

```bash
tapdance workers list                      # gcp-n2-1 should be "connected"
tapdance devices --platform android
tapdance device lease --platform android --os 35
tapdance app install ./app/build/outputs/apk/debug/app-debug.apk
tapdance app launch com.example.app
tapdance ui inspect
tapdance screenshot
tapdance record start && tapdance record stop
tapdance logs --app com.example.app
tapdance device release
```

Through the MCP server the agent uses the same tools as anywhere else (`lease_device`,
`install_app`, `take_screenshot`, …).

### Screenshots, recordings and logs

They come back to the VPS automatically: agent-device downloads each screenshot (PNG) and recording
(MP4) to `artifacts.directory/<session>/` on the machine running Tapdance, and logs are saved there
too. `tapdance artifacts` lists them with paths. Nothing needs to be copied off the VM. To watch the
emulator live from your own computer, see [browser access](browser-access.md).

## Stop or delete

| Action | Command | What happens |
| --- | --- | --- |
| Pause new work | `tapdance simlock --gateway worker drain <worker id>` on the gateway | Current leases finish; no new ones go to this VM. |
| Stop the VM | `gcloud compute instances stop tapdance-n2-1 --zone=us-central1-a` | vCPU and RAM billing stops. Leases on it end when it comes back (their emulators are no longer running). The worker reconnects on start if installed with `--service` and linger. |
| Start it again | `gcloud compute instances start tapdance-n2-1 --zone=us-central1-a` | |
| Delete everything | `gcloud compute instances delete tapdance-n2-1 --zone=us-central1-a` (or `terraform destroy`) | The VM and its boot disk (when auto-delete is on, the default) are gone. |

After deleting, also revoke the worker's join token on the gateway (`tapdance simlock --gateway token
list`, then `token revoke <id>`) and remove the worker (`tapdance simlock --gateway worker remove <id>`).

### What still bills when the VM is stopped

- **Persistent disks**, including the boot disk, for every GB provisioned, until you delete them.
- **Reserved static external IP addresses.** A reserved address that is not attached to a running VM
  bills at a higher hourly rate than one in use. Release it if you reserved one.
- **Snapshots and custom images** you made, for the storage they use.
- An ephemeral external IP does not bill while the VM is stopped; it is released.

## Cost estimates (November 2026)

Estimates for `us-central1`, on-demand, gathered in November 2026 from third-party price trackers and
Google's published rates. Prices differ by region and change: check
[VM instance pricing](https://cloud.google.com/compute/vm-instance-pricing),
[disk pricing](https://cloud.google.com/compute/disks-image-pricing),
[network pricing](https://cloud.google.com/vpc/network-pricing) and the
[pricing calculator](https://cloud.google.com/products/calculator) before you rely on them.

| Item | Estimate |
| --- | --- |
| `n2-standard-4` on-demand | about $0.19 per hour, about $142 for a full month (730 h) before automatic sustained-use discounts |
| `n2-standard-4` Spot | about $0.12 per hour, but Google can stop it at any time and the emulator is lost; untested with nested virtualization |
| 100 GB `pd-balanced` | about $10 per month (about $0.10 per GB-month); `pd-ssd` about $0.17 per GB-month |
| External IPv4 in use | about $0.005 per hour (about $3.65 per month) |
| Reserved static IPv4 not in use | about $0.01 per hour (about $7.30 per month) |
| Viewer video egress | at Simlock's default 1,500 kbps, roughly 0.7 GB per hour of watching, billed as internet egress |

Examples:

| Pattern | Rough monthly cost |
| --- | --- |
| Working hours only (8 h × 22 days, stopped otherwise) | about $34 VM + $10 disk + $1 IP ≈ **$45** |
| Always on | about $142 VM + $10 disk + $4 IP ≈ **$155** before sustained-use discounts |
| Stopped all month, disk kept | about **$10** (plus about $7 if a static IP is reserved) |

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Creating the VM fails naming `constraints/compute.disableNestedVirtualization` | The org policy forbids nested virtualization. | See [Check the nested virtualization org policy](#check-the-nested-virtualization-org-policy). |
| `grep -cw vmx /proc/cpuinfo` prints `0` | The VM was created without nested virtualization, or on a series that does not support it (E2, N2D). | Recreate it as `n2-standard-4` with `--enable-nested-virtualization`. |
| `/dev/kvm present but not writable by this user` | Your user is not in the `kvm` group. | `sudo usermod -aG kvm "$USER"`, log out and in. |
| Quota error on create | Not enough `N2_CPUS` in the region. | Request more, or pick another region. |
| `doctor`: Android SDK not found | `ANDROID_HOME` not set for the daemon. | Set it in `~/.profile`, then `tapdance worker install --service` again. |
| `LICENSE_NOT_ACCEPTED` | SDK licences not accepted. | `sdkmanager --licenses`. |
| `INSUFFICIENT_DISK_SPACE` | Disk too small for another image. | Grow the disk, or remove images you do not use. |
| Emulator never finishes booting | Not headless on a machine with no display, or GPU mode. | Check `android.emulator.headless` is `true`; read `tapdance worker logs`. If the log points at graphics, try `tapdance simlock config set android.emulator.gpu swiftshader_indirect` and restart. |
| `workers list` does not show the VM | Uplink failing. | `tapdance worker logs` on the VM; see the table in [laptop worker](laptop-worker.md#troubleshooting). |
| Lease waits and then fails with no capacity | Simlock allows one emulator on 4 vCPU / 16 GB by default. | Release the other lease, or use a larger VM after benchmarking. |
