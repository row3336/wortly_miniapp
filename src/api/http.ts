import { clientJournal, journalRecord, journalRefusal } from "../journal/clientJournal";
import { isCommandKind, isErrorCode, journalId, ATTEMPT_MAX_MS, type CommandReplyEvent } from "../journal/events";

/** The contract version of this client, sent with every write and with sign-in/open (the server compares for equality). */
export function clientContractVersion(): string {
  return import.meta.env.VITE_WORTLY_CONTRACT_VERSION || "1";
}

/** The header the core reads on POST /commands and /access/reapply; a write without it is refused as incompatible. */
export const CONTRACT_VERSION_HEADER = "X-Wortly-Contract-Version";

/**
 * The ID of one HTTP attempt (events TZ §2.1 `trace`): a new UUIDv4 on every request, echoed by the core on its answer.
 * It ties a refusal without a body (422/403/503) to the client journal; it is no command ID and never repeats.
 */
export const TRACE_HEADER = "X-Wortly-Trace-Id";

/** What a planned pause (503 MAINTENANCE) says about its end: whole seconds, an estimate, never a promise; null if absent. */
export type MaintenancePause = { waitSeconds: number | null };

/** One bounded exchange. A transport error never establishes a command's outcome. */
export class ApiError extends Error {
  constructor(
    public readonly kind: "network" | "http" | "invalid_response",
    public readonly status?: number,
    public readonly code?: string,
    public readonly pause?: MaintenancePause,
  ) {
    super(kind);
  }
}

export type HttpOptions = {
  fetcher: typeof fetch;
  baseUrl?: string;
  timeoutMs: number;
  maxResponseBytes: number;
  /** Told of every DOCUMENT_STALE refusal before the caller reads it; the window, not each module, reacts. */
  onDocumentStale?(): void;
  /** Overrides clientContractVersion() for the header of every POST. */
  contractVersion?: string;
  /** The trace of each attempt; crypto.randomUUID() by default. */
  newTraceId?(): string;
};

type Request = {
  method: "GET" | "POST";
  token?: string;
  proof?: string;
  body?: object;
  /**
   * Told once the request is fully built (headers, serialized body), right before fetch is called: the last point at
   * which nothing of it has left. It proves no delivery; it only ends «not started» (Learning 21.1-А, 33.1-А).
   */
  started?: () => void;
};

/**
 * retryAfter: whole seconds of a numeric Retry-After header, when the reply carried one. trace: the attempt's
 * X-Wortly-Trace-Id as the core echoed it, when the answer carried a well-formed one.
 */
export type JsonReply = { status: number; ok: boolean; value: unknown; retryAfter?: number; trace?: string };

export function errorCode(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("error" in value)) return;
  const error = value.error;
  if (typeof error !== "object" || error === null || !("code" in error)) return;
  if (typeof error.code === "string" && /^[A-Z][A-Z0-9_]*$/.test(error.code)) return error.code;
}

function wholeSeconds(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** MAINTENANCE carries its wait in the body and the same number in Retry-After; a malformed part is dropped. estimated_end_at is not read: the wait line needs only the seconds. */
function maintenancePause(reply: JsonReply): MaintenancePause {
  const error = typeof reply.value === "object" && reply.value !== null && "error" in reply.value
    && typeof reply.value.error === "object" && reply.value.error !== null ? reply.value.error : {};
  return { waitSeconds: wholeSeconds("wait_seconds" in error ? error.wait_seconds : undefined) ?? reply.retryAfter ?? null };
}

export function httpError(reply: JsonReply): ApiError {
  const code = errorCode(reply.value);
  return new ApiError("http", reply.status, code,
    code === "MAINTENANCE" && reply.status === 503 ? maintenancePause(reply) : undefined);
}

async function readJson(response: Response, limit: number, signal: AbortSignal): Promise<unknown> {
  if (Number(response.headers.get("content-length")) > limit) {
    void response.body?.cancel().catch(() => undefined);
    throw new ApiError("invalid_response");
  }
  let text = "";
  if (response.body) {
    const reader = response.body.getReader();
    // Cancellation is best effort: a broken stream must not extend the deadline.
    const cancel = () => { void reader.cancel().catch(() => undefined); };
    signal.addEventListener("abort", cancel, { once: true });
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let size = 0;
    try {
      while (true) {
        if (signal.aborted) throw new ApiError("network");
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > limit) throw new ApiError("invalid_response");
        try { text += decoder.decode(chunk.value, { stream: true }); }
        catch { throw new ApiError("invalid_response"); }
      }
      try { text += decoder.decode(); }
      catch { throw new ApiError("invalid_response"); }
    } finally {
      signal.removeEventListener("abort", cancel);
      cancel();
      reader.releaseLock();
    }
  } else {
    text = await response.text();
    if (new TextEncoder().encode(text).byteLength > limit) throw new ApiError("invalid_response");
  }
  try { return JSON.parse(text); }
  catch { throw new ApiError("invalid_response"); }
}

