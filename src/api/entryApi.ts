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
} from "./generated";

export interface EntryApi {
  auth(request: AuthRequest): Promise<AuthResponse>;
  reapply(token: string, request: ReapplyRequest): Promise<AccessCommandResponse>;
  register(token: string, request: RegisterRequest): Promise<RegisterResponse>;
  open(token: string, proof: string, request: OpenRequest): Promise<OpenedClient | BusyClient>;
}

import { ApiError as EntryApiError, createJsonTransport, httpError, type HttpOptions } from "./http";
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
    && (value.role === "owner" || value.role === "user")
    && language(value.ui_language)
    && language(value.dictionary_language)
    && (value.time_zone === null || typeof value.time_zone === "string");
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

function validOpen(value: unknown): value is OpenedClient | BusyClient {
  if (!record(value) || !validProfile(value.profile) || !validCompatibility(value.compatibility)) return false;
  if (value.status === "SESSION_BUSY") {
    if (!record(value.session) || value.session.status !== "busy") return false;
    const { stop_remote_target: target, document_conflict: conflict, document_epoch: epoch } = value.session;
    // A same-installation document conflict and its live epoch are accepted
    // here only; the entry screens do not act on them yet.
    return (target === undefined || target === null || typeof target === "string"
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target))
      && (conflict === undefined || typeof conflict === "boolean")
      && (epoch === undefined || epoch === null || validVersion(epoch));
  }
  return value.status === "opened" && nonemptyString(value.client_instance_id)
    && nonemptyString(value.document_id) && validVersion(value.document_epoch)
    && validVersion(value.proof_version)
    && (value.session === null || record(value.session)
      && nonemptyString(value.session.id)
      && (value.session.phase === "active" || value.session.phase === "summary"));
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
    token?: string, proof?: string): Promise<T> {
    const reply = await request(path, { method: "POST", body, token, proof });
    if (!reply.ok) throw httpError(reply);
    if (!valid(reply.value)) throw new EntryApiError("invalid_response");
    return reply.value;
  }

  return {
    auth: (request) => post("/auth/telegram", request, validAuth),
    reapply: (token, request) => post("/access/reapply", request, validReapply, token),
    register: (token, request) => post("/client/register", request, validRegister, token),
    open: (token, proof, request) => post("/client/open", request, validOpen, token, proof),
  };
}
