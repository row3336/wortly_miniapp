// Test support of the durable send budget (CP5b): the memory model of the store protocol (MemorySendBudget) as the store
// of a page, and the old two-number view of a record for the expectations of the recovery tests. Only tests use it.
import { budgetBinding, pageBudgetSource, recoveryBudget, sendBudgetProvider, type BudgetIntent, type BudgetOwner,
  type RecoveryBudget } from "./intentBudget";
import type { LaneBudgets, RecoveryIntent } from "./laneRecovery";
import { MAX_SENDS } from "./recoveryLimits";
import { MemorySendBudget, newBudgetRecord, type BudgetBinding, type BudgetFamily, type BudgetIdentity, type BudgetSlot,
  type BudgetSummary, type SendBudgetRecord } from "./sendBudget";

export const TEST_OWNER: BudgetOwner = { profileId: "0000000a-0000-4000-8000-00000000000a",
  clientInstanceId: "0000000b-0000-4000-8000-00000000000b", pair: "ru-de" };

/**
 * What the tests of a page put into or read from its store without knowing the document's identity: counts to seed for a
 * command_id (materialized under the identity of the first owner that reads it) and every load by command_id.
 */
export const testBudgetLog = {
  seeds: new Map<string, Marks>(),
  loads: [] as { commandId: string; transmitted: number | null }[],
};

/** The memory store of a page in tests: seeds counts on the first read of their command_id and logs every load. */
export class TestSendBudget extends MemorySendBudget {
  private adopt(identity: BudgetIdentity): void {
    const id = identity.commandId.toLowerCase(), marks = testBudgetLog.seeds.get(id);
    if (!marks || this.peek(id) !== undefined) return;
    this.seed(id, recordOf({ ...identity, commandId: id, family: "primary", target: { field: "session_id", id: identity.sessionId.toLowerCase() } }, marks));
  }
  override async load(identity: BudgetIdentity): Promise<BudgetSummary | null> {
    this.adopt(identity);
    const summary = await super.load(identity);
    testBudgetLog.loads.push({ commandId: identity.commandId.toLowerCase(), transmitted: summary?.transmitted ?? null });
    return summary;
  }
  override reserve(identity: BudgetIdentity, attempt: string) { this.adopt(identity); return super.reserve(identity, attempt); }
}

/** test.setup: every test gets its own store of the page (the provider is new, so a page opens a new one). */
export function installTestSendBudget(): void {
  testBudgetLog.seeds.clear();
  testBudgetLog.loads = [];
  // One store per test for every page of it, as IndexedDB is one per origin: a remount or a second App meets the same records.
  const store = new TestSendBudget();
  sendBudgetProvider.make = () => Promise.resolve(store);
}

/** The memory store a page uses now (the one the current provider gave it). */
export async function pageStore(page: object): Promise<MemorySendBudget> {
  const store = await pageBudgetSource(page).store();
  if (!(store instanceof MemorySendBudget)) throw new Error("the page has no memory test store");
  return store;
}

/** The budget of an intent over a given store (a fresh memory store by default). */
export function testBudget(intent: BudgetIntent, options: { store?: MemorySendBudget; owner?: BudgetOwner; family?: BudgetFamily;
  newAttempt?(): string; finalRefusal?(code: string | null | undefined): boolean } = {}): RecoveryBudget {
  const store = options.store ?? new MemorySendBudget();
  return recoveryBudget({ store: () => Promise.resolve(store) },
    () => budgetBinding(intent, options.owner ?? TEST_OWNER, options.family ?? "primary"),
    { ...(options.newAttempt ? { newAttempt: options.newAttempt } : {}), ...(options.finalRefusal ? { finalRefusal: options.finalRefusal } : {}) });
}

/** LaneBudgets of one lane over one memory store (page: the key of the pending losses). */
export function testLaneBudgets(store: MemorySendBudget = new MemorySendBudget(),
  options: { page?: object; owner?: BudgetOwner; family?: BudgetFamily } = {}): LaneBudgets {
  return { page: options.page ?? store, of: (intent: RecoveryIntent) => testBudget(intent as BudgetIntent, { store, ...options }) };
}

