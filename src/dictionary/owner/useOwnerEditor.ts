import { useEffect, useInsertionEffect, useMemo, useReducer, useRef, useState } from "react";
import type { DictionaryCardView } from "../../api/generated";
import type { HttpOptions } from "../../api/http";
import { useBackLayer, useUnsavedFieldBack } from "../../app/navigationBack";
import { ClosedAccessError, type OpenedAccess } from "../../app/openedAccess";
import { createCommonFieldApi, grammarCardType, type CommonFieldApi, type CommonLanguage, type EditableGrammar, type GrammarFieldName } from "./commonFieldApi";
import {
  OwnerEditorController, type CommonSource, type GrammarDraft, type OwnerEditorPort, type OwnerEditorSnapshot,
} from "./ownerEditorController";

/**
 * The owner's common source of a card read; null for any other role (K07-030: a user never changes common data, and the
 * Mini App shows no common action to them). Grammar only of the types the owner edits (R12-05).
 */
export function commonSourceOf(view: DictionaryCardView, stateVersion: string, role: string): CommonSource | null {
  if (role !== "owner") return null;
  const content = view.content, type = content.card.type;
  return { cardId: content.card.id, cardType: type, language: content.pair.slice(0, 2) as CommonLanguage,
    revision: content.card.revision, stateVersion, translations: [...content.translations.common],
    grammar: grammarCardType(type) && content.grammar !== null ? { ...(content.grammar as EditableGrammar) } : null };
}

/**
 * Host obligations (as useFieldEditors):
 * - view/stateVersion: the shown card read; contextId: the open card context (a common save needs it);
 * - blocked: a personal editor is open or its command under way (one editor and one command at a time);
 * - onChanged: read the card and its context again; onLeave: the card's managed exit.
 */
export type OwnerEditorOptions = {
  access: OpenedAccess;
  transport: HttpOptions;
  enabled?: boolean;
  view: DictionaryCardView | null;
  stateVersion: string | null;
  contextId: string | null;
  blocked: boolean;
  newId?(): string;
  onChanged(): void;
  onLeave(): void;
};
export type OwnerEditorActions = {
  openTranslations(): void;
  openGrammar(): void;
  cancel(): void;
  /** `language`: another language's list under its badge (R17-02); left out, the dictionary's own. */
  editTranslation(index: number, text: string, language?: CommonLanguage): void;
  addTranslation(language?: CommonLanguage): void;
  removeTranslation(index: number, language?: CommonLanguage): void;
  moveTranslation(from: number, to: number, language?: CommonLanguage): void;
  moveTranslationUp(index: number, language?: CommonLanguage): void;
  moveTranslationDown(index: number, language?: CommonLanguage): void;
  saveTranslations(language?: CommonLanguage): void;
  keepMineTranslations(language?: CommonLanguage): void;
  acceptCurrentTranslations(language?: CommonLanguage): void;
  retryTranslations(language?: CommonLanguage): void;
  /** R12-04: open or fold one other language under its badge; repeat a failed read of them. */
  toggleLanguage(language: CommonLanguage): void;
  retryOthers(): void;
  editGrammar(name: GrammarFieldName, draft: GrammarDraft): void;
  saveGrammar(name: GrammarFieldName): void;
  keepMineGrammar(name: GrammarFieldName): void;
  acceptCurrentGrammar(name: GrammarFieldName): void;
  retryGrammar(name: GrammarFieldName): void;
  /** Screen Back: asks first while a common change is unsaved, otherwise false (the caller continues its own exit). */
  guardLeave(): boolean;
  continueEditing(): void;
  confirmLeave(): void;
};
export type OwnerEditorState = OwnerEditorSnapshot & { leaveAsked: boolean };

function documentKey(access: OpenedAccess): string {
  return JSON.stringify([access.profile.profile_id, access.document.clientInstanceId, access.document.documentId,
    access.document.epoch]);
}

/** Every request through the access handle current at its start; an obsolete handle fails before it can deny access. */
function accessPort(latest: { current: OwnerEditorOptions }, api: () => CommonFieldApi): OwnerEditorPort {
  const bound = <T>(operation: (api: CommonFieldApi, token: string, proof: string) => Promise<T>): Promise<T> => {
    const access = latest.current.access;
    const requireCurrent = () => { if (latest.current.access !== access) throw new ClosedAccessError(); };
    return access.run(async ({ token, proof }) => {
      requireCurrent();
      try {
        const result = await operation(api(), token, proof);
        requireCurrent();
        return result;
      } catch (error) {
        requireCurrent();
        throw error;
      }
    });
  };
  return {
    origin() {
      const access = latest.current.access;
      return access.isLive() && access.profile.access.status === "admitted"
        ? { client_instance_id: access.document.clientInstanceId, document_id: access.document.documentId } : null;
    },
    send: command => bound((api, token, proof) => api.send(token, proof, command)),
    status: (command, ticket) => bound((api, token, proof) => api.status(token, proof, command, ticket)),
    readTranslations: cardId => bound((api, token) => api.readTranslations(token, cardId)),
  };
}

