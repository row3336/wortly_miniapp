import { clientJournal, journalRecord, journalRefusal } from "../journal/clientJournal";
import { isCommandKind, isErrorCode, journalId, ATTEMPT_MAX_MS, type CommandReplyEvent } from "../journal/events";
import { PausedBeforeSendError, type DocMark, type ReadbackTicket, type RequestOrigin, type RequestStamp,
  type WriteGate } from "../commands/writeGate";

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

/**
 * One bounded exchange. A transport error never establishes a command's outcome. `timeout` is the client's own deadline
 * (timeoutMs) and `network` a failed or aborted fetch: the write gate's observer tells them apart (P03 RD-2, M-P03-2).
 */
export class ApiError extends Error {
  constructor(
    public readonly kind: "network" | "timeout" | "http" | "invalid_response",
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
  /**
   * Told of every DOCUMENT_STALE refusal before the caller reads it; the window, not each module, reacts. source (the
   * DOCUMENT_STALE junction P02↔P03) says locally which request got it: the window decides by it whether that answer
   * proves its document replaced or only asks for its foreground check.
   */
  onDocumentStale?(source: DocumentStaleSource): void;
  /** Overrides clientContractVersion() for the header of every POST. */
  contractVersion?: string;
  /** The trace of each attempt; crypto.randomUUID() by default. */
  newTraceId?(): string;
  /**
   * The write gate of the page (P03 RD-7 п.1, L2): required. A transport is never built without it; the construction
   * still throws outside tests if a caller bypasses the type. It decides on every request right before fetch.
   */
  gate: WriteGate;
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
  /** The one-shot permission of gate.runReadback to read a command's status (R6); never sent on the wire. */
  readbackTicket?: ReadbackTicket;
  /** Who asked (L2 п.8, M-P03-10): a press of the user or the client itself; read by the K-5 rule only. */
  origin?: RequestOrigin;
  /**
   * Told the gate's stamp of this request (requestId, document_id, episode — §2 п.3) right after L2 let it go, in the same
   * synchronous stretch as fetch: the decoder gives it back with noteDefinite/resolvePending.
   */
  stamped?: (stamp: RequestStamp) => void;
};

/**
 * The transport of one module. A command status read carries the ticket that gate.runReadback gave its caller (R6): the
 * API modules take it as an explicit parameter of their status functions (M-P03-8).
 */
export type JsonTransport = (path: string, request: Request) => Promise<JsonReply>;

/**
 * retryAfter: whole seconds of a numeric Retry-After header, when the reply carried one. retryAfterRaw: the header as
 * sent (at most 64 characters) when it was present but not 1–9 digits, for the bounds of P03 §3.5. trace: the attempt's
 * X-Wortly-Trace-Id as the core echoed it, when the answer carried a well-formed one.
 */
/**
 * The request a 409 DOCUMENT_STALE answered, as this page sent it (no wire field): its route and method, the kind and
 * command_id of a POST /commands, the document_id it named, whether the core's envelope attributed the refusal to that very
 * command ({command: {id, status: "rejected"}}), and the gate's DocMark taken when it was let go.
 */
export type DocumentStaleSource = {
  readonly method: "GET" | "POST";
  readonly route: string;
  readonly kind: string | null;
  readonly commandId: string | null;
  readonly documentId: string | null;
  readonly attributed: boolean;
  readonly mark: DocMark | null;
};

export type JsonReply = { status: number; ok: boolean; value: unknown; retryAfter?: number; retryAfterRaw?: string; trace?: string };

/** The largest wait a client accepts from one announcement, in seconds (P03 §3.5, P3-01). */
export const RETRY_AFTER_MAX_S = 900;

/**
 * An announced wait after P03 §3.5: a whole number 0…900 as is; above 900 clamped to 900; negative, fractional or not a
 * number ignored (null). anomaly marks the last two cases (the event `retry_after_anomaly` of §3.5; the client journal
 * has no such event yet — P04).
 */
export type RetryAfter = { seconds: number | null; anomaly: boolean };

/** One candidate value: undefined when absent or null (the next source is read), else its bounded reading. */
export function boundRetryAfter(value: unknown): RetryAfter | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    return { seconds: null, anomaly: true };
  }
  return value > RETRY_AFTER_MAX_S ? { seconds: RETRY_AFTER_MAX_S, anomaly: true } : { seconds: value, anomaly: false };
}

