import type { AuthResponse, OpenRequest, Profile, RegisterResponse } from "../api/generated";
import { EntryApiError } from "../api/entryApi";
import type { DocumentStaleSource } from "../api/http";
import type { EntryApi } from "../api/entryApi";
import type { Language } from "../i18n/language";
import type { AsyncStorage } from "../platform/storage";
import type { DocumentLease, DocumentLock } from "./documentLock";
import { newerVersion } from "./installation";
import type { InstallationStore } from "./installationStore";
import type { IdbInstallationStore } from "./installationStoreIdb";
import { decideA, decideActivated, decideB, decideRegister } from "./installationWriters";
import type { Installation as StoredInstallation } from "./installation";
import type { Installation } from "./installation";
import type { EntryState } from "./entryState";
import { clearReapplyIntent, readReapplyIntent, writeReapplyIntent } from "./reapplyIntent";
import type { ReapplyIntent } from "./reapplyIntent";
import { createOpenedAccess, type OpenedAccess } from "./openedAccess";
import type { RemoteSessionApi, RemoteStopIntent } from "../study/remoteSessionApi";
import type { RemoteStopPendingStore } from "../study/remoteStopPending";
import { RemoteStopController } from "../study/remoteStopController";
import type { TodayApi } from "../today/todayApi";
import { createBusyAccess, type BusyAccess } from "./busyAccess";
import { journalAccess, journalRecord } from "../journal/clientJournal";
import { GatePending, pausedBeforeSend } from "../commands/gatePending";
import type { GateDoc, GateEvent, P01Episode, RemoteReadContext, RequestOrigin, RequestStamp, WriteGate } from "../commands/writeGate";
import { gateWait } from "../commands/gateWait";
import { DeletedProfileCleanup } from "../profile/deletedProfileCleanup";
import type { DeletionEnd } from "../profile/profileDeleteController";
import { proofRefusalCandidate } from "../commands/proofRefusal";

export type EntrySnapshot = { state: EntryState; profile?: Profile };

/** C163 шаг 6b (P2-6B): no installation store given — every write and read is "unsupported": fail-closed. */
const NO_STORE: InstallationStore = Object.freeze({
  mutate: async () => ({ kind: "unsupported" as const, reason: "no-web-locks" as const }),
  read: async () => ({ kind: "unsupported" as const }),
  forget: async () => ({ kind: "unsupported" as const }),
});

/**
 * What a screen's foreground carries (fix3/fix4, C384): startRefused — the command_id of the start whose definite refusal
 * SESSION_BUSY the screen shows, sent by the «На Сегодня» of that refusal screen only. It spends the gate's П01 episode of
 * exactly that command (once); its SESSION_BUSY then opens the narrow readback of the own stop (gate.openP01ReadContext).
 */
export type ForegroundIntent = { startRefused?: string };

/** HTTP 401 means this sign-in no longer works: retrying with the same signed data cannot help. */
function expiredBy(error: unknown): boolean {
  return error instanceof EntryApiError && error.kind === "http" && error.status === 401;
}

/**
 * 403 PROFILE_DELETED (P04 ред.14 §8, §3.9): the profile is deleted — its result, without a retry or a button that would
 * sign in again.
 */
function deletedBy(error: unknown): boolean {
  return error instanceof EntryApiError && error.kind === "http" && error.status === 403 && error.code === "PROFILE_DELETED";
}

/** A planned pause of the core or of the responder (503 MAINTENANCE, §3.2). */
function maintenance(error: unknown): error is EntryApiError {
  return error instanceof EntryApiError && error.kind === "http" && error.status === 503 && error.code === "MAINTENANCE";
}

/**
 * The class «ordinary transport» of a foreground answer (P02-W К-11 «Класс отказа», P03 §4.10): 502/504/any ≥500 but
 * 503 MAINTENANCE, a refused fetch, the client's own timeout, a body the transport could not read. A decoder refusal
 * names its status (entryApi) and is no transport: it is the failed identity check ВР-8.
 */
function transportFailure(error: unknown): boolean {
  if (!(error instanceof EntryApiError)) return false;
  if (error.kind === "network" || error.kind === "timeout") return true;
  if (error.kind === "invalid_response") return error.status === undefined;
  return error.kind === "http" && error.status !== undefined && error.status >= 500 && !maintenance(error);
}

/**
 * C163 re-entry (22.1-А, AC-104): right before L2 the window was hidden or the gate did not let the first open of the new
 * document go. Nothing of it left (admit never saw it, openAttempts unchanged); the expired screen comes back, the click is
 * not kept (N3, no queue of clicks).
 */
class ReentryHeld extends Error {
  constructor() { super("reentry_held"); }
}

/** ВР-8 / ВР-8б: the recovery foreground (or the manual check of the last working document) did not prove the identity. */
class IdentityRefused extends Error {
  constructor(public readonly reason: "identity" | "busy") { super(`identity_refused: ${reason}`); }
}

/**
 * The commands whose attributed 409 DOCUMENT_STALE proves the installation's live document is another one (the DOCUMENT_STALE
 * junction P02↔P03, C371/C408): core settings/reset.py checks exactly require_live_document (identity/origin.py:123–138,
 * DOCUMENT_STALE only for document_id ≠ live) for a new reset (:402), its cancel (cancel_target, :463) and its barrier
 * (raise_epoch, :472). Three explicit kinds, nothing wider.
 */
export const REPLACEMENT_PROOF_KINDS: ReadonlySet<string> = new Set(["settings.reset", "settings.reset_cancel", "settings.reset_barrier"]);
const sameGateDoc = (a: GateDoc, b: GateDoc) => a.profileId === b.profileId && a.documentId === b.documentId && a.epoch === b.epoch;

export type EntryControllerOptions = {
  api: EntryApi;
  today?: TodayApi;
  remote?: { api: RemoteSessionApi; pendingStore: RemoteStopPendingStore };
  storage: AsyncStorage;
  lock: DocumentLock;
  initData: string | null;
  savedLanguage: Language | null;
  browserLanguage: string | null;
  clientVersion: string;
  contractVersion: string;
  timeZone(): string | null;
  newId(): string;
  onUpdate(snapshot: EntrySnapshot): void;
  /** Closes this window when the platform can (the Telegram Mini App); otherwise the replaced screen stays. */
  closeWindow?(): void;
  /**
   * True from a DOCUMENT_STALE until its foreground check has settled. The window keeps its screens mounted but out
   * of sight meanwhile, so a replaced window closes without showing a module's refusal first (2.33).
   */
  onDocumentCheck?(checking: boolean): void;
  /**
   * The write gate of the page (P03 M-P03-8): the remote stop reads its status only with the gate's ticket (R6), and the
   * reapply and the remote stop take part in its readback registry (R1).
   */
  gate: WriteGate;
  /**
   * C163 шаг 6 (C405/C410): the ONE writer path of the installation record (installationStore.mutate). App gives the
   * browser store (Web Locks + synchronous storage, installationStore.ts). Without one the entry is fail-closed (6b,
   * P2-6B): nothing is written, no register, no open — there is no product fallback store.
   */
  installationStore?: InstallationStore;
};

export class EntryController {
  private generation = 0;
  private disposed = false;
  private state: EntryState = { kind: "checking" };
  private session: AuthResponse | null = null;
  private installation: Installation | null = null;
  private documentId: string | null = null;
  private lease: DocumentLease | null = null;
  // The pending lock request; reset, replacement and dispose drop it, so a late grant is given back.
  private claim: object | null = null;
  // A request of this document got DOCUMENT_STALE and no open has confirmed the document since.
  private staleHint = false;
  // The foreground check that a DOCUMENT_STALE asked for is still running.
  private checking = false;
  // A newer window of this installation took the document over: nothing here is sent for it again.
  private replaced = false;
  private profileVersion: string | null = null;
  private accessVersion: string | null = null;
  private reapplyIntent: ReapplyIntent | null = null;
  private conflictedIntentId: string | null = null;
  private conflictedAccessVersion: string | null = null;
  /** The profile whose reapply met 409 VERSION_CONFLICT: the refreshed profile must be this one (В4, C390). */
  private conflictedProfileId: string | null = null;
  // The profile whose reapply the core refused with 403 ACCESS_REJECTED (two refusals, CT §6.3). It outlives
  // retry(): the closure is final, and an older core's profile has no reapply_closed to say so again.
  private reapplyClosedFor: string | null = null;
  private proofIssuedThisSession = false;
  private running: Promise<void> | null = null;
  private foregroundRunning = false;
  private queuedForeground: Promise<void> | null = null;
  private queuedRemoteRequest: Promise<void> | null = null;
  private openedAccess: OpenedAccess | null = null;
  private busyAccess: BusyAccess | null = null;
  private busySequence = 0;
  private remote: RemoteStopController | null = null;
  private observedStateVersion: string | null = null;
  // The target of a confirmed stop that the core refused (for example SESSION_CLOSED). The reopen that follows
  // compares it with the session now occupying the account: a different one is explained, not silently offered.
  private refusedTarget: string | null = null;

  private readonly reapplyRegistry: GatePending;

