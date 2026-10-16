import type {
  ErrorDetail, MissingCommandFact, Profile, RefusedResetFact, RejectedCommandFact, ResetTarget, SavedCommandFact, SettingCommand,
  SettingsProjection, SettingsResetCancelCommand, SettingsResetCommand, SettingsResponse, StoredCommandFact, UnavailableCurrent,
} from "../api/generated";
import { validProfile } from "../api/entryApi";
import { ApiError, createJsonTransport, errorCode, httpError, type HttpOptions, type JsonReply } from "../api/http";
import type { ReadbackTicket } from "../commands/writeGate";

// root decision (C+M-SET-READINESS-FIELDS, P12/P14): the server may still carry these two keys while an older
// build is deployed. They are skipped when decoding and never edited or sent from here.
export const retiredKeys = ["learning_poll_seconds", "learning_ready_percent"] as const;
// Every other key of the wire command is editable here, including review_error_mode and learning_content.
export type SettingKey = Exclude<SettingCommand["payload"]["key"], (typeof retiredKeys)[number]>;
/**
 * R14-02: the Learning reminder pause is no setting any more, but an earlier build may have left an unfinished save of it
 * in the device's pending slot. Such a stored intent takes the ordinary recovery of every unfinished save (the pending
 * slot, then the status read by its command ID, as for retry_count), so neither its ID nor its outcome is dropped
 * silently. It is not a retired key: the projection never carries it (a projection with it is refused), this build never
 * edits it and never creates such an intent; only a stored one is checked and, on the user's explicit retry, sent again.
 */
export const storedOnlyKeys = ["learning_reminder_pause_seconds"] as const;
export type StoredOnlyKey = (typeof storedOnlyKeys)[number];
/** The key of a stored or sent intent: an editable key, or a stored-only key of an earlier build. */
export type IntentKey = SettingKey | StoredOnlyKey;
export function storedOnly(key: IntentKey): key is StoredOnlyKey { return (storedOnlyKeys as readonly string[]).includes(key); }
/** As the wire carries it, possibly naming a retired or a stored-only key. */
export type SettingIntent = Pick<SettingCommand, "command_id" | "kind" | "expected_field_version"> & {
  payload: Omit<SettingCommand["payload"], "key"> & { key: SettingCommand["payload"]["key"] | StoredOnlyKey };
};
/** An intent this build may keep as the pending slot and send: one it created, or a stored one of a stored-only key. */
export type EditableSettingIntent = Omit<SettingIntent, "payload"> & {
  payload: Omit<SettingCommand["payload"], "key"> & { key: IntentKey };
};
/** The command as it is sent: the stored intent with this window's client and document. */
export type SettingSaveCommand = Omit<SettingCommand, "payload"> & Pick<SettingIntent, "payload">;
/**
 * The confirmed reset to the initial values (CT 6.2, TC 13.1) as it is stored (P02-R I.11.1): it carries the reset epoch of
 * the read it was confirmed on (I.5). An earlier build stored it with an empty payload, the legacy intent without an epoch;
 * such a record is only checked by its ID and never sent again (I.11.3 step 4, R-5), so this build sends only the epoch form.
 */
export type SettingsResetIntent = Pick<SettingsResetCommand, "command_id" | "kind"> & {
  payload: SettingsResetCommand["payload"] | LegacyResetPayload;
};
/** The empty payload of a reset stored by a build before P02-R. */
export type LegacyResetPayload = { [key: string]: never };
/**
 * The eleven fields `settings.reset` returns to their initial values (TC 13.1.5–13.1.15). The server owns the
 * values; this list only decides which unsaved drafts an accepted reset discards (owner answer R12).
 */
export const resetKeys = ["learning_group_size", "learning_content", "learning_mix", "review_error_mode",
  "transition_mode", "strict_case", "include_preterite", "include_comparative", "learning_intervals_seconds",
  "retry_gap", "retry_count"] as const satisfies readonly SettingKey[];
type Current = { current: SettingsProjection; state_version: string };
/** The reply to a sent settings command, a save or a reset alike. */
export type SettingSaveReply = Current & (
  | { outcome: "accepted"; command: SavedCommandFact }
  | { outcome: "rejected" | "mismatch"; command: RejectedCommandFact; error: ErrorDetail }
);
export type SettingStatusReply = { state_version: string } & (
  | { outcome: "accepted"; command: StoredCommandFact; current: SettingsProjection | UnavailableCurrent }
  | { outcome: "not_found"; command: MissingCommandFact; current: Profile }
);

