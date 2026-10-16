import { useEffect, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WrittenAnswerDetail } from "../api/generated";
import type { Language } from "../i18n/language";
import { LearningScreen } from "./LearningScreen";
import { learningViewFixture } from "./learningView.test-support";
import { current, deferred, id, missing, original, pending, primaryKey, response } from "./learningFixtures.test-support";
import type { LearningViewController } from "./learningViewController";
import { hasPending, seedRaw } from "../commands/pendingSeed.test-support";

const owners: LearningViewController[] = [];
afterEach(() => { cleanup(); owners.splice(0).forEach(owner => owner.dispose()); vi.useRealTimers(); });
type Fixture = ReturnType<typeof learningViewFixture>;
function LiveScreen({ f, language = "ru", submitOnEnter = true }: { f: Fixture; language?: Language; submitOnEnter?: boolean }) {
  const [state, setState] = useState(() => f.view.snapshot());
  useEffect(() => { f.onUpdate.mockImplementation(setState); return () => { f.onUpdate.mockReset(); }; }, [f]);
  return <LearningScreen state={state} language={language} submitOnEnter={submitOnEnter} actions={f.view}
    renderPreview={preview => <p data-testid="preview">{preview.content.card.lemma}</p>} />;
}
async function mount(options: { language?: Language; submitOnEnter?: boolean; fresh?: boolean; wrong?: boolean } = {}) {
  const f = learningViewFixture("normal", options.fresh ? null : id(3)); owners.push(f.view);
  if (options.wrong) f.wrong();
  const ui = render(<LiveScreen f={f} {...options} />);
  await act(() => f.view.refresh());
  return { f, ...ui };
}
const input = () => screen.getByRole("textbox") as HTMLTextAreaElement;
const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
async function answer(f: Fixture, value = "Haus") {
  fireEvent.change(input(), { target: { value } }); click("Проверить");
  await waitFor(() => expect(f.view.snapshot().phase).toMatch(/^result_/));
  // The controller is ahead of the screen: Enter (useEnterNext) listens only once the rendered result offers «Далее» as
  // the controller allows it. Wait for that render, not for the snapshot alone, then flush its effects.
  await waitFor(() => {
    const next = screen.getByRole("button", { name: "Далее" }) as HTMLButtonElement;
    expect(next.disabled).toBe(!f.view.snapshot().canNext);
  });
  await act(async () => {});
}
function lastPost(f: Fixture) { return f.fetcher.mock.calls.filter(call => call[1]?.method === "POST").at(-1)!; }

