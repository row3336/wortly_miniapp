import type { Pair } from "./commandLane";
import { intentHashSync } from "./intentHash";
import {
  SendBudgetError,
  type BudgetBinding, type BudgetFamily, type BudgetLoss, type BudgetSummary, type BudgetTarget, type CreateResult, type ReserveResult,
  type SendBudgetStore, type SlotClaim,
} from "./sendBudget";
import { IdbSendBudget } from "./sendBudgetIdb";

/**
 * The durable send budget of one intent, as the recovery machine uses it (CP5b; D-CP5 10.7.2.3, C555, C556): the store
 * of the page and the binding of the intent's envelope. Every operation reports only what the store committed; a failure
 * of the store is never a proof: load answers null (an unknown count), a reservation answers null (nothing reserved), a
 * move answers false. Nothing here clears a record because something failed (D-CP5 9.2, 10.7.2.12).
 */
export type RecoveryBudget = {
  /** The count of this envelope's record; null when it cannot be established (none, another envelope, the store failed). */
  load(): Promise<BudgetSummary | null>;
  /** 2.3.1: the first send of a new intent; null when the store failed. */
  create(attempt: string): Promise<CreateResult | null>;
  /**
   * D-CP5A-DAMAGE-EXIT 3.2: the explicit start of a new session N — the damaged records of the store are listed and offered
   * as the release of this very start (none: no release). null when the store failed: no start is sent then.
   */
  createStart(attempt: string): Promise<CreateResult | null>;
  /** 2.3.2: a retry; null when the store failed. */
  reserve(attempt: string): Promise<ReserveResult | null>;
  /** C556 В1: the manual attempt of a closure C after its six automatic sends; null when the store failed. */
  reserveManual(attempt: string): Promise<ReserveResult | null>;
  beginSending(claim: SlotClaim): Promise<boolean>;
  markTransmitted(claim: SlotClaim): Promise<boolean>;
  markRetryable(claim: SlotClaim): Promise<boolean>;
  release(claim: SlotClaim): Promise<boolean>;
  forbidSends(): Promise<boolean>;
  setMaintenance(met: boolean): Promise<boolean>;
  /** 2.3.9: when the loss of a reply was found, by the server clock, and the send it waits for (D-CP5 10.3). */
  setLoss(loss: BudgetLoss): Promise<boolean>;
  /** 2.3.8: only after a proven outcome (D-CP5 9.2). */
  clear(): Promise<boolean>;
  /**
   * V-1 (stage 1, table of section 3): a refusal code that is final for this kind in this mode, by every branch of the
   * core that answers it — the record of its budget may go. Anything else keeps the record with the ban.
   */
  finalRefusal(code: string | null | undefined): boolean;
  /** A fresh attempt ID P (a UUID): every reservation names its own. */
  newAttempt(): string;
};

/** Where the store of this page comes from, and how a store that turned out unusable is given up. */
export type BudgetSource = {
  store(): Promise<SendBudgetStore>;
  /** Q34: whether the store of this page opens now (a failed open is tried again by the next call). */
  available?(): Promise<boolean>;
  /** The store answered "unavailable" (its connection closed): the next operation opens it again. */
  failed?(store: SendBudgetStore): void;
};

export type BudgetOptions = { newAttempt?(): string; now?(): number; finalRefusal?(code: string | null | undefined): boolean };

