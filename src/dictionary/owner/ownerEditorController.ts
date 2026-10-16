import type { CommonFieldsCurrent, CommonGrammarForm, CommonTranslationsResponse } from "../../api/generated";
import { version } from "../../api/wireValidation";
import { commandOutcomeUnknown } from "../../commands/commandOutcome";
import { GatePending, pausedBeforeSend } from "../../commands/gatePending";
import type { ReadbackTicket, WriteGate } from "../../commands/writeGate";
import {
  copyCommonIntent, grammarCardType, grammarFields,
  type CardType, type CommonCommand, type CommonCommandReply, type CommonCommandStatus, type CommonCurrent, type CommonLanguage,
  type CommonOrigin, type CommonSaveIntent, type EditableGrammar, type GrammarFieldName, type Separability,
} from "./commonFieldApi";
import {
  addItem, canRemove, hasBlank, itemsOf, moveDown, moveItem, moveUp, removeItem, sameTexts, textsOf, type TranslationItem,
} from "./translationOrder";

/** Credentials stay behind the port; origin is the live document's at each exchange (a retry keeps the intent). */
export type OwnerEditorPort = {
  origin(): CommonOrigin | null;
  send(command: CommonCommand): Promise<CommonCommandReply>;
  /** The status read by ID; the ticket comes from the write gate (R6). */
  status(command: CommonCommand, ticket: ReadbackTicket): Promise<CommonCommandStatus>;
  /** R12-04: every L1's common translations of the card (a read, never repeated by itself). */
  readTranslations(cardId: string): Promise<CommonTranslationsResponse>;
};

/** The owner's common data of the shown card: the card read (or a newer command current) of the current L1. */
export type CommonSource = {
  cardId: string;
  cardType: CardType;
  language: CommonLanguage;
  /** card.revision: the expected_field_version of the next common save (C-FIELDS-3). */
  revision: string;
  stateVersion: string;
  translations: string[];
  grammar: EditableGrammar | null;
};

/** One grammar field as the editor holds it: a form (status and text; "" is no form) or the separability. */
export type GrammarDraft = { status: CommonGrammarForm["status"]; value: string } | Separability;
export type OwnerTarget = "translations" | `translations:${CommonLanguage}` | GrammarFieldName;
export type OwnerPhase = "editing" | "saving" | "failed" | "conflict" | "saved";
export type OwnerProblem = {
  /** unknown: no reply, the same command can be repeated; invalid: 422; forbidden: not the owner; unavailable: card gone. */
  reason: "unknown" | "refused" | "invalid" | "forbidden" | "unavailable" | "mismatch"
    /** The write gate kept the request on the client (PAUSED_BEFORE_SEND, P03 §4.2): nothing left, the same ID is retried. */
    | "paused";
  code?: string;
};
/** R12-04: the other languages under badges, folded until tapped; for viewing only. */
export type OtherLanguagesSnapshot = {
  status: "loading" | "ready" | "failed" | "unavailable";
  /**
   * R17-02 (вар.1, П5-026): an opened badge edits its language in place, with the same fields as the dictionary's own.
   * texts: the list saved now; editor: the editable list of that language.
   */
  languages: { language: CommonLanguage; texts: string[]; expanded: boolean; editor: TranslationListSnapshot }[];
  /**
   * A read again after a save or a conflict (C333/A-1): the lists stay meanwhile; a failure, or a card no longer available
   * to this editor, keeps them and their drafts, and is repeated only by a tap.
   */
  refresh: "idle" | "loading" | "failed" | "unavailable";
};
/** One language's editable list of common translations (R14-01). */
export type TranslationListSnapshot = {
  items: TranslationItem[];
  /** The server's list the editor started from (after a conflict: the list saved elsewhere). */
  current: string[];
  phase: OwnerPhase;
  problem: OwnerProblem | null;
  dirty: boolean;
  /** A blank field: the save waits until it is filled in or removed. */
  blank: boolean;
  /** R12-06: the last field cannot be removed; true after such a refused removal until the next change. */
  lastRefused: boolean;
  canEdit: boolean;
  canSave: boolean;
  canRetry: boolean;
  canRemove: boolean;
  checking: boolean;
  /**
   * Another language after a conflict: the list saved elsewhere is not known until its read succeeds; meanwhile it is not
   * shown as saved and «Взять сохранённое» / «Сохранить моё» wait (only the read is repeated).
   */
  reading: boolean;
};
export type TranslationsSnapshot = TranslationListSnapshot & {
  canCancel: boolean;
  others: OtherLanguagesSnapshot;
};
export type GrammarFieldSnapshot = {
  name: GrammarFieldName;
  draft: GrammarDraft;
  original: GrammarDraft;
  current: GrammarDraft;
  phase: OwnerPhase;
  problem: OwnerProblem | null;
  dirty: boolean;
  canEdit: boolean;
  canSave: boolean;
  canRetry: boolean;
  checking: boolean;
};
export type OwnerEditorSnapshot = {
  /** The owner sees the common editors of this card (a user never does: K07-030, «эха в Mini App нет»). */
  available: boolean;
  /** The card type has grammar the owner may edit (R12-05) and the card read carries it. */
  grammarAvailable: boolean;
  open: "translations" | "grammar" | null;
  canOpen: boolean;
  translations: TranslationsSnapshot | null;
  grammar: { fields: GrammarFieldSnapshot[]; canCancel: boolean } | null;
  /** After an accepted translation save the editor closes and leaves this note (as the personal editor, M-EDIT Р8). */
  savedNote: boolean;
  /** Leaving the card would lose text the server has not confirmed. */
  unsaved: boolean;
  /** A common command is in flight or unresolved: the personal pencils wait (one command at a time). */
  busy: boolean;
  disposed: boolean;
};

