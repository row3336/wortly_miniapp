import { exactKeys, oneOf, record, uuid } from "../api/wireValidation";
import type { Pair } from "./commandLane";
import { MAX_SENDS } from "./recoveryLimits";

/**
 * The durable send budget of one command_id (CT §6.1 п. 4; DESIGN D-CP5 2.1–2.3, CL 4.13.1а): six slots, one per
 * send. A slot is taken by one attempt P (a fresh UUID) before the request, moved to "sending" before the request may
 * leave, and to "transmitted" once it has. Only the attempt that holds a slot may move it, and a slot is freed only
 * before "sending": a late handler of an old attempt never touches another attempt's slot. Every operation is atomic on
 * the store (one IndexedDB transaction), which is what keeps all windows of an installation within six sends.
 *
 * The record holds identifiers and the slot states only: no answer text and no command content (owner answer Е01,
 * C040). Nothing here expires by time (Е01: no cleanup deadlines); a record is removed only on proof (D-CP5 9.2).
 *
 * A record may also carry a ban on new sends (C053), set after a proven refusal of the server. It survives a reload and
 * a change of owner, is never lifted, and outranks the count: a known count with the ban set allows no send.
 *
 * A sent slot stays "transmitted" — outcome not known — until the page that saw the outcome writes "retryable" (the
 * reply was lost, or the answer allows a retry). A new reservation needs every taken slot to be retryable (C060). So an
 * outcome nobody could write down — a refusal whose ban failed to commit, a crash or reload while the request was out —
 * by itself forbids the next send in every window and after every reload, until the outcome is proven.
 */

export type SlotState = "empty" | "released" | "reserved" | "sending" | "transmitted" | "retryable";
export type BudgetSlot =
  | { state: "empty" | "released" }
  | { state: "reserved" | "sending" | "transmitted" | "retryable"; attempt: string };
/** Which budget a command spends: the action itself, the closing C of D-CP4, or the cancel of a start (DST). */
export type BudgetFamily = "primary" | "stop" | "start_cancel";
/** The step an action belongs to; the guard of a lost envelope (CP5c) matches it with the open step. */
export type BudgetTarget = { field: "assignment_id" | "result_id" | "session_id"; id: string };
/**
 * When the loss of a reply was found, by the server clock (ms), the send the pause stands before (2–6) and the device
 * clock only for diagnostics (D-CP5 10.3). Absent until a loss has been found.
 */
export type BudgetLoss = { server: number; next: number; device: number };

export type SendBudgetRecord = {
  schemaVersion: 1;
  commandId: string;
  profileId: string;
  clientInstanceId: string;
  pair: Pair;
  sessionId: string;
  kind: string;
  /** SHA-256 of kind and payload (intentHash.ts). Removed when another profile signs in (Е02, D-CP5 10.6.2). */
  intentHash?: string;
  family: BudgetFamily;
  target: BudgetTarget;
  slots: BudgetSlot[];
  lastMaintenance?: true;
  /** New sends are forbidden (C053): no reservation, no "sending", no "transmitted" from then on. Never removed. */
  sendBan?: true;
  /** Device time of creation, diagnostics only: no pause and no cleanup is computed from it. */
  createdAt: number;
  loss?: BudgetLoss;
};

/** What a record must match to be this command's budget: the fields of its pending envelope (D-CP5 2.2.2–2.2.5). */
export type BudgetIdentity = {
  commandId: string;
  profileId: string;
  clientInstanceId: string;
  pair: Pair;
  sessionId: string;
  kind: string;
  intentHash: string;
};
export type BudgetBinding = BudgetIdentity & { family: BudgetFamily; target: BudgetTarget };
/** The slot an attempt holds. Every later operation of the attempt names it and the full attempt ID. */
export type SlotClaim = { slot: number; attempt: string };

/**
 * "forbidden": the record of this envelope carries the ban on new sends (C053). "blocked_by_damage": the store holds a
 * damaged record that this profile has not released for this session (C069–C075); nothing was written.
 */
export type CreateResult = { outcome: "reserved"; claim: SlotClaim } | { outcome: "exists" } | { outcome: "forbidden" }
  | { outcome: "blocked_by_damage" }
  /**
   * A release was offered, but the store holds evidence that session N is not new: a record of N, a damaged record that
   * reads as one of N, or a release of N. Nothing was written (delta QA CP5a-2 п. 1, 6).
   */
  | { outcome: "session_not_new" };
/**
 * "unknown": no record, a corrupt one or one of another envelope. The count is then unknown, never zero (CT:240).
 * "unsettled": a taken slot is not retryable yet — another attempt is under way or its outcome was never written.
 * "no_slots": all six slots are taken. This is not proven exhaustion: some may still be unsettled (C081). Whether a
 * closing C or a cancel of the start may follow is decided by budgetVerdict alone.
 */
