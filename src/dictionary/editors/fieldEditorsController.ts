import type { FieldUndoTarget } from "../../api/generated";
import { version } from "../../api/wireValidation";
import { commandOutcomeUnknown } from "../../commands/commandOutcome";
import {
  caseRoles, copyFieldIntent,
  type CaseRole, type FieldCommand, type FieldCommandReply, type FieldCommandStatus, type FieldCurrent, type FieldIntent,
  type FieldKey, type FieldLanguage, type FieldOrigin, type FieldSaveIntent, type FieldUndoIntent,
} from "./fieldEditorApi";

/** Credentials stay behind the port; origin is the live document's at each exchange (CT 2.1: a retry keeps the intent). */
export type FieldEditorsPort = {
  origin(): FieldOrigin | null;
  send(command: FieldCommand): Promise<FieldCommandReply>;
  status(command: FieldCommand): Promise<FieldCommandStatus>;
};

/** The server's own value of one field and the version the next save expects (null value: no own value). */
export type FieldSource = { value: string | null; version: string };
/** What the card read says about its own fields; only the fields this card can edit are present. */
export type CardFields = {
  cardId: string;
  language: FieldLanguage;
  stateVersion: string;
  fields: Partial<Record<FieldKey, FieldSource>>;
  commonTranslations: string[];
};
/** One pencil opens one group: a scalar field, or both case roles of the example pair (TA §7). */
export type FieldGroup = "translation" | "example" | "association" | "pair";
export const groupKeys: Record<FieldGroup, readonly FieldKey[]> = {
  translation: ["translation"], example: ["example"], association: ["association"], pair: caseRoles,
};

export type EditorPhase = "editing" | "saving" | "failed" | "conflict" | "saved";
export type EditorProblem = {
  /** unknown: no reply, the same command can be repeated; refused: proven not saved; unavailable: the field is gone. */
  reason: "unknown" | "refused" | "unavailable" | "mismatch";
  code?: string;
};
/** TA §7: the editor keeps original/current/draft/field_version. */
export type EditorSnapshot = {
  key: FieldKey;
  phase: EditorPhase;
  /** The text the editor started from: the own value, or "" without one (the common text is never inserted by itself). */
  original: string;
  /** The newest server value known to this editor; after a conflict, the value saved elsewhere. */
  current: FieldSource;
  draft: string;
  fieldVersion: string;
  dirty: boolean;
  /** A status request or a command of this field is under way. */
  checking: boolean;
  canEdit: boolean;
  canSave: boolean;
  canRetry: boolean;
  canCancel: boolean;
  problem: EditorProblem | null;
  /** After an accepted save: the stored own value (null: removed), undefined when the reply could not show it. */
  saved?: string | null;
};
export type UndoSnapshot = {
  status: "offered" | "undoing" | "unknown" | "failed";
  canUndo: boolean;
  canRetry: boolean;
  problem: EditorProblem | null;
};
export type FieldEditorsSnapshot = {
  open: FieldGroup | null;
  editors: Partial<Record<FieldKey, EditorSnapshot>>;
  undo: UndoSnapshot | null;
  commonTranslations: string[];
  /** A pencil may open a group now. */
  canOpen: boolean;
  /** Leaving the card would lose text the server has not confirmed (К07-039). */
  unsaved: boolean;
  disposed: boolean;
};

type Options = {
  port: FieldEditorsPort;
  newId(): string;
  onUpdate(snapshot: FieldEditorsSnapshot): void;
  /** An accepted or refused command changed what the card shows: the host reads the card (and its context) again. */
  onChanged(): void;
};
type Known = FieldSource & { stateVersion: string };
type Session = {
  key: FieldKey; phase: EditorPhase; original: string; current: FieldSource; draft: string; fieldVersion: string;
  problem: EditorProblem | null; saved?: string | null;
};
/** The one command of this card in flight or unresolved; its intent never changes until it settles. */
type Entry = { intent: FieldIntent; key: FieldKey; status: "sending" | "unknown"; busy: boolean; notFound: boolean };
type Undo = {
  target: FieldUndoTarget; fieldVersion: string; stateVersion: string; save: FieldSaveIntent;
  status: UndoSnapshot["status"]; problem: EditorProblem | null; checking: boolean;
};

