// The retry check of a grade or a correction with an unknown outcome (M-REFAC-CMD): only the same live right.
import { describe, expect, it } from "vitest";
import { revisionRetryProblem, type RevisionIntent, type RevisionRead } from "./resultRevision";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const target = { session_id: id(3), assignment_id: id(6), result_id: id(7), expected_result_version: "2" };
const correct: RevisionIntent = { ...target, kind: "result.correct", payload: {} };
const grade = (value: number): RevisionIntent => ({ ...target, kind: "result.grade", payload: { grade: value } });
function read(change: (value: RevisionRead) => void = () => {}, wrong = true): RevisionRead {
  const value: RevisionRead = { step: { status: "active", session_id: id(3), pair: "ru-de" },
    result: { result_id: id(7), assignment_id: id(6), version: "2", status: "active" }, action: { version: "2", status: "active" },
    capabilities: { correct_target: wrong ? { ...target } : null, grades: wrong ? null : { ...target, values: [3, 4, 5] } } };
  change(value);
  return value;
}

describe("revision retry check", () => {
  it("offers a retry only while the server grants this exact right", () => {
    expect(revisionRetryProblem(correct, read(), "ru-de", false)).toBe("not_found");
    expect(revisionRetryProblem(grade(5), read(() => {}, false), "ru-de", false)).toBe("not_found");
    expect(revisionRetryProblem(grade(5), read(), "ru-de", false)).toBe("step_changed");
    expect(revisionRetryProblem(correct, read(() => {}, false), "ru-de", false)).toBe("step_changed");
    expect(revisionRetryProblem(grade(2), read(() => {}, false), "ru-de", false)).toBe("step_changed");
  });
  it("names the step that no longer belongs to this session and pair", () => {
    expect(revisionRetryProblem(correct, read(value => { value.step = { status: "unavailable" }; }), "ru-de", false)).toBe("forbidden");
    expect(revisionRetryProblem(correct, read(value => { value.step = { status: "active", session_id: id(4), pair: "ru-de" }; }), "ru-de", false)).toBe("step_changed");
    expect(revisionRetryProblem(correct, read(value => { value.step = { status: "closed", session_id: id(3), pair: "ru-de" }; }), "ru-de", false)).toBe("closed");
    expect(revisionRetryProblem(correct, read(value => { value.step = { status: "not_found", session_id: id(3) }; }), "ru-de", false)).toBe("step_changed");
    expect(revisionRetryProblem(correct, read(value => { value.step = { status: "unavailable", session_id: id(3) }; }), "ru-de", false)).toBe("forbidden");
    expect(revisionRetryProblem(correct, read(), "uk-de", false)).toBe("pair_changed");
  });
  it("refuses another version, result or target address", () => {
    expect(revisionRetryProblem(correct, read(value => { value.result!.version = "3"; }), "ru-de", false)).toBe("step_changed");
    expect(revisionRetryProblem(correct, read(value => { value.result = null; }), "ru-de", false)).toBe("step_changed");
    expect(revisionRetryProblem(correct, read(value => { value.action!.status = "undone"; }), "ru-de", false)).toBe("step_changed");
    expect(revisionRetryProblem(correct, read(value => { value.capabilities.correct_target!.result_id = id(8); }), "ru-de", false)).toBe("step_changed");
    expect(revisionRetryProblem(correct, read(value => { value.capabilities.correct_target!.expected_result_version = "1"; }), "ru-de", false)).toBe("step_changed");
  });
  it("compares the action version only where the mode always did (Learning)", () => {
    const older = read(value => { value.action!.version = "1"; });
    expect(revisionRetryProblem(correct, older, "ru-de", false)).toBe("not_found");
    expect(revisionRetryProblem(correct, older, "ru-de", true)).toBe("step_changed");
  });
});
