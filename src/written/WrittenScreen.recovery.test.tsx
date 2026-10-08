// The screen of automatic recovery (Я15, Я15.2, CT §6.1 п. 2, M-RECOV-AUTO CP2): the real document owner over the
// synthetic written server, on fake time. No manual check or resend of a study result; Stop keeps its own buttons.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useWrittenDocument } from "./useWrittenDocument";
import { WrittenScreen } from "./WrittenScreen";
import { response, tick, writtenFixture } from "./writtenFixtures.test-support";

afterEach(() => { cleanup(); vi.useRealTimers(); });

type Route = (request: { method: string; kind: string | null }) => undefined | "drop" | Response;
async function setup(language: "ru" | "uk" | "en" = "ru") {
  vi.useFakeTimers();
  const f = writtenFixture();
  let route: Route = () => undefined;
  f.fetcher.mockImplementation(async (url, init) => {
    const method = init?.method ?? "GET", kind = method === "POST" ? JSON.parse(String(init!.body)).kind as string : null;
    const decision = route({ method, kind });
    if (decision === "drop") throw new TypeError("network");
    return decision ?? f.server.handle(url as RequestInfo, init);
  });
  function Harness() {
    const { state, actions } = useWrittenDocument({ access: f.access(), storage: f.storage, transport: f.transport, newId: f.newId,
      transitionMode: "normal" });
    if (!state) return null;
    return <>
      <button type="button" onClick={() => { void actions.start("words"); }}>start-words</button>
      <WrittenScreen state={state} language={language} submitOnEnter actions={actions} onToday={vi.fn()} />
    </>;
  }
  render(<Harness />);
  const step = (ms = 0) => act(() => tick(ms));
  await step();
  fireEvent.click(screen.getByRole("button", { name: "start-words" })); await step();
  const answers = () => f.posts().filter(post => post.kind === "answer.submit");
  const answer = async (text: string) => {
    fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });
    fireEvent.click(screen.getByRole("button", { name: language === "ru" ? "Проверить" : language === "uk" ? "Перевірити" : "Check" }));
    await step();
  };
  const overlay = () => document.querySelector(".recovery-overlay");
  const noManual = () => {
    for (const name of ["Проверить состояние", "Повторить отправку", "Перевірити стан", "Повторити надсилання", "Check status", "Retry sending"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  };
  return { ...f, step, answers, answer, overlay, noManual, route: (next: Route) => { route = next; } };
}

describe("the waiting screen of a lost study result", () => {
  it("blurs the study content with an indicator and a status: checking, no connection, sending again — never a button (8.19)", async () => {
    const h = await setup();
    let online = false;
    h.route(request => request.kind === "answer.submit" && h.answers().length === 1 ? "drop" : !online && request.method === "GET" ? "drop" : undefined);
    await h.answer("Haus");
    expect(h.overlay()?.getAttribute("role")).toBe("status");
    expect(h.overlay()?.querySelector(".wortly-loader")).not.toBeNull();
    expect(h.overlay()?.textContent).toBe("Нет связи с сервером. Ждём, когда связь восстановится…");
    h.noManual();
    // Exit (Stop) stays reachable above the cover.
    expect((screen.getByRole("button", { name: "Выйти" }) as HTMLButtonElement).disabled).toBe(false);
    online = true; await h.step(5000);
    // Confirmed absence: the retry waits for its 2 s pause (the loss was more than 2 s ago, so it goes at once).
    expect(h.answers()).toHaveLength(2);
    await h.step();
    expect(h.overlay()).toBeNull();
    expect(screen.getByText("Верно")).toBeTruthy();
    h.noManual();
  });
  it("says it is sending again while the pause before a retry runs (uk)", async () => {
    const h = await setup("uk");
    h.route(request => request.kind === "answer.submit" && h.answers().length === 1 ? "drop" : undefined);
    await h.answer("Haus");
    expect(h.overlay()?.textContent).toBe("Надсилаємо дію повторно…");
    h.noManual();
    await h.step(2000); await h.step();
    expect(h.overlay()).toBeNull();
  });
  it("a planned pause names itself without asking for a manual check (4.6-Р5)", async () => {
    const h = await setup();
    h.route(request => request.kind === "answer.submit" && h.answers().length === 1
      ? response({ error: { code: "MAINTENANCE", wait_seconds: 120 } }, 503) : undefined);
    await h.answer("Haus");
    expect(h.overlay()?.textContent).toBe("Идёт плановое обновление. Подожди, мы продолжим сами. Примерное ожидание — около 2 мин.");
    expect(h.overlay()?.textContent).not.toContain("провер");
    h.noManual();
  });
  it("six lost sends end on the unsaved status without any action but Exit (temporary until CP4)", async () => {
    const h = await setup("en");
    h.route(request => request.kind === "answer.submit" ? "drop" : undefined);
    await h.answer("Haus");
    for (let second = 0; second < 70; second++) await h.step(1000);
    expect(h.answers()).toHaveLength(6);
    expect(h.overlay()?.textContent).toBe("We couldn't save your last action. The connection is back.");
    expect(h.overlay()?.querySelector(".wortly-loader")).toBeNull();
    h.noManual();
    expect((screen.getByRole("button", { name: "Exit" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("the mark that a question was shown waits without the cover (owner answers Q25.1, Q25.2 of 08.10.2026; TA §12.3)", () => {
  const labels = {
    ru: { status: "Подтверждаем показ задания…", check: "Проверить", previous: "Предыдущий ответ", next: "Далее" },
    uk: { status: "Підтверджуємо показ завдання…", check: "Перевірити", previous: "Попередня відповідь", next: "Далі" },
    en: { status: "Confirming the displayed question…", check: "Check", previous: "Previous answer", next: "Next" },
  } as const;
  it.each(["ru", "uk", "en"] as const)("%s: the question stays visible and typed under its short status, no button; its answer waits for the automatic confirmation", async language => {
    const h = await setup(language), t = labels[language];
    const presents = () => h.posts().filter(post => post.kind === "assignment.present");
    await h.answer("Haus");
    let online = false;
    h.route(request => !online && (request.kind === "assignment.present" || request.method === "GET") ? "drop" : undefined);
    await h.step(3000); await h.step();
    expect(presents()).toHaveLength(2);
    expect(screen.getByText("слово 7")).toBeTruthy();
    expect(screen.getByText(t.status)).toBeTruthy();
    expect(h.overlay()).toBeNull(); h.noManual();
    const field = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(field.readOnly).toBe(false);
    fireEvent.change(field, { target: { value: "Haus" } }); expect(field.value).toBe("Haus");
    const check = screen.getByRole("button", { name: t.check }) as HTMLButtonElement;
    expect(check.disabled).toBe(true);
    fireEvent.click(check); await h.step();
    // The previous result can be viewed with the same status; it offers no change before the confirmation (CT:107).
    fireEvent.click(screen.getByRole("button", { name: t.previous }));
    expect(screen.getByText(t.status)).toBeTruthy(); expect(h.overlay()).toBeNull(); h.noManual();
    expect(document.querySelector(".written-step-back")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: t.next }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Haus");
    expect(h.answers()).toHaveLength(1);
    online = true;
    for (let second = 0; second < 30; second += 5) await h.step(5000);
    expect(presents()).toHaveLength(3);
    expect(presents()[2].command_id).toBe(presents()[1].command_id);
    expect(screen.queryByText(t.status)).toBeNull();
    const confirmed = screen.getByRole("button", { name: t.check }) as HTMLButtonElement;
    expect(confirmed.disabled).toBe(false);
    fireEvent.click(confirmed); await h.step();
    expect(h.answers()).toHaveLength(2);
  });
  it("six lost presents end on the unsaved status, as any study action until CP4 (Я15.8)", async () => {
    const h = await setup();
    await h.answer("Haus");
    h.route(request => request.kind === "assignment.present" ? "drop" : undefined);
    for (let second = 0; second < 75; second++) await h.step(1000);
    expect(h.posts().filter(post => post.kind === "assignment.present")).toHaveLength(7);
    expect(h.overlay()?.textContent).toBe("Не удалось сохранить последнее действие. Связь восстановлена.");
    h.noManual();
    expect((screen.getByRole("button", { name: "Выйти" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("Stop keeps its manual recovery", () => {
  it("a lost Stop over a recovering answer offers only the Stop check and «Повторить завершение»", async () => {
    const h = await setup();
    let dropStop = true;
    h.route(request => request.kind === "answer.submit" && h.answers().length === 1 ? "drop"
      : request.kind === "session.stop" && dropStop ? "drop" : undefined);
    await h.answer("Haus");
    fireEvent.click(screen.getByRole("button", { name: "Выйти" })); await h.step();
    fireEvent.click(screen.getByRole("button", { name: "Проверить состояние" })); await h.step();
    expect(screen.getByRole("button", { name: "Повторить завершение" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Повторить отправку" })).toBeNull();
    dropStop = false;
    fireEvent.click(screen.getByRole("button", { name: "Повторить завершение" })); await h.step();
    expect(screen.getByText("Занятие прервано.")).toBeTruthy();
    expect(h.answers()).toHaveLength(1);
  });
});

describe("an ended recovery (CT §6.1 п. 7, 10; QA CP2 Н2)", () => {
  const unknown = ["Проверяем, сохранилось ли действие.", "Проверяем, сохранилось ли действие…", "Не удалось обновить занятие.",
    "Действие нельзя повторить. Проверь состояние занятия."];
  it("another payload under the same ID: the text of Я17 and «Выйти», nothing claims a check", async () => {
    const h = await setup();
    h.route(request => request.kind === "answer.submit" ? response({ error: { code: "COMMAND_PAYLOAD_MISMATCH" } }, 409) : undefined);
    await h.answer("Haus"); await h.step();
    expect(screen.getByText("Не удалось подтвердить это действие. Повторить его нельзя. Заверши занятие, чтобы продолжить.")).toBeTruthy();
    for (const text of unknown) expect(screen.queryByText(text)).toBeNull();
    expect(h.overlay()).toBeNull();
    h.noManual();
    // The conflicting record stays until a confirmed closure (Я17, CP4).
    expect(h.values.has("wortly.pending.written_session")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Выйти" })); await h.step();
    expect(h.posts().map(post => post.kind)).toContain("session.stop");
    expect(h.answers()).toHaveLength(1);
  });
  it("a definite refusal: the session as the server has it, without a check status or an instruction", async () => {
    const h = await setup();
    h.route(request => request.kind === "answer.submit" ? response({ error: { code: "VALIDATION_FAILED" } }, 422) : undefined);
    await h.answer("Haus"); await h.step();
    expect(screen.getByText("слово 6")).toBeTruthy();
    for (const text of unknown) expect(screen.queryByText(text)).toBeNull();
    expect(h.overlay()).toBeNull();
    h.noManual();
    expect((screen.getByRole("button", { name: "Выйти" }) as HTMLButtonElement).disabled).toBe(false);
    // The refused action is gone: the question takes a new answer (a new action).
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Haus" } }); await h.step();
    expect((screen.getByRole("button", { name: "Проверить" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("a confirmed answer whose local record could not be cleared (QA CP2b Н1)", () => {
  it("offers only to update the device data: no check, no POST, the record goes and the control disappears", async () => {
    const h = await setup();
    const remove = vi.mocked(h.storage.remove), base = remove.getMockImplementation()!;
    let failures = 1;
    remove.mockImplementation(async key => { if (key.includes("written_session") && failures-- > 0) throw new Error("io"); return base(key); });
    await h.answer("Haus");
    expect(screen.getByText("Верно")).toBeTruthy();
    expect(screen.getByText("Не удалось обновить данные на этом устройстве.")).toBeTruthy();
    expect(h.overlay()).toBeNull();
    h.noManual();
    const posts = h.posts().length;
    fireEvent.click(screen.getByRole("button", { name: "Продолжить" })); await h.step();
    expect(h.values.has("wortly.pending.written_session")).toBe(false);
    expect(h.posts()).toHaveLength(posts);
    expect(screen.queryByRole("button", { name: "Продолжить" })).toBeNull();
  });
});
