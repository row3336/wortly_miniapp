import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useWrittenDocument } from "./useWrittenDocument";
import { WrittenScreen } from "./WrittenScreen";
import { WrittenSummary } from "./WrittenSummary";
import { writtenFixture, type ServerOptions } from "./writtenFixtures.test-support";

afterEach(() => { cleanup(); vi.useRealTimers(); });

function setup(options: ServerOptions = {}, mode: "normal" | "accelerated" = "normal") {
  const f = writtenFixture(options);
  const onToday = vi.fn();
  function Harness() {
    const { state, actions } = useWrittenDocument({ access: f.access(), storage: f.storage, transport: f.transport, newId: f.newId,
      transitionMode: mode });
    if (!state) return null;
    return <>
      <button type="button" onClick={() => { void actions.start("words"); }}>start-words</button>
      <button type="button" onClick={() => { void actions.start("phrases"); }}>start-phrases</button>
      <WrittenScreen state={state} language="ru" submitOnEnter actions={actions} onToday={onToday} />
    </>;
  }
  render(<Harness />);
  const kinds = () => f.posts().map(post => post.kind);
  const start = async () => {
    await waitFor(() => expect(screen.getByRole("button", { name: "start-words" })).toBeTruthy());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    fireEvent.click(screen.getByRole("button", { name: "start-words" }));
    await waitFor(() => expect((screen.getByRole("textbox") as HTMLTextAreaElement).readOnly).toBe(false));
  };
  const field = () => screen.getByRole("textbox") as HTMLTextAreaElement;
  const button = (name: string | RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;
  return { ...f, onToday, kinds, start, field, button };
}

describe("М08 written task screen", () => {
  it("answers, shows the confirmed result with grades and moves on after an explicit grade", async () => {
    const h = setup(); await h.start();
    expect(screen.getByRole("heading", { name: "Слова: перевод на немецкий" })).toBeTruthy();
    expect(screen.getByText("слово 6")).toBeTruthy();
    fireEvent.change(h.field(), { target: { value: "Haus" } });
    fireEvent.click(h.button("Проверить"));
    await screen.findByText("Верно");
    expect(screen.getByText("das Haus")).toBeTruthy();
    expect(["Трудно", "Нормально", "Легко"].every(name => h.button(name))).toBe(true);
    expect(screen.queryByRole("button", { name: "Исправить ответ" })).toBeNull();
    fireEvent.click(h.button("Легко"));
    await screen.findByText("слово 7");
    expect(h.kinds()).toEqual(["session.start", "assignment.present", "answer.submit", "result.grade", "assignment.present"]);
    expect(h.posts()[3]).toMatchObject({ payload: { grade: 5 } });
  });

  it("Enter submits once, but Enter of an IME composition sends nothing", async () => {
    const h = setup(); await h.start();
    fireEvent.change(h.field(), { target: { value: "Haus" } });
    fireEvent.compositionStart(h.field());
    fireEvent.keyDown(h.field(), { key: "Enter" });
    fireEvent.compositionEnd(h.field());
    fireEvent.keyDown(h.field(), { key: "Enter", isComposing: true });
    fireEvent.keyDown(h.field(), { key: "Enter", keyCode: 229 });
    await act(async () => {});
    expect(h.kinds()).not.toContain("answer.submit");
    fireEvent.keyDown(h.field(), { key: "Enter" });
    await screen.findByText("Верно");
    expect(h.kinds().filter(kind => kind === "answer.submit")).toHaveLength(1);
  });

  it("Enter on a result advances, but not while an IME composition is open", async () => {
    const h = setup(); await h.start();
    fireEvent.change(h.field(), { target: { value: "falsch" } }); fireEvent.click(h.button("Проверить"));
    await screen.findByText("Есть ошибка");
    const main = document.querySelector("main")!;
    fireEvent.compositionStart(main); fireEvent.keyDown(document.body, { key: "Enter" }); fireEvent.compositionEnd(main);
    fireEvent.keyDown(document.body, { key: "Enter", isComposing: true });
    await act(async () => {});
    expect(h.kinds().at(-1)).toBe("answer.submit");
    fireEvent.keyDown(document.body, { key: "Enter" });
    await screen.findByText("слово 7");
    expect(h.kinds().at(-1)).toBe("assignment.present");
  });

  it("a held Enter on a result never advances; a fresh press does (TA §2)", async () => {
    const h = setup(); await h.start();
    fireEvent.change(h.field(), { target: { value: "falsch" } }); fireEvent.click(h.button("Проверить"));
    await screen.findByText("Есть ошибка");
    fireEvent.keyDown(document.body, { key: "Enter", repeat: true });
    await act(async () => {});
    expect(h.kinds().at(-1)).toBe("answer.submit");
    fireEvent.keyDown(document.body, { key: "Enter" });
    await screen.findByText("слово 7");
  });

  it("an ordinary request shows only its indicator; checking appears for an unknown outcome (TA табл. 5.1)", async () => {
    const h = setup(); await h.start();
    fireEvent.change(h.field(), { target: { value: "Haus" } });
    const gate = h.hold(); fireEvent.click(h.button("Проверить"));
    await screen.findByText("Сохраняем ответ…");
    expect(screen.queryByRole("button", { name: "Проверить состояние" })).toBeNull();
    gate.resolve(); await screen.findByText("Верно");
    fireEvent.click(h.button("Далее")); await screen.findByText("слово 7");
    await waitFor(() => expect(h.field().readOnly).toBe(false));
    fireEvent.change(h.field(), { target: { value: "Haus" } });
    h.dropRequest(); fireEvent.click(h.button("Проверить"));
    await screen.findByRole("button", { name: "Проверить состояние" });
    expect(screen.getByText("Проверяем, сохранилось ли действие.")).toBeTruthy();
  });

  it("the previous result says that B is still being confirmed until its present commits (TA §5)", async () => {
    const h = setup({ cards: [6, 7, 8] }); await h.start();
    fireEvent.change(h.field(), { target: { value: "Haus" } }); fireEvent.click(h.button("Проверить"));
    await screen.findByText("Верно");
    const gate = h.hold(); fireEvent.click(h.button("Далее"));
    await screen.findByText("слово 7");
    fireEvent.click(h.button("Предыдущий ответ"));
    await screen.findByText("Верно");
    expect(screen.getByText("Подтверждаем показ задания…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Легко" })).toBeNull();
    gate.resolve();
    await waitFor(() => expect(screen.queryByText("Подтверждаем показ задания…")).toBeNull());
    expect(h.button("Легко").disabled).toBe(false);
  });

  it("while the summary of an own Stop is read, the status says so in words", async () => {
    const h = setup(); await h.start();
    fireEvent.change(h.field(), { target: { value: "Haus" } }); fireEvent.click(h.button("Проверить"));
    await screen.findByText("Верно");
    // The Stop request is lost; meanwhile the session was closed by Stop, so the closed numbers are not at hand.
    h.dropRequest(); fireEvent.click(h.button("Выйти"));
    await screen.findByText("Завершаем занятие…");
    Object.assign(h.server.state, { status: "closed", closeReason: "stop", assignment: null, version: h.server.state.version + 1 });
    // The status check of the Stop goes through; the following read of the closed session is held.
    h.fetcher.mockImplementationOnce(h.server.handle); const gate = h.hold();
    fireEvent.click(h.button("Проверить состояние"));
    const status = await screen.findByRole("status", { name: "Итог занятия" });
    expect(status.textContent).toBe("Загружаем занятие…");
    gate.resolve(); await screen.findByText("Занятие прервано.");
  });

  it("a wrong answer offers «Исправить ответ» by the server right: one tap gives 4, then 3/5 (Т06)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const h = setup(); await h.start();
    fireEvent.change(h.field(), { target: { value: "falsch" } }); fireEvent.click(h.button("Проверить"));
    await screen.findByText("Есть ошибка");
    expect(document.querySelector(".written-timer")).toBeNull();
    expect(screen.queryByRole("button", { name: "Легко" })).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(h.kinds().at(-1)).toBe("answer.submit");
    fireEvent.click(h.button("Исправить ответ"));
    await screen.findByText("Ответ исправлен");
    expect(h.posts().at(-1)).toMatchObject({ kind: "result.correct", payload: {} });
    expect(screen.queryByRole("button", { name: "Исправить ответ" })).toBeNull();
    expect(["Трудно", "Нормально", "Легко"].every(name => h.button(name))).toBe(true);
    // The submitted text is not edited or checked again (К05-053/054).
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText("falsch")).toBeTruthy();
  });

  it("the written result shows one German example of the answered card after the answer only (К05-126)", async () => {
    const h = setup({ examples: { common: [{ id: "00000000-0000-4000-8000-000000000501", text: "Das Haus ist alt.", role: "general",
      highlighted_parts: [] }],
      personal: { value: "Mein Haus ist klein.", version: "1" } } });
    await h.start();
    expect(document.querySelector(".german-example")).toBeNull();
    fireEvent.change(h.field(), { target: { value: "Haus" } }); fireEvent.click(h.button("Проверить"));
    await screen.findByText("Верно");
    expect([...document.querySelectorAll(".german-example")].map(node => node.textContent)).toEqual(["Mein Haus ist klein."]);
  });

  it("a wrong answer waits for «Далее» in the normal mode", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const h = setup(); await h.start();
    fireEvent.change(h.field(), { target: { value: "falsch" } }); fireEvent.click(h.button("Проверить"));
    await screen.findByText("Есть ошибка");
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(h.kinds().at(-1)).toBe("answer.submit");
    fireEvent.click(h.button("Далее"));
    await screen.findByText("слово 7");
  });

  it("while a correction is unconfirmed its result says so and no action is offered", async () => {
    const h = setup(); await h.start();
    fireEvent.change(h.field(), { target: { value: "falsch" } }); fireEvent.click(h.button("Проверить"));
    await screen.findByText("Есть ошибка");
    const gate = h.hold(); fireEvent.click(h.button("Исправить ответ"));
    await screen.findByText("Сохраняем изменение");
    expect(h.button("Далее").disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Исправить ответ" })).toBeNull();
    gate.resolve(); await screen.findByText("Ответ исправлен");
  });

  it("the previous result keeps the next card's draft and returns to it by «Далее»", async () => {
    const h = setup({ cards: [6, 7, 8] }); await h.start();
    fireEvent.change(h.field(), { target: { value: "Haus" } }); fireEvent.click(h.button("Проверить"));
    await screen.findByText("Верно"); fireEvent.click(h.button("Далее"));
    await screen.findByText("слово 7");
    await waitFor(() => expect(h.field().readOnly).toBe(false));
    fireEvent.change(h.field(), { target: { value: "Entwurf" } });
    fireEvent.click(h.button("Предыдущий ответ"));
    await screen.findByText("Верно");
    expect(document.querySelector(".written-timer")).toBeNull();
    fireEvent.click(h.button("Далее"));
    await screen.findByText("слово 7");
    expect(h.field().value).toBe("Entwurf");
    expect(h.kinds().filter(kind => kind === "assignment.present")).toHaveLength(2);
  });

  it("Exit stops without confirmation, discards the draft and shows the interrupted summary (Д02)", async () => {
    const h = setup({ cards: [6, 7, 8] }); await h.start();
    fireEvent.change(h.field(), { target: { value: "Haus" } }); fireEvent.click(h.button("Проверить"));
    await screen.findByText("Верно"); fireEvent.click(h.button("Далее"));
    await screen.findByText("слово 7");
    fireEvent.change(h.field(), { target: { value: "unsent" } });
    fireEvent.click(h.button("Выйти"));
    await screen.findByRole("region", { name: "Итог занятия" });
    expect(screen.getByText("Занятие прервано.")).toBeTruthy();
    const values = Array.from(document.querySelectorAll(".written-summary dd"), item => item.textContent);
    expect(values.slice(0, 3)).toEqual(["1", "1", "0"]); expect(values[3]).toMatch(/^100\s?%$/);
    expect(h.kinds().filter(kind => kind === "session.stop")).toHaveLength(1);
    expect(h.posts().some(post => post.payload?.text === "unsent")).toBe(false);
    fireEvent.click(h.button("На Сегодня"));
    expect(h.onToday).toHaveBeenCalledOnce();
    expect(h.kinds().filter(kind => kind === "session.stop")).toHaveLength(1);
  });

  it("the natural end shows the completed summary and «На Сегодня» closes it with summary_home", async () => {
    const h = setup({ cards: [6] }); await h.start();
    fireEvent.change(h.field(), { target: { value: "falsch" } }); fireEvent.click(h.button("Проверить"));
    await screen.findByText("Есть ошибка"); fireEvent.click(h.button("Далее"));
    await screen.findByText("Занятие завершено.");
    const values = Array.from(document.querySelectorAll(".written-summary dd"), item => item.textContent);
    expect(values.slice(0, 3)).toEqual(["1", "0", "1"]); expect(values[3]).toMatch(/^0\s?%$/);
    fireEvent.click(h.button("На Сегодня"));
    await waitFor(() => expect(h.posts().at(-1)).toMatchObject({ kind: "session.stop", payload: { reason: "summary_home" } }));
  });

  it("a refused phrases start keeps the phrases heading and a phrases-neutral reason", async () => {
    const h = setup({ refuseStart: "NO_MATERIAL" });
    await waitFor(() => expect(screen.getByRole("button", { name: "start-phrases" })).toBeTruthy());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    fireEvent.click(screen.getByRole("button", { name: "start-phrases" }));
    await screen.findByText("Пока нет доступного материала");
    expect(h.posts()[0]).toMatchObject({ kind: "session.start", payload: { bucket: "phrases" } });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Фразы: перевод на немецкий");
    expect(screen.queryByText("Сейчас нет доступных слов для этого занятия.")).toBeNull();
  });

  it("a refused start shows its reason and offers Today", async () => {
    const h = setup({ refuseStart: "NO_MATERIAL" });
    await waitFor(() => expect(screen.getByRole("button", { name: "start-words" })).toBeTruthy());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    fireEvent.click(screen.getByRole("button", { name: "start-words" }));
    await screen.findByText("Сейчас нет доступных слов для этого занятия.");
    fireEvent.click(h.button("На Сегодня")); expect(h.onToday).toHaveBeenCalledOnce();
  });
});

describe("Д02 summary numbers", () => {
  it("shows «—» instead of 0 % when nothing was answered (В06.3)", () => {
    render(<WrittenSummary summary={{ completed: 0, correct: 0, wrong: 0, ratio: null }} outcome="interrupted" language="ru"
      canToday onToday={() => undefined} />);
    expect(Array.from(document.querySelectorAll("dd"), item => item.textContent)).toEqual(["0", "0", "0", "—"]);
  });
  it.each([["ru", /^67\s?%$/], ["uk", /^67\s?%$/], ["en", /^67%$/]] as const)("formats the confirmed ratio in %s", (language, expected) => {
    render(<WrittenSummary summary={{ completed: 3, correct: 2, wrong: 1, ratio: { numerator: 2, denominator: 3 } }} outcome="completed"
      language={language} canToday onToday={() => undefined} />);
    expect(Array.from(document.querySelectorAll("dd")).at(-1)!.textContent).toMatch(expected);
  });
});
