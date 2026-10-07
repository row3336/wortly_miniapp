import { useId } from "react";
import type { Language } from "../../i18n/language";
import { editorText } from "./editorCopy";
import type { FieldKey } from "./fieldEditorApi";
import type { EditorSnapshot } from "./fieldEditorsController";
import type { FieldEditorsActions } from "./useFieldEditors";

type PencilProps = { label: string; text?: string; disabled: boolean; onOpen(): void };

/**
 * К07-046: rights are marked by a pencil at the field; without an own example or association the control says
 * «Добавить …» (К07-045). The glyph is a placeholder until G05, so the accessible name carries the meaning.
 */
export function FieldPencil({ label, text, disabled, onOpen }: PencilProps) {
  return <button type="button" className={text ? "field-add" : "field-pencil"} aria-label={label} title={label}
    disabled={disabled} onClick={onOpen}>
    {text ?? <span aria-hidden="true">✎</span>}
  </button>;
}

type EditorProps = {
  editor: EditorSnapshot;
  language: Language;
  /** The dictionary L1: the language of a typed translation or association; examples are German. */
  dictionaryLanguage: string;
  actions: FieldEditorsActions;
  /** Translation only: all common translations, shown separately and offered for substitution (К07-025, К07-036). */
  common?: string[];
  /** The pair shares one cancel for both roles (M-EDIT Р3). */
  withCancel: boolean;
};

/** The hint for the current text: what saving it would do (root decision, pending owner — M-EDIT Р9). */
function hint(editor: EditorSnapshot, common: string[] | undefined, t: ReturnType<typeof editorText>): string | null {
  if (!editor.dirty) return null;
  const text = editor.draft.trim();
  if (text === "") return editor.original.trim() === "" ? null : t.clear[editor.key];
  // The server compares without edge spaces (C-FIELDS-1 §12 В2); it alone decides, this only explains.
  return editor.key === "translation" && common && common.length > 0 && text === common.join(", ") ? t.sameAsCommon : null;
}

function problemText(editor: EditorSnapshot, t: ReturnType<typeof editorText>): string | null {
  if (editor.phase !== "failed" || !editor.problem) return null;
  if (editor.checking) return t.checking;
  return editor.problem.reason === "unknown" ? t.unknown : editor.problem.reason === "unavailable" ? t.unavailable
    : editor.problem.reason === "mismatch" ? t.mismatch : t.failed;
}

/**
 * One own field (TA §7): editing → saving → saved | failed | conflict. While saving the field and Save are locked
 * (К07-048); a failure keeps the text with «Повторить» (К07-050); a conflict shows the value saved elsewhere and asks
 * (К11-008…012). The text goes as typed; the server trims and treats blank as removal.
 */
export function FieldEditor({ editor, language, dictionaryLanguage, actions, common, withCancel }: EditorProps) {
  const t = editorText(language), id = useId(), key: FieldKey = editor.key;
  const note = hint(editor, common, t), problem = problemText(editor, t);
  const saving = editor.phase === "saving";
  return <div className="field-editor" data-phase={editor.phase} lang={language}>
    <label className="field-editor-label" htmlFor={`${id}-text`}>{t.label[key]}</label>
    <textarea id={`${id}-text`} className="field-editor-text" rows={2} value={editor.draft} readOnly={!editor.canEdit}
      lang={key === "translation" || key === "association" ? dictionaryLanguage : "de"} aria-describedby={`${id}-notes`}
      onChange={event => actions.edit(key, event.target.value)} />
    <div id={`${id}-notes`} className="field-editor-notes">
      {common && <p className="field-editor-common">{common.length > 0 ? `${t.common}: ${common.join(", ")}` : t.noCommon}</p>}
      {note && <p className="field-editor-hint">{note}</p>}
      {saving && <p role="status">{t.saving}</p>}
      {editor.phase === "saved" && <p role="status">{editor.saved === null ? t.removed[key] : t.saved}</p>}
      {problem && <p role="alert" className="field-editor-problem">{problem}</p>}
      {editor.phase === "conflict" && <div role="alert" className="field-editor-conflict">
        <p>{t.conflict}</p>
        <p>{editor.current.value === null ? t.currentNone : t.currentValue(editor.current.value)}</p>
      </div>}
    </div>
    <div className="field-editor-actions">
      {common && common.length > 0 && <button type="button" disabled={!editor.canEdit} onClick={actions.substitute}>{t.substitute}</button>}
      {editor.phase === "conflict" ? <>
        <button type="button" onClick={() => actions.acceptCurrent(key)}>{t.accept}</button>
        <button type="button" onClick={() => actions.keepMine(key)}>{t.keep}</button>
      </> : editor.phase === "failed"
        ? editor.canRetry && <button type="button" onClick={() => actions.retry(key)}>{t.retry}</button>
        : <button type="button" disabled={!editor.canSave} aria-label={key === "akkusativ" || key === "dativ" ? `${t.save} ${t.label[key]}` : undefined}
          onClick={() => actions.save(key)}>{t.save}</button>}
      {withCancel && <button type="button" disabled={!editor.canCancel} onClick={actions.cancel}>{t.cancel}</button>}
    </div>
  </div>;
}
