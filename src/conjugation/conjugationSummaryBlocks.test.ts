import { describe, expect, it } from "vitest";
import type { ConjugationSessionProjection, ConjugationSummaryBlock } from "../api/generated";
import { validConjugationCurrent } from "./conjugationProjection";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SID = id(3), DONE = id(9), OPEN = id(19);
const all = ["du", "er_sie_es", "ich", "ihr", "sie_sie", "wir"] as ConjugationSummaryBlock["answered_groups"];

function block(over: Partial<ConjugationSummaryBlock> = {}): ConjugationSummaryBlock {
  return { cycle_id: DONE, base_verb_id: id(8), base_lemma: "kommen", tense: "present", answered_groups: all, effect: "error", grade: 2, ...over };
}

/** One completed cycle with an error and one partial cycle (du, ich) whose wrong second form is an error. */
function projection(status: "summary" | "closed" = "summary"): ConjugationSessionProjection {
  const closed = status === "closed";
  return { session_id: SID, status, mode: "conjugation", pair: "ru-de", direction: "conjugation", local_date: "2026-10-01",
    close_reason: closed ? "stop" : null, progress: { total: 3, completed: 3, correct: 1, wrong: 2 }, assignment: null,
    summary: { completed_cycle_ids: [DONE], partial: [{ cycle_id: OPEN, answered_groups: ["du", "ich"] }],
      results: [5, 6, 7].map(n => ({ result_id: id(n), version: "1" })), completed: 3, correct: 1, wrong: 2,
      blocks: [block(), block({ cycle_id: OPEN, base_verb_id: id(18), base_lemma: "gehen", tense: "preterite", answered_groups: ["du", "ich"] })] },
    capabilities: { answer_target: null, correct_target: null, grades: null, undo_target: null, stop: !closed, summary_home: !closed } };
}

type Mutable = { summary: Record<string, unknown> & { blocks: Array<Record<string, unknown>> | null } };
const valid = (value: unknown) => validConjugationCurrent(value, SID);
const changed = (change: (s: Mutable) => void, status: "summary" | "closed" = "summary") => {
  const value = projection(status); change(value as unknown as Mutable); return valid(value);
};

