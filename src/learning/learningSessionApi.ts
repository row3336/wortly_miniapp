import type { ClosedSessionBoundary, ErrorDetail, LearningSessionProjection,
  MissingCommandFact, Profile, RefusedStartFact, RejectedCommandFact, SavedCommandFact, SessionStartCommand,
  StoredCommandFact, UnavailableCurrent, UnavailableSession } from "../api/generated";
import { validProfile } from "../api/entryApi";
import { ApiError, createJsonTransport, errorCode, httpError, type HttpOptions } from "../api/http";
import { attemptRefusal } from "../commands/commandRefusal";
import { record, uuid, sameId, exactKeys, version, eventTime, oneOf, validClosedSessionBoundary } from "../api/wireValidation";
import { copyLearningSessionIntent, readableLearningSessionIntent, validLearningSessionIntent,
  type LearningSessionCommand } from "./learningSessionIntent";
import { intentHash } from "../commands/intentHash";
import { validLearningSessionCurrent } from "../study/sessionProjection";
import { createSessionReadApi } from "../study/sessionReadApi";
export { validLearningSessionCurrent } from "../study/sessionProjection";
export type { LearningSessionCommand } from "./learningSessionIntent";

export type LearningSessionAddress = Pick<SessionStartCommand, "session_id" | "client_instance_id" | "document_id">;
type Current = LearningSessionProjection | UnavailableSession;
export type LearningSessionRead = { current: Current; state_version: string };
export type LearningSessionReply = LearningSessionRead & (
  | { outcome: "accepted"; command: SavedCommandFact }
  | { outcome: "rejected" | "mismatch"; command: RejectedCommandFact; error: ErrorDetail }
);
export type LearningSessionStatus = { state_version: string } & (
  | { outcome: "accepted"; command: StoredCommandFact; current: Current | UnavailableCurrent }
  | { outcome: "not_found"; command: MissingCommandFact; current: Profile; closed_session?: ClosedSessionBoundary }
  | { outcome: "rejected"; command: RefusedStartFact; current: Current | UnavailableCurrent; error: ErrorDetail }
);

/**
 * The final start refusals the Learning view leaves at once (Codex C168, C183, C192). The core stores each by the start's
 * command_id (session_start_refusal.py FINAL_START_CODES), so no copy of that command can create the session later. Each
 * is raised before the new session exists or inside the start's own savepoint, which removes it and its binding
 * (new_session_start, learning_service.start, _deliver(starting=True)). SESSION_BUSY is about another open session T,
 * never this number: the idle «На Сегодня» opens the document afresh and that open shows T's busy state. SESSION_CLOSED
 * may name an existing session of this number and keeps its own handling.
 */
export const LEAVING_START_REFUSALS: ReadonlySet<string> = new Set(["SETUP_REQUIRED", "NO_MATERIAL", "SESSION_BUSY"]);
/**
 * Every code the core stores as a final start refusal (session_start_refusal.FINAL_START_CODES), so every one a status
 * read with include_refusal may answer. Reading it proves only the refusal; which of them the view leaves is
 * LEAVING_START_REFUSALS (C210).
 */
const FINAL_START_REFUSALS: ReadonlySet<string> = new Set([...LEAVING_START_REFUSALS, "SESSION_CLOSED"]);

export interface LearningSessionApi {
  read(token: string, proof: string, address: LearningSessionAddress): Promise<LearningSessionRead>;
  /** started, when given, is told right before the built request goes to fetch (after every local check). */
  send(token: string, proof: string, command: LearningSessionCommand, started?: () => void): Promise<LearningSessionReply>;
  status(token: string, proof: string, command: LearningSessionCommand): Promise<LearningSessionStatus>;
}