export type ReserveResult = { outcome: "reserved"; claim: SlotClaim } | { outcome: "no_slots" } | { outcome: "unknown" }
  | { outcome: "forbidden" } | { outcome: "unsettled" };
/**
 * occupied counts every taken slot and bounds the sends; transmitted (transmitted or retryable) proves a send left;
 * unsettled counts taken slots that are not retryable.
 */
export type BudgetSummary = {
  occupied: number;
  transmitted: number;
  unsettled: number;
  lastMaintenance: boolean;
  loss: BudgetLoss | null;
  forbidden: boolean;
};
export type BudgetVerdict = "can_send" | "exhausted" | "unconfirmed" | "unknown" | "forbidden" | "unsettled";
/**
 * A record of the profile and session, for the guard of a lost envelope (CP5c). A damaged record whose profileId and
 * sessionId still read as these is listed too (QA Н3): started and forbidden are then true, and a field that does not
 * read is null. Its commandId is the store key.
 */
export type BudgetOrphan = {
  commandId: string;
  damaged: boolean;
  kind: string | null;
  family: BudgetFamily | null;
  target: BudgetTarget | null;
  intentHash: string | null;
  /** A slot reached "sending" or later: a request may have left. */
  started: boolean;
  forbidden: boolean;
  occupied: number | null;
  transmitted: number | null;
};

/** A key of the send budget store: a command_id, a release key, or whatever a damaged value was stored under. */
export type StoreKey = string | number;
export type StoreEntry = readonly [StoreKey, unknown];
/**
 * The release of damaged records for one new session N of one profile (C069, C073, C075). It is written only together
 * with the record of the explicit start of N, in the same transaction, and lists the keys of the damaged records that
 * existed then. Those records were created before N existed, so none of them can be a command of N. The release frees
 * only N, only for this profile; it never changes, repairs or deletes the damaged records themselves.
 */
export type DamageRelease = { commandId: string; schemaVersion: 1; profileId: string; session: string; keys: StoreKey[] };

/**
 * "unavailable": no store or it could not be opened; "failed": a transaction aborted; "timeout": no answer within the
 * limit. In every case nothing is known to be written: the count of the command is unknown from then on and no
 * automatic retry follows (D-CP5 9.1). There is no fallback store with a fresh budget (Е01).
 */
export class SendBudgetError extends Error {
  constructor(public readonly reason: "unavailable" | "failed" | "timeout" | "invalid_input") { super(reason); }
}

/**
 * The operations of D-CP5 table 2.3. A result is reported only after the store has committed it. An operation that
 * refuses (false) wrote nothing.
 *
 * Removing a record is allowed only after a proven outcome (D-CP5 9.2, Е02). It is not the clear() of the temporary page
 * counter: no failure path — a failed write, a timeout, a failed ban — may lead to clear().
 */
export interface SendBudgetStore {
  /**
   * 2.3.1: creates the record with slot 1 reserved; never overwrites an existing record of the same command_id. Refused
   * with "blocked_by_damage" while a damaged record is not released for this profile and binding.sessionId. release:
   * only for the explicit start of a new session (kind session.start, target its own session_id); the keys of the
   * damaged records shown before the press. It is written in the same transaction, only when the record is created.
   */
  createAndReserve(binding: BudgetBinding, attempt: string, createdAt: number, release?: readonly StoreKey[]): Promise<CreateResult>;
  /** 2.3.2: the lowest empty or released slot. */
  reserve(identity: BudgetIdentity, attempt: string): Promise<ReserveResult>;
  /** 2.3.3: reserved(P) → sending(P). false: the request must not be made. */
  beginSending(identity: BudgetIdentity, claim: SlotClaim): Promise<boolean>;
  /** 2.3.4: sending(P) → transmitted(P); true again when already transmitted(P) or retryable(P). */
  markTransmitted(identity: BudgetIdentity, claim: SlotClaim): Promise<boolean>;
  /**
   * C060: transmitted(P) → retryable(P), written by the page that saw the reply lost or a retryable answer. Never for a
   * refusal: that is forbidSends. true again when already retryable(P).
   */
  markRetryable(identity: BudgetIdentity, claim: SlotClaim): Promise<boolean>;
  /** 2.3.5: reserved(P) → released, only before "sending". */
  release(identity: BudgetIdentity, claim: SlotClaim): Promise<boolean>;
  /** C053: sets the ban on new sends of this envelope; true again when already set. Never lifted. */
  forbidSends(identity: BudgetIdentity): Promise<boolean>;
  /** 2.3.6 */
  setMaintenance(identity: BudgetIdentity, met: boolean): Promise<boolean>;
  /** 2.3.9 */
  setLoss(identity: BudgetIdentity, loss: BudgetLoss): Promise<boolean>;
  /** 2.3.7: null is an unknown count. */
  load(identity: BudgetIdentity): Promise<BudgetSummary | null>;
  /** 2.3.8: removes a valid record of this profile; the caller has the proof of D-CP5 9.2. A corrupt record stays. */
  clear(commandId: string, profileId: string): Promise<boolean>;
  /**
   * Removes the damaged record stored under exactly this key (as listOrphans gives it, case kept); the caller has the
   * proof: already_applied of this command_id under the current profile (9.2.1). Nothing else of the record is trusted.
   * The key leaves every release in the same transaction. false: no damaged record under that key.
   */
  clearDamaged(key: StoreKey): Promise<boolean>;
  /**
   * Е02, D-CP5 10.6.2: drops intentHash from every record not of this profile, a recognisable damaged one included;
   * nothing else changes and nothing is deleted.
   */
  forgetHashOfOtherProfiles(profileId: string): Promise<number>;
  /** Records of the profile and session, damaged ones included; the caller drops the ones whose envelope still exists. */
  listOrphans(profileId: string, sessionId: string): Promise<BudgetOrphan[]>;
  /**
   * C091 §4, D-CP5A-DAMAGE-EXIT 2.1: the exact keys of every damaged record in the store, of any profile and session,
   * as stored (case kept) and sorted; no field of any record. Only the start of a new session N passes them on, as the
   * release of createAndReserve; nothing else may show or log them (Е02). It only reads: it frees, repairs and clears
   * nothing. A record damaged after this read is not in the list, so the start that offers it is blocked_by_damage.
   */
  listDamagedKeys(): Promise<StoreKey[]>;
}