const newer = (left: string, right: string) => BigInt(left) > BigInt(right);
const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
/** Codes after which the shown card may be outdated: it is read again, never guessed (TZA:145). */
const rereadCodes = new Set(["VERSION_CONFLICT", "WRITE_UNAVAILABLE", "DOCUMENT_STALE", "CAPABILITY_EXPIRED"]);

/**
 * All own-field editors of one open card М12 and the one undo of its last translation save (TA §7, CT 2.3).
 * Memory only: no durable draft (К07-040) and no durable undo (К05-074). One command at a time (root decision, pending
 * owner — M-EDIT Р13); an unknown outcome is
 * checked by the same ID and repeated only as the same command (CON:149). Not bound to an access handle: going to the
 * background keeps drafts and the undo right (К05-073); the host resets the undo on a new document.
 */
export class FieldEditorsController {
  private card: CardFields | null = null;
  private contextId: string | null = null;
  private readonly known = new Map<FieldKey, Known>();
  private readonly sessions = new Map<FieldKey, Session>();
  private openGroup: FieldGroup | null = null;
  private entry: Entry | null = null;
  private undoState: Undo | null = null;
  private disposed = false;

  constructor(private readonly options: Options) {}

  // ---- inputs from the host ----

  /** A card read of the same card and language; another card or language starts over (fields are per L1). */
  setCard(card: CardFields): void {
    if (this.disposed) return;
    if (!version(card.stateVersion)) throw new Error("invalid card state version");
    const previous = this.card;
    if (previous && (!same(previous.cardId, card.cardId) || previous.language !== card.language)) {
      this.sessions.clear(); this.openGroup = null; this.entry = null; this.undoState = null; this.known.clear();
    } else if (previous && newer(previous.stateVersion, card.stateVersion)) return; // an older read adds nothing (K10-097)
    this.card = structuredClone(card);
    for (const [key, source] of Object.entries(card.fields) as [FieldKey, FieldSource][]) {
      const known = this.known.get(key);
      if (!known || !newer(known.stateVersion, card.stateVersion)) this.known.set(key, { ...source, stateVersion: card.stateVersion });
    }
    this.observe(card.stateVersion);
    this.notify();
  }

  /** The open card context; field.save and field.undo need it, a right of another context is never offered. */
  setContext(contextId: string | null): void {
    if (this.disposed) return;
    this.contextId = contextId === null ? null : contextId.toLowerCase();
    if (this.undoState && (this.contextId === null || !same(this.undoState.target.context_id, this.contextId))) this.undoState = null;
    this.notify();
  }

  /** A new document invalidates the undo right (CT 2.3, К05-074); drafts stay in memory, an unresolved command is checked. */
  resetDocument(): void {
    if (this.disposed) return;
    this.undoState = null;
    this.notify();
    void this.resume();
  }

  /** A new access handle of the same document: an unresolved command is checked by status, never re-sent. */
  async resume(): Promise<void> {
    const entry = this.entry;
    if (!this.disposed && entry && entry.status === "unknown" && !entry.busy && !entry.notFound) await this.check(entry);
  }

  /**
   * A state version seen elsewhere (card read, context): a newer one means some other action may have ended the undo
   * right (CT 2.3 «до следующего действия»). The server decides by the save's own status, the client never guesses.
   */
  observe(stateVersion: string | null | undefined): void {
    const undo = this.undoState;
    if (this.disposed || !stateVersion || !version(stateVersion) || !undo || undo.status !== "offered" || undo.checking
      || !newer(stateVersion, undo.stateVersion)) return;
    void this.recheckUndo(undo, stateVersion);
  }

  dispose(): void {
    this.disposed = true;
    this.entry = null;
    this.undoState = null;
    this.sessions.clear();
  }

  // ---- user actions ----

