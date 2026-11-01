#!/usr/bin/env bash
# check-kvm.sh — read-only diagnostic: can this Linux machine run the Android Emulator with
# hardware acceleration (KVM)?
#
# It installs nothing and changes nothing. Run it as the user that will run the Tapdance worker:
#
#   bash infrastructure/scripts/check-kvm.sh
#
# Exit codes:
#   0  KVM acceleration is usable by this user
#   1  KVM acceleration is not usable (the report says why and what to do)
#   2  not a Linux x86_64 machine, or a usage error
#
# Tapdance never falls back to software emulation. If this script fails, fix the cause it reports
# or run the emulator on another machine (your laptop, a bare-metal server, a Google Cloud N2 VM).
# Status of this script: syntax-checked only (bash -n). Not yet run on a real machine; see STATUS.md.

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: check-kvm.sh [--android-home DIR] [--quiet]

Checks, in order: OS and CPU architecture, CPU virtualization flags (vmx/svm), the kvm kernel
modules, /dev/kvm and this user's access to it, kvm-ok (from cpu-checker), and the Android
Emulator's own -accel-check when the SDK is found.

  --android-home DIR  Android SDK to use for `emulator -accel-check`
                      (default: $ANDROID_HOME, then $ANDROID_SDK_ROOT, then ~/android-sdk)
  --quiet             print only failures and the final verdict
  -h, --help          show this help
EOF
}

ANDROID_SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/android-sdk}}"
QUIET=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --android-home) ANDROID_SDK="${2:?--android-home needs a directory}"; shift 2 ;;
    --quiet) QUIET=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

FAILURES=0
ok()   { [[ $QUIET -eq 1 ]] || printf '  [ok]   %s\n' "$*"; }
info() { [[ $QUIET -eq 1 ]] || printf '         %s\n' "$*"; }
bad()  { printf '  [FAIL] %s\n' "$*"; FAILURES=$((FAILURES + 1)); }
warn() { printf '  [warn] %s\n' "$*"; }
fix()  { printf '         fix: %s\n' "$*"; }

gcp_hint() {
  cat <<'EOF'
         On Google Cloud: the VM must be an N2 (Intel) instance created with nested
         virtualization enabled (Terraform: advanced_machine_features.enable_nested_virtualization
         = true; gcloud: --enable-nested-virtualization). N2D, E2, Arm and most AMD machine types do
         not work. Check the organization policy constraint
         constraints/compute.disableNestedVirtualization is not enforced for the project:
           gcloud resource-manager org-policies describe \
             constraints/compute.disableNestedVirtualization --project=PROJECT_ID --effective
         Check the instance itself (from your laptop):
           gcloud compute instances describe INSTANCE --zone=ZONE \
             --format='value(advancedMachineFeatures.enableNestedVirtualization)'
         On other clouds and VPS plans: ask the provider whether nested virtualization (VT-x
         passed to the guest) is enabled for your plan. Many cheap VPS plans do not offer it.
         On bare metal: enable Intel VT-x or AMD-V (SVM) in the firmware/BIOS settings.
EOF
}

[[ $QUIET -eq 1 ]] || echo "Tapdance KVM check"

# 1. OS and architecture -------------------------------------------------------------------
if [[ "$(uname -s)" != "Linux" ]]; then
  echo "This check is for Linux. On macOS the Android Emulator uses Apple's Hypervisor.framework;" >&2
  echo "run 'tapdance worker check' instead." >&2
  exit 2
fi
ARCH="$(uname -m)"
if [[ "$ARCH" != "x86_64" ]]; then
  bad "CPU architecture is $ARCH; this check and Tapdance's Linux worker scripts expect x86_64"
  exit 2
fi
ok "Linux $(uname -r), $ARCH"
if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  info "OS: ${PRETTY_NAME:-unknown}"
fi

# 2. CPU flags -----------------------------------------------------------------------------
CPU_FLAG=""
if grep -Eqw 'vmx' /proc/cpuinfo; then CPU_FLAG="vmx"; elif grep -Eqw 'svm' /proc/cpuinfo; then CPU_FLAG="svm"; fi
if [[ -n "$CPU_FLAG" ]]; then
  ok "CPU virtualization flag: $CPU_FLAG"
else
  bad "Neither vmx (Intel VT-x) nor svm (AMD-V) is in /proc/cpuinfo: the hypervisor does not pass virtualization to this machine"
  gcp_hint
