# Roadmap

Where Tapdance is going, phase by phase, and where it stands today. The detail behind every line is in
[PRODUCT.md](PRODUCT.md) (requirement IDs) and [STATUS.md](STATUS.md) (evidence). Update this file in
the same change that moves an item.

Legend: ✅ done and exercised on real devices · 🟡 partly done or not yet proven for real · ⬜ not started ·
⏸ deliberately deferred

**We are here: late Phase 1.** The device loop works for real on Android and iOS, locally, through a
gateway and through device-only mode, on one Mac. Phase 1 closes when it is proven across two machines
and the Phase 1 items below are ✅.

The first public release is about three things: get a device from any supported worker, let the agent
actually use the app, and return useful screenshots, recordings and evidence. Later phases wait until
those are excellent.

## Phase 1 · Foundation (open-source MVP)

| Item | State | Next step | IDs |
| --- | --- | --- | --- |
| Local Android worker | ✅ macOS · 🟡 Linux/KVM | Run on a Linux KVM host (N2) | D-01, D-02 |
| Local iOS worker | ✅ | — | D-03 |
| Remote workers through a gateway | 🟡 | One gateway + joined worker proven on one machine; prove VPS → laptop/N2 over a real network | M-02, M-03, Q-06 |
| Personal-Mac device-only mode | 🟡 | Guard proven on one machine; prove over Tailscale with a dedicated account | H-01–H-12 |
| Simlock integration | ✅ | — | R-01 |
| Android CLI integration | ✅ | Targets the leased emulator (`--device`); next: use it as an Android UI backend | U-04, U-05 |
| AXe integration | ✅ | Local Macs only (AXe must run beside the simulator) | U-02, Q-09 |
| CLI and MCP | ✅ | — | C-*, S-* |
| Device discovery and leasing | ✅ | — | P-01 |
| Screenshots, recordings, logs | ✅ both platforms | — | F-01 |
| Excellent `doctor` | 🟡 | Report per remote worker (SDK, KVM, Xcode), mark mandatory vs optional, give verify commands | C-05, Y-02 |
| Browser viewer (watch, take over) | ✅ both platforms | Multi-session console is Phase 4 | V-01–V-05 |

**Phase 1 exit:** two-machine proof (a non-KVM VPS + this Mac as worker), doctor across workers, one
Linux/KVM run.

## Phase 2 · Testing (agent testing experience)

| Item | State | IDs |
| --- | --- | --- |
| Structured UI inspection | ✅ basic · ⬜ paging, summaries | Y-04 |
| Semantic interactions (`tap`, `type`, `wait_for`, alerts) | ✅ | U-01 |
| Human takeover and hand-back | ✅ | V-03, Y-11 |
| Maestro / XCTest integrations | ⬜ (Maestro reachable only as a raw pass-through) | Y-07 |
| Test evidence bundles | 🟡 per-session artifacts + manifest; per-run evidence folder from `tapdance run` (FakeProvider tests only) | Y-08 |
| Test replay | 🟡 scenario files with `tapdance run` (FakeProvider tests only; no Maestro export) | Y-09 |
| Visual comparisons | ⬜ | Y-06 |

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
| BYOI provisioning (GCP N2) | 🟡 Terraform + scripts written, never applied | G-01, G-02 |
| Browser console (many sessions) | ⬜ | V-* |
| Managed Android and Mac workers | ⬜ | M-04 |
| Usage metering | ⬜ | P-04 |

## Not planned for now

Subscriptions and billing, a SaaS dashboard, Kubernetes, a custom streaming stack, Windows workers
(Simlock runs on macOS and Linux only).
