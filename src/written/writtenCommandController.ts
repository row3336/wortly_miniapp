import type { UnavailableCurrent } from "../api/generated";
import { sameId, uuid } from "../api/wireValidation";
import { CommandLane, retryStep, type CommandProblem, type LaneOptions, type LanePending, type LaneResolved, type LaneSettled, type LaneSnapshot,
  type WithoutId } from "../commands/commandLane";
import { revisionRetryProblem } from "../commands/resultRevision";
import type { WrittenAnswer, WrittenCurrent, WrittenReply, WrittenResultRead, WrittenSessionRead, WrittenStatus } from "./writtenApi";
import { copyWrittenIntent, isAnswerKind, isResultIntent, validWrittenIntent, type WrittenIntent,
  type WrittenResultIntent } from "./writtenIntent";
import type { WrittenLane } from "./writtenPending";

export type WrittenTransition = WithoutId<WrittenIntent>;
type Current = WrittenCurrent | UnavailableCurrent;
type Resolved = LaneResolved<WrittenIntent["kind"]> & { assignmentId?: string; resultId?: string };
export type WrittenCommandSnapshot = LaneSnapshot<WrittenIntent, Current, Resolved> & { answer: WrittenAnswer | null };
type Spec = { intent: WrittenIntent; lane: WrittenLane; current: Current; resolved: Resolved; reply: WrittenReply;
  status: WrittenStatus; read: WrittenSessionRead; snapshot: WrittenCommandSnapshot };
type Options = LaneOptions<Spec> & { readResult(intent: WrittenResultIntent): Promise<WrittenResultRead> };

/** Own one addressed intent of one lane; the written answer, its revisions and its undo add the result view to the shared lane. */
export class WrittenCommandController extends CommandLane<Spec, Options> {
  private answer: WrittenAnswer | null = null;

  constructor(options: Options) { super(options, { label: "written", lanes: ["primary", "stop"], copy: copyWrittenIntent }); }
  protected intent(action: WrittenTransition): WrittenIntent | Error {
    if (Object.hasOwn(action, "command_id")) return new Error("invalid written action");
    const intent = { ...action, command_id: this.options.newId() } as WrittenIntent;
    if (!validWrittenIntent(intent) || (intent.kind === "session.stop") !== (this.options.lane === "stop")) {
      return new Error("invalid written action");
    }
    return copyWrittenIntent(intent);
  }
  protected accept(intent: WrittenIntent, reply: LaneSettled<Spec> & { outcome: "accepted" }, resolved: Resolved): void {
    if (isAnswerKind(intent.kind) && "assignment_id" in intent && uuid(reply.command.result_id)) {
      resolved.assignmentId = intent.assignment_id; resolved.resultId = reply.command.result_id;
    }
  }
  protected settledCurrent(reply: LaneSettled<Spec>): object { return "step" in reply ? reply.step : reply.current; }
  protected settledView(reply: LaneSettled<Spec>): void {
    this.answer = "step" in reply && this.current !== null && "pair" in this.current
      ? structuredClone({ action: reply.action, result: reply.result, capabilities: reply.capabilities }) : null;
  }
  protected clearCurrent(): void { super.clearCurrent(); this.answer = null; }
  protected extend(snapshot: LaneSnapshot<WrittenIntent, Current, Resolved>, visible: boolean): WrittenCommandSnapshot {
    return { ...snapshot, answer: visible ? structuredClone(this.answer) : null };
  }
  protected async verify(pending: LanePending<WrittenIntent>): Promise<boolean> {
    const intent = pending.intent;
    if (!isResultIntent(intent)) return this.verifySession(pending, current => retryProblem(intent, current, pending.pair));
    const read = await this.options.readResult(intent);
    if (!this.live()) return false;
    if (!this.observe(read.state_version, read.step)) this.problem = "stale_response";
    else {
      this.answer = this.current !== null && "pair" in this.current
        ? structuredClone({ action: read.action, result: read.result, capabilities: read.capabilities }) : null;
      this.problem = revisionRetryProblem(intent, read, pending.pair, false);
      this.retryVerified = this.problem === "not_found";
    }
    return true;
  }
}

/** A missing acceptance fact authorizes no effect; retry only the same still-valid target. */
function retryProblem(intent: Exclude<WrittenIntent, WrittenResultIntent>, current: WrittenSessionRead["current"], pair: string): CommandProblem {
  const step = retryStep(current, intent, pair);
  if (typeof step === "string") return step;
  const assignment = step.status === "active" ? step.assignment : null;
  switch (intent.kind) {
    case "session.start": return "step_changed";
    case "session.stop": return intent.payload.reason === "stop" || step.status === "summary" ? "not_found" : "step_changed";
    case "assignment.present": return assignment?.status === "prefetched" && sameId(assignment.id, intent.assignment_id) ? "not_found" : "step_changed";
    case "answer.submit": return assignment?.status === "presented" && sameId(assignment.id, intent.assignment_id) ? "not_found" : "step_changed";
  }
}
