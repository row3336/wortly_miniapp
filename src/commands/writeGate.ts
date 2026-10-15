import type { Availability } from "../api/availability";
import { systemRecoveryClock, type RecoveryClock, type RecoveryTimer } from "./recoveryClock";
import { PROBE_DELAYS_MS } from "./recoveryLimits";

/**
 * The write gate of one page (P03 §2, §4.1, §4.4, §4.11, §4.12; M-P03-3). One object per WebView page: the transport
 * asks it before every request (L2, RD-7) and it alone runs the series of availability probes (RD-5). Nothing in it
 * opens the way to a write on a timer: only a `ready` probe opens `net`; `send_hold`, the series and every pause only
 * delay (§4.9). Who closes `net` on a reply (the observer, M-P03-4), the decoders that settle an episode and the entry
 * wiring of the identity lock (M-P03-10) call the methods below; this module decides nothing about a reply by itself.
 */

/** The generation of a document the locks belong to (§4.11 «Ключ»): the fields the identity check compares. */
export type GateDoc = { readonly profileId: string; readonly documentId: string; readonly epoch: string };

/** Why `net` is closed (§2): a planned pause, a refusal of writes, or a transport failure / an unreadable probe. */
export type NetCause = "maintenance" | "unavailable" | "unknown";
export type NetState = { kind: "open" } | { kind: "closed"; cause: NetCause };

/**
 * Why a request was not sent (`PAUSED_BEFORE_SEND`, §2): `paused` — `mayWrite` is false; `no_ticket` — a command
 * status read without a readback ticket (R6); `closed_window` — the window is closed for good (§4.12); `k5_denied` —
 * an explicit return of work (K-5) before the owner's Я19 contract; `cancelled` — a deferred readback that lost its
 * document (Z5/Z5′, an unmounted owner, R9). In every case fetch was never called.
 */
export type PausedReason = "paused" | "no_ticket" | "closed_window" | "k5_denied" | "cancelled";

export class PausedBeforeSendError extends Error {
  constructor(public readonly reason: PausedReason) {
    super(`PAUSED_BEFORE_SEND: ${reason}`);
    this.name = "PausedBeforeSendError";
  }
}

/** An opaque one-shot permission to read the status of one command (R6); it lives in the request, never on the wire. */
export interface ReadbackTicket { readonly readbackTicket: true }

/**
 * The client's table of the core's POST routes (RD-7 п.3, RD-8), without the /api/v1 prefix. The structural test keeps
 * it equal to the POST paths of core/docs/openapi.json: an unclassified route fails it. `exception` passes a closed gate
 * (L2 п.2); `foreground_only` passes only as `event="foreground"` without `return_marker`; `gated` waits for `mayWrite`.
 * A route missing here is gated as well (default-deny).
 */
export type PostRouteClass = "exception" | "foreground_only" | "gated";
export const POST_ROUTES: Readonly<Record<string, PostRouteClass>> = Object.freeze({
  "/access/reapply": "gated",
  "/auth/telegram": "exception",
  "/client/events": "gated",
  "/client/open": "foreground_only",
  "/client/register": "exception",
  "/commands": "gated",
  "/profile/delete": "gated",
});
/**
 * Routes classified ahead of the core (RD-7 п.3). `/client/window-return` belongs to K-5, which stays off until the
 * owner approves the server contract Я19: until then it is refused like `return_marker` (§4.1 п.8). Every other future
 * POST (`/notices/{id}/ack`, the contact after a second refusal, `/auth/logout`) is gated by default-deny.
 */
export const FUTURE_POST_ROUTES: Readonly<Record<string, "blocked_until_ya19">> = Object.freeze({
  "/client/window-return": "blocked_until_ya19",
});

/** The definite answers of a readback (Z3, R5) and the indefinite ones that leave the ID locked (Z3, R4). */
export type DefiniteOutcome = "recorded" | "already_applied" | "not_recorded" | "terminated" | "mismatch" | "rejected";
export type IndefiniteOutcome = "stale" | "window_stale" | "storage" | "invalid";
const DEFINITE: ReadonlySet<string> = new Set<DefiniteOutcome>(["recorded", "already_applied", "not_recorded", "terminated", "mismatch", "rejected"]);

export type GateEvent =
  | { type: "ready" }
  | { type: "identity_verified"; doc: GateDoc }
  | { type: "changed" };

