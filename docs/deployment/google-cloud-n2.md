# Android devices on a Google Cloud N2 VM

This guide runs Android emulators on a Compute Engine VM in your own Google Cloud project, for a
coding agent that runs somewhere else (your laptop, an ordinary VPS). You create the VM, run one
script on it, and connect the agent's machine over Tailscale. Requirements G-01 to G-03 in
[PRODUCT.md](../../PRODUCT.md).

> **Status: written, being proven in phase 2 — not yet run end to end.** No N2 VM has been created
> with this guide, and Android has not yet run on a Linux host. What is proven: `tapdance host up` ran
> on the owner's Mac, and an agent on a Linux VPS tested a real app through it over Tailscale
> ([field runs](../testing/evidence/2026-11-02-vps-field-runs.md),
> [self-test through the guard](../testing/evidence/2026-11-03-selftest-through-guard.md)). The Linux
> parts of `scripts/host-setup.sh` and `host up` (kvm access, `tailscale up --operator`, linger,
> headless emulators) are unit-tested only. The Terraform module has never been applied. Cost figures
> are estimates. See [STATUS.md](../../STATUS.md).

## The path at a glance

```text
agent machine (laptop or VPS, no KVM)                     N2 VM in your project
  coding agent -> tapdance mcp / CLI  -- Tailscale -->  worker guard :4720 -> Simlock worker -> emulator
```