  // ---- P03 M-P03-10: the window and the write gate (P02-W К-9, К-9а, К-11 as the row M-P03-10 lists them) ----
  /** The internal recovery flag of the opened state (К-11/К-9а): none, waiting for the server, or the foreground in flight. */
  private recovery: "none" | "recovering" | "verifying" = "none";
  /** The one recovery foreground in flight (any source: show, ready, a manual check). */
  private recoveryTask: Promise<void> | null = null;
  private hidden = false;
  /** Set when the window is hidden; the first foreground() after it is shown spends it (ВР-4, one per show). */
  private showPending = false;
  /** К-9: a window without a working document waits for ready and the hold end before its К-7 button (no open). */
  private waitingWrite = false;
  /** The last SESSION_BUSY named another installation's session (P03 §4.13 Б). */
  private foreignBusyKnown = false;
  /** R10 п.1: the narrow read context of the own stop_remote, made after a valid SESSION_BUSY of this generation. */
  private remoteContext: RemoteReadContext | null = null;
  /** The remote-stop screen belongs to the busy branch now: before that a loaded pending shows nothing (R10 п.4). */
  private remoteScreen = false;
  /** A window closed for good by ВР-8/ВР-8б (§4.12); ВР-7 is `replaced`. */
  private closed = false;
  /** The foreground after a confirmed own stop that a hidden window holds for its next show (N3, fix1). */
  private reopenOnShow: { token: string; generation: number } | null = null;
  /**
   * A reapply ended without a known profile (409 VERSION_CONFLICT, a committed reapply whose local cleanup failed, an
   * unreadable reply): the `unavailable` button reads the profile again (route «profile», fix1; C373).
   */
  private profileRefresh = false;
  /** The current run only reads the profile again (route «profile», fix1): it never goes on to open. */
  private profileOnly = false;
  /**
   * A first open that goes to L2 only from a visible window with mayWrite in the same synchronous stretch (else nothing
   * of it leaves): "reentry" — the expired screen's button (C163); "profile" — the first open of the page after the explicit
   * profile refresh of a VERSION_CONFLICT found the profile admitted (В4-Б, C390). Null for every other run.
   */
  private guarded: { generation: number; kind: "reentry" | "profile" } | null = null;
  /** Н4: the core refused this page's signed initData itself (401 to auth): no new sign-in with the same data. */
  private initDataRefused = false;
  /** P3-5: the profile whose session ended with 401; the re-entry signs in again only as this profile. */
  private reentryProfileId: string | null = null;
  /**
   * C163 шаг 5 (Q01 вариант 1; CON:196–200; CL493): after the narrow candidate of a refused installation proof the page's
   * re-entry signs in anew and continues as a NEW installation B. a — the refused installation A as this page knew it
   * (its record is never reused); b — the client_instance_id of B this page created. Once per page: a second candidate
   * stops (no cycle).
   */
  private installationRecovery: { a: Installation | null; b: Installation | null } | null = null;
  private readonly unsubscribeGate: () => void;
  private readonly waiters = new Set<() => void>();
  /** The phase of the identity lock the last gate event showed (ВР-12 is the step readback → verifying). */
  private lockPhase: "verifying" | "readback" | null = null;

  private readonly store: InstallationStore;
  /** P04 (A) / store §6: the profiles this page knows deleted; their cleanup is repeated on every trigger below. */
  private readonly deletedProfiles: DeletedProfileCleanup;

  constructor(private readonly options: EntryControllerOptions) {
    this.store = options.installationStore ?? NO_STORE;
    this.deletedProfiles = new DeletedProfileCleanup(options.storage, options.installationStore);
    this.reapplyRegistry = new GatePending(options.gate, "reapply");
    // The entry reports its document to the gate from now on (noteOpened/noteAccessLost, together with R10).
    options.gate.trackAccess();
    this.unsubscribeGate = options.gate.subscribe(event => this.onGate(event));
  }

  private get gate(): WriteGate { return this.options.gate; }

  private current(generation: number): boolean {
    return !this.disposed && generation === this.generation;
  }

  private emit(state: EntryState, profile?: Profile): void {
    this.state = state;
    if (state.kind !== "opened") {
      this.openedAccess = null;
      // No live opened any more: ordinary tickets are void (R2). Only busy → remote_confirm → remote keeps R10's context.
      const busyBranch = state.kind === "busy" || state.kind === "remote_confirm" || state.kind === "remote";
      if (!busyBranch) this.remoteContext = null;
      if (state.kind !== "closed" && state.kind !== "replaced") this.gate.noteAccessLost({ keepRemote: busyBranch });
    }
    if (state.kind !== "unavailable" || !state.waiting) this.waitingWrite = false;
    if (state.kind !== "unavailable" && state.kind !== "checking") this.profileRefresh = false;
    this.busyAccess = null;
    if (state.kind === "busy" && state.remoteTarget && profile && this.session && this.options.today) {
      const generation = this.generation;
      const access: BusyAccess = createBusyAccess({
        key: `${profile.profile_id}:busy:${++this.busySequence}`, profile,
        token: this.session.access_token, api: this.options.today,
        minimumVersion: this.observedStateVersion,
        onRead: version => this.observeStateVersion(version),
        isLive: () => this.current(generation) && this.state.kind === "busy" && this.busyAccess === access,
        onDenied: error => {
          this.generation += 1;
          this.resetInvalidSession(error);
          this.emit(this.failureState(error));
        },
      });
      this.busyAccess = access;
    }
    this.options.onUpdate({ state, profile });
  }

  getOpenedAccess(): OpenedAccess | null {
    return this.openedAccess?.isLive() ? this.openedAccess : null;
  }

  getBusyAccess(): BusyAccess | null {
    return this.busyAccess?.isLive() ? this.busyAccess : null;
  }

  private observeStateVersion(version: string): void {
    // Reads and commands can advance account state without returning a profile.
    // Do not relabel a cached profile with that newer version.
    if (!this.observedStateVersion || newerVersion(version, this.observedStateVersion)) this.observedStateVersion = version;
  }

  private acceptProfile(profile: Profile): boolean {
    if (this.session && this.session.profile.profile_id !== profile.profile_id) return false;
    if (this.profileVersion && newerVersion(this.profileVersion, profile.state_version)) return false;
    if (this.accessVersion && newerVersion(this.accessVersion, profile.access.version)) return false;
    this.profileVersion = profile.state_version;
    this.accessVersion = profile.access.version;
    if (this.session?.profile.profile_id === profile.profile_id) {
      this.session = { ...this.session, profile };
    }
    return true;
  }

  start(): Promise<void> {
    if (this.running) return this.running;
    // Store §6: the next sign-in repeats the cleanup of a profile this page knows deleted (actual presence each time).
    void this.deletedProfiles.retry();
    this.session = null;
    this.installation = null;
    this.documentId = null;
    this.profileVersion = null;
    this.observedStateVersion = null;
    this.accessVersion = null;
    this.reapplyIntent = null;
    this.staleHint = false;
    this.proofIssuedThisSession = false;
    return this.run(true);
  }

  /**
   * The button of the `unavailable` screen (P03 §4.13, M-P03-10). It never sends `event="open"` (п.8б): route А checks
   * the last working document with one foreground, route Б checks this window's own document while another
   * installation's occupancy is known; route В (no working document, no known occupancy) is blocked until Я19 and does
   * nothing — also without a session (after resetInvalidSession), where no new document is made by this button.
   * Active only by checkButtonActive (net open, hold over, no recovery foreground in flight, window not closed).
   */
  retry(): Promise<void> {
    if (this.running) return this.running;
    if (this.state.kind !== "unavailable" || this.state.waiting) return Promise.resolve();
    const route = this.route();
    if (route === "profile") {
      // P3-3: the profile button follows the rule of the button — its click may end in the guarded first open (В4-Б).
      if (this.gate.snapshot().closedWindow || !this.gate.mayWrite()) return Promise.resolve();
      this.profileOnly = true;
      return this.run(this.session === null).finally(() => { this.profileOnly = false; });
    }
    const session = this.session;
    if ((route !== "document" && route !== "own") || !session || !this.gate.checkButtonActive()) return Promise.resolve();
    const working = this.gate.snapshot().lastWorkingDoc;
    if (route === "document" && working) this.documentId = working.documentId;
    if (!this.documentId) return Promise.resolve();
    const generation = this.generation;
    this.gate.recoveryForegroundSent();
    this.emit(this.unavailableState());
    const task = this.open(session.access_token, generation, "foreground", "user", undefined, route === "document")
      .catch((error: unknown) => {
        if (!this.current(generation)) return;
        if (error instanceof IdentityRefused) { this.closeFor(error.reason); return; }
        if (route === "document" && !transportFailure(error) && error instanceof EntryApiError
          && error.kind === "invalid_response") { this.closeFor("identity"); return; }
        this.fail(error);
      }).finally(() => {
        this.gate.recoveryForegroundSettled();
        if (this.running === task) this.running = null;
        this.refreshShownState();
      });
    this.running = task;
    return task;
  }

  /**
   * The button of the expired screen (C163/22.1-А; P03 §4.6, AC-104; P02-W К-Т12о, :560): one new sign-in in the same
   * window after a 401. auth (and register, if the stored installation has no proof) are L2 exceptions (§4.1 п.2,
   * POST_ROUTES); a successful auth is no working document. The open that follows is the FIRST open of a new document
   * (resetInvalidSession dropped the old one: п.8б (2)) and goes to L2 only if, in the same synchronous stretch, the window
   * is visible and mayWrite holds; else nothing of it leaves and the expired screen comes back (ReentryHeld). A failure
   * before that open reached L2 also brings the expired screen back; after it, the ordinary rules of the first open apply
   * (§4.13 В/Б, п.8б (5)). Never the `unavailable` button (AC-102); ready, a show or a timer never call it.
   */
  reenter(): Promise<void> {
    if (this.running) return this.running;
    const state = this.state;
    if (state.kind !== "expired" || !state.reentry || !state.checkable) return Promise.resolve();
    if (this.session !== null || !this.options.initData || this.initDataRefused || this.replaced || this.closed || this.disposed
      || this.hidden || !this.gate.mayWrite()) return Promise.resolve();
    return this.run(true, true);
  }

  /**
   * The window is hidden or shown (App's visibilitychange/pageshow). Hidden: the next show is one show (ВР-4) — the
   * first foreground() after it spends it. Hidden windows send no recovery foreground (ВР-3).
   */
  setVisible(visible: boolean): void {
    if (visible === !this.hidden) return;
    this.hidden = !visible;
    if (this.hidden) { this.showPending = true; return; }
    // Store §6: the page shown again repeats the cleanup of a profile this page knows deleted.
    void this.deletedProfiles.retry();
    // N3 (C365): a first open held by the gate, or the foreground after a confirmed own stop, waits for a visible window.
    for (const wake of [...this.waiters]) wake();
  }

  /**
   * «Not confirmed» for the screens (P02-W К-11 «Результат foreground() для экранов», AC-11h): while the recovery flag is
   * set, a foreground the screen asked for proves no synchronization; the screen keeps what it shows and waits.
   */
  unconfirmed(): boolean { return this.recovery !== "none"; }

