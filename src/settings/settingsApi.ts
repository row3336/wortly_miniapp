import type {
  ErrorDetail, MissingCommandFact, Profile, RejectedCommandFact, SavedCommandFact, SettingCommand,
  SettingsProjection, SettingsResetCommand, SettingsResponse, StoredCommandFact, UnavailableCurrent,
} from "../api/generated";
import { validProfile } from "../api/entryApi";
import { ApiError, createJsonTransport, errorCode, httpError, type HttpOptions, type JsonReply } from "../api/http";

// root decision (C+M-SET-READINESS-FIELDS, P12/P14): the server may still carry these two keys while an older
// build is deployed. They are skipped when decoding and never edited or sent from here.
export const retiredKeys = ["learning_poll_seconds", "learning_ready_percent"] as const;
// Every other key of the wire command is editable here, including review_error_mode and learning_content.
export type SettingKey = Exclude<SettingCommand["payload"]["key"], (typeof retiredKeys)[number]>;
/** As the wire carries it, possibly naming a retired key. */
export type SettingIntent = Pick<SettingCommand, "command_id" | "kind" | "expected_field_version" | "payload">;
/** An intent this build may create, keep as the pending slot and send. */
export type EditableSettingIntent = Omit<SettingIntent, "payload"> & {
  payload: Omit<SettingCommand["payload"], "key"> & { key: SettingKey };
};
/** The confirmed reset to the initial values (CT 6.2, TC 13.1); its payload is always empty. */
export type SettingsResetIntent = Pick<SettingsResetCommand, "command_id" | "kind" | "payload">;
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

export interface SettingsApi {
  get(token: string): Promise<SettingsResponse>;
  save(token: string, proof: string, profileId: string, command: SettingCommand): Promise<SettingSaveReply>;
  status(token: string, profileId: string, intent: SettingIntent): Promise<SettingStatusReply>;
  reset(token: string, proof: string, profileId: string, command: SettingsResetCommand): Promise<SettingSaveReply>;
  resetStatus(token: string, profileId: string, intent: SettingsResetIntent): Promise<SettingStatusReply>;
}

const integers = ["retry_gap", "retry_count", "learning_group_size", "learning_reminder_pause_seconds"] as const;
const booleans = ["learning_mix", "strict_case", "include_preterite", "include_comparative"] as const;
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

export function validSettingsCurrent(value: unknown): value is SettingsProjection {
  if (!record(value) || typeof value.needs_setup !== "boolean" || !record(value.settings)
    || !exactOrRetired(value.settings, [...keys, "time_zone"]) || !record(value.constraints)
    || !exactOrRetired(value.constraints, keys)) return false;
  for (const key of keys) {
    const setting = value.settings[key];
    if (!record(setting) || !version(setting.version) || !Object.hasOwn(setting, "value")
      || !constraint(key, value.constraints[key])) return false;
    // Language and required-choice settings are never null; every other setting may be unset.
    if (setting.value === null && key !== "ui_language" && key !== "dictionary_language" && !requiredChoice(key)) continue;
    if (!valueShape(key, setting.value)) return false;
  }
  const zone = value.settings.time_zone;
  return record(zone) && version(zone.version) && (zone.value === null || typeof zone.value === "string");
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
    && exact(value.payload, ["key", "value"]) && oneOf(value.payload.key, keys)
    && valueShape(value.payload.key, value.payload.value);
}

export function validSettingsResetIntent(value: unknown): value is SettingsResetIntent {
  return record(value) && exact(value, ["command_id", "kind", "payload"]) && uuid(value.command_id)
    && value.kind === "settings.reset" && record(value.payload) && exact(value.payload, []);
}

// The wire command may still name a retired key; only an editable one passes.
function snapshot(value: unknown): EditableSettingIntent {
  if (!validSettingIntent(value)) throw new Error("invalid setting intent");
  return structuredClone(value);
}
function resetSnapshot(value: unknown): SettingsResetIntent {
  if (!validSettingsResetIntent(value)) throw new Error("invalid settings reset intent");
  return { command_id: value.command_id, kind: value.kind, payload: {} };
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
    async status(token, profileId, original) {
      requireSubject(token, profileId);
      const intent = snapshot(original);
      const reply = await request(`/commands/${intent.command_id}`, { method: "GET", token });
      return statusReply(reply, profileId, intent.command_id, (fact): fact is SavedCommandFact => acceptedFact(fact, profileId, intent));
    },
    async reset(token, proof, profileId, command) {
      requireSubject(token, profileId);
      if (!proof || !record(command) || !exact(command, ["command_id", "kind", "client_instance_id", "document_id", "payload"])
        || !uuid(command.client_instance_id) || !uuid(command.document_id)) throw new Error("invalid settings reset command");
      const intent = resetSnapshot({ command_id: command.command_id, kind: command.kind, payload: command.payload });
      const body = { ...intent, client_instance_id: command.client_instance_id, document_id: command.document_id };
      const reply = await request("/commands", { method: "POST", token, proof, body });
      return commandReply(reply, intent.command_id, (fact): fact is SavedCommandFact => resetFact(fact, profileId, intent));
    },
    async resetStatus(token, profileId, original) {
      requireSubject(token, profileId);
      const intent = resetSnapshot(original);
      const reply = await request(`/commands/${intent.command_id}`, { method: "GET", token });
      return statusReply(reply, profileId, intent.command_id, (fact): fact is SavedCommandFact => resetFact(fact, profileId, intent));
    },
  };
}
