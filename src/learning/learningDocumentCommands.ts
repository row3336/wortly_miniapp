import { DocumentLanes, type DocumentLanesOptions, type DocumentLanesSnapshot } from "../commands/documentLanes";
import { LearningCommandController, type LearningCommandSnapshot, type LearningTransition } from "./learningCommandController";
import { isLearningResultIntent, type LearningAnswerIntent, type LearningCommandIntent,
  type LearningResultIntent } from "./learningCommandIntent";
import { createLearningResultApi, type LearningResultRead } from "./learningAnswerApi";
import { createLearningSessionApi, type LearningSessionRead } from "./learningSessionApi";
import { LearningSessionPendingStore, LearningStopPendingStore } from "./learningSessionPending";

export type LearningDocumentSnapshot = DocumentLanesSnapshot<LearningCommandSnapshot>;
/**
 * The Learning commands that pass the result of a study step (CT §6.1 п. 1; TC table 4.3 «Шаг занятия»; D-RECOV table
 * 1.1.1 group (а)): the answer or «Не помню», a grade, a correction, «Шаг назад», and «Дальше» / «Уже знаю» of a preview.
 * session.start and assignment.present keep their manual recovery until the owner decides (4.6-В1, 4.6-В2);
 * session.stop always does.
 */
export const learningAutomaticKinds = ["answer.submit", "result.grade", "result.correct", "result.undo",
  "learning.preview_next", "learning.known"] as const;

function resultCommand(intent: LearningCommandIntent): intent is LearningAnswerIntent | LearningResultIntent {
  return intent.kind === "answer.submit" || isLearningResultIntent(intent);
}

/** Own both durable command lanes for one opened document, without owning its views or drafts. */
export class LearningDocumentCommands extends DocumentLanes<LearningCommandSnapshot, LearningTransition, LearningSessionRead, LearningResultRead> {
  constructor(options: DocumentLanesOptions<LearningCommandSnapshot>) {
    const sessions = createLearningSessionApi(options.transport), results = createLearningResultApi(options.transport);
    super(options, {
      label: "Learning",
      automatic: learningAutomaticKinds,
      readSession: (credentials, sessionId, origin) => sessions.read(credentials.token, credentials.proof,
        { session_id: sessionId, ...origin(credentials) }),
      readResult: (credentials, address, origin) => results.read(credentials.token, credentials.proof,
        { session_id: address.session_id, assignment_id: address.assignment_id, result_id: address.result_id, ...origin(credentials) }),
      controller: (wiring, reads) => new LearningCommandController({
        profileId: wiring.profileId, clientInstanceId: wiring.clientInstanceId, pair: wiring.pair,
        stateVersion: wiring.stateVersion, minimumStateVersion: wiring.minimumStateVersion,
        isLive: wiring.isLive, newId: wiring.newId,
        pendingStore: wiring.lane === "primary" ? new LearningSessionPendingStore(options.storage) : new LearningStopPendingStore(options.storage),
        // Answers, their revisions and their undo go to the result endpoint; every other transition is a session command.
        // transmitted is told inside the open handle, right before the request: a refusal before it sent nothing.
        send: (intent, transmitted) => wiring.send(async credentials => {
          const address = wiring.origin(credentials);
          transmitted?.();
          return resultCommand(intent)
            ? results.send(credentials.token, credentials.proof, { ...intent, ...address })
            : sessions.send(credentials.token, credentials.proof, { ...intent, ...address });
        }),
        check: intent => wiring.run(async credentials => {
          const address = wiring.origin(credentials);
          return resultCommand(intent)
            ? results.status(credentials.token, credentials.proof, { ...intent, ...address })
            : sessions.status(credentials.token, credentials.proof, { ...intent, ...address });
        }),
        read: reads.read, readResult: intent => reads.readResult(intent), onUpdate: wiring.onUpdate,
      }),
    });
  }
}
