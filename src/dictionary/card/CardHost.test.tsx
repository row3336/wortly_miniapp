import { useRef, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DictionaryCardView, OpenedClient } from "../../api/generated";
import { useBackLayer } from "../../app/navigationBack";
import { createOpenedAccess, type OpenedAccess } from "../../app/openedAccess";
import { ManualPendingStore } from "../../learning/manualPending";
import type { AsyncStorage } from "../../platform/storage";
import { CardHost, type CardHostProps } from "./CardHost";
import { CARD, cardView, reviewing } from "./cardTestData.test-support";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PROFILE = id(3), CLIENT = id(1), DOCUMENT = id(2);
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const flush = () => act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

type Route = (path: string, init: RequestInit) => Response | Promise<Response> | undefined;
/** Core-shaped synthetic server: card view, card context, manual Learning selection, command facts. */
function server(initial: () => DictionaryCardView = cardView) {
  const s = { state: 10n, selection: 1n, selected: new Set<string>(), base: initial, gone: false,
    contexts: new Map<string, "open" | "closed">(), commands: new Map<string, Record<string, unknown>>(), routes: [] as Route[], next: 500 };
  const view = (localDate: string | null = "2026-10-07"): DictionaryCardView => {
    const value = s.base();
    value.study.facts.manual = { selected: s.selected.has(CARD), selection_version: String(s.selection) };
    value.study.local_date = localDate;
    if (localDate === null) value.study.directions.forEach(direction => { direction.interval_preview = null; });
    return value;
  };
  const learning = () => ({ pair: "ru-de", state_version: String(s.state), manual_selection_version: String(s.selection), group: null,
    manual_selection: [...s.selected].map((card_id, i) => ({ card_id, position: i + 1, version: String(s.selection), eligible: true })),
    learning: { status: "new_group", ready: 0, preview: 0, next_due_at: null, new_group_size: 2, manual_eligible: s.selected.size, automatic_eligible: 2 } });
  // The context's own view has no local date: no interval offer, whatever its shape (M-INTV).
  const context = (contextId: string) => {
    const status = s.contexts.get(contextId);
    const reference = { id: contextId, kind: "dictionary", card_id: CARD };
    return status === "open" ? { status, context: reference, view: view(null), interval: null,
      capabilities: { interval_increase: null, undo_offer: null, undo_target: null } } : status === "closed" ? { status, context: reference } : { status: "unavailable" };
  };
  const fact = (body: Record<string, any>, contextId: string | null, status = "applied") => ({ id: body.command_id, kind: body.kind, status,
    applied_at: "2026-10-07T09:00:00Z", target_id: body.payload.card_id ?? CARD, action_id: null, result_id: null, context_id: contextId,
    object_version: body.kind.startsWith("learning.") ? String(s.selection) : null });
  const handle = (path: string, init: RequestInit): Response => {
    const url = new URL(path, "http://local");
    if (url.pathname === `/api/v1/dictionary/cards/${CARD}/view` && init.method === "GET") {
      return json({ state_version: String(s.state), current: s.gone ? { status: "unavailable" } : view() });
    }
    if (url.pathname === "/api/v1/learning/current" && init.method === "GET") return json(learning());
    if (url.pathname === "/api/v1/commands" && init.method === "POST") {
      const body = JSON.parse(String(init.body));
      if (body.kind === "context.open" || body.kind === "context.close") {
        let contextId: string = body.context_id;
        if (body.kind === "context.open") { for (const key of s.contexts.keys()) s.contexts.set(key, "closed"); contextId = id(s.next++); s.contexts.set(contextId, "open"); }
        else s.contexts.set(contextId, "closed");
        s.state++;
        const saved = fact({ ...body, payload: { card_id: CARD } }, contextId);
        s.commands.set(body.command_id, saved);
        return json({ command: saved, current: context(contextId), state_version: String(s.state) });
      }
      if (body.expected_selection_version !== String(s.selection)) {
        return json({ command: { id: body.command_id, status: "rejected" }, error: { code: "VERSION_CONFLICT" }, current: learning(), state_version: String(s.state) }, 409);
      }
      if (body.kind === "learning.select") s.selected.add(body.payload.card_id); else s.selected.delete(body.payload.card_id);
      s.selection++; s.state++;
      const saved = fact(body, null);
      s.commands.set(body.command_id, saved);
      return json({ command: saved, current: learning(), state_version: String(s.state) });
    }
    throw new Error(`unexpected ${init.method} ${path}`);
  };
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const route = s.routes.shift(), path = String(input);
    return (route && await route(path, init!)) ?? handle(path, init!);
  });
  const posts = () => fetcher.mock.calls.filter(([, init]) => init!.method === "POST").map(([, init]) => JSON.parse(String(init!.body)));
  const reads = (suffix: string) => fetcher.mock.calls.filter(([url, init]) => init!.method === "GET" && String(url).endsWith(suffix)).length;
  return Object.assign(s, { fetcher, handle, posts, reads });
}