type Options = {
  port: OwnerEditorPort;
  newId(): string;
  onUpdate(snapshot: OwnerEditorSnapshot): void;
  /** An accepted or refused command changed what the card shows: the host reads the card and its context again. */
  onChanged(): void;
  /** The write gate of the page (P03 M-P03-8): status reads by ticket (R6) and the readback registry. */
  gate: WriteGate;
};
type Translations = {
  items: TranslationItem[]; original: string[]; current: string[]; phase: OwnerPhase; problem: OwnerProblem | null;
  lastRefused: boolean;
};
type GrammarField = {
  name: GrammarFieldName; draft: GrammarDraft; original: GrammarDraft; current: GrammarDraft; phase: OwnerPhase;
  problem: OwnerProblem | null;
};
/**
 * The other languages of the open translations editor (R12-04, R17-02): one editable list each, from the owner's read of
 * every language (GET /common). `revision` is the card revision of the read the lists stand on: their saves expect it.
 */
type Others = { status: OtherLanguagesSnapshot["status"]; sessions: Map<CommonLanguage, Translations>;
  revision: string | null; refresh: OtherLanguagesSnapshot["refresh"]; expanded: Set<CommonLanguage>; read: number;
  /** Languages whose list saved elsewhere is unknown since a conflict: only a successful read tells it. */
  stale: Set<CommonLanguage>;
  /** The card revision a read again was already started for: a newer card read starts at most one read per revision. */
  followed: string | null };
type Entry = { intent: CommonSaveIntent; target: OwnerTarget; status: "sending" | "unknown"; busy: boolean; notFound: boolean };
/** The target of a save of another language than the dictionary's (R17-02); "translations" is the dictionary's own. */
type OtherTarget = `translations:${CommonLanguage}`;

const commonLanguages: readonly CommonLanguage[] = ["ru", "uk", "en"];
const otherTarget = (language: CommonLanguage): OtherTarget => `translations:${language}`;
const isOtherTarget = (target: OwnerTarget): target is OtherTarget => target.startsWith("translations:");
const otherLanguageOf = (target: OtherTarget) => target.slice("translations:".length) as CommonLanguage;
const newer = (left: string, right: string) => BigInt(left) > BigInt(right);
const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
/** Codes after which the shown card may be outdated: it is read again, never guessed. */
const rereadCodes = new Set(["VERSION_CONFLICT", "WRITE_UNAVAILABLE", "DOCUMENT_STALE", "CAPABILITY_EXPIRED", "FORBIDDEN"]);
const trimmed = (texts: readonly string[]) => texts.map(text => text.trim());

/** The editor's value of one grammar field of the server's grammar. */
export function grammarDraftOf(grammar: EditableGrammar | null, name: GrammarFieldName): GrammarDraft {
  const source = (grammar ?? {}) as Record<string, unknown>;
  if (name === "separability") return (source.separability as Separability | undefined) ?? "unknown";
  const status = (source[name === "article" ? "article_status" : `${name}_status`] as CommonGrammarForm["status"] | undefined) ?? "unknown";
  return { status, value: name === "article" ? "" : (source[name] as string | null | undefined) ?? "" };
}

/**
 * The wire value of a grammar draft (core CommonGrammarForm): no form where none can be (not_applicable, the article's
 * status-only column), "" is an explicit clearing (null), never a blank text (common_fields._text).
 */
export function grammarValueOf(name: GrammarFieldName, draft: GrammarDraft): CommonGrammarForm | Separability {
  if (typeof draft === "string") return draft;
  const text = draft.value.trim() === "" || draft.status === "not_applicable" || name === "article" ? null : draft.value;
  return { status: draft.status, value: text };
}

function sameGrammar(name: GrammarFieldName, left: GrammarDraft, right: GrammarDraft): boolean {
  const a = grammarValueOf(name, left), b = grammarValueOf(name, right);
  if (typeof a === "string" || typeof b === "string") return a === b;
  return a.status === b.status && (a.value?.trim() ?? null) === (b.value?.trim() ?? null);
}

function fieldsOf(type: CardType): readonly GrammarFieldName[] {
  return grammarCardType(type) ? grammarFields[type] : [];
}

/**
 * The owner's common editors of one open card М12: «Изменить перевод для всех» (R12-04, R14-01) and the allowed grammar
 * (R12-05). Memory only, one command at a time; an unknown outcome is checked by the same ID and repeated only as the
 * same command. The version of every common field is the card revision: a newer card read rebases the open editor —
 * untouched fields take the server's value, a touched field whose server value changed becomes a conflict.
 */
export class OwnerEditorController {
  private source: CommonSource | null = null;
  private contextId: string | null = null;
  private blocked = false;
  private openEditor: "translations" | "grammar" | null = null;
  private translations: Translations | null = null;
  private others: Others | null = null;
  private reads = 0;
  private grammar = new Map<GrammarFieldName, GrammarField>();
  /** The revision every draft of the open editor is based on. */
  private base: string | null = null;
  private entry: Entry | null = null;
  private savedNote = false;
  private disposed = false;
  private keys = 0;

  private readonly registry: GatePending;

  private readonly unsubscribeGate: () => void;

  constructor(private readonly options: Options) {
    this.registry = new GatePending(options.gate, "owner_field");
    // §4.1 «Правило кнопки» (C335, AC-16/AC-28; M-P03-10): «Сохранить»/«Повторить» follow the write gate — visible and
    // inactive while it holds, repainted as it changes; a press meanwhile does nothing and nothing is queued.
    this.unsubscribeGate = options.gate.subscribe(() => this.notify());
  }

