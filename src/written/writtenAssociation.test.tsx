import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SettingsDocument } from "../settings/useSettingsDocument";
import { useWrittenHost } from "./useWrittenHost";
import { id, writtenFixture, type ServerOptions } from "./writtenFixtures.test-support";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// R12-08 вар.2 in the written quiz: the own association after a mistake; its invitation opens М12 like «Уточнить поля»
// and, like it, leaves the quiz without a running auto-advance timer.
const settings = (mode: "normal" | "accelerated") => ({ state: { phase: "ready", data: null, dataCurrent: true, drafts: {}, pending: null,
  outcome: null, problem: null, canEdit: true, canRetry: false }, confirmed: { state_version: "1", settings: { dictionary_language: { value: "ru" },
  transition_mode: { value: mode } } }, actions: { refresh: vi.fn(async () => undefined) } } as unknown as SettingsDocument);

function Quiz({ f, mode }: { f: ReturnType<typeof writtenFixture>; mode: "normal" | "accelerated" }) {
  const [card, setCard] = useState<string | null>(null);
  const [conf] = useState(() => settings(mode));
  const written = useWrittenHost({ access: f.access(), transport: f.transport, storage: f.storage, newId: f.newId, language: "ru", settings: conf,
    initialSessionId: id(3), route: card === null ? "written" : "hidden", onWritten: () => undefined, onToday: () => undefined,
    onOpenCard: cardId => setCard(cardId) });
  return <>{written.screen}
    {card !== null && <section aria-label="М12 card"><p>{card}</p><button type="button" onClick={() => setCard(null)}>Назад</button></section>}</>;
}
async function answer(text: string) {
  await screen.findByText("слово 6");
  const field = screen.getByRole("textbox") as HTMLTextAreaElement;
  await waitFor(() => expect(field.readOnly).toBe(false));
  fireEvent.change(field, { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
}
const kinds = (f: ReturnType<typeof writtenFixture>) => f.posts().map(post => String(post.kind));
const quiz = (options: ServerOptions) => writtenFixture({ active: true, cards: [6, 7, 8], ...options });
const own = { value: "Haus: ха-ус, вот мой дом", version: "3" };

describe("the written quiz: the own association after a mistake", () => {
  it("a wrong answer shows the own association; a correct one does not (the server sends null then)", async () => {
    const f = quiz({ association: own });
    render(<Quiz f={f} mode="normal" />);
    // The native → German question never carries the association: it would hint at the answer before it is given.
    await screen.findByText("слово 6");
    expect(screen.queryByText(own.value)).toBeNull(); expect(screen.queryByRole("region", { name: /ассоциаци/i })).toBeNull();
    expect(document.body.textContent).not.toContain("ха-ус");
    await answer("falsch");
    const hint = await screen.findByRole("region", { name: "Твоя ассоциация" });
    expect(within(hint).getByText(own.value).getAttribute("lang")).toBe("ru");
    expect(screen.queryByRole("button", { name: "Добавить ассоциацию" })).toBeNull();
  });
  it("a correct answer: no block, no invitation", async () => {
    const f = quiz({ association: null });
    render(<Quiz f={f} mode="normal" />);
    await answer("Haus");
    await screen.findByText("Верно");
    expect(screen.queryByRole("region", { name: "Твоя ассоциация" })).toBeNull(); expect(screen.queryByText(/Своей ассоциации пока нет/)).toBeNull();
  });
  it("none of their own: the invitation opens the card of the answered word and sends no command", async () => {
    const f = quiz({ association: null });
    render(<Quiz f={f} mode="normal" />);
    await answer("falsch");
    const hint = await screen.findByRole("region", { name: "Твоя ассоциация" });
    expect(within(hint).getByText(/Своей ассоциации пока нет/)).toBeTruthy();
    const before = kinds(f);
    fireEvent.click(within(hint).getByRole("button", { name: "Добавить ассоциацию" }));
    expect((await screen.findByRole("region", { name: "М12 card" })).textContent).toContain(id(106));
    expect(kinds(f)).toEqual(before);
  });
  it("an older core without the key: no block", async () => {
    const f = quiz({});
    render(<Quiz f={f} mode="normal" />);
    await answer("falsch");
    await screen.findByText("Есть ошибка");
    expect(screen.queryByRole("region", { name: "Твоя ассоциация" })).toBeNull();
  });

  // The auto-advance timer (accelerated mode: 2 s, a mistake included) must not move the quiz on while М12 is open
  // over it, and must not run by itself on the way back: the result waits for «Далее».
  it("control: without opening the card the accelerated timer moves the quiz on by itself", async () => {
    const f = quiz({ association: null });
    render(<Quiz f={f} mode="accelerated" />);
    await answer("falsch");
    await screen.findByRole("region", { name: "Твоя ассоциация" });
    await waitFor(() => expect(kinds(f)).toContain("assignment.present"), { timeout: 5000 });
  }, 15000);
  it("the invitation opens М12 with the timer stopped: no auto-advance while it is open or after the return", async () => {
    const f = quiz({ association: null });
    render(<Quiz f={f} mode="accelerated" />);
    await answer("falsch");
    const hint = await screen.findByRole("region", { name: "Твоя ассоциация" });
    fireEvent.click(within(hint).getByRole("button", { name: "Добавить ассоциацию" }));
    await screen.findByRole("region", { name: "М12 card" });
    await new Promise(resolve => setTimeout(resolve, 2800));
    expect(kinds(f)).not.toContain("assignment.present");
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    await screen.findByRole("region", { name: "Твоя ассоциация" });
    await new Promise(resolve => setTimeout(resolve, 2800));
    expect(kinds(f)).not.toContain("assignment.present");
    expect((screen.getByRole("button", { name: "Далее" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole("region", { name: "Твоя ассоциация" })).toBeTruthy();
  }, 20000);
});
