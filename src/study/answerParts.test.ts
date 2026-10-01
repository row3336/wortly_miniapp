import { describe, expect, it } from "vitest";
import type { PublicAnswerSpec } from "../api/generated";
import { estimateAnswerParts } from "./answerParts";

const noun = { kind: "forms", labels: ["Singular", "Plural"], part_count: 2 } as const;
function shape(labels: string[], kind: PublicAnswerSpec["kind"] = "forms") {
  return { kind, labels, part_count: labels.length };
}
const countNoun = (text: string) => estimateAnswerParts({ ...noun, labels: [...noun.labels] }, text);

describe("approximate public answer shape", () => {
  it.each(["", " \n\t\u0085\u2003 ", " ,; | ↔ ◆ 😀 ", "\u200b\u0000"])("has no occupied part for %j", text => {
    expect(countNoun(text)).toBe(0);
  });
  it.each(["das Haus", "DER Quatsch", "die Hauser", "Wasser", "das E-Mail", "das E‐Mail", "das E‑Mail", "das O’Wort", "das O'Wort"])("counts one entered form in %s without knowing its answer", text => {
    expect(countNoun(text)).toBe(1);
  });
  it.each([" ", "\n", "\t", "\u0085", "\u2003", "\u001e", ",", ";", " / ", "↔", "◆", "😀", "\n,; |\t", "—", "؟"])("accepts the structural separator %j", separator => {
    expect(countNoun(`das Haus${separator}Ha\u0308user`)).toBe(2);
  });
  it.each(["das HausHauser", "das Haus\u200bHäuser", "das Haus\u0000Häuser", "das Haus\u0308Häuser"])("does not silently turn %j into two forms", text => {
    expect(countNoun(text)).toBe(1);
  });
  it("does not use spelling, agreement, case sensitivity or order to decide correctness", () => {
    expect(countNoun("das Haus, Häuser")).toBe(2);
    expect(countNoun("DER Quatsch / FALSCH")).toBe(2);
    expect(countNoun("Häuser, das Haus")).toBe(2);
    expect(countNoun("123 456")).toBe(2);
    expect(countNoun("einfach nur sehr viele falsche Wörter")).toBe(2);
  });
  it("groups prefixes only at their public position and only across whitespace", () => {
    const verb = shape(["Infinitiv", "Präteritum", "Partizip II"]);
    expect(estimateAnswerParts(verb, "sich freuen")).toBe(1);
    expect(estimateAnswerParts(verb, "gehen ging")).toBe(2);
    expect(estimateAnswerParts(verb, "gehen ging ist gegangen")).toBe(3);
    expect(estimateAnswerParts(verb, "sich, freuen")).toBe(2);
    expect(countNoun("das / Haus")).toBe(2);
    expect(estimateAnswerParts(shape(["Wort", "Wort", "Wort"]), "das Haus")).toBe(2);
  });
  it("uses the issued parts, including omitted preterite or comparative", () => {
    expect(estimateAnswerParts(shape(["Infinitiv", "Partizip II"]), "sich freuen hat gefreut")).toBe(2);
    expect(estimateAnswerParts(shape(["Positiv", "Komparativ", "Superlativ"]), "gut besser am besten")).toBe(3);
    expect(estimateAnswerParts(shape(["Positiv"]), "sehr gut")).toBe(1);
    expect(estimateAnswerParts(shape(["Plural"]), "die Leute")).toBe(1);
  });
  it.each(["constructor", "toString", "__proto__", "Unbekannt"])("treats the unfamiliar label %s as text", label => {
    expect(estimateAnswerParts(shape([label, "Plural"]), "der Quatsch")).toBe(2);
  });
  it.each(["word", "phrase"] as const)("%s remains one part regardless of spaces and punctuation", kind => {
    const spec = shape([kind === "phrase" ? "Satz" : "Wort"], kind);
    expect(estimateAnswerParts(spec, "Guten Tag! Wie geht’s?")).toBe(1);
    expect(estimateAnswerParts(spec, "guten, FALSCH? / Wort")).toBe(1);
    expect(estimateAnswerParts(spec, "... / ")).toBe(0);
  });
  it("is stateless across calls and does not change the source or its public shape", () => {
    const spec = Object.freeze(shape(["Singular", "Plural"])); Object.freeze(spec.labels);
    const raw = "  das Haus\nHa\u0308user  ";
    expect(estimateAnswerParts(spec, raw)).toBe(2);
    expect(estimateAnswerParts(spec, "")).toBe(0);
    expect(estimateAnswerParts(spec, raw)).toBe(2);
    expect(raw).toBe("  das Haus\nHa\u0308user  ");
    expect(spec.labels).toEqual(["Singular", "Plural"]);
  });
});
