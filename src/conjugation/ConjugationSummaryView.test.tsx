import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConjugationSummary, ConjugationSummaryBlock } from "../api/generated";
import type { Language } from "../i18n/language";
import { ConjugationSummaryView } from "./ConjugationSummaryView";

afterEach(cleanup);
const id = (n: number) => `cccccccc-dddd-4000-8000-${String(n).padStart(12, "0")}`;
const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const all = ["ich", "du", "er_sie_es", "wir", "ihr", "sie_sie"] as const;
function block(n: number, lemma: string, tense: "present" | "preterite", groups: ConjugationSummaryBlock["answered_groups"],
  effect: ConjugationSummaryBlock["effect"], grade: ConjugationSummaryBlock["grade"]): ConjugationSummaryBlock {
  return { cycle_id: id(n), base_verb_id: id(100 + n), base_lemma: lemma, tense, answered_groups: groups, effect, grade };
}
/** Server order on purpose not alphabetical: sein, gehen (completed), lesen, haben (partial). */
function summaryA(): ConjugationSummary {
  const blocks = [
    block(1, "sein", "present", [...all], "success", 4),
    block(2, "lesen", "preterite", ["ich", "du"], "error", 2),
    block(3, "gehen", "preterite", [...all], "error", 2),
    block(4, "haben", "present", ["wir", "ihr", "sie_sie"], "incomplete", null),
  ];
  return { completed_cycle_ids: [id(1), id(3)], partial: [{ cycle_id: id(2), answered_groups: ["ich", "du"] },
    { cycle_id: id(4), answered_groups: ["wir", "ihr", "sie_sie"] }], results: [], completed: 17, correct: 14, wrong: 3, blocks };
}
const legacyL1 = (): ConjugationSummary => ({ completed_cycle_ids: [id(1)], partial: [{ cycle_id: id(2), answered_groups: ["ich", "du", "wir"] }],
  results: [], completed: 9, correct: 8, wrong: 1, blocks: null });
const legacyL0 = (): ConjugationSummary => ({ completed_cycle_ids: [], partial: [], results: [], completed: 0, correct: 0, wrong: 0, blocks: null });
const view = (summary: ConjugationSummary | null, language: Language = "ru", extra: { closedReason?: Parameters<typeof ConjugationSummaryView>[0]["closedReason"]; onHome?: (() => void) | null } = {}) =>
  render(<ConjugationSummaryView summary={summary} language={language} onHome={extra.onHome === undefined ? vi.fn() : extra.onHome}
    {...("closedReason" in extra ? { closedReason: extra.closedReason } : {})} />).container;
const items = (name: string) => within(screen.getByRole("region", { name })).getAllByRole("listitem").map(item => item.textContent);