  // ---- inputs from the host ----

  /** The owner's card read (null: not the owner, or no card shown). Another card or language starts over. */
  setCard(source: CommonSource | null): void {
    if (this.disposed) return;
    const previous = this.source;
    if (source === null) {
      if (previous === null) return;
      this.source = null; this.close(); this.entry = null; this.savedNote = false;
      this.notify();
      return;
    }
    if (!version(source.stateVersion) || !version(source.revision)) throw new Error("invalid common source");
    if (previous && (!same(previous.cardId, source.cardId) || previous.language !== source.language)) {
      this.close(); this.entry = null; this.savedNote = false;
    } else if (previous && newer(previous.stateVersion, source.stateVersion)) return; // an older read adds nothing
    this.source = structuredClone(source);
    this.rebase();
    this.followOthers();
    this.notify();
  }

  /** The open card context: a common save needs it. */
  setContext(contextId: string | null): void {
    if (this.disposed) return;
    this.contextId = contextId === null ? null : contextId.toLowerCase();
    this.notify();
  }

  /** A personal editor is open or its command is under way: no common editor opens meanwhile (one at a time). */
  setBlocked(blocked: boolean): void {
    if (this.disposed || this.blocked === blocked) return;
    this.blocked = blocked;
    this.notify();
  }

  /** A new access handle or document: an unresolved command is checked by status, never re-sent. */
  async resume(): Promise<void> {
    const entry = this.entry;
    if (!this.disposed && entry && entry.status === "unknown" && !entry.busy && !entry.notFound) await this.check(entry);
  }

  dispose(): void {
    // Unsubscribed first: the release below changes the gate, and a disposed owner repaints nothing.
    this.unsubscribeGate();
    // R3: an ID without a definite answer stays locked to itself in the gate.
    this.registry.release();
    this.disposed = true;
    this.entry = null;
    this.close();
  }

  // ---- user actions: opening ----

  openTranslations(): void {
    const source = this.source;
    if (!source || !this.canOpen()) return;
    this.savedNote = false;
    // A card without a common translation of this L1 starts with one empty field.
    const texts = source.translations.length > 0 ? source.translations : [""];
    this.translations = { items: itemsOf(texts, () => this.newKey()), original: [...texts], current: [...source.translations],
      phase: "editing", problem: null, lastRefused: false };
    this.base = source.revision;
    this.openEditor = "translations";
    this.others = { status: "loading", sessions: new Map(), revision: null, refresh: "idle", expanded: new Set(), read: 0,
      stale: new Set(), followed: null };
    this.notify();
    void this.loadOthers();
  }

  /** R12-04: a badge opens or folds the translations of one other language; folding keeps its unsaved list. */
  toggleLanguage(language: CommonLanguage): void {
    const others = this.others;
    if (!others || others.status !== "ready" || this.openEditor !== "translations" || language === this.source?.language) return;
    if (others.expanded.has(language)) others.expanded.delete(language); else others.expanded.add(language);
    this.notify();
  }

  /** A failed read of the other languages (the first one or a read again) is repeated only by the owner's tap. */
  retryOthers(): Promise<void> {
    const others = this.others;
    if (!others || this.openEditor !== "translations") return Promise.resolve();
    if (others.status === "failed") others.status = "loading";
    else if (others.status === "ready" && (others.refresh === "failed" || others.refresh === "unavailable")) others.refresh = "loading";
    else return Promise.resolve();
    this.notify();
    return this.loadOthers();
  }

  openGrammar(): void {
    const source = this.source;
    if (!source || !this.canOpen() || !this.grammarAvailable()) return;
    this.savedNote = false;
    this.grammar.clear();
    for (const name of fieldsOf(source.cardType)) {
      const value = grammarDraftOf(source.grammar, name);
      this.grammar.set(name, { name, draft: value, original: value, current: value, phase: "editing", problem: null });
    }
    this.base = source.revision;
    this.openEditor = "grammar";
    this.notify();
  }

  /** Close the open editor without saving; a save in flight cannot be cancelled, an unresolved one is forgotten. */
  cancel(): void {
    if (this.openEditor === null) return;
    const entry = this.entry;
    if (entry) {
      if (entry.busy) return;
      this.entry = null;
      this.options.onChanged();
    }
    this.close();
    this.notify();
  }

  // ---- user actions: translations (R14-01; another language: R17-02) ----
  // `language`: the list of that language; left out or the dictionary's own, the dictionary's list.

  editTranslation(index: number, text: string, language?: CommonLanguage): void {
    const session = this.sessionOf(language);
    if (!session || typeof text !== "string" || !this.translationsEditable(session) || !session.items[index]) return;
    session.items = session.items.map((item, position) => position === index ? { ...item, text } : item);
    this.touched(session);
  }

  addTranslation(language?: CommonLanguage): void {
    const session = this.sessionOf(language);
    if (!session || !this.translationsEditable(session)) return;
    session.items = addItem(session.items, this.newKey());
    this.touched(session);
  }

  /** R12-06: removing the last field is refused with an explanation, the list stays. */
  removeTranslation(index: number, language?: CommonLanguage): void {
    const session = this.sessionOf(language);
    if (!session || !this.translationsEditable(session) || !session.items[index]) return;
    if (!canRemove(session.items)) { session.lastRefused = true; this.notify(); return; }
    session.items = removeItem(session.items, index);
    this.touched(session);
  }

  /** Drag and drop (R14-01): the field from `from` takes the place `to`; it can become the first. */
  moveTranslation(from: number, to: number, language?: CommonLanguage): void {
    const session = this.sessionOf(language);
    if (!session || !this.translationsEditable(session)) return;
    const items = moveItem(session.items, from, to);
    if (items.every((item, index) => item === session.items[index])) return;
    session.items = items;
    this.touched(session);
  }

