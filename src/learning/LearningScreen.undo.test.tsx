// The «Шаг назад» control of the Learning screen (M-UNDO CP2; К05-067, К10-127, К05-151).
import { useEffect, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { id } from "./learningFixtures.test-support";
import { LearningScreen } from "./LearningScreen";
import { learningUndoServer, type LearningUndoOptions } from "./learningUndo.test-support";
import { LearningViewController, type LearningViewSnapshot } from "./learningViewController";

const owners: LearningViewController[] = [];
afterEach(() => { cleanup(); owners.splice(0).forEach(owner => owner.dispose()); });

async function mount(options: LearningUndoOptions = {}) {
  const s = learningUndoServer(options);
  const onUpdate = vi.fn<(snapshot: LearningViewSnapshot) => void>();
  const view = new LearningViewController({ access: s.access, storage: s.storage, newId: s.newId,
    transport: { fetcher: s.fetcher, timeoutMs: 30000, maxResponseBytes: 100000 }, sessionId: id(3), transitionMode: () => "normal", onUpdate });
  owners.push(view);
  function Live() {
    const [state, setState] = useState(() => view.snapshot());
    useEffect(() => { onUpdate.mockImplementation(setState); return () => { onUpdate.mockReset(); }; }, []);
    return <LearningScreen state={state} language="ru" submitOnEnter actions={view} renderPreview={() => null} />;
  }
  render(<Live />);
  await act(() => view.refresh());
  const field = () => screen.getByRole("textbox") as HTMLTextAreaElement;
  const answer = async (text: string) => {
    fireEvent.change(field(), { target: { value: text } });
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    await waitFor(() => expect(view.snapshot().phase).toMatch(/^result_/));
  };
  return { s, view, field, answer };
}
const stepBack = () => screen.queryByRole("button", { name: "Шаг назад" });

describe("LearningScreen: «Шаг назад»", () => {
  it("is not shown without the server's right", async () => {
    const { answer } = await mount({ undo: false });
    await answer("falsch");
    expect(screen.getByRole("button", { name: "Исправить ответ" })).toBeTruthy();
    expect(stepBack()).toBeNull();
  });
  it("undoes the answer from its result and asks the card again with an empty field", async () => {
    const { s, field, answer } = await mount();
    await answer("falsch");
    fireEvent.click(stepBack()!);
    await waitFor(() => expect(s.posts().at(-1)).toMatchObject({ kind: "assignment.present", assignment_id: id(10006) }));
    await waitFor(() => expect(field().readOnly).toBe(false));
    expect(field().value).toBe("");
    expect(stepBack()).toBeNull();
  });
  it("is on the phase summary and returns to the card", async () => {
    const { s, view, field, answer } = await mount({ cards: [6] });
    await answer("Haus");
    await act(() => view.next());
    expect(screen.getByRole("button", { name: "Вернуться на Сегодня" })).toBeTruthy();
    fireEvent.click(stepBack()!);
    await waitFor(() => expect(s.posts().at(-1)).toMatchObject({ kind: "assignment.present", assignment_id: id(10006) }));
    await waitFor(() => expect(field().readOnly).toBe(false));
    expect(screen.queryByRole("button", { name: "Вернуться на Сегодня" })).toBeNull();
  });
  it("while the undo from the summary is saved, the summary and its «Вернуться на Сегодня» are gone", async () => {
    const { s, view, answer } = await mount({ cards: [6] });
    await answer("Haus");
    await act(() => view.next());
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const handle = s.fetcher.getMockImplementation()!;
    s.fetcher.mockImplementationOnce(async (...call) => { await gate; return handle(...call); });
    fireEvent.click(stepBack()!);
    await screen.findByText("Отменяем ответ…");
    expect(screen.queryByRole("button", { name: "Вернуться на Сегодня" })).toBeNull();
    expect(stepBack()).toBeNull();
    await act(async () => { release(); });
    await waitFor(() => expect(s.posts().at(-1)).toMatchObject({ kind: "assignment.present", assignment_id: id(10006) }));
  });
  it("the phase summary without the right has no «Шаг назад»", async () => {
    const { view, answer } = await mount({ cards: [6], undo: false });
    await answer("Haus");
    await act(() => view.next());
    expect(screen.getByRole("button", { name: "Вернуться на Сегодня" })).toBeTruthy();
    expect(stepBack()).toBeNull();
  });
  it("a refusal says that the step back is no longer available", async () => {
    const { answer } = await mount({ refuseUndo: { code: "CAPABILITY_EXPIRED" } });
    await answer("falsch");
    fireEvent.click(stepBack()!);
    await screen.findByText("Шаг назад больше недоступен.");
    expect(stepBack()).toBeNull();
  });
});
