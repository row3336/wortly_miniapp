import type { CardExample, CardExamples, PersonalCardText } from "../api/generated";

/** Frozen candidates of the answered card (result.detail.examples), 0..n of each kind. */
export type AnswerExampleCandidates = {
  personal: readonly PersonalCardText[];
  common: readonly CardExample[];
};
/** The two mandatory common examples of an Akkusativ/Dativ preposition, addressed by role, not by order. */
export type WechselExamplePair = { location: CardExample; direction: CardExample };
export type AnswerExampleChoice =
  | { kind: "personal"; personal: PersonalCardText }
  | { kind: "common"; common: CardExample }
  | ({ kind: "wechsel_pair" } & WechselExamplePair)
  | { kind: "none" };

/** Current shape stores at most one personal example; any personal object, even with empty text, is present.
 * Takes already decoded CardExamples only: a legacy `examples: null` snapshot is not "no candidates". */
export function answerExampleCandidates(examples: CardExamples): AnswerExampleCandidates {
  return { personal: examples.personal === null ? [] : [examples.personal], common: examples.common };
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

/** К05-127 / К05-113: a card with both wechsel roles always shows both common examples, without random.
 * Personal entries here carry no case role, so they never form the full personal pair that could replace
 * them; that pair needs the role-aware storage of К07-121 and is not representable yet.
 * Otherwise owner decision C3-EXAMPLES-2 (К05-126): personal examples win, one random among them;
 * otherwise one random common. random is injected and called once only when two or more candidates compete.
 * No state, no repeat avoidance. Source objects are returned as is. */
export function selectAnswerExample(candidates: AnswerExampleCandidates, random: () => number): AnswerExampleChoice {
  const pair = wechselPair(candidates.common);
  if (pair) return { kind: "wechsel_pair", ...pair };
  if (candidates.personal.length > 0) return { kind: "personal", personal: pick(candidates.personal, random) };
  if (candidates.common.length > 0) return { kind: "common", common: pick(candidates.common, random) };
  return { kind: "none" };
}
