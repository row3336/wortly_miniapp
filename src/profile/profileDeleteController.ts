import type { OpenedAccess } from "../app/openedAccess";
import { MAX_SENDS, PROBE_DELAYS_MS, RETRY_PAUSES_MS } from "../commands/recoveryLimits";
import { systemRecoveryClock, type RecoveryClock, type RecoveryTimer } from "../commands/recoveryClock";
import type { WriteGate } from "../commands/writeGate";
import { journalAccess, journalRecord } from "../journal/clientJournal";
import { isErrorCode, journalId } from "../journal/events";
import type { AsyncStorage } from "../platform/storage";
import { deleteAttempt, type ProfileDeleteApi, type ProfileDeleteCredentials, type ProfileDeleteIntent,
  type ProfileDeleteReply } from "./profileDeleteApi";
import { wipeProfileRecords } from "./profileWipe";

/** Q12: the final button of the question becomes active 5 s after the question is shown. */
export const CONFIRM_DELAY_MS = 5_000;

/**
 * How the deletion screen ends the document (P04 ред.14 §8): `deleted` — applied / already_applied / PROFILE_DELETED,
 * the local records of X already cleared, the one-time result S-A07 follows; `unknown` — AUTH_* after an unknown outcome
 * (PD-28): the screen «исход неизвестен» with an explicit sign-in, confirmedProfileId decides after it; `expired` —
 * AUTH_* on the first attempt: not done, the ordinary expired sign-in. None of them signs in by itself.
 */
export type DeletionEnd = { kind: "deleted" } | { kind: "unknown"; confirmedProfileId: string } | { kind: "expired" };

export type DeletePhase =
  | "owner" | "idle" | "asking" | "sending" | "waiting" | "checking" | "stuck"
  | "refused" | "not_deleted" | "ended" | "disposed";
export type DeleteSnapshot = {
  phase: DeletePhase;
  /** Whole seconds until the final button may be pressed (0 once the delay is over); null outside the question. */
  remainingS: number | null;
  /** The final button: the delay is over, nothing is in flight and the write gate lets a write through (no queued tap). */
  canConfirm: boolean;
  /** The question may be opened: not the owner, nothing of an earlier tap is still deciding. */
  canOpen: boolean;
  /** stuck: the read that decides the outcome by the same session (the gate's check predicate). */
  canCheck: boolean;
  /** An automatic repeat of the same command_id is waiting or in flight. */
  repeating: boolean;
  /** The last first-attempt send was kept on the client by the gate (PAUSED_BEFORE_SEND): nothing left. */
  paused: boolean;
  refusalCode: string | null;
  /**
   * The intent of an attempt whose outcome stayed unknown was dropped (another document, profile or sign-in of this
   * screen): the screen says so instead of an empty item (C375).
   */
  droppedUnknown: boolean;
};

type Options = {
  api: ProfileDeleteApi;
  /** The live opened access of this document, or null once it is gone. */
  access(): OpenedAccess | null;
  gate: WriteGate;
  storage: AsyncStorage;
  newId(): string;
  onUpdate(snapshot: DeleteSnapshot): void;
  onEnded(end: DeletionEnd): void;
  clock?: RecoveryClock;
  /**
   * The page as the user sees it (P03 N3, P04 §3.7): no automatic repeat leaves while it is hidden. Default: the
   * document (the same source the App gives the write gate). Hidden is not leaving the screen (Q-DEL-4): the intent stays.
   */
  pageVisible?(): boolean;
  /** Told when the page is hidden or shown (visibilitychange, pageshow); default: the document's own events. */
  onPageChange?(changed: () => void): () => void;
};

function documentVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

function documentChanges(changed: () => void): () => void {
  if (typeof document === "undefined" || typeof window === "undefined") return () => undefined;
  document.addEventListener("visibilitychange", changed);
  window.addEventListener("pageshow", changed);
  return () => { document.removeEventListener("visibilitychange", changed); window.removeEventListener("pageshow", changed); };
}

