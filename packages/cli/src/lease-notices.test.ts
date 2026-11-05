import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Tapdance, type CallOptions, type LeaseHandle, type LeaseRequest } from "@tapdance/sdk";
import { FakeProvider } from "../../sdk/src/testing.js";
import { selfTestLease } from "./commands-host.js";
import { leaseWithNotices } from "./context.js";

/**
 * MOCKED provider (a FakeProvider subclass): proves when the CLI prints a lease's notices, not how a
 * real device settles. The fake lease ends like an Android one after the change for field run 2d: a
 * settle line, the busy notice as soon as the settle wait ends, then the rest of the lease (the
 * snapshot-helper warm-up) with a progress line, then the handle with the same notice.
 */
const NOTICE = "The device is still busy with its start-up work after 5 s (guest CPU 96 %)";

class NoticeProvider extends FakeProvider {
  constructor(private readonly early: boolean) {
    super();
  }
  override async lease(sessionId: string, request: LeaseRequest, options: CallOptions = {}): Promise<LeaseHandle> {
    options.onProgress?.("Waiting for the device to settle (guest CPU 96 %; 2 s, at most 15 s)");
    if (this.early) options.onNotice?.(NOTICE);
    options.onProgress?.("Still reading the screen once so the first inspect is quick (5 s more, at most 15 s in all)");
    return { ...(await super.lease(sessionId, request)), notices: [NOTICE] };
  }
}

async function setup(early: boolean) {
  const lines: string[] = [];
  const home = await mkdtemp(join(tmpdir(), "td-notice-"));
  const cwd = await mkdtemp(join(tmpdir(), "td-notice-proj-"));
  const t = await Tapdance.create({ cwd, env: { TAPDANCE_HOME: home }, session: { id: "n1", source: "test" }, provider: new NoticeProvider(early), onProgress: (m) => lines.push(`› ${m}`) });
  const out = { progress: (m: string) => lines.push(`› ${m}`), warn: (m: string) => lines.push(`warning: ${m}`) };
  return { t, out, lines, cwd };
}

describe("lease notices in CLI output (field run 2d; MOCKED provider)", () => {
  it("device lease prints the notice when the provider knows it, before the rest of the lease, and once", async () => {
    const { t, out, lines } = await setup(true);
    const result = await leaseWithNotices(t, { platform: "android" }, out);
    expect(result.notices).toEqual([NOTICE]);
    expect(lines).toEqual([
      "› Waiting for the device to settle (guest CPU 96 %; 2 s, at most 15 s)",
      `warning: ${NOTICE}`,
      "› Still reading the screen once so the first inspect is quick (5 s more, at most 15 s in all)",
    ]);
    await t.close();
  });

  it("still prints notices a provider only returns with the handle", async () => {
    const { t, out, lines } = await setup(false);
    await leaseWithNotices(t, { platform: "android" }, out);
    expect(lines.filter((l) => l.startsWith("warning:"))).toEqual([`warning: ${NOTICE}`]);
    expect(lines.at(-1)).toBe(`warning: ${NOTICE}`);
    await t.close();
  });

  it("host up's self-test prints the lease notices instead of dropping them", async () => {
    const { t, out, lines, cwd } = await setup(true);
    await selfTestLease(t, "android", cwd, out);
    expect(lines).toEqual([
      "› Leasing an android device through the guard (the first boot can take minutes)",
      "› Waiting for the device to settle (guest CPU 96 %; 2 s, at most 15 s)",
      `warning: ${NOTICE}`,
      "› Still reading the screen once so the first inspect is quick (5 s more, at most 15 s in all)",
      "› Taking a screenshot through the guard",
    ]);
    // The self-test released its lease.
    await expect(t.status()).rejects.toMatchObject({ code: "NO_ACTIVE_LEASE" });
    await t.close();
  });
});
