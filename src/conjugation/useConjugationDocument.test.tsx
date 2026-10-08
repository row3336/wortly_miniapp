import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConjugationSessionProjection, OpenedClient } from "../api/generated";
import { createOpenedAccess, type OpenedAccess } from "../app/openedAccess";
import type { AsyncStorage } from "../platform/storage";
import { conjugationIntentHash, type ConjugationCommand, type ConjugationIntent } from "./conjugationIntent";
import { ConjugationSessionPendingStore, ConjugationStopPendingStore } from "./conjugationPending";
import type { ConjugationDocumentSnapshot } from "./conjugationDocumentController";
import { useConjugationDocument, type ConjugationDocumentHookOptions } from "./useConjugationDocument";

const id = (n: number) => `eeeeeeee-ffff-4000-8000-${String(n).padStart(12, "0")}`;
const S1 = id(3), S2 = id(4), B1 = id(21);
type Session = { id: string; status: "active" | "closed"; presented: boolean };

function projection(s: Session): ConjugationSessionProjection {
  const active = s.status === "active";
  return { session_id: s.id, status: s.status, mode: "conjugation", direction: "conjugation", pair: "ru-de", local_date: "2026-10-01",
    close_reason: active ? null : "stop", progress: { total: 1, completed: 0, correct: 0, wrong: 0 },
    assignment: active ? { id: B1, card_id: id(8), status: s.presented ? "presented" : "prefetched", kind: "conjugation", cycle_id: id(9),
      slot_id: { cycle_id: id(9), pronoun_group: "du" }, base_verb_id: id(8), display_verb_id: id(18), tense: "present", pronoun_group: "du",
      prompt: { verb: "kommen", translation: "приходить", language: "ru", pronoun: "du", tense: "present" },
      answer_spec: { kind: "forms", labels: ["du"], part_count: 1, case_sensitive: false } } : null,
    summary: active ? null : { completed_cycle_ids: [], partial: [], results: [], completed: 0, correct: 0, wrong: 0, blocks: [] },
    capabilities: { answer_target: active && s.presented ? B1 : null, correct_target: null, grades: null, undo_target: null,
      stop: active, summary_home: false } };
}
const profile = (state_version = "9007199254740990"): OpenedClient["profile"] => ({ profile_id: id(50), role: "user", ui_language: "ru",
  dictionary_language: "ru", time_zone: "UTC", state_version, access: { status: "admitted", version: "1", reason: null } });
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