/**
 * One open deletion screen (P04 ред.14 §3.7, §8; Q12, Q-DEL-1, Q-DEL-4). The intent {profile_id, command_id} lives only
 * in this object: it is never written to localStorage, sessionStorage or IndexedDB, and dispose() (leaving the screen,
 * closing or reloading the Mini App) drops it with every timer — nothing is sent afterwards. A new tap is a new question,
 * 5 s and a new command_id. Automatic repeats of the same command_id follow §3.7 «Действие на открытом экране»; every
 * send passes the write gate (RD-7), which may keep it on the client.
 *
 * Not registered in the gate's readback registry: profile.delete has no status read, only the repeat of the same POST.
 */
export class ProfileDeleteController {
  private readonly clock: RecoveryClock;
  private readonly profileId: string;
  private readonly documentId: string;
  /** The sign-in of the first send of the intent: an intent never moves to another session (C375). */
  private sessionToken: string | null = null;
  private droppedUnknown = false;
  private readonly owner: boolean;
  private phase: DeletePhase;
  private askedAt: number | null = null;
  private tick: RecoveryTimer | null = null;
  private repeatTimer: RecoveryTimer | null = null;
  private intent: ProfileDeleteIntent | null = null;
  private sends = 0;
  /** An earlier attempt of this command_id had an unknown outcome: classes change (§3.7). */
  private hadUnknown = false;
  private waitingGate = false;
  private paused = false;
  private refusalCode: string | null = null;
  private inFlight = false;
  private readonly unsubscribe: () => void;
  private readonly unsubscribePage: () => void;
  /**
   * The page was in the background while an automatic repeat waited (P03 N3): before the rest of the budget goes on,
   * the result is checked by one read of the same session (§3.7 ред.15 «Проверка — GET /settings тем же сеансом»).
   */
  private backgrounded = false;
  /** Failed reads of the return check in a row: the next look waits 5/10/20/30 s (P03 N3 light checks). */
  private returnTries = 0;
  private pageTimer: RecoveryTimer | null = null;

  constructor(private readonly options: Options) {
    this.clock = options.clock ?? systemRecoveryClock;
    const access = options.access();
    if (!access?.isLive()) throw new Error("profile deletion without an opened access");
    const profile = access.profile;
    this.profileId = profile.profile_id;
    this.documentId = access.document.documentId.toLowerCase();
    // Q-DEL-1: the owner sees the item with the button unavailable; the question and its timer never start.
    this.owner = profile.role === "owner";
    this.phase = this.owner ? "owner" : "idle";
    this.unsubscribe = options.gate.subscribe(() => this.gateChanged());
    // P03 N3: hidden — nothing is sent; shown — the result is checked, then the rest of the budget goes on with the same
    // command_id. The look is one task later, so the App's own listener has told the gate about the page first.
    this.unsubscribePage = (options.onPageChange ?? documentChanges)(() => {
      if (this.pageTimer || !this.live()) return;
      this.pageTimer = this.clock.schedule(() => { this.pageTimer = null; this.gateChanged(); }, 0);
    });
  }

  private live(): boolean { return this.phase !== "disposed" && this.phase !== "ended"; }

  /**
   * The access to send with (§3.7 п.3, Q-DEL-4): the live access of this screen's document and profile. "none" — no live
   * one right now: a foreground (for example on the return from the background) replaces the access of the same
   * document, which is not leaving the screen — the intent waits for the new one. "other" — another document or profile:
   * the intent goes. A lost sign-in or a closed document unmounts the screen (dispose) and so ends the intent.
   */
  private accessNow(): OpenedAccess | "none" | "other" {
    const access = this.options.access();
    if (!access) return "none";
    if (access.profile.profile_id.toLowerCase() !== this.profileId.toLowerCase()
      || access.document.documentId.toLowerCase() !== this.documentId) return "other";
    return access.isLive() ? access : "none";
  }

  /** The screen got a new access (a foreground of the same document): a waiting repeat looks again, one task later. */
  accessChanged(): void {
    if (this.pageTimer || !this.live()) return;
    this.pageTimer = this.clock.schedule(() => { this.pageTimer = null; this.gateChanged(); }, 0);
  }

  /** The intent stays with the sign-in it was first sent with; another one (a new sign-in) drops it. */
  private sameSession(intent: ProfileDeleteIntent, credentials: ProfileDeleteCredentials): boolean {
    if (!this.live() || this.intent !== intent) { this.inFlight = false; return false; }
    if (this.sessionToken === null) { this.sessionToken = credentials.token; return true; }
    if (this.sessionToken === credentials.token) return true;
    this.inFlight = false;
    this.lost();
    return false;
  }

