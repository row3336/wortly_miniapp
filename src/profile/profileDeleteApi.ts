import { ApiError, createJsonTransport, errorCode, type HttpOptions, type JsonReply } from "../api/http";
import { eventTime, exactKeys, oneOf, record, sameId, uuid } from "../api/wireValidation";
import { PausedBeforeSendError } from "../commands/writeGate";

/**
 * POST /api/v1/profile/delete (P04 ред.14 §7; core openapi ea8e1d9): the session's own profile, an admitted user only.
 * The body is exactly the four fields of ProfileDeleteRequest; payload_hash covers confirmation and confirmed_profile_id,
 * so a repeat of the same command_id always sends the same body.
 */
export type ProfileDeleteIntent = { profileId: string; commandId: string };
export type ProfileDeleteCredentials = { token: string; proof: string; clientInstanceId: string };

/**
 * What one attempt ended with, before the screen applies the classes of §3.7 (they also depend on whether an earlier
 * attempt of this command_id had an unknown outcome):
 * - applied: 200 applied/already_applied for this command_id, or 403 PROFILE_DELETED on any attempt (§5 п.3);
 * - refused: a 4xx the core gives before any write of the deletion (ACCESS_*, CLIENT_INCOMPATIBLE, FORBIDDEN with the
 *   proof sent);
 * - auth: 401 AUTH_INVALID / AUTH_EXPIRED (before any write; on a repeat the outcome is unknown, PD-28);
 * - defect: 422, 409 COMMAND_PAYLOAD_MISMATCH, or a 4xx this client cannot produce (FORBIDDEN without proof never leaves
 *   this module): the same request could not be answered so;
 * - write_unavailable: 503 WRITE_UNAVAILABLE of the core: rolled back;
 * - maintenance: 503 MAINTENANCE (the pause responder, not a proof of non-application);
 * - unknown: a timeout, a broken connection, 502/504, a 5xx without the core's body, an unreadable 200;
 * - paused: the write gate kept the request on the client (PAUSED_BEFORE_SEND): nothing left.
 */
export type ProfileDeleteReply =
  | { outcome: "applied"; status: "applied" | "already_applied" | "profile_deleted" }
  | { outcome: "refused"; code: string }
  | { outcome: "auth"; code: string | null }
  | { outcome: "defect"; status: number; code: string | null }
  | { outcome: "write_unavailable" }
  | { outcome: "maintenance" }
  | { outcome: "unknown" }
  | { outcome: "paused" };

/** The one read that decides a defect code on a repeat (§3.7): the same session reads a profile projection. */
export type ProfileCheckReply = "not_deleted" | "deleted" | "auth" | "unknown";

export interface ProfileDeleteApi {
  delete(credentials: ProfileDeleteCredentials, intent: ProfileDeleteIntent): Promise<ProfileDeleteReply>;
  check(token: string): Promise<ProfileCheckReply>;
}

/** FORBIDDEN here always has the proof header sent: this module never sends without it (§3.4 steps 6–8). */
const REFUSED_403 = new Set(["ACCESS_PENDING", "ACCESS_REJECTED", "FORBIDDEN"]);

export function deleteBody(intent: ProfileDeleteIntent, clientInstanceId: string) {
  return { command_id: intent.commandId, confirmed_profile_id: intent.profileId, confirmation: "delete_profile" as const,
    client_instance_id: clientInstanceId };
}

function appliedFact(value: unknown, commandId: string): "applied" | "already_applied" | null {
  if (!record(value) || !exactKeys(value, ["command", "deletion", "session"]) || value.session !== "revoked") return null;
  const command = value.command, deletion = value.deletion;
  if (!record(command) || !sameId(command.id, commandId) || command.kind !== "profile.delete"
    || !oneOf(command.status, ["applied", "already_applied"]) || !eventTime(command.applied_at)) return null;
  // S-009, И15: the archive is still pending and nothing says «fully deleted».
  if (!record(deletion) || !uuid(deletion.request_id) || deletion.working_data !== "deleted" || deletion.archive !== "pending"
    || deletion.fully_deleted !== false || typeof deletion.archive_deadline !== "string") return null;
  return command.status as "applied" | "already_applied";
}

export function classifyDeleteReply(reply: JsonReply, commandId: string): ProfileDeleteReply {
  const code = errorCode(reply.value) ?? null;
  if (reply.status === 200) {
    const status = appliedFact(reply.value, commandId);
    return status ? { outcome: "applied", status } : { outcome: "unknown" };
  }
  if (reply.status === 403 && code === "PROFILE_DELETED") return { outcome: "applied", status: "profile_deleted" };
  if (reply.status === 401) return { outcome: "auth", code };
  if (code !== null && (reply.status === 403 && REFUSED_403.has(code) || reply.status === 409 && code === "CLIENT_INCOMPATIBLE")) {
    return { outcome: "refused", code };
  }
  if (reply.status === 503 && code === "MAINTENANCE") return { outcome: "maintenance" };
  if (reply.status === 503 && code === "WRITE_UNAVAILABLE") return { outcome: "write_unavailable" };
  if (reply.status >= 400 && reply.status < 500 && reply.status !== 408 && reply.status !== 429) {
    return { outcome: "defect", status: reply.status, code };
  }
  return { outcome: "unknown" };
}

export function createProfileDeleteApi(options: HttpOptions): ProfileDeleteApi {
  const request = createJsonTransport(options);
  return {
    async delete(credentials, intent) {
      if (!credentials.token || !credentials.proof || !uuid(credentials.clientInstanceId) || !uuid(intent.profileId)
        || !uuid(intent.commandId)) throw new Error("invalid profile deletion");
      let reply: JsonReply;
      try {
        reply = await request("/profile/delete", { method: "POST", token: credentials.token, proof: credentials.proof,
          body: deleteBody(intent, credentials.clientInstanceId) });
      } catch (error) {
        if (error instanceof PausedBeforeSendError) return { outcome: "paused" };
        // An unreadable refusal keeps its status (http.ts): a 4xx without a body is still answered before any write.
        if (error instanceof ApiError && error.kind === "http" && error.status !== undefined) {
          return classifyDeleteReply({ status: error.status, ok: false, value: undefined }, intent.commandId);
        }
        return { outcome: "unknown" };
      }
      return classifyDeleteReply(reply, intent.commandId);
    },
    async check(token) {
      if (!token) throw new Error("invalid profile check");
      let reply: JsonReply;
      try { reply = await request("/settings", { method: "GET", token }); }
      catch { return "unknown"; }
      const code = errorCode(reply.value);
      if (reply.status === 200 && record(reply.value)) return "not_deleted";
      if (reply.status === 403 && code === "PROFILE_DELETED") return "deleted";
      if (reply.status === 401) return "auth";
      return "unknown";
    },
  };
}
