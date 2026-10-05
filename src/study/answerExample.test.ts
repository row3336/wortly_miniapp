import { describe, expect, it, vi } from "vitest";
import type { CardExample, CardExamples, PersonalCardText, WrittenAnswerDetail } from "../api/generated";
import { validWrittenAnswerDetail } from "../learning/learningAnswerApi";
import { answerExampleCandidates, hasWechselRoles, selectAnswerExample, wechselPair } from "./answerExample";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
// Edge whitespace makes any in-place trim or normalization visible.
const common = (n: number): CardExample => ({ id: id(n), text: ` Satz ${n}. `, role: "general",
  highlighted_parts: [{ start: 0, end: 4 }, ["legacy", n]] });
const personal = (value: string, version = "3"): PersonalCardText => ({ value, version });
const commons = (count: number) => Array.from({ length: count }, (_, index) => common(index + 1));
const fixed = (r: number) => vi.fn(() => r);
const withRole = (n: number, role: CardExample["role"]): CardExample => ({ ...common(n), role });

// Malformed answered examples are rejected by the strict decoder: learningAnswerApi.test.ts (P8).
describe("post-answer example of an Akkusativ/Dativ preposition (К05-127, К05-113)", () => {
  // Source order direction-first proves the pair is addressed by role, not by position.
  const direction = withRole(1, "wechsel_direction"), location = withRole(2, "wechsel_location");
  const pairCommon = [direction, common(3), location];

  it.each([[[]], [[personal("Mein Satz.")]], [[personal("Eins."), personal("Zwei.")]]])(
    "shows both role examples without random for personal candidates %j", own => {
      const random = fixed(Number.NaN);
      const choice = selectAnswerExample({ personal: own, common: pairCommon }, random);
      expect(choice).toEqual({ kind: "wechsel_pair", location, direction });
      if (choice.kind !== "wechsel_pair") throw new Error("expected the wechsel pair");
      expect(choice.location).toBe(location);
      expect(choice.direction).toBe(direction);
      expect(random).not.toHaveBeenCalled();
    });

  it("keeps the single stored personal example out of the result through the current DTO adapter", () => {
    const own = personal("Ich laufe in den Park."), examples: CardExamples = { common: pairCommon, personal: own };
    const before = structuredClone(examples);
    const choice = selectAnswerExample(answerExampleCandidates(examples), fixed(0.5));
    expect(choice.kind).toBe("wechsel_pair");
    expect(Object.values(choice)).not.toContain(own);
    expect(examples).toEqual(before);
  });

  it("uses the two roles as marker, so a single role keeps К05-126 (data precondition К05-110)", () => {
    expect(hasWechselRoles([direction, common(3)])).toBe(false);
    expect(wechselPair([direction, common(3)])).toBeNull();
    const own = personal("Mein Satz.");
    const choice = selectAnswerExample({ personal: [own], common: [direction, common(3)] }, fixed(0.5));
    expect(choice.kind === "personal" && choice.personal).toBe(own);
  });

  it("rejects a duplicate wechsel role instead of choosing one (examples_one_wechsel_role_idx)", () => {
    const duplicate = [...pairCommon, withRole(4, "wechsel_location")];
    expect(hasWechselRoles(duplicate)).toBe(true);
    expect(() => wechselPair(duplicate)).toThrow(RangeError);
    expect(() => selectAnswerExample({ personal: [], common: duplicate }, fixed(0.5))).toThrow(RangeError);
  });
});

