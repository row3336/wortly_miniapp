import type { RecoveryClock, RecoveryTimer } from "./recoveryClock";
import { MAX_SENDS, PROBE_DELAYS_MS, RETRY_PAUSES_MS } from "./recoveryLimits";
import { checkFailure, sendFailure, type CheckResult, type SendResult, type TerminationReason } from "./recoveryReplies";
import { copyMarks, validMarks, type SendCounter, type SendMarks } from "./sendCounter";

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
 * The network of one action. send must call transmitted() right when the request really starts (fetch begins) and
 * resolve not_sent (or reject with ClosedAccessError) only when nothing went out. send and check may reject: the
 * machine then classifies the error itself (recoveryReplies). check must already include the targeted read and the
 * right to continue (CT §6.1 п. 5).
 */
export interface RecoveryPorts<I> {
  send(intent: I, transmitted: () => void): Promise<SendResult>;
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
}

export type RecoveryOptions<I extends { command_id: string }> = {
  intent: I;
  ports: RecoveryPorts<I>;
  counter: SendCounter;
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
  onUpdate?(snapshot: RecoverySnapshot): void;
};

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
 * gives it the network, the clock and the counter.
 */
export class RecoveryMachine<I extends { command_id: string }> {
  private readonly intent: I;
  private readonly ports: RecoveryPorts<I>;
  private readonly counter: SendCounter;
  private readonly clock: RecoveryClock;
  private readonly onUpdate: ((snapshot: RecoverySnapshot) => void) | undefined;
  private readonly keepChecking: boolean;
  private state: RecoveryState = { name: "idle" };
  private marks: SendMarks | null = null;
  private active: boolean;
  /** Every stop starts a new generation: a reply or a timer of an older one never acts. */
  private generation = 0;
  private timer: RecoveryTimer | null = null;
  private ready: Promise<void> = Promise.resolve();
  /** Counter writes in call order, so a late release can never overwrite a newer reservation. */
  private writes: Promise<void> = Promise.resolve();
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

  constructor(options: RecoveryOptions<I>) {
    this.intent = structuredClone(options.intent);
    this.ports = options.ports;
    this.counter = options.counter;
    this.clock = options.clock;
    this.onUpdate = options.onUpdate;
    this.keepChecking = options.keepChecking ?? false;
    this.active = options.active;
  }

  snapshot(): RecoverySnapshot {
    const marks = this.marks;
    return { state: { ...this.state }, sends: marks?.reserved ?? null, transmitted: marks?.transmitted ?? null,
      remaining: marks === null ? null : this.sendsClosed ? 0 : MAX_SENDS - marks.reserved, active: this.active };
  }

  /** A new action: the first send. */
  begin(): void {
    if (this.state.name !== "idle") return;
    this.marks = { reserved: 0, transmitted: 0 };
    if (this.active) void this.send();
    else this.enter({ name: "suspended" });
  }

