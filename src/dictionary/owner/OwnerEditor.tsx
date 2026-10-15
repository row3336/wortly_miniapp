import { useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Language } from "../../i18n/language";
import type { CommonLanguage, GrammarFieldName } from "./commonFieldApi";
import { ownerText, type OwnerText } from "./ownerCopy";
import type {
  GrammarDraft, GrammarFieldSnapshot, OtherLanguagesSnapshot, OwnerPhase, OwnerProblem, TranslationListSnapshot,
  TranslationsSnapshot,
} from "./ownerEditorController";
import { useTranslationDrag } from "./useTranslationDrag";
import type { OwnerEditorActions, OwnerEditorState } from "./useOwnerEditor";
import "./ownerEditor.css";

type Props = { state: OwnerEditorState; actions: OwnerEditorActions; language: Language; dictionaryLanguage: CommonLanguage };

function problemText(phase: OwnerPhase, problem: OwnerProblem | null, checking: boolean, t: OwnerText): string | null {
  if (phase !== "failed" || !problem) return null;
  if (checking) return t.checking;
  return problem.reason === "unknown" ? t.unknown : problem.reason === "unavailable" ? t.unavailable
    : problem.reason === "mismatch" ? t.mismatch : problem.reason === "forbidden" ? t.forbidden
      : problem.reason === "paused" ? t.paused
      : problem.reason === "invalid" ? t.invalid : t.failed;
}

/**
 * The owner's common data at the card's translation (R12-04…06, R14-01): «Изменить перевод для всех» and «Изменить
 * грамматику для всех», next to the personal pencil and separate from it. A user never sees them (K07-030); there is no
 * echo in the Mini App. root decision, pending owner: both entries sit under the translation, one editor at a time.
 */
export function OwnerCommonSlot({ state, actions, language, dictionaryLanguage }: Props): ReactNode {
  const t = ownerText(language);
  if (!state.available) return null;
  if (state.open === "translations" && state.translations) {
    return <TranslationsEditor editor={state.translations} actions={actions} language={language} dictionaryLanguage={dictionaryLanguage} />;
  }
  if (state.open === "grammar" && state.grammar) {
    return <GrammarEditor fields={state.grammar.fields} canCancel={state.grammar.canCancel} actions={actions} language={language} />;
  }
  return <div className="owner-entry" lang={language}>
    <button type="button" className="owner-open" disabled={!state.canOpen} onClick={actions.openTranslations}>{t.openTranslations}</button>
    {state.grammarAvailable && <button type="button" className="owner-open" disabled={!state.canOpen} onClick={actions.openGrammar}>
      {t.openGrammar}</button>}
    {state.savedNote && <p role="status" className="owner-note">{t.saved}</p>}
  </div>;
}

/** Where the focus goes after a change of the list: a move control of a moved field, or a field itself (after «+» / ✕). */
type Focus = { key: string; control: "up" | "down" } | { field: number } | { field: "last" };

/** The changes of one language's list (the dictionary's own, or another one under its badge: R17-02). */
type ListActions = {
  edit(index: number, text: string): void;
  add(): void;
  remove(index: number): void;
  move(from: number, to: number): void;
  up(index: number): void;
  down(index: number): void;
};

function listActions(actions: OwnerEditorActions, language?: CommonLanguage): ListActions {
  return {
    edit: (index, text) => actions.editTranslation(index, text, language),
    add: () => actions.addTranslation(language),
    remove: index => actions.removeTranslation(index, language),
    move: (from, to) => actions.moveTranslation(from, to, language),
    up: index => actions.moveTranslationUp(index, language),
    down: index => actions.moveTranslationDown(index, language),
  };
}

/**
 * One language's fields (R14-01): a field per translation, a long press drags it, «Выше» / «Ниже» for the keyboard and the
 * screen reader, ✕ removes (never the last: R12-06), «+» adds. The same for the dictionary's language and, under an
 * opened badge, for every other one (R17-02, П5-026).
 */
