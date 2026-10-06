import type { ClosedSessionBoundary, ErrorDetail, MissingCommandFact, Profile, RejectedCommandFact,
  SavedCommandFact, SessionProjection, StoredCommandFact, UnavailableCurrent, UnavailableSession, WrittenAction,
  WrittenCapabilities, WrittenResult, WrittenStep } from "../api/generated";
import { validProfile } from "../api/entryApi";
import { ApiError, createJsonTransport, errorCode, httpError, type HttpOptions } from "../api/http";
import { count, date, eventTime, exactKeys, oneOf, record, sameId, uuid, validClosedSessionBoundary, version } from "../api/wireValidation";
import { validAnswerCapabilities, validAnswerFact, validSavedAnswer } from "../learning/learningAnswerApi";
import { validWrittenSessionCurrent } from "../study/sessionProjection";
import { createSessionReadApi } from "../study/sessionReadApi";
import { copyWrittenIntent, isAnswerKind, validWrittenIntent, writtenIntentHash, type WrittenCommand } from "./writtenIntent";

export type WrittenAnswer = { action: WrittenAction | null; result: WrittenResult | null; capabilities: WrittenCapabilities };
export type WrittenStepCurrent = WrittenStep | UnavailableSession | UnavailableCurrent;
export type WrittenCurrent = SessionProjection | WrittenStep | UnavailableSession;
export type WrittenSessionAddress = { session_id: string; client_instance_id: string; document_id: string };
export type WrittenResultAddress = WrittenSessionAddress & { assignment_id: string; result_id: string };
export type WrittenSessionRead = { current: SessionProjection | UnavailableSession; state_version: string };
export type WrittenResultRead = WrittenAnswer & { step: WrittenStepCurrent; state_version: string };
type Refusal = { outcome: "rejected" | "mismatch"; command: RejectedCommandFact; error: ErrorDetail };
type Accepted = { outcome: "accepted"; command: SavedCommandFact };
export type WrittenSessionReply = WrittenSessionRead & (Accepted | Refusal);
export type WrittenAnswerReply = WrittenResultRead & (Accepted | Refusal);
export type WrittenReply = WrittenSessionReply | WrittenAnswerReply;
export type WrittenStatus = { state_version: string } & (
  | { outcome: "accepted"; command: StoredCommandFact; current: SessionProjection | UnavailableSession | UnavailableCurrent }
  | (WrittenAnswer & { outcome: "accepted"; command: StoredCommandFact; step: WrittenStepCurrent })
  | { outcome: "not_found"; command: MissingCommandFact; current: Profile; closed_session?: ClosedSessionBoundary });

export interface WrittenApi {
  read(token: string, proof: string, address: WrittenSessionAddress): Promise<WrittenSessionRead>;
  readResult(token: string, proof: string, address: WrittenResultAddress): Promise<WrittenResultRead>;
  send(token: string, proof: string, command: WrittenCommand): Promise<WrittenReply>;
  status(token: string, proof: string, command: WrittenCommand): Promise<WrittenStatus>;
}

const stepKeys = ["session_id", "status", "mode", "pair", "direction", "local_date", "bucket", "close_reason", "progress",
  "assignment", "summary", "practice", "review_progress"];
const answerKeys = ["action", "result", "step", "capabilities"];

/** A written step adds practice and review progress to the public session projection; queue and answers stay hidden. */
export function validWrittenStep(value: unknown, sessionId: string): value is WrittenStepCurrent {
  if (!record(value)) return false;
  if (exactKeys(value, ["status"])) return value.status === "unavailable";
  if (oneOf(value.status, ["unavailable", "not_found"])) return exactKeys(value, ["session_id", "status"]) && sameId(value.session_id, sessionId);
  if (!exactKeys(value, stepKeys)) return false;
  // The counts and the summary belong to the session projection itself (C-WSUM) and are checked there.
  const { practice, review_progress: progress, ...base } = value;
  if (!validWrittenSessionCurrent(base, sessionId)) return false;
  if (!record(practice) || !exactKeys(practice, ["pair", "direction", "local_date", "time_zone", "count"])
    || !oneOf(practice.pair, ["ru-de", "uk-de", "en-de"]) || practice.direction !== "l1-de" || !date(practice.local_date)
    || typeof practice.time_zone !== "string" || !practice.time_zone || !count(practice.count)) return false;
  return progress === null || record(progress) && exactKeys(progress, ["interval_days", "repetitions", "ease", "due_date", "version"])
    && count(progress.interval_days) && count(progress.repetitions) && typeof progress.ease === "string"
    && date(progress.due_date) && version(progress.version);
}