  /** No live access of this document just now: an automatic send waits for it; a tap keeps its question (no queue). */
  private awaitAccess(automatic: boolean): void {
    this.inFlight = false;
    if (automatic) { this.phase = "waiting"; this.waitingGate = true; }
    else { this.paused = true; this.phase = "asking"; }
    this.emit();
  }

  snapshot(): DeleteSnapshot {
    const asking = this.phase === "asking";
    const remainingMs = asking && this.askedAt !== null ? Math.max(0, this.askedAt + CONFIRM_DELAY_MS - this.clock.now()) : null;
    const writable = this.options.gate.mayWrite(this.intent?.commandId);
    return {
      phase: this.phase,
      remainingS: remainingMs === null ? null : Math.ceil(remainingMs / 1000),
      canConfirm: asking && remainingMs === 0 && !this.inFlight && writable && !this.owner,
      canOpen: !this.owner && ["idle", "refused", "not_deleted"].includes(this.phase),
      // P3 (QA fix3): without a live access of this document the button is inactive, not a silent no-op; a new access
      // of the same document repaints it (accessChanged).
      canCheck: this.phase === "stuck" && !this.inFlight && this.options.gate.checkButtonActive()
        && typeof this.accessNow() === "object",
      repeating: this.phase === "waiting" || this.phase === "sending" && this.hadUnknown,
      paused: this.paused,
      refusalCode: this.refusalCode,
      droppedUnknown: this.droppedUnknown,
    };
  }

  private emit(): void { if (this.phase !== "disposed") this.options.onUpdate(this.snapshot()); }

  /** The question (Q12): the final button waits CONFIRM_DELAY_MS from now. */
  open(): void {
    if (!this.snapshot().canOpen) return;
    this.dropIntent();
    this.refusalCode = null;
    this.droppedUnknown = false;
    this.paused = false;
    this.phase = "asking";
    this.askedAt = this.clock.now();
    this.scheduleTick();
    this.emit();
  }

  /** «Отмена» of the question: back to the item; nothing was sent. */
  cancel(): void {
    if (this.phase !== "asking" || this.inFlight) return;
    this.cancelTick();
    this.dropIntent();
    this.phase = "idle";
    this.paused = false;
    this.emit();
  }

  private scheduleTick(): void {
    this.cancelTick();
    if (this.phase !== "asking" || this.askedAt === null) return;
    const left = this.askedAt + CONFIRM_DELAY_MS - this.clock.now();
    if (left <= 0) return;
    // One repaint per second of the countdown; the last one lands exactly at the end of the delay.
    this.tick = this.clock.schedule(() => { this.tick = null; this.scheduleTick(); this.emit(); }, left % 1000 || 1000);
  }
  private cancelTick(): void { if (this.tick) this.clock.cancel(this.tick); this.tick = null; }

  /** The final button. A tap while it is not active does nothing and is not kept for later. */
  confirm(): void {
    if (!this.snapshot().canConfirm) return;
    // A tap that the gate kept on the client (paused) sent nothing: the same command_id may go with the next tap.
    if (!this.intent) {
      this.intent = { profileId: this.profileId, commandId: this.options.newId() };
      this.sends = 0;
      this.hadUnknown = false;
    }
    this.paused = false;
    void this.send();
  }

  private dropIntent(): void {
    if (this.repeatTimer) this.clock.cancel(this.repeatTimer);
    this.repeatTimer = null;
    this.waitingGate = false;
    this.backgrounded = false;
    this.returnTries = 0;
    this.sessionToken = null;
    this.intent = null;
    this.sends = 0;
    this.hadUnknown = false;
  }

  private async credentials(access: OpenedAccess): Promise<ProfileDeleteCredentials> {
    // Taken from the opened access at the moment of each send (memory only); the request itself runs outside
    // access.run, so its 401/403 are decided here by §3.7 and do not end the document before this screen shows them.
    return access.run(async ({ token, proof, clientInstanceId }) => ({ token, proof, clientInstanceId }));
  }

