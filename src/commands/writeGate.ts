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
  openAttempts: readonly string[];
  retryAfter403Doc: string | null;
  lastRecoveryForegroundSentAt: number | null;
  recoveryForegroundInFlight: boolean;
  remoteReadContext: boolean;
};

/**
 * Who asked for a request (L2 п.8, `Request.origin`): a press of the user, or the client itself (a timer, `ready`, a
 * shown window, a late answer). Only the K-5 requests read it (п.8а); until Я19 they are refused whatever the origin.
 */
export type RequestOrigin = "user" | "auto";

export type AdmitRequest = { method: string; path: string; body?: unknown; readbackTicket?: ReadbackTicket; origin?: RequestOrigin };

/**
 * The stamp the transport puts on every admitted request (§2 п.3, M-P03-10): an opaque requestId unique on the page, the
 * document_id of the request (from its body or its query) and the episode at the moment it left. A decoder gives it
 * back with noteDefinite/resolvePending; a stamp of another request, document or episode changes nothing (AC-89, AC-95).
 */
export type RequestStamp = { readonly requestId: string; readonly documentId: string | null; readonly episode: number | null };

/**
 * K-5 (the explicit return of work: the marker, `open` with `return_marker`, `/client/window-return`) stays off until the
 * owner approves the server contract Я19 (§4.1 п.8, [ЗАВ-Я19]). A constant of the build, with no setter: the stub
 * refuses every K-5 request (`k5_denied`) whatever else holds; the other conditions of п.8а are not evaluated before Я19.
 */
export const YA19_CONTRACT_APPROVED = false as const;

/**
 * R10 (§4.11, ред.20): the narrow context in which the owner of the page's own `session.stop_remote` may read its status in
 * `busy`/`remote` without an `opened`. The entry makes it after a valid current SESSION_BUSY; it is no `gateDoc`, no
 * `lastWorkingDoc` and no `openedAccess`, and it gives no other right.
 */
export interface RemoteReadContext { readonly remoteReadContext: true }

/**
 * The document a request left for, as the gate saw it at admit (the DOCUMENT_STALE junction P02↔P03): its document of
 * reference and the count of confirmed `opened` of this page then. Local to the page — no wire field, no epoch.
 */
export interface DocMark { readonly doc: GateDoc | null; readonly opened: number }

/** fix3: the П01 episode — a definite SESSION_BUSY of this page's own session.start for its working document. */
export interface P01Episode { readonly p01: true; readonly doc: GateDoc; readonly commandId: string }

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

type Deferred = { commandId: string; start: () => void; cancel: (reason: PausedReason) => void; remote?: RemoteReadContext };
type Issued = { commandId: string; doc: GateDoc | null; remote?: { context: RemoteReadContext; registration: object } };

/** The anti-flapping threshold of a shown window (§2 «Антифлаппинг»): ≥ 5 s from the last recovery foreground sent. */
const SHOW_FOREGROUND_GAP_MS = 5_000;

function documentIdOf(path: string, body: Record<string, unknown> | undefined): string | null {
  if (typeof body?.document_id === "string") return body.document_id;
  const query = path.split("?", 2)[1];
  if (!query) return null;
  try { return new URLSearchParams(query).get("document_id"); } catch { return null; }
}
type Lock = { doc: GateDoc; phase: "verifying" | "readback"; round: Map<string, string> };

export class WriteGate {
  private readonly clock: RecoveryClock;
  private readonly freshReadyMs: number;
  private probe: (() => Promise<Availability>) | null;
  private readonly listeners = new Set<(event: GateEvent) => void>();

  private net: NetState = { kind: "open" };
  private holdUntil: number | null = null;
  private holdTimer: RecoveryTimer | null = null;

  /**
   * The episode of a failure (§2); withPending: begun while a registered pending had no definite answer; anchor: the
   * command whose request failed (§2 п.1) — or, when a foreground or a projection read failed, the first registered one.
   */
  private episode: { id: number; withPending: boolean; anchor: string | null } | null = null;
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
  private readonly tickets = new Map<ReadbackTicket, Issued>();
  private deferred: Deferred[] = [];

