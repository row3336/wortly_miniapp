import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode, useEffect, useLayoutEffect, useReducer, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConjugationAssignment, ConjugationSessionProjection, ConjugationSummary, OpenedClient, WrittenResult } from "../api/generated";
import { createOpenedAccess } from "../app/openedAccess";
import type { Language } from "../i18n/language";
import type { ConjugationCommandSnapshot } from "./conjugationCommandController";
import type { ConjugationDocumentSnapshot, ConjugationPresentationTicket, ConjugationStepTicket } from "./conjugationDocumentController";
import { ConjugationTestFlow, type FlowInput } from "./conjugationTestFlow";
import { ConjugationTestScreen } from "./ConjugationTestScreen";

afterEach(() => { cleanup(); setVisibility("visible"); });
const id = (n: number) => `aaaaaaaa-bbbb-4000-8000-${String(n).padStart(12, "0")}`;
const S1 = id(1), A0 = id(10), B1 = id(11), R1 = id(21), C1 = id(31);
const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** Opaque tickets; identity is asserted with toBe. */
const stepTicket = () => Object.freeze({}) as ConjugationStepTicket;
const presentationTicket = () => Object.freeze({}) as ConjugationPresentationTicket;
function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
}

function assignment(status: "prefetched" | "presented" = "presented"): ConjugationAssignment {
  return { id: B1, card_id: id(8), status, kind: "conjugation", cycle_id: C1, slot_id: { cycle_id: C1, pronoun_group: "du" },
    base_verb_id: id(8), display_verb_id: id(18), tense: "present", pronoun_group: "du",
    prompt: { verb: "gehen", translation: "идти", language: "ru", pronoun: "du", tense: "present" },
    answer_spec: { kind: "forms", labels: ["du"], part_count: 1, case_sensitive: false } };
}
const summaryFixture = (): ConjugationSummary => ({ completed_cycle_ids: [C1], partial: [], results: [], completed: 6, correct: 6, wrong: 0,
  blocks: [{ cycle_id: C1, base_verb_id: id(8), base_lemma: "gehen", tense: "present",
    answered_groups: ["ich", "du", "er_sie_es", "wir", "ihr", "sie_sie"], effect: "success", grade: 5 }] });
function projection(current: ConjugationAssignment | null, status: "active" | "summary" = "active"): ConjugationSessionProjection {
  return { session_id: S1, status, mode: "conjugation", direction: "conjugation", pair: "ru-de", local_date: "2026-10-01", close_reason: null,
    progress: { total: 6, completed: 1, correct: 1, wrong: 0 }, assignment: current, summary: status === "summary" ? summaryFixture() : null,
    capabilities: { answer_target: current?.status === "presented" ? current.id : null, correct_target: null, grades: null, undo_target: null,
      stop: true, summary_home: status === "summary" } };
}
function result(correct: boolean): WrittenResult {
  return { result_id: R1, assignment_id: A0, version: "5", grade: correct ? 4 : 2, correct, status: "active", accepted_at: "2026-10-01T08:00:00Z",
    answer_date: "2026-10-01", detail: null };
}
function command(over: Partial<ConjugationCommandSnapshot> = {}): ConjugationCommandSnapshot {
  return { phase: "idle", pending: false, kind: null, sessionId: null, pendingIntent: null, outcome: null, resolved: null,
    rejectionCode: null, problem: null, canRetry: false, stateVersion: null, closedSession: null, view: null, ...over };
}
function snap(over: Partial<ConjugationDocumentSnapshot> = {}): ConjugationDocumentSnapshot {
  return { phase: "question", sessionId: S1, stateVersion: "10", terminalSessionIds: [], closed: null, acceptedAddress: null,
    commands: { study: command(), stop: command() }, problem: null, pairMismatch: null,
    currentStep: { stateVersion: "10", step: projection(assignment()) }, resultA: null,
    display: { kind: "step", assignmentId: B1 }, stepTicket: null, presentationTicket: null,
    canStart: false, canSubmit: true, canCorrect: false, canUndo: false, canStop: true, canSummaryHome: false, allowedGrades: [],
    canRetry: { study: false, stop: false }, ...over };
}
const accepted = command({ phase: "settled", outcome: "accepted", kind: "answer.submit", sessionId: S1,
  resolved: { commandId: id(51), kind: "answer.submit", sessionId: S1, assignmentId: A0, resultId: R1 } });