const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const KIND = /^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/;
const PAIRS: readonly string[] = ["ru-de", "uk-de", "en-de"];
const FAMILIES: readonly string[] = ["primary", "stop", "start_cancel"];
const TARGET_FIELDS: readonly string[] = ["assignment_id", "result_id", "session_id"];
const HELD: readonly string[] = ["reserved", "sending", "transmitted", "retryable"];
const SENT: readonly string[] = ["transmitted", "retryable"];
const FREE: readonly string[] = ["empty", "released"];
const RECORD_KEYS = ["schemaVersion", "commandId", "profileId", "clientInstanceId", "pair", "sessionId", "kind", "family",
  "target", "slots", "createdAt"];
const OPTIONAL_KEYS = ["intentHash", "lastMaintenance", "sendBan", "loss"];

function lowerId(value: unknown): value is string {
  return typeof value === "string" && LOWER_UUID.test(value);
}
function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validSlot(value: unknown): value is BudgetSlot {
  if (!record(value)) return false;
  if (oneOf(value.state, FREE)) return exactKeys(value, ["state"]);
  return oneOf(value.state, HELD) && exactKeys(value, ["state", "attempt"]) && lowerId(value.attempt);
}
export function validLoss(value: unknown): value is BudgetLoss {
  return record(value) && exactKeys(value, ["server", "next", "device"]) && timestamp(value.server)
    && timestamp(value.device) && Number.isInteger(value.next) && (value.next as number) >= 2
    && (value.next as number) <= MAX_SENDS;
}
function validTarget(value: unknown): value is BudgetTarget {
  return record(value) && exactKeys(value, ["field", "id"]) && oneOf(value.field, TARGET_FIELDS) && lowerId(value.id);
}

/**
 * The exact format of D-CP5 2.2: the key set, six slots of the known states, an attempt only on a held slot, one slot
 * per attempt, lower-case UUIDs. Anything else is not repaired and not overwritten: its count is unknown.
 */
export function validBudgetRecord(value: unknown): value is SendBudgetRecord {
  if (!record(value)) return false;
  const keys = [...RECORD_KEYS, ...OPTIONAL_KEYS.filter(key => Object.hasOwn(value, key))];
  if (!exactKeys(value, keys)) return false;
  if (value.schemaVersion !== 1 || !lowerId(value.commandId) || !lowerId(value.profileId)
    || !lowerId(value.clientInstanceId) || !oneOf(value.pair, PAIRS) || !lowerId(value.sessionId)
    || typeof value.kind !== "string" || !KIND.test(value.kind) || !oneOf(value.family, FAMILIES)
    || !validTarget(value.target) || !timestamp(value.createdAt)) return false;
  if (Object.hasOwn(value, "intentHash") && (typeof value.intentHash !== "string" || !HASH.test(value.intentHash))) return false;
  if (Object.hasOwn(value, "lastMaintenance") && value.lastMaintenance !== true) return false;
  if (Object.hasOwn(value, "sendBan") && value.sendBan !== true) return false;
  if (Object.hasOwn(value, "loss") && !validLoss(value.loss)) return false;
  const slots = value.slots;
  // Array.from turns holes into undefined: every() alone skips them and would accept a sparse array.
  if (!Array.isArray(slots) || slots.length !== MAX_SENDS || !Array.from(slots).every(validSlot)) return false;
  const attempts = slots.flatMap(slot => "attempt" in slot ? [slot.attempt] : []);
  return new Set(attempts).size === attempts.length;
}

