import { useRef, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useBackLayer } from "../app/navigationBack";
import { CardHost } from "../dictionary/card/CardHost";
import { cardView, reviewing, response as viewResponse } from "../dictionary/card/cardTestData.test-support";
import { ManualPendingStore } from "../learning/manualPending";
import type { SettingsDocument } from "../settings/useSettingsDocument";
import { useWrittenHost } from "./useWrittenHost";
import { id, response, writtenFixture } from "./writtenFixtures.test-support";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const CARD_6 = id(106);
const settings = { state: { phase: "ready", data: null, dataCurrent: true, drafts: {}, pending: null, outcome: null, problem: null,
  canEdit: true, canRetry: false }, confirmed: { state_version: "1", settings: { dictionary_language: { value: "ru" },
  transition_mode: { value: "normal" } } }, actions: { refresh: vi.fn(async () => undefined) } } as unknown as SettingsDocument;

type CardFate = "ok" | "conflict";
/**
 * The written fixture plus the card endpoints of core: the card view, its context and card.exclude/card.relearn. One
 * profile state version for both, as in core (the quiz reads the session at least as new as the card action).
 */
function quiz(cardFates: CardFate[] = [], options: { staleSessionReads?: boolean } = {}) {
  const f = writtenFixture({ active: true, cards: [6, 7, 8] });
  const s = f.server.state, cards = { posts: [] as Record<string, any>[], excluded: false, version: null as string | null,
    contexts: new Map<string, "open" | "closed">(), next: 700, fates: [...cardFates], actionVersion: null as number | null,
    staleReads: [] as string[] };
  const view = (localDate: string | null = "2026-10-07") => {
    const value = reviewing(cardView(CARD_6));
    if (cards.excluded) {
      value.study.facts.exclusion = { excluded: true, version: cards.version };
      Object.assign(value.study.directions[0], { schedule: null, interval_preview: null });
      value.card_actions = { exclude: false, return: true, relearn: false };
    }
    value.study.local_date = localDate;
    if (localDate === null) value.study.directions.forEach(direction => { direction.interval_preview = null; });
    return value;
  };
  const context = (contextId: string) => {
    const status = cards.contexts.get(contextId), reference = { id: contextId, kind: "dictionary", card_id: CARD_6 };
    return status === "open" ? { status, context: reference, view: view(null), interval: null,
      capabilities: { interval_increase: null, undo_offer: null, undo_target: null } } : status === "closed" ? { status, context: reference }
      : { status: "unavailable" };
  };
  const base = f.fetcher.getMockImplementation()!;
  f.fetcher.mockImplementation(async (input, init) => {
    const url = new URL(String(input), "http://local");
    if (url.pathname === `/api/v1/dictionary/cards/${CARD_6}/view`) return response(viewResponse(view(), String(s.version)));
    if (url.pathname.startsWith("/api/v1/dictionary/contexts/")) return response({ state_version: String(s.version), current: context(url.pathname.split("/").at(-1)!) });
    if (url.pathname === "/api/v1/learning/current") return response({ pair: "ru-de", state_version: String(s.version), manual_selection_version: "1",
      group: null, manual_selection: [], learning: { status: "new_group", ready: 0, preview: 0, next_due_at: null, new_group_size: 2,
        manual_eligible: 0, automatic_eligible: 2 } });
    if (options.staleSessionReads && cards.actionVersion !== null && init?.method === "GET" && url.pathname.startsWith("/api/v1/sessions/")) {
      // A lagging reader: every session read after the action reports a version older than the action.
      const read = await (await base(input, init)).json();
      read.state_version = String(cards.actionVersion - 1);
      cards.staleReads.push(read.state_version);
      return response(read);
    }
    const body = init?.method === "POST" ? JSON.parse(String(init.body)) : null;
    if (!body || !(String(body.kind).startsWith("context.") || String(body.kind).startsWith("card."))) return base(input, init);
    cards.posts.push(body);
    const fact = (extra: Record<string, unknown>) => ({ id: body.command_id, kind: body.kind, status: "applied", applied_at: "2026-10-07T09:00:00Z",
      result_id: null, ...extra });
    if (body.kind === "context.open" || body.kind === "context.close") {
      let contextId: string = body.context_id;
      if (body.kind === "context.open") { contextId = id(cards.next++); cards.contexts.set(contextId, "open"); } else cards.contexts.set(contextId, "closed");
      s.version++;
      return response({ command: fact({ target_id: CARD_6, action_id: null, context_id: contextId, object_version: null }),
        current: context(contextId), state_version: String(s.version) });
    }
    const actions = () => ({ status: "available", card_id: CARD_6, pair: "ru-de", excluded: cards.excluded, version: cards.version,
      actions: cards.excluded ? { exclude: false, return: true, relearn: false } : { exclude: true, return: false, relearn: true } });
    if (cards.fates.shift() === "conflict") {
      return response({ command: { id: body.command_id, status: "rejected" }, current: actions(), state_version: String(s.version),
        error: { code: "VERSION_CONFLICT" } }, 409);
    }
    if (body.kind === "card.exclude") { cards.excluded = true; cards.version = "1"; }
    s.version++;
    cards.actionVersion = s.version;
    return response({ command: fact({ target_id: CARD_6, action_id: id(777), context_id: null,
      object_version: body.kind === "card.relearn" ? "3" : "1" }), current: actions(), state_version: String(s.version) });
  });
  return { f, cards };
}
type Quiz = ReturnType<typeof quiz>;