  /**
   * Refresh the same document before its screens read the new calendar state. source (fix2, П01 against N14): "show" — the
   * window became visible again (App's visibilitychange/pageshow, the real return of P03 N14 and E-M12); "screen" — a screen
   * synchronizes itself (the «На Сегодня» after a refused start, a return to Today, a stale check). SESSION_BUSY closes a
   * window with a working document (N14) unless the screen's intent spends the П01 episode of the shown refusal (fix5, C388):
   * then it is the busy Today of П01/В4.
   */
  foreground(source: "show" | "screen" = "screen", intent?: ForegroundIntent): Promise<void> {
    if (this.replaced || this.closed) return Promise.resolve();
    const shown = this.showPending;
    this.showPending = false;
    const reopen = this.reopenOnShow;
    if (reopen && !this.hidden && !this.running) {
      this.reopenOnShow = null;
      if (!this.current(reopen.generation)) return Promise.resolve();
      return this.remoteReopen(reopen.token, reopen.generation);
    }
    if (this.recovery !== "none") {
      // One recovery foreground in flight, for every caller (ВР-4, ВР-5): the show of a hidden window may send one
      // immediately unless the 5 s of the anti-flapping mark have not passed; any other caller sends nothing.
      if (this.recoveryTask) return this.recoveryTask;
      if (shown && !this.hidden && this.gate.showForegroundAllowed()) return this.sendRecovery("auto");
      return Promise.resolve();
    }
    if (this.running) {
      if (this.foregroundRunning || !this.refreshable()) return this.running;
      // Opened can be rendered before startup's finally clears running.
      // Retain that event, but coalesce events already covered by a foreground request.
      if (!this.queuedForeground) this.queuedForeground = this.running.then(() => {
        this.queuedForeground = null;
        return this.foreground(source, intent);
      });
      return this.queuedForeground;
    }
    if (!this.refreshable() || !this.session) return Promise.resolve();
    const generation = this.generation;
    // К-11/К-9а apply only to a working window: opened now, and the gate knows its confirmed document.
    const working = this.state.kind === "opened" && this.gate.snapshot().lastWorkingDoc !== null;
    // fix3 (П01): only the way back to Today of a working window spends a П01 episode; every other foreground ends it.
    const episode = working && source === "screen" && intent?.startRefused ? this.gate.takeP01(intent.startRefused) : null;
    if (!episode) this.gate.endP01();
    // fix5 (C388, N14 P03:54): a window with a working document (lastWorkingDoc, also on the busy Today it reached) answered
    // SESSION_BUSY to any ordinary foreground — a show, a generic return to Today, a pair refresh, a stale check, the busy
    // Today's refresh — is closed (ВР-8б path), with no request after it. Only the explicit «На Сегодня» of the shown refusal,
    // whose command_id spends the gate's П01 episode, leads to the busy Today of П01/В4; a window without a working
    // document keeps the cold busy Today (Stop, R10).
    const closeOnBusy = this.gate.snapshot().lastWorkingDoc !== null && !episode;
    const task = this.open(this.session.access_token, generation, "foreground", "auto", undefined, false,
      closeOnBusy, episode).catch((error: unknown) => {
      if (!this.current(generation)) return;
      if (error instanceof IdentityRefused) this.closeFor(error.reason);
      else if (working && (maintenance(error) || transportFailure(error))) this.enterRecovery();
      else this.fail(error);
    }).finally(() => {
      if (this.running === task) {
        this.running = null;
        this.foregroundRunning = false;
      }
    });
    this.running = task;
    this.foregroundRunning = true;
    return task;
  }

  private refreshable(): boolean {
    return this.getOpenedAccess() !== null || this.getBusyAccess() !== null;
  }

  private run(authenticate: boolean, reentry = false): Promise<void> {
    if (this.replaced) return Promise.resolve();
    this.remote?.dispose();
    this.remote = null;
    const generation = ++this.generation;
    this.guarded = reentry ? { generation, kind: "reentry" } : null;
    const task = this.execute(generation, authenticate).catch((error: unknown) => {
      if (!this.current(generation)) return;
      const guard = this.guarded?.generation === generation ? this.guarded.kind : null;
      if (guard && this.reentryUnsent(error)) {
        // Nothing of the document reached L2 (a held open, or auth/register failed by transport, a pause or an unreadable
        // reply): no working document, no open attempt. C163: the expired screen and its button by the gate. В4-Б: the
        // profile button again (it reads the profile anew; the same first open may follow, no other ID is made).
        this.session = null;
        if (guard === "profile") { this.profileRefresh = true; this.emit(this.unavailableState()); }
        else this.emit(this.expiredState());
        return;
      }
      // The first open of the profile route reached L2 and failed: its conflict proves nothing any more (route В follows).
      if (guard === "profile") { this.conflictedAccessVersion = null; this.conflictedProfileId = null; }
      this.fail(error);
    }).finally(() => {
      if (this.guarded?.generation === generation) this.guarded = null;
      if (this.running === task) this.running = null;
    });
    this.running = task;
    return task;
  }

  /**
   * The re-entry ended before its open of the new document reached L2 (ReentryHeld, or any failure of auth/register but a
   * refusal of the sign-in or of the access). 401 and 403 keep their own states (fail: expired, the stop of §4.13).
   */
  private reentryUnsent(error: unknown): boolean {
    if (this.documentId !== null && this.gate.openAttempted(this.documentId)) return false;
    if (error instanceof ReentryHeld) return true;
    return !(error instanceof EntryApiError && error.kind === "http" && (error.status === 401 || error.status === 403));
  }

  /**
   * 401: the state of a new sign-in (P03 §4.6; pending stay). With signed initData the core has not refused yet (Н4: after
   * a 401 to auth itself, no retry with the same data) the page offers the re-entry of C163/AC-104; its button follows
   * the rule of the button (§4.1, C335): visible, active by mayWrite, else the wait of §4.8.
   */
  private expiredState(): EntryState {
    if (!this.options.initData || this.initDataRefused || this.gate.snapshot().closedWindow) return { kind: "expired" };
    const checkable = this.gate.mayWrite();
    const wait = checkable ? null : gateWait(this.gate, { pending: this.gate.hasUnsettledPending() });
    return { kind: "expired", reentry: true, ...(checkable ? { checkable: true as const } : {}), ...(wait ? { wait } : {}) };
  }

  private fail(error: unknown): void {
    if (error instanceof EntryApiError && error.kind === "http" && error.status === 409 && error.code === "DOCUMENT_STALE") {
      // Only an open of this same document answers so: a newer window of the installation took it over.
      this.replace();
      return;
    }
    if (pausedBeforeSend(error) && (error.reason === "closed_window" || error.reason === "cancelled")) return;
    this.recovery = "none";
    this.resetInvalidSession(error);
    if (deletedBy(error)) { this.emit({ kind: "profile_deleted" }); return; }
    if (expiredBy(error)) { this.emit(this.expiredState()); return; }
    // К-9: a window without a working document met a planned pause (on open, auth or register) or a gate that kept its
    // open on the client: a wait screen without a button until ready and the end of the hold, then К-7 — no open.
    if (this.gate.snapshot().lastWorkingDoc === null
      && (maintenance(error) || pausedBeforeSend(error) && error.reason === "paused")) {
      this.emit(this.unavailableState({ waiting: true }));
      this.waitingWrite = true;
      return;
    }
    this.emit(this.unavailableState());
  }

  /** В4-Б: the page has never handed an open to L2 and has no document (P03 п.8б (1): the first open of the page). */
  private firstOpenOfPage(): boolean {
    const gate = this.gate.snapshot();
    return !this.closed && !this.replaced && !this.disposed && !gate.closedWindow && this.gate.gateDoc() === null
      && gate.lastWorkingDoc === null && gate.openAttempts.length === 0
      && (this.documentId === null || !this.gate.openAttempted(this.documentId));
  }

  /**
   * The route of the `unavailable` button by the facts of the gate (§4.13): А — a last working document; Б — none, but
   * another installation's occupancy is known; В — neither: blocked until Я19.
   */
  private route(): "document" | "own" | "profile" | "blocked" {
    if (this.gate.snapshot().lastWorkingDoc !== null) return "document";
    if (this.foreignBusyKnown) return "own";
    // A reapply refused with 409 VERSION_CONFLICT (fix1, C373): the button reads the current profile again by its own
    // contract — one sign-in (an L2 exception), no old command ID and no open of a document from this window.
    return this.profileRefresh ? "profile" : "blocked";
  }

  private failureState(error: unknown): EntryState {
    if (deletedBy(error)) return { kind: "profile_deleted" };
    return expiredBy(error) ? this.expiredState() : this.unavailableState();
  }

  private unavailableState(options: { waiting?: true } = {}): EntryState {
    const pending = this.gate.hasUnsettledPending();
    if (options.waiting) {
      const wait = gateWait(this.gate, { pending });
      return { kind: "unavailable", waiting: true, ...(wait ? { wait } : {}) };
    }
    const route = this.route();
    const checkable = route === "profile" ? !this.gate.snapshot().closedWindow && this.gate.mayWrite()
      : route !== "blocked" && this.session !== null && this.gate.checkButtonActive();
    const wait = route !== "blocked" && !checkable ? gateWait(this.gate, { pending }) : null;
    // Route В is the plain unavailable state: its button is visible and blocked until Я19 (EntryScreen).
    return { kind: "unavailable", ...(route === "blocked" ? {} : { route }), ...(checkable ? { checkable: true as const } : {}),
      ...(wait ? { wait } : {}) };
  }

  // ---- К-11 / К-9а of the working window (the row M-P03-10) ----

  /**
   * ВР-1 (transport) / К-9а (503 MAINTENANCE) on the foreground of the working window: the identity lock of its
   * document (Z1), the opened state and its screen stay, writes are shut by the gate; the gate's ready brings one
   * foreground of the same document (ВР-5), a show one at once (ВР-4).
   */
  private enterRecovery(): void {
    const doc = this.gate.snapshot().lastWorkingDoc;
    if (!doc || this.closed || this.replaced) return;
    this.gate.lockIdentity(doc);
    this.recovery = "recovering";
    this.emit(this.openedState(), this.session?.profile);
  }

