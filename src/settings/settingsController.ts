import type { Profile, SettingsProjection, SettingsResponse, UnavailableCurrent } from "../api/generated";
import { ApiError } from "../api/http";
import { version as validVersion } from "../api/wireValidation";
import { ClosedAccessError, type OpenedAccess } from "../app/openedAccess";
import { GatePending, pausedBeforeSend } from "../commands/gatePending";
import { PendingStoreError, validId } from "../commands/pendingSlot";
import { PausedBeforeSendError, type WriteGate } from "../commands/writeGate";
import { journalRecord } from "../journal/clientJournal";
import { isErrorCode, journalId, type ResetEvent } from "../journal/events";
import { allowedSettingValue, heldRefusal, KnownRefusal, refusalCodeOf, resetEpochOf, resetKeys, storedOnly, type IntentKey,
  type ResetFinalCode, type ResetHeldCode, type ResetRefusalCode, type ResetReply, type ResetTargetOutcome, type SettingKey, type SettingSaveReply, type SettingsApi } from "./settingsApi";
import { SettingsPendingStore, type SettingsPending } from "./settingsPending";
import { unfinished, type SettingsResetFinalOnly, type SettingsResetPending, type SettingsResetPendingStore,
  type SettingsResetRecord } from "./settingsResetPending";

type Draft = { input: unknown; original?: unknown; fieldVersion: string; revision: number };

/** The terminal outcome of X each stored refusal code names (core settings/reset.py TERMINAL_ANSWERS; events §4.5). */
const RESET_OUTCOME: Record<ResetRefusalCode, Exclude<ResetEvent["outcome"], "applied" | "unknown">> = {
  RESET_CANCELLED: "cancelled", RESET_EPOCH_STALE: "rejected_stale_epoch", VALIDATION_FAILED: "rejected_invalid",
  CLIENT_INCOMPATIBLE: "rejected_incompatible" };
/** A bare answer to X that the defect line takes (C479 R7): 422 or 409, but not the codes with a meaning of their own. */
const DEFECT_STATUSES = new Set([409, 422]);
const NOT_A_DEFECT = new Set(["DOCUMENT_STALE", "SESSION_BUSY"]);
export type SettingsDraft = Omit<Draft, "revision"> & {
  valid: boolean;
  conflict: boolean;
  error: "invalid" | "conflict" | "version_exhausted" | "rejected" | null;
  canSave: boolean;
  canKeepMine: boolean;
};
type Problem = { reason: "network" | "storage" | "invalid_pending" | "pending_changed" | "expired" | "forbidden"
  | "context_closed" | "context_refreshed" | "client_changed" | "profile_changed" | "mismatch" | "not_found" | "stale_response"
  | KnownRefusal["refusal"]
  /** PAUSED_BEFORE_SEND (P03 §4.2): the write gate kept the request on the client; the ID and the record stay. */
  | "paused"
  /**
   * P02-R I.11.3c, R8-05/R8-06 variant 1: the server stored an explicit refusal of the sent reset (F2); nothing is sent until
   * the user's «Отменить прежний сброс» (`code`: VALIDATION_FAILED or CLIENT_INCOMPATIBLE).
   */
  | "reset_refused"; code?: string };
/** `key` may name a stored-only key (R14-02): a stored intent of an earlier build, checked like any other. */
type Outcome = { commandId: string; key: IntentKey; status: "accepted" | "rejected"; code?: string };
/** The server's answer to a reset; shown only once the server reported it (TA 12.4). */
type ResetOutcome = Omit<Outcome, "key"> & {
  /** F1 of the reset itself (I.11.3a, «отказан»): the server closed it for good; worded by TZA:311, not as a cancel. */
  final?: true;
};
export type SettingsSnapshot = {
  phase: "loading" | "ready" | "sending" | "checking" | "unresolved" | "blocked" | "disposed";
  data: SettingsResponse | null;
  /** A retained editor can display older data, but it cannot publish it as current or save against it. */
  dataCurrent: boolean;
  drafts: Partial<Record<SettingKey, SettingsDraft>>;
  pending: SettingsPending | null;
  /** A sent reset. At most one of `pending` and `resetPending` is present. */
  resetPending: SettingsResetPending | null;
  outcome: Outcome | null;
  resetOutcome: ResetOutcome | null;
  problem: Problem | null;
  canEdit: boolean;
  canReset: boolean;
  canRetry: boolean;
  /**
   * After a COMMAND_PAYLOAD_MISMATCH of a field save (Q36): the stored intent cannot be proven, the old ID is never sent again,
   * and the user may continue with the current server settings. Offered only after a fresh server readback of this refresh.
   */
  canContinueWithServer: boolean;
  /**
   * R2-09 / K19-024 / P5-013: the user's explicit cancel of a stored save the server refused with 422 (any key; the refusal is
   * kept with the record between openings), or of a stored-only key's record of another launch (R14-02), which has no
   * field and is never repeated from here. Absent means false.
   */
  canCancelStored?: boolean;
  /**
   * P02-R I.11.3b п.3: «Отменить прежний сброс» — the user's explicit cancel of a reset the server refused and stored (F2).
   * Not offered while this build is the incompatible one (RQ-2 (а)), nor while the refusal is held only in this page's
   * memory (I.11.3c п.5). Absent means false.
   */
  canCancelReset?: boolean;
};
type Options = {
  api: SettingsApi;
  pendingStore: SettingsPendingStore;
  resetStore: SettingsResetPendingStore;
  access(): OpenedAccess | null;
  newId(): string;
  minimumStateVersion?(): string | null;
  onUpdate(snapshot: SettingsSnapshot): void;
  /** The write gate of the page (P03 M-P03-8): readback registry, status reads by ticket, the buttons (I9, M12). */
  gate: WriteGate;
  /**
   * Whether the page is shown (C365 N3): an automatic send — the client's own cancel of a reset, the resend of a stored
   * cancel — leaves only while it is; the gate's `mayWrite` does not see visibility. Default: document.visibilityState.
   */
  visible?(): boolean;
};

function integerInput(value: unknown): unknown {
  return typeof value === "string" && /^[+-]?\d+$/.test(value.trim()) ? Number(value.trim()) : value;
}
function draftValue(data: SettingsProjection, key: SettingKey, input: unknown): unknown {
  const type = data.constraints[key].type;
  if (type === "integer") return integerInput(input);
  if (type === "ordered_integer_list" && Array.isArray(input)) return Array.from(input, integerInput);
  return input;
}

/** `handle` names the access handle that got the refusal (handleNumber); a 422 does not depend on it. */
type Refusal = { commandId: string; reason: KnownRefusal["refusal"]; code?: string; handle: number };
/**
 * Known refusals by document (profile, installation, document ID), kept in page memory only. A remount of the same
 * document (Entry leaving `opened` and coming back, or a new generation under a new key) creates a new controller,
 * and the hold must not end with it (QA M-SETTINGS-KNOWN-REFUSAL delta 2, finding 1). A reload starts a new page and
 * a new document ID, so it starts without a hold, as before. Nothing here is persisted.
 */
const documentRefusals = new Map<string, Refusal>();
/**
 * A number per access handle, so a record can tell a newer handle apart without keeping the old one (and its token
 * and proof) alive: the WeakMap does not hold its keys.
 */
const handleNumbers = new WeakMap<OpenedAccess, number>();
/**
 * Documents whose settings reset (or its cancel) got CLIENT_INCOMPATIBLE, with the handle that got it (page memory only, as
 * documentRefusals). P02-R RQ-2 (а): in the incompatible build the cancel button is useless and is not shown; a newer handle
 * is a compatible open (app/entryController.ts) and lifts it.
 */
