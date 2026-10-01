import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenedClient, OralSessionProjection } from "../api/generated";
import { createOpenedAccess } from "../app/openedAccess";
import type { Language } from "../i18n/language";
import type { AsyncStorage } from "../platform/storage";
import { OralScreen } from "./OralScreen";
import { OralDocumentController, type OralDocumentSnapshot } from "./oralDocumentController";
import { oralIntentHash, type OralIntent, type OralCommand } from "./oralIntent";
import { OralSessionPendingStore, OralStopPendingStore } from "./oralPending";
import { useOralDocument, type OralDocumentActions } from "./useOralDocument";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const studyKey = "wortly.pending.oral_session", stopKey = "wortly.pending.oral_stop";
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
type Step = "prefetched" | "presented" | "revealed" | "summary" | "closed";
function projection(step: Step = "prefetched", completed = 0, correct = 0, total = 2): OralSessionProjection {
  const active = step !== "summary" && step !== "closed", assignmentId = completed === 0 ? id(6) : id(8);
  return { session_id: id(3), status: active ? "active" : step as "summary" | "closed", mode: "oral", pair: "ru-de",
    direction: "de-l1", local_date: "2026-10-01", bucket: "words", close_reason: step === "closed" ? "stop" : null,
    progress: { completed, total, correct, wrong: completed - correct },
    assignment: active ? { id: assignmentId, card_id: id(7), status: step === "prefetched" ? "prefetched" : "presented",
      kind: "original", prompt: { text: completed === 0 ? "wenn" : "die Straße", language: "de",
        conjunction_hint: completed === 0 ? { meaning_category: "Bedingung", verb_position: "am Ende" } : null },
      ...(step === "revealed" ? { status: "presented", revealed: true, translations: completed === 0 ? ["если", "при условии"] : ["улица"] } : { revealed: false }) } : null,
    summary: active ? null : { completed, correct, wrong: completed - correct, ratio: completed ? { numerator: correct, denominator: completed } : null },
    practice: { pair: "ru-de", direction: "de-l1", local_date: "2026-10-01", time_zone: "UTC", count: completed },
    capabilities: { reveal_target: step === "presented" ? assignmentId : null, grade_target: step === "revealed" ? assignmentId : null,
      stop: step !== "closed", summary_home: step === "summary" } };
}
const profile: OpenedClient["profile"] = { profile_id: id(50), role: "user", ui_language: "ru", dictionary_language: "ru",
  time_zone: "UTC", state_version: "1", access: { status: "admitted", version: "1", reason: null } };
