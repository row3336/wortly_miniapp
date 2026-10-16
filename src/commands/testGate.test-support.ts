import { WriteGate, type DefiniteOutcome, type IndefiniteOutcome, type ReadbackTicket } from "./writeGate";
import { ManualClock } from "./writeGate.test-support";

/**
 * The write gate of a test that is not about the gate (HttpOptions.gate is required, RD-7 п.1). It is a real gate — L2,
 * its exceptions, R6 tickets and the closed window work as in production — except that it never shuts writes: the
 * transport's observer does not close it (M-P03-4) and an owner's registrations leave no family lock behind (R3/R4), so
 * a test of a module's own retry keeps its exchanges and one test never blocks the IDs of the next. Its clock is manual:
 * it starts no timer. One gate per test file; the tests of the gate itself and of its owners use their own WriteGate.
 */
class OpenTestGate extends WriteGate {
  override closeByFailure(): void {}
  override closeByMaintenance(): void {}
  override resolvePending(commandId: string, outcome: DefiniteOutcome | IndefiniteOutcome): void {
    super.resolvePending(commandId, DEFINITE.has(outcome) ? outcome as DefiniteOutcome : "recorded");
  }
  override unregisterPending(commandId: string): void {
    super.resolvePending(commandId, "recorded");
    super.unregisterPending(commandId);
  }
}
const DEFINITE: ReadonlySet<string> = new Set(["recorded", "already_applied", "not_recorded", "terminated", "mismatch", "rejected"]);
const shared = new OpenTestGate({ clock: new ManualClock() });

export function testGate(): WriteGate { return shared; }

/**
 * A gate of its own for one EntryController of a test (M-P03-10): the entry reports its document, its open attempts
 * (п.8б) and its identity lock to the gate, so two controllers of one file must never share one. Never shut, as above.
 */
export function freshTestGate(): WriteGate { return new OpenTestGate({ clock: new ManualClock() }); }

/** A command status read of a test with the one-shot ticket of the shared test gate (R6). */
export function withTicket<T>(intent: { command_id: string }, read: (ticket: ReadbackTicket) => Promise<T>): Promise<T> {
  return shared.runReadback(intent.command_id, read);
}

/** The same read, with the command evaluated once: read gets it back with the ticket issued for its ID. */
export function readWithTicket<C extends { command_id: string }, T>(command: C,
  read: (command: C, ticket: ReadbackTicket) => Promise<T>): Promise<T> {
  return shared.runReadback(command.command_id, ticket => read(command, ticket));
}