  /** A pending action found on open, reload or another document: the count comes from the counter, then a check. */
  resume(): void {
    if (this.state.name !== "idle") return;
    // A check waits for the count, so a return from the background meanwhile cannot check against "unknown".
    this.ready = this.counter.load(this.intent.command_id).then((marks) => marks, () => null).then((marks) => {
      if (this.state.name === "disposed") return;
      this.marks = validMarks(marks) ? copyMarks({ ...marks, lastMaintenance: marks.lastMaintenance || undefined }) : null;
      // A ban stored with the count (another owner, a durable count after a reload): only checks from now on.
      if (this.marks?.forbidden && !this.sendsClosed) this.sendsClosed = { cause: "forbidden", code: null };
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

  /** The document stopped being live, or the adapter learned another reason to stop (CT §6.1 п. 7). */
  terminate(reason: TerminationReason): void {
    if (!FINAL.has(this.state.name)) this.enter({ name: "terminated", reason });
  }

  dispose(): void {
    this.stop();
    this.state = { name: "disposed" };
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
  }
  /** Leave the current state: older replies and timers are silenced. */
  private enter(state: RecoveryState): void {
    if (this.state.name === "disposed") return;
    this.stop();
    this.state = state;
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
  private save(marks: SendMarks): Promise<void> {
    const copy = { ...marks };
    const task = this.writes.then(() => this.counter.save(this.intent.command_id, copy));
    this.writes = task.catch(() => undefined);
    return task;
  }

  /** Only notRecorded calls this, with a known count below the limit. */
  private async send(): Promise<void> {
    const before = this.marks!;
    const attempt = before.reserved + 1;
    if (!this.liveOrTerminate()) return;
    this.enter({ name: "sending", attempt });
    const generation = this.generation;
    const reserved = copyMarks({ ...before, reserved: attempt });
    try {
      // The reservation is written before the network: a lost write can only over-count (CT §6.1 п. 4).
      await this.save(reserved);
    } catch {
      this.marks = null;
      if (generation === this.generation) this.counterUnknown();
      return;
    }
    this.marks = reserved;
    // Stopped between the reservation and the network (background, terminate, another window): provably not sent.
    if (generation !== this.generation || !this.liveOrTerminate()) { this.release(attempt); return; }
    let transmitted = false;
    const transmit = () => {
      if (transmitted) return;
      transmitted = true;
      this.transmitted(attempt);
    };
    let result: SendResult;
    try { result = await this.ports.send(structuredClone(this.intent), transmit); }
    catch (error: unknown) { result = sendFailure(error); }
    if (result.kind === "not_sent") {
      if (transmitted) result = { kind: "lost", cause: "network" };
      else this.release(attempt);
    } else if (result.kind !== "lost") {
      // Any answer of the server proves the request went out; a lost reply proves nothing either way.
      transmit();
    }
    if (generation !== this.generation) return;
    this.sent(result);
  }

  /** Count one more send that provably went out; a send that never reported its start stays only reserved. */
  private transmitted(attempt: number): void {
    const marks = this.marks;
    if (marks === null || marks.reserved < attempt || marks.transmitted >= marks.reserved) return;
    this.marks = copyMarks({ ...marks, transmitted: marks.transmitted + 1 });
    // A lost mark only blocks the exhaustion after a reload; it never allows another send.
    void this.save(this.marks).catch(() => undefined);
  }

  /** Give back a reservation whose request provably never started; a failed write keeps the higher, safe count. */
  private release(attempt: number): void {
    const marks = this.marks;
    if (marks === null || marks.reserved !== attempt || marks.transmitted >= attempt) return;
    const back = copyMarks({ ...marks, reserved: attempt - 1 });
    void this.save(back).then(() => {
      if (this.marks?.reserved === attempt && this.marks.transmitted === back.transmitted) this.marks = back;
    }, () => undefined);
  }

  private sent(result: SendResult): void {
    const streak = this.marks?.lastMaintenance === true;
    if (result.kind !== "not_sent") this.markMaintenance(result.kind === "maintenance");
    switch (result.kind) {
      case "settled": this.settle(result.outcome); return;
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
      case "not_sent": this.unreachable(null, false); return;
    }
  }

  /** Store whether the last answered send met a planned pause; a failed write keeps the older record. */
  private markMaintenance(met: boolean): void {
    const marks = this.marks;
    if (marks === null || (marks.lastMaintenance === true) === met) return;
    this.marks = copyMarks({ ...marks, lastMaintenance: met || undefined });
    void this.save(this.marks).catch(() => undefined);
  }

  private hold(waitSeconds: number | null | undefined): void {
    if (waitSeconds === null || waitSeconds === undefined) return;
    const until = this.clock.now() + waitSeconds * 1_000;
    if (this.holdUntil === null || until > this.holdUntil) this.holdUntil = until;
  }
  private held(at: number): number {
    return this.holdUntil === null ? at : Math.max(at, this.holdUntil);
  }

  private lose(): void {
    this.retryDueAt = this.marks !== null ? this.clock.now() + pauseBefore(this.marks.reserved + 1) : null;
  }

  private retryWait(dueAt: number): void {
    const attempt = (this.marks?.reserved ?? 0) + 1;
    const due = this.held(dueAt);
    this.enter({ name: "retry_wait", attempt, dueAt: due });
    // The check right before the retry: the fact, the count and the right to continue (Я15.6, CT §6.1 п. 5).
    this.after(due - this.clock.now(), () => { void this.check("pre_send_check"); });
  }

  /** afterProbe: the check follows a probe that answered, so a failure continues the same unreachable episode. */
  private async check(kind: "checking" | "pre_send_check", afterProbe = false): Promise<void> {
    if (!this.liveOrTerminate()) return;
    this.enter(kind === "checking" ? { name: "checking" } : { name: "pre_send_check", attempt: (this.marks?.reserved ?? 0) + 1 });
    const generation = this.generation;
    await this.ready;
    if (generation !== this.generation) return;
    let result: CheckResult;
    try { result = await this.ports.check(structuredClone(this.intent)); }
    catch (error: unknown) { result = checkFailure(error); }
    if (generation !== this.generation) return;
    switch (result.kind) {
      case "recorded": this.settle(result.outcome); return;
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
      case "not_recorded": this.notRecorded(); return;
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

  /** The server confirmed absence right now: send, wait for the pause, or stop at the limit. */
  private notRecorded(): void {
    if (this.sendsClosed) { this.checksOnly(); return; }
    const marks = this.marks;
    if (marks === null) { this.counterUnknown(); return; }
    if (marks.reserved >= MAX_SENDS) {
      // A planned pause must not close the quiz: the last send met it, so wait in the pause instead (TC §11).
      if (marks.lastMaintenance) this.pause(this.pauseSeconds, true);
      // Only six sends that provably went out make the budget truly spent (Я15.8).
      else if (marks.transmitted >= MAX_SENDS) this.exhausted();
      else this.counterUnknown();
      return;
    }
    const now = this.clock.now();
    // No known loss time (a resumed action): the full pause from now.
    if (this.retryDueAt === null) this.retryDueAt = now + pauseBefore(marks.reserved + 1);
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
    const probe = this.probes + 1;
    this.enter(this.paused
      ? { name: "maintenance", probe, pauseSeconds, budgetSpent: (this.marks?.reserved ?? 0) >= MAX_SENDS }
      : { name: "unreachable", probe, pauseSeconds });
    const now = this.clock.now();
    this.after(this.held(now + delayMs) - now, () => { void this.runProbe(inSeries ? probe : this.probes, pauseSeconds); });
  }

  /** probe: the place in the series once this probe has run (unchanged for a probe outside it). */
  private async runProbe(probe: number, pauseSeconds: number | null): Promise<void> {
    if (!this.liveOrTerminate()) return;
    const generation = this.generation;
    this.probes = probe;
    let reachable: boolean;
    try { reachable = await this.ports.probe(); } catch { reachable = false; }
    if (generation !== this.generation) return;
    if (!reachable) { this.nextProbe(pauseSeconds); return; }
    // Only an answering probe ends a planned pause; the fact check (and only then a POST) follows.
    this.paused = false;
    void this.check("checking", true);
  }

  /** Absence confirmed but no send allowed: only checks on the probe schedule, never a send or an exhaustion. */
  private counterUnknown(): void {
    const cause = this.marks === null ? "unknown" : "unconfirmed";
    this.quiet(check => ({ name: "counter_unknown", check, cause }));
  }

  /** Six sends provably went out and absence is confirmed: the end, or only checks from now on (keepChecking). */
  private exhausted(): void {
    if (this.keepChecking) this.closeSends("exhausted", null);
    else this.enter({ name: "exhausted" });
  }

  /** keepChecking: no send from now on, only checks of the fact (checks_only). */
  private closeSends(cause: ChecksOnlyCause, code: string | null): void {
    this.sendsClosed = { cause, code };
    // The ban goes into the shared count (forbidSends), so every later owner of this command_id — another document in
    // this page, a durable count after a reload — only checks it (C053). A failed ban must never leave the older, open
    // record behind: the count is then dropped, and an unknown count forbids a send as well.
    if (cause !== "exhausted") {
      if (this.marks !== null) this.marks = copyMarks({ ...this.marks, forbidden: true });
      const id = this.intent.command_id;
      this.writes = this.writes.then(() => this.counter.forbidSends(id))
        .catch(() => this.counter.clear(id)).catch(() => undefined);
    }
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

  private settle(outcome: "accepted" | "rejected"): void {
    this.enter({ name: "settled", outcome });
    // A stale count of a settled command_id is harmless; its failure must not undo the confirmed result.
    this.writes = this.writes.then(() => this.counter.clear(this.intent.command_id)).catch(() => undefined);
  }
}