  /** Open one group (Р2: one at a time). A previous result note ends with the next opened editor. */
  open(group: FieldGroup): void {
    if (!this.canOpen() || !this.card) return;
    const keys = groupKeys[group];
    if (!keys.every(key => this.known.has(key))) return;
    this.sessions.clear();
    // A refused undo only left its note; opening an editor is not an action and keeps an offered undo.
    if (this.undoState?.status === "failed") this.undoState = null;
    for (const key of keys) {
      const source = this.known.get(key)!;
      const original = source.value ?? "";
      this.sessions.set(key, { key, phase: "editing", original, current: { value: source.value, version: source.version },
        draft: original, fieldVersion: source.version, problem: null });
    }
    this.openGroup = group;
    this.notify();
  }

  edit(key: FieldKey, text: string): void {
    const session = this.sessions.get(key);
    if (typeof text !== "string" || !session || !this.editable(session)) return;
    session.draft = text;
    // A known refusal or a saved role continues as an ordinary edit; a conflict keeps its explicit choice.
    if (session.phase === "failed" || session.phase === "saved") {
      session.phase = "editing"; session.problem = null; session.saved = undefined;
    }
    this.notify();
  }

  /** К07-036: all common translations joined by a comma, into the field only; nothing is sent. */
  substitute(): void {
    const session = this.sessions.get("translation");
    const common = this.card?.commonTranslations ?? [];
    if (!session || !this.editable(session) || common.length === 0) return;
    this.edit("translation", common.join(", "));
  }

  save(key: FieldKey): Promise<void> {
    const session = this.sessions.get(key);
    if (!session || !this.canSave(session)) return Promise.resolve();
    return this.start(key, this.saveIntent(session));
  }

  /** Conflict: keep my text and save it against the version just reported (К11-011: the server checks again). */
  keepMine(key: FieldKey): Promise<void> {
    const session = this.sessions.get(key);
    if (!session || session.phase !== "conflict" || this.entry || !this.contextId) return Promise.resolve();
    return this.start(key, this.saveIntent(session));
  }

  /**
   * Conflict: take the value saved elsewhere; my draft is dropped only by this explicit choice (К11-010).
   * root decision, pending owner (M-EDIT Р7, В4): the editor stays open with that value, not closed.
   */
  acceptCurrent(key: FieldKey): void {
    const session = this.sessions.get(key);
    if (!session || session.phase !== "conflict") return;
    session.original = session.current.value ?? "";
    session.draft = session.original;
    session.phase = "editing"; session.problem = null;
    this.notify();
  }

  /**
   * After an unknown outcome the same command (ID and payload); after a refusal a new one with the same text.
   * root decision, pending owner (M-EDIT Р6).
   */
  retry(key: FieldKey): Promise<void> {
    const session = this.sessions.get(key), entry = this.entry;
    if (!session || session.phase !== "failed") return Promise.resolve();
    if (entry && entry.key === key && entry.intent.kind === "field.save") {
      return entry.status === "unknown" && !entry.busy ? this.execute(entry) : Promise.resolve();
    }
    return this.save(key);
  }

  /**
   * Close the open group without saving. root decision, pending owner (M-EDIT Р5, В3): an explicit cancel asks nothing.
   * root decision, pending owner (M-EDIT Р14): an unresolved save is forgotten and the card is read again, so the screen
   * shows what the server holds. A save in flight cannot be cancelled.
   */
  cancel(): void {
    const group = this.openGroup;
    if (group === null) return;
    const entry = this.entry;
    if (entry && groupKeys[group].includes(entry.key)) {
      if (entry.busy) return;
      this.entry = null;
      this.options.onChanged();
    }
    this.sessions.clear();
    this.openGroup = null;
    this.notify();
  }

  undo(): Promise<void> {
    const undo = this.undoState;
    if (!undo || !this.undoAllowed(undo) || !this.card) return Promise.resolve();
    const intent: FieldUndoIntent = { kind: "field.undo", command_id: this.options.newId(), context_id: undo.target.context_id,
      card_id: this.card.cardId, language: this.card.language, action_id: undo.target.action_id,
      expected_action_version: undo.target.version, expected_field_version: undo.fieldVersion };
    undo.status = "undoing"; undo.problem = null;
    return this.start("translation", intent);
  }

