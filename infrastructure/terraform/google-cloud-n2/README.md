# Google Cloud N2 Android host (Terraform)

This module creates one Google Cloud VM that can run the Android Emulator with hardware acceleration.
After `apply` you run Tapdance's setup script on the VM; it installs everything and runs
`tapdance host up`, and the agent's machine connects over Tailscale with `tapdance connect`.

**The guide is [docs/deployment/google-cloud-n2.md](../../../docs/deployment/google-cloud-n2.md).** It
has the steps, the IAM roles, the costs, stopping and starting, cost guards, tear-down and
troubleshooting. This page lists only what the module creates, its variables and its outputs.

Applied in several field runs since 2026-11-03. First run: Terraform 1.17.1, `validate` passed, `apply`
created 13 resources in 99 s (`region = "europe-west1"`, `zone = "europe-west1-b"`,
`assign_external_ip = true`, `boot_disk_size_gb = 64`)
([evidence](../../../docs/testing/evidence/2026-11-03-gcp-n2-android.md)). Later runs applied
ephemeral mode (`on_run_limit = "DELETE"`, `max_run_hours = 6`, the cap not reached) with a budget
(18 resources), and `terraform destroy` removed them with `gcp-leftovers.sh` finding nothing
([evidence](../../../docs/testing/evidence/2026-11-03-vps-n2-android.md)). Not run: the Cloud NAT default
(`assign_external_ip = false`), `create_project` and `stop_schedule`.

## Use it

```bash
cd infrastructure/terraform/google-cloud-n2
terraform init
terraform validate
terraform plan -out tapdance.plan
terraform apply tapdance.plan
```

Put your inputs in `terraform.tfvars` (it is in `.gitignore`). At least:

```hcl
project_id  = "my-tapdance-project"
ssh_members = ["user:you@example.com"]
```