const incompatibleResets = new Map<string, number>();
/**
 * Documents (profile, installation, document_id) whose reset or its cancel got a DOCUMENT_STALE that the window's junction
 * proved a replacement of this document (page memory only). The proof is the junction's, not the code's (C437): the entry
 * attributes the 409 to the very command sent (kind of the reset family, command_id/rejected, current DocMark, profile,
 * document; entryController.replacementProved) and closes the window (closedWindow) before this module reads the refusal.
 * P02-R I.11.3 step 4, I.11.4 (:439, :631, :640), C362 (3), C376: the record is not touched; X is read and cancelled only in a
 * new document. A new access object of the same document (a handle, generation or epoch) does not lift it. A bare or
 * unconfirmed DOCUMENT_STALE of a live window proves nothing: it takes the route of an unknown outcome (R16-01 variant 1).
 */
const staleResets = new Set<string>();
let lastHandleNumber = 0;
function handleNumber(access: OpenedAccess): number {
  let number = handleNumbers.get(access);
  if (number === undefined) handleNumbers.set(access, number = ++lastHandleNumber);
  return number;
}

/**
 * A document's editors and one sent intent, a field save or a reset (D-SET-RESET 4.3.1). Foreground updates access,
 * never recreates drafts.
 */
export class SettingsController {
  private readonly scope: { key: string; profileId: string; clientId: string; documentId: string; document: string };
  private readonly lifetime = new AbortController();
  private phase: SettingsSnapshot["phase"] = "loading";
  private data: SettingsResponse | null = null;
  private drafts: Partial<Record<SettingKey, Draft>> = {};
  private revision = 0;
  private submittedRevision: number | null = null;
  private pending: SettingsPending | null = null;
  private resetPending: SettingsResetPending | null = null;
  /** The c.reset lines this controller wrote (cmd:outcome): an outcome read again — by a cancel, a check — is not written twice. */
  private readonly journaledResets = new Set<string>();
  /**
   * The reset record as the storage holds it. It differs from `resetPending` only when the write of a held refusal failed
   * (I.11.3c п.5): the refusal is then held in this document's memory and nothing is sent for it.
   */
  private resetStored: SettingsResetRecord | null = null;
  /** «Отказан» alone (I.11.3a): the profile's record when no reset is unfinished; it never blocks editing. */
  private resetFinal: SettingsResetFinalOnly | null = null;
  private loaded = false;
  private settled = false;
  private version: string | null = null;
  private outcome: Outcome | null = null;
  private resetOutcome: ResetOutcome | null = null;
  /**
   * The last attempt of the sent intent got a known refusal (KnownRefusal). It is a fact about that attempt only:
   * the intent stays unresolved and checkable, since an earlier attempt may still have been applied. A timeout or a
   * status read never lifts it. CLIENT_INCOMPATIBLE is lifted by a newer client/open: Entry creates an access handle
   * only for a compatible open (app/entryController.ts), so another live handle is that verifiable sign. A 422 has
   * no such sign (a compatible client does not prove the core now accepts the payload; the core exposes no build or
   * capability), so it stands for this document's lifetime until an explicit manual step (pending owner). It is
   * kept per document, not per controller (documentRefusals), and only for the intent it was given to.
   */
  private get refusal(): Refusal | null {
    const refusal = documentRefusals.get(this.scope.document);
    return refusal && refusal.commandId === this.sent()?.intent.command_id ? refusal : null;
  }
  private set refusal(refusal: Refusal | null) {
    if (refusal) documentRefusals.set(this.scope.document, refusal);
    else documentRefusals.delete(this.scope.document);
  }
  private problem: Problem | null = null;
  private writeBlocked: "expired" | "forbidden" | "profile_changed" | null = null;
  private running: Promise<void> | null = null;
  private queuedRefresh: Promise<void> | null = null;
  /** The access handle through which a readback succeeded after the mismatch was established; any other state clears it. */
  private mismatchReadback: OpenedAccess | null = null;
  private readonly registry: GatePending;
  private readonly unsubscribe: () => void;

  constructor(private readonly options: Options) {
    const access = options.access();
    if (!access?.isLive() || !validId(access.profile.profile_id) || !validId(access.document.clientInstanceId)
      || !validId(access.document.documentId)) throw new Error("invalid settings access");
    this.scope = { key: access.key, profileId: access.profile.profile_id,
      clientId: access.document.clientInstanceId, documentId: access.document.documentId,
      document: JSON.stringify([access.profile.profile_id, access.document.clientInstanceId, access.document.documentId]) };
    this.registry = new GatePending(options.gate, "settings");
    // M12: the fields stay editable, «Сохранить» and the reset wait for the gate; its changes repaint them.
    const unsubscribe = options.gate.subscribe(() => { this.emit(); this.resumeResetCheck(); });
    // C365 N3: a check stopped while the page was hidden is taken up on its return (reading first, resumeResetCheck).
    const shownAgain = () => this.resumeResetCheck();
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", shownAgain);
    this.unsubscribe = () => {
      unsubscribe();
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", shownAgain);
    };
  }
  /**
   * R16-01 variant 1 in the same window: a check of the sent reset that the gate stopped (net closed, a hold, PAUSED_BEFORE_SEND)
   * or a lost answer stopped is taken up again by itself once the gate lets a readback and a write through (P03 I5: the gate
   * open, the hold over, then a fresh readback not_recorded before the send). One resumption per stop; a held refusal (F2)
   * and a mismatch are never resumed.
   */
  private resetCheckDue = false;
  private shown(): boolean {
    return this.options.visible ? this.options.visible() : typeof document === "undefined" || document.visibilityState !== "hidden";
  }
  /**
   * C365 N3: the last guard of an automatic send, right before the request is built (after every await of the path). A
   * hidden page sends nothing by itself: the record stays as it is (a stored cancel keeps its ID), and the check is due
   * again — on the return to the page it reads first and sends only the allowed rest.
   */
  private automaticSendAllowed(): void {
    if (!this.shown()) throw new PausedBeforeSendError("paused");
  }
  private resumeResetCheck(): void {
    if (!this.resetCheckDue || !this.shown() || this.staleHere() || this.running || !this.live() || !this.currentAccess() || !this.resetPending || this.heldCode()
      || this.resetPending.mismatch || this.writeBlocked || !this.registry.checkable() || !this.registry.writable()) return;
    this.resetCheckDue = false;
    void this.refresh();
  }
  /** I9: a save, a reset or a retry of the sent ID is allowed by the write gate right now. */
  private writable(): boolean { return this.registry.writable(this.heldId()); }
  /** The ID the gate holds for this document: the sent intent, or the stored cancel of the sent reset. */
  private heldId(): string | undefined {
    const state = this.resetPending?.state;
    return state && "cancel" in state ? state.cancel : this.sent()?.intent.command_id;
  }

  private live(): boolean { return !this.lifetime.signal.aborted; }
  private currentAccess(): OpenedAccess | null {
    if (!this.live()) return null;
    const access = this.options.access();
    return access?.isLive() && access.key === this.scope.key && access.profile.profile_id === this.scope.profileId
      && access.document.clientInstanceId === this.scope.clientId && access.document.documentId === this.scope.documentId
      ? access : null;
  }
  private access(): OpenedAccess {
    const access = this.currentAccess();
    if (!access) throw new ClosedAccessError();
    return access;
  }
  /** The one sent intent of this document, whichever kind it is. */
  private sent(): SettingsPending | SettingsResetPending | null { return this.pending ?? this.resetPending; }
  private editable(): boolean {
    return !!this.currentAccess() && this.loaded && this.dataIsCurrent() && !this.sent() && !this.writeBlocked;
  }
  private minimumVersion(): string | null {
    const access = this.currentAccess();
    if (access) for (const value of [access.profile.state_version, this.options.minimumStateVersion?.()]) {
      if (value === undefined || value === null) continue;
      if (!validVersion(value)) throw new Error("invalid shared Settings version");
      if (this.version === null || BigInt(value) > BigInt(this.version)) this.version = value;
    }
    return this.version;
  }
  private dataIsCurrent(): boolean {
    const minimum = this.minimumVersion();
    return this.data !== null && (minimum === null || BigInt(this.data.state_version) >= BigInt(minimum));
  }
  private refused(): KnownRefusal["refusal"] | null {
    const access = this.currentAccess();
    if (!this.refusal || !access) return null;
    return this.refusal.reason === "command_refused" || this.refusal.handle === handleNumber(access) ? this.refusal.reason : null;
  }
  private retryAllowed(): boolean {
    // A reset is never sent again, by itself or by hand (P02-R I.11.3 step 4, R-5, CON:301): only its status is read.
    const sent = this.pending;
    return !!this.currentAccess() && !this.running && !this.writeBlocked && !this.settled && !!sent && !this.resetPending && !this.refused()
      && !sent.mismatch && sent.clientInstanceId === this.scope.clientId
      && !!this.problem && ["network", "storage", "not_found", "context_refreshed", "stale_response", "paused"].includes(this.problem.reason)
      && this.writable();
  }

