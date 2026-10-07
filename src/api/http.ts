/** The contract version of this client, sent with every write and with sign-in/open (the server compares for equality). */
export function clientContractVersion(): string {
  return import.meta.env.VITE_WORTLY_CONTRACT_VERSION || "1";
}

/** The header the core reads on POST /commands and /access/reapply; a write without it is refused as incompatible. */
export const CONTRACT_VERSION_HEADER = "X-Wortly-Contract-Version";

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
};

type Request = {
  method: "GET" | "POST";
  token?: string;
  proof?: string;
  body?: object;
};

/** retryAfter: whole seconds of a numeric Retry-After header, when the reply carried one. */
export type JsonReply = { status: number; ok: boolean; value: unknown; retryAfter?: number };

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
  return async (path: string, request: Request): Promise<JsonReply> => {
    const controller = new AbortController();
    let refusalStatus: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new ApiError("network"));
        controller.abort();
      }, timeoutMs);
    });
    const exchange = async (): Promise<JsonReply> => {
      const headers: Record<string, string> = {};
      if (request.token) headers.Authorization = `Bearer ${request.token}`;
      if (request.proof) headers["X-Origin-Proof"] = request.proof;
      // Every write names the contract it was built for: reads stay open to an outdated client (CT §1), writes do not.
      if (request.method === "POST") headers[CONTRACT_VERSION_HEADER] = contractVersion;
      if (request.body !== undefined) headers["Content-Type"] = "application/json";
      const response = await fetcher(`${base}/api/v1${path}`, {
        method: request.method, headers,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
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
      return { status: response.status, ok: response.ok, value, ...(retryAfter === undefined ? {} : { retryAfter }) };
    };
    let reply: JsonReply;
    try { reply = await Promise.race([exchange(), deadline]); }
    catch (error) {
      // A stalled body cannot erase a refusal already received in the headers.
      if (refusalStatus !== undefined) throw new ApiError("http", refusalStatus);
      if (error instanceof ApiError) throw error;
      throw new ApiError("network");
    } finally { clearTimeout(timer); }
    // One place for every module: a newer window of this installation may own the document now (decision 2.3).
    if (reply.status === 409 && errorCode(reply.value) === "DOCUMENT_STALE") options.onDocumentStale?.();
    return reply;
  };
}