function TranslationFields({ editor, actions, t, textLanguage, hintId, lastId }: {
  editor: TranslationListSnapshot; actions: ListActions; t: OwnerText; textLanguage: CommonLanguage; hintId: string; lastId: string;
}) {
  const items = editor.items;
  const [announcement, setAnnouncement] = useState("");
  const focus = useRef<Focus | null>(null);
  const controls = useRef(new Map<string, HTMLButtonElement>());
  const fieldsRef = useRef<HTMLOListElement>(null);
  const drag = useTranslationDrag({ count: items.length, enabled: editor.canEdit,
    onDrop: (from, to) => {
      const moved = items[from];
      actions.move(from, to);
      if (moved) setAnnouncement(t.moved(moved.text.trim(), to + 1, items.length));
    } });
  // After «Выше» / «Ниже» the focus stays on the moved field's control (the other one at the list's edge).
  useLayoutEffect(() => {
    const wanted = focus.current;
    if (!wanted) return;
    focus.current = null;
    if ("field" in wanted) {
      // WCAG 2.4.3: after ✕ the neighbour field (the next one, or the previous at the end); after «+» the new field.
      const inputs = fieldsRef.current?.querySelectorAll<HTMLInputElement>(".owner-translation-text") ?? [];
      const target = wanted.field === "last" ? inputs.length - 1 : Math.min(wanted.field, inputs.length - 1);
      inputs[target]?.focus();
      return;
    }
    const index = items.findIndex(item => item.key === wanted.key);
    const control = wanted.control === "up" && index === 0 ? "down" : wanted.control === "down" && index === items.length - 1 ? "up" : wanted.control;
    controls.current.get(`${wanted.key}:${control}`)?.focus();
  });
  const move = (index: number, control: "up" | "down") => {
    const item = items[index], to = control === "up" ? index - 1 : index + 1;
    if (!item || to < 0 || to >= items.length) return;
    focus.current = { key: item.key, control };
    if (control === "up") actions.up(index); else actions.down(index);
    setAnnouncement(t.moved(item.text.trim(), to + 1, items.length));
  };
  return <>
    <ol ref={fieldsRef} className="owner-translation-list" aria-describedby={hintId} data-dragging={drag.drag ? "true" : undefined}>
      {items.map((item, index) => {
        const handlers = drag.handlers(index, item.key), text = item.text.trim();
        const picked = drag.drag?.from === index;
        return <li key={item.key} ref={element => drag.register(index, element)} className="owner-translation"
          data-picked={picked ? "true" : undefined} style={drag.styleOf(index, item.key)}
          onPointerDown={event => { if (!(event.target as Element).closest("button")) handlers.onPointerDown(event); }}
          onContextMenu={handlers.onContextMenu}>
          <input className="owner-translation-text" value={item.text} readOnly={!editor.canEdit} lang={textLanguage}
            aria-label={t.field(index + 1)} onChange={event => actions.edit(index, event.target.value)} />
          <button type="button" className="owner-move" ref={element => { if (element) controls.current.set(`${item.key}:up`, element); else controls.current.delete(`${item.key}:up`); }}
            aria-label={t.upLabel(text, index + 1)} disabled={!editor.canEdit || index === 0} onClick={() => move(index, "up")}>
            <span aria-hidden="true">↑</span><span className="owner-move-text">{t.up}</span>
          </button>
          <button type="button" className="owner-move" ref={element => { if (element) controls.current.set(`${item.key}:down`, element); else controls.current.delete(`${item.key}:down`); }}
            aria-label={t.downLabel(text, index + 1)} disabled={!editor.canEdit || index === items.length - 1} onClick={() => move(index, "down")}>
            <span aria-hidden="true">↓</span><span className="owner-move-text">{t.down}</span>
          </button>
          {/* R12-06: the cross of the last field stays reachable and explains the refusal instead of removing. */}
          <button type="button" className="owner-remove" aria-label={t.removeLabel(text, index + 1)} disabled={!editor.canEdit}
            aria-disabled={editor.canRemove ? undefined : "true"} aria-describedby={editor.lastRefused ? lastId : undefined}
            onClick={() => {
              // A refused removal of the last field keeps the focus on its cross, next to the explanation.
              if (editor.canRemove) focus.current = { field: index };
              actions.remove(index);
            }}><span aria-hidden="true">✕</span></button>
        </li>;
      })}
    </ol>
    <button type="button" className="owner-add" aria-label={t.add} title={t.add} disabled={!editor.canEdit}
      onClick={() => { focus.current = { field: "last" }; actions.add(); }}><span aria-hidden="true">+</span></button>
    <p className="owner-live" aria-live="polite">{announcement}</p>
  </>;
}

