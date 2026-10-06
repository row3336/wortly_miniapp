import { DocumentLanes, type DocumentLanesOptions, type DocumentLanesSnapshot } from "../commands/documentLanes";
import { LearningCommandController, type LearningCommandSnapshot, type LearningTransition } from "./learningCommandController";
import { createLearningResultApi, type LearningResultRead } from "./learningAnswerApi";
import { createLearningSessionApi, type LearningSessionRead } from "./learningSessionApi";
import { LearningSessionPendingStore, LearningStopPendingStore } from "./learningSessionPending";

export type LearningDocumentSnapshot = DocumentLanesSnapshot<LearningCommandSnapshot>;

/** Own both durable command lanes for one opened document, without owning its views or drafts. */
export class LearningDocumentCommands extends DocumentLanes<LearningCommandSnapshot, LearningTransition, LearningSessionRead, LearningResultRead> {
  constructor(options: DocumentLanesOptions<LearningCommandSnapshot>) {
    const sessions = createLearningSessionApi(options.transport), results = createLearningResultApi(options.transport);
    super(options, {
      label: "Learning",
      readSession: (credentials, sessionId, origin) => sessions.read(credentials.token, credentials.proof,
        { session_id: sessionId, ...origin(credentials) }),
      readResult: (credentials, address, origin) => results.read(credentials.token, credentials.proof,
        { session_id: address.session_id, assignment_id: address.assignment_id, result_id: address.result_id, ...origin(credentials) }),
      controller: (wiring, reads) => new LearningCommandController({
        profileId: wiring.profileId, clientInstanceId: wiring.clientInstanceId, pair: wiring.pair,
        stateVersion: wiring.stateVersion, minimumStateVersion: wiring.minimumStateVersion,
        isLive: wiring.isLive, newId: wiring.newId,
        pendingStore: wiring.lane === "primary" ? new LearningSessionPendingStore(options.storage) : new LearningStopPendingStore(options.storage),
        // Answers and their revisions go to the result endpoint; every other transition is a session command.
        send: intent => wiring.send(async credentials => {
          const address = wiring.origin(credentials);
          return intent.kind === "answer.submit" || intent.kind === "result.grade" || intent.kind === "result.correct"
            ? results.send(credentials.token, credentials.proof, { ...intent, ...address })
            : sessions.send(credentials.token, credentials.proof, { ...intent, ...address });
        }),
        check: intent => wiring.run(async credentials => {
          const address = wiring.origin(credentials);
          return intent.kind === "answer.submit" || intent.kind === "result.grade" || intent.kind === "result.correct"
            ? results.status(credentials.token, credentials.proof, { ...intent, ...address })
            : sessions.status(credentials.token, credentials.proof, { ...intent, ...address });
        }),
        read: reads.read, readResult: intent => reads.readResult(intent), onUpdate: wiring.onUpdate,
      }),
    });
  }
}