/** The Retry-After header of a reply after §3.5; a date or any non-integer is ignored as an anomaly. */
export function headerRetryAfter(reply: JsonReply): RetryAfter | undefined {
  if (reply.retryAfter !== undefined) return boundRetryAfter(reply.retryAfter);
  if (reply.retryAfterRaw === undefined) return undefined;
  const raw = reply.retryAfterRaw.trim();
  return /^\d+$/.test(raw) ? boundRetryAfter(Number(raw)) : { seconds: null, anomaly: true };
}

/**
 * The estimate of a planned pause (P03 §3.2, §3.5): error.retry_after_s, then error.wait_seconds, then Retry-After,
 * then none. The first source present decides; a malformed value is not replaced by a later source.
 */
export function readRetryAfter(reply: JsonReply): RetryAfter {
  const error = record(reply.value) && record(reply.value.error) ? reply.value.error : {};
  return boundRetryAfter(error.retry_after_s) ?? boundRetryAfter(error.wait_seconds) ?? headerRetryAfter(reply)
    ?? { seconds: null, anomaly: false };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function errorCode(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("error" in value)) return;
  const error = value.error;
  if (typeof error !== "object" || error === null || !("code" in error)) return;
  if (typeof error.code === "string" && /^[A-Z][A-Z0-9_]*$/.test(error.code)) return error.code;
}

/**
 * The wait a planned pause shows (P03 §3.2, §3.5; M-P03-9): the same reading as send_hold — error.retry_after_s first,
 * then error.wait_seconds, then Retry-After; the first source present decides, bounded to 0…900 s, a malformed one shown as
 * no estimate. estimated_end_at is not read: the wait line needs only the seconds.
 */
