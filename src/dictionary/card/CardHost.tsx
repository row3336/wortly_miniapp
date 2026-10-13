import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import type { DictionaryCardView, DictionaryCardViewResponse } from "../../api/generated";
import type { HttpOptions } from "../../api/http";
import { sameId } from "../../api/wireValidation";
import type { OpenedAccess } from "../../app/openedAccess";
import type { Language } from "../../i18n/language";
import type { ManualPendingStore } from "../../learning/manualPending";
import { useManualSelectionDocument, type ManualSelectionDocumentState } from "../../learning/useManualSelectionDocument";
import { CardActions } from "../actions/CardActions";
import type { CardActionApplied } from "../actions/cardActionsController";
import { useCardActions } from "../actions/useCardActions";
import { useDictionaryCardDocument } from "../useDictionaryCardDocument";
import { cardFieldSlots, type CardFieldSlots } from "../editors/CardFieldSlots";
import { useFieldEditors } from "../editors/useFieldEditors";
import { UnsavedLeaveDialog } from "../editors/UnsavedLeaveDialog";
import { OwnerCommonSlot } from "../owner/OwnerEditor";
import { useOwnerEditor } from "../owner/useOwnerEditor";
import { IntervalPanel } from "../IntervalPanel";
import { useDictionaryIntervalContext } from "../useDictionaryIntervalContext";
import { movesWrittenQuiz, viewOrigin, type CardOrigin } from "./cardOrigin";
import { CardScreen } from "./CardScreen";
import type { ManualControl } from "./CardStudyBlock";

export type CardContext = ReturnType<typeof useDictionaryIntervalContext>;
/** An accepted study action of this card: exclude/return/relearn (M-ACTIONS) or the manual increase and its undo (M-INTV). */
export type CardStudyEvent = CardActionApplied
  | { kind: "interval.increase" | "action.undo"; cardId: string; stateVersion: string };
