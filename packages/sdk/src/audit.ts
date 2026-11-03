import type { ScreenInspection, UiElement } from "@tapdance/core";

/**
 * An accessibility audit of the screen as assistive technology sees it (#60): what VoiceOver or
 * TalkBack would trip over, read from the accessibility tree. The iOS simulator cannot run VoiceOver,
 * so this is how an agent checks "every control is announced" there; on Android it complements
 * TalkBack. It cannot judge colour contrast or clipped text (those need the pixels).
 */

export type AuditRule = "unlabelled-control" | "small-target" | "duplicate-label" | "unlabelled-image";

export interface AuditFinding {
  rule: AuditRule;
  severity: "error" | "warning" | "info";
  ref: string;
  role: string;
  label?: string;
  identifier?: string;
  rect?: { x: number; y: number; width: number; height: number };
  detail: string;
}

export interface AuditReport {
  app?: string;
  checked: number;
  findings: AuditFinding[];
  counts: Record<AuditRule, number>;
  /** Controls cut off by an edge or covered by a bar: not judged, since only part of them is read (#69). */
  partlyHidden: string[];
}

const CONTROL = /^(button|cell|link|switch|toggle|checkbox|check-box|radio|radio-button|slider|tab|menu-?item|text-?field|text-?view|search|search-?field|secure-?text-?field|combo-?box|image-?button|stepper|segmented)/i;
const IMAGE = /^(image|img|icon)$/i;
/** Minimum touch target: Apple's 44 pt; Android's 48 dp. */
const IOS_MIN_PT = 44;
const ANDROID_MIN_DP = 48;
/** Containers that cut their content at their top and bottom edge. */
const SCROLLER = /^(.*scroll.*|recycler-?view|list(-?view)?|table(-?view)?|collection(-?view)?|.*pager)$/i;
/** Bars that content scrolls under (UIKit, Android views; Compose bars are found by shape below). */
const BAR = /tab-?bar|navigation-?bar|nav-?bar|tool-?bar|app-?bar|action-?bar|bottom-?nav|tab-?layout/i;
const BAR_ID = /tab_?bar|bottom_?(nav|bar)|tool_?bar|app_?bar|top_?bar|nav_?bar/i;

type Rect = { x: number; y: number; width: number; height: number };

/** Each element's parent index from the depth-ordered list (-1 for a root or when depth is missing). */
function parents(elements: UiElement[]): number[] {
  const stack: number[] = [];
  return elements.map((e, i) => {
    if (e.depth === undefined) return -1;
    while (stack.length && (elements[stack.at(-1)!]!.depth ?? 0) >= e.depth) stack.pop();
    const parent = stack.at(-1) ?? -1;
    stack.push(i);
    return parent;
  });
}

/**
 * Controls only partly on screen (#69): the accessibility tree reports what is visible of them (often
 * with no label), so their size and label say nothing about the control. A control counts as partly
 * hidden when it
 * - touches the top or bottom of the screen;
 * - is covered by a bar: a tab, navigation or tool bar, or a row of two or more controls side by side
 *   in the bottom fifth of the screen (a Compose or SwiftUI tab bar has no bar of its own in the tree);
 * - touches the edge of its scroll container or of a bar and looks cut (shorter than the rows like
 *   it, or under the minimum size);
 * - is the first or last of three or more rows alike and clearly shorter than them.
 */