  private async send(automatic = false): Promise<void> {
    const intent = this.intent;
    if (!intent || !this.live() || this.inFlight) return;
    const access = this.accessNow();
    if (access === "other" || intent.profileId.toLowerCase() !== this.profileId.toLowerCase()) { this.lost(); return; }
    if (access === "none") { this.awaitAccess(automatic); return; }
    this.inFlight = true;
    this.phase = "sending";
    this.emit();
    let credentials: ProfileDeleteCredentials;
    try { credentials = await this.credentials(access); }
    catch {
      // The access was replaced on this await (ClosedAccessError): the same document's new one is waited for.
      this.inFlight = false;
      if (this.live() && this.intent === intent) this.awaitAccess(automatic);
      return;
    }
    if (!this.sameSession(intent, credentials)) return;
    if (!this.stillOwner(intent, automatic)) return;
    let reply: ProfileDeleteReply;
    try { reply = await this.options.api.delete(credentials, intent); }
    catch { reply = { outcome: "unknown" }; }
    this.inFlight = false;
    // An applied deletion is a fact, not a new send: it is shown and cleared even if the screen was left meanwhile.
    if (reply.outcome === "applied" && (this.phase as DeletePhase) !== "ended") { await this.applied(); return; }
    if (!this.live() || this.intent !== intent) return;
    if (reply.outcome !== "paused") this.sends++;
    await this.decide(reply, credentials);
  }

  /** §3.7: «применено» → «исход неизвестен» → «не выполнено», by the code and by the earlier unknown outcome. */
  private async decide(reply: ProfileDeleteReply, credentials: ProfileDeleteCredentials | null): Promise<void> {
    const intent = this.intent;
    switch (reply.outcome) {
      case "applied": return;
      case "paused":
        // Nothing left the client. On the first tap the question comes back with its button (by the gate);
        // during automatic repeats the next repeat waits for the gate.
        if (this.hadUnknown || this.sends > 0) { this.scheduleRepeat(0); return; }
        this.paused = true;
        this.phase = "asking";
        this.emit();
        return;
      case "refused":
        this.journalDelete(intent, "refused", reply.code);
        this.refuse(reply.code);
        return;
      case "auth":
        if (this.hadUnknown) { this.end({ kind: "unknown", confirmedProfileId: this.profileId }); return; }
        this.end({ kind: "expired" });
        return;
      case "defect":
        // P3-D: a defect writes c.defect only, never a c.delete with the code the screen shows for it.
        this.journalDefect(intent, reply);
        if (!this.hadUnknown) { this.refuse(reply.code ?? "VALIDATION_FAILED"); return; }
        // The same request could not be answered so: no repeat; one read by the same session decides (§3.7).
        await this.checkOutcome(credentials);
        return;
      case "write_unavailable":
        // Rolled back: on the first attempt not applied yet, on a repeat unknown; both repeat the same command_id.
        this.scheduleRepeat(RETRY_PAUSES_MS[Math.min(this.sends, RETRY_PAUSES_MS.length) - 1] ?? 0);
        return;
      case "maintenance":
      case "unknown":
        this.hadUnknown = true;
        // After MAINTENANCE only the gate's readiness (P03) lets the repeat go: the gate stays closed until then.
        this.scheduleRepeat(RETRY_PAUSES_MS[Math.min(this.sends, RETRY_PAUSES_MS.length) - 1] ?? 0);
        return;
    }
  }

  private scheduleRepeat(pauseMs: number): void {
    if (!this.live() || !this.intent) return;
    if (this.sends >= MAX_SENDS) { this.phase = "stuck"; this.emit(); return; }
    this.phase = "waiting";
    this.emit();
    if (this.repeatTimer) this.clock.cancel(this.repeatTimer);
    this.repeatTimer = this.clock.schedule(() => {
      this.repeatTimer = null;
      this.waitingGate = true;
      this.gateChanged();
    }, pauseMs);
  }

  private gateChanged(): void {
    if (!this.live()) return;
    // Nothing is sent while the page is hidden (P04 §3.7, P03 N3): the repeat waits, its budget is kept as it is.
    if (!this.visible() && (this.phase === "waiting" || this.waitingGate)) this.backgrounded = true;
    if (this.waitingGate && this.intent && !this.inFlight && this.visible()
      && this.options.gate.mayWrite(this.intent.commandId)) {
      this.waitingGate = false;
      if (this.backgrounded) void this.returnCheck(); else void this.send(true);
      return;
    }
    this.emit();
  }