/** The notes of one language's list: the last field, a blank field, the save under way or done, a problem, a conflict. */
function ListNotes({ editor, t, lastId, refresh = "idle" }: {
  editor: TranslationListSnapshot; t: OwnerText; lastId: string; refresh?: OtherLanguagesSnapshot["refresh"];
}) {
  const problem = problemText(editor.phase, editor.problem, editor.checking, t);
  return <div className="owner-notes">
    {editor.lastRefused && <p id={lastId} role="alert" className="owner-problem">{t.lastRefused}</p>}
    {editor.blank && <p className="owner-hint">{t.blank}</p>}
    {editor.phase === "saving" && <p role="status">{t.saving}</p>}
    {editor.phase === "saved" && <p role="status">{t.fieldSaved}</p>}
    {problem && <p role="alert" className="owner-problem">{problem}</p>}
    {editor.phase === "conflict" && <div role="alert" className="owner-conflict">
      {/* C333/A-1: the list saved elsewhere is shown only once read; a failed read offers only its repetition. */}
      <p>{t.conflict}</p>{!editor.reading ? <p>{t.currentList(editor.current)}</p>
        : <p>{refresh === "loading" ? t.othersLoading : refresh === "unavailable" ? t.othersUnavailable : t.othersFailed}</p>}
    </div>}
  </div>;
}

function TranslationsEditor({ editor, actions, language, dictionaryLanguage }: {
  editor: TranslationsSnapshot; actions: OwnerEditorActions; language: Language; dictionaryLanguage: CommonLanguage;
}) {
  const t = ownerText(language), id = useId();
  const own = useMemo(() => listActions(actions), [actions]);
  return <section className="owner-editor" aria-labelledby={`${id}-title`} lang={language} data-phase={editor.phase}>
    <h3 id={`${id}-title`} className="owner-title">{t.translationsTitle(t.languages[dictionaryLanguage])}</h3>
    <p id={`${id}-hint`} className="owner-hint">{t.dragHint}</p>
    <TranslationFields editor={editor} actions={own} t={t} textLanguage={dictionaryLanguage} hintId={`${id}-hint`} lastId={`${id}-last`} />
    <OtherLanguages others={editor.others} actions={actions} t={t} hintId={`${id}-hint`} />
    <ListNotes editor={editor} t={t} lastId={`${id}-last`} />
    <div className="owner-actions">
      {editor.phase === "conflict" ? <>
        <button type="button" onClick={() => actions.acceptCurrentTranslations()}>{t.accept}</button>
        <button type="button" disabled={editor.blank} onClick={() => actions.keepMineTranslations()}>{t.keep}</button>
      </> : editor.phase === "failed" && (editor.canRetry || editor.checking)
        ? <button type="button" disabled={!editor.canRetry} onClick={() => actions.retryTranslations()}>{t.retry}</button>
        : <button type="button" disabled={!editor.canSave} onClick={() => actions.saveTranslations()}>{t.save}</button>}
      <button type="button" disabled={!editor.canCancel} onClick={actions.cancel}>{t.cancel}</button>
    </div>
  </section>;
}

/**
 * R12-04: the dictionary's language is open; every other language is folded under a badge and opens on a tap, on the same
 * screen. R17-02 (вар.1, П5-026, К19-059): an opened badge edits that language in place with the same fields, saved with
 * its own language; the same rights as the bot's editor (R12-05).
 */
