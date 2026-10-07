import type { RemoteStopSnapshot } from "../study/remoteStopController";

/** Entry screen states. EntryController is their only producer; screens only render them. */
export type EntryState =
  | { kind: "checking" }
  | { kind: "opening" }
  | { kind: "pending" }
  // pause: the last reapply met a planned pause (503 MAINTENANCE, К14-021). It is the same refusal screen with the
  // same reapply button and the same saved command ID, plus a note; waitSeconds is the server's estimate (0 = passed).
  | { kind: "rejected"; reason?: string; pause?: { waitSeconds?: number } }
  | { kind: "reapplying"; reason?: string }
  | { kind: "busy"; remoteTarget?: string }
  // A newer window of this installation took the document over (decision 2.3). Terminal: this window closes
  // itself; where it cannot (outside Telegram) it shows the busy screen without buttons until Q54 is answered.
  | { kind: "replaced" }
  | { kind: "remote_confirm"; targetId: string }
  | { kind: "remote"; remote: RemoteStopSnapshot }
  | { kind: "opened" }
  | { kind: "expired" }
  // This client's contract version is not served (К10-059/060): reading why is allowed, new writes are not.
  // No document is open; the screen offers only the update message (what else it shows is open, see DESIGN Q-H1).
  | { kind: "incompatible" }
  | { kind: "unavailable" };
