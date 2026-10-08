import type { ClosedSessionBoundary } from "../api/generated";
import { ApiError } from "../api/http";
import { sameId } from "../api/wireValidation";
import type { Pair } from "./commandLane";
import type { PendingSlot } from "./pendingSlot";
import type { RecoveryClock } from "./recoveryClock";
import { MAX_SENDS, RecoveryMachine, type RecoverySnapshot } from "./recoveryMachine";
import type { CheckResult, SendResult, TerminationReason } from "./recoveryReplies";
import type { SendCounter } from "./sendCounter";
import { startCancelIntent, type StartCancelCurrent, type StartCancelIntent, type StartCancelOutcome,
  type StartCancelReply, type StartCancelStatus } from "./startCancelApi";
import type { StartCancelPending } from "./startCancelPending";

/** How the automatic recovery of one session.start ended, as the decision to cancel it needs it. */
export type StartEnd = { recovery: RecoverySnapshot; rejectionCode: string | null };
/**
 * Whether a start that did not end in a proven exhaustion is cancelled as well: an unknown count after a reload
 * (D-CP2C-START question 5.1.1) or a temporary refusal after a lost reply (question 5.1.8). The policy only widens the
 * cancel; it never applies to an accepted start or to SESSION_CLOSED.
 */
export type StartCancelPolicy = (end: StartEnd) => boolean;
// pending owner: CL044 А-5.1.1, А-5.1.8 — an unfinished default, not an answer: no cancel beyond the proven exhaustion.
export const noFurtherCancel: StartCancelPolicy = () => false;

/** The start's own recovery allows its cancel now (CT:78, Q26-А: first up to six sends, then the cancel; 2.3). */
export function cancelDue(end: StartEnd, policy: StartCancelPolicy = noFurtherCancel): boolean {
  const { state, sends, transmitted } = end.recovery;
  // The machine reaches this only after six sends that provably went out and a confirmed absence of the start.
  if (state.name === "exhausted") return sends === MAX_SENDS && transmitted === MAX_SENDS;
  // SESSION_CLOSED is final: the number exists or is cancelled already, a cancel adds nothing (2.5.2, 3.3.24).
  if (end.rejectionCode === "SESSION_CLOSED") return false;
  const open = state.name === "counter_unknown" || state.name === "settled" && state.outcome === "rejected";
  return open && policy(end);
}

/** The document a cancel runs in; the host sends through the current open handle and never before Stop (2.4.1). */
export type StartCancelHost = {
  /** One POST of the cancel; transmitted is told right before the request starts, a refusal before it sent nothing. */
  send(intent: StartCancelIntent, transmitted: () => void): Promise<StartCancelReply>;
  /** GET /commands/{cancel_id} with the cancel's fingerprint and the session number. */
  status(intent: StartCancelIntent): Promise<StartCancelStatus>;
  isLive(): boolean;
  /** The window check a DOCUMENT_STALE asks for (RecoveryPorts.windowCheck). */
  windowCheck(): Promise<boolean>;
  /** The highest profile version this document has confirmed; an older not_found proves nothing. */
  minimumStateVersion?(): string | null;
  onUpdate(): void;
};
export type StartCancelOptions = {
  host: StartCancelHost;
  store: PendingSlot<StartCancelPending>;
  counter: SendCounter;
  clock: RecoveryClock;
  active: boolean;
  profileId: string;
  clientInstanceId: string;
  /** The pair the record is written with; a later pair change does not stop the cancel of this number (C038 п. 2). */
  pair: Pair;
  newId(): string;
};
/**
 * What the server confirmed for this number by the cancel's ID: cancelled, the session exists (R04-А), or the session
 * was created and is closed by now (a not_found of the cancel with the closure of exactly this number; C038 п. 1).
 */
export type StartCancelResult = StartCancelOutcome | "session_closed";
/**
 * Why the cancel will not settle by its automatic sends any more. Checks by its ID may still find a copy sent earlier,
 * except after status_unreadable. What the person may do then is not chosen yet: this module only reports it.
 */