/** The record as the two numbers of the earlier page count: reserved = taken slots, transmitted = sent ones. */
export type Marks = { reserved: number; transmitted: number; lastMaintenance?: true; forbidden?: true };
export function marksOf(value: unknown): Marks | null {
  const record = value as SendBudgetRecord | undefined;
  if (!record || !Array.isArray(record.slots)) return null;
  const held = record.slots.filter(slot => slot.state !== "empty" && slot.state !== "released");
  return { reserved: held.length, transmitted: held.filter(slot => slot.state === "transmitted" || slot.state === "retryable").length,
    ...(record.lastMaintenance ? { lastMaintenance: true } : {}), ...(record.sendBan ? { forbidden: true } : {}) };
}
export async function storedMarks(store: MemorySendBudget, commandId: string): Promise<Marks | null> {
  return marksOf(store.peek(commandId.toLowerCase()));
}

let seeded = 0;
/**
 * A record with the given count, as an earlier owner left it: transmitted slots written retryable (their reply was
 * lost), the rest of reserved "sending" (a request that may have left, its outcome unknown).
 */
export async function seedMarks(store: MemorySendBudget, intent: BudgetIntent, marks: Marks,
  options: { owner?: BudgetOwner; family?: BudgetFamily } = {}): Promise<SendBudgetRecord> {
  const value = recordOf(await budgetBinding(intent, options.owner ?? TEST_OWNER, options.family ?? "primary"), marks);
  store.seed(value.commandId, value);
  return value;
}
function recordOf(binding: BudgetBinding, marks: Marks): SendBudgetRecord {
  const attempt = () => `5eed0000-0000-4000-8000-${(++seeded).toString(16).padStart(12, "0")}`;
  const record = newBudgetRecord(binding, attempt(), 0);
  const slots: BudgetSlot[] = Array.from({ length: MAX_SENDS }, (_, index): BudgetSlot =>
    index < marks.transmitted ? { state: "retryable", attempt: attempt() }
      : index < marks.reserved ? { state: "sending", attempt: attempt() } : { state: "empty" });
  return { ...record, slots, ...(marks.lastMaintenance ? { lastMaintenance: true } : {}), ...(marks.forbidden ? { sendBan: true } : {}) };
}
/** The record of commandId in the store of a page, as the two numbers. */
export async function pageMarks(page: object, commandId: string): Promise<Marks | null> {
  return storedMarks(await pageStore(page), commandId);
}

/**
 * The memory store with a log of its operations by command_id (create, reserve, manual, sending, transmitted, retryable,
 * release, forbid, maintenance, clear), an optional held creation and an optional failing clear.
 */
export class LoggedBudget extends MemorySendBudget {
  readonly ops: string[] = [];
  constructor(private readonly options: { slowCreate?: Promise<void>; clearFails?: boolean } = {}) { super(); }
  private log(op: string, commandId: string): void { this.ops.push(`${op}:${commandId.toLowerCase()}`); }
  override async createAndReserve(...args: Parameters<MemorySendBudget["createAndReserve"]>) {
    this.log("create", args[0].commandId);
    if (this.options.slowCreate) await this.options.slowCreate;
    return super.createAndReserve(...args);
  }
  override reserve(...args: Parameters<MemorySendBudget["reserve"]>) { this.log("reserve", args[0].commandId); return super.reserve(...args); }
  override reserveManual(...args: Parameters<MemorySendBudget["reserveManual"]>) { this.log("manual", args[0].commandId); return super.reserveManual(...args); }
  override beginSending(...args: Parameters<MemorySendBudget["beginSending"]>) { this.log("sending", args[0].commandId); return super.beginSending(...args); }
  override markTransmitted(...args: Parameters<MemorySendBudget["markTransmitted"]>) { this.log("transmitted", args[0].commandId); return super.markTransmitted(...args); }
  override markRetryable(...args: Parameters<MemorySendBudget["markRetryable"]>) { this.log("retryable", args[0].commandId); return super.markRetryable(...args); }
  override release(...args: Parameters<MemorySendBudget["release"]>) { this.log("release", args[0].commandId); return super.release(...args); }
  override forbidSends(...args: Parameters<MemorySendBudget["forbidSends"]>) { this.log("forbid", args[0].commandId); return super.forbidSends(...args); }
  override setMaintenance(...args: Parameters<MemorySendBudget["setMaintenance"]>) { this.log("maintenance", args[0].commandId); return super.setMaintenance(...args); }
  override async clear(commandId: string, profileId: string) {
    this.log("clear", commandId);
    if (this.options.clearFails) throw new Error("storage unavailable");
    return super.clear(commandId, profileId);
  }
}
