# Google Cloud N2 Android host (Terraform)

This folder creates one Google Cloud VM that can run the Android Emulator with hardware
acceleration, so it can host Android devices for a coding agent that runs somewhere else (an
ordinary VPS, your laptop). After `apply` you run Tapdance's setup script on the VM over IAP SSH; it
installs everything and runs `tapdance host up`, and the agent's machine connects over Tailscale with
`tapdance connect`. No inbound port is opened besides IAP SSH.

> **Status: applied in several field runs since 2026-11-03.** First run: with Terraform 1.17.1,
> `terraform validate` passed and `apply` created 13 resources in 99 s (`region = "europe-west1"`,
> `zone = "europe-west1-b"`, `assign_external_ip = true`, `boot_disk_size_gb = 64`, `max_run_hours` at
> its default of 8). The VM then hosted Android emulators for an agent on a Mac
> ([evidence](../../../docs/testing/evidence/2026-11-03-gcp-n2-android.md)). Later runs applied
> ephemeral mode (`on_run_limit = "DELETE"`, `max_run_hours = 6`, the cap not reached) with a budget
> (18 resources), and `terraform destroy` removed them with `gcp-leftovers.sh` finding nothing
> ([evidence](../../../docs/testing/evidence/2026-11-03-vps-n2-android.md)). Not yet run: the Cloud NAT
> default (`assign_external_ip = false`), `create_project` and `stop_schedule`. See
> [STATUS.md](../../../STATUS.md) (rows G-01, G-02, G-07, G-08, Q-05).

The step-by-step guide (prerequisites, IAM, the setup script, connecting the agent, costs,
troubleshooting) is [docs/deployment/google-cloud-n2.md](../../../docs/deployment/google-cloud-n2.md).

## How the pieces fit

```text
agent machine (laptop or VPS, no KVM)                      this N2 VM
  coding agent -> tapdance mcp / CLI  -- Tailscale -->  worker guard :4720 -> Simlock worker -> emulator
```

- On the VM, `scripts/host-setup.sh` installs Node.js, a JDK, the Android SDK and a system image,
  Tailscale and Tapdance, then runs `tapdance host up`: the bundled Simlock worker, the **worker
  guard** (the only endpoint the agent reaches, with a fixed device API), a pairing token, `tailscale
  serve` on port 4720, and a self-test. See
  [one-command host](../../../docs/deployment/one-command-host.md).
- On the agent's machine, `tapdance connect <endpoint> < pairing-<label>.token` saves the endpoint
  and token and prints the MCP setup.
