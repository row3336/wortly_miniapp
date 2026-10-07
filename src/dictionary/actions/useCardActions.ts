import { useEffect, useInsertionEffect, useMemo, useReducer, useRef, useState } from "react";
import type { DictionaryCardView } from "../../api/generated";
import type { HttpOptions } from "../../api/http";
import { useBackLayer } from "../../app/navigationBack";
import { ClosedAccessError, type OpenedAccess } from "../../app/openedAccess";
import type { FeedbackSnapshot } from "../../feedback/feedbackController";
import { memoryFeedbackPendingStore } from "../../feedback/feedbackPending";
import { useFeedbackDocument } from "../../feedback/useFeedbackDocument";
import { createCardActionApi, type CardActionApi } from "./cardActionApi";
import {
  CardActionsController, type CardActionApplied, type CardActionsCard, type CardActionsPort, type CardActionsSnapshot,
} from "./cardActionsController";

/**
 * Host obligations:
 * - pass the opened access of this document; a foreground gives a new handle, which continues the same command;
 * - view/stateVersion: the shown card read (its card_actions and facts.exclusion.version);
 * - onApplied: read the card and its context again and perform the transition of the accepted action (TA:153);
 * - onChanged: read the card and its context again (a refusal, a confirmed complaint).
 */
export type CardActionsOptions = {
  access: OpenedAccess;
  transport: HttpOptions;
  /** false for a card host that is only leaving (M-CARD В6): it shows nothing and must not hold native Back. */
  enabled?: boolean;
  /** The card of this host: a complaint attaches it (К07-051). */
  cardId: string;
  view: DictionaryCardView | null;
  stateVersion: string | null;
  newId?(): string;
  onApplied(event: CardActionApplied): void;
  onChanged(): void;
};
export type CardComplaintState = {
  /** The window «Сообщить об ошибке» is open (RA table 6.1.12). */
  open: boolean;
  /** The last complaint was confirmed by the server and its window closed (К07-053), until the next action. */
  sent: boolean;
  form: FeedbackSnapshot;
};
export type CardActionsHandlers = {
  exclude(): void;
  restore(): void;
  askRelearn(): void;
  cancelRelearn(): void;
  confirmRelearn(): void;
  retry(): void;
  openComplaint(): void;
  closeComplaint(): void;
  editComplaint(text: string): void;
  sendComplaint(): void;
  retryComplaint(): void;
};
export type CardActionsDocument = { state: CardActionsSnapshot; complaint: CardComplaintState; actions: CardActionsHandlers };

/** The card read as the action controller needs it; only its hint and versions, never the content. */
function cardOf(view: DictionaryCardView, stateVersion: string): CardActionsCard {
  return { cardId: view.content.card.id, stateVersion, exclusionVersion: view.study.facts.exclusion.version,
    actions: { ...view.card_actions } };
}

/** Every request through the access handle current at its start; an obsolete handle fails before it can deny access. */
function accessPort(latest: { current: CardActionsOptions }, api: () => CardActionApi, mounted: { current: boolean }): CardActionsPort {
  const bound = <T>(operation: (api: CardActionApi, token: string, proof: string) => Promise<T>): Promise<T> => {
    const access = latest.current.access;
    const requireCurrent = () => { if (latest.current.access !== access) throw new ClosedAccessError(); };
    return access.run(async ({ token, proof }) => {
      requireCurrent();
      try {
        const result = await operation(api(), token, proof);
        requireCurrent();
        return result;
      } catch (error) {
        requireCurrent();
        throw error;
      }
    });
  };
  return {
    origin() {
      const access = latest.current.access;
      // An unmounted card sends nothing more; a reply already under way only updates memory nobody shows.
      return mounted.current && access.isLive() && access.profile.access.status === "admitted"
        ? { client_instance_id: access.document.clientInstanceId, document_id: access.document.documentId } : null;
    },
    send: command => bound((current, token, proof) => current.send(token, proof, command)),
    status: command => bound((current, token, proof) => current.status(token, proof, command)),
  };
}

