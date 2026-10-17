import type { RecoveryClock, RecoveryTimer } from "./recoveryClock";
import { MAX_SENDS, PROBE_DELAYS_MS, RETRY_PAUSES_MS } from "./recoveryLimits";
import { checkFailure, sendFailure, type CheckResult, type SendResult, type TerminationReason } from "./recoveryReplies";
import { recordOutcome, type RecoveryBudget } from "./intentBudget";
import { budgetVerdict, type BudgetSummary, type CreateResult, type ReserveResult, type SlotClaim } from "./sendBudget";
import { journalNoteAttempt, journalRecord } from "../journal/clientJournal";
import type { WriteGate } from "./writeGate";
import { RETRY_AFTER_MAX_S } from "../api/http";

export { MAX_SENDS, PROBE_DELAYS_MS, RETRY_PAUSES_MS };

/** DESIGN D-RECOV table 3. attempt is the number of the send (1–6) the state performs or prepares. */
export type RecoveryState =
  | { name: "idle" }
  | { name: "sending"; attempt: number }
  | { name: "checking" }
  | { name: "pre_send_check"; attempt: number }
  | { name: "unreachable"; probe: number; pauseSeconds: number | null }
  /**
   * A planned pause (503 MAINTENANCE): held until a light probe confirms its end, through the background as well; no
   * POST before that. budgetSpent: all six sends are used and the last one met the pause — the machine stays here
   * instead of an exhaustion, because a planned pause must not close the quiz (TC §11; root decision, pending owner).
   */
  | { name: "maintenance"; probe: number; pauseSeconds: number | null; budgetSpent: boolean }
  | { name: "retry_wait"; attempt: number; dueAt: number }
  /**
   * Absence confirmed, but no send is allowed: the count is unknown ("unknown"), or all six sends are reserved while
   * fewer than six provably went out ("unconfirmed"; root decision, pending owner). Only checks, never an exhaustion.
   */
  | { name: "counter_unknown"; check: number; cause: "unknown" | "unconfirmed" }
  /** DOCUMENT_STALE: nothing is sent until the window check decides whether this window was replaced (Р6). */
  | { name: "window_check" }
  | { name: "suspended" }
  | { name: "settled"; outcome: "accepted" | "rejected" }
  /** A definite HTTP refusal of the write (422 VALIDATION_FAILED, 409 VERSION_CONFLICT); no retry (root decision, pending owner). */
  | { name: "refused"; code: string }
  /** Six sends provably went out and the server confirmed absence: the session must be closed (Я15.8, done by CP4). */
  | { name: "exhausted" }
  /**
   * keepChecking: no send may follow any more (cause), but the fact may still appear, so it is checked on the probe
   * schedule; a recorded fact still settles it. check is the place in that series; code names a refusal.
   */
  | { name: "checks_only"; check: number; cause: ChecksOnlyCause; code: string | null }
  /**
   * Decision 2.3 А (owner, C109): the action was created by another window or by the page before a reload. Its fact is
   * checked on the probe schedule and a recorded fact still settles it, but it is never sent from here, whatever the
   * count says. Not an exhaustion, not a lost connection, not an unknown count: the count and the record stay as they are.
   */
  | { name: "origin_elsewhere"; check: number }
  /** Я17: the same command_id carries another payload; nothing is sent any more. */
  | { name: "conflict" }
  | { name: "terminated"; reason: TerminationReason }
  | { name: "disposed" };

/**
 * Why a keepChecking command sends nothing more: six sends provably went out and absence is confirmed ("exhausted"),
 * a send got a definite refusal ("refused"), a send was answered with another payload under its ID ("mismatch"), or
 * the shared count says an earlier owner forbade the sends for one of those reasons ("forbidden"; the reason is not kept).
 */
export type ChecksOnlyCause = "exhausted" | "refused" | "mismatch" | "forbidden";

export type RecoverySnapshot = {
  state: RecoveryState;
  /** Reserved sends of this command_id (the limit counts these); null when the count cannot be established. */
  sends: number | null;
  /** Sends that provably went out; null with an unknown count. */
  transmitted: number | null;
  remaining: number | null;
  active: boolean;
};

/**
 * The pre-request path of one send (CP5b; C555 п.2). prepare is the last await before the request: it commits the slot of
 * this attempt to "sending" and re-checks the document; false — no request may be made (the send then rejects with
 * NotPreparedError or resolves not_sent). From its true answer to fetch everything runs in one synchronous stretch:
 * the write gate L1, started, the transport's L2 and fetch. started is told right when the request really starts.
 */
export type RequestHooks = {
  prepare(): Promise<boolean>; started(): void;
  /** The send of the recovery machine (an automatic study step); a counted manual send (a start) has none. */
  automatic?: true;
};

/**
 * The network of one action. send must await hooks.prepare() as its last step before the request, call hooks.started()
 * right when the request really starts (fetch begins), and resolve not_sent (or reject with ClosedAccessError) only when
 * nothing went out. send and check may reject: the machine then classifies the error itself (recoveryReplies). check
 * must already include the targeted read and the right to continue (CT §6.1 п. 5).
 */
