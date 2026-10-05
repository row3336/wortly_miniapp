import type { SessionProjection } from "../api/generated";
import { exactKeys, oneOf, record, uuid } from "../api/wireValidation";
import { PendingSlot, PendingStoreError } from "../commands/pendingSlot";
import type { AsyncStorage } from "../platform/storage";
import { copyWrittenIntent, validWrittenIntent, type WrittenIntent } from "./writtenIntent";

export type WrittenLane = "primary" | "stop";
export type WrittenPending = {
  schemaVersion: 1;
  profileId: string;
  clientInstanceId: string;
  pair: SessionProjection["pair"];
  intent: WrittenIntent;
  mismatch?: true;
};

export function validWrittenPending(value: unknown): value is WrittenPending {
  return record(value) && exactKeys(value, ["schemaVersion", "profileId", "clientInstanceId", "pair", "intent",
    ...(Object.hasOwn(value, "mismatch") ? ["mismatch"] : [])])
    && value.schemaVersion === 1 && uuid(value.profileId) && uuid(value.clientInstanceId)
    && oneOf(value.pair, ["ru-de", "uk-de", "en-de"])
    && (!Object.hasOwn(value, "mismatch") || value.mismatch === true)
    && validWrittenIntent(value.intent);
}

function copy(value: unknown, lane: WrittenLane): WrittenPending {
  if (!validWrittenPending(value) || (value.intent.kind === "session.stop") !== (lane === "stop")) {
    throw new PendingStoreError("invalid");
  }
  return { schemaVersion: 1, profileId: value.profileId, clientInstanceId: value.clientInstanceId, pair: value.pair,
    intent: copyWrittenIntent(value.intent), ...(value.mismatch ? { mismatch: true } : {}) };
}

export const writtenPrimaryKey = "wortly.pending.written_session";
export const writtenStopKey = "wortly.pending.written_stop";
/** Study commands: start, present, answer and its revisions. */
export class WrittenSessionPendingStore extends PendingSlot<WrittenPending> {
  constructor(storage: AsyncStorage) { super(storage, writtenPrimaryKey, value => copy(value, "primary")); }
}
/** Stop has its own slot so an unknown study outcome can never prevent it. */
export class WrittenStopPendingStore extends PendingSlot<WrittenPending> {
  constructor(storage: AsyncStorage) { super(storage, writtenStopKey, value => copy(value, "stop")); }
}

export type WrittenStores = Readonly<Record<WrittenLane, PendingSlot<WrittenPending>>>;
const shared = new WeakMap<AsyncStorage, WrittenStores>();
/** One pair per storage: document owners that replace each other serialize through the same in-memory queue. */
export function writtenStores(storage: AsyncStorage): WrittenStores {
  let stores = shared.get(storage);
  if (!stores) {
    stores = Object.freeze({ primary: new WrittenSessionPendingStore(storage), stop: new WrittenStopPendingStore(storage) });
    shared.set(storage, stores);
  }
  return stores;
}
