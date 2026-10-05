import type {
  ErrorDetail, LearningCurrentProjection, LearningCurrentResponse, ManualSelectionCommand,
  MissingCommandFact, Profile, RejectedCommandFact, SavedCommandFact, StoredCommandFact,
  UnavailableCurrent,
} from "../api/generated";
import { validProfile } from "../api/entryApi";
import { ApiError, createJsonTransport, errorCode, httpError, type HttpOptions } from "../api/http";

export type ManualIntent = Pick<ManualSelectionCommand,
  "command_id" | "kind" | "expected_selection_version" | "payload">;

type Current = { current: LearningCurrentProjection; state_version: string };
export type ManualCommandReply = Current & (
  | { outcome: "accepted"; command: SavedCommandFact }
  | { outcome: "rejected" | "mismatch"; command: RejectedCommandFact; error: ErrorDetail }
);
export type ManualStatusReply = { state_version: string } & (
  | { outcome: "accepted"; command: StoredCommandFact; current: LearningCurrentProjection | UnavailableCurrent }
  | { outcome: "not_found"; command: MissingCommandFact; current: Profile }
);

export interface LearningApi {
  get(token: string): Promise<LearningCurrentResponse>;
  change(token: string, proof: string, command: ManualSelectionCommand): Promise<ManualCommandReply>;
  status(token: string, intent: ManualIntent): Promise<ManualStatusReply>;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function positive(value: unknown): value is number { return count(value) && value > 0; }
// The server's stored Learning debt; an absent value is invalid, not zero.
function recoveryRemaining(value: unknown): value is number { return count(value) && value <= 3; }
function pair(value: unknown): boolean { return value === "ru-de" || value === "uk-de" || value === "en-de"; }
function eventTime(value: unknown): boolean {
  if (typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|\+00:00)$/.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 19) === value.slice(0, 19);
}
function nullableTime(value: unknown): boolean { return value === null || eventTime(value); }
function oneOf(value: unknown, values: string[]): boolean {
  return typeof value === "string" && values.includes(value);
}

function validLearning(value: unknown): boolean {
  return record(value)
    && oneOf(value.status, ["preview", "ready", "waiting", "completed", "setup_required", "new_group", "no_material"])
    && count(value.ready) && count(value.preview) && nullableTime(value.next_due_at)
    && count(value.new_group_size) && count(value.manual_eligible) && count(value.automatic_eligible);
}

function orderedCards(value: unknown, order: string, valid: (row: Record<string, unknown>) => boolean): boolean {
  if (!Array.isArray(value)) return false;
  const seen = new Set<string>();
  let previous = 0;
  for (const item of value) {
    if (!record(item) || !uuid(item.card_id) || !positive(item[order]) || !valid(item)) return false;
    const position = item[order] as number;
    const id = item.card_id.toLowerCase();
    if (seen.has(id) || position <= previous) return false;
    seen.add(id);
    previous = position;
  }
  return true;
}

function validGroup(value: unknown): boolean {
  if (value === null) return true;
  if (!record(value) || !uuid(value.group_id) || !oneOf(value.status, ["assembling", "active"])
    || !eventTime(value.created_at) || !orderedCards(value.members, "introduction_order", row =>
      count(row.stage) && nullableTime(row.due_at) && recoveryRemaining(row.recovery_remaining)
      && oneOf(row.status, ["pending", "active", "completed", "skipped"])
      && version(row.version) && typeof row.available === "boolean"
      && typeof row.needs_preview === "boolean" && typeof row.ready === "boolean")) return false;
  const introduction = value.introduction;
  return introduction === null || record(introduction)
    && count(introduction.position) && version(introduction.version)
    && (introduction.next_card_id === null || uuid(introduction.next_card_id));
}