  /** §2 openAttempts: every document_id whose `event="open"` L2 has already checked (sent or refused). */
  private readonly openAttempts = new Set<string>();
  /** §2 retryAfter403Doc: the one-shot allowance of one repeat of `open` after a definite 403 FORBIDDEN (п.8б (5)). */
  private retryAfter403Doc: string | null = null;
  /** The stamps of the requests this gate let go (§2 п.3), the most recent ones only. */
  private readonly stamps = new Map<string, RequestStamp>();
  private stampSequence = 0;
  /** §2 «Антифлаппинг»: when the last recovery foreground of any source was sent in this episode; one in flight at most. */
  private lastRecoveryForegroundSentAt: number | null = null;
  private recoveryForegroundInFlight = false;
  /** fix3: the П01 episode of a definite SESSION_BUSY of the page's own start, and the last command this gate let go. */
  private p01: P01Episode | null = null;
  /** Confirmed `opened` of this page so far (DocMark). */
  private openedCount = 0;
  private lastCommand: { commandId: string; documentId: string | null } | null = null;
  /** R10: the live context of the own stop_remote readback in busy/remote, and its readbacks a hidden window holds back. */
  private remote: RemoteReadContext | null = null;
  private remoteDeferred: Deferred[] = [];
  /** The page started closed by the outage mark (§4.4, T28s): its first `open` waits for mayWrite (§4.10, R1). */
  readonly outageAtStart: boolean;