function fixture(initial?: () => DictionaryCardView) {
  const srv = server(initial);
  const values = new Map<string, string>();
  const storage: AsyncStorage = { get: vi.fn(async key => values.get(key) ?? null),
    set: vi.fn(async (key, value) => { values.set(key, value); }), remove: vi.fn(async key => { values.delete(key); }) };
  let active: OpenedAccess | null = null, next = 100;
  const opened: OpenedClient = { status: "opened", client_instance_id: CLIENT, document_id: DOCUMENT, document_epoch: "1", proof_version: "1",
    profile: { profile_id: PROFILE, role: "user", ui_language: "ru", dictionary_language: "ru", time_zone: "UTC", state_version: "10",
      access: { status: "admitted", version: "1", reason: null } }, session: null, compatibility: { compatible: true, contract_version: "1" } };
  const access = () => {
    let bound!: OpenedAccess;
    bound = createOpenedAccess({ opened, token: "synthetic-card-host-token", proof: "synthetic-card-host-proof", generation: 1,
      isLive: () => active === bound, onDenied: () => { if (active === bound) active = null; } });
    active = bound; return bound;
  };
  const onBack = vi.fn();
  const props: CardHostProps = { access: access(), transport: { fetcher: srv.fetcher, timeoutMs: 5000, maxResponseBytes: 1_000_000 },
    language: "ru", pendingStore: new ManualPendingStore(storage), cardId: CARD, origin: { kind: "dictionary" },
    newId: () => id(next++), onBack };
  return { srv, props, onBack, values, access };
}
const study = () => screen.getByRole("region", { name: "Изучение" });

