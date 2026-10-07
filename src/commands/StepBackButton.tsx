import type { Language } from "../i18n/language";

/** Working copies until G05, which also chooses the final icon (К05-068, К05-069). */
export const stepBackCopy = {
  ru: { label: "Шаг назад", pending: "Отменяем ответ…", unavailable: "Шаг назад больше недоступен." },
  uk: { label: "Крок назад", pending: "Скасовуємо відповідь…", unavailable: "Крок назад більше недоступний." },
  en: { label: "Step back", pending: "Undoing the answer…", unavailable: "Step back is no longer available." },
} as const;

type Props = { className: string; language: Language; onUndo(): void };

/**
 * «Шаг назад» (К05-067): an icon action. The caller renders it only while the server grants undo_target for the answer
 * on screen; the glyph is a placeholder until G05, so the accessible name carries the meaning.
 */
export function StepBackButton({ className, language, onUndo }: Props) {
  const label = stepBackCopy[language].label;
  return <button type="button" className={className} aria-label={label} title={label} onClick={onUndo}>
    <span aria-hidden="true">↶</span>
  </button>;
}
