# Threat model: a remote agent on your Mac

What someone can do with a worker-guard token (`tdg_…`), per platform, and what limits it. The token
lives on the agent's machine (often a VPS), so plan for that machine being compromised: whatever the
token allows is what an attacker gets.

## What a token holder can do

| Area (`allow.*`) | Android emulator | iOS simulator |
| --- | --- | --- |
| `interaction`, `inspection`, `screenshots`, `recording`, `streaming`, `input` | Drive and watch the emulator. | Drive and watch the simulator. |
| `install` | Install an APK into the emulator, a separate VM. | **Install a simulator app, which runs as an ordinary macOS process under the account that runs the worker.** It is not sandboxed the way an app on an iPhone is: it can read that account's files (home folder, SSH keys, browser data) as far as macOS privacy controls (TCC) allow. Installing an iOS app is code execution on the Mac. |
| `files` | Files in the emulator's shared storage or a debug app's sandbox. | Files in Photos, the Files app or an app's container, resolved by the guard; no Mac paths. |
| `deviceShell` | A shell **inside the emulator's VM** (wiped at release). Code there can reach the Mac's loopback services through the emulator network (10.0.2.2). | Not offered: a simulator shell would be a Mac shell. |
| `settings`, `perf`, `logs`, `notifications` | Device-only changes and readings. | Device-only changes and readings. |
| `physicalDevices` (off by default) | Phones enrolled with Simlock, with their owner's data. | Same. |

The guard refuses everything that reaches the Mac directly: host shells, `simctl spawn`, `adb push`/`pull`
of Mac paths, port forwarding, profiles written to Mac paths, macOS privacy permissions. See
[What the guard enforces](personal-mac.md#what-the-guard-enforces-on-the-mac).

## What limits the damage

1. **A dedicated, standard macOS account** for hosting (not your own, not an administrator). Then an
   iOS app or an escape from a simulator or emulator runs with that account's rights only: it cannot
   read your home folder, keychain or browser sessions, and cannot become root.
   `infrastructure/scripts/macos-create-worker-account.sh` sets one up (untested). `host up` refuses
   an administrator account unless you pass `--allow-admin-account`, and prints this warning at the end.
2. **A token with fewer areas.** `tapdance host up --scope interaction,inspection,screenshots,streaming,input`
   (or `worker guard pair --scope …`) issues a token that can drive and watch devices but not install
   apps, copy files or open a device shell. A scope never adds what the host policy turns off; both must
   allow a request. `worker guard tokens` and `host status` show each token's scopes, age and expiry.
3. **Short-lived, revocable tokens.** Tokens expire (7 days by default, `limits.tokenDays`), and
   `tapdance worker guard revoke <id|all>` or `tapdance host down --revoke` stops them on the next request.
4. **The network.** The guard listens on loopback and is reached through Tailscale. A Tailscale ACL that
   lets only the agent's machine reach the guard's port keeps the rest of the tailnet out:

   ```json
   { "action": "accept", "src": ["<agent machine's 100.x address or tag>"], "dst": ["<this Mac's 100.x address or tag>:4720"] }
   ```

5. **The host policy** (`~/.tapdance/worker/policy.json`) turns whole areas off for every token, for
   example `allow.install: false` or `allow.deviceShell: false`.
6. **The audit log** (`~/.tapdance/worker/audit.log`, `tapdance worker guard audit`) records every
   request with its token id, so you can see what a token did.

## Not covered yet

- An allow-list of apps a token may install (by bundle id or package): the guard sees an upload, not
  the app inside it.
- Per-request approval by the person (for example, approving an install in the viewer).
- Builds on the host from a client's source: Xcode run-script phases and Gradle build scripts run any
  command, so building is code execution on the Mac by design. The first build mode (git, issue #45)
  is built with that in mind: off by default, repositories on an allow-list, optional protected refs.
  See [one-command host](../deployment/one-command-host.md#builds-on-the-host). What a host that builds
  private repositories keeps, and what leaks if it is compromised:
  [private repositories](../guides/private-repositories.md#if-the-host-is-compromised).
