import type {
  ErrorDetail, MissingCommandFact, Profile, RejectedCommandFact, RemoteSessionProjection,
  SavedCommandFact, SessionStopRemoteCommand, StoredCommandFact, UnavailableCurrent, UnavailableSession,
} from "../api/generated";
import { validProfile } from "../api/entryApi";
import { ApiError, createJsonTransport, errorCode, httpError, type HttpOptions } from "../api/http";
import { record, uuid, sameId, exactKeys, version, eventTime, oneOf } from "../api/wireValidation";

export type RemoteStopIntent = Pick<SessionStopRemoteCommand, "command_id" | "kind" | "session_id" | "payload">;
type Current = RemoteSessionProjection | UnavailableSession;
export type RemoteStopReply = { current: Current; state_version: string } & (
  | { outcome: "accepted"; command: SavedCommandFact }
  | { outcome: "rejected" | "mismatch"; command: RejectedCommandFact; error: ErrorDetail }
);
export type RemoteStopStatus = { state_version: string } & (
  | { outcome: "accepted"; command: StoredCommandFact; current: Current | UnavailableCurrent }
  | { outcome: "not_found"; command: MissingCommandFact; current: Profile }
);

export interface RemoteSessionApi {
  stop(token: string, proof: string, command: SessionStopRemoteCommand): Promise<RemoteStopReply>;
  status(token: string, proof: string, command: SessionStopRemoteCommand): Promise<RemoteStopStatus>;
}

export function validRemoteStopIntent(value: unknown): value is RemoteStopIntent {
  return record(value) && uuid(value.command_id) && uuid(value.session_id)
    && value.kind === "session.stop_remote" && record(value.payload)
    && exactKeys(value.payload, ["confirmed"]) && value.payload.confirmed === true;
}

function snapshotCommand(value: SessionStopRemoteCommand): SessionStopRemoteCommand {
  if (!validRemoteStopIntent(value) || !record(value)
    || !exactKeys(value, ["command_id", "kind", "session_id", "payload", "client_instance_id", "document_id"])
    || !uuid(value.client_instance_id) || !uuid(value.document_id)) throw new Error("invalid remote stop command");
  return { ...value, payload: { confirmed: true } };
}

function current(value: unknown, intent: RemoteStopIntent): value is Current {
  if (!record(value) || !sameId(value.session_id, intent.session_id)) return false;
  if (value.status === "not_found" || value.status === "unavailable") {
    return exactKeys(value, ["session_id", "status"]);
  }
  if (!exactKeys(value, ["session_id", "status", "close_reason"])) return false;
  if (value.status === "active" || value.status === "summary") return value.close_reason === null;
  return value.status === "closed" && oneOf(value.close_reason,
    ["midnight", "pair_changed", "timezone_date_changed", "stop", "remote_stop", "summary_home"]);
}

function accepted(value: unknown, intent: RemoteStopIntent): value is SavedCommandFact {
  return record(value) && sameId(value.id, intent.command_id) && value.kind === intent.kind
    && sameId(value.target_id, intent.session_id) && oneOf(value.status, ["applied", "already_applied"])
    && eventTime(value.applied_at) && value.object_version === null
    && value.action_id === null && value.result_id === null && value.context_id === null;
}

export function createRemoteSessionApi(options: HttpOptions): RemoteSessionApi {
  const request = createJsonTransport(options);
  function prepare(token: string, proof: string, command: SessionStopRemoteCommand) {
    if (!token || !proof) throw new Error("token and proof are required");
    return snapshotCommand(command);
  }
  return {
    async stop(token, proof, original) {
      const command = prepare(token, proof, original);
      const reply = await request("/commands", { method: "POST", token, proof, body: command });
      const value = reply.value;
      if (record(value) && version(value.state_version) && current(value.current, command)) {
        const projection = { current: value.current, state_version: value.state_version };
        if (reply.status === 200 && accepted(value.command, command) && value.error == null) {
          return { ...projection, outcome: "accepted", command: value.command };
        }
        const code = errorCode(value);
        if ([403, 409, 422].includes(reply.status) && record(value.command)
          && sameId(value.command.id, command.command_id) && value.command.status === "rejected" && code) {
          return { ...projection, outcome: code === "COMMAND_PAYLOAD_MISMATCH" ? "mismatch" : "rejected",
            command: { id: value.command.id as string, status: "rejected" }, error: { code } };
        }
      }
      if (!reply.ok) throw httpError(reply);
      throw new ApiError("invalid_response");
    },
    async status(token, proof, original) {
      const command = prepare(token, proof, original);
      const query = new URLSearchParams({ client_instance_id: command.client_instance_id,
        document_id: command.document_id });
      const reply = await request(`/commands/${command.command_id}?${query}`, { method: "GET", token, proof });
      if (!reply.ok) throw httpError(reply);
      const value = reply.value;
      if (!record(value) || !record(value.command) || !version(value.state_version) || value.error != null) {
        throw new ApiError("invalid_response");
      }
      const fact = value.command;
      if (fact.status === "not_found" && sameId(fact.id, command.command_id)
        && validProfile(value.current) && uuid(value.current.profile_id)) {
        return { outcome: "not_found", command: { id: fact.id as string, status: "not_found" },
          current: value.current, state_version: value.state_version };
      }
      if (accepted(fact, command) && fact.status === "already_applied") {
        if (current(value.current, command)) return { outcome: "accepted", command: fact as StoredCommandFact,
          current: value.current, state_version: value.state_version };
        if (record(value.current) && exactKeys(value.current, ["status"]) && value.current.status === "unavailable") {
          return { outcome: "accepted", command: fact as StoredCommandFact,
            current: { status: "unavailable" }, state_version: value.state_version };
        }
      }
      throw new ApiError("invalid_response");
    },
  };
}
