#!/usr/bin/env bash
# Field-test driver for the Tapdance CLI: runs a fixed checklist of `tapdance` commands against the
# host this machine is connected to, timing each step, and writes a PASS/FAIL table, results.tsv and
# results.json. Dev tooling for field tests (docs/testing/field-test-cloud-android.md,
# docs/testing/field-test-rented-mac-ios.md); not shipped.
#
# Usage:
#   scripts/field-test/cli-checklist.sh <base|app|build> <out-dir> [--param KEY=VALUE ...]
#
# Suites:
#   base   the launcher: lease, inspect, swipe, keys, tap, wait, rotate, notifications, recording,
#          push to Downloads, logs, audit, links, artifacts, release. Optional: LAUNCHER_TAP.
#   app    your app: install (from CI with CI_REPO + CI_ARTIFACT [+ CI_BRANCH], and/or a file: APK on
#          Android, APP on iOS), launch APP_ID, inspect, screenshot, recording, logs, crash logs, audit, app list, kill,
#          clear, uninstall, release. Optional: TAP_TEXT (a button to tap, then back), TYPE_INTO (a
#          field's label to type into), SEQUENCE_FILE (a `ui sequence` JSON file), DEBUGGABLE=1 (the
#          build is debuggable: push to and pull from its sandbox and compare).
#   build  a build on the host: app build --git BUILD_REPO --ref BUILD_REF [--dir BUILD_DIR] --launch
#          APP_ID, then inspect, screenshot, release. The host must allow-list the repository.
# Platform: PLATFORM=android (default) or ios; DEVICE and OS pick the model and version to lease (e.g.
# DEVICE="iPhone 16" OS=26.1). On iOS: base adds a system alert read, the language setting and crash
# reports, pushes to the Files app instead of Downloads and skips Android's Back key; app installs APP (a
# simulator .app, or a .zip holding one) and runs the app once in German (LANGUAGE, default de-DE);
# build passes BUILD_SCHEME / BUILD_PROJECT instead of BUILD_DIR. Installs from CI work on both: an APK
# artifact on Android, a simulator .app (or a zip of one) on iOS.
# Parameters come from --param KEY=VALUE or the environment as FIELD_TEST_KEY. A step whose parameter
# is not set is SKIPPED, not failed.
#
# Environment: TAPDANCE_HOME must be a scratch directory, never ~/.tapdance (the owner's config and
# credentials); run `tapdance connect` with the same TAPDANCE_HOME first. TAPDANCE_SESSION_ID defaults
# to field-test-cli. TAPDANCE_BIN overrides the CLI (default: node <repo>/packages/cli/dist/main.js).
#
# Exit code: 0 when every step that ran passed, 1 otherwise, 2 on usage errors.

set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"

die() { echo "cli-checklist: $*" >&2; exit 2; }
usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; }

