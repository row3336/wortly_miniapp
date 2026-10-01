import type { SessionResponse } from "../api/generated";
import { ApiError, createJsonTransport, httpError, type HttpOptions } from "../api/http";
import { exactKeys, record, uuid, version } from "../api/wireValidation";
import { validSessionCurrent } from "./sessionProjection";

export type SessionAddress = { session_id: string; client_instance_id: string; document_id: string };
export type SessionReadApi = {
  read(token: string, proof: string, address: SessionAddress): Promise<SessionResponse>;
};

/** One addressed read; the persisted server mode chooses the projection. Never starts or presents a step. */
export function createSessionReadApi(options: HttpOptions): SessionReadApi {
  const request = createJsonTransport(options);
  return {
    async read(token, proof, original) {
      if (!token || !proof || !record(original) || !uuid(original.session_id)
        || !uuid(original.client_instance_id) || !uuid(original.document_id)) throw new Error("invalid session access");
      const sessionId = original.session_id;
      const query = new URLSearchParams({ client_instance_id: original.client_instance_id, document_id: original.document_id });
      const reply = await request(`/sessions/${sessionId}?${query}`, { method: "GET", token, proof });
      if (!reply.ok) throw httpError(reply);
      const value = reply.value;
      if (!record(value) || !exactKeys(value, ["current", "state_version"]) || !version(value.state_version)
        || !validSessionCurrent(value.current, sessionId)) throw new ApiError("invalid_response");
      return { current: value.current, state_version: value.state_version };
    },
  };
}
