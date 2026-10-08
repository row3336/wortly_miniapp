import { DocumentLanes, type DocumentLanesOptions, type DocumentLanesSnapshot } from "../commands/documentLanes";
import { createWrittenApi, type WrittenResultRead, type WrittenSessionRead } from "./writtenApi";
import { WrittenCommandController, type WrittenCommandSnapshot, type WrittenTransition } from "./writtenCommandController";
import { writtenStores } from "./writtenPending";

export type WrittenDocumentSnapshot = DocumentLanesSnapshot<WrittenCommandSnapshot>;
export type WrittenDocumentOptions = DocumentLanesOptions<WrittenCommandSnapshot>;
/**
 * The written commands that recover automatically (CT §6.1 п. 1, D-RECOV table 1.1.1 group (а)): the answer or
 * «Не помню», a grade, a correction, «Шаг назад», and the mark that a question was shown (assignment.present, owner
 * answer Q25.1 of 08.10.2026: its manual retry of CT:109 and TA:113 is gone). session.start keeps its manual recovery
 * until its own package (Q26); session.stop always does.
 */
export const writtenAutomaticKinds = ["answer.submit", "result.grade", "result.correct", "result.undo", "assignment.present"] as const;

/** Both durable command lanes of one opened document; views and drafts belong to the caller. */
export class WrittenDocumentCommands extends DocumentLanes<WrittenCommandSnapshot, WrittenTransition, WrittenSessionRead, WrittenResultRead> {
  constructor(options: WrittenDocumentOptions) {
    const api = createWrittenApi(options.transport), stores = writtenStores(options.storage);
    super(options, {
      label: "written",
      automatic: writtenAutomaticKinds,
      readSession: (credentials, sessionId, origin) => api.read(credentials.token, credentials.proof,
        { session_id: sessionId, ...origin(credentials) }),
      readResult: (credentials, address, origin) => api.readResult(credentials.token, credentials.proof,
        { session_id: address.session_id, assignment_id: address.assignment_id, result_id: address.result_id, ...origin(credentials) }),
      controller: (wiring, reads) => new WrittenCommandController({
        profileId: wiring.profileId, clientInstanceId: wiring.clientInstanceId, pair: wiring.pair, lane: wiring.lane,
        pendingStore: stores[wiring.lane], stateVersion: wiring.stateVersion, minimumStateVersion: wiring.minimumStateVersion,
        isLive: wiring.isLive, newId: wiring.newId,
        // transmitted is told inside the open handle, right before the request: a refusal before it sent nothing.
        send: (intent, transmitted) => wiring.send(credentials => {
          transmitted?.();
          return api.send(credentials.token, credentials.proof, { ...intent, ...wiring.origin(credentials) });
        }),
        check: intent => wiring.run(credentials => api.status(credentials.token, credentials.proof, { ...intent, ...wiring.origin(credentials) })),
        read: reads.read, readResult: intent => reads.readResult(intent), onUpdate: wiring.onUpdate,
      }),
    });
  }
  isClosed(sessionId: string): boolean { return this.closed.has(sessionId.toLowerCase()); }
}
