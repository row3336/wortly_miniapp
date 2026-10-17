import type { LearningPreviewCommand, LearningStartPayload, PresentCommand,
  SessionStartCommand, SessionStopCommand } from "../api/generated";
import { exactKeys, record, uuid } from "../api/wireValidation";
import { copySaveFailedStop, copyStopPayload, validSaveFailedStop, validStopPayload, type SaveFailedStopIntent,
  type StopPayload } from "../commands/closeIntent";

type WithoutOrigin<T> = T extends unknown ? Omit<T, "client_instance_id" | "document_id"> : never;
type SendableSessionIntent = WithoutOrigin<
  (Omit<SessionStartCommand, "payload"> & { payload: LearningStartPayload })
  | LearningPreviewCommand | PresentCommand | SessionStopCommand>;
/** SaveFailedStopIntent is only read from the Stop slot and checked; validLearningSessionIntent never lets it be sent. */
export type LearningSessionIntent = SendableSessionIntent | SaveFailedStopIntent;
export type LearningSessionCommand = LearningSessionIntent & {
  client_instance_id: string; document_id: string;
};

/** Durable intent never owns a document, an access token or an origin proof. An intent this client may send. */
export function validLearningSessionIntent(value: unknown): value is SendableSessionIntent {
  if (!record(value) || !uuid(value.command_id) || !uuid(value.session_id) || !record(value.payload)) return false;
  const keys = ["session_id", "command_id", "kind", "payload"];
  let valid = false;
  switch (value.kind) {
    case "session.start": valid = exactKeys(value.payload, ["mode"]) && value.payload.mode === "learning"; break;
    // T1 (project notices §4.1): `{reason}` as before, or with the unconfirmed action X (stop optional, save_failed required).
    case "session.stop": valid = validStopPayload(value.payload, value.command_id); break;
    case "assignment.present": keys.push("assignment_id"); valid = uuid(value.assignment_id) && exactKeys(value.payload, []); break;
    case "learning.preview_next": case "learning.known":
      keys.push("preview_id"); valid = uuid(value.preview_id) && exactKeys(value.payload, []); break;
  }
  return valid && exactKeys(value, keys);
}

/** An intent a durable record may hold and its status check may name: also the closure C, which is never sent. */
export function readableLearningSessionIntent(value: unknown): value is LearningSessionIntent {
  return validLearningSessionIntent(value) || validSaveFailedStop(value);
}

/** Stable field order gives the shared slot an exact comparison across callers. */
export function copyLearningSessionIntent(value: LearningSessionIntent): LearningSessionIntent {
  if (validSaveFailedStop(value)) return copySaveFailedStop(value);
  if (!validLearningSessionIntent(value)) throw new Error("invalid Learning intent");
  const address = { command_id: value.command_id, session_id: value.session_id };
  switch (value.kind) {
    case "session.start": return { ...address, kind: value.kind, payload: { mode: "learning" } };
    case "session.stop": return { ...address, kind: value.kind, payload: copyStopPayload(value.payload as StopPayload) } as LearningSessionIntent;
    case "assignment.present": return { ...address, kind: value.kind, assignment_id: value.assignment_id, payload: {} };
    case "learning.preview_next": case "learning.known":
      return { ...address, kind: value.kind, preview_id: value.preview_id, payload: {} };
  }
}