function OtherLanguages({ others, actions, t, hintId }: {
  others: OtherLanguagesSnapshot; actions: OwnerEditorActions; t: OwnerText; hintId: string;
}) {
  const id = useId();
  let body: ReactNode;
  if (others.status === "loading") body = <p role="status" className="owner-hint">{t.othersLoading}</p>;
  else if (others.status === "failed") body = <div className="owner-notes">
    <p role="alert" className="owner-problem">{t.othersFailed}</p>
    <div className="owner-actions"><button type="button" onClick={actions.retryOthers}>{t.retry}</button></div>
  </div>;
  else if (others.status === "unavailable") body = <p className="owner-hint">{t.othersUnavailable}</p>;
  else body = <>
    <ul className="owner-other-list">{others.languages.map(({ language, texts, expanded, editor }) => {
      const panel = `${id}-${language}`;
      return <li key={language} className="owner-other">
        <button type="button" className="owner-badge" aria-expanded={expanded} aria-controls={panel}
          onClick={() => actions.toggleLanguage(language)}>{t.otherBadge(t.languages[language], texts.length, editor.dirty || editor.phase === "conflict")}</button>
        {expanded && <OtherLanguageEditor id={panel} language={language} editor={editor} actions={actions} t={t} hintId={hintId}
          refresh={others.refresh} />}
      </li>;
    })}</ul>
    {(others.refresh === "failed" || others.refresh === "unavailable") && <div className="owner-notes">
      <p role="alert" className="owner-problem">{others.refresh === "failed" ? t.othersFailed : t.othersUnavailable}</p>
      <div className="owner-actions"><button type="button" onClick={actions.retryOthers}>{t.retry}</button></div>
    </div>}
  </>;
  return <section className="owner-others" aria-labelledby={`${id}-title`}>
    <h4 id={`${id}-title`} className="owner-others-title">{t.otherLanguages}</h4>
    {body}
  </section>;
}

/** Another language under its opened badge (R17-02): its own fields, notes and save; the editor's «Отмена» closes all. */
function OtherLanguageEditor({ id, language, editor, actions, t, hintId, refresh }: {
  id: string; language: CommonLanguage; editor: TranslationListSnapshot; actions: OwnerEditorActions; t: OwnerText; hintId: string;
  refresh: OtherLanguagesSnapshot["refresh"];
}) {
  const own = useMemo(() => listActions(actions, language), [actions, language]);
  const name = t.languages[language], named = (text: string) => `${text}: ${name}`;
  return <div id={id} className="owner-other-editor" role="group" aria-label={name} data-phase={editor.phase}>
    <TranslationFields editor={editor} actions={own} t={t} textLanguage={language} hintId={hintId} lastId={`${id}-last`} />
    <ListNotes editor={editor} t={t} lastId={`${id}-last`} refresh={refresh} />
    <div className="owner-actions">
      {editor.phase === "conflict" ? <>
        <button type="button" aria-label={named(t.accept)} disabled={editor.reading}
          onClick={() => actions.acceptCurrentTranslations(language)}>{t.accept}</button>
        <button type="button" aria-label={named(t.keep)} disabled={editor.blank || editor.reading}
          onClick={() => actions.keepMineTranslations(language)}>{t.keep}</button>
      </> : editor.phase === "failed" && (editor.canRetry || editor.checking)
        ? <button type="button" aria-label={named(t.retry)} disabled={!editor.canRetry}
          onClick={() => actions.retryTranslations(language)}>{t.retry}</button>
        : <button type="button" aria-label={named(t.save)} disabled={!editor.canSave}
          onClick={() => actions.saveTranslations(language)}>{t.save}</button>}
    </div>
  </div>;
}

const formStatuses = ["applicable", "not_applicable", "unknown"] as const;
const closedValues: Partial<Record<GrammarFieldName, readonly string[]>> = {
  gender: ["masculine", "feminine", "neuter"], auxiliary: ["haben", "sein"],
};

function shownForm(name: GrammarFieldName, draft: GrammarDraft, t: OwnerText): string {
  if (typeof draft === "string") return t.separabilities[draft];
  const status = t.statuses[draft.status];
  if (name === "article" || draft.status === "not_applicable" || draft.value.trim() === "") return status;
  const value = name === "gender" ? t.genders[draft.value as keyof OwnerText["genders"]] ?? draft.value : draft.value;
  return `${status}, ${value}`;
}