export type IdentityLockView = { doc: GateDoc; phase: "verifying" | "readback"; round: readonly string[] };
export type GateSnapshot = {
  net: NetState;
  /** The monotonic end of `send_hold`; null when none was ever announced. */
  holdUntil: number | null;
  identityLock: IdentityLockView | null;
  familyLocks: readonly string[];
  closedWindow: { doc: GateDoc | null } | null;
  lastWorkingDoc: GateDoc | null;
  /** The episode of a failure (§2) and the index of the last probe of its series; null outside an episode. */
  episode: { id: number; index: number } | null;
  /** The index of the last probe of the series (0 before the first); kept across `ready` (§2). */
  seriesIndex: number;
  probeScheduled: boolean;
  probeInFlight: boolean;
};

export type AdmitRequest = { method: string; path: string; body?: unknown; readbackTicket?: ReadbackTicket };

export type WriteGateOptions = {
  clock?: RecoveryClock;
  /** One GET /api/v1/availability (M-P03-1); attachProbe() may give it later, after the transport is built. */
  probe?: () => Promise<Availability>;
  /** The page starts with `closed(unknown)`: a pending with the outage mark in IndexedDB (§4.4, P2-04; MA-14). */
  outage?: { retryAfterS?: number | null };
  /** `ready` older than this needs a fresh probe before a readback, a send or a button (R-12, §4.4) [ПРЕДЛ]. */
  freshReadyMs?: number;
};

/** The upper bound of `send_hold` from one announcement (§3.5): callers pass a value already bounded by readRetryAfter. */
const HOLD_MAX_S = 900;
const FRESH_READY_MS = 10_000;

