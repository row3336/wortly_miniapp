import { DocumentLanes, type DocumentLanesOptions, type DocumentLanesSnapshot } from "../commands/documentLanes";
import { createWrittenApi, type WrittenResultRead, type WrittenSessionRead } from "./writtenApi";
import { WrittenCommandController, type WrittenCommandSnapshot, type WrittenTransition } from "./writtenCommandController";
import { writtenStores } from "./writtenPending";
import { ClosedAccessError } from "../app/openedAccess";
import { NotPreparedError } from "../commands/recoveryReplies";
import { PausedBeforeSendError } from "../commands/writeGate";
import { lostAddress } from "../commands/lostEnvelope";

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
    const api = createWrittenApi(options.transport), stores = writtenStores(options.storage), gate = options.transport.gate;
    super(options, {
      label: "written",
      automatic: writtenAutomaticKinds,
      readSession: (credentials, sessionId, origin) => api.read(credentials.token, credentials.proof,
        { session_id: sessionId, ...origin(credentials) }),
      readResult: (credentials, address, origin) => api.readResult(credentials.token, credentials.proof,
        { session_id: address.session_id, assignment_id: address.assignment_id, result_id: address.result_id, ...origin(credentials) }),
      controller: (wiring, reads) => {
        const controller: WrittenCommandController = new WrittenCommandController({
          profileId: wiring.profileId, clientInstanceId: wiring.clientInstanceId, pair: wiring.pair, lane: wiring.lane,
          pendingStore: stores[wiring.lane], stateVersion: wiring.stateVersion, minimumStateVersion: wiring.minimumStateVersion,
          isLive: wiring.isLive, newId: wiring.newId,
          // CP5b: the pre-request step (hooks.prepare: the slot goes to "sending") is the last await before the request; a
          // false answer sends nothing. started is told inside the open handle, right before the request; sendStarted is
          // told by the transport once the request is built, right before fetch.
          send: async (intent, hooks) => {
            // A handle replaced meanwhile refuses before the slot moves: the reservation goes back (ClosedAccessError).
            if (hooks && !wiring.canSend()) throw new ClosedAccessError();
            if (hooks && !(await hooks.prepare())) throw new NotPreparedError();
            return wiring.send(credentials => {
              // L1 (P03 §4.1, M-P03-5): the gate is asked first; the request, L2 and fetch follow in the same synchronous
              // stretch (I3). C565: the send is counted as gone (hooks.started) only by the transport's own callback, after
              // L2 and right before fetch: a request L2 refuses is never transmitted.
              if (!gate.mayWrite(intent.command_id)) throw new PausedBeforeSendError("paused");
              return api.send(credentials.token, credentials.proof, { ...intent, ...wiring.origin(credentials) },
                () => { hooks?.started(); controller.sendStarted(); });
            });
          },
          // R6: the status of this ID is read only with the gate's ticket (after the identity check, if one is due).
          check: intent => gate.runReadback(intent.command_id, ticket => wiring.run(credentials =>
            api.status(credentials.token, credentials.proof, { ...intent, ...wiring.origin(credentials) }, ticket))),
          // Q27 (C458): a lost answer is read by its ID under the same ticket and open handle; it is never sent.
          checkLost: lost => gate.runReadback(lost.commandId, ticket => wiring.run(credentials =>
            api.statusLost(credentials.token, credentials.proof, lostAddress(lost, wiring.origin(credentials)), ticket))),
          gate, family: "written",
          read: reads.read, readResult: intent => reads.readResult(intent), onUpdate: wiring.onUpdate,
          slotConflict: wiring.slotConflict,
        });
        return controller;
      },
    });
  }
  isClosed(sessionId: string): boolean { return this.closed.has(sessionId.toLowerCase()); }
}
