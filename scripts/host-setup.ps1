# host-setup.ps1 — Tapdance device hosts cannot run on Windows. This script only explains why and
# what to do instead; it changes nothing on this machine.
#
# Status: not run on Windows yet (see STATUS.md).

$message = @'
Tapdance cannot host devices on Windows.

Device hosts run Simlock workers, and Simlock supports macOS and Linux only. `tapdance host up`
refuses on Windows with NOT_SUPPORTED.

What you can do instead:

1. Use this PC as the control machine (where your agent runs). Install Node.js 22.13+ and Tapdance
   from source (docs/installation.md), set up a Mac or Linux host with `tapdance host up`, copy the
   token file it writes to this PC, then:

     Get-Content pairing-<label>.token | tapdance connect https://<host>.<tailnet>.ts.net:4720

2. Host Android emulators on this PC inside Linux, with nested virtualization:
   - WSL2 on Windows 11: set nestedVirtualization=true under [wsl2] in %UserProfile%\.wslconfig,
     run `wsl --shutdown`, and check that /dev/kvm exists inside the distribution; or
   - a Linux VM (Hyper-V, VMware, VirtualBox) with nested virtualization (VT-x/AMD-V) enabled.
   Inside Linux, run:

     bash scripts/host-setup.sh

   The Android emulator needs /dev/kvm; Tapdance never falls back to software emulation. Neither
   WSL2 nor a Windows-hosted VM has been tested with Tapdance yet.

iOS simulators need a Mac.
'@

Write-Host $message
exit 1