/** A detached copy with a stable key order, so equal records compare and store identically. */
export function copyBudgetRecord(value: SendBudgetRecord): SendBudgetRecord {
  return {
    schemaVersion: 1, commandId: value.commandId, profileId: value.profileId, clientInstanceId: value.clientInstanceId,
    pair: value.pair, sessionId: value.sessionId, kind: value.kind,
    ...(value.intentHash !== undefined ? { intentHash: value.intentHash } : {}),
    family: value.family, target: { field: value.target.field, id: value.target.id },
    slots: value.slots.map(slot => "attempt" in slot ? { state: slot.state, attempt: slot.attempt } : { state: slot.state }),
    ...(value.lastMaintenance ? { lastMaintenance: true as const } : {}),
    ...(value.sendBan ? { sendBan: true as const } : {}),
    createdAt: value.createdAt,
    ...(value.loss ? { loss: { server: value.loss.server, next: value.loss.next, device: value.loss.device } } : {}),
  };
}

function invalidInput(): never {
  throw new SendBudgetError("invalid_input");
}
function lower(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}
/** The identity in canonical (lower-case) form; a malformed identity is a programming error, not an unknown count. */
export function canonicalIdentity(identity: BudgetIdentity): BudgetIdentity {
  const canonical: BudgetIdentity = {
    commandId: lower(identity.commandId), profileId: lower(identity.profileId),
    clientInstanceId: lower(identity.clientInstanceId), pair: identity.pair, sessionId: lower(identity.sessionId),
    kind: identity.kind, intentHash: lower(identity.intentHash),
  };
  if (!lowerId(canonical.commandId) || !lowerId(canonical.profileId) || !lowerId(canonical.clientInstanceId)
    || !oneOf(canonical.pair, PAIRS) || !lowerId(canonical.sessionId) || typeof canonical.kind !== "string"
    || !KIND.test(canonical.kind) || !HASH.test(canonical.intentHash)) invalidInput();
  return canonical;
}
/** A command, attempt, profile or session ID in lower case. */
export function canonicalId(id: string): string {
  const value = lower(id);
  if (!lowerId(value)) invalidInput();
  return value;
}
export function canonicalClaim(claim: SlotClaim): SlotClaim {
  if (!Number.isInteger(claim.slot) || claim.slot < 0 || claim.slot >= MAX_SENDS) invalidInput();
  return { slot: claim.slot, attempt: canonicalId(claim.attempt) };
}

export function canonicalLoss(loss: BudgetLoss): BudgetLoss {
  if (!validLoss(loss)) invalidInput();
  return { server: loss.server, next: loss.next, device: loss.device };
}

/** A new record with slot 1 reserved by the attempt (2.3.1). */
export function newBudgetRecord(binding: BudgetBinding, attempt: string, createdAt: number): SendBudgetRecord {
  const identity = canonicalIdentity(binding);
  const target = { field: binding.target.field, id: lower(binding.target.id) };
  if (!oneOf(binding.family, FAMILIES) || !validTarget(target) || !timestamp(createdAt)) invalidInput();
  const slots: BudgetSlot[] = Array.from({ length: MAX_SENDS }, () => ({ state: "empty" as const }));
  slots[0] = { state: "reserved", attempt: canonicalId(attempt) };
  return copyBudgetRecord({ schemaVersion: 1, ...identity, family: binding.family, target, slots, createdAt });
}
/** The claim of the attempt that created the record. */
export function reservedClaim(fresh: SendBudgetRecord): SlotClaim {
  const first = fresh.slots[0];
  if (!("attempt" in first)) invalidInput();
  return { slot: 0, attempt: first.attempt };
}

/** The stored value is this command's budget: valid and of the same envelope (2.2.2–2.2.5). */
function ownRecord(current: unknown, identity: BudgetIdentity): SendBudgetRecord | null {
  if (!validBudgetRecord(current)) return null;
  const same = current.commandId === identity.commandId && current.profileId === identity.profileId
    && current.clientInstanceId === identity.clientInstanceId && current.pair === identity.pair
    && current.sessionId === identity.sessionId && current.kind === identity.kind
    && current.intentHash === identity.intentHash;
  return same ? copyBudgetRecord(current) : null;
}

/** One atomic step of an operation: its result and, when it changes the record, the record to write. */
export type BudgetStep<R> = { result: R; write?: SendBudgetRecord };

export function reserveStep(current: unknown, identity: BudgetIdentity, attempt: string): BudgetStep<ReserveResult> {
  const own = ownRecord(current, identity);
  if (!own) return { result: { outcome: "unknown" } };
  if (own.sendBan) return { result: { outcome: "forbidden" } };
  const slot = own.slots.findIndex(cell => FREE.includes(cell.state));
  if (slot < 0) return { result: { outcome: "no_slots" } };
  if (own.slots.some(cell => HELD.includes(cell.state) && cell.state !== "retryable")) return { result: { outcome: "unsettled" } };
  own.slots[slot] = { state: "reserved", attempt };
  return { result: { outcome: "reserved", claim: { slot, attempt } }, write: own };
}

