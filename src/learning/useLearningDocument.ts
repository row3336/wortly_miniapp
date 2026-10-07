import { useMemo } from "react";
import { useStudyDocument, type StudyDocumentOptions } from "../commands/useStudyDocument";
import { notifyAcceptedMilestone } from "../platform/telegram";
import type { LearningActions } from "./LearningScreen";
import { LearningViewController, type LearningViewSnapshot } from "./learningViewController";

type Options = StudyDocumentOptions & {
  /** Seed from a confirmed Learning resume; null means explicit start is still required. */
  initialSessionId: string | null;
};
export type LearningDocumentActions = LearningActions & { start(): Promise<void> };

/** One owner per opened document and dictionary. Keep it mounted across routes so pending recovery survives. */
export function useLearningDocument(options: Options): { state: LearningViewSnapshot | null; actions: LearningDocumentActions } {
  // The seed is read once when the owner is created; a later seed never re-creates it.
  const study = useStudyDocument<Options, LearningViewController, LearningViewSnapshot>(options, null,
    (current, _seed, settings) => new LearningViewController({ ...settings, sessionId: current.initialSessionId,
      // К09-004 haptic signal; when it fires: root decision, pending owner (M-LEARN-FIN Р1–Р5).
      onLearningComplete: () => notifyAcceptedMilestone(window, "learning-complete") }));
  const actions = useMemo<LearningDocumentActions>(() => ({ ...study.actions,
    advancePreview: known => study.perform(controller => controller.advancePreview(known)),
    start: () => study.start(controller => controller.start()) }), [study.actions, study.perform, study.start]);
  return { state: study.state, actions };
}
