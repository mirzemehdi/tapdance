# Field testing: ground rules and runbooks

This page is for a field-testing agent (or a person) who tests Tapdance on real machines. Your job:
run a runbook, write down what happened, and file a GitHub issue for every real problem you find
(PRODUCT.md K-02, O-04).

Read these first, in this order:

1. [PRODUCT.md](../../PRODUCT.md): the requirements. Every issue you file names the IDs it affects.
2. [STATUS.md](../../STATUS.md): what is built, what was proven, what is known to be missing. Do not
   file issues for things STATUS.md already says are not built, unless you found something new about
   them.
3. The runbook you will follow (below).
4. [evidence/README.md](evidence/README.md): how to write up a run.

The words host, worker, guard, agent's machine, connect target and pairing token mean what the
[glossary](../glossary.md) says.

## Ground rules

These come before anything else on this page or in a runbook.

- **Ask the owner before anything that costs money or changes another machine.** That includes
  creating cloud resources (Terraform, Google Cloud, Scaleway, AWS), installing software on the
  owner's laptop or Mac, trusting a Homebrew tap (AXe), pairing a machine, and joining any machine to
  a gateway. Ask in chat, wait for a clear yes, and do only what was approved.
- **You cannot run commands on the owner's laptop or Mac.** When a step runs there, give the owner
  the exact commands, ask them to run them, and ask them to paste the output back **with tokens
  removed**.
- **Never paste a token anywhere.** Not in an issue, a comment, a gist, a commit, an evidence record
  or a chat message. Simlock secrets start with `slk_`, pairing tokens with `tdg_`, GitHub tokens with
  `github_pat_` or `ghp_`. A pairing token file goes straight from the host to the agent's machine
  (`scp`), never through you. Viewer links from `tapdance view` hold a login key after the `#`: treat
  them as secrets too.
- **Use a scratch home.** Set `TAPDANCE_HOME` to a scratch directory on the agent's machine, never
  `~/.tapdance`, and give each run its own `TAPDANCE_SESSION_ID`.
- **Remote connections need TLS or a private network.** Do not expose a guard or a gateway to the
  internet without TLS in front of it. Do not use `ws://` or `http://` to a public address.
- **Leasing is not a sandbox.** An agent token on a Simlock worker is close to shell access on that
  machine, and a joined worker gives the gateway operator rights over it. Device-only mode (the
  guard) is the boundary on a personal Mac. Tell the owner this before they join a machine to a
  gateway.
- **Do not edit code under `packages/` to make a test pass.** You are testing, not fixing. If you
  find the fix, describe it in the issue.
- **Do not commit or push** unless the owner asked you to. Evidence records can stay in your clone
  until the owner says where they go.
- **Never mark something as passed that you did not run on a real device.** Mocked results are not
  evidence (PRODUCT.md Q-04).

## Runbooks

Every real run across machines so far used **device-only mode**: `host up` (or `scripts/host-setup.sh`)
on the host, `tapdance connect` on the agent's machine. The gateway route has not run across
machines; it has run on one Mac only.

| Runbook | Machines | State |
| --- | --- | --- |
| Your own Mac as the host: [one-command-host.md](../deployment/one-command-host.md) | A Linux VPS + the owner's Mac | Run 2026-11-02 ([evidence](evidence/2026-11-02-vps-field-runs.md)); self-test through the guard on the same Mac ([evidence](evidence/2026-11-03-selftest-through-guard.md)) |
| Android on a Google Cloud N2 VM: [field-test-cloud-android.md](field-test-cloud-android.md) | A Mac or a Linux VPS + an N2 VM | Run from a Mac and from a Linux VPS ([evidence](evidence/2026-11-03-vps-n2-android.md)) |
| iOS on a rented Scaleway Mac mini: [field-test-rented-mac-ios.md](field-test-rented-mac-ios.md) | A Mac or a Linux VPS + a rented Mac | Run from a Mac and from a Linux VPS ([evidence](evidence/2026-11-07-vps-rented-mac-ios.md)) |
| Two hosts at once (stage 4): see below | A Linux VPS + an N2 VM + a rented Mac | Run 2026-11-07 ([evidence](evidence/2026-11-07-two-hosts-android-ios.md)) |
| Single-machine and gateway procedures: [e2e-procedures.md](e2e-procedures.md) | One Mac or Linux box; gateway setups | See the table at the top of that page |