describe("ConjugationSummaryView A: server blocks", () => {
  it("separates completed from unfinished, keeps server order inside each group and shows outcome as text", () => {
    const root = view(summaryA());
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Итог спряжений");
    expect(items("Завершённые блоки")).toEqual(["sein · Präsens — Нормально", "gehen · Präteritum — С ошибкой"]);
    expect(items("Незавершённые блоки")).toEqual(["lesen · Präteritum — отвечено форм: 2 из 6", "haben · Präsens — отвечено форм: 3 из 6"]);
    expect(root.textContent).toContain("Ответов в этом занятии: 17 (верно 14, ошибок 3)");
    expect(root.textContent).not.toMatch(uuidPattern);
    expect(root.querySelectorAll('[lang="de"]').length).toBe(8);
  });

  it("never shows the outcome of an unfinished block (Q1), even when it is an error", () => {
    view(summaryA());
    const partial = items("Незавершённые блоки").join(" ");
    expect(partial).not.toContain("С ошибкой");
    expect(partial).not.toMatch(/Трудно|Нормально|Легко/);
  });

  it("3/6 is never a completed block; zero answers are not called done; empty groups are not rendered", () => {
    const summary: ConjugationSummary = { completed_cycle_ids: [], partial: [{ cycle_id: id(5), answered_groups: ["ich", "du", "wir"] }],
      results: [], completed: 0, correct: 0, wrong: 0, blocks: [block(5, "gehen", "present", ["ich", "du", "wir"], "incomplete", null)] };
    const root = view(summary);
    expect(screen.queryByRole("region", { name: "Завершённые блоки" })).toBeNull();
    expect(items("Незавершённые блоки")).toEqual(["gehen · Präsens — отвечено форм: 3 из 6"]);
    expect(root.textContent).toContain("В этом занятии ответов нет");
    expect(root.textContent).not.toMatch(/выполн/i);
    const empty = view({ ...summary, partial: [], blocks: [] });
    expect(empty.querySelectorAll("li")).toHaveLength(0);
  });

  it.each([["uk", "Підсумок дієвідмін", "sein · Präsens — Нормально", "lesen · Präteritum — форм із відповіддю: 2 із 6"],
    ["en", "Conjugation summary", "sein · Präsens — Normal", "lesen · Präteritum — forms answered: 2 of 6"]] as const)(
    "%s copy for every line", (language, title, done, partial) => {
      const root = view(summaryA(), language);
      expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(title);
      expect(root.textContent).toContain(done);
      expect(root.textContent).toContain(partial);
      // No line falls back to another language: en has no Cyrillic, uk has none of the Russian lines.
      expect(root.textContent).not.toMatch(language === "en" ? /[А-Яа-яЁёІіЇїЄє]/ : /Итог|Ответов|ошибок|отвечено/);
      expect(root.textContent).not.toMatch(uuidPattern);
    });
});

describe("ConjugationSummaryView B/C: legacy and unknown", () => {
  it("L1 shows only the frozen aggregates and that block details are unavailable", () => {
    const root = view(legacyL1());
    expect(root.textContent).toContain("Завершено блоков: 1");
    expect(root.textContent).toContain("Незавершённых блоков: 1, отвечено в них форм: 3");
    expect(root.textContent).toContain("Ответов в этом занятии: 9 (верно 8, ошибок 1)");
    expect(root.textContent).toContain("Подробности по блокам недоступны");
    expect(root.querySelectorAll("li")).toHaveLength(0);
    expect(root.textContent).not.toMatch(uuidPattern);
  });

  it("L0 and an unknown summary say only that details are unavailable: no zeros, no 'no answers', no 'done'", () => {
    for (const summary of [legacyL0(), null]) {
      const root = view(summary, "ru", { closedReason: "stop" });
      const text = root.textContent ?? "";
      expect(text).toContain("Подробности итога недоступны");
      expect(text).not.toMatch(/\d/);
      expect(text).not.toContain("ответов нет");
      expect(text).not.toMatch(/выполн/i);
      cleanup();
    }
  });
});

describe("ConjugationSummaryView closed reason and action", () => {
  it("closed shows one reason line by code; unknown or null reason → general text; live summary has none", () => {
    view(summaryA(), "ru", { closedReason: "midnight" });
    expect(screen.getByRole("status").textContent).toBe("Занятие закрыто: начался новый день");
    cleanup();
    view(summaryA(), "ru", { closedReason: null });
    expect(screen.getByRole("status").textContent).toBe("Занятие закрыто");
    cleanup();
    view(summaryA());
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("save_failed (no own text yet, owner question N4.4) renders the generic closed text in every language and does not throw", () => {
    const expected = { ru: "Занятие закрыто", uk: "Заняття закрито", en: "The session was closed" } as const;
    for (const language of ["ru", "uk", "en"] as const) {
      view(summaryA(), language, { closedReason: "save_failed" as unknown as null });
      expect(screen.getByRole("status").textContent).toBe(expected[language]);
      cleanup();
    }
  });

  it("the Today action calls onHome once per click and is disabled without the right", () => {
    const onHome = vi.fn();
    view(summaryA(), "ru", { onHome });
    fireEvent.click(screen.getByRole("button", { name: "На Сегодня" }));
    expect(onHome).toHaveBeenCalledTimes(1);
    cleanup();
    view(summaryA(), "en", { onHome: null });
    expect((screen.getByRole("button", { name: "To Today" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });
});
