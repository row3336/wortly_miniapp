import type { ReactNode } from "react";
import type { DictionaryCardView } from "../../api/generated";
import { StepBackButton, stepBackCopy } from "../../commands/StepBackButton";
import type { Language } from "../../i18n/language";
import { editorText, type EditorText } from "./editorCopy";
import { caseRoles, type FieldKey } from "./fieldEditorApi";
import { FieldEditor, FieldPencil } from "./FieldEditor";
import type { EditorSnapshot } from "./fieldEditorsController";
import type { FieldEditorsActions, FieldEditorsState } from "./useFieldEditors";
import { UnsavedLeaveDialog } from "./UnsavedLeaveDialog";
import "./fieldEditors.css";

/** What the card screen places at its fields: pencils, open editors, result notes, the translation undo, the leave question. */
export type CardFieldSlots = { translation: ReactNode; examples: ReactNode; association: ReactNode; leave: ReactNode };
type Props = { state: FieldEditorsState; actions: FieldEditorsActions; view: DictionaryCardView; language: Language };

/** The L1 of the card read: the language of its translation and association texts (as CardDescription). */
const dictionaryOf = (view: DictionaryCardView) => view.content.pair.slice(0, 2);

/** root decision, pending owner (M-EDIT Р8): after a save the field keeps a note of the result until the next editor. */
function savedNote(editor: EditorSnapshot | undefined, key: FieldKey, t: EditorText): ReactNode {
  if (editor?.phase !== "saved") return null;
  return <p role="status" className="field-note">{editor.saved === null ? t.removed[key] : t.saved}</p>;
}

/**
 * «Шаг назад» of the last translation save (CT 2.3, К05-071): only while the server's undo_target of that save is
 * current in this card. root decision, pending owner (M-EDIT Р10, В5): the shared «Шаг назад», not a text «Отменить».
 */
function TranslationUndo({ state, actions, language }: Omit<Props, "view">) {
  const undo = state.undo, t = editorText(language);
  if (!undo) return null;
  if (undo.status === "offered") return undo.canUndo ? <StepBackButton className="field-undo" language={language} onUndo={actions.undo} /> : null;
  if (undo.status === "undoing") return <p role="status" className="field-note">{t.undoing}</p>;
  if (undo.status === "unknown") return <div className="field-note">
    <p role="alert">{t.undoUnknown}</p>
    {undo.canRetry && <button type="button" onClick={actions.retryUndo}>{t.retry}</button>}
  </div>;
  return <p role="status" className="field-note">{stepBackCopy[language].unavailable}</p>;
}

function scalarSlot(key: "example" | "association", own: boolean, { state, actions, language, view }: Props): ReactNode {
  const t = editorText(language), editor = state.editors[key];
  if (state.open === key && editor) return <FieldEditor editor={editor} language={language} dictionaryLanguage={dictionaryOf(view)}
    actions={actions} withCancel />;
  return <div className="field-slot" lang={language}>
    <FieldPencil label={own ? t.edit[key] : t.add[key]} text={own ? undefined : t.add[key]} disabled={!state.canOpen}
      onOpen={() => actions.open(key)} />
    {savedNote(editor, key, t)}
  </div>;
}

/** root decision, pending owner (M-EDIT Р3, В2): two signed role fields, each saved by its own command, one shared cancel. */
function pairSlot(own: boolean, { state, actions, language, view }: Props): ReactNode {
  const t = editorText(language);
  if (state.open === "pair") {
    const busy = caseRoles.some(role => state.editors[role]?.canCancel === false);
    return <div className="field-pair" role="group" aria-label={t.pair}>
      <p className="field-editor-hint">{t.pairRule}</p>
      {caseRoles.map(role => {
        const editor = state.editors[role];
        return editor && <FieldEditor key={role} editor={editor} language={language} dictionaryLanguage={dictionaryOf(view)}
          actions={actions} withCancel={false} />;
      })}
      <div className="field-editor-actions">
        <button type="button" disabled={busy} onClick={actions.cancel}>{t.cancel}</button>
      </div>
    </div>;
  }
  return <div className="field-slot" lang={language}>
    <FieldPencil label={own ? t.edit.pair : t.add.pair} text={own ? undefined : t.add.pair} disabled={!state.canOpen}
      onOpen={() => actions.open("pair")} />
  </div>;
}

/**
 * The editors of one card М12 at their fields (TA §7, К07-027, К07-036…050, К07-121). root decision, pending owner
 * (M-EDIT Р1, Р2): an editor opens under its field, one at a time; the other pencils wait.
 */
export function cardFieldSlots(props: Props): CardFieldSlots {
  const { state, actions, view, language } = props, t = editorText(language), content = view.content;
  const translationEditor = state.editors.translation;
  const translation = state.open === "translation" && translationEditor
    ? <FieldEditor editor={translationEditor} language={language} dictionaryLanguage={dictionaryOf(view)} actions={actions}
      common={state.commonTranslations} withCancel />
    : <div className="field-slot" lang={language}>
      <FieldPencil label={t.edit.translation} disabled={!state.canOpen} onOpen={() => actions.open("translation")} />
      {savedNote(translationEditor, "translation", t)}
      <TranslationUndo state={state} actions={actions} language={language} />
    </div>;
  const pair = "preposition_pair" in content.examples ? content.examples.preposition_pair : null;
  const examples = pair ? pairSlot(caseRoles.some(role => pair.editor[role].value !== null), props)
    : scalarSlot("example", content.examples.personal !== null, props);
  const association = scalarSlot("association", content.association !== null, props);
  const leave = state.leaveAsked
    ? <UnsavedLeaveDialog language={language} onContinue={actions.continueEditing} onLeave={actions.confirmLeave} /> : null;
  return { translation, examples, association, leave };
}
