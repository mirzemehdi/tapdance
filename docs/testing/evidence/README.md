# Evidence records

This folder holds one record per real run of an end-to-end procedure. A record is how a "✅" in
[STATUS.md](../../../STATUS.md) is earned: STATUS.md may only mark a requirement as done on real
hardware if it links to a record here (PRODUCT.md Q-04: never claim a real-device test passed when it
was mocked).

The procedures themselves are in [e2e-procedures.md](../e2e-procedures.md). Field testers follow
[field-testing.md](../field-testing.md) and its runbooks. This page is the one definition of a record:
the runbooks link here instead of repeating it.

## Records so far

| Date | Topic | What it shows |
| --- | --- | --- |
| 2026-11-01 | [local-ios](2026-11-01-local-ios.md) | The iOS loop on one Mac in local mode, CLI and MCP, viewer, a custom `.app`. |
| 2026-11-01 | [android](2026-11-01-android.md) | The Android loop on the same Mac: emulators, a custom APK, a Google Play image, Google's Android CLI. |
| 2026-11-01 | [axe](2026-11-01-axe.md) | AXe as the iOS UI backend, with a custom app's sign-in flow. |
| 2026-11-01 | [worker-guard](2026-11-01-worker-guard.md) | Device-only mode on one Mac: the full MCP loop through the guard. |
| 2026-11-01 | [gateway-single-host](2026-11-01-gateway-single-host.md) | A gateway and a joined worker on one Mac; CLI, MCP and the viewer through it. |
| 2026-11-01 | [device-state-and-profiles](2026-11-01-device-state-and-profiles.md) | Device-state tools (settings, files, notifications, uninstall, clear data), the guard's device channel, device profiles, `.aab` installs. |
| 2026-11-02 | [vps-field-runs](2026-11-02-vps-field-runs.md) | An agent on a Linux VPS driving the owner's Mac over Tailscale in device-only mode. |
| 2026-11-03 | [gcp-n2-android](2026-11-03-gcp-n2-android.md) | Android on a Google Cloud N2 VM, driven from a Mac: setup, CLI, MCP, viewer, installs from CI, idle stop. |
| 2026-11-03 | [selftest-through-guard](2026-11-03-selftest-through-guard.md) | The owner's self-test checklist through the guard on his Mac, with a real app and an iOS host build. |
| 2026-11-03 | [vps-n2-android](2026-11-03-vps-n2-android.md) | The N2 runbook from a Linux VPS: checklists, ephemeral Terraform, leftovers check. |
| 2026-11-04 | [vps-n2-android-rerun](2026-11-04-vps-n2-android-rerun.md) | The same with Simlock 0.5.0 and Tapdance's patch. |
| 2026-11-05 | [vps-n2-android-2d](2026-11-05-vps-n2-android-2d.md) | Field run 2d (partial): lease time right after a release. |
| 2026-11-05 | [vps-n2-android-2e](2026-11-05-vps-n2-android-2e.md) | Field run 2e: that lease time down to 16-22 s. |
| 2026-11-06 | [rented-mac-ios](2026-11-06-rented-mac-ios.md) | iOS on a rented Scaleway Mac mini, set up over ssh and driven from a Mac. |
| 2026-11-07 | [vps-rented-mac-ios](2026-11-07-vps-rented-mac-ios.md) | The same Mac mini driven from a Linux VPS: all six checklists, a host build, a `.app` upload. |
| 2026-11-07 | [two-hosts-android-ios](2026-11-07-two-hosts-android-ios.md) | One Linux VPS agent with two connect targets: an N2 host for Android and a rented Mac for iOS, with one host down. |

## File names

```
docs/testing/evidence/YYYY-MM-DD-<scenario>.md
docs/testing/evidence/YYYY-MM-DD-<scenario>/        # optional: small files that back the record
```

