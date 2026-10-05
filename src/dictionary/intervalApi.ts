import type {
  ClosedDictionaryContext, DictionaryCardStudy, DictionaryCardView, DictionaryContextInterval,
  ErrorDetail, MissingCommandFact, OpenDictionaryContext, Profile, RejectedCommandFact,
  SavedCommandFact, StoredCommandFact, UnavailableCurrent,
} from "../api/generated";
import { validProfile } from "../api/entryApi";
import { ApiError, createJsonTransport, errorCode, httpError, type HttpOptions } from "../api/http";
import { count, date, eventTime, exactKeys, oneOf, record, sameId, uuid, version } from "../api/wireValidation";
import { validDictionaryView } from "./viewApi";

type Direction = "l1-de" | "de-l1";
type Pair = "ru-de" | "uk-de" | "en-de";
const directions: Direction[] = ["l1-de", "de-l1"];
const pairs: Pair[] = ["ru-de", "uk-de", "en-de"];
// Command integers are PositiveInteger on the wire (core api/models.py).
const maxInteger = 2147483647;

export type DictionaryContextCurrent = OpenDictionaryContext | ClosedDictionaryContext | UnavailableCurrent;
export type DictionaryContextRead = { current: DictionaryContextCurrent; state_version: string };

/** Intents follow the service fingerprint; card_id of close/undo only binds the reply, it is not sent. */
export type ContextOpenIntent = { kind: "context.open"; command_id: string; card_id: string };
export type ContextCloseIntent = { kind: "context.close"; command_id: string; context_id: string; card_id: string };
export type IntervalSelectionIntent = {
  direction: Direction; expected_progress_version: string | null;
  option_id: number; interval_days: number; next_due_date: string;
};
export type IntervalIncreaseIntent = {
  kind: "interval.increase"; command_id: string; context_id: string; card_id: string;
  expected_pair: Pair; expected_local_date: string; selections: IntervalSelectionIntent[];
};
export type ActionUndoIntent = {
  kind: "action.undo"; command_id: string; context_id: string; card_id: string;
  action_id: string; expected_action_version: string;
};
export type DictionaryIntervalIntent = ContextOpenIntent | ContextCloseIntent | IntervalIncreaseIntent | ActionUndoIntent;
export type DictionaryOrigin = { client_instance_id: string; document_id: string };
export type DictionaryIntervalCommand<T extends DictionaryIntervalIntent = DictionaryIntervalIntent> = T & DictionaryOrigin;
export type DictionaryContextAddress = DictionaryOrigin & { context_id: string; card_id: string };
export type IntervalChoice = { direction: Direction; option_id: number };

export type DictionaryCommandReply = DictionaryContextRead & (
  | { outcome: "accepted"; command: SavedCommandFact }
  | { outcome: "rejected" | "mismatch"; command: RejectedCommandFact; error: ErrorDetail }
);
export type DictionaryCommandStatus =
  | { outcome: "accepted"; command: StoredCommandFact; current: DictionaryContextCurrent; state_version: string }
  | { outcome: "not_found"; command: MissingCommandFact; current: Profile; state_version: string }
  | { outcome: "mismatch"; error: { code: "COMMAND_PAYLOAD_MISMATCH" } };

/**
 * One request per call, never repeated. A thrown local Error means nothing was sent;
 * an ApiError after a command POST is resolved by commandStatus (commandOutcomeUnknown).
 */
export interface DictionaryIntervalApi {
  openContext(token: string, proof: string, command: DictionaryIntervalCommand<ContextOpenIntent>): Promise<DictionaryCommandReply>;
  closeContext(token: string, proof: string, command: DictionaryIntervalCommand<ContextCloseIntent>): Promise<DictionaryCommandReply>;
  increase(token: string, proof: string, command: DictionaryIntervalCommand<IntervalIncreaseIntent>): Promise<DictionaryCommandReply>;
  undo(token: string, proof: string, command: DictionaryIntervalCommand<ActionUndoIntent>): Promise<DictionaryCommandReply>;
  readContext(token: string, proof: string, address: DictionaryContextAddress): Promise<DictionaryContextRead>;
  commandStatus(token: string, proof: string, command: DictionaryIntervalCommand): Promise<DictionaryCommandStatus>;
}

