/**
 * Links an app asked the system to open (#60): `mailto:` with no Mail app, App Store and Settings deep
 * links, web pages. The system's own log says what was asked and whether anything opened it, so an
 * agent can check "Contact us opens a mail to team@…" on a simulator that has no Mail app.
 */

export interface OpenedLink {
  time: string;
  /** The process that asked, when the log names it. */
  by?: string;
  scheme: string;
  /** The whole URL, when the log has it (the asking app logs it when the open fails). */
  url?: string;
  /** false: no app handles it (no Mail app on a simulator); true: an app was opened; unknown otherwise. */
  handled?: boolean;
  /** The app that took it, e.g. com.apple.mobilesafari. */
  handler?: string;
  /** For mailto: the address, subject and body, when the URL is known. */
  mail?: { to: string; subject?: string; body?: string };
}

const TIME = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+)/;

function mailOf(url: string): OpenedLink["mail"] | undefined {
  if (!url.toLowerCase().startsWith("mailto:")) return undefined;
  const [to, query] = url.slice(7).split("?", 2) as [string, string | undefined];
  const params = new URLSearchParams(query ?? "");
  const decode = (v: string) => {
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  };
  return { to: decode(to), ...(params.get("subject") ? { subject: params.get("subject")! } : {}), ...(params.get("body") ? { body: params.get("body")! } : {}) };
}

/** iOS: Launch Services' compact log lines (log show --style compact). */
export function parseIosLinkLog(text: string): OpenedLink[] {
  const links: OpenedLink[] = [];
  for (const line of text.split("\n")) {
    const time = TIME.exec(line)?.[1];
    if (!time) continue;
    const asked = /requests to open URL with scheme (\S+)/.exec(line);
    if (asked) {
      links.push({ time, scheme: asked[1]!.toLowerCase() });
      continue;
    }
    const found = /Found application: (\S+) to handle url scheme: (\S+)/.exec(line);
    if (found) {
      const open = [...links].reverse().find((l) => l.scheme === found[2]!.toLowerCase() && l.handled === undefined);
      if (open) Object.assign(open, { handled: true, handler: found[1]! });
      continue;
    }
    const none = /no registered handler for URL scheme (\S+)/.exec(line);
    if (none) {
      const open = [...links].reverse().find((l) => l.scheme === none[1]!.toLowerCase() && l.handled === undefined);
      if (open) open.handled = false;
      continue;
    }
    const failed = /\s([A-Za-z0-9_.-]+)\[\d+:[0-9a-f]+\] .*Failed to open URL (\S+?):? Error/.exec(line);
    if (failed) {
      const url = failed[2]!;
      const scheme = url.split(":")[0]!.toLowerCase();
      const open = [...links].reverse().find((l) => l.scheme === scheme && l.url === undefined);
      const entry = open ?? { time, scheme };
      Object.assign(entry, { by: failed[1]!.trim(), url, handled: false, ...(mailOf(url) ? { mail: mailOf(url) } : {}) });
      if (!open) links.push(entry);
      continue;
    }
    const opened = /(?:Opened|Opening|open) (?:URL|application for URL) ['"]?([a-z][a-z0-9+.-]*:[^\s'"]+)/i.exec(line);
    if (opened) {
      const url = opened[1]!;
      const scheme = url.split(":")[0]!.toLowerCase();
      const open = [...links].reverse().find((l) => l.scheme === scheme && l.url === undefined);
      if (open) Object.assign(open, { url, ...(mailOf(url) ? { mail: mailOf(url) } : {}) });
    }
  }
  return links;
}

/** Android: activity starts with a data URI (logcat threadtime), plus "No Activity found" failures. */
export function parseAndroidLinkLog(text: string): OpenedLink[] {
  const links: OpenedLink[] = [];
  for (const line of text.split("\n")) {
    const start = /^(\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+).*ActivityTaskManager: START u\d+ \{(?:act=(\S+) )?.*?dat=(\S+?)[ }]/.exec(line);
    if (start) {
      const url = start[3]!;
      const scheme = url.split(":")[0]!.toLowerCase();
      // Android masks most of a data URI in logcat (mailto:xxxxx); keep what it shows.
      links.push({ time: start[1]!, scheme, url, handled: true, ...(start[2] ? { by: start[2] } : {}) });
      continue;
    }
    const missing = /^(\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+).*No Activity found to handle Intent \{.*?dat=(\S+?)[ }]/.exec(line);
    if (missing) {
      const url = missing[2]!;
      links.push({ time: missing[1]!, scheme: url.split(":")[0]!.toLowerCase(), url, handled: false });
    }
  }
  return links;
}
