import { sameId, uuid } from "../api/wireValidation";
import type { UnavailableCurrent } from "../api/generated";
import { CommandLane, retryStep, type CommandProblem, type LaneOptions, type LanePending, type LaneResolved, type LaneSettled,
  type LaneSnapshot, type WithoutId } from "../commands/commandLane";
import type { OralRead, OralReply, OralStatus } from "./oralApi";
import { copyOralIntent, validOralIntent, type OralIntent } from "./oralIntent";
import type { OralCommandLane } from "./oralPending";

export type OralTransition = WithoutId<OralIntent>;
type Current = OralRead["current"] | UnavailableCurrent;
type Resolved = LaneResolved<OralIntent["kind"]> & { assignmentId?: string; actionId?: string; resultId?: string };
export type OralCommandSnapshot = LaneSnapshot<OralIntent, Current, Resolved>;
type Spec = { intent: OralIntent; lane: OralCommandLane; current: Current; resolved: Resolved; reply: OralReply;
  status: OralStatus; read: OralRead; snapshot: OralCommandSnapshot };

/** Own one addressed intent. Access callbacks belong to one immutable document lifetime. */
export class OralCommandController extends CommandLane<Spec> {
  constructor(options: LaneOptions<Spec>) { super(options, { label: "oral", lanes: ["study", "stop"], copy: copyOralIntent }); }
  protected intent(action: OralTransition): OralIntent | Error {
    const candidate = { ...action, command_id: this.options.clientInstanceId };
    if (Object.hasOwn(action, "command_id") || !validOralIntent(candidate) || (candidate.kind === "session.stop") !== (this.options.lane === "stop")) {
      return new Error("invalid oral action");
    }
    const intent = copyOralIntent(candidate);
    intent.command_id = this.options.newId();
    return validOralIntent(intent) ? intent : new Error("invalid oral command ID");
  }
  protected accept(intent: OralIntent, reply: LaneSettled<Spec> & { outcome: "accepted" }, resolved: Resolved): void {
    if (intent.kind !== "oral.grade") return;
    resolved.assignmentId = intent.assignment_id;
    if (uuid(reply.command.action_id)) resolved.actionId = reply.command.action_id;
    if (uuid(reply.command.result_id)) resolved.resultId = reply.command.result_id;
  }
  protected settledCurrent(reply: LaneSettled<Spec>): object { return reply.current; }
  protected verify(pending: LanePending<OralIntent>): Promise<boolean> {
    return this.verifySession(pending, current => retryProblem(pending.intent, current, pending.pair));
  }
}

function retryProblem(intent: OralIntent, current: OralRead["current"], pair: string): CommandProblem {
  const step = retryStep(current, intent, pair);
  if (typeof step === "string") return step;
  const assignment = step.assignment, capabilities = step.capabilities;
  switch (intent.kind) {
    case "session.start": return "step_changed";
    // The closure C (CON §6.1 п.8, Q30) may go again while the session is open at any step, as in the written mode.
    case "session.stop": return intent.payload.reason === "save_failed" ? "not_found"
      : intent.payload.reason === "stop" ? capabilities.stop ? "not_found" : "step_changed"
      : step.status === "summary" && capabilities.summary_home ? "not_found" : "step_changed";
    case "assignment.present": return step.status === "active" && assignment?.status === "prefetched"
      && sameId(assignment.id, intent.assignment_id) ? "not_found" : "step_changed";
    case "oral.reveal": return step.status === "active" && assignment?.status === "presented" && !assignment.revealed
      && sameId(assignment.id, intent.assignment_id) && sameId(capabilities.reveal_target, intent.assignment_id) ? "not_found" : "step_changed";
    case "oral.grade": return step.status === "active" && assignment?.status === "presented" && assignment.revealed
      && sameId(assignment.id, intent.assignment_id) && sameId(capabilities.grade_target, intent.assignment_id) ? "not_found" : "step_changed";
  }
}