function partlyHidden(elements: UiElement[], candidates: Set<UiElement>, vp: { width: number; height: number } | undefined, tol: number, minPx: number): Set<UiElement> {
  const hidden = new Set<UiElement>();
  const parent = parents(elements);
  const index = new Map(elements.map((e, i) => [e, i] as const));
  const ancestorOf = (a: UiElement, b: UiElement) => {
    for (let p = parent[index.get(b)!]!; p >= 0; p = parent[p]!) if (elements[p] === a) return true;
    return false;
  };
  const contains = (o: Rect, r: Rect) => r.x >= o.x - tol && r.y >= o.y - tol && r.x + r.width <= o.x + o.width + tol && r.y + r.height <= o.y + o.height + tol;
  const related = (a: UiElement, b: UiElement) => (a.depth !== undefined && b.depth !== undefined ? ancestorOf(a, b) || ancestorOf(b, a) : contains(a.rect!, b.rect!) || contains(b.rect!, a.rect!));
  const bottom = (r: Rect) => r.y + r.height;

  // Bars: by role or id, and the Compose/SwiftUI tab row by shape.
  const bars: Array<{ rect: Rect; members: Set<UiElement> }> = elements
    .filter((e) => e.rect && (BAR.test(e.role) || BAR_ID.test(e.identifier ?? "")))
    .map((e) => ({ rect: e.rect!, members: new Set([e]) }));
  if (vp) {
    const low = [...candidates].filter((e) => e.rect!.y >= vp.height * 0.8 && e.rect!.height < vp.height * 0.2);
    for (const e of low) {
      const row = low.filter((o) => Math.abs(o.rect!.y - e.rect!.y) <= 2 * tol);
      const sideBySide = row.every((a) => row.every((b) => a === b || a.rect!.x + a.rect!.width <= b.rect!.x + tol || b.rect!.x + b.rect!.width <= a.rect!.x + tol));
      if (row.length < 2 || !sideBySide || bars.some((b) => b.members.has(e))) continue;
      const top = Math.min(...row.map((o) => o.rect!.y));
      bars.push({ rect: { x: 0, y: top, width: vp.width, height: Math.max(...row.map((o) => bottom(o.rect!))) - top }, members: new Set(row) });
    }
  }
  const lines = [
    ...elements.filter((e) => e.rect && SCROLLER.test(e.role)).map((e) => ({ owner: e, ys: [e.rect!.y, bottom(e.rect!)] })),
    ...bars.map((b) => ({ owner: undefined as UiElement | undefined, ys: [b.rect.y, bottom(b.rect)] })),
  ];

  // Rows alike: same role, left edge and width.
  const groupOf = (e: UiElement) => `${e.role.toLowerCase()}|${Math.round(e.rect!.x / (4 * tol))}|${Math.round(e.rect!.width / (4 * tol))}`;
  const groups = new Map<string, UiElement[]>();
  for (const e of candidates) groups.set(groupOf(e), [...(groups.get(groupOf(e)) ?? []), e]);
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

  for (const e of candidates) {
    const r = e.rect!;
    if (bars.some((b) => b.members.has(e))) continue;
    if (vp && (r.y <= 0 || bottom(r) >= vp.height - 1)) {
      hidden.add(e);
      continue;
    }
    // Covered by a bar it is not part of.
    if (bars.some((b) => ![...b.members].some((m) => m === e || related(m, e)) && r.x < b.rect.x + b.rect.width && b.rect.x < r.x + r.width && Math.min(bottom(r), bottom(b.rect)) - Math.max(r.y, b.rect.y) > tol)) {
      hidden.add(e);
      continue;
    }
    const alike = (groups.get(groupOf(e)) ?? []).filter((o) => o.rect!.y > 0 && (!vp || bottom(o.rect!) < vp.height - 1));
    const typical = alike.length >= 3 ? median(alike.map((o) => o.rect!.height)) : undefined;
    const short = typical !== undefined && r.height < typical * 0.9;
    const outermost = alike.length >= 3 && (r.y <= Math.min(...alike.map((o) => o.rect!.y)) || bottom(r) >= Math.max(...alike.map((o) => bottom(o.rect!))));
    if (short && outermost) {
      hidden.add(e);
      continue;
    }
    const atLine = lines.some((l) => l.owner !== e && (!l.owner || related(l.owner, e)) && l.ys.some((y) => Math.abs(r.y - y) <= tol || Math.abs(bottom(r) - y) <= tol));
    if (atLine && (short || r.height < minPx)) hidden.add(e);
  }
  return hidden;
}

/** The labels an element's children give it (a Compose button whose text is a child is announced by it). */
function descendantLabel(elements: UiElement[], index: number): string | undefined {
  const depth = elements[index]!.depth;
  if (depth === undefined) return undefined;
  for (const e of elements.slice(index + 1)) {
    if ((e.depth ?? depth) <= depth) break;
    if (e.label?.trim()) return e.label;
  }
  return undefined;
}

