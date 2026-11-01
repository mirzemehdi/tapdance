# Evidence records

This folder holds one record per real run of an end-to-end procedure. A record is how a "✅" in
[STATUS.md](../../../STATUS.md) is earned: STATUS.md may only mark a requirement as done on real
hardware if it links to a record here (PRODUCT.md Q-04: never claim a real-device test passed when it
was mocked).

The procedures themselves are in [e2e-procedures.md](../e2e-procedures.md). Field testers follow
[field-testing.md](../field-testing.md).

## File names

```
docs/testing/evidence/YYYY-MM-DD-<scenario>.md
docs/testing/evidence/YYYY-MM-DD-<scenario>/        # optional: small files that back the record
```

Use the date the run happened, not the date you wrote it up. Use one of these scenario names, so
records of the same procedure sort together:

| Scenario name | Procedure in e2e-procedures.md | Requirement IDs |
| --- | --- | --- |
| `local-ios` | 1. iOS simulator on macOS | Q-03, M-01, D-03 |
| `local-android-macos` | 2. Android emulator on macOS | Q-03, D-01 |
| `local-android-linux-kvm` | 3. Android emulator on Linux with KVM | Q-03, D-01, D-02 |
| `laptop-worker` | 4. Two-machine laptop worker | Q-06, M-02, P-07 |
| `gcp-n2` | 5. Google Cloud N2 worker (add `-byoi` for the Q-07 browser part) | Q-05, Q-07, G-01 |
| `mac-worker-from-vps` | 6. Mac worker from a Linux VPS | Q-08 |
| `axe` | 7. AXe on a real Mac | Q-09, U-02 |
| `android-cli-n2` | 8. Android CLI on an N2 worker | Q-10, U-04, U-05 |

If you run something that is not on this list, pick a short, plain name and say which PRODUCT.md IDs
it covers.

The first record, [2026-11-01-local-ios.md](2026-11-01-local-ios.md), is the model to follow.

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

## Before you commit a record

1. Search the record and every committed file for secrets. Simlock secrets start with `slk_`:

   ```bash
   grep -rnE 'slk_[A-Za-z0-9_-]{8,}|Bearer [A-Za-z0-9._-]{8,}|BEGIN [A-Z ]*PRIVATE KEY' docs/testing/evidence/
   ```

   The command must print nothing.
2. Look at every committed screenshot. A screenshot of a real app can show a signed-in account,
   an email address or a notification.
3. Check that every "PASS" has output or an artifact behind it, and that nothing mocked is marked PASS.
4. Update the matching rows in [STATUS.md](../../../STATUS.md) in the same change, linking this record.
