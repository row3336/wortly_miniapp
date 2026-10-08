// T+M-CARD-LINK (answer Q20, variant A): the bot's complaint button opens the Mini App with `?card=<id>`.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { cardIdOf, cardView } from "../dictionary/card/cardTestData.test-support";
import { app, exchange, pairText, useWrittenAppEnvironment } from "../written/writtenApp.test-support";
import { response } from "../written/writtenFixtures.test-support";
import { App } from "./App";
import { LaunchCard, launchCardId } from "./launchCard";

useWrittenAppEnvironment();
afterEach(() => { window.history.replaceState(null, "", "/"); });

const CARD = cardIdOf(3);
/** The real App over the synthetic server, with the card read and its context commands; `hidden` answers as for another user. */
function launchApp(options: { hidden?: boolean; active?: boolean } = {}) {
  const a = app({ active: options.active });
  const base = a.fetcher.getMockImplementation()!;
  let state = 1000, next = 600;
  a.fetcher.mockImplementation(async (url, init) => {
    const target = new URL(String(url), "http://localhost");
    if (target.pathname.endsWith("/view")) {
      return response({ state_version: String(state), current: options.hidden ? { status: "unavailable" } : cardView(CARD) });
    }
    if (target.pathname.endsWith("/learning/current")) return response({ pair: "ru-de", state_version: String(state), manual_selection_version: "1",
      group: null, manual_selection: [], learning: { status: "new_group", ready: 0, preview: 0, next_due_at: null, new_group_size: 2,
        manual_eligible: 0, automatic_eligible: 2 } });
    const body = init?.method === "POST" && target.pathname.endsWith("/commands") ? JSON.parse(String(init.body)) : null;
    if (body?.kind === "context.open" || body?.kind === "context.close") {
      const contextId: string = body.kind === "context.open" ? `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}` : body.context_id;
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
  const views = () => a.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/view")).map(([url]) => new URL(String(url), "http://localhost").pathname);
  return { ...a, views };
}
const launch = (search: string) => window.history.replaceState(null, "", `/${search}`);

describe("launchCardId: only one well-formed card id is taken from the query", () => {
  it("takes a UUID, in lower case", () => {
    expect(launchCardId(`?card=${CARD}`)).toBe(CARD);
    expect(launchCardId(`?v=2&card=${CARD.toUpperCase()}`)).toBe(CARD);
  });
  it.each(["", "?card=", "?card=Haus", `?card=${CARD}x`, `?card=../settings`, `?card=${CARD}&card=${CARD}`, `?cards=${CARD}`,
    `?card=${CARD.replaceAll("-", "")}`])("ignores %j", (search) => {
    expect(launchCardId(search)).toBeNull();
  });
  it("is taken once", () => {
    const card = new LaunchCard(CARD);
    expect(card.take()).toBe(CARD);
    expect(card.take()).toBeNull();
  });
});

describe("the launch card in the actual App document", () => {
  it("L1 opens the card over Today after the ordinary entry; Back returns to Today and closes its context", async () => {
    launch(`?card=${CARD}`);
    const a = launchApp();
    render(<App />);
    await screen.findByRole("main", { name: "Карточка" }, exchange);
    await screen.findByText("В очереди на изучение");
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("das\u00a0Haus");
    // The ordinary signed entry came first; the id is only in the card read's path.
    expect(a.fetcher.mock.calls.findIndex(([url]) => String(url).endsWith("/auth/telegram")))
      .toBeLessThan(a.fetcher.mock.calls.findIndex(([url]) => String(url).endsWith("/view")));
    expect(a.views()).toEqual([`/api/v1/dictionary/cards/${CARD}/view`]);
    await waitFor(() => expect(a.kinds()).toEqual(["context.open"]));
    expect(a.posts()[0].payload).toEqual({ card_id: CARD, source: { kind: "dictionary" } });

    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    await screen.findByText(pairText, undefined, exchange);
    expect(screen.queryByRole("main", { name: "Карточка" })).toBeNull();
    await waitFor(() => expect(a.kinds()).toEqual(["context.open", "context.close"]));
  });

  it("L2 native Back on the launch card closes it like the control and leads to Today", async () => {
    launch(`?card=${CARD}`);
    const a = launchApp();
    render(<App />);
    await screen.findByText("В очереди на изучение", undefined, exchange);
    await waitFor(() => expect(a.kinds()).toEqual(["context.open"]));
    await a.back.click();
    await screen.findByText(pairText, undefined, exchange);
    await waitFor(() => expect(a.kinds()).toEqual(["context.open", "context.close"]));
    // Today has no Back of its own; the card is not opened again.
    expect(a.views()).toHaveLength(1);
  });

  it("L3 a hidden card read by another user shows «Карточка недоступна»; Back returns to Today", async () => {
    launch(`?card=${CARD}`);
    const a = launchApp({ hidden: true });
    render(<App />);
    await screen.findByText("Карточка недоступна", undefined, exchange);
    expect(a.kinds()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    await screen.findByText(pairText, undefined, exchange);
  });

  it.each(["", "?card=Haus", `?card=${CARD}&card=${CARD}`, `#card=${CARD}`])("L4 the launch %j opens Today as before, no card read", async (search) => {
    launch(search);
    const a = launchApp();
    render(<App />);
    await screen.findByText(pairText, undefined, exchange);
    expect(screen.queryByRole("main", { name: "Карточка" })).toBeNull();
    expect(a.views()).toEqual([]);
  });

  it("L5 a start that resumes a session drops the launch card", async () => {
    launch(`?card=${CARD}`);
    const a = launchApp({ active: true });
    render(<App />);
    await screen.findByRole("textbox", undefined, exchange);
    expect(screen.queryByRole("main", { name: "Карточка" })).toBeNull();
    expect(a.views()).toEqual([]);
  });
});
