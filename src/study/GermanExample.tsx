import type { ReactNode } from "react";
import type { CardExample } from "../api/generated";
import "./germanExample.css";

/** Half-open positions in Unicode code points, never UTF-16 offsets or HTML. */
export type GermanExampleHighlight = { start: number; end: number };

export type GermanExampleProps = {
  text: string;
  highlightedParts: CardExample["highlighted_parts"];
};

function rangesFor(parts: GermanExampleProps["highlightedParts"], length: number): GermanExampleHighlight[] {
  const ranges: GermanExampleHighlight[] = [];
  for (const part of parts) {
    if (part === null || typeof part !== "object" || Array.isArray(part)) continue;
    const keys = Object.keys(part);
    if (keys.length !== 2 || !keys.includes("start") || !keys.includes("end")) continue;
    const { start, end } = part as Record<string, unknown>;
    if (typeof start !== "number" || typeof end !== "number"
      || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start < 0 || start >= end || end > length) continue;
    ranges.push({ start, end });
  }
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: GermanExampleHighlight[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push(range);
  }
  return merged;
}

/** Shows one selected example. Only explicit Unicode-code-point ranges become strong text;
 * unsupported metadata is ignored. Text is never interpreted as HTML or markdown. */
export function GermanExample({ text, highlightedParts }: GermanExampleProps) {
  const points = Array.from(text);
  const ranges = rangesFor(highlightedParts, points.length);
  const content: ReactNode[] = [];
  let cursor = 0;
  for (const { start, end } of ranges) {
    if (cursor < start) content.push(points.slice(cursor, start).join(""));
    content.push(<strong key={start}>{points.slice(start, end).join("")}</strong>);
    cursor = end;
  }
  if (cursor < points.length) content.push(points.slice(cursor).join(""));
  return <p className="german-example" lang="de">{content}</p>;
}
