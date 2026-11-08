# Roadmap

Where Tapdance is going, phase by phase, and where it stands today. The detail behind every line is in
[PRODUCT.md](PRODUCT.md) (requirement IDs) and [STATUS.md](STATUS.md) (evidence). Update this file in
the same change that moves an item.

Legend: ✅ done and exercised on real devices · 🟡 partly done or not yet proven for real · ⬜ not started ·
⏸ deliberately deferred

**We are here: late Phase 1.** The device loop works for real on Android and iOS: locally on one Mac,
and across machines in device-only mode (a Linux VPS or a Mac as the agent's machine; the owner's Mac,
a Google Cloud N2 VM and a rented Mac mini as hosts; one agent reaching two hosts at once). A gateway
with a joined worker has run on one Mac only. Phase 1 closes when the items below are ✅.

Where devices run, stage by stage (your Mac → a Google Cloud N2 VM for Android → a rented Mac for iOS →
one agent across both → a hosted Tapdance Cloud), is planned in [docs/hosting-plan.md](docs/hosting-plan.md).

The first public release is about three things: get a device from any supported worker, let the agent
actually use the app, and return useful screenshots, recordings and evidence. Later phases wait until
those are excellent.

## Phase 1 · Foundation (open-source MVP)

| Item | State | Next step | IDs |
| --- | --- | --- | --- |
| Android worker | ✅ macOS · ✅ Linux/KVM (Google Cloud N2) | The missing-KVM path is unit-tested only | D-01, D-02 |
| Local iOS worker | ✅ | — | D-03 |
| Remote hosts in device-only mode (`host up`, `connect`) | ✅ | Proven across machines over Tailscale: VPS → Mac, Mac → N2, VPS → N2, Mac → rented Mac, VPS → rented Mac | P-03, Q-05, Q-08 |
| One agent, several hosts (connect targets) | ✅ | A Linux VPS with an N2 host and a rented Mac at once, one host down | M-06 |
| Remote workers through a gateway | 🟡 | One gateway + joined worker proven on one machine; across machines not run (stage 4 chose connect targets) | M-02, Q-06 |
| Personal-Mac device-only mode | 🟡 | Guard proven over Tailscale from other machines (uploads and artifacts bound per client); the dedicated worker account is untested | H-01–H-12 |
| One-command host setup (`host-setup.sh`, `host up`) and guard login service | 🟡 | Run on the owner's Mac, fresh N2 VMs and a fresh rented Mac; not yet: `host pause`/`resume`/`down --all` on Linux, the no-KVM branch | W-07, H-03 |
| Simlock integration | ✅ | — | R-01 |
| Android CLI integration | ✅ | Targets the leased emulator (`--device`); next: use it as an Android UI backend | U-04, U-05 |
| AXe integration | ✅ | Local Macs only (AXe must run beside the simulator) | U-02, Q-09 |
| CLI and MCP | ✅ | — | C-*, S-* |
| Device discovery and leasing | ✅ | — | P-01 |
| Screenshots, recordings, logs | ✅ both platforms | — | F-01 |
| Excellent `doctor` | 🟡 | Report per remote worker (SDK, KVM, Xcode), mark mandatory vs optional, give verify commands | C-05, Y-02 |
| Browser viewer (watch, take over) | ✅ both platforms | Multi-session console is Phase 4 | V-01–V-05 |

**Phase 1 exit:** the two-machine proof and the Linux/KVM run are done (device-only mode). Left: a
gateway with a joined worker across two machines, and `doctor` detail per remote worker (SDK, KVM,
Xcode).

## Phase 2 · Testing (agent testing experience)

| Item | State | IDs |
| --- | --- | --- |
| Structured UI inspection | ✅ basic · ⬜ paging, summaries | Y-04 |
| Semantic interactions (`tap`, `type`, `wait_for`, alerts) | ✅ | U-01 |
| Human takeover and hand-back | ✅ | V-03, Y-11 |
| Maestro / XCTest integrations | ⬜ (Maestro reachable only as a raw pass-through) | Y-07 |
| Test evidence bundles | 🟡 per-session artifacts + manifest; per-run evidence folder from `tapdance run` (written by passing runs on a real iOS simulator and Android emulator) | Y-08 |
| Test replay | 🟡 scenario files with `tapdance run` (passed on a real iOS simulator and Android emulator; no Maestro export) | Y-09 |
| Visual comparisons | ⬜ | Y-06 |
| Device state: settings, permissions, files, notifications, reset, intents, perf (local and through the guard) | ✅ Android · ✅ iOS locally | U-07–U-12, Y-10 |
| Device profiles (a prepared, signed-in emulator per lease) and asking a person (`request_human`) | ✅ Android and iOS, local only by decision (remote agents use `request_human`) | D-10, U-13, Y-12 |
| In-app purchase testing (Play Billing on a profile, StoreKit on the simulator) | 🟡 documented ([guide](docs/guides/purchase-testing.md)), not yet run with a real Play account | issue #15 |
| Audio capture / microphone, virtual MIDI keyboard | ⬜ (must not capture the host or need macOS Screen Recording) | U-12, issues #8, #16 |

## Phase 3 · Developer productivity (full lifecycle)

| Item | State | IDs |
| --- | --- | --- |
| `asc` pass-through (App Store Connect, iOS) | ✅ on the control machine · ⬜ remote Mac targets | E-05 |
| Android and iOS build orchestration | ⬜ (xcodebuild / Gradle only as raw pass-through) | Y-14 |
| Google Play publishing | ⬜ evaluate gradle-play-publisher or the Play Developer API first; fastlane `supply` only for teams already on fastlane | E-06 |
| Release preflight checks | ⬜ | Y-14 |
| CI integration | ⬜ (docs only) | E-10 |

fastlane is ⏸ for iOS: `asc` already covers App Store Connect.

## Phase 4 · Infrastructure (scale and hosted service)

| Item | State | IDs |
| --- | --- | --- |
| Multiple device pools, scheduling | 🟡 Simlock's queue and warm pool per gateway | Y-17 |
| BYOI provisioning (GCP N2, Android) | ✅ Terraform, `host-setup.sh`, `host up` and `connect` run on a real N2 VM ([evidence](docs/testing/evidence/2026-11-03-gcp-n2-android.md), [hosting plan](docs/hosting-plan.md) stage 2); provisioning is still by hand | G-01, G-02 |
| Rented Mac for iOS (Scaleway first) | 🟡 run twice on a Scaleway M1-M (8 GB), from a Mac and from a Linux VPS ([evidence](docs/testing/evidence/2026-11-07-vps-rented-mac-ios.md), [hosting plan](docs/hosting-plan.md) stage 3); MacStadium, AWS EC2 Mac and 16 GB offers not run | G-05, G-06 |
| One agent across a Linux and a Mac host | ✅ several connect targets ([evidence](docs/testing/evidence/2026-11-07-two-hosts-android-ios.md), [hosting plan](docs/hosting-plan.md) stage 4); a gateway pool across machines not run | M-06, Y-17 |
| Browser console (many sessions) | ⬜ | V-* |
| Tapdance Cloud: hosted fleet, accounts, metered billing (open-source core under AGPL-3.0) | ⬜ ([hosting plan](docs/hosting-plan.md) stage 5) | M-04, P-04 |
| Usage metering | ⬜ | P-04 |

## Not planned for now

Kubernetes, a custom streaming stack, Windows workers (Simlock runs on macOS and Linux only).
Subscriptions, billing and a hosted dashboard come with Tapdance Cloud, stage 5 of
[docs/hosting-plan.md](docs/hosting-plan.md), after the self-hosted stages are proven.