function oneLanguage(value: unknown): CommonLanguage | null {
  return value === "ru" || value === "uk" || value === "en" ? value : null;
}

/** A button handler passes its click event where a language may stand: only a language names another list (R17-02). */
function languageArg(value: unknown): CommonLanguage | undefined {
  return typeof value === "string" ? value as CommonLanguage : undefined;
}

/** The owner's common editors of one open card (R12-04…06, R14-01). One controller per mounted card host; memory only. */
export function useOwnerEditor(options: OwnerEditorOptions): { state: OwnerEditorState; actions: OwnerEditorActions } {
  const latest = useRef(options);
  useInsertionEffect(() => { latest.current = options; });
  const [, repaint] = useReducer((value: number) => value + 1, 0);
  // A translation save's current shows the profile's dictionary language (R17-02: whatever language was saved).
  const api = useMemo(() => createCommonFieldApi(options.transport,
    () => oneLanguage(latest.current.access.profile.dictionary_language)), [options.transport]);
  const currentApi = useRef(api); currentApi.current = api;
  // Mounted, not disposed: StrictMode's synchronous unmount and remount must keep the same editors and texts.
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const owner = useRef<OwnerEditorController | null>(null);
  if (owner.current === null) {
    const port = accessPort(latest, () => currentApi.current);
    owner.current = new OwnerEditorController({
      port: { ...port, origin: () => mounted.current ? port.origin() : null },
      newId: () => latest.current.newId?.() ?? window.crypto.randomUUID(),
      onUpdate: () => { if (mounted.current) repaint(); },
      onChanged: () => { if (mounted.current) latest.current.onChanged(); },
      gate: options.transport.gate,
    });
  }
  const controller = owner.current;

  const documentId = documentKey(options.access);
  useEffect(() => { void controller.resume(); }, [controller, documentId, options.access]);

  const role = options.access.profile.role;
  // The card read is a fresh copy on every render: its common data, not its identity, is the input.
  const source = options.view !== null && options.stateVersion !== null
    ? JSON.stringify(commonSourceOf(options.view, options.stateVersion, role)) : JSON.stringify(null);
  useEffect(() => { controller.setCard(JSON.parse(source) as CommonSource | null); }, [controller, source]);
  useEffect(() => { controller.setContext(options.contextId); }, [controller, options.contextId]);
  useEffect(() => { controller.setBlocked(options.blocked); }, [controller, options.blocked]);

  const [leaveAsked, setLeaveAsked] = useState(false);
  const snapshot = controller.snapshot();
  const unsaved = snapshot.unsaved && options.enabled !== false;
  useEffect(() => { if (!unsaved) setLeaveAsked(false); }, [unsaved]);
  useBackLayer("overlay", leaveAsked ? () => setLeaveAsked(false) : null);
  useUnsavedFieldBack(unsaved && !leaveAsked ? () => setLeaveAsked(true) : null);

  const actions = useMemo<OwnerEditorActions>(() => ({
    openTranslations: () => controller.openTranslations(),
    openGrammar: () => controller.openGrammar(),
    cancel: () => controller.cancel(),
    editTranslation: (index, text, language) => controller.editTranslation(index, text, languageArg(language)),
    addTranslation: language => controller.addTranslation(languageArg(language)),
    removeTranslation: (index, language) => controller.removeTranslation(index, languageArg(language)),
    moveTranslation: (from, to, language) => controller.moveTranslation(from, to, languageArg(language)),
    moveTranslationUp: (index, language) => controller.moveTranslationUp(index, languageArg(language)),
    moveTranslationDown: (index, language) => controller.moveTranslationDown(index, languageArg(language)),
    saveTranslations: language => { void controller.saveTranslations(languageArg(language)); },
    keepMineTranslations: language => { void controller.keepMineTranslations(languageArg(language)); },
    acceptCurrentTranslations: language => controller.acceptCurrentTranslations(languageArg(language)),
    retryTranslations: language => { void controller.retryTranslations(languageArg(language)); },
    toggleLanguage: language => controller.toggleLanguage(language),
    retryOthers: () => { void controller.retryOthers(); },
    editGrammar: (name, draft) => controller.editGrammar(name, draft),
    saveGrammar: name => { void controller.saveGrammar(name); },
    keepMineGrammar: name => { void controller.keepMineGrammar(name); },
    acceptCurrentGrammar: name => controller.acceptCurrentGrammar(name),
    retryGrammar: name => { void controller.retryGrammar(name); },
    guardLeave: () => {
      if (controller.snapshot().unsaved && latest.current.enabled !== false) { setLeaveAsked(true); return true; }
      return false;
    },
    continueEditing: () => setLeaveAsked(false),
    confirmLeave: () => { setLeaveAsked(false); latest.current.onLeave(); },
  }), [controller]);

  return { state: { ...snapshot, leaveAsked: leaveAsked && unsaved }, actions };
}
