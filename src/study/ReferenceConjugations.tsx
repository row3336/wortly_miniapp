import type { ReferenceConjugation } from "../api/generated";
import type { Language } from "../i18n/language";
import "./referenceConjugations.css";

const pronouns = ["ich", "du", "er_sie_es", "wir", "ihr", "sie_sie"] as const;
const labels = { ich: "ich", du: "du", er_sie_es: "er / sie / es", wir: "wir", ihr: "ihr", sie_sie: "sie / Sie" };
const missing = { ru: "Не заполнено", uk: "Не заповнено", en: "Not filled in" };
const tenses = [{ key: "present", label: "Präsens" }, { key: "preterite", label: "Präteritum" }] as const;

/** Read-only verb reference. Absent legacy data is unknown, never an inferred exclusion. */
export function ReferenceConjugations({ tables, language }: { tables: ReferenceConjugation[]; language: Language }) {
  return <div className="reference-conjugations">
    {tenses.map(tense => {
      const saved = tables.find(table => table.tense === tense.key);
      const rows = pronouns.flatMap(pronoun => {
        const form = saved?.forms.find(item => item.pronoun_group === pronoun);
        return form?.status === "not_applicable" ? [] : [{ pronoun, value: form?.value }];
      });
      if (!rows.length) return null;
      return <table key={tense.key} lang="de">
        <caption>{tense.label}</caption>
        <tbody>{rows.map(row => <tr key={row.pronoun}>
          <th scope="row">{labels[row.pronoun]}</th>
          <td>{row.value?.trim() ? row.value : <span className="reference-missing" lang={language}>{missing[language]}</span>}</td>
        </tr>)}</tbody>
      </table>;
    })}
  </div>;
}
