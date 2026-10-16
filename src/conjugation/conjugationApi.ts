import type { ClosedSessionBoundary, ConjugationCatalog, ConjugationCatalogResponse, ConjugationSessionProjection,
  ErrorDetail, MissingCommandFact, Profile, RejectedCommandFact, SavedCommandFact, StoredCommandFact,
  UnavailableCurrent, UnavailableSession } from "../api/generated";
import { validExactProfile } from "../api/entryApi";
import { ApiError, createJsonTransport, errorCode, httpError, type HttpOptions } from "../api/http";
import { attemptRefusal } from "../commands/commandRefusal";
import { eventTime, exactKeys, oneOf, record, sameId, uuid, validClosedSessionBoundary, version } from "../api/wireValidation";
import { validUndoFact } from "../commands/resultUndo";
import { conjugationIntentHash, copyConjugationIntent, validConjugationIntent, type ConjugationCommand,
  type ConjugationResultCommand, type ConjugationScheduleTransportCommand, type ConjugationSessionCommand } from "./conjugationIntent";
import { conjugationResultCurrent, validConjugationCatalog, validConjugationCurrent, type ConjugationResultCurrent } from "./conjugationProjection";
import type { ReadbackTicket } from "../commands/writeGate";
import type { LostAddress } from "../commands/lostEnvelope";
export type { ConjugationCommand, ConjugationIntent, ConjugationResultCommand,
  ConjugationScheduleTransportCommand, ConjugationSessionCommand } from "./conjugationIntent";

export type ConjugationSessionAddress = { session_id: string; client_instance_id: string; document_id: string };
export type ConjugationResultAddress = ConjugationSessionAddress & { assignment_id: string; result_id: string };
export type ConjugationCatalogRead = ConjugationCatalogResponse;
export type ConjugationSessionRead = { current: ConjugationSessionProjection | UnavailableSession; state_version: string };
export type ConjugationResultRead = ConjugationResultCurrent & { state_version: string };
type Read = ConjugationCatalogRead | ConjugationSessionRead | ConjugationResultRead;
type Outcome = { outcome: "accepted"; command: SavedCommandFact }
  | { outcome: "rejected" | "mismatch"; command: RejectedCommandFact; error: ErrorDetail };
export type ConjugationCatalogReply = ConjugationCatalogRead & Outcome;
export type ConjugationSessionReply = ConjugationSessionRead & Outcome;
export type ConjugationResultReply = ConjugationResultRead & Outcome;
export type ConjugationReply = ConjugationCatalogReply | ConjugationSessionReply | ConjugationResultReply;
type MissingStatus = { outcome: "not_found"; command: MissingCommandFact; current: Profile;
  state_version: string; closed_session?: ClosedSessionBoundary };
type AcceptedStatus = { outcome: "accepted"; command: StoredCommandFact; state_version: string };
export type ConjugationCatalogStatus = MissingStatus | (AcceptedStatus & { current: ConjugationCatalog | UnavailableCurrent });
export type ConjugationSessionStatus = MissingStatus | (AcceptedStatus & {
  current: ConjugationSessionProjection | UnavailableSession | UnavailableCurrent });
export type ConjugationResultStatus = MissingStatus | (AcceptedStatus & ConjugationResultCurrent);
export type ConjugationStatus = ConjugationCatalogStatus | ConjugationSessionStatus | ConjugationResultStatus;
export interface ConjugationApi {
  catalog(token: string): Promise<ConjugationCatalogRead>;
  read(token: string, proof: string, address: ConjugationResultAddress): Promise<ConjugationResultRead>;
  read(token: string, proof: string, address: ConjugationSessionAddress): Promise<ConjugationSessionRead>;
  read(token: string, proof: string, address: ConjugationSessionAddress | ConjugationResultAddress): Promise<ConjugationSessionRead | ConjugationResultRead>;
  send(token: string, proof: string, command: ConjugationScheduleTransportCommand): Promise<ConjugationCatalogReply>;
  send(token: string, proof: string, command: ConjugationSessionCommand): Promise<ConjugationSessionReply>;
  send(token: string, proof: string, command: ConjugationResultCommand): Promise<ConjugationResultReply>;
  send(token: string, proof: string, command: ConjugationCommand): Promise<ConjugationReply>;
  status(token: string, proof: string, command: ConjugationScheduleTransportCommand, ticket: ReadbackTicket): Promise<ConjugationCatalogStatus>;
  status(token: string, proof: string, command: ConjugationSessionCommand, ticket: ReadbackTicket): Promise<ConjugationSessionStatus>;
  status(token: string, proof: string, command: ConjugationResultCommand, ticket: ReadbackTicket): Promise<ConjugationResultStatus>;
  status(token: string, proof: string, command: ConjugationCommand, ticket: ReadbackTicket): Promise<ConjugationStatus>;
  /**
   * Q27 (C458/C467): the status of a lost answer or grade (its content gone, Е02) by its ID only — the same ticket and strict
   * reply checks, without the fingerprint of the body that is gone and without the comparison with that content.
   */
  statusLost(token: string, proof: string, address: LostAddress, ticket: ReadbackTicket): Promise<ConjugationResultStatus>;
}

