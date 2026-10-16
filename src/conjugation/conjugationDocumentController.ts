import { laneGate, type LaneGate } from "../commands/gateWait";
import type { ClosedSessionBoundary, ConjugationSessionProjection, ConjugationSummary, Profile } from "../api/generated";
import { ApiError, type HttpOptions } from "../api/http";
import { sameId, uuid, version } from "../api/wireValidation";
import { ClosedAccessError, type OpenedAccess } from "../app/openedAccess";
import { createConjugationApi } from "./conjugationApi";
import { ConjugationCommandController, resultAddressed, type ConjugationCommandSnapshot, type ConjugationCommandView,
  type ConjugationRead, type ConjugationTransition } from "./conjugationCommandController";
import type { ConjugationSessionPendingStore, ConjugationStopPendingStore } from "./conjugationPending";
import type { ConjugationResultCurrent } from "./conjugationProjection";
import { undoAction } from "../commands/resultUndo";

type AccessCredentials = Parameters<Parameters<OpenedAccess["run"]>[0]>[0];
type ResultView = Extract<ConjugationCommandView, { kind: "result" }>;
type ResultAddress = { session_id: string; assignment_id: string; result_id: string };

declare const stepBrand: unique symbol;
declare const presentationBrand: unique symbol;
/** Only reference equality authenticates a ticket; its contents are intentionally opaque. */
export type ConjugationStepTicket = Readonly<{ [stepBrand]: true }>;
export type ConjugationPresentationTicket = Readonly<{ [presentationBrand]: true }>;
export type ConjugationLane = "study" | "stop";
/** Exact identity of an accepted answer A; it carries no rights. */
export type ConjugationAcceptedAddress = Readonly<ResultAddress>;
export type CloseReason = ClosedSessionBoundary["close_reason"];
/** Facts of the selected terminal session, each from a server fact of exactly that session; null = unknown, never invented. */
export type ConjugationClosed = { sessionId: string; reason: CloseReason | null; summary: ConjugationSummary | null };
export type ConjugationDisplay = { kind: "none" } | { kind: "result" } | { kind: "step"; assignmentId: string }
  | { kind: "summary" } | { kind: "closed" };
export type ConjugationResultSnapshot = {
  address: ResultAddress;
  stateVersion: string;
  action: ConjugationResultCurrent["action"];
  result: ConjugationResultCurrent["result"];
  capabilities: ConjugationResultCurrent["capabilities"];
};
export type ConjugationDocumentSnapshot = {
  phase: "loading" | "idle" | "result" | "prefetched" | "visible_unconfirmed" | "question" | "summary"
    | "unknown" | "stopping" | "closed" | "stale" | "disposed";
  sessionId: string | null;
  stateVersion: string;
  terminalSessionIds: string[];
  closed: ConjugationClosed | null;
  /** C3: A's address of the selected live session, published regardless of view freshness; never a right. */
  acceptedAddress: ConjugationAcceptedAddress | null;
  commands: Record<ConjugationLane, ConjugationCommandSnapshot>;
  problem: string | null;
  /**
   * The selected session the server proved open in another pair (a step not below the floor): a fact about the session,
   * not a failed update, so it is never the shown problem (C149, C178; as StudyViewFields). null when nothing proves it.
   */
  pairMismatch: string | null;
  currentStep: { stateVersion: string; step: ConjugationSessionProjection } | null;
  resultA: ConjugationResultSnapshot | null;
  display: ConjugationDisplay;
  stepTicket: ConjugationStepTicket | null;
  presentationTicket: ConjugationPresentationTicket | null;
  canStart: boolean; canSubmit: boolean; canCorrect: boolean; canStop: boolean; canSummaryHome: boolean;
  /** «Шаг назад» (CT 2.3): the server grants exactly this right for the A on screen and nothing is in flight. */
  canUndo: boolean;
  allowedGrades: readonly (3 | 4 | 5)[];
  canRetry: Record<ConjugationLane, boolean>;
  /** The write gate of the manual controls (C335; M-P03-10): «Проверить» and the resends wait for it, visibly. */
  gate?: LaneGate;
};
export type ConjugationDocumentOptions = {
  access: OpenedAccess;
  transport: HttpOptions;
  studyStore: ConjugationSessionPendingStore;
  stopStore: ConjugationStopPendingStore;
  /** Only a shared resume read that confirmed mode=conjugation may supply this seed. */
  initialSessionId: string | null;
  /** C3: retained A address; accepted only for the non-terminal initialSessionId and licenses only its addressed GET. */
  initialResultAddress?: ConjugationAcceptedAddress | null;
  newId(): string;
  minimumStateVersion(): string | null;
  terminalSessionIds: readonly string[];
  /** Adapter source guard; also applies before React effect cleanup. */
  isLive(): boolean;
  /** Adapter may close activity gates during render, before its effects run. */
  activity(): { enabled: boolean; visible: boolean };
  onUpdate(snapshot: ConjugationDocumentSnapshot): void;
};
export type ConjugationDocumentActions = {
  refresh(): Promise<void>; start(): Promise<void>;
  openStep(ticket: ConjugationStepTicket): void; openResult(): void;
  shown(ticket: ConjugationPresentationTicket): Promise<void>;
  /** `assignmentId` is the question the answer was typed for; any other current question refuses it without a request. */
  submit(answer: { text: string } | { forgot: true }, assignmentId: string): Promise<void>;
  grade(value: 3 | 4 | 5): Promise<void>; correct(): Promise<void>; undo(): Promise<void>;
  stop(reason: "stop" | "summary_home"): Promise<void>;
  retry(lane: ConjugationLane): Promise<void>;
};

const freshTicket = <T>() => Object.freeze({}) as T;
/** A reply that arrived but failed strict parsing is not a lost connection. */
function readProblem(error: unknown): string {
  if (!(error instanceof ApiError)) return "network";
  return error.code ?? (error.kind === "invalid_response" ? "invalid_response" : "network");
}

