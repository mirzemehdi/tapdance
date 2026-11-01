import { TapdanceError } from "./errors.js";
import type { ElementTarget } from "./types.js";

export interface TargetInput {
  text?: string;
  id?: string;
  ref?: string;
  selector?: string;
  x?: number;
  y?: number;
}

/** Turns loose CLI/MCP inputs into exactly one target, refusing ambiguous or partial ones. */
export function parseTarget(input: TargetInput): ElementTarget {
  const named: ElementTarget[] = [];
  if (input.text !== undefined) named.push({ kind: "text", text: input.text });
  if (input.id !== undefined) named.push({ kind: "id", id: input.id });
  if (input.ref !== undefined) named.push({ kind: "ref", ref: input.ref.replace(/^@/, "") });
  if (input.selector !== undefined) named.push({ kind: "selector", selector: input.selector });
  const hasX = input.x !== undefined;
  const hasY = input.y !== undefined;
  if (hasX !== hasY) {
    throw new TapdanceError("USAGE", "Coordinates need both x and y");
  }
  if (hasX && hasY) {
    if (!Number.isFinite(input.x) || !Number.isFinite(input.y) || input.x! < 0 || input.y! < 0) {
      throw new TapdanceError("USAGE", "Coordinates must be non-negative numbers");
    }
    named.push({ kind: "point", x: input.x!, y: input.y! });
  }
  if (named.length === 0) {
    throw new TapdanceError("USAGE", "Name a target: text, id, ref, selector, or x and y", {
      hint: "Run `tapdance ui inspect` to see element refs and labels.",
    });
  }
  if (named.length > 1) {
    throw new TapdanceError("USAGE", `Name one target, not ${named.length} (${named.map((t) => t.kind).join(", ")})`);
  }
  const target = named[0]!;
  if (target.kind !== "point") {
    const value = Object.values(target)[1] as string;
    if (value.trim() === "") throw new TapdanceError("USAGE", `Target ${target.kind} is empty`);
  }
  return target;
}

export function describeTarget(target: ElementTarget): string {
  switch (target.kind) {
    case "text":
      return `text "${target.text}"`;
    case "id":
      return `id "${target.id}"`;
    case "ref":
      return `@${target.ref}`;
    case "selector":
      return `selector ${target.selector}`;
    case "point":
      return `(${target.x}, ${target.y})`;
  }
}
