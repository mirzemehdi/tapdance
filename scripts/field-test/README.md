# Field-test kit

Drivers and checklists for running the Android or iOS end-to-end test against a real device host (a
Google Cloud N2 VM, a rented Mac) from the agent's machine. Dev tooling only: nothing here ships in a
package, and nothing here creates, starts or deletes cloud resources. The full procedure, with the
cloud steps and the mandatory teardown, is
[docs/testing/field-test-cloud-android.md](../../docs/testing/field-test-cloud-android.md) for Android
and [docs/testing/field-test-rented-mac-ios.md](../../docs/testing/field-test-rented-mac-ios.md) for iOS.
The iOS checklists and `PLATFORM=ios` in the CLI driver are checked offline only (`--check`, and the
CLI driver against a fake CLI) until the first rented-Mac run.

Generalised from the drivers used for the 2026-11-03 run
([evidence](../../docs/testing/evidence/2026-11-03-gcp-n2-android.md)). Not yet run against a host in
this form: the checklists were checked offline (`--check`) and the drivers against a fake CLI and a
server with no device.

| File | What it does |
| --- | --- |
| `mcp-checklist.mjs` | Starts `tapdance mcp` from this repository over stdio (with the repository's `@modelcontextprotocol/sdk`), runs a JSON checklist of tool calls, writes `results.json`, `server-stderr.log` and returned images, and prints a PASS/FAIL table with latencies. `--check` validates a checklist offline against the MCP tool schemas. |
| `cli-checklist.sh` | Runs the same kind of checklist with the `tapdance` CLI, timing each command; writes `results.tsv`, `results.json` and each step's output. Suites `base`, `app`, `build`. |
| `checklists/mcp-base.json` | Launcher checklist: lease, status, keys, inspect, screenshot, swipe, tap, wait, rotate, recording, push to Downloads, notifications, logs, audit, opened links, artifacts, release. |
| `checklists/mcp-app.json` | Your app: install from CI or from an APK file, launch, inspect, screenshot, optional tap and typing, recording, app logs, crash logs, sandbox push and pull (debuggable builds), rotate, audit, list, kill, clear, relaunch, release. |
| `checklists/mcp-build.json` | A build on the host (`build_app`), then launch, inspect, screenshot, release. |
| `checklists/mcp-ios-base.json` | iOS home screen: lease (`DEVICE`, `OS`), keys, inspect, screenshot, swipes, alert, rotate, recording, push to the Files app, notifications, language, logs, crash reports, audit, opened links, release. |
| `checklists/mcp-ios-app.json` | iOS app: install from CI (`CI_REPO`, `CI_ARTIFACT`: a simulator `.app` artifact) or `APP` (a simulator `.app`, or a `.zip` holding one), launch, launch with console, inspect, alert, tap and typing, recording, app logs, crash reports, push to the app's Documents, launch in de-DE, rotate, audit, kill, clear, relaunch, release. |
| `checklists/mcp-ios-build.json` | iOS build on the host (`build_app` with `BUILD_PROJECT` / `BUILD_SCHEME`), launch, inspect, screenshot, the same build again (reused), release. |

## Before you run anything

- `pnpm install && pnpm build` in this repository.
- **A scratch `TAPDANCE_HOME`.** Both drivers refuse to run without one and refuse `~/.tapdance`, which
  holds the owner's own config and credentials. Connect to the host with the same scratch home:

  ```bash
  export TAPDANCE_HOME="$HOME/td-field-home"     # any directory except ~/.tapdance
  node packages/cli/dist/main.js connect https://<host>.<tailnet>.ts.net:4720 < pairing-<label>.token
  node packages/cli/dist/main.js doctor
  ```

- Session ids default to `field-test-mcp` and `field-test-cli`, so the runs do not take the lease of
  your coding agent's own session. Set `TAPDANCE_SESSION_ID` to choose another.
- Checklists lease devices and install apps **on the host**: run them only against a host the owner
  set up for the test.

## Parameters

Pass `--param KEY=VALUE` (repeatable) or set `FIELD_TEST_KEY` in the environment. A step that needs a
parameter you did not set is **skipped**, not failed. No checklist names a real repository or app; use
your own.

| Parameter | Used by | Meaning |
| --- | --- | --- |
| `PLATFORM`, `DEVICE`, `OS` | CLI driver (MCP: `DEVICE`, `OS` in the iOS checklists) | `android` (default) or `ios`; the model and OS version to lease, e.g. `iPhone 16` and `26.1`. |
| `APP` | app (iOS) | Install this simulator `.app` or `.zip` (uploaded from the agent's machine). The MCP driver adds its folder to `TAPDANCE_ALLOWED_ROOTS`. |
| `LANGUAGE` | app (CLI, iOS) | The language for the language steps (default `de-DE`). |
| `BUILD_PROJECT`, `BUILD_SCHEME` | build (iOS) | The `.xcodeproj`/`.xcworkspace` and scheme, when the repository has more than one. |
| `LAUNCHER_TAP` | base | An app label on the launcher to tap, e.g. `Chrome`. |
| `APP_ID` | app, build | The app's package, e.g. `com.example.app`. |
| `CI_REPO`, `CI_ARTIFACT`, `CI_BRANCH` | app | Install from a GitHub Actions artifact on the host: `owner/repo`, the artifact name, and (optional) the branch. The host's owner must allow-list the repository first (`tapdance host artifacts enable --repo owner/repo` on the host). |
| `APK` | app | Install this local `.apk` (uploaded from the agent's machine). The MCP driver adds its folder to `TAPDANCE_ALLOWED_ROOTS` for the server. |
| `TAP_TEXT` | app | A button's text to tap (then Back). |
| `TYPE_INTO` | app | The label of a text field to type `Tapdance Für Elise` into. |
| `SEQUENCE_FILE` | app (CLI) | A `ui sequence` JSON file of timed taps. |
| `DEBUGGABLE` | app | Set to `1` for a debuggable build: push a file into the app's sandbox, pull it back and compare. |
| `BUILD_REPO`, `BUILD_REF`, `BUILD_DIR` | build | `https://github.com/owner/repo`, a branch or sha, and (optional) the folder with `gradlew`. The host must allow-list the repository (`tapdance host builds enable` on the host). |

## Run

```bash
# offline: every step names a real MCP tool and its arguments parse
node scripts/field-test/mcp-checklist.mjs --check scripts/field-test/checklists/mcp-app.json

# MCP, launcher then app
node scripts/field-test/mcp-checklist.mjs scripts/field-test/checklists/mcp-base.json ~/td-field/out/mcp-base --param LAUNCHER_TAP=Chrome
node scripts/field-test/mcp-checklist.mjs scripts/field-test/checklists/mcp-app.json ~/td-field/out/mcp-app \
  --param APP_ID=com.example.app --param CI_REPO=owner/repo --param CI_ARTIFACT=app-debug --param DEBUGGABLE=1

# CLI, same suites
scripts/field-test/cli-checklist.sh base ~/td-field/out/cli-base --param LAUNCHER_TAP=Chrome
scripts/field-test/cli-checklist.sh app ~/td-field/out/cli-app --param APP_ID=com.example.app --param APK=./app-debug.apk

# a build on the host
scripts/field-test/cli-checklist.sh build ~/td-field/out/cli-build \
  --param BUILD_REPO=https://github.com/owner/repo --param BUILD_REF=main --param BUILD_DIR=android --param APP_ID=com.example.app
```

Both drivers exit 0 when every step that ran passed and 1 otherwise. Copy the PASS/FAIL table and the
latencies into the evidence record; keep `results.json` with the run's artifacts. The output folders
can hold screenshots and recordings of the app: do not commit them unless the owner agrees.

## Checklist format (MCP)

A JSON array of steps:

```json
{ "tool": "install_app", "args": { "from_ci": { "repo": "${CI_REPO}", "artifact": "${CI_ARTIFACT}", "branch": "${CI_BRANCH}" } },
  "requires": ["CI_REPO", "CI_ARTIFACT"], "optional": ["CI_BRANCH"], "label": "install_from_ci", "timeoutSec": 1200 }
```

- `${KEY}` in an argument is replaced by a parameter; `${OUT}` is the output folder. The MCP server
  runs in the output folder, which holds `push.txt` for the push steps.
- `requires`: skip the step unless these parameters are set. `optional`: leave out an argument whose
  whole value is an unset `${KEY}`.
- `stopOnFail`: skip the rest when this step fails (the lease, the launch), except steps marked
  `"always": true`, which run anyway. Every checklist marks its `release_device` step that way, so a
  failed run does not leave the device leased. `timeoutSec`: default 900.
- `expectText`: fail the step unless the reply's text contains this.
- `{ "tool": "__list" }` saves the server's tool list to `tools.json`.