/** Owns one confirmed conjugation document: two frozen command owners, reads, the A-result /
 * B-step split and the presentation barrier. Durable slots, access and transport are accepted
 * from outside and outlive this Module. It never decides Next, timers or terminal-B policy. */
export class ConjugationDocumentController implements ConjugationDocumentActions {
  private readonly options: Readonly<ConjugationDocumentOptions>;
  private readonly profile: Profile;
  private readonly pair: ConjugationSessionProjection["pair"];
  private readonly api: ReturnType<typeof createConjugationApi>;
  private readonly makeOwner: (lane: ConjugationLane, stateVersion: string) => ConjugationCommandController;
  private commands: Record<ConjugationLane, ConjugationCommandController>;
  private readonly terminal = new Set<string>();
  private readonly processed: Partial<Record<ConjugationLane, string>> = {};
  private readonly seenAnswers = new Set<string>();
  private readonly sendEpoch: Record<ConjugationLane, number> = { study: -1, stop: -1 };
  private readonly tasks: Record<ConjugationLane, Promise<void> | null> = { study: null, stop: null };
  /** Completion-only joins: a repeat may await the exact pending operation it started, never gain a new right. */
  private startJoin: Promise<void> | null = null;
  private shownJoin: { ticket: ConjugationPresentationTicket; task: Promise<void> } | null = null;
  private disposed = false;
  private enabled = true;
  private visible = true;
  private foregroundBlocked = false;
  private activityEpoch = 0;
  private recovered = false;
  private refreshing: Promise<void> | null = null;
  private sessionId: string | null;
  private floor: string;
  private step: { stateVersion: string; step: ConjugationSessionProjection } | null = null;
  private resultA: ConjugationResultSnapshot | null = null;
  /** Exact address of the selected session's last accepted answer, kept even when its view is stale. */
  private acceptedA: ResultAddress | null = null;
  private display: ConjugationDisplay = { kind: "none" };
  private displayRev = 0;
  private shownAssignment: string | null = null;
  /** Counts presents started here, so a return ticket never outlives the present it waits for. */
  private presentEpoch = 0;
  private closedFacts: ConjugationClosed | null = null;
  private stopRight: { sessionId: string; version: string; stop: boolean; home: boolean } | null = null;
  private problem: string | null = null;
  /** The selected session as the server showed it open in another pair; a step of this pair of it ends it (pairMismatch). */
  private mismatch: string | null = null;
  private stepTicket: { key: string; target: ConjugationDisplay; ticket: ConjugationStepTicket } | null = null;
  private presentationTicket: { key: string; assignmentId: string; ticket: ConjugationPresentationTicket } | null = null;

  constructor(options: ConjugationDocumentOptions) {
    const profile = options.access.profile, address = options.initialResultAddress;
    const addressKeys = ["session_id", "assignment_id", "result_id"] as const;
    if (address != null && (typeof address !== "object" || Object.keys(address).length !== 3
      || addressKeys.some(key => typeof address[key] !== "string" || !uuid(address[key])))) {
      throw new Error("invalid conjugation document context");
    }
    if (options.initialSessionId !== null && !uuid(options.initialSessionId) || !version(profile.state_version)
      || !Array.isArray(options.terminalSessionIds) || options.terminalSessionIds.some(item => !uuid(item))
      || typeof options.newId !== "function" || typeof options.isLive !== "function"
      || typeof options.activity !== "function" || typeof options.minimumStateVersion !== "function") {
      throw new Error("invalid conjugation document context");
    }
    this.options = { ...options };
    this.profile = profile;
    this.pair = `${profile.dictionary_language}-de` as ConjugationSessionProjection["pair"];
    this.sessionId = options.initialSessionId?.toLowerCase() ?? null;
    this.floor = profile.state_version;
    for (const item of options.terminalSessionIds) this.terminal.add(item.toLowerCase());
    if (address && this.sessionId && sameId(address.session_id, this.sessionId) && !this.terminal.has(this.sessionId)) {
      this.acceptedA = { session_id: this.sessionId, assignment_id: address.assignment_id.toLowerCase(), result_id: address.result_id.toLowerCase() };
    }
    this.api = createConjugationApi(options.transport);
    const api = this.api;
    // One owner instance per durable intent: its stateVersion is the version of the view that
    // justified the intent, so the frozen owner refuses a POST once a newer state was observed.
    const make = (lane: ConjugationLane, stateVersion: string): ConjugationCommandController => {
    const owner: ConjugationCommandController = new ConjugationCommandController({
      profileId: profile.profile_id, clientInstanceId: options.access.document.clientInstanceId, pair: this.pair, lane,
      pendingStore: lane === "study" ? options.studyStore : options.stopStore,
      stateVersion, minimumStateVersion: () => this.minimum(), newId: options.newId, isLive: () => this.live(),
      // R6: the status of this ID is read only with the gate's ticket (after the identity check, if one is due).
      check: intent => options.transport.gate.runReadback(intent.command_id, ticket =>
        this.exchange(({ token, proof, clientInstanceId, documentId }) =>
          api.status(token, proof, { ...intent, client_instance_id: clientInstanceId, document_id: documentId }, ticket))),
      gate: options.transport.gate,
      // Revisions read their original triple; start/present/unknown answer/stop read only the original session.
      read: intent => this.exchange<ConjugationRead>(({ token, proof, clientInstanceId, documentId }) => {
        if (intent.kind === "conjugation.schedule") throw new Error("catalog lane is not owned here");
        const address = { session_id: intent.session_id, client_instance_id: clientInstanceId, document_id: documentId };
        return resultAddressed(intent)
          ? api.read(token, proof, { ...address, assignment_id: intent.assignment_id, result_id: intent.result_id })
          : api.read(token, proof, address);
      }),
      send: intent => this.exchange(({ token, proof, clientInstanceId, documentId }) => {
        // Last gate before the POST enters transport; once entered it settles even if the UI closes.
        if (!this.sendable() || this.sendEpoch[lane] !== this.activityEpoch) throw new ClosedAccessError();
        return api.send(token, proof, { ...intent, client_instance_id: clientInstanceId, document_id: documentId });
      }),
      onUpdate: snapshot => {
        if (!this.live() || this.commands[lane] !== owner) return;
        this.ingest(lane, snapshot);
        this.emit();
      },
    });
    return owner;
    };
    this.makeOwner = make;
    this.commands = { study: make("study", this.floor), stop: make("stop", this.floor) };
    this.unsubscribeGate = options.transport.gate.subscribe(() => {
      this.readPausedLanes();
      const shown = JSON.stringify(laneGate(options.transport.gate, this.commands.study.snapshot(), this.commands.stop.snapshot()));
      if (shown !== this.shownGate) { this.shownGate = shown; this.emit(); }
    });
    this.minimum();
  }

