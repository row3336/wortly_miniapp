import type { LaneGate } from "../commands/gateWait";
import type { OralSessionProjection } from "../api/generated";
import { ApiError, type HttpOptions } from "../api/http";
import { sameId, uuid, version } from "../api/wireValidation";
import { ClosedAccessError, type OpenedAccess } from "../app/openedAccess";
import { onlyCheckedAbsent } from "../commands/commandLane";
import type { RecoveryView } from "../commands/laneRecovery";
import { createOralApi, type OralRead } from "./oralApi";
import type { OralCommandSnapshot, OralTransition } from "./oralCommandController";
import { OralDocumentCommands, type OralLanesSnapshot } from "./oralDocumentCommands";
import type { OralCommandLane, OralSessionPendingStore, OralStopPendingStore } from "./oralPending";
import { leaveOralClosure, noteOralClosure, oralClosureLeft, unleftOralClosure, type OralClosureOwner } from "./oralClosureHandoff";

type AccessCredentials = Parameters<Parameters<OpenedAccess["run"]>[0]>[0];

declare const presentationBrand: unique symbol;
/** Only reference equality authenticates a ticket; its contents are intentionally opaque. */
export type OralPresentationTicket = Readonly<{ [presentationBrand]: true }>;
/** Server facts of this owner's own closed session. summaryRead describes their acquisition only; it is data, never a right. */
export type OralClosed = {
  sessionId: string;
  reason: OralSessionProjection["close_reason"];
  summary: OralSessionProjection["summary"];
  progress: OralSessionProjection["progress"] | null;
  summaryRead: "pending" | "reading" | "failed" | "known";
};
export type OralDocumentSnapshot = {
  phase: "loading" | "idle" | "prefetched" | "visible_unconfirmed" | "question" | "revealed"
    | "unknown" | "summary" | "stopping" | "closed" | "stale" | "disposed";
  sessionId: string | null;
  current: OralSessionProjection | null;
  stateVersion: string;
  terminalSessionIds: string[];
  commands: Record<OralCommandLane, OralCommandSnapshot>;
  problem: string | null;
  presentationTicket: OralPresentationTicket | null;
  canStart: boolean; canReveal: boolean; canGrade: boolean; canStop: boolean; canSummaryHome: boolean;
  canRetry: Record<OralCommandLane, boolean>;
  /** The write gate of the manual controls (C335; M-P03-10): «Проверить» and the resends wait for it, visibly. */
  gate?: LaneGate;
  closed: OralClosed | null;
  /** Sessions this owner closed by a Stop naming X (T1): only their summary reads GET /notices for answer_loss (Т2). */
  unsavedClosures?: readonly string[];
  /**
   * The own session the server proved open in another pair (a read or a reply not below the floor): a fact about the
   * session, not a failed update, so it is never the shown problem (C149, C178; as StudyViewFields). null when nothing
   * proves it.
   */
  pairMismatch: string | null;
  /** Loading only because the owner waits for its window's foreground answer: nothing else of it is to be shown (2.33). */
  suspended?: true;
  /**
   * The only cause of `problem` is a successful lane check that found its command absent on the same open step
   * ("not_found"): nothing failed, the outcome of the action is just not confirmed. Set only when every current cause
   * agrees, so an older marker of the other lane never hides a read failure, a lost connection or a stale answer.
   */
  checkedAbsent?: true;
  /**
   * P2-B (Codex C537; Q32, TZA :295): the fresh, lane-proven closure of this client's own earlier oral session of the pair it
   * left (commandLane ownClosureOfOtherPair: its profile, its installation, its record's pair), seen by an owner of the new
   * pair that has no session of its own yet. Only the closure and its real reason: never this pair's current session,
   * never its numbers, cards or rights. Absent once this owner has a session.
   */
  priorClosure?: { sessionId: string; reason: NonNullable<OralClosed["reason"]> };
  /**
   * M1d (Q19 вариант 1, К19-018; CON §6.1 п.1–4): the automatic recovery of the study action (present, reveal, grade) on the
   * shared mechanism of CP5b (DocumentLanes): its machine's view, null when none was needed in this document.
   */
  recovery?: RecoveryView | null;
  /** The study lane holds an automatic step: it is recovered by its machine, never by a manual check or retry. */
  automaticStudy?: true;
  /** 9.2.12 + Q30: the closure C's own budget ran out with the session open — «Повторить завершение» (canRetry.stop). */
  closureFailed?: true;
  /** Q34 (вар.1, К19-029): the send budget of this page cannot be opened: no study send at all, the start included. */
  storageUnavailable?: true;
  /** The last «Начать» sent nothing: damaged records or a failed write of its budget (D-CP5A-DAMAGE-EXIT 3.2). */
  startBlocked?: "damage" | "storage";
};
const busyRefusal = (commands: Record<OralCommandLane, OralCommandSnapshot>): "SESSION_BUSY" | null =>
  commands.study.rejectionCode === "SESSION_BUSY" || commands.stop.rejectionCode === "SESSION_BUSY" ? "SESSION_BUSY" : null;
