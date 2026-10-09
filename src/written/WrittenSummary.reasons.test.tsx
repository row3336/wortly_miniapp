import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClosedSessionBoundary, WrittenSummary as Summary } from "../api/generated";
import { CLOSE_REASONS } from "../api/wireValidation";
import { WrittenSummary } from "./WrittenSummary";

afterEach(cleanup);

type CloseReason = ClosedSessionBoundary["close_reason"];
type ShownReason = Exclude<CloseReason, "stop" | "summary_home">;
// The summary reads its reason texts through a Partial map, so a missing text would silently fall back to the generic
// closed line. This keyed list fails tsc when the contract gains a reason; the test below then fails until that reason
// has its own text in every language. stop and summary_home show no reason line (the own Stop, the natural end).
const untranslated = {
  // Until N4.4 / CP4b: no own text yet, the generic closed line is the intended display.
  save_failed: true,
} as const satisfies Partial<Record<ShownReason, true>>;
const contractReasons: Record<CloseReason, true> = {
  midnight: true, pair_changed: true, timezone_date_changed: true, stop: true, remote_stop: true, summary_home: true,
  save_failed: true,
};
// The exact working texts (6.1.O5, not approved): a text swapped between reasons fails here in every language.
const expected: Record<Exclude<ShownReason, keyof typeof untranslated>, Record<"ru" | "uk" | "en", string>> = {
  remote_stop: { ru: "Занятие завершено на другом устройстве", uk: "Заняття завершено на іншому пристрої",
    en: "The session was ended on another device" },
  midnight: { ru: "Занятие закрыто: начался новый день", uk: "Заняття закрито: почався новий день",
    en: "The session was closed: a new day began" },
  timezone_date_changed: { ru: "Занятие закрыто: сменилась дата", uk: "Заняття закрито: змінилася дата",
    en: "The session was closed: the date changed" },
  pair_changed: { ru: "Занятие закрыто: изменилась языковая пара", uk: "Заняття закрито: змінилася мовна пара",
    en: "The session was closed: the language pair changed" },
};
const generic = { ru: "Занятие закрыто", uk: "Заняття закрито", en: "The session was closed" } as const;
const summary: Summary = { completed: 1, correct: 1, wrong: 0, ratio: { numerator: 1, denominator: 1 } };

/** The line under the outcome, or null when the summary shows none. */
function shown(reason: ShownReason | null | undefined, language: keyof typeof generic) {
  const { container } = render(<WrittenSummary summary={summary} outcome="interrupted" language={language} closedReason={reason}
    canToday onToday={vi.fn()} />);
  const lines = Array.from(container.querySelectorAll(".written-summary p"), line => line.textContent);
  cleanup();
  return lines.length > 1 ? lines[1] : null;
}

describe("WrittenSummary close reason texts (Q27-А)", () => {
  it("the typed reason list is exactly the decoded wire list", () => {
    expect(Object.keys(contractReasons).sort()).toEqual([...CLOSE_REASONS].sort());
  });

  it("every reachable reason has its own text in ru, uk and en", () => {
    const reachable = (Object.keys(contractReasons) as CloseReason[])
      .filter((reason): reason is ShownReason => reason !== "stop" && reason !== "summary_home" && !(reason in untranslated));
    expect(reachable.sort()).toEqual(Object.keys(expected).sort());
    for (const reason of reachable) {
      for (const language of ["ru", "uk", "en"] as const) {
        const text = shown(reason, language);
        expect(text, `${reason}/${language}`).toBeTruthy();
        expect(text, `${reason}/${language}`).not.toBe(generic[language]);
        expect(text, `${reason}/${language}`).toBe(expected[reason as keyof typeof expected][language]);
      }
    }
  });

  it("an untranslated or unknown reason shows the generic closed text; no reason shows no line", () => {
    for (const language of ["ru", "uk", "en"] as const) {
      for (const reason of Object.keys(untranslated) as ShownReason[]) expect(shown(reason, language)).toBe(generic[language]);
      expect(shown(null, language)).toBe(generic[language]);
      expect(shown(undefined, language)).toBeNull();
    }
  });
});
