import type { ScreenId } from "../../app/navigation";
import type { StudyDirection } from "../../i18n/messages";

/** Where the full card (М12) was opened from: the dictionary shows both directions, a quiz only its own (К07-055, К07-056). */
export type CardOrigin = { kind: "dictionary" } | { kind: "quiz"; direction: StudyDirection };

/**
 * The origin from the route the card returns to. root decision, pending owner (M-CARD Р7): the contract does not carry
 * the quiz direction; the written quiz is the main L1→De (Today starts written only for l1-de) and the oral quiz (М18)
 * goes German → translation. Every other source, Learning included, is the dictionary view of both directions.
 */
export function cardOrigin(source: ScreenId | null): CardOrigin {
  if (source === "written") return { kind: "quiz", direction: "l1-de" };
  if (source === "oral") return { kind: "quiz", direction: "de-l1" };
  return { kind: "dictionary" };
}

/**
 * The main written quiz moves on after an accepted exclude/relearn of its card (TA:153, К07-070, К07-079); a card of the
 * dictionary or of the oral quiz does not (К07-080). Only such a card reports its study action to the written quiz.
 */
export function movesWrittenQuiz(origin: CardOrigin): boolean {
  return origin.kind === "quiz" && origin.direction === "l1-de";
}