  private live(): boolean {
    return !this.disposed && this.options.isLive() && this.options.access.isLive() && this.profile.access.status === "admitted";
  }
  private requireLive(): void { if (!this.live()) throw new ClosedAccessError(); }
  /** Every exchange runs inside the captured access.run and checks THIS owner before the operation,
   * after the await and before rethrow, so an obsolete owner's late 401/403 reaches OpenedAccess
   * only as ClosedAccessError and cannot revoke a still-live access. A live denial is preserved. */
  private exchange<T>(operation: (credentials: AccessCredentials) => Promise<T>): Promise<T> {
    return this.options.access.run(async credentials => {
      this.requireLive();
      let result: T;
      try { result = await operation(credentials); }
      catch (error) { this.requireLive(); throw error; }
      this.requireLive();
      return result;
    });
  }
  private minimum(): string {
    // Never ask a publisher belonging to a disposed document; a vanished publisher never lowers the floor.
    if (!this.live()) return this.floor;
    const external = this.options.minimumStateVersion();
    if (external !== null && !version(external)) throw new Error("invalid conjugation document version");
    if (external !== null) this.raise(external);
    return this.floor;
  }
  private raise(value: string | null): void { if (value !== null && version(value) && BigInt(value) > BigInt(this.floor)) this.floor = value; }
  private fresh(stateVersion: string): boolean { return BigInt(stateVersion) >= BigInt(this.floor); }
  private foreground(): boolean {
    return this.live() && this.visible && !this.foregroundBlocked && this.options.activity().visible !== false;
  }
  /** Enabled/visible close every new mutation of both lanes (DESIGN §5); lifetime and entered POSTs are separate. */
  private sendable(): boolean {
    return this.foreground() && this.enabled && this.options.activity().enabled !== false;
  }
  private selected(sessionId: string): boolean { return this.sessionId !== null && sameId(sessionId, this.sessionId); }
  private setDisplay(display: ConjugationDisplay): void { this.display = display; this.displayRev++; }
  /** After an undo the answer is gone: no address, view, or screen of it remains, and no earlier answer takes its place (CT 2.3). */
  private retireAnswer(): void {
    this.acceptedA = null; this.resultA = null; this.shownAssignment = null;
    if (this.display.kind === "result" || this.display.kind === "summary") this.setDisplay({ kind: "none" });
  }
  private fallbackDisplay(): void { this.setDisplay(this.resultA || this.acceptedA ? { kind: "result" } : { kind: "none" }); }

