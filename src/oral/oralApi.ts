import type { ClosedSessionBoundary, ErrorDetail, OralSessionProjection,
  MissingCommandFact, Profile, RejectedCommandFact, SavedCommandFact, SessionStartCommand,
  StoredCommandFact, UnavailableCurrent, UnavailableSession } from "../api/generated";
import { validExactProfile } from "../api/entryApi";
import { ApiError, createJsonTransport, errorCode, httpError, type HttpOptions } from "../api/http";
import { attemptRefusal } from "../commands/commandRefusal";
import { record, uuid, sameId, exactKeys, version, eventTime, oneOf, validClosedSessionBoundary } from "../api/wireValidation";
import { copyOralIntent, oralIntentHash, validOralIntent, type OralCommand } from "./oralIntent";
import { validOralCurrent } from "./oralProjection";
import { createSessionReadApi } from "../study/sessionReadApi";
export { validOralCurrent } from "./oralProjection";
export type { OralCommand, OralIntent } from "./oralIntent";

export type OralAddress = Pick<SessionStartCommand, "session_id" | "client_instance_id" | "document_id">;
type Current = OralSessionProjection | UnavailableSession;
export type OralRead = { current: Current; state_version: string };
export type OralReply = OralRead & (
  | { outcome: "accepted"; command: SavedCommandFact }
  | { outcome: "rejected" | "mismatch"; command: RejectedCommandFact; error: ErrorDetail }
);
export type OralStatus = { state_version: string } & (
  | { outcome: "accepted"; command: StoredCommandFact; current: Current | UnavailableCurrent }
  | { outcome: "not_found"; command: MissingCommandFact; current: Profile; closed_session?: ClosedSessionBoundary }
);

export interface OralApi {
  read(token: string, proof: string, address: OralAddress): Promise<OralRead>;
  send(token: string, proof: string, command: OralCommand): Promise<OralReply>;
  status(token: string, proof: string, command: OralCommand): Promise<OralStatus>;
}

function address(value: unknown): value is OralAddress {
  return record(value) && exactKeys(value, ["session_id", "client_instance_id", "document_id"]) && uuid(value.session_id) && uuid(value.client_instance_id) && uuid(value.document_id);
}
function prepareAddress(token: string, proof: string, value: OralAddress): OralAddress {
  if (!token || !proof || !address(value)) throw new Error("invalid oral session access");
  return { session_id: value.session_id, client_instance_id: value.client_instance_id, document_id: value.document_id };
}
function prepareCommand(token: string, proof: string, value: OralCommand): OralCommand {
  if (!record(value)) throw new Error("invalid oral command");
  const access = prepareAddress(token, proof, {
    session_id: value.session_id, client_instance_id: value.client_instance_id, document_id: value.document_id,
  });
  const { client_instance_id: _client, document_id: _document, ...intent } = value;
  if (!validOralIntent(intent)) throw new Error("invalid oral command");
  return { ...copyOralIntent(intent), client_instance_id: access.client_instance_id, document_id: access.document_id };
}

function accepted(value: unknown, command: OralCommand): value is SavedCommandFact {
  if (!record(value)) return false;
  const grade = command.kind === "oral.grade";
  const target = "assignment_id" in command ? command.assignment_id : command.session_id;
  return exactKeys(value, ["id", "kind", "status", "applied_at", "target_id", "action_id", "result_id", "context_id", "object_version"])
    && sameId(value.id, command.command_id) && value.kind === command.kind && sameId(value.target_id, target)
    && oneOf(value.status, ["applied", "already_applied"]) && eventTime(value.applied_at)
    && value.context_id === null
    && (grade ? uuid(value.action_id) && uuid(value.result_id) && value.object_version === "1"
      : value.action_id === null && value.result_id === null && value.object_version === null);
}
function query(address: OralAddress): URLSearchParams {
  return new URLSearchParams({ client_instance_id: address.client_instance_id, document_id: address.document_id });
}

export function createOralApi(options: HttpOptions): OralApi {
  const request = createJsonTransport(options), sessions = createSessionReadApi(options);
  return {
    async read(token, proof, original) {
      const address = prepareAddress(token, proof, original);
      const reply = await sessions.read(token, proof, address);
      if (!validOralCurrent(reply.current, address.session_id)) throw new ApiError("invalid_response");
      return { current: reply.current, state_version: reply.state_version };
    },
    async send(token, proof, original) {
      const command = prepareCommand(token, proof, original);
      const reply = await request("/commands", { method: "POST", token, proof, body: command });
      // A refusal of this attempt only (window) never reads as a refused intent (commandRefusal.ts).
      if (!reply.ok && attemptRefusal(reply.status, errorCode(reply.value))) throw httpError(reply);
      const value = reply.value;
      if (record(value) && version(value.state_version)
        && exactKeys(value, ["command", "current", "state_version", ...(Object.hasOwn(value, "error") ? ["error"] : [])])
        && validOralCurrent(value.current, command.session_id)) {
        const projection = { current: value.current, state_version: value.state_version };
        if (reply.status === 200 && value.error == null && accepted(value.command, command)) {
          return { ...projection, outcome: "accepted", command: value.command };
        }
        const code = errorCode(value);
        if ([403, 409, 422].includes(reply.status) && code && record(value.command)
          && exactKeys(value.command, ["id", "status"]) && sameId(value.command.id, command.command_id)
          && value.command.status === "rejected" && record(value.error) && exactKeys(value.error, ["code"])) {
          return { ...projection, outcome: code === "COMMAND_PAYLOAD_MISMATCH" ? "mismatch" : "rejected",
            command: { id: command.command_id, status: "rejected" }, error: { code } };
        }
      }
      if (!reply.ok) throw httpError(reply);
      throw new ApiError("invalid_response");
    },
    async status(token, proof, original) {
      const command = prepareCommand(token, proof, original);
      const { client_instance_id: _client, document_id: _document, ...intent } = command;
      const expectedHash = await oralIntentHash(intent);
      const parameters = query(command);
      parameters.set("session_id", command.session_id);
      parameters.set("expected_intent_hash", expectedHash);
      const reply = await request.readback(command.command_id, `/commands/${command.command_id}?${parameters}`, { method: "GET", token, proof });
      if (!reply.ok) throw httpError(reply);
      const value = reply.value;
      if (reply.status !== 200 || !record(value) || !record(value.command)
        || !version(value.state_version) || value.error != null
        || !exactKeys(value, ["command", "current", "state_version",
          ...(Object.hasOwn(value, "error") ? ["error"] : []),
          ...(value.command.status === "already_applied" ? ["verified_intent_hash"] : []),
          ...(value.command.status === "not_found" && Object.hasOwn(value, "closed_session") ? ["closed_session"] : [])])) {
        throw new ApiError("invalid_response");
      }
      const fact = value.command;
      if (fact.status === "not_found" && exactKeys(fact, ["id", "status"]) && sameId(fact.id, command.command_id)
        && validExactProfile(value.current)) {
        if (Object.hasOwn(value, "closed_session") && !validClosedSessionBoundary(value.closed_session, command.session_id)) {
          throw new ApiError("invalid_response");
        }
        return { outcome: "not_found", command: { id: command.command_id, status: "not_found" },
          current: value.current, state_version: value.state_version,
          ...(value.closed_session === undefined ? {} : { closed_session: value.closed_session as ClosedSessionBoundary }) };
      }
      // A UUID/target match cannot distinguish another payload after a failed local mismatch write.
      if (accepted(fact, command) && fact.status === "already_applied"
        && value.verified_intent_hash === expectedHash) {
        if (validOralCurrent(value.current, command.session_id)) {
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
