import type { AsyncStorage } from "../platform/storage";
import { createdHere, noteCreatedHere } from "./pageOrigin";
import { journalRecord } from "../journal/clientJournal";

export class PendingStoreError extends Error {
  constructor(public readonly kind: "unavailable" | "invalid" | "changed" | "cancelled") { super(kind); }
}

/**
 * The slot refused to store a NEW intent before anything was written: another window's record is there ("changed"), or
 * the record there, or the intent itself, cannot be read ("invalid"). Nothing was stored, so nothing was or can be sent:
 * the one proof every lane uses to drop such an intent instead of keeping it as an unknown outcome. "unavailable" and
 * "cancelled" carry no such proof (the write itself may have happened), so they never drop anything.
 */
export function refusedUnsent(error: unknown): error is PendingStoreError {
  return error instanceof PendingStoreError && (error.kind === "changed" || error.kind === "invalid");
}

export function validId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function active(signal: AbortSignal): void {
  if (signal.aborted) throw new PendingStoreError("cancelled");
}

/** A profile's stored record could not be read or written (events TZ §4.5 c.storage): only the class, never the key or value. */
function journalStorage(kind: "storage_read" | "storage_write", error: unknown): void {
  if (!(error instanceof PendingStoreError && error.kind === "cancelled")) journalRecord({ ev: "c.storage", kind });
}

/** One temporary intent. Share the instance across document controllers; Entry owns the window lease. */
export class PendingSlot<T extends { profileId: string; mismatch?: true }> {
  private queue: Promise<unknown> = Promise.resolve();

  /** copy validates and returns a canonical, detached value, or throws PendingStoreError. */
  constructor(
    private readonly storage: AsyncStorage,
    private readonly key: string,
    private readonly copy: (value: unknown) => T,
  ) {}

  private same(left: T, right: T): boolean {
    return JSON.stringify(this.copy(left)) === JSON.stringify(this.copy(right));
  }

  private run<R>(action: () => Promise<R>): Promise<R> {
    const task = this.queue.then(action).catch((error: unknown) => {
      if (error instanceof PendingStoreError) throw error;
      throw new PendingStoreError("unavailable");
    });
    this.queue = task.catch(() => undefined);
    return task;
  }

  private async read(signal: AbortSignal): Promise<T | null> {
    active(signal);
    let raw: string | null;
    try { raw = await this.storage.get(this.key); } catch (error) { journalStorage("storage_read", error); throw error; }
    active(signal);
    if (raw === null) return null;
    let value: unknown;
    try { value = JSON.parse(raw); } catch { journalStorage("storage_read", null); throw new PendingStoreError("invalid"); }
    try { return this.copy(value); } catch (error) { journalStorage("storage_read", error); throw error; }
  }
  /** This page created the intent of commandId (decision 2.3 А): only such a record may be retried by hand. */
  noteCreated(commandId: string): void { noteCreatedHere(this.storage, commandId); }
  created(commandId: string | null | undefined): boolean { return createdHere(this.storage, commandId); }

  load(profileId: string, signal: AbortSignal): Promise<T | null> {
    return this.run(async () => {
      if (!validId(profileId)) throw new PendingStoreError("invalid");
      const current = await this.read(signal);
      active(signal);
      if (current && current.profileId !== profileId) {
        // Serialized with save/clear so this cannot erase the newer account's write.
        try { await this.storage.remove(this.key); } catch (error) { journalStorage("storage_write", error); throw error; }
        active(signal);
        return null;
      }
      return current;
    });
  }

  async save(value: T, signal: AbortSignal): Promise<void> {
    const pending = this.copy(value);
    return this.run(async () => {
      const current = await this.read(signal);
      active(signal);
      if (current && !this.same(current, pending)) throw new PendingStoreError("changed");
      if (!current) {
        try { await this.storage.set(this.key, JSON.stringify(pending)); } catch (error) { journalStorage("storage_write", error); throw error; }
        active(signal);
      }
    });
  }

  async clear(value: T, signal: AbortSignal): Promise<void> {
    const pending = this.copy(value);
    return this.run(async () => {
      const current = await this.read(signal);
      active(signal);
      if (current && !this.same(current, pending)) throw new PendingStoreError("changed");
      if (current) {
        try { await this.storage.remove(this.key); } catch (error) { journalStorage("storage_write", error); throw error; }
        active(signal);
      }
    });
  }

  /**
   * Clear the record of a conflict (Я17) after its session was closed: the stored copy may still lack the conflict
   * mark when its write failed, so the comparison leaves that one field out; every other field must match exactly.
   */
  async clearMarked(value: T, signal: AbortSignal): Promise<void> {
    const unmarked = (record: T): T => { const { mismatch: _mark, ...rest } = record; return rest as T; };
    const pending = unmarked(this.copy(value));
    return this.run(async () => {
      const current = await this.read(signal);
      active(signal);
      if (current && !this.same(unmarked(current), pending)) throw new PendingStoreError("changed");
      if (current) {
        try { await this.storage.remove(this.key); } catch (error) { journalStorage("storage_write", error); throw error; }
        active(signal);
      }
    });
  }

  /**
   * One write that replaces the stored `expected` record by `next` (the same intent with a further mark). A record that is
   * neither of them fails as "changed"; an absent record is not recreated; `next` already stored is left as it is.
   */
  async replace(expected: T, next: T, signal: AbortSignal): Promise<void> {
    const before = this.copy(expected), after = this.copy(next);
    return this.run(async () => {
      const current = await this.read(signal);
      active(signal);
      if (!current || this.same(current, after)) return;
      if (!this.same(current, before)) throw new PendingStoreError("changed");
      await this.storage.set(this.key, JSON.stringify(after));
      active(signal);
    });
  }

  async markMismatch(value: T, signal: AbortSignal): Promise<void> {
    const marked = this.copy({ ...value, mismatch: true });
    return this.run(async () => {
      const current = await this.read(signal);
      active(signal);
      if (current && !this.same({ ...current, mismatch: true }, marked)) throw new PendingStoreError("changed");
      if (!current?.mismatch) {
        try { await this.storage.set(this.key, JSON.stringify(marked)); } catch (error) { journalStorage("storage_write", error); throw error; }
        active(signal);
      }
    });
  }
}