/**
 * Moves the claimed slot from one held state to the next, comparing the full attempt ID (C006). A move towards a send
 * (banned: true) is refused once the ban of C053 is set.
 */
function moveSlot(current: unknown, identity: BudgetIdentity, claim: SlotClaim, from: readonly SlotState[],
  to: BudgetSlot, banned: boolean): BudgetStep<boolean> {
  const own = ownRecord(current, identity);
  const cell = own?.slots[claim.slot];
  if (!own || !cell || !("attempt" in cell) || cell.attempt !== claim.attempt || !from.includes(cell.state)
    || (banned && own.sendBan)) {
    return { result: false };
  }
  own.slots[claim.slot] = to;
  return { result: true, write: own };
}

export function beginSendingStep(current: unknown, identity: BudgetIdentity, claim: SlotClaim): BudgetStep<boolean> {
  return moveSlot(current, identity, claim, ["reserved"], { state: "sending", attempt: claim.attempt }, true);
}

export function markTransmittedStep(current: unknown, identity: BudgetIdentity, claim: SlotClaim): BudgetStep<boolean> {
  const own = ownRecord(current, identity);
  const cell = own?.slots[claim.slot];
  // Marked again on the server's answer: already sent by the same attempt is a success without a write.
  if (cell && "attempt" in cell && SENT.includes(cell.state) && cell.attempt === claim.attempt) return { result: true };
  // After the ban a slot stays "sending": it still bounds the count, and nothing can read it as a spent budget.
  return moveSlot(current, identity, claim, ["sending"], { state: "transmitted", attempt: claim.attempt }, true);
}

export function markRetryableStep(current: unknown, identity: BudgetIdentity, claim: SlotClaim): BudgetStep<boolean> {
  const own = ownRecord(current, identity);
  const cell = own?.slots[claim.slot];
  if (cell && cell.state === "retryable" && cell.attempt === claim.attempt) return { result: true };
  return moveSlot(current, identity, claim, ["transmitted"], { state: "retryable", attempt: claim.attempt }, true);
}

/** Never after "sending": from then on the request may have left at any moment (CL 4.13.1а). */
export function releaseStep(current: unknown, identity: BudgetIdentity, claim: SlotClaim): BudgetStep<boolean> {
  return moveSlot(current, identity, claim, ["reserved"], { state: "released" }, false);
}

export function forbidStep(current: unknown, identity: BudgetIdentity): BudgetStep<boolean> {
  const own = ownRecord(current, identity);
  if (!own) return { result: false };
  if (own.sendBan) return { result: true };
  return { result: true, write: copyBudgetRecord({ ...own, sendBan: true }) };
}

/** What create+reserve answers when a record of the command_id is already there. */
export function createConflict(current: unknown, identity: BudgetIdentity): CreateResult {
  return ownRecord(current, identity)?.sendBan ? { outcome: "forbidden" } : { outcome: "exists" };
}

export function maintenanceStep(current: unknown, identity: BudgetIdentity, met: boolean): BudgetStep<boolean> {
  const own = ownRecord(current, identity);
  if (!own) return { result: false };
  return { result: true, write: copyBudgetRecord({ ...own, lastMaintenance: met ? true : undefined }) };
}

export function lossStep(current: unknown, identity: BudgetIdentity, loss: BudgetLoss): BudgetStep<boolean> {
  const own = ownRecord(current, identity);
  if (!own) return { result: false };
  return { result: true, write: copyBudgetRecord({ ...own, loss }) };
}

function counts(value: SendBudgetRecord): { occupied: number; transmitted: number; unsettled: number } {
  const occupied = value.slots.filter(slot => HELD.includes(slot.state)).length;
  return {
    occupied,
    transmitted: value.slots.filter(slot => SENT.includes(slot.state)).length,
    unsettled: occupied - value.slots.filter(slot => slot.state === "retryable").length,
  };
}

export function summarize(current: unknown, identity: BudgetIdentity): BudgetSummary | null {
  const own = ownRecord(current, identity);
  if (!own) return null;
  return { ...counts(own), lastMaintenance: own.lastMaintenance === true, loss: own.loss ?? null, forbidden: own.sendBan === true };
}

/**
 * The automatic decision the count allows (CT:240–241, Я15.8). The ban of C053 comes first: a known count never
 * outweighs it. Six occupied: exhausted only with six sent sends whose outcome is written as retryable (QA Н1, C081):
 * a sent slot without it may be a refusal whose ban failed to commit, and exhaustion would derive a closing C or a
 * cancel of the start from it. Anything else at six is an unconfirmed count (no seventh send, no closing). Below six:
 * a send only when every taken slot is retryable (C060).
 */