1. [Create the VM](#create-the-vm) with Terraform or `gcloud` (nested virtualization on).
2. [Open a shell over IAP](#open-a-shell-and-check-kvm) and check KVM.
3. [Run the setup script](#run-the-setup-script): it installs everything and runs `tapdance host up`
   (worker, guard service, pairing, Tailscale, self-test).
4. [Copy the token](#copy-the-token-to-the-agent-machine) to the agent's machine, privately.
5. [Run `tapdance connect`](#connect-the-agent-machine) there, then [lease a device](#first-lease).

The VM runs in **device-only mode** ([personal-mac.md](../security/personal-mac.md)): the agent reaches
only the worker guard, which allows a fixed device API and nothing else. No port is opened to the
internet; SSH goes through Google's IAP, and the agent's traffic goes through your tailnet.

## The machine

| Choice | Value | Why |
| --- | --- | --- |
| Machine type | `n2-standard-4` (4 vCPU, 16 GB RAM, Intel) | Nested virtualization works on Intel N2. Simlock's default capacity on 4 vCPU / 16 GB is one emulator, which matches "one emulator per VM until benchmarked". |
| OS | Ubuntu 24.04 LTS (`ubuntu-2404-lts-amd64` image family) | x86_64, current LTS. |
| Boot disk | 64 GB `pd-balanced` | Ubuntu, the Android SDK, a system image (about 1.5 GB to download) and Simlock's emulators (`~/.simlock/devices`) fit with room to spare. |
| Nested virtualization | On (`--enable-nested-virtualization`) | Without it there is no `/dev/kvm` and the emulator cannot run accelerated. |
| Inbound firewall | SSH only, only from Google's IAP range | Tailscale and the downloads are outbound. Nothing else listens for the internet. |

The boot disk is the VM's hard drive: it holds the operating system and everything installed on it,
and Google bills it for every GB you provision until you delete it, also while the VM is stopped.

### Why not E2 or N2D

Google's [nested virtualization overview](https://docs.cloud.google.com/compute/docs/instances/nested-virtualization/overview)
lists what does not support it: **E2** VMs, memory-optimized VMs, Arm VMs, and VMs on **AMD**
processors (with N4D as the one AMD exception at the time of writing). N2D is AMD-based, so do not
substitute N2D or E2 for N2 to save money: the emulator will have no hardware acceleration, and
Tapdance refuses to fall back to software emulation. Other Intel series may work, but this guide
documents N2 only. Google also notes that nested VMs can be 10% or more slower for CPU-bound work.

## Before you start

- A Google Cloud project with **billing enabled**.
- The [gcloud CLI](https://cloud.google.com/sdk/docs/install), logged in (`gcloud auth login`) and
  pointed at the project (`gcloud config set project <PROJECT_ID>`).
- [Terraform](https://developer.hashicorp.com/terraform/install) 1.5 or later if you use the Terraform
  route (also run `gcloud auth application-default login`).
- A [Tailscale](https://tailscale.com/) account. The agent's machine must be logged into that tailnet
  (`tailscale status` there lists it). Turn on **HTTPS Certificates** in the
  [DNS settings](https://login.tailscale.com/admin/dns) first: the guard then gets an `https://`
  address, and the browser viewer shows live video.
- Tapdance on the agent's machine ([installation](../installation.md)). The VM gets its own copy from
  the setup script.

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

The VM itself needs no Google Cloud permissions. Never put cloud credentials on it.

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

Both routes create a VM named `tapdance-n2` in `us-central1-a`; the rest of this guide uses those
names. Pick one route.

### Route 1: Terraform

The reference module lives in
[`infrastructure/terraform/google-cloud-n2/`](../../infrastructure/terraform/google-cloud-n2/). Its
`README.md` and `variables.tf` list the inputs (project, region and zone, disk size, who may SSH in);
this page does not repeat them so they cannot drift. It creates its own network with Cloud NAT for
outbound traffic, no external IP, an SSH rule for IAP only, and a startup script that prepares KVM.

```bash
cd infrastructure/terraform/google-cloud-n2
terraform init
terraform validate   # the module has never been validated or applied; report what you find
terraform plan -out tapdance.plan
terraform apply tapdance.plan
```

Nothing secret goes into Terraform: the pairing token is made on the VM and never passes through
Terraform state or instance metadata. Still, never commit Terraform state or a `terraform.tfvars`.

### Route 2: gcloud by hand

```bash
gcloud compute instances create tapdance-n2 \
  --zone=us-central1-a \
  --machine-type=n2-standard-4 \
  --enable-nested-virtualization \
  --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud \
  --boot-disk-size=64GB --boot-disk-type=pd-balanced \
  --no-service-account --no-scopes \
  --tags=tapdance-host
```

Allow SSH only through [IAP TCP forwarding](https://cloud.google.com/iap/docs/using-tcp-forwarding)
(Google's range `35.235.240.0/20`), not from the whole internet:

```bash
gcloud compute firewall-rules create tapdance-host-ssh-iap \
  --network=default --direction=INGRESS --action=allow --rules=tcp:22 \
  --source-ranges=35.235.240.0/20 --target-tags=tapdance-host
```

The `default` network in a new project also has a `default-allow-ssh` rule open to `0.0.0.0/0`.
Delete or narrow it if this project hosts nothing else that needs it.

This VM keeps an ephemeral external IP for outbound traffic (Tailscale, package and SDK downloads).
Without one you would need Cloud NAT, which costs extra.

## Open a shell and check KVM

```bash
gcloud compute ssh tapdance-n2 --zone=us-central1-a --tunnel-through-iap
```

On the VM:

```bash
grep -cw vmx /proc/cpuinfo      # anything but 0 means nested virtualization is on
ls -l /dev/kvm                  # must exist
```

With the Terraform route, `bash /opt/tapdance/check-kvm.sh` runs these checks and more, and must end
with "KVM acceleration is usable" (wait a minute or two after `apply` for the startup script). If `vmx`
is there but `/dev/kvm` is missing, load the module: `sudo modprobe kvm_intel`. Do not go on without
`/dev/kvm`: Tapdance never falls back to software emulation.

## Run the setup script

Still on the VM, as your own user (not root):

```bash
curl -fsSL https://raw.githubusercontent.com/mirzemehdi/tapdance/main/scripts/host-setup.sh | bash -s -- --label gcp-n2-1
```

`--label` names the pairing; use a name that says which agent machine it is for. What happens:

1. **It lists what is missing and asks once** ("Install them now?"). On a fresh VM that is Node.js,
   a JDK 17, the Android command-line tools, platform-tools, the emulator, the system image
   `system-images;android-34;google_apis_playstore;x86_64` (about 1.5 GB), Tailscale, and access to
   `/dev/kvm`. Saying yes also **accepts the Android SDK licenses** for you; read them first at
   [developer.android.com/studio/terms](https://developer.android.com/studio/terms) if you have not.
   Everything goes into your home folder, checked against its publisher's checksum, except the steps
   that need `sudo`: git and unzip (the Terraform startup script already installed them), the Tailscale
   installer, and the kvm group. For `/dev/kvm` it adds you to the `kvm` group and sets an ACL on
   `/dev/kvm`, so you need not log out and back in.
2. **It logs the VM into your tailnet.** It asks first, then runs `sudo tailscale up --operator=$USER`,
   which prints a link ("To authenticate, visit: …"). Open it in a browser on any computer and log in
   to the tailnet your agent's machine is in. `--operator` lets your user run `tailscale serve` without
   root, which `host up` needs.
3. **It writes `~/.tapdance/env.sh`** (PATH, `JAVA_HOME`, `ANDROID_HOME`) and sources it from
   `~/.bashrc` and `~/.profile`, so SSH commands find the tools too.
4. **It installs Tapdance from source** into `~/tapdance`, builds it, and links `~/.local/bin/tapdance`.
5. **It runs `tapdance host up --label gcp-n2-1`**, which prints each step:

   | Step | On this VM |
   | --- | --- |
   | prerequisites | Checks the SDK, the image and KVM; reports the VM "with /dev/kvm (nested virtualization is on)". |
   | account | Refuses root. |
   | worker | The bundled Simlock worker as a systemd user service, with `android.emulator.headless` on because the VM has no display. |
   | guard service | `tapdance-guard.service`, a systemd user unit, answering on `127.0.0.1:4720`. It turns on **linger** for your user, so the worker and guard keep running after you close SSH and start at boot. |
   | pairing | Asks you to approve the pairing, then writes the token to `~/.tapdance/worker/pairing-gcp-n2-1.token` (mode 600). The token is never printed. |
   | tailscale | `tailscale serve` on port 4720 of the VM's MagicDNS name: `https://…` with HTTPS Certificates, `http://…` (inside the tailnet's encryption) without. |
   | self-test | Through the guard: leases an Android emulator, takes a screenshot, releases it. The first boot under nested virtualization can take several minutes. |

   It ends with a block like this:

   ```text
   TAPDANCE HOST READY
   endpoint:  https://tapdance-n2.tail1234.ts.net:4720
   token:     saved to /home/you/.tapdance/worker/pairing-gcp-n2-1.token (mode 600), fingerprint 3fa9c2. Copy it: tapdance host token --label gcp-n2-1
   devices:   android 34 (google_apis_playstore)
   self-test: PASS (android lease, screenshot ok)
   on the agent machine:  tapdance connect https://tapdance-n2.tail1234.ts.net:4720 < pairing-gcp-n2-1.token
   ```

Running the script or `host up` again is safe: finished steps are left as they are. If `host up`
stops at the pairing step with "Pairing must be approved at this machine's terminal" (the script's
input is the `curl` pipe, not your keyboard), run `~/.local/bin/tapdance host up --label gcp-n2-1` in
the same shell and answer the question. Every option of `host up` is in
[one-command host](one-command-host.md#options).

## Copy the token to the agent machine

The token lets its holder drive this VM's devices until it expires (7 days by default) or you revoke
it. Move it over a private channel, never through chat, an issue or a repository. From the computer
where you run `gcloud`:

```bash
gcloud compute scp --zone=us-central1-a --tunnel-through-iap \
  tapdance-n2:.tapdance/worker/pairing-gcp-n2-1.token .
```

If that computer is not the agent's machine, copy the file on (for example
`scp pairing-gcp-n2-1.token my-vps:`) and delete your local copy. Another way: run
`tapdance host token --label gcp-n2-1 --show` on the VM and paste the token into the hidden prompt of
`tapdance connect` (it then stays in your SSH terminal's scrollback).

## Connect the agent machine

On the agent's machine, with the endpoint from the block above:

```bash
tapdance connect https://tapdance-n2.tail1234.ts.net:4720 < pairing-gcp-n2-1.token
rm pairing-gcp-n2-1.token
```

`connect` checks that the address answers, saves the endpoint to `~/.tapdance/config.json` and the
token to `~/.tapdance/credentials.json` (mode 600, sent to that address only), runs `tapdance doctor`,
and prints the MCP setup for Claude Code, Codex and Cursor. Details:
[one-command host](one-command-host.md#on-the-agents-machine-tapdance-connect).

When the token expires, run `tapdance host up --label gcp-n2-1` on the VM again (it issues a new one),
copy it, and run `connect` again.

## First lease

On the agent's machine:

```bash
tapdance devices --platform android
tapdance device lease --platform android
tapdance app install ./app/build/outputs/apk/debug/app-debug.apk
tapdance app launch com.example.app
tapdance ui inspect
tapdance screenshot
tapdance record start && tapdance record stop
tapdance logs --app com.example.app
tapdance device release
```

Screenshots, recordings and logs come back to the agent's machine, under
`artifacts.directory/<session>/`; `tapdance artifacts` lists them. To watch the emulator live from a
browser, see [browser access](browser-access.md) (`tapdance view --tailscale` with HTTPS
Certificates).

The VM serves one emulator at a time (`limits.maxSessions` is 1, and Simlock's capacity on this
machine size is one). After the first lease, Simlock keeps that emulator booted as a warm spare so the
next lease is fast; `tapdance host warm android=0,ios=0` on the VM turns that off. Other Android
versions: `tapdance devices install android 35` on the VM.

### Use it from your agent

Add the MCP server that `connect` printed to your agent: [Claude Code](../agents/claude-code.md),
[Codex](../agents/codex.md), [Cursor](../agents/cursor.md). The agent then uses the same tools as
anywhere else (`lease_device`, `install_app`, `take_screenshot`, …).

## Stop, start, delete

| You want to | Run | What happens |
| --- | --- | --- |
| Stop hosting, keep the VM running | `tapdance host pause` on the VM; later `tapdance host resume` | The guard, the Tailscale exposure, the worker and its emulators stop, and nothing starts at boot. The pairing is kept. |
| Stop the VM | `gcloud compute instances stop tapdance-n2 --zone=us-central1-a` | vCPU and RAM billing stops; **the disk keeps billing**. Leases on it end. |
| Start it again | `gcloud compute instances start tapdance-n2 --zone=us-central1-a` | With linger on, the worker and guard start at boot, and Tailscale comes back with its `serve` setting; the endpoint and token stay the same. Check with `tapdance doctor` on the agent's machine. Not yet observed on a real VM. |
| Delete everything | See [Teardown](#teardown) | |

### What still bills when the VM is stopped

- **The boot disk**, for every GB provisioned (64 GB `pd-balanced` is about USD 6.40–7 a month), until
  you delete it.
- **Cloud NAT** (Terraform route): check [Cloud NAT pricing](https://cloud.google.com/nat/pricing) for
  what a NAT gateway and its IP cost while no VM uses them.
- **Reserved static external IP addresses**, if you reserved one: an address not attached to a running
  VM bills at a higher hourly rate. An ephemeral external IP does not bill while the VM is stopped.
- **Snapshots and custom images** you made, for the storage they use.

## Cost guardrails

(being added: idle stop and uptime cap; see STATUS.md)

## Teardown

Terraform route, from `infrastructure/terraform/google-cloud-n2`:

```bash
terraform destroy
```

gcloud route:

```bash
gcloud compute instances delete tapdance-n2 --zone=us-central1-a
gcloud compute firewall-rules delete tapdance-host-ssh-iap
gcloud compute disks list        # nothing named tapdance-n2 should be left
```

The boot disk is deleted with the VM (auto-delete is on by default). Then remove the machine from your
tailnet in the [Tailscale admin console](https://login.tailscale.com/admin/machines). The token saved on
the agent's machine stops working with the VM; nothing else needs revoking.

## Cost estimates (November 2026)

These are **estimates**, gathered in November 2026 from Google's published rates and third-party price
trackers, on-demand, before taxes, credits and sustained-use discounts. Prices differ by region and
change: check [VM instance pricing](https://cloud.google.com/compute/vm-instance-pricing),
[disk pricing](https://cloud.google.com/compute/disks-image-pricing),
[network pricing](https://cloud.google.com/vpc/network-pricing) and the
[pricing calculator](https://cloud.google.com/products/calculator) before you rely on them.

| Item | `us-central1` | `europe-west1` |
| --- | --- | --- |
| `n2-standard-4`, while running | about USD 0.19/hour | about USD 0.21/hour |
| `pd-balanced` disk, always | about USD 0.10/GB-month (64 GB: about USD 6.40/month) | about USD 0.11/GB-month (64 GB: about USD 7/month) |
| Ephemeral external IPv4, while running | about USD 0.005/hour | about USD 0.005/hour |

Viewer video at Simlock's default 1,500 kbps is roughly 0.7 GB per hour of watching, billed as egress.
A Spot VM is cheaper, but Google can stop it at any time and the emulator is lost; untested with
nested virtualization.

| Pattern | `us-central1`, rough monthly cost | `europe-west1`, rough monthly cost |
| --- | --- | --- |
| Working hours only (8 h × 22 days, stopped otherwise) | about USD 34 VM + 6.40 disk + 1 IP ≈ **USD 41** | about USD 37 VM + 7 disk + 1 IP ≈ **USD 45** |
| Always on (730 h) | about USD 142 VM + 6.40 disk + 4 IP ≈ **USD 152** | about USD 153 VM + 7 disk + 4 IP ≈ **USD 164** |
| Stopped all month, disk kept | about **USD 6.40** | about **USD 7** |

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Creating the VM fails naming `constraints/compute.disableNestedVirtualization` | The org policy forbids nested virtualization. | See [Check the nested virtualization org policy](#check-the-nested-virtualization-org-policy). |
| Quota error on create | Not enough `N2_CPUS` in the region. | Request more, or pick another region. |
| `gcloud compute ssh` hangs or is refused | IAP firewall rule or permissions. | Check the IAP rule exists and you have IAP-secured Tunnel User (Terraform: list yourself in `ssh_members`). |
| `grep -cw vmx /proc/cpuinfo` prints `0` | The VM was created without nested virtualization, or on a series that does not support it (E2, N2D). | Recreate it as `n2-standard-4` with `--enable-nested-virtualization`. |
| `vmx` present, `/dev/kvm` missing | The KVM module is not loaded. | `sudo modprobe kvm_intel`. Terraform route: read `/var/log/tapdance-startup.log`. |
| `/dev/kvm present but not writable by this user` | Your user cannot open `/dev/kvm`. | Run the setup script again: it adds you to the `kvm` group and sets an ACL. If `setfacl` was missing (`sudo apt-get install -y acl`), or after a reboot without a new login, log out and back in so the group applies (`id -nG` lists `kvm`). |
| The self-test or a lease never finishes booting | The emulator tried to open a window, or its graphics mode fails on a VM with no GPU. | `worker install` turns headless on only when no display is set; if you ran it with X11 forwarding, run `tapdance simlock -- --local config set android.emulator.headless true`. If `tapdance worker logs` points at graphics, run `tapdance simlock -- --local config set android.emulator.gpu swiftshader_indirect`. Then `tapdance worker restart`. |
| The worker and guard stop when you close SSH, or do not come back after a VM restart | Linger is off; `host up` warned "Could not turn on linger". | `sudo loginctl enable-linger $USER`, then `tapdance host up --label gcp-n2-1` again. `loginctl show-user $USER --property=Linger` should print `Linger=yes`. |
| `host up` fails at the tailscale step: "tailscale serve refused this user" (Access denied) | On Linux only root and the tailnet's operator may change `tailscale serve`. | `sudo tailscale set --operator=$USER`, then `host up` again. |
| `host up` warns Tailscale is not logged in, and the endpoint stays on loopback | The VM is not in your tailnet. | `sudo tailscale up --operator=$USER`, open the link, then `host up` again. |
| `host up` stops at pairing: "Pairing must be approved at this machine's terminal" | It ran from the `curl` pipe, which cannot answer the question. | `~/.local/bin/tapdance host up --label gcp-n2-1` in the same shell. |
| `No space left on device`, or `INSUFFICIENT_DISK_SPACE` | The boot disk is full. | `df -h /` to check. Grow the disk with `gcloud compute disks resize tapdance-n2 --size=100GB --zone=us-central1-a` and restart the VM (Ubuntu's cloud image grows the file system at boot). On the Terraform route, read the plan before changing `boot_disk_size_gb`: it can replace the VM. |
| `LICENSE_NOT_ACCEPTED` on `devices install` | An SDK licence not accepted yet. | `sdkmanager --licenses` on the VM. |
| `tapdance connect` says the address did not answer | The agent's machine is not in the same tailnet, or the guard is not running. | `tailscale status` on both machines; `tapdance host status` on the VM. |
| `tailscale status` shows the VM's connection as `relay` | No direct path through Cloud NAT; traffic goes through Tailscale's relays. | It works, more slowly. The gcloud route (external IP) usually connects directly. |
| A lease waits and then fails with no capacity | One emulator at a time on this VM. | Release the other lease, or use a larger VM after benchmarking. |

## Alternative: join a gateway

The older model runs a Simlock gateway on the agent's VPS and joins the VM to it as a worker with
`tapdance worker login --accept-gateway-exec`. It gives one queue for several workers, but the gateway
(and every agent token it issues) gets command execution on the VM, and it has **not been proven
across two machines**. See [laptop worker](laptop-worker.md) and the
[self-hosted overview](self-hosted-overview.md). Its install script,
`infrastructure/scripts/install-android-worker.sh`, is kept for that path and is not maintained for
this guide.
