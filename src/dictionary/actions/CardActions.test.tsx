import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DictionaryCardView, OpenedClient } from "../../api/generated";
import { createOpenedAccess } from "../../app/openedAccess";
import { excluded, reviewing } from "../card/cardTestData.test-support";
import { CardActions } from "./CardActions";
import { aid, CARD, cardActionServer, json, profileCurrent, type Fate } from "./actionTestData.test-support";
import type { CardActionApplied } from "./cardActionsController";
import { useCardActions } from "./useCardActions";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/** Card commands from the shared fake server, plus feedback.send with its own fates (core FeedbackService shapes). */
function world(cardFates: Fate[] = [], feedbackFates: ("ok" | "lose")[] = []) {
  const cards = cardActionServer(cardFates);
  const complaints = { posts: [] as Record<string, any>[], applied: new Map<string, string>(), fates: [...feedbackFates] };
  const fact = (commandId: string, status: string) => ({ id: commandId, kind: "feedback.send", status, applied_at: "2026-10-07T10:00:00Z",
    target_id: complaints.applied.get(commandId), action_id: null, result_id: null, context_id: null, object_version: null });
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const path = String(url);
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      if (body.kind !== "feedback.send") return cards.fetcher(url, init);
      complaints.posts.push(body);
      const known = complaints.applied.has(body.command_id);
      if (!known) complaints.applied.set(body.command_id, aid(950 + complaints.applied.size));
      if (complaints.fates.shift() === "lose") throw new TypeError("network");
      return json({ command: fact(body.command_id, known ? "already_applied" : "applied"),
        current: { inbox_id: complaints.applied.get(body.command_id), card_id: body.payload.card_id ?? null }, state_version: "20" });
    }
    const commandId = /\/commands\/([0-9a-f-]+)$/.exec(path)?.[1];
    if (commandId && !path.includes("?")) {
      if (!complaints.applied.has(commandId)) return json({ command: { id: commandId, status: "not_found" }, current: profileCurrent(), state_version: "20" });
      return json({ command: fact(commandId, "already_applied"), current: { inbox_id: complaints.applied.get(commandId), card_id: CARD }, state_version: "20" });
    }
    return cards.fetcher(url, init);
  });
  const opened: OpenedClient = { status: "opened", client_instance_id: aid(1), document_id: aid(2), document_epoch: "1", proof_version: "1",
    profile: { ...profileCurrent(), role: "user" } as OpenedClient["profile"], session: null,
    compatibility: { compatible: true, contract_version: "1" } };
  const access = createOpenedAccess({ opened, token: "synthetic-action-token", proof: "synthetic-action-proof", generation: 1,
    isLive: () => true, onDenied: () => {} });
  // One ID source for the whole world: a re-render must never hand out an ID already used (a retry keeps its own).
  let next = 100;
  return { cards, complaints, fetcher, access, transport: { fetcher, timeoutMs: 5000, maxResponseBytes: 1_000_000 },
    newId: () => aid(next++) };
}
type World = ReturnType<typeof world>;

function Harness({ w, view, stateVersion, onApplied, onChanged }: { w: World; view: DictionaryCardView; stateVersion: string;
  onApplied(event: CardActionApplied): void; onChanged(): void }) {
  const document = useCardActions({ access: w.access, transport: w.transport, cardId: CARD, view, stateVersion,
    newId: w.newId, onApplied, onChanged });
  return <CardActions language="ru" lemma="Haus" document={document} />;
}
function show(w: World, view: DictionaryCardView = reviewing(), stateVersion = "10") {
  const onApplied = vi.fn<(event: CardActionApplied) => void>(), onChanged = vi.fn();
  const result = render(<Harness w={w} view={view} stateVersion={stateVersion} onApplied={onApplied} onChanged={onChanged} />);
  return { ...result, onApplied, onChanged,
    rerender: (next: DictionaryCardView, version: string) =>
      result.rerender(<Harness w={w} view={next} stateVersion={version} onApplied={onApplied} onChanged={onChanged} />) };
}
const group = () => screen.getByRole("region", { name: "Действия с карточкой" });
function nativeBack() {
  const handlers = new Set<() => void>();
  vi.stubGlobal("Telegram", { WebApp: { BackButton: { show() {}, hide() {}, onClick: (h: () => void) => { handlers.add(h); },
    offClick: (h: () => void) => { handlers.delete(h); } } } });
  return { click: () => act(async () => { for (const h of [...handlers]) h(); }) };
}