/** Synthetic HTTP MODEL (session reads, status proofs, stop POST); not PG captures and not end-to-end. */
function server() {
  const sessions = new Map<string, Session>([[S1, { id: S1, status: "active", presented: true }], [S2, { id: S2, status: "active", presented: true }]]);
  const accepted = new Map<string, ConjugationIntent>(), posted: ConjugationCommand[] = [], gets: string[] = [];
  let stateVersion = "9007199254740991";
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input), "https://model.invalid");
    if (init?.method === "POST") {
      const command = JSON.parse(String(init.body)) as ConjugationCommand; posted.push(command);
      const { client_instance_id: _c, document_id: _d, ...intent } = command;
      if (intent.kind !== "session.stop") throw new Error("model supports stop only");
      accepted.set(intent.command_id, intent); sessions.get(intent.session_id)!.status = "closed";
      stateVersion = String(BigInt(stateVersion) + 1n);
      return response({ command: { id: intent.command_id, kind: intent.kind, status: "applied", applied_at: "2026-10-01T08:00:00Z",
        target_id: intent.session_id, action_id: null, result_id: null, context_id: null, object_version: null },
      current: projection(sessions.get(intent.session_id)!), state_version: stateVersion });
    }
    gets.push(url.pathname + url.search);
    if (url.pathname.includes("/commands/")) {
      const commandId = url.pathname.split("/").at(-1)!, intent = accepted.get(commandId);
      if (!intent) return response({ command: { id: commandId, status: "not_found" }, current: profile(stateVersion), state_version: stateVersion });
      const hash = await conjugationIntentHash(intent);
      return response({ command: { id: commandId, kind: intent.kind, status: "already_applied", applied_at: "2026-10-01T08:00:00Z",
        target_id: (intent as { session_id: string }).session_id, action_id: null, result_id: null, context_id: null, object_version: null },
      current: projection(sessions.get((intent as { session_id: string }).session_id)!), verified_intent_hash: hash, state_version: stateVersion });
    }
    return response({ current: projection(sessions.get(url.pathname.split("/").at(-1)!)!), state_version: stateVersion });
  });
  return { sessions, posted, gets, fetcher, get version() { return stateVersion; } };
}
function storage(): AsyncStorage {
  const values = new Map<string, string>();
  return { get: async k => values.get(k) ?? null, set: async (k, v) => { values.set(k, v); }, remove: async k => { values.delete(k); } };
}
function access(document = id(2), generation = 1, live = { value: true }): OpenedAccess {
  return createOpenedAccess({ opened: { status: "opened", client_instance_id: id(1), document_id: document, document_epoch: "1",
    proof_version: "1", profile: profile(), session: null, compatibility: { compatible: true, contract_version: "1" } },
  token: "synthetic-token", proof: "synthetic-proof", generation, isLive: () => live.value, onDenied: () => { live.value = false; } });
}
function options(model: ReturnType<typeof server>, extra: Partial<ConjugationDocumentHookOptions> = {}): ConjugationDocumentHookOptions {
  const shared = storage();
  let counter = 100;
  return { access: access(), transport: { fetcher: model.fetcher, timeoutMs: 1000, maxResponseBytes: 100000 },
    studyStore: new ConjugationSessionPendingStore(shared), stopStore: new ConjugationStopPendingStore(shared),
    initialSessionId: S1, newId: () => id(counter++), minimumStateVersion: null, enabled: true, ...extra };
}
const strict = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;
function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
}
afterEach(() => { cleanup(); setVisibility("visible"); });