/**
 * The refusals the core stores under a reset ID before it answers (P02-R I.4, I.7, R-10): F1 ends the reset with nothing
 * changed; F2 (the explicit refusal of R8-05/R8-06) is held until the user's «Отменить прежний сброс». Each code has one
 * HTTP status and one terminal outcome; an answer whose parts disagree is no attribution (AC-59).
 */
export const resetFinalCodes = ["RESET_EPOCH_STALE", "RESET_CANCELLED"] as const;
export const resetHeldCodes = ["VALIDATION_FAILED", "CLIENT_INCOMPATIBLE"] as const;
export type ResetFinalCode = (typeof resetFinalCodes)[number];
export type ResetHeldCode = (typeof resetHeldCodes)[number];
export type ResetRefusalCode = ResetFinalCode | ResetHeldCode;
export type ResetTargetOutcome = ResetTarget["outcome"];
const refusalStatus: Record<ResetRefusalCode, number> = { RESET_EPOCH_STALE: 409, RESET_CANCELLED: 409, VALIDATION_FAILED: 422,
  CLIENT_INCOMPATIBLE: 409 };
const refusalOutcome: Record<ResetRefusalCode, Exclude<ResetTargetOutcome, "applied">> = { RESET_CANCELLED: "cancelled",
  RESET_EPOCH_STALE: "rejected_stale_epoch", VALIDATION_FAILED: "rejected_invalid", CLIENT_INCOMPATIBLE: "rejected_incompatible" };
/** The code of a terminal outcome, as the core answers it (core settings/reset.py TERMINAL_ANSWERS). */
export function refusalCodeOf(outcome: Exclude<ResetTargetOutcome, "applied">): ResetRefusalCode {
  return (Object.keys(refusalOutcome) as ResetRefusalCode[]).find(code => refusalOutcome[code] === outcome)!;
}
export function heldRefusal(code: ResetRefusalCode): code is ResetHeldCode { return (resetHeldCodes as readonly string[]).includes(code); }
function refusalCode(value: unknown): value is ResetRefusalCode { return typeof value === "string" && Object.hasOwn(refusalStatus, value); }

type CurrentOrUnavailable = SettingsProjection | UnavailableCurrent;
/**
 * The answer to a sent reset that the server decided (P02-R I.7): applied, a stored refusal (F1/F2, attributed by the
 * command's ID, its status, the code with its own HTTP status and a valid `current`), or a mismatch of the ID. Every other
 * answer — a bare 422/409, DOCUMENT_STALE, SESSION_BUSY, 5xx, no answer, an unreadable one — throws: it records no outcome of
 * this reset, so it is no refusal (R16-01 variant 1) and the caller reads the reset's status by its ID.
 */
export type ResetReply = Current & (
  | { outcome: "accepted"; command: SavedCommandFact }
  | { outcome: "refused"; code: ResetRefusalCode; command: RejectedCommandFact }
  | { outcome: "mismatch"; command: RejectedCommandFact; error: ErrorDetail }
);
/**
 * The status of a reset ID read with include_refusal=true (P02-R I.8): its fact, its stored refusal, or the canonical
 * not_found — the only answer after which the client cancels the reset on the server itself. Anything else throws and
 * decides nothing.
 */
export type ResetStatusReply = { state_version: string } & (
  | { outcome: "accepted"; command: StoredCommandFact; current: CurrentOrUnavailable }
  | { outcome: "refused"; code: ResetRefusalCode; command: RefusedResetFact; current: CurrentOrUnavailable }
  | { outcome: "not_found"; command: MissingCommandFact; current: Profile }
);
/** The cancel of an earlier reset (P02-R I.5): its own new ID and the reset it names. */
export type ResetCancelIntent = { command_id: string; target_command_id: string };
/** The cancel's answer: the target's outcome read under the profile lock (I.9), or a mismatch of the cancel's ID. */
export type ResetCancelReply = Current & (
  | { outcome: "accepted"; target: ResetTargetOutcome; command: SavedCommandFact }
  | { outcome: "mismatch"; command: RejectedCommandFact; error: ErrorDetail }
);
/** The status of a cancel ID: its fact with the target's outcome, or the canonical not_found (then the same ID is sent). */
export type ResetCancelStatusReply = { state_version: string } & (
  | { outcome: "accepted"; target: ResetTargetOutcome; command: StoredCommandFact; current: SettingsProjection }
  | { outcome: "not_found"; command: MissingCommandFact; current: Profile }
);