  /** «Выше» / «Ниже» for the keyboard and the screen reader (R14-01). */
  moveTranslationUp(index: number, language?: CommonLanguage): void {
    const session = this.sessionOf(language);
    if (!session || !this.translationsEditable(session) || index <= 0) return;
    session.items = moveUp(session.items, index);
    this.touched(session);
  }

  moveTranslationDown(index: number, language?: CommonLanguage): void {
    const session = this.sessionOf(language);
    if (!session || !this.translationsEditable(session) || index >= session.items.length - 1) return;
    session.items = moveDown(session.items, index);
    this.touched(session);
  }

  saveTranslations(language?: CommonLanguage): Promise<void> {
    const session = this.sessionOf(language);
    if (!session || !this.canSaveTranslations(session)) return Promise.resolve();
    return this.start(this.targetOf(session), this.translationsIntent(session));
  }

  /** Conflict: keep my list and save it against the revision just reported (the server checks again). */
  keepMineTranslations(language?: CommonLanguage): Promise<void> {
    const session = this.sessionOf(language);
    if (!session || session.phase !== "conflict" || this.entry || !this.contextId || hasBlank(session.items)
      || this.reading(session)) return Promise.resolve();
    return this.start(this.targetOf(session), this.translationsIntent(session));
  }

  /** Conflict: take the list saved elsewhere; my list is dropped only by this explicit choice. */
  acceptCurrentTranslations(language?: CommonLanguage): void {
    const session = this.sessionOf(language);
    if (!session || session.phase !== "conflict" || this.reading(session)) return;
    const texts = session.current.length > 0 ? session.current : [""];
    session.items = itemsOf(texts, () => this.newKey());
    session.original = [...texts];
    session.phase = "editing"; session.problem = null; session.lastRefused = false;
    this.notify();
  }

  /** After an unknown outcome the same command; after a refusal a new one with the same list. */
  retryTranslations(language?: CommonLanguage): Promise<void> {
    const session = this.sessionOf(language), entry = this.entry;
    if (!session || session.phase !== "failed") return Promise.resolve();
    const target = this.targetOf(session);
    if (entry && entry.target === target) {
      return entry.status === "unknown" && !entry.busy && this.registry.writable(entry.intent.command_id) ? this.execute(entry) : Promise.resolve();
    }
    return this.saveTranslations(language);
  }

  // ---- user actions: grammar (R12-05) ----

  editGrammar(name: GrammarFieldName, draft: GrammarDraft): void {
    const field = this.grammar.get(name);
    if (!field || !this.grammarEditable(field) || !validDraft(name, draft)) return;
    field.draft = typeof draft === "string" ? draft : { status: draft.status, value: draft.value };
    if (field.phase === "failed" || field.phase === "saved") { field.phase = "editing"; field.problem = null; }
    this.notify();
  }

  saveGrammar(name: GrammarFieldName): Promise<void> {
    const field = this.grammar.get(name);
    if (!field || !this.canSaveGrammar(field)) return Promise.resolve();
    return this.start(name, this.grammarIntent(field));
  }

  keepMineGrammar(name: GrammarFieldName): Promise<void> {
    const field = this.grammar.get(name);
    if (!field || field.phase !== "conflict" || this.entry || !this.contextId) return Promise.resolve();
    return this.start(name, this.grammarIntent(field));
  }

  acceptCurrentGrammar(name: GrammarFieldName): void {
    const field = this.grammar.get(name);
    if (!field || field.phase !== "conflict") return;
    field.draft = field.current; field.original = field.current;
    field.phase = "editing"; field.problem = null;
    this.notify();
  }

  retryGrammar(name: GrammarFieldName): Promise<void> {
    const field = this.grammar.get(name), entry = this.entry;
    if (!field || field.phase !== "failed") return Promise.resolve();
    if (entry && entry.target === name) {
      return entry.status === "unknown" && !entry.busy && this.registry.writable(entry.intent.command_id) ? this.execute(entry) : Promise.resolve();
    }
    return this.saveGrammar(name);
  }

  // ---- snapshot ----

  snapshot(): OwnerEditorSnapshot {
    if (this.disposed) {
      return { available: false, grammarAvailable: false, open: null, canOpen: false, translations: null, grammar: null,
        savedNote: false, unsaved: false, busy: false, disposed: true };
    }
    const entry = this.entry;
    const session = this.translations;
    const translations: TranslationsSnapshot | null = session && this.openEditor === "translations" ? {
      ...this.listSnapshot(session), canCancel: !(entry?.busy ?? false), others: this.othersSnapshot(),
    } : null;
    const grammar = this.openEditor === "grammar" ? {
      fields: [...this.grammar.values()].map(field => ({
        name: field.name, draft: copyDraft(field.draft), original: copyDraft(field.original), current: copyDraft(field.current),
        phase: field.phase, problem: field.problem ? { ...field.problem } : null,
        dirty: !sameGrammar(field.name, field.draft, field.original), canEdit: this.grammarEditable(field),
        canSave: this.canSaveGrammar(field),
        canRetry: field.phase === "failed" && (entry?.target === field.name
          ? entry.status === "unknown" && !entry.busy && this.registry.writable(entry.intent.command_id)
          : this.retryable(field.problem) && this.registry.writable()),
        checking: entry?.target === field.name && entry.busy,
      })),
      canCancel: !(entry?.busy ?? false),
    } : null;
    return {
      available: this.source !== null, grammarAvailable: this.grammarAvailable(), open: this.openEditor,
      canOpen: this.canOpen(), translations, grammar, savedNote: this.savedNote && this.openEditor === null,
      unsaved: this.unsaved(), busy: entry !== null, disposed: false,
    };
  }