type Address = { session_id: string; assignment_id: string; result_id?: string };
function answerView(value: Record<string, unknown>, address: Address): (WrittenAnswer & { step: WrittenStepCurrent }) | null {
  const step = value.step, action = value.action, result = value.result, caps = value.capabilities;
  if (!validWrittenStep(step, address.session_id) || !record(caps)) return null;
  if ((action === null) !== (result === null)) return null;
  if (action !== null && result !== null) {
    if (!("mode" in step) || !record(action) || !record(result) || !validSavedAnswer(action, result, address, step.status === "closed")) return null;
  }
  if (!validAnswerCapabilities(caps, step, action, result, address)) return null;
  return { action, result, step, capabilities: caps } as WrittenAnswer & { step: WrittenStepCurrent };
}

function sessionFact(value: unknown, command: WrittenCommand): boolean {
  if (!record(value) || isAnswerKind(command.kind)) return false;
  const target = "assignment_id" in command ? command.assignment_id : command.session_id;
  return exactKeys(value, ["id", "kind", "status", "applied_at", "target_id", "action_id", "result_id", "context_id", "object_version"])
    && sameId(value.id, command.command_id) && value.kind === command.kind && sameId(value.target_id, target)
    && oneOf(value.status, ["applied", "already_applied"]) && eventTime(value.applied_at)
    && value.action_id === null && value.result_id === null && value.context_id === null && value.object_version === null;
}
function answerFact(value: unknown, command: WrittenCommand, view: WrittenAnswer & { step: WrittenStepCurrent }): boolean {
  return (command.kind === "answer.submit" || command.kind === "result.grade" || command.kind === "result.correct")
    && validAnswerFact(value, command, view);
}
function refusal(value: Record<string, unknown>, status: number, command: WrittenCommand): Refusal | null {
  const code = errorCode(value);
  if (![403, 409, 422].includes(status) || !code || !record(value.command) || !exactKeys(value.command, ["id", "status"])
    || !sameId(value.command.id, command.command_id) || value.command.status !== "rejected"
    || !record(value.error) || !exactKeys(value.error, ["code"])) return null;
  return { outcome: code === "COMMAND_PAYLOAD_MISMATCH" ? "mismatch" : "rejected",
    command: { id: command.command_id, status: "rejected" }, error: { code } };
}
function prepare(token: string, proof: string, value: WrittenCommand): WrittenCommand {
  if (!token || !proof || !record(value) || !uuid(value.client_instance_id) || !uuid(value.document_id)) throw new Error("invalid written command");
  const { client_instance_id, document_id, ...intent } = value;
  if (!validWrittenIntent(intent)) throw new Error("invalid written command");
  return { ...copyWrittenIntent(intent), client_instance_id, document_id };
}
const origin = (address: WrittenSessionAddress) => ({ client_instance_id: address.client_instance_id, document_id: address.document_id });

