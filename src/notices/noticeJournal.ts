import type { ScreenEvent } from "../api/generated";
import { journalRecord } from "../journal/clientJournal";

/**
 * c.screen(notice_shown) (events ред.3.6.4 §4.5; project notices ed.2.4 §8): once the summary with a notice is shown, the
 * client names that notice — `notice`, `kind=notice_shown`, no cmd, code or grade (core 35c3844 ScreenEvent). The
 * guard below stays: it is true exactly while the generated contract carries the kind.
 */
type NoticeShownAccepted = "notice_shown" extends ScreenEvent["kind"] ? true : false;
export const NOTICE_SHOWN_ACCEPTED: NoticeShownAccepted = true;

/** The notices this page already named: one c.screen(notice_shown) per notice and page. */
const named = new Set<string>();

/** Called once the summary with this notice is on screen (never before, never without a notice). */
export function noticeShown(noticeId: string): void {
  const id = noticeId.toLowerCase();
  if (!NOTICE_SHOWN_ACCEPTED || named.has(id)) return;
  named.add(id);
  journalRecord({ ev: "c.screen", kind: "notice_shown", notice: id });
}

/** Tests only: forget what this page named. */
export function resetNoticeShown(): void { named.clear(); }