function GrammarEditor({ fields, canCancel, actions, language }: {
  fields: GrammarFieldSnapshot[]; canCancel: boolean; actions: OwnerEditorActions; language: Language;
}) {
  const t = ownerText(language), id = useId();
  return <section className="owner-editor" aria-labelledby={`${id}-title`} lang={language}>
    <h3 id={`${id}-title`} className="owner-title">{t.grammarTitle}</h3>
    {fields.map(field => <GrammarRow key={field.name} field={field} actions={actions} t={t} />)}
    <div className="owner-actions">
      <button type="button" disabled={!canCancel} onClick={actions.cancel}>{t.close}</button>
    </div>
  </section>;
}

function GrammarRow({ field, actions, t }: { field: GrammarFieldSnapshot; actions: OwnerEditorActions; t: OwnerText }) {
  const id = useId(), name = field.name, label = t.grammar[name], draft = field.draft;
  const problem = problemText(field.phase, field.problem, field.checking, t);
  let controls: ReactNode;
  if (typeof draft === "string") {
    controls = <select id={`${id}-value`} aria-label={label} value={draft} disabled={!field.canEdit}
      onChange={event => actions.editGrammar(name, event.target.value as GrammarDraft)}>
      {(["separable", "inseparable", "unknown"] as const).map(value => <option key={value} value={value}>{t.separabilities[value]}</option>)}
    </select>;
  } else {
    const closed = closedValues[name];
    const setStatus = (status: (typeof formStatuses)[number]) => actions.editGrammar(name, { status, value: draft.value });
    const setValue = (value: string) => actions.editGrammar(name, { status: draft.status, value });
    controls = <>
      <label className="owner-grammar-control">{t.status}
        <select value={draft.status} disabled={!field.canEdit} onChange={event => setStatus(event.target.value as (typeof formStatuses)[number])}>
          {formStatuses.map(status => <option key={status} value={status}>{t.statuses[status]}</option>)}
        </select>
      </label>
      {name !== "article" && <label className="owner-grammar-control">{t.value}
        {closed ? <select value={draft.value} disabled={!field.canEdit || draft.status === "not_applicable"}
          onChange={event => setValue(event.target.value)}>
          <option value="">{t.none}</option>
          {closed.map(value => <option key={value} value={value}>{name === "gender" ? t.genders[value as keyof OwnerText["genders"]] : value}</option>)}
        </select>
          : <input value={draft.value} lang="de" readOnly={!field.canEdit} disabled={draft.status === "not_applicable"}
            onChange={event => setValue(event.target.value)} />}
      </label>}
    </>;
  }
  return <fieldset className="owner-grammar-field" data-phase={field.phase}>
    <legend>{label}</legend>
    <div className="owner-grammar-controls">{controls}</div>
    <div className="owner-notes">
      {field.phase === "saving" && <p role="status">{t.saving}</p>}
      {field.phase === "saved" && <p role="status">{t.fieldSaved}</p>}
      {problem && <p role="alert" className="owner-problem">{problem}</p>}
      {field.phase === "conflict" && <div role="alert" className="owner-conflict">
        <p>{t.grammarConflict}</p><p>{t.currentForm(shownForm(name, field.current, t))}</p>
      </div>}
    </div>
    <div className="owner-actions">
      {field.phase === "conflict" ? <>
        <button type="button" onClick={() => actions.acceptCurrentGrammar(name)}>{t.accept}</button>
        <button type="button" onClick={() => actions.keepMineGrammar(name)}>{t.keep}</button>
      </> : field.phase === "failed" && (field.canRetry || field.checking)
        ? <button type="button" disabled={!field.canRetry} onClick={() => actions.retryGrammar(name)}>{t.retry}</button>
        : <button type="button" aria-label={`${t.save}: ${label}`} disabled={!field.canSave} onClick={() => actions.saveGrammar(name)}>
          {t.save}</button>}
    </div>
  </fieldset>;
}