/**
 * The composition ApplicationDocument is asked to make (M-ACTIONS В1): the written result pushes the card, the card
 * returns to the quiz and reports its accepted study action to the written host.
 */
function QuizDocument({ q, onOpen, cards = true }: { q: Quiz; onOpen?(cardId: string, details: { assignment: string }): void;
  cards?: boolean }) {
  const [card, setCard] = useState<string | null>(null);
  const [store] = useState(() => new ManualPendingStore(q.f.storage));
  // One transport object for the document, as App passes it: a new object would restart both owners.
  const transport = q.f.transport;
  const slot = useRef<(() => void) | null>(null);
  const written = useWrittenHost({ access: q.f.access(), transport,
    storage: q.f.storage, newId: q.f.newId, language: "ru", settings, initialSessionId: id(3), route: card === null ? "written" : "hidden",
    onWritten: () => undefined, onToday: () => undefined,
    onOpenCard: cards ? (cardId, details) => { onOpen?.(cardId, details); setCard(cardId); } : undefined });
  useBackLayer("screen", card === null ? null : () => slot.current?.());
  return <>
    {written.screen}
    {card !== null && <CardHost access={q.f.access()} transport={transport}
      language="ru" pendingStore={store} cardId={card} origin={{ kind: "quiz", direction: "l1-de" }} newId={q.f.newId} backSlot={slot}
      onStudyAction={written.cardActionApplied} onBack={() => setCard(null)} />}
  </>;
}

async function answerWrong(q: Quiz) {
  await screen.findByText("слово 6");
  const field = screen.getByRole("textbox") as HTMLTextAreaElement;
  await waitFor(() => expect(field.readOnly).toBe(false));
  fireEvent.change(field, { target: { value: "falsch" } });
  fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
  await screen.findByText("Есть ошибка");
  expect(q.f.posts().map(post => post.kind)).toEqual(["answer.submit"]);
}
/** Commands of the quiz itself; the card's context and action commands are counted in q.cards.posts. */
const kinds = (q: Quiz) => q.f.posts().map(post => post.kind as string)
  .filter(kind => !kind.startsWith("context.") && !kind.startsWith("card."));

