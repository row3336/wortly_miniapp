import type { WriteGate } from "./writeGate";

/**
 * What the wait of a shut write gate is (P03 §4.8; M-P03-9): a planned pause or an announced hold, with its estimate in
 * whole seconds (null: none announced; 0: the estimate passed — maintenanceOver); the server unreachable or not ready
 * (9.2.2); or the check of the identity and of the pending actions (9.2.1).
 */
export type GateWait =
  | { cause: "maintenance"; waitSeconds: number | null }
  | { cause: "offline" }
  | { cause: "checking" };

/**
 * The cause of `¬mayWrite` that a screen names (§4.8 by cause): closed(maintenance) or a running send_hold → the planned
 * pause with the remaining hold; closed(unavailable|unknown) → 9.2.2; an identity lock with `net` open → 9.2.1 when the
 * window has pending actions, else 9.2.2. Null: nothing of the gate holds the window (a family lock is the ID's own).
 */
export function gateWait(gate: WriteGate, options: { pending?: boolean } = {}): GateWait | null {
  const snapshot = gate.snapshot();
  if (snapshot.closedWindow) return null;
  if (snapshot.net.kind === "closed") {
    return snapshot.net.cause === "maintenance" ? { cause: "maintenance", waitSeconds: gate.holdRemainingS() } : { cause: "offline" };
  }
  if (gate.holdActive()) return { cause: "maintenance", waitSeconds: gate.holdRemainingS() };
  if (snapshot.identityLock) return options.pending ? { cause: "checking" } : { cause: "offline" };
  return null;
}

/**
 * The write gate for the manual controls of a study screen (P03 §4.1 «Правило кнопки», C335; M-P03-9/10): «Проверить» by
 * checkButtonActive, a resend of a lane by mayWrite of its ID; wait is the cause the screen names while they wait.
 */
export type LaneGate = { checkable: boolean; primaryWritable: boolean; stopWritable: boolean; wait: GateWait | null };

export function laneGate(gate: WriteGate, primary: { pending: boolean; pendingIntent?: { command_id: string } | null },
  stop: { pending: boolean; pendingIntent?: { command_id: string } | null }): LaneGate {
  return { checkable: gate.checkButtonActive(), primaryWritable: gate.mayWrite(primary.pendingIntent?.command_id),
    stopWritable: gate.mayWrite(stop.pendingIntent?.command_id), wait: gateWait(gate, { pending: primary.pending || stop.pending }) };
}
