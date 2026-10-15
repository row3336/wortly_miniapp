import type { FeedbackCommand } from "../api/generated";
import { validProfile } from "../api/entryApi";
import { ApiError, createJsonTransport, errorCode, httpError, type HttpOptions } from "../api/http";
import { eventTime, exactKeys, oneOf, record, sameId, uuid, version } from "../api/wireValidation";

/** One message to the developer. A complaint about a card adds card_id; a general message has none (К07-099). */
export type FeedbackIntent = {
  command_id: string;
  kind: "feedback.send";
  payload: { text: string; card_id?: string };
};
/** Only a confirmed record or a definite refusal ends an exchange; everything else throws and stays unknown. */
export type FeedbackSendReply =
  | { outcome: "accepted"; inboxId: string }
  /** The server rolled the command back: nothing was written under this ID. */
  | { outcome: "refused"; code: string | null };
export type FeedbackStatusReply = { outcome: "accepted"; inboxId: string } | { outcome: "not_found" };

export interface FeedbackApi {
  send(token: string, proof: string, origin: { clientInstanceId: string; documentId: string }, intent: FeedbackIntent): Promise<FeedbackSendReply>;
  status(token: string, profileId: string, intent: FeedbackIntent): Promise<FeedbackStatusReply>;
}

/** The server rejects an empty or blank text (422), so the client never sends one. */
export function blankText(text: string): boolean { return text.trim() === ""; }

/**
 * R7-01 (К19-042, П5-022): a message or a complaint is at most 3700 UTF-16 code units, the same limit the server checks
 * (core `TEXT_MAX_UTF16`). The unit is the one of String.length, so an emoji counts two; code points are never counted.
 */
export const FEEDBACK_TEXT_MAX_UTF16 = 3700;
export function feedbackTextLength(text: string): number { return text.length; }
export function overFeedbackLimit(text: string): boolean { return feedbackTextLength(text) > FEEDBACK_TEXT_MAX_UTF16; }

export function validFeedbackIntent(value: unknown): value is FeedbackIntent {
  if (!record(value) || !exactKeys(value, ["command_id", "kind", "payload"]) || !uuid(value.command_id)
    || value.kind !== "feedback.send" || !record(value.payload)) return false;
  const payload = value.payload;
  const withCard = Object.hasOwn(payload, "card_id");
  return exactKeys(payload, withCard ? ["text", "card_id"] : ["text"])
    && typeof payload.text === "string" && !blankText(payload.text) && (!withCard || uuid(payload.card_id));
}

/**
 * A 4xx other than 401/403 (thrown for the access owner) and 408/429 (a retry may succeed) is refused before any write.
 * root decision, pending owner: broader than the M-SET convention (only 403/409/422), so a permanent 400/404/413
 * cannot lock the form forever; the owner decides whether Settings follow.
 */
function definiteRefusal(status: number): boolean {
  return status >= 400 && status < 500 && ![401, 403, 408, 429].includes(status);
}

function snapshot(intent: FeedbackIntent): FeedbackIntent {
  if (!validFeedbackIntent(intent)) throw new Error("invalid feedback intent");
  return structuredClone(intent);
}
function wireCommand(intent: FeedbackIntent, origin: { clientInstanceId: string; documentId: string }): FeedbackCommand {
  return { command_id: intent.command_id, kind: intent.kind, client_instance_id: origin.clientInstanceId,
    document_id: origin.documentId, payload: structuredClone(intent.payload) };
}

/**
 * The fact of an applied command. The text is never part of it; the record is named by reference only.
 * A deleted inbox record leaves the fact valid with an unavailable projection.
 */
function savedInbox(fact: unknown, current: unknown, intent: FeedbackIntent): string | null {
  if (!record(fact) || !sameId(fact.id, intent.command_id) || fact.kind !== "feedback.send"
    || !oneOf(fact.status, ["applied", "already_applied"]) || !eventTime(fact.applied_at) || !uuid(fact.target_id)) return null;
  if (record(current) && exactKeys(current, ["status"]) && current.status === "unavailable") return fact.target_id;
  return record(current) && exactKeys(current, ["inbox_id", "card_id"]) && sameId(current.inbox_id, fact.target_id)
    && current.card_id === (intent.payload.card_id ?? null) ? fact.target_id : null;
}

export function createFeedbackApi(options: HttpOptions): FeedbackApi {
  const request = createJsonTransport(options);
  return {
    async send(token, proof, origin, original) {
      if (!token || !proof || !uuid(origin.clientInstanceId) || !uuid(origin.documentId)) throw new Error("invalid feedback command");
      const intent = snapshot(original);
      // R7-01: a text over the limit is never sent. A stored intent from before the limit (the check is on the text, not on
      // the stored shape) ends as a definite refusal, so the text stays and the person is asked to shorten it.
      if (overFeedbackLimit(intent.payload.text)) return { outcome: "refused", code: "VALIDATION_FAILED" };
      const reply = await request("/commands", { method: "POST", token, proof, body: wireCommand(intent, origin) });
      const value = reply.value;
      if (reply.status === 200 && record(value) && version(value.state_version) && value.error == null) {
        const inboxId = savedInbox(value.command, value.current, intent);
        if (inboxId !== null) return { outcome: "accepted", inboxId };
      } else if (definiteRefusal(reply.status)) {
        return { outcome: "refused", code: errorCode(value) ?? null };
      }
      if (!reply.ok) throw httpError(reply);
      throw new ApiError("invalid_response");
    },
    async status(token, profileId, original) {
      if (!token || !uuid(profileId)) throw new Error("invalid feedback subject");
      const intent = snapshot(original);
      const reply = await request.readback(intent.command_id, `/commands/${intent.command_id}`, { method: "GET", token });
      if (!reply.ok) throw httpError(reply);
      const value = reply.value;
      if (reply.status !== 200 || !record(value) || !record(value.command) || !version(value.state_version) || value.error != null) {
        throw new ApiError("invalid_response");
      }
      const fact = value.command;
      if (fact.status === "not_found" && sameId(fact.id, intent.command_id) && validProfile(value.current)
        && sameId(value.current.profile_id, profileId)) return { outcome: "not_found" };
      const inboxId = fact.status === "already_applied" ? savedInbox(fact, value.current, intent) : null;
      if (inboxId !== null) return { outcome: "accepted", inboxId };
      throw new ApiError("invalid_response");
    },
  };
}
