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
}

const CONTROL = /^(button|cell|link|switch|toggle|checkbox|check-box|radio|radio-button|slider|tab|menu-?item|text-?field|text-?view|search|search-?field|secure-?text-?field|combo-?box|image-?button|stepper|segmented)/i;
const IMAGE = /^(image|img|icon)$/i;
/** Minimum touch target: Apple's 44 pt; Android's 48 dp. */
const IOS_MIN_PT = 44;
const ANDROID_MIN_DP = 48;

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
  const controls: Array<{ e: UiElement; spoken?: string }> = [];
  elements.forEach((e, i) => {
    if ((e.identifier ?? "").startsWith("com.android.systemui:")) return;
    if (CONTROL.test(e.role) && e.enabled !== false) {
      if (nested.has(e)) return;
      const spoken = e.label?.trim() || e.value?.trim() || e.placeholder?.trim() || descendantLabel(elements, i);
      controls.push({ e, ...(spoken ? { spoken } : {}) });
      if (!spoken) {
        findings.push(of(e, "unlabelled-control", "error", `A ${e.role} with nothing to announce${e.identifier ? ` (only the id "${e.identifier}", which a screen reader does not read)` : ""}: give it an accessibility label.`));
      }
      // A row cut off by the top or bottom edge (scrolled half out) reports only its visible part: its
      // size says nothing (#69). Full-width rows touch the side edges anyway, so those do not count.
      const clipped = !!vp && !!e.rect && (e.rect.y <= 0 || e.rect.y + e.rect.height >= vp.height - 1);
      if (e.rect && e.rect.width > 0 && e.rect.height > 0 && !clipped) {
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
  return { ...(screen.app ? { app: screen.app } : {}), checked: controls.length, findings, counts };
}
