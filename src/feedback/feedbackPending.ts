import type { AsyncStorage } from "../platform/storage";
import { PendingSlot, PendingStoreError, validId } from "../commands/pendingSlot";
import { validFeedbackIntent, type FeedbackIntent } from "./feedbackApi";

/** The sent intent whose outcome is not confirmed yet; the unsent text lives only in memory. */
export type FeedbackPending = {
  schemaVersion: 1;
  profileId: string;
  intent: FeedbackIntent;
};

export function validFeedbackPending(value: unknown): value is FeedbackPending {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Partial<FeedbackPending>;
  return Object.keys(item).length === 3 && ["schemaVersion", "profileId", "intent"].every(key => Object.hasOwn(item, key))
    && item.schemaVersion === 1 && validId(item.profileId) && validFeedbackIntent(item.intent);
}

function copy(value: unknown): FeedbackPending {
  if (!validFeedbackPending(value)) throw new PendingStoreError("invalid");
  const { command_id, kind, payload } = value.intent;
  // A fixed property order gives the shared slot an exact comparison.
  return { schemaVersion: 1, profileId: value.profileId, intent: { command_id, kind,
    payload: { text: payload.text, ...(payload.card_id === undefined ? {} : { card_id: payload.card_id }) } } };
}

/** One slot per application storage, next to the settings slot. */
export class FeedbackPendingStore extends PendingSlot<FeedbackPending> {
  constructor(storage: AsyncStorage) { super(storage, "wortly.pending.feedback", copy); }
}
