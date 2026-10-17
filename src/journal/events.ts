import type { AppOpenEvent, BudgetEvent, ClientErrorEvent, ClientEventBatch, CommandReplyEvent, CommandSendEvent,
  DefectEvent, DeleteEvent, RecoveryEvent, ResetEvent, ScreenEvent, StorageEvent } from "../api/generated";

/**
 * The client journal of the Mini App (events TZ §4.5, R3-03 step 6): the eleven c.* events the core's intake accepts
 * (POST /api/v1/client/events, core 30fe429; c.reset, c.defect and c.delete since core a4a65e9, DEV-41 C3/M1/M2). Every
 * event and every value is on a closed list, checked again here at run time: an event that does not pass is not kept, so
 * no free text — a word, a name, a message, initData, a token — can ever reach the buffer.
 */
export type ClientEvent = ClientEventBatch["events"][number];
/** An event as a call site gives it: the device time is stamped by the journal. */
export type JournalEvent = ClientEvent extends infer E ? E extends ClientEvent ? Omit<E, "cts"> : never : never;

type Exactly<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false;
const exact = <T extends true>(_proof?: T) => undefined;

export const COMMAND_KINDS = [
  "access.decide", "access.mode", "access.reapply", "action.undo", "action.undo_offer.close", "action.undo_offer.open",
  "answer.submit", "assignment.present", "card.exclude", "card.relearn", "card.return", "conjugation.schedule",
  "context.close", "context.open", "feedback.send", "field.save", "field.undo", "interval.increase", "learning.known",
  "learning.preview_next", "learning.select", "learning.unselect", "onboarding.advance", "onboarding.complete",
  "onboarding.dismiss", "oral.grade", "oral.reveal", "result.correct", "result.grade", "result.undo",
  "session.cancel_start", "session.start", "session.stop", "session.stop_remote", "setting.save", "settings.reset",
  // The kinds the core accepts since P02-R (ca6ccbb) and C4/C5 (a80d653), as its contract lists them; only the reset cancel is
  // sent by this client so far (P02-R I.11.3, R16-01).
  "settings.reset_barrier", "settings.reset_cancel", "synonym.clear", "synonym.link", "synonym.link_many", "synonym.unlink",
] as const;
exact<Exactly<typeof COMMAND_KINDS[number], CommandSendEvent["kind"]>>();

export const ERROR_CODES = [
  "ACCESS_PENDING", "ACCESS_REJECTED", "ACTION_ALREADY_SAVED", "ANSWER_SPEC_UNAVAILABLE", "ASSIGNMENT_STALE", "AUTH_EXPIRED", "AUTH_INVALID",
  "CAPABILITY_EXPIRED", "CLIENT_INCOMPATIBLE", "CLIENT_OPEN_REQUIRED", "CLIENT_REGISTRATION_CONFLICT",
  "COMMAND_PAYLOAD_MISMATCH", "DICTIONARY_LANGUAGE_LOCKED", "DOCUMENT_STALE", "FORBIDDEN", "INTERNAL_ERROR", "LEASE_HELD",
  "LEASE_LOST", "MAINTENANCE", "METHOD_NOT_ALLOWED", "NOT_FOUND", "NO_MATERIAL", "NOTICE_PENDING", "NOTIFICATIONS_NOT_OPENED", "PRECEDENCE_ANOMALY", "PROFILE_DELETED",
  "RATE_LIMITED", "REQUEST_REFUSED", "RESET_CANCELLED", "RESET_EPOCH_STALE", "SEARCH_CURSOR_STALE", "SESSION_BUSY", "SESSION_CLOSED", "SETUP_REQUIRED",
  "VALIDATION_FAILED", "VERSION_CONFLICT", "WRITE_UNAVAILABLE",
] as const;
export type ErrorCode = NonNullable<CommandReplyEvent["code"]>;
exact<Exactly<typeof ERROR_CODES[number], ErrorCode>>();
exact<Exactly<typeof ERROR_CODES[number], NonNullable<ScreenEvent["code"]>>>();

export const RECOVERY_STATES = [
  "checking", "checks_only", "conflict", "counter_unknown", "disposed", "exhausted", "idle", "lost", "maintenance",
  "origin_elsewhere", "pre_send_check", "refused", "retry_wait", "sending", "settled", "suspended", "terminated",
  "unreachable", "window_check",
] as const;
exact<Exactly<typeof RECOVERY_STATES[number], RecoveryEvent["from"]>>();

