import { vi } from "vitest";
import { hashInPlace } from "../commands/recoveryTime.test-support";
import type { LearningSessionProjection, OpenedClient, Profile } from "../api/generated";
import { createOpenedAccess, type OpenedAccess } from "../app/openedAccess";
import type { AsyncStorage } from "../platform/storage";
import type { LearningCommandIntent } from "./learningCommandIntent";
import type { LearningTransition } from "./learningCommandController";
import { LearningDocumentCommands, type LearningDocumentSnapshot } from "./learningDocumentCommands";
import { testGate } from "../commands/testGate.test-support";
import { seedRaw } from "../commands/pendingSeed.test-support";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const primaryKey = "wortly.pending.learning_session", stopKey = "wortly.pending.learning_stop";
const profile = (version = "1"): Profile => ({ profile_id: id(50), role: "user", ui_language: "ru", dictionary_language: "ru",
  time_zone: "UTC", state_version: version, access: { status: "admitted", version: "1", reason: null } });
function current(sessionId = id(3)): LearningSessionProjection {
  return { session_id: sessionId, mode: "learning", status: "active", pair: "ru-de", local_date: "2026-09-30", close_reason: null,
    group: { id: id(10), status: "active", version: "1", preview_position: 1, total: 1 }, preview: null,
    assignment: { id: id(6), card_id: id(11), kind: "learning", status: "presented", prompt: { text: "дом", language: "ru",
      translations: ["дом"], personal_translation_version: null, conjunction_hint: null },
      answer_spec: { kind: "word", labels: ["word"], part_count: 1, case_sensitive: true } } };
}
/** The current step with its question issued but not yet shown: the only state that lets a present be retried. */
function prefetched(): LearningSessionProjection {
  const step = current();
  return { ...step, assignment: { ...step.assignment!, status: "prefetched" } };
}
/** The mark that the question was shown; it recovers automatically (owner answer Q25.1 of 08.10.2026). */
const present: LearningTransition = { kind: "assignment.present", session_id: id(3), assignment_id: id(6), payload: {} };
const closed = (): LearningSessionProjection => ({ ...current(), status: "closed", close_reason: "stop", assignment: null });
const action = (kind: "answer.submit" | "result.correct" | "result.grade" = "answer.submit"): LearningTransition => kind === "answer.submit"
  ? { kind, session_id: id(3), assignment_id: id(6), payload: { text: "Haus" } }
  : { kind, session_id: id(3), assignment_id: id(6), result_id: id(7), expected_result_version: "1",
    payload: kind === "result.grade" ? { grade: 5 } : {} } as LearningTransition;
const stop: LearningTransition = { kind: "session.stop", session_id: id(3), payload: { reason: "stop" } };
const original = (transition = action(), n = 100): LearningCommandIntent => ({ ...transition, command_id: id(n) });
const pending = (intent = original()) => ({ schemaVersion: 1, profileId: id(50), clientInstanceId: id(1), pair: "ru-de", intent });
function fact(command: LearningCommandIntent, result = false, status = "applied") {
  return { id: command.command_id, kind: command.kind, status, applied_at: "2026-09-30T12:00:00Z",
    target_id: "assignment_id" in command ? command.assignment_id : "preview_id" in command ? command.preview_id : command.session_id,
    action_id: result ? id(8) : null, result_id: result ? id(7) : null, context_id: null,
    object_version: result ? command.kind === "answer.submit" ? "1" : "2" : "preview_id" in command ? "2" : null };
}
function resultRead(version = "1", grade = 2, stateVersion = "3", step: LearningSessionProjection = current()) {
  const target = { session_id: id(3), assignment_id: id(6), result_id: id(7), expected_result_version: version };
  const open = step.status !== "closed";
  return { state_version: stateVersion, step, action: { action_id: id(8), kind: "answer.submit", version, status: "active" },
    result: { result_id: id(7), assignment_id: id(6), version, status: "active", grade, correct: grade >= 3,
      accepted_at: "2026-09-30T12:00:00Z", answer_date: "2026-09-30", detail: null },
    capabilities: { answer_target: open ? id(6) : null, grades: open && grade >= 3 ? { ...target, values: [3, 4, 5] } : null,
      correct_target: open && grade === 2 ? target : null, undo_target: null, stop: open, summary_home: false } };
}
function accepted(command: LearningCommandIntent, stateVersion = "4", step = current(command.session_id), status = "applied") {
  if (command.kind === "answer.submit" || command.kind === "result.correct" || command.kind === "result.grade") {
    const grade = command.kind === "result.grade" ? command.payload.grade as number : 4;
    return { ...resultRead(command.kind === "answer.submit" ? "1" : "2", grade, stateVersion, step), command: fact(command, true, status) };
  }
  return { current: step, state_version: stateVersion, command: fact(command, false, status) };
}
const missing = (command: LearningCommandIntent, version = "3", isClosed = false) => ({
  state_version: version, current: profile(version), command: { id: command.command_id, status: "not_found" },
  ...(isClosed ? { closed_session: { session_id: command.session_id, status: "closed", close_reason: "stop" } } : {}),
});
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture(saved: Partial<Record<"primary" | "stop", LearningCommandIntent>> = {}, minimumStateVersion?: () => string | null) {
  hashInPlace();
  const values = new Map<string, string>([["unrelated", "keep"]]);
  if (saved.primary) seedRaw(values, primaryKey, JSON.stringify(pending(saved.primary)), id(50));
  if (saved.stop) seedRaw(values, stopKey, JSON.stringify(pending(saved.stop)), id(50));
  const storage: AsyncStorage = { get: vi.fn(async key => values.get(key) ?? null),
    set: vi.fn(async (key, value) => { values.set(key, value); }), remove: vi.fn(async key => { values.delete(key); }) };
  let access: OpenedAccess, live = true, next = 100;
  const onDenied = vi.fn(() => { live = false; });
  const replace = (patch: Partial<OpenedClient> = {}, token = "synthetic-token") => {
    const opened: OpenedClient = { status: "opened", client_instance_id: id(1), document_id: id(2), document_epoch: "1", proof_version: "1",
      profile: profile(), session: { id: id(3), phase: "active" }, compatibility: { compatible: true, contract_version: "1" }, ...patch };
    const handle: OpenedAccess = createOpenedAccess({ opened, token, proof: "synthetic-proof", generation: 1,
      isLive: () => live && access === handle, onDenied });
    access = handle;
  };
  replace();
  const fetcher = vi.fn<typeof fetch>(async (_url, options) => {
    if (options?.method !== "POST") throw new Error("unexpected GET");
    const command = JSON.parse(String(options.body));
    const step = command.kind === "session.stop" ? closed() : current(command.session_id);
    return response(accepted(command, command.kind === "session.stop" ? "10" : "4", step));
  });
  const onUpdate = vi.fn<(snapshot: LearningDocumentSnapshot) => void>(), newId = vi.fn(() => id(next++));
  const make = () => new LearningDocumentCommands({ access: () => access, storage,
    transport: { fetcher, timeoutMs: 1000, maxResponseBytes: 100000, gate: testGate() }, newId, onUpdate, minimumStateVersion });
  return { values, storage, access: () => access, replace, fetcher, onDenied, onUpdate, newId, make, owner: make(), revoke: () => { live = false; } };
}

export { id, primaryKey, stopKey, profile, current, prefetched, closed, action, present, stop, original, pending, fact, resultRead, accepted, missing, response, deferred, fixture };
