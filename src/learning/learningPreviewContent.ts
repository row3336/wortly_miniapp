import type { LearningPreviewContent } from "../api/generated";
import { validReferenceCardContent } from "../study/referenceCardContent";

export { validCardExamples } from "../study/referenceCardContent";

/** Learning retains its eight eligible types; dictionary phrases grant no training access. */
export function validLearningPreviewContent(value: unknown, cardId: string, pair: string): value is LearningPreviewContent {
  return validReferenceCardContent(value, cardId, pair) && value.card.type !== "phrase";
}
