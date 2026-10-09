import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenedClient } from "../../api/generated";
import { createOpenedAccess } from "../../app/openedAccess";
import { ManualPendingStore } from "../../learning/manualPending";
import type { AsyncStorage } from "../../platform/storage";
import { CardHost, type CardHostProps } from "../card/CardHost";
import type { CardOrigin } from "../card/cardOrigin";
import { CARD, cardView, reviewing } from "../card/cardTestData.test-support";
import { aid, json, profileCurrent } from "./actionTestData.test-support";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

/** Core-shaped card endpoints: view, context, Learning state, card.exclude/return/relearn and feedback.send. */
/** gate: the context.open reply is built when the server applies it and delivered only once the gate opens. */
function server(gate?: Promise<void>) {
  const s = { state: 10, excluded: false, version: null as string | null, next: 500, posts: [] as Record<string, any>[],
    contexts: new Map<string, "open" | "closed">(), inbox: new Map<string, string>() };
  const view = (localDate: string | null = "2026-10-07") => {
    const value = reviewing(cardView(CARD));
    if (s.excluded) {
      value.study.facts.exclusion = { excluded: true, version: s.version };
      Object.assign(value.study.directions[0], { schedule: null, interval_preview: null });
      value.card_actions = { exclude: false, return: true, relearn: false };
    }
    value.study.local_date = localDate;
    if (localDate === null) value.study.directions.forEach(direction => { direction.interval_preview = null; });
    return value;
  };
  const context = (contextId: string) => {
    const status = s.contexts.get(contextId), reference = { id: contextId, kind: "dictionary", card_id: CARD };
    return status === "open" ? { status, context: reference, view: view(null), interval: null,
      capabilities: { interval_increase: null, undo_offer: null, undo_target: null } } : status === "closed" ? { status, context: reference }
      : { status: "unavailable" };
  };
  const actions = () => ({ status: "available", card_id: CARD, pair: "ru-de", excluded: s.excluded, version: s.version,
    actions: s.excluded ? { exclude: false, return: true, relearn: false } : { exclude: true, return: false, relearn: true } });
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input), "http://local");
    if (url.pathname === `/api/v1/dictionary/cards/${CARD}/view`) return json({ state_version: String(s.state), current: view() });
    if (url.pathname.startsWith("/api/v1/dictionary/contexts/")) return json({ state_version: String(s.state), current: context(url.pathname.split("/").at(-1)!) });
    if (url.pathname === "/api/v1/learning/current") return json({ pair: "ru-de", state_version: String(s.state), manual_selection_version: "1",
      group: null, manual_selection: [], learning: { status: "new_group", ready: 0, preview: 0, next_due_at: null, new_group_size: 2,
        manual_eligible: 0, automatic_eligible: 2 } });
    if (url.pathname !== "/api/v1/commands" || init!.method !== "POST") throw new Error(`unexpected ${init!.method} ${input}`);
    const body = JSON.parse(String(init!.body));
    s.posts.push(body);
    s.state++;
    const fact = (extra: Record<string, unknown>) => ({ id: body.command_id, kind: body.kind, status: "applied", applied_at: "2026-10-07T09:00:00Z",
      result_id: null, action_id: null, context_id: null, object_version: null, ...extra });
    if (body.kind === "context.open" || body.kind === "context.close") {
      let contextId: string = body.context_id;
      if (body.kind === "context.open") { contextId = aid(s.next++); s.contexts.set(contextId, "open"); } else s.contexts.set(contextId, "closed");
      const reply = json({ command: fact({ target_id: CARD, context_id: contextId }), current: context(contextId), state_version: String(s.state) });
      if (body.kind === "context.open" && gate) await gate;
      return reply;
    }
    if (body.kind === "feedback.send") {
      s.inbox.set(body.command_id, aid(950));
      return json({ command: fact({ target_id: aid(950) }), current: { inbox_id: aid(950), card_id: body.payload.card_id ?? null },
        state_version: String(s.state) });
    }
    s.excluded = body.kind === "card.exclude" ? true : body.kind === "card.return" ? false : s.excluded;
    const objectVersion = body.kind === "card.relearn" ? "3" : String(Number(s.version ?? "0") + 1);
    if (body.kind !== "card.relearn") s.version = objectVersion;
    return json({ command: fact({ target_id: CARD, action_id: aid(777), object_version: objectVersion }), current: actions(),
      state_version: String(s.state) });
  });
  return Object.assign(s, { fetcher });
}

function fixture(origin: CardOrigin, gate?: Promise<void>) {
  const srv = server(gate), values = new Map<string, string>();
  const storage: AsyncStorage = { get: async key => values.get(key) ?? null, set: async (key, value) => { values.set(key, value); },
    remove: async key => { values.delete(key); } };
  const opened: OpenedClient = { status: "opened", client_instance_id: aid(1), document_id: aid(2), document_epoch: "1", proof_version: "1",
    profile: profileCurrent() as OpenedClient["profile"], session: null, compatibility: { compatible: true, contract_version: "1" } };
  let next = 100;
  const onBack = vi.fn(), onStudyAction = vi.fn();
  const props: CardHostProps = { access: createOpenedAccess({ opened, token: "synthetic-action-token", proof: "synthetic-action-proof",
    generation: 1, isLive: () => true, onDenied: () => {} }), transport: { fetcher: srv.fetcher, timeoutMs: 5000, maxResponseBytes: 1_000_000 },
    language: "ru", pendingStore: new ManualPendingStore(storage), cardId: CARD, origin, newId: () => aid(next++), onBack, onStudyAction };
  return { srv, props, onBack, onStudyAction, values };
}
const exchange = { timeout: 5000 };
const reads = (srv: ReturnType<typeof server>, part: string) =>
  srv.fetcher.mock.calls.filter(([url, init]) => init!.method === "GET" && String(url).includes(part)).length;