export interface SettingsApi {
  get(token: string): Promise<SettingsResponse>;
  save(token: string, proof: string, profileId: string, command: SettingSaveCommand): Promise<SettingSaveReply>;
  status(token: string, profileId: string, intent: SettingIntent, ticket: ReadbackTicket): Promise<SettingStatusReply>;
  reset(token: string, proof: string, profileId: string, command: SettingsResetCommand): Promise<ResetReply>;
  resetStatus(token: string, profileId: string, intent: SettingsResetIntent, ticket: ReadbackTicket): Promise<ResetStatusReply>;
  resetCancel(token: string, proof: string, profileId: string, command: SettingsResetCancelCommand): Promise<ResetCancelReply>;
  resetCancelStatus(token: string, profileId: string, intent: ResetCancelIntent, ticket: ReadbackTicket): Promise<ResetCancelStatusReply>;
}

/**
 * Notifications (project_notifications §3, §5): four switches and three whole local hours 0–23, each with its own field
 * version, never null. The Learning reminder pause is not a setting any more (R14-02): the projection has no such key and
 * a projection that carries one is refused as any unknown key. There is no weekday of the weekly report (R12-02).
 */
export const notificationFlags = ["notify_learning", "notify_weekly", "notify_daily", "notify_evening"] as const satisfies readonly SettingKey[];
export const notificationHours = ["weekly_report_hour", "daily_report_hour", "evening_reminder_hour"] as const satisfies readonly SettingKey[];
export type NotificationFlag = (typeof notificationFlags)[number];
export type NotificationHour = (typeof notificationHours)[number];
/** The keys the main settings screen edits; the notification keys belong to the submenu «Уведомления». */
export type MainSettingKey = Exclude<SettingKey, NotificationFlag | NotificationHour>;
const integers = ["retry_gap", "retry_count", "learning_group_size", ...notificationHours] as const;
const booleans = ["learning_mix", "strict_case", "include_preterite", "include_comparative", ...notificationFlags] as const;
/** Always present with a value, never null: the languages, the required choices and the notification keys. */
const neverNull: readonly string[] = ["ui_language", "dictionary_language", ...notificationFlags, ...notificationHours];
const languages = ["ru", "uk", "en"];
const levels = ["A1", "A2", "B1", "B2", "C1", "C2"];
const transitions = ["normal", "accelerated"];
// Always present and never null. K04-102, P07: review_error_mode is soft initially;
// K04-105: learning_content is words initially and independent of learning_mix.
const requiredChoices = {
  review_error_mode: ["strict", "soft"],
  learning_content: ["words", "phrases", "mixed"],
} as const satisfies Partial<Record<SettingKey, readonly string[]>>;
type RequiredChoiceKey = keyof typeof requiredChoices;
const requiredKeys = Object.keys(requiredChoices) as RequiredChoiceKey[];
function requiredChoice(key: string): key is RequiredChoiceKey { return Object.hasOwn(requiredChoices, key); }
const keys: SettingKey[] = ["ui_language", "dictionary_language", ...integers, ...booleans,
  "learning_intervals_seconds", "transition_mode", "material", ...requiredKeys];

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
}
/** Every wanted field is present; any further field must be a retired key (ignored, not validated). */
function exactOrRetired(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => fields.includes(key) || oneOf(key, retiredKeys));
}
function withoutRetired<T extends { settings: object; constraints: object }>(current: T): T {
  const drop = (group: object) => Object.fromEntries(Object.entries(group).filter(([key]) => !oneOf(key, retiredKeys)));
  return { ...current, settings: drop(current.settings), constraints: drop(current.constraints) } as T;
}
function oneOf(value: unknown, choices: readonly string[]): value is string {
  return typeof value === "string" && choices.includes(value);
}
function integer(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value); }
function listOf<T>(value: unknown, valid: (item: unknown) => item is T): value is T[] {
  if (!Array.isArray(value)) return false;
  // Unlike Array.every, iteration visits holes which JSON would silently encode as null.
  for (const item of value) if (!valid(item)) return false;
  return true;
}
function uuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
function sameId(value: unknown, expected: string): boolean {
  return uuid(value) && value.toLowerCase() === expected.toLowerCase();
}
function version(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value)
    && BigInt(value) <= 9223372036854775807n;
}
function eventTime(value: unknown): boolean {
  if (typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|\+00:00)$/.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 19) === value.slice(0, 19);
}

function material(value: unknown): boolean {
  if (!record(value)) return false;
  if (value.mode === "level") return exact(value, ["mode", "selected_level"]) && oneOf(value.selected_level, levels);
  if (value.mode !== "topics" || !exact(value, ["mode", "topic_ids"]) || !listOf(value.topic_ids, uuid)
    || value.topic_ids.length === 0) return false;
  return new Set(value.topic_ids.map(id => id.toLowerCase())).size === value.topic_ids.length;
}

