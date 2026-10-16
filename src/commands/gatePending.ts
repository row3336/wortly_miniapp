import { PausedBeforeSendError, type DefiniteOutcome, type IndefiniteOutcome, type ReadbackTicket, type WriteGate } from "./writeGate";

/**
 * One owner's part in the readback registry of the write gate (P03 §4.11 R1–R9, R8; M-P03-8): the command_id of the
 * pending record this owner holds. hold() registers it when the record is created or loaded and again before every
 * send (an outcome is unknown again once a request may have left); settled()/unsettled() report the answer of a
 * readback; release() unregisters it when the record is gone or the owner goes away — an ID that never got a definite
 * answer stays locked to itself in the gate until its definite readback (R3).
 */
export class GatePending {
  private commandId: string | null = null;

  constructor(private readonly gate: WriteGate, private readonly family: string) {}

  /** The owner holds the record of commandId (created, loaded, or about to be sent). Another held ID is let go first. */
  hold(commandId: string): void {
    if (this.commandId !== null && this.commandId !== commandId) this.gate.unregisterPending(this.commandId);
    this.commandId = commandId;
    this.gate.registerPending(this.family, commandId);
  }
  /** A definite answer about the held ID (R5): it takes the ID out of the round and out of familyLocks. */
  settled(outcome: DefiniteOutcome): void {
    if (this.commandId !== null) this.gate.resolvePending(this.commandId, outcome);
  }
  /** An indefinite one (stale, a storage error, a malformed record): the ID stays locked to itself (Z3, R4). */
  unsettled(outcome: IndefiniteOutcome): void {
    if (this.commandId !== null) this.gate.resolvePending(this.commandId, outcome);
  }
  /**
   * The owner cleared the record after it proved the outcome itself (a settled reply, a confirmed closure, a refusal, a
   * start that never left): definite for the gate (R5), then let go.
   */
  cleared(): void {
    this.settled("terminated");
    this.release();
  }
  /** The record is gone (after a definite answer), or the owner goes away (dispose, R8 п.4). */
  release(): void {
    if (this.commandId === null) return;
    const id = this.commandId;
    this.commandId = null;
    this.gate.unregisterPending(id);
  }
  /** The only way this owner reads the status of commandId (R6): the gate gives the ticket, maybe after the identity check. */
  read<T>(commandId: string, read: (ticket: ReadbackTicket) => Promise<T>): Promise<T> {
    return this.gate.runReadback(commandId, read);
  }
  /**
   * The button of a check by ID (readback; or a «repeat» that reads the ID first and sends only after not_recorded):
   * checkButtonActive — a family lock of the held ID never keeps it, since this read is what lifts that lock (R5, C335).
   */
  checkable(): boolean { return this.gate.checkButtonActive(); }
  /**
   * fix3 (П01): the direct reply of this owner's POST session.start was a definite refusal SESSION_BUSY — the gate may
   * attribute the «На Сегодня» that follows to that episode (TZA 12.1). Never after a readback or a restored record.
   */
  startRefusedBusy(commandId: string): void { this.gate.noteStartBusy(commandId); }
  /** I9: a manual send of commandId (or a new action) is allowed by the gate right now. */
  writable(commandId?: string): boolean { return this.gate.mayWrite(commandId); }
}

/** PAUSED_BEFORE_SEND: nothing left the client; never a lost reply and never an unknown outcome (§4.2, M-P03-8). */
export function pausedBeforeSend(error: unknown): error is PausedBeforeSendError {
  return error instanceof PausedBeforeSendError;
}

/**
 * A read refused by the gate itself (R8 п.2): cancelled — the document or the owner went away, nothing is decided;
 * no_ticket — a defect of the code, never shown as a network failure; closed_window — the window is closed for good.
 * In each case the pending record is left as it is.
 */
export function refusedRead(error: unknown): error is PausedBeforeSendError {
  return error instanceof PausedBeforeSendError;
}