describe("card actions in the card host (M-ACTIONS CP2)", () => {
  it("H1 from the dictionary «Не повторять» keeps the card and shows its new state from a new read", async () => {
    const f = fixture({ kind: "dictionary" });
    render(<CardHost {...f.props} />);
    // Every wait below is for a server exchange (card read, command, card read again): a network-sized bound, not 1 s.
    fireEvent.click(await screen.findByRole("button", { name: "Не повторять" }, exchange));
    await screen.findByText("Основные письменные повторы выключены", undefined, exchange);
    expect(await screen.findByRole("button", { name: "Вернуть в повторы" }, exchange)).toBeTruthy();
    expect(f.onBack).not.toHaveBeenCalled();
    expect(f.onStudyAction).toHaveBeenCalledWith({ kind: "card.exclude", cardId: CARD, stateVersion: expect.stringMatching(/^[1-9][0-9]*$/) });
    fireEvent.click(screen.getByRole("button", { name: "Вернуть в повторы" }));
    await screen.findByRole("button", { name: "Не повторять" }, exchange);
    expect(f.srv.posts.filter(post => post.kind.startsWith("card.")).map(post => [post.kind, post.expected_card_state_version]))
      .toEqual([["card.exclude", null], ["card.return", "1"]]);
    expect(f.onBack).not.toHaveBeenCalled();
  });

  it("H2 from the written quiz an accepted exclude leaves the card the managed way (context.close, then Back)", async () => {
    const f = fixture({ kind: "quiz", direction: "l1-de" });
    render(<CardHost {...f.props} />);
    // The quiz origin shows only its own direction.
    await screen.findByText("Интервал: 3 дн.", undefined, exchange);
    expect(screen.queryByText("Интервал: 8 дн.")).toBeNull();
    // The pencils wait for the open card context (M-EDIT Р12). Acting before it would send card.exclude ahead of
    // context.open, and the order asserted below would depend on timing.
    const pencil = await screen.findByRole("button", { name: "Изменить личный перевод" }, exchange) as HTMLButtonElement;
    await waitFor(() => expect(pencil.disabled).toBe(false), exchange);
    fireEvent.click(await screen.findByRole("button", { name: "Не повторять" }, exchange));
    await waitFor(() => expect(f.onBack).toHaveBeenCalledWith("sent"), exchange);
    expect(f.srv.posts.map(post => post.kind)).toEqual(["context.open", "card.exclude", "context.close"]);
    expect(f.onStudyAction).toHaveBeenCalledTimes(1);
  });

  it("H3 from the oral quiz an accepted relearn keeps the card: the oral question stays (К07-080)", async () => {
    const f = fixture({ kind: "quiz", direction: "de-l1" });
    render(<CardHost {...f.props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Изучить заново" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Изучить заново" }));
    await waitFor(() => expect(f.onStudyAction).toHaveBeenCalledWith(expect.objectContaining({ kind: "card.relearn" })));
    expect(f.onBack).not.toHaveBeenCalled();
    expect(f.srv.posts.some(post => post.kind === "context.close")).toBe(false);
  });

  it("H4 the complaint attaches the card, returns to it after the confirmation and reads it and its context again", async () => {
    const f = fixture({ kind: "dictionary" });
    render(<CardHost {...f.props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Сообщить об ошибке" }));
    const field = within(screen.getByRole("dialog")).getByRole("textbox", { name: "Что не так?" }) as HTMLTextAreaElement;
    await waitFor(() => expect(field.readOnly).toBe(false));
    fireEvent.change(field, { target: { value: "Plural fehlt" } });
    const views = reads(f.srv, "/view"), contexts = reads(f.srv, "/dictionary/contexts/");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Отправить" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText("Сообщение отправлено.")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2 })).toBeTruthy();
    expect(f.srv.posts.find(post => post.kind === "feedback.send")).toMatchObject({ payload: { text: "Plural fehlt", card_id: CARD } });
    await waitFor(() => expect(reads(f.srv, "/view")).toBe(views + 1));
    expect(reads(f.srv, "/dictionary/contexts/")).toBe(contexts + 1);
    // The complaint never reaches the application storage (Р7).
    expect([...f.values.keys()].some(key => key.includes("feedback"))).toBe(false);
    expect(f.onBack).not.toHaveBeenCalled();
  });
  it("H6 a context.open reply delivered after the action and the card's new read: the context is read once, the pencils work", async () => {
    let deliver!: () => void;
    const f = fixture({ kind: "quiz", direction: "de-l1" }, new Promise<void>(done => { deliver = done; }));
    render(<CardHost {...f.props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Не повторять" }, exchange));
    await screen.findByRole("button", { name: "Вернуть в повторы" }, exchange);
    const pencil = screen.getByRole("button", { name: "Изменить личный перевод" }) as HTMLButtonElement;
    expect(pencil.disabled).toBe(true);
    deliver();
    await waitFor(() => expect(pencil.disabled).toBe(false), exchange);
    expect(reads(f.srv, "/dictionary/contexts/")).toBe(1);
    expect(f.srv.posts.map(post => post.kind)).toEqual(["context.open", "card.exclude"]);
  });
});
