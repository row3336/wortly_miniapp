import type { ConjugationCatalog, ConjugationResultReadResponse, ConjugationSessionProjection, UnavailableSession } from "../api/generated";
import { count, date, eventTime, exactKeys, oneOf, record, sameId, uuid, version } from "../api/wireValidation";
import { validWrittenAnswerDetail } from "../learning/learningAnswerApi";

const pairs = ["ru-de", "uk-de", "en-de"];
const tenses = ["present", "preterite"];
const pronouns: Readonly<Record<string, string>> = {
  ich: "ich", du: "du", er_sie_es: "er/sie/es", wir: "wir", ihr: "ihr", sie_sie: "sie/Sie",
};
const groups = Object.keys(pronouns);
const closeReasons = ["midnight", "pair_changed", "timezone_date_changed", "stop", "remote_stop", "summary_home"];
function uniqueIds(values: unknown): values is string[] {
  return Array.isArray(values) && values.every(uuid) && new Set(values.map(id => id.toLowerCase())).size === values.length;
}

export function validConjugationCatalog(value: unknown): value is ConjugationCatalog {
  if (!record(value) || !exactKeys(value, ["pair", "local_date", "items"])
    || !oneOf(value.pair, pairs) || !date(value.local_date) || !Array.isArray(value.items)) return false;
  const seen = new Set<string>();
  return value.items.every(item => {
    if (!record(item) || !exactKeys(item, ["base_verb_id", "lemma", "tense", "status", "due_date", "can_schedule"])
      || !uuid(item.base_verb_id) || typeof item.lemma !== "string" || !oneOf(item.tense, tenses)
      || !oneOf(item.status, ["openable", "scheduled", "ready", "completed"])
      || !(item.due_date === null || date(item.due_date)) || item.can_schedule !== (item.status === "openable")) return false;
    const key = `${item.base_verb_id.toLowerCase()}/${item.tense}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

function assignment(value: unknown, pair: string): boolean {
  if (!record(value) || !exactKeys(value, ["id", "card_id", "status", "kind", "cycle_id", "slot_id",
    "base_verb_id", "display_verb_id", "tense", "pronoun_group", "prompt", "answer_spec"])
    || !uuid(value.id) || !uuid(value.card_id) || !uuid(value.cycle_id) || !uuid(value.base_verb_id)
    || !sameId(value.card_id, value.base_verb_id) || !uuid(value.display_verb_id) || value.kind !== "conjugation"
    || !oneOf(value.status, ["prefetched", "presented"]) || !oneOf(value.tense, tenses)
    || !oneOf(value.pronoun_group, groups) || !record(value.slot_id) || !record(value.prompt) || !record(value.answer_spec)) return false;
  const slot = value.slot_id, prompt = value.prompt, spec = value.answer_spec;
  return exactKeys(slot, ["cycle_id", "pronoun_group"]) && sameId(slot.cycle_id, value.cycle_id)
    && slot.pronoun_group === value.pronoun_group
    && exactKeys(prompt, ["verb", "translation", "language", "pronoun", "tense"])
    && typeof prompt.verb === "string" && typeof prompt.translation === "string"
    && prompt.pronoun === pronouns[value.pronoun_group as string]
    && prompt.language === pair.split("-")[0] && prompt.tense === value.tense
    && exactKeys(spec, ["kind", "labels", "part_count", "case_sensitive"]) && spec.kind === "forms"
    && Array.isArray(spec.labels) && spec.labels.length === 1 && spec.labels[0] === prompt.pronoun
    && spec.part_count === 1 && typeof spec.case_sensitive === "boolean";
}

/** Null means a closed summary frozen before blocks existed; otherwise exactly one block per summary cycle. */
function validSummaryBlocks(value: unknown, closed: boolean, cycles: Set<string>, partialGroups: Map<string, unknown[]>): boolean {
  if (value === null) return closed;
  if (!Array.isArray(value) || value.length !== cycles.size) return false;
  const seen = new Set<string>();
  return value.every(block => {
    if (!record(block) || !exactKeys(block, ["cycle_id", "base_verb_id", "base_lemma", "tense", "answered_groups", "effect", "grade"])
      || !uuid(block.cycle_id) || !uuid(block.base_verb_id) || typeof block.base_lemma !== "string" || block.base_lemma === ""
      || !oneOf(block.tense, tenses) || !oneOf(block.effect, ["incomplete", "error", "success"])
      || !Array.isArray(block.answered_groups) || !block.answered_groups.every(group => oneOf(group, groups))
      || new Set(block.answered_groups).size !== block.answered_groups.length) return false;
    const id = block.cycle_id.toLowerCase(), answered = block.answered_groups, partial = partialGroups.get(id);
    if (seen.has(id) || !cycles.has(id)) return false;
    seen.add(id);
    // Groups are compared as a set: the server keeps its SQL order.
    if (partial === undefined ? answered.length !== 6
      : answered.length !== partial.length || !answered.every(group => partial.includes(group))) return false;
    if (block.effect === "success") return answered.length === 6 && [3, 4, 5].includes(block.grade as number);
    if (block.effect === "error") return answered.length > 0 && block.grade === 2;
    return answered.length < 6 && block.grade === null;
  });
}

/** Session counts refer to this fixed form queue, while block groups may include earlier sessions. */
export function validConjugationCurrent(value: unknown, sessionId: string): value is ConjugationSessionProjection | UnavailableSession {
  if (!record(value) || !sameId(value.session_id, sessionId)) return false;
  if (oneOf(value.status, ["unavailable", "not_found"])) return exactKeys(value, ["session_id", "status"]);
  if (!exactKeys(value, ["session_id", "status", "mode", "pair", "direction", "local_date", "close_reason",
    "progress", "assignment", "summary", "capabilities"])
    || value.mode !== "conjugation" || value.direction !== "conjugation" || !oneOf(value.pair, pairs)
    || !oneOf(value.status, ["active", "summary", "closed"]) || !date(value.local_date)
    || !record(value.progress) || !record(value.capabilities)) return false;
  const progress = value.progress, caps = value.capabilities;
  if (!exactKeys(progress, ["total", "completed", "correct", "wrong"])
    || !count(progress.total) || !count(progress.completed) || !count(progress.correct) || !count(progress.wrong)
    || progress.completed > progress.total || progress.correct + progress.wrong !== progress.completed
    || !exactKeys(caps, ["answer_target", "correct_target", "grades", "undo_target", "stop", "summary_home"])
    || caps.correct_target !== null || caps.grades !== null || caps.undo_target !== null
    || caps.stop !== (value.status !== "closed") || caps.summary_home !== (value.status === "summary")) return false;
  if (value.status === "active") {
    if (value.close_reason !== null || value.summary !== null || progress.completed >= progress.total
      || !assignment(value.assignment, value.pair as string) || !record(value.assignment)) return false;
    return value.assignment.status === "presented" ? sameId(caps.answer_target, value.assignment.id as string) : caps.answer_target === null;
  }
  if (value.assignment !== null || caps.answer_target !== null
    || (value.status === "closed" ? !oneOf(value.close_reason, closeReasons) : value.close_reason !== null)
    || value.status === "summary" && progress.completed !== progress.total
    || !record(value.summary) || !exactKeys(value.summary, ["completed_cycle_ids", "partial", "results", "completed", "correct", "wrong", "blocks"])) return false;
  const summary = value.summary;
  if (summary.completed !== progress.completed || summary.correct !== progress.correct || summary.wrong !== progress.wrong
    || !uniqueIds(summary.completed_cycle_ids) || !Array.isArray(summary.partial) || !Array.isArray(summary.results)
    || summary.results.length !== progress.completed) return false;
  const cycles = new Set(summary.completed_cycle_ids.map(id => id.toLowerCase()));
  const partialGroups = new Map<string, unknown[]>();
  if (!summary.partial.every(block => {
    if (!record(block) || !exactKeys(block, ["cycle_id", "answered_groups"]) || !uuid(block.cycle_id)
      || cycles.has(block.cycle_id.toLowerCase()) || !Array.isArray(block.answered_groups)
      || block.answered_groups.length > 5 || !block.answered_groups.every(group => oneOf(group, groups))
      || new Set(block.answered_groups).size !== block.answered_groups.length) return false;
    cycles.add(block.cycle_id.toLowerCase()); partialGroups.set(block.cycle_id.toLowerCase(), block.answered_groups); return true;
  })) return false;
  if (!validSummaryBlocks(summary.blocks, value.status === "closed", cycles, partialGroups)) return false;
  const results = new Set<string>();
  return summary.results.every(result => {
    if (!record(result) || !exactKeys(result, ["result_id", "version"]) || !uuid(result.result_id)
      || !version(result.version) || results.has(result.result_id.toLowerCase())) return false;
    results.add(result.result_id.toLowerCase()); return true;
  });
}

export type ConjugationResultCurrent = Pick<ConjugationResultReadResponse, "action" | "result" | "step" | "capabilities">;

export function conjugationResultCurrent(value: Record<string, unknown>, address: {
  session_id: string; assignment_id: string; result_id?: string;
}): ConjugationResultCurrent | null {
  const { step, action, result, capabilities: caps } = value;
  if (!(validConjugationCurrent(step, address.session_id)
    || record(step) && exactKeys(step, ["status"]) && step.status === "unavailable") || !record(step) || !record(caps)) return null;
  const unavailable = oneOf(step.status, ["unavailable", "not_found"]);
  if ((action === null) !== (result === null)) return null;
  if (action !== null && result !== null) {
    if (unavailable || !record(action) || !record(result)
      || !exactKeys(action, ["action_id", "kind", "version", "status"]) || !uuid(action.action_id)
      || action.kind !== "answer.submit" || !version(action.version) || !oneOf(action.status, ["active", "undone"])
      || !exactKeys(result, ["result_id", "assignment_id", "version", "grade", "correct", "status", "accepted_at", "answer_date", "detail"])
      || !uuid(result.result_id) || !sameId(result.assignment_id, address.assignment_id)
      || address.result_id !== undefined && !sameId(result.result_id, address.result_id)
      || !version(result.version) || result.version !== action.version || result.status !== action.status
      || ![2, 3, 4, 5].includes(result.grade as number) || result.correct !== ((result.grade as number) >= 3)
      || !eventTime(result.accepted_at) || !date(result.answer_date)
      || result.detail !== null && !validWrittenAnswerDetail(result.detail)
      || step.status === "closed" && result.detail !== null) return null;
    if (result.status === "active" && "summary" in step && record(step.summary) && Array.isArray(step.summary.results)
      && !step.summary.results.some(ref => record(ref) && sameId(ref.result_id, result.result_id as string) && ref.version === result.version)) return null;
  }
  // The address of this live result of this open session; each right adds its own keys and conditions.
  const liveAddress = (value: unknown, extraKeys: string[]): value is Record<string, unknown> =>
    record(value) && record(result) && result.status === "active" && ["active", "summary"].includes(step.status as string)
    && exactKeys(value, ["session_id", "assignment_id", "result_id", "expected_result_version", ...extraKeys])
    && sameId(value.session_id, address.session_id) && sameId(value.assignment_id, address.assignment_id)
    && sameId(value.result_id, result.result_id as string) && value.expected_result_version === result.version;
  const target = (value: unknown, grades: boolean): boolean => {
    if (!liveAddress(value, grades ? ["values"] : [])) return false;
    const values = value.values;
    return grades ? (result as Record<string, unknown>).grade as number >= 3 && Array.isArray(values) && values.length === 3
      && [3, 4, 5].every(grade => values.includes(grade)) : (result as Record<string, unknown>).grade === 2;
  };
  // The one undo of this live form (CT table 2.3); any grade can be undone. No UI uses it yet (M-UNDO-CONJ).
  const undoTarget = (value: unknown): boolean => liveAddress(value, ["action_id", "kind"]) && record(action)
    && action.status === "active" && sameId(value.action_id, action.action_id as string) && value.kind === "answer.submit";
  if (!exactKeys(caps, ["answer_target", "correct_target", "grades", "undo_target", "stop", "summary_home"])
    || caps.undo_target !== null && !undoTarget(caps.undo_target)
    || caps.correct_target !== null && !target(caps.correct_target, false)
    || caps.grades !== null && !target(caps.grades, true)
    || typeof caps.stop !== "boolean" || typeof caps.summary_home !== "boolean") return null;
  if (unavailable) {
    if (caps.answer_target !== null || caps.correct_target !== null || caps.grades !== null || caps.undo_target !== null
      || caps.stop || caps.summary_home) return null;
  } else if (!("capabilities" in step) || !record(step.capabilities) || caps.answer_target !== step.capabilities.answer_target
    || caps.stop !== step.capabilities.stop || caps.summary_home !== step.capabilities.summary_home) return null;
  return { action, result, step, capabilities: caps } as ConjugationResultCurrent;
}