function onResult(value: WrittenResult, over: Partial<ConjugationDocumentSnapshot> = {}): ConjugationDocumentSnapshot {
  return snap({ phase: "result", display: { kind: "result" }, canSubmit: false, acceptedAddress: { session_id: S1, assignment_id: A0, result_id: R1 },
    resultA: { address: { session_id: S1, assignment_id: A0, result_id: R1 }, stateVersion: "10",
      action: { action_id: id(41), kind: "answer.submit", version: "5", status: "active" }, result: value,
      capabilities: { answer_target: null, grades: null, correct_target: null, undo_target: null, stop: true, summary_home: false } },
    commands: { study: accepted, stop: command() }, ...over });
}
const closed = (summary: ConjugationSummary | null) => snap({ phase: "closed", terminalSessionIds: [S1], display: { kind: "closed" }, currentStep: null,
  canSubmit: false, canStop: false, closed: { sessionId: S1, reason: "stop", summary } });

const profile: OpenedClient["profile"] = { profile_id: id(50), role: "user", ui_language: "ru", dictionary_language: "ru", time_zone: "UTC",
  state_version: "1", access: { status: "admitted", version: "1", reason: null } };
const A1 = createOpenedAccess({ opened: { status: "opened", client_instance_id: id(60), document_id: id(61), document_epoch: "1",
  proof_version: "1", profile, session: null, compatibility: { compatible: true, contract_version: "1" } },
token: "synthetic-token", proof: "synthetic-proof", generation: 1, isLive: () => true, onDenied: () => undefined });

type HostInput = { state: ConjugationDocumentSnapshot | null; tuple: string; onToday: () => void };
/** Test owner of one flow: project in render, commit in a layout effect; `onChange` = its stable repaint,
 * `onToday` = a wrapper over the latest prop. It never disposes (that belongs to the creator, T4). */
function setup(initial: ConjugationDocumentSnapshot | null, options: { language?: Language; submitOnEnter?: boolean; active?: boolean } = {}) {
  const actions = {
    refresh: vi.fn(async () => undefined), start: vi.fn(async () => undefined), openStep: vi.fn(), openResult: vi.fn(),
    shown: vi.fn(async (_ticket: ConjugationPresentationTicket) => undefined), submit: vi.fn(async () => undefined), grade: vi.fn(async () => undefined),
    correct: vi.fn(async () => undefined), undo: vi.fn(async () => undefined), stop: vi.fn(async () => undefined), retry: vi.fn(async () => undefined),
  };
  const schedule = vi.fn((_delay: 2000 | 3000, _run: () => void) => () => undefined);
  const onToday = vi.fn();
  const counts = { renders: 0, changes: 0, changesInRender: 0 };
  let repaint: () => void = () => undefined, latestToday: () => void = onToday, rendering = false;
  const flow = new ConjugationTestFlow({ actions, schedule, onToday: () => latestToday(),
    onChange: () => { counts.changes++; if (rendering) counts.changesInRender++; repaint(); } });
  const dispose = vi.spyOn(flow, "dispose");
  let change: (next: Partial<HostInput>) => void = () => undefined;
  function Host() {
    const [host, set] = useState<HostInput>({ state: initial, tuple: "tuple-1", onToday });
    const [, force] = useReducer((n: number) => n + 1, 0);
    repaint = force; latestToday = host.onToday; counts.renders++;
    change = next => set(current => ({ ...current, ...next }));
    const input: FlowInput = { source: { tuple: host.tuple, access: A1 }, state: host.state, transitionMode: "normal", active: options.active ?? true };
    rendering = true;
    const view = flow.project(input);
    rendering = false;
    useLayoutEffect(() => { rendering = true; flow.commit(input); rendering = false; });
    return <ConjugationTestScreen view={view} flow={flow} language={options.language ?? "ru"} submitOnEnter={options.submitOnEnter ?? true} />;
  }
  const rendered = render(<Host />);
  const update = async (state: ConjugationDocumentSnapshot | null) => { await act(async () => { change({ state }); }); };
  const host = async (next: Partial<HostInput>) => { await act(async () => { change(next); }); };
  const field = () => screen.getByRole("textbox") as HTMLTextAreaElement;
  return { ...rendered, actions, schedule, onToday, flow, dispose, update, host, field, counts };
}
const flush = () => act(async () => { await Promise.resolve(); });
/** List items hold lang spans, so their text is read whole. */
const listed = () => screen.getAllByRole("listitem").map(item => item.textContent);

