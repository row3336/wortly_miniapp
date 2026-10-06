import type { RemoteStopSnapshot } from "../study/remoteStopController";

/** Entry screen states. EntryController is their only producer; screens only render them. */
export type EntryState =
  | { kind: "checking" }
  | { kind: "opening" }
  | { kind: "pending" }
  | { kind: "rejected"; reason?: string }
  | { kind: "reapplying"; reason?: string }
  | { kind: "busy"; remoteTarget?: string }
  // A newer window of this installation took the document over (decision 2.3). Terminal: this window closes
  // itself; where it cannot (outside Telegram) it shows the busy screen without buttons until Q54 is answered.
  | { kind: "replaced" }
  | { kind: "remote_confirm"; targetId: string }
  | { kind: "remote"; remote: RemoteStopSnapshot }
  | { kind: "opened" }
  | { kind: "expired" }
  | { kind: "unavailable" };
