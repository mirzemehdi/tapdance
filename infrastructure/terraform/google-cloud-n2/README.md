# Google Cloud N2 Android worker (Terraform)

This folder creates one Google Cloud VM that can run the Android Emulator with hardware
acceleration, so it can serve as a Tapdance Android worker. Your agent runs somewhere else (an
ordinary VPS, your laptop); the VM dials out to your gateway and needs no inbound port.

> **Status: written, not yet run.** This configuration was **not** checked with
> `terraform validate` (Terraform was not installed where it was written) and has **never been
> applied** to a real project. The install scripts were syntax-checked with `bash -n` only;
> `shellcheck` was not available. No N2, Android or two-machine flow has been tested. Run
> `terraform init && terraform validate` before your first `plan`, and read
> [STATUS.md](../../../STATUS.md) (rows G-01, G-02, D-02, Q-05) for the current state. Please open
> an issue with what you find.

The longer, step-by-step guide (IAM, quotas, troubleshooting) is
[docs/deployment/google-cloud-n2.md](../../../docs/deployment/google-cloud-n2.md).

## How the pieces fit

```text
agent (Claude Code, Codex, ...) ──► gateway (VPS, no KVM) ◄── outbound wss:// ── this N2 VM
        tapdance mcp / CLI              tapdance gateway                 Simlock worker + emulator
```

- The **gateway** is a Simlock gateway started by `tapdance gateway setup`. It needs Node.js only.
  See [`../../scripts/install-gateway.sh`](../../scripts/install-gateway.sh).
- The **worker** on this VM is a Simlock worker configured by `tapdance worker install`. It owns the
  emulator and joins the gateway with `tapdance worker login`.
- Device orchestration (leases, queue, worker uplink) is
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
| Startup script | Installs `qemu` KVM packages and `cpu-checker`, writes a udev rule for `/dev/kvm`, loads `kvm_intel`, runs `kvm-ok`, and copies `install-android-worker.sh` and `check-kvm.sh` to `/opt/tapdance/`. It does **not** install Tapdance or join a gateway. Log: `/var/log/tapdance-startup.log`. |
| SSH access (optional) | For each principal in `ssh_members`: IAP tunnel access to this VM, `roles/compute.osAdminLogin` on it, and `roles/iam.serviceAccountUser` on its service account. |

**The gateway join token never goes into Terraform.** Terraform state and instance metadata are
readable by more people and processes than you might expect (anyone with `compute.instances.get`,
every process on the VM through the metadata server, whoever holds the state file). You type the
token into `tapdance worker login` over IAP SSH instead, where it is read from a hidden prompt or
from stdin.

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

The install script pins Simlock's capacity to **one running emulator** (`--max-emulators 1`).
Reasons:

- An `n2-standard-4` has 4 vCPUs and 16 GB. Simlock budgets 4 GiB of RAM per emulator, and one
  emulator under nested virtualization with software GPU rendering (`swiftshader_indirect`, there
  is no GPU on this VM) keeps several vCPUs busy while it boots and while the screen streams.
- A second emulator on the same 4 vCPUs makes both slow: longer boots, "app not responding"
  dialogs, and UI waits that run into the agent's timeouts. Flaky devices are worse for an agent
  than a short queue.
- Simlock's own default on this machine size is also one (a quarter of the CPU count). Pinning it
  makes the choice explicit and survives a resize.
- Requirement G-01 in [PRODUCT.md](../../../PRODUCT.md) says one emulator per VM until benchmarked.
  Nobody has benchmarked yet.

To serve more devices, add more VMs (each joins the gateway as its own worker) rather than more
emulators per VM. If you measure a larger machine type, raise the limit with
`install-android-worker.sh --max-emulators N` and share your numbers in an issue.

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
- Each person who will SSH in needs IAP tunnel access, `roles/compute.osAdminLogin` (the install
  script uses sudo) and `roles/iam.serviceAccountUser` on the VM's service account. Listing them
  in `ssh_members` grants exactly these. `gcloud compute ssh` may also need `roles/compute.viewer`
  on the project to look the VM up.