  private continueAllowed(): boolean {
    const access = this.currentAccess();
    return !!access && access === this.mismatchReadback && !this.running && !this.writeBlocked && !this.settled
      && !!this.pending?.mismatch && !this.resetPending && this.problem?.reason === "mismatch" && this.dataIsCurrent();
  }

  private cancelStoredAllowed(): boolean {
    const pending = this.pending;
    // Offered after the 422 of any save (kept between openings), or for a stored-only key's record of another launch of the
    // app, which is never repeated from here (retryAllowed): without it that record would close Settings for good.
    return !!this.currentAccess() && !this.running && !this.writeBlocked && !this.settled && !!pending && !this.resetPending
      && !pending.mismatch && this.loaded && (this.refused() === "command_refused"
        || storedOnly(pending.intent.payload.key) && pending.clientInstanceId !== this.scope.clientId);
  }

  private staleHere(): boolean { return staleResets.has(this.scope.document); }
  /**
   * The junction proved the replacement of this document (C437): the window is closed for good (P03 §4.12). The settings take
   * the window's decision; they never decide a replacement from the code alone.
   */
  private replacementProved(): boolean { return this.options.gate.snapshot().closedWindow !== null; }
  private incompatibleHere(): boolean {
    const access = this.currentAccess();
    return !!access && incompatibleResets.get(this.scope.document) === handleNumber(access);
  }
  private noteIncompatible(error: unknown): void {
    const access = this.currentAccess();
    if (access && error instanceof ApiError && error.code === "CLIENT_INCOMPATIBLE") incompatibleResets.set(this.scope.document, handleNumber(access));
  }
  /** The explicit refusal (F2) this document holds for the sent reset, or null. */
  private heldCode(): ResetHeldCode | null {
    const state = this.resetPending?.state;
    return state && "refused" in state ? state.refused : null;
  }
  private heldProblem(): Problem {
    if (this.resetStored !== this.resetPending) return { reason: "storage" };
    if (this.incompatibleHere()) return { reason: "incompatible", code: "CLIENT_INCOMPATIBLE" };
    return { reason: "reset_refused", code: this.heldCode()! };
  }
  private cancelResetAllowed(): boolean {
    const reset = this.resetPending;
    return !!this.currentAccess() && !this.running && !this.writeBlocked && !this.settled && this.loaded && !!reset
      && !reset.mismatch && this.heldCode() !== null && this.resetStored === reset && !this.incompatibleHere() && !this.staleHere()
      && this.registry.writable();
  }

  snapshot(): SettingsSnapshot {
    const available = !!this.currentAccess();
    const dataCurrent = available && !this.writeBlocked && this.dataIsCurrent();
    const drafts: SettingsSnapshot["drafts"] = {};
    if (available && !this.writeBlocked) for (const [name, draft] of Object.entries(this.drafts)) {
      const key = name as SettingKey;
      const valid = dataCurrent && !!this.data && allowedSettingValue(this.data, key, draftValue(this.data, key, draft.input));
      const conflict = dataCurrent && !!this.data && draft.fieldVersion !== this.data.settings[key].version;
      const exhausted = BigInt(this.data?.settings[key].version ?? draft.fieldVersion) >= 9223372036854775807n;
      const rejected = this.outcome?.key === key && this.outcome.status === "rejected";
      drafts[key] = { input: draft.input, fieldVersion: draft.fieldVersion,
        ...(Object.hasOwn(draft, "original") ? { original: draft.original } : {}), valid, conflict,
        error: !dataCurrent ? null : !valid ? "invalid" : exhausted ? "version_exhausted" : conflict ? "conflict" : rejected ? "rejected" : null,
        canSave: this.editable() && !this.running && valid && !conflict && !exhausted && this.writable(),
        canKeepMine: this.editable() && !this.running && valid && conflict && !exhausted && this.writable() };
    }
    return structuredClone({ phase: this.phase, data: available && !this.writeBlocked ? this.data : null, dataCurrent, drafts,
      pending: available ? this.pending : null, resetPending: available ? this.resetPending : null,
      outcome: available ? this.outcome : null, resetOutcome: available ? this.resetOutcome : null,
      problem: available ? this.problem : { reason: "context_closed" }, canEdit: this.editable(),
      canReset: this.editable() && !this.running && this.writable() && resetEpochOf(this.data) !== null, canRetry: this.retryAllowed(),
      canContinueWithServer: this.continueAllowed(), canCancelStored: this.cancelStoredAllowed(),
      canCancelReset: this.cancelResetAllowed() });
  }
  private emit(): void { if (this.live()) this.options.onUpdate(this.snapshot()); }

