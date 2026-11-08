# Tapdance documentation

Find the page for what you want to do. New to the words? Read the [glossary](glossary.md). Wondering
what has really been tested? [STATUS.md](../STATUS.md) is the source of truth.

## Try it

| Page | What it gives you |
| --- | --- |
| [Installation](installation.md) | Install Tapdance from source, and the SDKs your setup needs. |
| [Quick start](quick-start.md) | One full loop on your Mac: lease, launch, tap, screenshot, release. |
| [Local](deployment/local.md) | Run the agent and the devices on the same computer. |
| [How it works](how-it-works.md) | The pieces, the three modes, and which setups have run for real. |
| [Glossary](glossary.md) | Host, worker, guard, connect target, lease and the other terms. |

## Host devices for an agent elsewhere

Start with [choose a remote setup](deployment/self-hosted-overview.md) if you are not sure which page
fits.

| Page | What it gives you |
| --- | --- |
| [Host devices for a remote agent](deployment/one-command-host.md) | Your own Mac, Mac mini or Linux machine as a host, with `host up` and `connect`. Proven. |
| [Linux host with KVM](deployment/dedicated-linux-server.md) | A dedicated Linux server or another cloud VM for Android. Not run on bare metal. |
| [Google Cloud N2](deployment/google-cloud-n2.md) | Android emulators on a VM in your Google Cloud project. Proven. Terraform: [module README](../infrastructure/terraform/google-cloud-n2/README.md). |
| [Scaleway Mac mini](ios/scaleway-mac.md) | A rented Mac as an iOS host. Proven. |
| [Other cloud Macs](ios/other-cloud-macs.md) | MacStadium and AWS EC2 Mac. Not run. |
| [Android and iOS for one agent](guides/android-and-ios.md) | Two hosts, one agent: several connect targets. Proven. |
| [Gateway mode](deployment/gateway-mode.md) | Advanced: pool workers behind a Simlock gateway. Run on one Mac only. |
| [iOS overview](ios/overview.md) | Where iOS simulators can run, and how. |
| [iOS simulator management](ios/simulator-management.md) | How simulators are created, reused and wiped; memory on small Macs. |

## Connect your agent

| Page | What it gives you |
| --- | --- |
| [Connect your agent](agents.md) | MCP setup for Claude Code, Codex and Cursor. |
| [MCP server and tools](mcp.md) | Every MCP tool, its inputs, and the transports. |

## Test your app

| Page | What it gives you |
| --- | --- |
| [Host builds](guides/host-builds.md) | Let the host build your app from git, so an agent without Xcode can test iOS. |
| [Private repositories](guides/private-repositories.md) | Give the host read access to a private repository for host builds. |
| [Build in CI, test with Tapdance](guides/ci-builds.md) | Install the app your CI built; Xcode Cloud and `asc`. |
| [Testing in-app purchases](guides/purchase-testing.md) | StoreKit and Play Billing tests, with a person in the loop. |
| [Scenarios](scenarios.md) | Replay saved steps with `tapdance run` and get PASS or FAIL. |
| [Browser viewer](deployment/browser-access.md) | Watch the device live, take over, hand back. |
| [Android](platforms/android.md) | Android SDK, KVM, system image choices. |
| [iOS](platforms/ios.md) | Xcode, runtimes, what works on simulators. |

## Reference

| Page | What it gives you |
| --- | --- |
| [CLI reference](cli-reference.md) | Every command and flag, JSON output, exit codes, session identity. |
| [MCP server and tools](mcp.md) | Every MCP tool and its inputs. |
| [Configuration](configuration.md) | Config files, keys, credentials and environment variables. |
| [External tools](tools.md) | `asc`, Android CLI, AXe, Maestro, fastlane, `xcodebuild`: how they run and what agents may use. |
| [Compatibility](compatibility.md) | Versions that have been tested together. |
| [Troubleshooting](troubleshooting.md) | Errors and their fixes, on the agent's machine and on the host. |

## Security

| Page | What it gives you |
| --- | --- |
| [Threat model](security/threat-model.md) | What a token can do, per platform; what to watch out for. |
| [Device-only mode and the guard](security/device-only-mode.md) | The guard's policy, pairing, scopes, audit log, taking access away. |
| [Security policy](../SECURITY.md) | How to report a vulnerability. |

## Contributing and testing

| Page | What it gives you |
| --- | --- |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | Set up, build, test, and the rules for docs. |
| [AGENTS.md](../AGENTS.md) | Rules for coding agents working on this repository. |
| [Unit tests](testing/unit-tests.md) | Where the tests live and how to run them, including the integration test. |
| [End-to-end procedures](testing/e2e-procedures.md) | How each setup is proven on real devices. |
| [Field testing](testing/field-testing.md) | Ground rules and runbooks for testing on real machines. |
| [Field test: Android on Google Cloud](testing/field-test-cloud-android.md) | Runbook for an N2 host. |
| [Field test: iOS on a rented Mac](testing/field-test-rented-mac-ios.md) | Runbook for a rented Mac host. |
| [Evidence](testing/evidence/README.md) | The record of every real-device run, and how to write one. |
| [Architecture decision record](architecture-decision.md) | What Tapdance reuses, what it adds, and why. |
| [PRODUCT.md](../PRODUCT.md) · [STATUS.md](../STATUS.md) | Requirements with IDs, and what is proven for each. |
| [ROADMAP.md](../ROADMAP.md) · [CHANGELOG.md](../CHANGELOG.md) | What comes next, and what changed. |
| [NOTICE.md](../NOTICE.md) | Licenses of the projects Tapdance uses. |

## Maintainers

| Page | What it gives you |
| --- | --- |
| [Hosting plan](hosting-plan.md) | The stages in which Tapdance is proven on real infrastructure, with their prompts. |
