import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DictionaryCardContent, DictionarySearchResponse } from "../api/generated";
import { DICTIONARY_SEARCH_LIMITS } from "../dictionary/DictionaryHost";
import { app, pairText, useWrittenAppEnvironment } from "../written/writtenApp.test-support";
import { response } from "../written/writtenFixtures.test-support";
import { App } from "./App";

useWrittenAppEnvironment();

const cardId = (n: number) => `00000000-0000-4000-8000-${String(700 + n).padStart(12, "0")}`;
function content(n: number): DictionaryCardContent {
  return { pair: "ru-de", card: { id: cardId(n), revision: "1", lemma: `Karte${n}`, type: "noun", cefr: "A1" },
    translations: { common: [`карта${n}`], personal: null }, grammar: null, reference_conjugations: [],
    examples: { common: [], personal: null }, association: null };
}

/** The real App with the dictionary routes of the synthetic server: search, history and card text. */
function dictionaryApp() {
  const a = app();
  const history = [1, 2];
  const base = a.fetcher.getMockImplementation()!;
  a.fetcher.mockImplementation(async (url, init) => {
    const target = new URL(String(url), "http://localhost");
    if (target.pathname.endsWith("/dictionary/history")) {
      return response({ state_version: "1", items: history.map((n, k) => ({ card_id: cardId(n), opened_at: `2026-10-06T10:0${k}:00Z` })) });
    }
    const card = /\/dictionary\/cards\/([0-9a-f-]+)$/.exec(target.pathname);
    if (card) return response({ state_version: "1", current: content(Number(card[1].slice(-3)) - 700) });
    if (target.pathname.endsWith("/dictionary/search")) {
      const query = target.searchParams.get("query")!, mode = target.searchParams.get("mode") as "words" | "phrases";
      const type = mode === "phrases" ? "phrase" as const : "noun" as const;
      const body: DictionarySearchResponse = { state_version: "1", query, pair: "ru-de", mode, next_cursor: null, similar: [],
        items: [3, 4].map(n => ({ card_id: cardId(n), revision: "1", lemma: `${query}${n}`, type, cefr: null,
          translation: { common: [`дом${n}`], personal: null }, match_kind: "prefix" as const })) };
      return response(body);
    }
    return base(url, init);
  });
  const searches = () => a.fetcher.mock.calls.map(([url]) => new URL(String(url), "http://localhost"))
    .filter(url => url.pathname.endsWith("/dictionary/search")).map(url => Object.fromEntries(url.searchParams));
  return { ...a, searches };
}
const panelButton = (name: string) =>
  within(screen.getByRole("navigation", { name: "Основная навигация" })).getByRole("button", { name }) as HTMLButtonElement;
const field = () => screen.getByRole("textbox", { name: "Поиск" }) as HTMLInputElement;
const phrases = () => screen.getByRole("switch", { name: "Фразы" }) as HTMLInputElement;
const rows = (name: string) => within(screen.getByRole("region", { name })).getAllByRole("button");

let scrollTo: ReturnType<typeof vi.spyOn>;
beforeEach(() => { scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {}); });
afterEach(() => { Object.defineProperty(window, "scrollY", { value: 0, configurable: true }); });

describe("M-DICT dictionary (М11) in the actual App document", () => {
  it("D1 Today → Словарь → search → card → Back keeps query, mode and scroll; a new entry from Today clears it", async () => {
    const a = dictionaryApp(); render(<App />);
    await screen.findByText(pairText);
    fireEvent.click(panelButton("Словарь"));
    await screen.findByRole("heading", { name: "Словарь", level: 1 });
    // K07-097/K07-100: an empty words search with the field focused; K07-094: the account history.
    expect(field().value).toBe("");
    expect(phrases().checked).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(field()));
    await waitFor(() => expect(rows("История").map(row => row.querySelector("[lang='de']")!.textContent)).toEqual(["Karte1", "Karte2"]));

    fireEvent.click(phrases());
    fireEvent.change(field(), { target: { value: "Haus" } });
    await waitFor(() => expect(rows("Результаты")).toHaveLength(2));
    expect(a.searches().at(-1)).toEqual({ query: "Haus", mode: "phrases", limit: String(DICTIONARY_SEARCH_LIMITS.suggest) });
    const sent = a.searches().length;

    Object.defineProperty(window, "scrollY", { value: 360, configurable: true });
    fireEvent.click(rows("Результаты")[1]);
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Словарь", level: 1 })).toBeNull());
    expect(a.back.bound).toBe(1);

    await a.back.click();
    await screen.findByRole("heading", { name: "Словарь", level: 1 });
    expect(field().value).toBe("Haus");
    expect(phrases().checked).toBe(true);
    expect(rows("Результаты")).toHaveLength(2);
    await waitFor(() => expect(scrollTo).toHaveBeenLastCalledWith(0, 360));
    // K07-096/SP4e: the return rereads nothing of the search.
    expect(a.searches()).toHaveLength(sent);

    fireEvent.click(panelButton("Сегодня"));
    await screen.findByText(pairText);
    fireEvent.click(panelButton("Словарь"));
    await screen.findByRole("heading", { name: "Словарь", level: 1 });
    expect(field().value).toBe("");
    expect(phrases().checked).toBe(false);
    expect(screen.queryByRole("region", { name: "Результаты" })?.textContent ?? "").toBe("");
    expect(a.posts()).toEqual([]);
  });

  it("D2 the dictionary stays mounted but hidden on other sections and reads nothing there", async () => {
    const a = dictionaryApp(); render(<App />);
    await screen.findByText(pairText);
    fireEvent.click(panelButton("Словарь"));
    await screen.findByRole("heading", { name: "Словарь", level: 1 });
    fireEvent.change(field(), { target: { value: "Haus" } });
    await waitFor(() => expect(rows("Результаты")).toHaveLength(2));
    fireEvent.click(panelButton("Настройки"));
    await screen.findByRole("heading", { name: "Настройки", level: 1 });
    const calls = a.fetcher.mock.calls.length;
    expect(screen.queryByRole("heading", { name: "Словарь", level: 1 })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Поиск", hidden: true }).closest("[hidden]")).not.toBeNull();
    await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });
    expect(a.fetcher.mock.calls.slice(calls).some(([url]) => String(url).includes("/dictionary/"))).toBe(false);
  });
});