function calendarDate(value: unknown): value is string {
  return date(value) && !value.startsWith("0000");
}
function positive(value: unknown): value is number {
  return count(value) && value >= 1 && value <= maxInteger;
}
function addDays(day: string, days: number): string {
  const due = new Date(`${day}T00:00:00.000Z`);
  due.setUTCDate(due.getUTCDate() + days);
  return Number.isNaN(due.getTime()) ? "" : due.toISOString().slice(0, 10);
}
function unavailable(value: unknown): value is UnavailableCurrent {
  return record(value) && exactKeys(value, ["status"]) && value.status === "unavailable";
}
function listOf<T>(value: unknown, valid: (item: unknown) => item is T): value is T[] {
  if (!Array.isArray(value)) return false;
  // Unlike Array.every, iteration visits holes.
  for (const item of value) if (!valid(item)) return false;
  return true;
}

const optionKeys = ["option_id", "interval_days", "next_due_date"];

/** Offered steps only grow and keep the server's date arithmetic; no review formula here. */
function validOptions(value: unknown, currentDays: number, localDate: string): boolean {
  if (!Array.isArray(value)) return false;
  let lastOption = 0;
  let lastDays = currentDays;
  for (const option of value) {
    if (!record(option) || !exactKeys(option, optionKeys) || !positive(option.option_id) || option.option_id <= lastOption
      || !positive(option.interval_days) || option.interval_days <= lastDays
      || option.next_due_date !== addDays(localDate, option.interval_days)) return false;
    lastOption = option.option_id;
    lastDays = option.interval_days;
  }
  return true;
}

/** Same facts as the accepted E06.8 view (core dictionary_interval._interval_direction). */
function validDirection(value: unknown, index: number, study: DictionaryCardStudy, localDate: string): boolean {
  const fact = study.directions[index];
  if (!record(value) || !exactKeys(value, ["direction", "applicable", "current_schedule", "expected_progress_version", "options"])
    || value.direction !== directions[index] || fact.direction !== directions[index]
    || !Array.isArray(value.options)) return false;
  const suppressed = study.facts.exclusion.excluded || study.facts.learning.current !== null;
  const applicable = fact.introduced && !suppressed;
  if (value.applicable !== applicable) return false;
  if (!applicable) {
    return value.current_schedule === null && value.expected_progress_version === null && value.options.length === 0;
  }
  const schedule = value.current_schedule;
  if (!record(schedule) || !exactKeys(schedule, ["interval_days", "next_due_date", "persisted"])
    || schedule.persisted !== fact.progress_present) return false;
  if (!fact.progress_present) {
    // ILC A01: without a saved row the initial state is shown, due today; null is the only version.
    return value.expected_progress_version === null && schedule.interval_days === 1
      && schedule.next_due_date === localDate && validOptions(value.options, 1, localDate);
  }
  const saved = fact.schedule;
  const preview = fact.interval_preview;
  if (saved === null || preview === null || !version(value.expected_progress_version)
    || value.expected_progress_version !== fact.progress_version
    || schedule.interval_days !== saved.interval_days || schedule.next_due_date !== saved.next_due_date
    || !validOptions(value.options, saved.interval_days, localDate) || value.options.length !== preview.length) return false;
  const options = value.options as Record<string, unknown>[];
  return preview.every((step, position) => options[position].option_id === step.step_id
    && options[position].interval_days === step.interval_days && options[position].next_due_date === step.next_due_date);
}

function validInterval(value: unknown, view: DictionaryCardView | UnavailableCurrent): value is DictionaryContextInterval | null {
  if (view.status !== "available" || view.study.local_date === null) return value === null;
  const study = view.study;
  const localDate = study.local_date as string;
  if (!record(value) || !exactKeys(value, ["local_date", "expected_pair", "directions"])
    || value.local_date !== localDate || value.expected_pair !== study.pair
    || !Array.isArray(value.directions) || value.directions.length !== 2) return false;
  for (let index = 0; index < 2; index += 1) {
    if (!validDirection(value.directions[index], index, study, localDate)) return false;
  }
  return true;
}

function validCapabilities(value: unknown, interval: DictionaryContextInterval | null, contextId: string): boolean {
  if (!record(value) || !exactKeys(value, ["interval_increase", "undo_target"])) return false;
  // K07-063: only directions with offered steps; none means no operation at all.
  const offered = (interval?.directions ?? []).filter(item => item.options.length > 0).map(item => item.direction);
  const increase = value.interval_increase;
  if (offered.length === 0) {
    if (increase !== null) return false;
  } else if (!record(increase) || !exactKeys(increase, ["directions"]) || !Array.isArray(increase.directions)
    || increase.directions.length !== offered.length
    || offered.some((direction, index) => (increase.directions as unknown[])[index] !== direction)) return false;
  const undo = value.undo_target;
  return undo === null || (record(undo) && exactKeys(undo, ["action_id", "kind", "version", "context_id"])
    && uuid(undo.action_id) && undo.kind === "interval.increase" && version(undo.version)
    && sameId(undo.context_id, contextId));
}