export function auditScreen(screen: ScreenInspection, platform: "ios" | "android"): AuditReport {
  const elements = screen.elements;
  // Android rects are pixels; a phone is about 411 dp wide (Pixel 7: 1080 px at 2.625). Sizes are
  // compared in whole dp, so a target of exactly 48 dp passes (#64).
  const vp = screen.viewport;
  const density = platform === "ios" ? 1 : vp ? Math.min(vp.width, vp.height) / 411.4 : 2.625;
  const minTarget = platform === "ios" ? IOS_MIN_PT : ANDROID_MIN_DP;
  const unit = platform === "ios" ? "pt" : "dp";
  const findings: AuditFinding[] = [];
  const of = (e: UiElement, rule: AuditRule, severity: AuditFinding["severity"], detail: string): AuditFinding => ({
    rule,
    severity,
    ref: e.ref,
    role: e.role,
    ...(e.label ? { label: e.label } : {}),
    ...(e.identifier ? { identifier: e.identifier } : {}),
    ...(e.rect ? { rect: e.rect } : {}),
    detail,
  });
  const area = (e: UiElement) => (e.rect ? e.rect.width * e.rect.height : 0);
  const inside = (a: UiElement, b: UiElement) =>
    !!a.rect && !!b.rect && a.rect.x >= b.rect.x && a.rect.y >= b.rect.y && a.rect.x + a.rect.width <= b.rect.x + b.rect.width && a.rect.y + a.rect.height <= b.rect.y + b.rect.height;
  const candidates = elements.filter((e) => !(e.identifier ?? "").startsWith("com.android.systemui:") && CONTROL.test(e.role) && e.enabled !== false);
  // A control inside a bigger one (the switch inside its Settings row) is part of that row to a screen
  // reader and to a finger: the row is what gets announced and touched (#64).
  const nested = new Set(candidates.filter((e) => candidates.some((o) => o !== e && area(o) > area(e) && inside(e, o))));
  const spokenOf = (e: UiElement) => e.label?.trim() || e.value?.trim() || e.placeholder?.trim() || descendantLabel(elements, elements.indexOf(e));
  const sized = new Set(candidates.filter((e) => !nested.has(e) && e.rect && e.rect.width > 0 && e.rect.height > 0));
  const hidden = partlyHidden(elements, sized, vp, density, minTarget * density);
  const controls: Array<{ e: UiElement; spoken?: string }> = [];
  elements.forEach((e) => {
    if ((e.identifier ?? "").startsWith("com.android.systemui:")) return;
    if (CONTROL.test(e.role) && e.enabled !== false) {
      if (nested.has(e) || hidden.has(e)) return;
      const spoken = spokenOf(e);
      controls.push({ e, ...(spoken ? { spoken } : {}) });
      if (!spoken) {
        findings.push(of(e, "unlabelled-control", "error", `A ${e.role} with nothing to announce${e.identifier ? ` (only the id "${e.identifier}", which a screen reader does not read)` : ""}: give it an accessibility label.`));
      }
      if (e.rect && e.rect.width > 0 && e.rect.height > 0) {
        const w = Math.round(e.rect.width / density);
        const h = Math.round(e.rect.height / density);
        if (w < minTarget || h < minTarget) findings.push(of(e, "small-target", "warning", `Touch target ${w}×${h} ${unit}, under the ${minTarget} ${unit} minimum.`));
      }
    } else if (IMAGE.test(e.role) && !e.label?.trim() && e.rect && e.rect.width >= 24 * density && e.rect.height >= 24 * density) {
      findings.push(of(e, "unlabelled-image", "info", "An image with no label: fine if it is decorative (hide it from assistive technology), otherwise describe it."));
    }
  });
  const byLabel = new Map<string, UiElement[]>();
  for (const { e, spoken } of controls) {
    if (!spoken) continue;
    const key = spoken.toLowerCase();
    byLabel.set(key, [...(byLabel.get(key) ?? []), e]);
  }
  // A row and the button inside it with the same label are one control to a screen reader.
  for (const [label, all] of byLabel) {
    const same = all.filter((e) => !all.some((o) => o !== e && inside(e, o)));
    if (same.length < 2) continue;
    findings.push(of(same[0]!, "duplicate-label", "warning", `${same.length} controls are announced as "${label}" (${same.map((e) => e.ref).join(", ")}): a screen-reader user cannot tell them apart.`));
  }
  const counts = { "unlabelled-control": 0, "small-target": 0, "duplicate-label": 0, "unlabelled-image": 0 } as Record<AuditRule, number>;
  for (const f of findings) counts[f.rule]++;
  return { ...(screen.app ? { app: screen.app } : {}), checked: controls.length, findings, counts, partlyHidden: [...hidden].map((e) => e.ref) };
}