describe("post-answer example selection (К05-126)", () => {
  it("shows the only personal example and never consults commons or random (P1)", () => {
    const own = personal("Mein Satz."), random = fixed(0.7);
    const choice = selectAnswerExample({ personal: [own], common: commons(3) }, random);
    expect(choice).toEqual({ kind: "personal", personal: own });
    expect(choice.kind === "personal" && choice.personal).toBe(own);
    expect(random).not.toHaveBeenCalled();
  });

  it("returns a single common example without consulting random, even an invalid one", () => {
    const only = common(1), random = fixed(Number.NaN);
    const choice = selectAnswerExample({ personal: [], common: [only] }, random);
    expect(choice.kind === "common" && choice.common).toBe(only);
    expect(random).not.toHaveBeenCalled();
  });

  // 1 - EPSILON / 2 is the largest double below 1.
  it.each([[0, 0], [0.5, 1], [0.9999, 2], [1 - Number.EPSILON / 2, 2]])(
    "without personal picks one common by injected random %s (P2)", (r, index) => {
      const pool = commons(3), random = fixed(r);
      const choice = selectAnswerExample({ personal: [], common: pool }, random);
      expect(choice.kind === "common" && choice.common).toBe(pool[index]);
      expect(random).toHaveBeenCalledTimes(1);
    });

  it("keeps no state between calls, so a repeat is allowed (P2)", () => {
    const pool = commons(3), candidates = { personal: [], common: pool };
    const first = selectAnswerExample(candidates, fixed(0.4)), second = selectAnswerExample(candidates, fixed(0.4));
    expect(first.kind === "common" && first.common).toBe(pool[1]);
    expect(second.kind === "common" && second.common).toBe(pool[1]);
  });

  it("returns none without random when no candidate exists (P3)", () => {
    const random = fixed(0.5);
    expect(selectAnswerExample({ personal: [], common: [] }, random)).toEqual({ kind: "none" });
    expect(random).not.toHaveBeenCalled();
  });

  it("chooses randomly among several personal examples and never a common one (P4)", () => {
    const own = [personal("Eins."), personal("Zwei."), personal("Drei.")], pool = commons(2);
    const third = selectAnswerExample({ personal: own, common: pool }, fixed(0.8));
    expect(third.kind === "personal" && third.personal).toBe(own[2]);
    for (let step = 0; step < 100; step++) {
      const choice = selectAnswerExample({ personal: own, common: pool }, fixed(step / 100));
      expect(choice.kind).toBe("personal");
      expect(own).toContain(choice.kind === "personal" && choice.personal);
    }
  });

  it("adapts the current 0/1 personal shape without copying (P5)", () => {
    const pool = commons(2), own = personal("Mein Satz."), empty = personal("");
    const absent = answerExampleCandidates({ common: pool, personal: null });
    expect(absent.personal).toEqual([]);
    expect(absent.common).toBe(pool);
    expect(answerExampleCandidates({ common: pool, personal: own }).personal[0]).toBe(own);
    // A personal object is present even with empty text; nothing is trimmed or reinterpreted.
    const blank = answerExampleCandidates({ common: pool, personal: empty });
    expect(blank.personal).toEqual([empty]);
    expect(selectAnswerExample(blank, fixed(0.5))).toEqual({ kind: "personal", personal: empty });
    const spaces = personal("  "), spaced = selectAnswerExample(answerExampleCandidates({ common: pool, personal: spaces }), fixed(0.5));
    expect(spaced.kind === "personal" && spaced.personal).toBe(spaces);
    expect(spaces.value).toBe("  ");
  });

  it("selects from the frozen examples of the decoded answered result without changing them (P7)", () => {
    const examples: CardExamples = { common: commons(3), personal: null };
    const detail: WrittenAnswerDetail = { conjunction_hint: null, examples, input: { kind: "text", text: "Haus" },
      variants: [{ parts: ["Haus"] }], initial_check: { correct: true, variant_index: 0, correct_answer: "Haus",
        other_answers: [], matched_spans: [{ start: 0, end: 4 }], span_unit: "unicode_code_point",
        span_bounds: "start_inclusive_end_exclusive" } };
    expect(validWrittenAnswerDetail(detail)).toBe(true);
    const before = structuredClone(detail);
    const choice = selectAnswerExample(answerExampleCandidates(detail.examples!), fixed(0.5));
    expect(choice.kind === "common" && choice.common).toBe(examples.common[1]);
    expect(detail).toEqual(before);
  });

  it("returns the source text and highlighted parts as they are", () => {
    const pool = commons(2), before = structuredClone(pool);
    const choice = selectAnswerExample({ personal: [], common: pool }, fixed(0.75));
    if (choice.kind !== "common") throw new Error("expected a common example");
    expect(choice.common.text).toBe(" Satz 2. ");
    expect(choice.common.highlighted_parts).toBe(pool[1].highlighted_parts);
    expect(pool).toEqual(before);
  });

  it.each([-0.1, 1, Number.NaN, Number.POSITIVE_INFINITY, "0.5"])("rejects invalid random %s instead of a fallback", r => {
    const random = vi.fn(() => r) as unknown as () => number;
    expect(() => selectAnswerExample({ personal: [], common: commons(3) }, random)).toThrow(RangeError);
    expect(() => selectAnswerExample({ personal: [personal("A."), personal("B.")], common: [] }, random)).toThrow(RangeError);
  });
});
