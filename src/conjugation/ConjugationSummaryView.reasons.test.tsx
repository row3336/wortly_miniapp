import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLOSE_REASONS } from "../api/wireValidation";
import type { ConjugationSummary } from "../api/generated";
import { ConjugationSummaryView } from "./ConjugationSummaryView";
import type { CloseReason } from "./conjugationDocumentController";

afterEach(cleanup);

// The view reads its reason texts through a Partial map, so a missing text would silently fall back to the
// generic closed line. This keyed list fails tsc when the contract gains a reason; the test below then
// fails until that reason has its own text in every language.
const untranslated = {
  // Until N4.4 / CP4b: no own text yet, the generic closed line is the intended display.
  save_failed: true,
} as const satisfies Partial<Record<CloseReason, true>>;
const contractReasons: Record<CloseReason, true> = {
  midnight: true, pair_changed: true, timezone_date_changed: true, stop: true, remote_stop: true, summary_home: true,
  save_failed: true,
};
const generic = { ru: "Занятие закрыто", uk: "Заняття закрито", en: "The session was closed" } as const;
const summary: ConjugationSummary = { completed_cycle_ids: [], partial: [], results: [], completed: 0, correct: 0, wrong: 0, blocks: null };

function shown(reason: CloseReason, language: keyof typeof generic) {
  render(<ConjugationSummaryView summary={summary} closedReason={reason} language={language} onHome={vi.fn()} />);
  const text = screen.getByRole("status").textContent;
  cleanup();
  return text;
}

describe("ConjugationSummaryView close reason texts", () => {
  it("the typed reason list is exactly the decoded wire list", () => {
    expect(Object.keys(contractReasons).sort()).toEqual([...CLOSE_REASONS].sort());
  });

  it("every reachable reason has its own text in ru, uk and en", () => {
    const reachable = (Object.keys(contractReasons) as CloseReason[]).filter(reason => !(reason in untranslated));
    expect(reachable.length).toBeGreaterThan(0);
    for (const reason of reachable) {
      for (const language of ["ru", "uk", "en"] as const) {
        const text = shown(reason, language);
        expect(text, `${reason}/${language}`).toBeTruthy();
        expect(text, `${reason}/${language}`).not.toBe(generic[language]);
      }
    }
  });

  it("an untranslated reason shows the generic closed text", () => {
    for (const reason of Object.keys(untranslated) as CloseReason[]) {
      for (const language of ["ru", "uk", "en"] as const) expect(shown(reason, language)).toBe(generic[language]);
    }
  });
});
