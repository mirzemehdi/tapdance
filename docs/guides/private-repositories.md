# Private repositories for host builds

How a host (your Mac, a Linux machine, a [Google Cloud N2 VM](../deployment/google-cloud-n2.md)) builds
an app whose code is private, and what each way leaves on the host. Read [host builds](host-builds.md)
first: builds are off by default, and a build runs the repository's own scripts on the host.

> Proven: a fine-grained, read-only token with `--git-auth gh` cloned a private repository over
> `https://` on a Google Cloud N2 VM, and its Android build succeeded through the CLI and MCP
> ([evidence](../testing/evidence/2026-11-03-gcp-n2-android.md)). Not proven: a build through a deploy
> key. `host builds key --repo` ran on a rented Mac and printed the key, but the organization had deploy
> keys turned off, so the key was never used
> ([evidence](../testing/evidence/2026-11-07-two-hosts-android-ios.md)). Unit-tested only: build files.

## Pick a way

| Way | Best for | What it reaches | What the host keeps |
| --- | --- | --- | --- |
| **A fine-grained, read-only GitHub token** with `--git-auth gh` (recommended on a cloud VM) | Several repositories, GitHub submodules | The repositories you select, read-only, over `https://` | The token, in the `gh` config of the hosting account |
| **A deploy key per repository** (`host builds key --repo`) | One or two repositories; git servers other than GitHub; not when the organization has turned deploy keys off | One repository, read-only, over ssh | One ssh private key per repository |
| **No repository access:** build elsewhere, then `tapdance app install` | Code or secrets that should never be on the host | Nothing | Nothing but the apps you install |

The third way is often the best one: build in CI or on the agent's machine and install the app. See
[build in CI, test with Tapdance](ci-builds.md).

**Whatever the host keeps, every build can read.** A build runs the repository's Gradle or Xcode
scripts as the hosting account, so a build of any allow-listed repository can read the token, every
deploy key, every build file and `~/.gradle/gradle.properties`. Allow only repositories you trust, and
use `--protected-ref main` so only reviewed commits are built.

## A fine-grained GitHub token