function prepare(token: string, proof: string, original: ConjugationCommand): ConjugationCommand {
  if (!token || !proof || !record(original) || !uuid(original.client_instance_id) || !uuid(original.document_id)) {
    throw new Error("invalid conjugation command access");
  }
  const { client_instance_id, document_id, ...intent } = original;
  if (!validConjugationIntent(intent)) throw new Error("invalid conjugation command");
  return { ...copyConjugationIntent(intent), client_instance_id, document_id };
}
function resultCommand(command: ConjugationCommand): command is ConjugationResultCommand {
  return command.kind === "answer.submit" || command.kind === "result.grade" || command.kind === "result.correct"
    || command.kind === "result.undo";
}
function unavailable(value: unknown): value is UnavailableCurrent {
  return record(value) && exactKeys(value, ["status"]) && value.status === "unavailable";
}
function envelope(value: unknown, keys: string[], error = false): value is Record<string, unknown> & { state_version: string } {
  return record(value) && version(value.state_version)
    && exactKeys(value, [...keys, "state_version", ...(error && Object.hasOwn(value, "error") ? ["error"] : [])]);
}
function current(value: Record<string, unknown> & { state_version: string }, command: ConjugationCommand, status: boolean): Read | null {
  if (resultCommand(command)) {
    const view = conjugationResultCurrent(value, command);
    return view && { ...view, state_version: value.state_version };
  }
  const valid = command.kind === "conjugation.schedule" ? validConjugationCatalog(value.current)
    : validConjugationCurrent(value.current, command.session_id);
  if (!valid && !(status && unavailable(value.current))) return null;
  // The status-only unavailable projection is kept separate by the public status types.
  return { current: value.current, state_version: value.state_version } as Read;
}
/** lost (Q27): the content of the command is gone — its answer text or «Забыл», its grade — and is not compared. */
function acceptance(value: unknown, command: ConjugationCommand, view: Read, lost = false): value is SavedCommandFact {
  const target = command.kind === "conjugation.schedule" ? command.payload.base_verb_id
    : "assignment_id" in command ? command.assignment_id : command.session_id;
  if (!record(value) || !exactKeys(value, ["id", "kind", "status", "applied_at", "target_id", "action_id", "result_id", "context_id", "object_version"])
    || !sameId(value.id, command.command_id) || value.kind !== command.kind || !sameId(value.target_id, target)
    || !oneOf(value.status, ["applied", "already_applied"]) || !eventTime(value.applied_at) || value.context_id !== null) return false;
  if (!resultCommand(command)) return value.action_id === null && value.result_id === null
    && (command.kind === "conjugation.schedule" ? version(value.object_version) : value.object_version === null);
  if (!uuid(value.action_id) || !uuid(value.result_id) || !version(value.object_version) || !("result" in view)) return false;
  // An accepted undo retired exactly the addressed result at its next version (shared with the written quiz and Learning).
  if (command.kind === "result.undo") return validUndoFact(value, command, view);
  if (command.kind === "answer.submit") {
    if (value.object_version !== "1") return false;
  } else {
    if (!sameId(value.result_id, command.result_id)) return false;
    const expected = BigInt(command.expected_result_version), applied = BigInt(value.object_version);
    if (applied !== expected + 1n && !(command.kind === "result.grade" && applied === expected)) return false;
    if (!lost && view.result?.version === value.object_version
      && view.result.grade !== (command.kind === "result.correct" ? 4 : command.payload.grade)) return false;
  }
  if (view.result === null || view.action === null) return oneOf(view.step.status, ["unavailable", "not_found"]);
  if (!sameId(value.action_id, view.action.action_id) || !sameId(value.result_id, view.result.result_id)
    || BigInt(value.object_version) > BigInt(view.result.version)) return false;
  const detail = view.result.detail;
  return lost || command.kind !== "answer.submit" || detail === null
    || ("text" in command.payload ? detail.input.kind === "text" && detail.input.text === command.payload.text : detail.input.kind === "forgot");
}
function missing(value: unknown, command: ConjugationCommand): MissingStatus | null {
  if (!record(value) || !record(value.command) || !exactKeys(value.command, ["id", "status"])
    || value.command.status !== "not_found" || !sameId(value.command.id, command.command_id)
    || !envelope(value, ["command", "current", ...(Object.hasOwn(value, "closed_session") ? ["closed_session"] : [])])
    || !validExactProfile(value.current)) return null;
  if (Object.hasOwn(value, "closed_session") && (command.kind === "conjugation.schedule"
    || !validClosedSessionBoundary(value.closed_session, command.session_id))) return null;
  return { outcome: "not_found", command: { id: command.command_id, status: "not_found" }, current: value.current,
    state_version: value.state_version,
    ...(value.closed_session === undefined ? {} : { closed_session: value.closed_session as ClosedSessionBoundary }) };
}