  private run(action: () => Promise<void>): Promise<void> {
    if (!this.live()) return Promise.resolve();
    if (this.running) return this.running;
    const task = Promise.resolve().then(action).catch((error: unknown) => {
      if (!this.live()) return;
      if (error instanceof PendingStoreError) {
        this.problem = { reason: error.kind === "invalid" ? "invalid_pending"
          : error.kind === "changed" ? "pending_changed" : "storage" };
      } else if (pausedBeforeSend(error)) {
        // Nothing left the client (a send) or nothing was read (a readback the gate holds or cancelled): no lost reply.
        this.problem = { reason: "paused" };
      } else if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        this.writeBlocked = error.status === 401 ? "expired" : "forbidden";
        this.data = null;
        this.problem = { reason: this.writeBlocked, code: error.code };
      } else if (error instanceof ApiError && error.code === "DOCUMENT_STALE" && this.resetPending && this.currentAccess()
        && this.replacementProved()) {
        // I.11.4 :640: the window closed; the record is not touched, and nothing more of the reset is read or sent from here.
        staleResets.add(this.scope.document);
        this.problem = { reason: "context_closed", code: error.code };
      } else if (error instanceof ApiError && error.code === "CLIENT_INCOMPATIBLE" && this.resetPending && this.currentAccess()) {
        // The reset or its cancel met an incompatible build: the record stays; the screen asks to update (RQ-2 (а)).
        this.noteIncompatible(error);
        this.problem = { reason: "incompatible", code: error.code };
      } else if (error instanceof KnownRefusal && this.pending && this.currentAccess()) {
        this.refusal = { commandId: this.sent()!.intent.command_id, reason: error.refusal, code: error.code,
          handle: handleNumber(this.currentAccess()!) };
        this.problem = { reason: error.refusal, code: error.code };
      } else if (error instanceof ClosedAccessError) {
        this.problem = { reason: this.currentAccess() ? "context_refreshed" : "context_closed" };
      } else {
        // While a known refusal stands, a failed check (a status read, a lost reply) does not replace its reason: the
        // screen keeps saying why no repeat is offered (an update, or the refused command).
        const refused = this.refused();
        this.problem = this.heldCode() ? this.heldProblem() : refused ? { reason: refused, code: this.refusal!.code }
          : { reason: "network", ...(error instanceof ApiError ? { code: error.code } : {}) };
      }
      this.phase = this.sent() ? "unresolved" : "blocked";
      this.resetCheckDue = !!this.resetPending && !this.heldCode() && !this.resetPending.mismatch && !this.writeBlocked
        && !!this.problem && ["paused", "network"].includes(this.problem.reason);
    }).finally(() => {
      if (this.running === task) this.running = null;
      this.emit();
    });
    this.running = task;
    return task;
  }

  /** True when the answer was taken as the current data; an older answer than the known shared version is not. */
  private accept(current: SettingsProjection, version: string): boolean {
    const minimum = this.minimumVersion();
    if (minimum !== null && BigInt(version) < BigInt(minimum)) {
      if (!this.dataIsCurrent()) this.problem = { reason: "stale_response" };
      return false;
    }
    this.version = version;
    this.data = structuredClone({ ...current, state_version: version });
    this.problem = null;
    return true;
  }
  private idle(): void {
    if (this.writeBlocked) { this.data = null; this.problem = { reason: this.writeBlocked }; }
    this.phase = this.dataIsCurrent() && !this.problem ? "ready" : "blocked";
  }
  /** True only when this very read was taken as the current data. */
  private async readCurrent(): Promise<boolean> {
    const current = await this.access().run(({ token }) => this.options.api.get(token));
    if (!this.live()) return false;
    this.access();
    const taken = this.accept(current, current.state_version);
    if (!this.data && !this.problem) this.problem = { reason: "network" };
    return taken && !this.problem;
  }

  edit(key: SettingKey, input: unknown): void {
    if (!this.editable()) return;
    if (!Object.hasOwn(this.data!.constraints, key)) throw new Error("invalid setting key");
    let copied: unknown;
    try { copied = structuredClone(input); } catch { throw new Error("invalid draft value"); }
    const before = this.drafts[key];
    this.drafts[key] = { ...(before ?? { original: structuredClone(this.data!.settings[key].value),
      fieldVersion: this.data!.settings[key].version }), input: copied, revision: ++this.revision };
    this.outcome = null;
    this.resetOutcome = null;
    this.emit();
  }
  acceptCurrent(key: SettingKey): void {
    if (!this.editable() || this.running) return;
    delete this.drafts[key];
    this.outcome = null;
    this.emit();
  }
  keepMine(key: SettingKey): Promise<void> {
    if (!this.snapshot().drafts[key]?.canKeepMine) return this.running ?? Promise.resolve();
    const draft = this.drafts[key]!;
    draft.original = structuredClone(this.data!.settings[key].value);
    draft.fieldVersion = this.data!.settings[key].version;
    return this.save(key);
  }

  private restoreDraft(): void {
    const pending = this.pending;
    if (!pending) return;
    const key = pending.intent.payload.key;
    // A stored-only key (R14-02) has no field and no editor: its intent is only checked by ID, no draft is restored.
    if (storedOnly(key)) { this.submittedRevision = null; return; }
    if (!this.drafts[key]) this.drafts[key] = { input: structuredClone(pending.intent.payload.value),
      fieldVersion: pending.intent.expected_field_version, revision: ++this.revision };
    this.submittedRevision = this.drafts[key]!.revision;
  }
  private async clearSettled(): Promise<void> {
    if (!this.settled) return;
    let final: SettingsResetFinalOnly | null = null;
    if (this.pending) await this.options.pendingStore.clear(this.pending, this.lifetime.signal);
    else if (this.resetPending) {
      const stored = this.resetStored ?? this.resetPending;
      // I.11.3a п.5: an earlier «отказан» goes only with an applied command; a newer reset that was not applied keeps it.
      if (this.resetOutcome?.status !== "accepted" && unfinished(stored) && stored.final) {
        final = { schemaVersion: 2, profileId: stored.profileId, clientInstanceId: stored.clientInstanceId, final: stored.final };
        await this.options.resetStore.replace(stored, final, this.lifetime.signal);
      } else await this.options.resetStore.clear(stored, this.lifetime.signal);
    } else return;
    if (!this.live()) return;
    if (!this.pending) { this.resetFinal = final; this.resetStored = final; }
    this.pending = null;
    this.resetPending = null;
    this.registry.release();
    this.refusal = null;
    this.settled = false;
    this.submittedRevision = null;
    this.idle();
  }
  /**
   * DEV-41 M1 (events §4.5, C496): one c.reset once the outcome of X is recorded here (I.11.3c п.1: written before shown).
   * cmd is X; kind names the command that ended X, as the core's a.reset.outcome does: the cancel for `cancelled`, else the
   * reset. code only for a refusal (applied and cancelled are no errors); an unknown outcome writes nothing (R16-01: X is
   * checked again, nothing is guessed). No setting value, no text.
   */
  private journalReset(commandId: string, outcome: ResetEvent["outcome"], code?: ResetRefusalCode): void {
    const cmd = journalId(commandId);
    if (cmd === null || this.journaledResets.has(`${cmd}:${outcome}`)) return;
    this.journaledResets.add(`${cmd}:${outcome}`);
    journalRecord({ ev: "c.reset", cmd, kind: outcome === "cancelled" ? "settings.reset_cancel" : "settings.reset", outcome,
      ...(code !== undefined && outcome !== "cancelled" ? { code } : {}) });
  }

  /**
   * DEV-41 M1, C479 R7, §8: the answer to this very send of X recorded no outcome of it — a bare 422/409, or a refusal whose
   * parts disagree (AC-59). c.defect is taken from the actual-send snapshot only: cmd and trace of this attempt, never the
   * echo; guarded by the snapshot's own kind and command_id, the installation it named and a live owner. DOCUMENT_STALE and
   * SESSION_BUSY have their own meaning; 401/403, a network error and a request the gate kept are no defect. The handling
   * that follows (the status of X by its ID, R16-01) is the same with or without this line. Whether the core saw the
   * request is not known here: a proxy's 422 has no server line with this trace (P3-E).
   */
  private journalResetDefect(error: unknown, reset: SettingsResetPending, source: OpenedAccess): void {
    if (!(error instanceof ApiError) || error.kind !== "http" || error.status === undefined || !DEFECT_STATUSES.has(error.status)
      || error.code !== undefined && NOT_A_DEFECT.has(error.code)) return;
    const sent = error.sentRefusal?.sent;
    if (!sent || sent.method !== "POST" || sent.route !== "/commands" || sent.kind !== "settings.reset") return;
    const cmd = journalId(sent.commandId), trace = journalId(sent.trace);
    if (cmd === null || trace === null || cmd !== journalId(reset.intent.command_id)) return;
    if (sent.clientInstanceId !== reset.clientInstanceId || !this.live() || this.currentAccess() !== source
      || this.resetPending !== reset) return;
    journalRecord({ ev: "c.defect", cmd, trace, status: error.status, ...(isErrorCode(error.code) ? { code: error.code } : {}) });
  }

  private async resolve(status: Outcome["status"], code?: string): Promise<void> {
    this.registry.settled(status === "accepted" ? "recorded" : "rejected");
    if (this.resetPending) {
      this.outcome = null;
      this.resetOutcome = { commandId: this.resetPending.intent.command_id, status, ...(code ? { code } : {}) };
      const refusal = code as ResetRefusalCode | undefined;
      if (status === "accepted") this.journalReset(this.resetPending.intent.command_id, "applied");
      else if (refusal !== undefined && Object.hasOwn(RESET_OUTCOME, refusal)) {
        this.journalReset(this.resetPending.intent.command_id, RESET_OUTCOME[refusal], refusal);
      }
      this.settled = true;
      // Owner answer R12: a confirmed reset discards the unsaved drafts of the fields it returned, so the initial
      // values show. A refusal or an unknown outcome is not a reset and keeps them; other fields are untouched.
      if (status === "accepted") for (const key of resetKeys) delete this.drafts[key];
      await this.clearSettled();
      return;
    }
    if (!this.pending) return;
    const intent = this.pending.intent;
    this.outcome = { commandId: intent.command_id, key: intent.payload.key, status, ...(code ? { code } : {}) };
    if (status === "accepted") await this.dropFinal();
    this.settled = true;
    const key = intent.payload.key;
    const draft = storedOnly(key) ? undefined : this.drafts[key];
    if (status === "accepted" && draft && !storedOnly(key)) {
      if (draft.revision === this.submittedRevision) delete this.drafts[key];
      else if (draft.fieldVersion === intent.expected_field_version && this.data
        && BigInt(this.data.settings[key].version) === BigInt(intent.expected_field_version) + 1n) {
        // Only our own accepted change advances the base for a newer unsent edit.
        draft.original = structuredClone(this.data.settings[key].value);
        draft.fieldVersion = this.data.settings[key].version;
      }
    }
    await this.clearSettled();
  }

  /**
   * I.11.3a п.5: the server applied the next settings command of the profile (a field save), so «отказан» goes. A failed
   * removal keeps it; it blocks nothing and goes with the next applied command.
   */
  private async dropFinal(): Promise<void> {
    const final = this.resetFinal;
    if (!final) return;
    try { await this.options.resetStore.clear(final, this.lifetime.signal); } catch { return; }
    if (this.live() && this.resetFinal === final) { this.resetFinal = null; if (this.resetStored === final) this.resetStored = null; }
  }

  /**
   * F1 (I.11.3a п.1–3): the server closed X for good (RESET_EPOCH_STALE / RESET_CANCELLED). «Отказан» (X, code) is written
   * first, by the conditional replacement of the record; until it is stored nothing else happens — the record stays «sent»,
   * the block names the storage (the error goes to `run`), no readback and no text. Then the fresh settings of the answer
   * are taken and editing opens; X is never sent, cancelled or read again (п.4).
   */
  private async finalRefusal(code: ResetFinalCode, current: SettingsProjection | UnavailableCurrent, version: string): Promise<void> {
    const reset = this.resetPending!, stored = this.resetStored ?? reset;
    this.registry.settled("rejected");
    const final: SettingsResetFinalOnly = { schemaVersion: 2, profileId: reset.profileId, clientInstanceId: reset.clientInstanceId,
      final: { command_id: reset.intent.command_id.toLowerCase(), code } };
    await this.options.resetStore.replace(stored, final, this.lifetime.signal);
    if (!this.live()) return;
    this.resetPending = null;
    this.resetStored = final;
    this.resetFinal = final;
    this.registry.release();
    if ("settings" in current) this.accept(current, version);
    else { this.writeBlocked = "forbidden"; this.data = null; }
    this.outcome = null;
    this.resetOutcome = { commandId: reset.intent.command_id, status: "rejected", code, final: true };
    this.journalReset(reset.intent.command_id, RESET_OUTCOME[code], code);
    this.refusal = null;
    this.settled = false;
    this.submittedRevision = null;
    this.idle();
  }

  private async checkPending(): Promise<void> {
    const save = this.pending!, pending = save;
    // R6: the status of the sent ID is read only with the gate's ticket (after the identity check, if one is due).
    const reply = await this.registry.read(pending.intent.command_id, ticket => this.access().run(({ token }) =>
      this.options.api.status(token, this.scope.profileId, save.intent, ticket)));
    if (!this.live()) return;
    this.access();
    if (reply.outcome === "accepted") {
      if ("settings" in reply.current) this.accept(reply.current, reply.state_version);
      else { this.writeBlocked = "forbidden"; this.data = null; }
      await this.resolve("accepted");
      return;
    }
    // Not on the server: a definite answer about this ID (its record stays until it is sent again or cancelled).
    this.registry.settled("not_recorded");
    if (this.notFoundBlocks(reply.current, reply.state_version)) {
      this.problem = { reason: this.writeBlocked! };
    } else {
      await this.readCurrent();
      if (!this.live()) return;
      if (await this.releaseOutdatedRefusal(save)) return;
      // A missing fact does not undo a known refusal of the last attempt: the repeat stays closed (KnownRefusal).
      const refused = this.refused();
      if (!this.problem) this.problem = pending.clientInstanceId !== this.scope.clientId ? { reason: "client_changed" }
        : refused ? { reason: refused, code: this.refusal!.code } : { reason: "not_found" };
    }
    this.phase = "unresolved";
  }

  /**
   * The profile a not_found names (CON:32): another profile or a profile not admitted any more blocks every write; otherwise a
   * newer shared version makes the data stale until the next read. True when writes are blocked.
   */
  private notFoundBlocks(current: Profile, version: string): boolean {
    if (current.profile_id !== this.scope.profileId) this.writeBlocked = "profile_changed";
    else if (current.access.status !== "admitted") this.writeBlocked = "forbidden";
    if (this.writeBlocked) { this.data = null; return true; }
    if (this.version === null || BigInt(version) > BigInt(this.version)) {
      this.version = version;
      this.data = null;
    }
    return false;
  }

  /**
   * The status of the sent reset X by its ID, with include_refusal (P02-R I.11.3 step 4, I.8). It runs on every check of an
   * unresolved reset — on opening, foreground, a refresh — and right after a reply to X that records no outcome of X (R16-01
   * variant 1): the same path whether the window stayed open or not.
   * - fact → «сброс выполнен»; F1 → «сброс не выполнен» (I.11.3a);
   * - F2 → the explicit refusal is held until «Отменить прежний сброс» (I.11.3c п.6), nothing is sent;
   * - the canonical not_found → the client cancels X on the server itself (CON:301), unless a refusal is held (I.11.3c п.2);
   * - any other answer or a failed read decides nothing (C362): no cancel, the record stays, the check comes again later.
   */
  private async checkReset(): Promise<void> {
    const reset = this.resetPending!;
    if (reset.state && "cancel" in reset.state) return this.checkCancel();
    const reply = await this.registry.read(reset.intent.command_id, ticket => this.access().run(({ token }) =>
      this.options.api.resetStatus(token, this.scope.profileId, reset.intent, ticket)));
    if (!this.live()) return;
    this.access();
    if (reply.outcome !== "not_found") {
      const code = reply.outcome === "refused" ? reply.code : null;
      if (code && !heldRefusal(code)) { await this.finalRefusal(code, reply.current, reply.state_version); return; }
      if (code && heldRefusal(code)) await this.holdRefusal(code);
      if (!this.live()) return;
      if ("settings" in reply.current) this.accept(reply.current, reply.state_version);
      else { this.writeBlocked = "forbidden"; this.data = null; }
      if (code && heldRefusal(code)) { this.phase = "unresolved"; this.problem = this.writeBlocked ? { reason: this.writeBlocked } : this.heldProblem(); return; }
      await this.resolve("accepted");
      return;
    }
    // Nothing of X is recorded on the server: a definite answer about this ID (CON:32, :301).
    this.registry.settled("not_recorded");
    if (this.notFoundBlocks(reply.current, reply.state_version)) {
      this.problem = { reason: this.writeBlocked! };
      this.phase = "unresolved";
      return;
    }
    if (this.heldCode()) {
      // I.11.3c п.2: a held refusal is lifted only by the button; not_found starts nothing for it.
      await this.readCurrent();
      if (!this.live()) return;
      this.problem = this.problem ?? this.heldProblem();
      this.phase = "unresolved";
      return;
    }
    // C362 (1): only this canonical not_found lets the client cancel the reset itself (R16-01 variant 1, CON:301).
    await this.startCancel(false);
  }

  /**
   * I.11.3c п.1, п.5: the explicit refusal F2 of the sent reset is written first, by the conditional replacement of I.11.1;
   * a failed write keeps it in this document's memory only (nothing is sent for it then, and the screen names the storage).
   */
  private async holdRefusal(code: ResetHeldCode): Promise<void> {
    const reset = this.resetPending!, stored = this.resetStored ?? reset;
    this.registry.settled("rejected");
    const held: SettingsResetPending = { ...reset, state: { refused: code } };
    if (this.resetStored === reset && this.heldCode() === code) return;
    const was = this.heldCode();
    try {
      await this.options.resetStore.replace(stored, held, this.lifetime.signal);
      this.resetStored = held;
    } catch (error) {
      if (error instanceof PendingStoreError && error.kind === "cancelled") throw error;
      this.resetStored = stored;
    }
    if (!this.live()) return;
    this.resetPending = held;
    // Held in the record, or in this document's memory when that write failed: the outcome of X is known either way.
    if (was !== code) this.journalReset(reset.intent.command_id, RESET_OUTCOME[code], code);
  }

  /**
   * The cancel of the sent reset X with a new ID C (P02-R I.11.3 step 4, I.11.3b п.3): stored before it is sent (not stored —
   * not sent). `explicit` marks the user's «Отменить прежний сброс»; otherwise the client cancels after the canonical
   * not_found of X (CON:301, R16-01). Nothing is stored or sent while the gate holds writes (I9, M12).
   */
  private async startCancel(explicit: boolean): Promise<void> {
    const reset = this.resetPending!, stored = this.resetStored ?? reset;
    if (!this.registry.writable()) {
      if (!this.dataIsCurrent()) await this.readCurrent();
      throw new PausedBeforeSendError("paused");
    }
    if (!explicit) this.automaticSendAllowed();
    const cancel: SettingsResetPending = { ...reset, state: { cancel: this.options.newId().toLowerCase(), explicit } };
    if (!validId((cancel.state as { cancel: string }).cancel)) throw new Error("invalid settings reset cancel");
    await this.options.resetStore.replace(stored, cancel, this.lifetime.signal);
    if (!this.live()) return;
    this.resetPending = cancel;
    this.resetStored = cancel;
    await this.sendCancel(!explicit);
  }

  /**
   * One send of the stored cancel C of X; a lost answer leaves the record as it is (C is idempotent, I.7). `automatic`: sent
   * by the client itself, so it leaves only from a shown page (C365 N3); the user's button is no automatic send.
   */
  private async sendCancel(automatic: boolean): Promise<void> {
    const reset = this.resetPending!, state = reset.state as { cancel: string; explicit: boolean };
    const source = this.access();
    this.phase = "sending";
    this.problem = null;
    this.emit();
    this.registry.hold(state.cancel);
    const reply = await source.run(({ token, proof, documentId }) => {
      if (automatic) this.automaticSendAllowed();
      return this.options.api.resetCancel(token, proof, this.scope.profileId,
        { command_id: state.cancel, kind: "settings.reset_cancel", client_instance_id: this.scope.clientId, document_id: documentId,
          payload: { target_command_id: reset.intent.command_id } });
    });
    if (!this.live()) return;
    if (this.access() !== source) throw new ClosedAccessError();
    if (reply.outcome === "mismatch") {
      // I.11.3 step 4: the cancel's ID is taken by another intent; the same target gets a new cancel ID, sent on the next check.
      this.registry.settled("mismatch");
      const renewed: SettingsResetPending = { ...reset, state: { cancel: this.options.newId().toLowerCase(), explicit: state.explicit } };
      await this.options.resetStore.replace(reset, renewed, this.lifetime.signal);
      if (!this.live()) return;
      this.resetPending = renewed;
      this.resetStored = renewed;
      this.registry.hold((renewed.state as { cancel: string }).cancel);
      this.accept(reply.current, reply.state_version);
      this.phase = "unresolved";
      this.problem = { reason: "network", code: reply.error.code };
      return;
    }
    this.registry.settled("recorded");
    await this.takeTarget(reply.target, reply.current, reply.state_version);
  }

  /** The stored cancel C of X is checked by its ID; nothing recorded of C → the same C is sent (I.11.3 step 4; P03 I9). */
  private async checkCancel(): Promise<void> {
    const reset = this.resetPending!, state = reset.state as { cancel: string; explicit: boolean };
    const intent = { command_id: state.cancel, target_command_id: reset.intent.command_id };
    const reply = await this.registry.read(state.cancel, ticket => this.access().run(({ token }) =>
      this.options.api.resetCancelStatus(token, this.scope.profileId, intent, ticket)));
    if (!this.live()) return;
    this.access();
    if (reply.outcome === "accepted") {
      this.registry.settled("already_applied");
      await this.takeTarget(reply.target, reply.current, reply.state_version);
      return;
    }
    this.registry.settled("not_recorded");
    if (this.notFoundBlocks(reply.current, reply.state_version)) {
      this.problem = { reason: this.writeBlocked! };
      this.phase = "unresolved";
      return;
    }
    if (!this.registry.writable()) {
      await this.readCurrent();
      throw new PausedBeforeSendError("paused");
    }
    // The resend of a stored cancel after its not_found is the client's own (I.11.3 step 4), whoever stored it.
    await this.sendCancel(true);
  }

  /**
   * The outcome of X that its cancel read under the profile lock (I.9), with the fresh settings. The text follows that real
   * outcome (R16-01): applied → «сброс выполнен»; any refusal → «сброс не выполнен» — except a refusal the server stored
   * (F2) met by the client's own cancel: it is shown and held until the button, as R8-05 (R16-01, «при любом варианте»).
   */
  private async takeTarget(target: ResetTargetOutcome, current: SettingsProjection, version: string): Promise<void> {
    const state = this.resetPending!.state as { cancel: string; explicit: boolean };
    if (target !== "applied" && !state.explicit) {
      const code = refusalCodeOf(target);
      if (heldRefusal(code)) {
        await this.holdRefusal(code);
        if (!this.live()) return;
        this.accept(current, version);
        this.phase = "unresolved";
        this.problem = this.heldProblem();
        return;
      }
    }
    this.accept(current, version);
    await this.resolve(target === "applied" ? "accepted" : "rejected", target === "applied" ? undefined : refusalCodeOf(target));
  }

  /**
   * R2-09 / K19-024: a 422 stands until the server's state is proven changed. For a field it is proven when the fresh
   * settings carry another field version than the refused intent expected (its value was saved since, by any window), so
   * the old command could never apply: the record and its refusal are released as a rejected outcome. The unsent editor
   * text is kept and meets the current value as a conflict. A stored-only key has no field version: never released here.
   */
  private async releaseOutdatedRefusal(save: SettingsPending): Promise<boolean> {
    const key = save.intent.payload.key;
    if (this.refused() !== "command_refused" || storedOnly(key) || !this.data || this.pending !== save
      || this.data.settings[key].version === save.intent.expected_field_version) return false;
    await this.options.pendingStore.clear(save, this.lifetime.signal);
    if (!this.live()) return true;
    this.pending = null;
    this.registry.release();
    this.refusal = null;
    this.outcome = { commandId: save.intent.command_id, key, status: "rejected", code: "VALIDATION_FAILED" };
    this.settled = false;
    this.submittedRevision = null;
    this.problem = null;
    this.idle();
    return true;
  }

  /** Refreshes queued during a send coalesce to one subsequent GET, never a replay. */
  refresh(): Promise<void> {
    if (this.running) {
      if (!this.queuedRefresh) this.queuedRefresh = this.running.then(() => {
        this.queuedRefresh = null;
        return this.refresh();
      });
      return this.queuedRefresh;
    }
    return this.run(async () => {
      this.access();
      this.phase = "checking";
      this.problem = null;
      this.mismatchReadback = null;
      this.emit();
      if (!this.loaded) {
        const save = await this.options.pendingStore.load(this.scope.profileId, this.lifetime.signal);
        if (!this.live()) return;
        this.access();
        const reset = await this.options.resetStore.load(this.scope.profileId, this.lifetime.signal);
        if (!this.live()) return;
        this.access();
        // One sent intent per document: both slots filled means the recorded state cannot be trusted.
        // «Отказан» alone (I.11.3a) is no sent intent and stands beside a save.
        if (save && unfinished(reset)) throw new PendingStoreError("invalid");
        this.pending = save;
        // R2-09 / K19-024: an intent refused with 422 in an earlier opening keeps that refusal now (its record carries it):
        // no repeat is offered; the status read below may still prove a changed server state; otherwise only the cancel.
        if (save?.refused) this.refusal = { commandId: save.intent.command_id, reason: "command_refused",
          code: "VALIDATION_FAILED", handle: handleNumber(this.access()) };
        this.resetPending = unfinished(reset) ? reset : null;
        this.resetFinal = reset && !unfinished(reset) ? reset : null;
        this.resetStored = reset;
        this.loaded = true;
        const held = this.heldId();
        if (held) this.registry.hold(held);
        this.restoreDraft();
      }
      if (this.settled) { await this.clearSettled(); if (!this.live()) return; }
      if (this.sent()?.mismatch) {
        await this.markMismatch();
        if (!this.live()) return;
        await this.readbackAfterMismatch();
      } else if (this.resetPending && this.staleHere()) {
        // I.11.3 step 4 (:631): DOCUMENT_STALE — X is read only in a new document; this one sends and reads nothing of it.
        this.problem = { reason: "context_closed", code: "DOCUMENT_STALE" };
        this.phase = "unresolved";
      } else if (this.resetPending) await this.checkReset();
      else if (this.pending) await this.checkPending();
      else { await this.readCurrent(); if (this.live()) this.idle(); }
    });
  }

  /**
   * The server read that follows a mismatch (R9-01 variant 1: the live answer starts it by itself, the refresh starts it
   * by hand). Only a read; the old command and the drafts are never sent. Until it succeeds the editors stay closed.
   * Only a field save may leave the mismatch (Q36); a reset waits for the P02 barrier. A failed read throws to `run`
   * and leaves the earlier manual path: the refresh button.
   */
  private async readbackAfterMismatch(): Promise<void> {
    const fresh = await this.readCurrent();
    if (!this.live()) return;
    this.mismatchReadback = fresh && this.pending ? this.access() : null;
    this.phase = "unresolved";
    this.problem = { reason: "mismatch", code: "COMMAND_PAYLOAD_MISMATCH" };
  }

  private async markMismatch(): Promise<void> {
    if (this.pending) {
      this.pending = { ...this.pending, mismatch: true };
      await this.options.pendingStore.markMismatch(this.pending, this.lifetime.signal);
    } else if (this.resetPending) {
      this.resetPending = { ...this.resetPending, mismatch: true };
      await this.options.resetStore.markMismatch(this.resetPending, this.lifetime.signal);
    }
  }
  private async applyReply(reply: SettingSaveReply): Promise<void> {
    this.accept(reply.current, reply.state_version);
    if (reply.outcome === "mismatch") {
      this.registry.settled("mismatch");
      this.phase = "unresolved";
      this.problem = { reason: "mismatch", code: reply.error.code };
      this.mismatchReadback = null;
      await this.markMismatch();
      if (!this.live() || !this.pending) return;
      // R9-01: a field save answered with a live mismatch reads the server by itself, status shown as a refresh.
      this.phase = "checking";
      this.emit();
      await this.readbackAfterMismatch();
    } else if (reply.outcome === "rejected" && reply.error.code === "NOTIFICATIONS_NOT_OPENED" && this.pending) {
      // project_notifications §8.2: a switch refused before the bot is opened is not kept as the user's draft (the switch
      // shows the server's off), and the settings are read afresh, so the switches stay closed by the server's own fact.
      const key = this.pending.intent.payload.key;
      await this.resolve("rejected", reply.error.code);
      if (!this.live()) return;
      if (!storedOnly(key)) delete this.drafts[key];
      if (!this.sent()) { await this.readCurrent(); if (this.live()) this.idle(); }
    } else await this.resolve(reply.outcome, reply.outcome === "rejected" ? reply.error.code : undefined);
  }
  /**
   * The reset X is stored before it is sent, and sent once (never again: P02-R I.11.3 step 4, R-5). A reply the server decided
   * is taken as it is (ResetReply). Any other — a bare 422/409, DOCUMENT_STALE, SESSION_BUSY, 5xx, no answer, an unreadable
   * one — records no outcome of X, so it is no refusal (R16-01 variant 1): the status of X is read by its ID at once, in
   * this same window, as on the next opening (checkReset). 401/403, a request the gate kept and a changed access go to `run`.
   */
  private async sendReset(source: OpenedAccess): Promise<void> {
    const reset = this.resetPending;
    if (!reset || !this.live()) return;
    if (this.access() !== source) throw new ClosedAccessError();
    const epoch = (reset.intent.payload as { expected_reset_epoch?: string }).expected_reset_epoch;
    if (epoch === undefined) throw new Error("invalid settings reset intent");
    this.phase = "sending";
    this.problem = null;
    this.emit();
    // From now on a request of this ID may leave: its outcome is unknown until a definite answer (R1).
    this.registry.hold(reset.intent.command_id);
    // «Отказан» of an earlier reset is carried by this one until it is applied (I.11.3a п.5).
    if (this.resetStored && !unfinished(this.resetStored)) await this.options.resetStore.replace(this.resetStored, reset, this.lifetime.signal);
    else await this.options.resetStore.save(reset, this.lifetime.signal);
    if (!this.live()) return;
    this.resetStored = reset;
    this.resetFinal = null;
    if (this.access() !== source) throw new ClosedAccessError();
    let reply: ResetReply;
    try {
      reply = await source.run(({ token, proof, documentId }) => this.options.api.reset(token, proof, this.scope.profileId,
        { command_id: reset.intent.command_id, kind: "settings.reset", client_instance_id: reset.clientInstanceId,
          document_id: documentId, payload: { expected_reset_epoch: epoch } }));
    } catch (error) {
      // A DOCUMENT_STALE the junction proved a replacement (the window closed, I.11.3 step 4, :640): no GET X, no cancel, the
      // record as it is. A bare or unconfirmed one of a live window is an unknown outcome of X like any other (C437, R16-01).
      if (!this.live() || !(error instanceof ApiError) || error.status === 401 || error.status === 403
        || error.code === "DOCUMENT_STALE" && this.replacementProved()) throw error;
      this.journalResetDefect(error, reset, source);
      this.noteIncompatible(error);
      this.phase = "checking";
      this.emit();
      await this.checkReset();
      return;
    }
    if (!this.live()) return;
    if (this.access() !== source) throw new ClosedAccessError();
    if (reply.outcome === "refused" && heldRefusal(reply.code)) {
      // This build sent X with an epoch in this document: only its contract version can be the incompatible one (I.5,
      // I.9 step 0), so the cancel button is useless here (RQ-2 (а)). A later document cannot tell, and offers it.
      if (reply.code === "CLIENT_INCOMPATIBLE") this.noteIncompatible(new ApiError("http", 409, reply.code));
      // I.11.3c п.1: the held refusal is written first, before the reason is shown.
      await this.holdRefusal(reply.code);
      if (!this.live()) return;
      this.accept(reply.current, reply.state_version);
      this.phase = "unresolved";
      this.problem = this.heldProblem();
      return;
    }
    if (reply.outcome === "refused") {
      // F1 (I.11.3a): «отказан» is written first; then the fresh settings of the answer, editing opens again.
      await this.finalRefusal(reply.code as ResetFinalCode, reply.current, reply.state_version);
      return;
    }
    await this.applyReply(reply);
  }

  /** The intent is stored before it is sent; a retry sends the stored envelope again, never a new ID (TA 9). */
  private async sendPending(source: OpenedAccess): Promise<void> {
    const save = this.pending;
    if (!save || !this.live()) return;
    if (this.access() !== source) throw new ClosedAccessError();
    this.phase = "sending";
    this.problem = null;
    this.emit();
    // From now on a request of this ID may leave: its outcome is unknown until a definite answer (R1).
    this.registry.hold(save.intent.command_id);
    await this.options.pendingStore.save(save, this.lifetime.signal);
    if (!this.live()) return;
    // A foreground refresh must resolve the saved intent before an explicit
    // retry. Finishing a storage write cannot transfer a send to its new handle.
    if (this.access() !== source) throw new ClosedAccessError();
    const reply = await source.run(({ token, proof, documentId }) => this.options.api.save(token, proof, this.scope.profileId,
        { ...structuredClone(save.intent), client_instance_id: save.clientInstanceId, document_id: documentId }))
      .catch(async (error: unknown) => {
        // R2-09 / K19-024: the 422 of a stored save is kept with its record, so it stands between openings. A failed write
        // of the mark (or a record changed meanwhile) leaves the storage as it was; the refusal is then held in page memory.
        if (error instanceof KnownRefusal && error.refusal === "command_refused" && save && !save.refused
          && this.live() && this.pending === save) {
          const marked: SettingsPending = { ...save, refused: true };
          try { await this.options.pendingStore.markRefused(save, this.lifetime.signal); if (this.pending === save) this.pending = marked; }
          catch { /* the record stays unmarked; nothing is lost */ }
        }
        throw error;
      });
    if (!this.live()) return;
    if (this.access() !== source) throw new ClosedAccessError();
    await this.applyReply(reply);
  }
  save(key: SettingKey): Promise<void> {
    if (!this.snapshot().drafts[key]?.canSave) return this.running ?? Promise.resolve();
    const source = this.access();
    const draft = structuredClone(this.drafts[key]!);
    const value = structuredClone(draftValue(this.data!, key, draft.input));
    return this.run(async () => {
      if (this.access() !== source) throw new ClosedAccessError();
      this.outcome = null;
      this.resetOutcome = null;
      this.submittedRevision = draft.revision;
      // A new intent starts with no known refusal; a record left for a settled one is stale.
      this.refusal = null;
      this.pending = { schemaVersion: 1, profileId: this.scope.profileId, clientInstanceId: this.scope.clientId,
        intent: { command_id: this.options.newId(), kind: "setting.save", expected_field_version: draft.fieldVersion,
          payload: { key, value: value as SettingsPending["intent"]["payload"]["value"] } } };
      await this.sendPending(source);
    });
  }
  /**
   * One confirmed press creates one intent; a press while anything is sent or running creates none. The reset carries the
   * epoch of this document's last read (P02-R I.5, I.11.3 step 6); a read without one (a core before P02-R) offers none.
   */
  reset(): Promise<void> {
    const epoch = resetEpochOf(this.data);
    if (!this.editable() || this.running || epoch === null) return this.running ?? Promise.resolve();
    const source = this.access();
    return this.run(async () => {
      if (this.access() !== source) throw new ClosedAccessError();
      this.outcome = null;
      this.resetOutcome = null;
      this.refusal = null;
      const earlier = this.resetFinal?.final;
      this.resetPending = { schemaVersion: 2, profileId: this.scope.profileId, clientInstanceId: this.scope.clientId,
        intent: { command_id: this.options.newId(), kind: "settings.reset", payload: { expected_reset_epoch: epoch } },
        ...(earlier ? { final: earlier } : {}) };
      this.resetStored = this.resetFinal;
      await this.sendReset(source);
    });
  }
  /**
   * P02-R I.11.3b п.3, R8-05 variant 1: «Отменить прежний сброс» — the user's explicit cancel of the reset the server refused
   * and stored (F2). The cancel with a new ID is stored, then sent once; its answer names the reset's real outcome, and the
   * fresh settings open for editing. A lost answer keeps it and it is checked by its ID later.
   */
  cancelReset(): Promise<void> {
    if (!this.cancelResetAllowed()) return this.running ?? Promise.resolve();
    const source = this.access();
    return this.run(async () => {
      if (this.access() !== source) throw new ClosedAccessError();
      this.outcome = null;
      this.resetOutcome = null;
      this.phase = "sending";
      this.emit();
      await this.startCancel(true);
    });
  }
  retry(): Promise<void> {
    if (!this.retryAllowed()) return this.running ?? Promise.resolve();
    const source = this.access();
    return this.run(() => this.sendPending(source));
  }
  /**
   * Q36: leaves a mismatched field save. A fresh readback is taken now; only when it succeeds for this same profile and
   * document, the marked record is cleared by the store's `clearMarked` and the user may save anew under a new ID.
   * The old ID is never sent. A failed readback, a changed access, an abort or a storage error clears nothing.
   */
  continueWithServer(): Promise<void> {
    if (!this.continueAllowed()) return this.running ?? Promise.resolve();
    const source = this.access();
    const marked = this.pending!;
    return this.run(async () => {
      this.mismatchReadback = null;
      this.phase = "checking";
      this.emit();
      const fresh = await this.readCurrent();
      if (!this.live()) return;
      if (this.access() !== source) throw new ClosedAccessError();
      if (!fresh) { this.phase = "unresolved"; this.problem = this.problem ?? { reason: "stale_response" }; return; }
      await this.options.pendingStore.clearMarked(marked, this.lifetime.signal);
      if (!this.live()) return;
      if (this.access() !== source) throw new ClosedAccessError();
      // The unsent editor text of this field is not written back: the server value is shown.
      const key = marked.intent.payload.key;
      if (!storedOnly(key)) delete this.drafts[key];
      this.pending = null;
      this.registry.release();
      this.refusal = null;
      this.outcome = null;
      this.settled = false;
      this.submittedRevision = null;
      this.problem = null;
      this.idle();
    });
  }
  /**
   * R2-09 / K19-024 / P5-013: the user's explicit cancel of an earlier stored save refused with 422 (or of a stored-only
   * record of another launch). Only this press does anything: the old ID is first read once more (never sent again); if
   * the server applied it after all, that outcome is taken; if it is not found, only this record is cleared (compared
   * exactly: a newer intent in the slot fails as "changed" and stays), its unsent editor text is dropped and fresh
   * settings are read, so Settings open for editing. A failed read, a changed access or a storage error clears nothing.
   */
  cancelStored(): Promise<void> {
    if (!this.cancelStoredAllowed()) return this.running ?? Promise.resolve();
    const source = this.access();
    const stored = this.pending!;
    return this.run(async () => {
      this.phase = "checking";
      this.emit();
      const reply = await this.registry.read(stored.intent.command_id, ticket =>
        source.run(({ token }) => this.options.api.status(token, this.scope.profileId, stored.intent, ticket)));
      if (!this.live()) return;
      if (this.access() !== source) throw new ClosedAccessError();
      if (reply.outcome === "accepted") {
        if ("settings" in reply.current) this.accept(reply.current, reply.state_version);
        else { this.writeBlocked = "forbidden"; this.data = null; }
        await this.resolve("accepted");
        return;
      }
      this.registry.settled("not_recorded");
      await this.options.pendingStore.clear(stored, this.lifetime.signal);
      if (!this.live()) return;
      if (this.access() !== source) throw new ClosedAccessError();
      const key = stored.intent.payload.key;
      if (!storedOnly(key)) delete this.drafts[key];
      this.pending = null;
      this.registry.release();
      this.refusal = null;
      this.outcome = null;
      this.settled = false;
      this.submittedRevision = null;
      this.problem = null;
      await this.readCurrent();
      if (this.live()) this.idle();
    });
  }
  dispose(): void {
    // R3: an ID without a definite answer stays locked to itself in the gate until a later owner reads it.
    // Unsubscribed first: the release below changes the gate, and a disposed owner repaints nothing.
    this.unsubscribe();
    this.registry.release();
    this.lifetime.abort();
    this.phase = "disposed";
    this.data = null;
    this.drafts = {};
  }
}