function maintenancePause(reply: JsonReply): MaintenancePause {
  return { waitSeconds: readRetryAfter(reply).seconds };
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
        if (signal.aborted) throw new ApiError("timeout");
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

export function createJsonTransport(options: HttpOptions): JsonTransport {
  const { fetcher, timeoutMs, maxResponseBytes, gate } = options;
  // RD-7 п.1: no production transport without the write gate.
  if (!gate && import.meta.env.MODE !== "test") throw new Error("HttpOptions.gate is required outside tests");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("timeoutMs must be positive");
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new Error("maxResponseBytes must be a positive safe integer");
  }
  const base = (options.baseUrl ?? "").replace(/\/+$/, "");
  const contractVersion = options.contractVersion || clientContractVersion();
  const newTraceId = options.newTraceId ?? (() => globalThis.crypto.randomUUID());
  const send = async (path: string, request: Request): Promise<JsonReply> => {
    const controller = new AbortController();
    let refusalStatus: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let sentMark: DocMark | null = null;
    // What this exchange actually sent (C408): taken from the serialized body in the same synchronous stretch as the gate's
    // mark, before any await, so a later change of the caller's request object cannot change who answered.
    let sent: SentRequest | null = null;
    const trace = newTraceId();
    const journal = commandAttempt(path, request, trace);
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new ApiError("timeout"));
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
      // L2 (RD-7): the gate decides here, and fetch follows in the same synchronous stretch, with no await in between.
      // A refused request is not started: started() is not told and fetch is never called.
      const refusal = gate?.admit({ method: request.method, path, body: request.body, readbackTicket: request.readbackTicket,
        ...(request.origin ? { origin: request.origin } : {}) });
      if (refusal) throw new PausedBeforeSendError(refusal);
      if (gate && request.stamped) request.stamped(gate.stamp(path, request.body));
      sentMark = gate?.docMark() ?? null;
      sent = sentRequest(path, request.method, body);
      request.started?.();
      journal?.started();
      const response = await fetcher(url, {
        method: request.method, headers, body,
        signal: controller.signal, cache: "no-store", credentials: "same-origin",
      });
      if (controller.signal.aborted) {
        void response.body?.cancel().catch(() => undefined);
        throw new ApiError("timeout");
      }
      if (!response.ok) refusalStatus = response.status;
      let value: unknown;
      try { value = await readJson(response, maxResponseBytes, controller.signal); }
      catch (error) {
        // An unreadable refusal still supplies HTTP status, never an acceptance fact.
        if (response.ok || controller.signal.aborted) throw error;
      }
      const retryAfterHeader = response.headers.get("retry-after");
      const retryAfter = /^\d{1,9}$/.test(retryAfterHeader ?? "") ? Number(retryAfterHeader) : undefined;
      const retryAfterRaw = retryAfter === undefined && retryAfterHeader !== null ? retryAfterHeader.slice(0, 64) : undefined;
      const echo = journalId(response.headers.get(TRACE_HEADER));
      return { status: response.status, ok: response.ok, value, ...(retryAfter === undefined ? {} : { retryAfter }),
        ...(retryAfterRaw === undefined ? {} : { retryAfterRaw }), ...(echo === null ? {} : { trace: echo }) };
    };
    let reply: JsonReply;
    try { reply = await Promise.race([exchange(), deadline]); }
    catch (error) {
      // Nothing left: no journal, no refusal status, the caller sees PAUSED_BEFORE_SEND as it is.
      if (error instanceof PausedBeforeSendError) throw error;
      // A stalled body cannot erase a refusal already received in the headers.
      if (refusalStatus !== undefined) {
        journal?.answered({ status: refusalStatus, ok: false, value: undefined });
        observeFailure(gate, path, request, refusalStatus >= 500 ? "unreadable_5xx" : "unreadable_4xx");
        throw new ApiError("http", refusalStatus);
      }
      journal?.failed(timedOut ? "timeout" : error instanceof ApiError && error.kind === "invalid_response" ? "unknown" : "network");
      observeFailure(gate, path, request, timedOut ? "timeout"
        : error instanceof ApiError && error.kind === "invalid_response" ? "unreadable_2xx" : "network");
      if (error instanceof ApiError) throw error;
      throw new ApiError("network");
    } finally { clearTimeout(timer); }
    observeReply(gate, path, request, reply);
    journal?.answered(reply);
    // A lost admission or a deleted profile, seen on any route, ends the client journal at once (P04 r9 §8).
    journalRefusal(reply.status, errorCode(reply.value));
    // One place for every module: a newer window of this installation may own the document now (decision 2.3).
    if (reply.status === 409 && errorCode(reply.value) === "DOCUMENT_STALE" && sent) options.onDocumentStale?.(staleSource(sent, reply, sentMark));
    return reply;
  };
  return send;
}

/**
 * The observer of the write gate (P03 §4.1 «Наблюдатель в транспорте», M-P03-4): a 503 of any kind or a broken exchange
 * on any real request closes `net`; an ordinary loss does not. The availability probe is no real request: the gate reads
 * its answers itself. Nothing here ends an episode: definiteness is told by the module decoders (§2 п.3, M-P03-10).
 */
function observeReply(gate: WriteGate | undefined, path: string, request: Request, reply: JsonReply): void {
  if (!gate || probeRoute(path) || reply.status < 500) return;
  const code = errorCode(reply.value), command = commandOf(path, request);
  if (reply.status === 503 && code === "MAINTENANCE") gate.closeByMaintenance(readRetryAfter(reply).seconds, command);
  else gate.closeByFailure(reply.status === 503 && code === "WRITE_UNAVAILABLE" ? "unavailable" : "unknown", command);
}

