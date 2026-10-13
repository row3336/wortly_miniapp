import type { CommonFieldsCurrent, CommonGrammarForm, CommonTranslationsResponse } from "../../api/generated";
import { version } from "../../api/wireValidation";
import { commandOutcomeUnknown } from "../../commands/commandOutcome";
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
  status(command: CommonCommand): Promise<CommonCommandStatus>;
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
export type OwnerTarget = "translations" | GrammarFieldName;
export type OwnerPhase = "editing" | "saving" | "failed" | "conflict" | "saved";
export type OwnerProblem = {
  /** unknown: no reply, the same command can be repeated; invalid: 422; forbidden: not the owner; unavailable: card gone. */
  reason: "unknown" | "refused" | "invalid" | "forbidden" | "unavailable" | "mismatch";
  code?: string;
};
/** R12-04: the other languages under badges, folded until tapped; for viewing only. */
export type OtherLanguagesSnapshot = {
  status: "loading" | "ready" | "failed" | "unavailable";
  languages: { language: CommonLanguage; texts: string[]; expanded: boolean }[];
};
export type TranslationsSnapshot = {
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
  canCancel: boolean;
  canRemove: boolean;
  checking: boolean;
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
};
type Translations = {
  items: TranslationItem[]; original: string[]; current: string[]; phase: OwnerPhase; problem: OwnerProblem | null;
  lastRefused: boolean;
};
type GrammarField = {
  name: GrammarFieldName; draft: GrammarDraft; original: GrammarDraft; current: GrammarDraft; phase: OwnerPhase;
  problem: OwnerProblem | null;
};
type Others = { status: OtherLanguagesSnapshot["status"]; byLanguage: Partial<Record<CommonLanguage, string[]>>;
  expanded: Set<CommonLanguage>; read: number };
type Entry = { intent: CommonSaveIntent; target: OwnerTarget; status: "sending" | "unknown"; busy: boolean; notFound: boolean };

