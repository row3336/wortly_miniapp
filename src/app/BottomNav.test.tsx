import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TodayResponse } from "../api/generated";
import type { Language } from "../i18n/language";
import type { DictionaryPair } from "../i18n/messages";
import { TodayScreen } from "../today/TodayScreen";
import { BottomNav } from "./BottomNav";
import { Icon, iconSprite } from "./navigationIcons";

afterEach(cleanup);

describe("bottom navigation panel (К09-038)", () => {
  it.each([
    ["ru", "Основная навигация", ["Сегодня", "Словарь", "Настройки"]],
    ["uk", "Основна навігація", ["Сьогодні", "Словник", "Налаштування"]],
    ["en", "Main navigation", ["Today", "Dictionary", "Settings"]],
  ] as const)("%s: Today, Dictionary, Settings in this order with the current section marked", (language, label, names) => {
    render(<BottomNav current="dictionary" language={language} onNavigate={vi.fn()} />);
    const buttons = within(screen.getByRole("navigation", { name: label })).getAllByRole("button");
    expect(buttons.map(button => button.textContent)).toEqual(names);
    expect(buttons.map(button => button.getAttribute("aria-current"))).toEqual([null, "page", null]);
  });

  it("only navigates: a tap reports the section, and unavailable sections are disabled", () => {
    const onNavigate = vi.fn();
    render(<BottomNav current="today" language="ru" onNavigate={onNavigate} enabled={["dictionary", "settings"]} />);
    expect((screen.getByRole("button", { name: "Сегодня" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Словарь" }));
    fireEvent.click(screen.getByRole("button", { name: "Настройки" }));
    expect(onNavigate.mock.calls).toEqual([["dictionary"], ["settings"]]);
  });

  it("without a handler every section is visible and none can be opened", () => {
    render(<BottomNav current="today" language="ru" />);
    for (const button of screen.getAllByRole("button")) expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("uses the И1 symbols as decorative icons beside the visible names", () => {
    const { container } = render(<BottomNav current="today" language="ru" />);
    const uses = Array.from(container.querySelectorAll("svg use"), use => use.getAttribute("href"));
    expect(uses).toEqual([`${iconSprite}#calendar`, `${iconSprite}#book`, `${iconSprite}#settings`]);
    for (const svg of container.querySelectorAll("svg")) expect(svg.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("И1 icon names for the screen reader (TA §2)", () => {
  it.each([["ru", "Назад"], ["uk", "Назад"], ["en", "Back"]] as const)("%s: an icon-only control is announced by its name", (language, name) => {
    render(<button type="button"><Icon name="back" language={language} /></button>);
    expect(screen.getByRole("button", { name })).toBeTruthy();
    expect(screen.getByRole("img", { name })).toBeTruthy();
  });
});

const plan = (pair: DictionaryPair): TodayResponse => ({ state_version: "1", pair, local_date: "2026-10-06", status: "work_now",
  base: { total: 4, words: 2, phrases: 2 }, ordinary_status: "ready",
  ordinary: { words: { "l1-de": { ready: 1, next_due_date: null }, "de-l1": { ready: 0, next_due_date: null } },
    phrases: { "l1-de": { ready: 0, next_due_date: null }, "de-l1": { ready: 2, next_due_date: null } } },
  learning: { status: "completed", ready: 0, preview: 0, next_due_at: null, new_group_size: 0, manual_eligible: 0, automatic_eligible: 0 },
  conjugation: { ready: 0, openable: 0, next_due_date: null }, next_repeat_date: null });

describe("Today rows show the direction with the arrow (И04) for three UI languages × three pairs", () => {
  const expected: Record<Language, Record<DictionaryPair, string[] | null>> = {
    ru: { "ru-de": ["Рус → Нем", "Нем → Рус"], "uk-de": ["Укр → Нем", "Нем → Укр"], "en-de": null },
    uk: { "ru-de": ["Рос → Нім", "Нім → Рос"], "uk-de": ["Укр → Нім", "Нім → Укр"], "en-de": null },
    en: { "ru-de": ["Ru → De", "De → Ru"], "uk-de": ["Uk → De", "De → Uk"], "en-de": null },
  };
  it.each((["ru", "uk", "en"] as const).flatMap(language => (["ru-de", "uk-de", "en-de"] as const).map(pair => [language, pair] as const)))(
    "UI %s, pair %s", (language, pair) => {
      const { container } = render(<TodayScreen state={{ kind: "ready", data: plan(pair), refreshing: false }} language={language} onRetry={vi.fn()} />);
      const labels = Array.from(container.querySelectorAll(".today-direction"), item => item.textContent);
      const pairLabels = expected[language][pair];
      // Rows: words L1→De, words De→L1, phrases L1→De, phrases De→L1.
      expect(labels).toEqual(pairLabels === null ? [] : [pairLabels[0], pairLabels[1], pairLabels[0], pairLabels[1]]);
    });
});