describe("ConjugationTestScreen question", () => {
  it("renders the T3a heading with lang, the server pronoun as part label and no UUID", () => {
    const { container } = setup(snap());
    const heading = screen.getByRole("heading", { level: 2 });
    expect(heading.textContent).toBe("Präsens: gehen — идти");
    expect([...heading.querySelectorAll("[lang]")].map(node => node.getAttribute("lang"))).toEqual(["de", "de", "ru"]);
    expect(screen.getByLabelText("Формы ответа").textContent).toBe("du");
    expect(container.textContent).not.toMatch(uuidPattern);
    expect(container.innerHTML).not.toMatch(uuidPattern);
  });

  it("whitespace is not an answer; text goes verbatim; forgot is {forgot:true}; typing reaches the flow draft", async () => {
    const h = setup(snap());
    fireEvent.change(h.field(), { target: { value: "   " } });
    expect((screen.getByRole("button", { name: "Проверить" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(h.field(), { key: "Enter" });
    expect(h.actions.submit).not.toHaveBeenCalled();
    fireEvent.change(h.field(), { target: { value: "  gehst " } });
    expect((h.field() as HTMLTextAreaElement).value).toBe("  gehst ");
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    fireEvent.click(screen.getByRole("button", { name: "Забыл…" }));
    expect(h.actions.submit.mock.calls).toEqual([[{ text: "  gehst " }, B1], [{ forgot: true }, B1]]);
  });

  it("Enter with repeat or IME composition submits nothing; one plain Enter submits once", () => {
    const h = setup(snap());
    fireEvent.change(h.field(), { target: { value: "gehst" } });
    fireEvent.keyDown(h.field(), { key: "Enter", repeat: true });
    fireEvent.compositionStart(h.field());
    fireEvent.keyDown(h.field(), { key: "Enter" });
    fireEvent.compositionEnd(h.field());
    fireEvent.keyDown(h.field(), { key: "Enter", keyCode: 229 });
    expect(h.actions.submit).not.toHaveBeenCalled();
    fireEvent.keyDown(h.field(), { key: "Enter" });
    expect(h.actions.submit).toHaveBeenCalledTimes(1);
  });

  it("canSubmit=false or inactive: read-only field, draft kept, no submit", async () => {
    const h = setup(snap());
    fireEvent.change(h.field(), { target: { value: "geh" } });
    await h.update(snap({ canSubmit: false }));
    expect((h.field() as HTMLTextAreaElement).readOnly).toBe(true);
    expect((h.field() as HTMLTextAreaElement).value).toBe("geh");
    fireEvent.click(screen.getByRole("button", { name: "Забыл…" }));
    expect(h.actions.submit).not.toHaveBeenCalled();
    await h.update(snap());
    expect((h.field() as HTMLTextAreaElement).value).toBe("geh");
  });

  it("unknown answer: the exact pending text read-only, status, and one manual Retry", async () => {
    const h = setup(snap());
    fireEvent.change(h.field(), { target: { value: "other" } });
    await h.update(snap({ phase: "unknown", canSubmit: false, currentStep: null, display: { kind: "none" }, canRetry: { study: true, stop: false },
      commands: { study: command({ phase: "unresolved", pending: true, kind: "answer.submit", sessionId: S1,
        pendingIntent: { command_id: id(70), kind: "answer.submit", session_id: S1, assignment_id: B1, payload: { text: " gehst  " } } }), stop: command() } }));
    expect((h.field() as HTMLTextAreaElement).value).toBe(" gehst  ");
    expect((h.field() as HTMLTextAreaElement).readOnly).toBe(true);
    expect(screen.getByText("Ответ ещё не подтверждён. Проверь статус.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Повторить действие" }));
    expect(h.actions.retry.mock.calls).toEqual([["study"]]);
    expect(screen.queryByRole("button", { name: "Повторить завершение" })).toBeNull();
  });

  it("Ф2: an unknown answer before its check offers «Проверить статус» (GET), not a retry", async () => {
    const h = setup(snap());
    await h.update(snap({ phase: "unknown", canSubmit: false, currentStep: null, display: { kind: "none" }, problem: "network",
      commands: { study: command({ phase: "unresolved", pending: true, kind: "answer.submit", sessionId: S1, problem: "network",
        pendingIntent: { command_id: id(70), kind: "answer.submit", session_id: S1, assignment_id: B1, payload: { text: "gehst" } } }), stop: command() } }));
    expect(screen.getByText("Нет связи с сервером.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Повторить действие" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Проверить статус" }));
    expect(h.actions.refresh).toHaveBeenCalledTimes(1);
    for (const spy of [h.actions.submit, h.actions.retry]) expect(spy).not.toHaveBeenCalled();
  });

  it("Ф2: recovery and an unknown revision of the result offer the check too", async () => {
    const h = setup(snap({ phase: "unknown", sessionId: null, canSubmit: false, currentStep: null, display: { kind: "none" },
      commands: { study: command({ phase: "unresolved", pending: true, kind: "answer.submit", sessionId: S1,
        pendingIntent: { command_id: id(70), kind: "answer.submit", session_id: S1, assignment_id: B1, payload: { text: "x" } } }), stop: command() } }));
    expect(screen.getByText("Действие ещё не подтверждено. Проверь статус.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Проверить статус" }));
    expect(h.actions.refresh).toHaveBeenCalledTimes(1);
    cleanup();

    const revision = command({ phase: "unresolved", pending: true, kind: "result.grade", sessionId: S1,
      pendingIntent: { command_id: id(71), kind: "result.grade", session_id: S1, assignment_id: A0, result_id: R1, expected_result_version: "5", payload: { grade: 5 } } });
    const r = setup(onResult(result(true)));
    expect(screen.queryByRole("button", { name: "Проверить статус" })).toBeNull();
    await r.update(snap({ phase: "unknown", display: { kind: "none" }, currentStep: null, canSubmit: false, commands: { study: revision, stop: command() } }));
    fireEvent.click(screen.getByRole("button", { name: "Проверить статус" }));
    expect(r.actions.refresh).toHaveBeenCalledTimes(1);
  });

  it("Ф9: a known refusal is shown with the text of Learning/written on the question; an unlisted code gets the general text", async () => {
    const h = setup(snap({ problem: "ASSIGNMENT_STALE" }));
    expect(screen.getByText("Задание изменилось. Обнови занятие.")).toBeTruthy();
    await h.update(snap({ problem: "SESSION_BUSY" }));
    expect(screen.getByText("Занятие открыто на другом устройстве")).toBeTruthy();
    await h.update(snap({ problem: "VERSION_CONFLICT" }));
    expect(screen.getByText("Не удалось обновить занятие.")).toBeTruthy();
    await h.update(snap());
    expect(screen.queryByText("Не удалось обновить занятие.")).toBeNull();
  });

  it.each([["uk", "Завдання змінилося. Онови заняття."], ["en", "The question has changed. Refresh the session."]] as const)(
    "Ф9 %s: the refusal text is localized", (language, text) => {
      setup(onResult(result(true), { problem: "ASSIGNMENT_STALE" }), { language });
      expect(screen.getByText(text)).toBeTruthy();
    });
});

describe("ConjugationTestScreen visible commit", () => {
  const prefetched = (ticket: ConjugationPresentationTicket) => snap({ phase: "prefetched", canSubmit: false, presentationTicket: ticket,
    currentStep: { stateVersion: "10", step: projection(assignment("prefetched")) } });

  it("one shown per ticket after the visible commit; re-render sends nothing more", async () => {
    const ticket = presentationTicket();
    const h = setup(prefetched(ticket));
    expect(h.actions.shown).not.toHaveBeenCalled(); // not during render or layout
    await flush();
    expect(h.actions.shown).toHaveBeenCalledTimes(1);
    expect(h.actions.shown.mock.calls[0][0]).toBe(ticket);
    await h.update({ ...prefetched(ticket) });
    await flush();
    expect(h.actions.shown).toHaveBeenCalledTimes(1);
  });

  it("hidden at commit → 0 shown, and becoming visible with the same ticket does not repeat it", async () => {
    setVisibility("hidden");
    const ticket = presentationTicket();
    const h = setup(prefetched(ticket));
    await flush();
    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await h.update({ ...prefetched(ticket) });
    await flush();
    expect(h.actions.shown).not.toHaveBeenCalled();
  });

  it("the screen never disposes the flow it was given", () => {
    const h = setup(snap());
    h.unmount();
    // The test host does not dispose either; ownership belongs to the creator (T4).
    expect(h.dispose).not.toHaveBeenCalled();
  });
});

describe("ConjugationTestScreen result, keyboard and navigation", () => {
  it("Enter-Next needs the submitting Enter released; repeat/IME/focused control never act", async () => {
    const ticket = stepTicket();
    const h = setup(snap());
    fireEvent.change(h.field(), { target: { value: "gehst" } });
    fireEvent.keyDown(h.field(), { key: "Enter" });
    expect(h.actions.submit).toHaveBeenCalledTimes(1);
    await h.update(onResult(result(true), { stepTicket: ticket }));
    fireEvent.keyDown(document.body, { key: "Enter", repeat: true });
    fireEvent.keyDown(document.body, { key: "Enter" });
    expect(h.actions.openStep).not.toHaveBeenCalled();
    fireEvent.keyUp(document.body, { key: "Enter" });
    fireEvent.keyDown(document.body, { key: "Enter", isComposing: true });
    fireEvent.keyUp(document.body, { key: "Enter" });
    const next = screen.getByRole("button", { name: "Далее" });
    fireEvent.keyDown(next, { key: "Enter" });
    fireEvent.keyUp(next, { key: "Enter" });
    expect(h.actions.openStep).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: "Enter" });
    expect(h.actions.openStep).toHaveBeenCalledTimes(1);
    expect(h.actions.openStep.mock.calls[0][0]).toBe(ticket);
  });

  it("submitOnEnter=false: Enter never goes Next", async () => {
    const h = setup(onResult(result(true), { stepTicket: stepTicket() }), { submitOnEnter: false });
    fireEvent.keyDown(document.body, { key: "Enter" });
    expect(h.actions.openStep).not.toHaveBeenCalled();
  });

  it("previous answer and Next back to the same B keep the draft", async () => {
    const ticket = stepTicket();
    const withA = snap({ resultA: onResult(result(true)).resultA });
    const h = setup(withA);
    fireEvent.change(h.field(), { target: { value: "gehst" } });
    fireEvent.click(screen.getByRole("button", { name: "Предыдущий ответ" }));
    expect(h.actions.openResult).toHaveBeenCalledTimes(1);
    await h.update(onResult(result(true), { commands: { study: command(), stop: command() }, stepTicket: ticket,
      currentStep: { stateVersion: "10", step: projection(assignment()) } }));
    expect(screen.getByText("Предыдущий ответ")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    expect(h.actions.openStep.mock.calls[0][0]).toBe(ticket);
    await h.update(withA);
    expect((h.field() as HTMLTextAreaElement).value).toBe("gehst");
  });

  it("present barrier: grades/correct hidden, Next only with the C1 ticket", async () => {
    // Rights as the controller publishes them while the present is pending: none.
    const h = setup(onResult(result(true), { phase: "visible_unconfirmed" }));
    expect(screen.getByText("Подтверждаем показ следующего вопроса…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Легко" })).toBeNull();
    expect((screen.getByRole("button", { name: "Далее" }) as HTMLButtonElement).disabled).toBe(true);
    const back = stepTicket();
    await h.update(onResult(result(true), { phase: "visible_unconfirmed", stepTicket: back }));
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    expect(h.actions.openStep.mock.calls[0][0]).toBe(back);
    expect(h.actions.grade).not.toHaveBeenCalled();
  });

  it("Stop only with the right; lanes are independent", async () => {
    const h = setup(snap({ canStop: false, canRetry: { study: false, stop: true } }));
    expect((screen.getByRole("button", { name: "Завершить" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Повторить завершение" }));
    expect(h.actions.retry.mock.calls).toEqual([["stop"]]);
    await h.update(snap());
    fireEvent.click(screen.getByRole("button", { name: "Завершить" }));
    expect(h.actions.stop.mock.calls).toEqual([["stop"]]);
  });
});

describe("ConjugationTestScreen recovery, stale, summary and closed", () => {
  it("loading for the mask; recovery and stale are explicit with manual actions only", async () => {
    const h = setup(null);
    expect(screen.getByText("Загружаем занятие…")).toBeTruthy();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    await h.update(snap({ phase: "stale", problem: "network", currentStep: null, display: { kind: "none" } }));
    expect(screen.getByText("Нет связи с сервером.")).toBeTruthy();
    await h.update(snap({ phase: "stale", problem: "SOMETHING_NEW", currentStep: null, display: { kind: "none" } }));
    expect(screen.getByText("Не удалось обновить занятие.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Проверить статус" }));
    expect(h.actions.refresh).toHaveBeenCalledTimes(1);
    for (const spy of [h.actions.start, h.actions.submit, h.actions.retry, h.actions.stop]) expect(spy).not.toHaveBeenCalled();
  });

  it("Ф4: a reply that failed strict parsing is not shown as a lost connection", () => {
    setup(snap({ phase: "stale", problem: "invalid_response", currentStep: null, display: { kind: "none" } }));
    expect(screen.getByText("Не удалось обновить занятие.")).toBeTruthy();
    expect(screen.queryByText("Нет связи с сервером.")).toBeNull();
  });

  it("Ф8: while the summary_home Stop is in flight the summary shows the waiting text", async () => {
    const summary = { display: { kind: "summary" } as const, canSubmit: false, currentStep: { stateVersion: "10", step: projection(null, "summary") } };
    const h = setup(snap({ ...summary, phase: "summary", canSummaryHome: true }));
    expect(screen.queryByText("Завершаем занятие…")).toBeNull();
    await h.update(snap({ ...summary, phase: "stopping", canSummaryHome: false, canStop: false }));
    expect(screen.getByText("Завершаем занятие…")).toBeTruthy();
    expect((screen.getByRole("button", { name: "На Сегодня" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("summary phase: no refresh button; Today → summary_home", () => {
    const h = setup(snap({ phase: "summary", display: { kind: "summary" }, canSubmit: false, canSummaryHome: true,
      currentStep: { stateVersion: "10", step: projection(null, "summary") } }));
    expect(listed()).toEqual(["gehen · Präsens — Легко"]);
    expect(screen.queryByRole("button", { name: "Обновить итог" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "На Сегодня" }));
    expect(h.actions.stop.mock.calls).toEqual([["summary_home"]]);
  });

  it("closed with unknown summary: text + one refresh button; the button disappears once the summary is known", async () => {
    const h = setup(closed(null));
    expect(screen.getByText("Подробности итога недоступны")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Обновить итог" }));
    expect(h.actions.refresh).toHaveBeenCalledTimes(1);
    await h.update(closed(null));
    expect(screen.getAllByRole("button", { name: "Обновить итог" })).toHaveLength(1);
    await h.update(closed(summaryFixture()));
    expect(screen.queryByRole("button", { name: "Обновить итог" })).toBeNull();
    expect(listed()).toEqual(["gehen · Präsens — Легко"]);
    fireEvent.click(screen.getByRole("button", { name: "На Сегодня" }));
    expect(h.onToday).toHaveBeenCalledTimes(1);
    expect(h.actions.refresh).toHaveBeenCalledTimes(1);
  });

  it("closed with an L0 summary: details unavailable, no refresh button", () => {
    setup(closed({ completed_cycle_ids: [], partial: [], results: [], completed: 0, correct: 0, wrong: 0, blocks: null }));
    expect(screen.getByText("Подробности итога недоступны")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Обновить итог" })).toBeNull();
  });
});

describe("ConjugationTestScreen languages", () => {
  it.each([["uk", "Тест дієвідмін", "Перевірити", "Завершити"], ["en", "Conjugation test", "Check", "End"], ["ru", "Тест спряжений", "Проверить", "Завершить"]] as const)(
    "%s: every own label is localized and no UUID is rendered", (language, title, check, stop) => {
      const { container } = setup(snap(), { language });
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(title);
      expect(screen.getByRole("button", { name: check })).toBeTruthy();
      expect(screen.getByRole("button", { name: stop })).toBeTruthy();
      expect(container.innerHTML).not.toMatch(uuidPattern);
    });
});

describe("ConjugationTestScreen G-2: the flow draft is the only source", () => {
  it("1/4/5: each keystroke renders from the flow; refused or repeated text notifies nothing; Snapshots never loop", async () => {
    const h = setup(snap());
    for (const prefix of ["g", "ge", "geh"]) {
      fireEvent.change(h.field(), { target: { value: prefix } });
      expect(h.field().value).toBe(prefix);
    }
    expect(h.counts.changes).toBe(3);
    expect(h.flow.project({ source: { tuple: "tuple-1", access: A1 }, state: snap(), transitionMode: "normal", active: true }))
      .toMatchObject({ draft: "geh" });
    fireEvent.change(h.field(), { target: { value: "geh" } });
    expect(h.counts.changes).toBe(3);
    await h.update(snap({ canSubmit: false }));
    fireEvent.change(h.field(), { target: { value: "refused" } });
    expect(h.field().value).toBe("geh");
    expect(h.counts.changes).toBe(3);
    const before = h.counts.renders;
    for (let i = 0; i < 20; i++) await h.update(snap({ stateVersion: String(20 + i) }));
    expect(h.counts.renders - before).toBeLessThanOrEqual(20);
    expect(h.counts.changesInRender).toBe(0);
    for (const spy of Object.values(h.actions)) expect(spy).not.toHaveBeenCalled();
  });

  it("2: IME composition follows the input and its Enter submits nothing", () => {
    const h = setup(snap());
    fireEvent.compositionStart(h.field());
    fireEvent.change(h.field(), { target: { value: "ge" } });
    fireEvent.change(h.field(), { target: { value: "geh" } });
    fireEvent.keyDown(h.field(), { key: "Enter", isComposing: true });
    fireEvent.compositionEnd(h.field());
    expect(h.field().value).toBe("geh");
    expect(h.actions.submit).not.toHaveBeenCalled();
  });

  it("3: a German symbol inserted mid-word keeps the caret after it", () => {
    const h = setup(snap());
    fireEvent.change(h.field(), { target: { value: "gh" } });
    h.field().setSelectionRange(1, 1);
    fireEvent.click(screen.getByRole("button", { name: "ä" }));
    expect(h.field().value).toBe("gäh");
    expect(h.field().selectionStart).toBe(2);
  });

  it("7/8: another tuple with the same assignment is empty on its first render; a gap (state:null) keeps the draft", async () => {
    const h = setup(snap());
    fireEvent.change(h.field(), { target: { value: "geh" } });
    await h.update(null);
    expect(screen.getByText("Загружаем занятие…")).toBeTruthy();
    await h.update(snap());
    expect(h.field().value).toBe("geh");
    await h.host({ tuple: "tuple-2" });
    expect(h.field().value).toBe("");
  });

  it("9/10: an accepted submit consumes the draft; a programmatic setDraft renders", async () => {
    const h = setup(snap());
    fireEvent.change(h.field(), { target: { value: "  gehst" } });
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    expect(h.actions.submit.mock.calls).toEqual([[{ text: "  gehst" }, B1]]);
    await h.update(onResult(result(true), { currentStep: null, acceptedAddress: null, commands: { study: command({ phase: "settled", outcome: "accepted",
      kind: "answer.submit", sessionId: S1, resolved: { commandId: id(52), kind: "answer.submit", sessionId: S1, assignmentId: B1, resultId: R1 } }), stop: command() } }));
    await h.update(snap());
    expect(h.field().value).toBe("");
    act(() => { h.flow.setDraft("x"); });
    expect(h.field().value).toBe("x");
  });

  it("whitespace-only: the check button is closed by the flow right, forgot stays open", () => {
    const h = setup(snap());
    fireEvent.change(h.field(), { target: { value: "   " } });
    expect((screen.getByRole("button", { name: "Проверить" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Забыл…" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("12: the latest onToday is called exactly once after its own summary_home", async () => {
    const h = setup(snap({ phase: "summary", display: { kind: "summary" }, canSubmit: false, canSummaryHome: true,
      currentStep: { stateVersion: "10", step: projection(null, "summary") } }));
    const newest = vi.fn();
    await h.host({ onToday: newest });
    fireEvent.click(screen.getByRole("button", { name: "На Сегодня" }));
    const done = { ...closed(summaryFixture()), closed: { sessionId: S1, reason: "summary_home" as const, summary: summaryFixture() } };
    await h.update(done);
    await h.update({ ...done });
    expect(newest).toHaveBeenCalledTimes(1);
    expect(h.onToday).not.toHaveBeenCalled();
  });

  it("11: StrictMode owner (create in effect, dispose in cleanup): the first instance is disposed and silent, typing works in the second", async () => {
    const created: { flow: ConjugationTestFlow; changes: number }[] = [];
    const actions = { refresh: vi.fn(async () => undefined), start: vi.fn(async () => undefined), openStep: vi.fn(), openResult: vi.fn(),
      shown: vi.fn(async () => undefined), submit: vi.fn(async () => undefined), grade: vi.fn(async () => undefined),
      correct: vi.fn(async () => undefined), undo: vi.fn(async () => undefined), stop: vi.fn(async () => undefined), retry: vi.fn(async () => undefined) };
    function Owner() {
      const [flow, setFlow] = useState<ConjugationTestFlow | null>(null);
      const [, repaint] = useReducer((n: number) => n + 1, 0);
      useEffect(() => {
        const entry = { flow: null as unknown as ConjugationTestFlow, changes: 0 };
        entry.flow = new ConjugationTestFlow({ actions, schedule: () => () => undefined, onToday: () => undefined,
          onChange: () => { entry.changes++; repaint(); } });
        created.push(entry); setFlow(entry.flow);
        return () => { entry.flow.dispose(); };
      }, []);
      const input: FlowInput = { source: { tuple: "tuple-1", access: A1 }, state: snap(), transitionMode: "normal", active: true };
      const view = flow ? flow.project(input) : null;
      useLayoutEffect(() => { flow?.commit(input); });
      return view && flow ? <ConjugationTestScreen view={view} flow={flow} language="ru" submitOnEnter /> : null;
    }
    render(<StrictMode><Owner /></StrictMode>);
    await flush();
    expect(created).toHaveLength(2);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "geh" } });
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("geh");
    created[0].flow.setDraft("late");
    expect(created[0].changes).toBe(0);
    expect(created[1].changes).toBe(1);
  });
});

describe("ConjugationTestScreen «Шаг назад»", () => {
  const summaryState = (over: Partial<ConjugationDocumentSnapshot> = {}) => snap({ phase: "summary", display: { kind: "summary" }, canSubmit: false,
    canSummaryHome: true, currentStep: { stateVersion: "10", step: projection(null, "summary") }, ...over });
  const undoing = command({ phase: "sending", pending: true, kind: "result.undo", sessionId: S1,
    pendingIntent: { command_id: id(72), kind: "result.undo", session_id: S1, assignment_id: A0, result_id: R1, expected_result_version: "5", payload: {} } });
  const rejected = (rejectionCode: string) => command({ phase: "settled", outcome: "rejected", rejectionCode,
    resolved: { commandId: id(72), kind: "result.undo", sessionId: S1, assignmentId: A0 } });

  it("shows the button on the result and on the live summary only while the document grants it, and sends one undo", async () => {
    const h = setup(onResult(result(true)));
    expect(screen.queryByRole("button", { name: "Шаг назад" })).toBeNull();
    await h.update(onResult(result(true), { canUndo: true }));
    const button = screen.getByRole("button", { name: "Шаг назад" });
    expect(button.getAttribute("title")).toBe("Шаг назад");
    fireEvent.click(button);
    expect(h.actions.undo).toHaveBeenCalledTimes(1);
    expect(h.actions.openStep).not.toHaveBeenCalled();
    await h.update(summaryState({ canUndo: true, resultA: onResult(result(true)).resultA }));
    fireEvent.click(screen.getByRole("button", { name: "Шаг назад" }));
    expect(h.actions.undo).toHaveBeenCalledTimes(2);
    await h.update(summaryState({ canUndo: false }));
    expect(screen.queryByRole("button", { name: "Шаг назад" })).toBeNull();
    // The next question never carries it.
    await h.update(snap({ canUndo: true }));
    expect(screen.queryByRole("button", { name: "Шаг назад" })).toBeNull();
  });

  it("the button disappears and «Отменяем ответ…» is shown while the command runs, on the result and on the summary", async () => {
    const h = setup(onResult(result(true), { canUndo: true }));
    await h.update(onResult(result(true), { canUndo: false, allowedGrades: [], commands: { study: undoing, stop: command() } }));
    expect(screen.queryByRole("button", { name: "Шаг назад" })).toBeNull();
    expect(screen.getByText("Отменяем ответ…")).toBeTruthy();
    await h.update(summaryState({ commands: { study: undoing, stop: command() } }));
    expect(screen.getByText("Отменяем ответ…")).toBeTruthy();
    await h.update(onResult(result(true)));
    expect(screen.queryByText("Отменяем ответ…")).toBeNull();
  });

  it.each(["CAPABILITY_EXPIRED", "VERSION_CONFLICT", "FORBIDDEN", "ASSIGNMENT_STALE"])("refusal %s says that the step back is gone, on the answer", async code => {
    const h = setup(onResult(result(true), { canUndo: true }));
    await h.update(onResult(result(true), { problem: code, commands: { study: rejected(code), stop: command() } }));
    expect(screen.getByText("Шаг назад больше недоступен.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Шаг назад" })).toBeNull();
    await h.update(snap({ problem: code, commands: { study: rejected(code), stop: command() } }));
    expect(screen.queryByText("Шаг назад больше недоступен.")).toBeNull();
  });

  it("another refusal of the same command keeps its own text; a refused grade does not borrow the undo text", async () => {
    const h = setup(onResult(result(true)));
    await h.update(onResult(result(true), { problem: "SESSION_CLOSED", commands: { study: rejected("SESSION_CLOSED"), stop: command() } }));
    expect(screen.getByText("Занятие завершено.")).toBeTruthy();
    expect(screen.queryByText("Шаг назад больше недоступен.")).toBeNull();
    const grade = command({ phase: "settled", outcome: "rejected", rejectionCode: "VERSION_CONFLICT",
      resolved: { commandId: id(73), kind: "result.grade", sessionId: S1, assignmentId: A0 } });
    await h.update(onResult(result(true), { problem: "VERSION_CONFLICT", commands: { study: grade, stop: command() } }));
    expect(screen.queryByText("Шаг назад больше недоступен.")).toBeNull();
    expect(screen.getByText("Не удалось обновить занятие.")).toBeTruthy();
  });

  it.each([["uk", "Крок назад", "Скасовуємо відповідь…", "Крок назад більше недоступний."], ["en", "Step back", "Undoing the answer…", "Step back is no longer available."]] as const)(
    "%s: label, waiting text and refusal are localized", async (language, label, waiting, gone) => {
      const h = setup(onResult(result(true), { canUndo: true }), { language });
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
      await h.update(onResult(result(true), { canUndo: false, commands: { study: undoing, stop: command() } }));
      expect(screen.getByText(waiting)).toBeTruthy();
      await h.update(onResult(result(true), { problem: "VERSION_CONFLICT", commands: { study: rejected("VERSION_CONFLICT"), stop: command() } }));
      expect(screen.getByText(gone)).toBeTruthy();
    });

  it("an inactive screen shows no button; an unknown undo shows the checking text with the check and retry buttons", async () => {
    setup(onResult(result(true), { canUndo: true }), { active: false });
    expect(screen.queryByRole("button", { name: "Шаг назад" })).toBeNull();
    cleanup();
    const h = setup(onResult(result(true), { canUndo: true }));
    const unknown = snap({ phase: "unknown", display: { kind: "none" }, currentStep: null, resultA: null, canSubmit: false, canRetry: { study: true, stop: false },
      commands: { study: command({ phase: "unresolved", pending: true, kind: "result.undo", sessionId: S1, canRetry: true, pendingIntent: undoing.pendingIntent }), stop: command() } });
    await h.update(unknown);
    expect(screen.getByText("Проверяем изменение")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Шаг назад" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Проверить статус" }));
    fireEvent.click(screen.getByRole("button", { name: "Повторить действие" }));
    expect(h.actions.refresh).toHaveBeenCalledTimes(1);
    expect(h.actions.retry).toHaveBeenCalledWith("study");
    expect(h.actions.undo).not.toHaveBeenCalled();
  });
});