  retryUndo(): Promise<void> {
    const entry = this.entry, undo = this.undoState;
    if (!undo || undo.status !== "unknown" || !entry || entry.intent.kind !== "field.undo" || entry.busy) return Promise.resolve();
    return this.execute(entry);
  }

  // ---- snapshot ----

  snapshot(): FieldEditorsSnapshot {
    if (this.disposed) {
      return { open: null, editors: {}, undo: null, commonTranslations: [], canOpen: false, unsaved: false, disposed: true };
    }
    const editors: Partial<Record<FieldKey, EditorSnapshot>> = {};
    // A save in flight of any field of the open group keeps the whole group open (К07-048).
    const groupBusy = this.openGroup !== null && this.entry !== null && this.entry.busy
      && groupKeys[this.openGroup].includes(this.entry.key);
    for (const session of this.sessions.values()) {
      const entry = this.entry?.key === session.key && this.entry.intent.kind === "field.save" ? this.entry : null;
      editors[session.key] = {
        key: session.key, phase: session.phase, original: session.original, current: { ...session.current },
        draft: session.draft, fieldVersion: session.fieldVersion, dirty: session.draft !== session.original,
        checking: entry?.busy ?? false, canEdit: this.editable(session), canSave: this.canSave(session),
        canRetry: session.phase === "failed" && (entry ? entry.status === "unknown" && !entry.busy : this.contextId !== null && this.entry === null
          && session.problem?.reason !== "unavailable"),
        canCancel: !groupBusy,
        problem: session.problem ? { ...session.problem } : null,
        ...(session.phase === "saved" ? { saved: session.saved } : {}),
      };
    }
    const undo = this.undoState;
    const undoEntry = this.entry?.intent.kind === "field.undo" ? this.entry : null;
    return {
      open: this.openGroup, editors,
      undo: undo ? { status: undo.status, canUndo: this.undoAllowed(undo),
        canRetry: undo.status === "unknown" && undoEntry !== null && !undoEntry.busy,
        problem: undo.problem ? { ...undo.problem } : null } : null,
      commonTranslations: [...(this.card?.commonTranslations ?? [])],
      canOpen: this.canOpen(),
      unsaved: [...this.sessions.values()].some(session => this.unsaved(session)),
      disposed: false,
    };
  }

  // ---- rules ----

  /** root decision, pending owner (M-EDIT Р12, Р13): no pencil without the open card context or while a command is under way. */
  private canOpen(): boolean {
    return !this.disposed && this.card !== null && this.contextId !== null && this.openGroup === null && this.entry === null;
  }
  private editable(session: Session): boolean {
    // While a save is in flight or unresolved the text is the one sent; it changes only after the outcome (К07-048).
    const entry = this.entry;
    return this.openGroup !== null && !(entry && entry.key === session.key && entry.intent.kind === "field.save");
  }
  /** root decision, pending owner (M-EDIT Р4): an unchanged text is not saved (substituting the common one is a change). */
  private canSave(session: Session): boolean {
    return this.contextId !== null && this.entry === null && this.editable(session)
      && (session.phase === "editing" || session.phase === "failed" && session.problem?.reason !== "unavailable")
      && session.draft !== session.original;
  }
  /** root decision, pending owner (M-EDIT Р15): a text in flight or unresolved is not confirmed yet, leaving asks too. */
  private unsaved(session: Session): boolean {
    const entry = this.entry;
    return session.draft !== session.original || session.phase === "conflict"
      || (entry !== null && entry.key === session.key && entry.intent.kind === "field.save");
  }
  private undoAllowed(undo: Undo): boolean {
    // Hidden while the translation editor is open or any command is under way; the server still checks the right.
    return undo.status === "offered" && this.entry === null && this.contextId !== null
      && same(undo.target.context_id, this.contextId) && this.openGroup !== "translation";
  }

