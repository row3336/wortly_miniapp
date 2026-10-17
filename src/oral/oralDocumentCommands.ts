import { DocumentLanes, type DocumentLanesOptions, type DocumentLanesSnapshot } from "../commands/documentLanes";
import { ClosedAccessError } from "../app/openedAccess";
import { NotPreparedError } from "../commands/recoveryReplies";
import { PausedBeforeSendError } from "../commands/writeGate";
import { lostAddress } from "../commands/lostEnvelope";
import { createOralApi, type OralRead } from "./oralApi";
import { OralCommandController, type OralCommandSnapshot, type OralTransition } from "./oralCommandController";
import type { OralCommandLane, OralSessionPendingStore, OralStopPendingStore } from "./oralPending";

export type OralLanesSnapshot = DocumentLanesSnapshot<OralCommandSnapshot>;
/**
 * The oral steps that recover automatically (Q19 вариант 1 of 12.10, К19-018; CON §6.1 п.1): the mark that a question was
 * shown, the reveal of its translation and the self-assessment. session.start keeps its manual recovery counted in its
 * budget (as the written start); session.stop keeps its own rules, and the closure C its own machine (CON §6.1 п.8).
 */
export const oralAutomaticKinds = ["assignment.present", "oral.reveal", "oral.grade"] as const;
/** No result reads in the oral mode: the shared document never asks for one (only revisions of a result do). */
type NoResult = { state_version: string; step: { status: string } };

export type OralDocumentCommandsOptions = Omit<DocumentLanesOptions<OralCommandSnapshot>, "storage"> & {
  /** The shared slots of the page (one instance per storage); their page is the key of the send budget store. */
  studyStore: OralSessionPendingStore;
  stopStore: OralStopPendingStore;
  /**
   * The owner's last gate before the POST (its activity, OralDocumentController): false sends nothing (ClosedAccessError,
   * a reservation goes back). automatic: a send of a recovery machine (study or closure), which follows only the activity.
   */
  sendable(lane: OralCommandLane, automatic: boolean): boolean;
  /**
   * The owner is still live (not disposed, its adapter source current). Every exchange of these lanes checks it after the
   * transport await, before it returns or rethrows: a late refusal of an obsolete owner's request never reaches the
   * shared OpenedAccess as a denial of the owner that replaced it (as before M1d, oralDocumentController exchange).
   */
  ownerLive(): boolean;
};

/** Both durable command lanes of one oral document on the shared mechanism of CP5b (DocumentLanes); views belong to the caller. */
export class OralDocumentCommands extends DocumentLanes<OralCommandSnapshot, OralTransition, OralRead, NoResult> {
  constructor(options: OralDocumentCommandsOptions) {
    const api = createOralApi(options.transport), gate = options.transport.gate;
    const owned = <R, A>(operation: (credentials: A) => Promise<R>) => async (credentials: A): Promise<R> => {
      if (!options.ownerLive()) throw new ClosedAccessError();
      let result: R;
      try { result = await operation(credentials); } catch (error) {
        if (!options.ownerLive()) throw new ClosedAccessError();
        throw error;
      }
      if (!options.ownerLive()) throw new ClosedAccessError();
      return result;
    };
    super({ ...options, storage: options.studyStore.page }, {
      label: "oral",
      automatic: oralAutomaticKinds,
      readSession: (credentials, sessionId, origin) => owned(() => api.read(credentials.token, credentials.proof,
        { session_id: sessionId, ...origin(credentials) }))(credentials),
      readResult: () => Promise.reject(new Error("oral has no result reads")),
      controller: (wiring, reads) => {
        const lane: OralCommandLane = wiring.lane === "primary" ? "study" : "stop";
        const controller: OralCommandController = new OralCommandController({
          profileId: wiring.profileId, clientInstanceId: wiring.clientInstanceId, pair: wiring.pair as OralCommandSnapshotPair,
          lane, pendingStore: lane === "study" ? options.studyStore : options.stopStore,
          stateVersion: wiring.stateVersion, minimumStateVersion: wiring.minimumStateVersion,
          isLive: wiring.isLive, newId: wiring.newId,
          // CP5b (as written/Learning): the pre-request step (hooks.prepare: the slot goes to "sending") is the last await
          // before the request; a false answer sends nothing. C565: hooks.started only from the transport's own callback,
          // after L2 and right before fetch.
          send: async (intent, hooks) => {
            // The owner's activity first, then a handle replaced meanwhile: both refuse before the slot moves.
            if (!options.sendable(lane, !!hooks?.automatic)) throw new ClosedAccessError();
            if (hooks && !wiring.canSend()) throw new ClosedAccessError();
            if (hooks && !(await hooks.prepare())) throw new NotPreparedError();
            return wiring.send(owned(async credentials => {
              if (!options.sendable(lane, !!hooks?.automatic)) throw new ClosedAccessError();
              // L1 (P03 §4.1, M-P03-5): the gate is asked first; the request, L2 and fetch follow synchronously (I3).
              if (!gate.mayWrite(intent.command_id)) throw new PausedBeforeSendError("paused");
              return api.send(credentials.token, credentials.proof, { ...intent, ...wiring.origin(credentials) },
                () => { hooks?.started(); controller.sendStarted(); });
            }));
          },
          // R6: the status of this ID is read only with the gate's ticket (after the identity check, if one is due).
          check: intent => gate.runReadback(intent.command_id, ticket => wiring.run(owned(credentials =>
            api.status(credentials.token, credentials.proof, { ...intent, ...wiring.origin(credentials) }, ticket)))),
          // Q27 (C467): a lost self-assessment is read by its ID under the same ticket and open handle; it is never sent.
          checkLost: lost => gate.runReadback(lost.commandId, ticket => wiring.run(owned(credentials =>
            api.statusLost(credentials.token, credentials.proof, lostAddress(lost, wiring.origin(credentials)), ticket)))),
          gate, family: "oral",
          read: reads.read, onUpdate: wiring.onUpdate, slotConflict: wiring.slotConflict,
        });
        return controller;
      },
    });
  }
}
type OralCommandSnapshotPair = ConstructorParameters<typeof OralCommandController>[0]["pair"];