- Device orchestration (leases, the worker) is
  [Simlock](https://github.com/callstackincubator/simlock) (MIT). UI automation, app upload and
  artifact download are [agent-device](https://github.com/callstack/agent-device) (MIT). Tapdance
  wires them together; see the [architecture decision](../../../docs/architecture-decision.md).

## What gets created

| Resource | Details |
| --- | --- |
| Project (optional) | Only with `create_project = true`. By default you pass an existing `project_id`. |
| APIs | `compute`, `iam`, `oslogin`, `cloudresourcemanager`, and `iap` when IAP SSH is on. Never disabled on destroy. |
| VPC + subnet | Dedicated network `<name>-vpc`, subnet `10.42.0.0/24` with Private Google Access. |
| Firewall | Ingress TCP 22 **only** from IAP's range `35.235.240.0/20`, only to the worker's tag. An explicit deny-all for every other ingress. No ADB, emulator, Simlock or viewer port. |
| Outbound | Cloud Router + Cloud NAT (default), or an ephemeral external IP with `assign_external_ip = true`. |
| Service account | `<name>-worker@…`, scopes `logging.write` and `monitoring.write`, roles `logging.logWriter` and `monitoring.metricWriter` (turn off with `grant_logging_roles = false`). Nothing else. |
| VM | `n2-standard-4`, min CPU platform Intel Cascade Lake, **nested virtualization on**, Ubuntu 24.04 LTS (`ubuntu-2404-lts-amd64`), 64 GB `pd-balanced`, Shielded VM (Secure Boot, vTPM, integrity monitoring), OS Login on, project SSH keys blocked, no external IP. |
| Startup script | Installs `qemu` KVM packages, `cpu-checker`, git, unzip and curl, writes a udev rule for `/dev/kvm`, loads `kvm_intel`, runs `kvm-ok`, and copies `check-kvm.sh` (and the legacy `install-android-worker.sh`) to `/opt/tapdance/`. It does **not** install Tapdance, log into Tailscale or pair anything. Log: `/var/log/tapdance-startup.log`. |
| SSH access (optional) | For each principal in `ssh_members`: IAP tunnel access to this VM, `roles/compute.osAdminLogin` on it, and `roles/iam.serviceAccountUser` on its service account. |

**No secret goes into Terraform.** Terraform state and instance metadata are readable by more
people and processes than you might expect (anyone with `compute.instances.get`, every process on
the VM through the metadata server, whoever holds the state file). The pairing token is made on the
VM by `tapdance host up`, written to a mode-600 file, and copied to the agent's machine by you; the
Tailscale login happens in your browser.

## Why N2, and why only N2

The Android Emulator needs KVM. On Google Cloud that means a VM with **nested virtualization**,
which works on Intel-based machine series. Google's
[nested virtualization overview](https://cloud.google.com/compute/docs/instances/nested-virtualization/overview)
excludes E2, Arm and most AMD machine types (it names N4D as the AMD exception). This
configuration therefore refuses any `machine_type` that does not start with `n2-`: `n2d-*` and
`e2-*` fail validation. Google also says nested VMs can lose 10% or more CPU performance, more for
I/O-heavy work.

Nested virtualization can be blocked by the organization policy
`constraints/compute.disableNestedVirtualization`. Check it before you apply:

```sh
gcloud resource-manager org-policies describe \
  constraints/compute.disableNestedVirtualization --project=PROJECT_ID --effective
```

## One emulator per VM

Simlock's default capacity on an `n2-standard-4` is **one running emulator** (a quarter of the CPU
count), and the worker guard serves one session at a time (`limits.maxSessions` 1). Reasons to keep
it there:

- An `n2-standard-4` has 4 vCPUs and 16 GB. Simlock budgets 4 GiB of RAM per emulator, and one
  emulator under nested virtualization with software GPU rendering (`swiftshader_indirect`, there
  is no GPU on this VM) keeps several vCPUs busy while it boots and while the screen streams.
- A second emulator on the same 4 vCPUs makes both slow: longer boots, "app not responding"
  dialogs, and UI waits that run into the agent's timeouts. Flaky devices are worse for an agent
  than a short queue.
- Requirement G-01 in [PRODUCT.md](../../../PRODUCT.md) says one emulator per VM until benchmarked.
  Nobody has benchmarked yet.

To serve more devices, add more VMs rather than more emulators per VM. If you measure a larger
machine type, share your numbers in an issue.

## Prerequisites

- A Google Cloud project with billing enabled, or `create_project = true` with a billing account
  and an organization or folder.
- Quota for at least 4 N2 vCPUs in your region (`N2_CPUS`). New projects sometimes have less.
- [Terraform](https://developer.hashicorp.com/terraform/install) 1.5 or later and the
  [gcloud CLI](https://cloud.google.com/sdk/docs/install), signed in:
  `gcloud auth login` and `gcloud auth application-default login`.
- Permissions for whoever runs `terraform apply`. Owner on a dedicated project is simplest. Finer
  grained: Compute Admin, Service Account Admin, Service Usage Admin, Project IAM Admin (for the
  logging roles) and IAP Policy Admin (only for `ssh_members`).
- Each person who will SSH in needs IAP tunnel access, `roles/compute.osAdminLogin` (the setup
  script uses sudo for Tailscale and the kvm group) and `roles/iam.serviceAccountUser` on the VM's
  service account. Listing them in `ssh_members` grants exactly these. `gcloud compute ssh` may also need `roles/compute.viewer`
  on the project to look the VM up.
- A [Tailscale](https://tailscale.com/) account, with the agent's machine logged into the tailnet
  and Tapdance installed there ([installation](../../../docs/installation.md)).

## Steps

1. **Configure.** Create `terraform.tfvars` (it is in `.gitignore`; it holds no secrets anyway):

   ```hcl
   project_id  = "my-tapdance-project"
   region      = "us-central1"
   zone        = "us-central1-a"
   ssh_members = ["user:you@example.com"]
   ```

2. **Validate and create.** Terraform has not validated this configuration yet, so do it first:

   ```sh
   cd infrastructure/terraform/google-cloud-n2
   terraform init
   terraform validate
   terraform plan -out tapdance.plan
   terraform apply tapdance.plan
   ```

3. **Open a shell** through IAP (copy the `iap_ssh_command` output):

   ```sh
   gcloud compute ssh tapdance-n2 --zone us-central1-a --project my-tapdance-project --tunnel-through-iap
   ```

4. **Check KVM.** Wait a minute or two for the startup script, then:

   ```sh
   bash /opt/tapdance/check-kvm.sh
   ```

   Before the setup script, only the CPU flag (`vmx`), kvm module and `/dev/kvm` lines matter: a FAIL
   "cannot open it read-write" is expected (the setup script adds you to the kvm group and grants this
   login access at once, no re-login), and the emulator check is skipped until the SDK is installed. If
   the `vmx`, module or `/dev/kvm` line fails, stop here and read [Troubleshooting](#troubleshooting).
   Tapdance never falls back to software emulation. Run the check again after step 5: then it must end
   with "KVM acceleration is usable" (it finds the SDK in `~/Android/Sdk`, where the setup script puts it).

5. **Run the setup script** on the VM, as your own user. Read the Android SDK licences first: saying
   yes to the install accepts them.

   ```sh
   curl -fsSL https://raw.githubusercontent.com/mirzemehdi/tapdance/main/scripts/host-setup.sh | bash -s -- --label gcp-n2-1
   ```

   It asks once before installing, installs Tapdance into `~/tapdance`, then asks before logging the VM
   into your tailnet (`sudo tailscale up --operator=$USER` prints a link to open in your browser and
   waits until you approve the machine), and runs `tapdance host up --label gcp-n2-1`. That ends with a
   `TAPDANCE HOST READY` block naming the endpoint and the token file
   (`~/.tapdance/worker/pairing-gcp-n2-1.token`). If it stops at the pairing step because the `curl`
   pipe cannot answer, run `~/.local/bin/tapdance host up --label gcp-n2-1` in the same shell.

6. **Copy the token** to the agent's machine, privately (from where you run `gcloud`):

   ```sh
   gcloud compute scp --zone us-central1-a --project my-tapdance-project --tunnel-through-iap \
     tapdance-n2:.tapdance/worker/pairing-gcp-n2-1.token .
   ```

7. **Connect** on the agent's machine, with the endpoint `host up` printed, then delete the file:

   ```sh
   tapdance connect https://tapdance-n2.<tailnet>.ts.net:4720 < pairing-gcp-n2-1.token
   rm pairing-gcp-n2-1.token
   tapdance device lease --platform android
   tapdance device release
   ```

8. **Optionally close SSH** afterwards: set `enable_iap_ssh = false` and apply. The worker and guard
   keep running (linger) and Tailscale stays connected; you need SSH again only to change the host.

## Variables

| Variable | Default | Notes |
| --- | --- | --- |
| `project_id` | (required) | Existing project, or the ID to create. |
| `create_project` | `false` | Create the project. Needs `billing_account` and `org_id` or `folder_id`. |
| `project_name`, `billing_account`, `org_id`, `folder_id` | | Only used when creating the project. |
| `project_deletion_policy` | `PREVENT` | For a created project: `PREVENT`, `ABANDON` or `DELETE`. |
| `region`, `zone` | `us-central1`, `us-central1-a` | Pick a zone that offers N2. |
| `name` | `tapdance-n2` | Prefix for every resource. |
| `machine_type` | `n2-standard-4` | Must start with `n2-`. |
| `min_cpu_platform` | `Intel Cascade Lake` | Or `Intel Ice Lake`. |
| `boot_image` | `ubuntu-os-cloud/ubuntu-2404-lts-amd64` | The scripts support Ubuntu 22.04 and 24.04 on x86_64. |
| `boot_disk_size_gb` | `64` | 50–100. |
| `boot_disk_type` | `pd-balanced` | Or `pd-ssd`. |
| `on_host_maintenance` | `MIGRATE` | Or `TERMINATE`. How a running nested emulator behaves during live migration has not been tested. |
| `deletion_protection` | `false` | |
| `labels` | `{}` | Added to the VM and disk. |
| `subnet_cidr` | `10.42.0.0/24` | |
| `enable_iap_ssh` | `true` | `false` removes the SSH firewall rule and stops enabling the IAP API. |
| `assign_external_ip` | `false` | `true` gives the VM an ephemeral external IP and skips Cloud NAT. Inbound stays closed. |
| `ssh_members` | `[]` | Principals that may SSH in with sudo. |
| `grant_logging_roles` | `true` | Log and metric writer roles for the VM's service account. |
| `max_run_hours` | `8` | Compute Engine ends the VM this many hours after each start. `0` or `null`: off. |
| `on_run_limit` | `"STOP"` | What happens at `max_run_hours`: `"STOP"` keeps the stopped VM and its disk (which bills); `"DELETE"` (ephemeral mode, for test hosts) deletes the VM and its boot disk. Needs `max_run_hours` and no `deletion_protection`. Use it with `tapdance host up --idle-stop off`: an idle poweroff from inside the VM clears the countdown and leaves a stopped VM. |
| `stop_schedule`, `schedule_time_zone` | `null`, `UTC` | A cron schedule that stops the VM. Changing it later recreates the VM. |
| `budget_amount_usd` | `null` | A monthly budget with alert e-mails (alerts only; it never stops the VM). Needs `billing_account`. |

## Outputs

| Output | What it gives you |
| --- | --- |
| `instance_name`, `zone`, `project_id`, `internal_ip`, `service_account_email` | Identity of what was created. |
| `iap_ssh_command` | The `gcloud compute ssh … --tunnel-through-iap` command. |
| `next_steps` | Steps 3–7 above with your names filled in. |
| `stop_command`, `start_command` | `gcloud compute instances stop/start …`. |
| `delete_command` | `terraform destroy`, plus removing the VM from your tailnet. |
| `destroy_command` | `terraform -chdir=<this folder> destroy`, to run from anywhere. |
| `leftovers_check` | `bash <repo>/infrastructure/scripts/gcp-leftovers.sh <project>`: lists what can still bill; exit 0 means nothing. |
| `teardown` | Every step that leaves nothing billing: destroy, the leftovers check, the Tailscale machine, tokens, the project. |
| `cost_guards` | Which cost guards are on, and whether the run-time cap stops or deletes the VM. |
| `cost_note` | The estimate below, with your disk size. |

## Cost (estimates, November 2026)

Prices change and differ by region. These are on-demand list prices for `us-central1` as found in
November 2026, before taxes and credits. Check
[VM pricing](https://cloud.google.com/compute/vm-instance-pricing),
[disk pricing](https://cloud.google.com/compute/disks-image-pricing),
[Cloud NAT pricing](https://cloud.google.com/nat/pricing) and the
[pricing calculator](https://cloud.google.com/products/calculator) before you rely on them.

| Item | Estimate | Billed when |
| --- | --- | --- |
| `n2-standard-4` | about USD 0.194/hour; about USD 142 for a 730-hour month, about USD 113 with the full-month sustained use discount | VM running |
| 64 GB `pd-balanced` boot disk | about USD 0.10/GB-month, so about USD 6.40/month | Always, also while stopped |
| Cloud NAT | about USD 0.0014/hour per VM using it, plus USD 0.005/hour for the NAT's external IP, plus USD 0.045 per GiB processed | Gateway exists / traffic flows |
| Ephemeral external IP (instead of NAT) | about USD 0.005/hour | VM running |
| Internet egress (to the agent's machine, through Tailscale) | per GiB, by destination | Traffic flows |

Example: running 8 hours a day on 22 working days (176 hours) costs roughly USD 34 for the VM plus
about USD 6.40 for the disk, plus a few dollars of NAT and traffic. Running all month costs
roughly USD 125–155 in total. Spot VMs and committed-use discounts are cheaper but are not
configured here; a Spot VM can be stopped at any time, which ends the leases on it.

## Stop, start, delete

```sh
gcloud compute instances stop  tapdance-n2 --zone us-central1-a --project my-tapdance-project
gcloud compute instances start tapdance-n2 --zone us-central1-a --project my-tapdance-project
terraform destroy
```

- **Stopping** ends vCPU and RAM billing. The disk keeps billing. Leases on the VM end: after a
  reboot Simlock releases a lease whose emulator is no longer running (reason `device-lost`).
- **Starting** boots the VM; with linger on (`host up` turns it on), the worker and guard start
  as systemd user services, and Tailscale reconnects with its `serve` setting. Seen on a real VM after
  its idle stop (STATUS.md G-07).
- **Pausing** without stopping the VM: `tapdance host pause` on the VM stops the guard, the worker
  and its emulators; `tapdance host resume` starts them again.
- **Deleting** with `terraform destroy` removes the VM, disk, network, NAT and service account. It
  does not disable the APIs, and it will not delete a project it created while
  `project_deletion_policy = "PREVENT"`. Then run the leftovers check
  (from the repository root `bash infrastructure/scripts/gcp-leftovers.sh <PROJECT_ID>`, or
  `terraform output leftovers_check` before you destroy): it lists VMs in any state, disks, snapshots,
  images, addresses, routers and NATs, and exits 0 only when nothing is left. Run it before
  `gcloud projects delete` and before unlinking billing; afterwards it cannot check (exit 2). Then
  remove the VM from your tailnet in the Tailscale admin console; the token on the agent's machine stops
  working with the VM. `infrastructure/scripts/revoke-run-credentials.sh` revokes the `gcloud` logins
  the run made, asking first.
- **Ephemeral mode** (`on_run_limit = "DELETE"`): Compute Engine deletes the VM and its disk at
  `max_run_hours`. The rest stays until `terraform destroy`, and Terraform's state still lists the VM,
  so `terraform plan` would create it again: destroy instead. For test runs, see
  [field-test-cloud-android.md](../../../docs/testing/field-test-cloud-android.md).

## Security

- **A pairing token gives device access, not a shell.** Through the worker guard its holder can
  lease the emulator, install and drive apps, and run the fixed device commands the guard allows,
  as the VM's user. Use this VM only for testing and keep no other credentials on it. See
  [device-only mode](../../../docs/security/personal-mac.md) and the
  [threat model](../../../docs/security/threat-model.md).
- **Tailscale is the only way in for the agent.** `tailscale serve` exposes the guard to your tailnet,
  not to the internet. A [Tailscale ACL](https://login.tailscale.com/admin/acls) that lets only the
  agent's machine reach port 4720 narrows it further.
- **Never commit tokens.** The pairing token lives in `~/.tapdance/worker/pairing-<label>.token`
  (mode 600) on the VM and in `~/.tapdance/credentials.json` on the agent's machine. Do not put it
  in `terraform.tfvars`, instance metadata, shell history or an issue.
- No inbound port is open except IAP SSH, and that one can be closed. ADB, the emulator console,
  Simlock's local API and the guard are blocked by the firewall even if something on the VM listens
  on them.

## Troubleshooting

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| `terraform validate` fails | Not validated before publishing | Open an issue with the error; fix it locally meanwhile. |
| `Constraint constraints/compute.disableNestedVirtualization violated` | Org policy blocks nested virtualization | Ask your organization admin to allow it for this project. |
| `Quota 'N2_CPUS' exceeded` | Regional quota too low | Request more quota, or pick another region. |
| `check-kvm.sh`: no `vmx` flag | Nested virtualization not active | Check `gcloud compute instances describe tapdance-n2 --zone ZONE --format='value(advancedMachineFeatures.enableNestedVirtualization)'` prints `True`. |
| `/dev/kvm` not writable | You are not in the kvm group yet | Run the setup script again: it adds you to the group and sets an ACL on `/dev/kvm`. After a reboot, log out and back in so the group applies. |
| `gcloud compute ssh` hangs or is refused | IAP or OS Login permissions | You need IAP tunnel access, `compute.osAdminLogin` and `iam.serviceAccountUser` (see `ssh_members`). Check the firewall rule exists (`enable_iap_ssh = true`). |
| apt or git downloads time out | No outbound route | Cloud NAT must exist (`assign_external_ip = false`) or the VM needs an external IP. |
| `tapdance connect` says the address did not answer | The agent's machine is not in the tailnet, or the guard is not running | `tailscale status` on both machines; `tapdance host status` on the VM. |
| `tailscale status` shows the VM's connection as `relay` | No direct path through Cloud NAT | It works, more slowly. `assign_external_ip = true` usually allows a direct path. |
| The emulator fails with a missing `.so` | A library the setup script did not add | Install it with apt and open an issue so the script can include it. |
| More | | See [Troubleshooting in the guide](../../../docs/deployment/google-cloud-n2.md#troubleshooting). |

## Credits

- [Simlock](https://github.com/callstackincubator/simlock) by Callstack (MIT): workers, gateway,
  leases, emulator lifecycle. The capacity, headless and uplink behaviour described here comes
  from its documentation.
- [agent-device](https://github.com/callstack/agent-device) by Callstack (MIT): device automation.
- Android SDK command-line tools, emulator and system images by Google, under the Android SDK
  licence.
- [Tailscale](https://tailscale.com/) connects the agent's machine to the VM.
- The legacy `infrastructure/scripts/install-android-worker.sh` (copied to `/opt/tapdance/` for the
  [gateway path](../../../docs/deployment/laptop-worker.md)) uses
  [NodeSource](https://github.com/nodesource/distributions) Node.js packages; it is no longer the
  recommended setup for this VM.