  /** One recovery foreground of the same document, never `event="open"`, without marker or capture (ВР-4, ВР-5). */
  private sendRecovery(origin: RequestOrigin): Promise<void> {
    if (this.recoveryTask) return this.recoveryTask;
    const session = this.session;
    if (!session || this.closed || this.replaced || this.disposed) return Promise.resolve();
    if (this.running) {
      // A task of this window still settles (the foreground that just failed): ask once it has finished.
      return this.running.then(() => {
        if (this.recovery !== "none" && !this.recoveryTask && !this.hidden) return this.sendRecovery(origin);
      });
    }
    const generation = this.generation;
    this.recovery = "verifying";
    this.gate.recoveryForegroundSent();
    this.emit(this.openedState(), session.profile);
    const task = this.open(session.access_token, generation, "foreground", origin, undefined, true)
      .catch((error: unknown) => { if (this.current(generation)) this.recoveryFailed(error); })
      .finally(() => {
        this.gate.recoveryForegroundSettled();
        if (this.recoveryTask === task) this.recoveryTask = null;
        if (this.running === task) { this.running = null; this.foregroundRunning = false; }
        this.refreshShownState();
      });
    this.recoveryTask = task;
    this.running = task;
    this.foregroundRunning = true;
    return task;
  }

  /** The answer of a recovery foreground that was no confirmed identity (ВР-7…ВР-10а). */
  private recoveryFailed(error: unknown): void {
    if (error instanceof IdentityRefused) { this.closeFor(error.reason); return; }
    // A decoder that refused a 2xx (or a malformed opened) is a failed identity check (ВР-8), never a transport.
    if (!transportFailure(error) && (error instanceof EntryApiError && error.kind === "invalid_response"
      || !(error instanceof EntryApiError) && !pausedBeforeSend(error))) { this.closeFor("identity"); return; }
    if (pausedBeforeSend(error)) return; // the window closed or the page went away meanwhile
    // ВР-9 (transport again: the same episode, the gate's observer closed net) and ВР-10 (503 MAINTENANCE).
    if (transportFailure(error) || maintenance(error)) {
      this.recovery = "recovering";
      this.emit(this.openedState(), this.session?.profile);
      return;
    }
    // 409 DOCUMENT_STALE (ВР-7), 401/403 (ВР-10а), another 4xx → unavailable with the manual check (§4.13 А).
    this.fail(error);
  }

  /** ВР-8 / ВР-8б: the window closes for good (Z5′, §4.12); nothing of it is sent again. */
  private closeFor(reason: "identity" | "busy"): void {
    if (this.disposed || this.replaced || this.closed) return;
    this.closed = true;
    this.recovery = "none";
    this.generation += 1;
    this.gate.closeWindow();
    this.releaseLock();
    this.remote?.dispose();
    this.remote = null;
    this.emit({ kind: "closed", reason }, this.session?.profile);
    this.options.closeWindow?.();
  }

  /** The opened state with its recovery flag and the wait of §4.8 (M-P03-9). */
  private openedState(): EntryState {
    const locked = this.gate.identityLocked();
    const pending = this.gate.hasUnsettledPending();
    // fix1 (§4.8:475–480, AC-16): whatever keeps writes shut — a pause, an announced hold, the server unreachable — the
    // window names it over every visible screen (quiz, starts, manual screens), not only during the recovery.
    if (this.recovery === "none" && !locked) {
      const held = gateWait(this.gate, { pending });
      return held ? { kind: "opened", wait: held } : { kind: "opened" };
    }
    const wait = gateWait(this.gate, { pending }) ?? { cause: "offline" as const };
    const checking = this.recovery === "none" && pending && this.gate.snapshot().identityLock?.phase === "readback";
    return { kind: "opened", ...(this.recovery === "none" ? {} : { recovery: this.recovery }), wait,
      ...(checking ? { checking: true as const } : {}) };
  }

  /** The gate changed: ready brings the recovery foreground (ВР-5); К-9 leaves its wait; shown states follow the gate. */
  private onGate(event: GateEvent): void {
    if (this.disposed || this.closed || this.replaced) return;
    for (const wake of [...this.waiters]) wake();
    if (event.type === "ready" && this.recovery !== "none" && !this.hidden && !this.recoveryTask) {
      void this.sendRecovery("auto");
      return;
    }
    // ВР-12: a transport failure while the round was read sent the lock back from readback to verifying (Z3): the
    // window waits for the next ready (or a show) and its one foreground.
    const phase = this.gate.snapshot().identityLock?.phase ?? null;
    const interrupted = this.lockPhase === "readback" && phase === "verifying";
    this.lockPhase = phase;
    if (interrupted && this.recovery === "none" && this.state.kind === "opened") this.recovery = "recovering";
    if (this.waitingWrite && this.gate.mayWrite()) {
      this.waitingWrite = false;
      this.emit(this.unavailableState());
      return;
    }
    this.refreshShownState();
  }

  /** Resolves when the window is visible (at once if it is); false if this run ended meanwhile. */
  private async waitVisible(generation: number): Promise<boolean> {
    while (this.hidden && this.current(generation)) {
      await new Promise<void>(resolve => {
        const wake = () => { this.waiters.delete(wake); resolve(); };
        this.waiters.add(wake);
      });
    }
    return this.current(generation);
  }

  /** Re-emits a shown state whose gate-made parts changed (the wait line, the activity of a button). */
  private refreshShownState(): void {
    if (this.disposed || this.closed || this.replaced) return;
    const current = this.state;
    let next: EntryState | null = null;
    if (current.kind === "opened") next = this.openedState();
    else if (current.kind === "unavailable") next = this.unavailableState(current.waiting ? { waiting: true } : {});
    else if (current.kind === "expired" && current.reentry) next = this.expiredState();
    else if (current.kind === "rejected" && !current.closed) next = this.rejectedState(current);
    if (next && JSON.stringify(next) !== JSON.stringify(current)) this.emit(next, this.session?.profile);
  }

  /** К13 under the button rule: the reapply waits for mayWrite of its ID, visible and inactive meanwhile (§4.1, C335). */
  private rejectedState(state: Extract<EntryState, { kind: "rejected" }>): EntryState {
    const { blocked: _blocked, wait: _wait, ...base } = state;
    if (base.closed) return base;
    const id = this.reapplyIntent?.commandId;
    if (this.gate.mayWrite(id)) return base;
    const wait = gateWait(this.gate);
    return { ...base, blocked: true, ...(wait ? { wait } : {}) };
  }

  /**
   * Resolves once the gate lets a write go in a visible window (and a fresh probe agrees, R-12); false if this run ended
   * meanwhile. A hidden window sends nothing (N3, ВР-3): the end of a hold or a late ready while hidden waits for the show.
   */
  private async waitWritable(generation: number): Promise<boolean> {
    while (this.current(generation)) {
      if (!this.hidden && this.gate.mayWrite()) {
        if (await this.gate.ensureFresh() && !this.hidden) return this.current(generation);
        continue;
      }
      this.emit(this.unavailableState({ waiting: true }));
      await new Promise<void>(resolve => {
        const wake = () => { this.waiters.delete(wake); resolve(); };
        this.waiters.add(wake);
      });
    }
    return false;
  }

  /**
   * A request of this window got DOCUMENT_STALE: the shared transport reports it before the module reads the reply.
   * The core gives that answer to a replaced document, but also to a closed card context of the live one, so a
   * foreground of this same document decides. It asks one task later, on purpose: the module handles its refusal
   * first. That refusal refuses this attempt, not the action: the module keeps its saved action in the storage that the
   * installation's windows share for a live window to check (C091 §1, Р2). What a newer window shows for that action
   * is the open question В-1; whether it may send it is В-2 (commandRefusal.ts).
   */
  documentStale(source?: DocumentStaleSource): void {
    if (this.disposed || this.replaced || this.closed) return;
    // The DOCUMENT_STALE junction P02↔P03: an answer that proves the replacement of this very document closes it now —
    // synchronously, before the module reads the refusal, so nothing more of the old document is sent (ВР-7, Z5′).
    if (source && this.replacementProved(source)) { this.replace(); return; }
    // A request of another document (a late answer after this window opened a new one) says nothing about this one.
    if (source?.documentId != null && source.documentId !== this.documentId) return;
    this.staleHint = true;
    if (this.checking) return; // The running check answers this refusal too.
    // Synchronously: the module reads the refusal after this returns and must not be seen showing it (2.33).
    this.setChecking(true);
    setTimeout(() => {
      void (this.staleHint ? this.foreground() : Promise.resolve()).finally(() => this.setChecking(false));
    }, 0);
  }

  /**
   * A 409 DOCUMENT_STALE proves that this window's own current document was replaced only when (1) the core gives that
   * code for that command solely when the installation's live document is another one — POST settings.reset (core
   * settings/reset.py:402 → identity/origin.py require_live_document: document_id ≠ live), unlike a card context, which
   * gets it for a closed context of the live document too (study/card_contexts.py:30–48); (2) the core's envelope names
   * that very command as rejected; (3) the request was sent for the document this window has now: same document, same
   * profile, no `opened` confirmed since (DocMark), and the window is still the one that sent it.
   */
  private replacementProved(source: DocumentStaleSource): boolean {
    const mark = source.mark, doc = mark?.doc ?? null;
    return source.method === "POST" && source.route === "/commands" && source.kind !== null
      && REPLACEMENT_PROOF_KINDS.has(source.kind) && source.attributed
      && mark !== null && doc !== null && this.gate.markCurrent(mark)
      && source.documentId !== null && source.documentId === doc.documentId && source.documentId === this.documentId
      && this.session !== null && doc.profileId === this.session.profile.profile_id;
  }

  private setChecking(checking: boolean): void {
    if (this.checking === checking) return;
    this.checking = checking;
    if (!this.disposed) this.options.onDocumentCheck?.(checking);
  }

  /** A newer window of this installation took the document over (decision 2.3). Terminal for this window. */
  private replace(): void {
    if (this.disposed || this.replaced || this.closed) return;
    this.replaced = true;
    this.recovery = "none";
    this.generation += 1; // A late reply of this document must not reopen or relabel anything.
    // ВР-7 is a closure of the window (Z5′): from now on the gate refuses every request of this page (§4.12).
    this.gate.closeWindow();
    this.releaseLock();
    this.remote?.dispose();
    this.remote = null;
    this.emit({ kind: "replaced" }, this.session?.profile);
    this.options.closeWindow?.();
  }

  private releaseLock(): void {
    this.claim = null;
    this.lease?.release();
    this.lease = null;
  }