/** Shape and key/value correlation, independent of today's editable constraints. */
function valueShape(key: string, value: unknown): boolean {
  if (key === "ui_language" || key === "dictionary_language") return oneOf(value, languages);
  if (oneOf(key, integers)) return integer(value);
  if (oneOf(key, booleans)) return typeof value === "boolean";
  if (key === "transition_mode") return oneOf(value, transitions);
  if (requiredChoice(key)) return oneOf(value, requiredChoices[key]);
  if (key === "learning_intervals_seconds") return listOf(value, integer);
  // A stored-only key keeps the shape it had as a setting (a whole number of seconds); it has no constraint any more.
  if (oneOf(key, storedOnlyKeys)) return integer(value);
  return key === "material" && material(value);
}

function choices(value: unknown, supported: readonly string[]): boolean {
  return listOf(value, (item): item is string => oneOf(item, supported)) && value.length > 0
    && new Set(value).size === value.length;
}
function bounds(minimum: unknown, maximum: unknown): boolean {
  return integer(minimum) && integer(maximum) && minimum <= maximum;
}
function constraint(key: SettingKey, value: unknown): boolean {
  if (!record(value)) return false;
  if (key === "ui_language" || key === "dictionary_language" || key === "transition_mode") {
    return value.type === "enum" && choices(value.values, key === "transition_mode" ? transitions : languages);
  }
  if (requiredChoice(key)) return value.type === "enum" && choices(value.values, requiredChoices[key]);
  if (oneOf(key, integers)) return value.type === "integer" && bounds(value.minimum, value.maximum);
  if (oneOf(key, booleans)) return value.type === "boolean";
  if (key === "learning_intervals_seconds") return value.type === "ordered_integer_list"
    && typeof value.nonempty === "boolean" && bounds(value.item_minimum, value.item_maximum);
  return value.type === "exclusive_choice" && record(value.modes) && exact(value.modes, ["level", "topics"])
    && record(value.modes.level) && exact(value.modes.level, ["selected_level"])
    && choices(value.modes.level.selected_level, levels)
    && record(value.modes.topics) && exact(value.modes.topics, ["topic_ids"])
    && value.modes.topics.topic_ids === "nonempty_existing_uuid_list";
}

/**
 * The profile's reset epoch of a read (P02-R I.6), or null: a core before P02-R sends none, and then this client sends no
 * reset (I.13 п.1). The decoder lets such a read pass, so the generated type's required field may be absent at run time.
 */
export function resetEpochOf(current: SettingsProjection | null | undefined): string | null {
  const epoch = current ? (current as { reset_epoch?: unknown }).reset_epoch : undefined;
  return version(epoch) ? epoch : null;
}

export function validSettingsCurrent(value: unknown): value is SettingsProjection {
  if (!record(value) || typeof value.needs_setup !== "boolean" || !record(value.settings)
    || Object.hasOwn(value, "reset_epoch") && !version(value.reset_epoch)
    || !exactOrRetired(value.settings, [...keys, "time_zone"]) || !record(value.constraints)
    || !exactOrRetired(value.constraints, keys)) return false;
  for (const key of keys) {
    const setting = value.settings[key];
    if (!record(setting) || !version(setting.version) || !Object.hasOwn(setting, "value")
      || !constraint(key, value.constraints[key])) return false;
    // Language, required-choice and notification settings are never null; every other setting may be unset.
    if (setting.value === null && !neverNull.includes(key) && !requiredChoice(key)) continue;
    if (!valueShape(key, setting.value)) return false;
  }
  const zone = value.settings.time_zone;
  // Read only (§5.5): whether the person opened the bot; until then the switches stay closed (R12-15).
  const notifications = value.notifications;
  return record(zone) && version(zone.version) && (zone.value === null || typeof zone.value === "string")
    && record(notifications) && exact(notifications, ["telegram_opened"]) && typeof notifications.telegram_opened === "boolean";
}

