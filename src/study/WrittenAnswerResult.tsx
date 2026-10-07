import { useRef } from "react";
import type { MatchedSpan, WrittenResult } from "../api/generated";
import type { Language } from "../i18n/language";
import { answerExampleCandidates, selectAnswerExample, type AnswerExampleChoice } from "./answerExample";
import { ConjunctionHint } from "./ConjunctionHint";
import { GermanExample } from "./GermanExample";
import { PersonalExamplePair } from "./PersonalExamplePair";
import "./writtenAnswer.css";

export type WrittenAnswerResultProps = {
  result: WrittenResult;
  language: Language;
  pending: "changing" | "unknown" | null;
  grades: readonly (3 | 4 | 5)[];
  canCorrect: boolean;
  canNext: boolean;
  timer: { key: string; durationMs: number } | null;
  onGrade(grade: 3 | 4 | 5): void;
  onCorrect(): void;
  onNext(): void;
  /** The written quiz and Learning show one example after the answer (К05-126); its source of randomness is injectable. */
  example?: { random(): number };
};
const copy = {
  ru: { correct: "Верно", wrong: "Есть ошибка", corrected: "Ответ исправлен", changing: "Сохраняем изменение", unknown: "Проверяем изменение",
    input: "Твой ответ", forgot: "Забыл…", right: "Правильно", others: "Другие допустимые ответы", unavailable: "Разбор ответа больше недоступен",
    fix: "Исправить ответ", next: "Далее", grades: ["Трудно", "Нормально", "Легко"] },
  uk: { correct: "Правильно", wrong: "Є помилка", corrected: "Відповідь виправлено", changing: "Зберігаємо зміну", unknown: "Перевіряємо зміну",
    input: "Твоя відповідь", forgot: "Не пам’ятаю…", right: "Правильно", others: "Інші допустимі відповіді", unavailable: "Розбір відповіді більше недоступний",
    fix: "Виправити відповідь", next: "Далі", grades: ["Важко", "Нормально", "Легко"] },
  en: { correct: "Correct", wrong: "There is a mistake", corrected: "Answer corrected", changing: "Saving the change", unknown: "Checking the change",
    input: "Your answer", forgot: "I forgot…", right: "Correct answer", others: "Other accepted answers", unavailable: "Answer details are no longer available",
    fix: "Correct answer", next: "Next", grades: ["Hard", "Normal", "Easy"] },
} as const;

function HighlightedText({ text, errors }: { text: string; errors: readonly MatchedSpan[] | null | undefined }) {
  if (!errors?.length) return <>{text}</>;
  const points = Array.from(text);
  let offset = 0;
  const fragments = errors.map((span, index) => {
    const before = points.slice(offset, span.start).join(""); offset = span.end;
    return <span key={index}>{before}<span className="written-error">{points.slice(span.start, span.end).join("")}</span></span>;
  });
  return <>{fragments}{points.slice(offset).join("")}</>;
}

/** One example of the answered card per result: the choice stays while revisions of that result are shown.
 * root decision, pending owner (M-CARD В5): the written result keeps selectAnswerExample, not the reference-card rule —
 * К05-126 shows one (random) example after an answer; the two-case preposition pair comes from the same selection. */
function useAnswerExample(result: WrittenResult, source: WrittenAnswerResultProps["example"]): AnswerExampleChoice | null {
  const chosen = useRef<{ key: string; choice: AnswerExampleChoice } | null>(null);
  const examples = result.detail?.examples ?? null;
  if (!source || examples === null) return null;
  const key = `${result.result_id}:${JSON.stringify(examples)}`;
  if (chosen.current?.key !== key) chosen.current = { key, choice: selectAnswerExample(answerExampleCandidates(examples), source.random) };
  return chosen.current.choice;
}

/** German text only, without a heading or translation. A two-case preposition shows its pair (К05-127, К07-121):
 * the full own pair with its case labels, otherwise both common examples, Akkusativ (direction) first; never a mix. */
function AnswerExample({ choice }: { choice: AnswerExampleChoice | null }) {
  if (choice?.kind === "personal") return <GermanExample text={choice.personal.value} highlightedParts={[]} />;
  if (choice?.kind === "common") return <GermanExample text={choice.common.text} highlightedParts={choice.common.highlighted_parts} />;
  if (choice?.kind === "personal_pair") return <PersonalExamplePair pair={choice} />;
  if (choice?.kind === "wechsel_pair") return <>
    <GermanExample text={choice.direction.text} highlightedParts={choice.direction.highlighted_parts} />
    <GermanExample text={choice.location.text} highlightedParts={choice.location.highlighted_parts} />
  </>;
  return null;
}

/** Render only server-confirmed detail and capabilities; animation never runs a command. */
export function WrittenAnswerResult(props: WrittenAnswerResultProps) {
  const t = copy[props.language], detail = props.result.detail, check = detail?.initial_check;
  const example = useAnswerExample(props.result, props.example);
  const changed = !!check && !check.correct && props.result.correct;
  const status = props.pending ? t[props.pending] : changed ? t.corrected : props.result.correct ? t.correct : t.wrong;
  const blocked = props.pending !== null;
  return <section className="written-result" aria-label={status} aria-busy={blocked}>
    {detail ? <>
      <ConjunctionHint hint={detail.conjunction_hint} language={props.language} />
      <div className="written-result-input">
        <p className="written-parts">{t.input}</p>
        <p className="written-result-text" lang={detail.input.kind === "text" ? "de" : props.language}>
          {detail.input.kind === "text" ? <HighlightedText text={detail.input.text} errors={check?.input_errors} /> : t.forgot}
        </p>
      </div>
      <p className="written-result-status" role="status">
        {!blocked && <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          {props.result.correct ? <path d="m5 12 4 4 10-10" /> : <path d="m7 7 10 10M17 7 7 17" />}
        </svg>}{status}
      </p>
      <div className="written-correct-answer">
        <p className="written-parts">{t.right}</p>
        <p className="written-result-text" lang="de"><HighlightedText text={check!.correct_answer} errors={check?.answer_errors} /></p>
      </div>
      {check!.other_answers.length > 0 && <div className="written-alternatives">
        <p className="written-parts">{t.others}</p>
        <ul lang="de">{check!.other_answers.map((answer, index) => <li key={index}>{answer}</li>)}</ul>
      </div>}
      <AnswerExample choice={example} />
    </> : <><p role="status">{status}</p><p>{t.unavailable}</p></>}
    {props.timer && !blocked && <div className="written-timer" aria-hidden="true">
      <span key={props.timer.key} style={{ animationDuration: `${props.timer.durationMs}ms` }} />
    </div>}
    {props.grades.length > 0 && <div className="written-grades">
      {props.grades.map(grade => <button type="button" key={grade} disabled={blocked}
        onClick={() => { if (!blocked) props.onGrade(grade); }}>{t.grades[grade - 3]}</button>)}
    </div>}
    <div className="written-result-actions">
      {props.canCorrect && <button type="button" disabled={blocked} onClick={() => { if (!blocked) props.onCorrect(); }}>{t.fix}</button>}
      <button type="button" disabled={blocked || !props.canNext} onClick={() => { if (!blocked && props.canNext) props.onNext(); }}>{t.next}</button>
    </div>
  </section>;
}
