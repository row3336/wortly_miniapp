import type { LearningSessionProjection } from "../api/generated";
import { copyLanePending, validLanePending } from "../commands/commandLane";
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
  return validLanePending(value, validLearningCommandIntent);
}

function copy(value: unknown): LearningSessionPending {
  if (!validLearningSessionPending(value)) throw new PendingStoreError("invalid");
  return copyLanePending(value, copyLearningCommandIntent);
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