export type StartCancelUnresolved =
  /** All automatic sends provably went out and absence is confirmed; checks go on. */
  | "exhausted"
  /** The count of the cancel's sends is unknown (a reload before CP5): no send at all, only checks. */
  | "counter_unknown"
  /** A send was refused (422 of a core without the cancel, or a business refusal): no send again, checks go on. */
  | "refused"
  /** Another payload under the cancel's ID (impossible for a correct client): never sent again. */
  | "conflict"
  /** An earlier owner's send was refused or conflicted and it forbade the sends in the shared count: checks go on. */
  | "forbidden"
  /**
   * The core confirmed that this way of reading cannot serve the request (statusReadImpossible): the status is not read
   * again, the outcome stays unknown and the cancel is not a success. CP2 goes on by reading the session itself.
   */
  | "status_unreadable";
export type StartCancelView = {
  record: StartCancelPending;
  recovery: RecoverySnapshot;
  /** Only a server-confirmed result; a plain not_found never sets it (2.4.2). */
  outcome: StartCancelResult | null;
  /** The closure the server confirmed with outcome session_closed: the screen shows the ordinary closed state. */
  closedSession: ClosedSessionBoundary | null;
  rejectionCode: string | null;
  unresolved: StartCancelUnresolved | null;
};
/** started: a new cancel_id was written and sent; resumed: the stored cancel of this start goes on; busy: another start's cancel holds the slot. */
export type StartCancelBegin = "started" | "resumed" | "busy";

/**
 * The one answer of GET /commands/{id} that proves this way of reading can never serve the same request (C045 п. 1):
 * the core's own 422 VALIDATION_FAILED. The core gives it only for the form of the request — the query parsing
 * (app.py validation_error) and the argument checks of CommandStatusService.read before any state is read — and the
 * cancel sends the same request every time, so it would be refused again. No count is needed. Everything else is
 * waited out on the ordinary series: a lost reply, a timeout, 5xx and a planned pause, a 4xx without the core's code
 * (the core answers none of 404/405/408/413/429 on this route: that is a proxy), an unreadable answer. 401/403 and a
 * conflict are the machine's own classes.
 */
function statusReadImpossible(error: unknown): boolean {
  return error instanceof ApiError && error.kind === "http" && error.status === 422 && error.code === "VALIDATION_FAILED";
}

/**
 * Phase Б of an exhausted session.start (D-CP2C-START 2.3–2.4): one session.cancel_start with its own new command_id
 * and the same session_id, recorded on the device before its first send and recovered by the same RecoveryMachine
 * (six automatic sends, pauses 2/5/10/20/30 s from the detected loss, a check before each retry; owner's answer А-5.1.2).
 * One cancel_id per session_id for good: a stored cancel is always continued, never replaced (2.4.1а.1). Once no send
 * may follow (the sends ran out, a send was refused or conflicted), the cancel is only checked (keepChecking).
 * The module owns no screen and no start record.
 */
export class StartCancelRecovery {
  private readonly lifetime = new AbortController();
  private machine: RecoveryMachine<StartCancelIntent> | null = null;
  private record: StartCancelPending | null = null;
  private opening: Promise<StartCancelBegin> | null = null;
  private active: boolean;
  private found: StartCancelOutcome | null = null;
  /** The outcome of the last answer; it becomes the result only once the machine settled on that answer. */
  private answeredOutcome: StartCancelOutcome | null = null;
  private closed: ClosedSessionBoundary | null = null;
  /** The closure of the last check answer; it becomes the result only once the machine accepted that answer. */
  private answeredClosure: ClosedSessionBoundary | null = null;
  /** A termination asked from outside (terminate) is never the server's closure. */
  private terminating = false;
  private unresolved: StartCancelUnresolved | null = null;
  /** The code of the refused send; it stays while the checks go on. */
  private rejectionCode: string | null = null;
  /** The highest profile version among this cancel's own answers: an older not_found proves nothing. */
  private seen: bigint | null = null;

  constructor(private readonly options: StartCancelOptions) { this.active = options.active; }

  view(): StartCancelView | null {
    if (!this.machine || !this.record) return null;
    const recovery = this.machine.snapshot(), state = recovery.state;
    const outcome = state.name === "settled" && state.outcome === "accepted" ? this.found
      : state.name === "terminated" && state.reason === "session_closed" && this.closed ? "session_closed" : null;
    return { record: { ...this.record }, recovery, outcome,
      closedSession: outcome === "session_closed" ? structuredClone(this.closed) : null,
      rejectionCode: this.rejectionCode,
      unresolved: this.unresolved };
  }

