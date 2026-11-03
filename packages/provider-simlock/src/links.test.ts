import { describe, expect, it } from "vitest";
import { parseAndroidLinkLog, parseIosLinkLog } from "./links.js";

describe("links an app asked the system to open (#60)", () => {
  it("reads iOS Launch Services: mailto with no handler, https opened in Safari", () => {
    const log = [
      "2026-11-03 02:04:54.204 Df lsd[47714:332c42] [com.apple.launchservices:open] pid 51681 requests to open URL with scheme mailto",
      "2026-11-03 02:04:54.207 Df lsd[47714:332c42] [com.apple.launchservices:open] ERROR: There is no registered handler for URL scheme mailto",
      "2026-11-03 02:04:54.207 E  Pianolune[51681:332098] [com.apple.launchservices:default] Failed to open URL mailto:team@measify.com?subject=Hello%20there: Error Domain=LSApplicationWorkspaceErrorDomain Code=115",
      "2026-11-03 02:06:21.138 Df lsd[47714:33473e] [com.apple.launchservices:open] pid 51681 requests to open URL with scheme https",
      "2026-11-03 02:06:21.227 Df lsd[47714:333b77] [com.apple.launchservices:default] Found application: com.apple.mobilesafari to handle url scheme: https",
    ].join("\n");
    expect(parseIosLinkLog(log)).toEqual([
      { time: "2026-11-03 02:04:54.204", scheme: "mailto", handled: false, by: "Pianolune", url: "mailto:team@measify.com?subject=Hello%20there", mail: { to: "team@measify.com", subject: "Hello there" } },
      { time: "2026-11-03 02:06:21.138", scheme: "https", handled: true, handler: "com.apple.mobilesafari" },
    ]);
  });

  it("reads Android activity starts and missing handlers", () => {
    const log = [
      "11-03 02:10:01.100  1000  1200 I ActivityTaskManager: START u0 {act=android.intent.action.SENDTO dat=mailto:xxxxxx flg=0x10000000 cmp=com.google.android.gm/.ComposeActivityGmail} from uid 10190",
      "11-03 02:10:05.300 10190 10190 E AndroidRuntime: android.content.ActivityNotFoundException: No Activity found to handle Intent { act=android.intent.action.VIEW dat=market://details?id=com.x }",
    ].join("\n");
    expect(parseAndroidLinkLog(log)).toEqual([
      { time: "11-03 02:10:01.100", scheme: "mailto", url: "mailto:xxxxxx", handled: true, by: "android.intent.action.SENDTO" },
      { time: "11-03 02:10:05.300", scheme: "market", url: "market://details?id=com.x", handled: false },
    ]);
  });
});
