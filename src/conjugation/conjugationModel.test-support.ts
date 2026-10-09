// Synthetic HTTP model of the conjugation part of the server for host and App tests (not PG, not end-to-end).
// Same shapes as the model of conjugationIntegration.test.tsx, plus session.start, a refused start and closures the
// client did not choose. It answers only conjugation commands, their status checks and session reads.
import { vi } from "vitest";
import type { ClosedSessionBoundary, ConjugationSessionProjection } from "../api/generated";
import { conjugationIntentHash, type ConjugationCommand, type ConjugationIntent } from "./conjugationIntent";

export const conjugationId = (n: number) => `abababab-cdcd-4000-8000-${String(n).padStart(12, "0")}`;
/** The forms every new session asks in order; the last answer leads to the summary. */
export const FORMS = [conjugationId(21), conjugationId(22)] as const;
export type CloseReason = ClosedSessionBoundary["close_reason"];
type Result = { result_id: string; assignment_id: string; action_id: string; version: string; grade: 2 | 3 | 4 | 5 };
export type ModelSession = { id: string; status: "active" | "summary" | "closed"; assignment: string | null; presented: boolean;
  results: Result[]; reason?: CloseReason };

const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

export function conjugationProjection(s: ModelSession): ConjugationSessionProjection {
  const done = s.results.length, correct = s.results.filter(r => r.grade >= 3).length;
  const total = s.status === "active" ? done + 1 : done;
  const summary = s.status === "active" ? null : { completed_cycle_ids: [], partial: [{ cycle_id: conjugationId(9), answered_groups: ["du"] }],
    results: s.results.map(r => ({ result_id: r.result_id, version: r.version })), completed: done, correct, wrong: done - correct,
    blocks: [{ cycle_id: conjugationId(9), base_verb_id: conjugationId(8), base_lemma: "kommen", tense: "present", answered_groups: ["du"],
      effect: "incomplete", grade: null }] } as ConjugationSessionProjection["summary"];
  const assignment = s.status === "active" && s.assignment ? { id: s.assignment, card_id: conjugationId(8),
    status: s.presented ? "presented" : "prefetched", kind: "conjugation", cycle_id: conjugationId(9),
    slot_id: { cycle_id: conjugationId(9), pronoun_group: "du" }, base_verb_id: conjugationId(8), display_verb_id: conjugationId(18),
    tense: "present", pronoun_group: "du", prompt: { verb: "kommen", translation: "приходить", language: "ru", pronoun: "du", tense: "present" },
    answer_spec: { kind: "forms", labels: ["du"], part_count: 1, case_sensitive: false } } as ConjugationSessionProjection["assignment"] : null;
  return { session_id: s.id, status: s.status, mode: "conjugation", direction: "conjugation", pair: "ru-de", local_date: "2026-10-01",
    close_reason: s.status === "closed" ? s.reason ?? "stop" : null, progress: { total, completed: done, correct, wrong: done - correct },
    assignment, summary, capabilities: { answer_target: assignment && s.presented ? s.assignment : null, correct_target: null, grades: null,
      undo_target: null, stop: s.status !== "closed", summary_home: s.status === "summary" } };
}
function resultEnvelope(s: ModelSession, r: Result) {
  const step = conjugationProjection(s), live = s.status !== "closed";
  const target = { session_id: s.id, assignment_id: r.assignment_id, result_id: r.result_id, expected_result_version: r.version };
  return { action: { action_id: r.action_id, kind: "answer.submit", version: r.version, status: "active" },
    result: { result_id: r.result_id, assignment_id: r.assignment_id, version: r.version, grade: r.grade, correct: r.grade >= 3,
      status: "active", accepted_at: "2026-10-01T08:00:00Z", answer_date: "2026-10-01", detail: null },
    step, capabilities: { ...step.capabilities, grades: live && r.grade >= 3 ? { ...target, values: [3, 4, 5] } : null,
      correct_target: live && r.grade === 2 ? target : null, undo_target: null } };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

/** "kommst" is the right form; any other text or «Забыл» is wrong. */
export function conjugationServer(options: { sessions?: ModelSession[]; version?: string; profileId?: string } = {}) {
  const sessions = new Map((options.sessions ?? []).map(s => [s.id, structuredClone(s)]));
  const accepted = new Map<string, ConjugationIntent>();
  let stateVersion = options.version ?? "10", counter = 100;
  const posted: ConjugationCommand[] = [];
  const server = {
    /** The next session.start is refused with this code (core conjugation_sessions.py: NO_MATERIAL, SETUP_REQUIRED, …). */
    rejectStart: null as string | null,
    hold: null as null | { match: (url: URL, method: string) => boolean; gate: Promise<void>; entered: () => void },
  };
  const bump = () => { stateVersion = String(BigInt(stateVersion) + 1n); return stateVersion; };
  const fact = (intent: ConjugationIntent, status: "applied" | "already_applied", r?: Result) => ({ id: intent.command_id, kind: intent.kind,
    status, applied_at: "2026-10-01T08:00:00Z", target_id: "assignment_id" in intent ? intent.assignment_id : (intent as { session_id: string }).session_id,
    action_id: r ? r.action_id : null, result_id: r ? r.result_id : null, context_id: null,
    object_version: r ? (intent.kind === "answer.submit" ? "1" : r.version) : null });
  const resultCommand = (intent: ConjugationIntent) => intent.kind === "answer.submit" || intent.kind === "result.grade"
    || intent.kind === "result.correct" || intent.kind === "result.undo";
  const envelopeFor = (intent: ConjugationIntent) => {
    const s = sessions.get((intent as { session_id: string }).session_id)!;
    if (resultCommand(intent)) {
      const r = s.results.find(x => x.assignment_id === (intent as { assignment_id: string }).assignment_id)!;
      return { body: resultEnvelope(s, r), r };
    }
    return { body: { current: conjugationProjection(s) }, r: undefined };
  };
  const apply = (intent: ConjugationIntent) => {
    if (intent.kind === "session.start") {
      sessions.set(intent.session_id, { id: intent.session_id, status: "active", assignment: FORMS[0], presented: false, results: [] });
      bump(); return;
    }
    const s = sessions.get((intent as { session_id: string }).session_id)!;
    if (intent.kind === "assignment.present") s.presented = true;
    if (intent.kind === "answer.submit") {
      const grade = "text" in intent.payload && intent.payload.text === "kommst" ? 4 : 2;
      s.results.push({ result_id: conjugationId(31 + s.results.length), assignment_id: intent.assignment_id,
        action_id: conjugationId(41 + s.results.length), version: "1", grade });
      const next = FORMS[FORMS.indexOf(intent.assignment_id as typeof FORMS[number]) + 1] ?? null;
      if (next) s.assignment = next; else { s.status = "summary"; s.assignment = null; }
      s.presented = false;
    }
    if (intent.kind === "result.grade" || intent.kind === "result.correct") {
      const r = s.results.find(x => x.result_id === intent.result_id)!;
      const grade = intent.kind === "result.correct" ? 4 : intent.payload.grade as 3 | 4 | 5;
      if (r.grade === grade) return;
      r.version = String(BigInt(r.version) + 1n); r.grade = grade;
    }
    if (intent.kind === "session.stop") { s.status = "closed"; s.assignment = null; s.reason = intent.payload.reason; }
    bump();
  };
  const refuse = (intent: ConjugationIntent, code: string) => {
    const s = "session_id" in intent ? sessions.get(intent.session_id) : undefined;
    const base = { command: { id: intent.command_id, status: "rejected" }, error: { code }, state_version: stateVersion };
    if (resultCommand(intent) && s) {
      const step = conjugationProjection(s);
      return response({ ...base, action: null, result: null, step, capabilities: { ...step.capabilities } }, 409);
    }
    const sessionId = (intent as { session_id: string }).session_id;
    return response({ ...base, current: s ? conjugationProjection(s) : { session_id: sessionId, status: "unavailable" } }, 409);
  };
  /** The conjugation endpoints of the server, or null for any other request. */
  const handle = async (input: string | URL | Request, init?: RequestInit): Promise<Response | null> => {
    const url = new URL(String(input), "https://model.invalid"), method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    const commandPost = method === "POST" && url.pathname.endsWith("/commands") && typeof body?.kind === "string"
      && ["session.start", "session.stop", "assignment.present", "answer.submit", "result.grade", "result.correct", "result.undo"].includes(body.kind)
      && (body.kind !== "session.start" || (body.payload as { mode?: string })?.mode === "conjugation");
    const statusGet = method === "GET" && url.pathname.includes("/commands/");
    const sessionGet = method === "GET" && url.pathname.includes("/sessions/");
    if (!commandPost && !statusGet && !sessionGet) return null;
    if (server.hold?.match(url, method)) { const hold = server.hold; server.hold = null; hold.entered(); await hold.gate; }
    if (commandPost) {
      const command = body as unknown as ConjugationCommand; posted.push(command);
      const { client_instance_id: _c, document_id: _d, ...intent } = command;
      if (!accepted.has(intent.command_id)) {
        if (intent.kind === "session.start" && server.rejectStart) {
          const code = server.rejectStart; server.rejectStart = null;
          return refuse(intent, code);
        }
        // core: a command of a closed session is refused with its closure.
        if (intent.kind !== "session.start" && "session_id" in intent && sessions.get(intent.session_id)?.status === "closed") {
          return refuse(intent, "SESSION_CLOSED");
        }
        accepted.set(intent.command_id, intent); apply(intent);
      }
      const { body: reply, r } = envelopeFor(intent);
      return response({ ...reply, command: fact(intent, "applied", r), state_version: stateVersion });
    }
    if (statusGet) {
      const commandId = url.pathname.split("/").at(-1)!, intent = accepted.get(commandId);
      if (!intent) return response({ command: { id: commandId, status: "not_found" }, current: { profile_id: options.profileId ?? conjugationId(50), role: "user",
        ui_language: "ru", dictionary_language: "ru", time_zone: "UTC", state_version: stateVersion,
        access: { status: "admitted", version: "1", reason: null } }, state_version: stateVersion });
      const { body: reply, r } = envelopeFor(intent);
      return response({ ...reply, command: fact(intent, "already_applied", r), verified_intent_hash: await conjugationIntentHash(intent),
        state_version: stateVersion });
    }
    const sessionId = url.pathname.split("/").at(-1)!, s = sessions.get(sessionId);
    if (!s) return response({ current: { session_id: sessionId, status: "not_found" }, state_version: stateVersion });
    if (url.searchParams.has("result_id")) {
      const r = s.results.find(x => x.result_id === url.searchParams.get("result_id"))!;
      return response({ ...resultEnvelope(s, r), state_version: stateVersion });
    }
    return response({ current: conjugationProjection(s), state_version: stateVersion });
  };
  /** Holds the next matching request until released; `entered` resolves once it reached the server. */
  const hold = (match: (url: URL, method: string) => boolean) => {
    const gate = deferred(), entered = deferred();
    server.hold = { match, gate: gate.promise, entered: () => entered.resolve() };
    return { release: () => gate.resolve(), entered: entered.promise };
  };
  return { sessions, server, posted, handle, hold, newId: vi.fn(() => conjugationId(counter++)),
    version: () => stateVersion, bump,
    kinds: () => posted.map(post => post.kind),
    /** A closure not chosen by this client: midnight, a changed date or pair, a Stop from another device. */
    close(sessionId: string, reason: CloseReason) {
      const s = sessions.get(sessionId)!; s.status = "closed"; s.assignment = null; s.reason = reason; bump();
    } };
}
export type ConjugationServer = ReturnType<typeof conjugationServer>;