describe("Learning screen with its real command owner", () => {
  it("estimates entered forms locally and still sends an incomplete draft only on explicit submit", async () => {
    const f = learningViewFixture(); owners.push(f.view);
    const step = current();
    step.assignment!.answer_spec = { kind: "forms", labels: ["Infinitiv", "Präteritum", "Partizip II"],
      part_count: 3, case_sensitive: true };
    f.setStep(step); render(<LiveScreen f={f} />); await act(() => f.view.refresh());
    const field = input(); field.focus(); const requests = f.fetcher.mock.calls.length;
    fireEvent.change(field, { target: { value: "gehen" } });
    expect(screen.getByText("Заполнено частей (примерно): 1 из 3")).toBeTruthy();
    fireEvent.change(field, { target: { value: "gehen / ging ↔ ist gegangen" } });
    expect(screen.getByText("Заполнено частей (примерно): 3 из 3")).toBeTruthy();
    expect(f.fetcher).toHaveBeenCalledTimes(requests); expect(f.newId).not.toHaveBeenCalled(); expect(f.posts()).toEqual([]);
    fireEvent.change(field, { target: { value: "  gehen\n" } });
    const gate = deferred<Response>(); f.fetcher.mockReturnValueOnce(gate.promise); click("Проверить");
    await waitFor(() => expect(f.posts()).toHaveLength(1));
    expect(f.posts()[0].payload).toEqual({ text: "  gehen\n" });
    expect(input()).toBe(field); expect(document.activeElement).toBe(field); expect(field.readOnly).toBe(true);
    expect(screen.getByText("Заполнено частей (примерно): 1 из 3")).toBeTruthy();
    expect(screen.queryByText("Верно")).toBeNull(); expect(screen.queryByText("Есть ошибка")).toBeNull();
    await act(async () => { gate.resolve(await f.handler(...lastPost(f))); });
    await waitFor(() => expect(f.view.snapshot().phase).toBe("result_correct"));
  });
  it("keeps one read-only draft field until foreground recovery finishes", async () => {
    const { f } = await mount(); const field = input(); field.focus();
    fireEvent.change(field, { target: { value: "draft" } }); act(() => f.view.suspend());
    expect(input()).toBe(field); expect(field.readOnly).toBe(true); expect(field.value).toBe("draft");
    fireEvent.change(field, { target: { value: "overwrite" } }); fireEvent.keyDown(field, { key: "Enter" });
    click("Проверить"); click("Забыл…"); expect(f.posts()).toEqual([]); expect(f.view.snapshot().draft).toBe("draft");
    const gate = deferred<Response>(); f.fetcher.mockReturnValueOnce(gate.promise); f.replace();
    let resuming!: Promise<void>; act(() => { resuming = f.view.resume(); });
    await waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(2)); expect(input()).toBe(field); expect(field.readOnly).toBe(true);
    await act(async () => { gate.resolve(await f.handler(...f.fetcher.mock.calls.at(-1)!)); await resuming; });
    expect(input()).toBe(field); expect(field.readOnly).toBe(false); expect(field.value).toBe("draft");
    expect(document.activeElement).toBe(field); expect(f.posts()).toEqual([]);
  });
  it.each(["ru", "uk", "en"] as const)("%s presents the confirmed question without starting another session", async language => {
    const { f } = await mount({ language });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe({ ru: "Изучение слов", uk: "Вивчення слів", en: "Learn words" }[language]);
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("дом");
    expect(input().value).toBe(""); expect(f.posts()).toEqual([]);
  });
  it("keeps the same focused field and captured input while one answer is in flight", async () => {
    const { f } = await mount(); const field = input(); field.focus();
    fireEvent.change(field, { target: { value: "  Haus\n" } });
    const gate = deferred<Response>(); f.fetcher.mockReturnValueOnce(gate.promise);
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(f.posts()).toHaveLength(1));
    expect(input()).toBe(field); expect(document.activeElement).toBe(field); expect(field.readOnly).toBe(true);
    expect(field.value).toBe("  Haus\n"); expect(f.posts()[0].payload).toEqual({ text: "  Haus\n" });
    fireEvent.keyDown(field, { key: "Enter" }); click("Проверить"); click("Забыл…");
    fireEvent.change(field, { target: { value: "replacement" } }); expect(f.posts()).toHaveLength(1);
    expect(f.view.snapshot().draft).toBe("  Haus\n");
    await act(async () => { gate.resolve(await f.handler(...lastPost(f))); });
    await waitFor(() => expect(screen.getByText("Верно")).toBeTruthy()); expect(screen.queryByRole("textbox")).toBeNull();
  });
  it("submits Forgot without presenting an unfinished draft as the submitted answer", async () => {
    const { f } = await mount({ wrong: true }); fireEvent.change(input(), { target: { value: "unfinished" } });
    const gate = deferred<Response>(); f.fetcher.mockReturnValueOnce(gate.promise); click("Забыл…");
    await waitFor(() => expect(f.posts()).toHaveLength(1));
    expect(f.posts()[0].payload).toEqual({ forgot: true }); expect(input().value).toBe("");
    expect(screen.getByRole("status").textContent).toContain("Забыл…");
    await act(async () => { gate.resolve(await f.handler(...lastPost(f))); });
    await waitFor(() => expect(screen.getByText("Есть ошибка")).toBeTruthy());
  });
  it("recovers a lost accepted answer by GET by itself, under the waiting cover, without any button (Я15, Я15.2)", async () => {
    const { f } = await mount({ wrong: true });
    f.fetcher.mockImplementationOnce(async (...call) => { await f.handler(...call); throw new Error("lost response"); });
    // The machine's check by the same ID is held: the action is unknown meanwhile.
    const check = deferred<Response>(); f.fetcher.mockReturnValueOnce(check.promise);
    fireEvent.change(input(), { target: { value: "my exact input" } }); click("Проверить");
    await waitFor(() => expect(f.view.snapshot().commands.recovery?.state.name).toBe("checking"));
    expect(f.view.snapshot().phase).toBe("unknown");
    expect(input().readOnly).toBe(true); expect(input().value).toBe("my exact input");
    expect(document.querySelector(".recovery-overlay")?.textContent).toBe("Проверяем, сохранилось ли действие…");
    for (const name of ["Повторить отправку", "Проверить состояние"]) expect(screen.queryByRole("button", { name })).toBeNull();
    const status = f.fetcher.mock.calls.at(-1)!;
    await act(async () => { check.resolve(await f.handler(...status)); });
    await waitFor(() => expect(screen.getByText("Есть ошибка")).toBeTruthy());
    expect(document.querySelector(".recovery-overlay")).toBeNull();
    expect(f.posts().map(post => post.kind)).toEqual(["answer.submit"]);
  });
  it("after a reload a missing receipt keeps the saved text and is only checked: the count is unknown (CT §6.1 п. 4)", async () => {
    const f = learningViewFixture(); owners.push(f.view); const intent = original();
    seedRaw(f.values, primaryKey, JSON.stringify(pending(intent)), id(50));
    f.fetcher.mockImplementation(async (url, init) => init?.method === "GET" && String(url).includes(`/commands/${intent.command_id}`)
      ? response(missing(intent, "1")) : f.handler(url, init));
    render(<LiveScreen f={f} />); await act(() => f.view.refresh());
    await waitFor(() => expect(f.view.snapshot().commands.recovery?.state.name).toBe("counter_unknown"));
    expect(input().value).toBe("Haus"); expect(input().readOnly).toBe(true); expect(f.posts()).toEqual([]);
    // 9.2.9 + the voluntary Stop 9.2.10 (R10, C093 §6), not the checking text 9.2.1; no resend or manual check.
    expect(document.querySelector(".recovery-overlay")?.textContent)
      .toBe("Не удалось подтвердить последнее действие. Мы продолжаем проверять. Можно завершить занятие.Завершить занятие");
    expect(Array.from(document.querySelectorAll(".recovery-overlay button")).map(button => button.textContent)).toEqual(["Завершить занятие"]);
    for (const name of ["Повторить отправку", "Проверить состояние"]) expect(screen.queryByRole("button", { name })).toBeNull();
    expect(f.newId).not.toHaveBeenCalled();
  });
  it("a study result never offers a primary retry; Stop remains available", async () => {
    const f = learningViewFixture(); owners.push(f.view); const intent = original();
    seedRaw(f.values, primaryKey, JSON.stringify(pending(intent)), id(50));
    f.fetcher.mockImplementation(async (url, init) => init?.method === "GET" && String(url).includes(`/commands/${intent.command_id}`)
      ? response(missing(intent, "1")) : f.handler(url, init));
    render(<LiveScreen f={f} />); await act(() => f.view.refresh());
    expect(screen.queryByRole("button", { name: "Повторить отправку" })).toBeNull();
    expect(f.view.snapshot()).toMatchObject({ canRetryPrimary: false, commands: { automaticPrimary: true, primary: { canRetry: false } } });
    act(() => f.view.suspend());
    expect(screen.queryByRole("button", { name: "Повторить отправку" })).toBeNull();
    await act(() => f.view.retry("primary")); expect(f.posts()).toEqual([]);
    click("Выйти"); await waitFor(() => expect(f.view.snapshot().phase).toBe("closed"));
    expect(f.posts().map(post => post.kind)).toEqual(["session.stop"]);
  });
  it("shows the saved answer separately when the current question has changed", async () => {
    const f = learningViewFixture(); owners.push(f.view); const intent = original();
    seedRaw(f.values, primaryKey, JSON.stringify(pending(intent)), id(50));
    const next = { ...current(), assignment: { ...current().assignment!, id: id(90) } }; f.setStep(next);
    f.fetcher.mockResolvedValueOnce(response(missing(intent, "1"))).mockResolvedValueOnce(response({ current: next, state_version: "1" }));
    render(<LiveScreen f={f} />); await act(() => f.view.refresh());
    expect(screen.getByRole("region", { name: "Отправленный ответ" }).textContent).toContain("Haus");
    expect(screen.queryByRole("textbox")).toBeNull(); expect(screen.queryByText("дом")).toBeNull();
    expect(f.posts()).toEqual([]);
  });
  it("keeps B's draft across previous-result correction and grade without presenting B twice", async () => {
    const { f } = await mount({ wrong: true }); await answer(f, "wrong A"); click("Далее");
    await waitFor(() => expect(f.view.snapshot().phase).toBe("question"));
    fireEvent.change(input(), { target: { value: "B draft" } }); click("Предыдущий ответ");
    expect(screen.queryByRole("textbox")).toBeNull(); click("Исправить ответ");
    await waitFor(() => expect(screen.getByRole("button", { name: "Легко" })).toBeTruthy()); click("Легко");
    await waitFor(() => expect(f.view.snapshot()).toMatchObject({ phase: "previous_result", canNext: true }));
    click("Далее"); await waitFor(() => expect(input().value).toBe("B draft"));
    expect(f.posts().map(post => post.kind)).toEqual(["answer.submit", "assignment.present", "result.correct", "result.grade"]);
  });
  it("allows typing during the present barrier but blocks submit and previous-result correction", async () => {
    const { f } = await mount({ wrong: true }); await answer(f, "wrong A");
    const gate = deferred<Response>(); f.fetcher.mockReturnValueOnce(gate.promise); click("Далее");
    await waitFor(() => expect(f.posts()).toHaveLength(2)); const present = lastPost(f);
    expect(input().readOnly).toBe(false); fireEvent.change(input(), { target: { value: "B draft" } });
    click("Проверить"); click("Забыл…"); click("Предыдущий ответ");
    expect(screen.queryByRole("button", { name: "Исправить ответ" })).toBeNull(); click("Далее");
    expect(input().value).toBe("B draft"); expect(f.posts()).toHaveLength(2);
    await act(async () => { gate.resolve(await f.handler(...present)); });
    await waitFor(() => expect(f.view.snapshot().canSubmit).toBe(true)); expect(input().value).toBe("B draft");
  });
  it("a lost present is checked by itself without the cover: B is typed under its short status, no button (Q25.1, Q25.2)", async () => {
    const { f } = await mount({ wrong: true }); await answer(f, "wrong A");
    f.fetcher.mockImplementationOnce(async (...call) => { await f.handler(...call); throw new Error("lost response"); });
    // The machine's check by the same ID is held: the mark is unknown meanwhile.
    const check = deferred<Response>(); f.fetcher.mockReturnValueOnce(check.promise);
    click("Далее");
    await waitFor(() => expect(f.view.snapshot().commands.recovery?.state.name).toBe("checking"));
    const present = f.posts().at(-1)!;
    expect(present.kind).toBe("assignment.present");
    expect(document.querySelector(".recovery-overlay")).toBeNull();
    for (const name of ["Повторить отправку", "Проверить состояние"]) expect(screen.queryByRole("button", { name })).toBeNull();
    expect(screen.getByText("Подтверждаем показ задания…")).toBeTruthy();
    expect(input().readOnly).toBe(false); fireEvent.change(input(), { target: { value: "B draft" } });
    expect((screen.getByRole("button", { name: "Проверить" }) as HTMLButtonElement).disabled).toBe(true);
    click("Проверить"); click("Забыл…");
    // A's result is shown with the same status and no correction until the confirmation (CT:107).
    click("Предыдущий ответ");
    expect(screen.getByText("Подтверждаем показ задания…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Исправить ответ" })).toBeNull();
    click("Далее"); expect(input().value).toBe("B draft");
    expect(f.posts().map(post => post.kind)).toEqual(["answer.submit", "assignment.present"]);
    const status = f.fetcher.mock.calls.at(-1)!;
    await act(async () => { check.resolve(await f.handler(...status)); });
    await waitFor(() => expect(f.view.snapshot().canSubmit).toBe(true));
    expect(screen.queryByText("Подтверждаем показ задания…")).toBeNull();
    expect(input().value).toBe("B draft");
    expect(f.posts().map(post => post.kind)).toEqual(["answer.submit", "assignment.present"]);
  });
  it("pending grade replaces confirmation and blocks keyboard navigation until acknowledgement", async () => {
    const { f } = await mount(); await answer(f);
    const gate = deferred<Response>(); f.fetcher.mockReturnValueOnce(gate.promise); click("Легко");
    await waitFor(() => expect(screen.getByText("Сохраняем изменение")).toBeTruthy());
    expect(screen.queryByText("Верно")).toBeNull(); fireEvent.keyDown(document.body, { key: "Enter" }); click("Далее");
    expect(f.posts().map(post => post.kind)).toEqual(["answer.submit", "result.grade"]);
    await act(async () => { gate.resolve(await f.handler(...lastPost(f))); });
    await waitFor(() => expect(f.view.snapshot().phase).toBe("question"));
    expect(f.posts().map(post => post.kind)).toEqual(["answer.submit", "result.grade", "assignment.present"]);
  });
  it("another payload under the same ID shows the text of Я17 with «Выйти», no check and no retry (CT §6.1 п. 10)", async () => {
    const { f } = await mount();
    const handler = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (url, init) => init?.method === "POST" && JSON.parse(String(init.body)).kind === "answer.submit"
      ? response({ error: { code: "COMMAND_PAYLOAD_MISMATCH" } }, 409) : handler(url, init));
    fireEvent.change(input(), { target: { value: "Haus" } }); click("Проверить");
    await screen.findByText("Не удалось подтвердить это действие. Повторить его нельзя. Заверши занятие, чтобы продолжить.");
    expect(screen.queryByText("Проверяем, сохранилось ли действие.")).toBeNull();
    for (const name of ["Повторить отправку", "Проверить состояние"]) expect(screen.queryByRole("button", { name })).toBeNull();
    expect(hasPending(f.values, primaryKey)).toBe(true);
    click("Выйти"); await waitFor(() => expect(f.posts().map(post => post.kind)).toEqual(["answer.submit", "session.stop"]));
  });
  it("lost correction shows an unconfirmed change until its original receipt is read", async () => {
    const { f } = await mount({ wrong: true }); await answer(f);
    f.fetcher.mockImplementationOnce(async (...call) => { await f.handler(...call); throw new Error("lost correction"); });
    const check = deferred<Response>(); f.fetcher.mockReturnValueOnce(check.promise);
    click("Исправить ответ"); await waitFor(() => expect(screen.getByText("Проверяем изменение")).toBeTruthy());
    expect(screen.queryByText("Верно")).toBeNull(); expect(screen.queryByRole("button", { name: "Проверить состояние" })).toBeNull();
    // The machine's own check by ID confirms the correction.
    await waitFor(() => expect(f.view.snapshot().commands.recovery?.state.name).toBe("checking"));
    const status = f.fetcher.mock.calls.at(-1)!;
    await act(async () => { check.resolve(await f.handler(...status)); });
    await waitFor(() => expect(screen.getByText("Верно")).toBeTruthy());
    expect(f.posts().map(post => post.kind)).toEqual(["answer.submit", "result.correct"]);
  });
  it("Exit remains available during a pending answer and its late reply cannot reopen the screen", async () => {
    const { f } = await mount(); const gate = deferred<Response>(); f.fetcher.mockReturnValueOnce(gate.promise);
    fireEvent.change(input(), { target: { value: "Haus" } }); click("Проверить");
    await waitFor(() => expect(f.posts()).toHaveLength(1)); const old = await f.handler(...lastPost(f)); click("Выйти");
    await waitFor(() => expect(screen.getByText("Занятие завершено.")).toBeTruthy());
    await act(async () => { gate.resolve(old); });
    expect(screen.queryByRole("textbox")).toBeNull(); expect(screen.queryByText("Верно")).toBeNull();
    expect(f.posts().map(post => post.kind)).toEqual(["answer.submit", "session.stop"]);
    expect(f.posts()[1].payload).toEqual({ reason: "stop" });
  });
  it("an uncertain Stop blocks the old lesson and recovers its accepted receipt without another POST", async () => {
    const { f } = await mount(); fireEvent.change(input(), { target: { value: "unsent" } });
    f.fetcher.mockImplementationOnce(async (...call) => { await f.handler(...call); throw new Error("lost stop"); });
    click("Выйти"); await waitFor(() => expect(f.view.snapshot().commands.stop.phase).toBe("unresolved"));
    expect(screen.queryByRole("textbox")).toBeNull(); expect(screen.queryByText("Занятие завершено.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Повторить отправку" })).toBeNull();
    click("Проверить состояние"); await waitFor(() => expect(screen.getByText("Занятие завершено.")).toBeTruthy());
    expect(f.posts().map(post => post.kind)).toEqual(["session.stop"]); expect(f.view.snapshot().draft).toBe("");
  });
  it("a missing Stop can be retried only explicitly with its original identity", async () => {
    const { f } = await mount();
    f.fetcher.mockRejectedValueOnce(new Error("not delivered")); click("Выйти");
    await waitFor(() => expect(f.view.snapshot().commands.stop.phase).toBe("unresolved"));
    const sent = f.posts()[0];
    f.fetcher.mockResolvedValueOnce(response(missing({ command_id: sent.command_id, kind: "session.stop", session_id: id(3), payload: { reason: "stop" } }, "1")));
    click("Проверить состояние"); await waitFor(() => expect(screen.getByRole("button", { name: "Повторить завершение" })).toBeTruthy());
    expect(f.posts()).toHaveLength(1); click("Повторить завершение");
    await waitFor(() => expect(screen.getByText("Занятие завершено.")).toBeTruthy());
    expect(f.posts()).toEqual([sent, sent]);
  });
  it("a local receipt cleanup failure keeps the confirmed result and never offers to resend it", async () => {
    const { f } = await mount({ wrong: true });
    vi.mocked(f.storage.remove).mockRejectedValueOnce(new Error("storage unavailable")); await answer(f);
    expect(screen.getByText("Действие сохранено. Не удалось обновить данные на этом устройстве.")).toBeTruthy();
    expect(screen.getByText("Есть ошибка")).toBeTruthy(); expect(screen.queryByRole("button", { name: "Повторить отправку" })).toBeNull();
    // The outcome is confirmed: the control only repeats the local cleanup and is named so, not as a check (CT §6.1 п. 2).
    expect(screen.queryByRole("button", { name: "Проверить состояние" })).toBeNull();
    click("Продолжить"); await waitFor(() => expect(hasPending(f.values, primaryKey)).toBe(false));
    expect(f.posts().map(post => post.kind)).toEqual(["answer.submit"]);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Продолжить" })).toBeNull());
  });
  it("S07 «Продолжить» clears only the local record: no check, no read and no send before or after it", async () => {
    const { f } = await mount({ wrong: true });
    vi.mocked(f.storage.remove).mockRejectedValueOnce(new Error("storage unavailable")); await answer(f);
    const requests = f.fetcher.mock.calls.length;
    click("Продолжить"); await waitFor(() => expect(hasPending(f.values, primaryKey)).toBe(false));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Продолжить" })).toBeNull());
    expect(f.fetcher.mock.calls.length).toBe(requests);
    // The saved result stays on screen and continues as after its confirmation.
    expect(screen.getByText("Есть ошибка")).toBeTruthy();
    expect(f.view.snapshot()).toMatchObject({ phase: "result_wrong", problem: null, canRetryPrimary: false, canNext: true });
  });
  it("S07 the cleanup succeeds while the server is unreachable: a read problem follows, never the failed cleanup or a resend", async () => {
    const { f } = await mount({ wrong: true });
    vi.mocked(f.storage.remove).mockRejectedValueOnce(new Error("storage unavailable")).mockRejectedValueOnce(new Error("storage unavailable"));
    await answer(f);
    const handler = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (url, init) => init?.method === "GET" ? Promise.reject(new TypeError("offline")) : handler(url, init));
    // A read that failed leaves the view without a usable step while the record of the saved answer is still kept.
    await act(() => f.view.refresh());
    expect(f.view.snapshot().phase).toBe("stale");
    expect(hasPending(f.values, primaryKey)).toBe(true);
    click("Продолжить"); await waitFor(() => expect(hasPending(f.values, primaryKey)).toBe(false));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Продолжить" })).toBeNull());
    expect(screen.queryByText("Действие сохранено. Не удалось обновить данные на этом устройстве.")).toBeNull();
    expect(screen.getByText("Не удалось обновить занятие.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Проверить состояние" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Повторить отправку" })).toBeNull();
    expect(f.view.snapshot().canRetryPrimary).toBe(false);
    // Back online, the ordinary check reads the session; the saved answer is never sent again.
    f.fetcher.mockImplementation(handler);
    click("Проверить состояние"); await waitFor(() => expect(f.view.snapshot().phase).toBe("result_wrong"));
    expect(f.posts().map(post => post.kind)).toEqual(["answer.submit"]);
  });
  it("S07 a refused change whose record was left keeps the ordinary check, never «Продолжить» or «Действие сохранено»", async () => {
    const { f } = await mount(); await answer(f);
    expect(screen.getByText("Верно")).toBeTruthy();
    const handler = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementationOnce(async (_url, init) => {
      const command = JSON.parse(String(init!.body));
      const view = await (await handler(`http://localhost/api/v1/sessions/${id(3)}?result_id=${id(706)}`, { method: "GET" })).json();
      return response({ ...view, command: { id: command.command_id, status: "rejected" }, error: { code: "RESULT_STALE" } }, 409);
    });
    vi.mocked(f.storage.remove).mockRejectedValueOnce(new Error("storage unavailable"));
    click("Легко");
    await waitFor(() => expect(f.view.snapshot().commands.primary).toMatchObject({ outcome: "rejected", problem: "storage", pending: true }));
    expect(screen.queryByRole("button", { name: "Продолжить" })).toBeNull();
    expect(screen.queryByText("Действие сохранено. Не удалось обновить данные на этом устройстве.")).toBeNull();
    expect(screen.getByRole("button", { name: "Проверить состояние" })).toBeTruthy();
    expect(f.posts().map(post => post.kind)).toEqual(["answer.submit", "result.grade"]);
  });
  it("a repeated local cleanup refusal keeps the real state and the same control until the cleanup succeeds (S07)", async () => {
    const { f } = await mount({ wrong: true });
    vi.mocked(f.storage.remove).mockRejectedValueOnce(new Error("storage unavailable")).mockRejectedValueOnce(new Error("storage unavailable"));
    await answer(f);
    click("Продолжить");
    await waitFor(() => expect(vi.mocked(f.storage.remove)).toHaveBeenCalledTimes(2));
    // Still refused: the record stays, the saved result is still named, nothing is resent and there is no way forward yet.
    expect(hasPending(f.values, primaryKey)).toBe(true);
    expect(screen.getByText("Действие сохранено. Не удалось обновить данные на этом устройстве.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Продолжить" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Повторить отправку" })).toBeNull();
    click("Продолжить"); await waitFor(() => expect(hasPending(f.values, primaryKey)).toBe(false));
    expect(f.posts().map(post => post.kind)).toEqual(["answer.submit"]);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Продолжить" })).toBeNull());
  });
  it("an unavailable projection hides the question and explains recovery without exposing wire errors", async () => {
    const { f } = await mount(); fireEvent.change(input(), { target: { value: "retained draft" } });
    f.fetcher.mockResolvedValueOnce(response({ current: { session_id: id(3), status: "unavailable" }, state_version: "1" }));
    await act(() => f.view.refresh()); expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("button", { name: "Проверить состояние" })).toBeTruthy(); expect(f.posts()).toEqual([]);
    click("Проверить состояние"); await waitFor(() => expect(input().value).toBe("retained draft"));
    expect(f.posts()).toEqual([]);
  });
  it.each([
    ["ru", "Занятие открыто на другом устройстве"],
    ["uk", "Заняття відкрито на іншому пристрої"],
    ["en", "A session is open on another device"],
  ] as const)("names the other device when a start is refused as SESSION_BUSY in %s (К10-018)", async (language, message) => {
    const { f, rerender } = await mount({ language });
    const base = f.view.snapshot(), screen_ = (problem: string) => <LearningScreen state={{ ...base, problem }} language={language}
      submitOnEnter actions={f.view} renderPreview={() => null} />;
    rerender(screen_("SESSION_BUSY"));
    expect(screen.getByText(message)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/SESSION_BUSY|Не удалось обновить занятие|Could not refresh/);
    // Any other unclassified problem keeps the generic wording.
    rerender(screen_("network"));
    expect(screen.queryByText(message)).toBeNull();
  });
  it.each([
    ["ru", "Занятие открыто на другом устройстве"],
    ["uk", "Заняття відкрито на іншому пристрої"],
    ["en", "A session is open on another device"],
  ] as const)("a start refused by the core as SESSION_BUSY reaches the real screen in %s (К10-018)", async (language, message) => {
    const f = learningViewFixture("normal", null); owners.push(f.view);
    const base = f.handler;
    f.fetcher.mockImplementation(async (url, init) => {
      if (init?.method !== "POST") return base(url, init);
      const command = JSON.parse(String(init.body));
      return response({ command: { id: command.command_id, status: "rejected" }, error: { code: "SESSION_BUSY" },
        current: { session_id: command.session_id, status: "not_found" }, state_version: "9" }, 409);
    });
    render(<LiveScreen f={f} language={language} />); await act(() => f.view.refresh());
    await act(() => f.view.start());
    expect(f.view.snapshot().problem).toBe("SESSION_BUSY");
    expect(screen.getByText(message)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Не удалось обновить занятие|Не вдалося оновити заняття|Could not refresh/);
  });
  it("summary closes only by an explicit tap on the full-screen message", async () => {
    const { f } = await mount();
    f.setStep({ ...current(), status: "summary", assignment: null, group: { ...current().group, status: "completed" } });
    await act(() => f.view.refresh()); expect(screen.getByText("Группа изучена.")).toBeTruthy(); expect(f.posts()).toEqual([]);
    fireEvent.keyDown(document.body, { key: "Enter" }); expect(f.posts()).toEqual([]);
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("main").classList.contains("learning-screen-summary")).toBe(true);
    click("Вернуться на Сегодня"); await waitFor(() => expect(screen.getByText("Занятие завершено.")).toBeTruthy());
    expect(f.posts()).toHaveLength(1); expect(f.posts()[0]).toMatchObject({ kind: "session.stop", payload: { reason: "summary_home" } });
  });
  it("a finished round does not claim the entire group has been learned", async () => {
    const { f } = await mount(); f.setStep({ ...current(), status: "summary", assignment: null });
    await act(() => f.view.refresh()); expect(screen.getByText("Этот проход завершён.")).toBeTruthy();
    expect(screen.queryByText("Группа изучена.")).toBeNull(); expect(f.posts()).toEqual([]);
  });
  it.each(["Дальше", "Уже знаю"])("preview '%s' is blocked while current state is being reread", async button => {
    const { f } = await mount({ fresh: true }); expect(f.posts()).toEqual([]);
    await act(() => f.view.start()); expect(screen.getByTestId("preview").textContent).toBe("Hallo"); expect(screen.getByText("1 / 1")).toBeTruthy();
    const gate = deferred<Response>(); f.fetcher.mockReturnValueOnce(gate.promise); let reading!: Promise<void>;
    await act(async () => { reading = f.view.refresh(); });
    await waitFor(() => expect(f.fetcher.mock.calls.at(-1)?.[1]?.method).toBe("GET"));
    expect((screen.getByRole("button", { name: button }) as HTMLButtonElement).disabled).toBe(true);
    click(button); await f.view.advancePreview(button === "Уже знаю"); expect(f.posts()).toHaveLength(1);
    const get = f.fetcher.mock.calls.at(-1)!;
    await act(async () => { gate.resolve(await f.handler(...get)); await reading; }); click(button);
    await waitFor(() => expect(f.view.snapshot().phase).toBe("question"));
    expect(f.posts().map(post => post.kind)).toEqual(["session.start", button === "Уже знаю" ? "learning.known" : "learning.preview_next", "assignment.present"]);
  });
  it("a disposed document hides old data without claiming the server session was closed", async () => {
    const { f, rerender } = await mount(); f.revoke();
    rerender(<LearningScreen state={f.view.snapshot()} language="ru" submitOnEnter actions={f.view} renderPreview={() => null} />);
    expect(screen.getByText("Занятие недоступно в этом окне.")).toBeTruthy();
    expect(screen.queryByText("Занятие завершено.")).toBeNull(); expect(screen.queryByRole("textbox")).toBeNull(); expect(f.posts()).toEqual([]);
  });
});

