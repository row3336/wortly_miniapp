import type { ClosedSessionBoundary, ErrorDetail, MissingCommandFact, Profile, RejectedCommandFact, SavedCommandFact,
  SessionCancelStartCommand, SessionStartCancelProjection, StoredCommandFact } from "../api/generated";
import { validProfile } from "../api/entryApi";
import { ApiError, createJsonTransport, errorCode, httpError, type HttpOptions } from "../api/http";
import { eventTime, exactKeys, oneOf, record, sameId, uuid, validClosedSessionBoundary, version } from "../api/wireValidation";
import { intentHash } from "./intentHash";

export const CANCEL_START_KIND = "session.cancel_start";

/** The cancel without its origin: its own command_id and the session_id of the start it cancels; nothing else. */
export type StartCancelIntent = Pick<SessionCancelStartCommand, "command_id" | "session_id" | "kind" | "payload">;
export type StartCancelOutcome = SessionStartCancelProjection["outcome"];
/**
 * The cancel's view of its session: the outcome, or hidden from a document that is not the live one (with the number),
 * or hidden altogether when the status read had no usable origin or profile (without it, status only).
 */
export type StartCancelCurrent = SessionStartCancelProjection | { session_id: string; status: "unavailable" } | { status: "unavailable" };
export type StartCancelReply = { current: StartCancelCurrent; state_version: string } & (
  | { outcome: "accepted"; command: SavedCommandFact }
  | { outcome: "rejected" | "mismatch"; command: RejectedCommandFact; error: ErrorDetail });
export type StartCancelStatus = { state_version: string } & (
  | { outcome: "accepted"; command: StoredCommandFact; current: StartCancelCurrent }
  | { outcome: "not_found"; command: MissingCommandFact; current: Profile; closed_session?: ClosedSessionBoundary });

export interface StartCancelApi {
  send(token: string, proof: string, command: SessionCancelStartCommand): Promise<StartCancelReply>;
  status(token: string, proof: string, command: SessionCancelStartCommand): Promise<StartCancelStatus>;
}

/**
 * The fingerprint the core keeps for the cancel: it hashes {"session_id"} as its inner payload (session_start_cancel.py,
 * coordinator.execute), although the body sends an empty payload and the number in the envelope (D-CP2C-START 2.3.1).
 * The core writes the number as str(UUID), always lower case.
 */
export function startCancelIntentHash(sessionId: string): Promise<string> {
  return intentHash(CANCEL_START_KIND, { session_id: sessionId.toLowerCase() });
}

/** The cancel for this session number under its own new ID: an empty payload, the number in the envelope. */
export function startCancelIntent(commandId: string, sessionId: string): StartCancelIntent {
  return { command_id: commandId, session_id: sessionId, kind: CANCEL_START_KIND, payload: {} };
}

const COMMAND_KEYS = ["command_id", "client_instance_id", "document_id", "session_id", "kind", "payload"];
function prepare(token: string, proof: string, value: SessionCancelStartCommand): SessionCancelStartCommand {
  // The core refuses a payload that carries the number (422): only the exact empty shape goes out.
  if (!token || !proof || !record(value) || !exactKeys(value, COMMAND_KEYS) || value.kind !== CANCEL_START_KIND
    || !uuid(value.command_id) || !uuid(value.client_instance_id) || !uuid(value.document_id) || !uuid(value.session_id)
    || sameId(value.command_id, value.session_id) || !record(value.payload) || !exactKeys(value.payload, [])) {
    throw new Error("invalid session.cancel_start command");
  }
  return { command_id: value.command_id, client_instance_id: value.client_instance_id, document_id: value.document_id,
    session_id: value.session_id, kind: CANCEL_START_KIND, payload: {} };
}