function fact(intent: OralIntent, status = "applied") {
  const grade = intent.kind === "oral.grade";
  return { id: intent.command_id, kind: intent.kind, status, applied_at: "2026-10-01T12:00:00Z",
    target_id: "assignment_id" in intent ? intent.assignment_id : intent.session_id,
    action_id: grade ? id(10) : null, result_id: grade ? id(11) : null, context_id: null, object_version: grade ? "1" : null };
}
/** FakeHTTP is a synthetic server model. These tests do not claim independent backend acceptance. */
function fixture(step: Step = "prefetched") {
  let counter = 100, current = projection(step), stateVersion = "8";
  const values = new Map<string, string>(), accepted = new Map<string, OralIntent>();
  const holds = new Map<OralIntent["kind"], ReturnType<typeof deferred<void>>>();
  const posts: OralCommand[] = [], gets: string[] = [];
  const storage: AsyncStorage = { get: vi.fn(async k => values.get(k) ?? null),
    set: vi.fn(async (k, v) => { values.set(k, v); }), remove: vi.fn(async k => { values.delete(k); }) };
  const access = createOpenedAccess({ opened: { status: "opened", client_instance_id: id(1), document_id: id(2), document_epoch: "1",
    proof_version: "1", profile, session: null, compatibility: { compatible: true, contract_version: "1" } },
    token: "synthetic-token", proof: "synthetic-proof", generation: 1, isLive: () => true, onDenied() {} });
  const handler: typeof fetch = async (url, init) => {
    const path = new URL(String(url), "https://model.invalid");
    if (init?.method === "POST") {
      const command = JSON.parse(String(init.body)) as OralCommand; posts.push(command);
      const { client_instance_id: _client, document_id: _doc, ...intent } = command;
      accepted.set(intent.command_id, intent);
      const { completed, correct, total } = current.progress;
      if (command.kind === "oral.grade") current = projection(completed + 1 === total ? "summary" : "prefetched",
        completed + 1, correct + Number(command.payload.correct), total);
      else current = projection(command.kind === "session.stop" ? "closed" : command.kind === "oral.reveal" ? "revealed"
        : command.kind === "assignment.present" ? "presented" : "prefetched", completed, correct, total);
      stateVersion = String(BigInt(stateVersion) + 1n);
      const reply = { command: fact(intent), current, state_version: stateVersion };
      if (holds.has(command.kind)) await holds.get(command.kind)!.promise;
      return response(reply);
    }
    gets.push(path.pathname + path.search);
    if (path.pathname.includes("/commands/")) {
      const commandId = path.pathname.split("/").at(-1)!, intent = accepted.get(commandId);
      return intent ? response({ command: fact(intent, "already_applied"), verified_intent_hash: await oralIntentHash(intent), current, state_version: stateVersion })
        : response({ command: { id: commandId, status: "not_found" }, current: { ...profile, state_version: stateVersion }, state_version: stateVersion });
    }
    return response({ current, state_version: stateVersion });
  };
  const fetcher = vi.fn<typeof fetch>(handler);
  const options = { access, transport: { fetcher, timeoutMs: 1000, maxResponseBytes: 100000 },
    studyStore: new OralSessionPendingStore(storage), stopStore: new OralStopPendingStore(storage),
    newId: () => id(counter++), initialSessionId: id(3) };
  const controller = new OralDocumentController({ ...options, onUpdate() {} });
  const actions: OralDocumentActions = { refresh: () => controller.refresh(), start: bucket => controller.start(bucket),
    shown: ticket => controller.shown(ticket), reveal: () => controller.reveal(), grade: correct => controller.grade(correct),
    stop: reason => controller.stop(reason), retry: lane => controller.retry(lane) };
  function Harness({ active = true, language = "ru" }: { active?: boolean; language?: Language }) {
    const doc = useOralDocument({ ...options, enabled: active });
    return <OralScreen {...doc} language={language} active={active} />;
  }
  return { controller, actions, options, Harness, posts, gets, values, accepted, storage, fetcher, handler,
    hold: (kind: OralIntent["kind"]) => { const gate = deferred<void>(); holds.set(kind, gate); return gate; },
    set: (next: OralSessionProjection, version = stateVersion) => { current = next; stateVersion = version; } };
}
function visible(state: "visible" | "hidden") { Object.defineProperty(document, "visibilityState", { configurable: true, value: state }); }
function shownCallbacks() { const callbacks: VoidFunction[] = []; vi.spyOn(globalThis, "queueMicrotask").mockImplementation(callback => { callbacks.push(callback); }); return callbacks; }
function button(name: string) { return screen.getByRole("button", { name }) as HTMLButtonElement; }
afterEach(() => { cleanup(); visible("visible"); vi.restoreAllMocks(); });

