# Threat model: what a token can do

What someone who holds a Tapdance token can do to a **host** (the machine with the devices), what
limits it, and what Tapdance does not protect against. Terms are in the [glossary](../glossary.md).

Plan for the agent's machine being compromised. A token lives there (often on a Linux VPS), so whatever
the token allows is what an attacker gets. The same goes for the agent itself, the repository it works
on, and the app under test: treat all of them as untrusted input.

## The facts to remember

1. **Leasing is not a sandbox.** A lease reserves a device for one session. It does not isolate the
   agent from the host that runs the device, and two agents on one host are not isolated from each
   other's files. A service for strangers would need a separate host or VM per tenant.
2. **Device-only mode is the boundary.** In device-only mode the agent's machine holds a **pairing
   token** (`tdg_…`) and reaches only the **guard**, which allows a fixed list of device actions. It is
   the setup proven across machines, and the right one for any machine you care about. See
   [device-only mode](device-only-mode.md).
3. **A Simlock agent token is close to shell access on the host,** as the user that runs the worker.
   Simlock's `exec` runs `adb` and `simctl` commands there for a lease's holder, `simctl spawn` alone
   can start any program, and agent-device runs there too. Simlock's own docs say to treat an agent
   token like shell access. This is the token of [gateway mode](../deployment/gateway-mode.md) and of a
   worker reached without a guard. Tapdance offers no raw shell, `adb` or `simctl` tool, but anyone who
   holds such a token can call Simlock's HTTP API directly.
4. **A worker that joins a gateway gives the gateway operator rights over it.** Join only a gateway you
   trust as much as the host itself. `tapdance worker login` refuses unless you pass
   `--accept-gateway-exec`. Gateway, operator and join tokens are covered in
   [gateway mode](../deployment/gateway-mode.md).
5. **Remote use needs TLS or a private network.** Simlock, the guard, the viewer and the MCP HTTP server
   speak plain HTTP. Use Tailscale (as `host up` does), WireGuard, an SSH tunnel, or a reverse proxy with
   HTTPS. Tapdance refuses to send a token over plain `http://` or `ws://` to a public address.