/** Validate a NEW choice using the server's current bounds; never clamp or replace it. */
export function allowedSettingValue(current: SettingsProjection, key: SettingKey, value: unknown): boolean {
  if (!valueShape(key, value)) return false;
  const rule = current.constraints[key];
  if (!constraint(key, rule)) return false;
  if (rule.type === "integer") return (value as number) >= rule.minimum! && (value as number) <= rule.maximum!;
  if (rule.type === "ordered_integer_list") return Array.isArray(value) && (!rule.nonempty || value.length > 0)
    && value.every(item => item >= rule.item_minimum! && item <= rule.item_maximum!);
  if (rule.type === "enum") return rule.values!.includes(value as string);
  if (rule.type === "exclusive_choice") {
    if (!record(value)) return false;
    return value.mode === "topics" || (rule.modes!.level.selected_level as string[]).includes(value.selected_level as string);
  }
  return rule.type === "boolean";
}

export function validSettingIntent(value: unknown): value is EditableSettingIntent {
  return record(value) && exact(value, ["command_id", "kind", "expected_field_version", "payload"])
    && uuid(value.command_id) && value.kind === "setting.save" && version(value.expected_field_version)
    && BigInt(value.expected_field_version) < 9223372036854775807n && record(value.payload)
    && exact(value.payload, ["key", "value"]) && (oneOf(value.payload.key, keys) || oneOf(value.payload.key, storedOnlyKeys))
    && valueShape(value.payload.key, value.payload.value);
}

export function validSettingsResetIntent(value: unknown): value is SettingsResetIntent {
  return record(value) && exact(value, ["command_id", "kind", "payload"]) && uuid(value.command_id)
    && value.kind === "settings.reset" && record(value.payload)
    && (exact(value.payload, []) || exact(value.payload, ["expected_reset_epoch"]) && version(value.payload.expected_reset_epoch));
}

// The wire command may still name a retired key; only an editable one passes.
function snapshot(value: unknown): EditableSettingIntent {
  if (!validSettingIntent(value)) throw new Error("invalid setting intent");
  return structuredClone(value);
}
function resetSnapshot(value: unknown): SettingsResetIntent {
  if (!validSettingsResetIntent(value)) throw new Error("invalid settings reset intent");
  const epoch = (value.payload as { expected_reset_epoch?: string }).expected_reset_epoch;
  return { command_id: value.command_id, kind: value.kind, payload: epoch === undefined ? {} : { expected_reset_epoch: epoch } };
}
function requireSubject(token: string, profileId: string): void {
  if (!token || !uuid(profileId)) throw new Error("invalid setting subject");
}
function settingsFact(value: unknown, profileId: string, commandId: string, kind: string): value is SavedCommandFact {
  return record(value) && sameId(value.id, commandId) && value.kind === kind
    && oneOf(value.status, ["applied", "already_applied"]) && eventTime(value.applied_at)
    && sameId(value.target_id, profileId) && version(value.object_version)
    && value.action_id === null && value.result_id === null && value.context_id === null;
}
function acceptedFact(value: unknown, profileId: string, intent: SettingIntent): value is SavedCommandFact {
  return settingsFact(value, profileId, intent.command_id, "setting.save")
    && value.object_version === String(BigInt(intent.expected_field_version) + 1n);
}
/** A reset has no single field version to advance; its fact carries the settings row version after commit. */
function resetFact(value: unknown, profileId: string, intent: SettingsResetIntent): value is SavedCommandFact {
  return settingsFact(value, profileId, intent.command_id, "settings.reset");
}
/** The fact of a cancel names its target reset ID and no version (core settings/reset.py cancel_target). */
function cancelFact(value: unknown, intent: ResetCancelIntent): value is SavedCommandFact {
  return record(value) && sameId(value.id, intent.command_id) && value.kind === "settings.reset_cancel"
    && oneOf(value.status, ["applied", "already_applied"]) && eventTime(value.applied_at)
    && sameId(value.target_id, intent.target_command_id) && value.object_version === null
    && value.action_id === null && value.result_id === null && value.context_id === null;
}
/** current.reset_target of a cancel (I.6): the target's outcome; the projection is returned without it. */
function cancelTarget(value: unknown, targetId: string): { target: ResetTargetOutcome; current: SettingsProjection } | null {
  if (!record(value) || !record(value.reset_target)) return null;
  const { reset_target: target, ...current } = value;
  if (!exact(target, ["command_id", "outcome"]) || !sameId(target.command_id, targetId)
    || !oneOf(target.outcome, ["applied", "cancelled", "rejected_stale_epoch", "rejected_invalid", "rejected_incompatible"])
    || !validSettingsCurrent(current)) return null;
  return { target: target.outcome as ResetTargetOutcome, current: withoutRetired(current) };
}
function unavailable(value: unknown): value is UnavailableCurrent {
  return record(value) && exact(value, ["status"]) && value.status === "unavailable";
}
/** The canonical not_found of a status read (CON:32): this very ID, this profile, nothing else. */
function notFound(value: Record<string, unknown>, profileId: string, commandId: string): boolean {
  return record(value.command) && exact(value.command, ["id", "status"]) && value.command.status === "not_found"
    && sameId(value.command.id, commandId) && validProfile(value.current) && sameId(value.current.profile_id, profileId)
    && value.error == null;
}
/** An attributed refusal of a sent command: its own ID, status rejected and an error code (the general reply envelope). */
function attributed(value: Record<string, unknown>, commandId: string): string | undefined {
  return record(value.command) && exact(value.command, ["id", "status"]) && sameId(value.command.id, commandId)
    && value.command.status === "rejected" ? errorCode(value) : undefined;
}