describe("Learning screen keyboard boundaries", () => {
  it.each([true, false])("result Enter follows the configured preference (%s)", async enabled => {
    const { f } = await mount({ wrong: true, submitOnEnter: enabled }); await answer(f);
    fireEvent.keyDown(document.body, { key: "Enter" });
    if (enabled) await waitFor(() => expect(f.view.snapshot().phase).toBe("question"));
    expect(f.posts().map(post => post.kind)).toEqual(enabled ? ["answer.submit", "assignment.present"] : ["answer.submit"]);
  });
  it("IME and repeated Enter never submit the input", async () => {
    const { f } = await mount({ wrong: true }); fireEvent.change(input(), { target: { value: "Haus" } });
    fireEvent.compositionStart(input()); fireEvent.keyDown(input(), { key: "Enter" }); fireEvent.compositionEnd(input());
    fireEvent.keyDown(input(), { key: "Enter", repeat: true }); fireEvent.keyDown(input(), { key: "Enter", isComposing: true });
    expect(f.posts()).toEqual([]); fireEvent.keyDown(input(), { key: "Enter" });
    await waitFor(() => expect(screen.getByText("Есть ошибка")).toBeTruthy()); expect(f.posts()).toHaveLength(1);
  });
  it.each([{ repeat: true }, { isComposing: true }, { keyCode: 229 }])("result ignores a non-final Enter %j", async flags => {
    const { f } = await mount({ wrong: true }); await answer(f); fireEvent.keyDown(document.body, { key: "Enter", ...flags });
    expect(f.posts()).toHaveLength(1); expect(f.view.snapshot().phase).toBe("result_wrong");
  });
  it("focused grade owns Enter, and an external input or dialog cannot advance the result", async () => {
    const { f } = await mount(); await answer(f);
    const grade = screen.getByRole("button", { name: "Легко" }); grade.focus(); fireEvent.keyDown(grade, { key: "Enter" });
    const outside = render(<><input aria-label="outside" /><div role="dialog" tabIndex={0}>overlay</div></>);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "outside" }), { key: "Enter" });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" }); expect(f.posts()).toHaveLength(1);
    outside.unmount(); fireEvent.click(grade); await waitFor(() => expect(f.view.snapshot().phase).toBe("question"));
    expect(f.posts().map(post => post.kind)).toEqual(["answer.submit", "result.grade", "assignment.present"]);
  });
  it("respects an already handled Enter and removes the document listener on unmount", async () => {
    const { f, unmount } = await mount({ wrong: true }); await answer(f);
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }); event.preventDefault();
    document.body.dispatchEvent(event); expect(f.posts()).toHaveLength(1);
    unmount(); fireEvent.keyDown(document.body, { key: "Enter" }); expect(f.posts()).toHaveLength(1);
  });
});

