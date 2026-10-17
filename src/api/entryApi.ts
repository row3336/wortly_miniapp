import type {
  AccessCommandResponse,
  AuthRequest,
  AuthResponse,
  BusyClient,
  OpenRequest,
  OpenedClient,
  Profile,
  ReapplyRequest,
  RegisterRequest,
  RegisterResponse,
  IncompatibleClient,
} from "./generated";

export interface EntryApi {
  auth(request: AuthRequest): Promise<AuthResponse>;
  reapply(token: string, request: ReapplyRequest): Promise<AccessCommandResponse>;
  register(token: string, request: RegisterRequest): Promise<RegisterResponse>;
  /**
   * hooks (M-P03-10): who asked (L2 п.8 origin) and the gate's stamp of this open (§2 п.3), told right before it leaves;
   * the entry gives the stamp back to the gate with noteDefinite/noteForbiddenBeforeChange.
   */
  open(token: string, proof: string, request: OpenRequest, hooks?: OpenHooks): Promise<OpenedClient | BusyClient | IncompatibleClient>;
}

export type OpenHooks = { origin?: RequestOrigin; stamped?: (stamp: RequestStamp) => void };

import { ApiError as EntryApiError, createJsonTransport, httpError, type HttpOptions } from "./http";
import type { RequestOrigin, RequestStamp } from "../commands/writeGate";
import { exactKeys, uuid } from "./wireValidation";
import { validNotices } from "../notices/noticeApi";
export { ApiError as EntryApiError } from "./http";

type FetchOptions = HttpOptions;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validVersion(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value)
    && BigInt(value) <= 9223372036854775807n;
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function language(value: unknown): boolean {
  return value === "ru" || value === "uk" || value === "en";
}

function eventTime(value: unknown): value is string {
  if (typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|\+00:00)$/.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 19) === value.slice(0, 19);
}

function validCompatibility(value: unknown): boolean {
  return record(value) && typeof value.compatible === "boolean" && nonemptyString(value.contract_version);
}

export function validProfile(value: unknown): value is Profile {
  if (!record(value) || !record(value.access)) return false;
  return nonemptyString(value.profile_id) && validVersion(value.state_version)
    && validVersion(value.access.version)
    && (value.access.status === "admitted" || value.access.status === "pending" || value.access.status === "rejected")
    && (value.access.reason === null || typeof value.access.reason === "string")
    // An older core does not send reapply_closed: absent reads as "not closed", so either rollout order works.
    && (value.reapply_closed === undefined || typeof value.reapply_closed === "boolean")
    && (value.role === "owner" || value.role === "user")
    && language(value.ui_language)
    && language(value.dictionary_language)
    && (value.time_zone === null || typeof value.time_zone === "string");
}

const PROFILE_KEYS = ["profile_id", "access", "role", "ui_language", "dictionary_language", "time_zone", "state_version"];

/** validProfile plus no unknown keys, for status replies that must not carry private fields.
 * reapply_closed stays optional (an older core omits it) and is the only key allowed beyond the fixed list. */
export function validExactProfile(value: unknown): value is Profile {
  return validProfile(value) && uuid(value.profile_id)
    && exactKeys(value, Object.hasOwn(value, "reapply_closed") ? [...PROFILE_KEYS, "reapply_closed"] : PROFILE_KEYS)
    && exactKeys(value.access, ["status", "version", "reason"]);
}

function validAuth(value: unknown): value is AuthResponse {
  return record(value) && nonemptyString(value.access_token) && eventTime(value.expires_at)
    && validProfile(value.profile) && validCompatibility(value.compatibility);
}

function validRegister(value: unknown): value is RegisterResponse {
  return record(value) && nonemptyString(value.client_instance_id)
    && (value.status === "registered" || value.status === "already_registered")
    && validVersion(value.proof_version) && typeof value.activated === "boolean"
    && (value.origin_proof === undefined || value.origin_proof === null || typeof value.origin_proof === "string");
}

function validSessionReference(value: unknown): boolean {
  return value === null || record(value) && nonemptyString(value.id)
    && (value.phase === "active" || value.phase === "summary");
}

function validIncompatible(value: Record<string, unknown>): boolean {
  return nonemptyString(value.client_instance_id) && validProfile(value.profile)
    && validSessionReference(value.session) && validCompatibility(value.compatibility);
}

/** The pending notices an opened or busy answer carries (project notices ed.2.4 §5; core a2c29f4): absent or null from an
 * older core, else every item exactly a NoticeView. */
function validOpenNotices(value: Record<string, unknown>): boolean {
  return value.notices === undefined || value.notices === null || validNotices(value.notices);
}

function validOpen(value: unknown): value is OpenedClient | BusyClient | IncompatibleClient {
  if (record(value) && value.status === "incompatible") return validIncompatible(value);
  if (!record(value) || !validProfile(value.profile) || !validCompatibility(value.compatibility)) return false;
  if (!validOpenNotices(value)) return false;
  if (value.status === "SESSION_BUSY") {
    if (!record(value.session) || value.session.status !== "busy") return false;
    const { stop_remote_target: target, document_conflict: conflict, document_epoch: epoch } = value.session;
    // document_conflict is always false since decision 2.3 (a new document of the same installation takes over);
    // older cores' fields are still accepted here and ignored by entryController.
    return (target === undefined || target === null || typeof target === "string"
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target))
      && (conflict === undefined || typeof conflict === "boolean")
      && (epoch === undefined || epoch === null || validVersion(epoch));
  }
  return value.status === "opened" && nonemptyString(value.client_instance_id)
    && nonemptyString(value.document_id) && validVersion(value.document_epoch)
    && validVersion(value.proof_version) && validSessionReference(value.session);
}

function validReapply(value: unknown): value is AccessCommandResponse {
  return record(value) && record(value.command) && nonemptyString(value.command.id)
    && (value.command.status === "applied" || value.command.status === "already_applied")
    && eventTime(value.command.applied_at)
    && (value.command.target_id === null || nonemptyString(value.command.target_id))
    && validVersion(value.command.object_version)
    && validProfile(value.current);
}

export function createEntryApi(options: FetchOptions): EntryApi {
  const request = createJsonTransport(options);
  async function post<T>(path: string, body: object, valid: (value: unknown) => value is T,
    token?: string, proof?: string, hooks?: OpenHooks): Promise<T> {
    const reply = await request(path, { method: "POST", body, token, proof, ...hooks });
    if (!reply.ok) throw httpError(reply);
    // A decoder refusal names the status it read: the transport's unreadable body has none (P02-W К-11 «Класс отказа»,
    // ВР-8 against the transport of ВР-1/ВР-9).
    if (!valid(reply.value)) throw new EntryApiError("invalid_response", reply.status);
    return reply.value;
  }

  return {
    auth: (request) => post("/auth/telegram", request, validAuth),
    reapply: (token, request) => post("/access/reapply", request, validReapply, token),
    register: (token, request) => post("/client/register", request, validRegister, token),
    open: (token, proof, request, hooks) => post("/client/open", request, validOpen, token, proof, hooks),
  };
}