describe("OralScreen: public Interface with real owner, stores and API", () => {
  it("visible commit → present → reveal → exact bool grades → next and natural summary", async () => {
    const f = fixture(); render(<f.Harness />);
    await waitFor(() => expect(button("Раскрыть").disabled).toBe(false));
    expect(f.posts.map(p => p.kind)).toEqual(["assignment.present"]);
    expect(screen.getByText("wenn").getAttribute("lang")).toBe("de");
    expect(screen.getByText("Bedingung")).toBeTruthy(); expect(screen.getByText("am Ende")).toBeTruthy();
    expect(screen.queryByText("если")).toBeNull(); expect(screen.queryByRole("button", { name: "Правильно" })).toBeNull();
    fireEvent.click(button("Раскрыть")); await waitFor(() => expect(button("Правильно").disabled).toBe(false));
    expect(within(screen.getByRole("region", { name: "Перевод" })).getAllByRole("paragraph").map(p => p.textContent)).toEqual(["если", "при условии"]);
    expect(f.posts.filter(p => p.kind === "oral.grade")).toHaveLength(0);
    fireEvent.click(button("Правильно")); await waitFor(() => expect(screen.getByText("die Straße")).toBeTruthy());
    await waitFor(() => expect(button("Раскрыть").disabled).toBe(false));
    expect(screen.queryByText("если")).toBeNull(); fireEvent.click(button("Раскрыть"));
    await waitFor(() => expect(button("Неправильно").disabled).toBe(false)); fireEvent.click(button("Неправильно"));
    await waitFor(() => expect(screen.getByRole("region", { name: "Итог занятия" })).toBeTruthy());
    expect(f.posts.filter(p => p.kind === "oral.grade").map(p => p.payload)).toEqual([{ correct: true }, { correct: false }]);
    const summary = screen.getByRole("region", { name: "Итог занятия" });
    expect(Array.from(summary.querySelectorAll("dd"), e => e.textContent)).toEqual(["2", "1", "1", "0"]);
    fireEvent.click(button("На Сегодня")); await waitFor(() => expect(screen.getByText("Занятие завершено.")).toBeTruthy());
    expect(f.posts.at(-1)).toMatchObject({ kind: "session.stop", payload: { reason: "summary_home" } });
    expect(screen.queryByRole("region", { name: "Итог занятия" })).toBeNull();
  });

  it("a held present never licenses reveal or grade; masked current is not kept locally", async () => {
    const f = fixture(), gate = f.hold("assignment.present"); render(<f.Harness />);
    await waitFor(() => expect(f.posts).toHaveLength(1));
    expect(screen.getByText("Подтверждаем показ задания…")).toBeTruthy();
    expect(screen.queryByText("wenn")).toBeNull(); expect(screen.queryByRole("button", { name: "Раскрыть" })).toBeNull();
    expect(screen.queryByText("если")).toBeNull(); expect(screen.queryByRole("button", { name: "Правильно" })).toBeNull();
    await act(async () => { gate.resolve(); }); await waitFor(() => expect(button("Раскрыть").disabled).toBe(false));
    expect(f.posts).toHaveLength(1);
  });

  it("StrictMode produces one owner present POST and unrelated rerenders do not create another", async () => {
    const f = fixture(), ui = render(<f.Harness />, { reactStrictMode: true });
    await waitFor(() => expect(button("Раскрыть").disabled).toBe(false)); ui.rerender(<f.Harness language="en" />);
    await act(async () => {}); expect(f.posts.map(p => p.kind)).toEqual(["assignment.present"]);
    expect(button("Reveal").disabled).toBe(false);
  });

  it("a hung study command leaves the separate Stop lane usable; late reply cannot restore the question", async () => {
    const f = fixture("revealed"), gate = f.hold("oral.grade"); render(<f.Harness />);
    await waitFor(() => expect(button("Правильно").disabled).toBe(false)); fireEvent.click(button("Правильно"));
    await waitFor(() => expect(f.posts).toHaveLength(1)); expect(button("Выйти").disabled).toBe(false);
    expect(screen.getByText("Сохраняем действие…")).toBeTruthy(); fireEvent.click(button("Выйти"));
    await waitFor(() => expect(screen.getByText("Занятие завершено.")).toBeTruthy());
    expect(f.posts[1]).toMatchObject({ kind: "session.stop", payload: { reason: "stop" } });
    expect(button("Проверить состояние").disabled).toBe(false); expect(screen.queryByRole("region", { name: "Итог занятия" })).toBeNull();
    await act(async () => { gate.resolve(); }); expect(screen.queryByText("die Straße")).toBeNull();
    expect(screen.getByText("Занятие завершено.")).toBeTruthy();
  });
});

