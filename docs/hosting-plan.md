# Hosting plan: from your own Mac to Tapdance Cloud

The order in which Tapdance is proven on real infrastructure, one stage at a time, ending in a hosted
service. Each stage has a goal, what "done" means, and the prompt that starts its working session.
[ROADMAP.md](../ROADMAP.md) lists features; this file is about **where devices run**. Stage numbers are
not ROADMAP phase numbers.

**How to use it.** Start a stage by pasting its prompt into a new session. When the stage is done, that
session marks it ✅ here, with a link to its evidence. To get the next prompt, say "stage N is done":
the next stage's prompt is below.

| Stage | Where devices run | Agent runs on | State |
| --- | --- | --- | --- |
| 1 | Your own Mac (Android + iOS) | A Linux VPS | ✅ ([run evidence](testing/evidence/2026-11-02-vps-field-runs.md), [self-test](testing/evidence/2026-11-03-selftest-through-guard.md)) |
| 2 | Google Cloud N2 VM (Android) | This Mac, acting as the agent's machine; repeated from a Linux VPS | ✅ ([evidence](testing/evidence/2026-11-03-gcp-n2-android.md)); from a Linux VPS ✅ ([evidence](testing/evidence/2026-11-03-vps-n2-android.md), [rerun](testing/evidence/2026-11-04-vps-n2-android-rerun.md)); to repeat it: [field-test runbook](testing/field-test-cloud-android.md) |
| 3 | A rented Mac (iOS) | This Mac, acting as the agent's machine; repeated from a Linux VPS | ✅ ([evidence](testing/evidence/2026-11-06-rented-mac-ios.md), Scaleway M1-M); from a Linux VPS ✅ ([evidence](testing/evidence/2026-11-07-vps-rented-mac-ios.md)); to repeat it: [field-test runbook](testing/field-test-rented-mac-ios.md) |
| 4 | Both at once: Linux host for Android, Mac host for iOS | One agent, one connection | ✅ ([evidence](testing/evidence/2026-11-07-two-hosts-android-ios.md), Linux VPS agent, N2 + rented Mac, several connect targets; [guide](guides/android-and-ios.md)). Gateway pool across machines not run (owner's choice, STATUS Q-06) |
| 5 | Tapdance Cloud: our fleet, user signs up and connects | The user's agent | ⬜ |

Rules for every stage: the repository's CLAUDE.md and AGENTS.md apply. In particular, ask before
creating or starting anything that costs money; keep this Mac's live host untouched (scratch
`TAPDANCE_HOME`); never print tokens; no AI attribution. Each stage ends with docs, STATUS.md, an
evidence file and this table updated, and the paid machines stopped, with teardown commands.

---

## Stage 2 · Android on a Google Cloud N2 VM

**Goal.** A user with an agent machine and a Google Cloud project follows one doc to get Android
emulators on an `n2-standard-4` (Ubuntu 24.04, nested virtualization). Their agent then tests an app
end to end, through the CLI and MCP.

**Done when:**
- A new user can follow [deployment/google-cloud-n2.md](deployment/google-cloud-n2.md) with no undocumented step. It is rewritten around `host-setup.sh` → `host up` → `connect`, or the gateway path if that is the one that works.
- The full Android checklist passes from this Mac through the CLI and through the MCP server:
  - lease, build from git, install, launch with console;
  - inspect, tap/type/swipe, timed sequence, rotate;
  - screenshots, recording, logs, crashes, links, audit, notifications, files;
  - release.
- Measured: VM boot → host ready, lease time (cold and warm), tap latency, memory, cost per hour.
- STATUS.md G-01..G-03, Q-05, D-02, M-03 and W-07 on Linux are updated. Evidence is in `docs/testing/evidence/<date>-gcp-n2-android.md`.

**Prompt.** Already given to the running session. To restart it:

```text
Do stage 2 of docs/hosting-plan.md (Android on a Google Cloud N2 VM, driven from this Mac as the
agent's machine). Read that file, CLAUDE.md, AGENTS.md, PRODUCT.md and STATUS.md first.
Use a scratch TAPDANCE_HOME and a distinct TAPDANCE_SESSION_ID for everything N2-related; this
Mac's own host must stay untouched. Prove every lease comes from the VM. Ask me before creating
or starting anything in my GCP account, with the command and a cost estimate. Begin with a docs
audit and the questions you need answered; create nothing yet.
```

