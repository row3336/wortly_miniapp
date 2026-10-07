// The «Шаг назад» control of the written screen (M-UNDO; К05-067, К05-068, RA Д02).
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useWrittenDocument } from "./useWrittenDocument";
import { WrittenScreen } from "./WrittenScreen";
import { id, writtenFixture, type ServerOptions } from "./writtenFixtures.test-support";

afterEach(() => { cleanup(); });

async function open(options: ServerOptions = {}) {
  const f = writtenFixture({ undo: true, ...options });
  function Harness() {
    const { state, actions } = useWrittenDocument({ access: f.access(), storage: f.storage, transport: f.transport, newId: f.newId,
      transitionMode: "normal" });
    if (!state) return null;
    return <>
      <button type="button" onClick={() => { void actions.start("words"); }}>start-words</button>
      <WrittenScreen state={state} language="ru" submitOnEnter actions={actions} onToday={vi.fn()} />
    </>;
  }
  render(<Harness />);
  await screen.findByRole("button", { name: "start-words" });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  fireEvent.click(screen.getByRole("button", { name: "start-words" }));
  const field = () => screen.getByRole("textbox") as HTMLTextAreaElement;
  await waitFor(() => expect(field().readOnly).toBe(false));
  const answer = async (text: string) => {
    fireEvent.change(field(), { target: { value: text } });
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
  };
  return { f, field, answer };
}
const stepBack = () => screen.queryByRole("button", { name: "Шаг назад" });

describe("WrittenScreen: «Шаг назад»", () => {
  it("is an icon button on the result only while the server grants it", async () => {
    const { answer } = await open({ undo: false });
    await answer("falsch"); await screen.findByText("Есть ошибка");
    expect(screen.getByRole("button", { name: "Исправить ответ" })).toBeTruthy();
    expect(stepBack()).toBeNull();
  });
  it("undoes the answer and shows the card again with an empty field", async () => {
    const { f, field, answer } = await open();
    await answer("falsch"); await screen.findByText("Есть ошибка");
    expect(stepBack()?.textContent).toBe("↶");
    fireEvent.click(stepBack()!);
    await waitFor(() => expect(f.posts().at(-1)).toMatchObject({ kind: "assignment.present", assignment_id: id(10006) }));
    await waitFor(() => expect(field().readOnly).toBe(false));
    expect(field().value).toBe("");
    expect(screen.queryByText("Есть ошибка")).toBeNull();
    expect(stepBack()).toBeNull();
  });
  it("is on the summary next to «На Сегодня» and returns to the card", async () => {
    const { f, field, answer } = await open({ cards: [6] });
    await answer("Haus"); await screen.findByText("Верно");
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    await screen.findByRole("region", { name: "Итог занятия" });
    expect(screen.getByRole("button", { name: "На Сегодня" })).toBeTruthy();
    fireEvent.click(stepBack()!);
    await waitFor(() => expect(f.posts().at(-1)).toMatchObject({ kind: "assignment.present", assignment_id: id(10006) }));
    await waitFor(() => expect(field().readOnly).toBe(false));
    expect(screen.queryByRole("region", { name: "Итог занятия" })).toBeNull();
  });
  it("the summary has no «Шаг назад» while the server grants none", async () => {
    await open({ cards: [6], undo: false }).then(async ({ answer }) => {
      await answer("Haus"); await screen.findByText("Верно");
      fireEvent.click(screen.getByRole("button", { name: "Далее" }));
      await screen.findByRole("region", { name: "Итог занятия" });
      expect(screen.getByRole("button", { name: "На Сегодня" })).toBeTruthy();
      expect(stepBack()).toBeNull();
    });
  });
  it("a refusal says that the step back is no longer available and removes the button", async () => {
    const { answer } = await open({ refuseUndo: { code: "CAPABILITY_EXPIRED" } });
    await answer("falsch"); await screen.findByText("Есть ошибка");
    fireEvent.click(stepBack()!);
    await screen.findByText("Шаг назад больше недоступен.");
    expect(screen.getByText("Есть ошибка")).toBeTruthy();
    expect(stepBack()).toBeNull();
  });
});
