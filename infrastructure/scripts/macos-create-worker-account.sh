#!/usr/bin/env bash
# Creates a dedicated, standard (non-administrator) macOS account for the Tapdance worker, so remote
# device work runs under an account with none of the owner's files, keychains, SSH keys, iCloud or
# signing identities. Run it from an administrator account; it never stores or prints a password.
#
# Untested on real hardware as of 2026-11-01 (see STATUS.md, H-03). Read before running.
set -euo pipefail

ACCOUNT="${TAPDANCE_WORKER_ACCOUNT:-tapdance-worker}"
FULLNAME="Tapdance Worker"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script is for macOS." >&2
  exit 1
fi
if [[ $EUID -eq 0 ]]; then
  echo "Run it as an administrator user (it uses sudo for the steps that need it), not as root." >&2
  exit 1
fi
if dscl . -read "/Users/${ACCOUNT}" >/dev/null 2>&1; then
  echo "Account ${ACCOUNT} already exists; checking it instead of creating it."
else
  echo "Creating standard account ${ACCOUNT}. You will be asked for its new password (not stored)."
  # -password - prompts for the password; no -admin flag, so the account is a standard user.
  sudo sysadminctl -addUser "${ACCOUNT}" -fullName "${FULLNAME}" -password - -home "/Users/${ACCOUNT}"
  sudo createhomedir -c -u "${ACCOUNT}" >/dev/null
fi

# Never an administrator.
if dseditgroup -o checkmember -m "${ACCOUNT}" admin | grep -q "^yes"; then
  echo "Refusing: ${ACCOUNT} is in the admin group. Remove it: sudo dseditgroup -o edit -d ${ACCOUNT} -t user admin" >&2
  exit 1
fi

# The worker's home is private to it, and the owner's home is not readable by it.
sudo chmod 700 "/Users/${ACCOUNT}"
OWNER="$(stat -f %Su /dev/console)"
if [[ -n "${OWNER}" && "${OWNER}" != "${ACCOUNT}" && -d "/Users/${OWNER}" ]]; then
  OWNER_MODE="$(stat -f %Lp "/Users/${OWNER}")"
  if [[ "${OWNER_MODE}" != "700" && "${OWNER_MODE}" != "750" ]]; then
    echo "Note: /Users/${OWNER} is mode ${OWNER_MODE}; other accounts can list it. To close it: chmod 700 /Users/${OWNER}"
  fi
fi

cat <<NEXT

Account ${ACCOUNT} is ready. Do NOT sign it into iCloud, add SSH keys, or install signing certificates.

Next, as an administrator (system-wide, once):
  sudo xcode-select -s /Applications/Xcode.app
  sudo xcodebuild -license accept
  sudo xcodebuild -runFirstLaunch
  # With the open-source tailscaled daemon (not the Tailscale app): tailscaled lets only root and its
  # one operator account run \`tailscale serve\`, which host up uses. This makes ${ACCOUNT} the operator.
  sudo tailscale set --operator=${ACCOUNT}

Then sign in as ${ACCOUNT} (Fast User Switching keeps your own session open) and run:
  # install Node.js 22+ and Tapdance from source for this user (docs/installation.md)
  tapdance worker guard policy                   # review the device-only policy
  tapdance host up --label <control-machine>     # worker, guard service, pairing and
                                                 # \`tailscale serve\` (private, TLS, no public
                                                 # port), then a self-test; it prints the
                                                 # block to paste on the control machine

Remove everything later:
  sudo sysadminctl -deleteUser ${ACCOUNT}     # deletes the account and its home
NEXT