describe("OralScreen: visible commit lifetime", () => {
  it("render/SSR and inactive detached snapshots never call actions", async () => {
    const f = fixture(); await f.controller.refresh(); const state = f.controller.snapshot(), shown = vi.spyOn(f.actions, "shown");
    renderToString(<OralScreen state={state} actions={f.actions} language="ru" active />); expect(shown).not.toHaveBeenCalled();
    render(<OralScreen state={state} actions={f.actions} language="ru" active={false} />);
    await act(async () => {}); fireEvent.click(button("Раскрыть")); fireEvent.click(button("Выйти"));
    expect(button("Раскрыть").disabled).toBe(true); expect(f.posts).toEqual([]); expect(shown).not.toHaveBeenCalled();
    f.controller.dispose();
  });

  it("hidden document and disconnected prompt suppress a queued visible-commit callback", async () => {
    const f = fixture(); await f.controller.refresh(); const callbacks = shownCallbacks(), shown = vi.spyOn(f.actions, "shown");
    const ui = render(<OralScreen state={f.controller.snapshot()} actions={f.actions} language="ru" active />);
    expect(callbacks).toHaveLength(1); visible("hidden"); act(() => { callbacks[0](); }); expect(shown).not.toHaveBeenCalled();
    visible("visible"); const prompt = screen.getByText("wenn"); prompt.remove(); act(() => { callbacks[0](); });
    expect(shown).not.toHaveBeenCalled(); expect(f.posts).toEqual([]); ui.unmount(); f.controller.dispose();
  });

  it.each(["ticket", "inactive", "null", "unmount"] as const)("%s cleanup cancels retained callback without substituting a new ticket", async change => {
    const f = fixture(); await f.controller.refresh(); const old = f.controller.snapshot(), callbacks = shownCallbacks();
    const shown = vi.spyOn(f.actions, "shown"), commitChecks = vi.fn();
    function CommitProbe({ state, active, probe = false }: { state: OralDocumentSnapshot | null; active: boolean; probe?: boolean }) {
      useLayoutEffect(() => {
        // Run the retained callback during the replacement commit, before passive cleanup.
        if (probe) { commitChecks(); callbacks[0](); }
      }, [probe]);
      return <OralScreen state={state} actions={f.actions} language="ru" active={active} />;
    }
    const ui = render(<CommitProbe state={old} active />);
    let nextCallback: VoidFunction | undefined, nextTicket = old.presentationTicket;
    if (change === "ticket") {
      // Restore the scheduler while real HTTP Response streams close their own microtasks.
      vi.mocked(queueMicrotask).mockRestore();
      f.set(projection("prefetched", 1, 1), "9"); await f.controller.refresh();
      const next = f.controller.snapshot(), nextCallbacks = shownCallbacks(); nextTicket = next.presentationTicket;
      ui.rerender(<CommitProbe state={next} active />);
      expect(nextCallbacks).toHaveLength(1); nextCallback = nextCallbacks[0]; vi.mocked(queueMicrotask).mockRestore();
    } else if (change === "unmount") ui.unmount();
    else {
      ui.rerender(<CommitProbe state={change === "null" ? null : old} active={change !== "inactive"} probe />);
      expect(commitChecks).toHaveBeenCalledOnce(); expect(shown).not.toHaveBeenCalled();
    }
    act(() => { callbacks[0](); }); expect(shown).not.toHaveBeenCalled(); expect(f.posts).toEqual([]);
    if (change === "ticket") {
      await act(async () => { nextCallback!(); });
      expect(shown).toHaveBeenCalledWith(nextTicket);
      expect(shown.mock.calls[0][0]).not.toBe(old.presentationTicket);
      expect(f.posts[0]).toMatchObject({ kind: "assignment.present", assignment_id: id(8) });
    }
    f.controller.dispose();
  });
});

