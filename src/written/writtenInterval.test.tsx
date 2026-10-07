import { useRef, useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useBackLayer } from "../app/navigationBack";
import { CardHost } from "../dictionary/card/CardHost";
import { intervalWorld } from "../dictionary/intervalCardTestData.test-support";
import { ManualPendingStore } from "../learning/manualPending";
import type { SettingsDocument } from "../settings/useSettingsDocument";
import { useWrittenHost } from "./useWrittenHost";
import { id, writtenFixture } from "./writtenFixtures.test-support";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const CARD_6 = id(106);
const settings = { state: { phase: "ready", data: null, dataCurrent: true, drafts: {}, pending: null, outcome: null, problem: null,
  canEdit: true, canRetry: false }, confirmed: { state_version: "1", settings: { dictionary_language: { value: "ru" },
  transition_mode: { value: "normal" } } }, actions: { refresh: vi.fn(async () => undefined) } } as unknown as SettingsDocument;

/** The written fixture plus the card endpoints of core with the manual increase; one profile state version for both. */
function quiz(options: { lagging?: boolean } = {}) {
  const f = writtenFixture({ active: true, cards: [6, 7, 8] });
  const s = f.server.state;
  const world = intervalWorld({ cardId: CARD_6, id: n => id(n + 300), version: { get: () => s.version, bump: () => ++s.version } });
  const base = f.fetcher.getMockImplementation()!;
  const lagging: string[] = [];
  f.fetcher.mockImplementation(async (input, init) => {
    const card = world.handle(input, init);
    if (card) return card;
    const increase = world.posts.find(post => post.kind === "interval.increase");
    if (options.lagging && increase && init?.method === "GET" && String(input).includes("/api/v1/sessions/")) {
      // A lagging reader: every session read after the increase reports a version older than it.
      const read = await (await base(input, init)).json();
      read.state_version = String(world.increasedAt! - 1);
      lagging.push(read.state_version);
      return new Response(JSON.stringify(read), { status: 200 });
    }
    return base(input, init);
  });
  return { f, world, lagging };
}
type Quiz = ReturnType<typeof quiz>;

/** The composition of ApplicationDocument: the written result pushes the card, the card reports to the written host. */
function QuizDocument({ q }: { q: Quiz }) {
  const [card, setCard] = useState<string | null>(null);
  const [store] = useState(() => new ManualPendingStore(q.f.storage));
  const transport = q.f.transport;
  const slot = useRef<(() => void) | null>(null);
  const written = useWrittenHost({ access: q.f.access(), transport, storage: q.f.storage, newId: q.f.newId, language: "ru", settings,
    initialSessionId: id(3), route: card === null ? "written" : "hidden", onWritten: () => undefined, onToday: () => undefined,
    onOpenCard: cardId => setCard(cardId) });
  useBackLayer("screen", card === null ? null : () => slot.current?.());
  return <>
    {written.screen}
    {card !== null && <CardHost access={q.f.access()} transport={transport} language="ru" pendingStore={store} cardId={card}
      origin={{ kind: "quiz", direction: "l1-de" }} newId={q.f.newId} backSlot={slot}
      onStudyAction={written.cardActionApplied} onBack={() => setCard(null)} />}
  </>;
}

async function answerWrong() {
  await screen.findByText("слово 6");
  const field = screen.getByRole("textbox") as HTMLTextAreaElement;
  await waitFor(() => expect(field.readOnly).toBe(false));
  fireEvent.change(field, { target: { value: "falsch" } });
  fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
  await screen.findByText("Есть ошибка");
}
const quizKinds = (q: Quiz) => q.f.posts().map(post => String(post.kind))
  .filter(kind => !kind.startsWith("context.") && kind !== "interval.increase" && !kind.startsWith("action.undo"));

describe("the manual increase from the written quiz (M-INTV CP2: TA:149, Т08, RA:181)", () => {
  it("the card of the answered word increases L1→De; back in the quiz the session is read again and nothing moves on", async () => {
    const q = quiz();
    render(<QuizDocument q={q} />);
    await answerWrong();
    const sessionReads = q.f.gets("/api/v1/sessions/").length;
    fireEvent.click(screen.getByRole("button", { name: "Уточнить поля" }));
    const open = await screen.findByRole("button", { name: "Увеличить интервал" }, { timeout: 5000 }) as HTMLButtonElement;
    await waitFor(() => expect(open.disabled).toBe(false));
    fireEvent.click(open);
    fireEvent.click(within(screen.getByRole("dialog", { name: "Увеличить интервал" })).getByRole("button", { name: "Увеличить" }));
    await screen.findByRole("button", { name: "Отменить увеличение" });
    expect(q.world.kinds()).toEqual(["context.open", "interval.increase", "action.undo_offer.open"]);
    const increasedAt = q.f.server.state.version;
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    await screen.findByText("Есть ошибка");
    // Т08: the increase closed the correction on the server; the quiz shows a session read at least that new.
    await waitFor(() => expect(q.f.gets("/api/v1/sessions/").length).toBeGreaterThan(sessionReads));
    expect(q.f.server.state.version).toBeGreaterThanOrEqual(increasedAt);
    await new Promise(resolve => setTimeout(resolve, 200));
    // root decision, pending owner (M-INTV Р2): no «Дальше» by itself after an increase.
    expect(quizKinds(q)).toEqual(["answer.submit"]);
    expect(screen.getByRole("button", { name: "Далее" })).toBeTruthy();
    await waitFor(() => expect(q.world.kinds().at(-1)).toBe("context.close"));
    expect(q.world.kinds()).not.toContain("action.undo_offer.close");
  });

  it("a session read older than the increase is never shown as the quiz's current step (the quiz read floor)", async () => {
    const q = quiz({ lagging: true });
    render(<QuizDocument q={q} />);
    await answerWrong();
    fireEvent.click(screen.getByRole("button", { name: "Уточнить поля" }));
    const open = await screen.findByRole("button", { name: "Увеличить интервал" }, { timeout: 5000 }) as HTMLButtonElement;
    await waitFor(() => expect(open.disabled).toBe(false));
    fireEvent.click(open);
    fireEvent.click(within(screen.getByRole("dialog", { name: "Увеличить интервал" })).getByRole("button", { name: "Увеличить" }));
    await screen.findByRole("button", { name: "Отменить увеличение" });
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    await waitFor(() => expect(q.lagging.length).toBeGreaterThan(0));
    await new Promise(resolve => setTimeout(resolve, 300));
    // The result with its correction right predates the increase (Т08): a read below the increase does not bring it back.
    expect(screen.queryByText("Есть ошибка")).toBeNull();
    expect(quizKinds(q)).toEqual(["answer.submit"]);
  });
});