// R12-08 вар.2 / R13-07 вариант 1: after a mistake Learning shows the own association; with none of their own it is the
// invitation line alone: Learning has no way into М12 yet. A correct answer carries no association.
describe("Learning screen: the own association after a mistake", () => {
  const detail = (association: WrittenAnswerDetail["association"] | undefined, correct = false): WrittenAnswerDetail => ({
    input: { kind: "text", text: "Haus" }, conjunction_hint: null, examples: null, variants: [{ parts: ["das Haus"] }],
    initial_check: { correct, variant_index: correct ? 0 : null, correct_answer: "das Haus", other_answers: [],
      matched_spans: correct ? [{ start: 0, end: 4 }] : [], span_unit: "unicode_code_point", span_bounds: "start_inclusive_end_exclusive" },
    ...(association === undefined ? {} : { association }) });
  const hint = () => screen.queryByRole("region", { name: "Твоя ассоциация" });
  async function run(value: WrittenAnswerDetail, wrong: boolean) {
    const { f } = await mount({ wrong }); f.setDetail(value); await answer(f, "Haus"); return f;
  }
  it("a mistake shows the saved own association in the pair's language", async () => {
    await run(detail({ value: "Haus: ха-ус", version: "2" }), true);
    const block = hint()!; expect(block.querySelector("p")!.textContent).toBe("Haus: ха-ус");
    expect(block.querySelector("p")!.getAttribute("lang")).toBe("ru");
  });
  it("none of their own: the invitation line alone, no button", async () => {
    await run(detail(null), true);
    expect(hint()!.textContent).toContain("Своей ассоциации пока нет. Добавь её — так слово легче вспомнить.");
    expect(hint()!.querySelector("button")).toBeNull(); expect(screen.queryByRole("button", { name: "Добавить ассоциацию" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Уточнить поля" })).toBeNull();
  });
  it("a correct answer, or an older core without the key: no block", async () => {
    await run(detail(null, true), false); expect(hint()).toBeNull(); expect(screen.queryByText(/Своей ассоциации пока нет/)).toBeNull();
    cleanup();
    await run(detail(undefined), true); expect(hint()).toBeNull(); expect(screen.queryByText(/Своей ассоциации пока нет/)).toBeNull();
  });
});