  private listSnapshot(session: Translations): TranslationListSnapshot {
    const entry = this.entry, target = this.targetOf(session);
    return {
      items: session.items.map(item => ({ ...item })), current: [...session.current], phase: session.phase,
      problem: session.problem ? { ...session.problem } : null, dirty: this.translationsDirty(session),
      blank: hasBlank(session.items), lastRefused: session.lastRefused, canEdit: this.translationsEditable(session),
      canSave: this.canSaveTranslations(session),
      canRetry: session.phase === "failed" && (entry?.target === target
        ? entry.status === "unknown" && !entry.busy && this.registry.writable(entry.intent.command_id)
        : this.retryable(session.problem) && !hasBlank(session.items) && this.othersSaveable(session) && this.registry.writable()),
      canRemove: canRemove(session.items), checking: entry?.target === target && entry.busy, reading: this.reading(session),
    };
  }

  private othersSnapshot(): OtherLanguagesSnapshot {
    const others = this.others;
    if (!others) return { status: "loading", languages: [], refresh: "idle" };
    const languages = others.status !== "ready" ? [] : [...others.sessions].map(([language, session]) => ({
      language, texts: [...session.current], expanded: others.expanded.has(language), editor: this.listSnapshot(session) }));
    return { status: others.status, languages, refresh: others.refresh };
  }

  /**
   * GET /common: the first read of the other languages, or a read again (refresh) after a save of another language, a
   * conflict or a newer card revision (C333/A-1: the core's current shows the dictionary's language only).
   */
  private async loadOthers(): Promise<void> {
    const others = this.others, source = this.source;
    if (!others || !source) return;
    const read = ++this.reads;
    others.read = read;
    let reply: CommonTranslationsResponse | null = null;
    try {
      reply = await this.options.port.readTranslations(source.cardId);
    } catch {
      reply = null;
    }
    // A later read, another card or a closed editor makes this answer stale.
    if (this.disposed || this.others !== others || others.read !== read || this.source === null
      || !same(this.source.cardId, source.cardId)) return;
    const current = reply?.current;
    if (!reply || !current) {
      // A failed read again keeps the lists (and their drafts); the first failed read has none to keep.
      if (others.status === "ready") others.refresh = "failed"; else others.status = "failed";
    } else if (current.status !== "available" || current.language !== this.source.language) {
      // A read again never drops the lists or their drafts (C337); the first read has nothing to show.
      if (others.status === "ready") others.refresh = "unavailable";
      else { others.status = "unavailable"; others.refresh = "idle"; others.sessions.clear(); others.revision = null; }
    } else {
      this.applyOthers(others, current.card_revision, current.translations);
      // The card may have moved on while this read was under way (its first read included).
      this.followOthers();
    }
    this.notify();
  }

  /**
   * The other languages' lists at a card revision. Untouched lists take the server's; a touched list whose server value
   * changed is a conflict; the list of a save under way waits for its outcome. An older read adds nothing.
   */
  private applyOthers(others: Others, revision: string, lists: Record<CommonLanguage, string[]>): void {
    const own = this.source?.language;
    others.refresh = "idle";
    if (others.revision !== null && newer(others.revision, revision)) return;
    for (const language of commonLanguages) {
      if (language === own) continue;
      const server = [...lists[language]], session = others.sessions.get(language);
      if (!session) {
        // A language without a common translation starts with one empty field, as the dictionary's own.
        const texts = server.length > 0 ? server : [""];
        others.sessions.set(language, { items: itemsOf(texts, () => this.newKey()), original: [...texts], current: server,
          phase: "editing", problem: null, lastRefused: false });
        continue;
      }
      if (this.entry?.target === otherTarget(language)) continue;
      others.stale.delete(language);
      if (sameTexts(server, session.current)) continue;
      if (!this.translationsDirty(session) && session.phase !== "conflict") {
        const texts = server.length > 0 ? server : [""];
        session.items = itemsOf(texts, () => this.newKey());
        session.original = [...texts];
      } else { session.phase = "conflict"; session.problem = null; }
      session.current = server;
    }
    others.revision = revision;
    others.status = "ready";
  }

  /** A newer card revision than the other lists stand on: they are read again once (a failure waits for a tap). */
  private followOthers(): void {
    const others = this.others, source = this.source;
    if (!others || !source || this.openEditor !== "translations" || others.status !== "ready" || others.refresh !== "idle"
      || this.entry !== null || others.revision === null || !newer(source.revision, others.revision)
      || others.followed === source.revision) return;
    others.followed = source.revision;
    this.refreshOthers();
  }

  private refreshOthers(): void {
    const others = this.others;
    if (!others || others.status !== "ready" || this.openEditor !== "translations") return;
    others.refresh = "loading";
    void this.loadOthers();
  }

  // ---- rules ----