suite=""
out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h | --help) usage; exit 0 ;;
    --param)
      [[ $# -ge 2 && "$2" == *=* ]] || die "--param needs KEY=VALUE"
      key="${2%%=*}"
      [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || die "parameter names are UPPER_CASE, got '$key'"
      export "FIELD_TEST_$key=${2#*=}"
      shift 2 ;;
    -*) die "unknown option $1" ;;
    *)
      if [[ -z "$suite" ]]; then suite="$1"
      elif [[ -z "$out" ]]; then out="$1"
      else die "unexpected argument $1"; fi
      shift ;;
  esac
done
[[ "$suite" == base || "$suite" == app || "$suite" == build ]] || { usage >&2; exit 2; }
[[ -n "$out" ]] || die "give an output directory"

# ------------------------------------------------------------------ safety

[[ -n "${TAPDANCE_HOME:-}" ]] || die "set TAPDANCE_HOME to a scratch directory (the one you ran tapdance connect with)"
real() { (cd "$1" 2>/dev/null && pwd -P) || echo "$1"; }
if [[ "$(real "$TAPDANCE_HOME")" == "$(real "$HOME/.tapdance")" ]]; then
  die "TAPDANCE_HOME is ~/.tapdance, the owner's own config and credentials: use a scratch directory"
fi
export TAPDANCE_SESSION_ID="${TAPDANCE_SESSION_ID:-field-test-cli}"

if [[ -n "${TAPDANCE_BIN:-}" ]]; then
  td_cmd=("$TAPDANCE_BIN")
else
  [[ -f "$repo/packages/cli/dist/main.js" ]] || die "$repo/packages/cli/dist/main.js is missing: run pnpm build first"
  td_cmd=(node "$repo/packages/cli/dist/main.js")
fi
td() { "${td_cmd[@]}" "$@"; }

mkdir -p "$out" || die "cannot create $out"
out="$(cd "$out" && pwd)"
printf 'tapdance field test %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$out/push.txt"

# ------------------------------------------------------------------ timing and results

now_ms() {
  if command -v perl >/dev/null 2>&1; then perl -MTime::HiRes=time -e 'printf "%d\n", time * 1000'
  elif command -v python3 >/dev/null 2>&1; then python3 -c 'import time; print(int(time.time() * 1000))'
  else echo "$(($(date +%s) * 1000))"; fi
}

n=0
passed=0
failed=0
skipped=0
stopped=""
printf 'n\tlabel\tstatus\tms\tcommand\n' >"$out/results.tsv"
json_rows=""

json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr '\n\t' '  '; }

record() { # n label status ms command
  printf '%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "${4:--}" "$5" >>"$out/results.tsv"
  json_rows+="${json_rows:+,}"$'\n'"    {\"n\": $1, \"label\": \"$(json_escape "$2")\", \"status\": \"$3\", \"ms\": ${4:-null}, \"command\": \"$(json_escape "$5")\"}"
}

# step <label> <required params, comma-separated, or -> <command...>
# Set critical=1 to skip the rest when it fails; always=1 to run even after that (release).
step() {
  local label="$1" requires="$2"
  shift 2
  n=$((n + 1))
  local num
  num="$(printf '%02d' "$n")"
  local cmd="$*"
  local missing="" var
  if [[ "$requires" != "-" ]]; then
    IFS=',' read -r -a vars <<<"$requires"
    for var in "${vars[@]}"; do
      local name="FIELD_TEST_$var"
      [[ -n "${!name:-}" ]] || missing+="${missing:+, }$var"
    done
  fi
  if [[ -n "$stopped" && "${always:-0}" != 1 ]]; then missing="${missing:-$stopped}"; fi
  if [[ -n "$missing" ]]; then
    skipped=$((skipped + 1))
    printf 'SKIP %s %-26s %9s  needs %s\n' "$num" "$label" "" "$missing"
    record "$n" "$label" SKIP "" "$cmd"
    return 0
  fi
  local t0 t1 rc ms
  t0="$(now_ms)"
  "$@" >"$out/$num-$label.out" 2>"$out/$num-$label.err"
  rc=$?
  t1="$(now_ms)"
  ms=$((t1 - t0))
  if [[ $rc -eq 0 ]]; then
    passed=$((passed + 1))
    printf 'PASS %s %-26s %6s ms  %s\n' "$num" "$label" "$ms" "$(head -c 120 "$out/$num-$label.out" | tr '\n' ' ')"
    record "$n" "$label" PASS "$ms" "$cmd"
  else
    failed=$((failed + 1))
    printf 'FAIL %s %-26s %6s ms  exit %s: %s\n' "$num" "$label" "$ms" "$rc" "$(tail -c 200 "$out/$num-$label.err" | tr '\n' ' ')"
    record "$n" "$label" FAIL "$ms" "$cmd"
    if [[ "${critical:-0}" == 1 ]]; then stopped="an earlier critical step ($label) to pass"; fi
  fi
}

p() { local name="FIELD_TEST_$1"; printf '%s' "${!name:-}"; }

