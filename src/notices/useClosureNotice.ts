import { useEffect, useReducer, useRef } from "react";
import type { NoticeView } from "../api/generated";
import type { Language } from "../i18n/language";
import type { ClosureNotices } from "./noticeBoard";
import { answerLossLines } from "./NoticeScreen";

export type ClosureNotice = {
  /** The answer_loss of this closed session, once the board knows it. */
  notice: NoticeView | null;
  /** Its lines for the summary (9.2.7 / R2-05); null when there is no notice or no approved line in this language. */
  lines: string[] | null;
  /** The acknowledgement of the summary's «На Сегодня» is under way: the press waits. */
  leaving: boolean;
  /** «На Сегодня» of that summary: acknowledges the notice first (a failed ack keeps the summary), then `go`. */
  leave(go: () => void): void;
};

/**
 * answer_loss in the open window (project notices §6; Т2; CON §7.2 п.4 «если окно было открыто — показать там же»).
 * Only a session this owner closed by a Stop naming X or by the closure C reads GET /notices, once; the summary then
 * shows the notice's line and its «На Сегодня» acknowledges it. The summary that draws the line records
 * c.screen(notice_shown) itself (NoticeShown).
 */
export function useClosureNotice(options: { notices?: ClosureNotices; closed: { sessionId: string; reason: string | null } | null;
  unsavedClosures?: readonly string[]; language: Language; visible: boolean }): ClosureNotice {
  const { notices, closed, unsavedClosures, language, visible } = options;
  const read = useRef(new Set<string>());
  const leaving = useRef(false);
  const [, repaint] = useReducer((n: number) => n + 1, 0);
  const sessionId = closed?.sessionId.toLowerCase() ?? null;
  const relevant = !!notices && sessionId !== null && (closed!.reason === "stop" || closed!.reason === "save_failed")
    && !!unsavedClosures?.some(id => id.toLowerCase() === sessionId);
  useEffect(() => {
    if (!relevant || !sessionId || read.current.has(sessionId)) return;
    read.current.add(sessionId);
    notices!.read();
  }, [relevant, sessionId, notices]);
  const notice = relevant ? notices!.find(sessionId!) : null;
  const lines = notice ? answerLossLines(notice, language) : [];
  // c.screen(notice_shown) is the drawn summary's own (NoticeShown inside it), not this hook's: a route is no display.
  void visible;
  return {
    notice, lines: lines.length > 0 ? lines : null, leaving: leaving.current,
    leave(go) {
      if (!notice || !notices || !sessionId) { go(); return; }
      if (leaving.current) return;
      leaving.current = true; repaint();
      void notices.leave(sessionId).then(ok => { if (ok) go(); }).finally(() => { leaving.current = false; repaint(); });
    },
  };
}