6. **Tokens never go in config files.** See [tokens and where they live](#tokens-and-where-they-live).

## What a pairing token can do

Per policy area (`allow.*` in the host's policy, and the token's scopes):

| Area (`allow.*`) | Android emulator | iOS simulator |
| --- | --- | --- |
| `interaction`, `inspection`, `screenshots`, `recording`, `streaming`, `input` | Drive and watch the emulator. | Drive and watch the simulator. |
| `install` | Install an APK into the emulator, a separate VM. | **Install a simulator app, which runs as an ordinary macOS process under the account that runs the worker.** It is not sandboxed the way an app on an iPhone is: it can read that account's files (home folder, SSH keys, browser data) as far as macOS privacy controls (TCC) allow. Installing an iOS app is code execution on the Mac. |
| `files` | Files in the emulator's shared storage or a debug app's sandbox. | Files in Photos, the Files app or an app's container, resolved by the guard; no Mac paths. |
| `deviceShell` | A shell **inside the emulator's VM** (wiped at release). Code there can reach the host's loopback services through the emulator network (10.0.2.2). | Not offered: a simulator shell would be a Mac shell. |
| `settings`, `perf`, `logs`, `notifications` | Device-only changes and readings. | Device-only changes and readings. |
| `physicalDevices` (off by default) | Phones enrolled with Simlock, with their owner's data. | Same. |

The guard refuses everything that reaches the host directly: host shells, `simctl spawn`, `adb push`/`pull`
of host paths, port forwarding, profiles written to host paths, macOS privacy permissions. See
[what the guard enforces](device-only-mode.md#what-the-guard-enforces-on-the-host).

## Host builds and installs from CI

Both are off until the host's owner turns them on, and both need a token with the `install` scope.

**Host builds run your repository's code on the host.** A [host build](../guides/host-builds.md)
fetches a repository the owner allowed (`tapdance host builds enable --repo …`) and builds it. Xcode Run
Script phases and Gradle build scripts run any command, as the hosting account: building is code
execution on the host by design, and Tapdance does not sandbox it. A token holder can ask for any
commit of an allowed repository, unless the owner limits builds to protected branches
(`--protected-ref main`), so a push to a feature branch cannot get code built. The git credentials (the
host's `gh` login or a deploy key) stay on the host. What a compromised host leaks:
[private repositories](../guides/private-repositories.md#if-the-host-is-compromised).

**Installs from CI use the host's GitHub login.** With `tapdance host artifacts enable --repo …`, the host
downloads a GitHub Actions artifact with its own `gh` token and installs it on the lease
([CI builds](../guides/ci-builds.md)). The token never leaves the host; the agent only names the
repository and the artifact. Give `gh` a fine-grained, read-only token for the repositories it needs,
limit runs to branches you trust (`--branch main`), and remember that an iOS app from CI is still code
that runs as the hosting account.

## Several hosts: one token per host

An agent's machine can have several **connect targets**, for example a Linux host for Android and a Mac
for iOS. Each host has its own guard and its own pairing token. `tapdance connect` stores each token in
`~/.tapdance/credentials.json` (mode 600) under its host's origin, and Tapdance sends it only to that
origin. One leaked token reaches one host, and revoking it on that host leaves the others working.
`TAPDANCE_TOKEN` is never used for connect targets, and a project's `tapdance.config.json` cannot
redirect a saved token to another server ([token binding](../configuration.md#token-binding)).

## What limits the damage

1. **A dedicated, standard account** for hosting (not your own, not an administrator). Then an iOS
   app, a build script, or an escape from a simulator or emulator runs with that account's rights only:
   it cannot read your home folder, keychain or browser sessions, and cannot become root. On macOS,
   `infrastructure/scripts/macos-create-worker-account.sh` sets one up (not run yet). `host up` refuses
   an administrator account unless you pass `--allow-admin-account`, and prints this warning at the end.
   A rented Mac or a cloud VM that holds nothing of yours is the other way.
2. **A token with fewer areas.** `tapdance host up --scope interaction,inspection,screenshots,streaming,input`
   (or `worker guard pair --scope …`) issues a token that can drive and watch devices but not install
   apps, copy files or open a device shell. A host build installs its app on the lease, so it needs the
   `install` scope too. A scope never adds what the host policy turns off; both must allow a request.
   `worker guard tokens` and `host status` show each token's scopes, age and expiry.
3. **Short-lived, revocable tokens.** Pairing tokens expire (7 days by default, `limits.tokenDays`), and
   `tapdance worker guard revoke <id|all>` or `tapdance host down --revoke` stops them on the next
   request.
4. **The network.** The guard listens on loopback and is reached through Tailscale. A Tailscale ACL that
   lets only the agent's machine reach the guard's port keeps the rest of the tailnet out:

   ```json
   { "action": "accept", "src": ["<agent machine's 100.x address or tag>"], "dst": ["<this host's 100.x address or tag>:4720"] }
   ```

   With `host up --tailscale-ssh`, a shell over Tailscale SSH bypasses the guard altogether: limit the
   tailnet policy's `ssh` rule to your own devices in `src` (not the agent's machine) and to the hosting
   account in `users` (no root).
5. **The host policy** (`~/.tapdance/worker/policy.json`) turns whole areas off for every token, for
   example `allow.install: false` or `allow.deviceShell: false`.
6. **The audit log** (`~/.tapdance/worker/audit.log`, `tapdance worker guard audit`) records every
   request with its token id, so you can see what a token did.

## Running a host safely

| Do | Why |
| --- | --- |
| Host from a dedicated account with no sudo (on Linux servers, the `tapdance` user in the [dedicated server guide](../deployment/dedicated-linux-server.md)). | Everything the devices and builds do runs as this account. |
| Open no inbound ports on the host. | The guard is reached over Tailscale. Allow ssh only from your own addresses, or through IAP or SSM. |
| Never expose `adb`, the emulator console, Simlock's adb server port (5038) or Simlock's HTTP port on a network. | They are unauthenticated or token-only device control. |
| Pair one token per agent's machine, and label it. | You can revoke one without breaking the others. |
| Keep cloud credentials, signing keys and personal secrets off hosts. | Anything the hosting account can read, an installed iOS app or a build script can read. |
| On a Mac host, keep Apple signing certificates and App Store Connect keys off it unless it must sign builds; prefer a separate keychain and account. | Same reason. Tapdance gives guidance only; it does not manage them. |
| Keep Simlock's `capabilities.tunnel` off (the default; Tapdance never turns it on). | It reverses device ports to a lease holder's machine. |
| Keep Tapdance up to date on the host and the agent's machine. | Old versions miss fixes. Tapdance pins Simlock 0.6.0. |

## Tokens and where they live

| Token | Who has it | Stored at | If it leaks |
| --- | --- | --- | --- |
| Pairing token (`tdg_…`) | One agent's machine, for one host | `~/.tapdance/credentials.json` (mode 600) on the agent's machine, under the host's origin; only a hash on the host | The guard's device API on that host, within its policy and the token's scopes. Revoke it on the host: `tapdance worker guard revoke <id>`. |
| Simlock agent token (`slk_…`) | An agent's machine in gateway mode, or one talking to a worker directly | `~/.tapdance/credentials.json` (mode 600, bound to its endpoint), or `TAPDANCE_TOKEN` | Close to shell access on the host or on every worker of that gateway. Revoke it ([gateway mode](../deployment/gateway-mode.md)). |
| Operator and worker join tokens | You, and each joined worker | See [gateway mode](../deployment/gateway-mode.md) | See gateway mode. |
| Viewer key | One browser | URL fragment, then an `HttpOnly` cookie; dies with `tapdance view` | Control of that one leased device until the viewer stops. |
| MCP HTTP bearer | Remote MCP clients | `TAPDANCE_MCP_TOKEN`, or printed once at start | Acts as an agent through that MCP server. |

Rules Tapdance enforces:

- Config files never hold tokens. Loading a config with `token` or `operatorToken` in it fails, and
  `tapdance config set` refuses token-like keys. `tapdance connect` and `tapdance config set-token`
  (hidden input or stdin) store tokens; environment variables work too.
- A saved token is sent only to the origin it was saved for.
- Error messages, `tapdance report` and tool output (including saved output files) redact Simlock
  secrets (`slk_…`), pairing tokens (`tdg_…`), bearer headers, JWTs, private keys and viewer keys.
- The operator token is loaded only for fleet views (`tapdance workers list`, `doctor`); MCP tools and
  device commands never get it.
- MCP tools never return enrollment secrets, and there is no MCP tool for a shell on the host, `adb` or
  `simctl`. The only shell is `device_shell`, inside a leased Android emulator. Tapdance uses Simlock's
  `exec` internally for a fixed list of commands only (`device-commands.ts`).

**Never commit tokens.** That includes `.env` files, Terraform variable files and state, CI logs and
screenshots of terminals. If one leaks, revoke it on the host (`tapdance worker guard revoke <id>`) or
on the gateway.

## Devices and data

- Simlock leases only devices it created. Your own AVDs and Xcode simulators are never handed out.
- A released device is wiped. Installed apps and their data are gone.
- Artifacts (screenshots, recordings, logs) are written on the agent's machine under
  `artifacts.directory/<session>/`. They can contain whatever was on screen, including test account
  details; treat the directory as sensitive and keep it out of git.
- The viewer controls the leased device while it runs: anyone with its link who can reach its port can
  drive it ([browser viewer](../deployment/browser-access.md#how-the-link-is-protected)).

## Not covered yet

- An allow-list of apps a token may install (by bundle id or package): the guard sees an upload, not
  the app inside it.
- Per-request approval by the person (for example, approving an install in the viewer).
- Builds in a disposable VM. Host builds run as the hosting account.
- Mutual TLS, replay protection and short-lived per-session tokens. Transport security comes from
  Tailscale.
- OS and virtualization bugs. The guard's tests prove the API boundary only; a bug in the Simulator,
  the emulator, agent-device or the OS is outside it. A dedicated account limits the damage.
