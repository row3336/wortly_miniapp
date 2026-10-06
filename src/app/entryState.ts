import type { RemoteStopSnapshot } from "../study/remoteStopController";

/** Entry screen states. EntryController is their only producer; screens only render them. */
export type EntryState =
  | { kind: "checking" }
  | { kind: "opening" }
  | { kind: "pending" }
  | { kind: "rejected"; reason?: string }
  | { kind: "reapplying"; reason?: string }
  | { kind: "busy"; remoteTarget?: string }
  // Another live window of this installation keeps the document (its cross-window lock is held, or the
  // user kept it). Coming back to the foreground checks again.
  | { kind: "other_window" }
  // Without the lock the server cannot tell whether that window is still alive (CT:188): only the user
  // may end it, for the document epoch the server reported.
  | { kind: "replace_confirm"; epoch: string }
  | { kind: "remote_confirm"; targetId: string }
  | { kind: "remote"; remote: RemoteStopSnapshot }
  | { kind: "opened" }
  | { kind: "expired" }
  | { kind: "unavailable" };
