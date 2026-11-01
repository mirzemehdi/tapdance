import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { TapdanceError, type ActionResult, type ElementTarget, type ScreenInspection, type SwipeDirection, type UiElement } from "@tapdance/core";

const run = promisify(execFile);

/**
 * iOS Simulator UI backend over AXe (github.com/cameroncooke/AXe, MIT, © 2025 Cameron Cooke; it
 * bundles Meta's IDB, MIT). AXe drives a simulator through CoreSimulator on the Mac that hosts it,
 * so this backend only works when Tapdance runs on that Mac (local mode). Every call names the leased
 * simulator's UDID; nothing here can target another simulator.
 *
 * AXe reads only Xcode's default device set (its `getSimulatorSet(deviceSetPath: nil)`), so the
 * worker must keep Simlock's simulators there: `simlock config set drivers.ios.deviceSet default`.
 */
export interface AxeNode {
  type?: string;
  role?: string;
  AXLabel?: string | null;
  AXValue?: string | null;
  AXUniqueId?: string | null;
  frame?: { x: number; y: number; width: number; height: number };
  enabled?: boolean;
  children?: AxeNode[];
}

export interface FlatAxeElement extends UiElement {
  center?: { x: number; y: number };
}

const UDID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

/** Flattens AXe's tree; refs are `@a<n>` in depth-first order and valid for the screen they came from. */
export function flattenAxe(nodes: AxeNode[]): FlatAxeElement[] {
  const out: FlatAxeElement[] = [];
  const walk = (node: AxeNode, depth: number) => {
    const el: FlatAxeElement = { ref: `@a${out.length + 1}`, role: (node.type ?? node.role ?? "element").toLowerCase(), depth };
    if (node.AXLabel) el.label = node.AXLabel;
    if (node.AXValue && node.AXValue !== node.AXLabel) el.value = node.AXValue;
    if (node.AXUniqueId) el.identifier = node.AXUniqueId;
    if (node.enabled === false) el.enabled = false;
    if (node.frame) {
      const f = node.frame;
      el.rect = { x: Math.round(f.x), y: Math.round(f.y), width: Math.round(f.width), height: Math.round(f.height) };
      el.center = { x: Math.round(f.x + f.width / 2), y: Math.round(f.y + f.height / 2) };
    }
    out.push(el);
    for (const child of node.children ?? []) walk(child, depth + 1);
  };
  for (const node of nodes) walk(node, 0);
  return out;
}

export class AxeBackend {
  constructor(readonly bin = "axe") {}

  private check(udid: string): void {
    if (!UDID.test(udid)) throw new TapdanceError("FORBIDDEN", "The lease names no simulator UDID AXe can target");
  }

  private async axe(args: string[], timeoutMs = 60_000): Promise<string> {
    try {
      const { stdout } = await run(this.bin, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
      return stdout;
    } catch (error) {
      const e = error as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
      if (e.code === "ENOENT") {
        throw new TapdanceError("PROVIDER_UNAVAILABLE", "AXe is not installed on this Mac", {
          hint: "Install it (`brew install cameroncooke/axe/axe`) or set ios.uiBackend to \"agent-device\".",
        });
      }
      const text = `${e.stderr ?? ""}${e.stdout ?? ""}`.trim() || e.message;
      if (/not found/i.test(text) && /simulator/i.test(text)) {
        throw new TapdanceError("PROVIDER_UNAVAILABLE", `AXe cannot see the leased simulator: ${firstLine(text)}`, {
          hint: "AXe only reads Xcode's default device set. On this worker run `tapdance worker install --ios-backend axe` (sets Simlock's drivers.ios.deviceSet to default), then lease again.",
        });
      }
      if (/no (matching )?element|could not find|no accessibility element/i.test(text)) {
        throw new TapdanceError("ELEMENT_NOT_FOUND", firstLine(text), { hint: "Inspect the screen and target an element by its exact label or id." });
      }
      throw new TapdanceError("DEVICE_ERROR", `axe ${args[0]} failed: ${firstLine(text)}`);
    }
  }

  async version(): Promise<string | undefined> {
    try {
      const { stdout } = await run(this.bin, ["--version"], { timeout: 10_000 });
      return stdout.trim();
    } catch {
      return undefined;
    }
  }

  async describe(udid: string): Promise<FlatAxeElement[]> {
    this.check(udid);
    const text = await this.axe(["describe-ui", "--udid", udid]);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new TapdanceError("DEVICE_ERROR", "AXe returned an unreadable accessibility tree");
    }
    return flattenAxe(Array.isArray(parsed) ? (parsed as AxeNode[]) : [parsed as AxeNode]);
  }

