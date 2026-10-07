import { useEffect, useId, useRef } from "react";
import type { Language } from "../../i18n/language";
import { editorText } from "./editorCopy";

type Props = { language: Language; onContinue(): void; onLeave(): void };

/**
 * RA table 6.1.12 «Несохранённая правка»: a window over the screen with «Продолжить редактирование» / «Выйти без
 * сохранения» (К07-039, Т31). Focus goes to the first choice and returns to the field on close; Escape continues editing,
 * as native Back does (overlay layer, useFieldEditors).
 */
export function UnsavedLeaveDialog({ language, onContinue, onLeave }: Props) {
  const t = editorText(language), id = useId(), first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    first.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  return <div className="field-leave-backdrop">
    <div className="field-leave" role="dialog" aria-modal="true" aria-labelledby={`${id}-question`}
      onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); onContinue(); } }}>
      <p id={`${id}-question`}>{t.leaveQuestion}</p>
      <div className="field-editor-actions">
        <button ref={first} type="button" onClick={onContinue}>{t.continue}</button>
        <button type="button" onClick={onLeave}>{t.leave}</button>
      </div>
    </div>
  </div>;
}