describe("«Уточнить поля» and card study actions from the written quiz (TA:115, TA:153)", () => {
  it("Q1 the answered card opens with its editors and only the quiz direction; Back returns to the same result", async () => {
    const q = quiz(), onOpen = vi.fn();
    render(<QuizDocument q={q} onOpen={onOpen} />);
    await answerWrong(q);
    fireEvent.click(screen.getByRole("button", { name: "Уточнить поля" }));
    expect(onOpen).toHaveBeenCalledWith(CARD_6, { assignment: id(6) });
    const pencil = await screen.findByRole("button", { name: "Изменить личный перевод" }) as HTMLButtonElement;
    // Back only after the card context is open (the pencils wait for it, M-EDIT Р12): otherwise no close is due (M-CARD В6).
    await waitFor(() => expect(pencil.disabled).toBe(false));
    expect(screen.queryByText("Есть ошибка")).toBeNull();
    expect(await screen.findByRole("button", { name: "Не повторять" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    await screen.findByText("Есть ошибка");
    // A plain return is not an action: the result waits for «Далее» (К05-152), nothing was presented.
    expect(screen.getByRole("button", { name: "Далее" })).toBeTruthy();
    expect(kinds(q).filter(kind => kind === "assignment.present")).toHaveLength(0);
    await waitFor(() => expect(q.cards.posts.at(-1)).toMatchObject({ kind: "context.close" }));
  });

  it("Q2 «Не повторять» from that card: after the commit the card closes and the quiz goes on to the next question", async () => {
    const q = quiz();
    render(<QuizDocument q={q} />);
    await answerWrong(q);
    fireEvent.click(screen.getByRole("button", { name: "Уточнить поля" }));
    fireEvent.click(await screen.findByRole("button", { name: "Не повторять" }));
    await screen.findByText("слово 7");
    expect(screen.queryByText("Есть ошибка")).toBeNull();
    expect(q.cards.posts.map(post => post.kind)).toEqual(["context.open", "card.exclude", "context.close"]);
    expect(q.cards.posts[1]).toMatchObject({ expected_card_state_version: null, payload: { card_id: CARD_6 } });
    await waitFor(() => expect(kinds(q)).toEqual(["answer.submit", "assignment.present"]));
  });

  it("Q3 «Изучить заново» moves on only after its confirmation and commit; a cancel keeps the card open", async () => {
    const q = quiz();
    render(<QuizDocument q={q} />);
    await answerWrong(q);
    fireEvent.click(screen.getByRole("button", { name: "Уточнить поля" }));
    fireEvent.click(await screen.findByRole("button", { name: "Изучить заново" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Отмена" }));
    expect(screen.getByRole("button", { name: "Изучить заново" })).toBeTruthy();
    expect(q.cards.posts.some(post => post.kind === "card.relearn")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Изучить заново" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Изучить заново" }));
    await screen.findByText("слово 7");
    expect(q.cards.posts.find(post => post.kind === "card.relearn")).toMatchObject({ payload: { card_id: CARD_6, confirmed: true } });
  });

  it("Q4 a refused action keeps the card and the quiz where they were (К07-074)", async () => {
    const q = quiz(["conflict"]);
    render(<QuizDocument q={q} />);
    await answerWrong(q);
    fireEvent.click(screen.getByRole("button", { name: "Уточнить поля" }));
    fireEvent.click(await screen.findByRole("button", { name: "Не повторять" }));
    await screen.findByText("Карточка уже изменилась. Показано актуальное состояние.");
    expect(screen.queryByText("Есть ошибка")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    await screen.findByText("Есть ошибка");
    expect(kinds(q).filter(kind => kind === "assignment.present")).toHaveLength(0);
  });

  it("Q5 unsaved own text asks before the card leaves after the action; the quiz moves on once the card is left", async () => {
    const q = quiz();
    render(<QuizDocument q={q} />);
    await answerWrong(q);
    fireEvent.click(screen.getByRole("button", { name: "Уточнить поля" }));
    const pencil = await screen.findByRole("button", { name: "Добавить ассоциацию" }) as HTMLButtonElement;
    await waitFor(() => expect(pencil.disabled).toBe(false));
    fireEvent.click(pencil);
    fireEvent.change(within(screen.getByRole("region", { name: "Ассоциация" })).getByRole("textbox"), { target: { value: "Bild" } });
    fireEvent.click(screen.getByRole("button", { name: "Не повторять" }));
    await screen.findByRole("button", { name: "Выйти без сохранения" });
    expect(screen.queryByText("слово 7")).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Выйти без сохранения" })); });
    await screen.findByText("слово 7");
  });

  it("Q6 a correct result offers the button too; a host without the card route offers none", async () => {
    const q = quiz();
    const view = render(<QuizDocument q={q} />);
    await screen.findByText("слово 6");
    const field = screen.getByRole("textbox") as HTMLTextAreaElement;
    await waitFor(() => expect(field.readOnly).toBe(false));
    fireEvent.change(field, { target: { value: "Haus" } });
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    await screen.findByText("Верно");
    expect(screen.getByRole("button", { name: "Уточнить поля" })).toBeTruthy();
    view.unmount();
    const other = quiz();
    render(<QuizDocument q={other} cards={false} />);
    await answerWrong(other);
    expect(screen.queryByRole("button", { name: "Уточнить поля" })).toBeNull();
  });

  it("Q7 the quiz never moves on from a session read older than the action (its read floor)", async () => {
    const q = quiz([], { staleSessionReads: true });
    render(<QuizDocument q={q} />);
    await answerWrong(q);
    fireEvent.click(screen.getByRole("button", { name: "Уточнить поля" }));
    fireEvent.click(await screen.findByRole("button", { name: "Не повторять" }));
    await screen.findByText("Есть ошибка");
    await waitFor(() => expect(q.cards.staleReads.length).toBeGreaterThan(0));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
    expect(kinds(q)).toEqual(["answer.submit"]);
    expect(screen.queryByText("слово 7")).toBeNull();
  });
});
