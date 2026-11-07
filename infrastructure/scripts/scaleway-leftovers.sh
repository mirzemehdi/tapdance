#!/usr/bin/env bash
# Lists everything in a Scaleway account that can still cost money after a rented Mac mini (Apple
# silicon) is released: Apple silicon servers in every zone, in any state (a powered-off Mac mini bills
# until it is deleted), and Private Networks (an Apple silicon server with Private Networks enabled
# bills that option by the hour).
#
# Read-only: it only runs `scw apple-silicon server list`, `scw apple-silicon private-network list` and
# `scw vpc private-network list`. It never creates, updates or deletes anything. It prints only names,
# ids, types, states, zones and dates: never the server's VNC URL or sudo password, which the API
# returns with each server.
#
# Usage:
#   infrastructure/scripts/scaleway-leftovers.sh                 # the scw CLI's default profile
#   SCW_PROFILE=<profile> infrastructure/scripts/scaleway-leftovers.sh
#   infrastructure/scripts/scaleway-leftovers.sh --project <PROJECT_ID>
#
# Needs the scw CLI (https://www.scaleway.com/en/docs/scaleway-cli/quickstart/), logged in with a key
# that may read Apple silicon and VPC resources, and jq.
#
# Exit codes:
#   0  nothing left that bills (in the kinds listed above)
#   1  something is left: delete it (the commands are printed)
#   2  could not check (usage error, scw or jq missing, not logged in, a list call failed)
#
# Prices are Scaleway's published rates read on 2026-11-06 (excluding VAT): Mac mini M1-M EUR 0.11/hour,
# M2-M 0.17, M2-L 0.21, M4-S 0.22, M4-SP 0.24, M4-M 0.29, M4-XL 0.49; Private Network for Apple silicon
# EUR 0.03/hour. Not covered: anything else in the account (Instances, Object Storage, ...) and charges
# already incurred. The Billing page of the Scaleway console is the final word.

set -uo pipefail

usage() {
  sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'
}

project=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h | --help) usage; exit 0 ;;
    --project)
      [[ $# -ge 2 ]] || { echo "--project needs a project id" >&2; exit 2; }
      project="$2"; shift ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if ! command -v scw >/dev/null 2>&1; then
  echo "scw is not installed or not on PATH: https://www.scaleway.com/en/docs/scaleway-cli/quickstart/" >&2
  exit 2
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "jq is not installed or not on PATH (brew install jq, or your package manager)" >&2
  exit 2
fi

scope=()
[[ -n "$project" ]] && scope=("project-id=$project")

found=0
unknown=0
errfile=$(mktemp)
trap 'rm -f "$errfile"' EXIT

# Runs a read-only scw list call with JSON output. Prints the JSON; on failure prints the error and
# returns 1.
list() {
  local out err
  if ! out=$(scw "$@" "${scope[@]+"${scope[@]}"}" -o json 2>"$errfile"); then
    err=$(cat "$errfile")
    echo "  could not check: $(printf '%s\n' "${err:-$out}" | grep -v '^$' | head -n 2 | tr '\n' ' ')" >&2
    return 1
  fi
  printf '%s' "${out:-[]}"
}

# report <kind> <cost hint> <rows>
report() {
  local kind="$1" hint="$2" rows="$3"
  if [[ -z "$rows" ]]; then
    printf '%-22s none\n' "$kind"
    return
  fi
  local n
  n=$(printf '%s\n' "$rows" | grep -c .)
  found=$((found + n))
  printf '%-22s %s LEFT\n' "$kind" "$n"
  printf '%s\n' "$rows" | sed 's/^/    /'
  printf '    cost: %s\n' "$hint"
}

echo "Billable Scaleway leftovers${project:+ in project $project} (read-only check, $(date -u +%Y-%m-%dT%H:%MZ))"
echo

# Apple silicon servers. Only the fields below are printed: the API also returns vnc_url (with the
# VNC password in it) and sudo_password.
servers_json=""
if ! servers_json=$(list apple-silicon server list zone=all); then
  printf '%-22s UNKNOWN (see the error above)\n' "Mac mini servers"
  unknown=$((unknown + 1))
else
  # A jq failure is UNKNOWN, never "none": printing nothing would read as nothing left.
  if ! rows=$(jq -r '.[]? | "\(.name) id=\(.id) type=\(.type) status=\(.status) zone=\(.zone) created=\(.created_at // "?") deletable_at=\(.deletable_at // "?") scheduled_deletion=\(.deletion_scheduled // .schedule_deletion // "?")"' <<<"$servers_json" 2>/dev/null); then
    printf '%-22s UNKNOWN (unexpected output from scw)\n' "Mac mini servers"
    unknown=$((unknown + 1))
  else
    report "Mac mini servers" \
      "billed by the hour from creation until deletion, also while powered off (M1-M about EUR 0.11/hour, EUR 2.64 a day). Deletion is refused before deletable_at (the 24-hour minimum)." \
      "$rows"
  fi
fi

# Private Networks attached to Apple silicon servers (zone-scoped), then VPC Private Networks in every
# region (an empty Private Network is free; the Apple silicon option on a server is what bills).
pn_rows=""
if ! pn_json=$(list apple-silicon private-network list zone=all); then
  printf '%-22s UNKNOWN (see the error above)\n' "Mac mini private nets"
  unknown=$((unknown + 1))
else
  if ! pn_rows=$(jq -r '.[]? | "server=\(.server_id) private_network=\(.private_network_id) status=\(.status // "?") zone=\(.zone // "?")"' <<<"$pn_json" 2>/dev/null); then
    printf '%-22s UNKNOWN (unexpected output from scw)\n' "Mac mini private nets"
    unknown=$((unknown + 1))
  else
    report "Mac mini private nets" \
      "Private Network for Apple silicon: about EUR 0.03/hour per server while enabled (EUR 0.06 for 10 Gbps)." \
      "$pn_rows"
  fi
fi

if vpc_json=$(list vpc private-network list region=all); then
  vpc_rows=$(jq -r '.[]? | "\(.name) id=\(.id) region=\(.region // "?")"' <<<"$vpc_json" 2>/dev/null) || vpc_rows=""
  if [[ -z "$vpc_rows" ]]; then
    printf '%-22s none\n' "VPC private networks"
  else
    printf '%-22s %s (free while empty; listed so you can delete the ones made for the test)\n' "VPC private networks" "$(printf '%s\n' "$vpc_rows" | grep -c .)"
    printf '%s\n' "$vpc_rows" | sed 's/^/    /'
  fi
else
  printf '%-22s UNKNOWN (see the error above; informational only)\n' "VPC private networks"
fi

echo
if [[ $unknown -gt 0 ]]; then
  echo "RESULT: could not check $unknown kind(s); fix the errors above and run this again. Do not assume nothing is left."
  status=2
elif [[ $found -gt 0 ]]; then
  echo "RESULT: $found billable resource(s) left."
  echo "  Delete each Mac mini once its deletable_at has passed (console: Bare Metal > Apple silicon > Delete):"
  echo "    scw apple-silicon server delete <id> zone=<zone>"
  echo "  Or have Scaleway delete it as soon as it may: scw apple-silicon server update <id> schedule-deletion=true zone=<zone>"
  echo "  Deletion wipes the disk and takes about 30 minutes; billing stops when it is deleted. Run this check again until it exits 0."
  status=1
else
  echo "RESULT: nothing left that bills in the kinds checked."
  status=0
fi

exit "$status"