**Two hosts at once.** There is no separate runbook. Set up both hosts with the N2 and rented-Mac
runbooks (their checkpoints, resource logs and teardown apply), connect both from one agent's machine
(`tapdance connect <endpoint> --name n2` and `--name mac`), then run the `two-hosts` and `host-down`
suites: `cli-checklist.sh two-hosts` / `host-down`, and the MCP checklists `mcp-two-hosts.json` and
`mcp-host-down.json`. The commands are in
[scripts/field-test/README.md](../../scripts/field-test/README.md#two-hosts-stage-4); what a user sees
is in [Android and iOS from one agent](../guides/android-and-ios.md). Both leftover checks must exit 0
at the end.

## 1. Set up on the agent's machine

You need Node.js 22.13 or later, git, and the GitHub CLI (`gh`) logged in to an account that can open
issues on the repository.

```bash
node --version
gh auth status
```

Then clone, build and put `tapdance` on your `PATH` as in
[Install Tapdance from the repository](e2e-procedures.md#install-tapdance-from-the-repository-on-every-machine).
Write down the commit (`git rev-parse --short HEAD`): it goes in every report.

Work in a scratch folder so artifacts do not land in the repository:

```bash
mkdir -p ~/td-field
cd ~/td-field
export TAPDANCE_HOME="$HOME/td-field-home"
```

## 2. Run the scenarios, in this order

Each one builds on the previous one, and the cheap ones come first. Stop and ask the owner where a row
says so.

| Order | Scenario | Where it runs | Ask the owner first? |
| --- | --- | --- | --- |
| 0 | Baseline: build and unit tests | Agent's machine | No |
| 1 | CLI smoke checks with no devices | Agent's machine | No |
| 2 | No-KVM negative check ([procedure 3](e2e-procedures.md#3-android-emulator-on-linux-with-kvm), "Negative check") | A VPS without KVM | No |
| 3 | Device-only runbooks (table above) | Agent's machine + host(s) | **Yes.** The owner pairs each host; cloud hosts cost money: get approval for the plan and how long it may run, and tear down at the end |
| 4 | Gateway procedures [4](e2e-procedures.md#4-two-machine-laptop-worker-q-06), [5](e2e-procedures.md#5-google-cloud-n2-worker-q-05-q-07), [6](e2e-procedures.md#6-mac-worker-from-a-linux-vps-q-08) (never run across machines) | VPS + a joined worker | Yes: the owner runs the worker steps and decides whether to join a machine to a gateway |
| 5 | Android CLI on an N2 host ([procedure 8](e2e-procedures.md#8-android-cli-on-an-n2-worker-q-10)) | N2 VM | Yes. Only the local part can run: the part routed from another machine is blocked (STATUS Q-10, E-04) |
| 6 | AXe ([procedure 7](e2e-procedures.md#7-axe-on-a-real-mac-q-09)) | Owner's Mac | Yes (trusting the AXe Homebrew tap) |
| 7 | Summary issue | Agent's machine | No |

Procedures 1 and 2 in e2e-procedures.md (iOS and Android on one Mac) run on the owner's machine; run
them only if the owner asks.

### 0. Baseline

```bash
cd ~/tapdance
pnpm test
pnpm typecheck
```

All unit tests should pass; the count is whatever `pnpm test` reports. A failing unit test on a clean
clone is an issue in itself. File it before going further.

### 1. CLI smoke checks with no devices

These need nothing but the build. They check that the CLI behaves as documented. Run each line and
note its exit code (`echo $?`):

```bash
cd ~/td-field
tapdance --help
tapdance doctor --no-host
tapdance --json screenshot
tapdance --json device lease --platform windows
tapdance --json config set token x
TAPDANCE_PROVIDER=cloud tapdance --json devices
tapdance tools
tapdance report --title "smoke" --kind field-test
```

Expected: `doctor` fails without a host (read the hints); `screenshot` gives `NO_ACTIVE_LEASE`, exit 3;
`--platform windows` is a usage error, exit 2; `config set token` is refused (tokens never go in config
files); `provider: cloud` gives `NOT_SUPPORTED`, exit 8. Read the `report` output for secrets.

Also read `--help` for every command and subcommand, and compare it with the docs. A command, flag or
option that a doc names but `--help` does not have is a `docs` issue.

### 2 to 6. The runbooks and procedures

Follow each runbook or procedure step by step. While you work:

- Set a fresh session id per scenario: `export TAPDANCE_SESSION_ID=field-<scenario>-$(date +%s)`.
- Save the output of each command to a log file as you go, for example
  `tapdance --json device lease --platform android 2>&1 | tee -a ~/td-field/logs/n2.txt`.
- Note every exit code.
- When a step fails, retry once. Retry more only if the error says `retryable: true` (for example
  `WORKER_OFFLINE`, `NO_CAPACITY`, `HUMAN_HELD`, `PROVIDER_UNREACHABLE`). If it still fails, capture
  everything, file an issue (section 4), and decide whether the rest of the scenario can continue.
- Release every lease when a scenario ends (`tapdance device release`), even after a failure.
- If the owner approved cloud resources, follow the runbook's resource log and teardown: tear
  everything down at the end (also after a failure), run the leftovers check until it exits 0
  (`infrastructure/scripts/gcp-leftovers.sh <PROJECT_ID>` before the project is deleted;
  `infrastructure/scripts/scaleway-leftovers.sh` is the owner's, with their `scw` login), revoke the
  credentials the run left (`infrastructure/scripts/revoke-run-credentials.sh`, asking the owner), and
  tell the owner the final state, how long it ran and what it cost.
- The checklists in [`scripts/field-test/`](../../scripts/field-test/README.md) run the CLI and MCP
  checks against a connected host and time each step.

To check the MCP side as a real agent would, register the server (`claude mcp add tapdance --
tapdance mcp` for Claude Code), restart your session, and use the tools yourself: `lease_device`,
`install_app`, `list_apps`, `launch_app`, `inspect_screen`, `tap`, `type_text`, `swipe`,
`take_screenshot`, `start_recording`, `stop_recording`, `get_logs`, `get_crash_logs`,
`get_test_artifacts`, `release_device`. Every recorded MCP run so far used a scripted client, so a run
by a real agent is worth recording. Note anything about the tool descriptions or results that
confused you: that is useful feedback too (file it as `docs` or `missing-feature`).

## 3. Record evidence

For each scenario you ran, write a record in `docs/testing/evidence/` in your clone.
[evidence/README.md](evidence/README.md) defines the file name, the sections and the checks before
committing; follow it.

- Keep artifacts in `~/td-field/tapdance-artifacts/<session>/` (Tapdance's default) and list them
  with `tapdance --json artifacts`.
- Record the commit you tested (`git -C ~/tapdance rev-parse --short HEAD`).
- Do not commit MP4 files or full logs. Only small, reviewed PNG screenshots and short text excerpts
  belong next to a record.
- Do not commit or push unless the owner asked. If they did, put the records on a branch and open a
  pull request; never push to the default branch.

## 4. Report problems as GitHub issues

### One issue per problem

File one issue for each distinct problem. Two symptoms with the same cause are one issue; one
command that fails in two unrelated ways is two issues. Use these labels:

| Label | Use for |
| --- | --- |
| `field-test` | Every issue from this run. |
| `bug` | Tapdance does something wrong: an error, a wrong result, a hang, a misleading message. |
| `missing-feature` | Something a requirement or a user needs that Tapdance does not do. |
| `docs` | A doc or `--help` text that is wrong, missing or misleading. |

Check the labels exist first with `gh label list`. If one is missing, ask the owner before creating
it, or file without it and mention that in the summary.

### Step 1: search for an existing issue

```bash
gh issue list --state all --search "PROVIDER_UNREACHABLE"
gh issue list --state all --search "connect token"
gh issue list --state all --label field-test
```

Search by the error code, the command and a key word of the symptom. If an issue already exists,
add a comment with your new evidence (`gh issue comment <number> --body-file comment.md`) instead
of opening a duplicate.

### Step 2: generate the body with `tapdance report`

`tapdance report` writes an issue-ready Markdown body with the Tapdance, Simlock, agent-device and
Node versions, the OS, the provider, the current lease (if any) and the `doctor` results. It redacts
tokens. You fill in what happened.

Write multi-line text to files first, so the shell does not mangle it:

```bash
cat > /tmp/td-steps.txt <<'EOF'
1. Host (run by the owner): tapdance host up --label my-vps
2. Agent's machine: tapdance connect https://my-mac.<tailnet>.ts.net:4720 < pairing-my-vps.token
3. Agent's machine: tapdance device lease --platform ios
EOF

tapdance report --kind field-test \
  --title "device lease fails with PROVIDER_UNREACHABLE right after connect" \
  --steps "$(cat /tmp/td-steps.txt)" \
  --expected "The lease goes to the connected Mac (W-07, M-06)." \
  --actual "$(tail -n 30 ~/td-field/logs/mac.txt)" \
  --evidence "$HOME/td-field/logs/mac.txt,$HOME/td-field/tapdance-artifacts/field-mac/screenshot-1.png" \
  -o report.md
```

Then add the lines `tapdance report` does not write. At least the requirement IDs and the commit:

```bash
cat >> report.md <<EOF

### Requirements
W-07, M-06

### Tested commit
$(git -C ~/tapdance rev-parse --short HEAD)
EOF
```

### Step 3: review the body for secrets

Read the whole file. Then check it mechanically:

```bash
grep -nE 'slk_[A-Za-z0-9_-]{8,}|tdg_[A-Za-z0-9_-]{8,}|github_pat_[A-Za-z0-9_]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|Bearer [A-Za-z0-9._-]{8,}|BEGIN [A-Z ]*PRIVATE KEY|#[A-Za-z0-9_-]{20,}' report.md
```

That must print nothing. Also look for, and remove or replace with a placeholder:

- the host's or gateway's public host name and tailnet name (the report's Environment section
  includes the endpoint host), IP addresses, the owner's user name and home path;
- email addresses, account ids, Google Cloud project ids, Apple team ids;
- anything personal visible in a log excerpt.

### Step 4: file it

```bash
gh issue create \
  --title "device lease fails with PROVIDER_UNREACHABLE right after connect" \
  --body-file report.md \
  --label field-test --label bug
```

Use `--label missing-feature` or `--label docs` instead of `bug` where it fits. Keep the issue URL
`gh` prints; it goes in the evidence record and the summary.

### Attaching screenshots and logs

`gh issue create` cannot upload files. Do this instead:

- **Text logs:** put a trimmed excerpt (the 20–50 lines around the failure) in the body, inside a
  `<details>` block. If the full log matters, create a secret gist **after** reviewing it for
  secrets (`gh gist create ~/td-field/logs/mac.txt`) and link it. A secret gist is unlisted, not
  private: anyone with the link can read it.
- **Screenshots and recordings:** list their paths with `--evidence` (they show up in the body), and
  ask the owner to drag them into the issue in the GitHub web page. If the owner allowed you to push,
  small PNGs can go next to the evidence record on your branch and be linked from the issue.

## 5. Writing a good issue

A maintainer should be able to reproduce the problem from the issue alone, without asking you
anything. Include these parts:

- **Title.** The symptom, the command, and the error code if there is one. Not "it doesn't work".
  Example: `app install through the guard fails with PROVIDER_UNREACHABLE for APKs over 100 MB`.
- **What happened.** The exact command and the exact output, trimmed to the relevant part, with the
  exit code. Example: `tapdance app install big.apk` → `PROVIDER_UNREACHABLE … (exit 4)`.
- **What you expected,** and why: the requirement ID, the doc or the `--help` text. Example: "The APK
  installs (F-01)."
- **Minimal reproduction.** The shortest list of steps from a known state that shows the problem.
  Say which machine each step runs on. Example: 1. VPS: lease Android. 2. VPS: install a 150 MB APK.
- **Environment.** From `tapdance report`: versions, OS, provider. Add the machines involved, the
  network (Tailscale, Caddy) and the tested commit. Example: `tapdance 0.1.0 @ a1b2c3d, simlock 0.6.0,
  Ubuntu 24.04 VPS + macOS 26.5 Mac, Tailscale`.
- **Evidence.** Log excerpts, screenshots, the evidence record, timings.
- **How often.** Every time, sometimes (how many out of how many tries), once.
- **What you tried.** Workarounds, and whether they helped. Example: "`tapdance worker restart` on
  the host did not help."

Keep opinions and guesses separate from observations: put a suspected cause under its own
"Possible cause" heading, and say how sure you are.

## 6. Final summary issue

When you have run everything you can, file one summary issue. Generate the environment part with
`tapdance report` and replace the steps/expected/actual sections with a results table:

```bash
tapdance report --kind field-test --title "Field test summary YYYY-MM-DD" -o summary.md
```

Edit `summary.md` so it contains:

```markdown
## Field test summary — YYYY-MM-DD

Tested commit: a1b2c3d. Machines: VPS (Ubuntu 24.04, no KVM) as the agent's machine; N2 VM (n2-standard-4, europe-west1) for 3 h.

| # | Scenario | Requirements | Result | Issues | Evidence |
| --- | --- | --- | --- | --- | --- |
| 0 | Baseline build and unit tests | Q-01, Q-11 | PASS | — | — |
| 1 | CLI smoke checks | C-02 | PASS | — | — |
| 2 | No-KVM negative check | D-02 | PASS | — | docs/testing/evidence/... |
| 3 | N2 host in device-only mode | Q-05, W-07 | FAIL | #12, #13 | docs/testing/evidence/... |
| 4 | Gateway with a joined worker | Q-06, M-02 | BLOCKED (no approval) | — | — |

### What worked
### What failed
### What could not be tested, and why
### Suggested STATUS.md changes
```

Use PASS only for scenarios that ran on real devices and did everything the runbook expects. Review
the summary for secrets as in section 4, step 3, then file it:

```bash
gh issue create --title "Field test summary YYYY-MM-DD" --body-file summary.md --label field-test
```

Finally, tell the owner in chat: the summary issue's URL, the issues you filed, which cloud
resources (if any) are still running, and which evidence records are waiting in your clone.
