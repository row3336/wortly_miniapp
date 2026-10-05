import { useId, useLayoutEffect, useRef, type ReactNode } from "react";
import type { PublicAnswerSpec, PublicAssignment } from "../api/generated";
import type { Language } from "../i18n/language";
import { estimateAnswerParts } from "./answerParts";
import { ConjunctionHint } from "./ConjunctionHint";
import "./writtenAnswer.css";

export type WrittenAnswerInputProps = {
  assignment: PublicAssignment;
  language: Language;
  value: string;
  readOnly: boolean;
  canSubmit: boolean;
  canForget: boolean;
  submitOnEnter: boolean;
  status?: string;
  onChange(value: string): void;
  onSubmit(): void;
  onForget(): void;
};
/** A question without a text prompt: the owner renders its own heading over the same answer shape. */
export type WrittenAnswerQuestion = {
  assignment: Readonly<{ id: string; answer_spec: Pick<PublicAnswerSpec, "kind" | "labels" | "part_count">; prompt: null }>;
  heading: ReactNode;
};
const copy = {
  ru: { answer: "Твой ответ", submit: "Проверить", forgot: "Забыл…", symbols: "Немецкие символы", parts: "Формы ответа",
    filled: "Заполнено частей (примерно)", of: "из" },
  uk: { answer: "Твоя відповідь", submit: "Перевірити", forgot: "Не пам’ятаю…", symbols: "Німецькі символи", parts: "Форми відповіді",
    filled: "Заповнено частин (приблизно)", of: "із" },
  en: { answer: "Your answer", submit: "Check", forgot: "I forgot…", symbols: "German characters", parts: "Answer forms",
    filled: "Parts entered (approx.)", of: "of" },
} as const;

/** One controlled field. The owner captures the command; this view never saves or judges an answer. */
export function WrittenAnswerInput(props: WrittenAnswerInputProps | (Omit<WrittenAnswerInputProps, "assignment"> & WrittenAnswerQuestion)) {
  const t = copy[props.language], name = useId(), prompt = props.assignment.prompt;
  const field = useRef<HTMLTextAreaElement>(null), composing = useRef(false);
  const cursor = useRef<{ assignmentId: string; value: string; offset: number } | null>(null);
  const lastAssignment = useRef(props.assignment.id);
  useLayoutEffect(() => {
    if (lastAssignment.current !== props.assignment.id) {
      lastAssignment.current = props.assignment.id; composing.current = false; cursor.current = null;
    }
    const next = cursor.current;
    if (next && next.assignmentId === props.assignment.id && next.value === props.value && !props.readOnly) {
      field.current?.focus({ preventScroll: true });
      field.current?.setSelectionRange(next.offset, next.offset);
      cursor.current = null;
    }
  }, [props.assignment.id, props.value, props.readOnly]);
  const submit = () => {
    if (!composing.current && !props.readOnly && props.canSubmit && props.value.trim()) props.onSubmit();
  };
  const insert = (symbol: string) => {
    const input = field.current;
    if (!input || props.readOnly || composing.current) return;
    const start = input.selectionStart, end = input.selectionEnd;
    const value = props.value.slice(0, start) + symbol + props.value.slice(end);
    cursor.current = { assignmentId: props.assignment.id, value, offset: start + symbol.length };
    props.onChange(value);
    input.focus({ preventScroll: true });
  };
  return <section className="written-answer" aria-labelledby={`${name}-question`}>
    <h2 id={`${name}-question`} className="written-question" lang={prompt?.language}>
      {prompt === null ? "heading" in props && props.heading : prompt.text}
    </h2>
    {prompt?.hint && <p className="written-hint">{prompt.hint}</p>}
    {prompt && <ConjunctionHint hint={prompt.conjunction_hint} language={props.language} />}
    <div className="written-answer-parts">
      <p id={`${name}-parts`} className="written-parts" aria-label={t.parts} lang="de">
        {props.assignment.answer_spec.labels.join(" / ")}
      </p>
      <p id={`${name}-filled`} className="written-parts" aria-live="polite" aria-atomic="true" lang={props.language}>
        {t.filled}: {estimateAnswerParts(props.assignment.answer_spec, props.value)} {t.of} {props.assignment.answer_spec.part_count}
      </p>
    </div>
    <form onSubmit={event => { event.preventDefault(); submit(); }}>
      <label htmlFor={`${name}-input`}>{t.answer}</label>
      <textarea id={`${name}-input`} ref={field} rows={2} value={props.value} readOnly={props.readOnly}
        aria-describedby={`${name}-parts ${name}-filled${props.status ? ` ${name}-status` : ""}`} lang="de"
        autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
        onChange={event => { if (!props.readOnly) props.onChange(event.target.value); }}
        onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={event => {
          if (event.key !== "Enter" || !props.submitOnEnter) return;
          if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
          event.preventDefault();
          if (!event.repeat) submit();
        }} />
      <div className="written-symbols" role="group" aria-label={t.symbols}>
        {["ä", "ö", "ü", "ß"].map(symbol => <button key={symbol} type="button" disabled={props.readOnly}
          onPointerDown={event => { if (event.button === 0) event.preventDefault(); }}
          onClick={() => insert(symbol)}>{symbol}</button>)}
      </div>
      {props.status && <p id={`${name}-status`} className="written-status" role="status">{props.status}</p>}
      <div className="written-input-actions">
        <button type="button" disabled={props.readOnly || !props.canForget}
          onClick={() => { if (!composing.current && !props.readOnly && props.canForget) props.onForget(); }}>{t.forgot}</button>
        <button type="submit" disabled={props.readOnly || !props.canSubmit || !props.value.trim()}>{t.submit}</button>
      </div>
    </form>
  </section>;
}