export function budgetVerdict(summary: BudgetSummary | null): BudgetVerdict {
  if (summary === null) return "unknown";
  if (summary.forbidden) return "forbidden";
  if (summary.occupied >= MAX_SENDS) {
    return summary.transmitted >= MAX_SENDS && summary.unsettled === 0 ? "exhausted" : "unconfirmed";
  }
  return summary.unsettled > 0 ? "unsettled" : "can_send";
}

export function clearAllowed(current: unknown, commandId: string, profileId: string): boolean {
  return validBudgetRecord(current) && current.commandId === commandId && current.profileId === profileId;
}

const RELEASE_PREFIX = "release:";
export function releaseKey(profileId: string, session: string): string {
  return `${RELEASE_PREFIX}${profileId}:${session}`;
}
function isReleaseKey(key: StoreKey): boolean {
  return typeof key === "string" && key.startsWith(RELEASE_PREFIX);
}
/**
 * A key the API can name: any string but a release key, any number but NaN (D-CP5A-DAMAGE-EXIT 3.1.4 (а): "" and
 * ±Infinity are valid IndexedDB keys). A Date, array or binary key is not nameable (open question, CL125).
 */
function storeKey(value: unknown): value is StoreKey {
  return (typeof value === "string" && !isReleaseKey(value)) || (typeof value === "number" && !Number.isNaN(value));
}
function sortedKeys(keys: Iterable<StoreKey>): StoreKey[] {
  return [...keys].sort((left, right) => typeof left !== typeof right ? (typeof left === "number" ? -1 : 1)
    : left < right ? -1 : left > right ? 1 : 0);
}

/** The exact format of a release under its own key; anything else releases nothing. */
export function validRelease(value: unknown, key: StoreKey): value is DamageRelease {
  if (!record(value) || !exactKeys(value, ["commandId", "schemaVersion", "profileId", "session", "keys"])) return false;
  if (value.schemaVersion !== 1 || !lowerId(value.profileId) || !lowerId(value.session)
    || value.commandId !== key || key !== releaseKey(value.profileId, value.session)) return false;
  const keys = value.keys;
  return Array.isArray(keys) && keys.length > 0 && Array.from(keys).every(storeKey) && new Set(keys).size === keys.length;
}

/** A value of the budget store that is not a release and not a valid record under its own key. */
export function isDamaged(key: StoreKey, value: unknown): boolean {
  return !isReleaseKey(key) && (!validBudgetRecord(value) || value.commandId !== key);
}

/**
 * The keys of the damaged records among the entries: the selection of damageGate, nameable keys only. A damaged record
 * under a key the API cannot name (Date, array, binary) is left out, so it keeps blocking every new record (CL125).
 */
export function damagedKeys(entries: readonly StoreEntry[]): StoreKey[] {
  return sortedKeys(entries.filter(([key, value]) => storeKey(key) && isDamaged(key, value)).map(([key]) => key));
}

/** A store key given by the caller as it is; a release key or a malformed one is a programming error. */
export function canonicalStoreKey(key: StoreKey): StoreKey {
  if (!storeKey(key)) invalidInput();
  return key;
}

/** Only the explicit start of a session may carry a release; anything else is an error of the caller. */
export function canonicalRelease(binding: BudgetBinding, keys: readonly StoreKey[]): StoreKey[] {
  const identity = canonicalIdentity(binding);
  if (identity.kind !== "session.start" || binding.family !== "primary" || binding.target.field !== "session_id"
    || lower(binding.target.id) !== identity.sessionId || !Array.isArray(keys) || !Array.from(keys).every(storeKey)) {
    invalidInput();
  }
  return sortedKeys(new Set(keys));
}

/**
 * Whether a new record may be created, seen from everything in the store in the same transaction (C075 4.1): every
 * damaged record other than the new key itself must be released for this profile and session — by an existing valid
 * release, or by the release of this very start. The release written then lists the damaged keys of that moment.
 */
export function damageGate(entries: readonly StoreEntry[], fresh: SendBudgetRecord, release?: readonly StoreKey[]):
  { allowed: false; reason: "blocked_by_damage" | "session_not_new" } | { allowed: true; write?: DamageRelease } {
  const damaged = entries.filter(([key, value]) => key !== fresh.commandId && isDamaged(key, value)).map(([key]) => key);
  if (damaged.length === 0) return { allowed: true };
  // A release rests on N being new (C073): any trace of N in the store, of any profile, refuses it.
  if (release !== undefined && entries.some(([key, value]) => key !== fresh.commandId && mentionsSession(key, value, fresh.sessionId))) {
    return { allowed: false, reason: "session_not_new" };
  }
  const ownKey = releaseKey(fresh.profileId, fresh.sessionId);
  const existing = entries.find(([key]) => key === ownKey);
  const released = new Set<StoreKey>(existing && validRelease(existing[1], ownKey) ? existing[1].keys : []);
  const offered = new Set<StoreKey>(release ?? []);
  if (!damaged.every(key => released.has(key) || offered.has(key))) return { allowed: false, reason: "blocked_by_damage" };
  if (release === undefined) return { allowed: true };
  return { allowed: true, write: { commandId: ownKey, schemaVersion: 1, profileId: fresh.profileId,
    session: fresh.sessionId, keys: sortedKeys(damaged) } };
}