describe("card actions under the study block (RA 6.1.10–6.1.12)", () => {
  it("D1 only the actions of card_actions are drawn; an excluded card offers only «Вернуть в повторы»", () => {
    const w = world();
    const first = show(w);
    expect(within(group()).getAllByRole("button").map(button => button.textContent))
      .toEqual(["Не повторять", "Изучить заново", "Сообщить об ошибке"]);
    first.rerender(excluded(), "11");
    expect(within(group()).getAllByRole("button").map(button => button.textContent)).toEqual(["Вернуть в повторы", "Сообщить об ошибке"]);
  });

  it("D2 «Не повторять» has no confirmation; the host hears only the accepted fact", async () => {
    const w = world();
    const view = show(w);
    fireEvent.click(screen.getByRole("button", { name: "Не повторять" }));
    expect(screen.getByRole("status").textContent).toBe("Сохраняем…");
    await waitFor(() => expect(view.onApplied).toHaveBeenCalledWith({ kind: "card.exclude", cardId: CARD, stateVersion: "11" }));
    expect(w.cards.posts).toEqual([expect.objectContaining({ kind: "card.exclude", expected_card_state_version: null })]);
    expect(screen.queryByRole("dialog")).toBeNull();
    // The spent hint is not drawn until the card is read again.
    expect(screen.queryByRole("button", { name: "Не повторять" })).toBeNull();
  });

  it("D3 «Изучить заново»: a window with the word and the reset; cancel and native Back send nothing", async () => {
    const back = nativeBack(), w = world();
    const view = show(w);
    fireEvent.click(screen.getByRole("button", { name: "Изучить заново" }));
    const dialog = screen.getByRole("dialog", { name: "Изучить заново «Haus»?" });
    expect(within(dialog).getByText(/начнутся с нуля/)).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Отмена" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Отмена" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Изучить заново" }));
    await back.click();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Изучить заново" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(w.cards.posts).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Изучить заново" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Изучить заново" }));
    await waitFor(() => expect(view.onApplied).toHaveBeenCalledWith(expect.objectContaining({ kind: "card.relearn" })));
    expect(w.cards.posts).toEqual([expect.objectContaining({ kind: "card.relearn", payload: { card_id: CARD, confirmed: true } })]);
  });

  it("D4 a lost reply: «Повторить» checks and repeats the same command, nothing else can start meanwhile", async () => {
    const w = world(["lose-before"]);
    w.cards.state.statusFailures = 1;
    const view = show(w);
    fireEvent.click(screen.getByRole("button", { name: "Не повторять" }));
    await screen.findByText("Нет подтверждения, что действие сохранено.");
    expect(screen.queryByRole("button", { name: "Изучить заново" })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Повторить" }));
    await waitFor(() => expect(view.onApplied).toHaveBeenCalledTimes(1));
    expect(w.cards.posts).toHaveLength(2);
    expect(w.cards.posts[1]).toEqual(w.cards.posts[0]);
  });

  it("D5 a refusal: the reason is shown, the host reads the card again, the buttons stay", async () => {
    const w = world(["conflict"]);
    const view = show(w);
    fireEvent.click(screen.getByRole("button", { name: "Не повторять" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Карточка уже изменилась. Показано актуальное состояние.");
    expect(view.onChanged).toHaveBeenCalledTimes(1);
    expect(view.onApplied).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Не повторять" })).toBeTruthy();
  });

  it("D6 «Сообщить об ошибке»: one field «Что не так?»; a failure keeps the text; success closes the window back to the card", async () => {
    const w = world([], ["lose"]);
    const view = show(w);
    fireEvent.click(screen.getByRole("button", { name: "Сообщить об ошибке" }));
    const dialog = screen.getByRole("dialog", { name: "Сообщить об ошибке" });
    const field = within(dialog).getByRole("textbox", { name: "Что не так?" }) as HTMLTextAreaElement;
    await waitFor(() => expect(field.readOnly).toBe(false));
    expect(document.activeElement).toBe(field);
    expect((within(dialog).getByRole("button", { name: "Отправить" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(field, { target: { value: "Falscher Artikel" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Отправить" }));
    await within(dialog).findByRole("button", { name: "Повторить отправку" });
    expect(field.value).toBe("Falscher Artikel");
    expect(w.complaints.posts).toEqual([expect.objectContaining({ kind: "feedback.send", payload: { text: "Falscher Artikel", card_id: CARD } })]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Повторить отправку" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText("Сообщение отправлено.")).toBeTruthy();
    // The lost reply was applied: «Повторить» found it by the same ID and sent nothing new.
    expect(w.complaints.posts).toHaveLength(1);
    expect(w.fetcher.mock.calls.some(([url]) => String(url).endsWith(`/commands/${w.complaints.posts[0].command_id}`))).toBe(true);
    expect(view.onChanged).toHaveBeenCalledTimes(1);
    // A new window starts empty and the earlier note goes away.
    fireEvent.click(screen.getByRole("button", { name: "Сообщить об ошибке" }));
    expect((within(screen.getByRole("dialog")).getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
    expect(screen.queryByText("Сообщение отправлено.")).toBeNull();
  });

  it("D7 closing the complaint window keeps the typed text for the next opening; native Back closes it", async () => {
    const back = nativeBack(), w = world();
    show(w);
    fireEvent.click(screen.getByRole("button", { name: "Сообщить об ошибке" }));
    const field = within(screen.getByRole("dialog")).getByRole("textbox") as HTMLTextAreaElement;
    await waitFor(() => expect(field.readOnly).toBe(false));
    fireEvent.change(field, { target: { value: "Tippfehler" } });
    await back.click();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Сообщить об ошибке" }));
    expect((within(screen.getByRole("dialog")).getByRole("textbox") as HTMLTextAreaElement).value).toBe("Tippfehler");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Закрыть" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(w.complaints.posts).toHaveLength(0);
  });

  it("D8 SETUP_REQUIRED: its own reason, no «Повторить», no status check; the card is read again", async () => {
    const w = world(["setup"]);
    w.cards.state.excluded = true; w.cards.state.version = "3";
    const view = show(w, excluded());
    fireEvent.click(screen.getByRole("button", { name: "Вернуть в повторы" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Сначала нужно подтвердить часовой пояс в настройках.");
    expect(screen.queryByRole("button", { name: "Повторить" })).toBeNull();
    expect(w.cards.gets).toHaveLength(0);
    expect(view.onChanged).toHaveBeenCalledTimes(1);
    expect(view.onApplied).not.toHaveBeenCalled();
  });

  it("D9 FORBIDDEN: a plain refusal without «Повторить»; the card is read again", async () => {
    const w = world(["forbidden"]);
    const view = show(w);
    fireEvent.click(screen.getByRole("button", { name: "Не повторять" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Не удалось сохранить действие.");
    expect(screen.queryByRole("button", { name: "Повторить" })).toBeNull();
    expect(w.cards.gets).toHaveLength(0);
    expect(view.onChanged).toHaveBeenCalledTimes(1);
  });
});