  /**
   * Cancel this exhausted start (the caller checked cancelDue). The record is saved first; a failed save rejects with
   * the store error and sends nothing (2.3.2). A record of the same start is continued under its cancel_id.
   */
  begin(start: { sessionId: string; startCommandId: string }): Promise<StartCancelBegin> {
    if (this.opening) return this.opening;
    const task = this.open(start);
    this.opening = task;
    // Only a running cancel stays: a busy slot or a failed save may be tried again on a later event.
    const reopen = () => { if (this.opening === task) this.opening = null; };
    task.then(result => { if (result === "busy") reopen(); }, reopen);
    return task;
  }

  /**
   * On open, reload or another owner: a stored cancel of this profile is checked by its ID, its start is never sent
   * again (2.3.3). pending owner: CL044 А-5.1.4 — with an unknown count it is only checked, never sent (unfinished default).
   */
  async resume(): Promise<StartCancelPending | null> {
    const held = await this.options.store.load(this.options.profileId, this.lifetime.signal);
    if (held && !this.machine) this.run(held, false);
    return held;
  }

  /** Remove the cancel record once its result is confirmed, after the caller removed the start record (2.5.4, 2.5.5). */
  async clear(): Promise<void> {
    const view = this.view();
    if (!view || view.outcome === null) throw new Error("the cancel has no confirmed outcome");
    await this.options.store.clear(view.record, this.lifetime.signal);
  }

  setActive(active: boolean): void {
    this.active = active;
    this.machine?.setActive(active);
  }
  terminate(reason: TerminationReason): void {
    this.terminating = true;
    try { this.machine?.terminate(reason); } finally { this.terminating = false; }
  }
  dispose(): void {
    this.lifetime.abort();
    this.machine?.dispose();
  }

  private async open(start: { sessionId: string; startCommandId: string }): Promise<StartCancelBegin> {
    const { store, profileId, clientInstanceId, pair } = this.options, signal = this.lifetime.signal;
    const held = this.record ?? await store.load(profileId, signal);
    if (held) {
      if (!sameId(held.sessionId, start.sessionId) || !sameId(held.startCommandId, start.startCommandId)) return "busy";
      if (!this.machine) this.run(held, false);
      return "resumed";
    }
    const record: StartCancelPending = { schemaVersion: 1, profileId, clientInstanceId, pair, sessionId: start.sessionId,
      startCommandId: start.startCommandId, cancelCommandId: this.options.newId() };
    // Before the first send: a reload must know the cancel's own ID to check it (2.3.2).
    await store.save(record, signal);
    this.run(record, true);
    return "started";
  }

  private run(record: StartCancelPending, first: boolean): void {
    this.record = record;
    const host = this.options.host;
    // pending owner: CL044 А-5.1.3 — no manual send after the automatic ones (unfinished default: only checks).
    // pending owner: CL044 А-5.1.5 — a send met by a planned pause counts, as the machine counts it today.
    const machine = new RecoveryMachine<StartCancelIntent>({
      intent: startCancelIntent(record.cancelCommandId, record.sessionId),
      counter: this.options.counter, clock: this.options.clock, active: this.active, keepChecking: true,
      ports: {
        // An answer that arrives after dispose (a replaced owner) changes nothing here; the machine drops it as well.
        send: async (intent, transmitted) => this.sent(this.current(await host.send(intent, transmitted))),
        check: async (intent) => this.checked(this.current(await this.read(intent))),
        // 4.6-В9 variant Б, as the lanes (root decision, pending owner): the probe pauses pace the fact checks.
        probe: () => Promise.resolve(true),
        isLive: () => host.isLive(),
        windowCheck: () => host.windowCheck(),
      },
      onUpdate: snapshot => this.update(snapshot),
    });
    this.machine = machine;
    if (first) machine.begin();
    else machine.resume();
  }

  /**
   * One status read. When the core confirms that this read cannot serve the request, it is not polled again: without
   * a check no retry may follow either, so the machine stops and the outcome stays unknown (C045 п. 1).
   */
  private async read(intent: StartCancelIntent): Promise<StartCancelStatus> {
    try {
      return await this.options.host.status(intent);
    } catch (error: unknown) {
      if (statusReadImpossible(error)) {
        this.unresolved = "status_unreadable";
        this.machine?.dispose();
        this.options.host.onUpdate();
      }
      throw error;
    }
  }

