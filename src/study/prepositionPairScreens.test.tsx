import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CardExample, PrepositionCardExamples, WrittenResult } from "../api/generated";
import { LearningPreviewCard } from "../learning/LearningPreviewCard";
import { previewContent } from "../learning/learningPreview.test-support";
import { renderLearningPreviewExamples } from "./LearningPreviewExamples";
import { validCardExamples } from "./referenceCardContent";
import { WrittenAnswerResult } from "./WrittenAnswerResult";

afterEach(cleanup);
const example = (n: number, text: string, role: CardExample["role"]): CardExample =>
  ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, text, role, highlighted_parts: [] });
const direction = example(1, "Ich gehe in die Schule.", "wechsel_direction");
const location = example(2, "Ich bin in der Schule.", "wechsel_location");
const general = example(3, "Gemeinsamer Satz.", "general");

/** A two-case preposition: own roles as given, plus a single own example that never replaces the commons. */
function pair(akkusativ: string | null, dativ: string | null, single: string | null = null): PrepositionCardExamples {
  const full = akkusativ !== null && dativ !== null;
  const value: PrepositionCardExamples = { common: [direction, general, location], personal: single === null ? null : { value: single, version: "3" },
    preposition_pair: { editor: { akkusativ: { value: akkusativ, version: "2" }, dativ: { value: dativ, version: "2" } },
      effective: full ? { source: "personal", akkusativ: { value: akkusativ!, version: "2" }, dativ: { value: dativ!, version: "2" } }
        : { source: "common", akkusativ: direction, dativ: location } } };
  expect(validCardExamples(value)).toBe(true);
  return value;
}
const sentences = (root: ParentNode) => Array.from(root.querySelectorAll("p.german-example"), node => node.textContent);
const labels = (root: ParentNode) => Array.from(root.querySelectorAll(".personal-example-pair dt"), node => node.textContent);

function preview(examples: PrepositionCardExamples) {
  const value = previewContent("00000000-0000-4000-8000-0000000000a1");
  value.card = { ...value.card, type: "preposition", lemma: "in" };
  return render(<LearningPreviewCard content={{ ...value, examples }} language="ru" renderExamples={renderLearningPreviewExamples} />);
}
function answered(examples: PrepositionCardExamples) {
  const result: WrittenResult = { result_id: "result", assignment_id: "assignment", version: "1", status: "active", grade: 4, correct: true,
    accepted_at: "2026-10-07T09:00:00Z", answer_date: "2026-10-07", detail: { input: { kind: "text", text: "in" },
      conjunction_hint: null, examples, variants: [{ parts: ["in"] }],
      initial_check: { correct: true, variant_index: 0, correct_answer: "in", other_answers: [], matched_spans: [],
        input_errors: [], answer_errors: [], span_unit: "unicode_code_point", span_bounds: "start_inclusive_end_exclusive" } } };
  return render(<WrittenAnswerResult result={result} language="ru" pending={null} grades={[]} canCorrect={false} canNext timer={null}
    onGrade={vi.fn()} onCorrect={vi.fn()} onNext={vi.fn()} example={{ random: () => { throw new Error("no random for a pair"); } }} />);
}

describe("К07-104 / К05-127 / Т85 in М07 and after a written answer (PK3 G4, M-CARD В5)", () => {
  it("M07: the full own pair shows both own sentences with their cases, Akkusativ first, without commons", () => {
    const { container } = preview(pair("Ich laufe in den Park.", "Ich sitze im Park."));
    expect(sentences(container)).toEqual(["Ich laufe in den Park.", "Ich sitze im Park."]);
    expect(labels(container)).toEqual(["Akkusativ", "Dativ"]);
  });
  it.each([[null, null, null], ["Ich laufe in den Park.", null, null], [null, null, "Mein Satz."]])(
    "M07: 0/1 own role or a single own example shows only the common pair, Akkusativ first (%s, %s, %s)", (akk, dat, single) => {
      const { container } = preview(pair(akk, dat, single));
      expect(sentences(container)).toEqual([direction.text, location.text]);
      expect(labels(container)).toEqual([]);
    });
  it("written result: the full own pair with its cases, Akkusativ first", () => {
    const { container } = answered(pair("Ich laufe in den Park.", "Ich sitze im Park."));
    expect(sentences(container)).toEqual(["Ich laufe in den Park.", "Ich sitze im Park."]);
    expect(labels(container)).toEqual(["Akkusativ", "Dativ"]);
  });
  it.each([[null, null, null], [null, "Ich sitze im Park.", null], [null, null, "Mein Satz."]])(
    "written result: 0/1 own role or a single own example shows both commons, never a mix (%s, %s, %s)", (akk, dat, single) => {
      const { container } = answered(pair(akk, dat, single));
      expect(sentences(container)).toEqual([direction.text, location.text]);
    });
});
