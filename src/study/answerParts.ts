import type { PublicAnswerSpec } from "../api/generated";

const content = /[\p{L}\p{M}\p{N}]/u;
const whitespace = /^[\p{White_Space}\u001c-\u001f]+$/u;
// Keep in-word hyphens/apostrophes together. Other punctuation and symbols can separate forms.
const tokens = /[^\p{White_Space}\u001c-\u001f\p{P}\p{S}]+(?:[-‐‑'’][^\p{White_Space}\u001c-\u001f\p{P}\p{S}]+)*/gu;
const prefixes: ReadonlyMap<string, readonly string[]> = new Map([
  ["Singular", ["der", "die", "das"]],
  ["Infinitiv", ["sich"]],
  ["Partizip II", ["hat", "ist"]],
  ["Superlativ", ["am"]],
]);

/** Approximate occupied parts from public shape only, never correctness or permission to submit.
 * Multiword forms are ambiguous without the private answer. Group common prefixes by the
 * current German label, without crossing an explicit separator or consulting a dictionary.
 */
export function estimateAnswerParts(spec: Pick<PublicAnswerSpec, "kind" | "labels" | "part_count">, text: string): number {
  if (spec.part_count === 0 || !content.test(text)) return 0;
  if (spec.kind !== "forms" || spec.part_count === 1) return 1;
  const words = text.matchAll(tokens);
  let word = words.next(), filled = 0;
  while (!word.done && filled < spec.part_count) {
    const item = word.value;
    word = words.next();
    if (!content.test(item[0])) continue;
    if (prefixes.get(spec.labels[filled])?.includes(item[0].toLowerCase()) && !word.done
      && content.test(word.value[0]) && whitespace.test(text.slice(item.index + item[0].length, word.value.index))) {
      word = words.next();
    }
    filled++;
  }
  return filled;
}
