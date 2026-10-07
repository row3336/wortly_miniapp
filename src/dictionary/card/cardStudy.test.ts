import { describe, expect, it } from "vitest";
import { validDictionaryView } from "../viewApi";
import { cardOrigin } from "./cardOrigin";
import { cardStudyState, formatStudyDate } from "./cardStudy";
import { CARD, cardView, excluded, response, reviewing } from "./cardTestData.test-support";

const dictionary = { kind: "dictionary" } as const;
const quiz = (direction: "l1-de" | "de-l1") => ({ kind: "quiz", direction }) as const;

describe("М12 study block from the server facts (RA 6.1.10, К07-055…058, К07-063)", () => {
  it("fixtures are accepted by the strict view decoder", () => {
    for (const view of [cardView(), reviewing(), excluded()]) expect(validDictionaryView(response(view), CARD)).toBe(true);
  });

  it("not yet selected: queued for learning (К07-057)", () => {
    expect(cardStudyState(cardView().study, dictionary)).toEqual({ kind: "not_selected" });
  });

  it("manual selection: in the next word group, also over introduced facts (Р4)", () => {
    const view = cardView(); view.study.facts.manual.selected = true;
    expect(cardStudyState(view.study, dictionary)).toEqual({ kind: "manual" });
    const ordinary = reviewing(); ordinary.study.facts.manual.selected = true;
    expect(cardStudyState(ordinary.study, dictionary)).toEqual({ kind: "manual" });
  });

  it("current Learning: only «Изучается», whatever else the facts say (К07-057)", () => {
    const view = cardView(); view.study.facts.manual.selected = true;
    view.study.facts.learning = { ever_selected: true, finished_or_skipped: false,
      current: { group_id: "00000000-0000-4000-8000-000000000b01", group_status: "active", member_status: "active", member_version: "1" } };
    expect(cardStudyState(view.study, dictionary)).toEqual({ kind: "learning" });
  });

  it("ordinary reviews from the dictionary: both directions with their own terms (К07-055)", () => {
    expect(cardStudyState(reviewing().study, dictionary)).toEqual({ kind: "reviews", rows: [
      { direction: "l1-de", schedule: { interval_days: 3, next_due_date: "2026-10-10" }, writtenOff: false, limitReached: false },
      { direction: "de-l1", schedule: { interval_days: 8, next_due_date: "2026-10-15" }, writtenOff: false, limitReached: false },
    ] });
  });

  it("ordinary reviews from a quiz: only the quiz's direction (К07-056)", () => {
    expect(cardStudyState(reviewing().study, quiz("l1-de"))).toMatchObject({ rows: [{ direction: "l1-de" }] });
    expect(cardStudyState(reviewing().study, quiz("de-l1"))).toMatchObject({ rows: [{ direction: "de-l1" }] });
  });

  it("written reviews off: a status instead of the L1→De terms, the oral direction keeps its own (К07-058)", () => {
    expect(cardStudyState(excluded().study, dictionary)).toEqual({ kind: "reviews", rows: [
      { direction: "l1-de", schedule: null, writtenOff: true, limitReached: false },
      { direction: "de-l1", schedule: { interval_days: 8, next_due_date: "2026-10-15" }, writtenOff: false, limitReached: false },
    ] });
    expect(cardStudyState(excluded().study, quiz("de-l1"))).toMatchObject({ rows: [{ direction: "de-l1", writtenOff: false }] });
  });

  it("limit reached only for the written L1→De of a word with an empty ladder (К07-063)", () => {
    const top = reviewing(); top.study.directions[0].interval_preview = [];
    expect(validDictionaryView(response(top), CARD)).toBe(true);
    const [forward, reverse] = (cardStudyState(top.study, dictionary) as { rows: { limitReached: boolean }[] }).rows;
    expect(forward.limitReached).toBe(true);
    // The oral direction's empty ladder means "no operation", never a limit.
    expect(reverse.limitReached).toBe(false);
    // A phrase has no increase at all: its empty ladder is not a limit either.
    const phrase = reviewing(); phrase.study.card_type = "phrase"; phrase.study.directions[0].interval_preview = [];
    expect(cardStudyState(phrase.study, dictionary)).toMatchObject({ rows: [{ limitReached: false }, { limitReached: false }] });
    // Without a local date there is no preview: nothing is claimed.
    const unknown = reviewing(); unknown.study.directions[0].interval_preview = null;
    expect(cardStudyState(unknown.study, dictionary)).toMatchObject({ rows: [{ limitReached: false }, {}] });
  });

  it("an introduced direction without terms is not shown (Р5)", () => {
    const view = reviewing(); Object.assign(view.study.directions[1], { introduced: true, progress_present: false, progress_version: null,
      schedule: null, interval_preview: null });
    expect(cardStudyState(view.study, dictionary)).toMatchObject({ rows: [{ direction: "l1-de" }] });
    const phrase = cardView(); phrase.study.card_type = "phrase";
    Object.assign(phrase.study.directions[1], { introduced: true, progress_present: true, progress_version: "1",
      schedule: { interval_days: 1, next_due_date: "2026-10-08" }, interval_preview: [] });
    expect(cardStudyState(phrase.study, dictionary)).toEqual({ kind: "reviews", rows: [
      { direction: "de-l1", schedule: { interval_days: 1, next_due_date: "2026-10-08" }, writtenOff: false, limitReached: false }] });
  });

  it("formats a server date in the UI language without a day shift", () => {
    expect(formatStudyDate("2026-10-10", "ru")).toBe(new Intl.DateTimeFormat("ru-RU", { year: "numeric", month: "short", day: "numeric" })
      .format(new Date(2026, 9, 10, 12)));
    expect(formatStudyDate("2026-10-10", "en")).toMatch(/Oct 10, 2026/);
  });
});

describe("card origin from the source route (Р7)", () => {
  it("the written quiz is L1→De, the oral quiz De→L1, anything else is the dictionary", () => {
    expect(cardOrigin("written")).toEqual({ kind: "quiz", direction: "l1-de" });
    expect(cardOrigin("oral")).toEqual({ kind: "quiz", direction: "de-l1" });
    for (const source of ["dictionary", "learning", "today", "card", null] as const) expect(cardOrigin(source)).toEqual({ kind: "dictionary" });
  });
});
