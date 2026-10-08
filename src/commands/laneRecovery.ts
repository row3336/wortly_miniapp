import type { AsyncStorage } from "../platform/storage";
import type { RecoveryClock } from "./recoveryClock";
import { FINAL_RECOVERY_STATES, RecoveryMachine, type RecoverySnapshot } from "./recoveryMachine";
import { checkFailure, sendFailure, type CheckResult, type SendResult } from "./recoveryReplies";
import { MemorySendCounter, type SendCounter } from "./sendCounter";

export type RecoveryIntent = { command_id: string; kind: string; session_id: string };
/** The fields of the primary lane snapshot the adapter reads. */
export type RecoveryLaneState = {
  pending: boolean;
  pendingIntent: RecoveryIntent | null;
  outcome: string | null;
  resolved: { commandId: string } | null;
  problem: string | null;
  canRetry: boolean;
};
/** What a screen needs of the automatic recovery of the primary lane. */
export type RecoveryView = RecoverySnapshot & {
  commandId: string;
  /** The machine went past the first send (a lost reply, a reload, a background): a settled result is a recovered one. */
  afterLoss: boolean;
};

/**
 * How long a DOCUMENT_STALE waits for the entry window check (one open exchange) before the machine looks at the
 * document again. A replaced window has a dead handle by then; a live one usually got a new handle earlier, which
 * suspends and resumes the machine through the study view. The bound only keeps window_check from lasting forever.
 */
export const WINDOW_CHECK_MS = 5_000;

/** The owner of one document lane pair, as the adapter needs it. */
export type LaneRecoveryHost = {
  /** The study-step kinds of this mode that recover automatically (CT §6.1 п. 1). */
  automatic(kind: string): boolean;
  primary(): RecoveryLaneState;
  /** The raw error of the primary lane's last step. */
  failure(): unknown;
  /** One send of the primary lane through the document: first = the intent was never handed to the lane yet. */
  send(intent: RecoveryIntent, first: boolean, transmitted: () => void): Promise<void>;
  /** One fact check of the primary lane: its status by ID plus the targeted read of its right to continue. */
  check(): Promise<void>;
  /** Clear the pending intent whose outcome the machine proved final without a reply to show (refused, changed step). */
  release(commandId: string): Promise<void>;
  isLive(): boolean;
  onUpdate(): void;
};

/** A send class the lane proved for commandId; started says whether its request began (transmitted was told). */
export function laneSendResult(state: RecoveryLaneState, failure: unknown, started: boolean, commandId: string): SendResult {
  // A refusal before the request (closed handle, busy Stop lane, a local store failure) sent nothing.
  if (!started) return { kind: "not_sent" };
  const own = state.resolved?.commandId === commandId;
  if (own && (state.outcome === "accepted" || state.outcome === "rejected")) return { kind: "settled", outcome: state.outcome };
  if (state.problem === "mismatch") return { kind: "mismatch" };
  if (failure !== null) return sendFailure(failure);
  // The request began and no answer was accepted: its outcome is unknown.
  return { kind: "lost", cause: "network" };
}

/** What the lane's reconcile (status by ID, then the targeted read) proved for commandId (DESIGN D-RECOV table 2). */
export function laneCheckResult(state: RecoveryLaneState, failure: unknown, commandId: string): CheckResult {
  if (state.resolved?.commandId === commandId && state.outcome !== null) {
    // not_applied: one locked observation of absence plus the closure of exactly this session (missingProblem).
    return state.outcome === "not_applied" ? { kind: "terminated", reason: "session_closed" }
      : { kind: "recorded", outcome: state.outcome === "rejected" ? "rejected" : "accepted" };
  }
  if (state.problem === "mismatch") return { kind: "mismatch" };
  if (failure !== null) return checkFailure(failure);
  // canRetry: not found, same open step, own intent, fresh state — the only proof that allows a send (2.12).
  if (state.canRetry) return { kind: "not_recorded" };
  switch (state.problem) {
    case "expired": case "forbidden": case "profile_changed": return { kind: "terminated", reason: "access_lost" };
    case "closed": case "pair_changed": return { kind: "terminated", reason: "session_closed" };
    case "step_changed": return { kind: "terminated", reason: "step_stale" };
    case "client_changed": return { kind: "terminated", reason: "window_replaced" };
    // An older answer, or a target not yet confirmed fresh: the outcome stays unknown (2.13).
    case "stale_response": case "not_found": return { kind: "stale" };
    default: return { kind: "unreachable" };
  }
}

const counters = new WeakMap<AsyncStorage, SendCounter>();
/**
 * Stage 1 of the send count (DESIGN D-RECOV 4.1): the memory of this page, shared by its document owners through the
 * storage they share, like the pending slots. A reload starts without it, so a resumed action is only checked.
 */
export function pageSendCounter(storage: AsyncStorage): SendCounter {
  let counter = counters.get(storage);
  if (!counter) { counter = new MemorySendCounter(); counters.set(storage, counter); }
  return counter;
}

/**
 * The adapter between one document's primary lane and the recovery machine (M-RECOV-AUTO CP2). It decides nothing of
 * its own: the machine owns order, pauses and the budget; the lane owns the intent, its storage and its checks.
 */
export class LaneRecovery {
  private machine: RecoveryMachine<RecoveryIntent> | null = null;
  private commandId: string | null = null;
  private afterLoss = false;
  private active = true;
  /** Resolves the promise of begin: once the first send has its answer, or the machine stopped before sending it. */
  private firstSettled: (() => void) | null = null;
  private sending = false;

