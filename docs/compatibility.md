# Compatibility

Which versions Tapdance 0.1.0 has been run with, and what is only expected to work. "Tested" means
exercised on real devices and tools, with an evidence record. The runs date from 2026-11-01 to
2026-11-07; rows link their own evidence, and the rest link the
[first local run](testing/evidence/2026-11-01-local-ios.md). Everything else is marked.
[STATUS.md](../STATUS.md) is the authority on what is proven.

## Test hosts

The main test host: a MacBook Pro, Apple M1 Pro, 16 GB RAM, macOS 26.5 (arm64), in local mode (one
machine), with an iPhone 16 simulator on iOS 18.5 created by Simlock. The remote hosts (a Google Cloud N2
VM and a rented Scaleway Mac mini) and the Linux VPS used as the agent's machine have their own rows
below.

## Matrix

| Component | Version | Status with Tapdance 0.1.0 | Notes |
| --- | --- | --- | --- |
| Node.js | 22.22.0 | Tested | Minimum 22.13 (Tapdance's and Simlock's `engines`). `doctor` fails below it. |
| [Simlock](https://github.com/callstackincubator/simlock) | 0.5.0, patched | Tested (see notes for which runs) | Bundled, exact pin, with Tapdance's patch (`patches/simlock@0.5.0.patch`: stale Android records after a restart, #94; the guest CPU is logged when the clean baseline is captured, #103). Runs up to 2026-11-03 used Simlock 0.4.0: the local Mac, the gateway with its worker on one Mac, the first VPS runs and the first Google Cloud N2 runs. Runs from 2026-11-04 used 0.5.0 with the patch: the N2 reruns ([evidence](testing/evidence/2026-11-04-vps-n2-android-rerun.md)), the rented Scaleway Mac ([evidence](testing/evidence/2026-11-06-rented-mac-ios.md)) and the two-host run ([evidence](testing/evidence/2026-11-07-two-hosts-android-ios.md)). Gateway and worker on two machines not tested. |
| [agent-device](https://github.com/callstack/agent-device) | 0.21.35 | Tested | Bundled, exact pin. Simlock runs it through `capabilities.agent-device.command`. |
| Xcode | 26.5 (17F42) | Tested | iOS 18.5 runtime used; iOS 26.5 runtime installed but not leased in the recorded run. |
| [asc](https://github.com/rorkai/App-Store-Connect-CLI) | 5.17.1 (Homebrew) | Tested | `--version` and `apps list` through the CLI and `execute_tool`. |
| MCP TypeScript SDK | 1.32.2 | Tested (stdio) | Streamable HTTP partly verified: 401 without the token, tools listed, `list_devices` and `get_device_status` worked; a full device loop over HTTP not run. |
| pnpm | 10.20.0 | Used to build | Needed only to build from source. |
| [AXe](https://github.com/cameroncooke/AXe) | 1.8.0 | Tested | Release tarball, Xcode 26.5, iOS 26.5 simulator: install, launch, inspect, type, tap, wait, screenshot, MP4 ([evidence](testing/evidence/2026-11-01-axe.md)). |
| [Google's Android CLI](https://developer.android.com/tools/agents/android-cli) | 1.1.16717390 | Tested | `--version`, `layout --flat` on a leased emulator via `--device` ([evidence](testing/evidence/2026-11-01-android.md)). |
| Android SDK, emulator, system images | emulator 37.2.13, API 34 images (`google_apis`, `google_apis_playstore`) | Tested | On the test Mac (arm64, [evidence](testing/evidence/2026-11-01-android.md)) and on a Google Cloud N2 VM (x86_64, installed by `scripts/host-setup.sh`, [evidence](testing/evidence/2026-11-03-gcp-n2-android.md)). |
| Linux host with KVM: Google Cloud N2 | `n2-standard-4`, Ubuntu 24.04, nested virtualization | Tested | Terraform module, `scripts/host-setup.sh`, `host up` and `connect` from a Mac and from a Linux VPS; CLI and MCP checklists with a real app ([evidence](testing/evidence/2026-11-03-gcp-n2-android.md)). Other KVM hosts (bare metal, OVH) untested. |
| [Maestro](https://github.com/mobile-dev-inc/maestro) | any | **Untested** | Registered for pass-through. |
| [fastlane](https://github.com/fastlane/fastlane) | any | **Untested** | Registered for pass-through. |
| Cloud Mac: Scaleway Mac mini M1-M | 8 GB, macOS 27.2, Xcode 27.0, iOS 27.0 | Tested | `host-setup.sh --ios-only`, `host up`, `connect` from a Mac and from a Linux VPS; CLI and MCP checklists, host builds ([evidence](testing/evidence/2026-11-06-rented-mac-ios.md), [VPS](testing/evidence/2026-11-07-vps-rented-mac-ios.md)). One simulator at a time on 8 GB. |
| Cloud Macs: MacStadium, AWS EC2 Mac | | **Untested** | Documentation only. |
| Several connect targets | an N2 host (Android) and the Scaleway Mac (iOS) | Tested | One Linux VPS agent connected to both; one session leased Android, then iOS, through the CLI and MCP; with the Mac down, iOS leases failed fast with `PROVIDER_UNREACHABLE` while Android kept working ([evidence](testing/evidence/2026-11-07-two-hosts-android-ios.md)). |

Platform support:

| OS | Agent's machine (CLI, MCP) | Worker (host) | Gateway |
| --- | --- | --- | --- |
| macOS | Yes (tested) | iOS simulators (tested), Android emulators (tested) | Yes (tested with the worker on the same Mac) |
| Linux | Yes (tested: a Linux VPS as the agent's machine) | Android emulators with KVM (tested on a Google Cloud N2 VM) | Untested |
| Windows | Expected (untested) | **No**: Simlock supports macOS and Linux only | No |

## Simlock versions must match

Each Simlock release speaks one protocol version. A gateway and its workers must run Simlock versions
that can talk to each other; a worker on an incompatible version connects but is shown as
`incompatible` and gets no requests. A CLI and a running daemon of different versions can also refuse
each other with `PROTOCOL_VERSION_UNSUPPORTED` (restart the daemon after an upgrade).

Practical rule: run **Simlock 0.5.0 on the gateway and on every worker**, which is what Tapdance 0.1.0
bundles (with its patch, which does not change the protocol). Installing Tapdance from the same commit on every machine and using `tapdance worker …` /
`tapdance gateway …` gives you that. `tapdance doctor` warns when the endpoint reports another Simlock
version ("Tapdance is tested with 0.5.0").

## agent-device on workers

Tapdance talks to agent-device through Simlock's `/v1/agent-device` proxy, so the agent-device on each
**worker** matters. `tapdance worker install` and `worker login` point Simlock at the agent-device bundled
with Tapdance (0.21.35). If you configure a worker by hand, use the same version.

## Upgrades

Tapdance pins exact versions of Simlock and agent-device and never upgrades them, Xcode, the Android SDK
or external tools by itself. To upgrade, update every machine to the same Tapdance commit, run
`pnpm install && pnpm build`, then `tapdance worker restart` on workers (it also installs a login
service that still names the old Simlock folder again) and, on the gateway,
`tapdance simlock -- --gateway daemon stop` followed by `tapdance simlock -- --gateway daemon start`, so
the new Simlock runs everywhere. `tapdance tools versions` shows external tool versions.

When you run a combination not listed as tested, `tapdance report` collects the versions for an issue.
