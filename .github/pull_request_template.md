## What and why

<!-- What does this change, and why? Link the issue. -->

Closes #

**PRODUCT.md IDs:** <!-- e.g. M-02, E-04. Add a new ID in PRODUCT.md first if this is a new requirement. -->

## How it was tested

<!-- Commands you ran and what you saw. Say which tests are mocked. -->

- [ ] `pnpm build` passes
- [ ] `pnpm typecheck` passes
- [ ] `pnpm test` passes (unit)
- [ ] `pnpm test:integration` with `TAPDANCE_IT_PLATFORM=...` on real devices (only if device behaviour changed; say which platform and host)

## Checklist

- [ ] Tests that use `FakeProvider`, mocked transports or fake executables are labelled as mocked.
- [ ] Any claim that something works on a real device or real infrastructure has an evidence file in
      `docs/testing/evidence/` and is linked from STATUS.md.
- [ ] The STATUS.md row for each affected ID is updated (mark, notes, "Last updated" date).
- [ ] PRODUCT.md is updated if requirements changed (new IDs only; none reused or renumbered).
- [ ] Docs that show changed commands, flags, config keys, environment variables or MCP tools are
      updated, and match `--help`.
- [ ] No caller-supplied device ids; everything stays scoped to the session's lease.
- [ ] No raw shell, `adb` or `simctl` tool, and no command catalogue for external tools.
- [ ] No tokens or secrets in code, config, logs, fixtures, screenshots or evidence; new output that may
      carry secrets goes through `redactSecrets` / `redactObject`.
- [ ] New dependencies or external tools are pinned to exact versions, license-checked, and listed in
      NOTICE.md.
- [ ] CHANGELOG.md has an entry under the unreleased version (if user-visible).