function resetReply(reply: JsonReply, profileId: string, intent: SettingsResetIntent): ResetReply {
  const value = reply.value;
  if (record(value) && validSettingsCurrent(value.current) && version(value.state_version)) {
    const current = { current: withoutRetired(value.current), state_version: value.state_version };
    if (reply.status === 200 && resetFact(value.command, profileId, intent) && value.error == null) {
      return { ...current, outcome: "accepted", command: value.command };
    }
    const code = attributed(value, intent.command_id);
    const command = { id: intent.command_id, status: "rejected" as const };
    if (refusalCode(code) && reply.status === refusalStatus[code]) return { ...current, outcome: "refused", code, command };
    if (code === "COMMAND_PAYLOAD_MISMATCH" && reply.status === 409) return { ...current, outcome: "mismatch", command, error: { code } };
  }
  // No outcome of this reset is recorded by such an answer (R16-01 variant 1): the caller reads the status by the ID.
  if (!reply.ok) throw httpError(reply);
  throw new ApiError("invalid_response");
}
function resetStatusReply(reply: JsonReply, profileId: string, intent: SettingsResetIntent): ResetStatusReply {
  if (!reply.ok) throw httpError(reply);
  const value = reply.value;
  if (reply.status !== 200 || !record(value) || !record(value.command) || !version(value.state_version)) throw new ApiError("invalid_response");
  const state_version = value.state_version, fact = value.command;
  if (notFound(value, profileId, intent.command_id)) {
    return { outcome: "not_found", command: { id: fact.id as string, status: "not_found" }, current: value.current as Profile, state_version };
  }
  const current = validSettingsCurrent(value.current) ? withoutRetired(value.current)
    : unavailable(value.current) ? { status: "unavailable" as const } : null;
  if (current && value.error == null && resetFact(fact, profileId, intent) && fact.status === "already_applied") {
    return { outcome: "accepted", command: fact as StoredCommandFact, current, state_version };
  }
  const code = errorCode(value), refused: Record<string, unknown> = value.command;
  const status = Object.hasOwn(refused, "http_status") ? refused.http_status : null;
  if (current && refusalCode(code) && record(value.error) && exact(value.error, ["code"])
    && exact(refused, ["id", "kind", "status", "outcome", "refused_at", ...(Object.hasOwn(refused, "http_status") ? ["http_status"] : [])])
    && sameId(refused.id, intent.command_id) && refused.kind === "settings.reset" && refused.status === "rejected"
    && refused.outcome === refusalOutcome[code] && eventTime(refused.refused_at)
    && (heldRefusal(code) ? status === refusalStatus[code] : status === null)) {
    return { outcome: "refused", code, command: { id: refused.id as string, kind: "settings.reset", status: "rejected",
      outcome: refusalOutcome[code], refused_at: refused.refused_at as string,
      ...(status === null ? {} : { http_status: status as 409 | 422 }) }, current, state_version };
  }
  throw new ApiError("invalid_response");
}
function cancelReply(reply: JsonReply, intent: ResetCancelIntent): ResetCancelReply {
  const value = reply.value;
  if (record(value) && version(value.state_version)) {
    const decided = reply.status === 200 && value.error == null && cancelFact(value.command, intent)
      ? cancelTarget(value.current, intent.target_command_id) : null;
    if (decided) return { current: decided.current, state_version: value.state_version, outcome: "accepted", target: decided.target,
      command: value.command as SavedCommandFact };
    const code = attributed(value, intent.command_id);
    if (code === "COMMAND_PAYLOAD_MISMATCH" && reply.status === 409 && validSettingsCurrent(value.current)) {
      return { current: withoutRetired(value.current), state_version: value.state_version, outcome: "mismatch",
        command: { id: intent.command_id, status: "rejected" }, error: { code } };
    }
  }
  if (!reply.ok) throw httpError(reply);
  throw new ApiError("invalid_response");
}
function cancelStatusReply(reply: JsonReply, profileId: string, intent: ResetCancelIntent): ResetCancelStatusReply {
  if (!reply.ok) throw httpError(reply);
  const value = reply.value;
  if (reply.status !== 200 || !record(value) || !record(value.command) || !version(value.state_version)) throw new ApiError("invalid_response");
  if (notFound(value, profileId, intent.command_id)) return { outcome: "not_found",
    command: { id: value.command.id as string, status: "not_found" }, current: value.current as Profile, state_version: value.state_version };
  const decided = value.error == null && cancelFact(value.command, intent) && value.command.status === "already_applied"
    ? cancelTarget(value.current, intent.target_command_id) : null;
  if (decided) return { outcome: "accepted", target: decided.target, command: value.command as StoredCommandFact,
    current: decided.current, state_version: value.state_version };
  throw new ApiError("invalid_response");
}
function cancelSnapshot(value: unknown): ResetCancelIntent {
  if (!record(value) || !exact(value, ["command_id", "target_command_id"]) || !uuid(value.command_id)
    || !uuid(value.target_command_id) || value.command_id.toLowerCase() === value.target_command_id.toLowerCase()) {
    throw new Error("invalid settings reset cancel");
  }
  return { command_id: value.command_id, target_command_id: value.target_command_id };
}
type Fact = (value: unknown) => value is SavedCommandFact;