export interface RecoveryPorts<I> {
  send(intent: I, hooks: RequestHooks): Promise<SendResult>;
  check(intent: I): Promise<CheckResult>;
  /** The light availability probe; it proves nothing about the action and never spends the budget. */
  probe(): Promise<boolean>;
  /** False once another window took the work or the document closed. */
  isLive(): boolean;
  /**
   * The window check a DOCUMENT_STALE asks for (EntryController.documentStale → foreground check). Resolves once it
   * has settled: true when this window is still the live one (e.g. only a card context was closed), false when it was
   * replaced. isLive() is read again afterwards and must agree.
   */
  windowCheck(): Promise<boolean>;
  /**
   * Decision 2.3 А: whether this window may send this intent at all. Asked right before every send, synchronously and
   * before the reservation, so a refusal reserves, releases and writes nothing (C081 Н2). Absent = allowed (start cancel).
   */
  maySend?(): boolean;
  /**
   * The write gate of the page (P03 M-P03-6). When given, it replaces the light probe and the machine's own send_hold:
   * the machine never probes by itself, waits for the gate (its ready and the end of send_hold, then a fresh probe when
   * the ready is older than 10 s), and reserves and sends only while gate.mayWrite(command_id) (I5). A refusal of the
   * gate before the request (PAUSED_BEFORE_SEND) is not_sent: the reservation goes back and the machine waits again.
   */
  gate?: WriteGate;
}

/**
 * What an earlier owner of the same document knew about the next send (CT §6.1 п. 4): next is the number of that send,
 * dueAt the end of its pause counted from the loss it found (null: no loss was found, e.g. it only met a planned pause),
 * holdUntil the end of a planned pause the server announced (null: none). Times are on the clock of this page: the
 * memory of one page only, the monotonic clock does not survive a reload. A candidate to shorten the wait, never a right
 * to send: a send still needs a known count and a check that confirmed absence right before it.
 */
export type KnownLoss = { next: number; dueAt: number | null; holdUntil: number | null };

export type RecoveryOptions<I extends { command_id: string }> = {
  intent: I;
  ports: RecoveryPorts<I>;
  /** The durable budget of this intent (CP5b): slots with their own attempt IDs; no count lives in this machine. */
  budget: RecoveryBudget;
  clock: RecoveryClock;
  /**
   * The window is visible and its document live (Я15.7, RESULTS_VP 9.1.5): a fresh open handle after a return. The study
   * route and confirmed settings do not count.
   */
  active: boolean;
  /**
   * Keep checking the fact of a command that may not send any more, instead of stopping (checks_only). For
   * session.cancel_start (D-CP2C-START 2.4.1б.3; C038 п. 3): after a proven exhaustion, a definite refusal of a send or
   * another payload answered to a send, a copy sent earlier may still apply, and only a check finds it. No POST follows
   * any of them; a recorded fact settles it, a conflict confirmed by a check ends it. Off by default: a study action
   * stops there (CP4 closes its session after the exhaustion, Я17 shows the conflict).
   */
  keepChecking?: boolean;
  /**
   * resume only: the loss an earlier owner of this command_id found in the same document. It shortens nothing below
   * the pause of that loss and gives no send of its own: it applies only to the same send number of the loaded count.
   */
  knownLoss?: KnownLoss | null;
  /** The earliest moment of the next send changed (null: nothing is due any more, the action settled). */
  onLoss?(loss: KnownLoss | null): void;
  onUpdate?(snapshot: RecoverySnapshot): void;
};

/** The count of a new intent before its record exists: nothing reserved, nothing sent. */
const EMPTY: BudgetSummary = { occupied: 0, transmitted: 0, unsettled: 0, manualUnsettled: false, lastMaintenance: false, loss: null, forbidden: false };

/** States after which the machine sends and checks nothing any more. */
export const FINAL_RECOVERY_STATES: ReadonlySet<RecoveryState["name"]> = new Set(["settled", "refused", "exhausted", "conflict", "terminated", "disposed"]);
const FINAL = FINAL_RECOVERY_STATES;

/** The pause before send number next (1 = the first send, which needs none). */
function pauseBefore(next: number): number {
  return next <= 1 ? 0 : RETRY_PAUSES_MS[Math.min(next, MAX_SENDS) - 2];
}
function probeDelay(index: number): number {
  return PROBE_DELAYS_MS[Math.min(index, PROBE_DELAYS_MS.length) - 1];
}

/**
 * Automatic recovery of one study action with one command_id (CT §6.1, DESIGN D-RECOV scheme 2.3). Three parts stay
 * apart: a light probe only waits for the server, a fact check reads the command and its target, and only a send
 * spends the budget. A send always follows a check that confirmed absence right before it; an unknown outcome or an
 * unknown count never sends, and no answer of the server gives a send back. In the background every timer stops and
 * nothing is requested; a return starts with a check. The machine owns no storage and no screen: the lane adapter
 * gives it the network, the clock and the durable budget of the intent (CP5b). Every decision to send reads that budget
 * afresh; the counts it keeps between two reads only feed the snapshot.
 */