# ------------------------------------------------------------------ suites

platform="$(p PLATFORM)"
platform="${platform:-android}"
[[ "$platform" == android || "$platform" == ios ]] || die "PLATFORM is android or ios, got '$platform'"
ios() { [[ "$platform" == ios ]]; }
lease_cmd=(td device lease --platform "$platform")
[[ -n "$(p DEVICE)" ]] && lease_cmd+=(--device "$(p DEVICE)")
[[ -n "$(p OS)" ]] && lease_cmd+=(--os "$(p OS)")
language="$(p LANGUAGE)"
language="${language:-de-DE}"

suite_base() {
  step doctor - td doctor
  step devices - td devices
  critical=1 step lease - "${lease_cmd[@]}"
  step status - td device status
  step key_home - td ui key home
  # iOS: agent-device reads the session's app; the Home Screen is SpringBoard.
  if ios; then step inspect - td ui inspect --app com.apple.springboard; else step inspect - td ui inspect; fi
  step screenshot - td screenshot -o "$out/launcher.png" --note "launcher, CLI field test"
  step swipe_up - td ui swipe --direction up
  step key_home2 - td ui key home
  if ios; then
    step inspect_home2 - td ui inspect --app com.apple.springboard
    step tap_launcher_app - td ui tap --text "${FIELD_TEST_LAUNCHER_TAP:-Settings}"
  else
    step tap_launcher_app LAUNCHER_TAP td ui tap --text "$(p LAUNCHER_TAP)"
  fi
  step wait_stable - td ui wait --stable --timeout 15000
  if ios; then step key_home3 - td ui key home; else step key_back - td ui key back; fi
  step rotate_landscape - td device setting orientation landscape
  step rotate_portrait - td device setting orientation portrait
  if ios; then
    # The iOS simulator has no notification list: post to an app, open the Notification Center, read it.
    step notification_post - td device notifications post --app com.apple.Preferences --title "Tapdance field test" --text "posted from the CLI"
    step notification_open - td device notifications open
    step notification_read - td ui inspect --app com.apple.springboard
    step notification_close - td device notifications close
  else
    step notification_post - td device notifications post --title "Tapdance field test" --text "posted from the CLI"
    step notification_list - td device notifications list
  fi
  step record_start - td record start -o "$out/launcher.mp4"
  step swipe_left - td ui swipe --direction left
  step record_stop - td record stop
  if ios; then
    step push_files - td device push "$out/push.txt" --to files
    step alert_get - td ui alert get
    step language_read - td device setting language
    step crashes - td device crashes
  else
    step push_downloads - td device push "$out/push.txt" --to downloads
  fi
  step logs - td logs -n 50
  if ios; then step audit - td ui audit --app com.apple.Preferences; else step audit - td ui audit; fi
  step links - td device links
  step artifacts - td artifacts
  always=1 step release - td device release
}

pull_matches() { cmp -s "$out/push.txt" "$out/pulled.txt"; }

