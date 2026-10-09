import type { Entry, ScreenId } from "../../app/navigation";
import type { StudyDirection } from "../../i18n/messages";
import type { DictionaryViewOrigin } from "../viewApi";

/**
 * Where the full card (М12) was opened from: the dictionary shows both directions, a quiz only its own (К07-055, К07-056).
 * A card from a bot message (`via: "message"`, answer S01) is the dictionary view with the rights of an ordinary opening,
 * whatever screen lies under it; it is not an opening in the dictionary itself (answer S02).
 */
export type CardOrigin = { kind: "dictionary"; via?: "message" } | { kind: "quiz"; direction: StudyDirection };

/**
 * The origin from the route the card returns to. root decision, pending owner (M-CARD Р7): the contract does not carry
 * the quiz direction; the written quiz is the main L1→De (Today starts written only for l1-de) and the oral quiz (М18)
 * goes German → translation. Learning, like every section, is the dictionary view of both directions (kept as is).
 * The switch is exhaustive: a new ScreenId fails compilation here, so a new card entry point cannot silently become a
 * dictionary opening (which would write it into the history, 2.26б.1) — its origin must be chosen explicitly.
 */
export function cardOrigin(source: ScreenId | null, entry?: Entry): CardOrigin {
  // A card opened from a bot message over a quiz takes none of that quiz's rights (answer S01).
  if (entry === "message") return { kind: "dictionary", via: "message" };
  if (source === null) return { kind: "dictionary" };
  switch (source) {
    case "written":
      return { kind: "quiz", direction: "l1-de" };
    case "oral":
      return { kind: "quiz", direction: "de-l1" };
    case "dictionary":
    case "learning":
    case "conjugation":
    case "today":
    case "card":
    case "statistics":
    case "settings":
      return { kind: "dictionary" };
    default:
      return assertNever(source);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unclassified card source: ${String(value)}`);
}

/**
 * The main written quiz moves on after an accepted exclude/relearn of its card (TA:153, К07-070, К07-079); a card of the
 * dictionary or of the oral quiz does not (К07-080). Only such a card reports its study action to the written quiz.
 */
export function movesWrittenQuiz(origin: CardOrigin): boolean {
  return origin.kind === "quiz" && origin.direction === "l1-de";
}

/**
 * The origin of the card read: only an opening in the dictionary itself enters the history (answer S02). A quiz card
 * («Уточнить поля», a complaint from the quiz) is "study" (2.26б.1), a card from a bot message is "message"; neither
 * is recorded, and only "study" claims the quiz visibility.
 */
export function viewOrigin(origin: CardOrigin): DictionaryViewOrigin {
  if (origin.kind === "quiz") return "study";
  return origin.via === "message" ? "message" : "dictionary";
}