describe("OralScreen: recovery stays separate from accepted results", () => {
  it.each(["study", "stop"] as const)("unknown %s checks GET, retries only that lane and preserves exact intent", async lane => {
    const f = fixture(lane === "study" ? "presented" : "revealed");
    const intent: OralIntent = lane === "study" ? { command_id: id(4), session_id: id(3), assignment_id: id(6), kind: "oral.reveal", payload: {} }
      : { command_id: id(5), session_id: id(3), kind: "session.stop", payload: { reason: "stop" } };
    const receiptKey = lane === "study" ? studyKey : stopKey, retry = lane === "study" ? "Повторить действие" : "Повторить завершение";
    f.values.set(receiptKey, JSON.stringify({ schemaVersion: 1, profileId: id(50), clientInstanceId: id(1), pair: "ru-de", intent }));
    render(<f.Harness />); await waitFor(() => expect(button(retry)).toBeTruthy());
    expect(screen.queryByRole("button", { name: lane === "study" ? "Повторить завершение" : "Повторить действие" })).toBeNull(); expect(f.posts).toEqual([]);
    fireEvent.click(button("Проверить состояние")); await waitFor(() => expect(button(retry)).toBeTruthy());
    expect(f.posts).toEqual([]); expect(f.gets.filter(url => url.includes("/commands/")).length).toBeGreaterThanOrEqual(2);
    fireEvent.click(button(retry)); await waitFor(() => lane === "study" ? expect(button("Правильно").disabled).toBe(false)
      : expect(screen.getByText("Занятие завершено.")).toBeTruthy());
    expect(f.posts).toHaveLength(1); expect(f.posts[0]).toMatchObject(intent); expect(f.values.has(receiptKey)).toBe(false);
  });

  it("closed retains a GET check for an unresolved study receipt without another POST or invented interrupted summary", async () => {
    const f = fixture("revealed"), original = f.handler;
    f.fetcher.mockImplementation(async (url, init) => {
      const reply = await original(url, init);
      if (init?.method === "POST" && JSON.parse(String(init.body)).kind === "oral.grade") throw new Error("synthetic lost response");
      return reply;
    });
    render(<f.Harness />); await waitFor(() => expect(button("Правильно").disabled).toBe(false)); fireEvent.click(button("Правильно"));
    await waitFor(() => expect(screen.getByText("Действие ещё не подтверждено. Проверь состояние.")).toBeTruthy());
    fireEvent.click(button("Выйти")); await waitFor(() => expect(screen.getByText("Занятие завершено.")).toBeTruthy());
    expect(f.values.has(studyKey)).toBe(true); expect(screen.queryByRole("region", { name: "Итог занятия" })).toBeNull();
    fireEvent.click(button("Проверить состояние")); await waitFor(() => expect(f.values.has(studyKey)).toBe(false));
    expect(f.gets.some(url => url.includes("/commands/"))).toBe(true);
    expect(f.posts.map(p => p.kind)).toEqual(["oral.grade", "session.stop"]); expect(screen.queryByText("die Straße")).toBeNull();
  });

  it("closed with accepted receipt but failed clear keeps local failure and manual GET/cleanup recovery", async () => {
    const f = fixture("revealed"); vi.mocked(f.storage.remove).mockRejectedValueOnce(new Error("synthetic storage failure"));
    render(<f.Harness />); await waitFor(() => expect(button("Выйти").disabled).toBe(false)); fireEvent.click(button("Выйти"));
    await waitFor(() => expect(screen.getByText("Не удалось обновить данные на этом устройстве. Проверь состояние.")).toBeTruthy());
    expect(screen.getByText("Занятие завершено.")).toBeTruthy(); expect(f.values.has(stopKey)).toBe(true);
    expect(screen.queryByRole("button", { name: "Повторить завершение" })).toBeNull();
    fireEvent.click(button("Проверить состояние")); await waitFor(() => expect(f.values.has(stopKey)).toBe(false));
    expect(f.posts).toHaveLength(1); expect(screen.queryByText("Не удалось обновить данные на этом устройстве. Проверь состояние.")).toBeNull();
  });

  it("mismatched pending payload never becomes success or enables retry; closed still checks unresolved receipt", async () => {
    const f = fixture("revealed"), intent: OralIntent = { command_id: id(4), session_id: id(3), assignment_id: id(6), kind: "oral.grade", payload: { correct: true } };
    f.values.set(studyKey, JSON.stringify({ schemaVersion: 1, profileId: id(50), clientInstanceId: id(1), pair: "ru-de", intent }));
    const original = f.handler;
    f.fetcher.mockImplementation((url, init) => String(url).includes("/commands/")
      ? Promise.resolve(response({ error: { code: "COMMAND_PAYLOAD_MISMATCH" } }, 409)) : original(url, init));
    render(<f.Harness />); await waitFor(() => expect(button("Выйти").disabled).toBe(false));
    expect(screen.getByText("Действие нельзя повторить. Проверь состояние занятия.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Повторить действие" })).toBeNull(); fireEvent.click(button("Выйти"));
    await waitFor(() => expect(screen.getByText("Занятие завершено.")).toBeTruthy());
    expect(f.values.has(studyKey)).toBe(true); expect(button("Проверить состояние").disabled).toBe(false);
    fireEvent.click(button("Проверить состояние")); await act(async () => {});
    expect(f.posts.map(p => p.kind)).toEqual(["session.stop"]); expect(f.values.has(studyKey)).toBe(true);
    expect(screen.queryByText("COMMAND_PAYLOAD_MISMATCH")).toBeNull(); expect(screen.queryByText(id(4))).toBeNull();
  });
});