suite_app() {
  critical=1 step lease - "${lease_cmd[@]}"
  local ci=(td app install --from-ci "$(p CI_REPO)" --artifact "$(p CI_ARTIFACT)")
  [[ -n "$(p CI_BRANCH)" ]] && ci+=(--branch "$(p CI_BRANCH)")
  step install_from_ci CI_REPO,CI_ARTIFACT "${ci[@]}"
  if ios; then
    step install_app APP td app install "$(p APP)"
  else
    step install_apk APK td app install "$(p APK)"
  fi
  critical=1 step launch APP_ID td app launch "$(p APP_ID)"
  ios && step launch_console APP_ID td app launch "$(p APP_ID)" --console
  step inspect - td ui inspect
  step screenshot - td screenshot -o "$out/app.png" --note "app after launch"
  step tap_text TAP_TEXT td ui tap --text "$(p TAP_TEXT)"
  ios || step back TAP_TEXT td ui key back
  step type_into_field TYPE_INTO td ui type "Tapdance Für Elise" --text "$(p TYPE_INTO)"
  step swipe_up - td ui swipe --direction up
  step sequence SEQUENCE_FILE td ui sequence "$(p SEQUENCE_FILE)"
  step record_start - td record start -o "$out/app.mp4"
  step swipe_down - td ui swipe --direction down
  step record_stop - td record stop
  step logs_app APP_ID td logs --app "$(p APP_ID)" -n 40
  step logs_crash - td logs --crash -n 40
  if ios; then
    step alert_get - td ui alert get
    step crashes_app APP_ID td device crashes --app "$(p APP_ID)"
    step push_documents APP_ID td device push "$out/push.txt" --to documents --app "$(p APP_ID)" --name field-test.txt
    step push_files - td device push "$out/push.txt" --to files
    step language_set - td device setting language "$language"
    step launch_in_locale APP_ID td app launch "$(p APP_ID)" --locale "$language"
    step screenshot_language - td screenshot -o "$out/app-$language.png" --note "app in $language"
    step language_reset - td device setting language en-US
  else
    step push_sandbox DEBUGGABLE td device push "$out/push.txt" --to app_sandbox --app "$(p APP_ID)" --name field-test.txt
    step pull_sandbox DEBUGGABLE td device pull --app "$(p APP_ID)" --path files/field-test.txt -o "$out/pulled.txt"
    step pull_matches_push DEBUGGABLE pull_matches
    step push_downloads - td device push "$out/push.txt" --to downloads
  fi
  step rotate_landscape - td device setting orientation landscape
  step rotate_portrait - td device setting orientation portrait
  step audit - td ui audit
  step links - td device links
  step app_list - td app list
  step kill APP_ID td app kill "$(p APP_ID)"
  step clear APP_ID td app clear "$(p APP_ID)"
  step launch_after_clear APP_ID td app launch "$(p APP_ID)"
  step uninstall APP_ID td app uninstall "$(p APP_ID)"
  step artifacts - td artifacts
  always=1 step release - td device release
}

suite_build() {
  critical=1 step lease - "${lease_cmd[@]}"
  local build=(td app build --git "$(p BUILD_REPO)" --ref "$(p BUILD_REF)" --launch "$(p APP_ID)")
  [[ -n "$(p BUILD_DIR)" ]] && build+=(--dir "$(p BUILD_DIR)")
  [[ -n "$(p BUILD_PROJECT)" ]] && build+=(--project "$(p BUILD_PROJECT)")
  [[ -n "$(p BUILD_SCHEME)" ]] && build+=(--scheme "$(p BUILD_SCHEME)")
  step build BUILD_REPO,BUILD_REF,APP_ID "${build[@]}"
  step inspect - td ui inspect
  step screenshot - td screenshot -o "$out/build.png" --note "built on the host"
  step build_reused BUILD_REPO,BUILD_REF,APP_ID "${build[@]}"
  always=1 step release - td device release
}

started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
t_start="$(now_ms)"
echo "Tapdance CLI field test, suite $suite ($platform), session $TAPDANCE_SESSION_ID, TAPDANCE_HOME $TAPDANCE_HOME"
"suite_$suite"
t_end="$(now_ms)"

cat >"$out/results.json" <<EOF
{
  "suite": "$suite",
  "startedAt": "$started",
  "durationMs": $((t_end - t_start)),
  "session": "$(json_escape "$TAPDANCE_SESSION_ID")",
  "passed": $passed,
  "failed": $failed,
  "skipped": $skipped,
  "steps": [$json_rows
  ]
}
EOF

echo
column -t -s $'\t' "$out/results.tsv" 2>/dev/null || cat "$out/results.tsv"
echo "$passed/$((passed + failed)) passed, $skipped skipped; output of each step and results.json in $out"
[[ $((passed + failed)) -gt 0 && $failed -eq 0 ]]
