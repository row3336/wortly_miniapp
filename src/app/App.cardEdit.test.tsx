import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { DictionarySearchResponse } from "../api/generated";
import { cardIdOf, cardView } from "../dictionary/card/cardTestData.test-support";
import { app, pairText, useWrittenAppEnvironment } from "../written/writtenApp.test-support";
import { response } from "../written/writtenFixtures.test-support";
import { App } from "./App";

useWrittenAppEnvironment();

const CARD = cardIdOf(4);
/** The real App with dictionary, card, card context and own translation commands of the synthetic server (M-EDIT CP2). */
function editApp() {
  const a = app();
  const base = a.fetcher.getMockImplementation()!;
  let state = 1000, next = 700, personal: { value: string; version: string } | null = null, version = 1n;
  const contexts = new Map<string, "open" | "closed">();
  const view = () => { const value = cardView(CARD); value.content.translations.personal = personal;
    value.content.field_versions.translation = String(version); return value; };
  a.fetcher.mockImplementation(async (url, init) => {
    const target = new URL(String(url), "http://localhost");
    if (target.pathname.endsWith("/dictionary/history")) return response({ state_version: "1", items: [] });
    if (target.pathname.endsWith("/dictionary/search")) {
      const body: DictionarySearchResponse = { state_version: "1", query: target.searchParams.get("query")!, pair: "ru-de", mode: "words",
        next_cursor: null, similar: [], items: [{ card_id: CARD, revision: "1", lemma: "Haus", type: "noun", cefr: "A1",
          translation: { common: ["дом"], personal: null }, match_kind: "exact" }] };
      return response(body);
    }
    if (target.pathname.endsWith(`/dictionary/cards/${CARD}/view`)) return response({ state_version: String(state), current: view() });
    if (target.pathname.endsWith("/learning/current")) return response({ pair: "ru-de", state_version: String(state), manual_selection_version: "1",
      group: null, manual_selection: [], learning: { status: "new_group", ready: 0, preview: 0, next_due_at: null, new_group_size: 2,
        manual_eligible: 0, automatic_eligible: 2 } });
    const context = (contextId: string) => {
      const reference = { id: contextId, kind: "dictionary", card_id: CARD };
      const shown = view(); shown.study.local_date = null;
      return contexts.get(contextId) === "open" ? { status: "open", context: reference, view: shown, interval: null,
        capabilities: { interval_increase: null, undo_offer: null, undo_target: null } } : { status: "closed", context: reference };
    };
    if (target.pathname.includes("/dictionary/contexts/")) {
      return response({ state_version: String(state), current: context(target.pathname.split("/").at(-1)!) });
    }
    const body = init?.method === "POST" && target.pathname.endsWith("/commands") ? JSON.parse(String(init.body)) : null;
    const fact = (extra: Record<string, unknown>) => ({ id: body.command_id, kind: body.kind, status: "applied",
      applied_at: "2026-10-07T09:00:00Z", result_id: null, ...extra });
    if (body?.kind === "context.open" || body?.kind === "context.close") {
      const contextId: string = body.kind === "context.open" ? `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}` : body.context_id;
      contexts.set(contextId, body.kind === "context.open" ? "open" : "closed");
      state++;
      return response({ command: fact({ target_id: CARD, action_id: null, context_id: contextId, object_version: null }),
        current: context(contextId), state_version: String(state) });
    }
    if (body?.kind === "field.save") {
      version++; state++;
      personal = { value: body.payload.value.trim(), version: String(version) };
      const action = "00000000-0000-4000-8000-000000000777";
      return response({ command: fact({ target_id: "00000000-0000-4000-8000-000000000600", action_id: action, context_id: body.context_id,
        object_version: String(version) }), current: { status: "available", card_id: CARD, language: "ru", card_revision: "1",
        field_name: "translation", field_version: String(version), personal, common_translations: ["дом"], common_examples: null,
        undo_target: { action_id: action, kind: "field.save", version: "1", context_id: body.context_id } }, state_version: String(state) });
    }
    return base(url, init);
  });
  return { ...a, contexts };
}
const panelButton = (name: string) =>
  within(screen.getByRole("navigation", { name: "Основная навигация" })).getByRole("button", { name }) as HTMLButtonElement;

async function openCard(a: ReturnType<typeof editApp>) {
  render(<App />);
  await screen.findByText(pairText);
  fireEvent.click(panelButton("Словарь"));
  await screen.findByRole("heading", { name: "Словарь", level: 1 });
  fireEvent.change(screen.getByRole("textbox", { name: "Поиск" }), { target: { value: "Haus" } });
  const results = await screen.findByRole("region", { name: "Результаты" });
  fireEvent.click(await within(results).findByRole("button"));
  await screen.findByRole("main", { name: "Карточка" });
  await waitFor(() => expect(a.kinds()).toEqual(["context.open"]));
  const pencil = await screen.findByRole("button", { name: "Изменить личный перевод" }) as HTMLButtonElement;
  await waitFor(() => expect(pencil.disabled).toBe(false));
  return pencil;
}

describe("M-EDIT own translation in the actual App document (М12)", () => {
  it("X1 the saved personal translation replaces the common one on the card; the command carries this document", async () => {
    const a = editApp();
    fireEvent.click(await openCard(a));
    const region = screen.getByRole("region", { name: "Перевод" });
    fireEvent.change(within(region).getByRole("textbox"), { target: { value: " домишко " } });
    fireEvent.click(within(region).getByRole("button", { name: "Сохранить" }));
    await within(screen.getByRole("region", { name: "Перевод" })).findByText("Личный перевод");
    expect(within(screen.getByRole("region", { name: "Перевод" })).getByText("домишко")).toBeTruthy();
    const [open, save] = a.posts();
    expect(save).toMatchObject({ kind: "field.save", document_id: open.document_id, client_instance_id: open.client_instance_id,
      context_id: [...a.contexts.keys()][0], payload: { value: " домишко ", field_name: "translation" } });
    expect(screen.getByRole("button", { name: "Шаг назад" })).toBeTruthy();
  });

  it("X2 native Back with unsaved text asks; «Выйти без сохранения» returns to the dictionary and closes the context", async () => {
    const a = editApp();
    fireEvent.click(await openCard(a));
    fireEvent.change(within(screen.getByRole("region", { name: "Перевод" })).getByRole("textbox"), { target: { value: "x" } });
    await a.back.click();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("main", { name: "Карточка" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Выйти без сохранения" }));
    await screen.findByRole("heading", { name: "Словарь", level: 1 });
    await waitFor(() => expect(a.kinds()).toEqual(["context.open", "context.close"]));
  });
});
