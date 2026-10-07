import type { LearningPreviewContent } from "../api/generated";

export function previewContent(cardId: string, pair: LearningPreviewContent["pair"] = "ru-de"): LearningPreviewContent {
  return { pair, card: { id: cardId, revision: "1", lemma: "Hallo", type: "particle", cefr: "A1" },
    translations: { common: ["Привет"], personal: null }, grammar: null, reference_conjugations: [],
    examples: { common: [], personal: null }, association: null };
}
