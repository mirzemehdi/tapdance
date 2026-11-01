# Field-testing runbook (for an AI coding agent)

This runbook is written for an AI coding agent (Claude Code, Codex or similar) running on the
owner's VPS. Your job is to field-test Tapdance on real infrastructure, record what happened, and
file a GitHub issue for every real problem you find (PRODUCT.md K-02, O-04). A person can follow it
too.

Read these first, in this order:

1. [PRODUCT.md](../../PRODUCT.md) — the requirements. Every issue you file names the IDs it affects.
2. [STATUS.md](../../STATUS.md) — what is built, what was proven, what is known to be missing.
   Do not file issues for things STATUS.md already says are not built, unless you found something
   new about them.
3. [e2e-procedures.md](e2e-procedures.md) — the procedures you will run.
4. [evidence/README.md](evidence/README.md) — how to write up a run.

## Ground rules

These come before anything else in this runbook.

- **Ask the owner before anything that costs money or changes another machine.** That includes
  creating cloud resources (Terraform, Google Cloud, Scaleway, AWS), installing software on the
  owner's laptop or Mac, trusting a Homebrew tap (AXe), and joining any machine to a gateway. Ask in
  chat, wait for a clear yes, and do only what was approved.
- **You cannot run commands on the owner's laptop or Mac.** When a procedure has a step "on the
  laptop", give the owner the exact commands, ask them to run them, and ask them to paste the
  output back **with tokens removed**.
- **Never paste a token anywhere.** Not in an issue, a comment, a gist, a commit, an evidence record
  or a chat message. Simlock secrets start with `slk_`. Join tokens printed by
  `tapdance gateway setup` and `tapdance gateway token` must go to the owner by a private channel,
  not through you if you can avoid it. Viewer links from `tapdance view` contain a login key after
  the `#`; treat them as secrets too.
- **Remote connections need TLS or a private network.** Do not expose the gateway's port 4700 to the
  internet without TLS in front of it. Do not use `ws://` or `http://` to a public address.
- **Leasing is not a sandbox.** An agent token on a worker is close to shell access on that machine
  as the Simlock daemon's user, and a joined worker gives the gateway operator rights over it. Tell
  the owner this before they join their laptop.
- **Do not edit code under `packages/` to make a test pass.** You are testing, not fixing. If you
  find the fix, describe it in the issue.
- **Do not commit or push** unless the owner asked you to. Evidence records can stay in your clone
  until the owner says where they go.
- **Never mark something as passed that you did not run on a real device.** Mocked results are not
  evidence (PRODUCT.md Q-04).

## 1. Set up on the VPS

You need Node.js 22.13 or later, git, and the GitHub CLI (`gh`) logged in to an account that can
open issues on the repository.

```bash
node --version                    # v22.13.0 or later
gh auth status                    # must show a logged-in account

git clone https://github.com/tapdance-dev/tapdance.git ~/tapdance
cd ~/tapdance
git rev-parse --short HEAD        # write this down: it goes in every report
corepack enable
pnpm install
pnpm build
```

Use the repository URL the owner gave you if it differs; `packages/cli/package.json` lists
`https://github.com/tapdance-dev/tapdance`.

Put the CLI on your `PATH` with a wrapper (aliases do not work in non-interactive shells):

```bash
mkdir -p "$HOME/.local/bin"
printf '#!/bin/sh\nexec node "%s/packages/cli/dist/main.js" "$@"\n' "$HOME/tapdance" > "$HOME/.local/bin/tapdance"
chmod +x "$HOME/.local/bin/tapdance"
export PATH="$HOME/.local/bin:$PATH"
tapdance --version                # 0.1.0
```

Linking the package globally with pnpm (after `pnpm setup`) may also work, but the wrapper above is
the tested-by-construction path: it runs exactly the build in your clone.

> Do **not** run `npm install -g tapdance`. On 2026-11-01 that name on npm belongs to an unrelated
> package (a Test Anything Protocol harness). Tapdance is not on npm yet. `tapdance gateway setup`
> still prints that command in its "next steps"; this is a known problem. Search for an existing
> issue before filing it (see section 4).

Work in a scratch folder so artifacts do not land in the repository:

```bash
mkdir -p ~/td-field && cd ~/td-field
```

## 2. Run the scenarios, in this order

Each scenario is a procedure in [e2e-procedures.md](e2e-procedures.md). Do them in this order:
each one builds on the previous one, and the cheap ones come first. Stop and ask the owner where a
row says so.

