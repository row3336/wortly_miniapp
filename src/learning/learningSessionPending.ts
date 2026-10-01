import type { LearningSessionProjection } from "../api/generated";
import { exactKeys, oneOf, record, uuid } from "../api/wireValidation";
import { PendingSlot, PendingStoreError } from "../commands/pendingSlot";
import type { AsyncStorage } from "../platform/storage";
import { copyLearningCommandIntent, validLearningCommandIntent, type LearningCommandIntent } from "./learningCommandIntent";

export type LearningSessionPending = {
  schemaVersion: 1;
  profileId: string;
  clientInstanceId: string;
  pair: LearningSessionProjection["pair"];
  intent: LearningCommandIntent;
  mismatch?: true;
};

export function validLearningSessionPending(value: unknown): value is LearningSessionPending {
  return record(value) && exactKeys(value, ["schemaVersion", "profileId", "clientInstanceId", "pair", "intent",
    ...(Object.hasOwn(value, "mismatch") ? ["mismatch"] : [])])
    && value.schemaVersion === 1 && uuid(value.profileId) && uuid(value.clientInstanceId)
    && oneOf(value.pair, ["ru-de", "uk-de", "en-de"])
    && (!Object.hasOwn(value, "mismatch") || value.mismatch === true)
    && validLearningCommandIntent(value.intent);
}

function copy(value: unknown): LearningSessionPending {
  if (!validLearningSessionPending(value)) throw new PendingStoreError("invalid");
  return { schemaVersion: 1, profileId: value.profileId, clientInstanceId: value.clientInstanceId, pair: value.pair,
    intent: copyLearningCommandIntent(value.intent), ...(value.mismatch ? { mismatch: true } : {}) };
}

/** One unresolved Learning transition, in the existing application storage. */
export class LearningSessionPendingStore extends PendingSlot<LearningSessionPending> {
  constructor(storage: AsyncStorage) { super(storage, "wortly.pending.learning_session", copy); }
}

/** Stop may be requested while the outcome of a study transition is unknown. */
export class LearningStopPendingStore extends PendingSlot<LearningSessionPending> {
  constructor(storage: AsyncStorage) {
    super(storage, "wortly.pending.learning_stop", value => {
      const pending = copy(value);
      if (pending.intent.kind !== "session.stop") throw new PendingStoreError("invalid");
      return pending;
    });
  }
}