export class RecoveryMachine<I extends { command_id: string }> {
  private readonly intent: I;
  private readonly ports: RecoveryPorts<I>;
  private readonly budget: RecoveryBudget;
  private readonly clock: RecoveryClock;
  private readonly onUpdate: ((snapshot: RecoverySnapshot) => void) | undefined;
  private readonly keepChecking: boolean;
  private readonly knownLoss: KnownLoss | null;
  private readonly onLoss: ((loss: KnownLoss | null) => void) | undefined;
  private state: RecoveryState = { name: "idle" };
  /** The last known count of the record (a fresh load before every decision, local steps in between); null: unknown. */
  private summary: BudgetSummary | null = null;
  /** The record of this intent may exist: false only for a new intent before its first reservation was committed. */
  private created = false;
  /** C556 В1: the explicit press of «Повторить завершение» this check and send serve. */
  private manualPress = false;
  /** MA-13 c.budget is told once per machine, even when a manual press comes back to the exhausted state. */
  private budgetTold = false;
  /** discard ran: its clear is the last operation of this machine on the record; nothing of an attempt follows it. */
  private discarded = false;
  private active: boolean;
  /** Every stop starts a new generation: a reply or a timer of an older one never acts. */
  private generation = 0;
  private timer: RecoveryTimer | null = null;
  private ready: Promise<void> = Promise.resolve();
  /** Budget operations in call order: a mark of an attempt never overtakes its reservation, a decision waits for both. */
  private writes: Promise<unknown> = Promise.resolve();
  private emitted: string | null = null;
  private retryDueAt: number | null = null;
  /** The end of a planned pause the server announced: no probe and no send before it. */
  private holdUntil: number | null = null;
  private probes = 0;
  /** The place in the series of checks that may not send (counter_unknown, checks_only). */
  private quietChecks = 0;
  /** keepChecking: set once no send may follow any more; never cleared. */
  private sendsClosed: { cause: ChecksOnlyCause; code: string | null } | null = null;
  /** Inside a planned pause until a probe answers; survives the background. */
  private paused = false;
  private pauseSeconds: number | null = null;
  /** The subscription to the write gate while the machine waits for it (gate mode only). */
  private gateWait: (() => void) | null = null;

  constructor(options: RecoveryOptions<I>) {
    this.intent = structuredClone(options.intent);
    this.ports = options.ports;
    this.budget = options.budget;
    this.clock = options.clock;
    this.onUpdate = options.onUpdate;
    this.keepChecking = options.keepChecking ?? false;
    this.knownLoss = options.knownLoss ?? null;
    this.onLoss = options.onLoss;
    this.active = options.active;
  }

  snapshot(): RecoverySnapshot {
    const summary = this.summary;
    return { state: { ...this.state }, sends: summary?.occupied ?? null, transmitted: summary?.transmitted ?? null,
      remaining: summary === null ? null : this.sendsClosed ? 0 : MAX_SENDS - summary.occupied, active: this.active };
  }

  /** A new action: the first send. */
  begin(): void {
    if (this.state.name !== "idle") return;
    this.summary = { ...EMPTY };
    if (this.active) void this.send();
    else this.enter({ name: "suspended" });
  }

  /** A pending action found on open, reload or another document: the count comes from the budget, then a check. */
  resume(): void {
    if (this.state.name !== "idle") return;
    this.created = true;
    // A check waits for the count, so a return from the background meanwhile cannot check against "unknown".
    this.ready = this.budget.load().then((summary) => {
      if (this.state.name === "disposed") return;
      this.summary = summary;
      // A ban stored with the count (another owner, a durable count after a reload): only checks from now on.
      if (this.summary?.forbidden && !this.sendsClosed) this.sendsClosed = { cause: "forbidden", code: null };
      // What an earlier owner of this document knew: only for the very send it was waiting for. An announced planned
      // pause only ever grows; the loss time only replaces the full pause a resumed machine would otherwise wait.
      const known = this.knownLoss;
      if (known && this.summary && known.next === this.summary.occupied + 1) {
        if (known.dueAt !== null && this.retryDueAt === null) this.retryDueAt = known.dueAt;
        if (known.holdUntil !== null && (this.holdUntil === null || known.holdUntil > this.holdUntil)) this.holdUntil = known.holdUntil;
      }
    });
    if (this.active) void this.check("checking");
    else this.enter({ name: "suspended" });
  }

