import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { emptyStatistics, statisticsData } from "../statistics/statisticsFixtures.test-support";
import { app, pairText, useWrittenAppEnvironment } from "../written/writtenApp.test-support";
import { App } from "./App";

useWrittenAppEnvironment();

type Harness = ReturnType<typeof app>;
const overviewCalls = (a: Harness) => a.fetcher.mock.calls.filter(([url]) => new URL(String(url), "http://localhost").pathname.endsWith("/statistics/overview"));
const weeks = (a: Harness) => overviewCalls(a).map(([url]) => new URL(String(url), "http://localhost").searchParams.get("week"));

/** Serves GET /statistics/overview over the shared synthetic server; `reply` decides each answer. */
function serveStatistics(a: Harness, reply: (week: "current" | "previous", call: number) => Response | Promise<Response>) {
  const base = a.fetcher.getMockImplementation()!;
  let call = 0;
  a.fetcher.mockImplementation(async (url, init) => {
    const target = new URL(String(url), "http://localhost");
    if (!target.pathname.endsWith("/statistics/overview")) return base(url, init);
    return reply(target.searchParams.get("week") as "current" | "previous", ++call);
  });
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const version = (a: Harness) => String(a.server.state.version);
const open = async () => {
  // The first render of a cold App is slow under a parallel run; this is a wait, not a timing assertion.
  await screen.findByText(pairText, undefined, { timeout: 10000 });
  fireEvent.click(screen.getByRole("button", { name: "Статистика" }));
  await screen.findByRole("heading", { name: "Статистика", level: 1 });
};
const card = (name: string) => within(screen.getByRole("region", { name }));
const value = (name: string, label: string) => card(name).getByText(label).nextElementSibling?.textContent;

// M-STAT through the actual App document: the entry from Today, the server numbers, the week, the refresh on entry,
// on return to the foreground and by hand (TA:166, TA:362, К09-063…068).
describe("M-STAT statistics screen through the actual App document", () => {
  it("S1 opens from Today, reads the current week once and shows the server numbers; nothing is written", async () => {
    const a = app(); serveStatistics(a, week => json(statisticsData(week, {}, version(a))));
    render(<App />); await open();
    await screen.findByRole("region", { name: "Изучено" });
    expect(weeks(a)).toEqual(["current"]);
    expect(value("Изучено", "Слова")).toBe("9"); expect(value("Изучено", "Фразы")).toBe("2");
    expect(value("Результаты слов", "Слов с серией 5+")).toBe("6");
    expect(screen.queryByRole("region", { name: "Показатель владельца" })).toBeNull();
    expect(a.posts()).toEqual([]);
  });

  it("S2 shows a busy indicator, not numbers, until the answer arrives", async () => {
    const a = app(); let release!: () => void;
    serveStatistics(a, week => new Promise<Response>(resolve => { release = () => resolve(json(statisticsData(week, {}, version(a)))); }));
    render(<App />); await open();
    const status = await screen.findByRole("status");
    expect(status.textContent).toBe("Загружаем статистику");
    expect(screen.queryByRole("region", { name: "Изучено" })).toBeNull();
    await act(async () => { release(); });
    await screen.findByRole("region", { name: "Изучено" });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("S3 a real zero answer is not an error; a failed load is not zeros, and Retry reads again", async () => {
    const a = app();
    serveStatistics(a, (week, call) => call === 1 ? json({ error: { code: "UNAVAILABLE" } }, 503) : call === 2
      ? json(emptyStatistics(week, version(a))) : json(statisticsData(week, {}, version(a))));
    render(<App />); await open();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Не удалось загрузить статистику");
    expect(screen.queryByRole("region", { name: "Изучено" })).toBeNull();
    expect(weeks(a)).toEqual(["current"]);
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    await screen.findByRole("region", { name: "Изучено" });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(value("Изучено", "Слова")).toBe("0"); expect(value("База", "Всего")).toBe("0");
    expect(weeks(a)).toEqual(["current", "current"]);
  });

  it("S4 the week switch reads the other week; a new entry starts again with the current one", async () => {
    const a = app(); serveStatistics(a, week => json(statisticsData(week, {}, version(a))));
    render(<App />); await open();
    await screen.findByRole("region", { name: "Изучено" });
    const first = card("Практика по дням").getAllByRole("cell")[0].textContent;
    fireEvent.click(screen.getByRole("button", { name: "Прошлая неделя" }));
    await waitFor(() => expect(card("Практика по дням").getAllByRole("cell")[0].textContent).not.toBe(first));
    expect(weeks(a)).toEqual(["current", "previous"]);
    expect(screen.getByRole("button", { name: "Прошлая неделя" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    await screen.findByText(pairText);
    fireEvent.click(screen.getByRole("button", { name: "Статистика" }));
    await screen.findByRole("region", { name: "Изучено" });
    expect(weeks(a)).toEqual(["current", "previous", "current"]);
    expect(screen.getByRole("button", { name: "Эта неделя" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("S5 a return to the foreground reads the numbers again and shows the new ones", async () => {
    const a = app(); let learned = 9;
    serveStatistics(a, week => json(statisticsData(week, { learned: { words: learned, phrases: 2 } }, version(a))));
    render(<App />); await open();
    await screen.findByRole("region", { name: "Изучено" });
    expect(value("Изучено", "Слова")).toBe("9");
    learned = 12;
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    await waitFor(() => expect(value("Изучено", "Слова")).toBe("12"));
    expect(weeks(a)).toEqual(["current", "current"]);
  });

  it("S6 Back and native Back return to Today; the owner block follows the server key", async () => {
    const a = app();
    const profiles = [{ profile_id: "11111111-1111-4111-8111-111111111111", words: 14, phrases: 3 }];
    serveStatistics(a, week => json(statisticsData(week, { owner_metric: { profiles } }, version(a))));
    render(<App />); await open();
    await screen.findByRole("region", { name: "Показатель владельца" });
    expect(a.back.bound).toBe(1);
    await a.back.click();
    await screen.findByText(pairText);
    expect(a.back.bound).toBe(0); expect(a.posts()).toEqual([]);
  });
});
