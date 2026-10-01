import type { LearningSessionProjection, SessionProjection, SessionResponse, UnavailableSession } from "../api/generated";
import { record, uuid, sameId, exactKeys, version, oneOf, count, date } from "../api/wireValidation";
import { validLearningPreviewContent } from "../learning/learningPreviewContent";
import { validConjunctionHint } from "./questionContext";
import { validOralCurrent } from "../oral/oralProjection";
import { validConjugationCurrent } from "../conjugation/conjugationProjection";

/** Validate public session projections without admitting queue or answer snapshots. */
function textArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string");
}
function nullableVersion(value: unknown): boolean { return value === null || version(value); }
function validAssignment(value: unknown, pair: string, mode: "learning" | "written", bucket?: "words" | "phrases"): boolean {
  if (!record(value) || !exactKeys(value, ["id", "card_id", "status", "kind", "prompt", "answer_spec"])
    || !uuid(value.id) || !uuid(value.card_id)
    || !(mode === "learning" ? value.kind === "learning" : oneOf(value.kind, ["original", "drill"]))
    || !oneOf(value.status, ["prefetched", "presented"]) || !record(value.prompt) || !record(value.answer_spec)) return false;
  const prompt = value.prompt, spec = value.answer_spec;
  return exactKeys(prompt, ["text", "language", "translations", "personal_translation_version", "hint", "hint_version", "conjunction_hint"])
    && typeof prompt.text === "string" && prompt.language === pair.split("-")[0] && textArray(prompt.translations)
    && nullableVersion(prompt.personal_translation_version) && nullableVersion(prompt.hint_version)
    && (prompt.hint === null || typeof prompt.hint === "string")
    && validConjunctionHint(prompt.conjunction_hint)
    && exactKeys(spec, ["kind", "labels", "part_count", "case_sensitive"])
    && (bucket === "phrases" ? spec.kind === "phrase" : oneOf(spec.kind, ["word", "forms"]))
    && textArray(spec.labels) && count(spec.part_count)
    && spec.part_count > 0 && spec.part_count === spec.labels.length && typeof spec.case_sensitive === "boolean";
}

export function validLearningSessionCurrent(value: unknown, sessionId: string): value is LearningSessionProjection | UnavailableSession {
  if (!record(value) || !sameId(value.session_id, sessionId)) return false;
  if (oneOf(value.status, ["unavailable", "not_found"])) return exactKeys(value, ["session_id", "status"]);
  if (!exactKeys(value, ["session_id", "status", "mode", "pair", "local_date", "close_reason", "group", "preview", "assignment"])
    || value.mode !== "learning" || !oneOf(value.status, ["active", "summary", "closed"])
    || !oneOf(value.pair, ["ru-de", "uk-de", "en-de"]) || !date(value.local_date) || !record(value.group)) return false;
  const group = value.group;
  if (!exactKeys(group, ["id", "status", "version", "preview_position", "total"])
    || !uuid(group.id) || !version(group.version) || !oneOf(group.status, ["assembling", "active", "completed"])
    || !count(group.preview_position) || !count(group.total) || group.total === 0 || group.preview_position > group.total) return false;
  if (value.status === "closed") return value.preview === null && value.assignment === null
    && oneOf(value.close_reason, ["midnight", "pair_changed", "timezone_date_changed", "stop", "remote_stop", "summary_home"]);
  if (value.close_reason !== null) return false;
  if (value.status === "summary") return value.preview === null && value.assignment === null
    && oneOf(group.status, ["active", "completed"]) && group.preview_position === group.total;
  if (value.preview !== null) {
    const preview = value.preview;
    return value.assignment === null && group.status === "assembling" && record(preview)
      && exactKeys(preview, ["id", "card_id", "position", "total", "content"]) && uuid(preview.id) && uuid(preview.card_id)
      && count(preview.position) && preview.position === group.preview_position + 1
      && preview.total === group.total && preview.position <= group.total
      && validLearningPreviewContent(preview.content, preview.card_id, value.pair as string);
  }
  // A correction may complete the group while an already-issued repeat remains.
  // Reading that assignment does not decide how its eventual answer is applied.
  return oneOf(group.status, ["active", "completed"]) && group.preview_position === group.total
    && validAssignment(value.assignment, value.pair as string, "learning");
}


export function validWrittenSessionCurrent(value: unknown, sessionId: string): value is SessionProjection | UnavailableSession {
  if (!record(value) || !sameId(value.session_id, sessionId)) return false;
  if (oneOf(value.status, ["unavailable", "not_found"])) return exactKeys(value, ["session_id", "status"]);
  if (!exactKeys(value, ["session_id", "status", "mode", "pair", "direction", "local_date", "bucket", "close_reason", "progress", "assignment"])
    || value.mode !== "written" || !oneOf(value.status, ["active", "summary", "closed"])
    || !oneOf(value.pair, ["ru-de", "uk-de", "en-de"]) || value.direction !== "l1-de"
    || !date(value.local_date) || !(value.bucket === null || oneOf(value.bucket, ["words", "phrases"]))
    || !record(value.progress) || !exactKeys(value.progress, ["completed", "total"])
    || !count(value.progress.completed) || !count(value.progress.total)
    || value.progress.completed > value.progress.total) return false;
  if (value.status === "closed") return value.assignment === null
    && oneOf(value.close_reason, ["midnight", "pair_changed", "timezone_date_changed", "stop", "remote_stop", "summary_home"]);
  if (value.close_reason !== null) return false;
  if (value.status === "summary") return value.assignment === null;
  return value.bucket !== null && value.progress.total > 0
    && validAssignment(value.assignment, value.pair as string, "written", value.bucket as "words" | "phrases");
}

export function validSessionCurrent(value: unknown, sessionId: string): value is SessionResponse["current"] {
  if (!record(value)) return false;
  if (value.mode === "oral") return validOralCurrent(value, sessionId);
  if (value.mode === "conjugation") return validConjugationCurrent(value, sessionId);
  return value.mode === "written" ? validWrittenSessionCurrent(value, sessionId) : validLearningSessionCurrent(value, sessionId);
}
