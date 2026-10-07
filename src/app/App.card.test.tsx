import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { DictionarySearchResponse } from "../api/generated";
import { cardIdOf, cardView } from "../dictionary/card/cardTestData.test-support";
import { app, pairText, useWrittenAppEnvironment } from "../written/writtenApp.test-support";
import { response } from "../written/writtenFixtures.test-support";
import { App } from "./App";

useWrittenAppEnvironment();

const CARD = cardIdOf(3);
/** The real App with the dictionary and card routes of the synthetic server; context commands are answered here. */
function cardApp() {
  const a = app();
  const base = a.fetcher.getMockImplementation()!;
  let state = 1000, next = 600;
  const contexts = new Map<string, "open" | "closed">();
  a.fetcher.mockImplementation(async (url, init) => {
    const target = new URL(String(url), "http://localhost");
    if (target.pathname.endsWith("/dictionary/history")) return response({ state_version: "1", items: [] });
    if (target.pathname.endsWith("/dictionary/search")) {
      const query = target.searchParams.get("query")!;
      const body: DictionarySearchResponse = { state_version: "1", query, pair: "ru-de", mode: "words", next_cursor: null, similar: [],
        items: [{ card_id: CARD, revision: "1", lemma: "Haus", type: "noun", cefr: "A1",
          translation: { common: ["дом"], personal: null }, match_kind: "exact" }] };
      return response(body);
    }
    if (target.pathname.endsWith(`/dictionary/cards/${CARD}/view`)) return response({ state_version: String(state), current: cardView(CARD) });
    if (target.pathname.endsWith("/learning/current")) return response({ pair: "ru-de", state_version: String(state), manual_selection_version: "1",
      group: null, manual_selection: [], learning: { status: "new_group", ready: 0, preview: 0, next_due_at: null, new_group_size: 2,
        manual_eligible: 0, automatic_eligible: 2 } });
    const body = init?.method === "POST" && target.pathname.endsWith("/commands") ? JSON.parse(String(init.body)) : null;
    if (body?.kind === "context.open" || body?.kind === "context.close") {
      const contextId: string = body.kind === "context.open" ? `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}` : body.context_id;
      contexts.set(contextId, body.kind === "context.open" ? "open" : "closed");
      state++;
      const view = cardView(CARD); view.study.local_date = null;
      const reference = { id: contextId, kind: "dictionary", card_id: CARD };
      return response({ command: { id: body.command_id, kind: body.kind, status: "applied", applied_at: "2026-10-07T09:00:00Z", target_id: CARD,
        action_id: null, result_id: null, context_id: contextId, object_version: null },
        current: body.kind === "context.open" ? { status: "open", context: reference, view, interval: null,
          capabilities: { interval_increase: null, undo_offer: null, undo_target: null } } : { status: "closed", context: reference },
        state_version: String(state) });
    }
    return base(url, init);
  });
  const views = () => a.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/view")).length;
  let gate: Promise<void> | null = null;
  const inner = a.fetcher.getMockImplementation()!;
  a.fetcher.mockImplementation(async (url, init) => {
    if (gate && init?.method === "POST" && String(init.body).includes('"context.open"')) await gate;
    return inner(url, init);
  });
  /** Hold the next context.open replies until release() (M-CARD В6). */
  const hold = () => { let release!: () => void; gate = new Promise<void>(done => { release = done; }); return release; };
  return { ...a, contexts, views, hold };
}
const panelButton = (name: string) =>
  within(screen.getByRole("navigation", { name: "Основная навигация" })).getByRole("button", { name }) as HTMLButtonElement;
const field = () => screen.getByRole("textbox", { name: "Поиск" }) as HTMLInputElement;

async function openCard(a: ReturnType<typeof cardApp>) {
  render(<App />);
  await screen.findByText(pairText);
  fireEvent.click(panelButton("Словарь"));
  await screen.findByRole("heading", { name: "Словарь", level: 1 });
  fireEvent.change(field(), { target: { value: "Haus" } });
  const results = await screen.findByRole("region", { name: "Результаты" });
  fireEvent.click(await within(results).findByRole("button"));
  await screen.findByRole("main", { name: "Карточка" });
  await screen.findByText("В очереди на изучение");
  await waitFor(() => expect(a.kinds()).toEqual(["context.open"]));
  return a.posts()[0];
}

describe("M-CARD full card (М12) in the actual App document", () => {
  it("C1 dictionary → card: one /view read, context.open of this document; screen Back closes it and restores the search", async () => {
    const a = cardApp();
    const open = await openCard(a);
    expect(open.payload).toEqual({ card_id: CARD, source: { kind: "dictionary" } });
    expect(a.views()).toBe(1);
    // М12 has no bottom navigation (Р6); the dictionary stays mounted but hidden.
    expect(screen.queryByRole("navigation", { name: "Основная навигация" })).toBeNull();
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("das Haus");

    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    await screen.findByRole("heading", { name: "Словарь", level: 1 });
    expect(field().value).toBe("Haus");
    await waitFor(() => expect(a.kinds()).toEqual(["context.open", "context.close"]));
    const [contextId] = a.contexts.keys();
    expect(a.posts()[1]).toMatchObject({ context_id: contextId, document_id: open.document_id, client_instance_id: open.client_instance_id });
    expect(a.contexts.get(contextId)).toBe("closed");
  });

  it("C2 native Back runs the same transition: one close, back to the dictionary", async () => {
    const a = cardApp();
    await openCard(a);
    expect(a.back.bound).toBe(1);
    await a.back.click();
    await screen.findByRole("heading", { name: "Словарь", level: 1 });
    await waitFor(() => expect(a.kinds()).toEqual(["context.open", "context.close"]));
    // Back on the dictionary leads to Today, as before; no card command is sent again.
    await a.back.click();
    await screen.findByText(pairText);
    expect(a.kinds()).toEqual(["context.open", "context.close"]);
  });

  it("C3 Back before the open is confirmed returns at once; the close follows the confirmation (В6)", async () => {
    const a = cardApp(), release = a.hold();
    render(<App />);
    await screen.findByText(pairText);
    fireEvent.click(panelButton("Словарь"));
    await screen.findByRole("heading", { name: "Словарь", level: 1 });
    fireEvent.change(field(), { target: { value: "Haus" } });
    const results = await screen.findByRole("region", { name: "Результаты" });
    fireEvent.click(await within(results).findByRole("button"));
    await screen.findByText("В очереди на изучение");
    await waitFor(() => expect(a.kinds()).toEqual(["context.open"]));
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    await screen.findByRole("heading", { name: "Словарь", level: 1 });
    expect(screen.queryByRole("main", { name: "Карточка" })).toBeNull();
    expect(a.kinds()).toEqual(["context.open"]);
    release();
    await waitFor(() => expect(a.kinds()).toEqual(["context.open", "context.close"]));
    const [contextId] = a.contexts.keys();
    expect(a.contexts.get(contextId)).toBe("closed");
    // Native Back belongs to the dictionary again: it leads to Today.
    await a.back.click();
    await screen.findByText(pairText);
  });
});