describe("М12 card host: card read, card context, manual Learning choice, Back", () => {
  it("H1 shows loading, then the card; opens one context after the card is ready", async () => {
    const f = fixture(), gate = deferred<void>();
    f.srv.routes.push(async (path, init) => { await gate.promise; return f.srv.handle(path, init); });
    render(<CardHost {...f.props} />);
    expect(screen.getByRole("status").textContent).toBe("Загружаем карточку…");
    await flush();
    expect(f.srv.posts()).toEqual([]);
    gate.resolve();
    await screen.findByRole("heading", { level: 2 });
    expect(within(study()).getByText("В очереди на изучение")).toBeTruthy();
    await waitFor(() => expect(f.srv.posts().map(post => post.kind)).toEqual(["context.open"]));
    expect(f.srv.posts()[0]).toMatchObject({ client_instance_id: CLIENT, document_id: DOCUMENT, payload: { card_id: CARD, source: { kind: "dictionary" } } });
    expect(f.srv.reads("/view")).toBe(1);
  });

  it("H2 Back closes the open context before leaving; native Back is the same transition", async () => {
    const f = fixture();
    render(<CardHost {...f.props} />);
    await screen.findByRole("heading", { level: 2 });
    await waitFor(() => expect(f.srv.contexts.size).toBe(1));
    const [contextId] = f.srv.contexts.keys();
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    expect(f.onBack).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(f.srv.posts().at(-1)).toMatchObject({ kind: "context.close", context_id: contextId }));
    expect(f.srv.contexts.get(contextId)).toBe("closed");
  });

  it("H3 «Добавить в обучение» selects the card; its own reply rereads the card and the facts decide", async () => {
    const f = fixture();
    render(<CardHost {...f.props} />);
    await screen.findByText("В очереди на изучение");
    const add = await screen.findByRole("button", { name: "Добавить в обучение" }) as HTMLButtonElement;
    await waitFor(() => expect(add.disabled).toBe(false));
    fireEvent.click(add);
    await screen.findByText("В следующей группе слов");
    const select = f.srv.posts().find(post => post.kind === "learning.select");
    expect(select).toMatchObject({ expected_selection_version: "1", payload: { card_id: CARD, expected_pair: "ru-de" } });
    expect(f.srv.reads("/view")).toBe(2);
    // К04-061 / К04-072: the wait can be cancelled from the card.
    const remove = await screen.findByRole("button", { name: "Убрать из следующей группы" }) as HTMLButtonElement;
    await waitFor(() => expect(remove.disabled).toBe(false));
    fireEvent.click(remove);
    await screen.findByText("В очереди на изучение");
    expect(f.srv.posts().filter(post => post.kind.startsWith("learning.")).map(post => post.kind)).toEqual(["learning.select", "learning.unselect"]);
    expect(f.srv.selected.size).toBe(0);
  });

  it("H4 a manual selection made earlier (another document) is shown and removable after a new entry (К04-072)", async () => {
    const f = fixture(); f.srv.selected.add(CARD); f.srv.selection = 2n;
    render(<CardHost {...f.props} />);
    await screen.findByText("В следующей группе слов");
    const remove = await screen.findByRole("button", { name: "Убрать из следующей группы" }) as HTMLButtonElement;
    await waitFor(() => expect(remove.disabled).toBe(false));
  });

  it("H5 a refused change shows its message, keeps the facts and no second command is sent", async () => {
    const f = fixture();
    render(<CardHost {...f.props} />);
    const add = await screen.findByRole("button", { name: "Добавить в обучение" }) as HTMLButtonElement;
    await waitFor(() => expect(add.disabled).toBe(false));
    // Another device selected meanwhile: the expected version is old.
    f.srv.selection = 7n;
    fireEvent.click(add);
    await screen.findByText("Не удалось изменить обучение");
    expect(f.srv.posts().filter(post => post.kind === "learning.select")).toHaveLength(1);
    expect(screen.getByText("В очереди на изучение")).toBeTruthy();
  });

  it("H6 an unconfirmed outcome offers retry of the same command, never a new one", async () => {
    const f = fixture();
    render(<CardHost {...f.props} />);
    const add = await screen.findByRole("button", { name: "Добавить в обучение" }) as HTMLButtonElement;
    await waitFor(() => expect(add.disabled).toBe(false));
    f.srv.routes.push(() => { throw new TypeError("network down"); });
    fireEvent.click(add);
    const retry = await screen.findByRole("button", { name: "Повторить" });
    expect(screen.getByText("Изменение не подтверждено")).toBeTruthy();
    const firstId = (JSON.parse(String(f.srv.fetcher.mock.calls.find(([, init]) => init!.method === "POST" && String(init!.body).includes("learning.select"))![1]!.body))).command_id;
    fireEvent.click(retry);
    await screen.findByText("В следующей группе слов");
    const selects = f.srv.posts().filter(post => post.kind === "learning.select");
    // The lost request and its retry carry one command ID and one payload.
    expect(selects.map(post => post.command_id)).toEqual([firstId, firstId]);
    expect(selects[1]).toEqual(selects[0]);
  });

  it("H7 unavailable and failed reads are distinct; failure offers retry; another card is never shown", async () => {
    const gone = fixture(); gone.srv.gone = true;
    render(<CardHost {...gone.props} />);
    await screen.findByText("Карточка недоступна");
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
    cleanup();

    const f = fixture();
    f.srv.routes.push(() => json({ state_version: "10", current: cardView(id(77)) }));
    render(<CardHost {...f.props} />);
    await screen.findByText("Не удалось загрузить карточку");
    expect(screen.queryByText("Haus")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    await screen.findByRole("heading", { level: 2 });
  });

  it("H8 reviews from the dictionary show both directions; from the written quiz only L1→De", async () => {
    const f = fixture(reviewing);
    render(<CardHost {...f.props} />);
    await screen.findByRole("heading", { level: 2 });
    expect(within(study()).getAllByRole("term").map(term => term.textContent)).toEqual(["Рус → Нем", "Нем → Рус"]);
    expect(within(study()).getByText("Интервал: 3 дн.")).toBeTruthy();
    expect(within(study()).queryByRole("button")).toBeNull();
    cleanup();
    const q = fixture(reviewing);
    render(<CardHost {...q.props} origin={{ kind: "quiz", direction: "l1-de" }} />);
    await screen.findByRole("heading", { level: 2 });
    expect(within(study()).getAllByRole("term").map(term => term.textContent)).toEqual(["Рус → Нем"]);
  });

  it("H9 extension points receive the shown view and the card context", async () => {
    const f = fixture(reviewing);
    const renderActions = vi.fn((view: DictionaryCardView) => <p>actions {String(view.card_actions.exclude)}</p>);
    const renderInterval = vi.fn((_view: DictionaryCardView, context: { state: { phase: string } }) => <p>interval {context.state.phase}</p>);
    render(<CardHost {...f.props} extensions={{ renderActions, renderInterval }} />);
    await screen.findByText("actions true");
    await screen.findByText("interval ready");
  });
});