  /**
   * The last guard right before a request leaves, after the await for the credentials (C365, C366): the owner of the
   * norm is still there — this screen, this intent, an access of the same profile — and an automatic send also needs
   * the page shown and the gate open (a closed window keeps it closed). Otherwise nothing leaves and no budget is spent.
   */
  private stillOwner(intent: ProfileDeleteIntent, automatic: boolean): boolean {
    if (!this.live() || this.intent !== intent) { this.inFlight = false; return false; }
    const now = this.accessNow();
    if (now === "other") { this.inFlight = false; this.lost(); return false; }
    if (now === "none") { this.awaitAccess(automatic); return false; }
    if (!automatic && (!this.visible() || !this.options.gate.mayWrite(intent.commandId))) {
      // The tap met a hidden page or a gate that closed meanwhile: nothing leaves (background → 0 POST), the question
      // stays with its button and the same command_id for the next tap of the user (no queued tap).
      this.inFlight = false;
      this.paused = true;
      this.phase = "asking";
      this.emit();
      return false;
    }
    if (automatic && (!this.visible() || !this.options.gate.mayWrite(intent.commandId))) {
      this.inFlight = false;
      if (!this.visible()) this.backgrounded = true;
      this.phase = "waiting";
      this.waitingGate = true;
      this.emit();
      return false;
    }
    return true;
  }

  private visible(): boolean { return (this.options.pageVisible ?? documentVisible)(); }

  /**
   * The return from the background (P03 N3 «после возврата из фона проверить результат и автоматически продолжить
   * оставшийся бюджет»; P04 §3.7 ред.15). The result of an unknown outcome is checked by one read of the same session,
   * outside the send budget: PROFILE_DELETED — applied; AUTH_* — PD-28 after an unknown outcome (else not done, the
   * expired screen); a working read — the profile is alive at that moment, which is no proof the deletion will not
   * apply, so the same command_id goes on with the rest of the budget (a repeat of an applied one is already_applied,
   * §5); a failed read decides nothing — no POST, the next look after 5/10/20/30 s, only while shown.
   */
  private async returnCheck(): Promise<void> {
    const intent = this.intent;
    if (!intent || !this.live() || this.inFlight) return;
    const access = this.accessNow();
    if (access === "other") { this.lost(); return; }
    if (access === "none") { this.awaitAccess(true); return; }
    this.inFlight = true;
    this.phase = "checking";
    this.emit();
    let credentials: ProfileDeleteCredentials;
    try { credentials = await this.credentials(access); }
    catch { this.inFlight = false; if (this.live() && this.intent === intent) this.awaitAccess(true); return; }
    if (!this.sameSession(intent, credentials)) return;
    if (!this.stillOwner(intent, true)) return;
    let result: Awaited<ReturnType<ProfileDeleteApi["check"]>> = "unknown";
    try { result = await this.options.api.check(credentials.token); } catch { result = "unknown"; }
    this.inFlight = false;
    if (result === "deleted" && (this.phase as DeletePhase) !== "ended") { await this.applied(); return; }
    if (!this.live() || this.intent !== intent) return;
    if (result === "auth") {
      this.end(this.hadUnknown ? { kind: "unknown", confirmedProfileId: this.profileId } : { kind: "expired" });
      return;
    }
    if (result === "not_deleted") {
      this.backgrounded = false;
      this.returnTries = 0;
      void this.send(true);
      return;
    }
    this.returnTries++;
    this.phase = "waiting";
    this.emit();
    if (this.repeatTimer) this.clock.cancel(this.repeatTimer);
    this.repeatTimer = this.clock.schedule(() => {
      this.repeatTimer = null;
      this.waitingGate = true;
      this.gateChanged();
    }, PROBE_DELAYS_MS[Math.min(this.returnTries, PROBE_DELAYS_MS.length) - 1]);
  }

  /** «Проверить» after the repeats ran out: the read by the same session, never a new command. */
  check(): void {
    if (!this.snapshot().canCheck) return;
    const access = this.accessNow();
    if (access === "other") { this.lost(); return; }
    if (access === "none") return;
    void this.credentials(access).then(credentials => this.checkOutcome(credentials), () => this.checkOutcome(null));
  }