/**
 * A refusal of this attempt in one of two exact forms the core answers before any command handling, so no command fact
 * is written: 409 {"error":{"code":"CLIENT_INCOMPATIBLE"}} from the contract check (core api/app.py admit,
 * identity/origin.py) and 422 {"error":{"code":"VALIDATION_FAILED"}} from request parsing (api/app.py). It proves
 * nothing about earlier attempts of the same intent. Any other body, including a generic 409/422, stays a plain error.
 */
export class KnownRefusal extends ApiError {
  constructor(readonly refusal: "incompatible" | "command_refused", status: number, code: string) {
    super("http", status, code);
  }
}
function knownRefusal(reply: JsonReply): KnownRefusal | null {
  const value = reply.value;
  if (!record(value) || !exact(value, ["error"]) || !record(value.error) || !exact(value.error, ["code"])) return null;
  if (reply.status === 409 && value.error.code === "CLIENT_INCOMPATIBLE") return new KnownRefusal("incompatible", 409, "CLIENT_INCOMPATIBLE");
  if (reply.status === 422 && value.error.code === "VALIDATION_FAILED") return new KnownRefusal("command_refused", 422, "VALIDATION_FAILED");
  return null;
}

/** A command reply counts only with the complete current settings; an accepted fact must be the one we sent. */
function commandReply(reply: JsonReply, commandId: string, accepted: Fact): SettingSaveReply {
  const value = reply.value;
  if (record(value) && validSettingsCurrent(value.current) && version(value.state_version)) {
    const current = { current: withoutRetired(value.current), state_version: value.state_version };
    if (reply.status === 200 && accepted(value.command) && value.error == null) {
      return { ...current, outcome: "accepted", command: value.command };
    }
    const code = errorCode(value);
    if ([403, 409, 422].includes(reply.status) && record(value.command)
      && sameId(value.command.id, commandId) && value.command.status === "rejected" && code) {
      return { ...current, outcome: code === "COMMAND_PAYLOAD_MISMATCH" ? "mismatch" : "rejected",
        command: { id: value.command.id as string, status: "rejected" }, error: { code } };
    }
  }
  const refusal = knownRefusal(reply);
  if (refusal) throw refusal;
  if (!reply.ok) throw httpError(reply);
  throw new ApiError("invalid_response");
}
function statusReply(reply: JsonReply, profileId: string, commandId: string,
  accepted: Fact): SettingStatusReply {
  if (!reply.ok) throw httpError(reply);
  const value = reply.value;
  if (reply.status !== 200 || !record(value) || !record(value.command) || !version(value.state_version)
    || value.error != null) throw new ApiError("invalid_response");
  const fact = value.command;
  if (fact.status === "not_found" && sameId(fact.id, commandId)
    && validProfile(value.current) && sameId(value.current.profile_id, profileId)) {
    return { outcome: "not_found", command: { id: fact.id as string, status: "not_found" },
      current: value.current, state_version: value.state_version };
  }
  if (accepted(fact) && fact.status === "already_applied") {
    if (validSettingsCurrent(value.current)) return { outcome: "accepted", command: fact as StoredCommandFact,
      current: withoutRetired(value.current), state_version: value.state_version };
    if (record(value.current) && exact(value.current, ["status"]) && value.current.status === "unavailable") {
      return { outcome: "accepted", command: fact as StoredCommandFact,
        current: { status: "unavailable" }, state_version: value.state_version };
    }
  }
  throw new ApiError("invalid_response");
}