  /** The window became active (true) or went to the background / another route (false). */
  setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    // Nothing runs before begin/resume or after the end; a final snapshot is not repeated.
    if (FINAL.has(this.state.name) || this.state.name === "idle") return;
    if (!active) { this.enter({ name: "suspended" }); return; }
    // A return restarts the light probes at 5 s (Q35.3), inside a planned pause as well; the spent sends stay spent.
    this.probes = 0;
    this.quietChecks = 0;
    // Inside a planned pause a return starts with a probe (not before the announced end), never with a check or a POST.
    // Like the fact check of an ordinary return it stands before the series, so the series still starts at 5 s.
    if (this.paused) { this.probeAfter(0, this.pauseSeconds, false); return; }
    // A return checks the fact at once, not a light probe (question 11.3); a failed check starts a new episode.
    void this.check("checking");
  }

  /**
   * C556 В1 / Q30: one explicit press of «Повторить завершение» once the automatic budget of this closure C is provably
   * spent. A check of C and of the open session comes first; only its confirmed absence sends, once, through the manual
   * attempt of the record. The six automatic sends stay spent. false: nothing to do in this state.
   */
  manual(): boolean {
    if (this.state.name !== "exhausted" || this.keepChecking || !this.active) return false;
    this.manualPress = true;
    this.probes = 0;
    this.quietChecks = 0;
    void this.check("pre_send_check");
    return true;
  }

  /** The document stopped being live, or the adapter learned another reason to stop (CT §6.1 п. 7). */
  terminate(reason: TerminationReason): void {
    if (!FINAL.has(this.state.name)) this.enter({ name: "terminated", reason });
  }

  dispose(): void {
    this.stop();
    this.state = { name: "disposed" };
  }

  /**
   * The intent never existed beyond this window: its first send was refused locally before any request could start (its
   * lane refused to store it, so the pre-request step never ran). Drop the machine and its record, after every
   * operation already queued; a late step of the attempt then finds no record and writes nothing.
   */
  discard(): void {
    this.summary = null;
    this.discarded = true;
    this.queue(() => this.budget.clear()).catch(() => undefined);
    this.dispose();
  }

  private emit(): void {
    if (this.state.name === "disposed" || !this.onUpdate) return;
    const snapshot = this.snapshot(), key = JSON.stringify(snapshot);
    if (key === this.emitted) return;
    this.emitted = key;
    this.onUpdate(snapshot);
  }
  private stop(): void {
    this.generation++;
    if (this.timer !== null) this.clock.cancel(this.timer);
    this.timer = null;
    this.gateWait?.();
    this.gateWait = null;
  }
  /** Leave the current state: older replies and timers are silenced. */
  private enter(state: RecoveryState): void {
    if (this.state.name === "disposed") return;
    this.stop();
    const from = this.state.name;
    this.state = state;
    // The client journal (events TZ §4.5 c.recovery): a change of state, never a step inside one (a probe, a check).
    if (from !== state.name) {
      // The journal's closed list has no reauth (P04): it is told as the access_lost it was before M-P03-7.
      journalRecord({ ev: "c.recovery", cmd: this.intent.command_id, from, to: state.name,
        ...(state.name === "terminated" ? { reason: state.reason === "reauth" ? "access_lost" : state.reason } : {}) });
    }
    this.emit();
  }
  private after(delayMs: number, action: () => void): void {
    const generation = this.generation;
    this.timer = this.clock.schedule(() => {
      if (generation !== this.generation) return;
      this.timer = null;
      action();
    }, Math.max(0, delayMs));
  }
  private liveOrTerminate(): boolean {
    if (this.ports.isLive()) return true;
    this.enter({ name: "terminated", reason: "window_replaced" });
    return false;
  }
  /** One budget operation after every one queued before it; its failure never stops the queue. */
  private queue<R>(operation: () => Promise<R>): Promise<R> {
    const task = this.writes.then(operation);
    this.writes = task.catch(() => undefined);
    return task;
  }
  /** The count as the store holds it now, after every operation this machine queued (RD 7.2). */
  private fresh(): Promise<BudgetSummary | null> {
    return this.queue(() => this.budget.load()).catch(() => null);
  }

  /**
   * Only notRecorded (and begin) calls this, with a count that allows the send. The attempt reserves its own slot first
   * (a new intent creates its record, a retry reserves the next slot, a manual press of a closure its manual attempt).
   * The request itself waits for the pre-request step (hooks.prepare): the slot goes to "sending" before it may leave.
   */
  private async send(): Promise<void> {
    const before = this.summary!;
    const manual = this.manualPress;
    const attempt = manual ? MAX_SENDS + 1 : before.occupied + 1;
    if (!this.liveOrTerminate()) return;
    // 2.3 А: the last gate before the reservation and the network; no await between it and the reservation below.
    if (!this.mayResend()) { this.manualPress = false; this.originElsewhere(); return; }
    // I5 (M-P03-6): no reservation while the write gate holds writes; the send waits for it and a new check.
    if (!this.writable()) { this.manualPress = false; this.waitForGate(); return; }
    this.enter({ name: "sending", attempt });
    const generation = this.generation;
    const id = this.budget.newAttempt();
    const first = !this.created;
    const reserved = await this.queue<CreateResult | ReserveResult | null>(() => manual ? this.budget.reserveManual(id)
      : first ? this.budget.create(id) : this.budget.reserve(id));
    if (reserved?.outcome === "reserved" || reserved?.outcome === "exists" || reserved?.outcome === "forbidden") this.created = true;
    if (reserved?.outcome !== "reserved") {
      // Nothing was reserved: no request. The store refused (a ban, a damaged store, another attempt under way, a record
      // of another envelope) or failed — the count is unknown or forbids the send; only checks follow.
      this.manualPress = false;
      if (generation !== this.generation) return;
      if (reserved?.outcome === "forbidden") { this.forbidden(); return; }
      this.summary = null;
      this.counterUnknown();
      return;
    }
    const claim = reserved.claim;
    this.summary = manual ? { ...before, manualUnsettled: true }
      : { ...before, occupied: before.occupied + 1, unsettled: before.unsettled + 1 };
    // Stopped between the reservation and the network (background, terminate, another window): provably not sent.
    if (generation !== this.generation || !this.liveOrTerminate()) { this.manualPress = false; this.release(claim, manual); return; }
    let prepared = false, started = false;
    const hooks: RequestHooks = {
      automatic: true,
      prepare: async () => {
        // Checked before the slot moves as well: a document or a gate that changed already gives the reservation back.
        if (prepared || generation !== this.generation || !this.ports.isLive() || !this.mayResend() || !this.writable()) return false;
        const sending = await this.queue(() => this.budget.beginSending(claim));
        if (!sending) return false;
        prepared = true;
        // The final guard after the asynchronous step (C555 п.2): from a true answer to fetch nothing awaits any more.
        // A false answer now leaves the slot "sending": the request did not leave, but the slot is not given back (C555 п.4).
        return generation === this.generation && this.ports.isLive() && this.mayResend() && this.writable();
      },
      started: () => {
        if (started || !prepared) return;
        started = true;
        this.transmitted(claim, manual);
      },
    };
    let result: SendResult;
    journalNoteAttempt(this.intent.command_id, attempt);
    try { result = await this.ports.send(structuredClone(this.intent), hooks); }
    catch (error: unknown) { result = sendFailure(error); }
    if (result.kind === "not_sent") {
      if (started) result = { kind: "lost", cause: "network" };
      // Still only reserved: the attempt gives its slot back. After "sending" it is kept: the outcome is not provable.
      else if (!prepared) this.release(claim, manual);
    } else if (result.kind !== "lost" && !started) {
      // Any answer of the server proves the request went out; a lost reply proves nothing either way.
      if (!prepared && !this.discarded) this.queue(() => this.budget.beginSending(claim)).catch(() => undefined);
      prepared = true;
      hooks.started();
    }
    this.manualPress = false;
    if (started) this.outcomeOf(result, claim, manual);
    if (generation !== this.generation) return;
    this.sent(result);
  }

  /** Count one more send that provably went out; the store marks it transmitted after its "sending". */
  private transmitted(claim: SlotClaim, manual: boolean): void {
    if (this.discarded) return;
    if (!manual && this.summary !== null) this.summary = { ...this.summary, transmitted: this.summary.transmitted + 1 };
    this.queue(() => this.budget.markTransmitted(claim)).catch(() => undefined);
  }

  /**
   * What the answer of a sent attempt writes into its slot (C060): a lost reply or an answer that allows a retry makes it
   * retryable; a refusal or another payload bans new sends (C053). A settled answer is written by settle.
   */
  private outcomeOf(result: SendResult, claim: SlotClaim, manual: boolean): void {
    if (this.discarded) return;
    switch (result.kind) {
      case "lost": case "maintenance": case "window_stale": case "terminated": case "incompatible":
        if (this.summary !== null) {
          this.summary = manual ? { ...this.summary, manualUnsettled: false }
            : { ...this.summary, unsettled: Math.max(0, this.summary.unsettled - 1) };
        }
        this.queue(() => this.budget.markRetryable(claim)).catch(() => undefined);
        return;
      case "refused": case "mismatch": this.forbid(); return;
      default: return;
    }
  }

  /** Give back a reservation whose request provably never started; a failed write keeps the higher, safe count. */
  private release(claim: SlotClaim, manual: boolean): void {
    if (this.discarded) return;
    void this.queue(() => this.budget.release(claim)).then(released => {
      if (!released || this.summary === null) return;
      this.summary = manual ? { ...this.summary, manualUnsettled: false }
        : { ...this.summary, occupied: Math.max(0, this.summary.occupied - 1), unsettled: Math.max(0, this.summary.unsettled - 1) };
    }, () => undefined);
  }

  private sent(result: SendResult): void {
    const streak = this.summary?.lastMaintenance === true;
    if (result.kind !== "not_sent") this.markMaintenance(result.kind === "maintenance");
    switch (result.kind) {
      case "settled": this.settle(result.outcome, result.code); return;
      // keepChecking: the conflict is confirmed by a check of the same ID before it ends the work; never sent again.
      case "mismatch": if (this.keepChecking) this.closeSends("mismatch", null); else this.enter({ name: "conflict" }); return;
      case "terminated": this.enter({ name: "terminated", reason: result.reason }); return;
      // As after a lost reply: the next pause runs from this answer once the window check keeps the window.
      case "window_stale": this.lose(); void this.windowCheck(); return;
      case "refused": if (this.keepChecking) this.closeSends("refused", result.code); else this.enter({ name: "refused", code: result.code }); return;
      // The spent send stays spent; no further POST is possible for this client version.
      case "incompatible": this.enter({ name: "terminated", reason: "client_incompatible" }); return;
      case "maintenance":
        // A planned pause: the send stays spent, and its announced end bounds both the next probe and the next send.
        this.hold(result.waitSeconds);
        this.lose();
        // Pauses in a row (a probe that answers during the pause) keep growing the probe schedule.
        this.pause(result.waitSeconds, streak);
        return;
      case "lost": this.lose(); void this.check("checking"); return;
      // Nothing went out (e.g. a closed access handle): wait on the probe schedule, then check; never a tight loop.
      // A refusal of the write gate (L1/L2) waits for the gate instead (M-P03-6).
      case "not_sent": if (!this.writable()) this.waitForGate(); else this.unreachable(null, false); return;
    }
  }

  /** Store whether the last answered send met a planned pause; a failed write keeps the older record. */
  private markMaintenance(met: boolean): void {
    const summary = this.summary;
    if (summary === null || summary.lastMaintenance === met) return;
    this.summary = { ...summary, lastMaintenance: met };
    this.queue(() => this.budget.setMaintenance(met)).catch(() => undefined);
  }

  /** The ban on new sends of this intent (C053), written into its record; a failed write is only a failure. */
  private forbid(): void {
    if (this.summary !== null) this.summary = { ...this.summary, forbidden: true };
    this.queue(() => this.budget.forbidSends()).catch(() => undefined);
  }

  private hold(waitSeconds: number | null | undefined): void {
    if (waitSeconds === null || waitSeconds === undefined) return;
    // With the write gate the gate's send_hold governs (§3.5, RD-4); the machine keeps its own copy of the estimate only
    // within the same bound of 900 s, so a misconfigured estimate never holds it longer than the gate would.
    const seconds = this.ports.gate ? Math.min(waitSeconds, RETRY_AFTER_MAX_S) : waitSeconds;
    const until = this.clock.now() + seconds * 1_000;
    if (this.holdUntil === null || until > this.holdUntil) this.holdUntil = until;
    this.remember();
  }
  private held(at: number): number {
    return this.holdUntil === null ? at : Math.max(at, this.holdUntil);
  }

  private lose(): void {
    this.retryDueAt = this.summary !== null ? this.clock.now() + pauseBefore(this.summary.occupied + 1) : null;
    this.remember();
  }
  /** Hand the earliest next send to the owner, so a later owner of the same document does not wait the pause again. */
  private remember(): void {
    if (this.state.name === "disposed" || this.summary === null || this.retryDueAt === null && this.holdUntil === null) return;
    this.onLoss?.({ next: this.summary.occupied + 1, dueAt: this.retryDueAt, holdUntil: this.holdUntil });
  }

  private retryWait(dueAt: number): void {
    const attempt = (this.summary?.occupied ?? 0) + 1;
    const due = this.held(dueAt);
    this.enter({ name: "retry_wait", attempt, dueAt: due });
    // The check right before the retry: the fact, the count and the right to continue (Я15.6, CT §6.1 п. 5).
    this.after(due - this.clock.now(), () => { void this.check("pre_send_check"); });
  }

  /** afterProbe: the check follows a probe that answered, so a failure continues the same unreachable episode. */
  private async check(kind: "checking" | "pre_send_check", afterProbe = false): Promise<void> {
    if (!this.liveOrTerminate()) return;
    this.enter(kind === "checking" ? { name: "checking" }
      : { name: "pre_send_check", attempt: this.manualPress ? MAX_SENDS + 1 : (this.summary?.occupied ?? 0) + 1 });
    const generation = this.generation;
    await this.ready;
    if (generation !== this.generation) return;
    // The count is read afresh alongside the check (RD 7.2): it is the store's after every operation this machine queued
    // before the check, and the reservation that may follow is atomic on the store anyway (C060). Read in parallel, it
    // adds no wait between the check's answer and the decision.
    const counted = this.created ? this.fresh() : null;
    let result: CheckResult;
    try { result = await this.ports.check(structuredClone(this.intent)); }
    catch (error: unknown) { result = checkFailure(error); }
    if (generation !== this.generation) return;
    // A press is served by this one check: any answer but a confirmed absence ends it.
    if (result.kind !== "not_recorded") this.manualPress = false;
    switch (result.kind) {
      case "recorded": this.settle(result.outcome, result.code); return;
      case "mismatch": this.enter({ name: "conflict" }); return;
      case "terminated": this.enter({ name: "terminated", reason: result.reason }); return;
      // A live window then waits on the probe schedule before the next check: a check that keeps meeting
      // DOCUMENT_STALE must not loop without a pause (Н11).
      case "window_stale": void this.windowCheck({ afterCheck: afterProbe }); return;
      case "unreachable":
        if (result.pauseSeconds === undefined) { this.unreachable(null, afterProbe); return; }
        // The check met a planned pause: the same hold as after a POST.
        this.hold(result.pauseSeconds);
        this.pause(result.pauseSeconds, afterProbe);
        return;
      // An answer older than the known state proves nothing: wait and check again, never send (2.13).
      case "stale": this.unreachable(null, afterProbe); return;
      case "not_recorded": void this.notRecorded(counted); return;
      // R8 п.2: a read the gate refused is no lost reply. cancelled: the document or the owner went away — nothing is
      // decided here (the machine is about to be disposed); a closed window ends the work; anything else waits.
      case "gate_refused":
        if (result.reason === "cancelled") return;
        if (result.reason === "closed_window") { this.enter({ name: "terminated", reason: "window_replaced" }); return; }
        this.unreachable(null, afterProbe);
        return;
    }
  }

  /**
   * Wait for the window check without sending anything (D-RECOV RESULTS_VP 9.2.1). A replaced window terminates; a
   * live one continues with a fact check, as after a lost reply, with the same remaining budget (9.2.2, 9.2.3).
   */
  private async windowCheck(paced?: { afterCheck: boolean }): Promise<void> {
    this.enter({ name: "window_check" });
    const generation = this.generation;
    let live: boolean;
    try { live = await this.ports.windowCheck(); } catch { live = this.ports.isLive(); }
    if (generation !== this.generation) return;
    if (!live || !this.ports.isLive()) { this.enter({ name: "terminated", reason: "window_replaced" }); return; }
    // After a send the fact check follows at once; after a check, the next one waits for an answering probe.
    if (paced) this.unreachable(null, paced.afterCheck);
    else void this.check("checking");
  }

  /**
   * The server confirmed absence right now: send, wait for the pause, or stop at the limit. The decision reads the
   * record afresh (RD 7.2), after every operation this machine queued; a new intent without a record keeps its zero.
   */
  private async notRecorded(counted: Promise<BudgetSummary | null> | null): Promise<void> {
    if (this.sendsClosed) { this.manualPress = false; this.checksOnly(); return; }
    if (counted) {
      const generation = this.generation;
      const summary = await counted;
      if (generation !== this.generation) return;
      this.summary = summary;
    }
    const summary = this.summary;
    if (summary === null) { this.manualPress = false; this.counterUnknown(); return; }
    // A ban written by any owner of this ID (C053): only checks from now on, whatever the count says.
    if (summary.forbidden) { this.manualPress = false; this.forbidden(); return; }
    // 2.3 А: a known count never lets another window send this action (C119): checks only, nothing written.
    if (!this.mayResend()) { this.manualPress = false; this.originElsewhere(); return; }
    // I5 (M-P03-6): absence seen while the gate holds writes decides nothing yet (T10); after ready, the end of
    // send_hold and a fresh probe the ID is read again, and only that answer counts.
    if (!this.writable()) { this.manualPress = false; this.waitForGate(); return; }
    const verdict = budgetVerdict(summary);
    if (this.manualPress) {
      // C556 В1: the press sends once more only while the automatic budget is provably spent; otherwise it changes nothing.
      if (verdict === "exhausted") { void this.send(); return; }
      this.manualPress = false;
    }
    if (summary.occupied >= MAX_SENDS) {
      // A planned pause must not close the quiz: the last send met it, so wait in the pause instead (TC §11). With the
      // write gate the end of the pause is proven (ready, send_hold, then this readback): six provable sends are an
      // exhaustion even when the last met the pause (P03 §4.5, R2-08 Б, T18) — the endless pause ends here (M-P03-6).
      if (summary.lastMaintenance && !this.ports.gate) this.pause(this.pauseSeconds, true);
      // Only six sends that provably went out, each written retryable, make the budget truly spent (Я15.8, C081).
      else if (verdict === "exhausted") this.exhausted();
      else this.counterUnknown();
      return;
    }
    // A taken slot whose outcome nobody wrote (another attempt under way, a request that may have left): no send (C060).
    if (verdict !== "can_send") { this.counterUnknown(); return; }
    const now = this.clock.now();
    // No known loss time (a resumed action without one): the full pause from now.
    if (this.retryDueAt === null) { this.retryDueAt = now + pauseBefore(summary.occupied + 1); this.remember(); }
    const due = this.held(this.retryDueAt);
    if (now >= due) void this.send();
    else this.retryWait(this.retryDueAt);
  }

  /**
   * Wait for the server: light probes 5, 10, 20, then 30 s, only while active (timers stop otherwise). A failed check
   * right after an answering probe continues the episode; anything else starts a new one (question 11.3).
   */
  private unreachable(pauseSeconds: number | null, sameEpisode: boolean): void {
    if (!sameEpisode) this.probes = 0;
    this.quietChecks = 0;
    this.nextProbe(pauseSeconds);
  }

  /** Enter or continue a planned pause: probes on the same schedule, none before the announced end. */
  private pause(pauseSeconds: number | null, sameEpisode: boolean): void {
    this.paused = true;
    this.pauseSeconds = pauseSeconds;
    this.unreachable(pauseSeconds, sameEpisode);
  }

  private nextProbe(pauseSeconds: number | null): void {
    this.probeAfter(probeDelay(this.probes + 1), pauseSeconds);
  }

  /** inSeries false: a probe outside the schedule (a return in a pause); it does not move the series on. */
  private probeAfter(delayMs: number, pauseSeconds = this.pauseSeconds, inSeries = true): void {
    // M-P03-6: the gate owns the series (RD-5); a closed gate is waited for, never probed from here, and a return from
    // the background starts no probe of its own (RD-3).
    if (!this.writable()) { this.waitForGate(); return; }
    const probe = this.probes + 1;
    this.enter(this.paused
      ? { name: "maintenance", probe, pauseSeconds, budgetSpent: (this.summary?.occupied ?? 0) >= MAX_SENDS }
      : { name: "unreachable", probe, pauseSeconds });
    const now = this.clock.now();
    this.after(this.held(now + delayMs) - now, () => { void this.runProbe(inSeries ? probe : this.probes, pauseSeconds); });
  }

  /** probe: the place in the series once this probe has run (unchanged for a probe outside it). */
  private async runProbe(probe: number, pauseSeconds: number | null): Promise<void> {
    if (!this.liveOrTerminate()) return;
    const generation = this.generation;
    this.probes = probe;
    // M-P03-6: with the gate this pacing only spaces the checks of an open gate; the gate itself is never probed here.
    if (this.ports.gate) {
      if (!this.writable()) this.waitForGate();
      else void this.afterGate(generation);
      return;
    }
    let reachable: boolean;
    try { reachable = await this.ports.probe(); } catch { reachable = false; }
    if (generation !== this.generation) return;
    if (!reachable) { this.nextProbe(pauseSeconds); return; }
    // Only an answering probe ends a planned pause; the fact check (and only then a POST) follows.
    this.paused = false;
    void this.check("checking", true);
  }

  private mayResend(): boolean { return this.ports.maySend?.() ?? true; }

  /** I5 п.1–2: the gate lets a write of this ID through now (ready after the last closure, send_hold over, no lock). */
  private writable(): boolean { return !this.ports.gate || this.ports.gate.mayWrite(this.intent.command_id); }

  /**
   * Wait for the write gate (M-P03-6): the screen state follows its cause (a planned pause or an announced hold:
   * maintenance; otherwise unreachable); nothing is probed, checked or sent until it lets a write through again.
   */
  private waitForGate(): void {
    const gate = this.ports.gate;
    if (!gate) { this.unreachable(null, false); return; }
    const snapshot = gate.snapshot();
    const planned = snapshot.net.kind === "closed" && snapshot.net.cause === "maintenance" || gate.holdActive();
    // §4.8 (M-P03-9): the estimate of 9.2.4 is what is left of the gate's announced hold (bounded by §3.5); once an
    // estimate passed while the pause goes on, 0 (maintenanceOver); none announced — no number.
    const estimate = () => gate.holdActive() ? gate.holdRemainingS() : this.pauseSeconds === null ? null : 0;
    this.enter(planned
      ? { name: "maintenance", probe: this.probes + 1, pauseSeconds: estimate(), budgetSpent: (this.summary?.occupied ?? 0) >= MAX_SENDS }
      : { name: "unreachable", probe: this.probes + 1, pauseSeconds: null });
    const generation = this.generation;
    const resume = () => {
      if (generation !== this.generation || !this.active) return;
      if (!this.writable()) {
        // The hold ended (or was lengthened) while the pause goes on: the same state with its new estimate.
        if (this.state.name === "maintenance" && this.state.pauseSeconds !== estimate()) {
          this.state = { ...this.state, pauseSeconds: estimate() };
          this.emit();
        }
        return;
      }
      this.gateWait?.();
      this.gateWait = null;
      void this.afterGate(generation);
    };
    this.gateWait = gate.subscribe(resume);
    resume();
  }

  /** The gate let writes through: a fresh probe if its ready is older than 10 s (R-12), then the check by ID (I5 п.3). */
  private async afterGate(generation: number): Promise<void> {
    const gate = this.ports.gate!;
    let fresh: boolean;
    try { fresh = await gate.ensureFresh(); } catch { fresh = false; }
    if (generation !== this.generation) return;
    if (!fresh) { this.waitForGate(); return; }
    this.paused = false;
    void this.check("checking", true);
  }
  /** 2.3 А: only checks on the probe schedule; the count, the ban and the record are left untouched. */
  private originElsewhere(): void { this.quiet(check => ({ name: "origin_elsewhere", check })); }

  /** Absence confirmed but no send allowed: only checks on the probe schedule, never a send or an exhaustion. */
  private counterUnknown(): void {
    const cause = this.summary === null ? "unknown" : "unconfirmed";
    this.quiet(check => ({ name: "counter_unknown", check, cause }));
  }

  /** Six sends provably went out and absence is confirmed: the end, or only checks from now on (keepChecking). */
  private exhausted(): void {
    // MA-13: the automatic sends are spent (six went out and absence is confirmed). Once: a manual press may come back here.
    if (!this.budgetTold) {
      this.budgetTold = true;
      journalRecord({ ev: "c.budget", cmd: this.intent.command_id, n: this.summary?.transmitted ?? MAX_SENDS, outcome: "failed" });
    }
    if (this.keepChecking) this.closeSends("exhausted", null);
    else this.enter({ name: "exhausted" });
  }

  /** keepChecking: no send from now on, only checks of the fact (checks_only). */
  private closeSends(cause: ChecksOnlyCause, code: string | null): void {
    this.sendsClosed = { cause, code };
    // The ban goes into the record (forbidSends; outcomeOf has written it for a refusal or another payload), so every
    // later owner of this command_id — another document, a reload — only checks it (C053). A failed ban is only a
    // failure: the refused slot was never written retryable, so the record itself still forbids the next send (C060).
    // Nothing is cleared because of it (D-CP5 10.7.2.12).
    if (cause !== "exhausted" && this.summary?.forbidden !== true) this.forbid();
    this.checksOnly();
  }
  private checksOnly(): void {
    const { cause, code } = this.sendsClosed!;
    this.quiet(check => ({ name: "checks_only", check, cause, code }));
  }

  /** The next check of a series that may not send, after the probe delay of its place in the series. */
  private quiet(state: (check: number) => RecoveryState): void {
    const check = this.quietChecks + 1;
    this.enter(state(check));
    this.after(probeDelay(check), () => {
      this.quietChecks = check;
      void this.check("checking");
    });
  }

  /** A ban found in the record (any owner wrote it): only checks from now on (C053). */
  private forbidden(): void {
    if (!this.sendsClosed) this.sendsClosed = { cause: "forbidden", code: null };
    this.checksOnly();
  }

  private settle(outcome: "accepted" | "rejected", code?: string | null): void {
    this.enter({ name: "settled", outcome });
    this.onLoss?.(null);
    // D-CP5 9.2 / V-1: accepted and SESSION_CLOSED remove the record; any other refusal keeps it with the ban. A failed
    // write must not undo the confirmed result.
    this.queue(() => recordOutcome(this.budget, outcome, code)).catch(() => undefined);
  }
}