/**
 * Strict context union (core dictionary_interval.context_projection). A bound ID must match;
 * the nested view is checked by the accepted E06.8 validator under the same state_version.
 */
export function validDictionaryContextCurrent(
  value: unknown, stateVersion: string, binding: { context_id?: string; card_id?: string },
): value is DictionaryContextCurrent {
  if (unavailable(value)) return true;
  if (!record(value) || !record(value.context) || !exactKeys(value.context, ["id", "kind", "card_id"])
    || !uuid(value.context.id) || value.context.kind !== "dictionary" || !uuid(value.context.card_id)
    || (binding.context_id !== undefined && !sameId(value.context.id, binding.context_id))
    || (binding.card_id !== undefined && !sameId(value.context.card_id, binding.card_id))) return false;
  if (value.status === "closed") return exactKeys(value, ["status", "context"]);
  if (value.status !== "open" || !exactKeys(value, ["status", "context", "view", "interval", "capabilities"])
    || !validDictionaryView({ state_version: stateVersion, current: value.view }, value.context.card_id)) return false;
  const view = value.view as DictionaryCardView | UnavailableCurrent;
  return validInterval(value.interval, view)
    && validCapabilities(value.capabilities, value.interval as DictionaryContextInterval | null, value.context.id);
}

function validSelection(value: unknown): value is IntervalSelectionIntent {
  return record(value) && exactKeys(value, ["direction", "expected_progress_version", "option_id", "interval_days", "next_due_date"])
    && oneOf(value.direction, directions)
    && (value.expected_progress_version === null || version(value.expected_progress_version))
    && positive(value.option_id) && positive(value.interval_days) && calendarDate(value.next_due_date);
}

export function validDictionaryIntervalIntent(value: unknown): value is DictionaryIntervalIntent {
  if (!record(value) || !uuid(value.command_id)) return false;
  switch (value.kind) {
    case "context.open":
      return exactKeys(value, ["kind", "command_id", "card_id"]) && uuid(value.card_id);
    case "context.close":
      return exactKeys(value, ["kind", "command_id", "context_id", "card_id"]) && uuid(value.context_id) && uuid(value.card_id);
    case "action.undo":
      return exactKeys(value, ["kind", "command_id", "context_id", "card_id", "action_id", "expected_action_version"])
        && uuid(value.context_id) && uuid(value.card_id) && uuid(value.action_id) && version(value.expected_action_version);
    case "interval.increase": {
      if (!exactKeys(value, ["kind", "command_id", "context_id", "card_id", "expected_pair", "expected_local_date", "selections"])
        || !uuid(value.context_id) || !uuid(value.card_id) || !oneOf(value.expected_pair, pairs)
        || !calendarDate(value.expected_local_date) || !listOf(value.selections, validSelection)
        || value.selections.length < 1 || value.selections.length > 2) return false;
      return new Set(value.selections.map(selection => selection.direction)).size === value.selections.length;
    }
    default:
      return false;
  }
}

/** Detached copy with lower-case UUIDs, as core str(UUID) fingerprints them. */
function copyIntent(value: DictionaryIntervalIntent): DictionaryIntervalIntent {
  if (!validDictionaryIntervalIntent(value)) throw new Error("invalid dictionary interval intent");
  const id = (text: string) => text.toLowerCase();
  switch (value.kind) {
    case "context.open":
      return { kind: value.kind, command_id: id(value.command_id), card_id: id(value.card_id) };
    case "context.close":
      return { kind: value.kind, command_id: id(value.command_id), context_id: id(value.context_id), card_id: id(value.card_id) };
    case "action.undo":
      return { kind: value.kind, command_id: id(value.command_id), context_id: id(value.context_id),
        card_id: id(value.card_id), action_id: id(value.action_id), expected_action_version: value.expected_action_version };
    case "interval.increase":
      return { kind: value.kind, command_id: id(value.command_id), context_id: id(value.context_id),
        card_id: id(value.card_id), expected_pair: value.expected_pair, expected_local_date: value.expected_local_date,
        selections: value.selections.map(selection => ({ direction: selection.direction,
          expected_progress_version: selection.expected_progress_version, option_id: selection.option_id,
          interval_days: selection.interval_days, next_due_date: selection.next_due_date })) };
  }
}