function sameDoc(a: GateDoc | null | undefined, b: GateDoc | null | undefined): boolean {
  return !!a && !!b && a.profileId === b.profileId && a.documentId === b.documentId && a.epoch === b.epoch;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function probeDelay(index: number): number {
  return PROBE_DELAYS_MS[Math.min(Math.max(index, 1), PROBE_DELAYS_MS.length) - 1];
}

type Deferred = { commandId: string; start: () => void; cancel: (reason: PausedReason) => void };
type Lock = { doc: GateDoc; phase: "verifying" | "readback"; round: Map<string, string> };

export class WriteGate {
  private readonly clock: RecoveryClock;
  private readonly freshReadyMs: number;
  private probe: (() => Promise<Availability>) | null;
  private readonly listeners = new Set<(event: GateEvent) => void>();

  private net: NetState = { kind: "open" };
  private holdUntil: number | null = null;
  private holdTimer: RecoveryTimer | null = null;

  private episode: { id: number } | null = null;
  private episodes = 0;
  private seriesIndex = 0;
  private seriesTimer: RecoveryTimer | null = null;
  private inFlight: Promise<Availability> | null = null;
  private lastReadyAt: number | null = null;
  private visible = true;

  /**
   * The live document of the page as the entry reports it: a confirmed `opened` (a doc), its loss in `unavailable`
   * (null), or `untracked` while no entry wiring reports it (before M-P03-10): then tickets follow the locks only.
   */
  private access: GateDoc | null | "untracked" = "untracked";
  private lastWorkingDoc: GateDoc | null = null;
  private lock: Lock | null = null;
  private readonly familyLocks = new Set<string>();
  private closedWindow: { doc: GateDoc | null } | null = null;
  private disposed = false;

  private readonly registry = new Map<string, { family: string; resolved: boolean }>();
  private readonly tickets = new Map<ReadbackTicket, { commandId: string; doc: GateDoc | null }>();
  private deferred: Deferred[] = [];

  constructor(options: WriteGateOptions = {}) {
    this.clock = options.clock ?? systemRecoveryClock;
    this.freshReadyMs = options.freshReadyMs ?? FRESH_READY_MS;
    this.probe = options.probe ?? null;
    if (options.outage) {
      this.net = { kind: "closed", cause: "unknown" };
      this.extendHoldBy(options.outage.retryAfterS ?? null);
      this.beginEpisode();
    }
  }

  /** The probe arrives once the shared transport (which itself needs this gate) is built. */
  attachProbe(probe: () => Promise<Availability>): void { this.probe = probe; }

  subscribe(listener: (event: GateEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  // ---- The single predicate (§2) and L2 (§4.1) ----

  /** The document the locks refer to (§2): the live `opened`, else the last confirmed one of this page. */
  gateDoc(): GateDoc | null {
    return (this.access !== "untracked" ? this.access : null) ?? this.lastWorkingDoc;
  }

  holdActive(): boolean { return this.holdUntil !== null && this.clock.now() < this.holdUntil; }

  /**
   * The button of a check by ID (a readback) — the narrower predicate of §4.13 and the rule of the button (C335):
   * net=open ∧ hold over ∧ window not closed. Neither the identity lock nor familyLocks keep it: a readback is what
   * settles them (Z4, R5). The «no recovery foreground in flight» part belongs to the entry (M-P03-10).
   */
  checkButtonActive(): boolean {
    return !this.closedWindow && !this.disposed && this.net.kind === "open" && !this.holdActive();
  }

  /** mayWrite(req) = net=open ∧ hold over ∧ no identity lock of gateDoc ∧ ID not family-locked ∧ window not closed. */
  mayWrite(commandId?: string): boolean {
    if (this.closedWindow || this.net.kind !== "open" || this.holdActive()) return false;
    if (this.lock && sameDoc(this.lock.doc, this.gateDoc())) return false;
    return commandId === undefined || !this.familyLocks.has(commandId);
  }

  /**
   * L2: the decision on one request, made synchronously right before fetch (RD-7 п.4); null lets it go. A ticket is
   * spent here, once. Default-deny: every non-GET waits for mayWrite unless it is one of the three exceptions.
   */
  admit(request: AdmitRequest): PausedReason | null {
    if (this.closedWindow) return "closed_window";
    // A disposed gate belongs to a page (or an App run) that is gone (Z5): it owns no probes, locks or tickets any more,
    // so nothing it guarded may leave through it — as its deferred readbacks, its requests end as cancelled.
    if (this.disposed) return "cancelled";
    const route = request.path.split(/[?#]/, 1)[0];
    if (request.method === "GET") {
      const status = /^\/commands\/([^/]+)$/.exec(route);
      if (!status) return null;
      let commandId: string;
      try { commandId = decodeURIComponent(status[1]); } catch { return "no_ticket"; }
      return this.spendTicket(request.readbackTicket, commandId) ? null : "no_ticket";
    }
    const body = record(request.body) ? request.body : undefined;
    // K-5 is off until Я19 (§4.1 п.8, ya19ContractApproved=false): the stub refuses its requests whatever else holds.
    if (FUTURE_POST_ROUTES[route] === "blocked_until_ya19"
      || route === "/client/open" && body !== undefined && Object.hasOwn(body, "return_marker") && body.return_marker !== undefined) {
      return "k5_denied";
    }
    const routeClass = Object.hasOwn(POST_ROUTES, route) ? POST_ROUTES[route] : "gated";
    if (request.method === "POST" && routeClass === "exception") return null;
    if (request.method === "POST" && routeClass === "foreground_only" && body?.event === "foreground") return null;
    const commandId = typeof body?.command_id === "string" ? body.command_id : undefined;
    return this.mayWrite(commandId) ? null : "paused";
  }

  // ---- net, send_hold and the single series of probes (§2, §3.5, §4.4) ----

  /** 503 MAINTENANCE on a real request: closed(maintenance); its estimate (bounded by §3.5) only lengthens the hold. */
  closeByMaintenance(retryAfterS: number | null): void {
    if (this.closedWindow || this.disposed) return;
    this.net = { kind: "closed", cause: "maintenance" };
    this.extendHoldBy(retryAfterS);
    // The same episode continues on its next index (ВР-10); outside an episode the series starts at 5 s.
    if (this.episode) this.nextOfSeries(this.clock.now());
    else if (!this.seriesTimer && !this.inFlight) this.scheduleProbe(1, this.clock.now());
    this.emit({ type: "changed" });
  }

  /**
   * A transport failure of a real request (502/504/other 5xx, a refused connection, an unreadable body, and until the
   * observer applies RD-2 also a timeout): the first one starts an episode (probe in 5 s); within an episode the series
   * goes on with the next index from this moment (§2 «Тот же эпизод», «Таймер ряда один»).
   */
  closeByFailure(cause: "unavailable" | "unknown" = "unknown"): void {
    if (this.closedWindow || this.disposed) return;
    this.net = { kind: "closed", cause };
    if (this.episode) this.nextOfSeries(this.clock.now());
    else this.beginEpisode();
    this.emit({ type: "changed" });
  }

  /** `send_hold := max(send_hold, now + N)`; never shortened (§3.5); null leaves it as it is. */
  extendHold(retryAfterS: number | null): void {
    if (this.closedWindow || this.disposed) return;
    if (this.extendHoldBy(retryAfterS)) this.emit({ type: "changed" });
  }

  /** A definite answer of the core ended the episode (§2 п.1–3, decided by the caller): the next failure starts at 5 s. */
  finishEpisode(): void {
    if (!this.episode) return;
    this.episode = null;
    this.seriesIndex = 0;
    if (this.net.kind === "open") this.cancelSeries();
    this.emit({ type: "changed" });
  }

  /**
   * The page is hidden or shown. Hidden: timers stop, nothing new is sent, a request in flight is not cancelled, and
   * the gate keeps everything. Shown again: the series restarts at 5 s (Q35.3) while there is something to wait for.
   */
  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    if (!visible) { this.cancelSeries(); return; }
    if (this.closedWindow || this.disposed) return;
    if (this.net.kind === "closed" || this.episode) this.scheduleProbe(1, this.clock.now());
  }

  /**
   * R-12: right before a readback, a send or a button after the hold — true when `ready` is fresh (or the gate never
   * closed); otherwise one probe outside the series. A negative answer closes `net`, applies its `retry_after_s` and
   * resumes the series with index i+1 from the end of this probe; it neither starts nor ends an episode (§4.4).
   */
  async ensureFresh(): Promise<boolean> {
    if (this.closedWindow || this.disposed || this.net.kind !== "open" || this.holdActive()) return false;
    if (this.lastReadyAt === null || this.clock.now() - this.lastReadyAt <= this.freshReadyMs) return true;
    const result = await this.runProbe();
    return result?.status === "ready" && this.mayWrite();
  }

  private beginEpisode(): void {
    this.episode = { id: ++this.episodes };
    this.scheduleProbe(1, this.clock.now());
  }

  private nextOfSeries(from: number): void { this.scheduleProbe(this.seriesIndex + 1, from); }

  /** The one timer of the series: any event replaces the probe it had planned. */
  private scheduleProbe(index: number, from: number): void {
    this.cancelSeries();
    this.seriesIndex = index;
    if (!this.visible || this.closedWindow || this.disposed) return;
    const delay = Math.max(0, from + probeDelay(index) - this.clock.now());
    this.seriesTimer = this.clock.schedule(() => {
      this.seriesTimer = null;
      void this.runProbe();
    }, delay);
  }

  private cancelSeries(): void {
    if (this.seriesTimer) this.clock.cancel(this.seriesTimer);
    this.seriesTimer = null;
  }

  /** At most one probe of this page in flight (§3.1 «Нагрузка»); a second caller shares its answer. */
  private runProbe(): Promise<Availability | null> {
    if (this.closedWindow || this.disposed || !this.probe) return Promise.resolve(null);
    if (this.inFlight) return this.inFlight;
    let pending: Promise<Availability>;
    try { pending = this.probe(); } catch { pending = Promise.resolve({ status: "unknown" }); }
    const flight = pending.catch((): Availability => ({ status: "unknown" }));
    this.inFlight = flight;
    this.emit({ type: "changed" });
    return flight.then(result => {
      this.inFlight = null;
      this.probeAnswered(result);
      return result;
    });
  }

  private probeAnswered(result: Availability): void {
    // A closed window ignores late answers (§4.12): they are facts for the journal, not transitions.
    if (this.closedWindow || this.disposed) return;
    const now = this.clock.now();
    if (result.status === "ready") {
      this.lastReadyAt = now;
      this.cancelSeries();
      if (this.net.kind === "closed") {
        this.net = { kind: "open" };
        this.emit({ type: "ready" });
      }
      this.emit({ type: "changed" });
      return;
    }
    this.net = { kind: "closed", cause: result.status };
    if (result.status !== "unknown") this.extendHoldBy(result.retryAfterS);
    this.nextOfSeries(now);
    this.emit({ type: "changed" });
  }

  private extendHoldBy(retryAfterS: number | null): boolean {
    if (retryAfterS === null || !Number.isSafeInteger(retryAfterS) || retryAfterS < 0) return false;
    const until = this.clock.now() + Math.min(retryAfterS, HOLD_MAX_S) * 1_000;
    if (this.holdUntil !== null && until <= this.holdUntil) return false;
    this.holdUntil = until;
    if (this.holdTimer) this.clock.cancel(this.holdTimer);
    // The end of the hold opens nothing; subscribers only look again (buttons, a fresh probe).
    this.holdTimer = this.clock.schedule(() => { this.holdTimer = null; this.emit({ type: "changed" }); },
      Math.max(0, until - this.clock.now()));
    return true;
  }

  // ---- The document, the identity lock and the closed window (§4.11, §4.12) ----

  /** A confirmed `opened` of `doc`. Another document than gateDoc replaces the locks of the old one (Z5). */
  noteOpened(doc: GateDoc): void {
    if (this.closedWindow || this.disposed) return;
    const current = this.gateDoc();
    if (current && !sameDoc(current, doc)) this.dropDocument();
    this.access = doc;
    this.lastWorkingDoc = doc;
    this.releaseDeferred();
    this.emit({ type: "changed" });
  }

  /** `fail()` → `unavailable`: not Z5. The locks and lastWorkingDoc stay; tickets are void until the next `opened`. */
  noteAccessLost(): void {
    if (this.closedWindow || this.disposed) return;
    this.access = null;
    this.tickets.clear();
    this.emit({ type: "changed" });
  }

  /** Z1 (K-9a, K-11 ВР-1): the identity lock of a working document; an existing lock of the same doc is kept. */
  lockIdentity(doc: GateDoc): void {
    if (this.closedWindow || this.disposed) return;
    if (this.lock && sameDoc(this.lock.doc, doc)) return;
    this.lock = { doc, phase: "verifying", round: new Map() };
    this.emit({ type: "changed" });
  }

  /** Z2 (ВР-6): the identity matched; the round becomes the unsettled registry and its deferred readbacks start. */
  identityVerified(doc: GateDoc): void {
    if (this.closedWindow || this.disposed) return;
    this.noteOpened(doc);
    const lock = this.lock;
    if (!lock || !sameDoc(lock.doc, doc)) return;
    lock.phase = "readback";
    lock.round = new Map([...this.registry].filter(([, entry]) => !entry.resolved).map(([id, entry]) => [id, entry.family]));
    this.emit({ type: "identity_verified", doc });
    this.releaseDeferred();
    this.settleRound();
    this.emit({ type: "changed" });
  }

  /** Z3, transport (ВР-12): the round waits for the next identity check; it is kept as it is. */
  readbackInterrupted(): void {
    if (this.closedWindow || this.disposed || !this.lock) return;
    this.lock.phase = "verifying";
    this.emit({ type: "changed" });
  }

  /** Z5 by `resetInvalidSession` (401/403): the old document's locks, registrations and deferred readbacks go. */
  resetDocument(): void {
    if (this.closedWindow || this.disposed) return;
    this.dropDocument();
    this.access = null;
    this.emit({ type: "changed" });
  }

  /**
   * Z5′ (ВР-7, ВР-8, ВР-8б): the window is closed for good. Every request of any method is refused from now on, the
   * series stops, tickets and deferred readbacks are void; only a reload of the page lifts it (§4.12).
   */
  closeWindow(doc?: GateDoc | null): void {
    if (this.closedWindow || this.disposed) return;
    const closed = { doc: doc ?? this.gateDoc() };
    this.dropDocument();
    this.access = null;
    this.closedWindow = closed;
    this.cancelSeries();
    this.emit({ type: "changed" });
  }

  /** The page goes away (Z5): timers stop and nothing waits any more. */
  dispose(): void {
    if (this.disposed) return;
    this.dropDocument();
    this.cancelSeries();
    if (this.holdTimer) this.clock.cancel(this.holdTimer);
    this.holdTimer = null;
    this.disposed = true;
    this.listeners.clear();
  }

  private dropDocument(): void {
    this.lock = null;
    this.familyLocks.clear();
    this.lastWorkingDoc = null;
    this.registry.clear();
    this.tickets.clear();
    this.cancelDeferred(() => true);
  }

  // ---- The registry of readbacks and the tickets (§4.11 R1–R9) ----

  /** R1: a pending is created or loaded; under a lock it joins the current round. */
  registerPending(family: string, commandId: string): void {
    if (this.closedWindow || this.disposed) return;
    this.registry.set(commandId, { family, resolved: false });
    if (this.lock && sameDoc(this.lock.doc, this.gateDoc())) this.lock.round.set(commandId, family);
    this.emit({ type: "changed" });
  }

  /** R3/R9: the owner goes away; an ID without a definite answer stays locked to itself until its definite readback. */
  unregisterPending(commandId: string): void {
    const entry = this.registry.get(commandId);
    this.registry.delete(commandId);
    if (entry && !entry.resolved) this.familyLocks.add(commandId);
    this.lock?.round.delete(commandId);
    this.cancelDeferred(job => job.commandId === commandId);
    this.settleRound();
    this.emit({ type: "changed" });
  }

  /**
   * Z3/R5: the outcome of a readback. A definite one takes the ID out of the round and of familyLocks; an indefinite one
   * (stale, window_stale, a storage error, a malformed record) takes it out of the round into familyLocks. The checks of
   * requestId/doc/episode of a reply (§2 п.3) belong to the decoders (M-P03-10).
   */
  resolvePending(commandId: string, outcome: DefiniteOutcome | IndefiniteOutcome): void {
    if (this.closedWindow || this.disposed) return;
    const entry = this.registry.get(commandId);
    if (DEFINITE.has(outcome)) {
      if (entry) entry.resolved = true;
      this.familyLocks.delete(commandId);
    } else this.familyLocks.add(commandId);
    this.lock?.round.delete(commandId);
    this.settleRound();
    this.emit({ type: "changed" });
  }

  /** True while a registered pending still waits for a definite answer (used by the K-5 rule, §4.1 п.8). */
  hasUnsettledPending(): boolean {
    for (const entry of this.registry.values()) if (!entry.resolved) return true;
    return false;
  }

  /**
   * The only way to read a command's status (R2, R6): fn gets a one-shot ticket that the transport spends. Under the
   * identity lock of gateDoc in `verifying`, or without a live `opened`, fn waits; a closed window refuses at once.
   */
  runReadback<T>(commandId: string, fn: (ticket: ReadbackTicket) => Promise<T>): Promise<T> {
    if (this.closedWindow) return Promise.reject(new PausedBeforeSendError("closed_window"));
    if (this.disposed) return Promise.reject(new PausedBeforeSendError("cancelled"));
    return new Promise<T>((resolve, reject) => {
      const job: Deferred = {
        commandId,
        start: () => {
          const ticket: ReadbackTicket = Object.freeze({ readbackTicket: true as const });
          this.tickets.set(ticket, { commandId, doc: this.gateDoc() });
          let run: Promise<T>;
          try { run = Promise.resolve(fn(ticket)); } catch (error) { run = Promise.reject(error); }
          run.finally(() => { this.tickets.delete(ticket); }).then(resolve, reject);
        },
        cancel: reason => reject(new PausedBeforeSendError(reason)),
      };
      if (this.readbackAllowed()) job.start();
      else this.deferred.push(job);
    });
  }

  private readbackAllowed(): boolean {
    if (this.closedWindow || this.disposed || this.access === null) return false;
    return !(this.lock && this.lock.phase === "verifying" && sameDoc(this.lock.doc, this.gateDoc()));
  }

  private releaseDeferred(): void {
    if (!this.readbackAllowed()) return;
    const jobs = this.deferred;
    this.deferred = [];
    // In the order the readbacks were asked for (T36).
    for (const job of jobs) job.start();
  }

  private cancelDeferred(which: (job: Deferred) => boolean): void {
    const cancelled = this.deferred.filter(which);
    this.deferred = this.deferred.filter(job => !which(job));
    for (const job of cancelled) job.cancel("cancelled");
  }

  private spendTicket(ticket: ReadbackTicket | undefined, commandId: string): boolean {
    if (!ticket) return false;
    const issued = this.tickets.get(ticket);
    if (!issued || issued.commandId !== commandId) return false;
    if (issued.doc && !sameDoc(issued.doc, this.gateDoc())) return false;
    this.tickets.delete(ticket);
    return true;
  }

  /** Z4: an empty round after the identity check lifts the whole lock; familyLocks stay (AC-53). */
  private settleRound(): void {
    if (this.lock && this.lock.phase === "readback" && this.lock.round.size === 0) {
      this.lock = null;
      this.releaseDeferred();
    }
  }

  // ---- Observation ----

  snapshot(): GateSnapshot {
    return {
      net: this.net,
      holdUntil: this.holdUntil,
      identityLock: this.lock ? { doc: this.lock.doc, phase: this.lock.phase, round: [...this.lock.round.keys()] } : null,
      familyLocks: [...this.familyLocks],
      closedWindow: this.closedWindow,
      lastWorkingDoc: this.lastWorkingDoc,
      episode: this.episode ? { id: this.episode.id, index: this.seriesIndex } : null,
      seriesIndex: this.seriesIndex,
      probeScheduled: this.seriesTimer !== null,
      probeInFlight: this.inFlight !== null,
    };
  }

  private emit(event: GateEvent): void {
    for (const listener of [...this.listeners]) {
      try { listener(event); } catch { /* a subscriber's error never changes the gate */ }
    }
  }
}