export function validLearningCurrent(value: unknown): value is LearningCurrentProjection {
  return record(value) && pair(value.pair) && validLearning(value.learning)
    && validGroup(value.group) && version(value.manual_selection_version)
    && orderedCards(value.manual_selection, "position", row =>
      version(row.version) && typeof row.eligible === "boolean");
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

export function validManualIntent(value: unknown): value is ManualIntent {
  return record(value) && uuid(value.command_id)
    && oneOf(value.kind, ["learning.select", "learning.unselect"])
    && version(value.expected_selection_version) && record(value.payload)
    && exactKeys(value.payload, ["card_id", "expected_pair"])
    && uuid(value.payload.card_id) && pair(value.payload.expected_pair);
}

function snapshotIntent(value: ManualIntent): ManualIntent {
  if (!validManualIntent(value)) throw new Error("invalid manual intent");
  return { command_id: value.command_id, kind: value.kind,
    expected_selection_version: value.expected_selection_version, payload: { ...value.payload } };
}

function acceptedFact(value: unknown, intent: ManualIntent): value is SavedCommandFact {
  return record(value) && sameId(value.id, intent.command_id) && value.kind === intent.kind
    && oneOf(value.status, ["applied", "already_applied"]) && eventTime(value.applied_at)
    && sameId(value.target_id, intent.payload.card_id) && version(value.object_version)
    && value.action_id === null && value.result_id === null && value.context_id === null;
}

function requireToken(token: string): void {
  if (!token) throw new Error("token is required");
}

export function createLearningApi(options: HttpOptions): LearningApi {
  const request = createJsonTransport(options);
  return {
    async get(token) {
      requireToken(token);
      const reply = await request("/learning/current", { method: "GET", token });
      if (!reply.ok) throw httpError(reply);
      if (!record(reply.value) || !version(reply.value.state_version) || !validLearningCurrent(reply.value)) {
        throw new ApiError("invalid_response");
      }
      return reply.value as LearningCurrentResponse;
    },
    async change(token, proof, command) {
      requireToken(token);
      if (!proof) throw new Error("proof is required");
      const intent = snapshotIntent(command);
      if (!record(command) || !uuid(command.client_instance_id) || !uuid(command.document_id)
        || !exactKeys(command, ["command_id", "kind", "client_instance_id", "document_id",
          "expected_selection_version", "payload"])) throw new Error("invalid manual command");
      const body = { ...intent, client_instance_id: command.client_instance_id, document_id: command.document_id };
      const reply = await request("/commands", { method: "POST", token, proof, body });
      const value = reply.value;
      if (record(value) && validLearningCurrent(value.current) && version(value.state_version)) {
        const current = { current: value.current, state_version: value.state_version };
        if (reply.status === 200 && acceptedFact(value.command, intent) && value.error == null) {
          return { ...current, outcome: "accepted", command: value.command };
        }
        const code = errorCode(value);
        if ([403, 409, 422].includes(reply.status) && record(value.command)
          && sameId(value.command.id, intent.command_id) && value.command.status === "rejected" && code) {
          // A reused ID with different content may already have an accepted fact.
          return { ...current, outcome: code === "COMMAND_PAYLOAD_MISMATCH" ? "mismatch" : "rejected",
            command: { id: value.command.id as string, status: "rejected" }, error: { code } };
        }
      }
      if (!reply.ok) throw httpError(reply);
      throw new ApiError("invalid_response");
    },
    async status(token, original) {
      requireToken(token);
      const intent = snapshotIntent(original);
      const reply = await request(`/commands/${intent.command_id}`, { method: "GET", token });
      if (!reply.ok) throw httpError(reply);
      const value = reply.value;
      if (reply.status !== 200 || !record(value) || !record(value.command)
        || !version(value.state_version) || value.error != null) {
        throw new ApiError("invalid_response");
      }
      const fact = value.command;
      if (fact.status === "not_found" && sameId(fact.id, intent.command_id)
        && validProfile(value.current) && uuid(value.current.profile_id)) {
        return { outcome: "not_found", command: { id: fact.id as string, status: "not_found" },
          current: value.current, state_version: value.state_version };
      }
      if (acceptedFact(fact, intent) && fact.status === "already_applied") {
        if (validLearningCurrent(value.current)) {
          return { outcome: "accepted", command: fact as StoredCommandFact,
            current: value.current, state_version: value.state_version };
        }
        if (record(value.current) && value.current.status === "unavailable") {
          return { outcome: "accepted", command: fact as StoredCommandFact,
            current: { status: "unavailable" }, state_version: value.state_version };
        }
      }
      throw new ApiError("invalid_response");
    },
  };
}
