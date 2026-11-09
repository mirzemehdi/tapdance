# Evidence: machine auto issues #167, #168, #169 — 2026-11-09

Auto mode (`tapdance machine auto`) used for real from a Linux VPS with `tapdance-cli@0.3.0` from npm,
19:58–20:04 UTC. Three issues came out of it:
[#167](https://github.com/mirzemehdi/tapdance/issues/167),
[#168](https://github.com/mirzemehdi/tapdance/issues/168) and
[#169](https://github.com/mirzemehdi/tapdance/issues/169). This record holds the CLI output that shows
them. Each issue has a unit test that reproduced it (listed below). **Fixed in #170**: the tests are now
ordinary tests that pass; the field check of the fixed version is still to run.

The excerpts are redacted: the Google Cloud project id is `<project>`, the tailnet name `tailXXXX`, an old
Mac connect target with no platform list is `old-mac`; IP addresses, lease ids, pids and token prefixes
are left out.

## Environment

| | |
| --- | --- |
| Agent's machine | A Linux VPS, Node.js 22, gcloud, Tailscale. `tapdance-cli@0.3.0` installed from npm |
| Connect targets | `old-mac` (no platform list; offline the whole run), `scw-mac` (ios, reached through an ssh tunnel; down at the start), `android` (android; the auto-mode machine) |
| Machine | `android`: a Google Cloud `n2-standard-4` made earlier with `tapdance machine create --cloud gcp`, auto mode on for android |
| Not covered | Anything on the host itself; iOS auto mode; the `-c <config>` note in #167 is shown below but has no test |

## #167: an offline target with no platform list stops auto start

Auto mode on, then the VM stopped:

```text
$ tapdance machine stop android
Stopped android. It now bills only its disk (about USD 6.40 a month) until you destroy it. ...
$ gcloud compute instances list --project <project>
NAME              ZONE           MACHINE_TYPE   ...  STATUS
tapdance-android  us-central1-a  n2-standard-4  ...  TERMINATED
```

The lease does not start it (11 s, exit 4); the VM stays TERMINATED:

```text
$ tapdance device lease --platform android
› old-mac (https://old-mac.tailXXXX.ts.net:4720) does not answer: The operation was aborted due to timeout
› android (https://tapdance-android.tailXXXX.ts.net:4720) does not answer: The operation was aborted due to timeout
error [PROVIDER_UNREACHABLE] Cannot lease android: target old-mac (https://old-mac.tailXXXX.ts.net:4720) does not answer (The operation was aborted due to timeout); nor does android
  fix: No other target answers either. Retry when old-mac is back (`tapdance host status` on that host, `tailscale status` here); `tapdance doctor` shows every target.
$ gcloud compute instances list --project <project>
tapdance-android  us-central1-a  n2-standard-4  ...  TERMINATED
```

`--target android` does not help (16 s, exit 4, VM still TERMINATED):

```text
$ tapdance device lease --platform android --target android
› android (https://tapdance-android.tailXXXX.ts.net:4720) does not answer: The operation was aborted due to timeout
error [PROVIDER_UNREACHABLE] Cannot lease android: target android (https://tapdance-android.tailXXXX.ts.net:4720) does not answer (The operation was aborted due to timeout)
```

Nor does `-c` with a config that lists only the android target: the output is the same as the first
lease, naming `old-mac`.

With a scratch `TAPDANCE_HOME` whose config keeps only the `android` target, the same lease starts the VM
(91 s, exit 0; VM RUNNING afterwards):

```text
› Auto mode: starting machine android (it was stopped)…
› Queued for a device (position 1, waiting-for-device) (5 s)
› Granted Pixel 8 (android 34); attaching automation session
warning: Started machine android for this lease in 41 s; it stops itself again when idle.
Device:    Pixel 8
Status:    Ready
```

Tests (they failed before #170, pass after):

- `packages/cli/src/machine/machine.test.ts`: "#167: starts its stopped machine when the other target is an offline host with no platform list" (mocked gcloud). Today `autoDecision` counts `old-mac` as a host that serves android and rethrows.
- `packages/sdk/src/tapdance.test.ts`: "#167: asks the hook when the lease names the auto machine's target and it does not answer" (FakeProvider). Today the SDK turns auto mode off whenever a target is named.

## #168: an unknown model shows PROVIDER_UNREACHABLE

The android host up, `old-mac` offline. With only the android target configured, the host's real answer
comes back (2 s, exit 2):

```text
$ TAPDANCE_HOME=<scratch, android target only> tapdance device lease --platform android --device "Pixel 99 Ultra"
› Requesting android "Pixel 99 Ultra" from https://tapdance-android.tailXXXX.ts.net:4720 ...
error [USAGE] lease failed: refused by simlock: Unknown android model: Pixel 99 Ultra
```

With the normal config it is lost (11 s, exit 4), and the fix line itself says android is up:

```text
$ tapdance device lease --platform android --device "Pixel 99 Ultra"
› old-mac (https://old-mac.tailXXXX.ts.net:4720) does not answer: The operation was aborted due to timeout
error [PROVIDER_UNREACHABLE] Cannot lease android: target old-mac (https://old-mac.tailXXXX.ts.net:4720) does not answer (The operation was aborted due to timeout)
  fix: Up: scw-mac (ios), android (android). Retry when old-mac is back (`tapdance host status` on that host, `tailscale status` here); `tapdance doctor` shows every target.
```

Nothing was created in either case: Google Cloud instances, disks, networks and firewall rules were the
same before and after.

Test (it failed before #170, passes after): `packages/sdk/src/routing-provider.test.ts`: "#168: reports the
refusal of the host that answered, not a down host, for an unknown model" (mocked hosts).
`RoutingProvider.lease` throws PROVIDER_UNREACHABLE whenever any candidate is down, even when the hosts
that answered all refused the request.

## #169: status says "now: created"; "Started machine" is a warning

`tapdance machine auto` printed the same line at 20:00:34, with the VM TERMINATED (gcloud showed
TERMINATED at 20:00:18 and the next lease had to start it), and at 20:04:15, with it RUNNING:

```text
android: machine android on Google Cloud (n2-standard-4, project <project>): created on the first lease that needs it, started when stopped, stops itself after 30 idle minutes
  now: created
```

`tapdance machine list` at the same time shows the real state (`TERMINATED`, later `RUNNING`). The start
notice comes out as a warning (see the #167 lease above):

```text
warning: Started machine android for this lease in 41 s; it stops itself again when idle.
```

Tests (they failed before #170, pass after):

- `packages/cli/src/cli.test.ts`: "#169: shows a stopped auto-mode VM as stopped, not 'created'" (built CLI, a fake `gcloud` on `PATH` that answers TERMINATED).
- `packages/cli/src/lease-notices.test.ts`: "#169: prints auto mode's 'Started machine' notice as information, not as a warning" (FakeProvider and a fake auto-mode hook). `leaseWithNotices` prints every lease notice with `out.warn`.

## How to re-run

The tests: `npx vitest run --project unit -t "#16"` (they pass since #170). The field run needs a real Google
Cloud machine in auto mode and a second, offline connect target with no platform list (ask the owner
first, see AGENTS.md "Cloud resources for tests").