  private canOpen(): boolean {
    return !this.disposed && this.source !== null && this.contextId !== null && !this.blocked && this.openEditor === null
      && this.entry === null;
  }
  private grammarAvailable(): boolean {
    const source = this.source;
    return source !== null && grammarCardType(source.cardType) && source.grammar !== null;
  }
  /** While a save is in flight or unresolved the list is the one sent; it changes only after the outcome. */
  private translationsEditable(session: Translations): boolean {
    // A conflict keeps its explicit choice («Взять сохранённое» / «Сохранить моё»); the list stays editable meanwhile.
    return this.openEditor === "translations" && this.entry === null && session.phase !== "saving";
  }
  /** The list of the dictionary's language, or of another language once its read is shown (R17-02). */
  private sessionOf(language?: CommonLanguage): Translations | null {
    if (language === undefined || language === this.source?.language) return this.translations;
    const others = this.others;
    return others?.status === "ready" ? others.sessions.get(language) ?? null : null;
  }
  private languageOf(session: Translations): CommonLanguage | null {
    for (const [language, item] of this.others?.sessions ?? []) if (item === session) return language;
    return null;
  }
  private targetOf(session: Translations): OwnerTarget {
    const language = session === this.translations ? null : this.languageOf(session);
    return language === null ? "translations" : otherTarget(language);
  }
  /** Another language's list is saved against the revision of its read, never while that read is renewed. */
  private othersSaveable(session: Translations): boolean {
    if (session === this.translations) return true;
    const others = this.others;
    return others !== null && others.status === "ready" && others.refresh !== "loading" && others.refresh !== "unavailable"
      && others.revision !== null;
  }
  /** The list saved elsewhere of another language is not known yet (being read, or its read failed): its choice waits. */
  private reading(session: Translations): boolean {
    const language = session === this.translations ? null : this.languageOf(session);
    return language !== null && (this.others?.stale.has(language) ?? false);
  }
  private grammarEditable(field: GrammarField): boolean {
    return this.openEditor === "grammar" && this.entry?.target !== field.name;
  }
  private translationsDirty(session: Translations): boolean {
    return !sameTexts(textsOf(session.items), session.original);
  }
  /** An unchanged list is not saved; a blank field or an empty list never goes (R12-06). */
  private canSaveTranslations(session: Translations): boolean {
    const texts = textsOf(session.items);
    return this.contextId !== null && this.entry === null && this.openEditor === "translations" && this.othersSaveable(session)
      && (session.phase === "editing" || session.phase === "failed" && this.retryable(session.problem))
      && texts.length > 0 && !hasBlank(session.items) && !sameTexts(trimmed(texts), trimmed(session.original))
      && this.registry.writable();
  }
  private canSaveGrammar(field: GrammarField): boolean {
    return this.contextId !== null && this.entry === null && this.openEditor === "grammar"
      && (field.phase === "editing" || field.phase === "saved" || field.phase === "failed" && this.retryable(field.problem))
      && !sameGrammar(field.name, field.draft, field.original) && this.registry.writable();
  }
  private retryable(problem: OwnerProblem | null): boolean {
    return this.contextId !== null && this.entry === null && problem?.reason !== "unavailable" && problem?.reason !== "forbidden";
  }
  private unsaved(): boolean {
    if (this.openEditor === "translations" && this.translations) {
      return this.entry !== null || [this.translations, ...this.others?.sessions.values() ?? []]
        .some(session => this.translationsDirty(session) || session.phase === "conflict");
    }
    if (this.openEditor === "grammar") {
      return this.entry !== null || [...this.grammar.values()].some(field => field.phase === "conflict"
        || !sameGrammar(field.name, field.draft, field.original));
    }
    return false;
  }

  /** R17-02: another language's list goes with its own language and the revision of its read. */
  private translationsIntent(session: Translations): CommonSaveIntent {
    const source = this.source!, other = session === this.translations ? null : this.languageOf(session);
    return copyCommonIntent({ kind: "field.save", command_id: this.options.newId(), context_id: this.contextId!,
      card_id: source.cardId, field_name: "translation", language: other ?? source.language, value: textsOf(session.items),
      expected_field_version: other !== null ? this.others!.revision! : this.base ?? source.revision });
  }
  private grammarIntent(field: GrammarField): CommonSaveIntent {
    const source = this.source!;
    return copyCommonIntent({ kind: "field.save", command_id: this.options.newId(), context_id: this.contextId!,
      card_id: source.cardId, field_name: field.name, language: null, value: grammarValueOf(field.name, field.draft),
      expected_field_version: this.base ?? source.revision });
  }

  // ---- state helpers ----

  private newKey(): string {
    this.keys += 1;
    return `t${this.keys}`;
  }

  private touched(session: Translations): void {
    session.lastRefused = false;
    if (session.phase === "failed" || session.phase === "saved") { session.phase = "editing"; session.problem = null; }
    this.notify();
  }

  private close(): void {
    this.openEditor = null;
    this.translations = null;
    this.others = null;
    this.grammar.clear();
    this.base = null;
  }

  /**
   * A newer source of the same card: the open editor follows it. Untouched drafts take the server's values; a touched
   * draft whose server value changed is a conflict; the next save expects the new revision.
   */
  private rebase(): void {
    const source = this.source;
    if (!source || this.openEditor === null || this.base === null || !newer(source.revision, this.base)) return;
    const entry = this.entry;
    if (this.openEditor === "translations" && this.translations && entry?.target !== "translations") {
      const session = this.translations, server = source.translations;
      if (!sameTexts(server, session.current)) {
        if (!this.translationsDirty(session) && session.phase !== "conflict") {
          const texts = server.length > 0 ? server : [""];
          session.items = itemsOf(texts, () => this.newKey());
          session.original = [...texts];
        } else { session.phase = "conflict"; session.problem = null; }
        session.current = [...server];
      }
    }
    if (this.openEditor === "grammar") {
      for (const field of this.grammar.values()) {
        if (entry?.target === field.name) continue;
        const server = grammarDraftOf(source.grammar, field.name);
        if (sameGrammar(field.name, server, field.current)) continue;
        if (sameGrammar(field.name, field.draft, field.original) && field.phase !== "conflict") {
          field.draft = server; field.original = server;
        } else { field.phase = "conflict"; field.problem = null; }
        field.current = server;
      }
    }
    if (!entry) this.base = source.revision;
  }

