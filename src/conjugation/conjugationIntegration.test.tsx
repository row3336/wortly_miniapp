// Real controller + flow (+ hook + screen) over a synthetic HTTP model of the server (not PG, not end-to-end).
// Ported from the independent acceptance M-CONJ-QA (qaConjugationIntegration.test.tsx); its findings are now ordinary tests.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useLayoutEffect, useMemo, useReducer } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConjugationSessionProjection, OpenedClient } from "../api/generated";
import { createOpenedAccess, type OpenedAccess } from "../app/openedAccess";
import type { AsyncStorage } from "../platform/storage";
import { conjugationIntentHash, type ConjugationCommand, type ConjugationIntent } from "./conjugationIntent";
import { ConjugationSessionPendingStore, ConjugationStopPendingStore } from "./conjugationPending";
import { ConjugationDocumentController, type ConjugationAcceptedAddress, type ConjugationDocumentActions } from "./conjugationDocumentController";
import { ConjugationTestFlow, type FlowInput } from "./conjugationTestFlow";
import { ConjugationTestScreen } from "./ConjugationTestScreen";
import { useConjugationDocument, type ConjugationDocumentHookOptions } from "./useConjugationDocument";

const id = (n: number) => `abababab-cdcd-4000-8000-${String(n).padStart(12, "0")}`;
const S1 = id(3), B1 = id(21), B2 = id(22), B3 = id(23);
const studyKey = "wortly.pending.conjugation_session";
type Result = { result_id: string; assignment_id: string; action_id: string; version: string; grade: 2 | 3 | 4 | 5 };
type Session = { id: string; status: "active" | "summary" | "closed"; assignment: string | null; presented: boolean; results: Result[];
  reason?: "stop" | "summary_home" };
function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
}
afterEach(() => { cleanup(); setVisibility("visible"); });

function projection(s: Session): ConjugationSessionProjection {
  const done = s.results.length, correct = s.results.filter(r => r.grade >= 3).length;
  const total = s.status === "active" ? done + 1 : done;
  const summary = s.status === "active" ? null : { completed_cycle_ids: [], partial: [{ cycle_id: id(9), answered_groups: ["ich"] }],
    results: s.results.map(r => ({ result_id: r.result_id, version: r.version })), completed: done, correct, wrong: done - correct,
    blocks: [{ cycle_id: id(9), base_verb_id: id(8), base_lemma: "kommen", tense: "present", answered_groups: ["ich"], effect: "incomplete", grade: null }] } as ConjugationSessionProjection["summary"];
  const assignment = s.status === "active" && s.assignment ? { id: s.assignment, card_id: id(8), status: s.presented ? "presented" : "prefetched",
    kind: "conjugation", cycle_id: id(9), slot_id: { cycle_id: id(9), pronoun_group: "du" }, base_verb_id: id(8), display_verb_id: id(18),
    tense: "present", pronoun_group: "du", prompt: { verb: "kommen", translation: "приходить", language: "ru", pronoun: "du", tense: "present" },
    answer_spec: { kind: "forms", labels: ["du"], part_count: 1, case_sensitive: false } } as ConjugationSessionProjection["assignment"] : null;
  return { session_id: s.id, status: s.status, mode: "conjugation", direction: "conjugation", pair: "ru-de", local_date: "2026-10-01",
    close_reason: s.status === "closed" ? s.reason ?? "stop" : null, progress: { total, completed: done, correct, wrong: done - correct }, assignment, summary,
    capabilities: { answer_target: assignment && s.presented ? s.assignment : null, correct_target: null, grades: null, undo_target: null,
      stop: s.status !== "closed", summary_home: s.status === "summary" } };
}
function resultEnvelope(s: Session, r: Result) {
  const step = projection(s), live = s.status !== "closed";
  const target = { session_id: s.id, assignment_id: r.assignment_id, result_id: r.result_id, expected_result_version: r.version };
  return { action: { action_id: r.action_id, kind: "answer.submit", version: r.version, status: "active" },
    result: { result_id: r.result_id, assignment_id: r.assignment_id, version: r.version, grade: r.grade, correct: r.grade >= 3,
      status: "active", accepted_at: "2026-10-01T08:00:00Z", answer_date: "2026-10-01", detail: null },
    step, capabilities: { ...step.capabilities, grades: live && r.grade >= 3 ? { ...target, values: [3, 4, 5] } : null,
      correct_target: live && r.grade === 2 ? target : null } };
}
const profile = (state_version = "9007199254740990"): OpenedClient["profile"] => ({ profile_id: id(50), role: "user", ui_language: "ru",
  dictionary_language: "ru", time_zone: "UTC", state_version, access: { status: "admitted", version: "1", reason: null } });
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const macrotasks = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(done => setTimeout(done, 0)); };

