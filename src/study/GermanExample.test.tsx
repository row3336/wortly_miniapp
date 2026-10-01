import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { GermanExample } from "./GermanExample";
import type { GermanExampleProps } from "./GermanExample";

afterEach(cleanup);

function example(text: string, highlightedParts: GermanExampleProps["highlightedParts"]) {
  const view = render(<GermanExample text={text} highlightedParts={highlightedParts} />);
  return { ...view, paragraph: view.container.querySelector("p")! };
}

const strongTexts = (paragraph: HTMLElement) => Array.from(paragraph.querySelectorAll("strong"), node => node.textContent);

describe("GermanExample explicit highlights", () => {
  it("preserves every space, tab and line break with German semantic markup", () => {
    const text = "  Ich\tgehe.\n\nDu gehst.  ";
    const { paragraph } = example(text, [{ start: 6, end: 10 }]);
    expect(paragraph.textContent).toBe(text);
    expect(paragraph.lang).toBe("de");
    expect(strongTexts(paragraph)).toEqual(["gehe"]);
    expect(paragraph.children).toHaveLength(1);
    expect(paragraph.querySelector("strong")!.attributes).toHaveLength(0);
    expect(paragraph.hasAttribute("style")).toBe(false);
  });

  it("counts a preceding emoji as one code point and preserves surrogate pairs inside highlights", () => {
    const text = "😀 Ich gehe 🚶 heute.";
    const { paragraph } = example(text, [{ start: 6, end: 10 }, { start: 11, end: 12 }]);
    expect(paragraph.textContent).toBe(text);
    expect(strongTexts(paragraph)).toEqual(["gehe", "🚶"]);
  });

  it("highlights only the addressed occurrence of a repeated word", () => {
    const { paragraph } = example("geht und geht", [{ start: 9, end: 13 }]);
    expect(paragraph.textContent).toBe("geht und geht");
    expect(paragraph.firstChild!.textContent).toBe("geht und ");
    expect(strongTexts(paragraph)).toEqual(["geht"]);
  });

  it("sorts and merges adjacent and overlapping ranges without changing frozen input", () => {
    const parts = [
      { start: 7, end: 9 }, { start: 4, end: 7 }, { start: 1, end: 5 },
      { start: 1, end: 3 }, { start: 11, end: 12 },
    ];
    const before = structuredClone(parts);
    parts.forEach(Object.freeze); Object.freeze(parts);
    const { paragraph } = example("abcdefghijklmn", parts);
    expect(paragraph.textContent).toBe("abcdefghijklmn");
    expect(strongTexts(paragraph)).toEqual(["bcdefghi", "l"]);
    expect(parts).toEqual(before);
  });

  it("renders empty and unannotated text without invented highlights and updates on rerender", () => {
    const { paragraph, rerender } = example("", [{ start: 0, end: 1 }]);
    expect(paragraph.textContent).toBe("");
    expect(strongTexts(paragraph)).toEqual([]);
    rerender(<GermanExample text={"Ich gehe.\n "} highlightedParts={[]} />);
    expect(paragraph.textContent).toBe("Ich gehe.\n ");
    expect(strongTexts(paragraph)).toEqual([]);
  });

  it("ignores malformed and legacy metadata while retaining valid ranges and all text", () => {
    const parts = [null, false, 2, "gehe", [0, 3], {}, { start: 0 },
      { start: "0", end: 3 }, { start: -1, end: 3 }, { start: 1.5, end: 3 },
      { start: 0, end: 2.5 }, { start: 3, end: 3 }, { start: 4, end: 3 },
      { start: 0, end: 100 }, { start: 0, end: Number.MAX_SAFE_INTEGER + 1 },
      { start: NaN, end: 3 }, { start: 0, end: Infinity },
      { start: 0, end: 3, role: "button" }, { text: "gehe" },
      { start: 4, end: 8 }];
    const { paragraph, rerender } = example("Ich gehe.", parts);
    expect(paragraph.textContent).toBe("Ich gehe.");
    expect(strongTexts(paragraph)).toEqual(["gehe"]);
    rerender(<GermanExample text="Ich gehe." highlightedParts={parts.slice(0, -1)} />);
    expect(paragraph.textContent).toBe("Ich gehe.");
    expect(strongTexts(paragraph)).toEqual([]);
  });

  it("keeps literal HTML and markdown as text without elements or metadata attributes", () => {
    const text = '<script>alert(1)</script> <img src=x onerror="alert(1)"> **geht**';
    const { paragraph } = example(text, [
      { start: 0, end: 8 }, { start: 25, end: 30, role: "button", onClick: "alert(1)" },
      { html: "<b>geht</b>" },
    ]);
    expect(paragraph.textContent).toBe(text);
    expect(strongTexts(paragraph)).toEqual(["<script>"]);
    expect(paragraph.querySelector("script, img, b, button, [role], [onclick], [onerror]")).toBeNull();
    expect(Array.from(paragraph.querySelectorAll("*"), node => node.tagName)).toEqual(["STRONG"]);
  });
});
