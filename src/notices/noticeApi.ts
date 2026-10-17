import type { NoticeAcked, NoticeView } from "../api/generated";
import { ApiError, createJsonTransport, errorCode, httpError, type HttpOptions } from "../api/http";
import { CLOSE_REASONS, eventTime, exactKeys, oneOf, record, sameId, uuid } from "../api/wireValidation";

/**
 * The notices of a closed session (project notices ed.2.4 §5; core a2c29f4 N1): the pending ones of the profile, and the
 * acknowledgement of one. Reading is no acknowledgement (§5: GET ≠ ack); only the explicit press acknowledges (§6).
 */
export type NoticeKind = NoticeView["kind"];
const KINDS: readonly NoticeKind[] = ["answer_loss", "oral_forced_close"];
const MODES: readonly NoticeView["mode"][] = ["written", "oral", "learning", "conjugation"];
const VIEW_KEYS = ["notice_id", "kind", "session_id", "mode", "close_reason", "created_at", "summary"];
const whole = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
/**
 * The progress of the closed session, ahead of the core (Codex C525: a later backend step adds it; core a2c29f4 sends
 * none). Accepted only absent, null or exactly the progress of a study projection (WrittenProgress), so «Осталось» of the
 * notice screen turns on when it comes and nothing else slips in.
 */
export function noticeProgress(value: unknown): { completed: number; total: number; correct: number; wrong: number } | null {
  return record(value) && exactKeys(value, ["completed", "total", "correct", "wrong"]) && whole(value.completed)
    && whole(value.total) && whole(value.correct) && whole(value.wrong) && value.completed <= value.total
    ? { completed: value.completed, total: value.total, correct: value.correct, wrong: value.wrong } : null;
}

/** One NoticeView exactly as the core sends it: defect_class may only be absent or null (Д1, CON §6.1 п.9). */
export function validNotice(value: unknown): value is NoticeView {
  if (!record(value)) return false;
  const keys = [...VIEW_KEYS, ...["defect_class", "progress"].filter(key => Object.hasOwn(value, key))];
  return exactKeys(value, keys) && (value.progress === undefined || value.progress === null || noticeProgress(value.progress) !== null)
    && uuid(value.notice_id) && oneOf(value.kind, KINDS) && uuid(value.session_id)
    && oneOf(value.mode, MODES) && oneOf(value.close_reason, CLOSE_REASONS)
    && (value.defect_class === undefined || value.defect_class === null)
    && eventTime(value.created_at) && (value.summary === null || record(value.summary));
}

/** A list of notices; one malformed item refuses the whole list (nothing of it is guessed). */
export function validNotices(value: unknown): value is NoticeView[] {
  return Array.isArray(value) && value.every(validNotice);
}

/**
 * created_at as an exactly comparable key: the wire form is UTC only (eventTime: …Z or +00:00) with any number of
 * fraction digits; the core's timestamptz keeps microseconds, which Date.parse would drop. The fraction is padded, never
 * rounded, so 00:00:01.000001Z sorts before 00:00:01.000002Z.
 */
function timeKey(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(?:Z|\+00:00)$/.exec(value);
  if (!match) return value;
  return `${match[1]}.${(match[2] ?? "").padEnd(12, "0")}`;
}
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
/** The order of showing (CON §7.2 п.4; §5 :189, §6 :204): created_at, then notice_id — as the core's ORDER BY. */
export function noticeOrder(notices: readonly NoticeView[]): NoticeView[] {
  return [...notices].sort((a, b) => order(timeKey(a.created_at), timeKey(b.created_at))
    || order(a.notice_id.toLowerCase(), b.notice_id.toLowerCase()));
}

/**
 * The end of one acknowledgement. done: applied or already_applied (T4) — after it the notice is shown on no device;
 * gone: 404 NOT_FOUND (unknown or another profile's) — nothing of it is shown any more; failed: anything else (network,
 * timeout, 5xx, a pause of the gate, a refusal) — the notice stays and is shown again until an acknowledgement ends (§5).
 * A 401/403 (AUTH_*, ACCESS_*, PROFILE_DELETED) also reaches the window through OpenedAccess.run (P04 §8 for the last).
 */
export type AckEnd = { kind: "done"; status: NoticeAcked["status"] } | { kind: "gone" } | { kind: "failed"; error: unknown };

export interface NoticeApi {
  pending(token: string): Promise<NoticeView[]>;
  ack(token: string, proof: string, noticeId: string, body: { command_id: string; client_instance_id: string }): Promise<AckEnd>;
}

export function createNoticeApi(options: HttpOptions): NoticeApi {
  const request = createJsonTransport(options);
  return {
    async pending(token) {
      // §5 (C492): the read needs the session and the admission only, no X-Origin-Proof.
      const reply = await request("/notices", { method: "GET", token });
      if (!reply.ok) throw httpError(reply);
      const value = reply.value;
      if (!record(value) || !exactKeys(value, ["notices"]) || !validNotices(value.notices)) throw new ApiError("invalid_response", reply.status);
      return noticeOrder(value.notices);
    },
    async ack(token, proof, noticeId, body) {
      if (!uuid(noticeId) || !uuid(body.command_id) || !uuid(body.client_instance_id)) throw new Error("invalid notice acknowledgement");
      let reply;
      try {
        reply = await request(`/notices/${encodeURIComponent(noticeId)}/ack`, { method: "POST", token, proof,
          body: { command_id: body.command_id, client_instance_id: body.client_instance_id }, origin: "user" });
      } catch (error) { return { kind: "failed", error }; }
      const value = reply.value;
      if (reply.status === 200 && record(value) && exactKeys(value, ["notice_id", "status", "acked_at"])
        && sameId(value.notice_id, noticeId) && oneOf(value.status, ["applied", "already_applied"]) && eventTime(value.acked_at)) {
        return { kind: "done", status: value.status as NoticeAcked["status"] };
      }
      if (reply.status === 404 && errorCode(value) === "NOT_FOUND") return { kind: "gone" };
      if (!reply.ok) throw httpError(reply);
      return { kind: "failed", error: new ApiError("invalid_response", reply.status) };
    },
  };
}
