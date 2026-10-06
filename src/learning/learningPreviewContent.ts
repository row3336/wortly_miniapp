import type { LearningPreviewContent } from "../api/generated";
import { validReferenceCardContent } from "../study/referenceCardContent";

export { validCardExamples } from "../study/referenceCardContent";

/** Learning introduces words and phrases alike (K04-105); a phrase has no grammar block. */
export function validLearningPreviewContent(value: unknown, cardId: string, pair: string): value is LearningPreviewContent {
  return validReferenceCardContent(value, cardId, pair);
}