/** Connection points of the packages that add their own controls to М12 (DESIGN M-CARD §7). */
export type CardExtensions = {
  /** Further controls under the card's own study actions (M-ACTIONS renders those itself). */
  renderActions?(view: DictionaryCardView): ReactNode;
  /** Replaces the interval window of the open card context (IntervalPanel, M-INTV). */
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
  /**
   * An accepted exclude/return/relearn of this card (M-ACTIONS): the source quiz may move on (TA:153). An accepted manual
   * increase or its undo (M-INTV): the source quiz reads its session again (Т08: the increase ends the earlier correction).
   */
  onStudyAction?(event: CardStudyEvent): void;
  /** The card's content was shown for the first time (an unavailable card or a failed read never is). */
  onShown?(): void;
  /** The core answered that the card is unavailable to this user: a final answer (a failed read never is one). */
  onRefused?(): void;
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

/** The owner's entries and editors follow the personal translation slot; their leave question shares the slot. */
function withOwner(slots: CardFieldSlots, owner: ReturnType<typeof useOwnerEditor>, language: Language,
  view: DictionaryCardView): CardFieldSlots {
  const dictionaryLanguage = view.content.pair.slice(0, 2) as "ru" | "uk" | "en";
  return { ...slots,
    translation: <>{slots.translation}
      <OwnerCommonSlot state={owner.state} actions={owner.actions} language={language} dictionaryLanguage={dictionaryLanguage} /></>,
    leave: slots.leave ?? (owner.state.leaveAsked
      ? <UnsavedLeaveDialog language={language} onContinue={owner.actions.continueEditing} onLeave={owner.actions.confirmLeave} />
      : null) };
}

/**
 * Mount one host per opened card route (keyed by the card). It owns the card read (/view, which also records the
 * history), the card context (context.open once the card is ready, context.close on Back — TA §7) and the manual
 * Learning choice (TA §6, К04-058, К04-072). Native Back of the card is its own: the same transition as the control.
 */
export function CardHost(props: CardHostProps) {
  const leaving = props.leaving === true;
  // Only an opening in the dictionary itself enters the history (2.26б.1, answer S02).
  const card = useDictionaryCardDocument({ access: props.access, transport: props.transport, cardId: props.cardId, enabled: !leaving,
    origin: viewOrigin(props.origin) });
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
  // M-INTV: an accepted own increase or undo reads the card again (its study block shows the server's new term) and tells
  // the source quiz. root decision, pending owner (M-INTV Р2): the quiz only reads its session again, it does not move on.
  const applied = context.state.applied;
  const { refresh: refreshCard } = card;
  const latestStudy = useRef(props.onStudyAction); latestStudy.current = props.onStudyAction;
  const reported = useRef<string | null>(null);
  useEffect(() => {
    if (applied === null || reported.current === applied.commandId) return;
    reported.current = applied.commandId;
    void refreshCard();
    latestStudy.current?.({ kind: applied.kind, cardId: props.cardId, stateVersion: applied.stateVersion });
  }, [applied, refreshCard, props.cardId]);
  const pending = context.state.pending;
  // An unknown open outcome that its status check could not settle is given up: the next open or document closes it.
  const settledOpen = pending?.kind !== "context.open" || pending.status === "unknown" && context.state.problem !== null
    && context.state.problem.reason !== "network";
  const finished = leaving && (settledOpen || left.current !== props.access);
  const { onClosed } = props;
  useEffect(() => { if (finished) onClosed?.(); }, [finished, onClosed]);

  const shown = (card.state.phase === "ready" || card.state.phase === "loading") && previous?.current.status === "available"
    ? previous.current : null;
  const viewed = shown !== null && !leaving;
  const latestShown = useRef(props.onShown); latestShown.current = props.onShown;
  useEffect(() => { if (viewed) latestShown.current?.(); }, [viewed]);
  const refused = card.state.phase === "unavailable" && !leaving;
  const latestRefused = useRef(props.onRefused); latestRefused.current = props.onRefused;
  useEffect(() => { if (refused) latestRefused.current?.(); }, [refused]);
  // Own fields (M-EDIT): saved through the open card context; an accepted or refused field command reads the card and
  // its context again (the save also ends the interval undo on the server, CT 2.3). Unsaved text asks before Back.
  const editors = useFieldEditors({ access: props.access, transport: props.transport, enabled: !leaving, view: shown,
    stateVersion: shown ? previous!.state_version : null,
    contextId: context.state.phase === "ready" ? context.state.context?.id ?? null : null,
    contextStateVersion: context.state.stateVersion, newId: props.newId,
    onChanged: () => { void card.refresh(); void context.actions.refresh(); }, onLeave: () => latestLeave.current() });
  // The owner's common data (R12-04…06, R14-01): «Изменить перевод для всех» and the allowed grammar, only for the owner
  // (K07-030). One editor and one command at a time across the personal and the common editors (M-EDIT Р2, Р13).
  const owner = useOwnerEditor({ access: props.access, transport: props.transport, enabled: !leaving, view: shown,
    stateVersion: shown ? previous!.state_version : null,
    contextId: context.state.phase === "ready" ? context.state.context?.id ?? null : null,
    blocked: !editors.state.canOpen, newId: props.newId,
    onChanged: () => { void card.refresh(); void context.actions.refresh(); }, onLeave: () => latestLeave.current() });
  // Screen Back and a managed exit ask first while a common change is unsaved, then while an own field is.
  const requestLeave = () => { if (!owner.actions.guardLeave()) editors.actions.requestLeave(); };
  const latestRequestLeave = useRef(requestLeave); latestRequestLeave.current = requestLeave;
  const latestProps = useRef(props); latestProps.current = props;
  // Study actions and the complaint (M-ACTIONS): root decision, pending owner (Р11) — every accepted or refused command reads
  // the card and its context again (they end the context's undo rights on the server, CT 2.3). root decision, pending owner (M-ACTIONS Р4): from the main
  // written quiz an accepted exclude/relearn leaves the card the managed way — the quiz then moves on (К07-070, К07-079);
  // from the dictionary and the oral quiz the card stays and shows its new state (К07-080).
  const studyActions = useCardActions({ access: props.access, transport: props.transport, enabled: !leaving, cardId: props.cardId,
    view: shown, stateVersion: shown ? previous!.state_version : null, newId: props.newId,
    onApplied: event => {
      const current = latestProps.current;
      current.onStudyAction?.(event);
      void card.refresh(); void context.actions.refresh();
      if (movesWrittenQuiz(current.origin) && event.kind !== "card.return") latestRequestLeave.current();
    },
    onChanged: () => { void card.refresh(); void context.actions.refresh(); } });
  if (leaving) return null;

  return <CardScreen language={props.language} phase={card.state.phase} problem={card.state.problem} view={shown}
    origin={props.origin} manual={manualControl(manual, props.cardId, card.state.phase === "ready")}
    actions={shown && <>
      <CardActions language={props.language} lemma={shown.content.card.lemma} document={studyActions} />
      {props.extensions?.renderActions?.(shown)}
    </>}
    // root decision, pending owner (M-INTV Р3): no increase from the oral quiz (RA:220, TA:132, К07-064), although the
    // dictionary context of its card offers it, neither the default window nor an extension; the dictionary and the main
    // written quiz show it (TA:149).
    interval={shown && (props.origin.kind === "dictionary" || movesWrittenQuiz(props.origin))
      && (props.extensions?.renderInterval ? props.extensions.renderInterval(shown, context)
        : <IntervalPanel language={props.language} context={context} enabled={!leaving} />)}
    fields={shown ? withOwner(cardFieldSlots({ state: { ...editors.state,
      canOpen: editors.state.canOpen && owner.state.open === null && !owner.state.busy,
      // One command at a time: the personal «Шаг назад» waits while the common editor is open or its save is under way.
      undo: editors.state.undo && (owner.state.open !== null || owner.state.busy)
        ? { ...editors.state.undo, canUndo: false, canRetry: false } : editors.state.undo },
    actions: editors.actions, view: shown, language: props.language }), owner, props.language, shown) : undefined}
    onBack={requestLeave} onRetry={() => { void card.refresh(); }} />;
}