/** The parent's part of В6: Back with an unconfirmed open keeps the same host mounted with leaving until onClosed. */
function Leaving(props: CardHostProps & { closed(): void }) {
  const [leaving, setLeaving] = useState(false), [gone, setGone] = useState(false);
  if (gone) return null;
  return <CardHost {...props} leaving={leaving}
    onBack={close => { props.onBack(close); if (close === "after_open") setLeaving(true); else setGone(true); }}
    onClosed={() => { props.closed(); setGone(true); }} />;
}
function holdOpen(f: ReturnType<typeof fixture>, refuse: boolean) {
  const gate = deferred<void>(), original = f.srv.fetcher.getMockImplementation()!;
  f.srv.fetcher.mockImplementation(async (input, init) => {
    if (init?.method === "POST" && String(init.body).includes('"context.open"')) {
      await gate.promise;
      if (refuse) {
        const body = JSON.parse(String(init.body));
        return json({ command: { id: body.command_id, status: "rejected" }, error: { code: "DOCUMENT_STALE" },
          current: { status: "unavailable" }, state_version: String(f.srv.state) }, 409);
      }
    }
    return original(input, init);
  });
  return gate;
}

describe("М12 Back before context.open is confirmed (root decision В6)", () => {
  it("V1 the close waits for the open and follows it at once, through the same document; the screen is gone meanwhile", async () => {
    const f = fixture(), gate = holdOpen(f, false), closed = vi.fn();
    render(<Leaving {...f.props} closed={closed} />);
    await screen.findByRole("heading", { level: 2 });
    await waitFor(() => expect(f.srv.posts().map(post => post.kind)).toEqual(["context.open"]));
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    expect(f.onBack).toHaveBeenCalledWith("after_open");
    expect(screen.queryByRole("main")).toBeNull();
    await flush();
    expect(f.srv.posts().map(post => post.kind)).toEqual(["context.open"]);
    expect(closed).not.toHaveBeenCalled();
    gate.resolve();
    await waitFor(() => expect(f.srv.posts().map(post => post.kind)).toEqual(["context.open", "context.close"]));
    const [contextId] = f.srv.contexts.keys();
    expect(f.srv.posts()[1]).toMatchObject({ context_id: contextId, client_instance_id: CLIENT, document_id: DOCUMENT });
    expect(f.srv.contexts.get(contextId)).toBe("closed");
    await waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
  });

  it("V2 a refused open sends no close; the host is released", async () => {
    const f = fixture(), gate = holdOpen(f, true), closed = vi.fn();
    render(<Leaving {...f.props} closed={closed} />);
    await screen.findByRole("heading", { level: 2 });
    await waitFor(() => expect(f.srv.posts().map(post => post.kind)).toEqual(["context.open"]));
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    expect(f.onBack).toHaveBeenCalledWith("after_open");
    gate.resolve();
    await waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
    await flush();
    expect(f.srv.posts().map(post => post.kind)).toEqual(["context.open"]);
  });

  it("V3 Back after a confirmed open closes at once and needs no leaving host", async () => {
    const f = fixture(), closed = vi.fn();
    render(<Leaving {...f.props} closed={closed} />);
    await screen.findByRole("heading", { level: 2 });
    await waitFor(() => expect(f.srv.contexts.size).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    expect(f.onBack).toHaveBeenCalledWith("sent");
    await waitFor(() => expect(f.srv.posts().map(post => post.kind)).toEqual(["context.open", "context.close"]));
    expect(closed).not.toHaveBeenCalled();
  });
});

/** Telegram's native Back button, as the app binds it. */
function nativeBack() {
  const handlers = new Set<() => void>();
  vi.stubGlobal("Telegram", { WebApp: { BackButton: { show() {}, hide() {}, onClick: (h: () => void) => { handlers.add(h); },
    offClick: (h: () => void) => { handlers.delete(h); } } } });
  return { get bound() { return handlers.size; }, click: () => act(async () => { for (const h of [...handlers]) h(); }) };
}
/** The document's part: its one screen-layer handler calls the card's slot. It registers in the same commit as the card,
 * after it (a parent effect runs after the child's), which is the order QA M20 found unsafe. */
function Document(props: CardHostProps) {
  const slot = useRef<(() => void) | null>(null);
  useBackLayer("screen", () => slot.current?.());
  return <CardHost {...props} backSlot={slot} />;
}

describe("М12 native Back through the document's slot (QA M-CARD находки 1, 3)", () => {
  it("N1 native Back runs the card's exit: onBack and context.close, whatever the registration order", async () => {
    const back = nativeBack(), f = fixture();
    render(<Document {...f.props} />);
    await screen.findByRole("heading", { level: 2 });
    await waitFor(() => expect(f.srv.contexts.size).toBe(1));
    const [contextId] = f.srv.contexts.keys();
    expect(back.bound).toBe(1);
    await back.click();
    expect(f.onBack).toHaveBeenCalledWith("sent");
    await waitFor(() => expect(f.srv.posts().at(-1)).toMatchObject({ kind: "context.close", context_id: contextId }));
  });
  it("N2 the card registers no back layer of its own, and a leaving host leaves the slot empty", async () => {
    const back = nativeBack(), f = fixture();
    const slot = { current: null as (() => void) | null };
    const { rerender } = render(<CardHost {...f.props} backSlot={slot} />);
    await screen.findByRole("heading", { level: 2 });
    expect(back.bound).toBe(0);
    expect(slot.current).toBeTypeOf("function");
    rerender(<CardHost {...f.props} backSlot={slot} leaving />);
    expect(slot.current).toBeNull();
  });
});

describe("М12 leaving host reads nothing (QA M-CARD находка 2, M19)", () => {
  it("V4 after Back with an unconfirmed open a new access neither rereads /view (history) nor Learning, nor opens", async () => {
    const f = fixture(), gate = holdOpen(f, false), closed = vi.fn();
    const ui = render(<Leaving {...f.props} closed={closed} />);
    await screen.findByRole("heading", { level: 2 });
    await waitFor(() => expect(f.srv.posts().map(post => post.kind)).toEqual(["context.open"]));
    const learning = f.srv.reads("/learning/current");
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    ui.rerender(<Leaving {...f.props} access={f.access()} closed={closed} />);
    await flush();
    expect(f.srv.reads("/view")).toBe(1);
    expect(f.srv.reads("/learning/current")).toBe(learning);
    expect(f.srv.posts().map(post => post.kind)).toEqual(["context.open"]);
    await waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
    gate.resolve();
  });
});
