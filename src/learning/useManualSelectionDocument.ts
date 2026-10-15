import { useEffect, useInsertionEffect, useMemo, useReducer, useRef } from "react";
import type { HttpOptions } from "../api/http";
import { version } from "../api/wireValidation";
import type { OpenedAccess } from "../app/openedAccess";
import { accessBoundLearningApi, accessBoundManualContext, manualPairOf } from "./accessBoundLearningApi";
import { createLearningApi, type LearningApi, type ManualIntent } from "./learningApi";
import type { ManualPendingStore } from "./manualPending";
import { ManualSelectionController, type ManualSelectionSnapshot } from "./manualSelectionController";

export type ManualSelectionDocumentOptions = {
  access: OpenedAccess;
  transport: HttpOptions;
  /** The shared durable slot; a new binding recovers its intent by status only. */
  pendingStore: ManualPendingStore;
  /** False while no card uses the action: no reads, and the stored intent waits for the next binding. */
  enabled: boolean;
  /** A confirmed version the host observed elsewhere, such as the card's own read. */
  minimumStateVersion?: string;
  newId?(): string;
};
type Reason = NonNullable<ManualSelectionSnapshot["problem"]>["reason"] | "stale";
export type ManualSelectionDocumentState = {
  phase: ManualSelectionSnapshot["phase"] | "idle";
  problem: { reason: Reason; code?: string } | null;
  /** The one unresolved intent. It blocks changes on every card; retry belongs to this card only. */
  pending: { cardId: string; kind: ManualIntent["kind"] } | null;
  /** Raise the card's minimum state version to stateVersion; it is not a source of card content. */
  outcome: { commandId: string; cardId: string | null; status: "accepted" | "rejected"; code?: string; stateVersion: string | null } | null;
  canChange: boolean;
  canRetry: boolean;
};
export type ManualSelectionDocumentActions = {
  change(cardId: string, selected: boolean): Promise<void>;
  /** Repeats the stored command only when cardId is the pending intent's card. */
  retry(cardId: string): Promise<void>;
  refresh(): Promise<void>;
};
type Owner = {
  access: OpenedAccess; transport: HttpOptions; store: ManualPendingStore;
  controller: ManualSelectionController;
  /** Card of each command this binding sent or checked; memory only. */
  cards: Map<string, string>;
  /** Top-level state_version of this binding's own latest reply per command, whatever its current carries. */
  versions: Map<string, string>;
};

/** Known state per profile; it only rises, and a switch to another profile cannot lower it. */
function raise(floors: Map<string, string>, profileId: string, observed: string | undefined): void {
  if (observed === undefined) return;
  const known = floors.get(profileId);
  if (known === undefined || BigInt(observed) > BigInt(known)) floors.set(profileId, observed);
}

function binding(current: ManualSelectionDocumentOptions, bound: Owner | null, suspended: WeakSet<OpenedAccess>): Owner | null {
  return bound && current.enabled && current.access === bound.access && current.transport === bound.transport
    && current.pendingStore === bound.store && current.access.isLive() && current.access.profile.access.status === "admitted"
    && !suspended.has(current.access) && document.visibilityState === "visible" ? bound : null;
}

function masked(phase: ManualSelectionDocumentState["phase"], problem: ManualSelectionDocumentState["problem"] = null): ManualSelectionDocumentState {
  return { phase, problem, pending: null, outcome: null, canChange: false, canRetry: false };
}

function present(bound: Owner, floor: string): ManualSelectionDocumentState {
  const snapshot = bound.controller.snapshot();
  // A read older than a confirmed version is not permission to change.
  const stale = snapshot.data !== null && BigInt(snapshot.data.state_version) < BigInt(floor);
  const outcome = snapshot.outcome;
  return {
    phase: stale && snapshot.phase === "ready" ? "blocked" : snapshot.phase,
    problem: snapshot.problem ?? (stale ? { reason: "stale" } : null),
    pending: snapshot.pending ? { cardId: snapshot.pending.intent.payload.card_id, kind: snapshot.pending.intent.kind } : null,
    outcome: outcome ? { ...outcome, cardId: bound.cards.get(outcome.commandId) ?? null,
      stateVersion: bound.versions.get(outcome.commandId) ?? null } : null,
    canChange: snapshot.canChange && !stale,
    canRetry: snapshot.canRetry,
  };
}