/** The immutable snapshot of what one exchange sent: its method and route, and the kind, command_id and document_id of its body. */
type SentRequest = { readonly method: "GET" | "POST"; readonly route: string; readonly kind: string | null;
  readonly commandId: string | null; readonly documentId: string | null };

/** Read from the serialized body that goes to fetch (the bytes sent), never from the caller's object afterwards. */
function sentRequest(path: string, method: "GET" | "POST", serialized: string | undefined): SentRequest {
  const route = path.split(/[?#]/, 1)[0];
  let body: Record<string, unknown> | undefined;
  if (serialized !== undefined) {
    try { const parsed: unknown = JSON.parse(serialized); body = record(parsed) ? parsed : undefined; } catch { body = undefined; }
  }
  const post = method === "POST" && route === "/commands";
  let documentId: string | null = typeof body?.document_id === "string" ? body.document_id : null;
  if (documentId === null && path.includes("?")) {
    try { documentId = new URLSearchParams(path.split("?", 2)[1]).get("document_id"); } catch { documentId = null; }
  }
  return Object.freeze({ method, route, kind: post && typeof body?.kind === "string" ? body.kind : null,
    commandId: post && typeof body?.command_id === "string" ? body.command_id : null, documentId });
}

/** The local attribution of a DOCUMENT_STALE (DocumentStaleSource): what this exchange sent and what the core named. */
function staleSource(sent: SentRequest, reply: JsonReply, mark: DocMark | null): DocumentStaleSource {
  const command = record(reply.value) && record(reply.value.command) ? reply.value.command : null;
  const attributed = sent.commandId !== null && command !== null && command.id === sent.commandId && command.status === "rejected";
  return Object.freeze({ ...sent, attributed, mark });
}

/** The command a request is about (its POST or the readback of its status): the anchor of an episode (§2 п.1), Z3. */
function commandOf(path: string, request: Request): string | undefined {
  const route = path.split(/[?#]/, 1)[0];
  if (request.method === "POST" && route === "/commands" && record(request.body) && typeof request.body.command_id === "string") {
    return request.body.command_id;
  }
  const status = request.method === "GET" ? /^\/commands\/([^/]+)$/.exec(route) : null;
  if (!status) return undefined;
  try { return decodeURIComponent(status[1]); } catch { return undefined; }
}

/**
 * A failed exchange: a refused connection or an unreadable answer ≥500 closes `net`. The client's own timeout and an
 * unreadable answer <500 are an ordinary loss (RD-2, in force once M-P03-2 tells the timeout apart): `net` stays as it
 * is. The one exception is the entry's foreground open: its timeout or an unreadable 2xx closes `net` (K-11 ВР-1 ahead
 * of RD-2, §4.4).
 */
function observeFailure(gate: WriteGate | undefined, path: string, request: Request,
  failure: "network" | "timeout" | "unreadable_5xx" | "unreadable_4xx" | "unreadable_2xx"): void {
  if (!gate || probeRoute(path)) return;
  const command = commandOf(path, request);
  if (failure === "network" || failure === "unreadable_5xx") { gate.closeByFailure("unknown", command); return; }
  // The foreground of the entry: its timeout and a body the transport cannot read (an unreadable 2xx) are the transport
  // class of K-11 (ВР-1, P02-W «Класс отказа»), ahead of RD-2 — they close `net`, and the series brings the ready.
  if ((failure === "timeout" || failure === "unreadable_2xx") && foregroundOpen(path, request)) gate.closeByFailure("unknown");
}

function probeRoute(path: string): boolean { return path.split(/[?#]/, 1)[0] === "/availability"; }

function foregroundOpen(path: string, request: Request): boolean {
  return request.method === "POST" && path.split(/[?#]/, 1)[0] === "/client/open" && record(request.body) && request.body.event === "foreground";
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