  private saveIntent(session: Session): FieldSaveIntent {
    const card = this.card!, role = session.key === "akkusativ" || session.key === "dativ" ? session.key as CaseRole : null;
    return copyFieldIntent({ kind: "field.save", command_id: this.options.newId(), context_id: this.contextId!,
      card_id: card.cardId, language: card.language, field_name: role ? "example" : session.key as FieldSaveIntent["field_name"],
      case_role: role, value: session.draft, expected_field_version: session.fieldVersion });
  }

  // ---- exchange ----

  private notify(): void {
    if (!this.disposed) this.options.onUpdate(this.snapshot());
  }

  private start(key: FieldKey, intent: FieldIntent): Promise<void> {
    const entry: Entry = { intent: copyFieldIntent(intent), key, status: "sending", busy: false, notFound: false };
    this.entry = entry;
    const session = this.sessions.get(key);
    if (session && intent.kind === "field.save") { session.phase = "saving"; session.problem = null; }
    return this.execute(entry);
  }

  private command(entry: Entry): FieldCommand | null {
    const origin = this.options.port.origin();
    return origin ? { ...copyFieldIntent(entry.intent), ...origin } : null;
  }

  private async execute(entry: Entry): Promise<void> {
    entry.status = "sending"; entry.busy = true; entry.notFound = false;
    this.marking(entry, "sending");
    this.notify();
    let reply: FieldCommandReply;
    try {
      const command = this.command(entry);
      if (!command) throw new Error("no live document");
      reply = await this.options.port.send(command);
    } catch (error) {
      if (this.disposed || this.entry !== entry) return;
      entry.busy = false;
      if (commandOutcomeUnknown(error)) {
        entry.status = "unknown";
        this.marking(entry, "unknown");
        this.notify();
        await this.check(entry);
        return;
      }
      // An HTTP refusal without a fact: nothing was saved.
      this.entry = null;
      const code = (error as { code?: string }).code;
      this.marking(entry, "refused", { reason: "refused", ...(code ? { code } : {}) });
      this.notify();
      return;
    }
    if (this.disposed || this.entry !== entry) return;
    this.entry = null;
    this.settle(entry, reply);
  }

  /** One status request for an unknown outcome: accepted settles, not_found allows the same command again. */
  private async check(entry: Entry): Promise<void> {
    if (entry.busy || this.disposed) return;
    entry.busy = true;
    this.notify();
    let status: FieldCommandStatus;
    try {
      const command = this.command(entry);
      if (!command) throw new Error("no live document");
      status = await this.options.port.status(command);
    } catch {
      if (this.disposed || this.entry !== entry) return;
      entry.busy = false;
      this.notify();
      return;
    }
    if (this.disposed || this.entry !== entry) return;
    entry.busy = false;
    if (status.outcome === "accepted") {
      this.entry = null;
      this.accepted(entry, status.current, status.state_version, status.command.action_id);
      return;
    }
    if (status.outcome === "not_found") { entry.notFound = true; this.notify(); return; }
    // Another payload under this ID: this intent can never be confirmed; a new command is needed.
    this.entry = null;
    this.marking(entry, "refused", { reason: "mismatch", code: status.error.code });
    this.notify();
  }

  private settle(entry: Entry, reply: FieldCommandReply): void {
    if (reply.outcome === "accepted") {
      this.accepted(entry, reply.current, reply.state_version, reply.command.action_id);
      return;
    }
    const code = reply.error.code;
    if (reply.outcome === "mismatch") this.marking(entry, "refused", { reason: "mismatch", code });
    else if (entry.intent.kind === "field.save" && code === "VERSION_CONFLICT" && reply.current.status === "available") {
      this.conflict(entry.key, reply.current, reply.state_version);
    } else {
      this.marking(entry, "refused", { reason: reply.current.status === "unavailable" ? "unavailable" : "refused", code });
    }
    this.notify();
    if (rereadCodes.has(code)) this.options.onChanged();
  }

