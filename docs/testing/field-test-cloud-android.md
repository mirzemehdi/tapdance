# Field test: Android on a Google Cloud N2 VM, end to end

A runbook an agent (or a person) can follow from nothing to a written evidence record, and back to
**nothing left that bills**. It creates a short-lived N2 VM in the owner's Google Cloud project, sets
it up as an Android device host, drives it from the agent's machine with the CLI and MCP checklists in
[`scripts/field-test/`](../../scripts/field-test/README.md), and tears everything down.

> **Status: this runbook has not been run as a whole yet.** It is built from the 2026-11-03 run
> ([evidence](evidence/2026-11-03-gcp-n2-android.md)), which used the same Terraform module, setup
> script and checks by hand. New since then and not yet run on a cloud: Terraform's ephemeral mode
> (`on_run_limit = "DELETE"`), `infrastructure/scripts/gcp-leftovers.sh`, the cloud cost line in
> `tapdance host up` and `tapdance host status`, and the checklist drivers in this form. See
> [STATUS.md](../../STATUS.md).

Background: [google-cloud-n2.md](../deployment/google-cloud-n2.md) (the guide for owners) and
[field-testing.md](field-testing.md) (the general rules for field-testing agents). This page adds the
order of steps, the checkpoints and the teardown.

## Ground rules

- **Cloud credentials are the owner's.** The agent never asks for, reads, prints or stores a password,
  a service account key, a billing account login, a Tailscale auth key or a GitHub token. The owner logs
  `gcloud` in on the machine that provisions (`gcloud auth login` and `gcloud auth application-default
  login`, in their own terminal), opens the Tailscale login links, and pastes any GitHub token on the VM
  themselves. Never create a service account key.
- **Ask the owner at every checkpoint** marked **ASK** below, wait for a clear yes, and do only what was
  approved. Creating, starting, resizing or deleting a cloud resource is always a checkpoint.
- **Keep a resource log** (below) from the first resource on, and **never end a session with billable
  resources left** unless the owner said in so many words to keep them; then tell them what they cost
  per day.
- **Scratch home only.** On the agent's machine, `TAPDANCE_HOME` is a scratch directory, never
  `~/.tapdance`. The checklist drivers refuse `~/.tapdance`.
- **No tokens in chat, issues, commits or evidence.** Pairing tokens start with `tdg_`, Simlock secrets
  with `slk_`. Move the pairing token file directly from the VM to the agent's machine.

## Checkpoints

| # | Checkpoint | Who | When |
| --- | --- | --- | --- |
| 1 | **ASK**: the plan: project, region and zone, machine type, `max_run_hours`, budget, the cost estimate, and that teardown at the end is part of the run | Owner approves | Before anything is created |
| 2 | Log `gcloud` in, and choose or create the project with billing | Owner | Before provisioning |
| 3 | **ASK**: `terraform apply` of the reviewed plan | Owner approves | Provision |
| 4 | **ASK**: install the Android SDK and accept its licences on the VM (`host-setup.sh` asks; yes accepts them) | Owner approves | Host setup |
| 5 | Open the Tailscale login link the VM prints | Owner | Host setup |
| 6 | Approve the pairing, or allow `--yes` | Owner | Host setup |
| 7 | Only for CI installs or host builds: log `gh` in on the VM with a fine-grained, read-only token | Owner pastes it | Before the app checklist |
| 8 | **ASK**: anything that would extend the run (a second VM, a bigger machine, a longer `max_run_hours`, a VM restart) | Owner approves | Any time |
| 9 | Teardown: `terraform destroy`, leftovers check, Tailscale machine, GitHub token, project (optional) | Agent runs what it can; owner does the rest | Always, at the end, also after a failure |

## Costs