  /** A command's current is a newer common source of the same card (its state version orders it). */
  private absorb(current: CommonCurrent, stateVersion: string): void {
    const source = this.source;
    if (!source || current.status !== "available" || !same(current.card_id, source.cardId) || current.language !== source.language
      || newer(source.stateVersion, stateVersion)) return;
    this.source = sourceOf(current, stateVersion);
  }

  // ---- exchange ----

  private notify(): void {
    if (!this.disposed) this.options.onUpdate(this.snapshot());
  }

  private start(target: OwnerTarget, intent: CommonSaveIntent): Promise<void> {
    const entry: Entry = { intent: copyCommonIntent(intent), target, status: "sending", busy: false, notFound: false };
    this.entry = entry;
    return this.execute(entry);
  }

  private command(entry: Entry): CommonCommand | null {
    const origin = this.options.port.origin();
    return origin ? { ...copyCommonIntent(entry.intent), ...origin } : null;
  }

  private async execute(entry: Entry): Promise<void> {
    entry.status = "sending"; entry.busy = true; entry.notFound = false;
    this.mark(entry.target, "saving", null);
    this.notify();
    let reply: CommonCommandReply;
    try {
      const command = this.command(entry);
      if (!command) throw new Error("no live document");
      // From now on a request of this ID may leave: its outcome is unknown until a definite answer (R1).
      this.registry.hold(entry.intent.command_id);
      reply = await this.options.port.send(command);
    } catch (error) {
      if (this.disposed || this.entry !== entry) return;
      entry.busy = false;
      // PAUSED_BEFORE_SEND comes before commandOutcomeUnknown: nothing left, no check; the retry repeats the same ID.
      if (pausedBeforeSend(error)) {
        entry.status = "unknown";
        this.mark(entry.target, "failed", { reason: "paused" });
        this.notify();
        return;
      }
      if (commandOutcomeUnknown(error)) {
        entry.status = "unknown";
        this.mark(entry.target, "failed", { reason: "unknown" });
        this.notify();
        await this.check(entry);
        return;
      }
      // An HTTP refusal without a fact: nothing was saved.
      this.entry = null;
      this.registry.settled("rejected");
      this.registry.release();
      const code = (error as { code?: string }).code;
      this.mark(entry.target, "failed", problemOf(code, null));
      this.notify();
      if (code && rereadCodes.has(code)) this.options.onChanged();
      return;
    }
    if (this.disposed || this.entry !== entry) return;
    this.entry = null;
    this.registry.settled(reply.outcome === "accepted" ? "recorded" : reply.outcome === "mismatch" ? "mismatch" : "rejected");
    this.registry.release();
    this.settle(entry, reply);
  }

  /** One status request for an unknown outcome: accepted settles, not_found allows the same command again. */
  private async check(entry: Entry): Promise<void> {
    if (entry.busy || this.disposed) return;
    entry.busy = true;
    this.notify();
    let status: CommonCommandStatus;
    try {
      const command = this.command(entry);
      if (!command) throw new Error("no live document");
      // R6: the status of this ID is read only with the gate's ticket.
      status = await this.registry.read(command.command_id, ticket => this.options.port.status(command, ticket));
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
      this.registry.settled("recorded");
      this.registry.release();
      this.accepted(entry, status.current, status.state_version);
      return;
    }
    if (status.outcome === "not_found") { this.registry.settled("not_recorded"); entry.notFound = true; this.notify(); return; }
    // Another payload under this ID: this intent can never be confirmed; a new command is needed.
    this.entry = null;
    this.registry.settled("mismatch");
    this.registry.release();
    this.mark(entry.target, "failed", { reason: "mismatch", code: status.error.code });
    this.notify();
  }

  private settle(entry: Entry, reply: CommonCommandReply): void {
    if (reply.outcome === "accepted") {
      this.accepted(entry, reply.current, reply.state_version);
      return;
    }
    const code = reply.error.code;
    if (reply.outcome === "mismatch") this.mark(entry.target, "failed", { reason: "mismatch", code });
    else if (code === "VERSION_CONFLICT" && reply.current.status === "available") {
      // К11-008…010: my draft stays, the value saved elsewhere is shown, the next save expects its revision.
      this.absorb(reply.current, reply.state_version);
      this.conflict(entry.target);
    } else this.mark(entry.target, "failed", problemOf(code, reply.current));
    this.notify();
    if (rereadCodes.has(code)) this.options.onChanged();
  }

  private accepted(entry: Entry, current: CommonCurrent, stateVersion: string): void {
    this.absorb(current, stateVersion);
    const source = this.source;
    if (isOtherTarget(entry.target)) this.savedOther(entry, otherLanguageOf(entry.target));
    else if (entry.target === "translations") {
      // The editor closes after its save and leaves a note at the translation; while another language keeps an unsaved
      // list it stays open with the saved list of its own language (R17-02: no draft is dropped without a choice).
      if (this.openEditor === "translations" && this.othersUnsaved()) this.savedOwn(entry);
      else if (this.openEditor === "translations") { this.close(); this.savedNote = true; }
    } else {
      const field = this.grammar.get(entry.target);
      if (field && source && this.openEditor === "grammar") {
        const server = grammarDraftOf(source.grammar, field.name);
        field.current = server; field.original = server; field.draft = server;
        field.phase = "saved"; field.problem = null;
        this.base = source.revision;
        this.rebaseGrammar(field.name);
      }
    }
    this.notify();
    this.options.onChanged();
  }

