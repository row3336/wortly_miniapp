import type { ClientEventBatch } from "../api/generated";
import { acceptedEvent, BATCH_MAX_BYTES, BATCH_MAX_EVENTS } from "./events";

/**
 * The client journal's intake (POST /api/v1/client/events) of a synthetic core, as core 30fe429 answers it: 200
 * {accepted: n} for a valid batch, 422 VALIDATION_FAILED otherwise. App tests put it in front of their own synthetic
 * server, so the journal of an admitted profile is on in every App test and its batches never reach a study handler
 * (which would take them for a command) or a test's own list of requests.
 */
export function withJournalIntake<F extends (url: string | URL | Request, init?: RequestInit) => Promise<Response>>(
  server: F, batches: ClientEventBatch[] = []): F {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const address = url instanceof Request ? url.url : String(url);
    if (new URL(address, "http://localhost").pathname.endsWith("/api/v1/client/events")) {
      let batch: ClientEventBatch | null = null;
      try { batch = JSON.parse(String(init?.body)); } catch { batch = null; }
      const valid = init?.method === "POST" && batch !== null && Array.isArray(batch.events) && batch.events.length >= 1
        && batch.events.length <= BATCH_MAX_EVENTS && new TextEncoder().encode(String(init.body)).byteLength <= BATCH_MAX_BYTES
        && batch.events.every(event => acceptedEvent(event) !== null);
      if (!valid) return new Response(JSON.stringify({ error: { code: "VALIDATION_FAILED" } }), { status: 422 });
      batches.push(batch!);
      return new Response(JSON.stringify({ accepted: batch!.events.length }), { status: 200 });
    }
    return server(url, init);
  }) as F;
}