| Order | Scenario | Where it runs | Ask the owner first? |
| --- | --- | --- | --- |
| 0 | Baseline: build and unit tests | VPS | No |
| 1 | CLI smoke checks with no devices | VPS | No |
| 2 | No-KVM negative check (procedure 3, "Negative check") | VPS | No |
| 3 | Gateway on the VPS (procedure 4, VPS steps) | VPS | Yes, if it needs Caddy/DNS or Tailscale changes |
| 4 | Laptop worker, Q-06 (procedure 4) | VPS + owner's laptop | Yes: the owner runs the laptop steps |
| 5 | Mac worker, Q-08 (procedure 6) | VPS + owner's Mac | Yes |
| 6 | Google Cloud N2, Q-05/Q-07 (procedure 5) | VPS + N2 VM | **Yes: it costs money.** Get approval for the project, region and how long it may run |
| 7 | Android CLI on the N2, Q-10 (procedure 8) | N2 VM | Yes (installing the Android CLI there) |
| 8 | AXe, Q-09 (procedure 7) | Owner's Mac | Yes (trusting the AXe Homebrew tap) |
| 9 | Summary issue | VPS | No |

Procedures 1–3 in e2e-procedures.md (single-machine iOS, Android on macOS, Android on Linux with KVM)
run on the owner's machines; run them only if the owner asks.

### 0. Baseline

```bash
cd ~/tapdance
pnpm test          # all unit tests should pass (69 on 2026-11-01)
pnpm typecheck
```

A failing unit test on a clean clone is an issue in itself. File it before going further.

### 1. CLI smoke checks with no devices

These need nothing but the build. They check that the CLI behaves as documented.

```bash
cd ~/td-field
tapdance --help
tapdance doctor --no-host; echo "exit: $?"            # fails without a worker; read the hints
tapdance --json screenshot; echo "exit: $?"           # NO_ACTIVE_LEASE, exit 3
tapdance --json device lease --platform windows; echo "exit: $?"   # usage error, exit 2
tapdance --json config set token x; echo "exit: $?"   # refused: tokens never go in config files
TAPDANCE_PROVIDER=cloud tapdance --json devices; echo "exit: $?"   # NOT_SUPPORTED, exit 8
tapdance tools
tapdance report --title "smoke" --kind field-test     # prints a report; read it for secrets
```

Also read `--help` for every command and subcommand, and compare it with the docs. A command,
flag or option that a doc names but `--help` does not have is a `docs` issue.

### 2 – 8. The procedures

Follow each procedure in [e2e-procedures.md](e2e-procedures.md) step by step. While you work:

- Set a fresh session id per scenario: `export TAPDANCE_SESSION_ID=field-<scenario>-$(date +%s)`.
- Save the output of each command to a log file as you go, for example
  `tapdance --json device lease --platform android 2>&1 | tee -a ~/td-field/logs/q06.txt`.
- Note every exit code.
- When a step fails, retry once. Retry more only if the error says `retryable: true` (for example
  `WORKER_OFFLINE`, `NO_CAPACITY`, `HUMAN_HELD`). If it still fails, capture everything, file an
  issue (section 4), and decide whether the rest of the scenario can continue.
- Release every lease when a scenario ends (`tapdance device release`), even after a failure.
- If the owner approved cloud resources, remind them to destroy them at the end, and say how long
  they ran.

To check the MCP side as a real agent would, register the server (`claude mcp add tapdance --
tapdance mcp` for Claude Code), restart your session, and use the tools yourself:
`lease_device`, `install_app`, `list_apps`, `launch_app`, `inspect_screen`, `tap`, `type_text`, `swipe`,
`take_screenshot`, `start_recording`, `stop_recording`, `get_logs`, `get_crash_logs`,
`get_test_artifacts`, `release_device`. Note anything about the tool descriptions or results that
confused you: that is useful feedback too (file it as `docs` or `missing-feature`).

## 3. Record evidence

For each scenario you ran, write a record in `docs/testing/evidence/` in your clone, in the format of
[evidence/README.md](evidence/README.md): environment, what ran (each step marked PASS, FAIL, BLOCKED,
SKIPPED or MOCKED), results by requirement ID, artifacts with sizes and SHA-256 hashes, how to re-run,
what was not covered, and the issues you filed.

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
gh issue list --state all --search "WORKER_OFFLINE"
gh issue list --state all --search "worker login 403"
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
1. VPS: tapdance gateway setup --worker-label my-laptop --public-url https://gw.example.com
2. Laptop (run by the owner): tapdance worker install
3. Laptop: tapdance worker login --accept-gateway-exec --gateway wss://gw.example.com --label my-laptop
4. VPS: tapdance workers list
EOF

tapdance report --kind field-test \
  --title "workers list shows the laptop as disconnected after worker login" \
  --steps "$(cat /tmp/td-steps.txt)" \
  --expected "my-laptop appears as connected within 30 seconds of worker login (Q-06, W-01)." \
  --actual "$(tail -n 30 ~/td-field/logs/q06.txt)" \
  --evidence "$HOME/td-field/logs/q06.txt,$HOME/td-field/tapdance-artifacts/field-q06/screenshot-1.png" \
  -o report.md
