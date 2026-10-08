import { exactKeys, oneOf, record, sameId, uuid } from "../api/wireValidation";
import type { AsyncStorage } from "../platform/storage";
import type { Pair } from "./commandLane";
import { PendingSlot, PendingStoreError } from "./pendingSlot";

/** The modes whose session.start may need a cancel (D-CP2C-START 2.1); oral and conjugation join with CP3. */
export type StartCancelMode = "written" | "learning" | "oral" | "conjugation";

/**
 * The durable record of one session.cancel_start (D-CP2C-START table 2.8.1). It is written before the first send of
 * the cancel, so a reload still knows the cancel's own ID and checks it by that ID instead of sending the start again
 * (2.3.2, 2.3.3). The three numbers never mix: the start's command_id, the cancel's command_id and the session_id both
 * of them address (REV F03).
 */
export type StartCancelPending = {
  schemaVersion: 1;
  profileId: string;
  clientInstanceId: string;
  pair: Pair;
  sessionId: string;
  startCommandId: string;
  cancelCommandId: string;
};

const KEYS = ["schemaVersion", "profileId", "clientInstanceId", "pair", "sessionId", "startCommandId", "cancelCommandId"];

export function validStartCancelPending(value: unknown): value is StartCancelPending {
  return record(value) && exactKeys(value, KEYS) && value.schemaVersion === 1
    && uuid(value.profileId) && uuid(value.clientInstanceId) && oneOf(value.pair, ["ru-de", "uk-de", "en-de"])
    && uuid(value.sessionId) && uuid(value.startCommandId) && uuid(value.cancelCommandId)
    // A cancel under the start's own ID, or an ID equal to the session number, was never written by a correct client.
    && !sameId(value.cancelCommandId, value.startCommandId)
    && !sameId(value.sessionId, value.startCommandId) && !sameId(value.sessionId, value.cancelCommandId);
}

/** A canonical copy: a stable field order gives the shared slot an exact comparison across callers. */
export function copyStartCancelPending(value: unknown): StartCancelPending {
  if (!validStartCancelPending(value)) throw new PendingStoreError("invalid");
  return { schemaVersion: 1, profileId: value.profileId, clientInstanceId: value.clientInstanceId, pair: value.pair,
    sessionId: value.sessionId, startCommandId: value.startCommandId, cancelCommandId: value.cancelCommandId };
}

/** One slot per mode, apart from the lane slots: no lane validator has to learn a second kind (table 2.8.1.3–4). */
export function startCancelKey(mode: StartCancelMode): string {
  return `wortly.pending.${mode}_start_cancel`;
}

export class StartCancelPendingStore extends PendingSlot<StartCancelPending> {
  constructor(storage: AsyncStorage, mode: StartCancelMode) { super(storage, startCancelKey(mode), copyStartCancelPending); }
}

const shared = new WeakMap<AsyncStorage, Map<StartCancelMode, StartCancelPendingStore>>();
/** One store per storage and mode: document owners that replace each other serialize through the same queue. */
export function startCancelStore(storage: AsyncStorage, mode: StartCancelMode): StartCancelPendingStore {
  let stores = shared.get(storage);
  if (!stores) { stores = new Map(); shared.set(storage, stores); }
  let store = stores.get(mode);
  if (!store) { store = new StartCancelPendingStore(storage, mode); stores.set(mode, store); }
  return store;
}
