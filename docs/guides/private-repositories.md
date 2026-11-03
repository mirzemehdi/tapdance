# Private repositories for builds on the host

How a device host (your Mac, a Linux machine, a [Google Cloud N2 VM](../deployment/google-cloud-n2.md))
builds an app whose code is private, and what each way leaves on the host. Read
[builds on the host](../deployment/one-command-host.md#builds-on-the-host) first: builds are off by
default, and a build runs the repository's own scripts on the host.

> **Status: unit-tested only.** Builds on the host have run once on a real repository, on the owner's
> Mac. The per-repository deploy key, build files and the sign-in hint below are tested with a fake git,
> Xcode and Gradle; none has run against a real private repository yet. See [STATUS.md](../../STATUS.md).

## Pick one

| Way | Best for | What it reaches | What the host keeps |
| --- | --- | --- | --- |
| **A fine-grained, read-only GitHub token** with `--git-auth gh` (recommended on a cloud VM) | Several repositories, GitHub submodules | The repositories you select, read-only, over `https://` | The token, in the `gh` config of the hosting account |
| **A deploy key per repository** (`host builds key --repo`) | One or two repositories; git servers other than GitHub | One repository, read-only, over ssh | One ssh private key per repository |
| **No repository access:** build elsewhere, then `tapdance app install` | Code or secrets that should never be on the host | Nothing | Nothing but the apps you install |

The third way is often the best one: build in CI or on the agent's machine and install the APK. See
[build in CI, test with Tapdance](ci-builds.md).

**Whatever the host keeps, every build can read.** A build runs the repository's Gradle or Xcode
scripts as the hosting account, so a build of any allow-listed repository can read the token, every
deploy key, every build file and `~/.gradle/gradle.properties`. Allow only repositories you trust, and
use `--protected-ref main` so only reviewed commits are built.

## A fine-grained GitHub token

1. On GitHub: **Settings › Developer settings › Personal access tokens › Fine-grained tokens ›
   Generate new token**.
2. **Resource owner:** the account or organization that owns the repositories. An organization may have
   to approve the token.
3. **Expiration:** set one, for example 30 or 90 days. When it expires, builds fail with the sign-in
   hint below until you add a new token.
4. **Repository access:** *Only select repositories*. Pick the app's repository and any private
   repositories it pulls in as submodules.
5. **Permissions › Repository permissions:** *Contents: Read-only*. *Metadata: Read-only* is added for
   you. Nothing else.
6. Generate it and copy it.

On the host, as the account that runs the guard. Install the [GitHub CLI](https://cli.github.com/) if
it is missing (Ubuntu: `sudo apt-get install -y gh`; macOS: `brew install gh`), then:

```bash
read -rsp "GitHub token: " t && echo && printf '%s' "$t" | gh auth login --with-token; unset t
gh auth status

# check that git reaches the repository the way builds do
git -c credential.helper= -c 'credential.helper=!gh auth git-credential' ls-remote https://github.com/acme/app HEAD

tapdance host builds enable --repo https://github.com/acme/app --git-auth gh --protected-ref main
```

- Use `https://` URLs, both in `host builds enable` and in the agent's `tapdance app build --git`. The
  allow-list compares URLs as written, so `https://github.com/acme/app` and
  `git@github.com:acme/app.git` are different entries.
- `--git-auth` applies to every repository on the allow-list, and each `host builds enable` sets it
  (the default is `none`). Pass `--git-auth gh` every time you add a repository.
- **Submodules** on `https://github.com/…` that the token covers are fetched. Others (ssh URLs, other
  hosts, repositories the token does not cover) are skipped with "warning: some submodules could not be
  fetched"; the build goes on and fails only if it needed them.
- On a server without a keyring, `gh` keeps the token in `~/.config/gh/hosts.yml` of the hosting
  account.

## A deploy key per repository

GitHub accepts a deploy key on one repository only, so each repository gets its own key.

```bash
tapdance host builds key --repo git@github.com:acme/app.git
```

It creates an ed25519 key under `~/.tapdance/worker/builds/keys/` (private half mode 600) and prints the
public half with the page to add it on (GitHub: the repository's **Settings › Deploy keys › Add deploy
key**; leave *Allow write access* off). Running it again prints the same key. Then:

```bash
tapdance host builds enable --repo git@github.com:acme/app.git --protected-ref main
```

The agent builds with the same ssh URL: `tapdance app build --git git@github.com:acme/app.git --ref main`.
That repository's builds use its own key whatever `--git-auth` says, and git is given only that key,
never the account's own keys or ssh agent. Submodules in other repositories cannot use it; they are
skipped with a warning, as above.

`tapdance host builds key` without `--repo` creates one shared key for `--git-auth deploy-key`; since
GitHub refuses a deploy key on a second repository, prefer `--repo`. `tapdance host builds status`
shows which key each repository uses. To take a key away, delete it on the repository's deploy keys
page.

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

The agent's machine holds only the guard token. With it, an attacker can ask for a build of an
allow-listed repository at an allowed ref, but cannot read the token, keys or build files through the
guard. See the [threat model](../security/threat-model.md).

## When a build cannot sign in

A failed clone or fetch that looks like a sign-in failure ("Permission denied (publickey)", "Repository
not found", "could not read Username", "Authentication failed") stops with a hint that starts "This host
could not sign in to …" and names the three ways above. Only the host's owner can fix it; an agent
should ask instead of retrying. More in [troubleshooting](../troubleshooting.md#builds-on-the-host).