  private markClosed(sessionId: string): void {
    this.terminal.add(sessionId.toLowerCase());
    if (this.selected(sessionId)) {
      this.step = null; this.resultA = null; this.stopRight = null; this.shownAssignment = null;
      this.stepTicket = null; this.presentationTicket = null;
      if (this.display.kind !== "closed") this.setDisplay({ kind: "closed" });
    }
  }
  /** Immutable history of the selected terminal session; a later fact never overwrites a known one. Grants nothing. */
  private recordClosed(sessionId: string, reason: CloseReason | null, summary: ConjugationSummary | null): void {
    if (!this.selected(sessionId) || !this.terminal.has(sessionId.toLowerCase())) return;
    const known = this.closedFacts && this.selected(this.closedFacts.sessionId) ? this.closedFacts : null;
    this.closedFacts = { sessionId: sessionId.toLowerCase(), reason: known?.reason ?? reason,
      summary: known?.summary ?? (summary ? structuredClone(summary) : null) };
  }
  /** Session projection B of the selected session. It never refreshes A's capabilities. */
  private setStep(step: ConjugationSessionProjection, stateVersion: string): void {
    if (step.status === "closed") { this.markClosed(step.session_id); this.recordClosed(step.session_id, step.close_reason, step.summary); return; }
    if (!this.selected(step.session_id) || this.terminal.has(step.session_id.toLowerCase())) return;
    // An open step of another pair is no failed read: the pair changed elsewhere and the session lives there (R1). It is
    // kept as a fact; nothing of it is shown and it grants no right here (no Stop before the window's refresh).
    if (step.pair !== this.pair) {
      this.step = null; this.stopRight = null; this.mismatch = step.session_id; this.problem = null; return;
    }
    this.mismatch = null;
    this.step = { stateVersion, step: structuredClone(step) };
    this.problem = null;
    this.stopRight = { sessionId: step.session_id, version: stateVersion, stop: step.capabilities.stop, home: step.capabilities.summary_home };
    const assignment = step.status === "active" ? step.assignment : null;
    const display = this.display;
    if (display.kind === "step") {
      // A shown B keeps its address while the fresh step still carries it; a replaced or
      // vanished target cancels the selection without self-showing the replacement.
      if (!assignment || !sameId(assignment.id, display.assignmentId)) { this.shownAssignment = null; this.fallbackDisplay(); }
    } else if (display.kind === "summary") {
      if (step.status !== "summary") this.fallbackDisplay();
    } else if (display.kind === "none" || display.kind === "closed") {
      // Resume restores only an already presented B (no new present needed). A summary or a
      // prefetched B stays data with a stepTicket: the caller selects it via openStep, whenever it chooses.
      if (assignment?.status === "presented") this.setDisplay({ kind: "step", assignmentId: assignment.id.toLowerCase() });
      else if (display.kind === "closed") this.setDisplay({ kind: "none" });
    }
  }
  private observeSession(current: ConjugationSessionProjection | { session_id: string; status: string }, stateVersion: string): void {
    if (!this.fresh(stateVersion)) {
      // A stale closed projection may only complete the frozen facts of a session that is already terminal.
      if ("pair" in current && current.status === "closed" && this.terminal.has(current.session_id.toLowerCase())) {
        this.recordClosed(current.session_id, (current as ConjugationSessionProjection).close_reason, (current as ConjugationSessionProjection).summary);
        return;
      }
      this.problem = "stale_response"; return;
    }
    this.raise(stateVersion);
    if ("pair" in current) { this.setStep(current as ConjugationSessionProjection, stateVersion); return; }
    if (this.selected(current.session_id)) { this.step = null; this.stopRight = null; this.problem = current.status; }
  }
  private observeResult(view: ConjugationResultCurrent, stateVersion: string, address: ResultAddress): void {
    if (!this.fresh(stateVersion)) { this.problem = "stale_response"; return; }
    this.raise(stateVersion);
    // An A that the server shows undone (here or in another window of this document) is no longer an answer to show.
    if (view.result?.status === "undone" && this.acceptedA && sameId(this.acceptedA.result_id, address.result_id)) this.retireAnswer();
    const step = view.step;
    if ("pair" in step) this.setStep(step, stateVersion);
    else if ("session_id" in step && this.selected(step.session_id)) { this.step = null; this.stopRight = null; }
    // A historical receipt of another session stays a fact only; it never opens a view.
    if (!this.selected(address.session_id) || this.terminal.has(address.session_id.toLowerCase())) return;
    if (!this.acceptedA || !sameId(this.acceptedA.result_id, address.result_id)) return;
    this.resultA = view.result === null ? null : { address: { ...this.acceptedA }, stateVersion,
      action: structuredClone(view.action), result: structuredClone(view.result), capabilities: structuredClone(view.capabilities) };
  }
  private ingest(lane: ConjugationLane, snapshot: ConjugationCommandSnapshot): void {
    const stamp = JSON.stringify([snapshot.phase, snapshot.stateVersion, snapshot.view, snapshot.closedSession, snapshot.resolved, snapshot.outcome]);
    if (this.processed[lane] === stamp) return;
    this.processed[lane] = stamp;
    this.raise(snapshot.stateVersion);
    if (snapshot.closedSession) {
      // The boundary proves closure and its reason, not the frozen summary.
      this.markClosed(snapshot.closedSession.session_id);
      this.recordClosed(snapshot.closedSession.session_id, snapshot.closedSession.close_reason, null);
    }
    const resolved = snapshot.resolved;
    if (snapshot.outcome === "accepted" && resolved?.kind === "session.stop" && resolved.sessionId) this.markClosed(resolved.sessionId);
    if (lane === "study" && resolved && snapshot.outcome !== null && resolved.kind === "assignment.present") this.shownAssignment = null;
    if (lane === "study" && snapshot.outcome === "accepted" && resolved?.kind === "result.undo" && resolved.sessionId
      && this.selected(resolved.sessionId)) this.retireAnswer();
    if (lane === "study" && snapshot.outcome === "accepted" && resolved?.kind === "answer.submit" && resolved.sessionId
      && resolved.assignmentId && resolved.resultId && this.selected(resolved.sessionId)
      && !this.seenAnswers.has(resolved.commandId)) {
      // The accepted proof alone fixes A's exact address, independent of the freshness of its view.
      this.seenAnswers.add(resolved.commandId);
      this.acceptedA = { session_id: resolved.sessionId, assignment_id: resolved.assignmentId, result_id: resolved.resultId };
      this.resultA = null; this.shownAssignment = null;
      this.setDisplay({ kind: "result" });
    }
    const view = snapshot.view, stateVersion = snapshot.stateVersion;
    if (!view || !stateVersion) return;
    if (view.kind === "result") {
      // Only an accepted proof or the exact revision intent names A; an answer's result ID is never inferred.
      const intent = snapshot.pendingIntent;
      const address: ResultAddress | null = resolved?.sessionId && resolved.assignmentId && resolved.resultId
        ? { session_id: resolved.sessionId, assignment_id: resolved.assignmentId, result_id: resolved.resultId }
        : intent && resultAddressed(intent)
          ? { session_id: intent.session_id, assignment_id: intent.assignment_id, result_id: intent.result_id } : null;
      // An accepted undo names the answer it retired; it must not bring it back as A.
      if (address && resolved?.kind !== "answer.submit" && resolved?.kind !== "result.undo" && this.selected(address.session_id)
        && (!this.acceptedA || sameId(this.acceptedA.result_id, address.result_id))) {
        this.acceptedA = { session_id: address.session_id.toLowerCase(), assignment_id: address.assignment_id.toLowerCase(),
          result_id: address.result_id.toLowerCase() };
      }
      if (address) this.observeResult(view as ResultView, stateVersion, address);
      else if ("pair" in view.step) this.observeSession(view.step, stateVersion);
    } else if (view.kind === "session" && "session_id" in view.current) this.observeSession(view.current, stateVersion);
  }
  private foreignPending(commands: Record<ConjugationLane, ConjugationCommandSnapshot>, except: string | null = this.sessionId): boolean {
    return Object.values(commands).some(command => command.pending && command.sessionId !== null
      && !(except !== null && sameId(command.sessionId, except)) && !this.terminal.has(command.sessionId.toLowerCase()));
  }
  private ready(snapshot: ConjugationCommandSnapshot, lane: ConjugationLane): boolean {
    return !snapshot.pending && ["idle", "settled"].includes(snapshot.phase) && !this.tasks[lane];
  }