Estimates for November 2026, on-demand, before taxes (see
[cost estimates](../deployment/google-cloud-n2.md#cost-estimates-november-2026); check Google's
pricing pages before relying on them):

| Item | Cost | Bills while |
| --- | --- | --- |
| `n2-standard-4` | about USD 0.19/hour (`us-central1`), 0.21/hour (`europe-west1`) | the VM runs |
| 64 GB `pd-balanced` boot disk | about USD 6.40-7 a month, about USD 0.01/hour | the disk exists: **also while the VM is stopped** |
| Ephemeral external IP (`assign_external_ip = true`) | about USD 0.005/hour | the VM runs |
| Egress to the agent's machine | per GiB; the live viewer is about 0.7 GB per hour of watching | traffic flows |
| Budget, VPC, firewall rules, service account | nothing | |

A test run of 4-6 hours costs about USD 1-1.50 plus traffic. With ephemeral mode the worst case for a
forgotten VM is `max_run_hours` of running, then nothing (the VM and its disk are deleted). With the
default `STOP` it is a stopped VM whose disk bills about USD 0.21 a day until someone deletes it.
**A Google Cloud budget only sends e-mails; it never stops or caps the VM.**

## Resource log

Keep this table in your notes (not in the repository) from the first resource on, and update it at
teardown. It is what you report to the owner at the end.

| Resource | Name / id | Created (UTC) | How to delete | Deleted (UTC) |
| --- | --- | --- | --- | --- |
| Terraform resources (VM, disk, VPC, firewall, service account, budget) | `tapdance-n2` in `<PROJECT_ID>` | | `terraform destroy` | |
| Project (only if made for the test) | `<PROJECT_ID>` | | owner: `gcloud projects delete <PROJECT_ID>` | |
| Tailscale machine | `tapdance-n2` | | owner: Tailscale admin console, Machines | |
| GitHub fine-grained token (if any) | name only, never the value | | owner: GitHub settings, Developer settings | |
| Pairing token copies | file paths on the agent's machine | | `rm` | |
| Scratch `TAPDANCE_HOME` | path | | `rm -rf` | |

## 1. Prerequisites

On the machine that provisions (the owner's computer, or the agent's machine if the owner logs `gcloud`
in there):

- [gcloud](https://cloud.google.com/sdk/docs/install), logged in by the owner, and
  [Terraform](https://developer.hashicorp.com/terraform/install) 1.5 or later (tested: 1.17.1).
- A project with billing, the IAM roles in
  [google-cloud-n2.md](../deployment/google-cloud-n2.md#iam-roles), 4 free `N2_CPUS` in the region, and
  nested virtualization allowed ([check](../deployment/google-cloud-n2.md#check-the-nested-virtualization-org-policy)).
- `gcloud config get-value billing/quota_project` empty or this project; otherwise add
  `--billing-project=<PROJECT_ID>` to every `gcloud` command below (2026-11-03 run, fix 15).
- For the budget: the billing account id and Billing Account Administrator or Costs Manager on it. If
  the owner lacks that, they create a budget in the console instead. Always have one.

On the agent's machine (a Mac, a Linux laptop or a Linux VPS):

- Node.js 22.13+, git, and this repository built: `corepack enable && pnpm install && pnpm build`.
- Tailscale, logged in to the owner's tailnet, with **MagicDNS** and **HTTPS Certificates** on
  ([DNS settings](https://login.tailscale.com/admin/dns)).
- A scratch home and a short name for the CLI. Below, `tapdance` means this repository's build:

  ```bash
  export TAPDANCE_HOME="$HOME/td-field-home"     # scratch, never ~/.tapdance
  alias tapdance="node $PWD/packages/cli/dist/main.js"
  ```

## 2. Plan and ask (checkpoint 1)

Write the plan for the owner, for example:

> Project `<PROJECT_ID>`, `europe-west1-b`, `n2-standard-4`, 64 GB disk, external IP (no Cloud NAT).
> Ephemeral mode: Compute Engine deletes the VM and its disk 6 hours after it starts. Budget USD 10
> with alert e-mails. Estimated cost: about USD 1.50 for 6 hours plus traffic. At the end I run
> `terraform destroy` and the leftovers check, and tell you the final state; you remove the Tailscale
> machine and any GitHub token. OK?

Do not go on without a yes.

## 3. Provision (checkpoints 2 and 3)

Work in the module's folder, and never commit `terraform.tfvars`, the state or a plan file (they stay
on the provisioning machine until teardown). In `infrastructure/terraform/google-cloud-n2/terraform.tfvars`:

```hcl
# never commit this file
project_id         = "<PROJECT_ID>"
region             = "europe-west1"
zone               = "europe-west1-b"
assign_external_ip = true      # no Cloud Router or NAT to leave behind
boot_disk_size_gb  = 64
max_run_hours      = 6         # long enough for the whole test; the VM is gone after it
on_run_limit       = "DELETE"  # ephemeral mode: delete the VM and its disk at the limit
budget_amount_usd  = 10
billing_account    = "XXXXXX-XXXXXX-XXXXXX"
```

```bash
cd infrastructure/terraform/google-cloud-n2
terraform init
terraform validate
terraform plan -out tapdance.plan     # show the owner the summary: "Plan: N to add, 0 to change, 0 to destroy"
terraform apply tapdance.plan         # only after the owner's yes; note the start and end time
terraform output cost_guards          # must say "deletes the VM and its disk 6 h after each start"
terraform output teardown             # keep this: it is the end of the run
```

Write the resources into the resource log now. The 6-hour clock starts when the VM is `RUNNING`.
Restarting the VM restarts the clock; ask first (checkpoint 8).

## 4. Set up the host (checkpoints 4-6)

```bash
gcloud compute ssh tapdance-n2 --zone=europe-west1-b --tunnel-through-iap   # --billing-project=<PROJECT_ID> if needed
bash /opt/tapdance/check-kvm.sh       # must end with "KVM acceleration is usable"
```

Then on the VM, as the logged-in user:

```bash
curl -fsSL https://raw.githubusercontent.com/mirzemehdi/tapdance/main/scripts/host-setup.sh \
  | bash -s -- --label field-agent --idle-stop off
```

- `--idle-stop off`: in ephemeral mode the run-time limit ends the VM. The guard's idle stop would
  power the VM off instead, which **clears the run-time countdown and leaves a stopped VM whose disk
  bills**.
- To test a branch that is not merged yet: `TAPDANCE_REF=<branch>` on `bash`, and the script's URL from
  that branch.
- The script lists what it will install and asks once; yes also accepts the Android SDK licences
  (checkpoint 4). It prints a Tailscale login link (checkpoint 5) and asks to approve the pairing on the
  terminal (checkpoint 6).
- It ends with the `TAPDANCE HOST READY` block. On a Google Cloud VM the block has a line
  `cloud VM:  Google Cloud, billed while running; its disk bills even when stopped. Delete it when you
  are done: …`, and `cost guard:` shows the idle stop off. Write down the endpoint.

`tapdance host status` on the VM shows the same as rows.

## 5. Connect the agent's machine

From the provisioning machine, copy the token straight to the agent's machine (never through chat):

```bash
gcloud compute scp --zone=europe-west1-b --tunnel-through-iap \
  tapdance-n2:.tapdance/worker/pairing-field-agent.token .
```

On the agent's machine, with the scratch home:

```bash
tapdance connect https://tapdance-n2.<tailnet>.ts.net:4720 < pairing-field-agent.token
rm pairing-field-agent.token
tapdance doctor
```

### Variant: the agent runs on a Linux VPS

The VPS needs no KVM. Install Tailscale on it, `sudo tailscale up` (the owner approves the machine in
the tailnet), clone and build this repository, and set the scratch home as above. Copy the token from
the provisioning machine to the VPS with `scp` (or run `gcloud compute scp` on the VPS if the owner
logged `gcloud` in there), then the same `connect`, `rm` and `doctor`. If the tailnet has ACLs, allow
the VPS to reach the VM's port 4720. Everything below is the same; the viewer needs a browser, so skip
it or open it from the owner's computer.

## 6. Run the checklists

```bash
for f in scripts/field-test/checklists/*.json; do node scripts/field-test/mcp-checklist.mjs --check "$f"; done
mkdir -p ~/td-field/out

node scripts/field-test/mcp-checklist.mjs scripts/field-test/checklists/mcp-base.json ~/td-field/out/mcp-base --param LAUNCHER_TAP=Chrome
scripts/field-test/cli-checklist.sh base ~/td-field/out/cli-base --param LAUNCHER_TAP=Chrome
```

For the app checklists, use the owner's app (or [examples/android-demo](../../examples/)): an APK on the
agent's machine, or a GitHub Actions artifact the host downloads. For the artifact route the owner logs
`gh` in on the VM with a fine-grained, read-only token for the repository whose CI made the artifact
(checkpoint 7; a token for another repository answers 404), and allow-lists it on the VM:
`tapdance host artifacts enable --repo <owner/repo>`.

```bash
node scripts/field-test/mcp-checklist.mjs scripts/field-test/checklists/mcp-app.json ~/td-field/out/mcp-app \
  --param APP_ID=<app id> --param CI_REPO=<owner/repo> --param CI_ARTIFACT=<artifact> --param DEBUGGABLE=1
scripts/field-test/cli-checklist.sh app ~/td-field/out/cli-app \
  --param APP_ID=<app id> --param APK=<path to .apk> --param TAP_TEXT=<a button> --param DEBUGGABLE=1
```

Optional: a build on the host (the owner allow-lists the repository on the VM with
`tapdance host builds enable --repo <url> --git-auth gh`; the app's own build needs, such as an NDK or
CMake, are the app's), then `scripts/field-test/cli-checklist.sh build …` and
`mcp-checklist.mjs …/mcp-build.json` with `BUILD_REPO`, `BUILD_REF`, `BUILD_DIR` and `APP_ID`. Optional,
with the owner at a browser: `tapdance view`, and the owner taking over (the agent's next action gets
`HUMAN_HELD`).

A failed step: retry once, then capture its output (each driver keeps every step's output in its
folder), and decide with the owner whether to go on. Do not edit `packages/` to make a step pass.

## 7. Measurements to record

| What | Where it comes from |
| --- | --- |
| `terraform apply` time and resource count | Terraform output, your clock |
| `host-setup.sh` time, first run (downloads included) | your clock |
| `connect` → `doctor` passing | your clock |
| Cold lease (first) and warm lease | `lease` step in both drivers |
| Key press, tap, `inspect`, screenshot, recording start and stop | the drivers' tables (CLI and MCP separately) |
| Install: APK upload and from CI | `install_apk`, `install_from_ci` steps; the APK's size |
| Build on the host (if run) | `build` step |
| Emulator memory and CPU at idle | on the VM: `ps -o rss,pcpu -C qemu-system-x86_64` (or `top`) |
| Disk used at the end | on the VM: `df -h /` |
| VM running time and estimated cost | apply time to destroy time × the hourly price |
| Each checkpoint: who did it, when | your notes |

## 8. Evidence record

Write `docs/testing/evidence/YYYY-MM-DD-gcp-n2-field-test.md` in the format of
[evidence/README.md](evidence/README.md). A skeleton:

```markdown
# Evidence: Android on a Google Cloud N2 VM with the field-test kit — YYYY-MM-DD

Real VM, real emulator, no mocks. <agent's machine> drove an n2-standard-4 VM over Tailscale. Run by
<who>. Result: <one line>.

## Environment
| Item | Value |
| --- | --- |
| Agent's machine | <machine, OS>; Tapdance <commit>; scratch TAPDANCE_HOME; sessions field-test-cli, field-test-mcp |
| Device host | n2-standard-4, <zone>, Ubuntu <version>, 64 GB pd-balanced, external IP |
| Terraform | <version>; on_run_limit = "DELETE", max_run_hours = <n>, budget USD <n> |
| Simlock, agent-device, emulator, system image | <versions> |
| Network | Tailscale with HTTPS Certificates |

## What ran
1. Provision — PASS/FAIL, times.
2. Host setup — …
3. CLI base / app / build — <passed>/<ran>, the table.
4. MCP base / app / build — <passed>/<ran>, the table.
5. Teardown — terraform destroy, gcp-leftovers.sh exit code, what the owner removed.

## Measurements
## What failed and why
## Results by requirement
## Cost (resource log, running time, estimate)
## Re-run
## Not covered
## Issues filed
```

## 9. Teardown (mandatory)

Do this at the end of every run, **also when the run failed or was cut short**. The plan the owner
approved in checkpoint 1 includes it; say that you are starting it. If the owner now wants to keep the
VM, record that in the resource log and tell them what it costs per day while running and while
stopped.

1. Release leases: `tapdance device release` (both sessions), or let the drivers' final `release`
   steps do it.
2. On the VM (if it still exists), optional: `tapdance host down --all --yes` removes the pairing and
   stops the worker. Not needed when the VM is deleted next.
3. Destroy, from the provisioning machine. This is needed **also when ephemeral mode already deleted the
   VM**: the network, firewall rules, service account and budget stay until `destroy`. Terraform plans to
   destroy what is left; a VM that is already gone is dropped from the state.

   ```bash
   cd infrastructure/terraform/google-cloud-n2
   terraform destroy            # read the plan: only this run's resources; then yes
   ```

4. Check that nothing bills. It must exit 0:

   ```bash
   bash infrastructure/scripts/gcp-leftovers.sh <PROJECT_ID>; echo "exit: $?"
   ```

   Exit 1 lists what is left with a cost hint and delete commands: delete it (ask the owner if it is not
   from this run; the project may hold other things) and run the check again. Exit 2 means it could not
   check; fix the error, never assume it is clean. With Terraform's state lost, delete this run's
   resources with `gcloud` by the names in the resource log, then run the check.
5. Project (only if it was made for the test, and only with the owner's yes):
   `bash infrastructure/scripts/gcp-leftovers.sh <PROJECT_ID> --delete-project` prints the command; the
   owner runs it.
6. The owner removes the VM from the tailnet in the
   [Tailscale admin console](https://login.tailscale.com/admin/machines), and deletes the GitHub token
   used on the VM (if any).
7. On the agent's machine: delete every copy of the pairing token, and the scratch home
   (`rm -rf "$TAPDANCE_HOME"`, which holds the saved token). Keep `~/td-field/out` until the evidence is
   written; it can hold screenshots of the owner's app.
8. Tell the owner, in one message: what was created, what was deleted and when, the leftovers check's
   result (exit 0), what they still have to do (Tailscale, GitHub token, project), and the cost: running
   hours × the hourly price, plus the disk for the same hours.

## Troubleshooting from the 2026-11-03 run

| Symptom | Fix |
| --- | --- |
| `gcloud compute ssh` says the OS Login API is not used in another project | `--billing-project=<PROJECT_ID>`, or `gcloud config unset billing/quota_project` |
| `host up` step 3: "Failed to connect to bus" over SSH | Fixed in `host up`; on an older checkout, update the branch |
| GitHub: "Deploy keys are disabled for this repository" | The organization turned deploy keys off; use `--git-auth gh` with a fine-grained token |
| 404 for a CI artifact | The token must select the repository whose CI made the artifact |
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | An earlier build signed with another key is installed: `tapdance app uninstall <app id>` |
| The VM is gone in the middle of the run | `max_run_hours` passed in ephemeral mode. Teardown still applies; ask the owner before creating a new one |
