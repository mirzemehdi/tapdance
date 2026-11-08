# Android devices on a Google Cloud N2 VM

This guide runs Android emulators on a Compute Engine VM in your own Google Cloud project, for a
coding agent that runs somewhere else (your laptop, or for example a Linux VPS). You create the VM, run
one script on it, and connect the agent's machine over Tailscale.

Proven (2026-11-03, again on 2026-11-04 and 11-05): an `n2-standard-4` VM in `europe-west1-b`, made
with the Terraform module and set up with `scripts/host-setup.sh`, hosted Android emulators for an
agent on a Mac and for one on a Linux VPS: the CLI and MCP checklists, the browser viewer, installs
from CI, an Android build on the VM from a private repository, the idle stop, a start back to ready in
54 s, Terraform's ephemeral mode (the cap not reached), `terraform destroy` and the leftovers check
([evidence](../testing/evidence/2026-11-03-gcp-n2-android.md),
[VPS](../testing/evidence/2026-11-03-vps-n2-android.md)). Not run: the gcloud-by-hand route, a Spot
VM, other machine types, the uptime cap, and the snapshot commands under [parking](#parking-the-vm).
Prices are estimates from Google's published rates.

The commands below use the zone `us-central1-a` as an example. Use your own zone in its place.

**For a test run** (trying Tapdance for a few hours), follow
[field-test-cloud-android.md](../testing/field-test-cloud-android.md): ephemeral mode, a budget alert,
the checklists, and a teardown that leaves nothing that bills.

## What you get

```text
agent's machine (laptop or VPS, no KVM)                   N2 VM in your project
  coding agent -> tapdance mcp / CLI  -- Tailscale -->  worker guard :4720 -> Simlock worker -> emulator
```

- Android emulators with hardware acceleration, one at a time, on a VM you can stop when idle.
- [Device-only mode](../security/device-only-mode.md): the agent reaches only the worker guard, which
  allows a fixed device API and nothing else.
- No port open to the internet. SSH goes through Google's IAP, and the agent's traffic through your
  tailnet.
- Cost guards that power the VM off when nobody uses it.

The VM can be one [connect target](../glossary.md) next to a Mac for iOS: one agent then leases
Android here and iOS on the Mac ([Android and iOS from one agent](../guides/android-and-ios.md)).

## What you need

- A Google Cloud project with **billing enabled**.
- The [gcloud CLI](https://cloud.google.com/sdk/docs/install), logged in (`gcloud auth login`) and
  pointed at the project (`gcloud config set project <PROJECT_ID>`).
- [Terraform](https://developer.hashicorp.com/terraform/install) 1.5 or later for the Terraform route.
  Also run `gcloud auth application-default login`.
- A [Tailscale](https://tailscale.com/) account. The agent's machine must be logged into that tailnet
  (`tailscale status` there lists it). Turn on **HTTPS Certificates** in the
  [DNS settings](https://login.tailscale.com/admin/dns) first: the guard then gets an `https://`
  address, and the browser viewer shows live video.
- Tapdance on the agent's machine ([installation](../installation.md)). The VM gets its own copy from
  the setup script.

Know what the gcloud logins grant. Both give the `cloud-platform` scope for your **whole Google
account**, not just this project. Their refresh tokens (in `~/.config/gcloud`) do not expire on their
own: they work until revoked, or until unused for about 6 months, for any process running as your user.
On a shared machine, or one an agent works on, revoke them when you are done ([tear down](#tear-down)).

**Check gcloud's quota project.** If `gcloud config get-value billing/quota_project` names another
project, gcloud bills API calls such as OS Login to that one, and `gcloud compute ssh` fails saying the
OS Login API has not been used in that project. Add `--billing-project=<PROJECT_ID>` to the `gcloud`
commands in this guide, or run `gcloud config unset billing/quota_project`.

### The machine

| Choice | Value | Why |
| --- | --- | --- |
| Machine type | `n2-standard-4` (4 vCPU, 16 GB RAM, Intel) | Nested virtualization works on Intel N2. |
| OS | Ubuntu 24.04 LTS (`ubuntu-2404-lts-amd64` image family) | x86_64, current LTS. |
| Boot disk | 64 GB `pd-balanced` | Ubuntu, the Android SDK, a system image (about 1.5 GB to download) and Simlock's emulators (`~/.simlock/devices`) fit with room to spare. 19 GB were used after the tested run. |
| Nested virtualization | On (`--enable-nested-virtualization`) | Without it there is no `/dev/kvm` and the emulator cannot run accelerated. |
| Inbound firewall | SSH only, only from Google's IAP range | Tailscale and the downloads are outbound. |

The boot disk is the VM's hard drive. Google bills every GB you provision until you delete it, also
while the VM is stopped.

**Why not E2 or N2D.** Google's
[nested virtualization overview](https://docs.cloud.google.com/compute/docs/instances/nested-virtualization/overview)
lists what does not support it: **E2** VMs, memory-optimized VMs, Arm VMs, and VMs on **AMD**
processors (N4D is the one AMD exception at the time of writing). N2D is AMD-based. On E2 or N2D the
emulator has no hardware acceleration, and Tapdance refuses to fall back to software emulation. The
Terraform module refuses any `machine_type` that does not start with `n2-`. Other Intel series may
work, but this guide covers N2 only. Google also notes that nested VMs can be 10% or more slower for
CPU-bound work.

**One emulator per VM.** Simlock's default capacity on 4 vCPU and 16 GB is one running emulator, and
the guard serves one session at a time (`limits.maxSessions` 1). One emulator under nested
virtualization with software rendering keeps several vCPUs busy while it boots and streams. A second
one on the same 4 vCPUs makes both slow: longer boots, "app not responding" dialogs, and UI waits that
run into the agent's timeouts. To serve more devices, add VMs, not emulators. Larger machine types have
not been measured.

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

For the Terraform route, whoever runs `terraform apply` needs Compute Admin, Service Account Admin,
Service Usage Admin, Project IAM Admin (for the logging roles) and IAP Policy Admin (only for
`ssh_members`). Owner on a dedicated project is simplest. Each person who will SSH in needs IAP tunnel
access, `roles/compute.osAdminLogin` (the setup script uses sudo) and `roles/iam.serviceAccountUser`
on the VM's service account; listing them in the module's `ssh_members` grants exactly these.
`gcloud compute ssh` may also need `roles/compute.viewer` on the project to look the VM up.

The VM itself needs no Google Cloud permissions. Never put cloud credentials on it.

### Enable the API and check quota

```bash
gcloud services enable compute.googleapis.com
gcloud compute regions describe us-central1 | grep -B1 -A1 -E "metric: (CPUS|N2_CPUS)$"
```

You need at least 4 free `N2_CPUS` (and `CPUS`) in the region. New projects sometimes have low limits;
request more under **IAM & Admin → Quotas & system limits**.

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

## Steps

1. [Create the VM](#create-the-vm) with Terraform or `gcloud`.
2. [Open a shell over IAP](#open-a-shell-and-check-kvm) and check KVM.
3. [Run the setup script](#run-the-setup-script): it installs everything and runs `tapdance host up`.
4. [Copy the token](#copy-the-token-to-the-agent-machine) to the agent's machine, privately.
5. [Run `tapdance connect`](#connect-the-agent-machine) there, then [lease a device](#first-lease).

### Create the VM

Both routes create a VM named `tapdance-n2`. Pick one.

**Route 1: Terraform.** The module is in
[`infrastructure/terraform/google-cloud-n2/`](../../infrastructure/terraform/google-cloud-n2/). Its
[README](../../infrastructure/terraform/google-cloud-n2/README.md) lists what it creates, its
variables and its outputs. By default it makes its own network with Cloud NAT for outbound traffic, no
external IP, an SSH rule for IAP only, and a startup script that prepares KVM. Write a
`terraform.tfvars` (never commit it, nor the Terraform state). The tested run used:

```hcl
project_id         = "<PROJECT_ID>"
region             = "europe-west1"
zone               = "europe-west1-b"
assign_external_ip = true   # an ephemeral external IP for outbound traffic instead of Cloud NAT
boot_disk_size_gb  = 64
```

With `ssh_members = ["user:you@example.com"]` the module also grants your SSH roles. Then:

```bash
cd infrastructure/terraform/google-cloud-n2
terraform init
terraform validate
terraform plan -out tapdance.plan
terraform apply tapdance.plan
```

`validate` passed with Terraform 1.17.1, and `apply` took 99 s and created 13 resources.
`terraform output iap_ssh_command` and `terraform output next_steps` print the next commands with your
names filled in. Nothing secret goes into Terraform: the pairing token is made on the VM.

**Route 2: gcloud by hand** (not run):

```bash
gcloud compute instances create tapdance-n2 \
  --zone=us-central1-a \
  --machine-type=n2-standard-4 \
  --enable-nested-virtualization \
  --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud \
  --boot-disk-size=64GB --boot-disk-type=pd-balanced \
  --no-service-account --no-scopes \
  --tags=tapdance-host \
  --max-run-duration=8h --instance-termination-action=STOP
```

The last line is the run-time cap ([cost guardrails](#cost-guardrails)). Older gcloud versions have
these two flags under `gcloud beta`; check `--help`.

Allow SSH only through [IAP TCP forwarding](https://cloud.google.com/iap/docs/using-tcp-forwarding)
(Google's range `35.235.240.0/20`), not from the whole internet:

```bash
gcloud compute firewall-rules create tapdance-host-ssh-iap \
  --network=default --direction=INGRESS --action=allow --rules=tcp:22 \
  --source-ranges=35.235.240.0/20 --target-tags=tapdance-host
```

The `default` network in a new project also has a `default-allow-ssh` rule open to `0.0.0.0/0`.
Delete or narrow it if this project hosts nothing else that needs it. This VM keeps an ephemeral
external IP for outbound traffic (Tailscale, package and SDK downloads); without one you need Cloud
NAT, which costs extra.

### Open a shell and check KVM

```bash
gcloud compute ssh tapdance-n2 --zone=us-central1-a --tunnel-through-iap
```

On the VM:

```bash
grep -cw vmx /proc/cpuinfo
ls -l /dev/kvm
```

The first must print a number other than 0, and `/dev/kvm` must exist. If `vmx` is there but
`/dev/kvm` is missing, load the module: `sudo modprobe kvm_intel`. Do not go on without `/dev/kvm`:
Tapdance never falls back to software emulation.

On the Terraform route, `bash /opt/tapdance/check-kvm.sh` runs these checks and more (wait a minute or
two after `apply` for the startup script). Before the setup script, only its `vmx`, kvm module and
`/dev/kvm` lines matter. "Cannot open /dev/kvm" is expected then: the setup script adds you to the
`kvm` group and grants this login access, with no re-login. The emulator check is skipped until the
SDK is installed. Run it again after the setup script: then it must end with "KVM acceleration is
usable".

### Run the setup script

Still on the VM, as your own user (not root):

```bash
curl -fsSL https://raw.githubusercontent.com/mirzemehdi/tapdance/main/scripts/host-setup.sh | bash -s -- --label my-vps
```

`--label` names the pairing after the agent's machine that will use it (here `my-vps`). What happens:

1. **It lists what is missing and asks once** ("Install them now?"). On a fresh VM that is Node.js, a
   JDK 17, the Android command-line tools, platform-tools, the emulator, the system image
   `system-images;android-34;google_apis;x86_64` (about 1.5 GB), the emulator's system libraries that
   Ubuntu's cloud image lacks (`libpulse0 libxkbfile1 libxi6 libsm6 libice6` and their dependencies,
   in one apt step with git and unzip), Tailscale, and access to `/dev/kvm`. Saying yes also
   **accepts the Android SDK licences**; read them first at
   [developer.android.com/studio/terms](https://developer.android.com/studio/terms).

   Everything goes into your home folder, checked against its publisher's checksum, except the steps
   that need sudo: the system packages, the Tailscale installer, the `kvm` group (plus an ACL on
   `/dev/kvm`, so you need not log in again), and a sudoers rule that lets your user run only
   `/usr/bin/systemctl poweroff`, so the guard can stop the VM when idle
   ([cost guardrails](#cost-guardrails)).

   The newest command-line tools are Google's Android CLI, which collects usage metrics by default.
   The script turns that off with a `--no-metrics` line in `~/.androidrc`, Google's documented
   setting. (Checked with command-line tools 23.0: nothing is recorded with the line, and a record is
   spooled without it.)

   Options:

   - `--play-store` installs the Google Play image (`google_apis_playstore`) instead. Use it only when
     the agent tests Play Billing or a Play sign-in. Play images update Google Play services in the
     background after a boot, which is likely (not proven) why the guest stayed busy for about
     5 minutes after a fresh boot on the 2026-11-04 run. Leases then pass
     `--image-tag google_apis_playstore` (MCP `image_tag`).
   - `--with-gh` also installs the GitHub CLI, which [installs from CI](#getting-your-app-onto-the-vm)
     and builds with `--git-auth gh` need.
   - `--sdk-packages "cmake;3.31.6"` installs SDK packages your app's build needs. A Kotlin
     Multiplatform app with native code needs CMake; without it the first build failed after 8 minutes.

2. **It writes `~/.tapdance/env.sh`** (PATH, `JAVA_HOME`, `ANDROID_HOME`, `ANDROID_SDK_ROOT`) and
   sources it at the top of `~/.bashrc`, before Ubuntu's "not interactive: return" line, and from
   `~/.profile`, so commands over ssh (`gcloud compute ssh --command …`) find the tools too.
3. **It installs Tapdance from source** into `~/tapdance`, builds it, and links `~/.local/bin/tapdance`.
4. **It logs the VM into your tailnet.** It asks first, then runs `sudo tailscale up --operator=$USER`,
   which prints a link and waits until you approve the machine. Open it in a browser on any computer
   and log in to the tailnet your agent's machine is in. `--operator` lets your user run
   `tailscale serve` without root, which `host up` needs.
5. **It runs `tapdance host up --label my-vps`**, which prints each step:

   | Step | On this VM |
   | --- | --- |
   | prerequisites | Checks the SDK, the image and KVM. |
   | account | Refuses root. |
   | worker | The bundled Simlock worker as a systemd user service, headless, with `android.emulator.gpu` set to `swiftshader_indirect`, because the VM has no display and no GPU ([speed](#speed-on-n2-standard-4)). |
   | guard service | `tapdance-guard.service`, a systemd user unit on `127.0.0.1:4720`. It turns on linger, so the worker and guard keep running after you close SSH and start at boot. OS Login accounts (the default with `gcloud compute ssh`) cannot linger; for them the setup script installs `tapdance-user-manager.service`, a small system unit that starts your user manager at boot. On a cloud VM it also turns on the idle stop. |
   | pairing | Asks you to approve, then writes the token to `~/.tapdance/worker/pairing-my-vps.token` (mode 600). The token is never printed. |
   | tailscale | `tailscale serve` on port 4720 of the VM's MagicDNS name: `https://…` with HTTPS Certificates, `http://…` (inside the tailnet's encryption) without. |
   | self-test | Through the guard: leases an emulator, takes a screenshot, releases it. The first boot under nested virtualization can take several minutes. |

   It ends with a block like this:

   ```text
   TAPDANCE HOST READY
   endpoint:  https://tapdance-n2.tail1234.ts.net:4720
   token:     saved to /home/you/.tapdance/worker/pairing-my-vps.token (mode 600), fingerprint 3fa9c2. Copy it: tapdance host token --label my-vps
   devices:   android 34 (google_apis)
   self-test: PASS (android lease, screenshot ok)
   cost guard: idle stop after 30 min, uptime cap off
   cloud VM:  Google Cloud, billed while running; its disk bills even when stopped. Delete it when you are done: see docs/deployment/google-cloud-n2.md#tear-down
   on the agent machine:  tapdance connect https://tapdance-n2.tail1234.ts.net:4720 < pairing-my-vps.token
   ```

On the tested VM, the run that passed took **2 min 44 s**, including the emulator libraries,
`host up`, the first cold emulator boot and the self-test. Earlier attempts had already downloaded
Node.js, the JDK, the SDK and the system image; a first run downloads those too (not timed).

The `cloud VM:` line appears on any detected cloud VM (in `tapdance host status` too), because a VM
costs money until it is deleted, not only while it runs. Running the script or `host up` again is safe:
finished steps are left as they are. The pairing question is asked on your terminal even though the
script came through `curl`. `tapdance host up --help` lists every option, and
[host devices for a remote agent](one-command-host.md) explains them.

### Copy the token to the agent machine

The token lets its holder drive this VM's devices until it expires (7 days by default) or you revoke
it. Move it over a private channel, never through a chat, an issue or a repository. From the computer
where you run `gcloud`:

```bash
gcloud compute scp --zone=us-central1-a --tunnel-through-iap tapdance-n2:.tapdance/worker/pairing-my-vps.token .
```

If that computer is not the agent's machine, copy the file on (for example
`scp pairing-my-vps.token my-vps:`) and delete your local copy. Another way: run
`tapdance host token --label my-vps --show` on the VM and paste the token into the hidden prompt of
`tapdance connect` (it then stays in your SSH terminal's scrollback).

### Connect the agent machine

On the agent's machine, with the endpoint from the block above:

```bash
tapdance connect https://tapdance-n2.tail1234.ts.net:4720 < pairing-my-vps.token
rm pairing-my-vps.token
```

`connect` checks that the address answers and adds the VM as a connect target (under `targets` in
`~/.tapdance/config.json`). It saves the token in `~/.tapdance/credentials.json` (mode 600), sent to
that address only, runs `tapdance doctor`, and prints the MCP setup for Claude Code, Codex and Cursor.
`--name` names the target. To add a Mac for iOS as a second target, see
[Android and iOS from one agent](../guides/android-and-ios.md).

When the token expires, run `tapdance host up --label my-vps` on the VM again (it issues a new one),
copy it, and run `connect` again.

### First lease

On the agent's machine:

```bash
tapdance devices --platform android
tapdance device lease --platform android
tapdance app install ./app/build/outputs/apk/debug/app-debug.apk
tapdance app launch com.example.app
tapdance ui inspect
tapdance screenshot
tapdance record start
tapdance record stop
tapdance logs --app com.example.app
tapdance device release
```

## Check it worked

- The setup ended with `self-test: PASS`, and `tapdance host status` on the VM shows the guard,
  worker, Tailscale and cost guard.
- `tapdance doctor` on the agent's machine passes, and `tapdance devices --platform android` lists
  Android 34.
- Screenshots, recordings and logs come back to the agent's machine, under
  `artifacts.directory/<session>/`; `tapdance artifacts` lists them.
- To watch the emulator live, see [browser access](browser-access.md) (`tapdance view --tailscale`
  with HTTPS Certificates).

## Use it day to day

Add the MCP server that `connect` printed to your agent ([connect your agent](../agents.md)). The agent
then uses the same tools as anywhere else (`lease_device`, `install_app`, `take_screenshot`, …).

The VM serves one emulator at a time. After the first lease, Simlock keeps that emulator booted as a
[warm spare](../glossary.md) so the next lease is fast; `tapdance host warm android=0,ios=0` on the VM
turns that off. Other Android versions: `tapdance devices install android 35` on the VM.

### A busy guest after a boot or release

Under nested virtualization the guest stays busy for a while after it starts: on the 2026-11-04 run
(Play image), 65-145 s after a release and about 5 minutes after a fresh boot, with commands taking
2-10 s instead of 2-6 s and no "isn't responding" dialog.

A lease waits for boot and for no "isn't responding" dialog (answered with Wait). It then checks the
CPU for `session.settleSeconds` (15 s by default) and hands the device out, with a notice that says how
busy it still is. A guest whose first 3 readings are 80 % or more and not falling is handed out after
about 5 s. `--settle 60` (or a larger `session.settleSeconds`, up to 300) waits more of the busy phase
out, at that much extra lease time.

### Lease timing

| Lease | Time | Run |
| --- | --- | --- |
| The idle spare | 10.3 s | 2026-11-05, field run 2d ([evidence](../testing/evidence/2026-11-05-vps-n2-android-2d.md)) |
| Cold | 40.7 s | field run 2d |
| Right after a release, before the fix | 35-43 s: snapshot restore 3.5 s, attaching the automation session on the busy guest 8.5-15 s, the CPU check 15-16 s, the snapshot-helper warm-up 6-9 s | field run 2d |
| Right after a release, with the early busy exit and the warm-up running alongside the CPU check | 16.0-22.0 s, mean 20.4 s | 2026-11-05, field run 2e ([evidence](../testing/evidence/2026-11-05-vps-n2-android-2e.md)) |

Field runs 2d and 2e used `google_apis` Pixel 8 / API 34. In run 2d the guest stayed busy for 55-60 s
after a release, so the CPU check almost never ended calm, and the snapshot helper's first start failed
on every restore (the retry worked).

When Simlock saves a device's clean snapshot (on the device's first boot; every spare restores it), it
logs the guest CPU at that moment. `tapdance worker logs --contains "clean baseline"` on the VM shows
"Capturing the Android clean baseline" with `busy` (0 to 1). An earlier patch waited up to 120 s for a
calm guest and ran Android's background dexopt job before that snapshot; on the 2026-11-04 run both
gave up every time at about 95 % guest CPU and pushed cold leases to 269-348 s, so they were removed.

### Getting your app onto the VM

The simplest path keeps your source code off the VM: build the APK on the agent's machine or in CI and
install it with `tapdance app install` ([CI builds](../guides/ci-builds.md)).

**Let the VM fetch the APK from CI.** Uploading a 77 MB APK from the Mac took 149 s; the VM downloading
the same build from GitHub Actions took about 8 s the first time and 7–12 s from its cache. On the VM,
log `gh` in with a fine-grained, read-only token (*Actions: Read-only*, *Contents: Read-only*) and allow
the repository:

```bash
tapdance host artifacts enable --repo acme/app --branch main
```

The agent then runs `tapdance app install --from-ci acme/app --artifact app-debug` (MCP: `install_app`
with `from_ci`). The token must select the repository whose workflow made the artifact: a token for
another repository of the same app gets a 404 from GitHub. CI runners often make a new debug key per
run, so installing over an earlier build can fail with `INSTALL_FAILED_UPDATE_INCOMPATIBLE`: uninstall
the app first, or sign debug builds with one shared keystore in CI.

**Build on the VM.** The VM can also build from a git repository
([host builds](../guides/host-builds.md)). For a private repository, read
[private repositories](../guides/private-repositories.md) first, including what a compromised VM would
give away. If your GitHub organization has turned deploy keys off ("Deploy keys are disabled for this
repository"), use a fine-grained token: one token covers builds and CI artifacts. A build needs the
app's own toolchain on the VM: the tested app's first Gradle build stopped after 8 min 43 s (with
dependency downloads) because it needs CMake 3.31.6. After `sdkmanager "cmake;3.31.6"` (6 s), the
build succeeded in 2 min 40 s, and asking again for the same commit reinstalled the kept build in
11 s. The host signs with its own debug key, so a build installed over a CI build is refused with
`INSTALL_FAILED_UPDATE_INCOMPATIBLE`: `tapdance app uninstall` first.

### Security

- **A pairing token gives device access, not a shell.** Through the guard its holder can lease the
  emulator, install and drive apps, and run the fixed device commands the guard allows, as the VM's
  user. Use the VM only for testing and keep no other credentials on it. See the
  [threat model](../security/threat-model.md).
- **Tailscale is the only way in for the agent.** `tailscale serve` exposes the guard to your tailnet,
  not the internet. A [Tailscale ACL](https://login.tailscale.com/admin/acls) that lets only the agent's
  machine reach port 4720 narrows it further.
- **No inbound port is open except IAP SSH.** On the Terraform route you can close that too once the
  host is set up: set `enable_iap_ssh = false` and apply. The worker and guard keep running and
  Tailscale stays connected; you need SSH again only to change the host.
- **Never put the pairing token** in `terraform.tfvars`, instance metadata, shell history or an issue.

## Stop, start, delete

| You want to | Run | What happens |
| --- | --- | --- |
| Stop hosting, keep the VM running | `tapdance host pause` on the VM; later `tapdance host resume` | The guard, the Tailscale exposure, the worker and its emulators stop, and nothing starts at boot. The pairing is kept. |
| Stop the VM | `gcloud compute instances stop tapdance-n2 --zone=us-central1-a` | vCPU and RAM billing stops; **the disk keeps billing**. Leases on it end (Simlock releases them with reason `device-lost`). |
| Start it again | `gcloud compute instances start tapdance-n2 --zone=us-central1-a` | The worker and guard start at boot, and Tailscale comes back with its `serve` setting; the endpoint and token stay the same. Check with `tapdance doctor` on the agent's machine. On the tested VM: `RUNNING` after 12 s, the guard answered over Tailscale after 48 s, `doctor` passed after 54 s; the first lease then cold-booted an emulator (154 s). |
| Delete everything | See [Tear down](#tear-down) | |

On the Terraform route, `terraform output stop_command` and `terraform output start_command` print the
same commands. Start the VM from the computer where you run `gcloud`: the agent cannot, because it has
no Google Cloud credentials, by design. The token still expires on its own date.

### What still bills when the VM is stopped

- **The boot disk**, for every GB provisioned (64 GB `pd-balanced` is about USD 6.40–7 a month), until
  you delete it.
- **Cloud NAT** (Terraform route): see [cost estimates](#cost-estimates-november-2026) and
  [Cloud NAT pricing](https://cloud.google.com/nat/pricing) for what a NAT gateway and its IP cost while
  no VM uses them.
- **Reserved static external IP addresses**, if you reserved one: an address not attached to a running
  VM bills at a higher hourly rate. An ephemeral external IP does not bill while the VM is stopped.
- **Snapshots and custom images** you made, for the storage they use.

### Parking the VM

| State | What bills | Back to work |
| --- | --- | --- |
| **Stopped** (`gcloud compute instances stop`, or the idle stop) | The 64 GB boot disk: about USD 0.21 a day (USD 6.40–7 a month) | `gcloud compute instances start`: ready in about a minute (54 s measured). With the idle stop on, it powers off again after the idle time unless an agent connects. |
| **Snapshot, then delete the VM** | The snapshot, for the data actually used: about USD 1 a month for about 20 GB | Recreate the VM from the snapshot (below): a few minutes, same Tailscale name and pairing. |
| **Destroyed** (`terraform destroy`, or [Tear down](#tear-down)) | Nothing | Start over from [Create the VM](#create-the-vm) and pair again. |

Snapshot and delete (not yet run):

```bash
gcloud compute instances stop tapdance-n2 --zone=us-central1-a
gcloud compute snapshots create tapdance-n2-parked --source-disk=tapdance-n2 --source-disk-zone=us-central1-a
gcloud compute instances delete tapdance-n2 --zone=us-central1-a
```

Recreate it from the snapshot:

```bash
gcloud compute disks create tapdance-n2 --zone=us-central1-a \
  --source-snapshot=tapdance-n2-parked --type=pd-balanced --size=64GB
gcloud compute instances create tapdance-n2 --zone=us-central1-a \
  --machine-type=n2-standard-4 --enable-nested-virtualization \
  --disk=name=tapdance-n2,boot=yes,auto-delete=yes \
  --no-service-account --no-scopes --tags=tapdance-host \
  --metadata=enable-oslogin=TRUE,block-project-ssh-keys=TRUE \
  --max-run-duration=8h --instance-termination-action=STOP
gcloud compute snapshots delete tapdance-n2-parked
```

Delete the snapshot only once the VM is back. On the Terraform route, use the module's network and tag
instead: `--subnet=tapdance-n2-subnet --tags=tapdance-n2-worker` (and `--no-address` if you use Cloud
NAT). The recreated VM is then outside Terraform's state, so `terraform destroy` no longer removes it:
delete it with gcloud first. Keep `enable-oslogin=TRUE`: your files on the disk belong to your OS Login
account. The disk keeps the Tailscale identity, so the VM comes back under the same MagicDNS name and
the token on the agent's machine keeps working until it expires.

## Cost guardrails

### What can still cost money

Go through this list whenever you stop using the VM. Each item bills on its own:

- [ ] **The VM while it runs**: about USD 0.19-0.21 an hour for an `n2-standard-4`, used or not.
- [ ] **The boot disk, even while the VM is stopped**: about USD 6.40-7 a month for 64 GB, until the disk
  is deleted. Stopping is not deleting.
- [ ] **Snapshots, machine images and custom images** you made (for example when
  [parking](#parking-the-vm)).
- [ ] **A reserved static IP**, and on the default Terraform route the **Cloud NAT** gateway
  ([what still bills](#what-still-bills-when-the-vm-is-stopped)).
- [ ] **Traffic** from the VM to the agent's machine (the live viewer most of all).

When you are done: `terraform destroy`, then `bash infrastructure/scripts/gcp-leftovers.sh <PROJECT_ID>`,
which lists anything from this list still in the project and exits 0 only when nothing is left
([Tear down](#tear-down)). A Google Cloud **budget only e-mails**; it cannot stop or cap Compute Engine.
Set one anyway, always (`budget_amount_usd`), so a forgotten VM shows up in your inbox.

**For a test host, use ephemeral mode:** `on_run_limit = "DELETE"` with `max_run_hours` set, and
`tapdance host up --idle-stop off`. Compute Engine then deletes the VM and its disk when the time is up,
so the most a forgotten test VM can cost is `max_run_hours` of running. The idle stop is off because a
poweroff from inside the VM stops it instead, which clears the countdown and leaves a disk that bills.
For a host you keep, use the default `STOP` with the idle stop.

### The layers

The idle stop is proven: the CLI keepalive released the last lease, and 30 minutes later the guard
powered the VM off (`TERMINATED`) and compute billing stopped
([evidence](../testing/evidence/2026-11-03-gcp-n2-android.md)). Not run: the uptime cap (unit-tested
only), reaching the Terraform run-time cap (set, never reached), the stop schedule and the budget.

An `n2-standard-4` bills about USD 0.19 an hour while it runs, whether an agent uses it or not. These
layers keep a forgotten VM from running on; each catches what the layer above misses.

| Layer | Guard | Default | What it does | Set it with |
| --- | --- | --- | --- | --- |
| Lease | Lease TTL | 30 min (`session.defaultTtlMinutes`); the guard caps each lease at 60 min (`limits.maxLeaseMinutes`) | A lease that nobody renews ends on its own. | The agent machine's config; the VM's `~/.tapdance/worker/policy.json` |
| Lease | Keepalive | On, renewing for up to 240 min (`session.maxSessionMinutes`) | Renews a CLI lease in the background, then lets it expire. | The agent machine's config |
| Lease | Idle release | 30 min (`session.idleReleaseMinutes`) | The keepalive and the MCP server release a lease nobody has used for this long. Not with `device lease --hold`. | The agent machine's config ([configuration](../configuration.md#session-and-lease)) |
| Host | Idle stop | 30 min on a detected cloud VM | The guard powers the VM off when nothing has used it for this long. | `tapdance host up --idle-stop <minutes\|off>` |
| Host | Uptime cap | Off | Past the cap the guard takes no new leases, and powers the VM off once the last one ends. | `tapdance host up --max-uptime <hours\|off>` |
| VM | Run-time cap | 8 h (Terraform `max_run_hours`), stop (`on_run_limit`) | Compute Engine stops the VM 8 hours after each start; with `on_run_limit = "DELETE"` it deletes the VM and its disk instead. | Terraform |
| VM | Stop schedule | Off (`stop_schedule`) | Compute Engine stops the VM at a set time, for example every evening. | Terraform |
| Billing | Budget | Off (`budget_amount_usd`) | E-mails at 50%, 90% and 100% of a monthly amount. **Stops nothing.** | Terraform |

### Host level: idle stop and uptime cap

The guard on the VM checks once a minute. It counts as use:

- a lease that Simlock reports, including leases made on the VM itself (the `host up` self-test, an
  agent running there);
- a request to the guard with a valid token, for as long as it stays open (a viewer's input socket
  too);
- a build on the host.

Health checks and requests without a valid token do not count, and neither does a warm spare. The
countdown starts when the guard starts, so a VM you start and then leave alone stops again after the
idle time.

- **Idle stop** (`--idle-stop`): `host up` turns it on with 30 minutes when it detects a cloud VM, and
  says so. Elsewhere it is off unless you pass the flag.
- **Uptime cap** (`--max-uptime`): measured from boot, so it starts again at every start. Once it has
  passed, a new lease is refused with `NO_CAPACITY` ("This host has run longer than its uptime cap …").
  Leases that are running go on; the VM powers off when none is left.
- **Linux only.** On a Mac, `host up` refuses both flags: Tapdance never powers a Mac off. Use
  `tapdance host pause` there.
- **The stop command is fixed:** `sudo -n /usr/bin/systemctl poweroff`. Nothing a client or a
  repository sends can change it. It needs one sudoers rule, which `scripts/host-setup.sh` installs on a
  Linux cloud VM after asking (in `/etc/sudoers.d/tapdance-poweroff`, checked with `visudo`):

  ```text
  you ALL=(root) NOPASSWD: /usr/bin/systemctl poweroff
  ```

  Without it, `host up` prints the rule and the command that installs it, `host status` shows the cost
  guard row as failing, and the guard logs the failed stop once an hour while the VM keeps running (and
  billing).
- **Where it is kept:** `hostStop` (`idleMinutes`, `maxUptimeHours`) in `~/.tapdance/worker/policy.json`
  on the VM. Running `host up` again keeps it; pass a flag to change it. `host up` restarts the guard to
  apply a change when no lease is running, and tells you when it could not. `tapdance host up
  --idle-stop 10` keeps the host's only pairing (pass `--label` when it has several); a cost guard
  change never pairs a new machine.
- **What it did:** `tapdance host status` shows the setting, how long the VM has been idle and when it
  will power off. The guard checks once a minute and the guest then takes a minute or two to shut down,
  so the VM reaches `TERMINATED` a little after the limit (measured: 12 min 15 s after the last use with
  a 10 min limit). `tapdance worker guard audit` lists each stop as a `TIMER host-stop` entry with its
  reason, and `~/.tapdance/worker/guard.log` has the "cost guard: powering off" line
  (`journalctl --user` may show nothing for an OS Login account).

A poweroff from inside the VM stops the instance the same way `gcloud compute instances stop` does:
the disk and everything on it stay.

### VM level: Terraform

These work even when Tapdance does not run on the VM. The Terraform module sets them
([variables](../../infrastructure/terraform/google-cloud-n2/README.md#variables));
`terraform output cost_guards` shows which are on.

- **`max_run_hours`** (default `8`): Compute Engine stops the VM this many hours after each start. The
  count starts again at every start; a reboot inside the VM does not reset it. It stops, never deletes:
  the boot disk stays (and bills). It also cuts off a running lease. `0` turns it off. gcloud route:
  `--max-run-duration=8h --instance-termination-action=STOP`.
- **`on_run_limit`** (default `"STOP"`): what happens at `max_run_hours`. `"DELETE"` is **ephemeral
  mode**: Compute Engine deletes the VM and its boot disk, so nothing of the VM bills afterwards and
  everything on it is lost. The network, firewall rules, service account and budget stay until
  `terraform destroy` (they cost nothing; Cloud NAT does, so use `assign_external_ip = true` for a test
  host). Terraform refuses `"DELETE"` without `max_run_hours` or with `deletion_protection`. The
  countdown only runs while the VM runs: turn the guard's idle stop off (`--idle-stop off`), or an idle
  poweroff leaves a stopped VM with its disk. After the deletion Terraform still lists the VM, and
  `terraform plan` would create it again: run `terraform destroy`. gcloud route:
  `--instance-termination-action=DELETE`. Applied with `max_run_hours = 6` on a real VM; the cap was
  not reached, so the deletion itself has not been seen.
- **`stop_schedule`** (default off) and **`schedule_time_zone`** (default `UTC`): a cron schedule at
  which Compute Engine stops the VM, for example `"0 20 * * *"` for 20:00 every day. A scheduled stop
  can begin up to 15 minutes late. It only stops; starting stays up to you. Terraform also grants the
  Compute Engine Service Agent `roles/compute.instanceAdmin.v1` on the project, which Google requires for
  schedules. **Set it when you create the VM:** changing it later recreates the VM, which wipes the boot
  disk.
- **`budget_amount_usd`** (default off) with **`billing_account`**: a monthly budget that e-mails the
  billing account's admins at 50%, 90% and 100%. It stops nothing. Creating it needs Billing Account
  Administrator or Billing Account Costs Manager on the billing account.

For a host you keep:

```hcl
# terraform.tfvars (never commit it)
project_id         = "my-project"
max_run_hours      = 8
stop_schedule      = "0 20 * * *"
schedule_time_zone = "Europe/Berlin"
budget_amount_usd  = 50
billing_account    = "XXXXXX-XXXXXX-XXXXXX"
```

For a test host (ephemeral; with `host up --idle-stop off`):

```hcl
# terraform.tfvars (never commit it)
project_id         = "my-project"
assign_external_ip = true      # no Cloud NAT to leave behind
max_run_hours      = 6
on_run_limit       = "DELETE"
budget_amount_usd  = 10
billing_account    = "XXXXXX-XXXXXX-XXXXXX"
```

`terraform output teardown` prints every step that leaves nothing billing.

### When the VM has stopped

A stopped VM still bills for its disk ([what still bills](#what-still-bills-when-the-vm-is-stopped)).
To start it again, see [Stop, start, delete](#stop-start-delete). Start it when the agent is about to
use it: after the idle time without use, it stops again.

To see why it stopped, run `tapdance host status` and `tapdance worker guard audit` on the VM, or read
`~/.tapdance/worker/guard.log`. A `TIMER host-stop` entry means the guard stopped it. No entry means
the run-time cap, the schedule or a person did; the VM's audit logs in the Google Cloud console show
the stop.

### Recommended settings for one developer

| Setting | Value | Why |
| --- | --- | --- |
| `max_run_hours` | `8` (the default) | A forgotten start costs at most about 8 × USD 0.19 ≈ USD 1.55 in `us-central1`. |
| `host up --idle-stop` | `30` (the default on a cloud VM) | The VM stops half an hour after the agent is done. |
| `host up --max-uptime` | `7` | One hour below `max_run_hours`: new leases stop first, so the hard stop does not cut a test in half. |
| `stop_schedule` | The end of your working day, in your time zone | Catches a VM that something kept busy. Set it when you create the VM. |
| `budget_amount_usd` | About USD 50 | Working hours cost about USD 41 a month in `us-central1`; an alert above that means something ran on. |

With the setup script: `bash -s -- --label my-vps --max-uptime 7` (the idle stop comes by default). On a
VM that is already set up: `tapdance host up --label my-vps --max-uptime 7`.

## Tear down

Do all of it when you are done; a stopped VM still bills for its disk.

1. Delete the VM. Terraform route, from `infrastructure/terraform/google-cloud-n2` (or
   `terraform output destroy_command` from anywhere):

   ```bash
   terraform destroy
   ```

   Run it also after ephemeral mode deleted the VM: the network, service account and budget stay until
   then. It removes the VM, disk, network, NAT and service account. It does not disable the APIs, and
   it does not delete a project it created while `project_deletion_policy = "PREVENT"`.

   gcloud route:

   ```bash
   gcloud compute instances delete tapdance-n2 --zone=us-central1-a
   gcloud compute firewall-rules delete tapdance-host-ssh-iap
   ```

   The boot disk is deleted with the VM (auto-delete is on by default). Delete snapshots or images you
   made for [parking](#parking-the-vm) as well.
2. Check that nothing is left that bills:

   ```bash
   bash infrastructure/scripts/gcp-leftovers.sh <PROJECT_ID>
   ```

   It lists VMs in any state, disks, snapshots, machine and custom images, reserved addresses, routers
   and NAT gateways, forwarding rules and storage buckets, with a cost hint for each. It exits 0 only
   when there are none (1: something is left; 2: it could not check). It only reads; it never deletes.
   Run it **before** deleting the project or unlinking billing: afterwards the project is
   `DELETE_REQUESTED`, the lists answer that billing must be enabled, and it exits 2.
3. If the project was made only for Tapdance, you can delete it as a whole:
   `bash infrastructure/scripts/gcp-leftovers.sh <PROJECT_ID> --delete-project` prints the command (it
   does not run it).
4. Remove the machine from your tailnet in the
   [Tailscale admin console](https://login.tailscale.com/admin/machines), and delete any GitHub token you
   gave the VM for installs from CI or builds (it dies with the disk on the VM, but stays valid on GitHub
   until it expires or you delete it). The pairing token on the agent's machine stops working with the
   VM; `tapdance disconnect <target>` removes the target there.
5. Revoke the logins the run left behind, on each machine that ran `gcloud` or `tapdance connect` for it:

   ```bash
   bash infrastructure/scripts/revoke-run-credentials.sh --tapdance-home <scratch TAPDANCE_HOME, if any>
   ```

   It asks before each step: `gcloud auth revoke --all`, `gcloud auth application-default revoke`
   (answer no to keep a login you had before), and deleting a scratch Tapdance home (never
   `~/.tapdance`). Then it prints what is still credentialed. `--check` only prints that.

In the 2026-11-04 field run `gcp-leftovers.sh` exited 0 after `terraform destroy` and 2 after the
project was deleted (issue #83). Its handling of a partial list and of a deleted project, and
`revoke-run-credentials.sh`, have run only against a stand-in for `gcloud`.

## Speed on n2-standard-4

Measured from a Mac over Tailscale on the tested VM, with one emulator
([evidence](../testing/evidence/2026-11-03-gcp-n2-android.md)):

| What | Time |
| --- | --- |
| Warm lease (a booted spare) | CLI 2.4–5 s; MCP 3.8–34 s (34 s when the spare had to boot) |
| Cold lease (first after a VM or worker restart) | 154–206 s |
| Key press | CLI 0.75–0.8 s (process start and TLS each time); MCP 0.1–0.2 s |
| Tap by text | CLI 2.6–4 s, up to 9–20 s when a sheet or the app opened (with `-gpu auto`) |
| `inspect` | 0.8–2.6 s |
| Screenshot | 1.2–2.9 s |
| Recording | start about 1 s, stop 2.5–3.8 s |
| Install, 77 MB APK uploaded from the Mac | 149 s |
| Install from CI on the VM | first download about 8 s plus the install; cached 7–12 s |

Memory: the emulator used about 3.7–4.2 GB, and the VM 4.6 GB of its 16 GB with one emulator.

**Taps that change the screen are slower than key presses.** The emulator runs under nested
virtualization with software rendering (the VM has no GPU). With the emulator's `-gpu auto`, the idle
emulator kept 136–165 % CPU busy (of 400 %), and 6 tab-switch taps took 3.4–7.9 s (median about
4.3 s). With `swiftshader_indirect` the idle emulator was near 0 % CPU and those taps took 2.2–2.6 s
(median about 2.3 s); key presses stayed at about 0.6–0.8 s from the CLI in both. `worker install` and
`host up` now set `swiftshader_indirect` on a Linux host without a display. On a host set up before
that, with no lease running:

```bash
tapdance simlock -- --local config set android.emulator.gpu swiftshader_indirect
tapdance worker restart
```

The next lease cold-boots the emulator (206 s measured). Larger machine types (`n2-standard-8`) and
other GPU modes have not been compared.

## Cost estimates (November 2026)

Measured basis: the tested VM ran about 2 hours before its idle stop powered it off, 30 minutes after
the last lease; a start took 54 s to be ready again, so letting it stop when idle costs little time.
The prices are **estimates**, gathered in November 2026 from Google's published rates and third-party
price trackers: on demand, before taxes, credits and sustained-use discounts. Prices differ by region
and change. Check [VM instance pricing](https://cloud.google.com/compute/vm-instance-pricing),
[disk pricing](https://cloud.google.com/compute/disks-image-pricing),
[network pricing](https://cloud.google.com/vpc/network-pricing),
[Cloud NAT pricing](https://cloud.google.com/nat/pricing) and the
[pricing calculator](https://cloud.google.com/products/calculator) before you rely on them.

| Item | `us-central1` | `europe-west1` |
| --- | --- | --- |
| `n2-standard-4`, while running | about USD 0.19/hour (0.194) | about USD 0.21/hour |
| `pd-balanced` disk, always | about USD 0.10/GB-month (64 GB: about USD 6.40/month) | about USD 0.11/GB-month (64 GB: about USD 7/month) |
| Ephemeral external IPv4, while running | about USD 0.005/hour | about USD 0.005/hour |
| Cloud NAT (Terraform default), while the gateway exists | about USD 0.0014/hour per VM using it, plus USD 0.005/hour for its IP, plus USD 0.045 per GiB processed | not checked |

Viewer video at Simlock's default 1,500 kbps is roughly 0.7 GB per hour of watching, billed as egress.
A full month with Google's sustained-use discount brings the `us-central1` VM from about USD 142 to
about USD 113. Spot VMs and committed-use discounts are cheaper but not configured here. Google can stop
a Spot VM at any time and the emulator is lost; untested with nested virtualization.

| Pattern | `us-central1`, rough monthly cost | `europe-west1`, rough monthly cost |
| --- | --- | --- |
| Working hours only (8 h × 22 days, stopped otherwise) | about USD 34 VM + 6.40 disk + 1 IP ≈ **USD 41** | about USD 37 VM + 7 disk + 1 IP ≈ **USD 45** |
| Always on (730 h) | about USD 142 VM + 6.40 disk + 4 IP ≈ **USD 152** | about USD 153 VM + 7 disk + 4 IP ≈ **USD 164** |
| Stopped all month, disk kept | about **USD 6.40** | about **USD 7** |

With Cloud NAT instead of an external IP, add a few dollars of NAT and traffic.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Creating the VM fails naming `constraints/compute.disableNestedVirtualization` | The org policy forbids nested virtualization. | See [Check the nested virtualization org policy](#check-the-nested-virtualization-org-policy). |
| Quota error on create (`N2_CPUS`) | Not enough N2 vCPUs in the region. | Request more, or pick another region. |
| `gcloud compute ssh` hangs or is refused | IAP firewall rule or permissions. | Check the IAP rule exists (Terraform: `enable_iap_ssh = true`) and that you have IAP tunnel access, `compute.osAdminLogin` and `iam.serviceAccountUser` (Terraform: list yourself in `ssh_members`). |
| `gcloud compute ssh` fails saying the OS Login API has not been used in a project that is not yours | gcloud's `billing/quota_project` names another project. | Add `--billing-project=<PROJECT_ID>`, or `gcloud config unset billing/quota_project`. |
| `grep -cw vmx /proc/cpuinfo` prints `0` | The VM was created without nested virtualization, or on a series that does not support it (E2, N2D). | `gcloud compute instances describe tapdance-n2 --zone=us-central1-a --format='value(advancedMachineFeatures.enableNestedVirtualization)'` must print `True`. Otherwise recreate it as `n2-standard-4` with nested virtualization. |
| `vmx` present, `/dev/kvm` missing | The KVM module is not loaded. | `sudo modprobe kvm_intel`. Terraform route: read `/var/log/tapdance-startup.log`. |
| `/dev/kvm present but not writable by this user` | Your user cannot open `/dev/kvm`. | Run the setup script again: it adds you to the `kvm` group and sets an ACL. If `setfacl` was missing (`sudo apt-get install -y acl`), or after a reboot without a new login, log out and back in so the group applies (`id -nG` lists `kvm`). |
| apt or git downloads time out | No outbound route. | Terraform route: Cloud NAT must exist (`assign_external_ip = false`), or give the VM an external IP (`assign_external_ip = true`). |
| `doctor` or `host up`: "the emulator cannot start: system library libpulse.so.0 is missing" | Ubuntu's cloud image lacks the emulator's audio and X libraries. | `sudo apt-get install -y libpulse0 libxkbfile1 libxi6 libsm6 libice6` (the setup script does this). For another missing `.so`, install it with apt and open an issue so the script can include it. |
| `host up` fails at the worker step: "Failed to connect to bus: No medium found" | No systemd user manager runs for your account in a non-interactive SSH session. | Update Tapdance and run the setup script again: `host up` turns on linger and waits for the user manager. For an OS Login account, see the next row. |
| "Could not enable linger: No such file or directory", also with `sudo` | An OS Login account, which logind cannot look up. | The setup script installs `tapdance-user-manager.service` instead; `systemctl status tapdance-user-manager.service` should show it active. |
| The worker and guard stop when you close SSH, or do not come back after a VM restart | Linger is off; `host up` warned "Could not turn on linger". | `sudo loginctl enable-linger $USER`, then `tapdance host up --label my-vps` again. `loginctl show-user $USER --property=Linger` should print `Linger=yes`. For an OS Login account, run the setup script again so it installs `tapdance-user-manager.service`. |
| Taps that change the screen take several seconds; `top` shows the emulator at 130 % CPU or more while idle | The emulator's `-gpu auto` on a VM without a GPU (hosts set up before `swiftshader_indirect` became the default). | See [speed](#speed-on-n2-standard-4): set `swiftshader_indirect` and restart the worker with no lease running. |
| The self-test or a lease never finishes booting | The emulator tried to open a window, or its graphics mode fails on a VM with no GPU. | If you ran setup with X11 forwarding: `tapdance simlock -- --local config set android.emulator.headless true`. If `tapdance worker logs` points at graphics: `tapdance simlock -- --local config set android.emulator.gpu swiftshader_indirect`. Then `tapdance worker restart`. |
| `host up` fails at the tailscale step: "tailscale serve refused this user" (Access denied) | On Linux only root and the tailnet's operator may change `tailscale serve`. | `sudo tailscale set --operator=$USER`, then `host up` again. |
| `host up` warns Tailscale is not logged in, and the endpoint stays on loopback | The VM is not in your tailnet. | `sudo tailscale up --operator=$USER`, open the link, then `host up` again. |
| `host up` stops at pairing: "Pairing must be approved at this machine's terminal" | It ran without a terminal (for example `gcloud compute ssh --command …` without `-t`, or the `curl` pipe could not answer). | Run `~/.local/bin/tapdance host up --label my-vps` in an interactive SSH session, or pass `--yes` if you are the owner. |
| `No space left on device`, or `INSUFFICIENT_DISK_SPACE` | The boot disk is full. | `df -h /` to check. Grow it with `gcloud compute disks resize tapdance-n2 --size=100GB --zone=us-central1-a` and restart the VM (Ubuntu's cloud image grows the file system at boot). On the Terraform route, read the plan before changing `boot_disk_size_gb`: it can replace the VM. |
| `LICENSE_NOT_ACCEPTED` on `devices install` | An SDK licence not accepted yet. | `sdkmanager --licenses` on the VM. |
| `tapdance connect` says the address did not answer | The agent's machine is not in the same tailnet, or the guard is not running. | `tailscale status` on both machines; `tapdance host status` on the VM. |
| `tailscale status` shows the VM's connection as `relay` | No direct path through Cloud NAT; traffic goes through Tailscale's relays. | It works, more slowly. An external IP (`assign_external_ip = true`, or the gcloud route) usually connects directly. |
| A lease waits and then fails with no capacity | One emulator at a time on this VM. | Release the other lease, or use a larger VM after benchmarking. |
| The VM stopped by itself, it never stops when idle, or leases are refused past the uptime cap | The cost guards. | See [When the VM has stopped](#when-the-vm-has-stopped), and the cost guard section of [troubleshooting](../troubleshooting.md). |

## Gateway mode

A VM can instead join a Simlock gateway as a worker. That gives the gateway command execution on the
VM, and it has never run across two machines; see [gateway mode](gateway-mode.md). Its install script,
`infrastructure/scripts/install-android-worker.sh`, is kept for that path, copied to `/opt/tapdance/`
by the Terraform startup script, and never run.
