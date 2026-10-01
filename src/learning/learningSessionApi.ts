import type { ClosedSessionBoundary, ErrorDetail, LearningSessionProjection,
  MissingCommandFact, Profile, RejectedCommandFact, SavedCommandFact, SessionStartCommand,
  StoredCommandFact, UnavailableCurrent, UnavailableSession } from "../api/generated";
import { validProfile } from "../api/entryApi";
import { ApiError, createJsonTransport, errorCode, httpError, type HttpOptions } from "../api/http";
import { record, uuid, sameId, exactKeys, version, eventTime, oneOf, validClosedSessionBoundary } from "../api/wireValidation";
import { copyLearningSessionIntent, validLearningSessionIntent, type LearningSessionCommand } from "./learningSessionIntent";
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
);

export interface LearningSessionApi {
  read(token: string, proof: string, address: LearningSessionAddress): Promise<LearningSessionRead>;
  send(token: string, proof: string, command: LearningSessionCommand): Promise<LearningSessionReply>;
  status(token: string, proof: string, command: LearningSessionCommand): Promise<LearningSessionStatus>;
}

function address(value: unknown): value is LearningSessionAddress {
  return record(value) && uuid(value.session_id) && uuid(value.client_instance_id) && uuid(value.document_id);
}
function prepareAddress(token: string, proof: string, value: LearningSessionAddress): LearningSessionAddress {
  if (!token || !proof || !address(value)) throw new Error("invalid Learning session access");
  return { session_id: value.session_id, client_instance_id: value.client_instance_id, document_id: value.document_id };
}
function prepareCommand(token: string, proof: string, value: LearningSessionCommand): LearningSessionCommand {
  const access = prepareAddress(token, proof, value);
  const { client_instance_id: _client, document_id: _document, ...intent } = value;
  if (!validLearningSessionIntent(intent)) throw new Error("invalid Learning command");
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
    async send(token, proof, original) {
      const command = prepareCommand(token, proof, original);
      const reply = await request("/commands", { method: "POST", token, proof, body: command });
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
      const command = prepareCommand(token, proof, original);
      const parameters = query(command);
      parameters.set("session_id", command.session_id);
      const reply = await request(`/commands/${command.command_id}?${parameters}`, { method: "GET", token, proof });
      if (!reply.ok) throw httpError(reply);
      const value = reply.value;
      if (reply.status !== 200 || !record(value) || !record(value.command)
        || !version(value.state_version) || value.error != null
        || !exactKeys(value, ["command", "current", "state_version",
          ...(Object.hasOwn(value, "error") ? ["error"] : []),
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
