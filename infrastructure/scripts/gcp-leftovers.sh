#!/usr/bin/env bash
# Lists everything in a Google Cloud project that can still cost money after a Tapdance host is torn
# down: VMs in any state, disks, snapshots, machine images, custom images, reserved addresses, Cloud
# Routers with their Cloud NAT gateways, forwarding rules and Cloud Storage buckets. Prints a cost hint
# for each kind it finds.
#
# Read-only: it only runs `gcloud ... list`, `gcloud services list` and `gcloud projects describe`. It
# never creates, stops or deletes anything. `--delete-project` only PRINTS the command that deletes the
# whole project.
#
# Usage:
#   infrastructure/scripts/gcp-leftovers.sh <PROJECT_ID>
#   infrastructure/scripts/gcp-leftovers.sh <PROJECT_ID> --delete-project
#
# Exit codes:
#   0  nothing left that bills (in the kinds listed above)
#   1  something is left: delete it (terraform destroy, or the gcloud delete commands printed)
#   2  could not check (usage error, gcloud missing or not logged in, a list call failed or warned
#      that some requests did not succeed, or the project is already being deleted)
#
# Run it BEFORE `gcloud projects delete` and before unlinking billing. Afterwards the project is
# DELETE_REQUESTED, the Compute Engine lists answer "billing must be enabled", and nothing can be
# checked any more (its resources stop billing when the project shuts down).
#
# Prices are estimates from Google's published rates in November 2026 (us-central1 / europe-west1); see
# docs/deployment/google-cloud-n2.md#cost-estimates-november-2026 and Google's pricing pages.
# Not covered: anything outside these kinds (for example Cloud SQL, GKE, Artifact Registry), and
# charges already incurred. The billing reports in the Cloud console are the final word.

set -uo pipefail

usage() {
  sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'
}

project=""
print_delete=0
for arg in "$@"; do
  case "$arg" in
    -h | --help) usage; exit 0 ;;
    --delete-project) print_delete=1 ;;
    -*) echo "unknown option: $arg" >&2; usage >&2; exit 2 ;;
    *)
      if [[ -n "$project" ]]; then echo "only one project id, please (got '$project' and '$arg')" >&2; exit 2; fi
      project="$arg" ;;
  esac
done

if [[ -z "$project" ]]; then
  echo "usage: $0 <PROJECT_ID> [--delete-project]" >&2
  exit 2
fi
if ! [[ "$project" =~ ^[a-z][-a-z0-9]{4,28}[a-z0-9]$ ]]; then
  echo "'$project' does not look like a Google Cloud project id (6-30 lowercase letters, digits, hyphens)" >&2
  exit 2
fi
if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud is not installed or not on PATH: https://cloud.google.com/sdk/docs/install" >&2
  exit 2
fi

found=0
unknown=0

errfile=$(mktemp)
trap 'rm -f "$errfile"' EXIT

# Runs a read-only gcloud list call. Prints its rows (stdout only); on failure, or when gcloud exits 0
# but warns that some requests did not succeed (a partial list), prints the error and returns 1.
list() {
  local out err
  if ! out=$(gcloud "$@" --project "$project" --quiet 2>"$errfile"); then
    err=$(cat "$errfile")
    echo "  could not check: $(printf '%s\n' "${err:-$out}" | grep -v '^$' | head -n 2 | tr '\n' ' ')" >&2
    return 1
  fi
  err=$(cat "$errfile")
  if grep -qE '[Dd]id not succeed|requires billing|^ERROR' <<<"$err"; then
    echo "  could not check: $(printf '%s\n' "$err" | grep -v '^$' | head -n 3 | tr '\n' ' ')" >&2
    return 1
  fi
  printf '%s' "$out"
}

# report <kind> <cost hint> <rows>
report() {
  local kind="$1" hint="$2" rows="$3"
  if [[ -z "$rows" ]]; then
    printf '%-18s none\n' "$kind"
    return
  fi
  local n
  n=$(printf '%s\n' "$rows" | grep -c .)
  found=$((found + n))
  printf '%-18s %s LEFT\n' "$kind" "$n"
  printf '%s\n' "$rows" | sed 's/^/    /'
  printf '    cost: %s\n' "$hint"
}

# check <kind> <cost hint> <gcloud args...>
check() {
  local kind="$1" hint="$2"
  shift 2
  local rows
  if ! rows=$(list "$@"); then
    printf '%-18s UNKNOWN (see the error above)\n' "$kind"
    unknown=$((unknown + 1))
    return
  fi
  report "$kind" "$hint" "$rows"
}

echo "Billable leftovers in project $project (read-only check, $(date -u +%Y-%m-%dT%H:%MZ))"
echo