Use the date the run happened, not the date you wrote it up. Reuse a scenario name from this table,
so records of the same run sort together. For a repeat of a run, add `-rerun` or a run letter (`-2d`,
`-2e`).

| Scenario name | What ran | Procedure or runbook | Requirement IDs |
| --- | --- | --- | --- |
| `local-ios` | iOS on one Mac, local mode | [Procedure 1](../e2e-procedures.md#1-ios-simulator-on-macos) | Q-03, M-01, D-03 |
| `android` | Android on one Mac, local mode | [Procedure 2](../e2e-procedures.md#2-android-emulator-on-macos) | Q-03, D-01 |
| `axe` | AXe on one Mac | [Procedure 7](../e2e-procedures.md#7-axe-on-a-real-mac-q-09) | Q-09, U-02 |
| `device-state-and-profiles` | Device-state tools and device profiles | — | U-07 to U-14, D-09, D-10 |
| `worker-guard` | Device-only mode on one Mac | — | H-02, H-11 |
| `gateway-single-host` | A gateway and a joined worker on one Mac | Procedure 4's code path, no network | M-02, S-07 |
| `selftest-through-guard` | The owner's self-test through the guard | — | H-08 |
| `vps-field-runs` | A Linux VPS agent, the owner's Mac as host | [one-command-host.md](../../deployment/one-command-host.md) | P-03, W-07, Q-06 |
| `gcp-n2-android` | An N2 host driven from a Mac | [field-test-cloud-android.md](../field-test-cloud-android.md); procedure 5, device-only | Q-05, Q-07, G-01, M-03 |
| `vps-n2-android` | An N2 host driven from a Linux VPS | [field-test-cloud-android.md](../field-test-cloud-android.md) | Q-05, Q-12, G-08 |
| `rented-mac-ios` | A rented Mac driven from a Mac | [field-test-rented-mac-ios.md](../field-test-rented-mac-ios.md) | G-05, G-06, Q-08 |
| `vps-rented-mac-ios` | A rented Mac driven from a Linux VPS | [field-test-rented-mac-ios.md](../field-test-rented-mac-ios.md); procedure 6, device-only | Q-08 |
| `two-hosts-android-ios` | One agent, two connect targets | [field-testing.md](../field-testing.md#runbooks), "Two hosts at once" | M-06, Q-06 |

Names for runs that have not happened yet: `local-android-linux-kvm` (procedure 3), `laptop-worker`
(procedure 4), `gateway-n2-android` and `gateway-mac-ios` (procedures 5 and 6 through a gateway),
`android-cli-n2` (procedure 8). For anything else, pick a short, plain name in the same style
(`<agent's machine>-<host>-<platform>`) and say which PRODUCT.md IDs it covers.

The first record, [2026-11-01-local-ios.md](2026-11-01-local-ios.md), is the model to follow. For a run
across machines, [2026-11-07-two-hosts-android-ios.md](2026-11-07-two-hosts-android-ios.md) is a recent,
complete one.

## What a record contains

Use these sections, in this order. Leave a section in with "None" rather than dropping it.

### 1. Title and one-line summary

`# Evidence: <what> — YYYY-MM-DD`, then one sentence: real or partly mocked, how many machines, who
ran it (a person or an agent), and the overall result.

### 2. Environment

A table. Give exact versions; "latest" is not a version.

| Item | Example |
| --- | --- |
| Each machine, with its role | `VPS (gateway + agent): Hetzner CX22, Ubuntu 24.04, x86_64, no /dev/kvm` |
| Tapdance | `0.1.0`, plus the git commit (`git rev-parse --short HEAD`) |
| Node.js, pnpm | `node --version`, `pnpm --version` |
| Simlock, agent-device | From `tapdance report` (it prints both and the tested Simlock version) |
| Platform tools | Xcode version and iOS runtime; or Android emulator version, system image (API, tag, ABI) |
| Other tools | AXe, Android CLI, asc — with versions from `tapdance tools versions` |
| Network | `Caddy + Let's Encrypt`, `Tailscale`, or `loopback only` |
| Device | Model and OS as `tapdance device status` printed them |

Do not put public host names, IP addresses or account ids in the record. Use the worker label
(`my-laptop`, `n2-worker-1`) and the network kind instead. Tailscale `100.x` addresses are private but
still leave them out.

### 3. What ran

A numbered list of the steps, each with the exact command (or MCP tool call) and what came back.
Quote the important part of the output: the lease block, the error code, the exit code, file sizes.
Mark each step:

| Mark | Meaning |
| --- | --- |
| PASS | It ran on the real device or tool and did what the procedure expects. |
| FAIL | It ran and did not do what the procedure expects. Link the issue. |
| BLOCKED | It could not run, for a reason outside the step (missing tool, no VM, no permission). Say what blocked it. |
| SKIPPED | Deliberately not run. Say why. |
| MOCKED | It ran against a fake. Never counts as a pass for any requirement. |

### 4. Results by requirement

A short table: requirement ID → PASS / FAIL / PARTIAL / BLOCKED, with a sentence each. This is what
the person updating STATUS.md reads.

### 5. Artifacts

List each screenshot, recording and log the run produced: file name, size in bytes, and SHA-256
(`shasum -a 256 <file>` on macOS, `sha256sum <file>` on Linux). Say where each one lives:

- **Committed** next to the record, in `docs/testing/evidence/YYYY-MM-DD-<scenario>/`. Only small,
  reviewed files: PNG screenshots and short text excerpts, each under 1 MB.
- **Attached** to a GitHub issue or the summary issue. Use this for MP4 recordings and full logs.
- **Kept locally** at a path on the tester's machine. Say so; nobody else can see it.

Never commit MP4 files, full device logs, `~/.tapdance/credentials.json`, `~/.simlock/config.json`,
Terraform state or `terraform.tfvars`. The repository's `.gitignore` already excludes
`tapdance-artifacts/` and Terraform state.

### 6. Re-run

The commands someone else needs to repeat the run, from a fresh clone. Usually a copy of the
procedure's command block with your values filled in.

### 7. Not covered

What this run did not exercise, even though the procedure or the requirement mentions it. Be
specific: "installing a custom app", "the browser viewer from a second laptop", "Streamable HTTP MCP".

### 8. Issues filed

Links to every issue the run produced, with one line each. "None" if the run was clean.

### Optional sections

Add these when they apply, after "Results by requirement":

- **Measurements.** Times and sizes the runbook asks for (setup, cold and warm lease, first command,
  tap, install, build, memory, disk). The runbooks list what to measure, for example
  [field-test-cloud-android.md](../field-test-cloud-android.md#7-measurements-to-record).
- **What failed and why.** Each failure with its exact output, its cause if known, and the fix or
  issue.
- **Cost.** For runs on paid machines: the resource log (what was created and deleted, when), the
  running time, the estimated or billed cost, and the leftovers check's exit code.

## Before you commit a record

1. Search the record and every committed file for secrets. Simlock secrets start with `slk_`,
   pairing tokens with `tdg_`, GitHub tokens with `github_pat_` or `ghp_`:

   ```bash
   grep -rnE 'slk_[A-Za-z0-9_-]{8,}|tdg_[A-Za-z0-9_-]{8,}|github_pat_[A-Za-z0-9_]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|Bearer [A-Za-z0-9._-]{8,}|BEGIN [A-Z ]*PRIVATE KEY' docs/testing/evidence/
   ```

   The command must print nothing.
2. Look at every committed screenshot. A screenshot of a real app can show a signed-in account,
   an email address or a notification.
3. Check that every "PASS" has output or an artifact behind it, and that nothing mocked is marked PASS.
4. Update the matching rows in [STATUS.md](../../../STATUS.md) in the same change, linking this record.
