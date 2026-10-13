import { describe, expect, it } from "vitest";
import {
  addItem, canRemove, dropIndex, hasBlank, itemsOf, moveDown, moveItem, moveUp, removeItem, sameTexts, shiftOf, textsOf,
} from "./translationOrder";

const keys = () => { let n = 0; return () => `k${++n}`; };

describe("R14-01 order of the owner's translation fields", () => {
  it("O1 a field moves to any place, also to the first; other fields keep their relative order", () => {
    const list = ["дом", "жилище", "здание", "строение"];
    expect(moveItem(list, 2, 0)).toEqual(["здание", "дом", "жилище", "строение"]);
    expect(moveItem(list, 0, 3)).toEqual(["жилище", "здание", "строение", "дом"]);
    expect(moveItem(list, 3, 1)).toEqual(["дом", "строение", "жилище", "здание"]);
    // Nothing changes for the same place or an index outside the list; the input is never mutated.
    expect(moveItem(list, 1, 1)).toEqual(list);
    expect(moveItem(list, -1, 2)).toEqual(list);
    expect(moveItem(list, 1, 4)).toEqual(list);
    expect(moveItem(list, 0.5, 2)).toEqual(list);
    expect(list).toEqual(["дом", "жилище", "здание", "строение"]);
  });

  it("O2 «Выше» / «Ниже» move one place; the edges stay", () => {
    const list = ["a", "b", "c"];
    expect(moveUp(list, 2)).toEqual(["a", "c", "b"]);
    expect(moveUp(list, 0)).toEqual(list);
    expect(moveDown(list, 0)).toEqual(["b", "a", "c"]);
    expect(moveDown(list, 2)).toEqual(list);
  });

  it("O3 R12-06: the last field cannot be removed; any other can", () => {
    expect(canRemove(["дом"])).toBe(false);
    expect(removeItem(["дом"], 0)).toEqual(["дом"]);
    expect(canRemove(["дом", "жилище"])).toBe(true);
    expect(removeItem(["дом", "жилище"], 0)).toEqual(["жилище"]);
    expect(removeItem(["дом", "жилище"], 5)).toEqual(["дом", "жилище"]);
  });

  it("O4 «+» adds an empty field at the end; a blank field is detected; texts keep the order and the raw text", () => {
    const items = itemsOf(["дом", " жилище "], keys());
    const added = addItem(items, "new");
    expect(added.map(item => item.key)).toEqual(["k1", "k2", "new"]);
    expect(hasBlank(added)).toBe(true);
    expect(hasBlank(items)).toBe(false);
    expect(hasBlank([{ key: "x", text: "   " }])).toBe(true);
    expect(textsOf(items)).toEqual(["дом", " жилище "]);
    expect(sameTexts(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameTexts(["a", "b"], ["b", "a"])).toBe(false);
  });

  it("O5 a dragged field lands where its middle passes a neighbour's middle; first and last places are reachable", () => {
    const heights = [44, 44, 60, 44], gap = 8;
    expect(dropIndex(1, 0, heights, gap)).toBe(1);
    expect(dropIndex(1, 29, heights, gap)).toBe(1);
    expect(dropIndex(1, 30, heights, gap)).toBe(1); // 60/2 + 8 = 38 is needed to pass the third field's middle
    expect(dropIndex(1, 38, heights, gap)).toBe(2);
    expect(dropIndex(1, 68 + 22 + 8, heights, gap)).toBe(3);
    expect(dropIndex(1, 10_000, heights, gap)).toBe(3);
    expect(dropIndex(2, -29, heights, gap)).toBe(2);
    expect(dropIndex(2, -30, heights, gap)).toBe(1);
    expect(dropIndex(2, -10_000, heights, gap)).toBe(0);
    expect(dropIndex(5, 10, heights, gap)).toBe(5);
    expect(dropIndex(1, Number.NaN, heights, gap)).toBe(1);
  });

  it("O6 the fields between part by the dragged height plus the gap; the others and the dragged one do not shift", () => {
    // Down from 0 to 2: fields 1 and 2 move up.
    expect([0, 1, 2, 3].map(index => shiftOf(index, 0, 2, 44, 8))).toEqual([0, -52, -52, 0]);
    // Up from 3 to 1: fields 1 and 2 move down.
    expect([0, 1, 2, 3].map(index => shiftOf(index, 3, 1, 44, 8))).toEqual([0, 52, 52, 0]);
    expect([0, 1, 2].map(index => shiftOf(index, 1, 1, 44, 8))).toEqual([0, 0, 0]);
  });
});
