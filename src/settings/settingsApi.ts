import type {
  ErrorDetail, MissingCommandFact, Profile, RejectedCommandFact, SavedCommandFact, SettingCommand,
  SettingsProjection, SettingsResponse, StoredCommandFact, UnavailableCurrent,
} from "../api/generated";
import { validProfile } from "../api/entryApi";
import { ApiError, createJsonTransport, errorCode, httpError, type HttpOptions } from "../api/http";

// Keys this client edits. review_error_mode and learning_content are decoded
// strictly but have no editor here yet; their controls and explanations belong
// to a later UI package.
type ReadOnlySettingKey = "review_error_mode" | "learning_content";
export type SettingKey = Exclude<SettingCommand["payload"]["key"], ReadOnlySettingKey>;
export type EditableSettingPayload = SettingCommand["payload"] & { key: SettingKey };
export type SettingIntent = Pick<SettingCommand, "command_id" | "kind" | "expected_field_version"> & {
  payload: EditableSettingPayload;
};
/** The wire command this client sends; it never carries a read-only key. */
export type EditableSettingCommand = Omit<SettingCommand, "payload"> & { payload: EditableSettingPayload };
type Current = { current: SettingsProjection; state_version: string };
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
  save(token: string, proof: string, profileId: string, command: EditableSettingCommand): Promise<SettingSaveReply>;
  status(token: string, profileId: string, intent: SettingIntent): Promise<SettingStatusReply>;
}

const integers = ["retry_gap", "retry_count", "learning_group_size", "learning_poll_seconds",
  "learning_reminder_pause_seconds", "learning_ready_percent"] as const;
const booleans = ["learning_mix", "strict_case", "include_preterite", "include_comparative"] as const;
const languages = ["ru", "uk", "en"];
const levels = ["A1", "A2", "B1", "B2", "C1", "C2"];
const transitions = ["normal", "accelerated"];
// Always present and never null. K04-102: review_error_mode is strict initially;
// K04-105: learning_content is words initially and independent of learning_mix.
const readOnlyChoices: Record<ReadOnlySettingKey, readonly string[]> = {
  review_error_mode: ["strict", "soft"],
  learning_content: ["words", "phrases", "mixed"],
};
const readOnlyKeys = Object.keys(readOnlyChoices) as ReadOnlySettingKey[];
const keys: SettingKey[] = ["ui_language", "dictionary_language", ...integers, ...booleans,
  "learning_intervals_seconds", "transition_mode", "material"];

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
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
    || !exact(value.settings, [...keys, ...readOnlyKeys, "time_zone"]) || !record(value.constraints)
    || !exact(value.constraints, [...keys, ...readOnlyKeys])) return false;
  for (const key of readOnlyKeys) {
    const setting = value.settings[key], rule = value.constraints[key];
    if (!record(setting) || !version(setting.version) || !oneOf(setting.value, readOnlyChoices[key])
      || !record(rule) || rule.type !== "enum" || !choices(rule.values, readOnlyChoices[key])) return false;
  }
  for (const key of keys) {
    const setting = value.settings[key];
    if (!record(setting) || !version(setting.version) || !Object.hasOwn(setting, "value")
      || !constraint(key, value.constraints[key])) return false;
    if (setting.value === null && key !== "ui_language" && key !== "dictionary_language") continue;
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

export function validSettingIntent(value: unknown): value is SettingIntent {
  return record(value) && exact(value, ["command_id", "kind", "expected_field_version", "payload"])
    && uuid(value.command_id) && value.kind === "setting.save" && version(value.expected_field_version)
    && BigInt(value.expected_field_version) < 9223372036854775807n && record(value.payload)
    && exact(value.payload, ["key", "value"]) && oneOf(value.payload.key, keys)
    && valueShape(value.payload.key, value.payload.value);
}

function snapshot(value: SettingIntent): SettingIntent {
  if (!validSettingIntent(value)) throw new Error("invalid setting intent");
  return structuredClone(value);
}
function requireSubject(token: string, profileId: string): void {
  if (!token || !uuid(profileId)) throw new Error("invalid setting subject");
}
function acceptedFact(value: unknown, profileId: string, intent: SettingIntent): value is SavedCommandFact {
  return record(value) && sameId(value.id, intent.command_id) && value.kind === "setting.save"
    && oneOf(value.status, ["applied", "already_applied"]) && eventTime(value.applied_at)
    && sameId(value.target_id, profileId) && version(value.object_version)
    && value.object_version === String(BigInt(intent.expected_field_version) + 1n)
    && value.action_id === null && value.result_id === null && value.context_id === null;
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
      return reply.value as SettingsResponse;
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
      const value = reply.value;
      if (record(value) && validSettingsCurrent(value.current) && version(value.state_version)) {
        const current = { current: value.current, state_version: value.state_version };
        if (reply.status === 200 && acceptedFact(value.command, profileId, intent) && value.error == null) {
          return { ...current, outcome: "accepted", command: value.command };
        }
        const code = errorCode(value);
        if ([403, 409, 422].includes(reply.status) && record(value.command)
          && sameId(value.command.id, intent.command_id) && value.command.status === "rejected" && code) {
          return { ...current, outcome: code === "COMMAND_PAYLOAD_MISMATCH" ? "mismatch" : "rejected",
            command: { id: value.command.id as string, status: "rejected" }, error: { code } };
        }
      }
      if (!reply.ok) throw httpError(reply);
      throw new ApiError("invalid_response");
    },
    async status(token, profileId, original) {
      requireSubject(token, profileId);
      const intent = snapshot(original);
      const reply = await request(`/commands/${intent.command_id}`, { method: "GET", token });
      if (!reply.ok) throw httpError(reply);
      const value = reply.value;
      if (reply.status !== 200 || !record(value) || !record(value.command) || !version(value.state_version)
        || value.error != null) throw new ApiError("invalid_response");
      const fact = value.command;
      if (fact.status === "not_found" && sameId(fact.id, intent.command_id)
        && validProfile(value.current) && sameId(value.current.profile_id, profileId)) {
        return { outcome: "not_found", command: { id: fact.id as string, status: "not_found" },
          current: value.current, state_version: value.state_version };
      }
      if (acceptedFact(fact, profileId, intent) && fact.status === "already_applied") {
        if (validSettingsCurrent(value.current)) return { outcome: "accepted", command: fact as StoredCommandFact,
          current: value.current, state_version: value.state_version };
        if (record(value.current) && exact(value.current, ["status"]) && value.current.status === "unavailable") {
          return { outcome: "accepted", command: fact as StoredCommandFact,
            current: { status: "unavailable" }, state_version: value.state_version };
        }
      }
      throw new ApiError("invalid_response");
    },
  };
}
