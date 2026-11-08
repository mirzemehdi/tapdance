# Releasing Tapdance to npm

Tapdance is published as one npm package, **`tapdance-cli`**, whose command is `tapdance`. The name
`tapdance` on npm belongs to an unrelated package, and the `@tapdance` scope is not ours.

## What the package contains

`scripts/pack-npm.mjs` builds it from the workspace:

- the CLI's `dist/`;
- the four other workspace packages (`@tapdance/core`, `@tapdance/provider-simlock`, `@tapdance/sdk`,
  `@tapdance/mcp`), which are not published on their own;
- Simlock 0.5.0 and agent-device 0.21.35 with the same patches pnpm applies in the workspace
  (`patches/`). A plain npm install of those packages would get the unpatched releases, so they travel
  inside the package as bundled dependencies, together with their own dependencies. Each patched copy's
  `package.json` names its patch in a `tapdancePatch` field.

The packed `tapdance-cli-0.1.0.tgz` was about 9 MB, 36 MB unpacked. The script never publishes.

## Try it locally

```bash
pnpm build
node scripts/pack-npm.mjs
npm install -g --prefix /tmp/tapdance-try "$PWD/dist-npm/tapdance-cli-0.1.0.tgz"
/tmp/tapdance-try/bin/tapdance --version
```

Pass the tarball as an absolute path: npm reads a relative `dist-npm/…` path as a GitHub repository.
Use a scratch `TAPDANCE_HOME` for anything beyond `--help`.

## Release a version

1. Set the same version in all five `packages/*/package.json` files, add the release to
   `CHANGELOG.md`, and merge that to `main`.
2. Tag the merge commit and push the tag:

   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```

3. The [release workflow](../.github/workflows/release.yml) runs on macOS: install, typecheck, tests,
   `docs:check`, pack, a smoke test of the packed package (`--version`, the bundled Simlock, an exit
   code), then `npm publish` with provenance. It refuses a tag that does not match the package version.

To build and pack without publishing, run the workflow by hand from the Actions tab with **publish**
off. The tarball is attached to the run as an artifact.

## First-time setup on npm

The workflow publishes through npm's trusted publishing: GitHub Actions proves who it is, and no npm
token is stored in the repository.

1. Create an npm account with two-factor authentication, if you have none.
2. **First publish.** If npm lets you add a trusted publisher for a package that does not exist yet,
   do that (step 3) and skip this step. Otherwise, create a granular access token on npmjs.com that can
   publish new packages, save it as the repository secret `NPM_TOKEN`, and push the first tag. The
   workflow uses the token when the secret is set.
3. **Trusted publisher.** On npmjs.com, open `tapdance-cli` › Settings › Trusted publishing and add
   GitHub Actions: repository `mirzemehdi/tapdance`, workflow `release.yml`.
4. Delete the `NPM_TOKEN` secret and revoke the token. Later releases need only the tag.

## Not covered yet

- `scripts/host-setup.sh` still installs Tapdance from source on a host. Switching it to the npm
  package is a separate change.
- The README and the guides still show the install from source until the first version is on npm.
