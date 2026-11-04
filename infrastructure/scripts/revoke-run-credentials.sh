#!/usr/bin/env bash
# revoke-run-credentials.sh — after a cloud host is torn down, take back the credentials the run left on
# the machine that provisioned it or drove it (the agent's machine). Teardown (terraform destroy,
# gcp-leftovers.sh, deleting the project) removes what bills, not these:
#
#   - gcloud logins: `gcloud auth login` and `gcloud auth application-default login` grant the
#     cloud-platform scope for the whole Google account, not just the test project. Their refresh tokens
#     sit in ~/.config/gcloud with no fixed expiry (valid until revoked, or unused for about 6 months),
#     usable by any process of this user.
#   - the Tapdance profile used for the host: a scratch TAPDANCE_HOME holding the saved pairing token.
#     The token stops working once the VM is gone (only that VM's guard knew it), but the file stays.
#   - things only the owner can remove on a website: the fine-grained GitHub token used on the VM (it
#     dies with the disk there, but stays valid on GitHub), and the VM's entry in Tailscale Machines.
#
# Every change is asked first, one by one; nothing is revoked without a yes. The user may have been
# logged in to gcloud before the run: answer no to keep a login you had before.
#
# Usage:
#   infrastructure/scripts/revoke-run-credentials.sh [--tapdance-home DIR] [--check]
#
#   --tapdance-home DIR  the scratch TAPDANCE_HOME of the run (default: $TAPDANCE_HOME when it is not
#                        ~/.tapdance). ~/.tapdance itself is never removed.
#   --check              change nothing: only print what is still credentialed
#
# Exit codes: 0 done (or --check printed), 2 usage error or no terminal to ask on.
# Status: run only against a stand-in gcloud; see STATUS.md.

set -uo pipefail

CHECK=0
TD_HOME="${TAPDANCE_HOME:-}"
while (( $# )); do
  case "$1" in
    --check) CHECK=1 ;;
    --tapdance-home) [[ $# -ge 2 ]] || { echo "--tapdance-home needs a directory" >&2; exit 2; }; TD_HOME="$2"; shift ;;
    -h|--help) sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

real_home="$(cd "$HOME" && pwd -P)"
if [[ -n "$TD_HOME" ]]; then
  td_real="$(cd "$TD_HOME" 2>/dev/null && pwd -P || true)"
  if [[ "$td_real" == "$real_home/.tapdance" || "$td_real" == "$real_home" || "$td_real" == "/" ]]; then
    echo "$TD_HOME is your own Tapdance home (or home folder); this script never removes it." >&2
    TD_HOME=""
  fi
fi

have_tty() { { : < /dev/tty; } 2>/dev/null; }
ask() {
  have_tty || { echo "no terminal to ask on; run it in a terminal (or with --check)" >&2; exit 2; }
  printf '%s [y/N] ' "$1" > /dev/tty
  local a; read -r a < /dev/tty
  [[ "$a" =~ ^[Yy] ]]
}

report() {
  echo "Still credentialed on this machine:"
  if command -v gcloud >/dev/null 2>&1; then
    local accounts; accounts="$(gcloud auth list --format='value(account)' 2>/dev/null || true)"
    if [[ -n "$accounts" ]]; then printf '  gcloud logins: %s\n' "$(printf '%s' "$accounts" | tr '\n' ' ')"; else echo "  gcloud logins: none"; fi
    # Prints nothing: only whether a token can still be minted (the token itself is discarded).
    if gcloud auth application-default print-access-token >/dev/null 2>&1; then echo "  gcloud application-default credentials: VALID"; else echo "  gcloud application-default credentials: none"; fi
  else
    echo "  gcloud: not installed"
  fi
  if [[ -n "$TD_HOME" ]]; then
    if [[ -e "$TD_HOME" ]]; then echo "  Tapdance profile $TD_HOME: still there (holds the saved pairing token)"; else echo "  Tapdance profile $TD_HOME: removed"; fi
  fi
  echo "Owner, on the web (this script cannot do it):"
  echo "  - GitHub: delete the fine-grained token used on the VM (Settings > Developer settings > Fine-grained tokens)."
  echo "  - Tailscale: remove the VM from https://login.tailscale.com/admin/machines"
}

if (( CHECK )); then report; exit 0; fi

if command -v gcloud >/dev/null 2>&1; then
  accounts="$(gcloud auth list --format='value(account)' 2>/dev/null || true)"
  if [[ -n "$accounts" ]] && ask "Revoke every gcloud login on this machine ($(printf '%s' "$accounts" | tr '\n' ' '))? Say no if you were logged in before the run."; then
    gcloud auth revoke --all
  fi
  if gcloud auth application-default print-access-token >/dev/null 2>&1 && ask "Revoke gcloud's application-default credentials (used by Terraform)?"; then
    gcloud auth application-default revoke --quiet
  fi
fi
if [[ -n "$TD_HOME" && -e "$TD_HOME" ]] && ask "Delete the run's Tapdance profile $TD_HOME (its saved token and settings)?"; then
  rm -rf -- "$TD_HOME"
fi
echo
report