export function recoveryBudget(source: BudgetSource, binding: () => Promise<BudgetBinding>,
  options: BudgetOptions = {}): RecoveryBudget {
  let bound: Promise<BudgetBinding> | null = null;
  const bindingOnce = () => bound ??= binding();
  /**
   * C567/C568: a store whose connection closed answers "unavailable" before it starts any transaction — nothing was read
   * or written. Only then the same operation (same envelope, ID and attempt) is tried once more, on the store the page
   * opens anew. A timeout, an abort or a failed commit is no such proof: never repeated, its failure stands (unknown).
   */
  const run = async <R>(operation: (store: SendBudgetStore, binding: BudgetBinding) => Promise<R>, failure: R): Promise<R> => {
    let store: SendBudgetStore;
    try { store = await source.store(); } catch { return failure; }
    for (let tries = 0; ; tries++) {
      try { return await operation(store, await bindingOnce()); }
      catch (error) {
        if (!(error instanceof SendBudgetError && error.reason === "unavailable")) return failure;
        source.failed?.(store);
        if (tries > 0) return failure;
        let next: SendBudgetStore;
        try { next = await source.store(); } catch { return failure; }
        if (next === store) return failure;
        store = next;
      }
    }
  };
  return {
    load: () => run((store, own) => store.load(own), null),
    create: attempt => run((store, own) => store.createAndReserve(own, attempt, (options.now ?? Date.now)()), null),
    createStart: attempt => run(async (store, own) => {
      const keys = await store.listDamagedKeys();
      return keys.length > 0 ? store.createAndReserve(own, attempt, (options.now ?? Date.now)(), keys)
        : store.createAndReserve(own, attempt, (options.now ?? Date.now)());
    }, null),
    reserve: attempt => run((store, own) => store.reserve(own, attempt), null),
    reserveManual: attempt => run((store, own) => store.reserveManual(own, attempt), null),
    beginSending: claim => run((store, own) => store.beginSending(own, claim), false),
    markTransmitted: claim => run((store, own) => store.markTransmitted(own, claim), false),
    markRetryable: claim => run((store, own) => store.markRetryable(own, claim), false),
    release: claim => run((store, own) => store.release(own, claim), false),
    forbidSends: () => run((store, own) => store.forbidSends(own), false),
    setMaintenance: met => run((store, own) => store.setMaintenance(own, met), false),
    setLoss: loss => run((store, own) => store.setLoss(own, loss), false),
    clear: () => run((store, own) => store.clear(own.commandId, own.profileId), false),
    finalRefusal: code => code === "SESSION_CLOSED" || (options.finalRefusal?.(code) ?? false),
    newAttempt: () => (options.newAttempt ?? (() => globalThis.crypto.randomUUID()))(),
  };
}

/** The envelope fields of a recovered intent the binding is made of. */
export type BudgetIntent = { command_id: string; kind: string; session_id: string } & Record<string, unknown>;
export type BudgetOwner = { profileId: string; clientInstanceId: string; pair: Pair };

/**
 * The step of an intent (D-CP5 2.2.10): the result of a result command, the assignment of an answer or a present, the
 * preview of a Learning preview step, otherwise its session (a Stop, a closure C, a start or its cancel).
 */
export function budgetTarget(intent: BudgetIntent): BudgetTarget {
  for (const field of ["result_id", "assignment_id", "preview_id"] as const) {
    const id = intent[field];
    if (typeof id === "string") return { field, id: id.toLowerCase() };
  }
  return { field: "session_id", id: intent.session_id.toLowerCase() };
}

/**
 * The local fingerprint of the envelope (D-CP5 2.2.5): SHA-256 over its kind and every other field but its command_id.
 * It only tells this envelope's record from another one on this device; the server never sees it.
 */
export function envelopeHash(intent: BudgetIntent): string {
  const { command_id: _id, kind, ...rest } = intent;
  return intentHashSync(kind, rest);
}

/** Synchronous on purpose: no step of the recovery waits for the platform's digest (the store is the only wait). */
export async function budgetBinding(intent: BudgetIntent, owner: BudgetOwner, family: BudgetFamily): Promise<BudgetBinding> {
  return {
    commandId: intent.command_id, profileId: owner.profileId, clientInstanceId: owner.clientInstanceId, pair: owner.pair,
    sessionId: intent.session_id, kind: intent.kind, intentHash: envelopeHash(intent), family, target: budgetTarget(intent),
  };
}

/**
 * The store of this page (Е01: IndexedDB). The product opens IndexedDB and fails closed: no IndexedDB, a refused or
 * timed-out open — every operation fails and no send is made (Q34, D-CP5 10.2). There is no fallback in memory: the
 * memory model of the same protocol (MemorySendBudget) is only what tests put here.
 */