describe("conjugation summary blocks decoder", () => {
  it("accepts the summary phase, a frozen closed list and set-equal groups in any order", () => {
    expect(valid(projection())).toBe(true);
    expect(valid(projection("closed"))).toBe(true);
    expect(changed(s => { s.summary.blocks!.reverse(); s.summary.blocks![0].answered_groups = ["ich", "du"]; })).toBe(true);
    expect(changed(s => { s.summary.blocks![0].cycle_id = DONE.toUpperCase(); })).toBe(true);
  });

  it("accepts success with the minimum grade, incomplete without grade and an empty list without cycles", () => {
    expect(changed(s => { s.summary.blocks![0] = { ...block(), effect: "success", grade: 3 }; })).toBe(true);
    expect(changed(s => { s.summary.blocks![1] = { ...s.summary.blocks![1], effect: "incomplete", grade: null }; })).toBe(true);
    expect(changed(s => { s.summary.completed_cycle_ids = []; s.summary.partial = []; s.summary.blocks = []; })).toBe(true);
  });

  it("accepts null only for closed legacy and NULL summaries", () => {
    expect(changed(s => { s.summary.blocks = null; }, "closed")).toBe(true);
    const zero = projection("closed");
    zero.progress = { total: 0, completed: 0, correct: 0, wrong: 0 };
    zero.summary = { completed_cycle_ids: [], partial: [], results: [], completed: 0, correct: 0, wrong: 0, blocks: null };
    expect(valid(zero)).toBe(true);
    expect(changed(s => { s.summary.blocks = null; })).toBe(false);
  });

  it("keeps active summary null", () => {
    const active: ConjugationSessionProjection = { ...projection(), status: "active", close_reason: null,
      progress: { total: 3, completed: 1, correct: 1, wrong: 0 }, summary: null,
      assignment: { id: id(5), card_id: id(8), status: "presented", kind: "conjugation", cycle_id: DONE,
        slot_id: { cycle_id: DONE, pronoun_group: "du" }, base_verb_id: id(8), display_verb_id: id(18), tense: "present", pronoun_group: "du",
        prompt: { verb: "ankommen", translation: "прибывать", language: "ru", pronoun: "du", tense: "present" },
        answer_spec: { kind: "forms", labels: ["du"], part_count: 1, case_sensitive: false } },
      capabilities: { answer_target: id(5), correct_target: null, grades: null, undo_target: null, stop: true, summary_home: false } };
    expect(valid(active)).toBe(true);
    expect(valid({ ...active, summary: projection().summary })).toBe(false);
  });

  it("requires the blocks key and an array of exact block records", () => {
    expect(changed(s => { delete (s.summary as Record<string, unknown>).blocks; })).toBe(false);
    expect(changed(s => { delete (s.summary as Record<string, unknown>).blocks; }, "closed")).toBe(false);
    expect(changed(s => { (s.summary as Record<string, unknown>).blocks = {}; })).toBe(false);
    expect(changed(s => { s.summary.blocks![0] = "block" as unknown as Record<string, unknown>; })).toBe(false);
    expect(changed(s => { s.summary.blocks![0].lemma = "kommen"; })).toBe(false);
    expect(changed(s => { delete s.summary.blocks![0].tense; })).toBe(false);
  });

  const violations: Array<[string, (s: Mutable) => void]> = [
    ["bad cycle id", s => { s.summary.blocks![0].cycle_id = "cycle-9"; }],
    ["bad base verb id", s => { s.summary.blocks![0].base_verb_id = 8; }],
    ["duplicate cycle id", s => { s.summary.blocks![1] = { ...s.summary.blocks![0] }; }],
    ["duplicate cycle id by case", s => { s.summary.blocks!.push({ ...s.summary.blocks![0], cycle_id: DONE.toUpperCase() }); }],
    ["foreign cycle id", s => { s.summary.blocks![1].cycle_id = id(29); }],
    ["missing block", s => { s.summary.blocks!.pop(); }],
    ["extra block for a known cycle set", s => { s.summary.blocks!.push(block({ cycle_id: id(29) })); }],
    ["empty base lemma", s => { s.summary.blocks![0].base_lemma = ""; }],
    ["non-string base lemma", s => { s.summary.blocks![0].base_lemma = null; }],
    ["bad tense", s => { s.summary.blocks![0].tense = "perfect"; }],
    ["bad effect", s => { s.summary.blocks![0].effect = "partial"; }],
    ["unknown group", s => { s.summary.blocks![1].answered_groups = ["du", "Ich"]; }],
    ["duplicate group", s => { s.summary.blocks![1].answered_groups = ["du", "du"]; }],
    ["completed block with five groups", s => { s.summary.blocks![0].answered_groups = all.slice(1); }],
    ["partial block with other groups", s => { s.summary.blocks![1].answered_groups = ["du", "wir"]; }],
    ["partial block with more groups", s => { s.summary.blocks![1].answered_groups = ["du", "ich", "wir"]; }],
    ["success with grade 2", s => { s.summary.blocks![0].effect = "success"; }],
    ["success without grade", s => { Object.assign(s.summary.blocks![0], { effect: "success", grade: null }); }],
    ["success out of range", s => { Object.assign(s.summary.blocks![0], { effect: "success", grade: 6 }); }],
    ["success on a partial block", s => { Object.assign(s.summary.blocks![1], { effect: "success", grade: 4 }); }],
    ["error with grade 3", s => { s.summary.blocks![0].grade = 3; }],
    ["error without grade", s => { s.summary.blocks![1].grade = null; }],
    ["error with no answered group", s => {
      s.summary.partial = [{ cycle_id: OPEN, answered_groups: [] }]; s.summary.blocks![1].answered_groups = [];
    }],
    ["incomplete with grade", s => { Object.assign(s.summary.blocks![1], { effect: "incomplete", grade: 3 }); }],
    ["incomplete with six groups", s => { Object.assign(s.summary.blocks![0], { effect: "incomplete", grade: null }); }],
  ];
  for (const [name, change] of violations) {
    it(`rejects ${name} in summary and closed phases`, () => {
      expect(changed(change)).toBe(false);
      expect(changed(change, "closed")).toBe(false);
    });
  }
});

/** A closed legacy summary skips block checks, so each case below can only fail on its own pre-P1 rule. */
describe("pre-P1 summary invariants without block masking", () => {
  const legacy = (change: (s: Mutable) => void = () => {}) => changed(s => { s.summary.blocks = null; change(s); }, "closed");

  it("accepts the unchanged closed legacy base", () => {
    expect(legacy()).toBe(true);
  });

  const partialRules: Array<[string, (s: Mutable) => void]> = [
    ["a partial cycle that is also completed", s => { s.summary.partial = [{ cycle_id: DONE, answered_groups: ["du", "ich"] }]; }],
    ["a duplicate partial group", s => { s.summary.partial = [{ cycle_id: OPEN, answered_groups: ["ich", "ich"] }]; }],
    ["a partial with six groups", s => { s.summary.partial = [{ cycle_id: OPEN, answered_groups: all }]; }],
    ["an unknown partial group", s => { s.summary.partial = [{ cycle_id: OPEN, answered_groups: ["du", "Ich"] }]; }],
  ];
  for (const [name, change] of partialRules) {
    it(`rejects ${name}`, () => {
      expect(legacy(change)).toBe(false);
    });
  }

  it("rejects a duplicated completed cycle while blocks still map one to one", () => {
    expect(changed(s => { s.summary.completed_cycle_ids = [DONE, DONE]; })).toBe(false);
    expect(changed(s => { s.summary.completed_cycle_ids = [DONE, DONE.toUpperCase()]; })).toBe(false);
  });
});
