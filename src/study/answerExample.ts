import type { CardExample, CardExamples, PersonalCardText, PrepositionCardExamples, PrepositionPair } from "../api/generated";

/** Frozen candidates of the answered card (result.detail.examples), 0..n of each kind. */
export type AnswerExampleCandidates = {
  personal: readonly PersonalCardText[];
  common: readonly CardExample[];
  /** The decoded К07-121 pair of a two-case preposition; absent in a snapshot issued before it existed. */
  pair?: PrepositionPair["effective"];
};
/** The two mandatory common examples of an Akkusativ/Dativ preposition, addressed by role, not by order. */
export type WechselExamplePair = { location: CardExample; direction: CardExample };
/** The full own pair of a two-case preposition, by case role. */
export type PersonalExamplePair = { akkusativ: PersonalCardText; dativ: PersonalCardText };
export type AnswerExampleChoice =
  | { kind: "personal"; personal: PersonalCardText }
  | { kind: "common"; common: CardExample }
  | ({ kind: "wechsel_pair" } & WechselExamplePair)
  | ({ kind: "personal_pair" } & PersonalExamplePair)
  | { kind: "none" };

/** Current shape stores at most one personal example; any personal object, even with empty text, is present.
 * Takes already decoded CardExamples only: a legacy `examples: null` snapshot is not "no candidates". */
export function answerExampleCandidates(examples: CardExamples | PrepositionCardExamples): AnswerExampleCandidates {
  const candidates: AnswerExampleCandidates = { personal: examples.personal === null ? [] : [examples.personal], common: examples.common };
  if ("preposition_pair" in examples) candidates.pair = examples.preposition_pair.effective;
  return candidates;
}

/** К05-127 marker: both wechsel roles among common examples, independent of the card type.
 * A single role is not a pair. */
export function hasWechselRoles(common: readonly CardExample[]): boolean {
  return common.some(example => example.role === "wechsel_location")
    && common.some(example => example.role === "wechsel_direction");
}

/** The pair addressed by role. One example per role is a storage invariant (examples_one_wechsel_role_idx);
 * a duplicate role is a corrupted snapshot and throws instead of picking one. */
export function wechselPair(common: readonly CardExample[]): WechselExamplePair | null {
  const location = common.filter(example => example.role === "wechsel_location");
  const direction = common.filter(example => example.role === "wechsel_direction");
  if (location.length > 1 || direction.length > 1) throw new RangeError("duplicate wechsel example role");
  return location.length === 1 && direction.length === 1 ? { location: location[0], direction: direction[0] } : null;
}

function pick<T>(pool: readonly T[], random: () => number): T {
  if (pool.length === 1) return pool[0];
  const r = random();
  if (typeof r !== "number" || !Number.isFinite(r) || r < 0 || r >= 1) throw new RangeError("random must return [0, 1)");
  return pool[Math.floor(r * pool.length)];
}

/** К05-127 / К07-121: a full own pair (the decoder accepts source "personal" only with both role texts)
 * replaces the common pair; otherwise a card with both wechsel roles shows both common examples, without random.
 * A single own example, or one own role, never replaces them.
 * Otherwise owner decision C3-EXAMPLES-2 (К05-126): personal examples win, one random among them;
 * otherwise one random common. random is injected and called once only when two or more candidates compete.
 * No state, no repeat avoidance. Source objects are returned as is. */
export function selectAnswerExample(candidates: AnswerExampleCandidates, random: () => number): AnswerExampleChoice {
  if (candidates.pair?.source === "personal") {
    return { kind: "personal_pair", akkusativ: candidates.pair.akkusativ, dativ: candidates.pair.dativ };
  }
  const pair = wechselPair(candidates.common);
  if (pair) return { kind: "wechsel_pair", ...pair };
  if (candidates.personal.length > 0) return { kind: "personal", personal: pick(candidates.personal, random) };
  if (candidates.common.length > 0) return { kind: "common", common: pick(candidates.common, random) };
  return { kind: "none" };
}

/** What the reference card shows (М07 and М12 share the rule, TA §6, §7). */
export type ReferenceExamples =
  | ({ kind: "personal_pair" } & PersonalExamplePair)
  | { kind: "personal"; personal: PersonalCardText }
  | { kind: "common"; common: readonly CardExample[] };

/** К07-104: an own example replaces every common one. К05-127 / К07-121 / Т16: a two-case preposition shows only its
 * effective pair — the full own pair, otherwise its two common wechsel examples, Akkusativ (direction) first; other
 * common examples and a single own example are not shown. A card with both wechsel roles but no pair key (an older
 * snapshot) shows the same two common examples. Without an own example all commons are shown in source order: no random
 * choice, no limit (К05-115). Input is already decoded; nothing is repaired.
 * root decision, pending owner (M-CARD QA question 2): the general examples of a two-case preposition stay hidden. */
export function selectReferenceExamples(examples: CardExamples | PrepositionCardExamples): ReferenceExamples {
  if ("preposition_pair" in examples) {
    const effective = examples.preposition_pair.effective;
    return effective.source === "personal"
      ? { kind: "personal_pair", akkusativ: effective.akkusativ, dativ: effective.dativ }
      : { kind: "common", common: [effective.akkusativ, effective.dativ] };
  }
  const pair = wechselPair(examples.common);
  if (pair) return { kind: "common", common: [pair.direction, pair.location] };
  return examples.personal === null
    ? { kind: "common", common: examples.common }
    : { kind: "personal", personal: examples.personal };
}
