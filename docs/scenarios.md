# Scenarios: replay a flow and get PASS/FAIL

A scenario file is a saved flow of device steps. `tapdance run <file>` replays it on this session's
device, one step after another, and writes a PASS/FAIL report with evidence for every failed step.

> **Status:** `examples/ios-demo/signin.scenario.yaml` passed on a real iPhone 16 simulator (8 steps,
> 45 s; [evidence](testing/evidence/2026-11-01-device-state-and-profiles.md)). The Android example has not passed on a real emulator yet: its one run hit
> adb timeouts on an overloaded test Mac. Unit tests: `packages/sdk/src/scenario.test.ts`.

Every step goes through the same Tapdance calls as `tapdance ui …` and the MCP tools, so a scenario
works wherever those work: on a local worker, through a gateway, and through device-only mode. It does
not use agent-device's own replay or test commands.

A replay repeats the steps. It does not restore the app's data, a signed-in account, the network,
the location or the clock that the original run saw. If the flow depends on any of them, set them up
first or add steps for them.

## Run one

```bash
tapdance run examples/ios-demo/signin.scenario.yaml
```

```text
✓  1 install the scenario's app 4210 ms
✓  2 launch_app dev.tapdance.demo 1830 ms
✓  3 expect_visible id "email" 410 ms
✓  4 type_text (15 chars) into id "email" 920 ms
✓  5 type_text (7 chars) into id "password" 870 ms
✓  6 tap text "Sign in" 640 ms
✓  7 expect_visible text "Welcome, ada@example.com" 300 ms
✓  8 take_screenshot "signed in" 520 ms

PASS iOS demo sign-in · 8 passed, 0 failed, 0 skipped · 9.7 s
device: iPhone 16 (ios 18.5)  app: dev.tapdance.demo
report: ./tapdance-artifacts/<session>/runs/<time>-ios-demo-sign-in/report.md
```

(The timings above are illustrative.)

- `--json` prints the whole report (below) on stdout; the step lines go to stderr.
- `--continue-on-failure` runs every step even after one fails.
- `--keep-lease` keeps a device the scenario leased, renewed in the background, instead of releasing
  it at the end. Release it later with `tapdance device release`.

Exit codes: `0` when every step passed, `12` (`SCENARIO_FAILED`) when the scenario ran and a step
failed, `2` for an invalid scenario file, and the usual codes when the run cannot start (for example
`3` when the session holds no device and the scenario names none to lease).

## The device

- If the session already holds a device, the scenario runs on it. `platform` (or `device.platform`)
  must match it, or the run stops before the first step.
- If the session holds none and the scenario has a `device` block, `tapdance run` leases that device,
  runs the steps, and releases it at the end (unless `--keep-lease`).
- If the session holds none and the scenario has no `device` block, the run fails with
  `NO_ACTIVE_LEASE`. Lease one first with `tapdance device lease --platform ios`.

## Format

YAML (`.yaml`, `.yml`) or JSON (`.json`). Unknown keys are refused, so a typo fails loudly.

| Key | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Shown in the report. |
| `description` | no | Free text. |
| `platform` | no | `android` or `ios`; the run refuses a device of the other platform. |
| `device` | no | What to lease when the session holds no device: `platform` (required), `device` (model, e.g. `iPhone 16`), `os_version`, `image_tag`. The same fields as `lease_device`. |
| `app` | no | `path`: an `.apk` or simulator `.app` installed before the first step (relative to the scenario file). `id`: the package or bundle id, recorded in the report. |
| `steps` | yes | 1 to 500 steps, run in order. |

### Steps

A step is an object with one step type as its key and that type's arguments as its value. A step type
without arguments may be written as a bare name (`- stop_recording`). Step types and their arguments
are the MCP tool names and arguments, so a flow an agent ran can be saved as it was called.

Any step may also have:

| Option | Meaning |
| --- | --- |
| `name` | The name shown in the output and the report. Default: a description of the step (typed text is shown only as its length). |
| `continue_on_failure` | `true` keeps going after this step fails. The scenario still ends as FAIL. |
| `timeout_ms` | For `wait_for` and `expect_*`, the wait (when the step's own `timeout_ms` is not set; at most 30000). For other steps, the step fails with `TIMEOUT` after this long. The device call itself is not cancelled. |

| Step | Arguments | Passes when |
| --- | --- | --- |
| `install_app` | `path`, `app_id?` | The app installed. Relative paths are relative to the scenario file. |
| `launch_app` | `app_id`, `relaunch?`, `url?` | The app launched. |
| `stop_app` | `app_id` | The app stopped. |
| `tap` | exactly one of `text`, `id`, `ref`, `selector`, or `x` and `y` | The tap went through. |
| `type_text` | `text`, at most one of `into_text`, `into_id`, `into_ref` | The text was typed, and the field read it back when the backend can tell. |
| `swipe` | `direction` (`up`, `down`, `left`, `right`) with `amount?`, `until_text?`; or all of `from_x`, `from_y`, `to_x`, `to_y` | The swipe went through. |
| `press_key` | `key`: `back`, `home`, `enter`, `dismiss_keyboard`, `app_switcher` | The key was pressed. |
| `wait_for` | exactly one of `text`, `absent`, `stable: true`; `timeout_ms?` (default 10000) | The text appeared, went away, or the screen settled in time. A timeout fails the step. |
| `handle_alert` | `action`: `get`, `accept`, `dismiss` | For `accept` and `dismiss`, an alert was showing and was answered. |
| `take_screenshot` | `note?` | The PNG was saved into the evidence folder. |
| `start_recording` | none | Recording started into the evidence folder. A recording still running at the end is stopped and kept. |
| `stop_recording` | none | The MP4 was saved. |
| `sleep` | `ms` (0 to 60000) | Always, after the pause. Prefer `wait_for`. |
| `expect_visible` | exactly one of `text`, `id`; `timeout_ms?` (default 10000) | The text (through the device backend's wait) or an element with that accessibility id or resource id is on screen in time. |
| `expect_not_visible` | exactly one of `text`, `id`; `timeout_ms?` | The text or element is gone in time. |
| `expect_app` | `app_id` | The foreground app the backend reports is `app_id`. When the backend does not report it, the step fails with `NOT_SUPPORTED`. |

`ref` targets (`@e7`) belong to one screen and will usually not match on replay. Use `text` or `id`.

## Full example: the demo sign-in flow

The demo apps in [examples/ios-demo](../examples/ios-demo/) and
[examples/android-demo](../examples/android-demo/) show one sign-in form: fields labelled Email and
Password, a "Sign in" button, and a result text that reads `Welcome, <email>` after a valid sign-in.
Both have the app id `dev.tapdance.demo`.

iOS ([examples/ios-demo/signin.scenario.yaml](../examples/ios-demo/signin.scenario.yaml)); the fields
have the accessibility ids `email` and `password`:

```yaml
name: iOS demo sign-in
platform: ios
device:
  platform: ios
  device: iPhone 16
app:
  path: build/TapdanceDemo.app # relative to this file
  id: dev.tapdance.demo
steps:
  - launch_app: { app_id: dev.tapdance.demo, relaunch: true }
  - expect_visible: { id: email }
  - type_text: { text: ada@example.com, into_id: email }
  - type_text: { text: secret1, into_id: password }
  - tap: { text: Sign in }
  - expect_visible: { text: "Welcome, ada@example.com", timeout_ms: 10000 }
  - take_screenshot: { note: signed in }
```

Android ([examples/android-demo/signin.scenario.yaml](../examples/android-demo/signin.scenario.yaml));
the fields are found by their labels:

```yaml
name: Android demo sign-in
platform: android
device:
  platform: android
  device: Pixel 8
app:
  path: build/TapdanceDemo.apk # relative to this file
  id: dev.tapdance.demo
steps:
  - launch_app: { app_id: dev.tapdance.demo, relaunch: true }
  - type_text: { text: ada@example.com, into_text: Email }
  - type_text: { text: secret1, into_text: Password }
  - press_key: { key: dismiss_keyboard }
    continue_on_failure: true
  - tap: { text: Sign in }
  - expect_visible: { text: "Welcome, ada@example.com", timeout_ms: 10000 }
  - take_screenshot: { note: signed in }
```

The same flow in JSON:

```json
{
  "name": "Android demo sign-in",
  "device": { "platform": "android", "device": "Pixel 8" },
  "steps": [
    { "launch_app": { "app_id": "dev.tapdance.demo", "relaunch": true } },
    { "type_text": { "text": "ada@example.com", "into_text": "Email" } },
    { "type_text": { "text": "secret1", "into_text": "Password" } },
    { "tap": { "text": "Sign in" } },
    { "expect_visible": { "text": "Welcome, ada@example.com" } }
  ]
}
```

Build the apps first with `examples/ios-demo/build.sh` or `examples/android-demo/build.sh`.

Scenario files are plain text in your repository. Do not put real passwords in them; use a test
account.

## The report and evidence

Each run writes an evidence folder in the session's artifacts folder (`artifacts.directory`, by default
`./tapdance-artifacts`), at `<session>/runs/<time>-<scenario name>/`:

| File | What |
| --- | --- |
| `report.json` | The full report (below). |
| `report.md` | A short summary: device, app, environment, one table row per step, and the failures. |
| `step-NN-failure.png` | The screen when step NN failed. |
| `step-NN-tree.json` | The full UI tree (all elements, not only interactive ones) when step NN failed. |
| `step-NN-screenshot.png` | A `take_screenshot` step's image. |
| `recording.mp4` | A `start_recording` step's video. |

Every file is also recorded in the session's artifact manifest, so `tapdance artifacts` (MCP:
`get_test_artifacts`) lists them.