function address(value: unknown): value is LearningSessionAddress {
  return record(value) && uuid(value.session_id) && uuid(value.client_instance_id) && uuid(value.document_id);
}
function prepareAddress(token: string, proof: string, value: LearningSessionAddress): LearningSessionAddress {
  if (!token || !proof || !address(value)) throw new Error("invalid Learning session access");
  return { session_id: value.session_id, client_instance_id: value.client_instance_id, document_id: value.document_id };
}
/** send: only an intent this client may send; a status check also names a stored closure record (D-CP4 4.6.1). */
function prepareCommand(token: string, proof: string, value: LearningSessionCommand, use: "send" | "status"): LearningSessionCommand {
  const access = prepareAddress(token, proof, value);
  const { client_instance_id: _client, document_id: _document, ...intent } = value;
  if (!(use === "send" ? validLearningSessionIntent(intent) : readableLearningSessionIntent(intent))) throw new Error("invalid Learning command");
  return { ...copyLearningSessionIntent(intent), client_instance_id: access.client_instance_id, document_id: access.document_id };
}

function accepted(value: unknown, command: LearningSessionCommand): value is SavedCommandFact {
  if (!record(value)) return false;
  const preview = command.kind === "learning.known" || command.kind === "learning.preview_next";
  const target = "preview_id" in command ? command.preview_id
    : "assignment_id" in command ? command.assignment_id : command.session_id;
  return exactKeys(value, ["id", "kind", "status", "applied_at", "target_id", "action_id", "result_id", "context_id", "object_version"])
    && sameId(value.id, command.command_id) && value.kind === command.kind && sameId(value.target_id, target)
    && oneOf(value.status, ["applied", "already_applied"]) && eventTime(value.applied_at)
    && value.action_id === null && value.result_id === null && value.context_id === null
    && (preview ? version(value.object_version) : value.object_version === null);
}
/** core identity.intent_hash of a start: the payload the coordinator stores, its session number included. */
function startHash(command: LearningSessionCommand): Promise<string> {
  return intentHash("session.start", { session_id: command.session_id.toLowerCase(), mode: "learning" });
}
/**
 * A stored final refusal of exactly this start (contracts §1.3, design D-START-REFUSAL 3.6), read only with
 * include_refusal=true. The verified intent hash binds the record to this very intent, whatever its current names. The
 * current is the core's recheck of this start's own number (command_status._refused_start): any valid Learning current
 * of that number, a real session included, or the bare unavailable one. Anything else proves no refusal.
 */
function refusedStart(value: Record<string, unknown>, command: LearningSessionCommand, expectedHash: string): boolean {
  const fact = value.command, error = value.error, current = value.current;
  return exactKeys(value, ["command", "error", "current", "state_version", "verified_intent_hash"])
    && value.verified_intent_hash === expectedHash
    && record(fact) && exactKeys(fact, ["id", "kind", "status", "refused_at"]) && sameId(fact.id, command.command_id)
    && fact.kind === "session.start" && fact.status === "rejected" && eventTime(fact.refused_at)
    && record(error) && exactKeys(error, ["code"]) && typeof error.code === "string" && FINAL_START_REFUSALS.has(error.code)
    && record(current) && (exactKeys(current, ["status"]) && current.status === "unavailable"
      || validLearningSessionCurrent(current, command.session_id));
}
function query(address: LearningSessionAddress): URLSearchParams {
  return new URLSearchParams({ client_instance_id: address.client_instance_id, document_id: address.document_id });
}

