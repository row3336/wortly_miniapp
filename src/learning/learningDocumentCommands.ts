import { DocumentLanes, type DocumentLanesOptions, type DocumentLanesSnapshot } from "../commands/documentLanes";
import { LearningCommandController, type LearningCommandSnapshot, type LearningTransition } from "./learningCommandController";
import { isLearningResultIntent, type LearningAnswerIntent, type LearningCommandIntent,
  type LearningResultIntent } from "./learningCommandIntent";
import { createLearningResultApi, type LearningResultRead } from "./learningAnswerApi";
import { createLearningSessionApi, type LearningSessionRead } from "./learningSessionApi";
import { LearningSessionPendingStore, LearningStopPendingStore } from "./learningSessionPending";
import type { LearningPageStarts } from "./learningPageStarts";
import { PausedBeforeSendError } from "../commands/writeGate";
import { lostAddress } from "../commands/lostEnvelope";

export type LearningDocumentSnapshot = DocumentLanesSnapshot<LearningCommandSnapshot>;
/**
 * The Learning commands that recover automatically (CT §6.1 п. 1; TC table 4.3 «Шаг занятия»; D-RECOV table 1.1.1
 * group (а)): the answer or «Не помню», a grade, a correction, «Шаг назад», «Дальше» / «Уже знаю» of a preview, and the
 * mark that a question was shown (assignment.present, owner answer Q25.1 of 08.10.2026: its manual retry is gone).
 * session.start keeps its manual recovery until its own package (Q26); session.stop always does.
 */
export const learningAutomaticKinds = ["answer.submit", "result.grade", "result.correct", "result.undo",
  "learning.preview_next", "learning.known", "assignment.present"] as const;

function resultCommand(intent: LearningCommandIntent): intent is LearningAnswerIntent | LearningResultIntent {
  return intent.kind === "answer.submit" || isLearningResultIntent(intent);
}

/** Own both durable command lanes for one opened document, without owning its views or drafts. */
export class LearningDocumentCommands extends DocumentLanes<LearningCommandSnapshot, LearningTransition, LearningSessionRead, LearningResultRead> {
  constructor(options: DocumentLanesOptions<LearningCommandSnapshot> & { page?: LearningPageStarts }) {
    const sessions = createLearningSessionApi(options.transport), results = createLearningResultApi(options.transport);
    const gate = options.transport.gate;
    super(options, {
      label: "Learning",
      automatic: learningAutomaticKinds,
      // 35.1-А (C243): the page of a start is the one LearningPageStarts names, for the controller and for the document.
      lanePage: ["session.start"],
      readSession: (credentials, sessionId, origin) => sessions.read(credentials.token, credentials.proof,
        { session_id: sessionId, ...origin(credentials) }),
      readResult: (credentials, address, origin) => results.read(credentials.token, credentials.proof,
        { session_id: address.session_id, assignment_id: address.assignment_id, result_id: address.result_id, ...origin(credentials) }),
      controller: (wiring, reads) => {
        const controller: LearningCommandController = new LearningCommandController({
          profileId: wiring.profileId, clientInstanceId: wiring.clientInstanceId, pair: wiring.pair,
          stateVersion: wiring.stateVersion, minimumStateVersion: wiring.minimumStateVersion,
          isLive: wiring.isLive, newId: wiring.newId,
          pendingStore: wiring.lane === "primary" ? new LearningSessionPendingStore(options.storage) : new LearningStopPendingStore(options.storage),
          // Answers, their revisions and their undo go to the result endpoint; every other transition is a session command.
          // transmitted is told inside the open handle, right before the request: a refusal before it sent nothing.
          // sendStarted is told by the transport once the request is built, right before fetch.
          send: (intent, transmitted) => wiring.send(async credentials => {
            const address = wiring.origin(credentials), sendStarted = () => controller.sendStarted();
            // L1 (P03 §4.1, M-P03-5), both branches (results.send and sessions.send): the gate is asked before the send
            // is counted as gone; transmitted, the request and L2 follow in the same synchronous stretch (I3).
            if (!gate.mayWrite(intent.command_id)) throw new PausedBeforeSendError("paused");
            transmitted?.();
            // The live open handle was checked by wiring.send (access.run) right before this; started is told by the
            // transport once the request is built, right before fetch (21.1-А, 33.1-А boundary). A start is always a
            // session command. The same moment ends an inherited intent for the timer (sendStarted, 20.1-А/22.1-А).
            return resultCommand(intent)
              ? results.send(credentials.token, credentials.proof, { ...intent, ...address }, sendStarted)
              : sessions.send(credentials.token, credentials.proof, { ...intent, ...address },
                () => { controller.requestStarted(); sendStarted(); });
          }),
          // R6: the status of this ID is read only with the gate's ticket (after the identity check, if one is due).
          check: intent => gate.runReadback(intent.command_id, ticket => wiring.run(async credentials => {
            const address = wiring.origin(credentials);
            return resultCommand(intent)
              ? results.status(credentials.token, credentials.proof, { ...intent, ...address }, ticket)
              : sessions.status(credentials.token, credentials.proof, { ...intent, ...address }, ticket);
          })),
          // Q27 (C458/C467): a lost answer or grade is read by its ID under the same ticket and open handle; never sent.
          checkLost: lost => gate.runReadback(lost.commandId, ticket => wiring.run(credentials =>
            results.statusLost(credentials.token, credentials.proof, lostAddress(lost, wiring.origin(credentials)), ticket))),
          gate, family: "learning",
          read: reads.read, readResult: intent => reads.readResult(intent), onUpdate: wiring.onUpdate, page: options.page,
        });
        return controller;
      },
    });
  }
}
