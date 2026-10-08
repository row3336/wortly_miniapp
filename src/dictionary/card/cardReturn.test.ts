import { describe, expect, it } from "vitest";
import { backDestination, initialRoute, navigationReducer, type Route } from "../../app/navigation";
import { cardOrigin, movesWrittenQuiz, viewOrigin } from "./cardOrigin";
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

  it("only a card of the main written quiz moves that quiz on after its study action (M-ACTIONS Р4)", () => {
    expect(movesWrittenQuiz(cardOrigin(openFrom("written").back?.source ?? null))).toBe(true);
    expect(movesWrittenQuiz(cardOrigin(openFrom("oral").back?.source ?? null))).toBe(false);
    expect(movesWrittenQuiz(cardOrigin(openFrom("dictionary").back?.source ?? null))).toBe(false);
  });
});

describe("M-CARD-LINK-2: a card from a bot message (answers S01, S02)", () => {
  const fromMessage = (screen: "written" | "oral" | "learning" | "today") => navigationReducer(
    screen === "today" ? initialRoute : navigationReducer(initialRoute, { type: "open", screen }),
    { type: "push", screen: "card", subject: CARD, entry: "message" });

  it.each(["written", "oral", "learning", "today"] as const)("over %s it is the dictionary view with no quiz rights", (screen) => {
    const card = fromMessage(screen);
    expect(card).toMatchObject({ screen: "card", subject: CARD, entry: "message" });
    const origin = cardOrigin(card.back?.source ?? null, card.entry);
    expect(origin).toEqual({ kind: "dictionary", via: "message" });
    expect(movesWrittenQuiz(origin)).toBe(false);
    // Back returns to the screen under it; the restored route carries no entry.
    const back = navigationReducer(card, { type: "back" });
    expect(back.screen).toBe(screen);
    expect(back.entry).toBeUndefined();
  });

  it("an ordinary push carries no entry", () => {
    expect("entry" in navigationReducer(initialRoute, { type: "push", screen: "card", subject: CARD })).toBe(false);
  });

  it("only a quiz card reads as study, a message card as message", () => {
    expect(viewOrigin({ kind: "quiz", direction: "l1-de" })).toBe("study");
    expect(viewOrigin({ kind: "quiz", direction: "de-l1" })).toBe("study");
    expect(viewOrigin({ kind: "dictionary" })).toBe("dictionary");
    expect(viewOrigin({ kind: "dictionary", via: "message" })).toBe("message");
  });
});