describe("useConjugationDocument adapter", () => {
  it("StrictMode mount is GET-only and Stop is sent exactly once", async () => {
    const model = server();
    const { result } = renderHook(props => useConjugationDocument(props), { initialProps: options(model), wrapper: strict });
    await waitFor(() => expect(result.current.state?.phase).toBe("question"));
    expect(model.posted).toEqual([]);
    expect(result.current.state).toMatchObject({ canSubmit: true, canStop: true });
    await act(async () => { await Promise.all([result.current.actions.stop("stop"), result.current.actions.stop("stop")]); });
    expect(model.posted.map(c => c.kind)).toEqual(["session.stop"]);
    expect(result.current.state).toMatchObject({ phase: "closed", terminalSessionIds: [S1] });
  });
  it("keeps floor and terminal memory when only the source (access/transport/stores) is replaced in the same tuple", async () => {
    const model = server(), first = options(model);
    const { result, rerender } = renderHook(props => useConjugationDocument(props), { initialProps: first });
    await waitFor(() => expect(result.current.state?.phase).toBe("question"));
    await act(async () => { await result.current.actions.stop("stop"); });
    const floor = result.current.state!.stateVersion;
    expect(BigInt(floor)).toBeGreaterThan(9007199254740991n);
    const shared = storage();
    const replaced = { ...first, access: access(id(2), 2), transport: { ...first.transport },
      studyStore: new ConjugationSessionPendingStore(shared), stopStore: new ConjugationStopPendingStore(shared) };
    rerender(replaced);
    // Terminal memory shows closed at once; Start opens only after the new owner's GET recovery.
    await waitFor(() => expect(result.current.state?.phase).toBe("closed"));
    await waitFor(() => expect(result.current.state?.canStart).toBe(true));
    expect(result.current.state).toMatchObject({ terminalSessionIds: [S1], stateVersion: floor, canStart: true });
    expect(model.posted).toHaveLength(1);
  });
  it("a changed semantic tuple resets retained memory", async () => {
    const model = server(), first = options(model);
    const { result, rerender } = renderHook(props => useConjugationDocument(props), { initialProps: first });
    await waitFor(() => expect(result.current.state?.phase).toBe("question"));
    await act(async () => { await result.current.actions.stop("stop"); });
    rerender({ ...first, access: access(id(12)), initialSessionId: S2 });
    await waitFor(() => expect(result.current.state?.phase).toBe("question"));
    expect(result.current.state).toMatchObject({ sessionId: S2, terminalSessionIds: [] });
  });
  it("render masks a replaced seed/access before effects and never shows the old session", async () => {
    const model = server(), first = options(model), seen: (ConjugationDocumentSnapshot | null)[] = [];
    const { result, rerender } = renderHook(props => { const value = useConjugationDocument(props); seen.push(value.state); return value; },
      { initialProps: first });
    await waitFor(() => expect(result.current.state?.phase).toBe("question"));
    const before = seen.length;
    rerender({ ...first, initialSessionId: S2 });
    expect(seen[before]).toBeNull(); // render-phase value of the rerender, before effect cleanup/creation
    await waitFor(() => expect(result.current.state?.sessionId).toBe(S2));
    expect(seen.slice(before).every(state => state === null || state.sessionId === S2)).toBe(true);
  });
  it("a floor raised by props masks stale data during render, before the refresh effect", async () => {
    const model = server(), first = options(model), seen: (ConjugationDocumentSnapshot | null)[] = [];
    const { result, rerender } = renderHook(props => { const value = useConjugationDocument(props); seen.push(value.state); return value; },
      { initialProps: first });
    await waitFor(() => expect(result.current.state?.phase).toBe("question"));
    const before = seen.length, raised = "9007199254749999";
    rerender({ ...first, minimumStateVersion: raised });
    expect(seen[before]).toMatchObject({ phase: "stale", currentStep: null, canSubmit: false, stateVersion: raised });
    // The model never reaches the raised floor, so the view stays masked; the floor never drops.
    await act(async () => { await result.current.actions.refresh(); });
    rerender({ ...first, minimumStateVersion: null });
    await waitFor(() => expect(result.current.state?.phase).toBe("stale"));
    expect(result.current.state).toMatchObject({ phase: "stale", stateVersion: raised });
    expect(model.posted).toEqual([]);
  });
  it("disabled closes study and Stop alike (DESIGN §5); re-enabled sends the lawful Stop exactly once", async () => {
    const model = server(), first = options(model);
    const { result, rerender } = renderHook(props => useConjugationDocument(props), { initialProps: first });
    await waitFor(() => expect(result.current.state?.phase).toBe("question"));
    rerender({ ...first, enabled: false });
    expect(result.current.state).toMatchObject({ canSubmit: false, canStop: false, canSummaryHome: false, canRetry: { stop: false } });
    await act(async () => { await result.current.actions.stop("stop"); });
    expect(model.posted).toEqual([]);
    expect(result.current.state).toMatchObject({ phase: "question", terminalSessionIds: [] }); // disabling is not disposal
    rerender(first);
    await waitFor(() => expect(result.current.state?.canStop).toBe(true));
    await act(async () => { await Promise.all([result.current.actions.stop("stop"), result.current.actions.stop("stop")]); });
    expect(model.posted.map(c => [c.kind, c.payload])).toEqual([["session.stop", { reason: "stop" }]]);
    expect(result.current.state).toMatchObject({ phase: "closed", terminalSessionIds: [S1] });
  });
  it("hidden closes foreground until a fresh access owner", async () => {
    const model = server(), first = options(model);
    const { result, rerender } = renderHook(props => useConjugationDocument(props), { initialProps: first });
    await waitFor(() => expect(result.current.state?.canSubmit).toBe(true));
    act(() => { setVisibility("hidden"); document.dispatchEvent(new Event("visibilitychange")); });
    expect(result.current.state).toMatchObject({ canSubmit: false, canStop: false });
    act(() => { setVisibility("visible"); document.dispatchEvent(new Event("visibilitychange")); });
    await act(async () => { await result.current.actions.refresh(); });
    // Waiting for the window's foreground is loading, not a failed refresh (2.33).
    expect(result.current.state).toMatchObject({ canSubmit: false, canStop: false, phase: "loading", problem: null });
    await act(async () => { await result.current.actions.stop("stop"); });
    expect(model.posted).toEqual([]);
    rerender({ ...first, access: access(id(2), 2) });
    await waitFor(() => expect(result.current.state?.canSubmit).toBe(true));
  });
  it("pageshow also suspends the current owner", async () => {
    const model = server(), first = options(model);
    const { result } = renderHook(props => useConjugationDocument(props), { initialProps: first });
    await waitFor(() => expect(result.current.state?.canStop).toBe(true));
    act(() => { window.dispatchEvent(new Event("pageshow")); });
    expect(result.current.state).toMatchObject({ canStop: false, canSubmit: false });
  });
});