export const RECOVERY_REASONS = ["access_lost", "client_incompatible", "session_closed", "step_stale", "window_replaced"] as const;
exact<Exactly<typeof RECOVERY_REASONS[number], NonNullable<RecoveryEvent["reason"]>>>();

export const SCREEN_KINDS = ["result_shown", "already_recorded", "lost", "unsaved_shown", "notice_shown", "refusal_shown",
  "update_required"] as const;
exact<Exactly<typeof SCREEN_KINDS[number], ScreenEvent["kind"]>>();

export const REPLY_OUTCOMES = ["applied", "already_applied", "refused", "unknown", "network", "timeout"] as const;
exact<Exactly<typeof REPLY_OUTCOMES[number], CommandReplyEvent["outcome"]>>();

/** c.reset (P02-R): the reset X or its cancel, and the outcome of X as the client recorded it (events §4.5, C496). */
export const RESET_KINDS = ["settings.reset", "settings.reset_cancel"] as const;
exact<Exactly<typeof RESET_KINDS[number], ResetEvent["kind"]>>();
export const RESET_OUTCOMES = ["applied", "rejected_stale_epoch", "rejected_invalid", "rejected_incompatible", "cancelled",
  "unknown"] as const;
exact<Exactly<typeof RESET_OUTCOMES[number], ResetEvent["outcome"]>>();
/** c.delete (P04): only the outcomes that were not applied; never del (events §4.5, V7). */
export const DELETE_OUTCOMES = ["refused", "unknown"] as const;
exact<Exactly<typeof DELETE_OUTCOMES[number], DeleteEvent["outcome"]>>();
exact<Exactly<ErrorCode, NonNullable<ResetEvent["code"]>>>();
exact<Exactly<ErrorCode, NonNullable<DefectEvent["code"]>>>();
exact<Exactly<ErrorCode, NonNullable<DeleteEvent["code"]>>>();

export const ERROR_CLASSES = [
  "Error", "AggregateError", "EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError", "URIError",
  "DOMException", "AbortError", "ConstraintError", "DataError", "InvalidStateError", "NetworkError", "NotAllowedError",
  "NotFoundError", "QuotaExceededError", "ReadOnlyError", "SecurityError", "TimeoutError", "TransactionInactiveError",
  "UnknownError", "VersionError", "ApiError", "ClosedAccessError", "DatabaseOpenError", "PendingStoreError",
  "SendBudgetError",
] as const;
exact<Exactly<typeof ERROR_CLASSES[number], ClientErrorEvent["err"]>>();

/** The core's bounds (api/models.py 30fe429): one event as compact JSON, a batch by count and by body size. */
export const EVENT_MAX_BYTES = 512;
export const BATCH_MAX_EVENTS = 50;
export const BATCH_MAX_BYTES = 32 * 1024;
/** CLIENT_ATTEMPT_MAX_MS: the longest attempt the core accepts. */
export const ATTEMPT_MAX_MS = 600_000;
/** The client build version the core accepts in client_version (ClientBuildVersion). */
export const CLIENT_BUILD_VERSION = /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}(?:\+[0-9a-f]{7,12})?$/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TIME = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;

const among = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (list as readonly string[]).includes(value);
const uuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);
const whole = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;

/** A UUID in the one form the journal keeps (lower case), or null when the value is none. */
export function journalId(value: unknown): string | null {
  return typeof value === "string" && UUID.test(value.toLowerCase()) ? value.toLowerCase() : null;
}
export function isErrorCode(value: unknown): value is ErrorCode { return among(ERROR_CODES, value); }
export function isCommandKind(value: unknown): value is CommandSendEvent["kind"] { return among(COMMAND_KINDS, value); }

