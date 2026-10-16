// Q27 (C458/C467) at the level of its decoders: what proves the outcome of a command whose content payload is gone.
// lostMissingProblem — only the final closure of ITS OWN session proves «never applies»; validLostAnswerFact — a lost
// grade is taken only as a fact of the very result it graded.
import { describe, expect, it } from "vitest";
import type { Profile } from "../api/generated";
import { lostCommand, lostMissingProblem, type LostAddress } from "./lostEnvelope";
import { PendingStoreError, type LostEnvelope } from "./pendingSlot";
import { validLostAnswerFact } from "../learning/learningAnswerApi";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PROFILE = id(50), CLIENT = id(1), COMMAND = id(10), SESSION = id(20), ASSIGNMENT = id(30), RESULT = id(40), ACTION = id(41);

function lost(kind: "answer.submit" | "result.grade" = "answer.submit") {
  const intent = { command_id: COMMAND, kind, session_id: SESSION, assignment_id: ASSIGNMENT, payload: {},
    ...(kind === "result.grade" ? { result_id: RESULT, expected_result_version: "1" } : {}) };
  const record = { schemaVersion: 1, profileId: PROFILE, clientInstanceId: CLIENT, pair: "ru-de", intent };
  return lostCommand(new PendingStoreError("lost_envelope", { profileId: PROFILE, commandId: COMMAND, kind, record } as LostEnvelope), PROFILE);
}
const profile = (over: Partial<Profile> = {}): Profile => ({ profile_id: PROFILE, role: "user", ui_language: "ru",
  dictionary_language: "ru", time_zone: "UTC", state_version: "2", access: { status: "admitted", version: "1", reason: null }, ...over });
const own = { profileId: PROFILE, clientInstanceId: CLIENT, pair: "ru-de" };
const closure = (sessionId: string) => ({ session_id: sessionId, status: "closed", close_reason: "stop" }) as never;

describe("lostMissingProblem: a not_found of the lost command's ID", () => {
  it("with the final closure of its own session proves that it never applies", () => {
    expect(lostMissingProblem({ outcome: "not_found", state_version: "2", current: profile(), closed_session: closure(SESSION) }, lost(), own))
      .toBe("not_applied");
  });
  it("with the closure of another session proves nothing about it (the step changed)", () => {
    expect(lostMissingProblem({ outcome: "not_found", state_version: "2", current: profile(), closed_session: closure(id(21)) }, lost(), own))
      .toBe("step_changed");
  });
  it("without a closure leaves it to the read of its session; another profile or a lost admission come first", () => {
    expect(lostMissingProblem({ outcome: "not_found", state_version: "2", current: profile() }, lost(), own)).toBeNull();
    expect(lostMissingProblem({ outcome: "not_found", state_version: "2", current: profile({ profile_id: id(60) }),
      closed_session: closure(SESSION) }, lost(), own)).toBe("profile_changed");
    expect(lostMissingProblem({ outcome: "not_found", state_version: "2",
      current: profile({ access: { status: "pending", version: "2", reason: null } }) }, lost(), own)).toBe("forbidden");
  });
});

describe("validLostAnswerFact: a lost grade is the fact of the result it graded", () => {
  const address: LostAddress = { command_id: COMMAND, kind: "result.grade", session_id: SESSION, assignment_id: ASSIGNMENT,
    result_id: RESULT, expected_result_version: "1", client_instance_id: CLIENT, document_id: id(2) };
  const fact = (resultId: string) => ({ id: COMMAND, kind: "result.grade", status: "already_applied", applied_at: "2026-10-16T10:00:00Z",
    target_id: ASSIGNMENT, action_id: ACTION, result_id: resultId, context_id: null, object_version: "2" });
  const shown = (resultId: string) => ({ action: { action_id: ACTION, status: "active" }, step: { status: "active" },
    result: { result_id: resultId, version: "2", grade: 5, status: "active", detail: null } });
  it("the graded result itself: accepted", () => {
    expect(validLostAnswerFact(fact(RESULT), address, shown(RESULT))).toBe(true);
  });
  it("another result, even the one its reply shows: never taken as this grade", () => {
    expect(validLostAnswerFact(fact(id(42)), address, shown(id(42)))).toBe(false);
  });
});