- A Tapdance gateway reachable from the VM over `wss://` (TLS) or a private network such as
  Tailscale. See [`install-gateway.sh`](../../scripts/install-gateway.sh).

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

   It must end with "KVM acceleration is usable". If it does not, stop here and read
   [Troubleshooting](#troubleshooting). Tapdance never falls back to software emulation.

5. **Install the worker.** Read the Android SDK licences first (the script can show them to you
   when you leave the flag out); `--accept-android-licenses` accepts all of them for you:

   ```sh
   bash /opt/tapdance/install-android-worker.sh --accept-android-licenses \
     --gateway wss://gateway.example.com --label tapdance-n2
   ```

   The script installs KVM access, OpenJDK 17, Node.js 22, the Android command-line tools
   (checked against Google's published SHA-256), platform-tools, the emulator, the
   `system-images;android-35;google_apis;x86_64` image, and Tapdance from a git checkout. It then
   runs `tapdance worker check --android-only`, enables lingering, runs
   `tapdance worker install --service` (a systemd user service), and `emulator -accel-check`.
   Add `--boot-test` to boot one throw-away emulator as an end-to-end check. Run it with `--help`
   for every option.

6. **Join the gateway.** On the gateway, mint a join token (it is shown once):

   ```sh
   tapdance gateway token --role worker --label tapdance-n2
   ```

   On the VM, join. The token is read from a hidden prompt:

   ```sh
   tapdance worker login --accept-gateway-exec --gateway wss://gateway.example.com --label tapdance-n2
   ```

   Or from your laptop without opening a shell, passing the token on stdin:

   ```sh
   read -rs TOKEN && printf '%s\n' "$TOKEN" | gcloud compute ssh tapdance-n2 --zone us-central1-a \
     --tunnel-through-iap \
     --command 'bash -lc "tapdance worker login --accept-gateway-exec --gateway wss://gateway.example.com --label tapdance-n2 --token-stdin"'
   unset TOKEN
   ```

7. **Check from the gateway machine:**

   ```sh
   tapdance workers list
   tapdance devices
   tapdance device lease --platform android
   tapdance device release
   ```

8. **Optionally close SSH** once the worker has joined: set `enable_iap_ssh = false` and apply. The
   worker keeps running and reconnecting; it never needed inbound access.

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

## Outputs

| Output | What it gives you |
| --- | --- |
| `instance_name`, `zone`, `project_id`, `internal_ip`, `service_account_email` | Identity of what was created. |
| `iap_ssh_command` | The `gcloud compute ssh … --tunnel-through-iap` command. |
| `next_steps` | Steps 3–7 above with your names filled in. |
| `stop_command`, `start_command` | `gcloud compute instances stop/start …`. |
| `delete_command` | `terraform destroy`, plus revoking the join token on the gateway. |
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
| Internet egress (to your gateway) | per GiB, by destination | Traffic flows |

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
- **Starting** boots the VM; with lingering enabled, the worker's systemd user service starts and
  redials the gateway by itself (1 s, doubling up to 30 s between tries).
- **Deleting** with `terraform destroy` removes the VM, disk, network, NAT and service account. It
  does not disable the APIs, and it will not delete a project it created while
  `project_deletion_policy = "PREVENT"`. Afterwards revoke the worker's join token on the gateway:
  `tapdance simlock --gateway token list`, then `tapdance simlock --gateway token revoke <id>`.

## Security

- **An agent token is close to shell access.** Simlock's `exec` and agent-device let anyone with a
  valid agent token for the gateway run adb commands and install apps on this VM as the worker's
  user. Leasing is not a sandbox. Use this VM only for testing, keep no other credentials on it,
  and give every agent its own token.
- **A joined worker gives the gateway operator rights.** Whoever controls the gateway, or holds an
  operator token for it, can lease and release any device here, install system images and read
  the worker's configuration. Join only a gateway you trust as much as this VM.
- **TLS or a private network is required.** Tapdance refuses `ws://` to a public address. Use
  `wss://` behind Caddy (or another proxy that passes WebSockets) or a Tailscale address.
- **Never commit tokens.** The join token ends up in `~/.simlock/config.json` on the VM (mode 600).
  Do not put it in `terraform.tfvars`, instance metadata, shell history or an issue.
- No inbound port is open except IAP SSH, and that one can be closed. ADB, the emulator console and
  Simlock's local API are blocked by the firewall even if something on the VM listens on them.

## Troubleshooting

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| `terraform validate` fails | Not validated before publishing | Open an issue with the error; fix it locally meanwhile. |
| `Constraint constraints/compute.disableNestedVirtualization violated` | Org policy blocks nested virtualization | Ask your organization admin to allow it for this project. |
| `Quota 'N2_CPUS' exceeded` | Regional quota too low | Request more quota, or pick another region. |
| `check-kvm.sh`: no `vmx` flag | Nested virtualization not active | Check `gcloud compute instances describe tapdance-n2 --zone ZONE --format='value(advancedMachineFeatures.enableNestedVirtualization)'` prints `True`. |
| `/dev/kvm` not writable | Your login predates the kvm group | Log out and back in. The install script uses `sg kvm` meanwhile and restarts your systemd user manager so the service gets the group. |
| `gcloud compute ssh` hangs or is refused | IAP or OS Login permissions | You need IAP tunnel access, `compute.osAdminLogin` and `iam.serviceAccountUser` (see `ssh_members`). Check the firewall rule exists (`enable_iap_ssh = true`). |
| apt or git downloads time out | No outbound route | Cloud NAT must exist (`assign_external_ip = false`) or the VM needs an external IP. |
| Command-line tools SHA-256 mismatch | Google published a newer build | Take the new URL and SHA-256 from [developer.android.com/studio](https://developer.android.com/studio) ("Command line tools only") and pass `--cmdline-tools-url` / `--cmdline-tools-sha256`. |
| `tapdance workers list` does not show the VM | Wrong URL, revoked or reused token, proxy without WebSocket support | On the VM run `tapdance worker logs` and look for `Uplink to gateway` lines. A join token pairs with the first worker that uses it; mint one per worker. |
| The emulator fails with a missing `.so` | A library the install script did not add | Install it with apt and open an issue so the script can include it. |

## Credits

- [Simlock](https://github.com/callstackincubator/simlock) by Callstack (MIT): workers, gateway,
  leases, emulator lifecycle. The capacity, headless and uplink behaviour described here comes
  from its documentation.
- [agent-device](https://github.com/callstack/agent-device) by Callstack (MIT): device automation.
- Android SDK command-line tools, emulator and system images by Google, under the Android SDK
  licence.
- [NodeSource](https://github.com/nodesource/distributions) Node.js packages,
  [Caddy](https://caddyserver.com/) and [Tailscale](https://tailscale.com/) are used by the
  gateway script only when you ask for them.