  private accepted(entry: Entry, current: FieldCurrent, stateVersion: string, actionId: string | null): void {
    const intent = entry.intent;
    if (current.status === "available") this.remember(entry.key, ownOf(current), stateVersion);
    if (intent.kind === "field.undo") {
      this.undoState = null;
      // The note of the undone save no longer describes the field.
      const session = this.sessions.get("translation");
      if (session?.phase === "saved") this.sessions.delete("translation");
    } else {
      // The next accepted action ends the previous one-step right (CT 2.3); only a translation save gives a new one.
      this.undoState = null;
      const target = current.status === "available" && "undo_target" in current ? current.undo_target : null;
      if (target && actionId && current.status === "available" && same(target.action_id, actionId)) {
        this.undoState = { target: { ...target }, fieldVersion: current.field_version, stateVersion, save: intent,
          status: "offered", problem: null, checking: false };
      }
      const session = this.sessions.get(entry.key);
      if (session) {
        const own = current.status === "available" ? ownOf(current) : null;
        session.phase = "saved"; session.problem = null;
        session.saved = own ? own.value : undefined;
        // К07-049: the field now holds what the server stored (edges trimmed, blank removed).
        if (own) { session.current = own; session.fieldVersion = own.version; session.draft = own.value ?? ""; }
        session.original = session.draft;
        // root decision, pending owner (M-EDIT Р8, Р3/В2): a scalar editor closes after its save and leaves a note at the
        // field (К07-049); the pair stays open for the other role, each role has its own save.
        if (this.openGroup !== "pair") this.openGroup = null;
      }
    }
    this.notify();
    this.options.onChanged();
  }

  private conflict(key: FieldKey, current: Exclude<FieldCurrent, { status: "unavailable" }>, stateVersion: string): void {
    const own = ownOf(current);
    this.remember(key, own, stateVersion);
    if (key === "translation" && "common_translations" in current && current.common_translations && this.card) {
      this.card.commonTranslations = [...current.common_translations];
    }
    const session = this.sessions.get(key);
    if (!session) return;
    // К11-008…010: the draft stays, the value saved elsewhere is shown, the next save expects its version.
    session.phase = "conflict"; session.problem = null; session.current = own; session.fieldVersion = own.version;
  }

  private marking(entry: Entry, status: "sending" | "unknown" | "refused", problem?: EditorProblem): void {
    if (entry.intent.kind === "field.undo") {
      const undo = this.undoState;
      if (!undo) return;
      if (status === "sending") { undo.status = "undoing"; undo.problem = null; }
      else if (status === "unknown") { undo.status = "unknown"; undo.problem = { reason: "unknown" }; }
      else { undo.status = "failed"; undo.problem = problem ?? { reason: "refused" }; }
      return;
    }
    const session = this.sessions.get(entry.key);
    if (!session) return;
    if (status === "sending") { session.phase = "saving"; session.problem = null; }
    else { session.phase = "failed"; session.problem = status === "unknown" ? { reason: "unknown" } : problem ?? { reason: "refused" }; }
  }

  private remember(key: FieldKey, source: FieldSource, stateVersion: string): void {
    const known = this.known.get(key);
    if (!known || !newer(known.stateVersion, stateVersion)) this.known.set(key, { ...source, stateVersion });
  }

  private async recheckUndo(undo: Undo, stateVersion: string): Promise<void> {
    undo.checking = true;
    let status: FieldCommandStatus | null = null;
    try {
      const origin = this.options.port.origin();
      if (origin) status = await this.options.port.status({ ...copyFieldIntent(undo.save), ...origin });
    } catch {
      status = null;
    }
    if (this.disposed || this.undoState !== undo) return;
    undo.checking = false;
    if (status === null) return;
    const current = status.outcome === "accepted" ? status.current : null;
    const target = current && current.status === "available" && "undo_target" in current ? current.undo_target : null;
    if (status.outcome === "accepted" && target && same(target.action_id, undo.target.action_id)) {
      undo.stateVersion = newer(status.state_version, stateVersion) ? status.state_version : stateVersion;
    } else this.undoState = null;
    this.notify();
  }
}

/** The own value and version of a field current (a role current addresses its own case role). */
function ownOf(current: Exclude<FieldCurrent, { status: "unavailable" }>): FieldSource {
  return { value: current.personal?.value ?? null, version: current.field_version };
}