  constructor(options: WriteGateOptions = {}) {
    this.clock = options.clock ?? systemRecoveryClock;
    this.freshReadyMs = options.freshReadyMs ?? FRESH_READY_MS;
    this.probe = options.probe ?? null;
    this.outageAtStart = !!options.outage;
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

  /**
   * The entry of the page reports its document from now on (noteOpened/noteAccessLost, M-P03-10 with R10): until its
   * first confirmed `opened` no ordinary readback ticket is given (R2, R8 п.5). A gate nobody tracks (an owner's unit
   * test) keeps giving tickets by its locks only.
   */
  trackAccess(): void { if (this.access === "untracked") this.access = null; }

  /** Whole seconds left of the announced hold: null if none was ever announced, 0 once it passed (§4.8 maintenanceOver). */
  holdRemainingS(): number | null {
    return this.holdUntil === null ? null : Math.max(0, Math.ceil((this.holdUntil - this.clock.now()) / 1_000));
  }

  holdActive(): boolean { return this.holdUntil !== null && this.clock.now() < this.holdUntil; }

  /**
   * The button of a check by ID (a readback) — the narrower predicate of §4.13 and the rule of the button (C335):
   * net=open ∧ hold over ∧ window not closed. Neither the identity lock nor familyLocks keep it: a readback is what
   * settles them (Z4, R5). The «no recovery foreground in flight» part belongs to the entry (M-P03-10).
   */
  checkButtonActive(): boolean {
    return !this.closedWindow && !this.disposed && this.net.kind === "open" && !this.holdActive()
      && !this.recoveryForegroundInFlight;
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
    // п.8б: a repeated `event="open"` without a marker — a retry() of the same document — is refused whatever its
    // origin, mayWrite or locks; any `event="open"` is refused once the page has a document of reference (gateDoc).
    // The first check of a document_id records it, before every other condition (§2 openAttempts).
    if (route === "/client/open" && request.method === "POST" && body?.event === "open") {
      const documentId = typeof body.document_id === "string" ? body.document_id : null;
      const repeated = documentId === null || this.openAttempts.has(documentId);
      if (documentId !== null) this.openAttempts.add(documentId);
      const allowance = repeated && documentId !== null && this.retryAfter403Doc === documentId;
      if (allowance) this.retryAfter403Doc = null; // spent by this check, sent or not (§2)
      if (this.gateDoc() !== null) return "k5_denied";
      if (repeated && !allowance && !YA19_CONTRACT_APPROVED) return "k5_denied";
      return this.mayWrite() ? null : "paused";
    }
    const routeClass = Object.hasOwn(POST_ROUTES, route) ? POST_ROUTES[route] : "gated";
    if (request.method === "POST" && routeClass === "exception") return null;
    if (request.method === "POST" && routeClass === "foreground_only" && body?.event === "foreground") return null;
    const commandId = typeof body?.command_id === "string" ? body.command_id : undefined;
    if (!this.mayWrite(commandId)) return "paused";
    if (request.method === "POST" && route === "/commands" && commandId !== undefined) {
      // fix3 (П01): the command this page is about to send; any newer action ends a П01 episode of an earlier refusal.
      this.p01 = null;
      this.lastCommand = { commandId, documentId: typeof body?.document_id === "string" ? body.document_id : null };
    }
    return null;
  }

  // ---- fix3: the П01 episode — a definite SESSION_BUSY of this page's own session.start (TZA 12.1, В4) ----

  /**
   * The decoder of the direct reply of POST /commands session.start read a definite refusal SESSION_BUSY (not a readback,
   * not a restored record): the П01 episode of the working document begins. Only for the command this gate let go last,
   * of the live document of reference, without an identity lock or a closed window. Nothing is opened or lifted by it.
   */
  noteStartBusy(commandId: string): boolean {
    const doc = this.gateDoc();
    if (this.closedWindow || this.disposed || this.lock || doc === null || this.access === null || this.access === "untracked"
      || !sameDoc(this.access, doc) || this.lastCommand?.commandId !== commandId || this.lastCommand.documentId !== doc.documentId) {
      return false;
    }
    this.p01 = Object.freeze({ p01: true as const, doc, commandId });
    return true;
  }

  /** The «На Сегодня» of that refusal spends the episode, once; any other caller only ends it (endP01). */
  takeP01(commandId: string): P01Episode | null {
    const episode = this.p01;
    this.p01 = null; // spent or ended by this check either way: one transition per episode
    if (!episode || episode.commandId.toLowerCase() !== commandId.toLowerCase()) return null;
    // fix5 (C388): the episode holds only while its document is still the live one of reference, unlocked and open.
    const doc = this.gateDoc();
    if (this.closedWindow || this.disposed || this.lock || doc === null || !sameDoc(doc, episode.doc)
      || this.access === null || this.access === "untracked" || !sameDoc(this.access, episode.doc)
      || this.lastWorkingDoc === null || !sameDoc(this.lastWorkingDoc, episode.doc)) return null;
    return episode;
  }
  endP01(): void { this.p01 = null; }
  p01Pending(): boolean { return this.p01 !== null; }

  /**
   * The narrow read context of the own stop_remote after the busy Today of a П01 episode: the same R10 tickets (one GET of
   * the registered own stop, bound to its registration and this context), for the working document of the episode only —
   * its lastWorkingDoc stays, no opened, gateDoc or epoch is made; no identity lock, no closed window.
   */
  openP01ReadContext(episode: P01Episode): RemoteReadContext | null {
    if (this.closedWindow || this.disposed || this.lock !== null || this.lastWorkingDoc === null
      || !sameDoc(this.lastWorkingDoc, episode.doc)) return null;
    this.voidRemote();
    const context: RemoteReadContext = Object.freeze({ remoteReadContext: true as const });
    this.remote = context;
    return context;
  }

  /** The document a request admit() has just let go is sent for (DocMark); the transport keeps it for its answer. */
  docMark(): DocMark { return Object.freeze({ doc: this.gateDoc(), opened: this.openedCount }); }
  /**
   * The mark still names the page's current document: the window is not closed, its document of reference is the same
   * and no `opened` was confirmed since — a late answer of an older document, profile or exchange is never current.
   */
  markCurrent(mark: DocMark): boolean {
    return !this.closedWindow && !this.disposed && mark.doc !== null && sameDoc(mark.doc, this.gateDoc())
      && mark.opened === this.openedCount;
  }

  /** The stamp of a request admit() has just let go (§2 п.3): the transport takes it in the same synchronous stretch. */
  stamp(path: string, body?: unknown): RequestStamp {
    const stamp: RequestStamp = Object.freeze({ requestId: `rq${++this.stampSequence}`,
      documentId: documentIdOf(path, record(body) ? body : undefined), episode: this.episode?.id ?? null });
    this.stamps.set(stamp.requestId, stamp);
    if (this.stamps.size > 256) this.stamps.delete(this.stamps.keys().next().value as string);
    return stamp;
  }

  /** The stamp is one this gate gave, of the current episode and of the document of reference (§2 п.3). */
  private currentStamp(stamp: RequestStamp): boolean {
    const issued = this.stamps.get(stamp.requestId);
    if (!issued || issued !== stamp && (issued.documentId !== stamp.documentId || issued.episode !== stamp.episode)) return false;
    if (stamp.episode !== (this.episode?.id ?? null)) return false;
    const doc = this.gateDoc();
    return doc === null || stamp.documentId === doc.documentId;
  }

  /**
   * §2 п.3: a strict decoder read a definite answer of the core to the request of this stamp (not a readback). It ends an
   * episode without pending (§2 п.2); an episode begun with pending ends only by the definite readback of its anchor.
   * A late answer of another request, document or episode changes nothing (it is a fact for the journal only).
   */
  noteDefinite(stamp: RequestStamp): boolean {
    if (this.closedWindow || this.disposed || !this.episode || !this.currentStamp(stamp)) return false;
    if (this.episode.withPending && this.anchor() !== null) return false;
    this.finishEpisode();
    return true;
  }

  /**
   * The late-registration branch of the first open (§2 retryAfter403Doc, п.8б (5)): a definite 403 FORBIDDEN of the core to
   * the open of this stamp allows one repeat of `event="open"` of the same document. Nothing else sets it.
   */
  noteForbiddenBeforeChange(stamp: RequestStamp): boolean {
    if (this.closedWindow || this.disposed || stamp.documentId === null) return false;
    const issued = this.stamps.get(stamp.requestId);
    if (!issued || issued.documentId !== stamp.documentId || !this.openAttempts.has(stamp.documentId)) return false;
    this.retryAfter403Doc = stamp.documentId;
    return true;
  }

  /** The late registration ended without the repeat (its register failed, fail()): the allowance is gone (§2, ред.15). */
  dropRetryAfter403(): void { this.retryAfter403Doc = null; }

  /** True while the allowance of п.8б (5) waits for its one repeat (observation, tests). */
  retryAfter403Pending(): string | null { return this.retryAfter403Doc; }

  /** Has L2 already checked an `event="open"` of this document (§2 openAttempts)? */
  openAttempted(documentId: string): boolean { return this.openAttempts.has(documentId); }

  // ---- The recovery foreground of the entry (K-11/K-9a, §2 «Антифлаппинг»; M-P03-10) ----

  /** A recovery foreground of any source (show, ready, manual check) leaves now: the mark moves, one is in flight. */
  recoveryForegroundSent(): void {
    this.lastRecoveryForegroundSentAt = this.clock.now();
    this.recoveryForegroundInFlight = true;
    this.emit({ type: "changed" });
  }

  /** Its answer or failure came back. */
  recoveryForegroundSettled(): void {
    if (!this.recoveryForegroundInFlight) return;
    this.recoveryForegroundInFlight = false;
    this.emit({ type: "changed" });
  }

  /** A shown window may send its immediate foreground: none in flight and ≥ 5 s from the mark (or no mark yet). */
  showForegroundAllowed(): boolean {
    if (this.recoveryForegroundInFlight) return false;
    return this.lastRecoveryForegroundSentAt === null || this.clock.now() - this.lastRecoveryForegroundSentAt >= SHOW_FOREGROUND_GAP_MS;
  }

  recoveryForegroundBusy(): boolean { return this.recoveryForegroundInFlight; }

  // ---- net, send_hold and the single series of probes (§2, §3.5, §4.4) ----

  /**
   * 503 MAINTENANCE on a real request: closed(maintenance); its estimate (bounded by §3.5) only lengthens the hold.
   * commandId: the command of the request (its POST or its readback), when it was one (§2 п.1, Z3).
   */
  closeByMaintenance(retryAfterS: number | null, commandId?: string): void {
    if (this.closedWindow || this.disposed) return;
    this.net = { kind: "closed", cause: "maintenance" };
    this.extendHoldBy(retryAfterS);
    this.interruptRound(commandId);
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
  closeByFailure(cause: "unavailable" | "unknown" = "unknown", commandId?: string): void {
    if (this.closedWindow || this.disposed) return;
    this.net = { kind: "closed", cause };
    this.interruptRound(commandId);
    if (this.episode) this.nextOfSeries(this.clock.now());
    else this.beginEpisode(commandId);
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
    this.lastRecoveryForegroundSentAt = null;
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
    // AC-11b: readbacks a hidden window held back under the identity lock go now (in the order asked, T36).
    this.releaseDeferred();
    // R10 п.3: a hidden window starts no readback of its own stop_remote; shown again, they go.
    const remote = this.remoteDeferred;
    this.remoteDeferred = [];
    for (const job of remote) { if (job.remote === this.remote) job.start(); else job.cancel("cancelled"); }
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

  private beginEpisode(failed?: string): void {
    const withPending = this.hasUnsettledPending();
    const own = failed !== undefined && this.registry.get(failed)?.resolved === false ? failed : null;
    this.episode = { id: ++this.episodes, withPending, anchor: withPending ? own ?? this.firstUnsettled() : null };
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
    this.scheduleHoldEnd();
    return true;
  }

  /**
   * The end of the hold opens nothing; subscribers only look again (buttons, a fresh probe). A timer that fires a moment
   * early (the timer and the monotonic clock are two sources) waits for the rest instead of telling a hold still on.
   */
  private scheduleHoldEnd(): void {
    if (this.holdTimer) this.clock.cancel(this.holdTimer);
    this.holdTimer = null;
    if (this.holdUntil === null || this.disposed) return;
    this.holdTimer = this.clock.schedule(() => {
      this.holdTimer = null;
      if (this.holdActive()) { this.scheduleHoldEnd(); return; }
      this.emit({ type: "changed" });
    }, Math.max(1, this.holdUntil - this.clock.now()));
  }

  // ---- The document, the identity lock and the closed window (§4.11, §4.12) ----

  /** A confirmed `opened` of `doc`. Another document than gateDoc replaces the locks of the old one (Z5). */
  noteOpened(doc: GateDoc): void {
    if (this.closedWindow || this.disposed) return;
    this.openedCount += 1;
    const current = this.gateDoc();
    if (current && !sameDoc(current, doc)) this.dropDocument();
    this.voidRemote(); // an ordinary context replaces the narrow one of R10
    this.access = doc;
    this.lastWorkingDoc = doc;
    this.releaseDeferred();
    this.emit({ type: "changed" });
  }

  /**
   * No live `opened` any more (`fail()` → `unavailable`, `busy`, a new entry run): not Z5. The locks and lastWorkingDoc stay;
   * ordinary tickets are void until the next `opened`. keepRemote: the UI step busy → remote_confirm → remote of the same
   * entry generation, the only change the R10 context outlives (R10 п.1); anything else voids it too (R10 п.3).
   */
  noteAccessLost(options: { keepRemote?: boolean } = {}): void {
    if (this.closedWindow || this.disposed) return;
    const changed = this.access !== null;
    if (this.access !== "untracked") this.access = null;
    for (const [ticket, issued] of this.tickets) if (!issued.remote) this.tickets.delete(ticket);
    if (!options.keepRemote) { this.voidRemote(); this.p01 = null; }
    if (changed) this.emit({ type: "changed" });
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

  /**
   * Z3 transport (ВР-12): a failure of a task of the round (the readback of one of its commands) while the round is read
   * sends the lock back to `verifying`; its round is kept. A failure of any other request (a projection) does not.
   */
  private interruptRound(commandId?: string): void {
    if (this.lock && this.lock.phase === "readback" && commandId !== undefined && this.lock.round.has(commandId)) {
      this.lock.phase = "verifying";
    }
  }

  /** Is there an identity lock of this document of reference (any phase)? For the entry's routing (§4.13). */
  identityLocked(): boolean { return this.lock !== null; }

  /** Z5 by `resetInvalidSession` (401/403): the old document's locks, registrations and deferred readbacks go. */
  resetDocument(): void {
    if (this.closedWindow || this.disposed) return;
    this.dropDocument();
    this.retryAfter403Doc = null;
    if (this.access !== "untracked") this.access = null;
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
    this.retryAfter403Doc = null;
    this.recoveryForegroundInFlight = false;
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
    this.recoveryForegroundInFlight = false;
    this.listeners.clear();
  }

  private dropDocument(): void {
    this.p01 = null;
    this.lock = null;
    this.familyLocks.clear();
    this.lastWorkingDoc = null;
    this.registry.clear();
    this.tickets.clear();
    this.cancelDeferred(() => true);
    this.voidRemote();
  }

  // ---- R10: the readback of the own stop_remote in busy/remote without `opened` (§4.11 R10, ред.20) ----

  /**
   * R10 п.1: the narrow read context after a valid current SESSION_BUSY of the page's own document. Never with a document
   * of reference, an identity lock or a closed window (AC-115). A new one voids the old one and its tickets.
   */
  openRemoteReadContext(): RemoteReadContext | null {
    if (this.closedWindow || this.disposed || this.lastWorkingDoc !== null || this.lock !== null) return null;
    this.voidRemote();
    const context: RemoteReadContext = Object.freeze({ remoteReadContext: true as const });
    this.remote = context;
    return context;
  }

  /** The entry voids the context (the generation, the identity or the document changed). */
  voidRemoteReadContext(context?: RemoteReadContext | null): void {
    if (!context || context === this.remote) this.voidRemote();
  }

  remoteReadContextLive(context: RemoteReadContext | null | undefined): boolean {
    return !!context && context === this.remote && !this.closedWindow && !this.disposed;
  }

  private voidRemote(): void {
    const old = this.remote;
    if (!old) return;
    this.remote = null;
    for (const [ticket, issued] of this.tickets) if (issued.remote?.context === old) this.tickets.delete(ticket);
    const cancelled = this.remoteDeferred;
    this.remoteDeferred = [];
    for (const job of cancelled) job.cancel("cancelled");
  }

  /**
   * R10 п.2: the one-shot ticket of the registered own `session.stop_remote` of commandId, bound to the context and to this
   * registration. Another family, an unknown or a settled ID, a dead context: no ticket (zero transfers). Hidden: waits.
   */
  runRemoteReadback<T>(context: RemoteReadContext, commandId: string, fn: (ticket: ReadbackTicket) => Promise<T>): Promise<T> {
    if (this.closedWindow) return Promise.reject(new PausedBeforeSendError("closed_window"));
    if (this.disposed || context !== this.remote) return Promise.reject(new PausedBeforeSendError("cancelled"));
    const registration = this.registry.get(commandId);
    if (!registration || registration.family !== "stop_remote" || registration.resolved) {
      return Promise.reject(new PausedBeforeSendError("no_ticket"));
    }
    return new Promise<T>((resolve, reject) => {
      const job: Deferred = {
        commandId, remote: context,
        start: () => {
          if (context !== this.remote || this.registry.get(commandId) !== registration) {
            reject(new PausedBeforeSendError("cancelled"));
            return;
          }
          const ticket: ReadbackTicket = Object.freeze({ readbackTicket: true as const });
          this.tickets.set(ticket, { commandId, doc: null, remote: { context, registration } });
          let run: Promise<T>;
          try { run = Promise.resolve(fn(ticket)); } catch (error) { run = Promise.reject(error); }
          run.finally(() => { this.tickets.delete(ticket); }).then(resolve, reject);
        },
        cancel: reason => reject(new PausedBeforeSendError(reason)),
      };
      if (this.visible) job.start();
      else this.remoteDeferred.push(job);
    });
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
    const remote = this.remoteDeferred.filter(job => job.commandId === commandId);
    this.remoteDeferred = this.remoteDeferred.filter(job => job.commandId !== commandId);
    for (const job of remote) job.cancel("cancelled");
    for (const [ticket, issued] of this.tickets) if (issued.remote && issued.commandId === commandId) this.tickets.delete(ticket);
    this.settleRound();
    this.emit({ type: "changed" });
  }

  /**
   * Z3/R5: the outcome of a readback. A definite one takes the ID out of the round and of familyLocks; an indefinite one
   * (stale, window_stale, a storage error, a malformed record) takes it out of the round into familyLocks. The checks of
   * requestId/doc/episode of a reply (§2 п.3) belong to the decoders (M-P03-10).
   */
  resolvePending(commandId: string, outcome: DefiniteOutcome | IndefiniteOutcome, stamp?: RequestStamp): void {
    if (this.closedWindow || this.disposed) return;
    // §2 п.3: a decoder that names its request is heard only for the current request, document and episode (AC-89).
    if (stamp && !this.currentStamp(stamp)) return;
    const entry = this.registry.get(commandId);
    const endsEpisode = !!this.episode?.withPending && DEFINITE.has(outcome) && this.anchor() === commandId;
    if (DEFINITE.has(outcome)) {
      if (entry) entry.resolved = true;
      this.familyLocks.delete(commandId);
    } else this.familyLocks.add(commandId);
    this.lock?.round.delete(commandId);
    this.settleRound();
    if (endsEpisode) this.finishEpisode();
    else if (this.episode?.withPending && this.anchor() === null) this.episode.withPending = false; // §2 п.1 → п.2
    this.emit({ type: "changed" });
  }

  /**
   * §2 п.1: the anchor of an episode begun with pending — the command whose request failed. Once it is settled otherwise,
   * unregistered or family-locked by an indefinite readback, the next not locked one takes its place (the lock of the old
   * anchor stays); with only locked ones left, the first of them. Registration order stands for creation order.
   */
  private anchor(): string | null {
    const episode = this.episode;
    const current = episode?.anchor ?? null;
    if (current !== null) {
      const entry = this.registry.get(current);
      if (entry && !entry.resolved && !this.familyLocks.has(current)) return current;
    }
    let locked: string | null = null;
    for (const [id, entry] of this.registry) {
      if (entry.resolved) continue;
      if (!this.familyLocks.has(id)) { if (episode) episode.anchor = id; return id; }
      locked ??= id;
    }
    if (episode && locked !== null) episode.anchor = locked;
    return locked;
  }

  /** The first registered pending without a definite answer (registration order stands for creation order). */
  private firstUnsettled(): string | null {
    for (const [id, entry] of this.registry) if (!entry.resolved) return id;
    return null;
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
    // AC-11b / ВР-3: the round of an identity lock is read only in a visible window; shown again, it goes (setVisible).
    if (this.lock && !this.visible) return false;
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
    if (issued.remote) {
      // R10 п.2: live context, the same registration of the owner, right before the network.
      if (issued.remote.context !== this.remote || this.registry.get(commandId) !== issued.remote.registration) return false;
    } else if (issued.doc && !sameDoc(issued.doc, this.gateDoc())) return false;
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
      openAttempts: [...this.openAttempts],
      retryAfter403Doc: this.retryAfter403Doc,
      lastRecoveryForegroundSentAt: this.lastRecoveryForegroundSentAt,
      recoveryForegroundInFlight: this.recoveryForegroundInFlight,
      remoteReadContext: this.remote !== null,
    };
  }

  private emit(event: GateEvent): void {
    for (const listener of [...this.listeners]) {
      try { listener(event); } catch { /* a subscriber's error never changes the gate */ }
    }
  }
}