/**
 * The stored value is evidence that the session already exists: a record of it (valid, or damaged but reading so) or
 * a release of it. Read conservatively: a damaged field counts against novelty, never for it.
 */
function mentionsSession(key: StoreKey, value: unknown, session: string): boolean {
  // A release key of N counts whatever it holds: a damaged release under it must not be overwritten by a new one.
  if (isReleaseKey(key)) return (typeof key === "string" && key.endsWith(`:${session}`)) || (record(value) && value.session === session);
  if (!record(value)) return false;
  const target = record(value.target) ? value.target.id : undefined;
  return lower(value.sessionId) === session || lower(target) === session;
}

/** The releases to rewrite (key removed) or delete (left empty) when the record under key is removed. */
export function releasesWithout(entries: readonly StoreEntry[], key: StoreKey): { puts: DamageRelease[]; deletes: StoreKey[] } {
  const puts: DamageRelease[] = [];
  const deletes: StoreKey[] = [];
  for (const [releaseAt, value] of entries) {
    if (!validRelease(value, releaseAt) || !value.keys.includes(key)) continue;
    const keys = value.keys.filter(other => other !== key);
    if (keys.length === 0) deletes.push(releaseAt);
    else puts.push({ ...value, keys });
  }
  return { puts, deletes };
}

/**
 * The stored value without its content fingerprint unless it is this profile's; undefined when nothing changes. A
 * damaged record loses the fingerprint too (its owner cannot be trusted either), and nothing else of it is touched:
 * the slots, the ban and the damage stay, so the returning profile gets no new budget (Е02, C053, C060).
 */
export function forgetHashStep(current: unknown, profileId: string): Record<string, unknown> | undefined {
  // The record is written back under the store's own key whatever its commandId field holds.
  if (!record(current) || !Object.hasOwn(current, "intentHash") || current.profileId === profileId) return undefined;
  if (validBudgetRecord(current)) return copyBudgetRecord({ ...current, intentHash: undefined });
  // Dropping a damaged fingerprint must not heal the record (delta QA CP5a-2 п. 2): the mark keeps it damaged.
  const { intentHash: _dropped, ...rest } = current;
  return { ...rest, damaged: true };
}

export function orphanOf(key: StoreKey, current: unknown, profileId: string, sessionId: string): BudgetOrphan | null {
  if (isReleaseKey(key) || !record(current) || current.profileId !== profileId || current.sessionId !== sessionId) return null;
  if (!isDamaged(key, current) && validBudgetRecord(current)) {
    const { occupied, transmitted } = counts(current);
    return {
      commandId: current.commandId, damaged: false, kind: current.kind, family: current.family,
      target: { field: current.target.field, id: current.target.id }, intentHash: current.intentHash ?? null,
      started: current.slots.some(slot => slot.state === "sending" || SENT.includes(slot.state)),
      forbidden: current.sendBan === true, occupied, transmitted,
    };
  }
  // Damaged: only the key is trusted for a check by number; the rest is read where it still reads, never relied on.
  // The key is reported exactly as stored, so clearDamaged can remove it.
  if (!uuid(key)) return null;
  return {
    commandId: key, damaged: true,
    kind: typeof current.kind === "string" && KIND.test(current.kind) ? current.kind : null,
    family: oneOf(current.family, FAMILIES) ? current.family as BudgetFamily : null,
    target: validTarget(current.target) ? { field: current.target.field, id: current.target.id } : null,
    intentHash: typeof current.intentHash === "string" && HASH.test(current.intentHash) ? current.intentHash : null,
    started: true, forbidden: true, occupied: null, transmitted: null,
  };
}

/**
 * The same protocol in the memory of one page, operations run one after another. Only a test double: it does not
 * survive a reload and other windows do not see it, so it never serves as a fallback store (D-CP5 9.1, Е01).
 */
export class MemorySendBudget implements SendBudgetStore {
  private readonly values = new Map<string, unknown>();
  private queue: Promise<unknown> = Promise.resolve();

  private run<R>(action: () => R): Promise<R> {
    const task = this.queue.then(action);
    this.queue = task.catch(() => undefined);
    return task;
  }
  private apply<R>(commandId: string, step: (current: unknown) => BudgetStep<R>): Promise<R> {
    return this.run(() => {
      const { result, write } = step(this.values.get(commandId));
      if (write) this.values.set(commandId, structuredClone(write));
      return result;
    });
  }