export type OralDocumentOptions = {
  access: OpenedAccess;
  transport: HttpOptions;
  studyStore: OralSessionPendingStore;
  stopStore: OralStopPendingStore;
  newId(): string;
  /** Only a shared resume read that confirmed mode=oral may supply an active seed; the React adapter may re-supply this identity's own terminal session id, which is never revived. */
  initialSessionId: string | null;
  minimumStateVersion?(): string | null;
  terminalSessionIds?: readonly string[];
  /**
   * The facts of the initial session as the previous owner of this identity knew them, when that session is terminal
   * (useOralDocument Retained; M1d, Q32/C577): its reason stays known; numbers only if they were read.
   */
  retainedClosed?: OralClosed | null;
  enabled?: boolean;
  /** Adapter source guard also applies before React effect cleanup. */
  isLive?(): boolean;
  /** Adapter may close activity gates during render, before its effects run. */
  activity?(): { enabled: boolean; visible: boolean };
  onUpdate(snapshot: OralDocumentSnapshot): void;
};

/** Owns one immutable opened source. Durable slots outlive this Module. */
export class OralDocumentController {
  private readonly options: Readonly<OralDocumentOptions>;
  /** Both durable lanes on the shared mechanism of CP5b (M1d): study (its primary lane) and stop. */
  private readonly lanes: OralDocumentCommands;
  private readonly terminal = new Set<string>();
  private readonly receiptSessions = new Set<string>();
  private readonly processed: Partial<Record<OralCommandLane, string>> = {};
  private readonly sendEpoch: Record<OralCommandLane, number> = { study: -1, stop: -1 };
  private readonly busy: Record<OralCommandLane, boolean> = { study: false, stop: false };
  private disposed = false;
  private enabled: boolean;
  private visible = true;
  private foregroundBlocked = false;
  private activityEpoch = 0;
  private recovered = false;
  private refreshing: Promise<void> | null = null;
  private queuedCheck: Promise<void> | null = null;
  private sessionId: string | null;
  private floor: string;
  private current: OralSessionProjection | null = null;
  private currentVersion: string | null = null;
  private problem: string | null = null;
  /** The own session as the server showed it open in another pair; a projection of this pair of it ends it (pairMismatch). */
  private mismatch: string | null = null;
  private ticket: OralPresentationTicket | null = null;
  private shownPending = false;
  private stopRight: { sessionId: string; version: string; stop: boolean; home: boolean } | null = null;
  private closedFacts: OralClosed | null = null;
  private priorClosure: { sessionId: string; reason: NonNullable<OralClosed["reason"]> } | null = null;
  /** The profile and installation of this owner: the key of the closures handed off between owners (oralClosureHandoff). */
  private readonly closureOwner: OralClosureOwner;
  /** The study command whose outcome this owner already followed with a read of its session (once per ID). */
  private followed: string | null = null;
  private followRead: Promise<void> | null = null;
  /** The summary of the initial closed session came from the previous owner of this identity (retainedClosed). */
  private carriedSummary = false;