  /**
   * The lock is no permission to open (the new window never waits for it): it only lets an older window of this
   * installation learn at once that its document was replaced. Taken after the server accepted this document.
   */
  private claimLock(key: string): void {
    if (this.lease || this.claim) return;
    const claim = {};
    this.claim = claim;
    let lease: DocumentLease | null = null;
    void this.options.lock.acquire(key, () => {
      if (lease !== null && this.lease === lease) this.replace();
    }).then((result) => {
      if (typeof result !== "object") return;
      if (this.claim !== claim) { result.release(); return; }
      lease = result;
      this.lease = result;
    }, () => undefined).finally(() => {
      if (this.claim === claim) this.claim = null;
    });
  }

  /**
   * C163 шаг 5: the rights of document A end at once (Z5, like any 403: session, document, locks and tickets go); its
   * pending records stay in the storage with their IDs, intents, origins and targets. The window shows the re-entry at once
   * (the expired screen and its button by the rule of the button); nothing is sent until the explicit click.
   */
  private enterInstallationRecovery(): void {
    const installation = this.installation;
    const profileId = this.session?.profile.profile_id ?? null;
    this.installationRecovery = { a: installation ? { ...installation } : null, b: null };
    this.resetInvalidSession(new EntryApiError("http", 403, "FORBIDDEN"));
    this.reentryProfileId = profileId;
    this.emit(this.expiredState());
  }

  /**
   * C163 шаг 5: the installation of the re-entry after a refused proof. Never A's record (CON:200: a new authorization
   * makes NEW client_instance_id/registration_id) and never another window's record from the shared storage: the stored
   * record must be A's as this page knew it, this page's own B, or none; anything else (A with a newer proof — another
   * window of A registered again —, a foreign B) stops. B with a proof continues; B without one is replaced by a new B
   * (its registration belonged to the earlier sign-in).
   */
  private async prepareInstallationB(profileId: string, generation: number): Promise<boolean> {
    const recovery = this.installationRecovery!;
    if (recovery.a === null) return false;
    const expectedA = recovery.a;
    const ids = { clientInstanceId: this.options.newId(), registrationId: this.options.newId() };
    // C163 шаг 6: one atomic mutation over the ACTUAL record (writer 2, decideB): exactly A as this page knew it, this
    // page's own B, or none; a fresher A or another window's B is "foreign" — nothing written, no register/open.
    const before = this.installation;
    const outcome = await this.store.mutate(profileId, () => this.current(generation),
      current => decideB(current, profileId, expectedA, recovery.b, ids));
    // The write may have happened; a context that ended meanwhile still sends nothing (installationStore.ts contract).
    const record = this.settleInstallationWrite(outcome, generation, before);
    if (!record) return false;
    recovery.b = record;
    this.installation = record;
    return true;
  }

  /**
   * C163 шаг 6 — the outcome mapping of a store mutation (C414, prototype; not yet accepted): only "applied" or "current"
   * of a context still live gives a record to go on with. A write that happened for a context that ended ("applied"
   * after it, or the store's "late") is not acted on and not rolled back — this page only forgets its memory of the
   * record, so the next run reads the actual one. "conflict" (incl. "invalid", fail-closed), "cancelled", "unsupported",
   * "failed", "unknown" — no record: no register, no open; "unknown" is never read as «no record» or as a reason for a
   * new A.
   */
  private settleInstallationWrite(outcome: { kind: string }, generation: number, before: StoredInstallation | null): StoredInstallation | null {
    // K2 (store canon §4, ред.1.2): the store may answer applied/current to a context that has ended — Entry checks it
    // after the await for EVERY outcome. late, or applied/current of an ended context: act on nothing, roll nothing back,
    // forget the memory of the record — unless a newer run of this page already set its own meanwhile.
    // Store §6 «после восстановления store»: the store answered again — a known deleted profile is cleaned once more.
    if (outcome.kind === "applied" || outcome.kind === "current" || outcome.kind === "late") void this.deletedProfiles.retry();
    if (!this.current(generation) || outcome.kind === "late") {
      if (this.installation === before) this.installation = null;
      return null;
    }
    // conflict (incl. invalid: fail-closed), cancelled, failed, unknown, unavailable, unsupported: no record — no
    // register, no open. unavailable is never current(null) and never a reason to read the legacy record.
    return outcome.kind === "applied" || outcome.kind === "current" ? (outcome as unknown as { result: StoredInstallation }).result : null;
  }

  private resetInvalidSession(error: unknown): void {
    if (!(error instanceof EntryApiError) || error.kind !== "http"
      || (error.status !== 401 && error.status !== 403)) return;
    // P3-5: the re-entry after this 401 continues only for the same profile (reentryProfileId, execute).
    if (error.status === 401 && this.session) this.reentryProfileId = this.session.profile.profile_id;
    // The sign-in ended (401): the journal waits for the next one. A lost admission or a deleted profile (403) ends it
    // and clears its buffer (P04 r9 §3.8); another 403 (a refused proof) only stops its sending.
    if (error.status === 403 && (error.code === "PROFILE_DELETED" || error.code === "ACCESS_PENDING" || error.code === "ACCESS_REJECTED")) {
      journalAccess.revoke(true);
      // CON §7.3 п.2, P04 §8: after PROFILE_DELETED (also on another device) the local records of X go too.
      const deleted = this.session?.profile.profile_id;
      // Store §6: forget in IndexedDB first, then localStorage; repeated while this page knows X is deleted.
      if (error.code === "PROFILE_DELETED" && deleted) void this.deletedProfiles.note(deleted);
    } else {
      journalAccess.credentials(null);
      if (error.status === 401) journalAccess.revoke(false);
    }
    this.session = null;
    this.installation = null;
    this.documentId = null;
    this.staleHint = false;
    this.proofIssuedThisSession = false;
    this.remote?.dispose();
    this.remote = null;
    this.observedStateVersion = null;
    this.foreignBusyKnown = false;
    this.remoteContext = null;
    this.reopenOnShow = null;
    this.recovery = "none";
    this.releaseLock();
    // Z5: the document changed without a closure — its locks, registrations, tickets and R10 context go.
    this.gate.resetDocument();
  }

  private async execute(generation: number, authenticate: boolean): Promise<void> {
    this.emit({ kind: "checking" });
    if (authenticate) {
      if (!this.options.initData) { this.emit(this.unavailableState()); return; }
      let response: AuthResponse;
      try {
        response = await this.options.api.auth({
          init_data: this.options.initData,
          client_version: this.options.clientVersion,
          contract_version: this.options.contractVersion,
          saved_language: this.options.savedLanguage,
          browser_language: this.options.browserLanguage,
        });
      } catch (error) {
        // Н4: a definite refusal of auth itself by the core — 401 AUTH_EXPIRED/AUTH_INVALID (initData older than max_age or
        // invalid), or another coded 4xx but 403/429 (P3-2: 422 and the like) — means these signed data cannot sign in
        // again. A bare 401 without the core's code (P3-1), a 429, transport or a pause refuse nothing of the data.
        if (error instanceof EntryApiError && error.kind === "http" && error.code !== undefined && error.status !== undefined
          && error.status >= 400 && error.status < 500 && error.status !== 403 && error.status !== 429) this.initDataRefused = true;
        throw error;
      }
      if (!this.current(generation)) return;
      this.session = response;
    }
    const session = this.session;
    if (!session) { this.emit(this.unavailableState()); return; }
    // An incompatible client may read why (CT §1), so this is its own state, not "unavailable" (К10-060).
    if (!session.compatibility.compatible) {
      // Only an admitted profile has a journal (P1-2); it keeps the update screen until a compatible build sends it.
      if (session.profile.access.status === "admitted") {
        journalAccess.admit(session.profile.profile_id);
        journalRecord({ ev: "c.screen", kind: "update_required", code: "CLIENT_INCOMPATIBLE" });
      } else journalAccess.revoke(true);
      this.emit({ kind: "incompatible" }, session.profile);
      return;
    }
    const profile = session.profile;
    // P3-5: a re-entry that signed in as another profile than the one whose session ended stops here (no screen, no open).
    if (this.guarded?.generation === generation && this.guarded.kind === "reentry" && this.reentryProfileId !== null
      && profile.profile_id !== this.reentryProfileId) {
      this.session = null;
      this.emit(this.unavailableState());
      return;
    }
    // The client journal exists only for an admitted profile: a pending or rejected one has none, and any other
    // profile's buffer is dropped (events TZ §4.5; P04 r9 §2.7).
    if (profile.access.status === "admitted") journalAccess.admit(profile.profile_id);
    else journalAccess.revoke(true);
    if (!this.acceptProfile(profile)) throw new EntryApiError("invalid_response");
    // В4 (C390): after a VERSION_CONFLICT the refreshed profile is the conflicted one's and newer than the access version
    // the refused reapply expected — for every status, not only rejected; else it proves nothing current.
    if (this.conflictedAccessVersion && (profile.profile_id !== (this.conflictedProfileId ?? profile.profile_id)
      || !newerVersion(profile.access.version, this.conflictedAccessVersion))) {
      this.session = null;
      this.emit(this.unavailableState());
      return;
    }
    if (profile.access.status === "pending") {
      await this.dropSettledReapplyIntent(profile.profile_id);
      if (!this.current(generation)) return;
      this.emit({ kind: "pending" }, profile);
      return;
    }
    if (profile.access.status === "rejected") {
      this.reapplyIntent ??= await readReapplyIntent(this.options.storage, profile.profile_id);
      if (!this.current(generation)) return;
      if (this.conflictedIntentId) {
        if (this.reapplyIntent && this.reapplyIntent.commandId !== this.conflictedIntentId) {
          throw new Error("Conflicting pending action");
        }
        if (this.reapplyIntent) await clearReapplyIntent(this.options.storage, profile.profile_id);
        if (!this.current(generation)) return;
        this.conflictedIntentId = null;
        this.reapplyIntent = null;
      }
      if (this.conflictedAccessVersion) {
        if (!newerVersion(profile.access.version, this.conflictedAccessVersion)) {
          this.session = null;
          this.emit(this.unavailableState());
          return;
        }
        this.conflictedAccessVersion = null;
        this.conflictedProfileId = null;
      }
      this.emit(this.rejected(profile), profile);
      return;
    }
    // The profile refresh after a VERSION_CONFLICT (route «profile», C373): no old reapply ID, no side open. В4-Б (C390): an
    // admitted current profile continues the page's ORIGINAL entry only while that is truly its first open — no document
    // of reference, no working document, no L2 attempt of any open on this page; its open is guarded (visible ∧ mayWrite
    // right before L2). Otherwise the profile screen stays (a named remainder), nothing opens.
    if (this.profileOnly) {
      this.profileOnly = false;
      // P2-2 (pre-QA C163): only a proven 409 VERSION_CONFLICT (its strict actuality was checked above) continues the first
      // entry. Every other reason of route «profile» — a committed reapply whose later step failed (ACCESS_* 403 on
      // register/open, a cleanup failure), an unreadable reply — keeps the old stop: the profile, no open (C390 В3).
      const conflicted = this.conflictedAccessVersion !== null && this.conflictedProfileId !== null;
      if (!conflicted || !this.firstOpenOfPage()) {
        // P3 (pre-QA 3b): no first open is possible by this route any more — its button stops honestly (route В, blocked)
        // instead of reading the profile again and again; the proof of a conflict is void here.
        this.profileRefresh = false;
        this.conflictedAccessVersion = null;
        this.conflictedProfileId = null;
        this.emit(this.unavailableState());
        return;
      }
      // The conflict marks stay until the first open has been answered: a click held before L2 may come again.
      this.guarded = { generation, kind: "profile" };
    }
    this.emit({ kind: "opening" }, profile);
    if (this.installationRecovery !== null && this.guarded?.generation === generation && this.guarded.kind === "reentry") {
      // C163 шаг 5: the fresh same profile is admitted — B, never A (prepareInstallationB); a record it may not take stops.
      if (!await this.prepareInstallationB(profile.profile_id, generation)) {
        if (!this.current(generation)) return;
        this.session = null;
        this.emit(this.unavailableState());
        return;
      }
    } else if (!await this.prepareInstallation(profile.profile_id, generation)) {
      // C163 шаг 6: an invalid record (fail-closed: never a new A over it), a conflict or no safe store — no register/open.
      if (!this.current(generation)) return;
      this.emit(this.unavailableState());
      return;
    }
    if (!this.current(generation)) return;
    if (!this.installation) throw new Error("Missing installation");
    if (!this.installation.proof) await this.register(session.access_token, generation);
    if (!this.current(generation)) return;
    // T28s (§4.10, R1): a page closed by the outage mark does not hand its first open to L2 before mayWrite (ready, the
    // hold end, a fresh probe): it waits without a button; no PAUSED_BEFORE_SEND, nothing in openAttempts meanwhile.
    if (this.guarded?.generation !== generation && this.gate.outageAtStart && !this.gate.openAttempted(this.documentId ?? "")) {
      if (!await this.waitWritable(generation)) return;
      this.emit({ kind: "opening" }, profile);
    }
    let stamp: RequestStamp | null = null;
    try {
      await this.open(session.access_token, generation, "open", this.guarded?.generation === generation ? "user" : "auto",
        issued => { stamp = issued; });
    } catch (error) {
      if (!(error instanceof EntryApiError) || error.kind !== "http" || error.status !== 403
        || this.installation?.activated || !this.proofIssuedThisSession || !this.current(generation)
        // C163 шаг 5: a refusal of B's first open ends the recovery — no repeat, no cycle.
        || (this.installationRecovery?.b ?? null) !== null
          && this.installationRecovery!.b!.clientInstanceId === this.installation?.clientInstanceId) throw error;
      // A late registration may have replaced a proof before this open reached the server. Only a definite 403
      // FORBIDDEN of the core (given before any change, clients.py:237–239) allows one repeat of the same document's
      // open (п.8б (5)): the gate takes the stamp of that very request; any other 403 ends here (ВР-10а).
      if (error.code !== "FORBIDDEN" || !stamp || !this.gate.noteForbiddenBeforeChange(stamp)) throw error;
      try {
        await this.register(session.access_token, generation);
      } catch (registerError) {
        this.gate.dropRetryAfter403();
        throw registerError;
      }
      if (!this.current(generation)) { this.gate.dropRetryAfter403(); return; }
      await this.open(session.access_token, generation);
    }
    // В4-Б: the first open of the profile route was answered; its conflict proves nothing for any later run.
    if (this.guarded?.generation === generation && this.guarded.kind === "profile") {
      this.conflictedAccessVersion = null;
      this.conflictedProfileId = null;
    }
  }

