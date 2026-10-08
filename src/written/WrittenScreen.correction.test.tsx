// The screen of an unknown correction (moved from the independent QA of M-WCORR, QA-S1; TA:107, TA табл. 5.1).
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useWrittenDocument } from "./useWrittenDocument";
import { WrittenScreen } from "./WrittenScreen";
import { writtenFixture } from "./writtenFixtures.test-support";

afterEach(() => { cleanup(); });

describe("WrittenScreen: correction", () => {
  it("an unknown correction keeps the old result on screen, says it is being checked and offers no action", async () => {
    const f = writtenFixture();
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
    const field = () => screen.getByRole("textbox") as HTMLTextAreaElement;
    await screen.findByRole("button", { name: "start-words" });
    // Let the owner's first recovery settle before the start tap.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    fireEvent.click(screen.getByRole("button", { name: "start-words" }));
    await waitFor(() => expect(field().readOnly).toBe(false));
    fireEvent.change(field(), { target: { value: "falsch" } });
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    await screen.findByText("Есть ошибка");
    // The reply is lost and the server stays unreachable for the check.
    f.loseReply(); f.offline();
    fireEvent.click(screen.getByRole("button", { name: "Исправить ответ" }));
    await screen.findByText("Проверяем изменение");
    // Automatic recovery waits for the server under a blurred cover with its status (Я15.2).
    await screen.findByText("Нет связи с сервером. Ждём, когда связь восстановится…");
    // The submitted text stays visible; nothing claims the 4 yet and no revision is offered.
    expect(screen.getByText("falsch")).toBeTruthy();
    expect(screen.queryByText("Ответ исправлен")).toBeNull();
    expect(screen.queryByRole("button", { name: "Исправить ответ" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Легко" })).toBeNull();
    // No manual check or resend (Я15); Exit (Stop) stays.
    for (const name of ["Проверить состояние", "Повторить отправку"]) expect(screen.queryByRole("button", { name })).toBeNull();
    expect(screen.getByRole("button", { name: "Выйти" })).toBeTruthy();
  });
});