**What you need:** a GitHub account or organization that owns the repositories, and the
[GitHub CLI](https://cli.github.com/) on the host. `host-setup.sh --with-gh` installs it; otherwise
Ubuntu: `sudo apt-get install -y gh`, macOS: `brew install gh`.

**Steps:**

1. On GitHub: **Settings › Developer settings › Personal access tokens › Fine-grained tokens ›
   Generate new token**.
2. **Resource owner:** the account or organization that owns the repositories. An organization may have
   to approve the token.
3. **Expiration:** set one, for example 30 or 90 days. When it expires, builds fail with the sign-in
   hint below until you add a new token.
4. **Repository access:** *Only select repositories*. Pick the app's repository and any private
   repositories it pulls in as submodules.
5. **Permissions › Repository permissions:** *Contents: Read-only*. *Metadata: Read-only* is added for
   you. Add *Actions: Read-only* if the same host should also [install your CI's
   APKs](ci-builds.md#let-the-host-fetch-the-artifact). Nothing else. One token can serve both; it must
   select every repository it is used for, including the one whose workflow makes the artifact.
6. Generate it and copy it.
7. On the host, as the account that runs the guard, log `gh` in. `host gh-login` reads the token with
   echo off and passes it to `gh auth login`:

   ```bash
   tapdance host gh-login
   gh auth status
   ```

8. Allow the repository:

   ```bash
   tapdance host builds enable --repo https://github.com/acme/app --git-auth gh --protected-ref main
   ```

**Check it worked:** `host builds enable` checks that git reaches each `--repo` the way builds do
(`git ls-remote <url> HEAD` with the `gh` credential helper) and prints a warning with the fix when it
cannot, for example when the token does not cover that repository. It is a warning, not a refusal; `--no-check` skips it, and
`tapdance host builds status --check` runs it again for every repository on the list.

- Use `https://` URLs, both in `host builds enable` and in the agent's `tapdance app build --git`. The
  allow-list compares URLs as written, so `https://github.com/acme/app` and
  `git@github.com:acme/app.git` are different entries.
- `--git-auth` applies to every repository on the allow-list. A `host builds enable` without it keeps
  the current setting (`none` until you set one).
- **Submodules** on GitHub that the token covers are fetched, also when `.gitmodules` lists them with
  ssh URLs (`git@github.com:…`): with `--git-auth gh` the submodule step fetches github.com over https,
  where `gh` signs in (unit-tested only). Others (other hosts, repositories the token does not cover)
  are skipped with "warning: some submodules could not be fetched"; the build goes on and fails only if
  it needed them.
- On a server without a keyring, `gh` keeps the token in `~/.config/gh/hosts.yml` of the hosting
  account.
- **The app's toolchain must be on the host too.** Gradle does not download every SDK component: the
  tested app needed CMake 3.31.6, and the build stopped with a hint naming
  `sdkmanager "cmake;3.31.6"` for the host's owner to run (6 s); the next build succeeded.

## A deploy key per repository

Not proven: no build has run through a deploy key yet (see the status note at the top).

GitHub accepts a deploy key on one repository only, so each repository gets its own key. An
organization can turn deploy keys off for all its repositories; GitHub then answers "Deploy keys are
disabled for this repository" when you add one. Use a fine-grained token there.

```bash
tapdance host builds key --repo git@github.com:acme/app.git
```

It creates an ed25519 key under `~/.tapdance/worker/builds/keys/` (private half mode 600) and prints the
public half, its fingerprint and the page to add it on (GitHub: the repository's **Settings › Deploy
keys › Add deploy key**; leave *Allow write access* off). The output names the repository as you typed
it; only the key's folder name is lower-case. Running it again prints the same key. Then:

```bash
tapdance host builds enable --repo git@github.com:acme/app.git --protected-ref main
```

`enable` checks the key works (`git ls-remote` with that key only). If GitHub refuses it, the warning
names the key's fingerprint and what to check: that the key is added to this repository, and that the
organization allows deploy keys (**organization Settings › Member privileges › Deploy keys**).

The agent builds with the same ssh URL: `tapdance app build --git git@github.com:acme/app.git --ref main`.
That repository's builds use its own key whatever `--git-auth` says, and git is given only that key,
never the account's own keys or ssh agent. Submodules in other repositories cannot use it; they are
skipped with a warning, as above.

A deploy key works over ssh only. `tapdance host builds status` shows which key each repository
uses, and `not used (https)` next to an https URL of a repository that has a key: an https clone signs
in with `gh` or not at all.

`tapdance host builds key` without `--repo` creates one shared key for `--git-auth deploy-key`; since
GitHub refuses a deploy key on a second repository, prefer `--repo`.

To take a key away: `tapdance host builds key --repo git@github.com:acme/app.git --remove` deletes it on
the host and prints its fingerprint; delete the entry with that fingerprint on the repository's deploy
keys page too. `tapdance host builds disable --repo <url>` takes one URL off the allow-list and leaves
builds on for the others.

## Build files

Many apps need files that are kept out of git: `google-services.json`, `local.properties`, `.env`.
Build files are the host owner's copies of them. Before each build of a repository the host copies them
into the checkout, and after the build it removes them again.

```bash
tapdance host builds files add --repo https://github.com/acme/app androidApp/google-services.json --from ./google-services.json
tapdance host builds files add --repo https://github.com/acme/app .env < ./app.env
tapdance host builds files list
tapdance host builds files remove --repo https://github.com/acme/app .env
```

- **Owner only.** They live under `~/.tapdance/worker/builds/files/` (folders 700, files 600). Only
  these commands, run on the host, add or remove them. No guard route or MCP tool reads or writes them,
  so an agent cannot see their content through Tapdance; `list` shows the path, size and the start of
  the sha256, never the content.
- **Only for the build.** They are copied in after checkout and removed after the build, and also before
  the next build if one died half way. The build log says `using host build file <path> (sha256 …)`,
  never the content.
- **The https and ssh URL of one repository share its build files.** Changing a file makes the next
  build of that commit build again instead of reusing an earlier build. No guard restart is needed.
- **Limits:** 1 MB per file, 50 files per repository.
- **Refused paths:** absolute paths, `~`, `..`, backslashes, empty or `.` parts, anything in a `.git`
  folder and `.gitmodules`, characters other than letters, digits, space and `_ . + @ , = -`, and paths
  over 300 characters. At build time, a file whose place in the checkout is a symlink or a folder, or
  whose folder is a symlink that leads outside the checkout, is not copied and the build stops
  (`FORBIDDEN`).
- **Not hidden from the build.** The repository's scripts can read a build file while the build runs.
  A script that prints one puts it in the build log, which streams to the agent (known token formats
  are redacted, other secrets are not). Protected refs keep unreviewed scripts out.

## Private Gradle registries

Put the registry's credentials in the hosting account's `~/.gradle/gradle.properties` (mode 600), under
the property names the project's build reads them from. Builds on the host use that account's Gradle
home, so Gradle finds them there. Use a read-only credential.

## If the host is compromised

What an attacker who gets the hosting account learns, per way:

| What the host keeps | What leaks | What to do |
| --- | --- | --- |
| A fine-grained token | Read access to the selected repositories until the token expires or you revoke it | Revoke it on GitHub (**Settings › Developer settings**). |
| A deploy key | Read access to that one repository | Delete the key on the repository's deploy keys page. |
| Build files | Their content (Firebase config, API keys in `.env`) | Rotate the keys they hold. |
| `~/.gradle/gradle.properties` | The registry credentials | Revoke and replace them. |
| The build cache (`~/.tapdance/worker/builds/`) | A clone of each repository the host built, and the last builds | Treat the source as read. |
| No repository access | Only the apps you installed | Nothing about your source. |

The agent's machine holds only the pairing token. With it, an attacker can ask for a build of an
allow-listed repository at an allowed ref, but cannot read the GitHub token, keys or build files through
the guard. See the [threat model](../security/threat-model.md).

## When a build cannot sign in

A failed clone or fetch that looks like a sign-in failure ("Permission denied (publickey)", "Repository
not found", "could not read Username", "Authentication failed") stops with `AUTH_FAILED` (exit 5;
`details.reason: "GIT_AUTH"` in JSON and MCP replies), not `DEVICE_ERROR`. The error shows git's own
line, and the hint fits the auth the host used:

- **A deploy key** (the repository's own, or the shared one): it names the key's fingerprint and asks
  whether the key is added to this repository and whether the organization allows deploy keys.
- **gh over https:** the token gh uses on the host does not reach this repository.
- **An https URL next to a deploy key:** a deploy key works over ssh only; build with the ssh URL.
- **ssh without a key:** create one with `tapdance host builds key --repo <url>`, or use a token.

Only the host's owner can fix it; an agent should ask instead of retrying. More in
[troubleshooting](../troubleshooting.md#builds-on-the-host).
