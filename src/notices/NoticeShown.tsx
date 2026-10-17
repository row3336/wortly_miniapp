import { useEffect } from "react";
import { noticeShown } from "./noticeJournal";

/**
 * c.screen(notice_shown) at the moment the summary with this notice is actually drawn (project notices §8; QA M1b P3):
 * rendered inside that summary, next to its notice line — not when a route is chosen or a read is started.
 */
export function NoticeShown({ noticeId }: { noticeId: string | null | undefined }) {
  useEffect(() => { if (noticeId) noticeShown(noticeId); }, [noticeId]);
  return null;
}
