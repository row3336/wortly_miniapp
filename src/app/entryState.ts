import type { RemoteStopSnapshot } from "../study/remoteStopController";

/** Entry screen states. EntryController is their only producer; screens only render them. */
export type EntryState =
  | { kind: "checking" }
  | { kind: "opening" }
  | { kind: "pending" }
  | { kind: "rejected"; reason?: string }
  | { kind: "reapplying"; reason?: string }
  | { kind: "busy"; remoteTarget?: string }
  | { kind: "remote_confirm"; targetId: string }
  | { kind: "remote"; remote: RemoteStopSnapshot }
  | { kind: "opened" }
  | { kind: "expired" }
  | { kind: "unavailable" };