  /** Test access: put any raw value (e.g. a corrupt record) under a command_id. */
  seed(commandId: string, value: unknown): void {
    this.values.set(commandId, structuredClone(value));
  }
  /** Test access: the raw stored value. */
  peek(commandId: string): unknown {
    return structuredClone(this.values.get(commandId));
  }

  createAndReserve(binding: BudgetBinding, attempt: string, createdAt: number, release?: readonly StoreKey[]): Promise<CreateResult> {
    const fresh = newBudgetRecord(binding, attempt, createdAt);
    const claim = reservedClaim(fresh);
    const own = canonicalIdentity(binding);
    const offered = release === undefined ? undefined : canonicalRelease(binding, release);
    return this.run((): CreateResult => {
      if (this.values.has(fresh.commandId)) return createConflict(this.values.get(fresh.commandId), own);
      const gate = damageGate([...this.values.entries()], fresh, offered);
      if (!gate.allowed) return { outcome: gate.reason };
      this.values.set(fresh.commandId, structuredClone(fresh));
      if (gate.write) this.values.set(gate.write.commandId, structuredClone(gate.write));
      return { outcome: "reserved", claim };
    });
  }
  reserve(identity: BudgetIdentity, attempt: string): Promise<ReserveResult> {
    const own = canonicalIdentity(identity);
    const id = canonicalId(attempt);
    return this.apply(own.commandId, current => reserveStep(current, own, id));
  }
  beginSending(identity: BudgetIdentity, claim: SlotClaim): Promise<boolean> {
    const own = canonicalIdentity(identity);
    const held = canonicalClaim(claim);
    return this.apply(own.commandId, current => beginSendingStep(current, own, held));
  }
  markTransmitted(identity: BudgetIdentity, claim: SlotClaim): Promise<boolean> {
    const own = canonicalIdentity(identity);
    const held = canonicalClaim(claim);
    return this.apply(own.commandId, current => markTransmittedStep(current, own, held));
  }
  markRetryable(identity: BudgetIdentity, claim: SlotClaim): Promise<boolean> {
    const own = canonicalIdentity(identity);
    const held = canonicalClaim(claim);
    return this.apply(own.commandId, current => markRetryableStep(current, own, held));
  }
  release(identity: BudgetIdentity, claim: SlotClaim): Promise<boolean> {
    const own = canonicalIdentity(identity);
    const held = canonicalClaim(claim);
    return this.apply(own.commandId, current => releaseStep(current, own, held));
  }
  forbidSends(identity: BudgetIdentity): Promise<boolean> {
    const own = canonicalIdentity(identity);
    return this.apply(own.commandId, current => forbidStep(current, own));
  }
  setMaintenance(identity: BudgetIdentity, met: boolean): Promise<boolean> {
    const own = canonicalIdentity(identity);
    return this.apply(own.commandId, current => maintenanceStep(current, own, met));
  }
  setLoss(identity: BudgetIdentity, loss: BudgetLoss): Promise<boolean> {
    const own = canonicalIdentity(identity);
    const found = canonicalLoss(loss);
    return this.apply(own.commandId, current => lossStep(current, own, found));
  }
  load(identity: BudgetIdentity): Promise<BudgetSummary | null> {
    const own = canonicalIdentity(identity);
    return this.run(() => summarize(this.values.get(own.commandId), own));
  }
  clear(commandId: string, profileId: string): Promise<boolean> {
    const id = canonicalId(commandId);
    const profile = canonicalId(profileId);
    return this.run(() => clearAllowed(this.values.get(id), id, profile) && this.remove(id));
  }
  clearDamaged(key: StoreKey): Promise<boolean> {
    const id = String(canonicalStoreKey(key));
    return this.run(() => this.values.has(id) && isDamaged(id, this.values.get(id)) && this.remove(id));
  }
  /** Deletes the record and takes its key out of every release, as one step. */
  private remove(id: string): true {
    const { puts, deletes } = releasesWithout([...this.values.entries()], id);
    this.values.delete(id);
    puts.forEach(release => this.values.set(release.commandId, structuredClone(release)));
    deletes.forEach(key => this.values.delete(String(key)));
    return true;
  }
  forgetHashOfOtherProfiles(profileId: string): Promise<number> {
    const profile = canonicalId(profileId);
    return this.run(() => {
      let changed = 0;
      for (const [key, value] of this.values) {
        const write = forgetHashStep(value, profile);
        if (write) { this.values.set(key, structuredClone(write)); changed++; }
      }
      return changed;
    });
  }
  listOrphans(profileId: string, sessionId: string): Promise<BudgetOrphan[]> {
    const profile = canonicalId(profileId);
    const session = canonicalId(sessionId);
    return this.run(() => [...this.values.entries()].flatMap(([key, value]) => orphanOf(key, value, profile, session) ?? []));
  }
  listDamagedKeys(): Promise<StoreKey[]> {
    return this.run(() => damagedKeys([...this.values.entries()]));
  }
}