  constructor(options: OralDocumentOptions) {
    if (options.initialSessionId !== null && !uuid(options.initialSessionId)
      || !version(options.access.profile.state_version)
      || options.terminalSessionIds?.some(item => !uuid(item))) throw new Error("invalid oral document context");
    this.options = { ...options };
    this.enabled = options.enabled !== false;
    this.sessionId = options.initialSessionId;
    this.floor = options.access.profile.state_version;
    for (const item of options.terminalSessionIds ?? []) this.terminal.add(item.toLowerCase());
    this.closureOwner = { profileId: options.access.profile.profile_id, clientInstanceId: options.access.document.clientInstanceId };
    // C537/C581: a closure of an own earlier session that an owner before this one accepted and whose frame the person has
    // not left yet (the window moved to another pair meanwhile): shown as the earlier session's closure while this owner
    // has no session of its own — the fact and its reason only, never that session as the current one.
    if (this.sessionId === null) this.priorClosure = unleftOralClosure(this.closureOwner);
    const retained = options.retainedClosed;
    if (retained && this.sessionId && sameId(retained.sessionId, this.sessionId) && this.terminal.has(this.sessionId.toLowerCase())) {
      // The reason stays known; the summary is read once more by this owner as before, and a summary the previous owner
      // read is kept if that read fails or answers below the floor (it was accepted then).
      this.closedFacts = { ...structuredClone(retained), summaryRead: "pending" };
      this.carriedSummary = retained.summaryRead === "known";
    }
    this.lanes = new OralDocumentCommands({
      access: () => options.access, transport: options.transport, studyStore: options.studyStore, stopStore: options.stopStore,
      newId: options.newId, minimumStateVersion: () => this.live() ? this.minimum() : null,
      // A manual send goes only in the activity epoch of its tap; a send of a recovery machine follows the visibility of
      // the window alone (as the written and Learning views: a route away does not stop the recovery, a background does).
      sendable: (lane, automatic) => automatic ? this.active("stop") : this.active(lane) && this.sendEpoch[lane] === this.activityEpoch,
      ownerLive: () => this.live(),
      onUpdate: snapshot => {
        // The shared lanes may publish while they are being built (before this.lanes is set): nothing to show yet.
        if (!this.lanes || !this.live()) return;
        this.ingestLanes(snapshot);
        this.emit();
      },
    });
  }
  private live(): boolean {
    return !this.disposed && (this.options.isLive?.() ?? true) && this.options.access.isLive()
      && this.options.access.profile.access.status === "admitted";
  }
  private requireLive(): void { if (!this.live()) throw new ClosedAccessError(); }
  /** Cut off an obsolete owner's response before OpenedAccess can handle denial.
   * Activity is deliberately separate: already sent intents still settle while disabled. */
  private exchange<T>(operation: (credentials: AccessCredentials) => Promise<T>): Promise<T> {
    return this.options.access.run(async credentials => {
      this.requireLive();
      try {
        const result = await operation(credentials);
        this.requireLive();
        return result;
      } catch (error) {
        this.requireLive();
        throw error;
      }
    });
  }
  private minimum(): string {
    // Never ask a publisher belonging to a disposed document for new observations.
    if (!this.live()) return this.floor;
    const external = this.options.minimumStateVersion?.() ?? null;
    if (external !== null && !version(external)) throw new Error("invalid oral document version");
    if (external !== null) this.raise(external);
    return this.floor;
  }
  private raise(value: string): void { if (BigInt(value) > BigInt(this.floor)) this.floor = value; }
  private active(lane: OralCommandLane): boolean {
    if (!this.live()) return false;
    const activity = this.options.activity?.();
    return this.visible && !this.foregroundBlocked && activity?.visible !== false
      && (lane === "stop" || this.enabled && activity?.enabled !== false);
  }
  private markClosed(sessionId: string): void {
    this.terminal.add(sessionId.toLowerCase());
    if (this.sessionId && sameId(sessionId, this.sessionId)) {
      this.current = null; this.ticket = null; this.shownPending = false; this.stopRight = null;
    }
  }
  /** Facts of this owner's own terminal session: the reason from a closed projection of that id or a boundary, the numbers
   * only from a closed projection of that id and this owner's pair; never from an active projection. The first known value wins. Grants nothing.
   * Returns whether the projection supplied the facts. */
  private recordClosed(sessionId: string, reason: OralClosed["reason"], projection: OralSessionProjection | null): boolean {
    if (!this.sessionId || !sameId(sessionId, this.sessionId) || !this.terminal.has(sessionId.toLowerCase())) return false;
    if (!this.closedFacts || !sameId(this.closedFacts.sessionId, sessionId)) {
      this.closedFacts = { sessionId: this.sessionId, reason: null, summary: null, progress: null, summaryRead: "pending" };
    }
    const facts = this.closedFacts;
    if (projection && (projection.status !== "closed" || !sameId(projection.session_id, sessionId))) return false;
    facts.reason ??= reason;
    // The fact of the own closure goes to the owners after this one (C537, C581): S and its real reason only.
    if (facts.reason !== null) noteOralClosure(this.closureOwner, sessionId, facts.reason);
    // The reason of an own closure is a server fact whatever pair its projection names; only its numbers need this owner's pair.
    if (projection && projection.pair !== `${this.options.access.profile.dictionary_language}-de`) return false;
    if (!projection || facts.summaryRead === "known") return false;
    facts.summary = structuredClone(projection.summary); facts.progress = structuredClone(projection.progress);
    facts.summaryRead = "known";
    return true;
  }
  private observe(read: OralRead): void {
    const floor = this.minimum();
    if (BigInt(read.state_version) < BigInt(floor)) { this.problem = "stale_response"; return; }
    this.raise(read.state_version);
    const current = read.current;
    if (current.status === "closed") this.markClosed(current.session_id);
    if (current.status === "closed") this.recordClosed(current.session_id, current.close_reason, current);
    if (!this.sessionId || !sameId(current.session_id, this.sessionId)) return;
    this.ticket = null; this.shownPending = false;
    // A closure of the own session is no failed refresh, whatever pair its projection names; an unavailable one still is.
    if ('pair' in current && this.terminal.has(current.session_id.toLowerCase())) return;
    if (!('pair' in current) || current.pair !== `${this.options.access.profile.dictionary_language}-de`) {
      this.current = null; this.currentVersion = null; this.stopRight = null;
      // An open projection of another pair is no failed read: the pair changed elsewhere and the session lives there (R1).
      // It is kept as a fact; nothing of it is shown and it grants no right here (no Stop before the window's refresh).
      if ('pair' in current) { this.mismatch = current.session_id; this.problem = null; } else this.problem = current.status;
      return;
    }
    this.mismatch = null;
    this.current = structuredClone(current); this.currentVersion = read.state_version; this.problem = null;
    this.stopRight = { sessionId: current.session_id, version: read.state_version,
      stop: current.capabilities.stop, home: current.capabilities.summary_home };
  }
  private ingest(lane: OralCommandLane, snapshot: OralCommandSnapshot): void {
    if (snapshot.sessionId) this.receiptSessions.add(snapshot.sessionId.toLowerCase());
    if (snapshot.resolved) this.receiptSessions.add(snapshot.resolved.sessionId.toLowerCase());
    const stamp = JSON.stringify([snapshot.stateVersion, snapshot.current, snapshot.closedSession, snapshot.resolved, snapshot.outcome]);
    if (this.processed[lane] === stamp) return;
    this.processed[lane] = stamp;
    if (snapshot.stateVersion) this.raise(snapshot.stateVersion);
    if (lane === "study" && snapshot.outcome !== null && snapshot.resolved) {
      this.current = null; this.currentVersion = null; this.ticket = null;
    }
    // P2-B: the lane keeps a projection of another pair only as the own closure of its record's session; it is a fact of
    // that earlier session (its reason), taken only while this owner has no session of its own.
    const prior = snapshot.current;
    if (prior && "pair" in prior && prior.status === "closed" && prior.close_reason !== null
      && prior.pair !== `${this.options.access.profile.dictionary_language}-de` && !this.sessionId
      && snapshot.resolved && sameId(snapshot.resolved.sessionId, prior.session_id)) {
      this.priorClosure ??= { sessionId: prior.session_id, reason: prior.close_reason };
      noteOralClosure(this.closureOwner, prior.session_id, prior.close_reason);
    }
    if (snapshot.closedSession) this.markClosed(snapshot.closedSession.session_id);
    // The boundary proves closure and its reason, not the summary.
    if (snapshot.closedSession) this.recordClosed(snapshot.closedSession.session_id, snapshot.closedSession.close_reason, null);
    if (snapshot.outcome === "accepted" && snapshot.resolved?.kind === "session.stop") this.markClosed(snapshot.resolved.sessionId);
    if (snapshot.outcome === "accepted" && snapshot.resolved?.kind === "session.stop") this.recordClosed(snapshot.resolved.sessionId, null, null);
    if (snapshot.current && "session_id" in snapshot.current && snapshot.stateVersion) {
      this.observe({ current: snapshot.current, state_version: snapshot.stateVersion });
    }
  }
  /** Both lanes of a publication of the shared lanes, then the read that follows a new outcome of the study action. */
  private ingestLanes(lanes: OralLanesSnapshot): void {
    this.ingest("study", lanes.primary);
    this.ingest("stop", lanes.stop);
    this.follow(lanes.primary);
  }
  /**
   * A command fact never licenses reuse of its former question: once per study command with a known outcome (applied or
   * refused, however it became known: the tap's own send, a send or a check of the recovery machine), the session is read
   * again unless the reply already brought a fresh step.
   */
  private follow(command: OralCommandSnapshot): void {
    const id = command.resolved?.commandId.toLowerCase();
    if (!id || command.outcome === null || this.followed === id) return;
    this.followed = id;
    // A refresh reads the session itself once its lanes are checked: no second read for what its check found.
    if (this.refreshing || command.outcome === "not_applied" || !this.sessionId || this.terminal.has(this.sessionId.toLowerCase())) return;
    if (command.outcome !== "rejected" && this.current && this.currentVersion !== null
      && BigInt(this.currentVersion) >= BigInt(this.minimum())) return;
    this.current = null;
    const read = this.readCurrent().finally(() => { if (this.followRead === read) this.followRead = null; this.emit(); });
    this.followRead = read;
  }
  private studyLanes(): Record<OralCommandLane, OralCommandSnapshot> {
    const lanes = this.lanes.snapshot();
    return { study: lanes.primary, stop: lanes.stop };
  }
  private ready(snapshot: OralCommandSnapshot): boolean {
    return !snapshot.pending && ["idle", "settled"].includes(snapshot.phase);
  }
  snapshot(): OralDocumentSnapshot {
    const live = this.live();
    if (live) this.minimum();
    const lanes = this.lanes.snapshot(), commands = { study: lanes.primary, stop: lanes.stop };
    const closed = !!this.sessionId && this.terminal.has(this.sessionId.toLowerCase());
    const fresh = this.currentVersion !== null && BigInt(this.currentVersion) >= BigInt(this.floor);
    const unknown = commands.study.pending && commands.study.outcome === null;
    const sendingStudy = this.busy.study || commands.study.phase === "sending";
    const sendingStop = this.busy.stop || commands.stop.phase === "sending";
    const current = this.active("stop") && fresh && !closed
      && !this.refreshing && !unknown && !sendingStudy && !sendingStop ? this.current : null;
    // The shared lanes' own readiness for a new study action (no work in flight, no machine busy, Q34); the write gate
    // is asked by each right below, as before.
    const studyReady = this.ready(commands.study) && !this.busy.study && (lanes.canBegin || !!lanes.heldByGate);
    const stopReady = this.ready(commands.stop) && !this.busy.stop;
    const foreignHistory = [...this.receiptSessions].some(id => !this.terminal.has(id)
      && (!this.sessionId || !sameId(id, this.sessionId)));
    // A confirmed addressed session is authoritative for continuing study. A fully settled historical
    // receipt cannot override it; a foreign receipt still awaiting resolution or
    // durable cleanup does. Without a seed, recovery must never elect a session
    // from the order in which historical receipts finish.
    const foreignReceipt = this.sessionId === null
      ? foreignHistory
      : Object.values(commands).some(command => command.pending && command.sessionId !== null
        && !sameId(command.sessionId, this.sessionId!) && !this.terminal.has(command.sessionId.toLowerCase()));
    const checkedAbsent = live && onlyCheckedAbsent([commands.study, commands.stop],
      this.problem ?? (foreignReceipt ? "unconfirmed_session" : null) ?? busyRefusal(commands));
    const right = this.stopRight;
    // §4.1 «Правило кнопки» (K01s, K03, K05; C335, M-P03-10): every manual mutation of the screen waits for mayWrite.
    const writable = this.options.transport.gate.mayWrite();
    const canStop = this.active("stop") && stopReady && lanes.canStop && !closed && !!right && writable
      && BigInt(right.version) >= BigInt(this.floor) && !!this.sessionId && sameId(right.sessionId, this.sessionId);
    const assignment = current?.status === "active" ? current.assignment : null;
    if (!current || assignment?.status !== "prefetched" || !this.active("study") || !studyReady || !stopReady) this.ticket = null;
    else this.ticket ??= Object.freeze({}) as OralPresentationTicket;
    let phase: OralDocumentSnapshot["phase"];
    if (!live) phase = "disposed";
    else if (closed) phase = "closed";
    else if (sendingStop) phase = "stopping";
    else if (this.shownPending) phase = "visible_unconfirmed";
    else if (unknown || foreignReceipt) phase = "unknown";
    else if (!this.recovered || this.refreshing) phase = "loading";
    else if (current?.status === "summary") phase = "summary";
    else if (assignment) phase = assignment.status === "prefetched" ? "prefetched" : assignment.revealed ? "revealed" : "question";
    // A suspended owner hides its session until its window's foreground answers: that is loading, not a failed
    // refresh. Otherwise every return, and a replaced window before it closes, reads as an error (2.33).
    else phase = this.sessionId ? this.foregroundBlocked ? "loading" : "stale" : "idle";
    return { phase, sessionId: live ? this.sessionId : null, current: structuredClone(current), stateVersion: this.floor,
      terminalSessionIds: [...this.terminal], commands,
      // A start refused as SESSION_BUSY is a fact of the core, not a lost reply: it outranks the generic problem that the
      // follow-up read of the never-created session leaves behind, so the screen can name the other device (К10-018).
      // The lane's pair change for an applied command is the same known fact (commandLane settle, guard v3): the observed
      // reply keeps it as pairMismatch, so it is no shown problem either (C149, C178; as studyView).
      problem: live ? (commands.study.outcome === "accepted" && commands.study.problem === "pair_changed" ? null : commands.study.problem)
        ?? commands.stop.problem ?? busyRefusal(commands) ?? this.problem
        ?? (foreignReceipt ? "unconfirmed_session" : null) : null,
      presentationTicket: live ? this.ticket : null,
      canStart: this.active("study") && writable && this.recovered && !this.refreshing && studyReady && stopReady
        && !foreignHistory && (!this.sessionId || closed),
      canReveal: this.active("study") && writable && studyReady && stopReady && !foreignReceipt && assignment?.status === "presented"
        && !assignment.revealed && sameId(current!.capabilities.reveal_target, assignment.id),
      canGrade: this.active("study") && writable && studyReady && stopReady && !foreignReceipt && assignment?.status === "presented"
        && assignment.revealed && sameId(current!.capabilities.grade_target, assignment.id),
      canStop: canStop && !!right?.stop, canSummaryHome: canStop && !!right?.home,
      // Decision 2.3 А: a study action of another window or of the page before a reload is only checked, never retried
      // by hand here. Stop keeps its own rules.
      // The shared lanes already mask both: an automatic step and a record of another window or of the page before a
      // reload are never retried by hand (decision 2.3 А); C only by «Повторить завершение» once its budget ran out (Q30).
      canRetry: { study: this.active("study") && commands.study.canRetry, stop: this.active("stop") && commands.stop.canRetry },
      gate: lanes.gate,
      closed: live && closed ? this.closedSnapshot(this.sessionId!) : null,
      pairMismatch: live && !closed && this.mismatch !== null && !!this.sessionId && sameId(this.mismatch, this.sessionId)
        ? this.mismatch : null,
      ...(live && this.foregroundBlocked && phase === "loading" ? { suspended: true as const } : {}),
      ...(checkedAbsent ? { checkedAbsent: true as const } : {}),
      ...(live && !this.sessionId && this.priorClosure && !oralClosureLeft(this.closureOwner, this.priorClosure.sessionId)
        ? { priorClosure: { ...this.priorClosure } } : {}),
      recovery: live ? lanes.recovery : null,
      ...(live && lanes.automaticPrimary ? { automaticStudy: true as const } : {}),
      ...(live && lanes.closureFailed ? { closureFailed: true as const } : {}),
      ...(live && lanes.storageUnavailable ? { storageUnavailable: true as const } : {}),
      ...(live && lanes.startBlocked ? { startBlocked: lanes.startBlocked } : {}),
      ...(live && lanes.unsavedClosures?.length ? { unsavedClosures: [...lanes.unsavedClosures] } : {}) };
  }
  private closedSnapshot(sessionId: string): OralClosed {
    const facts = this.closedFacts && sameId(this.closedFacts.sessionId, sessionId) ? this.closedFacts : null;
    return facts ? structuredClone(facts) : { sessionId, reason: null, summary: null, progress: null, summaryRead: "pending" };
  }
  private emit(): void {
    if (!this.live()) return;
    const snapshot = this.snapshot();
    if (this.live()) this.options.onUpdate(snapshot);
  }
  setActivity(activity: { enabled: boolean; visible: boolean }): void {
    if (!this.live()) return;
    if (!activity.visible) this.foregroundBlocked = true;
    if (!activity.visible || this.enabled !== activity.enabled) {
      this.activityEpoch++; this.ticket = null; this.shownPending = false;
    }
    this.enabled = activity.enabled; this.visible = activity.visible;
    // The machines request nothing while the window is in the background (Я15.3); this owner never returns from it (a
    // new owner with a fresh open handle checks and goes on with the rest of the budget).
    this.lanes.setRecoveryActive(this.active("stop"));
    this.emit();
  }
  /** Resolves both durable lanes, then reads only the explicitly confirmed session. Never POSTs. */
  refresh(): Promise<void> {
    if (!this.live()) return Promise.resolve();
    if (this.refreshing) return this.refreshing;
    this.ticket = null;
    const task = Promise.resolve().then(async () => {
      if (!this.live()) return;
      await this.lanes.refresh();
      if (!this.live()) return;
      this.recovered = true;
      if (this.sessionId && !this.terminal.has(this.sessionId.toLowerCase())) await this.readCurrent();
      if (this.live() && this.sessionId && this.terminal.has(this.sessionId.toLowerCase())) await this.readClosed();
    }).finally(() => {
      if (this.refreshing === task) this.refreshing = null;
      this.emit();
    });
    this.refreshing = task; this.emit();
    return task;
  }
  /** Explicit status check. An in-flight refresh may already be past its lane checks, so this
   * queues one subsequent refresh; repeated requests coalesce into it. Never POSTs. */
  recheck(): Promise<void> {
    if (!this.live()) return Promise.resolve();
    if (!this.refreshing) return this.refresh();
    if (!this.queuedCheck) {
      const next = () => { this.queuedCheck = null; return this.refresh(); };
      this.queuedCheck = this.refreshing.then(next, next);
    }
    return this.queuedCheck;
  }
  private async readCurrent(): Promise<void> {
    const sessionId = this.sessionId;
    if (!sessionId || !this.live() || this.terminal.has(sessionId.toLowerCase())) return;
    try {
      const api = createOralApi(this.options.transport);
      const read = await this.exchange(({ token, proof, clientInstanceId, documentId }) => {
        return api.read(token, proof, { session_id: sessionId, client_instance_id: clientInstanceId, document_id: documentId });
      });
      if (!this.live() || this.sessionId !== sessionId || this.terminal.has(sessionId.toLowerCase())) return;
      this.observe(read);
    } catch (error) {
      if (!this.live()) return;
      this.current = null; this.ticket = null;
      this.problem = error instanceof ApiError && error.code ? error.code : "network";
    }
  }
  /** The only read of this owner's terminal session: while its summary is not known, one addressed GET per
   * refresh. Data only: never observe(), floor, problem, current or rights; a failure waits for a later refresh. */
  private async readClosed(): Promise<void> {
    const sessionId = this.sessionId;
    if (!sessionId || !this.live() || !this.terminal.has(sessionId.toLowerCase())) return;
    if (!this.closedFacts || !sameId(this.closedFacts.sessionId, sessionId)) {
      this.closedFacts = { sessionId, reason: null, summary: null, progress: null, summaryRead: "pending" };
    }
    const facts = this.closedFacts;
    if (facts.summaryRead === "known") return;
    facts.summaryRead = "reading"; this.emit();
    let read: OralRead;
    try {
      const api = createOralApi(this.options.transport);
      read = await this.exchange(({ token, proof, clientInstanceId, documentId }) => {
        return api.read(token, proof, { session_id: sessionId, client_instance_id: clientInstanceId, document_id: documentId });
      });
    } catch {
      if (this.live() && this.closedFacts === facts && facts.summaryRead === "reading") facts.summaryRead = this.carriedSummary ? "known" : "failed";
      return;
    }
    if (!this.live() || this.sessionId !== sessionId || this.closedFacts !== facts || facts.summaryRead !== "reading") return;
    const current = read.current;
    const kept = current.status === "closed" && BigInt(read.state_version) >= BigInt(this.minimum())
      && this.recordClosed(sessionId, current.close_reason, current);
    if (!kept) facts.summaryRead = this.carriedSummary && facts.summary !== null ? "known" : "failed";
  }
  private async begin(lane: OralCommandLane, transition: OralTransition): Promise<void> {
    if (!this.active(lane) || this.busy[lane]) return;
    this.busy[lane] = true; this.sendEpoch[lane] = this.activityEpoch; this.ticket = null;
    try {
      // The shared lanes (M1d): an automatic step goes to its recovery machine (resolved once its first send has its
      // answer), the start is counted in its budget (Q34: no send without the page's store), Stop names X itself (T1).
      // 14.8.8.1 А: a new action that met another record in the shared slot is checked there, never sent (2.3 А).
      await this.lanes.begin(transition);
      if (!this.live()) return;
      this.ingestLanes(this.lanes.snapshot());
      this.shownPending = false;
      // The read that follows a known outcome (follow) is awaited by the tap that caused it.
      if (this.followRead) await this.followRead;
    } finally {
      this.busy[lane] = false;
      this.emit();
    }
  }
  async start(bucket: "words" | "phrases"): Promise<void> {
    if (bucket !== "words" && bucket !== "phrases") throw new Error("oral bucket required");
    const epoch = this.activityEpoch;
    if (!this.active("study")) return;
    await this.refresh();
    if (!this.active("study") || epoch !== this.activityEpoch || !this.snapshot().canStart) return;
    const sessionId = this.options.newId();
    if (!uuid(sessionId)) throw new Error("invalid oral session ID");
    this.sessionId = sessionId; this.current = null; this.currentVersion = null; this.stopRight = null;
    this.closedFacts = null; this.mismatch = null;
    await this.begin("study", { kind: "session.start", session_id: sessionId, payload: { mode: "oral", bucket } });
  }
  shown(ticket: OralPresentationTicket): Promise<void> {
    const snapshot = this.snapshot(), assignment = snapshot.current?.assignment;
    if (!ticket || ticket !== snapshot.presentationTicket || !this.active("study") || !assignment
      || assignment.status !== "prefetched" || !snapshot.sessionId) return Promise.resolve();
    this.ticket = null; this.shownPending = true;
    const task = this.begin("study", { kind: "assignment.present", session_id: snapshot.sessionId,
      assignment_id: assignment.id, payload: {} });
    this.emit(); return task;
  }
  reveal(): Promise<void> {
    const snapshot = this.snapshot();
    return snapshot.canReveal ? this.begin("study", { kind: "oral.reveal", session_id: snapshot.sessionId!,
      assignment_id: snapshot.current!.assignment!.id, payload: {} }) : Promise.resolve();
  }
  grade(correct: boolean): Promise<void> {
    if (typeof correct !== "boolean") throw new Error("oral grade must be boolean");
    const snapshot = this.snapshot();
    return snapshot.canGrade ? this.begin("study", { kind: "oral.grade", session_id: snapshot.sessionId!,
      assignment_id: snapshot.current!.assignment!.id, payload: { correct } }) : Promise.resolve();
  }
  stop(reason: "stop" | "summary_home"): Promise<void> {
    if (reason !== "stop" && reason !== "summary_home") throw new Error("oral stop reason required");
    const snapshot = this.snapshot();
    // T1 (project notices §4.1): the shared lanes name the unconfirmed study action X of this session, if any, in the
    // person's Stop; without X the payload stays `{reason}`.
    return (reason === "stop" ? snapshot.canStop : snapshot.canSummaryHome)
      ? this.begin("stop", { kind: "session.stop", session_id: snapshot.sessionId!, payload: { reason } }) : Promise.resolve();
  }
  async retry(lane: OralCommandLane): Promise<void> {
    if (lane !== "study" && lane !== "stop") throw new Error("invalid oral lane");
    if (!this.snapshot().canRetry[lane] || this.busy[lane]) return;
    const intent = this.studyLanes()[lane].pendingIntent;
    this.busy[lane] = true; this.sendEpoch[lane] = this.activityEpoch; this.ticket = null;
    try {
      // The shared lanes: a start through its budget (a counted slot), C only through «Повторить завершение» (its machine).
      await this.lanes.retry(lane === "study" ? "primary" : "stop");
      if (!this.live()) return;
      const command = this.studyLanes()[lane];
      this.ingestLanes(this.lanes.snapshot());
      // A manual retry of the retained start is an explicit choice of that exact
      // session. Passive recovery never elects a session from receipt order.
      if (intent?.kind === "session.start" && command.outcome === "accepted" && !this.sessionId
        && !this.terminal.has(intent.session_id.toLowerCase())
        && ![...this.receiptSessions].some(id => !this.terminal.has(id) && !sameId(id, intent.session_id))) {
        this.sessionId = intent.session_id;
        if (command.current && "session_id" in command.current && command.stateVersion) {
          this.observe({ current: command.current, state_version: command.stateVersion });
        }
      }
      if (this.sessionId && !this.terminal.has(this.sessionId.toLowerCase())) await this.readCurrent();
    } finally { this.busy[lane] = false; this.emit(); }
  }

  /**
   * The person left the frame of that closure of an own session («На Сегодня» or the native Back on it): no owner of this
   * document shows it again — another render, another owner, the pair changed back (C581). Sends nothing.
   */
  leaveClosure(sessionId: string): void {
    if (!uuid(sessionId)) return;
    leaveOralClosure(this.closureOwner, sessionId);
    this.emit();
  }
  dispose(): void {
    this.disposed = true; this.activityEpoch++; this.ticket = null; this.current = null; this.stopRight = null;
    this.closedFacts = null;
    // M03 (P03 §5.2) and the gate's repaint now belong to the shared lanes: their subscription ends with them.
    this.lanes.dispose();
  }
}