describe("OralScreen: localized detached rendering and capability guards", () => {
  it.each(["ru", "uk", "en"] as const)("%s escapes server strings and exposes only approved oral controls", async language => {
    const f = fixture("revealed"), value = projection("revealed"); value.assignment!.prompt.text = '<img src=x onerror="boom()">';
    if (value.assignment!.revealed) value.assignment!.translations = ["<script>boom()</script>"];
    f.set(value); await f.controller.refresh();
    const ui = render(<OralScreen state={f.controller.snapshot()} actions={f.actions} language={language} active />);
    expect(ui.container.querySelector("main")?.getAttribute("lang")).toBe(language);
    expect(screen.getByText('<img src=x onerror="boom()">')).toBeTruthy(); expect(screen.getByText("<script>boom()</script>")).toBeTruthy();
    expect(ui.container.querySelector("img, script, input, textarea, audio, [role=timer]")).toBeNull();
    const names = Array.from(ui.container.querySelectorAll("button"), b => b.textContent);
    expect(names).toEqual(language === "en" ? ["Exit", "Correct", "Incorrect"] : language === "uk" ? ["Вийти", "Правильно", "Неправильно"] : ["Выйти", "Правильно", "Неправильно"]);
    f.controller.dispose();
  });

  it("null/loading, stale, stopping, disposed and zero summary are understandable; disabled capabilities call nothing", async () => {
    const f = fixture("summary"); f.set(projection("summary", 0, 0)); await f.controller.refresh();
    const base = f.controller.snapshot(), grade = vi.spyOn(f.actions, "grade"), stop = vi.spyOn(f.actions, "stop"), refresh = vi.spyOn(f.actions, "refresh");
    const ui = render(<OralScreen state={null} actions={f.actions} language="en" active />);
    expect(screen.getByText("Loading your session…")).toBeTruthy(); expect(button("Exit").disabled).toBe(true);
    for (const [phase, message] of [["idle", "The session has not started yet."], ["stale", "Could not refresh the session. Check status."], ["stopping", "Ending the session…"], ["disposed", "This session is unavailable in this window."]] as const) {
      ui.rerender(<OralScreen state={{ ...base, current: null, phase, canStop: false }} actions={f.actions} language="en" active />);
      expect(screen.getByText(message)).toBeTruthy();
    }
    ui.rerender(<OralScreen state={{ ...base, canSummaryHome: false }} actions={f.actions} language="en" active />);
    expect(Array.from(screen.getByRole("region", { name: "Session summary" }).querySelectorAll("dd"), e => e.textContent)).toEqual(["0", "0", "0", "2"]);
    fireEvent.click(button("Return to Today")); expect(stop).not.toHaveBeenCalled();
    const question = projection("revealed"), state: OralDocumentSnapshot = { ...base, current: question, phase: "revealed", canGrade: false, canStop: false };
    ui.rerender(<OralScreen state={state} actions={f.actions} language="en" active />);
    fireEvent.click(button("Correct")); fireEvent.click(button("Incorrect")); fireEvent.click(button("Exit"));
    expect(grade).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled();
    ui.rerender(<OralScreen state={{ ...base, phase: "closed", current: null }} actions={f.actions} language="en" active={false} />);
    expect(screen.queryByRole("button", { name: "Check status" })).toBeNull(); expect(refresh).not.toHaveBeenCalled(); f.controller.dispose();
  });
});
