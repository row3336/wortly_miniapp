import { recordOutcome, type RecoveryBudget } from "./intentBudget";
import { refusedUnsent } from "./pendingSlot";
import type { RecoveryClock } from "./recoveryClock";
import { FINAL_RECOVERY_STATES, RecoveryMachine, type KnownLoss, type RecoverySnapshot, type RequestHooks } from "./recoveryMachine";
import { checkFailure, sendFailure, type CheckResult, type SendResult } from "./recoveryReplies";
import type { WriteGate } from "./writeGate";
import { journalRecord } from "../journal/clientJournal";
import { isErrorCode, type ScreenEvent } from "../journal/events";

export type RecoveryIntent = { command_id: string; kind: string; session_id: string };
/** The fields of the primary lane snapshot the adapter reads. */
export type RecoveryLaneState = {
  pending: boolean;
  pendingIntent: RecoveryIntent | null;
  outcome: string | null;
  resolved: { commandId: string } | null;
  problem: string | null;
  canRetry: boolean;
  /** The code of the refusal the lane settled on (rejected), when it knows one. */
  rejectionCode?: string | null;
};
/** What a screen needs of the automatic recovery of the primary lane. */
/**
 * What the screen decides for the action once its machine has ended (events TZ §4.5 c.screen): the class of the
 * decision and its code, never a text. null: nothing final to show yet.
 */
export function screenDecision(state: RecoverySnapshot["state"], afterLoss: boolean): Pick<ScreenEvent, "kind" | "code"> | null {
  switch (state.name) {
    case "settled":
      if (state.outcome === "rejected") return { kind: "refusal_shown" };
      return { kind: afterLoss ? "already_recorded" : "result_shown" };
    case "refused": return { kind: "refusal_shown", ...(isErrorCode(state.code) ? { code: state.code } : {}) };
    case "conflict": return { kind: "refusal_shown", code: "COMMAND_PAYLOAD_MISMATCH" };
    case "exhausted": return { kind: "unsaved_shown" };
    case "terminated":
      if (state.reason === "client_incompatible") return { kind: "update_required", code: "CLIENT_INCOMPATIBLE" };
      // Absence confirmed and the session closed: the action was not applied and is lost (laneCheckResult not_applied).
      if (state.reason === "session_closed") return { kind: "lost", code: "SESSION_CLOSED" };
      return null;
    default: return null;
  }
}

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
  /**
   * One send of the primary lane through the document: first = the intent was never handed to the lane yet. hooks: the
   * pre-request step (its last await before the request) and the start of the request (RequestHooks).
   */
  send(intent: RecoveryIntent, first: boolean, hooks: RequestHooks): Promise<void>;
  /** One fact check of the primary lane: its status by ID plus the targeted read of its right to continue. */
  check(): Promise<void>;
  /** Clear the pending intent whose outcome the machine proved final without a reply to show (refused, changed step). */
  release(commandId: string): Promise<void>;
  isLive(): boolean;
  onUpdate(): void;
  /** 2.3 А: whether this window created the intent of commandId and may therefore send it at all. */
  maySend?(commandId: string): boolean;
  /** 14.8.8.1 А: the new action was dropped over another record in the slot and its machine is gone; check that record. */
  blocked?(): void;
  /** The write gate of the page: the machine waits for it instead of probing (P03 M-P03-6). */
  gate?: WriteGate;
};