const commonLanguages: readonly CommonLanguage[] = ["ru", "uk", "en"];
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

  constructor(private readonly options: Options) {}

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
    this.others = { status: "loading", byLanguage: {}, expanded: new Set(), read: 0 };
    this.notify();
    void this.loadOthers();
  }

  /** R12-04: a badge opens or folds the translations of one other language. */
  toggleLanguage(language: CommonLanguage): void {
    const others = this.others;
    if (!others || others.status !== "ready" || this.openEditor !== "translations" || language === this.source?.language) return;
    if (others.expanded.has(language)) others.expanded.delete(language); else others.expanded.add(language);
    this.notify();
  }

  /** A failed read of the other languages is repeated only by the owner's tap. */
  retryOthers(): Promise<void> {
    if (this.others?.status !== "failed" || this.openEditor !== "translations") return Promise.resolve();
    this.others.status = "loading";
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

  // ---- user actions: translations (R14-01) ----

  editTranslation(index: number, text: string): void {
    const session = this.translations;
    if (!session || typeof text !== "string" || !this.translationsEditable() || !session.items[index]) return;
    session.items = session.items.map((item, position) => position === index ? { ...item, text } : item);
    this.touched(session);
  }

  addTranslation(): void {
    const session = this.translations;
    if (!session || !this.translationsEditable()) return;
    session.items = addItem(session.items, this.newKey());
    this.touched(session);
  }

  /** R12-06: removing the last field is refused with an explanation, the list stays. */
  removeTranslation(index: number): void {
    const session = this.translations;
    if (!session || !this.translationsEditable() || !session.items[index]) return;
    if (!canRemove(session.items)) { session.lastRefused = true; this.notify(); return; }
    session.items = removeItem(session.items, index);
    this.touched(session);
  }

  /** Drag and drop (R14-01): the field from `from` takes the place `to`; it can become the first. */
  moveTranslation(from: number, to: number): void {
    const session = this.translations;
    if (!session || !this.translationsEditable()) return;
    const items = moveItem(session.items, from, to);
    if (items.every((item, index) => item === session.items[index])) return;
    session.items = items;
    this.touched(session);
  }

  /** «Выше» / «Ниже» for the keyboard and the screen reader (R14-01). */
  moveTranslationUp(index: number): void {
    const session = this.translations;
    if (!session || !this.translationsEditable() || index <= 0) return;
    session.items = moveUp(session.items, index);
    this.touched(session);
  }

  moveTranslationDown(index: number): void {
    const session = this.translations;
    if (!session || !this.translationsEditable() || index >= session.items.length - 1) return;
    session.items = moveDown(session.items, index);
    this.touched(session);
  }

  saveTranslations(): Promise<void> {
    const session = this.translations;
    if (!session || !this.canSaveTranslations(session)) return Promise.resolve();
    return this.start("translations", this.translationsIntent(session));
  }

  /** Conflict: keep my list and save it against the revision just reported (the server checks again). */
  keepMineTranslations(): Promise<void> {
    const session = this.translations;
    if (!session || session.phase !== "conflict" || this.entry || !this.contextId || hasBlank(session.items)) return Promise.resolve();
    return this.start("translations", this.translationsIntent(session));
  }

  /** Conflict: take the list saved elsewhere; my list is dropped only by this explicit choice. */
  acceptCurrentTranslations(): void {
    const session = this.translations;
    if (!session || session.phase !== "conflict") return;
    const texts = session.current.length > 0 ? session.current : [""];
    session.items = itemsOf(texts, () => this.newKey());
    session.original = [...texts];
    session.phase = "editing"; session.problem = null; session.lastRefused = false;
    this.notify();
  }

  /** After an unknown outcome the same command; after a refusal a new one with the same list. */
  retryTranslations(): Promise<void> {
    const session = this.translations, entry = this.entry;
    if (!session || session.phase !== "failed") return Promise.resolve();
    if (entry && entry.target === "translations") return entry.status === "unknown" && !entry.busy ? this.execute(entry) : Promise.resolve();
    return this.saveTranslations();
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
    if (entry && entry.target === name) return entry.status === "unknown" && !entry.busy ? this.execute(entry) : Promise.resolve();
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
      items: session.items.map(item => ({ ...item })), current: [...session.current], phase: session.phase,
      problem: session.problem ? { ...session.problem } : null, dirty: this.translationsDirty(session),
      blank: hasBlank(session.items), lastRefused: session.lastRefused, canEdit: this.translationsEditable(),
      canSave: this.canSaveTranslations(session),
      canRetry: session.phase === "failed" && (entry?.target === "translations" ? entry.status === "unknown" && !entry.busy
        : this.retryable(session.problem) && !hasBlank(session.items)),
      canCancel: !(entry?.busy ?? false), canRemove: canRemove(session.items),
      checking: entry?.target === "translations" && entry.busy,
      others: this.othersSnapshot(),
    } : null;
    const grammar = this.openEditor === "grammar" ? {
      fields: [...this.grammar.values()].map(field => ({
        name: field.name, draft: copyDraft(field.draft), original: copyDraft(field.original), current: copyDraft(field.current),
        phase: field.phase, problem: field.problem ? { ...field.problem } : null,
        dirty: !sameGrammar(field.name, field.draft, field.original), canEdit: this.grammarEditable(field),
        canSave: this.canSaveGrammar(field),
        canRetry: field.phase === "failed" && (entry?.target === field.name ? entry.status === "unknown" && !entry.busy
          : this.retryable(field.problem)),
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

  private othersSnapshot(): OtherLanguagesSnapshot {
    const others = this.others, language = this.source?.language;
    if (!others) return { status: "loading", languages: [] };
    const languages = others.status !== "ready" ? [] : commonLanguages.filter(item => item !== language).map(item => ({
      language: item, texts: [...(others.byLanguage[item] ?? [])], expanded: others.expanded.has(item) }));
    return { status: others.status, languages };
  }

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
    if (!reply || !current) others.status = "failed";
    else if (current.status !== "available" || current.language !== this.source.language) others.status = "unavailable";
    else { others.status = "ready"; others.byLanguage = structuredClone(current.translations); }
    this.notify();
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
  private translationsEditable(): boolean {
    // A conflict keeps its explicit choice («Взять сохранённое» / «Сохранить моё»); the list stays editable meanwhile.
    return this.openEditor === "translations" && this.entry === null && this.translations?.phase !== "saving";
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
    return this.contextId !== null && this.entry === null && this.openEditor === "translations"
      && (session.phase === "editing" || session.phase === "failed" && this.retryable(session.problem))
      && texts.length > 0 && !hasBlank(session.items) && !sameTexts(trimmed(texts), trimmed(session.original));
  }
  private canSaveGrammar(field: GrammarField): boolean {
    return this.contextId !== null && this.entry === null && this.openEditor === "grammar"
      && (field.phase === "editing" || field.phase === "saved" || field.phase === "failed" && this.retryable(field.problem))
      && !sameGrammar(field.name, field.draft, field.original);
  }
  private retryable(problem: OwnerProblem | null): boolean {
    return this.contextId !== null && this.entry === null && problem?.reason !== "unavailable" && problem?.reason !== "forbidden";
  }
  private unsaved(): boolean {
    if (this.openEditor === "translations" && this.translations) {
      const session = this.translations;
      return this.translationsDirty(session) || session.phase === "conflict" || this.entry !== null;
    }
    if (this.openEditor === "grammar") {
      return this.entry !== null || [...this.grammar.values()].some(field => field.phase === "conflict"
        || !sameGrammar(field.name, field.draft, field.original));
    }
    return false;
  }

  private translationsIntent(session: Translations): CommonSaveIntent {
    const source = this.source!;
    return copyCommonIntent({ kind: "field.save", command_id: this.options.newId(), context_id: this.contextId!,
      card_id: source.cardId, field_name: "translation", language: source.language, value: textsOf(session.items),
      expected_field_version: this.base ?? source.revision });
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
      reply = await this.options.port.send(command);
    } catch (error) {
      if (this.disposed || this.entry !== entry) return;
      entry.busy = false;
      if (commandOutcomeUnknown(error)) {
        entry.status = "unknown";
        this.mark(entry.target, "failed", { reason: "unknown" });
        this.notify();
        await this.check(entry);
        return;
      }
      // An HTTP refusal without a fact: nothing was saved.
      this.entry = null;
      const code = (error as { code?: string }).code;
      this.mark(entry.target, "failed", problemOf(code, null));
      this.notify();
      if (code && rereadCodes.has(code)) this.options.onChanged();
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
    let status: CommonCommandStatus;
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
      this.accepted(entry, status.current, status.state_version);
      return;
    }
    if (status.outcome === "not_found") { entry.notFound = true; this.notify(); return; }
    // Another payload under this ID: this intent can never be confirmed; a new command is needed.
    this.entry = null;
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
    if (entry.target === "translations") {
      // The editor closes after its save and leaves a note at the translation.
      if (this.openEditor === "translations") { this.close(); this.savedNote = true; }
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
