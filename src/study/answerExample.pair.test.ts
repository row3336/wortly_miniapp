import { describe, expect, it, vi } from "vitest";
import type { CardExamples, PrepositionCardExamples } from "../api/generated";
import { validCardExamples } from "./referenceCardContent";
import { answerExampleCandidates, selectAnswerExample, selectReferenceExamples } from "./answerExample";

const example = (n: number, role: "general" | "wechsel_location" | "wechsel_direction") =>
  ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, text: `Satz ${n}.`, role, highlighted_parts: [] });
const direction = example(1, "wechsel_direction"), location = example(2, "wechsel_location"), general = example(3, "general");
const own = (value: string) => ({ value, version: "4" });

function pair(akkusativ: string | null, dativ: string | null, single: string | null = null): PrepositionCardExamples {
  const full = akkusativ !== null && dativ !== null;
  return { common: [direction, general, location], personal: single === null ? null : own(single), preposition_pair: {
    editor: { akkusativ: { value: akkusativ, version: "4" }, dativ: { value: dativ, version: "4" } },
    effective: full ? { source: "personal", akkusativ: own(akkusativ!), dativ: own(dativ!) }
      : { source: "common", akkusativ: direction, dativ: location } } };
}
const never = () => vi.fn(() => { throw new Error("random must not be used"); });

describe("К05-127 / К07-121 / Т85: the full own pair of a two-case preposition", () => {
  it("fixtures are accepted by the strict decoder", () => {
    for (const value of [pair(null, null), pair("Akk.", null), pair("Akk.", "Dat."), pair(null, null, "Mein Satz.")]) {
      expect(validCardExamples(value)).toBe(true);
    }
  });

  it("after a written answer: the full own pair replaces the commons, without random (G4)", () => {
    const examples = pair("Ich gehe in den Park.", "Ich bin im Park."), random = never();
    expect(selectAnswerExample(answerExampleCandidates(examples), random)).toEqual(
      { kind: "personal_pair", akkusativ: own("Ich gehe in den Park."), dativ: own("Ich bin im Park.") });
    expect(random).not.toHaveBeenCalled();
  });

  it.each([[null, null, null], ["Akk.", null, null], [null, "Dat.", null], [null, null, "Mein Satz."]])(
    "after a written answer: 0/1 own role or a single own example keeps both commons (%s, %s, %s)", (akk, dat, single) => {
      expect(selectAnswerExample(answerExampleCandidates(pair(akk, dat, single)), never()))
        .toEqual({ kind: "wechsel_pair", location, direction });
    });

  it("reference card (М07/М12): the full own pair, otherwise only the two common wechsel examples, Akkusativ first, never a mix", () => {
    expect(selectReferenceExamples(pair("Akk.", "Dat."))).toEqual({ kind: "personal_pair", akkusativ: own("Akk."), dativ: own("Dat.") });
    expect(selectReferenceExamples(pair("Akk.", null))).toEqual({ kind: "common", common: [direction, location] });
    expect(selectReferenceExamples(pair(null, null, "Mein Satz."))).toEqual({ kind: "common", common: [direction, location] });
  });

  it("an older snapshot without the pair key (К05-127): the commons, even with an own example", () => {
    const old: CardExamples = { common: [location, general, direction], personal: own("Mein Satz.") };
    expect(selectReferenceExamples(old)).toEqual({ kind: "common", common: [direction, location] });
    expect(answerExampleCandidates(old)).not.toHaveProperty("pair");
  });
});

describe("К07-104: an own example replaces every common one on the reference card", () => {
  it("only the own example, also with several commons", () => {
    const examples: CardExamples = { common: [general, example(4, "general")], personal: own("Mein Satz.") };
    expect(selectReferenceExamples(examples)).toEqual({ kind: "personal", personal: own("Mein Satz.") });
  });
  it("without an own example all commons in source order, none is none", () => {
    const pool = [example(5, "general"), general];
    expect(selectReferenceExamples({ common: pool, personal: null })).toEqual({ kind: "common", common: pool });
    expect(selectReferenceExamples({ common: [], personal: null })).toEqual({ kind: "common", common: [] });
  });
});
