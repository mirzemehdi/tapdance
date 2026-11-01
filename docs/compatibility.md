# Compatibility

Which versions Tapdance 0.1.0 has been run with, and what is only expected to work. "Tested" means
exercised on real devices and tools on 2026-11-01
([evidence](testing/evidence/2026-11-01-local-ios.md)); everything else is marked. [STATUS.md](../STATUS.md)
is the authority on what is proven.

## Test host

MacBook Pro, Apple M1 Pro, 16 GB RAM, macOS 26.5 (arm64), local mode (one machine). iPhone 16 simulator
on iOS 18.5, created by Simlock.

## Matrix

| Component | Version | Status with Tapdance 0.1.0 | Notes |
| --- | --- | --- | --- |
| Node.js | 22.22.0 | Tested | Minimum 22.13 (Tapdance's and Simlock's `engines`). `doctor` fails below it. |
| [Simlock](https://github.com/callstackincubator/simlock) | 0.4.0 | Tested (local worker; gateway + joined worker on one Mac) | Bundled, exact pin. Gateway and worker on two machines not tested. |
| [agent-device](https://github.com/callstack/agent-device) | 0.21.35 | Tested | Bundled, exact pin. Simlock runs it through `capabilities.agent-device.command`. |
| Xcode | 26.5 (17F42) | Tested | iOS 18.5 runtime used; iOS 26.5 runtime installed but not leased in the recorded run. |
| [asc](https://github.com/rorkai/App-Store-Connect-CLI) | 5.17.1 (Homebrew) | Tested | `--version` and `apps list` through the CLI and `execute_tool`. |
| MCP TypeScript SDK | 1.32.2 | Tested (stdio) | Streamable HTTP partly verified: 401 without the token, tools listed, `list_devices` and `get_device_status` worked; a full device loop over HTTP not run. |
| pnpm | 10.20.0 | Used to build | Needed only to build from source. |
| [AXe](https://github.com/cameroncooke/AXe) | 1.8.0 | **Untested** | AXe's README says it supports Xcode 26 and Xcode 27, validated by its authors with Xcode 26.5 (17F42). Not installed on the test Mac (Homebrew tap-trust policy), so Tapdance's AXe backend and pass-through have only unit tests. |
| [Google's Android CLI](https://developer.android.com/tools/agents/android-cli) | any | **Untested** | Registered for pass-through; device targeting via `ANDROID_SERIAL` unverified. |
| Android SDK, emulator, system images | any | **Untested** | Android end to end has not run: the test Mac lacks the SDK command-line tools Simlock needs. |
| Linux worker with KVM (e.g. Google Cloud N2) | Ubuntu 24.04 planned | **Untested** | Terraform and scripts exist under `infrastructure/`; nothing provisioned. |
| [Maestro](https://github.com/mobile-dev-inc/maestro) | any | **Untested** | Registered for pass-through. |
| [fastlane](https://github.com/fastlane/fastlane) | any | **Untested** | Registered for pass-through. |
| Cloud Macs (Scaleway, MacStadium, AWS EC2 Mac) | | **Untested** | Documentation only. |

Platform support:

| Host | Control machine (CLI, MCP) | Worker | Gateway |
| --- | --- | --- | --- |
| macOS | Yes (tested) | iOS simulators (tested), Android emulators (untested) | Yes (tested with the worker on the same Mac) |
| Linux | Expected (untested) | Android emulators with KVM (untested) | Yes (untested) |
| Windows | Expected (untested) | **No**: Simlock supports macOS and Linux only | No |

## Simlock versions must match

Each Simlock release speaks one protocol version. A gateway and its workers must run Simlock versions
that can talk to each other; a worker on an incompatible version connects but is shown as
`incompatible` and gets no requests. A CLI and a running daemon of different versions can also refuse
each other with `PROTOCOL_VERSION_UNSUPPORTED` (restart the daemon after an upgrade).

Practical rule: run **Simlock 0.4.0 on the gateway and on every worker**, which is what Tapdance 0.1.0
bundles. Installing Tapdance from the same commit on every machine and using `tapdance worker …` /
`tapdance gateway …` gives you that. `tapdance doctor` warns when the endpoint reports another Simlock
version ("Tapdance is tested with 0.4.0").

## agent-device on workers

Tapdance talks to agent-device through Simlock's `/v1/agent-device` proxy, so the agent-device on each
**worker** matters. `tapdance worker install` and `worker login` point Simlock at the agent-device bundled
with Tapdance (0.21.35). If you configure a worker by hand, use the same version.

## Upgrades

Tapdance pins exact versions of Simlock and agent-device and never upgrades them, Xcode, the Android SDK
or external tools by itself. To upgrade, update every machine to the same Tapdance commit, run
`pnpm install && pnpm build`, then `tapdance worker restart` on workers and, on the gateway,
`tapdance simlock -- --gateway daemon stop` followed by `tapdance simlock -- --gateway daemon start`, so
the new Simlock runs everywhere. `tapdance tools versions` shows external tool versions.

When you run a combination not listed as tested, `tapdance report` collects the versions for an issue.
