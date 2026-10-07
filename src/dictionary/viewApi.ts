import type {
  DictionaryCardContent, DictionaryCardStudy, DictionaryCardViewResponse,
  DictionaryReviewSchedule, DictionaryStudyFacts,
} from "../api/generated";
import { ApiError, createJsonTransport, httpError, type HttpOptions } from "../api/http";
import { count, date, exactKeys, oneOf, record, sameId, uuid, version } from "../api/wireValidation";
import { validDictionaryViewContent } from "../study/referenceCardContent";

export interface DictionaryViewApi {
  read(token: string, cardId: string): Promise<DictionaryCardViewResponse>;
}

function calendarDate(value: unknown): value is string {
  return date(value) && !value.startsWith("0000");
}

function validFacts(value: unknown): value is DictionaryStudyFacts {
  if (!record(value) || !exactKeys(value, ["common_translation_present", "exclusion", "manual", "learning", "non_learning_history"])
    || typeof value.common_translation_present !== "boolean" || typeof value.non_learning_history !== "boolean"
    || !record(value.exclusion) || !exactKeys(value.exclusion, ["excluded", "version"])
    || typeof value.exclusion.excluded !== "boolean"
    || (value.exclusion.version !== null && !version(value.exclusion.version))
    || (value.exclusion.excluded && value.exclusion.version === null)
    || !record(value.manual) || !exactKeys(value.manual, ["selected", "selection_version"])
    || typeof value.manual.selected !== "boolean" || !version(value.manual.selection_version)
    || !record(value.learning) || !exactKeys(value.learning, ["ever_selected", "finished_or_skipped", "current"])
    || typeof value.learning.ever_selected !== "boolean" || typeof value.learning.finished_or_skipped !== "boolean") return false;
  const learning = value.learning;
  if (!learning.ever_selected && (learning.finished_or_skipped || learning.current !== null)) return false;
  return learning.current === null || (record(learning.current)
    && exactKeys(learning.current, ["group_id", "group_status", "member_status", "member_version"])
    && uuid(learning.current.group_id) && version(learning.current.member_version)
    && oneOf(learning.current.group_status, ["assembling", "active"])
    && oneOf(learning.current.member_status, ["pending", "active"]));
}

function validSchedule(value: unknown): value is DictionaryReviewSchedule {
  return record(value) && exactKeys(value, ["interval_days", "next_due_date"])
    && count(value.interval_days) && calendarDate(value.next_due_date);
}

/** Check arithmetic consistency, without duplicating the server's review formula. */
function validOptions(value: unknown, schedule: DictionaryReviewSchedule | null, localDate: string | null): boolean {
  if (schedule === null || localDate === null) return value === null;
  if (!Array.isArray(value)) return false;
  let lastStep = 0;
  let lastInterval = schedule.interval_days;
  for (const option of value) {
    if (!record(option) || !exactKeys(option, ["step_id", "interval_days", "next_due_date"])
      || !count(option.step_id) || option.step_id <= lastStep
      || !count(option.interval_days) || option.interval_days <= lastInterval
      || !calendarDate(option.next_due_date)) return false;
    const due = new Date(`${localDate}T00:00:00.000Z`);
    due.setUTCDate(due.getUTCDate() + option.interval_days);
    if (Number.isNaN(due.getTime()) || due.toISOString().slice(0, 10) !== option.next_due_date) return false;
    lastStep = option.step_id;
    lastInterval = option.interval_days;
  }
  return true;
}

function validStudy(value: unknown, content: DictionaryCardContent): value is DictionaryCardStudy {
  if (!record(value) || !exactKeys(value, ["status", "card_id", "card_revision", "pair", "card_type", "local_date", "facts", "directions"])
    || value.status !== "available" || !sameId(value.card_id, content.card.id)
    || value.card_revision !== content.card.revision || value.pair !== content.pair || value.card_type !== content.card.type
    || (value.local_date !== null && !calendarDate(value.local_date))
    || !validFacts(value.facts) || !Array.isArray(value.directions) || value.directions.length !== 2
    || value.facts.common_translation_present !== (content.translations.common.length > 0)) return false;
  const facts = value.facts;
  const suppressed = facts.exclusion.excluded || facts.learning.current !== null;
  for (const [index, direction] of value.directions.entries()) {
    if (!record(direction) || !exactKeys(direction, ["direction", "introduced", "progress_present", "progress_version", "schedule", "interval_preview"])
      || direction.direction !== ["l1-de", "de-l1"][index]
      || typeof direction.introduced !== "boolean" || typeof direction.progress_present !== "boolean"
      || (direction.progress_present ? !version(direction.progress_version) : direction.progress_version !== null)) return false;
    const introduced = facts.learning.finished_or_skipped || facts.non_learning_history
      || (content.card.type === "phrase" && direction.progress_present);
    if (direction.introduced !== introduced) return false;
    const scheduled = direction.progress_present && introduced && !suppressed;
    if (scheduled ? !validSchedule(direction.schedule) : direction.schedule !== null) return false;
    if (!validOptions(direction.interval_preview, direction.schedule as DictionaryReviewSchedule | null, value.local_date)) return false;
  }
  return true;
}

/** Both sections must address the same snapshot; the server chooses the current pair. */
export function validDictionaryView(value: unknown, cardId: string): value is DictionaryCardViewResponse {
  if (!uuid(cardId) || !record(value) || !exactKeys(value, ["state_version", "current"])
    || !version(value.state_version) || !record(value.current)) return false;
  const current = value.current;
  if (current.status === "unavailable") return exactKeys(current, ["status"]);
  if (current.status !== "available" || !exactKeys(current, ["status", "content", "study"])
    || !record(current.content) || typeof current.content.pair !== "string"
    || !validDictionaryViewContent(current.content, cardId, current.content.pair)) return false;
  return validStudy(current.study, current.content);
}

/** One authenticated bounded request; it never grants an action or changes study state. */
export function createDictionaryViewApi(options: HttpOptions): DictionaryViewApi {
  const request = createJsonTransport(options);
  return {
    async read(token, cardId) {
      if (typeof token !== "string" || !token || !uuid(cardId)) throw new Error("token and card ID are required");
      const reply = await request(`/dictionary/cards/${cardId}/view`, { method: "GET", token });
      if (!reply.ok) throw httpError(reply);
      if (reply.status !== 200 || !validDictionaryView(reply.value, cardId)) throw new ApiError("invalid_response");
      return reply.value;
    },
  };
}