  constructor(private readonly host: LaneRecoveryHost, private readonly counter: SendCounter, private readonly clock: RecoveryClock) {}

  /** A machine that still checks or sends owns the primary lane: no new action, no other check of it. */
  busy(): boolean {
    const name = this.machine?.snapshot().state.name;
    return name !== undefined && !FINAL_RECOVERY_STATES.has(name);
  }
  view(): RecoveryView | null {
    return this.machine && this.commandId ? { ...this.machine.snapshot(), commandId: this.commandId, afterLoss: this.afterLoss } : null;
  }
  /** A new action: the machine sends it; resolves once the first send has its answer (or never started), as begin did. */
  begin(intent: RecoveryIntent): Promise<void> {
    if (!this.active) return Promise.resolve();
    this.replace(intent, false);
    const first = new Promise<void>(resolve => { this.firstSettled = resolve; });
    this.machine!.begin();
    return first;
  }
  /**
   * After a step of the primary lane. The lane may have settled the action outside the machine (a reply that arrived
   * after the window went to the background, a check after Stop): nothing is left to recover. Otherwise a pending
   * automatic intent this owner does not drive yet (reload, another owner) is checked, then continued.
   */
  sync(): void {
    const state = this.host.primary(), intent = state.pendingIntent;
    if (this.machine && this.busy() && !this.exchanging() && state.outcome !== null && state.resolved?.commandId === this.commandId) {
      this.machine.dispose(); this.machine = null;
      void this.counter.clear(this.commandId).catch(() => undefined);
      return;
    }
    if (!state.pending || state.outcome !== null || !intent || !this.host.automatic(intent.kind)) return;
    if (this.commandId !== null && intent.command_id.toLowerCase() === this.commandId.toLowerCase()) return;
    this.replace(intent, true);
    this.machine!.resume();
  }
  setActive(active: boolean): void {
    this.active = active;
    this.machine?.setActive(active);
  }
  dispose(): void {
    this.machine?.dispose();
    this.settleFirst();
  }

  private settleFirst(): void {
    this.firstSettled?.(); this.firstSettled = null;
  }
  private replace(intent: RecoveryIntent, resumed: boolean): void {
    this.machine?.dispose();
    this.settleFirst();
    this.commandId = intent.command_id; this.afterLoss = resumed;
    const machine: RecoveryMachine<RecoveryIntent> = new RecoveryMachine({ intent, counter: this.counter, clock: this.clock, active: this.active,
      ports: {
        send: async (copy, transmitted) => {
          let started = false;
          const first = !this.stored(copy.command_id);
          this.sending = true;
          try { await this.host.send(copy, first, () => { started = true; transmitted(); }); }
          finally { this.sending = false; }
          const result = laneSendResult(this.host.primary(), this.host.failure(), started, copy.command_id);
          // A machine that stopped meanwhile (background) never answers this send; the caller of begin still waits
          // for it. Otherwise the machine's next state settles begin, so the caller sees the machine already moved on.
          if (machine.snapshot().state.name !== "sending") this.settleFirst();
          return result;
        },
        check: async (copy) => {
          // Never handed to the lane (the machine stopped between its reservation and the request): nothing left
          // this window, so the server cannot hold it.
          if (!this.stored(copy.command_id)) return { kind: "not_recorded" };
          await this.host.check();
          return laneCheckResult(this.host.primary(), this.host.failure(), copy.command_id);
        },
        // 4.6-В9 variant Б (root decision, pending owner): no separate light route; the probe pauses pace the fact
        // checks, and the fact check itself shows whether the server answers.
        probe: () => Promise.resolve(true),
        isLive: () => this.host.isLive(),
        windowCheck: () => new Promise<boolean>(resolve => {
          if (!this.host.isLive()) { resolve(false); return; }
          this.clock.schedule(() => resolve(this.host.isLive()), WINDOW_CHECK_MS);
        }),
      },
      onUpdate: snapshot => this.update(snapshot),
    });
    this.machine = machine;
  }
  /** The machine waits for its own send or check: their answer settles it, not this adapter. */
  private exchanging(): boolean {
    const name = this.machine?.snapshot().state.name;
    return name === "sending" || name === "checking" || name === "pre_send_check";
  }
  /** The lane holds this intent, or has settled it. */
  private stored(commandId: string): boolean {
    const state = this.host.primary();
    return state.pending || state.resolved?.commandId === commandId;
  }
  private update(snapshot: RecoverySnapshot): void {
    const state = snapshot.state;
    // A definite refusal or a changed step: the old command will never apply, so its record goes and the view continues
    // by the server's state (CT §6.1 п. 7). Not a conflict, not a closure or a replaced window: those keep their rules.
    if (this.commandId && (state.name === "refused" || state.name === "terminated" && state.reason === "step_stale")) {
      const commandId = this.commandId;
      void this.host.release(commandId).catch(() => undefined);
      void this.counter.clear(commandId).catch(() => undefined);
    }
    const firstSend = state.name === "idle" || state.name === "sending" && state.attempt === 1 && !this.afterLoss;
    if (!firstSend && state.name !== "settled") this.afterLoss = true;
    // Stopped before the first request went out (background between the reservation and the request).
    if (!firstSend && !this.sending) this.settleFirst();
    this.host.onUpdate();
  }
}