fi
if [[ -r /sys/class/dmi/id/product_name ]]; then
  info "Machine: $(cat /sys/class/dmi/id/product_name 2>/dev/null || true)"
fi
MODEL="$(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2- | sed 's/^ *//' || true)"
[[ -z "$MODEL" ]] || info "CPU: $MODEL ($(nproc) vCPUs)"

# 3. Kernel modules ------------------------------------------------------------------------
if [[ -r /proc/modules ]] && grep -Eq '^kvm(_intel|_amd)? ' /proc/modules; then
  ok "kvm kernel modules loaded: $(grep -Eo '^kvm(_intel|_amd)?' /proc/modules | sort -u | tr '\n' ' ')"
elif [[ -d /sys/module/kvm ]]; then
  ok "kvm is built into the kernel"
else
  bad "kvm kernel modules are not loaded"
  if [[ "$CPU_FLAG" == "vmx" ]]; then fix "sudo modprobe kvm_intel"; elif [[ "$CPU_FLAG" == "svm" ]]; then fix "sudo modprobe kvm_amd"; fi
fi

# 4. /dev/kvm ------------------------------------------------------------------------------
if [[ -e /dev/kvm ]]; then
  # shellcheck disable=SC2012
  info "$(ls -l /dev/kvm)"
  if [[ -r /dev/kvm && -w /dev/kvm ]]; then
    ok "/dev/kvm is readable and writable by $(id -un)"
  else
    bad "/dev/kvm exists but $(id -un) cannot open it read-write"
    if id -nG "$(id -un)" | grep -qw kvm; then
      if id -nG | grep -qw kvm; then
        fix "the device's group or mode is wrong; a udev rule fixes it: KERNEL==\"kvm\", GROUP=\"kvm\", MODE=\"0660\" (install-android-worker.sh writes one)"
      else
        fix "you were added to the kvm group after this login: log out and back in, or run 'newgrp kvm'"
      fi
    else
      fix "sudo usermod -aG kvm $(id -un), then log out and back in"
    fi
  fi
else
  bad "/dev/kvm does not exist"
  if [[ -n "$CPU_FLAG" ]]; then
    fix "load the module (sudo modprobe kvm_intel or kvm_amd) and check 'sudo dmesg | grep -i kvm'"
  fi
fi

# 5. kvm-ok --------------------------------------------------------------------------------
if command -v kvm-ok >/dev/null 2>&1; then
  KVM_OK_OUT="$(kvm-ok 2>&1 || true)"
  if grep -q "KVM acceleration can be used" <<<"$KVM_OK_OUT"; then
    ok "kvm-ok: KVM acceleration can be used"
  else
    bad "kvm-ok says KVM acceleration cannot be used:"
    sed 's/^/           /' <<<"$KVM_OK_OUT"
  fi
else
  warn "kvm-ok not installed (sudo apt-get install cpu-checker); skipping"
fi

# 6. Kernel messages (best effort; dmesg can need root) -------------------------------------
if DMESG="$(dmesg 2>/dev/null | grep -i kvm | tail -n 5)"; then
  if [[ -n "$DMESG" ]]; then
    info "recent kernel messages about kvm:"
    sed 's/^/           /' <<<"$DMESG"
  fi
fi

# 7. Android Emulator ----------------------------------------------------------------------
EMULATOR="$ANDROID_SDK/emulator/emulator"
if [[ -x "$EMULATOR" ]]; then
  ACCEL_OUT="$("$EMULATOR" -accel-check 2>&1 || true)"
  if grep -q "is installed and usable" <<<"$ACCEL_OUT"; then
    ok "emulator -accel-check: $(grep 'is installed and usable' <<<"$ACCEL_OUT" | head -n1)"
  else
    bad "emulator -accel-check does not report usable acceleration:"
    sed 's/^/           /' <<<"$ACCEL_OUT"
  fi
else
  info "Android Emulator not found at $EMULATOR; skipped -accel-check (pass --android-home)"
fi

# Verdict ----------------------------------------------------------------------------------
echo
if [[ $FAILURES -eq 0 ]]; then
  echo "KVM acceleration is usable. This machine can host Android emulators for Tapdance."
  exit 0
fi
echo "KVM acceleration is NOT usable ($FAILURES problem(s) above)."
echo "Do not run the Android Emulator here without acceleration: Tapdance and Simlock will not"
echo "fall back to software emulation. Fix the problems above, or use another machine as the worker."
exit 1