```

Then add the lines `tapdance report` does not write. At least the requirement IDs and the commit:

```bash
cat >> report.md <<EOF

### Requirements
Q-06, W-01, M-02

### Tested commit
$(git -C ~/tapdance rev-parse --short HEAD)
EOF
```

### Step 3: review the body for secrets

Read the whole file. Then check it mechanically:

```bash
grep -nE 'slk_[A-Za-z0-9_-]{8,}|Bearer [A-Za-z0-9._-]{8,}|BEGIN [A-Z ]*PRIVATE KEY|#[A-Za-z0-9_-]{20,}' report.md
```

That must print nothing. Also look for, and remove or replace with a placeholder:

- the gateway's public host name (the report's Environment section includes the endpoint host),
  IP addresses, the owner's user name and home path;
- email addresses, account ids, Google Cloud project ids, Apple team ids;
- anything personal visible in a log excerpt.

### Step 4: file it

```bash
gh issue create \
  --title "workers list shows the laptop as disconnected after worker login" \
  --body-file report.md \
  --label field-test --label bug
```

Use `--label missing-feature` or `--label docs` instead of `bug` where it fits. Keep the issue URL
`gh` prints; it goes in the evidence record and the summary.

### Attaching screenshots and logs

`gh issue create` cannot upload files. Do this instead:

- **Text logs:** put a trimmed excerpt (the 20–50 lines around the failure) in the body, inside a
  `<details>` block. If the full log matters, create a secret gist **after** reviewing it for
  secrets (`gh gist create ~/td-field/logs/q06.txt`) and link it. A secret gist is unlisted, not
  private: anyone with the link can read it.
- **Screenshots and recordings:** list their paths with `--evidence` (they show up in the body), and
  ask the owner to drag them into the issue in the GitHub web page. If the owner allowed you to push,
  small PNGs can go next to the evidence record on your branch and be linked from the issue.

## 5. Writing a good issue

A maintainer should be able to reproduce the problem from the issue alone, without asking you
anything. Include:

| Part | What to write | Example |
| --- | --- | --- |
| Title | The symptom, the command, and the error code if there is one. Not "it doesn't work". | `app install over a gateway fails with PROVIDER_UNREACHABLE for APKs over 100 MB` |
| What happened | The exact command and the exact output, trimmed to the relevant part. Include the exit code. | `tapdance app install big.apk` → `PROVIDER_UNREACHABLE … (exit 4)` |
| What you expected | What should have happened, and why you expected it: the requirement ID, the doc or the `--help` text. | "The APK installs (F-01). e2e-procedures.md procedure 4 says it is uploaded through the gateway." |
| Minimal reproduction | The shortest list of steps from a known state that shows the problem. Remove steps that do not matter. Say which machine each step runs on. | 1. VPS: lease Android. 2. VPS: install a 150 MB APK. |
| Environment | From `tapdance report`: versions, OS, provider. Add the machines involved, the network (Caddy, Tailscale), and the tested commit. | `tapdance 0.1.0 @ a1b2c3d, simlock 0.4.0, Ubuntu 24.04 VPS + macOS 26.5 laptop, Tailscale` |
| Evidence | Log excerpts, screenshots, the evidence record, timings. | `<details>` with 30 log lines; screenshot attached |
| How often | Every time, sometimes (how many out of how many tries), once. | "3 of 3 tries" |
| What you tried | Workarounds, and whether they helped. | "`tapdance worker restart` on the laptop did not help." |

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

Tested commit: a1b2c3d. Machines: VPS (Ubuntu 24.04, no KVM); owner's MacBook (macOS 26.5); N2 VM (n2-standard-4, us-central1) for 3 h.

| # | Scenario | Requirements | Result | Issues | Evidence |
| --- | --- | --- | --- | --- | --- |
| 0 | Baseline build and unit tests | Q-01, Q-11 | PASS | — | — |
| 1 | CLI smoke checks | C-02 | PASS | — | — |
| 2 | No-KVM negative check | D-02 | PASS | — | docs/testing/evidence/... |
| 4 | Laptop worker | Q-06, M-02 | FAIL | #12, #13 | docs/testing/evidence/... |
| 6 | Google Cloud N2 | Q-05 | BLOCKED (no approval for GCP) | — | — |

### What worked
### What failed
### What could not be tested, and why
### Suggested STATUS.md changes
```

Use PASS only for scenarios that ran on real devices and did everything the procedure expects.
Review the summary for secrets as in section 4, step 3, then file it:

```bash
gh issue create --title "Field test summary YYYY-MM-DD" --body-file summary.md --label field-test
```

Finally, tell the owner in chat: the summary issue's URL, the issues you filed, which cloud
resources (if any) are still running, and which evidence records are waiting in your clone.
