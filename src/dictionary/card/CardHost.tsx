import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import type { DictionaryCardView, DictionaryCardViewResponse } from "../../api/generated";
import type { HttpOptions } from "../../api/http";
import { sameId } from "../../api/wireValidation";
import type { OpenedAccess } from "../../app/openedAccess";
import type { Language } from "../../i18n/language";
import type { ManualPendingStore } from "../../learning/manualPending";
import { useManualSelectionDocument, type ManualSelectionDocumentState } from "../../learning/useManualSelectionDocument";
import { useDictionaryCardDocument } from "../useDictionaryCardDocument";
import { useDictionaryIntervalContext } from "../useDictionaryIntervalContext";
import type { CardOrigin } from "./cardOrigin";
import { CardScreen } from "./CardScreen";
import type { ManualControl } from "./CardStudyBlock";

export type CardContext = ReturnType<typeof useDictionaryIntervalContext>;
/** Connection points of the packages that add their own controls to М12 (DESIGN M-CARD §7). */
export type CardExtensions = {
  /** M-ACTIONS: exclude/return/relearn by view.card_actions and «Что не так?». */
  renderActions?(view: DictionaryCardView): ReactNode;
  /** M-INTV: the interval window of the open card context. */
  renderInterval?(view: DictionaryCardView, context: CardContext): ReactNode;
};

export type CardHostProps = {
  access: OpenedAccess;
  transport: HttpOptions;
  language: Language;
  /** The document's one durable slot of the manual Learning choice. */
  pendingStore: ManualPendingStore;
  cardId: string;
  origin: CardOrigin;
  newId?(): string;
  extensions?: CardExtensions;
  /**
   * Navigate back to the source; the host has already asked to close the card context. "after_open": the context.open
   * is not confirmed yet, so its close can only follow the confirmation — keep this same host mounted with `leaving`
   * until onClosed (M-CARD В6).
   */
  onBack(close: "sent" | "after_open"): void;
  /**
   * Native Back of the card route: the document's one screen-layer handler calls this slot, so the card's exit (with its
   * context.close) never depends on the order of back-layer registrations. Only the shown host fills it.
   */
  backSlot?: MutableRefObject<(() => void) | null>;
  /** Left by Back while its context.open was unconfirmed: no screen, no Back, no reads; only that close is awaited. */
  leaving?: boolean;
  /** The awaited close was started, or cannot follow any more (open refused or unresolved, access changed). */
  onClosed?(): void;
};

type ManualDocument = ReturnType<typeof useManualSelectionDocument>;

/** The command outcome of this card, with the state version of its own reply. */
function ownOutcome(state: ManualSelectionDocumentState, cardId: string) {
  const outcome = state.outcome;
  return outcome !== null && outcome.cardId !== null && sameId(outcome.cardId, cardId) ? outcome : null;
}

function manualControl({ state, actions }: ManualDocument, cardId: string, ready: boolean): ManualControl {
  const mine = state.pending !== null && sameId(state.pending.cardId, cardId);
  const status: ManualControl["status"] = mine
    ? state.canRetry ? "unknown" : state.phase === "sending" || state.phase === "checking" || state.phase === "loading" ? "sending" : "failed"
    : ownOutcome(state, cardId)?.status === "rejected" ? "failed" : "idle";
  return { status, enabled: ready && state.canChange,
    onChange: selected => { void actions.change(cardId, selected); },
    onRetry: () => { void actions.retry(cardId); } };
}

/**
 * Mount one host per opened card route (keyed by the card). It owns the card read (/view, which also records the
 * history), the card context (context.open once the card is ready, context.close on Back — TA §7) and the manual
 * Learning choice (TA §6, К04-058, К04-072). Native Back of the card is its own: the same transition as the control.
 */
export function CardHost(props: CardHostProps) {
  const leaving = props.leaving === true;
  const card = useDictionaryCardDocument({ access: props.access, transport: props.transport, cardId: props.cardId, enabled: !leaving });
  const pair = `${props.access.profile.dictionary_language}-de`;
  const last = useRef<DictionaryCardViewResponse | null>(null);
  if (card.state.phase === "ready" && card.state.data?.current.status === "available") last.current = card.state.data;
  // While the same card is read again its previous read stays visible; another pair's read never does (RA 6.1.14).
  const previous = last.current?.current.status === "available" && last.current.current.content.pair === pair ? last.current : null;
  const [opened, setOpened] = useState(false);
  useEffect(() => { if (card.state.phase === "ready") setOpened(true); }, [card.state.phase]);

  const manual = useManualSelectionDocument({ access: props.access, transport: props.transport, pendingStore: props.pendingStore,
    enabled: opened && !leaving, minimumStateVersion: previous?.state_version, newId: props.newId });
  // After this card's own manual command the card is read again in place (the previous read stays visible meanwhile):
  // the study block follows the new facts, the client never guesses them. A raised floor instead would first mask the
  // shown card as a stale read.
  const settled = ownOutcome(manual.state, props.cardId)?.commandId ?? null;
  const { refresh } = card;
  useEffect(() => { if (settled !== null) void refresh(); }, [settled, refresh]);

  // The access a Back left with: a later handle (foreground) must never bind, it would open a new context.
  const left = useRef<OpenedAccess | null>(null);
  // The context is opened once the card has been shown (useDictionaryIntervalContext host obligations).
  const context = useDictionaryIntervalContext({ access: props.access, transport: props.transport, cardId: props.cardId,
    enabled: opened && (left.current === null || left.current === props.access), minimumStateVersion: previous?.state_version,
    newId: props.newId });
  const leave = () => {
    // A managed exit closes the context first; its request starts before the route changes (OpenedAccess.run is synchronous up to fetch).
    // root decision, pending owner (M-CARD В6): an unconfirmed open keeps the close requested in the same controller, which
    // sends it right after the open is accepted (DictionaryIntervalController.settle/check); a refused open sends none.
    const awaiting = context.state.pending?.kind === "context.open";
    left.current = props.access;
    void context.actions.close();
    props.onBack(awaiting ? "after_open" : "sent");
  };
  const latestLeave = useRef(leave); latestLeave.current = leave;
  const { backSlot } = props;
  useLayoutEffect(() => {
    if (leaving || !backSlot) return;
    const run = () => latestLeave.current();
    backSlot.current = run;
    return () => { if (backSlot.current === run) backSlot.current = null; };
  }, [leaving, backSlot]);
  const pending = context.state.pending;
  // An unknown open outcome that its status check could not settle is given up: the next open or document closes it.
  const settledOpen = pending?.kind !== "context.open" || pending.status === "unknown" && context.state.problem !== null
    && context.state.problem.reason !== "network";
  const finished = leaving && (settledOpen || left.current !== props.access);
  const { onClosed } = props;
  useEffect(() => { if (finished) onClosed?.(); }, [finished, onClosed]);
  if (leaving) return null;

  const shown = (card.state.phase === "ready" || card.state.phase === "loading") && previous?.current.status === "available"
    ? previous.current : null;
  return <CardScreen language={props.language} phase={card.state.phase} problem={card.state.problem} view={shown}
    origin={props.origin} manual={manualControl(manual, props.cardId, card.state.phase === "ready")}
    actions={shown && props.extensions?.renderActions?.(shown)}
    interval={shown && props.extensions?.renderInterval?.(shown, context)}
    onBack={leave} onRetry={() => { void card.refresh(); }} />;
}