type Check = (value: unknown) => boolean;
const optional = (check: Check): Check => value => value === undefined || check(value);
const FIELDS: Record<ClientEvent["ev"], Record<string, { check: Check; required: boolean }>> = {
  "c.app.open": { kind: req(value => value === "open" || value === "foreground"), doc: opt(uuid), idb_ok: opt(value => typeof value === "boolean") },
  "c.cmd.send": { cmd: req(uuid), trace: req(uuid), kind: req(value => among(COMMAND_KINDS, value)), attempt: req(value => whole(value, 1, 100)) },
  "c.cmd.reply": { cmd: opt(uuid), trace: req(uuid), status: opt(value => whole(value, 100, 599)), code: opt(isErrorCode),
    outcome: req(value => among(REPLY_OUTCOMES, value)), ms: opt(value => whole(value, 0, ATTEMPT_MAX_MS)) },
  "c.recovery": { cmd: req(uuid), from: req(value => among(RECOVERY_STATES, value)), to: req(value => among(RECOVERY_STATES, value)),
    reason: opt(value => among(RECOVERY_REASONS, value)) },
  "c.screen": { cmd: opt(uuid), kind: req(value => among(SCREEN_KINDS, value)), code: opt(isErrorCode),
    grade: opt(value => value === "correct" || value === "wrong" || value === "partial"),
    // notice_shown (events ред.3.6.4 §4.5; project notices §8; core 35c3844 ScreenEvent): the shown notice's id — see screenRule.
    notice: opt(uuid) },
  "c.budget": { cmd: req(uuid), n: req(value => whole(value, 0, 100)), outcome: req(value => value === "failed" || value === "cancel_sent") },
  "c.storage": { kind: req(value => value === "storage_read" || value === "storage_write" || value === "idb_unavailable") },
  "c.error": { err: req(value => among(ERROR_CLASSES, value)) },
  "c.reset": { cmd: req(uuid), kind: req(value => among(RESET_KINDS, value)), outcome: req(value => among(RESET_OUTCOMES, value)),
    code: opt(isErrorCode) },
  "c.defect": { cmd: req(uuid), trace: req(uuid), status: req(value => whole(value, 100, 599)), code: opt(isErrorCode) },
  "c.delete": { cmd: req(uuid), outcome: req(value => among(DELETE_OUTCOMES, value)), code: opt(isErrorCode) },
};
function req(check: Check) { return { check, required: true }; }
function opt(check: Check) { return { check: optional(check), required: false }; }

/**
 * The event exactly as the core would accept it, or null. Only the named fields of its event are kept; a field that is
 * missing, unknown or off its list rejects the whole event (nothing of it is guessed or shortened).
 */
export function acceptedEvent(value: unknown): ClientEvent | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const ev = record.ev;
  if (typeof ev !== "string" || !Object.prototype.hasOwnProperty.call(FIELDS, ev)) return null;
  const fields = FIELDS[ev as ClientEvent["ev"]];
  if (typeof record.cts !== "string" || !TIME.test(record.cts) || Number.isNaN(Date.parse(record.cts))) return null;
  const event: Record<string, unknown> = { cts: record.cts, ev };
  for (const [name, item] of Object.entries(record)) {
    if (name === "ev" || name === "cts" || item === undefined) continue;
    if (!Object.prototype.hasOwnProperty.call(fields, name)) return null;
  }
  for (const [name, rule] of Object.entries(fields)) {
    const item = record[name];
    if (item === undefined || item === null) { if (rule.required) return null; continue; }
    if (!rule.check(item)) return null;
    event[name] = item;
  }
  if (ev === "c.screen" && !screenRule(event)) return null;
  return event as ClientEvent;
}

/**
 * core ScreenEvent._notice_by_kind (35c3844): notice_shown names its notice and nothing else (no cmd, code or grade);
 * no other kind names a notice.
 */
function screenRule(event: Record<string, unknown>): boolean {
  if (event.kind === "notice_shown") return event.notice !== undefined && event.cmd === undefined
    && event.code === undefined && event.grade === undefined;
  return event.notice === undefined;
}

/** The size the core measures: compact JSON in UTF-8. */
export function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/** The class name of a thrown value, as a closed-list name; any other class is "Error" (never the message). */
export function errorClass(error: unknown): ClientErrorEvent["err"] {
  if (error instanceof DOMException && among(ERROR_CLASSES, error.name)) return error.name;
  if (error instanceof DOMException) return "DOMException";
  if (error instanceof Error) {
    const name = error.constructor?.name;
    if (among(ERROR_CLASSES, name)) return name;
  }
  return "Error";
}

export type { AppOpenEvent, BudgetEvent, ClientErrorEvent, CommandReplyEvent, CommandSendEvent, DefectEvent, DeleteEvent,
  RecoveryEvent, ResetEvent, ScreenEvent, StorageEvent };
