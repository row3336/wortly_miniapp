import { useId } from "react";
import type { Language } from "../i18n/language";
import { dictionaryChoiceCopy, pairOrder } from "./dictionaryChoiceCopy";
import { problemText } from "./SettingsScreen";
import { settingsCopy } from "./settingsCopy";
import type { SettingsDocument } from "./useSettingsDocument";
import "./settings.css";
import "./dictionaryChoice.css";

type Props = {
  document: SettingsDocument;
  language: Language;
  /**
   * The language turned out to be chosen already (VERSION_CONFLICT, or a read showed a version above 1) while this
   * screen was shown: it names the current pair, sends nothing and «Продолжить» only leaves the screen.
   */
  settled: boolean;
  onLeave(): void;
};

/** И02 flags: German in every row, Ukrainian and British on their side, none for Russian. Decorative only. */
function Flag({ country }: { country: "de" | "ua" | "gb" }) {
  if (country === "de") return <svg className="choice-flag" viewBox="0 0 5 3" aria-hidden="true">
    <rect width="5" height="1" fill="#000" /><rect y="1" width="5" height="1" fill="#d00" /><rect y="2" width="5" height="1" fill="#ffce00" />
  </svg>;
  if (country === "ua") return <svg className="choice-flag" viewBox="0 0 3 2" aria-hidden="true">
    <rect width="3" height="1" fill="#0057b7" /><rect y="1" width="3" height="1" fill="#ffd700" />
  </svg>;
  return <svg className="choice-flag" viewBox="0 0 60 30" aria-hidden="true">
    <rect width="60" height="30" fill="#012169" />
    <path d="M0,0 L60,30 M60,0 L0,30" stroke="#fff" strokeWidth="6" />
    <path d="M0,0 L60,30 M60,0 L0,30" stroke="#c8102e" strokeWidth="2" />
    <path d="M30,0 V30 M0,15 H60" stroke="#fff" strokeWidth="10" />
    <path d="M30,0 V30 M0,15 H60" stroke="#c8102e" strokeWidth="6" />
  </svg>;
}
const sideFlag: Partial<Record<Language, "ua" | "gb">> = { uk: "ua", en: "gb" };

/**
 * The first choice of the dictionary language (М02, 25.1-А, 29.1-А), shown instead of Today until the choice is
 * confirmed. It has no sections and no Back of its own. Confirming is the ordinary Settings save of
 * `dictionary_language` (the same command, intent store and recovery as in Settings); an unknown outcome is checked and
 * retried under the same command id, never sent as a new one.
 */
export function DictionaryChoiceScreen({ document, language, settled, onLeave }: Props) {
  const t = dictionaryChoiceCopy[language], s = settingsCopy[language], title = useId();
  const { state, actions } = document;
  const field = state.data?.settings.dictionary_language ?? null;
  const pending = state.pending?.intent.payload.key === "dictionary_language" ? state.pending : null;
  const busy = ["loading", "checking", "sending"].includes(state.phase);
  const editable = !settled && !pending && state.canEdit && !busy;
  const allowed = field ? (state.data!.constraints.dictionary_language.values ?? []) : [];
  const draft = state.drafts.dictionary_language?.input;
  // What the screen marks: the current choice once settled, the sent one while it is unresolved, else the pick over the
  // proposed value (the interface language, И03). The pick is the settings draft of the field, kept by the document's
  // settings owner like any unsent edit, so a foreground re-read that hides this screen for a moment does not lose it.
  const marked = (settled ? field?.value : pending ? pending.intent.payload.value
    : typeof draft === "string" ? draft : field?.value) as Language | undefined;
  const outcome = state.outcome?.key === "dictionary_language" ? state.outcome : null;
  const confirm = () => {
    if (settled) { onLeave(); return; }
    if (!marked) return;
    actions.edit("dictionary_language", marked);
    void actions.save("dictionary_language");
  };

  return <main className="settings-screen choice-screen" lang={language}>
    <h1 id={title}>{t.title}</h1>
    <p>{t.question}</p>
    <div className="choice-pairs" role="radiogroup" aria-labelledby={title}>
      {pairOrder.map(item => <label key={item} className="choice-pair">
        <input type="radio" name={`${title}-pair`} value={item} checked={marked === item}
          disabled={!editable || !allowed.includes(item)} onChange={() => actions.edit("dictionary_language", item)} />
        <Flag country="de" /><span>{t.pairs[item]}</span>{sideFlag[item] && <Flag country={sideFlag[item]!} />}
      </label>)}
    </div>
    <div className="choice-status" aria-live="polite">
      {settled && field && <p role="status">{t.confirmed(t.pairs[field.value as Language])}</p>}
      {!settled && state.phase === "sending" && <p role="status">{s.saving}</p>}
      {!settled && pending && state.problem && !busy && <div className="settings-error" role="alert">
        <p>{problemText(state, language)}</p>
        <div className="settings-actions">
          {state.canRetry && <button type="button" className="settings-secondary" onClick={() => { void actions.retry(); }}>{s.retry}</button>}
          <button type="button" className="settings-secondary" onClick={() => { void actions.refresh(); }}>{s.refresh}</button>
        </div>
      </div>}
      {!settled && !pending && outcome?.status === "rejected" && <p className="settings-error" role="alert">{s.rejected}</p>}
    </div>
    <button type="button" className="settings-primary choice-proceed" disabled={!settled && (!editable || !marked)}
      onClick={confirm}>{t.proceed}</button>
    <p className="settings-help">{t.footnote}</p>
  </main>;
}
