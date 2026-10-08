import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Language } from "../i18n/language";
import { StatisticsScreen, type StatisticsScreenProps } from "./StatisticsScreen";
import type { StatisticsSnapshot } from "./statisticsController";
import { emptyStatistics, statisticsData } from "./statisticsFixtures.test-support";

afterEach(cleanup);

const ready = (data = statisticsData()): StatisticsSnapshot => ({ phase: "ready", pair: data.pair, week: "current", data, problem: null });
const failed = (problem: NonNullable<StatisticsSnapshot["problem"]>): StatisticsSnapshot =>
  ({ phase: "failed", pair: "ru-de", week: "current", data: null, problem });
const loading: StatisticsSnapshot = { phase: "loading", pair: "ru-de", week: "current", data: null, problem: null };

function show(state: StatisticsSnapshot, patch: Partial<StatisticsScreenProps> = {}) {
  const props: StatisticsScreenProps = { state, week: "current", language: "ru", onWeek: vi.fn(), onRetry: vi.fn(), onBack: vi.fn(), ...patch };
  render(<StatisticsScreen {...props} />);
  return props;
}
const card = (name: string) => within(screen.getByRole("region", { name }));
/** «label → value» pairs of one card in document order. */
const pairs = (name: string) => card(name).getAllByRole("term").map(term => [term.textContent, term.nextElementSibling?.textContent]);