  snapshot(): ConjugationDocumentSnapshot {
    const live = this.live();
    if (live) this.minimum();
    const commands = { study: this.commands.study.snapshot(), stop: this.commands.stop.snapshot() };
    const closed = !!this.sessionId && this.terminal.has(this.sessionId.toLowerCase());
    const unresolved = (command: ConjugationCommandSnapshot) => command.pending && command.outcome === null
      && ["unresolved", "blocked"].includes(command.phase);
    const presenting = this.shownAssignment !== null || commands.study.pending && commands.study.kind === "assignment.present"
      && commands.study.sessionId !== null && this.selected(commands.study.sessionId);
    const unknown = unresolved(commands.study) && !presenting || unresolved(commands.stop);
    const sendingStop = !!this.tasks.stop && !unresolved(commands.stop) || commands.stop.phase === "sending";
    const studyReady = this.ready(commands.study, "study"), stopReady = this.ready(commands.stop, "stop");
    // A confirmed addressed session is authoritative for continuing study; a fully settled historical
    // receipt cannot override it, while a foreign receipt awaiting resolution or durable cleanup does.
    // Without a seed, recovery never elects a session from the order in which receipts finish.
    const foreignReceipt = this.foreignPending(commands);
    const foreground = live && this.foreground(), study = foreground && this.sendable();
    const settledView = foreground && !closed && !this.refreshing && !foreignReceipt && !unknown;
    const step = settledView && this.step && this.fresh(this.step.stateVersion) ? this.step : null;
    const resultA = settledView && this.resultA && this.fresh(this.resultA.stateVersion)
      && this.selected(this.resultA.address.session_id) ? this.resultA : null;
    const flowReady = study && this.recovered && studyReady && stopReady && settledView;
    const assignment = step?.step.status === "active" ? step.step.assignment : null;

    let display: ConjugationDisplay = closed ? { kind: "closed" } : this.display;
    if (display.kind === "result" && !resultA) display = { kind: "none" };
    if (display.kind === "step" && !(assignment && sameId(assignment.id, display.assignmentId))) display = { kind: "none" };
    if (display.kind === "summary" && step?.step.status !== "summary") display = { kind: "none" };
    // C1: the B whose present is pending was already visible, so returning to it from A needs no new present.
    // Only a B shown here or named by the selected session's durable present qualifies; dependent rights stay closed.
    const durablePresent = commands.study.pending && commands.study.pendingIntent?.kind === "assignment.present"
      && this.selected(commands.study.pendingIntent.session_id) ? commands.study.pendingIntent.assignment_id : null;
    const shownB = presenting ? this.shownAssignment ?? durablePresent : null;
    const returnReady = study && this.recovered && stopReady && settledView && display.kind === "result"
      && !!shownB && !!assignment && sameId(assignment.id, shownB);

    // Step ticket: explicit, caller-chosen transition to exactly the current B or summary.
    const target: ConjugationDisplay | null = !step ? null : assignment ? { kind: "step", assignmentId: assignment.id.toLowerCase() }
      : step.step.status === "summary" ? { kind: "summary" } : null;
    const alreadyThere = target && (target.kind === "summary" ? this.display.kind === "summary"
      : this.display.kind === "step" && target.kind === "step" && this.display.assignmentId === target.assignmentId);
    if (flowReady && target && !alreadyThere && !presenting) {
      const key = JSON.stringify([this.sessionId, target, step!.stateVersion, this.displayRev, this.activityEpoch]);
      if (this.stepTicket?.key !== key) this.stepTicket = { key, target, ticket: freshTicket<ConjugationStepTicket>() };
    } else if (returnReady) {
      const assignmentId = assignment!.id.toLowerCase();
      const key = JSON.stringify(["return", this.sessionId, assignmentId, step!.stateVersion, this.displayRev, this.activityEpoch, this.presentEpoch]);
      if (this.stepTicket?.key !== key) this.stepTicket = { key, target: { kind: "step", assignmentId }, ticket: freshTicket<ConjugationStepTicket>() };
    } else this.stepTicket = null;
    // Presentation ticket: only the selected, still prefetched B; obtaining it is not a show.
    if (flowReady && !presenting && display.kind === "step" && assignment?.status === "prefetched") {
      const key = JSON.stringify([this.sessionId, assignment.id.toLowerCase(), step!.stateVersion, this.displayRev, this.activityEpoch]);
      if (this.presentationTicket?.key !== key) {
        this.presentationTicket = { key, assignmentId: assignment.id.toLowerCase(), ticket: freshTicket<ConjugationPresentationTicket>() };
      }
    } else this.presentationTicket = null;

    // §4.1 «Правило кнопки» (K01s, K03, K06; C335, M-P03-10): every manual mutation of the screen waits for mayWrite.
    const writable = this.options.transport.gate.mayWrite();
    const mutate = flowReady && !presenting && writable;
    const caps = resultA?.capabilities, result = resultA?.result;
    const target3 = (value: { session_id: string; assignment_id: string; result_id: string; expected_result_version: string } | null | undefined) =>
      !!value && !!result && !!resultA && result.status === "active" && sameId(value.session_id, resultA.address.session_id)
      && sameId(value.assignment_id, resultA.address.assignment_id) && sameId(value.result_id, resultA.address.result_id)
      && value.expected_result_version === result.version;
    const allowedGrades = mutate && caps?.grades && target3(caps.grades) ? [...caps.grades.values] as (3 | 4 | 5)[] : [];
    const right = this.stopRight;
    // Stop needs open activity like any mutation, but not a ready study lane (unknown study must not block it).
    const canStopBase = study && writable && stopReady && !closed && !!right && this.fresh(right.version) && this.selected(right.sessionId);
    // «На Сегодня» ends the natural summary, so unlike Stop it also waits for a ready study lane and a fresh summary
    // step (V-1, C083): an undo in flight could reopen the session and turn the summary_home into a refusal that a
    // late copy of the same command would replay on the next summary. stop() re-reads this before it begins.
    const summaryReady = mutate && step?.step.status === "summary";

    let phase: ConjugationDocumentSnapshot["phase"];
    if (!live) phase = "disposed";
    else if (closed) phase = "closed";
    else if (sendingStop) phase = "stopping";
    else if (presenting) phase = "visible_unconfirmed";
    else if (unknown || foreignReceipt) phase = "unknown";
    else if (!this.recovered || this.refreshing) phase = "loading";
    else if (display.kind === "result") phase = "result";
    else if (display.kind === "summary") phase = "summary";
    else if (display.kind === "step") phase = assignment?.status === "presented" ? "question" : "prefetched";
    else if (assignment?.status === "prefetched") phase = "prefetched";
    else if (step?.step.status === "summary") phase = "summary";
    // A suspended owner hides its session until its window's foreground answers: that is loading, not a failed
    // refresh. Otherwise every return from the background reads as an error (2.33; same as the oral owner).
    else phase = this.sessionId ? this.foregroundBlocked ? "loading" : "stale" : "idle";

    return {
      phase, sessionId: live ? this.sessionId : null, stateVersion: this.floor, terminalSessionIds: [...this.terminal],
      closed: live && closed ? this.closedSnapshot(this.sessionId!) : null,
      acceptedAddress: live && !closed && this.acceptedA && this.selected(this.acceptedA.session_id) ? { ...this.acceptedA } : null, commands,
      // A known server refusal of a lane reaches the screen as its code (CT табл. 2.2), as in Learning and written.
      problem: live ? commands.study.problem ?? commands.study.rejectionCode ?? commands.stop.problem ?? commands.stop.rejectionCode
        ?? this.problem ?? (foreignReceipt ? "unconfirmed_session" : null) : null,
      pairMismatch: live && !closed && this.mismatch !== null && this.selected(this.mismatch) ? this.mismatch.toLowerCase() : null,
      currentStep: step ? structuredClone(step) : null,
      resultA: resultA ? structuredClone(resultA) : null,
      display: live ? { ...display } : { kind: "none" },
      stepTicket: live ? this.stepTicket?.ticket ?? null : null,
      presentationTicket: live ? this.presentationTicket?.ticket ?? null : null,
      canStart: study && writable && this.recovered && !this.refreshing && studyReady && stopReady && !foreignReceipt && !unknown
        && (!this.sessionId || closed),
      canSubmit: mutate && display.kind === "step" && assignment?.status === "presented"
        && !!step && sameId(step.step.capabilities.answer_target ?? "", assignment.id),
      canCorrect: mutate && !!caps?.correct_target && target3(caps.correct_target),
      canUndo: mutate && !!caps?.undo_target && target3(caps.undo_target),
      canStop: canStopBase && !!right?.stop, canSummaryHome: canStopBase && !!right?.home && summaryReady,
      allowedGrades,
      canRetry: { study: study && commands.study.canRetry && !this.tasks.study, stop: study && commands.stop.canRetry && !this.tasks.stop },
      gate: laneGate(this.options.transport.gate, commands.study, commands.stop),
    };
  }
  private closedSnapshot(sessionId: string): ConjugationClosed {
    const facts = this.closedFacts && sameId(this.closedFacts.sessionId, sessionId) ? this.closedFacts : null;
    return { sessionId, reason: facts?.reason ?? null, summary: facts?.summary ? structuredClone(facts.summary) : null };
  }
  private emit(): void {
    if (!this.live()) return;
    const snapshot = this.snapshot();
    if (this.live()) this.options.onUpdate(snapshot);
  }

