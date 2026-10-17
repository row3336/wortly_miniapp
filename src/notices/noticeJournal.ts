import type { ScreenEvent } from "../api/generated";
import { journalRecord } from "../journal/clientJournal";
import type { JournalEvent } from "../journal/events";

/**
 * c.screen(notice_shown) (events ed.3.6.3 §4.5; project notices ed.2.4 §8): once the summary with a notice is shown, the
 * client names that notice — `notice`, `kind=notice_shown`. The intake of core a2c29f4 does not accept it yet: its
 * ScreenEvent has no kind notice_shown and no field notice (api/models.py). Until the core's types carry both, this seam
 * stays closed and records nothing (M1b, after the core's intake): the constant below stops compiling the moment the
 * generated contract gains the kind, so the seam cannot be forgotten open or shut.
 */
type NoticeShownAccepted = "notice_shown" extends ScreenEvent["kind"] ? true : false;
// No cast here (C532): the day the generated kind appears, this assignment fails tsc with TS2322 and the seam must be opened.
export const NOTICE_SHOWN_ACCEPTED: NoticeShownAccepted = false;

/** Called by the notice screen once per shown notice; a no-op while the seam is closed. */
export function noticeShown(noticeId: string): void {
  if (!NOTICE_SHOWN_ACCEPTED) return;
  // M1b: events.ts must list kind notice_shown and the field notice before this record passes acceptedEvent.
  journalRecord({ ev: "c.screen", kind: "notice_shown", notice: noticeId } as unknown as JournalEvent);
}