Then follow the guide from [Open a shell and check KVM](../../../docs/deployment/google-cloud-n2.md#open-a-shell-and-check-kvm).
`terraform output next_steps` prints those steps with your names filled in.

## What gets created

| Resource | Details |
| --- | --- |
| Project (optional) | Only with `create_project = true`. By default you pass an existing `project_id`. |
| APIs | `compute`, `iam`, `oslogin`, `cloudresourcemanager`, and `iap` when IAP SSH is on. Never disabled on destroy. |
| VPC and subnet | Dedicated network `<name>-vpc`, subnet `10.42.0.0/24` with Private Google Access. |
| Firewall | Ingress TCP 22 **only** from IAP's range `35.235.240.0/20`, only to the worker's tag. An explicit deny-all for every other ingress. No ADB, emulator, Simlock, guard or viewer port. |
| Outbound | Cloud Router and Cloud NAT (default), or an ephemeral external IP with `assign_external_ip = true`. |
| Service account | `<name>-worker@…`, scopes `logging.write` and `monitoring.write`, roles `logging.logWriter` and `monitoring.metricWriter` (turn off with `grant_logging_roles = false`). Nothing else. |
| VM | `n2-standard-4`, minimum CPU platform Intel Cascade Lake, **nested virtualization on**, Ubuntu 24.04 LTS (`ubuntu-2404-lts-amd64`), 64 GB `pd-balanced`, Shielded VM (Secure Boot, vTPM, integrity monitoring), OS Login on, project SSH keys blocked, no external IP. A run-time cap of 8 hours (`max_run_hours`). |
| Startup script | Installs the `qemu` KVM packages, `cpu-checker`, git, unzip and curl, writes a udev rule for `/dev/kvm`, loads `kvm_intel`, runs `kvm-ok`, and copies `check-kvm.sh` (and the older `install-android-worker.sh`, for [gateway mode](../../../docs/deployment/gateway-mode.md)) to `/opt/tapdance/`. It does **not** install Tapdance, log into Tailscale or pair anything. Log: `/var/log/tapdance-startup.log`. |
| SSH access (optional) | For each principal in `ssh_members`: IAP tunnel access to this VM, `roles/compute.osAdminLogin` on it, and `roles/iam.serviceAccountUser` on its service account. |
| Schedule (optional) | With `stop_schedule`: a Compute Engine stop schedule, and `roles/compute.instanceAdmin.v1` for the Compute Engine Service Agent, which Google requires for schedules. |
| Budget (optional) | With `budget_amount_usd` and `billing_account`: a monthly budget that e-mails at 50%, 90% and 100%. |

**No secret goes into Terraform.** Terraform state and instance metadata are readable by more people
and processes than you might expect: anyone with `compute.instances.get`, every process on the VM
through the metadata server, and whoever holds the state file. The pairing token is made on the VM by
`tapdance host up`, written to a mode-600 file, and copied to the agent's machine by you. The Tailscale
login happens in your browser. Still, never commit the state or `terraform.tfvars`.

## Variables

| Variable | Default | Notes |
| --- | --- | --- |
| `project_id` | (required) | Existing project, or the ID to create. |
| `create_project` | `false` | Create the project. Needs `billing_account` and `org_id` or `folder_id`. |
| `project_name`, `billing_account`, `org_id`, `folder_id` | | Used when creating the project; `billing_account` also for the budget. |
| `project_deletion_policy` | `PREVENT` | For a created project: `PREVENT`, `ABANDON` or `DELETE`. |
| `region`, `zone` | `us-central1`, `us-central1-a` | Pick a zone that offers N2. |
| `name` | `tapdance-n2` | Prefix for every resource. |
| `machine_type` | `n2-standard-4` | Must start with `n2-`: `n2d-*` and `e2-*` fail validation, because they lack nested virtualization. |
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
| `on_run_limit` | `"STOP"` | What happens at `max_run_hours`: `"STOP"` keeps the stopped VM and its disk (which bills); `"DELETE"` (ephemeral mode, for test hosts) deletes the VM and its boot disk. Needs `max_run_hours` and no `deletion_protection`. Use it with `tapdance host up --idle-stop off`. |
| `stop_schedule`, `schedule_time_zone` | `null`, `UTC` | A cron schedule that stops the VM. Changing it later recreates the VM. |
| `budget_amount_usd` | `null` | A monthly budget with alert e-mails (alerts only; it never stops the VM). Needs `billing_account`. |

What each cost guard does in practice: [cost guardrails](../../../docs/deployment/google-cloud-n2.md#cost-guardrails).

## Outputs

| Output | What it gives you |
| --- | --- |
| `instance_name`, `zone`, `project_id`, `internal_ip`, `service_account_email` | Identity of what was created. |
| `iap_ssh_command` | The `gcloud compute ssh … --tunnel-through-iap` command. |
| `next_steps` | The guide's steps after `apply`, with your names filled in. |
| `stop_command`, `start_command` | `gcloud compute instances stop/start …`. |
| `delete_command` | `terraform destroy`, plus removing the VM from your tailnet. |
| `destroy_command` | `terraform -chdir=<this folder> destroy`, to run from anywhere. |
| `leftovers_check` | `bash <repo>/infrastructure/scripts/gcp-leftovers.sh <project>`: lists what can still bill; exit 0 means nothing. |
| `teardown` | Every step that leaves nothing billing: destroy, the leftovers check, the Tailscale machine, tokens, the project. |
| `cost_guards` | Which cost guards are on, and whether the run-time cap stops or deletes the VM. |
| `cost_note` | A cost estimate with your disk size ([cost estimates](../../../docs/deployment/google-cloud-n2.md#cost-estimates-november-2026)). |

## Credits

- [Simlock](https://github.com/callstackincubator/simlock) by Callstack (MIT): workers, leases,
  emulator lifecycle.
- [agent-device](https://github.com/callstack/agent-device) by Callstack (MIT): device automation.
- Android SDK command-line tools, emulator and system images by Google, under the Android SDK licence.
- [Tailscale](https://tailscale.com/) connects the agent's machine to the VM.
- The older `infrastructure/scripts/install-android-worker.sh` uses
  [NodeSource](https://github.com/nodesource/distributions) Node.js packages.