  /** The refusal screen of a rejected profile; closed once no reapplication is left (CT §6.3). */
  private rejected(profile: Profile): EntryState {
    // An older core sends no reapply_closed: it reads as open, and its 403 to the reapply closes it below.
    const closed = profile.reapply_closed === true || this.reapplyClosedFor === profile.profile_id;
    const reason = profile.access.reason ?? undefined;
    return closed ? { kind: "rejected", reason, closed: true } : this.rejectedState({ kind: "rejected", reason });
  }

  /** Pending access means any earlier reapply was settled: its saved ID must not be resent later. */
  private async dropSettledReapplyIntent(profileId: string): Promise<void> {
    this.reapplyRegistry.settled("recorded");
    this.reapplyRegistry.release();
    this.reapplyIntent = null;
    try {
      await clearReapplyIntent(this.options.storage, profileId);
    } catch {
      // reapply() also refuses an intent saved for another access version, so a failed cleanup
      // must not hide the confirmed pending state.
    }
  }

  /**
   * Writer 1 (C163 шаг 6, decideA): the record of the ordinary entry, decided on the ACTUAL record under the store's
   * lock — a record with a proof is reused, none or one without a proof (an earlier sign-in's registration) is replaced by
   * new IDs. An invalid record is fail-closed (no new A over it). Without a safe store ("unsupported") only a valid,
   * activated record with a proof may be used by a plain read — it needs no write before open; anything else stops.
   */
  private async prepareInstallation(profileId: string, generation: number): Promise<boolean> {
    if (this.installation?.profileId === profileId) return true;
    const ids = { clientInstanceId: this.options.newId(), registrationId: this.options.newId() };
    const before = this.installation;
    const outcome = await this.store.mutate(profileId, () => this.current(generation), current => decideA(current, profileId, ids));
    let record = this.settleInstallationWrite(outcome, generation, before);
    if (!this.current(generation)) return false;
    // §5 (store canon, C423 п.1): ONLY when the IndexedDB API is reliably absent ("unsupported" no-indexeddb) — one strict
    // read-only legacy read of this profile; a valid activated A with a proof and its version opens by the existing open
    // with no installation write and no register (open() skips the activated write, register needs no proof). Never for
    // unavailable/failed/unknown/invalid; never a write, an import or a mirror; anything else → no open.
    if (!record && outcome.kind === "unsupported" && (outcome as { reason?: string }).reason === "no-indexeddb"
      && "readLegacy" in this.store) {
      const legacy = await (this.store as IdbInstallationStore).readLegacy(profileId);
      if (!this.current(generation)) return false;
      if (legacy.kind === "found" && legacy.openable && legacy.record.profileId === profileId && legacy.record.activated
        && legacy.record.proof && legacy.record.proofVersion) record = legacy.record;
    }
    if (!record) return false;
    this.installation = record;
    return true;
  }

  private async register(token: string, generation: number): Promise<void> {
    const installation = this.installation;
    if (!installation) throw new Error("Missing installation");
    const response: RegisterResponse = await this.options.api.register(token, {
      client_instance_id: installation.clientInstanceId,
      registration_id: installation.registrationId,
    });
    if (!this.current(generation)) return;
    if (response.client_instance_id !== installation.clientInstanceId) throw new Error("Wrong installation");
    if (response.status === "already_registered") {
      if (!installation.proof) throw new Error("Proof unavailable");
      return;
    }
    if (!response.origin_proof || response.activated) throw new Error("Invalid registration");
    // Writer 3 (C163 шаг 6, decideRegister): the reply belongs only to the IDs that were sent; the highest version is read
    // from the ACTUAL record; activated is never lowered; a late reply never replaces another record (late A after B).
    const sent = { profileId: installation.profileId, clientInstanceId: installation.clientInstanceId, registrationId: installation.registrationId };
    const reply = { proof: response.origin_proof, proofVersion: response.proof_version };
    const before = this.installation;
    const outcome = await this.store.mutate(installation.profileId, () => this.current(generation),
      current => decideRegister(current, sent, reply));
    const record = this.settleInstallationWrite(outcome, generation, before);
    if (!this.current(generation)) return;
    if (!record) throw new Error("Installation not stored"); // conflict / no safe store / failed / unknown: no open follows
    this.installation = record;
    // 6b (P2-6A): this page's own B is known by its full record from now on (its proof included).
    const recovery = this.installationRecovery;
    if (recovery?.b && recovery.b.clientInstanceId === record.clientInstanceId && recovery.b.registrationId === record.registrationId) {
      recovery.b = record;
    }
    if (record.proof === reply.proof) this.proofIssuedThisSession = true;
  }