/** A send class the lane proved for commandId; started says whether its request began (transmitted was told). */
export function laneSendResult(state: RecoveryLaneState, failure: unknown, started: boolean, commandId: string): SendResult {
  // A refusal before the request (closed handle, busy Stop lane, a local store failure) sent nothing.
  if (!started) return { kind: "not_sent" };
  const own = state.resolved?.commandId === commandId;
  if (own && (state.outcome === "accepted" || state.outcome === "rejected")) {
    return { kind: "settled", outcome: state.outcome, ...(state.outcome === "rejected" ? { code: state.rejectionCode ?? null } : {}) };
  }
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
      : state.outcome === "rejected" ? { kind: "recorded", outcome: "rejected", code: state.rejectionCode ?? null }
        : { kind: "recorded", outcome: "accepted" };
  }
  if (state.problem === "mismatch") return { kind: "mismatch" };
  if (failure !== null) return checkFailure(failure);
  // canRetry: not found, same open step, own intent, fresh state — the only proof that allows a send (2.12).
  if (state.canRetry) return { kind: "not_recorded" };
  switch (state.problem) {
    // M-P03-7: an expired sign-in is no end of the action (reauth); a denial or another profile is.
    case "expired": return { kind: "terminated", reason: "reauth" };
    case "forbidden": case "profile_changed": return { kind: "terminated", reason: "access_lost" };
    case "closed": case "pair_changed": return { kind: "terminated", reason: "session_closed" };
    case "step_changed": return { kind: "terminated", reason: "step_stale" };
    case "client_changed": return { kind: "terminated", reason: "window_replaced" };
    // An older answer, or a target not yet confirmed fresh: the outcome stays unknown (2.13).
    case "stale_response": case "not_found": return { kind: "stale" };
    default: return { kind: "unreachable" };
  }
}

/**
 * The durable budgets of one document's lane (CP5b): the page they share (the key of the pending losses below) and the
 * budget of an intent. The budget itself lives in the store of the page (intentBudget.ts), not in this adapter.
 */
export type LaneBudgets = { page: object; of(intent: RecoveryIntent): RecoveryBudget };

type PageLoss = KnownLoss & { scope: string };
const losses = new WeakMap<object, Map<string, PageLoss>>();
/**
 * The earliest next send of each command_id, in the memory of the page (CT §6.1 п. 4): an owner re-created inside the
 * same document (a failed foreground, a reseed) or another document of this page waits only the rest of the pause —
 * the page's monotonic clock is the same for all of them (C572 (а)). scope only says which owners keep a loss at all
 * (none: no loss is kept). A reload starts without it (decision 2.3 А: it only checks there anyway).
 */
function pageLosses(page: object): Map<string, PageLoss> {
  let map = losses.get(page);
  if (!map) { map = new Map(); losses.set(page, map); }
  return map;
}

/**
 * The adapter between one document's primary lane and the recovery machine (M-RECOV-AUTO CP2). It decides nothing of
 * its own: the machine owns order, pauses and the budget; the lane owns the intent, its storage and its checks.
 */
export class LaneRecovery {
  private machine: RecoveryMachine<RecoveryIntent> | null = null;
  private commandId: string | null = null;
  private intent: RecoveryIntent | null = null;
  private afterLoss = false;
  private active = true;
  /** Resolves the promise of begin: once the first send has its answer, or the machine stopped before sending it. */
  private firstSettled: (() => void) | null = null;
  private sending = false;
  /** Н3: a refused or outdated intent whose record could not be cleared; cleared again on the next event, never on a timer. */
  private unreleased: string | null = null;
  private releasing: Promise<void> | null = null;

  /** scope: the document this owner belongs to (profile, installation, document and epoch); none keeps no loss. */
  constructor(private readonly host: LaneRecoveryHost, private readonly budgets: LaneBudgets, private readonly clock: RecoveryClock,
    private readonly scope?: string) {}

