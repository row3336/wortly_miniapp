import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { cardView, reviewing } from "../dictionary/card/cardTestData.test-support";
import { answer, app, startWords, useWrittenAppEnvironment } from "../written/writtenApp.test-support";
import { id, response } from "../written/writtenFixtures.test-support";
import { App } from "./App";

useWrittenAppEnvironment();

const CARD_6 = id(106);
/**
 * The real App over the synthetic written server plus the card endpoints of core (view, context, card.exclude). One
 * profile state version for both, as in core: the quiz reads its session at least as new as the card action.
 */
function actionsApp() {
  const a = app({ cards: [6, 7, 8] });
  const s = a.server.state, base = a.fetcher.getMockImplementation()!;
  const card = { excluded: false, version: null as string | null, next: 700, posts: [] as Record<string, any>[],
    contexts: new Map<string, "open" | "closed">() };
  const view = (localDate: string | null = "2026-10-07") => {
    const value = reviewing(cardView(CARD_6));
    if (card.excluded) {
      value.study.facts.exclusion = { excluded: true, version: card.version };
      Object.assign(value.study.directions[0], { schedule: null, interval_preview: null });
      value.card_actions = { exclude: false, return: true, relearn: false };
    }
    value.study.local_date = localDate;
    if (localDate === null) value.study.directions.forEach(direction => { direction.interval_preview = null; });
    return value;
  };
  const context = (contextId: string) => {
    const status = card.contexts.get(contextId), reference = { id: contextId, kind: "dictionary", card_id: CARD_6 };
    return status === "open" ? { status, context: reference, view: view(null), interval: null,
      capabilities: { interval_increase: null, undo_offer: null, undo_target: null } } : { status: "closed", context: reference };
  };
  a.fetcher.mockImplementation(async (url, init) => {
    const target = new URL(String(url), "http://localhost");
    if (target.pathname.endsWith(`/dictionary/cards/${CARD_6}/view`)) return response({ state_version: String(s.version), current: view() });
    if (target.pathname.includes("/dictionary/contexts/")) {
      return response({ state_version: String(s.version), current: context(target.pathname.split("/").at(-1)!) });
    }
    if (target.pathname.endsWith("/learning/current")) return response({ pair: "ru-de", state_version: String(s.version),
      manual_selection_version: "1", group: null, manual_selection: [], learning: { status: "new_group", ready: 0, preview: 0,
        next_due_at: null, new_group_size: 2, manual_eligible: 0, automatic_eligible: 2 } });
    const body = init?.method === "POST" && target.pathname.endsWith("/commands") ? JSON.parse(String(init.body)) : null;
    if (!body || !(String(body.kind).startsWith("context.") || String(body.kind).startsWith("card."))) return base(url, init);
    card.posts.push(body);
    const fact = (extra: Record<string, unknown>) => ({ id: body.command_id, kind: body.kind, status: "applied",
      applied_at: "2026-10-07T09:00:00Z", result_id: null, ...extra });
    if (body.kind === "context.open" || body.kind === "context.close") {
      const contextId: string = body.kind === "context.open" ? id(card.next++) : body.context_id;
      card.contexts.set(contextId, body.kind === "context.open" ? "open" : "closed");
      s.version++;
      return response({ command: fact({ target_id: CARD_6, action_id: null, context_id: contextId, object_version: null }),
        current: context(contextId), state_version: String(s.version) });
    }
    if (body.kind !== "card.exclude") return response({ error: { code: "UNEXPECTED" } }, 500);
    card.excluded = true; card.version = "1"; s.version++;
    return response({ command: fact({ target_id: CARD_6, action_id: id(777), context_id: null, object_version: "1" }),
      current: { status: "available", card_id: CARD_6, pair: "ru-de", excluded: true, version: "1",
        actions: { exclude: false, return: true, relearn: false } }, state_version: String(s.version) });
  });
  return { ...a, card };
}
const quizKinds = (a: ReturnType<typeof actionsApp>) => a.kinds().filter(kind => !kind.startsWith("context.") && !kind.startsWith("card."));

describe("card actions from the written quiz through the actual App (M-ACTIONS)", () => {
  it("A1 «Уточнить поля» opens the answered card with its editors; «Назад» returns to the same result of the quiz", async () => {
    const a = actionsApp(); render(<App />);
    await startWords(); await answer("falsch");
    fireEvent.click(screen.getByRole("button", { name: "Уточнить поля" }));
    const pencil = await screen.findByRole("button", { name: "Изменить личный перевод" }) as HTMLButtonElement;
    // The pencils wait for the open card context (M-EDIT Р12).
    await waitFor(() => expect(pencil.disabled).toBe(false));
    expect(screen.queryByText("Есть ошибка")).toBeNull();
    // The quiz origin: only its own direction (К07-056).
    await screen.findByText("Интервал: 3 дн.");
    expect(screen.queryByText("Интервал: 8 дн.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    await screen.findByText("Есть ошибка");
    expect(screen.getByRole("button", { name: "Далее" })).toBeTruthy();
    expect(quizKinds(a)).toEqual(["session.start", "assignment.present", "answer.submit"]);
    await waitFor(() => expect(a.card.posts.map(post => post.kind)).toEqual(["context.open", "context.close"]));
  });

  it("A2 «Не повторять» on the card opened from the quiz: after the commit the quiz goes on to the next question by itself", async () => {
    const a = actionsApp(); render(<App />);
    await startWords(); await answer("falsch");
    fireEvent.click(screen.getByRole("button", { name: "Уточнить поля" }));
    fireEvent.click(await screen.findByRole("button", { name: "Не повторять" }));
    await screen.findByText("слово 7");
    expect(screen.queryByText("Есть ошибка")).toBeNull();
    expect(a.card.posts.map(post => post.kind)).toEqual(["context.open", "card.exclude", "context.close"]);
    expect(a.card.posts[1]).toMatchObject({ expected_card_state_version: null, payload: { card_id: CARD_6 } });
    await waitFor(() => expect(quizKinds(a)).toEqual(["session.start", "assignment.present", "answer.submit", "assignment.present"]));
  });
});
