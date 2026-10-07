import { describe, expect, it } from "vitest";
import { backDestination, initialRoute, navigationReducer, type Route } from "../../app/navigation";
import { cardOrigin } from "./cardOrigin";
import { CARD } from "./cardTestData.test-support";

/** The route ApplicationDocument renders CardHost from: subject is the card, origin comes from back.source. */
function openFrom(screen: "written" | "oral" | "dictionary", details = {}): Route {
  const source = navigationReducer(initialRoute, { type: "open", screen });
  return navigationReducer(source, { type: "push", screen: "card", subject: CARD, details });
}

describe("М12 return to its source (TA:86, M-CARD В4): the entry point of M-ACTIONS needs no CardHost change", () => {
  it("from the written quiz: the card shows L1→De only and Back returns to the same quiz with its assignment", () => {
    const card = openFrom("written", { assignment: "assignment-7" });
    expect(card).toMatchObject({ screen: "card", subject: CARD });
    expect(cardOrigin(card.back?.source ?? null)).toEqual({ kind: "quiz", direction: "l1-de" });
    expect(backDestination(card)).toBe("written");
    // Back never starts a new quiz: it restores the source route with its return context.
    const back = navigationReducer(card, { type: "back" });
    expect(back).toMatchObject({ screen: "written", subject: null, restored: { source: "written", assignment: "assignment-7" } });
  });

  it("from the oral quiz: De→L1 only and Back to the oral route", () => {
    const card = openFrom("oral");
    expect(cardOrigin(card.back?.source ?? null)).toEqual({ kind: "quiz", direction: "de-l1" });
    expect(navigationReducer(card, { type: "back" }).screen).toBe("oral");
  });

  it("from the dictionary: both directions and Back restores query, mode and scroll", () => {
    const card = openFrom("dictionary", { search: { query: "Haus", mode: "words" }, scroll: 120 });
    expect(cardOrigin(card.back?.source ?? null)).toEqual({ kind: "dictionary" });
    expect(navigationReducer(card, { type: "back" })).toMatchObject({ screen: "dictionary",
      restored: { source: "dictionary", search: { query: "Haus", mode: "words" }, scroll: 120 } });
  });
});