  /**
   * One POST /client/open of this window's document. verify: the recovery foreground of the working window (ВР-4, ВР-5)
   * or the manual check of its last working document (§4.13 А) — every field of the identity must match the last
   * confirmed `opened` (ВР-6), else the window closes (ВР-8, ВР-8б). origin and onStamp go to the transport (L2, §2 п.3).
   */
  private async open(token: string, generation: number, event: "open" | "foreground" = "open", origin: RequestOrigin = "auto",
    onStamp?: (stamp: RequestStamp) => void, verify = false, returnOfWorking = false, p01: P01Episode | null = null): Promise<void> {
    if (this.replaced || this.closed) return;
    const installation = this.installation;
    if (!installation?.proof || !installation.proofVersion) throw new Error("Proof unavailable");
    const timeZone = this.options.timeZone();
    if (!timeZone) throw new Error("Time zone unavailable");
    this.documentId ??= this.options.newId();
    const refused = this.refusedTarget;
    this.refusedTarget = null;
    if (this.options.remote && !verify && (!await this.prepareRemote(token, generation) || !this.current(generation))) return;
    // After DOCUMENT_STALE an open of this document would make it live again, taking it from the newer window
    // (question 2.30 is open). Only a foreground may ask until an answer confirms the document.
    if (this.staleHint) event = "foreground";
    // C163 re-entry: its open goes to L2 only from a visible window whose gate lets it go — the same synchronous stretch as
    // admit (no await from here to fetch); else nothing leaves and the expired screen comes back.
    if (event === "open" && this.guarded?.generation === generation && (this.hidden || !this.gate.mayWrite())) {
      this.gate.dropRetryAfter403(); // an allowance of п.8б (5) never outlives an open that did not go
      throw new ReentryHeld();
    }
    // A new document of this installation always becomes the live one (decision 2.3): no lock flag, no confirmation.
    const request: OpenRequest = {
      client_instance_id: installation.clientInstanceId,
      document_id: this.documentId,
      time_zone: timeZone,
      event,
      client_version: this.options.clientVersion,
      contract_version: this.options.contractVersion,
    };
    let stamp: RequestStamp | null = null;
    let opened: Awaited<ReturnType<EntryApi["open"]>>;
    try {
      opened = await this.options.api.open(token, installation.proof, request, {
        origin, stamped: issued => { stamp = issued; onStamp?.(issued); } });
    } catch (error) {
      // §2 п.2: a 4xx with the core's envelope is a definite answer of a real request — but never on the recovery
      // foreground, where only a confirmed opened ends an episode (ред.14, P2-3).
      if (!verify && stamp && error instanceof EntryApiError && error.kind === "http" && error.code
        && error.status !== undefined && error.status >= 400 && error.status < 500) this.gate.noteDefinite(stamp);
      throw error;
    }
    if (!this.current(generation)) return;
    if (opened.profile.access.status !== "admitted"
      || (this.observedStateVersion !== null && newerVersion(this.observedStateVersion, opened.profile.state_version))
      || !this.acceptProfile(opened.profile)) {
      if (verify) throw new IdentityRefused("identity");
      throw new EntryApiError("invalid_response", 200);
    }
    // The core answered for this admitted profile and its registered installation: the journal may send now.
    journalAccess.admit(opened.profile.profile_id);
    journalAccess.credentials({ token, proof: installation.proof, clientInstanceId: installation.clientInstanceId });
    const idbOk = journalAccess.idbOk();
    journalRecord({ ev: "c.app.open", kind: event, doc: this.documentId, ...(idbOk === null ? {} : { idb_ok: idbOk }) });
    if (opened.status === "incompatible" || !opened.compatibility.compatible) {
      journalRecord({ ev: "c.screen", kind: "update_required", code: "CLIENT_INCOMPATIBLE" });
      // The core neither made this document live nor activated the installation (В6): nothing is saved or locked here.
      if (opened.status === "incompatible" && opened.client_instance_id !== installation.clientInstanceId) {
        throw new Error("Invalid opened client");
      }
      this.emit({ kind: "incompatible" }, opened.profile);
      return;
    }
    // ВР-8б: SESSION_BUSY on the recovery foreground (or the manual check А) proves no identity (BusyClient has none):
    // fail-closed. N14 (P03:54, fix2/fix5 C388): the same answer to any ordinary foreground of a window with a working
    // document closes it too. Only the «На Сегодня» of a shown refused start that spent its П01 episode (TZA 12.1, В4)
    // keeps the busy Today with its confirmed stop: a refusal of a study command is no loss of the document's identity.
    if (opened.status === "SESSION_BUSY" && (verify || returnOfWorking)) throw new IdentityRefused("busy");
    this.staleHint = false; // The server answered for this document: it is still the live one.
    this.claimLock(`${opened.profile.profile_id}:${installation.clientInstanceId}`);
    if (opened.status === "SESSION_BUSY") {
      if (stamp) this.gate.noteDefinite(stamp);
      const { stop_remote_target: target } = opened.session;
      this.foreignBusyKnown = !!target;
      // R10 п.1: the narrow read context of the own stop_remote — never with a working document or a lock (AC-115).
      // fix3: a П01 episode of the working document gets the same narrow context through its own gate door (AC-115 stays
      // for every other busy of a working window).
      this.remoteContext = this.remote && target
        ? p01 && this.current(generation) ? this.gate.openP01ReadContext(p01) : this.gate.openRemoteReadContext() : null;
      const remote = this.remoteContext ? this.remote : null;
      remote?.setReadContext(this.remoteContext);
      if (remote && remote.snapshot().pending) {
        // R10: the loaded pending of the own stop is read now, by its narrow ticket; then the remote screen decides.
        this.remoteScreen = true;
        await remote.refresh();
        if (!this.current(generation) || this.remote !== remote) return;
        const phase = remote.snapshot().phase;
        if (phase === "settled") {
          // The stop is confirmed: the window opens by one foreground of its own document, never a new open (AC-106).
          remote.dispose();
          this.remote = null;
          this.remoteScreen = false;
          // N3 (C365): an answer that came while the window was hidden opens nothing before it is shown again.
          if (!await this.waitVisible(generation)) return;
          await this.open(token, generation, "foreground", origin);
          return;
        }
        if (phase !== "idle") return; // the remote screen of the unresolved stop (manual route)
      }
      if (this.remote && target && refused && refused !== target) {
        this.emit({ kind: "remote_confirm", targetId: target, changed: true }, opened.profile);
        return;
      }
      // The busy screen and its confirmed stop stay as before; only the narrow readback needs R10's context.
      this.emit({ kind: "busy", ...(this.remote && target ? { remoteTarget: target } : {}) }, opened.profile);
      return;
    }
    if (opened.client_instance_id !== installation.clientInstanceId || opened.document_id !== this.documentId
      || opened.proof_version !== installation.proofVersion) {
      if (verify) throw new IdentityRefused("identity");
      throw new Error("Invalid opened client");
    }
    const doc: GateDoc = { profileId: opened.profile.profile_id, documentId: opened.document_id, epoch: opened.document_epoch };
    const working = this.gate.snapshot().lastWorkingDoc;
    // ВР-8: the same document with another epoch or profile than the last confirmed one is no identity.
    if (verify && (!working || !sameGateDoc(working, doc))) throw new IdentityRefused("identity");
    // Writer 4 (C163 шаг 6, decideActivated): only the flag of the actual record of this installation; a fresher proof
    // there is kept, never rewritten from this snapshot.
    // An installation already activated needs no write (also where the store is "unsupported": C405 p.«unsupported», C410/C414).
    if (!installation.activated) {
      const before = this.installation;
      const outcome = await this.store.mutate(installation.profileId, () => this.current(generation),
        current => decideActivated(current, installation));
      const activated = this.settleInstallationWrite(outcome, generation, before);
      if (!this.current(generation)) return;
      // Not stored (no safe store, or the record is no longer this installation): as before, the open fails (no working
      // document from a record this page cannot keep).
      if (!activated) throw new Error("Installation not stored");
      this.installation = activated;
    }
    const access: OpenedAccess = createOpenedAccess({ opened, token, proof: installation.proof, generation,
      isLive: () => this.current(generation) && this.state.kind === "opened" && this.openedAccess === access,
      onDenied: error => {
        this.generation += 1; // A pending foreground reply must not restore revoked access.
        // C163 шаг 5: only the narrow candidate (commands/proofRefusal.ts), only once per page, leads to the re-entry
        // of a new installation; every other 401/403 keeps its own state.
        if (this.installationRecovery === null && proofRefusalCandidate(error, access.document)) {
          this.enterInstallationRecovery();
          return;
        }
        this.resetInvalidSession(error);
        this.emit(this.failureState(error));
      },
    });
    this.openedAccess = access;
    this.foreignBusyKnown = false;
    this.remoteScreen = false;
    this.recovery = "none";
    // The gate learns the confirmed document: ВР-6 (Z2) for a verified one — its round of readbacks starts — else
    // noteOpened (a first or a new document: Z5 for the old one). A definite answer ends an episode without pending.
    if (verify) this.gate.identityVerified(doc);
    else this.gate.noteOpened(doc);
    if (stamp) this.gate.noteDefinite(stamp);
    this.emit(this.openedState(), opened.profile);
    // An own stop_remote left from the busy branch is read in the ordinary context now (R1/R2): nothing is shown for it.
    if (this.remote?.snapshot().pending) void this.remote.refresh();
  }

  /**
   * R10 п.4: the own stop_remote pending is loaded and registered, never read here — the first open does not wait for
   * a GET (it could not go before a context exists). Its readback follows the answer: SESSION_BUSY gives R10's narrow
   * context, opened the ordinary one.
   */
  private async prepareRemote(token: string, generation: number): Promise<boolean> {
    const remoteOptions = this.options.remote;
    if (!remoteOptions) return true;
    const installation = this.installation;
    const documentId = this.documentId;
    if (!installation?.proof || !documentId) return false;
    if (this.remote?.snapshot().phase === "settled") { this.remote.dispose(); this.remote = null; }
    if (!this.remote) {
      const proof = installation.proof;
      const addressed = (intent: RemoteStopIntent) => ({ ...intent,
        client_instance_id: installation.clientInstanceId, document_id: documentId });
      const remote = new RemoteStopController({
        profileId: installation.profileId, clientInstanceId: installation.clientInstanceId,
        pendingStore: remoteOptions.pendingStore, newId: this.options.newId,
        send: intent => remoteOptions.api.stop(token, proof, addressed(intent)),
        check: (intent, ticket) => remoteOptions.api.status(token, proof, addressed(intent), ticket),
        gate: this.options.gate,
        onUpdate: snapshot => {
          if (!this.current(generation) || this.remote !== remote) return;
          if (snapshot.stateVersion) this.observeStateVersion(snapshot.stateVersion);
          if (!this.remoteScreen) return; // outside the busy branch a loaded pending shows nothing (R10 п.4)
          if (snapshot.pending || snapshot.phase === "blocked") {
            if (snapshot.problem === "expired" || snapshot.problem === "forbidden") {
              this.resetInvalidSession(new EntryApiError("http", snapshot.problem === "expired" ? 401 : 403));
              this.emit(snapshot.problem === "expired" ? this.expiredState() : { kind: "unavailable" });
              return;
            }
            this.emit({ kind: "remote", remote: snapshot }, this.session?.profile);
          }
        },
      });
      this.remote = remote;
    }
    const remote = this.remote;
    await remote.load();
    if (!this.current(generation) || this.remote !== remote) return false;
    if (remote.snapshot().phase === "settled") {
      remote.dispose();
      this.remote = null;
      return this.prepareRemote(token, generation);
    }
    if (remote.snapshot().phase === "blocked") {
      // The record cannot be read from the storage: the existing remote screen says so, nothing is sent.
      this.remoteScreen = true;
      this.emit({ kind: "remote", remote: remote.snapshot() }, this.session?.profile);
      return false;
    }
    return true;
  }