  private async checkOutcome(credentials: ProfileDeleteCredentials | null): Promise<void> {
    if (!this.live()) return;
    this.phase = "checking";
    this.inFlight = true;
    this.emit();
    let result: Awaited<ReturnType<ProfileDeleteApi["check"]>> = "unknown";
    if (credentials) { try { result = await this.options.api.check(credentials.token); } catch { result = "unknown"; } }
    this.inFlight = false;
    // «Deleted» is a fact about X, as an applied send is: its records go even if the screen was left meanwhile.
    if (result === "deleted" && (this.phase as DeletePhase) !== "ended") { await this.applied(); return; }
    if (!this.live()) return;
    // A working read by the same session: an applied deletion would have revoked it (S36), so nothing was deleted.
    if (result === "not_deleted") { this.dropIntent(); this.phase = "not_deleted"; this.emit(); return; }
    // AUTH_* or no answer: the outcome stays unknown, the explicit sign-in decides (PD-28).
    this.end({ kind: "unknown", confirmedProfileId: this.profileId });
  }

  /**
   * DEV-41 M2 (events §4.5, П-Р2): c.delete of an outcome that was not applied — refused with its code, or the final
   * «исход неизвестен». cmd is this screen's own command_id; no del, no trace, nothing of the question or its text. An
   * applied deletion writes nothing: the buffer is cleared (P04 §8). A refusal that ends the admission (ACCESS_*) clears
   * the journal in the transport before this line, so it is not kept either.
   */
  private journalDelete(intent: ProfileDeleteIntent | null, outcome: "refused" | "unknown", code?: string): void {
    const cmd = journalId(intent?.commandId);
    if (cmd === null) return;
    journalRecord({ ev: "c.delete", cmd, outcome, ...(outcome === "refused" && isErrorCode(code) ? { code } : {}) });
  }

  /**
   * DEV-41 M2, §9 п.3: c.defect of the attempt the defect answered, from the transport's snapshot only (trace and the
   * command_id of the body that was sent, never the echo), and only while it is this screen's live intent of the same
   * profile. Tied to the core's line of that attempt by the trace when the request reached the core (P3-E).
   */
  private journalDefect(intent: ProfileDeleteIntent | null, reply: Extract<ProfileDeleteReply, { outcome: "defect" }>): void {
    const attempt = deleteAttempt(reply);
    if (!attempt || !intent || !this.live() || this.intent !== intent
      || intent.profileId.toLowerCase() !== this.profileId.toLowerCase()) return;
    const cmd = journalId(attempt.commandId), trace = journalId(attempt.trace);
    if (cmd === null || trace === null || cmd !== journalId(intent.commandId)) return;
    journalRecord({ ev: "c.defect", cmd, trace, status: reply.status, ...(isErrorCode(reply.code) ? { code: reply.code } : {}) });
  }

  private refuse(code: string): void {
    this.dropIntent();
    this.refusalCode = code;
    this.phase = "refused";
    this.emit();
  }

  /** The access went away or now names another profile (§3.7 п.3): the intent is dropped, nothing more is sent. */
  private lost(): void {
    if (this.intent && (this.hadUnknown || this.sends > 0)) this.droppedUnknown = true;
    this.dropIntent();
    this.phase = this.owner ? "owner" : "idle";
    this.emit();
  }

  private async applied(): Promise<void> {
    const profileId = this.profileId;
    this.dropIntent();
    this.cancelTick();
    // §8: the journal buffer and every local record of X go before the result is shown; a failure keeps the result.
    journalAccess.revoke(true);
    await wipeProfileRecords(this.options.storage, profileId);
    this.end({ kind: "deleted" });
  }

  private end(end: DeletionEnd): void {
    if (this.phase === "ended" || this.phase === "disposed" && end.kind !== "deleted") return;
    const disposed = this.phase === "disposed";
    if (end.kind === "unknown") this.journalDelete(this.intent, "unknown");
    this.dropIntent();
    this.cancelTick();
    this.phase = "ended";
    if (!disposed) this.options.onUpdate(this.snapshot());
    this.options.onEnded(end);
  }

  /** The screen is left (Back, another section, a closed or reloaded Mini App): the intent and every timer go. */
  dispose(): void {
    if (this.phase === "disposed") return;
    this.unsubscribe();
    this.unsubscribePage();
    if (this.pageTimer) this.clock.cancel(this.pageTimer);
    this.pageTimer = null;
    this.cancelTick();
    this.dropIntent();
    this.phase = "disposed";
  }
}