/** One exchange per call; immutable exact command facts never restore old steps or rights. */
export function createConjugationApi(options: HttpOptions): ConjugationApi {
  const request = createJsonTransport(options);
  const api = {
    async catalog(token: string): Promise<ConjugationCatalogRead> {
      if (!token) throw new Error("invalid conjugation catalog access");
      const reply = await request("/conjugations", { method: "GET", token });
      if (!reply.ok) throw httpError(reply);
      if (reply.status !== 200 || !envelope(reply.value, ["current"]) || !validConjugationCatalog(reply.value.current)) throw new ApiError("invalid_response");
      return { current: reply.value.current, state_version: reply.value.state_version };
    },
    async read(token: string, proof: string, original: ConjugationSessionAddress | ConjugationResultAddress): Promise<ConjugationSessionRead | ConjugationResultRead> {
      const result = record(original) && (Object.hasOwn(original, "assignment_id") || Object.hasOwn(original, "result_id"));
      const keys = ["session_id", "client_instance_id", "document_id", ...(result ? ["assignment_id", "result_id"] : [])];
      if (!token || !proof || !record(original) || !exactKeys(original, keys) || !keys.every(key => uuid(original[key as keyof typeof original]))) {
        throw new Error("invalid conjugation address");
      }
      const address = { ...original };
      const { session_id, client_instance_id, document_id } = address;
      const query = new URLSearchParams({ client_instance_id, document_id });
      if (result && "assignment_id" in address) {
        query.set("assignment_id", address.assignment_id); query.set("result_id", address.result_id);
      }
      const reply = await request(`/sessions/${session_id}?${query}`, { method: "GET", token, proof });
      if (!reply.ok) throw httpError(reply);
      if (reply.status === 200 && envelope(reply.value, result ? ["action", "result", "step", "capabilities"] : ["current"])) {
        if (result && "assignment_id" in address) {
          const view = conjugationResultCurrent(reply.value, address);
          if (view) return { ...view, state_version: reply.value.state_version };
        } else if (validConjugationCurrent(reply.value.current, session_id)) {
          return { current: reply.value.current, state_version: reply.value.state_version };
        }
      }
      throw new ApiError("invalid_response");
    },
    async send(token: string, proof: string, original: ConjugationCommand): Promise<ConjugationReply> {
      const command = prepare(token, proof, original);
      const reply = await request("/commands", { method: "POST", token, proof, body: command });
      // A refusal of this attempt only (window) never reads as a refused intent (commandRefusal.ts).
      if (!reply.ok && attemptRefusal(reply.status, errorCode(reply.value))) throw httpError(reply);
      const value = reply.value;
      if (envelope(value, resultCommand(command) ? ["command", "action", "result", "step", "capabilities"] : ["command", "current"], true)) {
        const view = current(value, command, false);
        if (view) {
          if (reply.status === 200 && value.error == null && acceptance(value.command, command, view)) {
            return { ...view, outcome: "accepted", command: value.command };
          }
          const code = errorCode(value);
          if ([403, 409, 422].includes(reply.status) && code && record(value.error) && exactKeys(value.error, ["code"])
            && record(value.command) && exactKeys(value.command, ["id", "status"])
            && sameId(value.command.id, command.command_id) && value.command.status === "rejected") {
            return { ...view, outcome: code === "COMMAND_PAYLOAD_MISMATCH" ? "mismatch" : "rejected",
              command: { id: command.command_id, status: "rejected" }, error: { code } };
          }
        }
      }
      if (!reply.ok) throw httpError(reply);
      throw new ApiError("invalid_response");
    },
    async status(token: string, proof: string, original: ConjugationCommand, ticket: ReadbackTicket): Promise<ConjugationStatus> {
      const command = prepare(token, proof, original);
      const { client_instance_id: _client, document_id: _document, ...intent } = command;
      const expectedHash = await conjugationIntentHash(intent);
      const query = new URLSearchParams({ client_instance_id: command.client_instance_id, document_id: command.document_id });
      if (command.kind !== "conjugation.schedule") query.set("session_id", command.session_id);
      query.set("expected_intent_hash", expectedHash);
      const reply = await request(`/commands/${command.command_id}?${query}`, { method: "GET", token, proof, readbackTicket: ticket });
      if (!reply.ok) throw httpError(reply);
      if (reply.status !== 200) throw new ApiError("invalid_response");
      const absent = missing(reply.value, command);
      if (absent) return absent;
      const value = reply.value;
      if (envelope(value, [...(resultCommand(command) ? ["command", "action", "result", "step", "capabilities"] : ["command", "current"]),
        "verified_intent_hash"]) && value.verified_intent_hash === expectedHash) {
        const view = current(value, command, true);
        if (view && acceptance(value.command, command, view) && value.command.status === "already_applied") {
          return { ...view, outcome: "accepted", command: value.command as StoredCommandFact };
        }
      }
      throw new ApiError("invalid_response");
    },
    async statusLost(token: string, proof: string, original: LostAddress, ticket: ReadbackTicket): Promise<ConjugationResultStatus> {
      const grade = record(original) && original.kind === "result.grade";
      if (!token || !proof || !record(original) || !oneOf(original.kind, ["answer.submit", "result.grade"])
        || !exactKeys(original, ["command_id", "kind", "session_id", "assignment_id", ...(grade ? ["result_id", "expected_result_version"] : []),
          "client_instance_id", "document_id"])
        || ![original.command_id, original.session_id, original.assignment_id, original.client_instance_id, original.document_id,
          ...(grade ? [original.result_id] : [])].every(uuid)
        || grade && !version(original.expected_result_version)) throw new Error("invalid lost conjugation address");
      // The service address only (no payload, never sendable): enough for the target and result checks of the reply.
      const command = { ...original, payload: {} } as unknown as ConjugationCommand;
      const query = new URLSearchParams({ client_instance_id: original.client_instance_id, document_id: original.document_id,
        session_id: original.session_id });
      const reply = await request(`/commands/${original.command_id}?${query}`, { method: "GET", token, proof, readbackTicket: ticket });
      if (!reply.ok) throw httpError(reply);
      if (reply.status !== 200) throw new ApiError("invalid_response");
      const absent = missing(reply.value, command);
      if (absent) return absent as ConjugationResultStatus;
      const value = reply.value;
      // Without a fingerprint the server verifies none: a reply that claims one is refused.
      if (envelope(value, ["command", "action", "result", "step", "capabilities"])) {
        const view = current(value, command, true);
        if (view && acceptance(value.command, command, view, true) && value.command.status === "already_applied") {
          return { ...view, outcome: "accepted", command: value.command as StoredCommandFact } as ConjugationResultStatus;
        }
      }
      throw new ApiError("invalid_response");
    },
  };
  return api as ConjugationApi;
}