  /** Only my save lies between the revision the other lists stand on and its fact: they follow it without a read. */
  private followMine(entry: Entry): void {
    const others = this.others, expected = entry.intent.expected_field_version;
    if (others && others.revision === expected) others.revision = String(BigInt(expected) + 1n);
  }

  private othersUnsaved(): boolean {
    return [...this.others?.sessions.values() ?? []].some(session => this.translationsDirty(session) || session.phase === "conflict");
  }

  /** The dictionary's list saved while another language keeps a draft: the editor stays with the reply's list. */
  private savedOwn(entry: Entry): void {
    const session = this.translations, source = this.source;
    if (!session || !source) return;
    const texts = source.translations.length > 0 ? source.translations : [""];
    session.items = itemsOf(texts, () => this.newKey()); session.original = [...texts]; session.current = [...source.translations];
    session.phase = "saved"; session.problem = null; session.lastRefused = false;
    this.base = source.revision;
    this.followMine(entry);
  }

  /**
   * Another language saved (R17-02): the reply's current shows the dictionary's language only, so the saved list is read
   * again (GET /common) and shown in its own panel (C333/A-1); meanwhile the panel holds what was sent, edges trimmed as
   * the core does. The dictionary's list follows the reply as after any newer card read.
   */
  private savedOther(entry: Entry, language: CommonLanguage): void {
    const session = this.others?.sessions.get(language);
    this.followMine(entry);
    if (this.openEditor !== "translations" || !session) return;
    const sent = trimmed(entry.intent.value as string[]);
    session.items = itemsOf(sent, () => this.newKey()); session.original = [...sent]; session.current = [...sent];
    session.phase = "saved"; session.problem = null; session.lastRefused = false;
    this.rebase();
    this.refreshOthers();
  }

  /** After my own grammar save the other fields follow the reply (a concurrent change would be a conflict). */
  private rebaseGrammar(saved: GrammarFieldName): void {
    const source = this.source;
    if (!source) return;
    for (const field of this.grammar.values()) {
      if (field.name === saved) continue;
      const server = grammarDraftOf(source.grammar, field.name);
      if (sameGrammar(field.name, server, field.current)) continue;
      if (sameGrammar(field.name, field.draft, field.original)) { field.draft = server; field.original = server; }
      else { field.phase = "conflict"; field.problem = null; }
      field.current = server;
    }
  }

  private conflict(target: OwnerTarget): void {
    const source = this.source;
    if (!source) return;
    if (isOtherTarget(target)) {
      // The reply's current is the dictionary's language: that list follows it; the list saved elsewhere of this
      // language is read again, and its revision is what «Сохранить моё» expects (C333/A-1).
      const language = otherLanguageOf(target), session = this.others?.sessions.get(language);
      if (!session) return;
      session.phase = "conflict"; session.problem = null;
      this.others!.stale.add(language);
      this.rebase();
      this.refreshOthers();
      return;
    }
    if (target === "translations") {
      const session = this.translations;
      if (!session) return;
      session.phase = "conflict"; session.problem = null; session.current = [...source.translations];
    } else {
      const field = this.grammar.get(target);
      if (!field) return;
      field.phase = "conflict"; field.problem = null; field.current = grammarDraftOf(source.grammar, target);
      this.rebaseGrammar(target);
    }
    this.base = source.revision;
  }

  private mark(target: OwnerTarget, phase: OwnerPhase, problem: OwnerProblem | null): void {
    if (isOtherTarget(target)) {
      const session = this.others?.sessions.get(otherLanguageOf(target));
      if (session) { session.phase = phase; session.problem = problem; }
      return;
    }
    if (target === "translations") {
      const session = this.translations;
      if (session) { session.phase = phase; session.problem = problem; }
      return;
    }
    const field = this.grammar.get(target);
    if (field) { field.phase = phase; field.problem = problem; }
  }
}

function problemOf(code: string | undefined, current: CommonCurrent | null): OwnerProblem {
  const coded = code ? { code } : {};
  if (code === "FORBIDDEN") return { reason: "forbidden", ...coded };
  if (code === "VALIDATION_FAILED") return { reason: "invalid", ...coded };
  if (current?.status === "unavailable" || code === "WRITE_UNAVAILABLE" || code === "DOCUMENT_STALE"
    || code === "CAPABILITY_EXPIRED") return { reason: "unavailable", ...coded };
  return { reason: "refused", ...coded };
}

function copyDraft(draft: GrammarDraft): GrammarDraft {
  return typeof draft === "string" ? draft : { status: draft.status, value: draft.value };
}

const statuses = ["applicable", "not_applicable", "unknown"];
const closedValues: Partial<Record<GrammarFieldName, readonly string[]>> = {
  gender: ["masculine", "feminine", "neuter"], auxiliary: ["haben", "sein"],
};

/** The editor offers only what the core accepts (validation._CLOSED_VALUES, STATUS_ONLY_FIELDS). */
function validDraft(name: GrammarFieldName, draft: GrammarDraft): boolean {
  if (name === "separability") return typeof draft === "string" && ["separable", "inseparable", "unknown"].includes(draft);
  if (typeof draft !== "object" || draft === null || !statuses.includes(draft.status) || typeof draft.value !== "string") return false;
  const closed = closedValues[name];
  return !closed || draft.value === "" || closed.includes(draft.value);
}

/** The common source of the owner's current (core common_projection). */
export function sourceOf(current: CommonFieldsCurrent, stateVersion: string): CommonSource {
  return { cardId: current.card_id, cardType: current.card_type, language: current.language, revision: current.card_revision,
    stateVersion, translations: [...current.translations], grammar: current.grammar ? { ...current.grammar } : null };
}