# A project already being deleted (gcloud projects delete) cannot be checked: say so instead of
# reporting the errors (or warnings) its lists return.
state=$(gcloud projects describe "$project" --format='value(lifecycleState)' 2>/dev/null || true)
if [[ "$state" == DELETE_REQUESTED ]]; then
  echo "Project $project is DELETE_REQUESTED (gcloud projects delete ran): it is shut down, its resources"
  echo "stop billing, and this check cannot list them any more. Run it before deleting a project next time."
  echo "To be sure nothing bills, see Billing > Reports in the Cloud console for the billing account."
  exit 2
fi

enabled=$(list services list --enabled --format='value(config.name)') || {
  echo "Cannot list the project's enabled APIs. Check the project id and that gcloud is logged in (gcloud auth login)." >&2
  exit 2
}

if printf '%s\n' "$enabled" | grep -qxF 'compute.googleapis.com'; then
  check "instances" \
    "RUNNING bills vCPU and RAM (n2-standard-4: about USD 0.19-0.21/hour); TERMINATED (stopped) bills no vCPU or RAM but its disks still bill; SUSPENDED bills memory and disks." \
    compute instances list --format='value(name,zone.basename(),status,machineType.basename())'
  check "disks" \
    "about USD 0.10-0.11 per GB-month (pd-balanced; pd-ssd more), whether the VM runs, is stopped or is gone: a 64 GB disk is about USD 6.40-7 a month." \
    compute disks list --format='value(name,zone.basename(),region.basename(),sizeGb,type.basename(),status)'
  check "snapshots" \
    "about USD 0.05 per GB-month of stored data (about USD 1 a month for 20 GB)." \
    compute snapshots list --format='value(name,diskSizeGb,storageBytes)'
  check "machine images" \
    "billed for the stored data, like snapshots." \
    compute machine-images list --format='value(name,totalStorageBytes)'
  check "custom images" \
    "about USD 0.05 per GB-month of image storage." \
    compute images list --no-standard-images --format='value(name,diskSizeGb,archiveSizeBytes)'
  check "addresses" \
    "a reserved static IP bills by the hour, at a higher rate while no running VM uses it." \
    compute addresses list --format='value(name,region.basename(),status,addressType)'
  check "forwarding rules" \
    "load balancer and protocol forwarding rules bill by the hour." \
    compute forwarding-rules list --format='value(name,region.basename(),IPAddress)'

  if ! routers=$(list compute routers list --format='value(name,region.basename())'); then
    printf '%-18s UNKNOWN (see the error above)\n' "routers / NAT"
    unknown=$((unknown + 1))
  elif [[ -z "$routers" ]]; then
    printf '%-18s none\n' "routers / NAT"
  else
    rows=""
    while read -r name region; do
      [[ -z "$name" ]] && continue
      if ! nats=$(list compute routers nats list --router "$name" --region "$region" --format='value(name)'); then
        unknown=$((unknown + 1))
        nats="?"
      fi
      rows+="router $name ($region), NAT gateways: $(printf '%s' "${nats:-none}" | tr '\n' ' ')"$'\n'
    done <<<"$routers"
    report "routers / NAT" \
      "a Cloud Router itself is free; a Cloud NAT gateway bills per VM using it, for its IP addresses and per GiB processed (https://cloud.google.com/nat/pricing). terraform destroy removes the module's router and NAT." \
      "${rows%$'\n'}"
  fi
else
  echo "Compute Engine API is not enabled in this project: no VMs, disks, snapshots, images, addresses or NAT gateways can exist."
fi

if printf '%s\n' "$enabled" | grep -qxE 'storage(-api|-component)?\.googleapis\.com'; then
  check "storage buckets" \
    "Cloud Storage bills per GB-month stored (a remote Terraform state, uploaded files)." \
    storage buckets list --format='value(name,location)'
else
  printf '%-18s none (Cloud Storage API not enabled)\n' "storage buckets"
fi

echo
if [[ $unknown -gt 0 ]]; then
  echo "RESULT: could not check $unknown kind(s); fix the errors above and run this again. Do not assume nothing is left."
  status=2
elif [[ $found -gt 0 ]]; then
  echo "RESULT: $found billable resource(s) left in $project."
  echo "  Terraform route: terraform destroy in the module directory (terraform output destroy_command)."
  echo "  Then delete what is still listed, e.g.:"
  echo "    gcloud compute instances delete <NAME> --zone <ZONE> --project $project"
  echo "    gcloud compute disks delete <NAME> --zone <ZONE> --project $project"
  echo "    gcloud compute snapshots delete <NAME> --project $project"
  echo "  and run this check again until it exits 0."
  status=1
else
  echo "RESULT: nothing left that bills in the kinds checked. (A Google Cloud budget and the project itself cost nothing.)"
  status=0
fi

if [[ $print_delete -eq 1 ]]; then
  echo
  echo "To delete the whole project (NOT run by this script; it removes everything in it, for every user):"
  echo "  gcloud projects delete $project"
  echo "The project is shut down at once and deleted after about 30 days; billing for its resources stops when"
  echo "it is shut down. Its id cannot be used again. Only do this for a project made for the test."
fi

exit "$status"
