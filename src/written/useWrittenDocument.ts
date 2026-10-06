import { useMemo } from "react";
import { useStudyDocument, type StudyDocumentOptions } from "../commands/useStudyDocument";
import { WrittenViewController, type WrittenViewSnapshot } from "./writtenViewController";

type Options = StudyDocumentOptions & {
  /** Only a resume read that confirmed mode=written supplies an open session of this client (В02). */
  initialSessionId?: string | null;
};
export type WrittenActions = Pick<WrittenViewController, "setDraft" | "submit" | "previousResult" | "next" | "grade" | "correct"
  | "retry" | "refresh" | "stop">
  & { start(bucket: "words" | "phrases"): Promise<void> };

/**
 * One owner per opened document, dictionary pair and resume seed. It stays mounted across routes so a durable receipt
 * is recovered by its ID. A seed only addresses the session: its step comes from the server projection, never from
 * the view of an earlier document.
 */
export function useWrittenDocument(options: Options): { state: WrittenViewSnapshot | null; actions: WrittenActions } {
  const study = useStudyDocument<Options, WrittenViewController, WrittenViewSnapshot>(options, options.initialSessionId ?? null,
    (_current, seed, settings) => new WrittenViewController({ ...settings, sessionId: seed }));
  const actions = useMemo<WrittenActions>(() => ({ ...study.actions,
    start: bucket => study.start(controller => controller.start(bucket)) }), [study.actions, study.start]);
  return { state: study.state, actions };
}
