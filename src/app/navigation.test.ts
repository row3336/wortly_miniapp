import { describe, expect, it } from "vitest";
import { backDestination, initialRoute, navigationReducer, type NavigationAction, type Route, type ScreenId } from "./navigation";

const run = (...actions: NavigationAction[]) => actions.reduce(navigationReducer, initialRoute);
const at = (screen: ScreenId): Route => ({ ...initialRoute, screen });

describe("route model (TA §1: screen_id and return context)", () => {
  it("starts on Today with no return context", () => {
    expect(initialRoute).toEqual({ screen: "today", subject: null, back: null, restored: null, direction: "none" });
  });

  it("opening a section or a session starts the route afresh", () => {
    const route = run({ type: "push", screen: "statistics" }, { type: "open", screen: "written" });
    expect(route).toEqual({ screen: "written", subject: null, back: null, restored: null, direction: "forward" });
  });

  it("an unchanged section keeps the same route object, so nothing re-renders or animates", () => {
    const settings = run({ type: "open", screen: "settings" });
    expect(navigationReducer(settings, { type: "open", screen: "settings" })).toBe(settings);
    expect(navigationReducer(initialRoute, { type: "home" })).toBe(initialRoute);
  });

  it("a card opened from the dictionary keeps its source, search and scroll, and Back restores them (Т87)", () => {
    const search = { query: "Haus", mode: "words" } as const;
    const card = run({ type: "open", screen: "dictionary" }, { type: "push", screen: "card", subject: "card-1", details: { search, scroll: 320 } });
    expect(card).toMatchObject({ screen: "card", subject: "card-1", direction: "forward",
      back: { source: "dictionary", subject: null, parent: null, search, scroll: 320 } });
    const back = navigationReducer(card, { type: "back" });
    expect(back).toEqual({ screen: "dictionary", subject: null, back: null, direction: "back",
      restored: { source: "dictionary", subject: null, parent: null, search, scroll: 320 } });
  });

  it("the return context holds the source and the assignment id, never a copy of study progress", () => {
    const card = run({ type: "open", screen: "written" }, { type: "push", screen: "card", subject: "card-7",
      details: { assignment: "assignment-3" } });
    expect(Object.keys(card.back!).sort()).toEqual(["assignment", "parent", "source", "subject"]);
    expect(card.back).toEqual({ source: "written", subject: null, parent: null, assignment: "assignment-3" });
    // Back returns to the source screen; it does not start another quiz (TA:86): the route only names the screen.
    expect(navigationReducer(card, { type: "back" })).toMatchObject({ screen: "written", back: null,
      restored: { assignment: "assignment-3" } });
  });

  it("nested screens unwind one step per Back, each to its own source", () => {
    const related = run({ type: "push", screen: "statistics" }, { type: "push", screen: "card", subject: "a" },
      { type: "push", screen: "card", subject: "b" });
    const first = navigationReducer(related, { type: "back" });
    expect(first).toMatchObject({ screen: "card", subject: "a" });
    const second = navigationReducer(first, { type: "back" });
    expect(second).toMatchObject({ screen: "statistics", back: { source: "today" } });
    expect(navigationReducer(second, { type: "back" })).toMatchObject({ screen: "today", back: null, direction: "back" });
  });

  it("Back never leaves a session by navigation: the session's own exit decides (stop without confirmation)", () => {
    for (const screen of ["learning", "oral", "written", "conjugation"] as const) {
      const route = run({ type: "open", screen });
      expect(navigationReducer(route, { type: "back" })).toBe(route);
    }
  });

  it("sections move sideways in panel order; Today after anything is a return", () => {
    expect(run({ type: "open", screen: "settings" }).direction).toBe("forward");
    expect(run({ type: "open", screen: "settings" }, { type: "open", screen: "dictionary" }).direction).toBe("back");
    expect(run({ type: "open", screen: "dictionary" }, { type: "open", screen: "settings" }).direction).toBe("forward");
    expect(run({ type: "open", screen: "oral" }, { type: "home" }).direction).toBe("back");
    expect(run({ type: "open", screen: "oral" }, { type: "open", screen: "settings" }).direction).toBe("forward");
  });
});

describe("Back destination for every screen (TA:86)", () => {
  it.each([
    ["today", null],
    ["dictionary", "today"],
    ["settings", "today"],
    ["statistics", "today"],
    ["learning", null],
    ["oral", null],
    ["written", null],
    ["conjugation", null],
  ] as const)("%s → %s", (screen, destination) => {
    const route = screen === "statistics" ? run({ type: "push", screen }) : at(screen);
    expect(backDestination(route)).toBe(destination);
  });

  it("a card returns to its source, also when the source is a session", () => {
    expect(backDestination(run({ type: "open", screen: "dictionary" }, { type: "push", screen: "card", subject: "c" }))).toBe("dictionary");
    expect(backDestination(run({ type: "open", screen: "oral" }, { type: "push", screen: "card", subject: "c" }))).toBe("oral");
  });
});
