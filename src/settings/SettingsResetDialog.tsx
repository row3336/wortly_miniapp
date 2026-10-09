import { useEffect, useId, useRef } from "react";
import { useBackLayer } from "../app/navigationBack";
import type { Language } from "../i18n/language";
import { settingsCopy } from "./settingsCopy";

type Props = {
  language: Language;
  /** Whether a reset can be sent right now; the window stays open but cannot confirm otherwise. */
  canConfirm: boolean;
  onConfirm(): void;
  onCancel(): void;
};

/**
 * The confirmation before returning the initial settings (owner answer Q08): only the general blocks, never the eleven
 * fields. Built like the card's ActionDialog: role=dialog with its title, focus inside, and Escape or native Back
 * (overlay layer) close it without a command; focus returns to the opener on close.
 */
export function SettingsResetDialog({ language, canConfirm, onConfirm, onCancel }: Props) {
  const id = useId(), t = settingsCopy[language].reset;
  const cancel = useRef<HTMLButtonElement>(null);
  const close = useRef(onCancel); close.current = onCancel;
  useBackLayer("overlay", () => close.current());
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // The reversible choice takes the first focus, so a stray Enter does not reset.
    cancel.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  return <div className="settings-dialog-backdrop">
    <div className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-resets ${id}-kept`}
      onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); close.current(); } }}>
      <h2 id={`${id}-title`}>{t.title}</h2>
      <p id={`${id}-resets`}>{t.resets}</p>
      <p id={`${id}-kept`}>{t.kept}</p>
      <div className="settings-actions">
        <button type="button" className="settings-primary" disabled={!canConfirm} onClick={onConfirm}>{t.confirm}</button>
        <button type="button" className="settings-secondary" ref={cancel} onClick={() => close.current()}>{t.cancel}</button>
      </div>
    </div>
  </div>;
}