const B2 = id(22), R1 = id(31);
type Answered = { id: string; status: "active" | "closed"; assignment: string; presented: boolean;
  result: { result_id: string; assignment_id: string; action_id: string; version: string; grade: 2 | 4 } | null };
function answeredProjection(s: Answered): ConjugationSessionProjection {
  const done = s.result ? 1 : 0, correct = s.result && s.result.grade >= 3 ? 1 : 0, active = s.status === "active";
  const base = projection({ id: s.id, status: s.status, presented: s.presented });
  return { ...base, progress: { total: active ? done + 1 : done, completed: done, correct, wrong: done - correct },
    assignment: active && base.assignment ? { ...base.assignment, id: s.assignment } : null,
    summary: active ? null : { completed_cycle_ids: [], partial: [], results: s.result ? [{ result_id: s.result.result_id, version: s.result.version }] : [],
      completed: done, correct, wrong: done - correct, blocks: [] },
    capabilities: { ...base.capabilities, answer_target: active && s.presented ? s.assignment : null } };
}
function answeredEnvelope(s: Answered) {
  const r = s.result!, step = answeredProjection(s), live = s.status === "active";
  const target = { session_id: s.id, assignment_id: r.assignment_id, result_id: r.result_id, expected_result_version: r.version };
  return { action: { action_id: r.action_id, kind: "answer.submit", version: r.version, status: "active" },
    result: { result_id: r.result_id, assignment_id: r.assignment_id, version: r.version, grade: r.grade, correct: r.grade >= 3,
      status: "active", accepted_at: "2026-10-01T08:00:00Z", answer_date: "2026-10-01", detail: null },
    step, capabilities: { ...step.capabilities, grades: live && r.grade >= 3 ? { ...target, values: [3, 4, 5] } : null,
      correct_target: live && r.grade === 2 ? target : null } };
}
/** Synthetic HTTP MODEL for C3 (start, answer, stop, session/result reads, status proofs); not PG and not end-to-end. */
function answerServer() {
  const sessions = new Map<string, Answered>([[S1, { id: S1, status: "active", assignment: B1, presented: true, result: null }],
    [S2, { id: S2, status: "active", assignment: B1, presented: true, result: null }]]);
  const accepted = new Map<string, ConjugationIntent>(), posted: ConjugationCommand[] = [], gets: string[] = [];
  let stateVersion = "9007199254740991";
  const fact = (intent: ConjugationIntent, status: string) => {
    const s = sessions.get((intent as { session_id: string }).session_id)!, r = intent.kind === "answer.submit" ? s.result : null;
    return { id: intent.command_id, kind: intent.kind, status, applied_at: "2026-10-01T08:00:00Z",
      target_id: "assignment_id" in intent ? intent.assignment_id : (intent as { session_id: string }).session_id,
      action_id: r?.action_id ?? null, result_id: r?.result_id ?? null, context_id: null, object_version: r ? "1" : null };
  };
  const body = (intent: ConjugationIntent) => {
    const s = sessions.get((intent as { session_id: string }).session_id)!;
    return intent.kind === "answer.submit" ? answeredEnvelope(s) : { current: answeredProjection(s) };
  };
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input), "https://model.invalid");
    if (init?.method === "POST") {
      const command = JSON.parse(String(init.body)) as ConjugationCommand; posted.push(command);
      const { client_instance_id: _c, document_id: _d, ...intent } = command;
      const sessionId = (intent as { session_id: string }).session_id;
      if (intent.kind === "session.start") sessions.set(sessionId, { id: sessionId, status: "active", assignment: B1, presented: false, result: null });
      const s = sessions.get(sessionId)!;
      if (intent.kind === "answer.submit") {
        s.result = { result_id: R1, assignment_id: intent.assignment_id, action_id: id(41), version: "1", grade: 4 };
        s.assignment = B2; s.presented = false;
      } else if (intent.kind === "session.stop") s.status = "closed";
      else if (intent.kind !== "session.start") throw new Error("model: unsupported command");
      accepted.set(intent.command_id, intent);
      stateVersion = String(BigInt(stateVersion) + 1n);
      return response({ ...body(intent), command: fact(intent, "applied"), state_version: stateVersion });
    }
    gets.push(url.pathname + url.search);
    if (url.pathname.includes("/commands/")) {
      const commandId = url.pathname.split("/").at(-1)!, intent = accepted.get(commandId);
      if (!intent) return response({ command: { id: commandId, status: "not_found" }, current: profile(stateVersion), state_version: stateVersion });
      return response({ ...body(intent), command: fact(intent, "already_applied"), verified_intent_hash: await conjugationIntentHash(intent),
        state_version: stateVersion });
    }
    const s = sessions.get(url.pathname.split("/").at(-1)!)!;
    if (url.searchParams.has("result_id")) return response({ ...answeredEnvelope(s), state_version: stateVersion });
    return response({ current: answeredProjection(s), state_version: stateVersion });
  });
  return { sessions, posted, gets, fetcher, resultGets: () => gets.filter(g => g.includes(`result_id=${R1}`)).length };
}
function tupleAccess(change: { epoch?: string; language?: "ru" | "uk"; generation?: number; live?: { value: boolean } } = {}): OpenedAccess {
  const live = change.live ?? { value: true };
  return createOpenedAccess({ opened: { status: "opened", client_instance_id: id(1), document_id: id(2), document_epoch: change.epoch ?? "1",
    proof_version: "1", profile: { ...profile(), dictionary_language: change.language ?? "ru" }, session: null,
    compatibility: { compatible: true, contract_version: "1" } },
  token: "synthetic-token", proof: "synthetic-proof", generation: change.generation ?? 1, isLive: () => live.value, onDenied: () => { live.value = false; } });
}
async function acceptedA(model: ReturnType<typeof answerServer>) {
  const first = { ...options(model as unknown as ReturnType<typeof server>), access: tupleAccess() };
  const view = renderHook(props => useConjugationDocument(props), { initialProps: first });
  await waitFor(() => expect(view.result.current.state?.canSubmit).toBe(true));
  await act(async () => { await view.result.current.actions.submit({ text: "kommst" }, B1); });
  expect(view.result.current.state).toMatchObject({ phase: "result", acceptedAddress: { session_id: S1, assignment_id: B1, result_id: R1 } });
  return { ...view, first };
}