describe("statistics screen: states", () => {
  it("shows a busy indicator with no numbers while the server is read", () => {
    show(loading);
    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-busy")).toBe("true");
    expect(status.textContent).toBe("Загружаем статистику");
    expect(screen.queryByRole("table")).toBeNull(); expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each(["load", "stale_response", "pair_changed"] as const)("a %s failure is an alert with a retry and no numbers", problem => {
    const props = show(failed(problem));
    expect(screen.getByRole("alert").textContent).toMatch(/статистик|устаревшие|Пара языков/);
    expect(screen.queryByText("0")).toBeNull(); expect(screen.queryByRole("table")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(props.onRetry).toHaveBeenCalledOnce();
  });

  it.each(["expired", "forbidden"] as const)("a %s denial asks to reopen through the bot and offers no retry", problem => {
    show(failed(problem));
    expect(screen.getByRole("alert").textContent).toContain("Открой Wortly снова через бота");
    expect(screen.queryByRole("button", { name: "Повторить" })).toBeNull();
  });

  it("a real server answer of zeros is shown as zeros, not as an error or a missing value", () => {
    show(ready(emptyStatistics()));
    expect(screen.queryByRole("alert")).toBeNull(); expect(screen.queryByRole("status")).toBeNull();
    // The only dash is the practice table's reverse direction, which has no data by design.
    expect(screen.queryAllByText("—")).toHaveLength(7);
    for (const name of ["Изучено", "Добавлено в базу", "Ещё не начинал"]) {
      expect(pairs(name)).toEqual([["Слова", "0"], ["Фразы", "0"]]);
    }
    expect(pairs("Результаты слов").every(([, value]) => value === "0")).toBe(true);
    const rows = card("Практика по дням").getAllByRole("row").slice(1);
    expect(rows).toHaveLength(7);
    for (const row of rows) expect(within(row).getAllByRole("cell").map(cell => cell.textContent)).toEqual(["0", "0", "—"]);
  });

  it("keeps the back control and the week switch in every state", () => {
    for (const state of [loading, failed("load"), ready()]) {
      const props = show(state);
      fireEvent.click(screen.getByRole("button", { name: "Назад" }));
      expect(props.onBack).toHaveBeenCalledOnce();
      expect(screen.getByRole("group", { name: "Период" })).toBeTruthy();
      cleanup();
    }
  });
});

describe("statistics screen: composition of K9", () => {
  it("shows the server numbers under their own labels", () => {
    show(ready());
    expect(pairs("Изучено")).toEqual([["Слова", "9"], ["Фразы", "2"]]);
    expect(pairs("Добавлено в базу")).toEqual([["Слова", "4"], ["Фразы", "3"]]);
    expect(pairs("Ещё не начинал")).toEqual([["Слова", "8"], ["Фразы", "1"]]);
    expect(pairs("База").slice(0, 3)).toEqual([["Всего", "30"], ["Слова", "25"], ["Фразы", "5"]]);
    expect(pairs("База").slice(3)).toEqual([["Существительные", "12"], ["Глаголы", "5"], ["Фразы", "5"], ["Прилагательные", "3"],
      ["Местоимения", "2"], ["Наречия", "1"], ["Предлоги", "1"], ["Союзы", "1"], ["Частицы", "0"]]);
    expect(pairs("Результаты слов")).toEqual([["Последний ответ неверный", "4"], ["Слов с серией 1", "3"], ["Слов с серией 2", "2"],
      ["Слов с серией 3", "5"], ["Слов с серией 4", "1"], ["Слов с серией 5+", "6"]]);
  });

  it("lists the four ready counts with the direction arrow of the dictionary pair", () => {
    show(ready());
    expect(pairs("Готово к повтору")).toEqual([
      ["Рус → Нем Слова: перевод на немецкий", "7"], ["Нем → Рус Слова: перевод с немецкого", "6"],
      ["Рус → Нем Фразы: перевод на немецкий", "3"], ["Нем → Рус Фразы: перевод с немецкого", "2"]]);
  });

  it("names the direction in words when the pair has no abbreviation (en-de, M-NAV Q57)", () => {
    show(ready(statisticsData("current", {}, "1", "en-de")), { language: "ru" });
    expect(pairs("Готово к повтору").map(([label]) => label)).toEqual(["Слова: перевод на немецкий", "Слова: перевод с немецкого",
      "Фразы: перевод на немецкий", "Фразы: перевод с немецкого"]);
  });

  it("shows the practice of each local day of the week, words and phrases apart", () => {
    show(ready());
    const rows = card("Практика по дням").getAllByRole("row").slice(1);
    expect(rows.map(row => within(row).getAllByRole("cell").map(cell => cell.textContent)))
      .toEqual([["11", "21", "—"], ["12", "22", "—"], ["13", "23", "—"], ["14", "24", "—"], ["15", "25", "—"], ["16", "26", "—"], ["17", "27", "—"]]);
  });

  it.each([
    ["ru", "Практика по дням", "Немецкий → родной", "В письменном квизе такого направления нет"],
    ["uk", "Практика за днями", "Німецька → рідна", "У письмовому квізі такого напрямку немає"],
    ["en", "Practice by day", "German → native", "The written quiz has no such direction"],
  ] as const)("explains the missing reverse direction in %s and shows no conjugation figure", (language, title, header, note) => {
    show(ready(), { language });
    const practice = card(title);
    expect(practice.getByRole("columnheader", { name: header })).toBeTruthy();
    expect(practice.getByText(new RegExp(note))).toBeTruthy();
    expect(practice.queryByText(/спряж|спряг|conjugat/i)).toBeNull();
  });

  it("never shifts the server's local dates by the device time zone", () => {
    // A zone behind UTC turns 2026-09-28T00:00Z into the 27th unless the formatter is pinned to UTC; the zone is fixed here
    // so the check does not depend on where the suite runs.
    const saved = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      // Guard: the switch must really take effect, otherwise this test would pass vacuously.
      expect(new Date("2026-09-28T00:00:00Z").getDate()).toBe(27);
      show(ready());
      const rows = card("Практика по дням").getAllByRole("row").slice(1);
      expect(within(rows[0]).getByRole("rowheader").textContent).toMatch(/(^|\D)28(\D|$)/);
      expect(within(rows[6]).getByRole("rowheader").textContent).toMatch(/(^|\D)4(\D|$)/);
      expect(screen.getByText(/^Неделя 28 .+ – 4 .+ 2026/)).toBeTruthy();
    } finally {
      if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
    }
  });

  it("renders no percentage, chart or whole-base knowledge figure (TA:326)", () => {
    const { container } = render(<StatisticsScreen state={ready()} week="current" language="ru" onWeek={vi.fn()} onRetry={vi.fn()} onBack={vi.fn()} />);
    expect(container.textContent).not.toMatch(/%/);
    expect(container.querySelector("svg, canvas, progress, meter")).toBeNull();
  });

  it("shows the owner metric only when the server sent the key", () => {
    show(ready());
    expect(screen.queryByRole("region", { name: "Показатель владельца" })).toBeNull();
    cleanup();
    const profiles = [{ profile_id: "11111111-1111-4111-8111-111111111111", words: 14, phrases: 3 },
      { profile_id: "22222222-2222-4222-8222-222222222222", words: 0, phrases: 0 }];
    show(ready(statisticsData("current", { owner_metric: { profiles } })));
    const rows = card("Показатель владельца").getAllByRole("row").slice(1);
    expect(rows.map(row => [within(row).getByRole("rowheader").textContent, ...within(row).getAllByRole("cell").map(cell => cell.textContent)]))
      .toEqual([["Профиль 1 · 11111111", "14", "3"], ["Профиль 2 · 22222222", "0", "0"]]);
  });

  it("an owner list with no profiles is an empty table, not a missing block", () => {
    show(ready(statisticsData("current", { owner_metric: { profiles: [] } })));
    expect(card("Показатель владельца").getAllByRole("row")).toHaveLength(1);
  });
});

describe("statistics screen: week and language", () => {
  it("marks the selected week and reports the other one", () => {
    const props = show(ready(), { week: "current" });
    const current = screen.getByRole("button", { name: "Эта неделя" }), previous = screen.getByRole("button", { name: "Прошлая неделя" });
    expect(current.getAttribute("aria-pressed")).toBe("true"); expect(previous.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(previous);
    expect(props.onWeek).toHaveBeenCalledWith("previous");
  });

  it.each([["uk", "Статистика", "Вивчено"], ["en", "Statistics", "Learned"]] as [Language, string, string][])(
    "%s copy: title and a section", (language, title, learned) => {
      show(ready(), { language });
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(title);
      expect(screen.getByRole("region", { name: learned })).toBeTruthy();
    });
});
