import type { SettingsProjection, SettingsResponse } from "../api/generated";
import { ApiError } from "../api/http";
import { version as validVersion } from "../api/wireValidation";
import { ClosedAccessError, type OpenedAccess } from "../app/openedAccess";
import { PendingStoreError, validId } from "../commands/pendingSlot";
import { allowedSettingValue, KnownRefusal, resetKeys, type SettingKey, type SettingSaveReply, type SettingsApi } from "./settingsApi";
import { SettingsPendingStore, type SettingsPending } from "./settingsPending";
import type { SettingsResetPending, SettingsResetPendingStore } from "./settingsResetPending";

type Draft = { input: unknown; original?: unknown; fieldVersion: string; revision: number };
export type SettingsDraft = Omit<Draft, "revision"> & {
  valid: boolean;
  conflict: boolean;
  error: "invalid" | "conflict" | "version_exhausted" | "rejected" | null;
  canSave: boolean;
  canKeepMine: boolean;
};
type Problem = { reason: "network" | "storage" | "invalid_pending" | "pending_changed" | "expired" | "forbidden"
  | "context_closed" | "context_refreshed" | "client_changed" | "profile_changed" | "mismatch" | "not_found" | "stale_response"
  | KnownRefusal["refusal"]; code?: string };
type Outcome = { commandId: string; key: SettingKey; status: "accepted" | "rejected"; code?: string };
/** The server's answer to a reset; shown only once the server reported it (TA 12.4). */
type ResetOutcome = Omit<Outcome, "key">;
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
};
type Options = {
  api: SettingsApi;
  pendingStore: SettingsPendingStore;
  resetStore: SettingsResetPendingStore;
  access(): OpenedAccess | null;
  newId(): string;
  minimumStateVersion?(): string | null;
  onUpdate(snapshot: SettingsSnapshot): void;
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

  constructor(private readonly options: Options) {
    const access = options.access();
    if (!access?.isLive() || !validId(access.profile.profile_id) || !validId(access.document.clientInstanceId)
      || !validId(access.document.documentId)) throw new Error("invalid settings access");
    this.scope = { key: access.key, profileId: access.profile.profile_id,
      clientId: access.document.clientInstanceId, documentId: access.document.documentId,
      document: JSON.stringify([access.profile.profile_id, access.document.clientInstanceId, access.document.documentId]) };
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
    const sent = this.sent();
    return !!this.currentAccess() && !this.running && !this.writeBlocked && !this.settled && !!sent && !this.refused()
      && !sent.mismatch && sent.clientInstanceId === this.scope.clientId
      && !!this.problem && ["network", "storage", "not_found", "context_refreshed", "stale_response"].includes(this.problem.reason);
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
        canSave: this.editable() && !this.running && valid && !conflict && !exhausted,
        canKeepMine: this.editable() && !this.running && valid && conflict && !exhausted };
    }
    return structuredClone({ phase: this.phase, data: available && !this.writeBlocked ? this.data : null, dataCurrent, drafts,
      pending: available ? this.pending : null, resetPending: available ? this.resetPending : null,
      outcome: available ? this.outcome : null, resetOutcome: available ? this.resetOutcome : null,
      problem: available ? this.problem : { reason: "context_closed" }, canEdit: this.editable(),
      canReset: this.editable() && !this.running, canRetry: this.retryAllowed() });
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
      } else if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        this.writeBlocked = error.status === 401 ? "expired" : "forbidden";
        this.data = null;
        this.problem = { reason: this.writeBlocked, code: error.code };
      } else if (error instanceof KnownRefusal && this.sent() && this.currentAccess()) {
        this.refusal = { commandId: this.sent()!.intent.command_id, reason: error.refusal, code: error.code,
          handle: handleNumber(this.currentAccess()!) };
        this.problem = { reason: error.refusal, code: error.code };
      } else if (error instanceof ClosedAccessError) {
        this.problem = { reason: this.currentAccess() ? "context_refreshed" : "context_closed" };
      } else {
        // While a known refusal stands, a failed check (a status read, a lost reply) does not replace its reason: the
        // screen keeps saying why no repeat is offered (an update, or the refused command).
        const refused = this.refused();
        this.problem = refused ? { reason: refused, code: this.refusal!.code }
          : { reason: "network", ...(error instanceof ApiError ? { code: error.code } : {}) };
      }
      this.phase = this.sent() ? "unresolved" : "blocked";
    }).finally(() => {
      if (this.running === task) this.running = null;
      this.emit();
    });
    this.running = task;
    return task;
  }

  private accept(current: SettingsProjection, version: string): void {
    const minimum = this.minimumVersion();
    if (minimum !== null && BigInt(version) < BigInt(minimum)) {
      if (!this.dataIsCurrent()) this.problem = { reason: "stale_response" };
      return;
    }
    this.version = version;
    this.data = structuredClone({ ...current, state_version: version });
    this.problem = null;
  }
  private idle(): void {
    if (this.writeBlocked) { this.data = null; this.problem = { reason: this.writeBlocked }; }
    this.phase = this.dataIsCurrent() && !this.problem ? "ready" : "blocked";
  }
  private async readCurrent(): Promise<void> {
    const current = await this.access().run(({ token }) => this.options.api.get(token));
    if (!this.live()) return;
    this.access();
    this.accept(current, current.state_version);
    if (!this.data && !this.problem) this.problem = { reason: "network" };
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
    if (!this.drafts[key]) this.drafts[key] = { input: structuredClone(pending.intent.payload.value),
      fieldVersion: pending.intent.expected_field_version, revision: ++this.revision };
    this.submittedRevision = this.drafts[key]!.revision;
  }
  private async clearSettled(): Promise<void> {
    if (!this.settled) return;
    if (this.pending) await this.options.pendingStore.clear(this.pending, this.lifetime.signal);
    else if (this.resetPending) await this.options.resetStore.clear(this.resetPending, this.lifetime.signal);
    else return;
    if (!this.live()) return;
    this.pending = null;
    this.resetPending = null;
    this.refusal = null;
    this.settled = false;
    this.submittedRevision = null;
    this.idle();
  }
  private async resolve(status: Outcome["status"], code?: string): Promise<void> {
    if (this.resetPending) {
      this.outcome = null;
      this.resetOutcome = { commandId: this.resetPending.intent.command_id, status, ...(code ? { code } : {}) };
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
    this.settled = true;
    const draft = this.drafts[intent.payload.key];
    if (status === "accepted" && draft) {
      if (draft.revision === this.submittedRevision) delete this.drafts[intent.payload.key];
      else if (draft.fieldVersion === intent.expected_field_version && this.data
        && BigInt(this.data.settings[intent.payload.key].version) === BigInt(intent.expected_field_version) + 1n) {
        // Only our own accepted change advances the base for a newer unsent edit.
        draft.original = structuredClone(this.data.settings[intent.payload.key].value);
        draft.fieldVersion = this.data.settings[intent.payload.key].version;
      }
    }
    await this.clearSettled();
  }

  private async checkPending(): Promise<void> {
    const save = this.pending, reset = this.resetPending, pending = (save ?? reset)!;
    const reply = await this.access().run(({ token }) => save ? this.options.api.status(token, this.scope.profileId, save.intent)
      : this.options.api.resetStatus(token, this.scope.profileId, reset!.intent));
    if (!this.live()) return;
    this.access();
    if (reply.outcome === "accepted") {
      if ("settings" in reply.current) this.accept(reply.current, reply.state_version);
      else { this.writeBlocked = "forbidden"; this.data = null; }
      await this.resolve("accepted");
      return;
    }
    if (reply.current.profile_id !== this.scope.profileId) this.writeBlocked = "profile_changed";
    else if (reply.current.access.status !== "admitted") this.writeBlocked = "forbidden";
    if (this.writeBlocked) {
      this.data = null;
      this.problem = { reason: this.writeBlocked };
    } else {
      if (this.version === null || BigInt(reply.state_version) > BigInt(this.version)) {
        this.version = reply.state_version;
        this.data = null;
      }
      await this.readCurrent();
      if (!this.live()) return;
      // A missing fact does not undo a known refusal of the last attempt: the repeat stays closed (KnownRefusal).
      const refused = this.refused();
      if (!this.problem) this.problem = pending.clientInstanceId !== this.scope.clientId ? { reason: "client_changed" }
        : refused ? { reason: refused, code: this.refusal!.code } : { reason: "not_found" };
    }
    this.phase = "unresolved";
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
      this.emit();
      if (!this.loaded) {
        const save = await this.options.pendingStore.load(this.scope.profileId, this.lifetime.signal);
        if (!this.live()) return;
        this.access();
        const reset = await this.options.resetStore.load(this.scope.profileId, this.lifetime.signal);
        if (!this.live()) return;
        this.access();
        // One sent intent per document: both slots filled means the recorded state cannot be trusted.
        if (save && reset) throw new PendingStoreError("invalid");
        this.pending = save;
        this.resetPending = reset;
        this.loaded = true;
        this.restoreDraft();
      }
      if (this.settled) { await this.clearSettled(); if (!this.live()) return; }
      if (this.sent()?.mismatch) {
        await this.markMismatch();
        if (!this.live()) return;
        await this.readCurrent();
        if (!this.live()) return;
        this.phase = "unresolved";
        this.problem = { reason: "mismatch", code: "COMMAND_PAYLOAD_MISMATCH" };
      } else if (this.sent()) await this.checkPending();
      else { await this.readCurrent(); if (this.live()) this.idle(); }
    });
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
      this.phase = "unresolved";
      this.problem = { reason: "mismatch", code: reply.error.code };
      await this.markMismatch();
    } else await this.resolve(reply.outcome, reply.outcome === "rejected" ? reply.error.code : undefined);
  }
  /** The intent is stored before it is sent; a retry sends the stored envelope again, never a new ID (TA 9). */
  private async sendPending(source: OpenedAccess): Promise<void> {
    const save = this.pending, reset = this.resetPending;
    if (!(save ?? reset) || !this.live()) return;
    if (this.access() !== source) throw new ClosedAccessError();
    this.phase = "sending";
    this.problem = null;
    this.emit();
    if (save) await this.options.pendingStore.save(save, this.lifetime.signal);
    else await this.options.resetStore.save(reset!, this.lifetime.signal);
    if (!this.live()) return;
    // A foreground refresh must resolve the saved intent before an explicit
    // retry. Finishing a storage write cannot transfer a send to its new handle.
    if (this.access() !== source) throw new ClosedAccessError();
    const reply = await source.run(({ token, proof, documentId }) => save
      ? this.options.api.save(token, proof, this.scope.profileId,
        { ...structuredClone(save.intent), client_instance_id: save.clientInstanceId, document_id: documentId })
      : this.options.api.reset(token, proof, this.scope.profileId,
        { ...structuredClone(reset!.intent), client_instance_id: reset!.clientInstanceId, document_id: documentId }));
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
  /** One confirmed press creates one intent; a press while anything is sent or running creates none. */
  reset(): Promise<void> {
    if (!this.editable() || this.running) return this.running ?? Promise.resolve();
    const source = this.access();
    return this.run(async () => {
      if (this.access() !== source) throw new ClosedAccessError();
      this.outcome = null;
      this.resetOutcome = null;
      this.refusal = null;
      this.resetPending = { schemaVersion: 1, profileId: this.scope.profileId, clientInstanceId: this.scope.clientId,
        intent: { command_id: this.options.newId(), kind: "settings.reset", payload: {} } };
      await this.sendPending(source);
    });
  }
  retry(): Promise<void> {
    if (!this.retryAllowed()) return this.running ?? Promise.resolve();
    const source = this.access();
    return this.run(() => this.sendPending(source));
  }
  dispose(): void {
    this.lifetime.abort();
    this.phase = "disposed";
    this.data = null;
    this.drafts = {};
  }
}