describe("C3: the hook retains A's address within one tuple, as identity only", () => {
  it("H1: a new access of the same tuple and seed hands the address to the new controller, which re-reads A", async () => {
    const model = answerServer(), { result, rerender, first } = await acceptedA(model);
    const before = model.resultGets();
    rerender({ ...first, access: tupleAccess({ generation: 2 }) });
    await waitFor(() => expect(result.current.state?.resultA?.address.result_id).toBe(R1));
    expect(model.resultGets()).toBeGreaterThan(before);
    expect(result.current.state).toMatchObject({ acceptedAddress: { session_id: S1, assignment_id: B1, result_id: R1 }, allowedGrades: [3, 4, 5] });
    expect(model.posted.map(c => c.kind)).toEqual(["answer.submit"]);
  });
  it("H2: null states, a disposed controller and a disabled gap do not erase the retained address", async () => {
    const model = answerServer(), { result, rerender, first } = await acceptedA(model);
    const seen: (ConjugationDocumentSnapshot | null)[] = [];
    rerender({ ...first, enabled: false });
    rerender({ ...first, enabled: false, access: tupleAccess({ generation: 2, live: { value: false } }) }); // no controller: state null
    seen.push(result.current.state);
    rerender({ ...first, enabled: false, access: tupleAccess({ generation: 3, live: { value: false } }) });
    seen.push(result.current.state);
    expect(seen).toEqual([null, null]);
    const before = model.resultGets();
    rerender({ ...first, access: tupleAccess({ generation: 4 }) });
    await waitFor(() => expect(result.current.state?.resultA?.address.result_id).toBe(R1));
    expect(model.resultGets()).toBeGreaterThan(before);
    expect(model.posted.map(c => c.kind)).toEqual(["answer.submit"]);
  });
  it("H3: a new Start (another session) removes the address; returning to the old seed does not revive it", async () => {
    const model = answerServer(), { result, rerender, first } = await acceptedA(model);
    rerender({ ...first, access: tupleAccess({ generation: 2 }), initialSessionId: null });
    await waitFor(() => expect(result.current.state?.canStart).toBe(true));
    await act(async () => { await result.current.actions.start(); });
    expect(result.current.state?.sessionId).not.toBe(S1);
    const before = model.resultGets();
    rerender({ ...first, access: tupleAccess({ generation: 3 }) });
    await waitFor(() => expect(result.current.state?.phase).toBe("prefetched"));
    expect(result.current.state).toMatchObject({ sessionId: S1, acceptedAddress: null, resultA: null });
    expect(model.resultGets()).toBe(before);
  });
  it("H4: a changed epoch or dictionary language does not carry the address over", async () => {
    for (const change of [{ epoch: "2" }, { language: "uk" as const }]) {
      const model = answerServer(), { result, rerender, first } = await acceptedA(model);
      const before = model.resultGets();
      rerender({ ...first, access: tupleAccess({ ...change, generation: 2 }) });
      await waitFor(() => expect(result.current.state?.sessionId).toBe(S1));
      await act(async () => { await result.current.actions.refresh(); });
      expect(result.current.state).toMatchObject({ acceptedAddress: null, resultA: null });
      expect(model.resultGets()).toBe(before);
      cleanup();
    }
  });
  it("H5: a confirmed terminal of S removes the address; the next controller seeded with S never reads A", async () => {
    const model = answerServer(), { result, rerender, first } = await acceptedA(model);
    await act(async () => { await result.current.actions.stop("stop"); });
    expect(result.current.state).toMatchObject({ phase: "closed", acceptedAddress: null, closed: { sessionId: S1, reason: "stop" } });
    const before = model.resultGets();
    rerender({ ...first, access: tupleAccess({ generation: 2 }) });
    await waitFor(() => expect(result.current.state?.phase).toBe("closed"));
    await act(async () => { await result.current.actions.refresh(); });
    expect(result.current.state).toMatchObject({ acceptedAddress: null, resultA: null, closed: { sessionId: S1, reason: "stop" } });
    expect(model.resultGets()).toBe(before);
    expect(model.posted.map(c => c.kind)).toEqual(["answer.submit", "session.stop"]);
  });
});
