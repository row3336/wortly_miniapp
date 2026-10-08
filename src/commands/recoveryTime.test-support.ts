import { createHash } from "node:crypto";
import { vi } from "vitest";

/**
 * The intent hash of a status check is the only work of the command exchanges that leaves the microtask queue (WebCrypto
 * answers from a thread pool). Computed in place, a whole exchange settles in microtasks: a test of automatic recovery
 * on fake time then never depends on how fast the machine runs.
 */
export function hashInPlace(): void {
  const subtle = globalThis.crypto.subtle;
  if (vi.isMockFunction(subtle.digest)) return;
  vi.spyOn(subtle, "digest").mockImplementation(async (_algorithm, data) => {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return Uint8Array.from(createHash("sha256").update(bytes).digest()).buffer;
  });
}
/**
 * Lets the asynchronous work of the exchanges finish without moving fake time: automatic recovery runs on its own after
 * an action, so a test waits for it to come to rest. Only microtasks: no wall clock is involved.
 */
export async function drain(): Promise<void> {
  for (let round = 0; round < 500; round++) await Promise.resolve();
}
/** Fake time moves by ms (timers fire), then the work of the exchanges settles. */
export async function tick(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await drain();
}