/** One manual-selection controller per opened access handle, transport and store. The host owns UI and refresh moments. */
export function useManualSelectionDocument(options: ManualSelectionDocumentOptions): {
  state: ManualSelectionDocumentState; actions: ManualSelectionDocumentActions;
} {
  manualPairOf(options.access);
  // Render only reads these refs: an interrupted or suspended render must not change the current binding or a floor.
  const latest = useRef(options), owner = useRef<Owner | null>(null);
  const floors = useRef(new Map<string, string>()), suspended = useRef(new WeakSet<OpenedAccess>());
  const [, repaint] = useReducer((value: number) => value + 1, 0);
  const profile = options.access.profile;
  let floor = floors.current.get(profile.profile_id) ?? profile.state_version;
  for (const observed of [profile.state_version, options.minimumStateVersion]) {
    if (observed === undefined) continue;
    if (!version(observed)) throw new Error("invalid manual selection state version");
    if (BigInt(observed) > BigInt(floor)) floor = observed;
  }
  // The commit makes these options current, before any layout effect of a consumer or its children,
  // so a callback in the commit window cannot reach the previous controller or its credentials.
  useInsertionEffect(() => {
    latest.current = options;
    raise(floors.current, options.access.profile.profile_id, floor);
  });
  const find = useRef(() => binding(latest.current, owner.current, suspended.current));
  const committedFloor = useRef(() => {
    const current = latest.current.access.profile;
    return floors.current.get(current.profile_id) ?? current.state_version;
  });

  useEffect(() => {
    // Capture runs before App's foreground listener; only a new access handle restores rights.
    const suspend = () => { suspended.current.add(latest.current.access); repaint(); };
    document.addEventListener("visibilitychange", suspend, true);
    window.addEventListener("pageshow", suspend, true);
    return () => {
      document.removeEventListener("visibilitychange", suspend, true);
      window.removeEventListener("pageshow", suspend, true);
    };
  }, []);

  useEffect(() => {
    const current = latest.current, access = current.access;
    if (document.visibilityState !== "visible") suspended.current.add(access);
    if (!current.enabled || !access.isLive() || access.profile.access.status !== "admitted" || suspended.current.has(access)) return;
    let active = true;
    const live = () => active && find.current() === bound;
    const gated = accessBoundLearningApi({ access, api: createLearningApi(current.transport), isCurrent: live });
    const remember = (intent: ManualIntent) => { bound.cards.set(intent.command_id, intent.payload.card_id); };
    // Only a reply the gate let through is recorded: never one of an obsolete binding.
    const record = <T extends { state_version: string }>(commandId: string, reply: T): T => {
      bound.versions.set(commandId, reply.state_version);
      return reply;
    };
    const api: LearningApi = {
      get: token => gated.get(token),
      change: async (token, proof, command) => { remember(command); return record(command.command_id, await gated.change(token, proof, command)); },
      status: async (token, intent, ticket) => { remember(intent); return record(intent.command_id, await gated.status(token, intent, ticket)); },
    };
    const controller = new ManualSelectionController({ api, pendingStore: current.pendingStore,
      context: accessBoundManualContext(access),
      newId: () => latest.current.newId?.() ?? window.crypto.randomUUID(),
      onUpdate(snapshot) {
        if (!live()) return;
        const profileId = access.profile.profile_id;
        raise(floors.current, profileId, snapshot.data?.state_version);
        if (snapshot.outcome) raise(floors.current, profileId, bound.versions.get(snapshot.outcome.commandId));
        repaint();
      }, gate: current.transport.gate });
    const bound: Owner = { access, transport: current.transport, store: current.pendingStore, controller, cards: new Map(), versions: new Map() };
    owner.current = bound;
    // Opening and a foreground handle only read; a stored intent is checked by status, never re-sent.
    void controller.refresh();
    return () => { active = false; controller.dispose(); if (owner.current === bound) owner.current = null; };
  }, [options.access, options.transport, options.pendingStore, options.enabled]);

  useEffect(() => {
    // A raised confirmed version re-reads once; a still older reply waits for an explicit refresh.
    const bound = find.current();
    if (!bound) return;
    const snapshot = bound.controller.snapshot();
    if (snapshot.phase === "ready" && snapshot.data && BigInt(snapshot.data.state_version) < BigInt(committedFloor.current())) {
      void bound.controller.refresh();
    }
  }, [options.minimumStateVersion]);

  const actions = useMemo<ManualSelectionDocumentActions>(() => {
    const view = () => {
      const bound = find.current();
      return bound ? { bound, state: present(bound, committedFloor.current()) } : null;
    };
    return {
      change(cardId, selected) {
        const current = view();
        return current?.state.canChange ? current.bound.controller.change(cardId, selected) : Promise.resolve();
      },
      retry(cardId) {
        const current = view(), pending = current?.state.pending;
        return current?.state.canRetry && pending && typeof cardId === "string" && pending.cardId.toLowerCase() === cardId.toLowerCase()
          ? current.bound.controller.retry() : Promise.resolve();
      },
      refresh: () => find.current()?.controller.refresh() ?? Promise.resolve(),
    };
  }, []);

  const bound = binding(options, owner.current, suspended.current);
  if (bound) return { state: present(bound, floor), actions };
  if (!options.enabled) return { state: masked("idle"), actions };
  if (!options.access.isLive() || options.access.profile.access.status !== "admitted") {
    // A denial through this binding stays visible; a closed handle is not a new refusal.
    const denied = owner.current?.access === options.access ? owner.current.controller.snapshot().problem : null;
    return { state: denied && (denied.reason === "expired" || denied.reason === "forbidden") ? masked("blocked", denied) : masked("disposed"), actions };
  }
  return { state: masked("loading"), actions };
}