/** Service payload of core DictionaryIntervalService: values as strings, selections ordered by direction. */
function fingerprintPayload(intent: DictionaryIntervalIntent): Record<string, unknown> {
  switch (intent.kind) {
    case "context.open":
      return { card_id: intent.card_id, source: { kind: "dictionary" } };
    case "context.close":
      return { context_id: intent.context_id };
    case "action.undo":
      return { context_id: intent.context_id, action_id: intent.action_id,
        expected_action_version: intent.expected_action_version };
    case "interval.increase":
      return { context_id: intent.context_id, card_id: intent.card_id, expected_pair: intent.expected_pair,
        expected_local_date: intent.expected_local_date,
        selections: [...intent.selections].sort((a, b) => (a.direction < b.direction ? -1 : 1)).map(selection => ({
          direction: selection.direction, expected_progress_version: selection.expected_progress_version,
          option_id: String(selection.option_id), interval_days: String(selection.interval_days),
          next_due_date: selection.next_due_date })) };
  }
}

/** json.dumps(sort_keys=True, separators=(",", ":")); payload strings are ASCII. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (record(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Matches core identity.intent_hash(kind, payload); origin and command ID are not part of it. */
export async function dictionaryIntervalIntentHash(value: DictionaryIntervalIntent): Promise<string> {
  const intent = copyIntent(value);
  const text = canonical({ kind: intent.kind, payload: fingerprintPayload(intent) });
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

/** The confirmed increase is built only from the server's offer; versions and dates are never computed. */
export function dictionaryIncreaseIntent(
  current: DictionaryContextCurrent, commandId: string, choices: IntervalChoice[],
): IntervalIncreaseIntent {
  if (current.status !== "open" || current.interval === null || current.capabilities.interval_increase === null) {
    throw new Error("interval increase is not offered");
  }
  const interval = current.interval;
  const offered = current.capabilities.interval_increase.directions;
  if (!Array.isArray(choices) || choices.length < 1 || choices.length > 2) throw new Error("invalid interval choice");
  const seen = new Set<string>();
  const selections = choices.map(choice => {
    if (!record(choice) || !exactKeys(choice, ["direction", "option_id"]) || !offered.includes(choice.direction)
      || seen.has(choice.direction)) throw new Error("direction is not offered");
    seen.add(choice.direction);
    const direction = interval.directions.find(item => item.direction === choice.direction);
    const option = direction?.options.find(item => item.option_id === choice.option_id);
    if (!direction || !option) throw new Error("option is not offered");
    return { direction: direction.direction, expected_progress_version: direction.expected_progress_version,
      option_id: option.option_id, interval_days: option.interval_days, next_due_date: option.next_due_date };
  });
  return copyIntent({ kind: "interval.increase", command_id: commandId, context_id: current.context.id,
    card_id: current.context.card_id, expected_pair: interval.expected_pair,
    expected_local_date: interval.local_date, selections }) as IntervalIncreaseIntent;
}

/** Undo addresses exactly the server's current undo_target of this open context. */
export function dictionaryUndoIntent(current: DictionaryContextCurrent, commandId: string): ActionUndoIntent {
  if (current.status !== "open" || current.capabilities.undo_target === null) throw new Error("undo is not offered");
  const target = current.capabilities.undo_target;
  return copyIntent({ kind: "action.undo", command_id: commandId, context_id: current.context.id,
    card_id: current.context.card_id, action_id: target.action_id,
    expected_action_version: target.version }) as ActionUndoIntent;
}

/** After a command POST only an HTTP refusal proves no fact; any other failure needs commandStatus. */
export function commandOutcomeUnknown(error: unknown): boolean {
  return error instanceof ApiError && (error.kind !== "http" || error.status === undefined || error.status >= 500);
}

function prepareCommand(token: string, proof: string, value: DictionaryIntervalCommand, kind?: string): DictionaryIntervalCommand {
  if (typeof token !== "string" || !token || typeof proof !== "string" || !proof || !record(value)
    || (kind !== undefined && value.kind !== kind)) throw new Error("invalid dictionary interval command");
  const { client_instance_id: clientId, document_id: documentId, ...rest } = value as Record<string, unknown>;
  if (!uuid(clientId) || !uuid(documentId)) throw new Error("invalid dictionary interval command");
  return { ...copyIntent(rest as DictionaryIntervalIntent), client_instance_id: clientId.toLowerCase(), document_id: documentId.toLowerCase() };
}

function prepareAddress(token: string, proof: string, value: DictionaryContextAddress): DictionaryContextAddress {
  if (typeof token !== "string" || !token || typeof proof !== "string" || !proof || !record(value)
    || !exactKeys(value, ["context_id", "card_id", "client_instance_id", "document_id"])
    || !uuid(value.context_id) || !uuid(value.card_id) || !uuid(value.client_instance_id) || !uuid(value.document_id)) {
    throw new Error("invalid dictionary context address");
  }
  return { context_id: value.context_id.toLowerCase(), card_id: value.card_id.toLowerCase(),
    client_instance_id: value.client_instance_id.toLowerCase(), document_id: value.document_id.toLowerCase() };
}

function wireBody(command: DictionaryIntervalCommand): object {
  const head = { command_id: command.command_id, kind: command.kind,
    client_instance_id: command.client_instance_id, document_id: command.document_id };
  switch (command.kind) {
    case "context.open":
      return { ...head, payload: { card_id: command.card_id, source: { kind: "dictionary" } } };
    case "context.close":
      return { ...head, context_id: command.context_id, payload: {} };
    case "action.undo":
      return { ...head, context_id: command.context_id, action_id: command.action_id,
        expected_action_version: command.expected_action_version, payload: {} };
    case "interval.increase":
      return { ...head, context_id: command.context_id,
        expected_progress_versions: command.selections.map(selection => ({
          direction: selection.direction, version: selection.expected_progress_version })),
        payload: { card_id: command.card_id, expected_pair: command.expected_pair,
          expected_local_date: command.expected_local_date,
          selections: command.selections.map(selection => ({ direction: selection.direction,
            option_id: selection.option_id, interval_days: selection.interval_days,
            next_due_date: selection.next_due_date })) } };
  }
}

const factKeys = ["id", "kind", "status", "applied_at", "target_id", "action_id", "result_id", "context_id", "object_version"];

/** Fact references per kind (core coordinator._fact and DictionaryIntervalService handlers). */
function acceptedFact(value: unknown, intent: DictionaryIntervalIntent, statuses: string[]): value is SavedCommandFact {
  if (!record(value) || !exactKeys(value, factKeys) || !sameId(value.id, intent.command_id) || value.kind !== intent.kind
    || !oneOf(value.status, statuses) || !eventTime(value.applied_at) || value.result_id !== null
    || !sameId(value.target_id, intent.card_id)) return false;
  switch (intent.kind) {
    case "context.open":
      return uuid(value.context_id) && value.action_id === null && value.object_version === null;
    case "context.close":
      return sameId(value.context_id, intent.context_id) && value.action_id === null && value.object_version === null;
    case "interval.increase":
      return sameId(value.context_id, intent.context_id) && uuid(value.action_id) && value.object_version === "1";
    case "action.undo":
      return sameId(value.context_id, intent.context_id) && sameId(value.action_id, intent.action_id)
        && value.object_version === String(BigInt(intent.expected_action_version) + 1n);
  }
}

/** A new context is addressed by its fact; a closed context ID is never reopened (N22). */
function factCurrent(value: unknown, stateVersion: string, intent: DictionaryIntervalIntent,
  fact: SavedCommandFact): value is DictionaryContextCurrent {
  const contextId = intent.kind === "context.open" ? fact.context_id as string : intent.context_id;
  return validDictionaryContextCurrent(value, stateVersion, { context_id: contextId, card_id: intent.card_id })
    && !(intent.kind === "context.close" && record(value) && value.status === "open");
}

export function createDictionaryIntervalApi(options: HttpOptions): DictionaryIntervalApi {
  const request = createJsonTransport(options);

  async function send(token: string, proof: string, original: DictionaryIntervalCommand, kind: DictionaryIntervalIntent["kind"]): Promise<DictionaryCommandReply> {
    // Detached before the first await: later caller mutation cannot change the sent intent.
    const command = prepareCommand(token, proof, original, kind);
    const reply = await request("/commands", { method: "POST", token, proof, body: wireBody(command) });
    const value = reply.value;
    if (record(value) && version(value.state_version)) {
      const stateVersion = value.state_version;
      if (reply.status === 200 && value.error == null
        && exactKeys(value, ["command", "current", "state_version", ...(Object.hasOwn(value, "error") ? ["error"] : [])])
        && acceptedFact(value.command, command, ["applied", "already_applied"])
        && factCurrent(value.current, stateVersion, command, value.command)) {
        return { outcome: "accepted", command: value.command, current: value.current, state_version: stateVersion };
      }
      const code = errorCode(value);
      // An open refusal may show the context of an earlier command with this ID (mismatch).
      const binding = command.kind === "context.open" ? {} : { context_id: command.context_id, card_id: command.card_id };
      if ([403, 409, 422].includes(reply.status) && code && exactKeys(value, ["command", "current", "state_version", "error"])
        && record(value.error) && exactKeys(value.error, ["code"])
        && record(value.command) && exactKeys(value.command, ["id", "status"])
        && sameId(value.command.id, command.command_id) && value.command.status === "rejected"
        && validDictionaryContextCurrent(value.current, stateVersion, binding)) {
        return { outcome: code === "COMMAND_PAYLOAD_MISMATCH" ? "mismatch" : "rejected",
          command: { id: command.command_id, status: "rejected" }, error: { code },
          current: value.current, state_version: stateVersion };
      }
    }
    if (!reply.ok) throw httpError(reply);
    // HTTP 200 with an error or a foreign shape is never a success.
    throw new ApiError("invalid_response");
  }

  return {
    openContext: (token, proof, command) => send(token, proof, command, "context.open"),
    closeContext: (token, proof, command) => send(token, proof, command, "context.close"),
    increase: (token, proof, command) => send(token, proof, command, "interval.increase"),
    undo: (token, proof, command) => send(token, proof, command, "action.undo"),

    async readContext(token, proof, original) {
      const address = prepareAddress(token, proof, original);
      const parameters = new URLSearchParams({ client_instance_id: address.client_instance_id, document_id: address.document_id });
      const reply = await request(`/dictionary/contexts/${address.context_id}?${parameters}`, { method: "GET", token, proof });
      if (!reply.ok) throw httpError(reply);
      const value = reply.value;
      // An unrecognized document is an opaque unavailable context, not readiness.
      if (reply.status !== 200 || !record(value) || !exactKeys(value, ["current", "state_version"])
        || !version(value.state_version) || !validDictionaryContextCurrent(value.current, value.state_version,
          { context_id: address.context_id, card_id: address.card_id })) throw new ApiError("invalid_response");
      return { current: value.current, state_version: value.state_version };
    },

    async commandStatus(token, proof, original) {
      const command = prepareCommand(token, proof, original);
      const { client_instance_id: clientId, document_id: documentId, ...intent } = command as Record<string, unknown>;
      const expectedHash = await dictionaryIntervalIntentHash(intent as DictionaryIntervalIntent);
      const parameters = new URLSearchParams({ client_instance_id: clientId as string, document_id: documentId as string,
        expected_intent_hash: expectedHash });
      const reply = await request(`/commands/${command.command_id}?${parameters}`, { method: "GET", token, proof });
      const value = reply.value;
      if (reply.status === 409 && record(value) && exactKeys(value, ["error"]) && record(value.error)
        && exactKeys(value.error, ["code"]) && value.error.code === "COMMAND_PAYLOAD_MISMATCH") {
        return { outcome: "mismatch", error: { code: "COMMAND_PAYLOAD_MISMATCH" } };
      }
      if (!reply.ok) throw httpError(reply);
      if (reply.status !== 200 || !record(value) || !version(value.state_version) || !record(value.command)) {
        throw new ApiError("invalid_response");
      }
      const fact = value.command;
      if (fact.status === "not_found") {
        if (exactKeys(value, ["command", "current", "state_version"]) && exactKeys(fact, ["id", "status"])
          && sameId(fact.id, command.command_id) && validProfile(value.current) && uuid(value.current.profile_id)
          && exactKeys(value.current, ["profile_id", "access", "role", "ui_language", "dictionary_language", "time_zone", "state_version"])
          && record(value.current.access) && exactKeys(value.current.access, ["status", "version", "reason"])) {
          return { outcome: "not_found", command: { id: command.command_id, status: "not_found" },
            current: value.current, state_version: value.state_version };
        }
        throw new ApiError("invalid_response");
      }
      // The ID alone cannot tell this intent from another payload; the server echoes the verified hash.
      if (exactKeys(value, ["command", "current", "state_version", "verified_intent_hash"])
        && value.verified_intent_hash === expectedHash && acceptedFact(fact, command, ["already_applied"])
        && factCurrent(value.current, value.state_version, command, fact)) {
        return { outcome: "accepted", command: fact as StoredCommandFact, current: value.current,
          state_version: value.state_version };
      }
      throw new ApiError("invalid_response");
    },
  };
}
