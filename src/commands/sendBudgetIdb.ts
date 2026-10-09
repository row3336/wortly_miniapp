import { DatabaseOpenError, openWortlyDatabase, SEND_BUDGET_STORE } from "../platform/indexedDb";
import {
  beginSendingStep, canonicalClaim, canonicalId, canonicalIdentity, canonicalLoss, canonicalRelease, canonicalStoreKey, clearAllowed,
  createConflict, damageGate, forbidStep, forgetHashStep, isDamaged, lossStep, releasesWithout,
  maintenanceStep, markRetryableStep, markTransmittedStep, newBudgetRecord, orphanOf, releaseStep, reserveStep, reservedClaim,
  SendBudgetError, summarize,
  type BudgetBinding, type BudgetIdentity, type BudgetLoss, type BudgetOrphan, type BudgetStep, type BudgetSummary,
  type CreateResult, type ReserveResult, type SendBudgetStore, type SlotClaim, type StoreEntry, type StoreKey,
} from "./sendBudget";

/** Limit for opening the database and for one transaction (D-CP5 RD 7.5). Technical: never shown on a screen. */
export const SEND_BUDGET_TIMEOUT_MS = 5_000;

type Finish<R> = (result: R) => void;

/** Every key and value of the store, read in the caller's transaction (both lists come in key order). */
function readAll(store: IDBObjectStore, then: (entries: StoreEntry[]) => void): void {
  const keys = store.getAllKeys();
  const values = store.getAll();
  values.onsuccess = () => then(values.result.map((value, index) => [keys.result[index] as StoreKey, value] as const));
}

/**
 * The send budget in IndexedDB (owner answer Е01, C040). Every operation is one transaction: the read and the write of
 * an operation happen in it without waiting for anything else, so concurrent windows queue behind each other. A result
 * is reported only on the transaction's complete event; a write is made durable ("strict") before complete where the
 * browser supports it. An abort, an error, a closed connection or no answer within the limit reject with
 * SendBudgetError: nothing is known to be written, and there is no fallback store (D-CP5 9.1).
 *
 * A failed forbidSends (C053) is only an error: nothing is kept in memory instead. The record itself forbids the next
 * send, because the refused slot was never written as retryable (C060).
 */
export class IdbSendBudget implements SendBudgetStore {
  private closed = false;

  private constructor(private readonly db: IDBDatabase, private readonly timeoutMs: number) {}

  /** Opens the installation database; rejects with SendBudgetError("unavailable") when it is missing or does not open. */
  static async open(factory: IDBFactory | undefined = globalThis.indexedDB,
    timeoutMs: number = SEND_BUDGET_TIMEOUT_MS): Promise<IdbSendBudget> {
    let budget: IdbSendBudget | null = null;
    let closedEarly = false;
    try {
      const db = await openWortlyDatabase(factory, timeoutMs, () => {
        if (budget) budget.closed = true;
        else closedEarly = true;
      });
      budget = new IdbSendBudget(db, timeoutMs);
      budget.closed = closedEarly;
      return budget;
    } catch (error) {
      if (error instanceof DatabaseOpenError) throw new SendBudgetError("unavailable");
      throw error;
    }
  }

