import { describe, expect, it } from "vitest";
import { validConjugationCurrent } from "../conjugation/conjugationProjection";
import { validOralCurrent } from "../oral/oralProjection";
import { validLearningSessionCurrent, validWrittenSessionCurrent } from "../study/sessionProjection";
import { validClosedSessionBoundary } from "./wireValidation";

// Every strict close_reason decoder accepts save_failed (R2a prepares the client before the core writes it)
// and still rejects an unknown value.
const sid = "cccccccc-dddd-4000-8000-000000000003";
const gid = "cccccccc-dddd-4000-8000-000000000004";
const progress = { total: 3, completed: 0, correct: 0, wrong: 0 };
const writtenSummary = { completed: 0, correct: 0, wrong: 0, ratio: null };

const closed = {
  written: (reason: unknown) => ({ session_id: sid, status: "closed", mode: "written", pair: "ru-de", direction: "l1-de",
    local_date: "2026-10-01", bucket: "words", close_reason: reason, progress, assignment: null, summary: writtenSummary }),
  learning: (reason: unknown) => ({ session_id: sid, status: "closed", mode: "learning", pair: "ru-de", local_date: "2026-10-01",
    close_reason: reason, group: { id: gid, status: "active", version: "1", preview_position: 2, total: 2 }, preview: null, assignment: null }),
  oral: (reason: unknown) => ({ session_id: sid, status: "closed", mode: "oral", pair: "ru-de", direction: "de-l1",
    local_date: "2026-10-01", bucket: "words", close_reason: reason, progress, assignment: null, summary: writtenSummary,
    practice: { pair: "ru-de", direction: "de-l1", local_date: "2026-10-01", time_zone: "UTC", count: 0 },
    capabilities: { reveal_target: null, grade_target: null, stop: false, summary_home: false } }),
  conjugation: (reason: unknown) => ({ session_id: sid, status: "closed", mode: "conjugation", pair: "ru-de", direction: "conjugation",
    local_date: "2026-10-01", close_reason: reason, progress, assignment: null,
    summary: { completed_cycle_ids: [], partial: [], results: [], completed: 0, correct: 0, wrong: 0, blocks: null },
    capabilities: { answer_target: null, correct_target: null, grades: null, undo_target: null, stop: false, summary_home: false } }),
};
const decoders: Array<[string, (value: unknown) => boolean, (reason: unknown) => unknown]> = [
  ["written projection", value => validWrittenSessionCurrent(value, sid), closed.written],
  ["learning projection", value => validLearningSessionCurrent(value, sid), closed.learning],
  ["oral projection", value => validOralCurrent(value, sid), closed.oral],
  ["conjugation projection", value => validConjugationCurrent(value, sid), closed.conjugation],
  ["closed session boundary", value => validClosedSessionBoundary(value, sid),
    reason => ({ session_id: sid, status: "closed", close_reason: reason })],
];

describe("close_reason decoding (save_failed)", () => {
  describe.each(decoders)("%s", (_name, decode, make) => {
    it.each(["stop", "summary_home", "remote_stop", "midnight", "pair_changed", "timezone_date_changed", "save_failed"])(
      "accepts %s", reason => { expect(decode(make(reason))).toBe(true); });
    it.each(["unknown", "", null, 7, ["save_failed"]])("rejects %j", reason => { expect(decode(make(reason))).toBe(false); });
  });
});