export function createJsonTransport(options: HttpOptions) {
  const { fetcher, timeoutMs, maxResponseBytes } = options;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("timeoutMs must be positive");
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new Error("maxResponseBytes must be a positive safe integer");
  }
  const base = (options.baseUrl ?? "").replace(/\/+$/, "");
  const contractVersion = options.contractVersion || clientContractVersion();
  const newTraceId = options.newTraceId ?? (() => globalThis.crypto.randomUUID());
  return async (path: string, request: Request): Promise<JsonReply> => {
    const controller = new AbortController();
    let refusalStatus: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const trace = newTraceId();
    const journal = commandAttempt(path, request, trace);
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new ApiError("network"));
        controller.abort();
      }, timeoutMs);
    });
    const exchange = async (): Promise<JsonReply> => {
      const headers: Record<string, string> = {};
      headers[TRACE_HEADER] = trace;
      if (request.token) headers.Authorization = `Bearer ${request.token}`;
      if (request.proof) headers["X-Origin-Proof"] = request.proof;
      // Every write names the contract it was built for: reads stay open to an outdated client (CT §1), writes do not.
      if (request.method === "POST") headers[CONTRACT_VERSION_HEADER] = contractVersion;
      if (request.body !== undefined) headers["Content-Type"] = "application/json";
      const url = `${base}/api/v1${path}`, body = request.body === undefined ? undefined : JSON.stringify(request.body);
      request.started?.();
      journal?.started();
      const response = await fetcher(url, {
        method: request.method, headers, body,
        signal: controller.signal, cache: "no-store", credentials: "same-origin",
      });
      if (controller.signal.aborted) {
        void response.body?.cancel().catch(() => undefined);
        throw new ApiError("network");
      }
      if (!response.ok) refusalStatus = response.status;
      let value: unknown;
      try { value = await readJson(response, maxResponseBytes, controller.signal); }
      catch (error) {
        // An unreadable refusal still supplies HTTP status, never an acceptance fact.
        if (response.ok || controller.signal.aborted) throw error;
      }
      const retryAfter = /^\d{1,9}$/.test(response.headers.get("retry-after") ?? "")
        ? Number(response.headers.get("retry-after")) : undefined;
      const echo = journalId(response.headers.get(TRACE_HEADER));
      return { status: response.status, ok: response.ok, value, ...(retryAfter === undefined ? {} : { retryAfter }),
        ...(echo === null ? {} : { trace: echo }) };
    };
    let reply: JsonReply;
    try { reply = await Promise.race([exchange(), deadline]); }
    catch (error) {
      // A stalled body cannot erase a refusal already received in the headers.
      if (refusalStatus !== undefined) { journal?.answered({ status: refusalStatus, ok: false, value: undefined }); throw new ApiError("http", refusalStatus); }
      journal?.failed(timedOut ? "timeout" : error instanceof ApiError && error.kind === "invalid_response" ? "unknown" : "network");
      if (error instanceof ApiError) throw error;
      throw new ApiError("network");
    } finally { clearTimeout(timer); }
    journal?.answered(reply);
    // A lost admission or a deleted profile, seen on any route, ends the client journal at once (P04 r9 §8).
    journalRefusal(reply.status, errorCode(reply.value));
    // One place for every module: a newer window of this installation may own the document now (decision 2.3).
    if (reply.status === 409 && errorCode(reply.value) === "DOCUMENT_STALE") options.onDocumentStale?.();
    return reply;
  };
}

/** The outcome of an answered command attempt as the journal names it (events TZ §4.5 c.cmd.reply). */
function replyOutcome(reply: JsonReply): CommandReplyEvent["outcome"] {
  if (reply.ok) {
    const command = typeof reply.value === "object" && reply.value !== null && "command" in reply.value ? reply.value.command : null;
    const status = typeof command === "object" && command !== null && "status" in command ? command.status : null;
    if (status === "applied" || status === "already_applied") return status;
    return status === "rejected" ? "refused" : "unknown";
  }
  // A refusal before the write; a server failure or a failed commit (WRITE_UNAVAILABLE) may still have written.
  if (reply.status >= 400 && reply.status < 500) return "refused";
  return reply.status === 503 && errorCode(reply.value) === "MAINTENANCE" ? "refused" : "unknown";
}

/**
 * The journal of one POST /commands attempt (c.cmd.send, c.cmd.reply): the command ID and kind come from the command
 * itself, nothing else of its body is read. Any other request is not journalled here; without an admitted profile the
 * journal keeps nothing.
 */
function commandAttempt(path: string, request: Request, trace: string) {
  const journal = clientJournal();
  if (!journal || journal.admitted() === null || request.method !== "POST" || path !== "/commands") return null;
  const body = request.body as Record<string, unknown> | undefined;
  const cmd = journalId(body?.command_id), kind = body?.kind;
  if (cmd === null || !isCommandKind(kind)) return null;
  let begun: number | null = null;
  let done = false;
  const ms = () => begun === null ? undefined : Math.max(0, Math.min(ATTEMPT_MAX_MS, Math.round(performance.now() - begun)));
  const reply = (fields: Omit<CommandReplyEvent, "cts" | "ev" | "cmd" | "trace">) => {
    if (done || begun === null) return;
    done = true;
    journalRecord({ ev: "c.cmd.reply", cmd, trace, ...fields, ...(ms() === undefined ? {} : { ms: ms() }) });
  };
  return {
    started() {
      if (begun !== null) return;
      begun = performance.now();
      journalRecord({ ev: "c.cmd.send", cmd, trace, kind, attempt: journal.attempt(cmd) });
    },
    answered(answer: JsonReply) {
      const code = errorCode(answer.value);
      reply({ status: answer.status, outcome: replyOutcome(answer), ...(isErrorCode(code) ? { code } : {}) });
    },
    failed(outcome: "network" | "timeout" | "unknown") { reply({ outcome }); },
  };
}