---

## Stage 3 · iOS on a rented Mac

**Goal.** A user without a spare Mac rents one and follows one doc to make it an iOS host. Their agent
tests an iOS app end to end on it, through the CLI and MCP. Candidates:
- [Scaleway Mac mini](ios/scaleway-mac.md): hourly, 24-hour minimum;
- [AWS EC2 Mac](ios/aws-ec2-mac.md): dedicated host, 24-hour minimum;
- [MacStadium](ios/macstadium.md): monthly.

Pick the cheapest that works and document the others as "same steps, not run".

**What is new compared with your own Mac:**
- Access is SSH/VNC only, with no person at the screen.
- Xcode is installed remotely: `xcodes`, with your Apple ID typed by you; then the licence and first-launch setup.
- Simulators may need a logged-in GUI session (auto-login).
- The host must not sleep, and the worker and guard must come back after a reboot.
- Disk: Xcode plus runtimes is 40 GB or more.
- No macOS privacy (TCC) prompts may be needed.
- The 24-hour billing minimum shapes how the test day is planned.

**Done when:**
- A new user can follow one doc (the chosen provider's page, cross-linked from [deployment/one-command-host.md](deployment/one-command-host.md)) from "I rented a Mac" to "my agent tested my iOS app".
- The full iOS checklist passes from this Mac through the CLI and MCP:
  - lease, build from git, install, launch with console;
  - inspect, tap/type/swipe, timed sequence, rotate;
  - screenshots, recording, logs, crashes, opened links, audit, alerts, language;
  - release.
- Measured: setup time from a blank rented Mac, lease time, tap latency, cost per day.
- STATUS.md G-05/G-06 and Q-08 are updated. Evidence is in `docs/testing/evidence/<date>-rented-mac-ios.md`.

**Prompt:**

```text
Do stage 3 of docs/hosting-plan.md: iOS on a rented Mac, driven from this Mac as the agent's
machine. Read that file, CLAUDE.md, AGENTS.md, PRODUCT.md, STATUS.md and docs/ios/ (scaleway-mac,
aws-ec2-mac, macstadium, overview) first, plus the stage 2 evidence for how the previous stage was
run.
1. Docs audit: walk the path a new user would take for "rent a Mac for iOS"; list gaps and
   commands that no longer exist (check --help).
2. Recommend one provider with costs (the 24-hour minimum included) and ask me before renting.
3. On the rented Mac, follow our docs only: host-setup.sh, Xcode installed remotely (I type my
   Apple ID myself), auto-login if simulators need it, no sleep, worker and guard surviving a
   reboot, no TCC prompts. Fix what breaks in the scripts and the CLI.
4. From this Mac, with a scratch TAPDANCE_HOME and a distinct TAPDANCE_SESSION_ID, connect and run
   the full iOS checklist through the CLI and through MCP (stdio server driven by a small client
   script). Prove every lease comes from the rented Mac. Use a real app built from git (Pianolune
   iOS is fine); tool bugs only.
5. Measure, then update the provider doc, one-command-host.md, troubleshooting.md, docs/mcp.md,
   docs/cli-reference.md (pnpm build && pnpm docs:cli), STATUS.md, CHANGELOG, a new evidence file,
   and the stage table in docs/hosting-plan.md. Commit with my identity; no AI attribution.
6. Before the 24-hour minimum runs out, give me the release/teardown steps.
This Mac's own host stays untouched; never run xcrun simctl or adb -P 5038 here. Ask before
anything that costs money. Begin with step 1 and your questions; rent nothing yet.
```

---

## Stage 4 · One agent, both hosts

**Goal.** One agent connection reaches the Linux host for Android and the Mac host for iOS. "Give me
an iPhone" and "give me a Pixel" both work, and Tapdance picks the machine. This is the core of the
hosted product, so it is proven while still self-hosted.

**Open questions the stage answers first:**
- Does Simlock's gateway already pool a Linux worker and a Mac worker, with queueing and warm spares per platform?
- Should a control machine hold several `connect` targets instead, or both?
- Pairing and scopes: one token per host, or one gateway token?
- What the agent sees: one device list, platform chosen per lease, clear errors when a platform has no capacity.

**Done when:**
- From the agent's machine (a Mac or a Linux VPS), one session leases an Android emulator on the N2 VM and an iOS simulator on the rented Mac, through the CLI and MCP, in the same run.
- Both hosts are in one `doctor` report.
- Losing one host leaves the other usable, with a clear error.
- One doc ("Android and iOS from one agent") covers it. STATUS.md and evidence are updated.
- Nothing is left that bills: both leftover checks exit 0.

**What stages 2 and 3 taught, for this stage:** both hosts were torn down, so this stage rents them
again (N2 about USD 0.19-0.21/h; a Scaleway Mac mini bills a 24-hour minimum). An 8 GB Mac mini holds
one simulator, so a 16 GB one fits a warm spare. A VPS reaches the Mac only with an ssh key added when
it is rented. Gateway mode has run on one Mac only (STATUS Q-06).

**Prompt:**

```text
Do stage 4 of docs/hosting-plan.md: one agent connection that reaches both the Linux Android host
(stage 2, Google Cloud N2) and the Mac iOS host (stage 3, Scaleway Mac mini). Read that file,
CLAUDE.md, AGENTS.md, PRODUCT.md, STATUS.md, docs/architecture-decision.md and the stage 2 and 3
evidence first (docs/testing/evidence/2026-11-03-gcp-n2-android.md, 2026-11-06-rented-mac-ios.md,
2026-11-07-vps-rented-mac-ios.md).

0. Say which machine you run on (the owner's Mac or a Linux VPS); that is the agent's machine for
   this stage. If it is the owner's Mac, its own Tapdance host stays untouched: never run xcrun
   simctl or adb -P 5038 there, never touch ~/.tapdance, never trigger macOS privacy prompts.
1. Find out what exists, running nothing paid: Simlock's gateway pooling across workers (Simlock
   0.5.0, patched), `tapdance connect` with one or several targets, how pairing tokens and scopes
   work, and what `doctor` and `devices` show for several hosts. Gateway mode has run on one Mac
   only so far (STATUS Q-06), and doctor on a gateway with an agent-only token reports no
   capabilities (a known review finding).
2. Propose the design (gateway pool vs several connect targets vs both), with the trade-offs for
   the hosted service in stage 5. Wait for my choice before building.
3. Build it, then prove it with a scratch TAPDANCE_HOME and a distinct TAPDANCE_SESSION_ID: one
   session leases Android on the N2 VM and iOS on the rented Mac, through the CLI and MCP (the
   drivers in scripts/field-test/); doctor shows both hosts; take one host down and check the
   other still works and the agent gets a clear error.
4. Paid machines: the stage 2 and 3 hosts are gone. Before creating anything, give me a cost
   estimate and wait for my yes.
   - N2: about USD 0.19-0.21/h, Terraform in infrastructure/terraform/google-cloud-n2 (ephemeral
     mode).
   - Scaleway Mac mini: 24-hour minimum. M1-M is EUR 2.64 + VAT, but its 8 GB holds one simulator
     only (`tapdance host warm android=0,ios=0`); propose M2-M (16 GB, EUR 4.08) if this stage needs
     warm spares.
   Follow docs/testing/field-test-cloud-android.md and docs/testing/field-test-rented-mac-ios.md
   for setup, the resource log and teardown. When I rent the Mac, remind me to add every agent
   machine's ssh public key (a VPS has no other way in). I approve the pairing and type any
   password or token myself; you never ask for or handle them.
5. While both hosts are up, and if time allows, prove these unit-tested-only items and record them:
   - `tapdance host builds key --repo <ssh url>` (a deploy key for a host build, no GitHub token);
   - `tapdance host up --tailscale-ssh`;
   - an iOS install from CI (`tapdance app install --from-ci`).
6. Update docs (one guide: "Android and iOS from one agent"), STATUS.md, CHANGELOG.md, an evidence
   file under docs/testing/evidence/, and the stage table in docs/hosting-plan.md. Work on a branch
   and open a PR; merge only when I say so. File GitHub issues only for problems outside this
   change, and never publicly for a security hole (tell me instead). Commit with my git identity;
   no AI attribution anywhere.
7. End with nothing that bills: tear down, then run
   infrastructure/scripts/gcp-leftovers.sh <PROJECT_ID> and
   infrastructure/scripts/scaleway-leftovers.sh until both exit 0. Give me the final state, the
   cost, and anything left for me to remove (Tailscale machines, GitHub tokens or deploy keys,
   ssh keys).

Never print tokens (slk_, tdg_, pairing files, GitHub or cloud credentials), never ask for, print or
store my cloud credentials, and ask before anything that costs money or starts services on a host.
```

---

## Stage 5 · Tapdance Cloud (hosted, open-source core)

**Goal.** A Postiz-style model. The open-source core stays self-hostable (stages 1–4). A hosted service
lets a user sign up, get an API key, run `tapdance connect` (or pick "Tapdance Cloud" in `tapdance
init`, today "not available yet"), and test Android and iOS without renting anything.

**What it adds on top of stage 4:**

| Area | Needs |
| --- | --- |
| Accounts | Sign-up, teams, API keys; `connect` takes a cloud key instead of a pairing token |
| Isolation | Fresh device per lease, wiped after; per-tenant network egress limits; the guard's allow-list; abuse handling (user-uploaded apps run on our machines) |
| Billing | Stripe, metered per device-minute, quotas and spend caps, free tier |
| Fleet | Android: always-on base load on rented bare-metal KVM servers (several emulators each, no nested-virtualization penalty), with Google Cloud N2 VMs started on demand for peaks. iOS: Scaleway Mac minis (hourly, 24-hour minimum), MacStadium only if monthly works out cheaper at scale. Health checks, autoscaling, image and Xcode updates |
| Console | Web console for many sessions: live view, takeover, recordings, logs, usage |
| Operations | Monitoring, status page, backups, support, terms and privacy policy |

**Decide before building (these are the owner's calls):**
- **Licence: decided.** Tapdance is AGPL-3.0-only (like Postiz) since 2026-11-03: anyone may
  self-host it, but a modified Tapdance offered as a service must publish its changes. Before taking
  outside contributions, decide whether to ask for a contributor licence agreement, so that a
  commercial licence (for companies that cannot accept AGPL, e.g. for the SDK) stays possible.
- **Apple's macOS licence.** Renting from Scaleway meets Apple's rental rule: Scaleway leases the
  whole Mac to us for at least 24 hours. What remains is our own use of it: running short simulator
  sessions for many customers on one Mac. That is what CI and device-cloud vendors already sell
  (Bitrise, Codemagic, Appetize, BrowserStack), so it is not a blocker, but get a quick legal read
  of the macOS and Xcode terms before launch. A "dedicated Mac" plan (one customer per Mac for at
  least 24 hours) avoids the question entirely.
- **Pricing and margins.** Android carries the margin. iOS may need a higher per-minute price or a
  dedicated-Mac plan.
- **Positioning.** BrowserStack, Sauce Labs, LambdaTest, Firebase Test Lab, AWS Device Farm and
  Appetize sell device minutes. Tapdance's edge is that it is built for agents:
  - MCP first;
  - human takeover;
  - precise device tools: timed taps, link capture, crash reports, audit;
  - the open-source core as the funnel.

**Done when (first version):**
- A stranger signs up, gets a key, connects their agent and tests an Android and an iOS app.
- They are billed per minute and see their usage.
- Their devices are wiped after use.
- Its own STATUS and evidence entries cover each claim.

**Prompt** (it starts with design, not code):

```text
Do stage 5 of docs/hosting-plan.md: plan Tapdance Cloud, a hosted service on top of the
open-source core, Postiz style. Read that file, CLAUDE.md, AGENTS.md, PRODUCT.md, STATUS.md,
ROADMAP.md, docs/architecture-decision.md and the stage 2–4 evidence first. Build nothing yet.
1. Write docs/cloud/architecture.md:
   - accounts and API keys, and how `tapdance connect` / `tapdance init` reach the cloud;
   - tenant isolation and device wiping, egress limits and abuse handling;
   - metering and Stripe billing;
   - the fleet (bare-metal KVM base plus N2 on demand for Android, Scaleway Macs for iOS),
     scheduling and health;
   - the web console;
   - operations.
   Say what the existing gateway/guard/Simlock pieces cover and what is new.
2. List the owner decisions with options and your recommendation: a contributor licence
   agreement (the licence itself is AGPL-3.0-only, decided), the Apple macOS licence question for
   shared iOS minutes (flag for a lawyer, don't decide it), pricing and free tier, the first fleet
   (bare-metal KVM vs N2 for Android, Scaleway vs MacStadium for iOS) with monthly costs.
3. Propose a first version that a stranger could use end to end, split into stages like this
   file, each with its own prompt, and add them to docs/hosting-plan.md.
Ask me the decisions you need; commit only the docs, with my identity and no AI attribution.
```
