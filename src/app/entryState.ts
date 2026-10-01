import type { RemoteStopSnapshot } from "../study/remoteStopController";

/** API adapters send only confirmed results into this reducer. */
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

export type EntryEvent =
  | { type: "ACCESS_PENDING" }
  | { type: "ACCESS_REJECTED"; reason?: string }
  | { type: "ACCESS_ADMITTED" }
  | { type: "ACCESS_UNAVAILABLE" }
  | { type: "CLIENT_BUSY" }
  | { type: "CLIENT_OPENED" }
  | { type: "RETRY_AUTH" }
  | { type: "REAPPLY_STARTED" }
  | { type: "REAPPLY_CONFIRMED" }
  | { type: "REAPPLY_FAILED" };

export function entryReducer(state: EntryState, event: EntryEvent): EntryState {
  switch (event.type) {
    case "ACCESS_PENDING":
      return state.kind === "checking" || state.kind === "reapplying" ? { kind: "pending" } : state;
    case "ACCESS_REJECTED":
      return state.kind === "checking" ? { kind: "rejected", reason: event.reason } : state;
    case "ACCESS_ADMITTED":
      return state.kind === "checking" ? { kind: "opening" } : state;
    case "ACCESS_UNAVAILABLE":
      return state.kind === "checking" || state.kind === "opening" ? { kind: "unavailable" } : state;
    case "CLIENT_BUSY":
      return state.kind === "opening" ? { kind: "busy" } : state;
    case "CLIENT_OPENED":
      return state.kind === "opening" ? { kind: "opened" } : state;
    case "RETRY_AUTH":
      return state.kind === "unavailable" ? { kind: "checking" } : state;
    case "REAPPLY_STARTED":
      return state.kind === "rejected" ? { kind: "reapplying", reason: state.reason } : state;
    case "REAPPLY_CONFIRMED":
      return state.kind === "reapplying" ? { kind: "pending" } : state;
    case "REAPPLY_FAILED":
      return state.kind === "reapplying" ? { kind: "rejected", reason: state.reason } : state;
  }
}