  /** Enabled/visible close new actions only; lifetime is separate. Hidden closes foreground for this owner for good. */
  setActivity(activity: { enabled: boolean; visible: boolean }): void {
    if (!this.live() || typeof activity?.enabled !== "boolean" || typeof activity.visible !== "boolean") return;
    if (!activity.visible) this.foregroundBlocked = true;
    if (!activity.visible || this.enabled !== activity.enabled) {
      this.activityEpoch++; this.stepTicket = null; this.presentationTicket = null;
    }
    this.enabled = activity.enabled; this.visible = activity.visible; this.emit();
  }

  /** Reconciles both durable lanes, then reads the confirmed session and the known A. GET only. */
  refresh(): Promise<void> {
    if (!this.live()) return Promise.resolve();
    if (this.refreshing) return this.refreshing;
    const task = Promise.resolve().then(async () => {
      if (!this.live()) return;
      await Promise.all([this.commands.study.refresh(), this.commands.stop.refresh()]);
      if (!this.live()) return;
      this.recovered = true;
      await this.readSelected(true);
      await this.readClosed();
    }).finally(() => {
      if (this.refreshing === task) this.refreshing = null;
      this.emit();
    });
    this.refreshing = task; this.emit();
    return task;
  }
  private async readSelected(always: boolean): Promise<void> {
    const sessionId = this.sessionId;
    if (!sessionId || !this.live() || this.terminal.has(sessionId.toLowerCase())) return;
    if (always || !this.step || !this.fresh(this.step.stateVersion)) await this.readSession(sessionId);
    const address = this.acceptedA;
    if (!this.live() || !address || !this.selected(address.session_id) || this.terminal.has(sessionId.toLowerCase())) return;
    if (always || !this.resultA || !this.fresh(this.resultA.stateVersion)) await this.readResult(address);
  }
  /** C2: the only read of a terminal session. While its frozen summary is unknown, one addressed GET per
   * refresh; it accepts nothing but a closed projection of that same ID and never revives the address. */
  private async readClosed(): Promise<void> {
    const sessionId = this.sessionId;
    if (!sessionId || !this.live() || !this.terminal.has(sessionId.toLowerCase())) return;
    if (this.closedFacts && sameId(this.closedFacts.sessionId, sessionId) && this.closedFacts.summary) return;
    try {
      const read = await this.exchange(({ token, proof, clientInstanceId, documentId }) =>
        this.api.read(token, proof, { session_id: sessionId, client_instance_id: clientInstanceId, document_id: documentId }));
      if (!this.live() || !this.selected(sessionId)) return;
      const current = read.current;
      if ("pair" in current && current.status === "closed" && sameId(current.session_id, sessionId)) {
        this.recordClosed(sessionId, current.close_reason, current.summary);
      }
    } catch {
      // The summary stays unknown (null); there is no automatic retry.
    }
  }
  private async readSession(sessionId: string): Promise<void> {
    try {
      const read = await this.exchange(({ token, proof, clientInstanceId, documentId }) =>
        this.api.read(token, proof, { session_id: sessionId, client_instance_id: clientInstanceId, document_id: documentId }));
      if (!this.live() || !this.selected(sessionId)) return;
      this.observeSession(read.current, read.state_version);
    } catch (error) {
      if (!this.live()) return;
      this.step = null; this.stopRight = null;
      this.problem = readProblem(error);
    }
  }
  private async readResult(address: ResultAddress): Promise<void> {
    try {
      const read = await this.exchange(({ token, proof, clientInstanceId, documentId }) =>
        this.api.read(token, proof, { ...address, client_instance_id: clientInstanceId, document_id: documentId }));
      if (!this.live()) return;
      this.observeResult(read, read.state_version, address);
    } catch (error) {
      if (!this.live()) return;
      this.resultA = null;
      this.problem = readProblem(error);
    }
  }
  private begin(lane: ConjugationLane, transition: ConjugationTransition | null, basis: string | null): Promise<void> {
    if (this.tasks[lane]) return this.tasks[lane]!;
    if (!this.sendable()) return Promise.resolve();
    if (transition && (basis === null || !this.ready(this.commands[lane].snapshot(), lane))) return Promise.resolve();
    this.sendEpoch[lane] = this.activityEpoch;
    this.stepTicket = null; this.presentationTicket = null;
    const before = transition ? null : this.commands[lane].snapshot().pendingIntent;
    let owner = this.commands[lane];
    if (transition) {
      // A ready lane holds no durable intent; the new intent gets an owner bound to its basis version.
      owner.dispose();
      owner = this.commands[lane] = this.makeOwner(lane, basis!);
      this.processed[lane] = undefined;
    }
    const task = (async () => {
      if (transition) {
        await owner.refresh();
        if (!this.live() || this.commands[lane] !== owner) return;
        await owner.begin(transition);
      } else await owner.retry();
      if (!this.live() || this.commands[lane] !== owner) return;
      const command = owner.snapshot();
      this.ingest(lane, command);
      // A manual retry of the retained start is an explicit choice of that exact session.
      // Passive recovery never elects a session from receipt order.
      if (before?.kind === "session.start" && command.outcome === "accepted" && !this.sessionId
        && !this.terminal.has(before.session_id.toLowerCase())
        && !this.foreignPending({ study: command, stop: this.commands.stop.snapshot() }, before.session_id)) {
        this.sessionId = before.session_id.toLowerCase();
        this.processed[lane] = undefined;
        this.ingest(lane, command);
      }
      if (command.outcome === "rejected" || command.outcome === "not_applied" || lane === "study" && command.outcome === "accepted") {
        await this.readSelected(command.outcome !== "accepted");
      }
    })().finally(() => {
      if (this.tasks[lane] === task) this.tasks[lane] = null;
      if (lane === "study" && !this.commands.study.snapshot().pending) this.shownAssignment = null;
      this.emit();
    });
    this.tasks[lane] = task;
    return task;
  }
  private pendingJoin(task: Promise<void> | null | undefined): Promise<void> | null {
    return task && this.live() && this.tasks.study === task ? task : null;
  }
  start(): Promise<void> {
    const joined = this.pendingJoin(this.startJoin);
    if (joined) return joined;
    this.startJoin = null;
    if (!this.snapshot().canStart) return Promise.resolve();
    const sessionId = this.options.newId();
    if (!uuid(sessionId)) return Promise.reject(new Error("invalid conjugation session ID"));
    // Only what this document itself showed before the tap (its idle screen or the closure it knew), never server rights:
    // the step, the result A and its address and the Stop right stay cleared.
    const before = { sessionId: this.sessionId, closedFacts: this.closedFacts, problem: this.problem, display: this.display };
    this.sessionId = sessionId.toLowerCase();
    this.step = null; this.resultA = null; this.acceptedA = null; this.stopRight = null; this.shownAssignment = null; this.problem = null;
    this.closedFacts = null; this.mismatch = null;
    this.setDisplay({ kind: "none" });
    const task = this.begin("study", { kind: "session.start", session_id: this.sessionId, payload: { mode: "conjugation" } }, this.floor);
    if (this.tasks.study === task) {
      this.startJoin = task; // before emit: a synchronous onUpdate repeat joins too
      // The start met another record in the shared slot and was neither stored nor sent: no session of its ID exists to
      // read or check. The document goes back to what it showed; the lane's block names the reason.
      const started = this.sessionId;
      void task.then(() => {
        // A disposed owner (a repeated mount) or a newer selection keeps its own state. While the start runs nothing else
        // can begin: the Stop right and the step were cleared above, and a second start joins this one.
        if (!this.live() || this.sessionId !== started || !unsentSlot(this.commands.study.snapshot())) return;
        this.sessionId = before.sessionId; this.closedFacts = before.closedFacts; this.problem = before.problem;
        this.setDisplay(before.display); this.emit();
      }, () => undefined);
    }
    this.emit();
    return task;
  }
  openStep(ticket: ConjugationStepTicket): void {
    const snapshot = this.snapshot(), bound = this.stepTicket;
    if (!ticket || !bound || ticket !== snapshot.stepTicket || ticket !== bound.ticket) return;
    this.stepTicket = null;
    this.setDisplay(bound.target);
    this.emit();
  }
  openResult(): void {
    const snapshot = this.snapshot();
    if (!snapshot.resultA || this.display.kind === "result") return;
    // The presentation barrier of a shown B stays in force; only the local display changes.
    this.setDisplay({ kind: "result" });
    this.emit();
  }
  shown(ticket: ConjugationPresentationTicket): Promise<void> {
    // The same genuine ticket repeated while its present is pending awaits that present; it creates no UUID.
    // Any other (cloned, foreign, invalidated, already settled) ticket stays a no-op.
    const joined = ticket && this.shownJoin?.ticket === ticket ? this.pendingJoin(this.shownJoin.task) : null;
    if (joined) return joined;
    if (this.shownJoin && !this.pendingJoin(this.shownJoin.task)) this.shownJoin = null;
    const snapshot = this.snapshot(), bound = this.presentationTicket;
    if (!ticket || !bound || ticket !== snapshot.presentationTicket || ticket !== bound.ticket || !snapshot.sessionId) return Promise.resolve();
    this.presentationTicket = null; this.shownAssignment = bound.assignmentId; this.presentEpoch++;
    const task = this.begin("study", { kind: "assignment.present", session_id: snapshot.sessionId, assignment_id: bound.assignmentId, payload: {} },
      snapshot.currentStep?.stateVersion ?? null);
    if (this.tasks.study === task) this.shownJoin = { ticket, task };
    else this.shownAssignment = null;
    this.emit();
    return task;
  }
  submit(answer: { text: string } | { forgot: true }, assignmentId: string): Promise<void> {
    const keys = answer !== null && typeof answer === "object" ? Object.keys(answer) : [];
    const text = keys.length === 1 && keys[0] === "text" && typeof (answer as { text: unknown }).text === "string";
    const forgot = keys.length === 1 && keys[0] === "forgot" && (answer as { forgot: unknown }).forgot === true;
    if (!text && !forgot) return Promise.reject(new Error("conjugation answer requires exact text or forgot"));
    if (typeof assignmentId !== "string" || !uuid(assignmentId)) return Promise.reject(new Error("conjugation answer requires its assignment"));
    const snapshot = this.snapshot();
    // An answer typed for one form is never sent to another one the document reached in the meantime (R-G1).
    if (!snapshot.canSubmit || snapshot.display.kind !== "step" || !sameId(snapshot.display.assignmentId, assignmentId)) {
      return this.tasks.study ?? Promise.resolve();
    }
    // Verbatim: no trim, normalization or client-side grading.
    const payload = text ? { text: (answer as { text: string }).text } : { forgot: true as const };
    return this.begin("study", { kind: "answer.submit", session_id: snapshot.sessionId!, assignment_id: snapshot.display.assignmentId, payload },
      snapshot.currentStep?.stateVersion ?? null);
  }
  grade(value: 3 | 4 | 5): Promise<void> {
    if (value !== 3 && value !== 4 && value !== 5) return Promise.reject(new Error("conjugation grade must be 3, 4 or 5"));
    const snapshot = this.snapshot(), target = snapshot.resultA?.capabilities.grades;
    if (!snapshot.allowedGrades.includes(value) || !target) return this.tasks.study ?? Promise.resolve();
    return this.begin("study", { kind: "result.grade", session_id: target.session_id, assignment_id: target.assignment_id,
      result_id: target.result_id, expected_result_version: target.expected_result_version, payload: { grade: value } },
      snapshot.resultA!.stateVersion);
  }
  correct(): Promise<void> {
    const snapshot = this.snapshot(), target = snapshot.resultA?.capabilities.correct_target;
    if (!snapshot.canCorrect || !target) return this.tasks.study ?? Promise.resolve();
    return this.begin("study", { kind: "result.correct", session_id: target.session_id, assignment_id: target.assignment_id,
      result_id: target.result_id, expected_result_version: target.expected_result_version, payload: {} },
      snapshot.resultA!.stateVersion);
  }
  /** The one undo of the A on screen, built only from the server's undo_target (never from the grade or history). */
  undo(): Promise<void> {
    const snapshot = this.snapshot(), target = snapshot.resultA?.capabilities.undo_target;
    if (!snapshot.canUndo || !target) return this.tasks.study ?? Promise.resolve();
    return this.begin("study", undoAction(target), snapshot.resultA!.stateVersion);
  }
  stop(reason: "stop" | "summary_home"): Promise<void> {
    if (reason !== "stop" && reason !== "summary_home") return Promise.reject(new Error("conjugation stop reason required"));
    const snapshot = this.snapshot();
    if (!(reason === "stop" ? snapshot.canStop : snapshot.canSummaryHome)) return this.tasks.stop ?? Promise.resolve();
    return this.begin("stop", { kind: "session.stop", session_id: snapshot.sessionId!, payload: { reason } }, this.stopRight?.version ?? null);
  }
  /** Manual only: the owner re-proves the exact retained UUID/payload by GET before its one POST. */
  retry(lane: ConjugationLane): Promise<void> {
    if (lane !== "study" && lane !== "stop") return Promise.reject(new Error("invalid conjugation lane"));
    if (this.tasks[lane]) return this.tasks[lane]!;
    if (!this.snapshot().canRetry[lane]) return Promise.resolve();
    return this.begin(lane, null, null);
  }