  requestRemoteStop(): void {
    if (this.state.kind !== "busy" || !this.state.remoteTarget) return;
    this.requestRemoteStopFor(this.state.remoteTarget);
  }

  /** `tapped` is the target the user saw when pressing the button: a refreshed answer may name another session. */
  private requestRemoteStopFor(tapped: string): void {
    if (this.running) {
      // The busy screen and its button stay visible while a refresh settles occupancy. Keep the tap,
      // as foreground() keeps an event during startup, and ask once the current task has finished.
      this.queuedRemoteRequest ??= this.running.then(() => {
        this.queuedRemoteRequest = null;
        this.requestRemoteStopFor(tapped);
      });
      return;
    }
    if (this.state.kind !== "busy" || !this.state.remoteTarget || !this.remote) return;
    // The tap was for another session: it is no confirmation for this one, so say so and ask separately.
    const changed = this.state.remoteTarget !== tapped;
    this.emit({ kind: "remote_confirm", targetId: this.state.remoteTarget, ...(changed ? { changed: true as const } : {}) },
      this.session?.profile);
  }

  /** The held foreground after a confirmed own stop, sent by the show (one, of the own document; AC-106, N3). */
  private remoteReopen(token: string, generation: number): Promise<void> {
    const task = this.open(token, generation, "foreground", "user").catch((error: unknown) => {
      if (this.current(generation)) this.fail(error);
    }).finally(() => { if (this.running === task) this.running = null; });
    this.running = task;
    return task;
  }

  cancelRemoteStop(): void {
    if (this.running || this.state.kind !== "remote_confirm") return;
    this.emit({ kind: "busy", remoteTarget: this.state.targetId }, this.session?.profile);
  }

  private remoteAction(action: (remote: RemoteStopController) => Promise<void>): Promise<void> {
    if (this.running) return this.running;
    if (!this.remote || !this.session || this.disposed) return Promise.resolve();
    const remote = this.remote;
    const token = this.session.access_token;
    const generation = this.generation;
    this.remoteScreen = true;
    const task = Promise.resolve().then(async () => {
      await action(remote);
      if (!this.current(generation) || this.remote !== remote) return;
      const phase = remote.snapshot().phase;
      // After a confirmed stop the window opens by a foreground of its own document_id (exception (4) of п.8б, AC-106):
      // never `event="open"`, which L2 refuses as a repeat.
      // N3 (C365, fix1): an answer that came while the window was hidden opens nothing there; the next show of the
      // window (its foreground()) sends the one foreground of its own document (AC-106).
      if (phase === "idle" || phase === "settled") {
        if (this.hidden) { this.reopenOnShow = { token, generation }; return; }
        await this.open(token, generation, "foreground", "user");
      }
    }).catch((error: unknown) => {
      if (this.current(generation)) this.fail(error);
    }).finally(() => {
      this.refusedTarget = null; // Only the reopen right after this action may use it.
      if (this.running === task) this.running = null;
    });
    this.running = task;
    return task;
  }

  confirmRemoteStop(): Promise<void> {
    if (this.state.kind !== "remote_confirm") return this.running ?? Promise.resolve();
    const target = this.state.targetId;
    return this.remoteAction(async remote => {
      await remote.confirm(target);
      if (remote.snapshot().outcome === "rejected") this.refusedTarget = target;
    });
  }

  checkRemoteStop(): Promise<void> {
    if (this.state.kind !== "remote") return this.running ?? Promise.resolve();
    // C400: the user's explicit check — after not_found its repeat reads again by a new one-shot ticket (R10 п.1).
    return this.remoteAction(remote => remote.refresh({ manual: true }));
  }

  retryRemoteStop(): Promise<void> {
    if (this.state.kind !== "remote") return this.running ?? Promise.resolve();
    return this.remoteAction(remote => remote.retry());
  }

  reapply(): Promise<void> {
    if (this.running) return this.running;
    if (this.conflictedIntentId || this.conflictedAccessVersion) return Promise.resolve();
    const session = this.session;
    if (!session || this.state.kind !== "rejected" || this.state.closed) return Promise.resolve();
    const reason = this.state.reason;
    const generation = ++this.generation;
    this.emit({ kind: "reapplying", reason });
    let confirmed = false;
    const task = (async () => {
      let intent = this.reapplyIntent;
      // An unknown outcome repeats its ID only while access is still at the version it was sent for.
      // After a newer decision that ID can only return the old fact, so the tap needs a new command.
      if (!intent || intent.expectedAccessVersion !== session.profile.access.version) {
        intent = {
          profileId: session.profile.profile_id,
          commandId: this.options.newId(),
          expectedAccessVersion: session.profile.access.version,
        };
        await writeReapplyIntent(this.options.storage, intent); // Replaces a stale intent under the same key.
        if (!this.current(generation)) return;
        this.reapplyIntent = intent;
      }
      if (!this.current(generation)) return;
      // From now on a request of this ID may leave: its outcome is unknown until a definite answer (R1).
      this.reapplyRegistry.hold(intent.commandId);
      const response = await this.options.api.reapply(session.access_token, {
        command_id: intent.commandId,
        expected_access_version: intent.expectedAccessVersion,
      });
      if (!this.current(generation)) return;
      if (response.command.id !== intent.commandId || !this.acceptProfile(response.current)) {
        throw new EntryApiError("invalid_response");
      }
      confirmed = true;
      this.reapplyRegistry.settled("recorded");
      this.session = { ...session, profile: response.current };
      await clearReapplyIntent(this.options.storage, session.profile.profile_id);
      if (!this.current(generation)) return;
      this.reapplyIntent = null;
      this.reapplyRegistry.release();
      if (response.current.access.status === "pending") {
        this.emit({ kind: "pending" }, response.current);
      } else if (response.current.access.status === "admitted") {
        await this.execute(generation, false);
      } else {
        this.emit(this.rejected(response.current), response.current);
      }
    })().catch(async (error: unknown) => {
      if (!this.current(generation)) return;
      // PAUSED_BEFORE_SEND (K13): nothing left; the saved ID stays for the next press, the button comes back.
      if (!confirmed && pausedBeforeSend(error)) { this.emit(this.rejectedState({ kind: "rejected", reason })); return; }
      if (!confirmed && error instanceof EntryApiError && error.kind === "http" && error.status === 403
        && error.code === "ACCESS_REJECTED") {
        this.reapplyRegistry.settled("rejected");
        this.reapplyRegistry.release();
        // The core refused a third application and wrote nothing (CT §6.3). The sign-in still works, so the
        // session stays; the screen is the closed refusal, not "unavailable" with a retry that leads back here.
        this.reapplyClosedFor = session.profile.profile_id;
        this.reapplyIntent = null;
        try {
          await clearReapplyIntent(this.options.storage, session.profile.profile_id);
        } catch {
          // The saved ID was never applied; with no reapply button left it is never sent again.
        }
        if (this.current(generation)) this.emit(this.rejected(session.profile), session.profile);
        return;
      }
      this.resetInvalidSession(error);
      if (error instanceof EntryApiError && error.kind === "http" && error.status === 409
        && error.code === "VERSION_CONFLICT") {
        this.reapplyRegistry.settled("rejected");
        this.reapplyRegistry.release();
        this.conflictedIntentId = this.reapplyIntent?.commandId ?? null;
        this.conflictedAccessVersion = this.reapplyIntent?.expectedAccessVersion ?? null;
        this.conflictedProfileId = session.profile.profile_id;
        this.reapplyIntent = null;
        this.session = null;
        try {
          await clearReapplyIntent(this.options.storage, session.profile.profile_id);
          if (this.current(generation)) this.conflictedIntentId = null;
        } catch {
          // Keep the in-memory block until the known-unapplied ID is cleared.
        }
        if (this.current(generation)) { this.profileRefresh = true; this.emit(this.unavailableState()); }
        return;
      }
      if (confirmed) { if (!expiredBy(error)) this.profileRefresh = true; this.emit(this.failureState(error)); return; }
      if (error instanceof EntryApiError && error.kind === "http") {
        // Known refusals of a write, each with its own meaning: neither is a network error nor a rejected access.
        if (error.status === 409 && error.code === "CLIENT_INCOMPATIBLE") { this.emit({ kind: "incompatible" }); return; }
        if (error.status === 503 && error.code === "MAINTENANCE") {
          const wait = error.pause?.waitSeconds;
          this.emit(this.rejectedState({ kind: "rejected", reason, pause: wait === null || wait === undefined ? {} : { waitSeconds: wait } }));
          return;
        }
      }
      if (error instanceof EntryApiError && error.kind === "invalid_response") {
        this.profileRefresh = true;
        this.emit(this.unavailableState());
        return;
      }
      if (error instanceof EntryApiError && error.kind === "http" && (error.status === 401 || error.status === 403)) {
        this.emit(this.failureState(error));
      } else {
        this.emit(this.rejectedState({ kind: "rejected", reason }));
      }
    }).finally(() => {
      if (this.running === task) this.running = null;
    });
    this.running = task;
    return task;
  }

  /**
   * The deletion screen ended this document (P04 ред.14 §8, PD-28): the sign-in is dropped and no sign-in follows by
   * itself. deleted — the result S-A07; unknown — «исход неизвестен» with the explicit sign-in (start()); expired —
   * AUTH_* on the first attempt, the ordinary expired screen.
   */
  /** PD-28 after the explicit sign-in named another profile: the earlier one is deleted (App, deletionCheckResult). */
  profileDeleted(profileId: string): void { void this.deletedProfiles.note(profileId); }

  endAfterDeletion(end: DeletionEnd): void {
    if (this.disposed || this.replaced) return;
    this.generation += 1; // A pending foreground reply must not reopen the document.
    this.recovery = "none";
    this.resetInvalidSession(end.kind === "deleted"
      ? new EntryApiError("http", 403, "PROFILE_DELETED") : new EntryApiError("http", 401, "AUTH_INVALID"));
    this.emit({ kind: end.kind === "deleted" ? "profile_deleted" : end.kind === "unknown" ? "deletion_unknown" : "expired" });
  }

  dispose(): void {
    this.unsubscribeGate();
    for (const wake of [...this.waiters]) wake();
    this.reapplyRegistry.release();
    this.remote?.dispose();
    this.remote = null;
    this.disposed = true;
    this.generation += 1;
    this.releaseLock();
    this.session = null;
    this.openedAccess = null;
    this.busyAccess = null;
  }
}
