import { useEffect, useInsertionEffect, useMemo, useReducer, useRef, useState } from "react";
import type { DictionaryCardView } from "../../api/generated";
import type { HttpOptions } from "../../api/http";
import { useBackLayer, useUnsavedFieldBack } from "../../app/navigationBack";
import { ClosedAccessError, type OpenedAccess } from "../../app/openedAccess";
import { createFieldEditorApi, type FieldEditorApi, type FieldKey, type FieldLanguage } from "./fieldEditorApi";
import {
  FieldEditorsController, type CardFields, type FieldEditorsPort, type FieldEditorsSnapshot, type FieldGroup,
} from "./fieldEditorsController";

/**
 * The own fields a card view offers to its editors (C-FIELDS-1 §5а, C-FIELDS-2 §6). A two-case preposition edits its
 * case-role pair instead of the scalar example (root decision, pending owner — M-EDIT Р11, C-FIELDS-2 В3).
 */
export function cardFieldsOf(view: DictionaryCardView, stateVersion: string): CardFields {
  const content = view.content, versions = content.field_versions;
  const fields: CardFields["fields"] = {
    translation: { value: content.translations.personal?.value ?? null, version: versions.translation },
    association: { value: content.association?.value ?? null, version: versions.association },
  };
  if ("preposition_pair" in content.examples) {
    const editor = content.examples.preposition_pair.editor;
    fields.akkusativ = { value: editor.akkusativ.value, version: editor.akkusativ.version };
    fields.dativ = { value: editor.dativ.value, version: editor.dativ.version };
  } else fields.example = { value: content.examples.personal?.value ?? null, version: versions.example };
  return { cardId: content.card.id, language: content.pair.slice(0, 2) as FieldLanguage, stateVersion, fields,
    commonTranslations: [...content.translations.common] };
}

/**
 * Host obligations:
 * - pass the opened access of this document; a foreground gives a new handle, which continues the same editors;
 * - view/stateVersion: the shown card read; contextId: the open card context (pencils need it);
 * - onChanged: read the card and its context again (an accepted field command also ends the interval undo, CT 2.3);
 * - onLeave: the card's managed exit; the screen Back calls actions.requestLeave instead of it.
 */
export type FieldEditorsOptions = {
  access: OpenedAccess;
  transport: HttpOptions;
  /** false for a card host that is only leaving (M-CARD В6): it shows nothing and must not hold native Back. */
  enabled?: boolean;
  view: DictionaryCardView | null;
  stateVersion: string | null;
  contextId: string | null;
  /** state_version of the shown card context; a newer one may mean another action (Р10). */
  contextStateVersion?: string | null;
  newId?(): string;
  onChanged(): void;
  onLeave(): void;
};
export type FieldEditorsActions = {
  open(group: FieldGroup): void;
  edit(key: FieldKey, text: string): void;
  substitute(): void;
  save(key: FieldKey): void;
  keepMine(key: FieldKey): void;
  acceptCurrent(key: FieldKey): void;
  retry(key: FieldKey): void;
  cancel(): void;
  undo(): void;
  retryUndo(): void;
  /** Screen Back: asks first while text is unsaved (К07-039), otherwise leaves. */
  requestLeave(): void;
  continueEditing(): void;
  confirmLeave(): void;
};
export type FieldEditorsState = FieldEditorsSnapshot & { leaveAsked: boolean };

function documentKey(access: OpenedAccess): string {
  return JSON.stringify([access.profile.profile_id, access.document.clientInstanceId, access.document.documentId,
    access.document.epoch]);
}

/** Every request through the access handle current at its start; an obsolete handle fails before it can deny access. */
function accessPort(latest: { current: FieldEditorsOptions }, api: () => FieldEditorApi): FieldEditorsPort {
  const bound = <T>(operation: (api: FieldEditorApi, token: string, proof: string) => Promise<T>): Promise<T> => {
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
    status: command => bound((api, token, proof) => api.status(token, proof, command)),
  };
}

/** The own-field editors of one open card (TA §7). One controller per mounted card host; memory only. */
export function useFieldEditors(options: FieldEditorsOptions): { state: FieldEditorsState; actions: FieldEditorsActions } {
  const latest = useRef(options);
  useInsertionEffect(() => { latest.current = options; });
  const [, repaint] = useReducer((value: number) => value + 1, 0);
  const api = useMemo(() => createFieldEditorApi(options.transport), [options.transport]);
  const currentApi = useRef(api); currentApi.current = api;
  // Mounted, not disposed: StrictMode's synchronous unmount and remount must keep the same editors and texts.
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const owner = useRef<FieldEditorsController | null>(null);
  if (owner.current === null) {
    const port = accessPort(latest, () => currentApi.current);
    owner.current = new FieldEditorsController({
      // An unmounted card sends nothing more; a reply already under way only updates memory nobody shows.
      port: { ...port, origin: () => mounted.current ? port.origin() : null },
      newId: () => latest.current.newId?.() ?? window.crypto.randomUUID(),
      onUpdate: () => { if (mounted.current) repaint(); },
      onChanged: () => { if (mounted.current) latest.current.onChanged(); },
    });
  }
  const controller = owner.current;

  const documentId = documentKey(options.access);
  const seenDocument = useRef(documentId);
  useEffect(() => {
    if (seenDocument.current !== documentId) { seenDocument.current = documentId; controller.resetDocument(); }
    else void controller.resume();
  }, [controller, documentId, options.access]);

  // The card read is a fresh copy on every render (structuredClone): its fields, not its identity, are the input.
  const fields = options.view !== null && options.stateVersion !== null ? JSON.stringify(cardFieldsOf(options.view, options.stateVersion)) : null;
  useEffect(() => { if (fields !== null) controller.setCard(JSON.parse(fields) as CardFields); }, [controller, fields]);
  useEffect(() => { controller.setContext(options.contextId); }, [controller, options.contextId]);
  useEffect(() => { controller.observe(options.contextStateVersion); }, [controller, options.contextStateVersion]);

  const [leaveAsked, setLeaveAsked] = useState(false);
  const snapshot = controller.snapshot();
  const unsaved = snapshot.unsaved && options.enabled !== false;
  useEffect(() => { if (!unsaved) setLeaveAsked(false); }, [unsaved]);
  // Native Back: the confirmation layer first, then the unsaved guard, then the card's own exit (TA:86, Т31).
  useBackLayer("overlay", leaveAsked ? () => setLeaveAsked(false) : null);
  useUnsavedFieldBack(unsaved && !leaveAsked ? () => setLeaveAsked(true) : null);

  const actions = useMemo<FieldEditorsActions>(() => ({
    open: group => controller.open(group),
    edit: (key, text) => controller.edit(key, text),
    substitute: () => controller.substitute(),
    save: key => { void controller.save(key); },
    keepMine: key => { void controller.keepMine(key); },
    acceptCurrent: key => controller.acceptCurrent(key),
    retry: key => { void controller.retry(key); },
    cancel: () => controller.cancel(),
    undo: () => { void controller.undo(); },
    retryUndo: () => { void controller.retryUndo(); },
    requestLeave: () => {
      if (controller.snapshot().unsaved && latest.current.enabled !== false) setLeaveAsked(true);
      else latest.current.onLeave();
    },
    continueEditing: () => setLeaveAsked(false),
    confirmLeave: () => { setLeaveAsked(false); latest.current.onLeave(); },
  }), [controller]);

  return { state: { ...snapshot, leaveAsked: leaveAsked && unsaved }, actions };
}