export function createSettingsApi(options: HttpOptions): SettingsApi {
  const request = createJsonTransport(options);
  return {
    async get(token) {
      if (!token) throw new Error("token is required");
      const reply = await request("/settings", { method: "GET", token });
      if (!reply.ok) throw httpError(reply);
      if (reply.status !== 200 || !record(reply.value) || !version(reply.value.state_version)
        || reply.value.error != null || !validSettingsCurrent(reply.value)) throw new ApiError("invalid_response");
      return withoutRetired(reply.value as SettingsResponse);
    },
    async save(token, proof, profileId, command) {
      requireSubject(token, profileId);
      if (!proof || !record(command) || !exact(command, ["command_id", "kind", "client_instance_id",
        "document_id", "expected_field_version", "payload"]) || !uuid(command.client_instance_id)
        || !uuid(command.document_id)) throw new Error("invalid setting command");
      const intent = snapshot({ command_id: command.command_id, kind: command.kind,
        expected_field_version: command.expected_field_version, payload: command.payload });
      const body = { ...intent, client_instance_id: command.client_instance_id, document_id: command.document_id };
      const reply = await request("/commands", { method: "POST", token, proof, body });
      return commandReply(reply, intent.command_id, (fact): fact is SavedCommandFact => acceptedFact(fact, profileId, intent));
    },
    async status(token, profileId, original, ticket: ReadbackTicket) {
      requireSubject(token, profileId);
      const intent = snapshot(original);
      const reply = await request(`/commands/${intent.command_id}`, { method: "GET", token, readbackTicket: ticket });
      return statusReply(reply, profileId, intent.command_id, (fact): fact is SavedCommandFact => acceptedFact(fact, profileId, intent));
    },
    async reset(token, proof, profileId, command) {
      requireSubject(token, profileId);
      if (!proof || !record(command) || !exact(command, ["command_id", "kind", "client_instance_id", "document_id", "payload"])
        || !uuid(command.client_instance_id) || !uuid(command.document_id)) throw new Error("invalid settings reset command");
      const intent = resetSnapshot({ command_id: command.command_id, kind: command.kind, payload: command.payload });
      // Only the epoch form is sent (I.5): a legacy intent without an epoch is never sent again (I.11.3 step 4, R-5).
      if (!("expected_reset_epoch" in intent.payload)) throw new Error("invalid settings reset command");
      const body = { ...intent, client_instance_id: command.client_instance_id, document_id: command.document_id };
      const reply = await request("/commands", { method: "POST", token, proof, body });
      return resetReply(reply, profileId, intent);
    },
    async resetStatus(token, profileId, original, ticket: ReadbackTicket) {
      requireSubject(token, profileId);
      const intent = resetSnapshot(original);
      // I.8: a reset ID is always read with include_refusal=true; only so is a stored refusal told from not_found.
      const reply = await request(`/commands/${intent.command_id}?include_refusal=true`, { method: "GET", token, readbackTicket: ticket });
      return resetStatusReply(reply, profileId, intent);
    },
    async resetCancel(token, proof, profileId, command) {
      requireSubject(token, profileId);
      if (!proof || !record(command) || !exact(command, ["command_id", "kind", "client_instance_id", "document_id", "payload"])
        || command.kind !== "settings.reset_cancel" || !uuid(command.client_instance_id) || !uuid(command.document_id)
        || !record(command.payload) || !exact(command.payload, ["target_command_id"])) throw new Error("invalid settings reset cancel");
      const intent = cancelSnapshot({ command_id: command.command_id, target_command_id: command.payload.target_command_id });
      const body = { command_id: intent.command_id, kind: "settings.reset_cancel", client_instance_id: command.client_instance_id,
        document_id: command.document_id, payload: { target_command_id: intent.target_command_id } };
      const reply = await request("/commands", { method: "POST", token, proof, body });
      return cancelReply(reply, intent);
    },
    async resetCancelStatus(token, profileId, original, ticket: ReadbackTicket) {
      requireSubject(token, profileId);
      const intent = cancelSnapshot(original);
      const reply = await request(`/commands/${intent.command_id}`, { method: "GET", token, readbackTicket: ticket });
      return cancelStatusReply(reply, profileId, intent);
    },
  };
}