  async inspect(udid: string, interactiveOnly: boolean): Promise<ScreenInspection> {
    const all = await this.describe(udid);
    const interactive = /button|cell|field|switch|link|slider|tab|search|textview|picker|segmented|stepper|toggle/;
    const elements = (interactiveOnly ? all.filter((e) => interactive.test(e.role) || e.identifier) : all).map(({ center: _c, ...rest }) => rest);
    const root = all[0]?.rect;
    return {
      ...(root ? { viewport: { width: root.width, height: root.height } } : {}),
      elements,
      truncated: false,
      warnings: ["Refs (@a…) come from AXe and are valid until the screen changes; prefer text or id targets."],
    };
  }

  async tap(udid: string, target: ElementTarget): Promise<ActionResult> {
    this.check(udid);
    let args: string[];
    switch (target.kind) {
      case "text":
        args = ["tap", "--label", target.text];
        break;
      case "id":
        args = ["tap", "--id", target.id];
        break;
      case "point":
        args = ["tap", "-x", String(Math.round(target.x)), "-y", String(Math.round(target.y))];
        break;
      case "ref": {
        const el = (await this.describe(udid)).find((e) => e.ref === `@${target.ref.replace(/^@/, "")}`);
        if (!el?.center) throw new TapdanceError("ELEMENT_NOT_FOUND", `No element @${target.ref} on the current screen`, { hint: "Inspect again; refs change with the screen." });
        args = ["tap", "-x", String(el.center.x), "-y", String(el.center.y)];
        break;
      }
      case "selector":
        throw new TapdanceError("NOT_SUPPORTED", "The AXe backend takes text, id, ref or coordinates, not agent-device selectors");
    }
    await this.axe([...args, "--wait-timeout", "5", "--udid", udid]);
    return { ok: true, message: `Tapped ${args.slice(1, 3).join(" ")}` };
  }

  async swipe(
    udid: string,
    gesture: { kind: "direction"; direction: SwipeDirection } | { kind: "points"; from: { x: number; y: number }; to: { x: number; y: number } },
  ): Promise<ActionResult> {
    this.check(udid);
    if (gesture.kind === "points") {
      await this.axe(["swipe", "--start-x", String(gesture.from.x), "--start-y", String(gesture.from.y), "--end-x", String(gesture.to.x), "--end-y", String(gesture.to.y), "--udid", udid]);
      return { ok: true, message: "Swiped" };
    }
    // AXe's scroll presets name the content direction; Tapdance's swipe names the finger's.
    const preset: Record<SwipeDirection, string> = { up: "scroll-down", down: "scroll-up", left: "scroll-right", right: "scroll-left" };
    const root = (await this.describe(udid))[0]?.rect;
    await this.axe(["gesture", preset[gesture.direction], ...(root ? ["--screen-width", String(root.width), "--screen-height", String(root.height)] : []), "--udid", udid]);
    return { ok: true, message: `Swiped ${gesture.direction}` };
  }

  async type(udid: string, text: string, target?: ElementTarget): Promise<ActionResult> {
    this.check(udid);
    if (target) await this.tap(udid, target);
    // Text goes on stdin, never argv, so it cannot be read as an option.
    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.bin, ["type", "--stdin", "--udid", udid], { stdio: ["pipe", "ignore", "pipe"] });
      let err = "";
      child.stderr.on("data", (d: Buffer) => (err += d.toString()));
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve() : reject(new TapdanceError("DEVICE_ERROR", `axe type failed: ${firstLine(err)}`))));
      child.stdin.end(text);
    });
    return { ok: true, message: `Typed ${text.length} characters` };
  }

  async button(udid: string, button: "home" | "lock"): Promise<ActionResult> {
    this.check(udid);
    await this.axe(["button", button, "--udid", udid]);
    return { ok: true, message: `Pressed ${button}` };
  }

  async screenshot(udid: string, outPath: string): Promise<{ path: string }> {
    this.check(udid);
    await this.axe(["screenshot", "--output", outPath, "--udid", udid]);
    return { path: outPath };
  }

  /** Starts `axe record-video` detached; it records until SIGINT. Returns its pid. */
  startRecording(udid: string, outPath: string): { pid: number } {
    this.check(udid);
    const child = spawn(this.bin, ["record-video", "--udid", udid, "--output", outPath, "--fps", "15"], { detached: true, stdio: "ignore" });
    child.unref();
    if (!child.pid) throw new TapdanceError("DEVICE_ERROR", "Could not start axe record-video");
    return { pid: child.pid };
  }

  async stopRecording(pid: number, outPath: string, timeoutMs = 30_000): Promise<{ path: string }> {
    try {
      process.kill(pid, "SIGINT");
    } catch {
      throw new TapdanceError("DEVICE_ERROR", "The recording process is gone; the video may be incomplete");
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        if (!existsSync(outPath)) throw new TapdanceError("DEVICE_ERROR", "AXe stopped without writing the video");
        return { path: outPath };
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new TapdanceError("TIMEOUT", "AXe did not finish writing the video in 30 s");
  }
}

function firstLine(text: string): string {
  return (text.split("\n").find((l) => l.trim()) ?? text).slice(0, 300);
}