/** bare: a status read may hide the view without naming the number ({status: "unavailable"}); a reply never does. */
function validCurrent(value: unknown, sessionId: string, bare: boolean): value is StartCancelCurrent {
  if (!record(value)) return false;
  if (exactKeys(value, ["status"])) return bare && value.status === "unavailable";
  if (exactKeys(value, ["session_id", "status"])) return sameId(value.session_id, sessionId) && value.status === "unavailable";
  return exactKeys(value, ["session_id", "outcome"]) && sameId(value.session_id, sessionId)
    && oneOf(value.outcome, ["cancelled", "session_exists"]);
}
function validFact(value: unknown, command: SessionCancelStartCommand, statuses: readonly string[]): boolean {
  return record(value)
    && exactKeys(value, ["id", "kind", "status", "applied_at", "target_id", "action_id", "result_id", "context_id", "object_version"])
    && sameId(value.id, command.command_id) && value.kind === CANCEL_START_KIND && sameId(value.target_id, command.session_id)
    && oneOf(value.status, statuses) && eventTime(value.applied_at)
    && value.action_id === null && value.result_id === null && value.context_id === null && value.object_version === null;
}

/** session.cancel_start and its status by the cancel's own ID (D-CP2C-START 2.4.1–2.4.2); no retry of its own. */
export function createStartCancelApi(options: HttpOptions): StartCancelApi {
  const request = createJsonTransport(options);
  return {
    async send(token, proof, original) {
      const command = prepare(token, proof, original);
      const reply = await request("/commands", { method: "POST", token, proof, body: command });
      const value = reply.value;
      if (record(value) && version(value.state_version)
        && exactKeys(value, ["command", "current", "state_version", ...(Object.hasOwn(value, "error") ? ["error"] : [])])
        && validCurrent(value.current, command.session_id, false)) {
        const projection = { current: value.current, state_version: value.state_version };
        if (reply.status === 200 && value.error == null && validFact(value.command, command, ["applied", "already_applied"])) {
          return { ...projection, outcome: "accepted", command: value.command as SavedCommandFact };
        }
        const code = errorCode(value);
        if ([403, 409, 422].includes(reply.status) && code && record(value.error) && exactKeys(value.error, ["code"])
          && record(value.command) && exactKeys(value.command, ["id", "status"])
          && sameId(value.command.id, command.command_id) && value.command.status === "rejected") {
          return { ...projection, outcome: code === "COMMAND_PAYLOAD_MISMATCH" ? "mismatch" : "rejected",
            command: { id: command.command_id, status: "rejected" }, error: { code } };
        }
      }
      if (!reply.ok) throw httpError(reply);
      throw new ApiError("invalid_response");
    },
    async status(token, proof, original) {
      const command = prepare(token, proof, original);
      const expectedHash = await startCancelIntentHash(command.session_id);
      const query = new URLSearchParams({ client_instance_id: command.client_instance_id, document_id: command.document_id,
        session_id: command.session_id, expected_intent_hash: expectedHash });
      const reply = await request(`/commands/${command.command_id}?${query}`, { method: "GET", token, proof });
      // A 409 COMMAND_PAYLOAD_MISMATCH reaches the caller as an HTTP refusal of this exact ID.
      if (!reply.ok) throw httpError(reply);
      const value = reply.value;
      if (reply.status !== 200 || !record(value) || !record(value.command) || !version(value.state_version)) throw new ApiError("invalid_response");
      const fact = value.command;
      if (fact.status === "not_found") {
        if (exactKeys(fact, ["id", "status"]) && sameId(fact.id, command.command_id)
          && exactKeys(value, ["command", "current", "state_version", ...(Object.hasOwn(value, "closed_session") ? ["closed_session"] : [])])
          && validProfile(value.current) && uuid(value.current.profile_id)
          // null is allowed by the contract (CommandStatusResponse) and means no closure, as an absent field does.
          && (value.closed_session == null || validClosedSessionBoundary(value.closed_session, command.session_id))) {
          return { outcome: "not_found", command: { id: command.command_id, status: "not_found" }, current: value.current,
            state_version: value.state_version,
            ...(value.closed_session == null ? {} : { closed_session: value.closed_session as ClosedSessionBoundary }) };
        }
        throw new ApiError("invalid_response");
      }
      // An ID/target match cannot tell another payload apart; only the server's verified fingerprint can.
      if (value.verified_intent_hash === expectedHash
        && exactKeys(value, ["command", "current", "state_version", "verified_intent_hash"])
        && validFact(fact, command, ["already_applied"]) && validCurrent(value.current, command.session_id, true)) {
        return { outcome: "accepted", command: fact as StoredCommandFact, current: value.current, state_version: value.state_version };
      }
      throw new ApiError("invalid_response");
    },
  };
}