  private transact<R>(mode: IDBTransactionMode, body: (store: IDBObjectStore, finish: Finish<R>) => void): Promise<R> {
    if (this.closed) return Promise.reject(new SendBudgetError("unavailable"));
    return new Promise<R>((resolve, reject) => {
      let transaction: IDBTransaction | undefined;
      let outcome: { value: R } | null = null;
      let settled = false;
      const settle = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        action();
      };
      const timer = setTimeout(() => settle(() => {
        // Without an answer the write may still commit later: the caller treats the count as unknown either way.
        try { transaction?.abort(); } catch { /* already finished */ }
        reject(new SendBudgetError("timeout"));
      }), this.timeoutMs);
      try {
        transaction = mode === "readwrite"
          ? this.db.transaction(SEND_BUDGET_STORE, "readwrite", { durability: "strict" })
          : this.db.transaction(SEND_BUDGET_STORE, "readonly");
        transaction.oncomplete = () => settle(() => {
          if (outcome) resolve(outcome.value);
          else reject(new SendBudgetError("failed"));
        });
        transaction.onabort = () => settle(() => reject(new SendBudgetError("failed")));
        const store = transaction.objectStore(SEND_BUDGET_STORE);
        body(store, value => { outcome = { value }; });
      } catch {
        try { transaction?.abort(); } catch { /* not started or already finished */ }
        settle(() => reject(new SendBudgetError("failed")));
      }
    });
  }

  /** Reads the record of commandId and writes the step's record in the same transaction. */
  private step<R>(commandId: string, step: (current: unknown) => BudgetStep<R>): Promise<R> {
    return this.transact<R>("readwrite", (store, finish) => {
      const request = store.get(commandId);
      request.onsuccess = () => {
        const { result, write } = step(request.result);
        if (write) store.put(write);
        finish(result);
      };
    });
  }

  createAndReserve(binding: BudgetBinding, attempt: string, createdAt: number, release?: readonly StoreKey[]): Promise<CreateResult> {
    const fresh = newBudgetRecord(binding, attempt, createdAt);
    const claim = reservedClaim(fresh);
    const own = canonicalIdentity(binding);
    const offered = release === undefined ? undefined : canonicalRelease(binding, release);
    return this.transact<CreateResult>("readwrite", (store, finish) => {
      // The damage gate reads the whole store in the same transaction: no window can slip a record in between.
      readAll(store, entries => {
        const exists = entries.some(([key]) => key === fresh.commandId);
        const gate = exists ? { allowed: true as const } : damageGate(entries, fresh, offered);
        if (!gate.allowed) { finish({ outcome: gate.reason }); return; }
        // add, never put: a record of this command_id, whatever its content, is never reset (D-CP5 2.3.1).
        const request = store.add(fresh);
        request.onsuccess = () => {
          // add as well: an existing release of this session is refused by the gate already; a duplicate aborts.
          if ("write" in gate && gate.write) store.add(gate.write);
          finish({ outcome: "reserved", claim });
        };
        request.onerror = (event) => {
          if (request.error?.name !== "ConstraintError") return;
          event.preventDefault();
          event.stopPropagation();
          // Same transaction: tell a banned record of this envelope from any other existing one.
          const existing = store.get(own.commandId);
          existing.onsuccess = () => finish(createConflict(existing.result, own));
        };
      });
    });
  }
  reserve(identity: BudgetIdentity, attempt: string): Promise<ReserveResult> {
    const own = canonicalIdentity(identity);
    const id = canonicalId(attempt);
    return this.step(own.commandId, current => reserveStep(current, own, id));
  }
  beginSending(identity: BudgetIdentity, claim: SlotClaim): Promise<boolean> {
    const own = canonicalIdentity(identity);
    const held = canonicalClaim(claim);
    return this.step(own.commandId, current => beginSendingStep(current, own, held));
  }
  markTransmitted(identity: BudgetIdentity, claim: SlotClaim): Promise<boolean> {
    const own = canonicalIdentity(identity);
    const held = canonicalClaim(claim);
    return this.step(own.commandId, current => markTransmittedStep(current, own, held));
  }
  markRetryable(identity: BudgetIdentity, claim: SlotClaim): Promise<boolean> {
    const own = canonicalIdentity(identity);
    const held = canonicalClaim(claim);
    return this.step(own.commandId, current => markRetryableStep(current, own, held));
  }
  release(identity: BudgetIdentity, claim: SlotClaim): Promise<boolean> {
    const own = canonicalIdentity(identity);
    const held = canonicalClaim(claim);
    return this.step(own.commandId, current => releaseStep(current, own, held));
  }
  forbidSends(identity: BudgetIdentity): Promise<boolean> {
    const own = canonicalIdentity(identity);
    return this.step(own.commandId, current => forbidStep(current, own));
  }
  setMaintenance(identity: BudgetIdentity, met: boolean): Promise<boolean> {
    const own = canonicalIdentity(identity);
    return this.step(own.commandId, current => maintenanceStep(current, own, met));
  }
  setLoss(identity: BudgetIdentity, loss: BudgetLoss): Promise<boolean> {
    const own = canonicalIdentity(identity);
    const found = canonicalLoss(loss);
    return this.step(own.commandId, current => lossStep(current, own, found));
  }
  load(identity: BudgetIdentity): Promise<BudgetSummary | null> {
    const own = canonicalIdentity(identity);
    return this.transact<BudgetSummary | null>("readonly", (store, finish) => {
      const request = store.get(own.commandId);
      request.onsuccess = () => finish(summarize(request.result, own));
    });
  }
  clear(commandId: string, profileId: string): Promise<boolean> {
    const id = canonicalId(commandId);
    const profile = canonicalId(profileId);
    return this.removeIf(id, current => clearAllowed(current, id, profile));
  }
  clearDamaged(key: StoreKey): Promise<boolean> {
    const id = canonicalStoreKey(key);
    return this.removeIf(id, current => current !== undefined && isDamaged(id, current));
  }
  /** Deletes the record under id when allowed and takes the key out of every release, in one transaction. */
  private removeIf(id: StoreKey, allowed: (current: unknown) => boolean): Promise<boolean> {
    return this.transact<boolean>("readwrite", (store, finish) => {
      readAll(store, entries => {
        const current = entries.find(([key]) => key === id)?.[1];
        if (!allowed(current)) { finish(false); return; }
        const { puts, deletes } = releasesWithout(entries, id);
        store.delete(id);
        puts.forEach(release => store.put(release));
        deletes.forEach(key => store.delete(key));
        finish(true);
      });
    });
  }
  forgetHashOfOtherProfiles(profileId: string): Promise<number> {
    const profile = canonicalId(profileId);
    return this.transact<number>("readwrite", (store, finish) => {
      const request = store.getAll();
      request.onsuccess = () => {
        let changed = 0;
        for (const value of request.result) {
          const write = forgetHashStep(value, profile);
          if (write) { store.put(write); changed++; }
        }
        finish(changed);
      };
    });
  }
  listOrphans(profileId: string, sessionId: string): Promise<BudgetOrphan[]> {
    const profile = canonicalId(profileId);
    const session = canonicalId(sessionId);
    return this.transact<BudgetOrphan[]>("readonly", (store, finish) => {
      readAll(store, entries => finish(entries.flatMap(([key, value]) => orphanOf(key, value, profile, session) ?? [])));
    });
  }
}
