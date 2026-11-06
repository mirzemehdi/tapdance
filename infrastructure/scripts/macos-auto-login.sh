#!/usr/bin/env bash
# Turns on automatic login for a macOS account, so its login services (the Tapdance worker and guard
# LaunchAgents) start after a reboot with nobody at the screen. For a Mac you reach only over ssh, such
# as a rented Mac mini. iOS simulators themselves do not need a login session; the LaunchAgents do.
#
# Usage (as an administrator, in an interactive terminal; asks for the sudo password, then for the
# account's login password, neither echoed nor stored anywhere but /etc/kcpassword):
#   infrastructure/scripts/macos-auto-login.sh [account]      # default: the current user
#   infrastructure/scripts/macos-auto-login.sh --off
#   infrastructure/scripts/macos-auto-login.sh --status
#
# Apple's `sudo sysadminctl -autologin set -userName <account> -password -` is the first thing to try. On
# macOS 27.2 over ssh it failed on a Scaleway Mac mini with "SACSetAutoLoginPassword error:22" although
# the password was right (twice). This script writes what the Users & Groups pane writes instead: /etc/kcpassword (the password XOR-obfuscated with a fixed key, root-only,
# mode 600) and `autoLoginUser` in /Library/Preferences/com.apple.loginwindow.
#
# Security: /etc/kcpassword is obfuscation, not encryption: anyone who can read it as root recovers the
# password. Use automatic login only on a Mac that is dedicated to hosting (nothing of yours on it), and
# never with FileVault on (it would not work anyway: FileVault needs the password at boot).
#
# Untested beyond one Scaleway Mac mini (macOS 27.2) as of 2026-11-06.
set -euo pipefail

die() { printf 'macos-auto-login: %s\n' "$*" >&2; exit 1; }
[[ "$(uname -s)" == Darwin ]] || die "this script is for macOS."
[[ ${EUID:-$(id -u)} -ne 0 ]] || die "run it as an administrator user (it uses sudo), not as root."

PREFS=/Library/Preferences/com.apple.loginwindow
case "${1:-}" in
  --status)
    user="$(defaults read "$PREFS" autoLoginUser 2>/dev/null || true)"
    if [[ -n "$user" ]] && sudo test -f /etc/kcpassword; then echo "automatic login: ON for $user"; else echo "automatic login: OFF"; fi
    exit 0 ;;
  --off)
    sudo defaults delete "$PREFS" autoLoginUser 2>/dev/null || true
    sudo rm -f /etc/kcpassword
    echo "automatic login: OFF"
    exit 0 ;;
  -*) die "unknown option $1 (use an account name, --status or --off)" ;;
esac

user="${1:-$(id -un)}"
dscl . -read "/Users/$user" UniqueID >/dev/null 2>&1 || die "no local account named $user"
if fdesetup isactive >/dev/null 2>&1; then die "FileVault is on: automatic login cannot work (macOS needs the password at boot)."; fi
[[ -r /dev/tty ]] || die "run it in an interactive terminal (ssh -t)"

sudo -v
printf 'Login password of %s (not shown): ' "$user" > /dev/tty
IFS= read -rs pw < /dev/tty
printf '\n' > /dev/tty
[[ -n "$pw" ]] || die "empty password"
# Check it before writing anything, so a typo does not leave a broken automatic login behind. For the
# current user, sudo checks it (read from stdin, never on a command line); for another account, the
# reboot is the check.
if [[ "$user" == "$(id -un)" ]]; then
  printf '%s\n' "$pw" | sudo -k -S -p '' -v 2>/dev/null || { unset pw; die "that is not $user's login password"; }
else
  echo "note: cannot check another account's password here; the reboot will show whether it is right" > /dev/tty
fi

# What the Users & Groups pane writes: the password, padded with NUL bytes to a multiple of 12, XORed
# with Apple's fixed 11-byte key. The password goes to python on stdin (printf is a shell builtin), so it
# never appears in a process list or the environment.
printf '%s' "$pw" | /usr/bin/python3 -c '
import sys
key = [125, 137, 82, 35, 210, 188, 221, 234, 163, 185, 31]
pw = sys.stdin.buffer.read()
pw += b"\0" * (12 - len(pw) % 12)
sys.stdout.buffer.write(bytes(b ^ key[i % len(key)] for i, b in enumerate(pw)))
' | sudo tee /etc/kcpassword > /dev/null
unset pw
sudo chown root:wheel /etc/kcpassword
sudo chmod 600 /etc/kcpassword
sudo defaults write "$PREFS" autoLoginUser -string "$user"
echo "automatic login: ON for $user (/etc/kcpassword)"
echo "Reboot to check: after it, \`who\` should list $user on console."