  private observe(stateVersion: string): void {
    const value = BigInt(stateVersion);
    if (this.seen === null || value > this.seen) this.seen = value;
  }
  /** Older than this document or this cancel already confirmed: such an answer proves nothing. */
  private stale(stateVersion: string): boolean {
    const minimum = this.options.host.minimumStateVersion?.() ?? null;
    const value = BigInt(stateVersion);
    return minimum !== null && value < BigInt(minimum) || this.seen !== null && value < this.seen;
  }

  /** A shown outcome is the server's own; a hidden view (a document that is not the live one) asks for a window check. */
  private outcome(current: StartCancelCurrent): boolean {
    if (!("outcome" in current)) return false;
    this.answeredOutcome = current.outcome;
    return true;
  }

  private current<T>(answer: T): T {
    if (this.lifetime.signal.aborted) throw new Error("the cancel owner was disposed");
    return answer;
  }

  private sent(reply: StartCancelReply): SendResult {
    this.answeredOutcome = null;
    this.observe(reply.state_version);
    if (reply.outcome === "accepted") return this.outcome(reply.current) ? { kind: "settled", outcome: "accepted" } : { kind: "window_stale" };
    if (reply.outcome === "mismatch") return { kind: "mismatch" };
    switch (reply.error.code) {
      case "DOCUMENT_STALE": return { kind: "window_stale" };
      case "FORBIDDEN": return { kind: "terminated", reason: "access_lost" };
      // A refusal of this one send proves nothing about a copy sent earlier: no send again, only checks (C038 п. 3).
      default: return { kind: "refused", code: reply.error.code };
    }
  }

  private checked(status: StartCancelStatus): CheckResult {
    this.answeredClosure = null;
    this.answeredOutcome = null;
    if (status.outcome === "accepted") {
      this.observe(status.state_version);
      return this.outcome(status.current) ? { kind: "recorded", outcome: "accepted" } : { kind: "window_stale" };
    }
    if (this.stale(status.state_version)) return { kind: "stale" };
    this.observe(status.state_version);
    // not_found: not applied at the moment of this check, nothing more (2.4.2). A retry also needs the right to go on
    // (2.4.1а.7): the same admitted profile and the same installation; the live document is the machine's own check.
    // A changed pair does not stop it: the cancel addresses the number, and a late copy of the start may still come.
    const record = this.record!, current = status.current;
    if (!sameId(current.profile_id, this.options.profileId) || current.access.status !== "admitted") return { kind: "terminated", reason: "access_lost" };
    if (!sameId(record.clientInstanceId, this.options.clientInstanceId)) return { kind: "terminated", reason: "window_replaced" };
    // The server's closure of exactly this number (the decoder checked it): the start created the session and it is
    // closed by now. A confirmed result of its own, not an applied cancel; nothing is sent any more (C038 п. 1).
    if (status.closed_session !== undefined) {
      // Kept aside: an answer the machine drops (an older generation, the background) must not become the result.
      this.answeredClosure = structuredClone(status.closed_session);
      return { kind: "terminated", reason: "session_closed" };
    }
    return { kind: "not_recorded" };
  }

  private update(snapshot: RecoverySnapshot): void {
    const state = snapshot.state;
    switch (state.name) {
      case "checks_only":
        this.unresolved = state.cause === "mismatch" ? "conflict" : state.cause;
        if (state.code !== null) this.rejectionCode = state.code;
        break;
      case "counter_unknown": this.unresolved = "counter_unknown"; break;
      case "conflict": this.unresolved = "conflict"; break;
      case "terminated":
        // The machine terminates with session_closed only on the closure answer it accepted, or when asked from outside.
        if (state.reason === "session_closed" && !this.terminating && this.answeredClosure) this.closed = this.answeredClosure;
        this.unresolved = null;
        break;
      case "settled":
        if (state.outcome === "accepted") this.found = this.answeredOutcome;
        this.unresolved = null;
        break;
      default: break;
    }
    this.options.host.onUpdate();
  }
}