  /** A machine that still checks or sends owns the primary lane: no new action, no other check of it. */
  busy(): boolean {
    const name = this.machine?.snapshot().state.name;
    return name !== undefined && !FINAL_RECOVERY_STATES.has(name);
  }
  /** The machine still checks or sends this very intent. */
  drives(commandId: string): boolean {
    return this.busy() && this.commandId !== null && this.commandId.toLowerCase() === commandId.toLowerCase();
  }
  view(): RecoveryView | null {
    return this.machine && this.commandId ? { ...this.machine.snapshot(), commandId: this.commandId, afterLoss: this.afterLoss } : null;
  }
  /**
   * C556 В1 / Q30: the explicit press of «Повторить завершение» for the intent this machine drove to an exhausted budget.
   * false: no such state (nothing is sent then).
   */
  manual(): boolean {
    return this.machine?.manual() ?? false;
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
    this.retryRelease();
    const state = this.host.primary(), intent = state.pendingIntent;
    if (this.machine && this.busy() && !this.exchanging() && state.outcome !== null && state.resolved?.commandId === this.commandId) {
      this.machine.dispose(); this.machine = null;
      pageLosses(this.budgets.page).delete(this.commandId.toLowerCase());
      // The lane proved the outcome outside the machine: the record follows it as after the machine's own settle.
      const outcome = state.outcome === "accepted" || state.outcome === "rejected" || state.outcome === "not_applied" ? state.outcome : null;
      if (outcome && this.intent) void recordOutcome(this.budgets.of(this.intent), outcome, state.rejectionCode).catch(() => undefined);
      return;
    }
    if (!state.pending || state.outcome !== null || !intent || !this.host.automatic(intent.kind)) return;
    if (this.commandId !== null && intent.command_id.toLowerCase() === this.commandId.toLowerCase()) return;
    this.replace(intent, true);
    this.machine!.resume();
  }
  /**
   * Н4 (D-CP4 3.1.3): the session of this pending automatic intent was confirmed closed while no machine drives it
   * (the budget ran out, a check of the closure failed, a reload). A resumed machine only checks it by its ID until the
   * answer is definite, on the probe schedule and only in an active window; a send cannot follow, because the document
   * refuses any send into a closed session and a closure turns every absence into not_applied.
   */
  recheck(intent: RecoveryIntent): void {
    if (this.drives(intent.command_id)) return;
    this.replace(intent, true);
    this.machine!.resume();
  }
  /**
   * The lane cleared the record of this intent outside the machine (a conflict after the confirmed closure, Н2): nothing
   * is left to check or send, and a machine still waiting on it would hold the lane busy and keep probing.
   */
  forget(commandId: string): void {
    if (this.commandId === null || this.commandId.toLowerCase() !== commandId.toLowerCase()) return;
    this.machine?.dispose(); this.machine = null;
    this.settleFirst();
    pageLosses(this.budgets.page).delete(commandId.toLowerCase());
    // D-CP5 9.2: a conflict after the confirmed closure of its own session — the record goes with the lane's.
    if (this.intent) void this.budgets.of(this.intent).clear().catch(() => undefined);
    this.host.onUpdate();
  }
  /**
   * The first send of this intent was refused locally over another record in the shared slot, before any request: the lane
   * dropped the intent (never stored, never sent). Unlike forget, which follows a cleared record, this discards the machine
   * and its count in order, so nothing of this ID is written after it.
   */
  private dropUnsent(commandId: string): void {
    if (this.commandId === null || this.commandId.toLowerCase() !== commandId.toLowerCase()) return;
    this.machine?.discard(); this.machine = null;
    this.settleFirst();
    this.host.onUpdate();
    // 14.8.8.1 А: only now, with the machine of the dropped action gone, may the record of the other window be checked.
    this.host.blocked?.();
  }
  /**
   * Н3 (D-CP4 3.1.2): clear the record of a refused or outdated intent again after a failed cleanup. Called by events
   * only (a lane step, a return from the background, a refresh); null when nothing is left to clear.
   */
  retryRelease(): Promise<void> | null {
    if (this.releasing) return this.releasing;
    return this.unreleased ? this.release(this.unreleased) : null;
  }
  setActive(active: boolean): void {
    this.active = active;
    this.machine?.setActive(active);
    if (active) void this.retryRelease();
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
    this.commandId = intent.command_id; this.afterLoss = resumed; this.intent = intent;
    const key = intent.command_id.toLowerCase(), scope = this.scope, known = scope ? pageLosses(this.budgets.page).get(key) : undefined;
    const machine: RecoveryMachine<RecoveryIntent> = new RecoveryMachine({ intent, budget: this.budgets.of(intent), clock: this.clock, active: this.active,
      // C572 (а): the loss of this action is known to every owner of it in this page, whatever its document: the page's
      // monotonic clock is the same for all of them, so the rest of the pause is exact without any server time.
      knownLoss: resumed && known ? { next: known.next, dueAt: known.dueAt, holdUntil: known.holdUntil } : null,
      onLoss: loss => {
        // Only the machine that drives the intent now: a replaced or disposed one never writes over its successor.
        if (!scope || this.machine !== machine) return;
        if (loss) pageLosses(this.budgets.page).set(key, { ...loss, scope });
        else pageLosses(this.budgets.page).delete(key);
      },
      ports: {
        send: async (copy, hooks) => {
          let started = false;
          const first = !this.stored(copy.command_id);
          this.sending = true;
          try { await this.host.send(copy, first, { automatic: true, prepare: () => hooks.prepare(), started: () => { started = true; hooks.started(); } }); }
          finally { this.sending = false; }
          // Proof of an unsent intent: its first send (never handed to the lane before), no request began (started), the
          // lane holds no intent any more, and the last failure is the refusal of its save over another record. Nothing is
          // unknown here, so no machine waits for it. A retained intent (a resend) and an outcome that became unknown after
          // a request began (started) never take this branch.
          const failure = this.host.failure();
          if (first && !started && !this.host.primary().pending && refusedUnsent(failure)) {
            this.dropUnsent(copy.command_id);
            return { kind: "not_sent" };
          }
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
        maySend: () => this.host.maySend?.(intent.command_id) ?? true,
        ...(this.host.gate ? { gate: this.host.gate } : {}),
        windowCheck: () => new Promise<boolean>(resolve => {
          if (!this.host.isLive()) { resolve(false); return; }
          this.clock.schedule(() => resolve(this.host.isLive()), WINDOW_CHECK_MS);
        }),
      },
      onUpdate: snapshot => this.update(snapshot),
    });
    this.machine = machine;
  }
  /**
   * One cleanup of a record that will never apply. The lane keeps the record when its storage fails; then it is due
   * again on the next event. The step's own completion (its sync) runs while this is still in flight, so a failing
   * storage never loops.
   */
  private release(commandId: string): Promise<void> {
    if (this.releasing) return this.releasing;
    const task = this.host.release(commandId).catch(() => undefined).then(() => {
      if (this.releasing === task) this.releasing = null;
      const state = this.host.primary(), held = state.pendingIntent?.command_id ?? commandId;
      this.unreleased = state.pending && state.outcome === null && held.toLowerCase() === commandId.toLowerCase() ? commandId : null;
    });
    this.releasing = task;
    return task;
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
    const decision = this.commandId ? screenDecision(state, this.afterLoss) : null;
    if (decision && this.commandId) journalRecord({ ev: "c.screen", cmd: this.commandId, ...decision });
    // A definite refusal or a changed step: the old command will never apply, so the lane's record goes and the view
    // continues by the server's state (CT §6.1 п. 7). Not a conflict, not a closure or a replaced window: those keep their
    // rules. The durable budget record stays (D-CP5 10.7.2.5, V-1): a refusal has written its ban, a changed step none.
    if (this.commandId && (state.name === "refused" || state.name === "terminated" && state.reason === "step_stale")) {
      const commandId = this.commandId;
      void this.release(commandId);
      pageLosses(this.budgets.page).delete(commandId.toLowerCase());
    }
    const firstSend = state.name === "idle" || state.name === "sending" && state.attempt === 1 && !this.afterLoss;
    if (!firstSend && state.name !== "settled") this.afterLoss = true;
    // Stopped before the first request went out (background between the reservation and the request).
    if (!firstSend && !this.sending) this.settleFirst();
    this.host.onUpdate();
  }
}