/** Synthetic HTTP model of the server. As in core, the same grade is an accepted no-op without a new version. */
function model(initial: Session[] = [{ id: S1, status: "active", assignment: B1, presented: true, results: [] }], lastAnswer = false) {
  const values = new Map<string, string>();
  const storage: AsyncStorage = { get: async k => values.get(k) ?? null, set: async (k, v) => { values.set(k, v); }, remove: async k => { values.delete(k); } };
  const sessions = new Map(initial.map(s => [s.id, structuredClone(s)]));
  const accepted = new Map<string, ConjugationIntent>();
  let stateVersion = "9007199254740991", counter = 100;
  const posted: ConjugationCommand[] = [], gets: string[] = [], fetches: string[] = [];
  const server = { lostReply: false, failPost: false, extraField: false, rejectNext: null as string | null,
    hold: null as null | { match: (url: URL, method: string) => boolean; gate: Promise<void>; entered: () => void },
    bump: () => { stateVersion = String(BigInt(stateVersion) + 1n); return stateVersion; } };
  const fact = (intent: ConjugationIntent, status: "applied" | "already_applied", r?: Result) => ({ id: intent.command_id, kind: intent.kind, status,
    applied_at: "2026-10-01T08:00:00Z", target_id: "assignment_id" in intent ? intent.assignment_id : (intent as { session_id: string }).session_id,
    action_id: r ? r.action_id : null, result_id: r ? r.result_id : null, context_id: null,
    object_version: r ? (intent.kind === "answer.submit" ? "1" : r.version) : null });
  const envelopeFor = (intent: ConjugationIntent) => {
    const s = sessions.get((intent as { session_id: string }).session_id)!;
    if (intent.kind === "answer.submit" || intent.kind === "result.grade" || intent.kind === "result.correct") {
      const r = s.results.find(x => x.assignment_id === intent.assignment_id)!;
      return { body: resultEnvelope(s, r), r };
    }
    return { body: { current: projection(s) }, r: undefined };
  };
  const answer = (s: Session, assignmentId: string, grade: 2 | 4) => {
    s.results.push({ result_id: id(31 + s.results.length), assignment_id: assignmentId, action_id: id(41 + s.results.length), version: "1", grade });
    const next = [B1, B2, B3][[B1, B2, B3].indexOf(assignmentId) + 1] ?? null;
    if (lastAnswer || !next) { s.status = "summary"; s.assignment = null; } else s.assignment = next;
    s.presented = false;
  };
  const apply = (intent: ConjugationIntent) => {
    const s = sessions.get((intent as { session_id: string }).session_id)!;
    if (intent.kind === "assignment.present") s.presented = true;
    if (intent.kind === "answer.submit") answer(s, intent.assignment_id, "text" in intent.payload && intent.payload.text === "kommst" ? 4 : 2);
    if (intent.kind === "result.grade" || intent.kind === "result.correct") {
      const r = s.results.find(x => x.result_id === intent.result_id)!;
      const grade = intent.kind === "result.correct" ? 4 : intent.payload.grade as 3 | 4 | 5;
      // core conjugation_commands.py: the same grade is accepted without a new version.
      if (r.grade === grade) return;
      r.version = String(BigInt(r.version) + 1n); r.grade = grade;
    }
    if (intent.kind === "session.stop") { s.status = "closed"; s.assignment = null; s.reason = intent.payload.reason; }
    server.bump();
  };
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input), "https://model.invalid"), method = init?.method ?? "GET";
    fetches.push(`${method} ${url.pathname}`);
    if (server.hold?.match(url, method)) { const hold = server.hold; server.hold = null; hold.entered(); await hold.gate; }
    if (method === "POST") {
      const command = JSON.parse(String(init!.body)) as ConjugationCommand; posted.push(command);
      if (server.failPost) throw new TypeError("synthetic network failure before server");
      const { client_instance_id: _c, document_id: _d, ...intent } = command;
      if (server.rejectNext && intent.kind === "answer.submit") {
        const code = server.rejectNext; server.rejectNext = null;
        const step = projection(sessions.get(intent.session_id)!);
        return response({ command: { id: intent.command_id, status: "rejected" }, action: null, result: null, step,
          capabilities: { ...step.capabilities }, error: { code }, state_version: stateVersion }, 409);
      }
      if (!accepted.has(intent.command_id)) { accepted.set(intent.command_id, intent); apply(intent); }
      const { body, r } = envelopeFor(intent);
      if (server.lostReply) throw new TypeError("synthetic lost reply after server commit");
      return response({ ...body, command: fact(intent, "applied", r), state_version: stateVersion });
    }
    gets.push(url.pathname + url.search);
    if (url.pathname.includes("/commands/")) {
      const commandId = url.pathname.split("/").at(-1)!, intent = accepted.get(commandId);
      if (!intent) return response({ command: { id: commandId, status: "not_found" }, current: profile(stateVersion), state_version: stateVersion });
      const hash = await conjugationIntentHash(intent);
      const { body, r } = envelopeFor(intent);
      return response({ ...body, command: fact(intent, "already_applied", r), verified_intent_hash: hash, state_version: stateVersion });
    }
    const sessionId = url.pathname.split("/").at(-1)!, s = sessions.get(sessionId)!;
    if (url.searchParams.has("result_id")) {
      const r = s.results.find(x => x.result_id === url.searchParams.get("result_id"))!;
      return response({ ...resultEnvelope(s, r), state_version: stateVersion });
    }
    const current = projection(s);
    return response({ current: server.extraField ? { ...current, block_error: true } : current, state_version: stateVersion });
  });
  const access = (generation: number, live = { value: true }): OpenedAccess => createOpenedAccess({ opened: { status: "opened",
    client_instance_id: id(1), document_id: id(2), document_epoch: "1", proof_version: "1", profile: profile(), session: null,
    compatibility: { compatible: true, contract_version: "1" } }, token: "synthetic-token", proof: "synthetic-proof", generation,
  isLive: () => live.value, onDenied: () => { live.value = false; } });
  const stores = { studyStore: new ConjugationSessionPendingStore(storage), stopStore: new ConjugationStopPendingStore(storage) };
  const transport = { fetcher, timeoutMs: 1000, maxResponseBytes: 200000 };
  const newId = vi.fn(() => id(counter++));
  const hold = (match: (url: URL, method: string) => boolean) => {
    const gate = deferred(), entered = deferred();
    server.hold = { match, gate: gate.promise, entered: () => entered.resolve() };
    return { release: () => gate.resolve(), entered: entered.promise };
  };
  const controller = (a: OpenedAccess, address: ConjugationAcceptedAddress | null = null, activity = { enabled: true, visible: true }) =>
    new ConjugationDocumentController({ access: a, transport, ...stores, initialSessionId: S1, initialResultAddress: address, newId,
      minimumStateVersion: () => null, terminalSessionIds: [], isLive: () => true, activity: () => activity, onUpdate: () => undefined });
  const answers = () => posted.filter(c => c.kind === "answer.submit");
  return { values, storage, sessions, server, posted, gets, fetches, fetcher, access, stores, transport, newId, hold, controller, answers };
}