/** Exact command outcome and the current step are separate facts; no automatic retry. */
export function createWrittenApi(options: HttpOptions): WrittenApi {
  const request = createJsonTransport(options), sessions = createSessionReadApi(options);
  return {
    async read(token, proof, address) {
      if (!token || !proof || !record(address) || !exactKeys(address, ["session_id", "client_instance_id", "document_id"])
        || !uuid(address.session_id) || !uuid(address.client_instance_id) || !uuid(address.document_id)) throw new Error("invalid written session access");
      const reply = await sessions.read(token, proof, { session_id: address.session_id, ...origin(address) });
      if (!validWrittenSessionCurrent(reply.current, address.session_id)) throw new ApiError("invalid_response");
      return { current: reply.current, state_version: reply.state_version };
    },
    async readResult(token, proof, address) {
      const keys = ["session_id", "assignment_id", "result_id", "client_instance_id", "document_id"] as const;
      if (!token || !proof || !record(address) || !exactKeys(address, [...keys]) || !keys.every(key => uuid(address[key]))) {
        throw new Error("invalid written result address");
      }
      const query = new URLSearchParams({ assignment_id: address.assignment_id, result_id: address.result_id, ...origin(address) });
      const reply = await request(`/sessions/${address.session_id}?${query}`, { method: "GET", token, proof });
      if (!reply.ok) throw httpError(reply);
      const value = reply.value;
      if (reply.status === 200 && record(value) && version(value.state_version) && exactKeys(value, [...answerKeys, "state_version"])) {
        const view = answerView(value, address);
        if (view) return { ...view, state_version: value.state_version };
      }
      throw new ApiError("invalid_response");
    },
    async send(token, proof, original) {
      const command = prepare(token, proof, original);
      const reply = await request("/commands", { method: "POST", token, proof, body: command });
      const value = reply.value;
      const extra = record(value) && Object.hasOwn(value, "error") ? ["error"] : [];
      if (record(value) && version(value.state_version)) {
        const stateVersion = value.state_version;
        if (isAnswerKind(command.kind) && exactKeys(value, [...answerKeys, "command", "state_version", ...extra])) {
          const view = answerView(value, command as WrittenCommand & Address);
          if (view && reply.status === 200 && value.error == null && answerFact(value.command, command, view)) {
            return { ...view, outcome: "accepted", command: value.command as SavedCommandFact, state_version: stateVersion };
          }
          const refused = view && refusal(value, reply.status, command);
          if (view && refused) return { ...view, ...refused, state_version: stateVersion };
        } else if (!isAnswerKind(command.kind) && exactKeys(value, ["command", "current", "state_version", ...extra])
          && validWrittenSessionCurrent(value.current, command.session_id)) {
          const current = value.current;
          if (reply.status === 200 && value.error == null && sessionFact(value.command, command)) {
            return { current, state_version: stateVersion, outcome: "accepted", command: value.command as SavedCommandFact };
          }
          const refused = refusal(value, reply.status, command);
          if (refused) return { current, state_version: stateVersion, ...refused };
        }
      }
      if (!reply.ok) throw httpError(reply);
      throw new ApiError("invalid_response");
    },
    async status(token, proof, original) {
      const command = prepare(token, proof, original);
      const { client_instance_id: _client, document_id: _document, ...intent } = command;
      const expectedHash = await writtenIntentHash(intent);
      const query = new URLSearchParams({ ...origin(command), session_id: command.session_id, expected_intent_hash: expectedHash });
      const reply = await request(`/commands/${command.command_id}?${query}`, { method: "GET", token, proof });
      // A 409 COMMAND_PAYLOAD_MISMATCH reaches the controller as an HTTP refusal of this exact ID.
      if (!reply.ok) throw httpError(reply);
      const value = reply.value;
      if (reply.status !== 200 || !record(value) || !record(value.command) || !version(value.state_version)) throw new ApiError("invalid_response");
      const fact = value.command;
      if (fact.status === "not_found") {
        if (exactKeys(fact, ["id", "status"]) && sameId(fact.id, command.command_id)
          && exactKeys(value, ["command", "current", "state_version", ...(Object.hasOwn(value, "closed_session") ? ["closed_session"] : [])])
          && validProfile(value.current) && uuid(value.current.profile_id)
          && (!Object.hasOwn(value, "closed_session") || validClosedSessionBoundary(value.closed_session, command.session_id))) {
          return { outcome: "not_found", command: { id: command.command_id, status: "not_found" }, current: value.current,
            state_version: value.state_version,
            ...(value.closed_session === undefined ? {} : { closed_session: value.closed_session as ClosedSessionBoundary }) };
        }
        throw new ApiError("invalid_response");
      }
      // An ID/target match cannot tell another payload apart; only the server's verified fingerprint can.
      if (fact.status !== "already_applied" || value.verified_intent_hash !== expectedHash) throw new ApiError("invalid_response");
      if (isAnswerKind(command.kind)) {
        if (exactKeys(value, [...answerKeys, "command", "state_version", "verified_intent_hash"])) {
          const view = answerView(value, command as WrittenCommand & Address);
          if (view && answerFact(fact, command, view)) {
            return { ...view, outcome: "accepted", command: fact as StoredCommandFact, state_version: value.state_version };
          }
        }
      } else if (exactKeys(value, ["command", "current", "state_version", "verified_intent_hash"]) && sessionFact(fact, command)) {
        const current = value.current;
        if (validWrittenSessionCurrent(current, command.session_id)
          || record(current) && exactKeys(current, ["status"]) && current.status === "unavailable") {
          return { outcome: "accepted", command: fact as StoredCommandFact,
            current: current as SessionProjection | UnavailableSession | UnavailableCurrent, state_version: value.state_version };
        }
      }
      throw new ApiError("invalid_response");
    },
  };
}