export const sendBudgetProvider: { make(): Promise<SendBudgetStore> } = {
  make: () => IdbSendBudget.open(),
};

type PageStore = { make: () => Promise<SendBudgetStore>; opened: Promise<SendBudgetStore>; value?: SendBudgetStore };
const stores = new WeakMap<object, PageStore>();
/**
 * One store per page (the storage wrapper of the page is the key, as for the pending slots), opened by the provider that
 * is current: a provider replaced (a test) opens its own.
 */
export function pageBudgetSource(page: object): BudgetSource {
  return {
    store: () => {
      const make = sendBudgetProvider.make;
      const held = stores.get(page);
      // C567: only a live store is handed out; one whose connection closed (versionchange, the browser) is opened anew.
      if (held && held.make === make && held.value?.isOpen?.() !== false) return held.opened;
      const opened = make();
      const entry: PageStore = { make, opened };
      stores.set(page, entry);
      opened.then(value => { entry.value = value; }, () => undefined);
      // A failed open is not kept for good: the next operation tries again, and fails closed again if it must.
      opened.catch(() => { if (stores.get(page) === entry) stores.delete(page); });
      return opened;
    },
    available: () => pageBudgetSource(page).store().then(store => store.isOpen?.() !== false, () => false),
    failed: store => {
      const held = stores.get(page);
      if (held) void held.opened.then(open => { if (open === store && stores.get(page) === held) stores.delete(page); }, () => undefined);
    },
  };
}

/**
 * What a proven outcome does to the record (D-CP5 9.2, 10.7.2.5; V-1 of stage 1): accepted, not applied in its own
 * closed session, or refused with SESSION_CLOSED — the record goes. Any other refusal keeps it with the ban on new sends,
 * so no window may send it again and the guard of a lost envelope still sees it.
 */
export function recordOutcome(budget: RecoveryBudget, outcome: "accepted" | "rejected" | "not_applied", code?: string | null): Promise<boolean> {
  if (outcome === "accepted" || outcome === "not_applied" || budget.finalRefusal(code)) return budget.clear();
  return budget.forbidSends();
}

/**
 * The pairs «kind + refusal code» of the V-1 table (A-V1-REFUSALS table 1.1 with the root notes of C083, C090) that are
 * final by every branch of the core answering them, per mode. Left out on purpose: answer.submit ASSIGNMENT_STALE
 * (one branch is final only behind the client barrier Q25), Learning result.grade/result.correct (ASSIGNMENT_STALE of
 * _close_finished_phase is not proven final), DOCUMENT_STALE, CLIENT_INCOMPATIBLE, COMMAND_PAYLOAD_MISMATCH (its record
 * waits for the confirmed closure), the oral kinds (M1d), every code not named here. SESSION_CLOSED is final for all.
 */
const FINAL_REFUSALS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  written: {
    "result.grade": ["VERSION_CONFLICT", "FORBIDDEN"], "result.correct": ["VERSION_CONFLICT", "FORBIDDEN"],
    "result.undo": ["CAPABILITY_EXPIRED", "VERSION_CONFLICT", "FORBIDDEN", "ASSIGNMENT_STALE"],
    "assignment.present": ["ASSIGNMENT_STALE"],
  },
  learning: {
    "result.undo": ["CAPABILITY_EXPIRED", "VERSION_CONFLICT", "FORBIDDEN", "ASSIGNMENT_STALE"],
    "learning.preview_next": ["ASSIGNMENT_STALE"], "learning.known": ["ASSIGNMENT_STALE"],
    "assignment.present": ["ASSIGNMENT_STALE"],
  },
};
export function finalRefusals(mode: string, kind: string): (code: string | null | undefined) => boolean {
  const codes = FINAL_REFUSALS[mode.toLowerCase()]?.[kind] ?? [];
  return code => typeof code === "string" && codes.includes(code);
}