/** The hook's actions object: stable, always dispatching to the current controller. */
function proxy(ref: { current: ConjugationDocumentController }): ConjugationDocumentActions {
  return { refresh: () => ref.current.refresh(), start: () => ref.current.start(), openStep: t => ref.current.openStep(t),
    openResult: () => ref.current.openResult(), shown: t => ref.current.shown(t), submit: (a, b) => ref.current.submit(a, b),
    grade: v => ref.current.grade(v), correct: () => ref.current.correct(), stop: r => ref.current.stop(r), retry: l => ref.current.retry(l) };
}
/** Host semantics of the flow without React: project + commit of the controller's current snapshot. */
function drive(ref: { current: ConjugationDocumentController }, access: OpenedAccess) {
  const timers: { delay: number; run: () => void; cancelled: boolean }[] = [];
  const schedule = (delay: 2000 | 3000, run: () => void) => { const t = { delay, run, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; };
  const onToday = vi.fn(), onChange = vi.fn();
  const flow = new ConjugationTestFlow({ actions: proxy(ref), schedule, onToday, onChange });
  let source = { tuple: "tuple-1", access };
  const input = (over: Partial<FlowInput> = {}): FlowInput => ({ source, state: ref.current.snapshot(), transitionMode: "normal", active: true, ...over });
  const show = (over: Partial<FlowInput> = {}) => { const value = input(over); const view = flow.project(value); flow.commit(value); return view; };
  /** Commit, let the controller react (automatic openStep/openResult, replies), commit again. */
  const settle = async (over: Partial<FlowInput> = {}) => { show(over); await macrotasks(); show(over); await macrotasks(); return show(over); };
  return { flow, timers, running: () => timers.filter(t => !t.cancelled), show, settle, onToday, onChange,
    setAccess: (a: OpenedAccess) => { source = { tuple: "tuple-1", access: a }; } };
}

describe("QA-1 command discipline through the real controller", () => {
  it("two quick submits (and a forget) without a commit in between send ONE answer with one command ID", async () => {
    const m = model(), ref = { current: m.controller(m.access(1)) };
    await ref.current.refresh();
    const d = drive(ref, m.access(1));
    expect(d.show()).toMatchObject({ screen: "question", canSubmit: false });
    d.flow.setDraft("kommst"); d.show();
    const before = m.newId.mock.calls.length;
    d.flow.submit(); d.flow.submit(); d.flow.forget();
    await macrotasks();
    expect(m.answers()).toHaveLength(1);
    expect(m.answers()[0].payload).toEqual({ text: "kommst" });
    expect(m.newId.mock.calls.length - before).toBe(1);
    expect(await d.settle()).toMatchObject({ screen: "result", mode: "answer" });
    d.flow.submit(); d.flow.forget(); await macrotasks();
    expect(m.answers()).toHaveLength(1);
  });

  it("Ф2: network failure before the server → the view's own check (GET of the same ID) → the manual retry resends the SAME ID and text", async () => {
    const m = model(), ref = { current: m.controller(m.access(1)) };
    await ref.current.refresh();
    const d = drive(ref, m.access(1));
    d.show(); d.flow.setDraft("kommst"); d.show();
    m.server.failPost = true;
    d.flow.submit(); await macrotasks();
    m.server.failPost = false;
    const unknown = d.show();
    expect(unknown).toMatchObject({ screen: "question", status: "unknown", editable: false, draft: "kommst", canSubmit: false,
      canCheck: true, canRetry: { study: false } });
    d.flow.submit(); d.flow.forget(); await macrotasks();
    expect(m.answers()).toHaveLength(1);
    d.flow.refresh(); await macrotasks();
    expect(m.gets.filter(g => g.includes(`/commands/${m.answers()[0].command_id}`))).toHaveLength(1);
    const verified = d.show();
    expect(verified).toMatchObject({ screen: "question", status: "unknown", canRetry: { study: true } });
    d.flow.retry("study"); await macrotasks();
    const [first, second] = m.answers();
    expect(second.command_id).toBe(first.command_id);
    expect(second.payload).toEqual(first.payload);
    expect(await d.settle()).toMatchObject({ screen: "result", mode: "answer" });
  });

  it("lost reply after the server commit: resolved by GET /commands/{same id}, never a second POST", async () => {
    const m = model(), ref = { current: m.controller(m.access(1)) };
    await ref.current.refresh();
    const d = drive(ref, m.access(1));
    d.show(); d.flow.setDraft("kommst"); d.show();
    m.server.lostReply = true;
    d.flow.submit(); await macrotasks();
    m.server.lostReply = false;
    expect(d.show()).toMatchObject({ screen: "question", status: "unknown", canCheck: true });
    d.flow.refresh();
    expect(await d.settle()).toMatchObject({ screen: "result", mode: "answer" });
    expect(m.answers()).toHaveLength(1);
    expect(m.gets.some(g => g.includes(`/commands/${m.answers()[0].command_id}`))).toBe(true);
  });
});

describe("QA-2 late answer and form change", () => {
  it("Ф1: a draft typed for B1 is never sent as the answer to B2 that the controller reached without a flow commit", async () => {
    const m = model(), ref = { current: m.controller(m.access(1)) };
    await ref.current.refresh();
    const d = drive(ref, m.access(1));
    d.show(); d.flow.setDraft("geh"); d.show();
    // Another window answered B1 and presented B2 on the server.
    const s = m.sessions.get(S1)!;
    s.results.push({ result_id: id(31), assignment_id: B1, action_id: id(41), version: "1", grade: 2 });
    s.assignment = B2; s.presented = true; m.server.bump();
    await ref.current.refresh(); await ref.current.refresh(); // two reads, no React commit in between
    d.flow.submit(); d.flow.forget(); await macrotasks();
    expect(m.posted).toEqual([]);
    // The next commit shows B2 empty: the old input is not carried over to the new form (CT табл. 2.2).
    expect(d.show()).toMatchObject({ screen: "question", question: { assignmentId: B2 }, draft: "" });
  });

  it("a late accepted answer after an accepted Stop never reopens a result or a question", async () => {
    const m = model(), ref = { current: m.controller(m.access(1)) };
    await ref.current.refresh();
    const d = drive(ref, m.access(1));
    d.show(); d.flow.setDraft("kommst"); d.show();
    const held = m.hold((_url, method) => method === "POST");
    d.flow.submit(); await held.entered;
    expect(d.show()).toMatchObject({ screen: "question", status: "submitting", canStop: true });
    d.flow.stop(); await macrotasks();
    expect(d.show()).toMatchObject({ screen: "closed" });
    held.release(); await macrotasks();
    const after = await d.settle();
    expect(after).toMatchObject({ screen: "closed" });
    // The model records a held POST when it is released, so only the set is compared.
    expect(m.posted.map(c => c.kind).sort()).toEqual(["answer.submit", "session.stop"]);
  });
});

describe("QA-6 guard of the unknown-answer view (Ф10, kills mutation 14)", () => {
  it("an unknown answer to B2 recovered from the durable slot is never shown under the remembered question B1", async () => {
    const m = model(), a1 = m.access(1), ref = { current: m.controller(a1) };
    await ref.current.refresh();
    const d = drive(ref, a1);
    d.show(); d.flow.setDraft("geh"); d.show();
    expect(d.show()).toMatchObject({ screen: "question", question: { assignmentId: B1 } });
    // Meanwhile B1 was answered and B2 presented; another owner of this client sent an answer to B2 that never
    // reached the server (the R-G1 send itself is refused since Ф1). Its intent stays in the shared slot.
    const s = m.sessions.get(S1)!;
    s.results.push({ result_id: id(31), assignment_id: B1, action_id: id(41), version: "1", grade: 2 });
    s.assignment = B2; s.presented = true; m.server.bump();
    const other = m.controller(m.access(2));
    await other.refresh();
    m.server.failPost = true;
    await other.submit({ text: "kommst" }, B2);
    m.server.failPost = false;
    other.dispose();
    expect(m.values.has(studyKey)).toBe(true);
    // The flow's host gets a new owner of the same tuple; it reconciles the retained intent by GET only.
    const a3 = m.access(3);
    d.setAccess(a3); d.show({ state: null });
    ref.current.dispose(); ref.current = m.controller(a3);
    await ref.current.refresh();
    const view = d.show();
    expect(ref.current.snapshot().commands.study.pendingIntent).toMatchObject({ kind: "answer.submit", assignment_id: B2 });
    expect(view.screen).toBe("recovery");
    expect(m.answers().map(a => (a as { assignment_id: string }).assignment_id)).toEqual([B2]);
  });
});

describe("QA-7 explicit grade advances after its confirmation (К05-047, TA:109)", () => {
  it("«Легко» (5) on an automatic 4: one grade command, then the next question", async () => {
    const m = model(), ref = { current: m.controller(m.access(1)) };
    await ref.current.refresh();
    const d = drive(ref, m.access(1));
    d.show(); d.flow.setDraft("kommst"); d.show(); d.flow.submit();
    expect(await d.settle()).toMatchObject({ screen: "result", grades: [3, 4, 5] });
    d.flow.grade(5);
    await d.settle();
    expect(await d.settle()).toMatchObject({ screen: "question" });
    expect(m.posted.filter(c => c.kind === "result.grade")).toHaveLength(1);
  });

  it("Ф7: «Нормально» (4) on an automatic 4 is accepted as a no-op without a new version and still goes on", async () => {
    const m = model(), ref = { current: m.controller(m.access(1)) };
    await ref.current.refresh();
    const d = drive(ref, m.access(1));
    d.show(); d.flow.setDraft("kommst"); d.show(); d.flow.submit();
    expect(await d.settle()).toMatchObject({ screen: "result", grades: [3, 4, 5], timer: { durationMs: 3000 } });
    d.flow.grade(4);
    await d.settle();
    expect(m.posted.filter(c => c.kind === "result.grade")).toHaveLength(1);
    expect(m.sessions.get(S1)!.results[0].version).toBe("1");
    expect(d.running()).toHaveLength(0); // the grade cancelled the timer for good
    expect(await d.settle()).toMatchObject({ screen: "question", question: { assignmentId: B2 } });
    expect(m.posted.filter(c => c.kind === "result.grade")).toHaveLength(1);
  });
});

/** Host as the connecting package would wire it: hook + flow + screen. */
function Host({ options, active = true, sink }: { options: ConjugationDocumentHookOptions; active?: boolean;
  sink: { flow?: ConjugationTestFlow; timers: number; disposed: number } }) {
  const { state, actions } = useConjugationDocument(options);
  const [, repaint] = useReducer((n: number) => n + 1, 0);
  const flow = useMemo(() => new ConjugationTestFlow({ actions, onToday: () => undefined, onChange: repaint,
    schedule: (_delay, _run) => { sink.timers++; return () => undefined; } }), [actions]);
  sink.flow = flow;
  useEffect(() => () => { sink.disposed++; flow.dispose(); }, [flow]);
  const input: FlowInput = { source: { tuple: "tuple-1", access: options.access }, state, transitionMode: "normal", active };
  const view = flow.project(input);
  useLayoutEffect(() => { flow.commit(input); });
  return <ConjugationTestScreen view={view} flow={flow} language="ru" submitOnEnter />;
}
function hostOptions(m: ReturnType<typeof model>, generation = 1): ConjugationDocumentHookOptions {
  return { access: m.access(generation), transport: m.transport, ...m.stores, initialSessionId: S1, newId: m.newId,
    minimumStateVersion: null, enabled: true };
}
async function typed(text: string) {
  const field = await screen.findByRole("textbox") as HTMLTextAreaElement;
  await waitFor(() => expect(field.readOnly).toBe(false));
  fireEvent.change(field, { target: { value: text } });
  return field;
}

describe("QA-4 hook + flow + screen", () => {
  it("double Enter and double click on «Проверить» send one answer", async () => {
    const m = model(), sink = { timers: 0, disposed: 0 };
    render(<Host options={hostOptions(m)} sink={sink} />);
    const field = await typed("kommst");
    await waitFor(() => expect(field.value).toBe("kommst"));
    const held = m.hold((_url, method) => method === "POST");
    fireEvent.keyDown(field, { key: "Enter" }); fireEvent.keyDown(field, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    await held.entered; held.release();
    await screen.findByRole("button", { name: "Далее" });
    expect(m.answers()).toHaveLength(1);
  });

  it("unmount while the answer POST is in flight: no further requests or updates; the intent survives for the next document", async () => {
    const m = model(), sink = { timers: 0, disposed: 0 };
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const view = render(<Host options={hostOptions(m)} sink={sink} />);
    await typed("kommst");
    const held = m.hold((_url, method) => method === "POST");
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    await held.entered;
    expect(m.values.has(studyKey)).toBe(true);
    view.unmount();
    expect(sink.disposed).toBe(1);
    const fetchesAtUnmount = m.fetches.length;
    held.release(); await macrotasks();
    expect(m.fetches.length).toBe(fetchesAtUnmount);
    expect(m.values.has(studyKey)).toBe(true); // reconciled by the next document, not lost
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
    // Next document of the same tuple: GET proof of the same ID, result shown, no second POST.
    const sink2 = { timers: 0, disposed: 0 };
    render(<Host options={hostOptions(m, 2)} sink={sink2} />);
    await screen.findByRole("button", { name: "Далее" });
    expect(m.answers()).toHaveLength(1);
    expect(m.gets.some(g => g.includes(`/commands/${m.answers()[0].command_id}`))).toBe(true);
    // OPEN QUESTION (owner): an answer sent, its confirmation lost, the app closed — the result first seen in the
    // next document runs the ordinary timer. Pinned as is, not decided here.
    expect(sink2.timers).toBe(1);
  });

  it("Ф2 (screen): an unknown answer offers «Проверить статус»; after the GET proof the retry sends the same command", async () => {
    const m = model(), sink = { timers: 0, disposed: 0 };
    render(<Host options={hostOptions(m)} sink={sink} />);
    await typed("kommst");
    m.server.failPost = true;
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    await screen.findByText(/Ответ ещё не подтверждён/);
    m.server.failPost = false;
    expect(screen.queryByRole("button", { name: "Повторить действие" })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Проверить статус" }));
    fireEvent.click(await screen.findByRole("button", { name: "Повторить действие" }));
    await screen.findByRole("button", { name: "Далее" });
    const [first, second] = m.answers();
    expect(second.command_id).toBe(first.command_id);
    expect(m.gets.some(g => g.includes(`/commands/${first.command_id}`))).toBe(true);
  });

  it("Ф4 (message): a projection with one extra field is refused as a whole and is not shown as «Нет связи с сервером.»", async () => {
    const m = model(), sink = { timers: 0, disposed: 0 };
    m.server.extraField = true;
    render(<Host options={hostOptions(m)} sink={sink} />);
    // The reply did arrive (HTTP 200): the general truthful text, as Learning shows for the same failure.
    await screen.findByText("Не удалось обновить занятие.");
    expect(screen.queryByText("Нет связи с сервером.")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(m.posted).toEqual([]);
  });

  it("background during the result through the real hook: no page turn while hidden, Next needed after return", async () => {
    const m = model(), sink = { timers: 0, disposed: 0 };
    const view = render(<Host options={hostOptions(m)} sink={sink} />);
    await typed("kommst");
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    await screen.findByRole("button", { name: "Далее" });
    const armed = sink.timers;
    expect(armed).toBe(1);
    act(() => { setVisibility("hidden"); document.dispatchEvent(new Event("visibilitychange")); });
    view.rerender(<Host options={hostOptions(m)} active={false} sink={sink} />); // fresh access as on return
    act(() => { setVisibility("visible"); });
    view.rerender(<Host options={hostOptions(m, 3)} sink={sink} />);
    await screen.findByRole("button", { name: "Далее" });
    await macrotasks();
    expect(sink.timers).toBe(armed);
  });
});

describe("QA-8 summary while «На Сегодня» is being sent", () => {
  it("Ф8: while the summary_home Stop is in flight the summary shows «Завершаем занятие…» and a disabled button", async () => {
    const m = model(undefined, true), sink = { timers: 0, disposed: 0 };
    render(<Host options={hostOptions(m)} sink={sink} />);
    await typed("kommst");
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    fireEvent.click(await screen.findByRole("button", { name: "Далее" }));
    const home = await screen.findByRole("button", { name: "На Сегодня" }) as HTMLButtonElement;
    await waitFor(() => expect(home.disabled).toBe(false));
    const held = m.hold((_url, method) => method === "POST");
    fireEvent.click(home);
    await held.entered;
    await screen.findByText("Завершаем занятие…");
    expect((screen.getByRole("button", { name: "На Сегодня" }) as HTMLButtonElement).disabled).toBe(true);
    held.release();
    await screen.findByText("Занятие завершено");
    expect(m.posted.filter(c => c.kind === "session.stop")).toHaveLength(1);
  });
});

describe("QA-9 a known refusal of the answer", () => {
  it("Ф9: ASSIGNMENT_STALE moves to the current question and its reason reaches the view; the typed text is not carried over", async () => {
    const m = model(), ref = { current: m.controller(m.access(1)) };
    await ref.current.refresh();
    const d = drive(ref, m.access(1));
    d.show(); d.flow.setDraft("kommst"); d.show();
    // Another window already answered B1; the server now presents B2 and refuses the old answer.
    const s = m.sessions.get(S1)!;
    s.results.push({ result_id: id(31), assignment_id: B1, action_id: id(41), version: "1", grade: 4 });
    s.assignment = B2; s.presented = true; m.server.bump();
    m.server.rejectNext = "ASSIGNMENT_STALE";
    d.flow.submit();
    const after = await d.settle();
    expect(ref.current.snapshot().commands.study).toMatchObject({ outcome: "rejected", rejectionCode: "ASSIGNMENT_STALE" });
    expect(after).toMatchObject({ screen: "question", problem: "ASSIGNMENT_STALE", draft: "", question: { assignmentId: B2 } });
  });

  it("Ф9 (screen): the refusal text of Learning/written is shown with the current question", async () => {
    const m = model(), sink = { timers: 0, disposed: 0 };
    render(<Host options={hostOptions(m)} sink={sink} />);
    await typed("kommst");
    const s = m.sessions.get(S1)!;
    s.results.push({ result_id: id(31), assignment_id: B1, action_id: id(41), version: "1", grade: 4 });
    s.assignment = B2; s.presented = true; m.server.bump();
    m.server.rejectNext = "ASSIGNMENT_STALE";
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    await screen.findByText("Задание изменилось. Обнови занятие.");
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
    expect(m.answers()).toHaveLength(1);
  });
});

describe("QA-3 background on the result (DC 2.19, К05-152) with the real controller", () => {
  async function toResult() {
    const m = model(), a1 = m.access(1), ref = { current: m.controller(a1) };
    await ref.current.refresh();
    const d = drive(ref, a1);
    d.show(); d.flow.setDraft("kommst"); d.show(); d.flow.submit();
    const result = await d.settle();
    expect(result).toMatchObject({ screen: "result", mode: "answer", timer: { durationMs: 3000 } });
    expect(d.running()).toHaveLength(1);
    return { m, ref, d, address: ref.current.snapshot().acceptedAddress! };
  }

  it("hook path (hidden owner → fresh access owner): after return the result waits for Next", async () => {
    const { m, ref, d, address } = await toResult();
    const armed = d.timers.length;
    ref.current.setActivity({ enabled: true, visible: false }); // what useConjugationDocument does on visibilitychange
    const hidden = d.show({ active: false });
    expect(d.running()).toHaveLength(0);
    expect(hidden.screen).toBe("stale");
    // Return: the host supplies a fresh access; the hook masks (state null) and builds a new controller with the retained address.
    const a2 = m.access(2);
    d.setAccess(a2); d.show({ state: null });
    ref.current.dispose(); ref.current = m.controller(a2, address);
    await ref.current.refresh();
    expect(await d.settle()).toMatchObject({ screen: "result", mode: "answer", canNext: true, timer: null });
    expect(d.timers.length - armed).toBe(0);
    d.flow.next(); await macrotasks();
    expect(d.show()).toMatchObject({ screen: "question" });
  });

  it("Ф12: snapshot-kept path (host keeps the result, active=false→true): no new timer, Next is needed", async () => {
    const { d } = await toResult();
    d.show({ active: false });
    expect(d.running()).toHaveLength(0);
    expect(d.show()).toMatchObject({ timer: null, canNext: true });
    expect(d.running()).toHaveLength(0);
    expect(d.timers).toHaveLength(1);
  });

  it("OPEN QUESTION Ф3 (owner): after a return, «Исправить ответ» arms a timer on the corrected version (Learning keeps waiting for Next); pinned as is", async () => {
    const m = model(), a1 = m.access(1), ref = { current: m.controller(a1) };
    await ref.current.refresh();
    const d = drive(ref, a1);
    d.show(); d.flow.setDraft("falsch"); d.show(); d.flow.submit();
    expect(await d.settle({ transitionMode: "accelerated" })).toMatchObject({ screen: "result", mode: "answer", canCorrect: true, timer: { durationMs: 2000 } });
    d.show({ transitionMode: "accelerated", active: false });
    expect(d.show({ transitionMode: "accelerated" })).toMatchObject({ timer: null });
    const before = d.timers.length;
    d.flow.correct();
    const corrected = await d.settle({ transitionMode: "accelerated" });
    expect(corrected).toMatchObject({ screen: "result", result: { grade: 4 }, timer: { durationMs: 2000 } });
    expect(d.timers.length - before).toBe(1);
  });

  it("without background, a correction arms a new timer on the corrected version (same as Learning continueView)", async () => {
    const m = model(), a1 = m.access(1), ref = { current: m.controller(a1) };
    await ref.current.refresh();
    const d = drive(ref, a1);
    d.show(); d.flow.setDraft("falsch"); d.show(); d.flow.submit();
    expect(await d.settle()).toMatchObject({ screen: "result", timer: null, canCorrect: true });
    d.flow.correct();
    expect(await d.settle()).toMatchObject({ screen: "result", result: { grade: 4 }, timer: { durationMs: 3000 } });
  });
});

// Not ported: QA-5 «К06-101 В блоке есть ошибка» (needs a new server field; left open by root).
describe("QA-5 timer details, summary and Today (К06-102, К06-103)", () => {
  it("a data refresh with the same result version keeps the running timer (no restart)", async () => {
    const m = model(), a1 = m.access(1), ref = { current: m.controller(a1) };
    await ref.current.refresh();
    const d = drive(ref, a1);
    d.show(); d.flow.setDraft("kommst"); d.show(); d.flow.submit();
    expect(await d.settle()).toMatchObject({ screen: "result", timer: { durationMs: 3000 } });
    const first = d.running()[0];
    await ref.current.refresh();
    await d.settle();
    expect(d.timers).toHaveLength(1);
    expect(first.cancelled).toBe(false);
  });

  it("a new access of the same tuple while visible ends the timer; the result then waits for Next", async () => {
    const m = model(), a1 = m.access(1), ref = { current: m.controller(a1) };
    await ref.current.refresh();
    const d = drive(ref, a1);
    d.show(); d.flow.setDraft("kommst"); d.show(); d.flow.submit();
    expect(await d.settle()).toMatchObject({ screen: "result", timer: { durationMs: 3000 } });
    const a2 = m.access(2), address = ref.current.snapshot().acceptedAddress!;
    d.setAccess(a2); d.show({ state: null });
    ref.current.dispose(); ref.current = m.controller(a2, address);
    await ref.current.refresh();
    expect(await d.settle()).toMatchObject({ screen: "result", mode: "answer", timer: null, canNext: true });
    expect(d.running()).toHaveLength(0);
  });

  it("last answer → Next → summary → «На Сегодня»: one summary_home Stop, then onToday once", async () => {
    const m = model(undefined, true), a1 = m.access(1), ref = { current: m.controller(a1) };
    await ref.current.refresh();
    const d = drive(ref, a1);
    d.show(); d.flow.setDraft("kommst"); d.show(); d.flow.submit();
    expect(await d.settle()).toMatchObject({ screen: "result", canNext: true });
    d.flow.next();
    expect(await d.settle()).toMatchObject({ screen: "summary", canHome: true });
    d.flow.home(); d.flow.home();
    expect(await d.settle()).toMatchObject({ screen: "closed", reason: "summary_home" });
    expect(m.posted.filter(c => c.kind === "session.stop").map(c => c.payload)).toEqual([{ reason: "summary_home" }]);
    expect(d.onToday).toHaveBeenCalledTimes(1);
  });

  it("К06-102: from the summary back to the last answer within the server's rights, corrected without a timer, Next back to the summary", async () => {
    const m = model(undefined, true), a1 = m.access(1), ref = { current: m.controller(a1) };
    await ref.current.refresh();
    const d = drive(ref, a1);
    d.show(); d.flow.setDraft("falsch"); d.show(); d.flow.submit();
    expect(await d.settle()).toMatchObject({ screen: "result", canCorrect: true, canNext: true });
    d.flow.next();
    const summary = await d.settle();
    expect(summary).toMatchObject({ screen: "summary", canPrevious: true, canHome: true });
    const timersAtSummary = d.timers.length;
    d.flow.previous();
    const back = await d.settle();
    expect(back).toMatchObject({ screen: "result", mode: "previous", timer: null, canCorrect: true, canNext: true, result: { grade: 2 } });
    d.flow.correct();
    const corrected = await d.settle();
    expect(corrected).toMatchObject({ screen: "result", mode: "previous", timer: null, result: { grade: 4, version: "2" }, canNext: true });
    expect(m.posted.filter(c => c.kind === "result.correct")).toHaveLength(1);
    expect(d.timers.length).toBe(timersAtSummary);
    expect(await d.settle()).toMatchObject({ screen: "result", mode: "previous" }); // waits for Next, no self-advance
    d.flow.next();
    expect(await d.settle()).toMatchObject({ screen: "summary", canHome: true, summary: { correct: 1, wrong: 0 } });
    expect(m.posted.filter(c => c.kind === "session.stop")).toEqual([]);
  });
});