  /**
   * M03 (P03 §5.2): once the gate lets a write through again, an intent the gate kept on the client is read by its ID
   * (refresh reads only, never POSTs); the lane then offers the same send again.
   */
  private readPausedLanes(): void {
    if (!this.live()) return;
    const gate = this.options.transport.gate;
    const paused = (["study", "stop"] as const).some(lane => {
      const state = this.commands[lane].snapshot(), id = state.pendingIntent?.command_id;
      return state.problem === "paused" && !!id && gate.mayWrite(id);
    });
    if (paused) void this.refresh();
  }
  private unsubscribeGate: () => void = () => undefined;
  private shownGate = "";
  dispose(): void {
    this.unsubscribeGate();
    this.disposed = true; this.activityEpoch++; this.startJoin = null; this.shownJoin = null;
    this.step = null; this.resultA = null; this.stopRight = null; this.stepTicket = null; this.presentationTicket = null;
    this.commands.study.dispose(); this.commands.stop.dispose();
  }
}

/** The shared slot refused a new intent of the lane (another record, or one it cannot read): dropped, neither stored nor sent. */
function unsentSlot(command: ConjugationCommandSnapshot): boolean {
  return !command.pending && command.outcome === null && (command.problem === "pending_changed" || command.problem === "invalid_pending");
}