/** The study actions and the complaint of one open card (TA §7). One owner per mounted card host; memory only. */
export function useCardActions(options: CardActionsOptions): CardActionsDocument {
  const latest = useRef(options);
  useInsertionEffect(() => { latest.current = options; });
  const [, repaint] = useReducer((value: number) => value + 1, 0);
  const api = useMemo(() => createCardActionApi(options.transport), [options.transport]);
  const currentApi = useRef(api); currentApi.current = api;
  // Mounted, not disposed: StrictMode's synchronous unmount and remount must keep the same controller.
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const owner = useRef<CardActionsController | null>(null);
  if (owner.current === null) {
    owner.current = new CardActionsController({
      port: accessPort(latest, () => currentApi.current, mounted),
      newId: () => latest.current.newId?.() ?? window.crypto.randomUUID(),
      onUpdate: () => { if (mounted.current) repaint(); },
      onApplied: event => { if (mounted.current) latest.current.onApplied(event); },
      onRefused: () => { if (mounted.current) latest.current.onChanged(); },
    });
  }
  const controller = owner.current;
  // A new handle of the same document: an unresolved command is checked by its own ID (CON:149).
  useEffect(() => { void controller.resume(); }, [controller, options.access]);

  const view = options.view, stateVersion = options.stateVersion;
  const card = view !== null && stateVersion !== null ? JSON.stringify(cardOf(view, stateVersion)) : null;
  useEffect(() => { if (card !== null) controller.setCard(JSON.parse(card) as CardActionsCard); }, [controller, card]);

  // root decision, pending owner (M-ACTIONS Р7): the complaint of this card lives only in memory.
  const [complaintStore] = useState(memoryFeedbackPendingStore);
  const feedback = useFeedbackDocument({ access: options.access, transport: options.transport, pendingStore: complaintStore,
    cardId: options.cardId });
  // root decision, pending owner (M-ACTIONS Р6, В6): closing the window keeps the typed text in memory while the card is
  // open, and leaving the card does not ask about it (the leave question is for own fields only, К07-039).
  const [open, setOpen] = useState(false);
  // root decision, pending owner (M-ACTIONS Р8, В4): «Сообщение отправлено» stays until the next action on the card.
  const [sent, setSent] = useState(false);
  // Only a new confirmation closes the window: a confirmed form stays "confirmed" until the next edit.
  const confirmed = feedback.state.confirmed;
  const wasConfirmed = useRef(confirmed);
  useEffect(() => {
    const previous = wasConfirmed.current;
    wasConfirmed.current = confirmed;
    if (!confirmed || previous) return;
    setOpen(false); setSent(true);
    latest.current.onChanged();
  }, [confirmed]);

  const snapshot = controller.snapshot();
  const enabled = options.enabled !== false;
  // Native Back closes an open window first (overlay layer), as its own close control does.
  useBackLayer("overlay", !enabled ? null : snapshot.confirming ? () => controller.cancelRelearn()
    : open ? () => setOpen(false) : null);

  const actions = useMemo<CardActionsHandlers>(() => ({
    exclude: () => { setSent(false); void controller.exclude(); },
    restore: () => { setSent(false); void controller.restore(); },
    askRelearn: () => { setSent(false); controller.askRelearn(); },
    cancelRelearn: () => controller.cancelRelearn(),
    confirmRelearn: () => { void controller.confirmRelearn(); },
    retry: () => { void controller.retry(); },
    openComplaint: () => { setSent(false); setOpen(true); },
    closeComplaint: () => setOpen(false),
    editComplaint: text => feedback.actions.edit(text),
    sendComplaint: () => { void feedback.actions.send(); },
    retryComplaint: () => { void feedback.actions.retry(); },
  }), [controller, feedback.actions]);

  return { state: snapshot, complaint: { open: open && enabled, sent, form: feedback.state }, actions };
}