`report.json`:

```json
{
  "scenario": "Android demo sign-in",
  "file": "/work/examples/android-demo/signin.scenario.yaml",
  "status": "fail",
  "startedAt": "2026-11-01T10:00:00.000Z",
  "finishedAt": "2026-11-01T10:00:21.400Z",
  "durationMs": 21400,
  "sessionId": "…",
  "device": { "platform": "android", "model": "Pixel 8", "osVersion": "34", "leaseId": "…", "location": "local" },
  "app": { "id": "dev.tapdance.demo" },
  "leased": true,
  "released": true,
  "environment": { "tapdance": "0.1.0", "node": "v22.13.0", "host": "darwin 25.5.0", "git": { "commit": "…", "branch": "main" } },
  "summary": { "passed": 6, "failed": 1, "skipped": 1 },
  "steps": [
    { "index": 7, "name": "expect_visible text \"Welcome, ada@example.com\"", "action": "expect_visible", "status": "fail", "durationMs": 10040,
      "error": { "code": "ASSERTION_FAILED", "message": "\"Welcome, ada@example.com\" is not on screen (waited 10000 ms)", "hint": "…" },
      "evidence": { "screenshot": "…/step-07-failure.png", "tree": "…/step-07-tree.json" } },
    { "index": 8, "name": "take_screenshot \"signed in\"", "action": "take_screenshot", "status": "skipped", "durationMs": 0 }
  ],
  "evidenceDir": "…", "reportPath": "…/report.json", "summaryPath": "…/report.md"
}
```

(Shortened: `steps` lists every step.) `index` counts from 1, and an `app.path` install is step 1.
A step that failed has `error.code`: `ASSERTION_FAILED` when an expectation did not hold, or the
Tapdance error code of the call that failed (`ELEMENT_NOT_FOUND`, `TIMEOUT`, `LEASE_LOST`, …). After
`LEASE_LOST` the remaining steps are skipped even with `continue_on_failure`. `git` is present when
the scenario file is inside a git work tree. The app version is not read from the device yet.

Typed text is never written into step names. Secrets Tapdance recognises are redacted from the report.

## From the SDK

```ts
import { Tapdance, loadScenario, runScenario } from "@tapdance/sdk";

const tapdance = await Tapdance.create();
const scenario = await loadScenario("examples/android-demo/signin.scenario.yaml");
const report = await runScenario(tapdance, scenario, { file: "examples/android-demo/signin.scenario.yaml", onStep: (s) => console.log(s.status, s.name) });
console.log(report.status, report.summaryPath);
```

`parseScenario(text, { filename })` and `validateScenario(object)` check a scenario without running
it. `scenarioFromToolCalls(calls)` turns a list of MCP tool calls (`{ tool, arguments, isError? }`) into
a scenario: `lease_device` becomes the `device` block, device actions become steps, reads such as
`inspect_screen` are dropped, and failed calls are left out. It also returns `notes` about what will not
replay faithfully, such as taps on a `ref` and `execute_tool` calls.
