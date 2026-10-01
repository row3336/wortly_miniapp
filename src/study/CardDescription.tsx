import type { ReactNode } from "react";
import type { DictionaryCardContent, LearningPreviewContent } from "../api/generated";
import type { Language } from "../i18n/language";

type Props = { content: LearningPreviewContent | DictionaryCardContent; language: Language; headingId: string };
type Form = { label: string; value: string | null | undefined; status?: "applicable" | "not_applicable" | "unknown";
  article?: "der" | "die" | "das" };
const copy = {
  ru: { missing: "Не заполнено", translation: "Перевод", personal: "Личный перевод", level: "Уровень",
    category: "Категория", cases: "Падеж", position: "Положение глагола",
    types: { noun: "Существительное", verb: "Глагол", phrase: "Фраза", adjective: "Прилагательное", pronoun: "Местоимение",
      adverb: "Наречие", preposition: "Предлог", conjunction: "Союз", particle: "Частица" } },
  uk: { missing: "Не заповнено", translation: "Переклад", personal: "Особистий переклад", level: "Рівень",
    category: "Категорія", cases: "Відмінок", position: "Положення дієслова",
    types: { noun: "Іменник", verb: "Дієслово", phrase: "Фраза", adjective: "Прикметник", pronoun: "Займенник",
      adverb: "Прислівник", preposition: "Прийменник", conjunction: "Сполучник", particle: "Частка" } },
  en: { missing: "Not filled in", translation: "Translation", personal: "Personal translation", level: "Level",
    category: "Category", cases: "Case", position: "Verb position",
    types: { noun: "Noun", verb: "Verb", phrase: "Phrase", adjective: "Adjective", pronoun: "Pronoun",
      adverb: "Adverb", preposition: "Preposition", conjunction: "Conjunction", particle: "Particle" } },
} as const;
const articles = { masculine: "der", feminine: "die", neuter: "das" } as const;
const auxiliaries = { haben: "hat", sein: "ist" } as const;

/** Shared German forms, taxonomy and translation; the surrounding screen owns the remaining blocks. */
export function CardDescription({ content, language, headingId }: Props) {
  const t = copy[language], { card, grammar } = content;
  const missing = <span className="reference-missing" lang={language}>{t.missing}</span>;
  const value = (text: string | null | undefined) => text?.trim() ? text : missing;
  // Field hints must not replace the German text in the heading's accessible name.
  const field = (form: Form) => form.status === "not_applicable" ? null
    : <span className="reference-form" title={form.label} lang="de" data-article={form.article}>{value(form.value)}</span>;
  let head: ReactNode = value(card.lemma), below: ReactNode = null;
  let taxonomy: { label: string; value: string | null }[] = [];

  if (card.type === "noun") {
    const noun = grammar && "singular" in grammar ? grammar : null;
    const articleValue = noun?.gender ? articles[noun.gender] : undefined;
    const article = field({ label: "Artikel", value: articleValue, article: articleValue, status: noun?.article_status });
    const singular = field({ label: "Singular", value: noun?.singular, status: noun?.singular_status });
    const plural = field({ label: "Plural", value: noun?.plural, status: noun?.plural_status });
    // A lemma is a title, not evidence for a missing grammatical form.
    if (singular) {
      head = <>{article}{article && "\u00a0"}{singular}</>;
      if (!noun?.singular?.trim()) head = <>{value(card.lemma)}<span className="reference-missing-forms">{head}</span></>;
      below = plural;
    } else if (plural) head = noun?.plural?.trim() ? plural
      : <>{value(card.lemma)}<span className="reference-missing-forms">{plural}</span></>;
  } else if (card.type === "verb") {
    const verb = grammar && "infinitive" in grammar ? grammar : null;
    const infinitive = field({ label: "Infinitiv", value: verb?.infinitive, status: verb?.infinitive_status });
    const preterite = field({ label: "Präteritum", value: verb?.preterite, status: verb?.preterite_status });
    const auxiliary = field({ label: "Hilfsverb", value: verb?.auxiliary ? auxiliaries[verb.auxiliary] : null, status: verb?.auxiliary_status });
    const participle = field({ label: "Partizip II", value: verb?.participle_ii, status: verb?.participle_ii_status });
    const perfect = auxiliary || participle ? <span className="reference-compound">{auxiliary}{auxiliary && participle && "\u00a0"}{participle}</span> : null;
    const forms = [infinitive, preterite, perfect].filter(part => part !== null);
    head = <>{(!verb?.infinitive?.trim() || !infinitive) && <span className="reference-fallback-lemma">{value(card.lemma)}</span>}
      <span className="reference-main-forms">{forms.map((form, index) => <span key={index}>{index > 0 && <span aria-hidden="true"> / </span>}{form}</span>)}</span></>;
  } else if (card.type === "adjective") {
    const adjective = grammar && "positive" in grammar ? grammar : null;
    const forms = [field({ label: "Positiv", value: adjective?.positive, status: adjective?.positive_status }),
      field({ label: "Komparativ", value: adjective?.comparative, status: adjective?.comparative_status }),
      field({ label: "Superlativ", value: adjective?.superlative, status: adjective?.superlative_status })].filter(form => form !== null);
    head = <>{(!adjective?.positive?.trim() || adjective.positive_status === "not_applicable") && <span className="reference-fallback-lemma">{value(card.lemma)}</span>}
      <span className="reference-main-forms">{forms.map((form, index) => <span key={index}>{index > 0 && <span aria-hidden="true"> / </span>}{form}</span>)}</span></>;
  } else if (card.type === "preposition") {
    const preposition = grammar && "cases" in grammar ? grammar : null;
    taxonomy = [{ label: t.category, value: preposition?.category.name ?? null },
      { label: t.cases, value: preposition?.cases.map(term => term.name).join(" / ") ?? null }];
  } else if (card.type === "conjunction") {
    const conjunction = grammar && "verb_position" in grammar ? grammar : null;
    taxonomy = [{ label: t.category, value: conjunction?.meaning_category.name ?? null },
      { label: t.position, value: conjunction?.verb_position.name ?? null }];
  }
  const personal = content.translations.personal;
  const translations = personal !== null ? [personal.value] : content.translations.common;
  const dictionaryLanguage = content.pair.slice(0, 2);
  return <>
    <div className="reference-card-meta"><span>{t.types[card.type]}</span><span title={t.level}>{value(card.cefr)}</span></div>
    <div className="reference-word"><h2 id={headingId} lang="de">{head}</h2>
      {below && <p className="reference-plural" lang="de">{below}</p>}
    </div>
    {taxonomy.length > 0 && <dl className="reference-taxonomy">{taxonomy.map(term => <div key={term.label}>
      <dt>{term.label}</dt><dd lang="de">{value(term.value)}</dd>
    </div>)}</dl>}
    <section className="reference-translation" aria-label={t.translation} lang={dictionaryLanguage}>
      {personal !== null && <p className="reference-personal" lang={language}>{t.personal}</p>}
      {(translations.length ? translations : [null]).map((text, index) => <p key={index}>{value(text)}</p>)}
    </section>
  </>;
}
