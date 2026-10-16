import type { GateWait } from "../commands/gateWait";
import type { RemoteStopSnapshot } from "../study/remoteStopController";

/** Entry screen states. EntryController is their only producer; screens only render them. */
export type EntryState =
  | { kind: "checking" }
  | { kind: "opening" }
  | { kind: "pending" }
  // pause: the last reapply met a planned pause (503 MAINTENANCE, К14-021). It is the same refusal screen with the
  // same reapply button and the same saved command ID, plus a note; waitSeconds is the server's estimate (0 = passed).
  // closed: the second refusal in the profile's life ended reapplication (CT §6.3). The same refusal screen, calm
  // wording and no reapply button; it is also where a 403 ACCESS_REJECTED to a reapply lands, never "unavailable".
  // blocked (P03 §4.1 «Правило кнопки», K13; M-P03-10): the write gate does not let the reapply go right now — the button
  // stays visible and inactive, with the wait of §4.8 (wait); a click is never queued.
  | { kind: "rejected"; reason?: string; pause?: { waitSeconds?: number }; closed?: true; blocked?: true; wait?: GateWait }
  | { kind: "reapplying"; reason?: string }
  | { kind: "busy"; remoteTarget?: string }
  // A newer window of this installation took the document over (decision 2.3). Terminal: this window closes
  // itself; where it cannot (outside Telegram) it shows the busy screen without buttons until Q54 is answered.
  | { kind: "replaced" }
  // changed: another session took the place of the one the user meant to end (decision 2.13.2). The same screen
  // explains that and asks separately; the earlier tap never counts as the confirmation for the new target.
  | { kind: "remote_confirm"; targetId: string; changed?: true }
  | { kind: "remote"; remote: RemoteStopSnapshot }
  // recovery (P02-W К-11 / К-9а, P03 §4.10; M-P03-10): an internal flag of the same opened state — the screen and the
  // document stay, writes are shut by the write gate. recovering: waiting for the server (ВР-1, ВР-9, ВР-10); verifying: the
  // one recovery foreground is in flight (ВР-4, ВР-5). checking: the round of readbacks after ВР-6 has pending IDs (9.2.1).
  | { kind: "opened"; recovery?: "recovering" | "verifying"; wait?: GateWait; checking?: true }
  // 401 (AUTH_EXPIRED / AUTH_INVALID): the state of a new sign-in (CON §7.1 п.1, P03 §4.6; pending stay, К19-001).
  // reentry (C163/22.1-А, P03 AC-104, P02-W К-Т12о): the page has signed initData, so its button signs in again in the same
  // window — one auth, then the FIRST open of a new document (п.8б (2)); never the `unavailable` retry() (AC-102).
  // checkable: the button is active (the rule of the button, §4.1/C335: the gate lets the open go); wait: why not.
  | { kind: "expired"; reentry?: true; checkable?: true; wait?: GateWait }
  // This client's contract version is not served (К10-059/060): reading why is allowed, new writes are not.
  // No document is open; the screen offers only the update message (what else it shows is open, see DESIGN Q-H1).
  | { kind: "incompatible" }
  // route (P03 §4.13, by the facts of the gate): document — a manual check of the last working document (А); own — a check
  // foreground of this window's own document while another installation's occupancy is known (Б); blocked — the button
  // is visible and inactive until Я19 (В; the state then carries no route); profile — after a reapply refused with
  // 409 VERSION_CONFLICT the button reads the current profile again (one sign-in, no open; fix1). checkable: the button of А/Б is active (checkButtonActive, none in flight).
  // waiting: К-9 (or a first open held by the outage mark) — a wait screen without a button until ready and the hold end.
  | { kind: "unavailable"; route?: "document" | "own" | "profile" | "blocked"; checkable?: true; waiting?: true; wait?: GateWait }
  // The window closed for good by ВР-8 (identity) or ВР-8б (SESSION_BUSY on the recovery foreground), P03 §4.12: the
  // platform closes it; where it cannot, a line without buttons stays.
  | { kind: "closed"; reason: "identity" | "busy" }
  // P04 ред.14 §8: the profile is deleted (applied, already_applied or PROFILE_DELETED): the one-time result S-A07,
  // no automatic sign-in. deletion_unknown: AUTH_* after an unknown outcome of the deletion (PD-28): only an explicit
  // sign-in follows.
  | { kind: "profile_deleted" }
  | { kind: "deletion_unknown" };