export function createLearningSessionApi(options: HttpOptions): LearningSessionApi {
  const request = createJsonTransport(options), sessions = createSessionReadApi(options);
  return {
    async read(token, proof, original) {
      const address = prepareAddress(token, proof, original);
      const reply = await sessions.read(token, proof, address);
      if (!validLearningSessionCurrent(reply.current, address.session_id)) throw new ApiError("invalid_response");
      return { current: reply.current, state_version: reply.state_version };
    },
    async send(token, proof, original, started) {
      const command = prepareCommand(token, proof, original, "send");
      const reply = await request("/commands", { method: "POST", token, proof, body: command, ...(started ? { started } : {}) });
      // A refusal of this attempt only (window) never reads as a refused intent (commandRefusal.ts).
      if (!reply.ok && attemptRefusal(reply.status, errorCode(reply.value))) throw httpError(reply);
      const value = reply.value;
      if (record(value) && version(value.state_version)
        && exactKeys(value, ["command", "current", "state_version", ...(Object.hasOwn(value, "error") ? ["error"] : [])])
        && validLearningSessionCurrent(value.current, command.session_id)) {
        const projection = { current: value.current, state_version: value.state_version };
        if (reply.status === 200 && value.error == null && accepted(value.command, command)) {
          return { ...projection, outcome: "accepted", command: value.command };
        }
        const code = errorCode(value);
        if ([403, 409, 422].includes(reply.status) && code && record(value.command)
          && exactKeys(value.command, ["id", "status"]) && sameId(value.command.id, command.command_id)
          && value.command.status === "rejected") {
          return { ...projection, outcome: code === "COMMAND_PAYLOAD_MISMATCH" ? "mismatch" : "rejected",
            command: { id: command.command_id, status: "rejected" }, error: { code } };
        }
      }
      if (!reply.ok) throw httpError(reply);
      throw new ApiError("invalid_response");
    },
    async status(token, proof, original) {
      const command = prepareCommand(token, proof, original, "status");
      const parameters = query(command);
      parameters.set("session_id", command.session_id);
      // Only a start asks for its stored final refusal, bound to this intent by its hash; other kinds read as before.
      const expectedHash = command.kind === "session.start" ? await startHash(command) : null;
      if (expectedHash !== null) {
        parameters.set("include_refusal", "true"); parameters.set("expected_intent_hash", expectedHash);
      }
      const reply = await request.readback(command.command_id, `/commands/${command.command_id}?${parameters}`, { method: "GET", token, proof });
      if (!reply.ok) throw httpError(reply);
      const value = reply.value;
      if (reply.status === 200 && expectedHash !== null && record(value) && record(value.command)
        && value.command.status === "rejected" && version(value.state_version)) {
        if (!refusedStart(value, command, expectedHash)) throw new ApiError("invalid_response");
        return { outcome: "rejected", command: structuredClone(value.command) as RefusedStartFact,
          current: structuredClone(value.current) as Current | UnavailableCurrent,
          error: { code: (value.error as ErrorDetail).code }, state_version: value.state_version as string };
      }
      // The core echoes the hash only with a fact or a refusal; a fact of a start that carries one must carry this one.
      const verified = expectedHash !== null && record(value) && Object.hasOwn(value, "verified_intent_hash");
      if (reply.status !== 200 || !record(value) || !record(value.command)
        || !version(value.state_version) || value.error != null
        || verified && (value.verified_intent_hash !== expectedHash || value.command.status !== "already_applied")
        || !exactKeys(value, ["command", "current", "state_version",
          ...(Object.hasOwn(value, "error") ? ["error"] : []),
          ...(verified ? ["verified_intent_hash"] : []),
          ...(value.command.status === "not_found" && Object.hasOwn(value, "closed_session") ? ["closed_session"] : [])])) {
        throw new ApiError("invalid_response");
      }
      const fact = value.command;
      if (fact.status === "not_found" && exactKeys(fact, ["id", "status"]) && sameId(fact.id, command.command_id)
        && validProfile(value.current) && uuid(value.current.profile_id)) {
        if (Object.hasOwn(value, "closed_session") && !validClosedSessionBoundary(value.closed_session, command.session_id)) {
          throw new ApiError("invalid_response");
        }
        return { outcome: "not_found", command: { id: command.command_id, status: "not_found" },
          current: value.current, state_version: value.state_version,
          ...(value.closed_session === undefined ? {} : { closed_session: value.closed_session as ClosedSessionBoundary }) };
      }
      if (accepted(fact, command) && fact.status === "already_applied") {
        if (validLearningSessionCurrent(value.current, command.session_id)) {
          return { outcome: "accepted", command: fact as StoredCommandFact, current: value.current, state_version: value.state_version };
        }
        if (record(value.current) && exactKeys(value.current, ["status"]) && value.current.status === "unavailable") {
          return { outcome: "accepted", command: fact as StoredCommandFact,
            current: { status: "unavailable" }, state_version: value.state_version };
        }
      }
      throw new ApiError("invalid_response");
    },
  };
}
