import { useEffect, useMemo, useReducer, useRef } from "react";
import type { OpenedAccess } from "../app/openedAccess";
import { OralDocumentController, type OralDocumentOptions, type OralDocumentSnapshot, type OralPresentationTicket } from "./oralDocumentController";
import type { OralCommandLane } from "./oralPending";

export type OralDocumentHookOptions = Omit<OralDocumentOptions, "onUpdate" | "minimumStateVersion" | "terminalSessionIds" | "isLive" | "activity"> & {
  minimumStateVersion?: string;
};
export type OralDocumentActions = {
  refresh(): Promise<void>; start(bucket: "words" | "phrases"): Promise<void>;
  shown(ticket: OralPresentationTicket): Promise<void>; reveal(): Promise<void>; grade(correct: boolean): Promise<void>;
  stop(reason: "stop" | "summary_home"): Promise<void>; retry(lane: OralCommandLane): Promise<void>;
};
type Identity = Pick<OralDocumentHookOptions, "transport" | "studyStore" | "stopStore"> & { key: string };
type Retained = { identity: Identity; floor: string; terminal: Set<string>; closed: string | null };
type Owner = { identity: Identity; access: OpenedAccess; seed: string | null; controller: OralDocumentController; waiting: boolean };
function identity(options: OralDocumentHookOptions): Identity {
  const { access, transport, studyStore, stopStore } = options;
  return { key: JSON.stringify([access.key, access.profile.profile_id, access.document.clientInstanceId,
    access.document.documentId, access.document.epoch, access.profile.dictionary_language]), transport, studyStore, stopStore };
}
function same(left: Identity, right: Identity): boolean {
  return left.key === right.key && left.transport === right.transport && left.studyStore === right.studyStore && left.stopStore === right.stopStore;
}

/** React Adapter owns document lifetime only; the future renderer owns actual visible commit.
 * For the same identity it also re-supplies this identity's own confirmed terminal session address;
 * an active seed comes only from the composition after mode=oral. */
export function useOralDocument(options: OralDocumentHookOptions): { state: OralDocumentSnapshot | null; actions: OralDocumentActions } {
  const latest = useRef(options); latest.current = options;
  const owner = useRef<Owner | null>(null), retained = useRef<Retained | null>(null);
  const [, repaint] = useReducer((value: number) => value + 1, 0);
  const minimum = () => latest.current.minimumStateVersion ?? latest.current.access.profile.state_version;
  const remember = (snapshot: OralDocumentSnapshot, id: Identity) => {
    if (!retained.current || !same(retained.current.identity, id)) return;
    if (BigInt(snapshot.stateVersion) > BigInt(retained.current.floor)) retained.current.floor = snapshot.stateVersion;
    snapshot.terminalSessionIds.forEach(item => retained.current!.terminal.add(item));
    // Only the latest own session counts, and only while terminal; a null session (disposed) leaves the address.
    if (snapshot.sessionId !== null) retained.current.closed = snapshot.phase === "closed" ? snapshot.sessionId : null;
  };
  const lookup = () => {
    const bound = owner.current, current = latest.current;
    return bound && bound.access === current.access && bound.seed === current.initialSessionId
      && same(bound.identity, identity(current)) ? bound : null;
  };
  const find = useRef(lookup); find.current = lookup;
  useEffect(() => {
    const current = latest.current, id = identity(current);
    if (!current.access.isLive() || current.access.profile.access.status !== "admitted") return;
    if (!retained.current || !same(retained.current.identity, id)) {
      retained.current = { identity: id, floor: minimum(), terminal: new Set(), closed: null };
    }
    if (BigInt(minimum()) > BigInt(retained.current.floor)) retained.current.floor = minimum();
    // A possibly active props seed wins; otherwise this identity's own terminal session keeps its address.
    const saved = retained.current, terminal = (value: string) => saved.terminal.has(value.toLowerCase());
    const seed = current.initialSessionId;
    const effective = seed !== null && !terminal(seed) ? seed
      : saved.closed !== null && terminal(saved.closed) ? saved.closed : seed;
    let active = true;
    const controller = new OralDocumentController({ ...current, initialSessionId: effective, isLive: () => active && find.current() === bound,
      activity: () => ({ enabled: latest.current.enabled !== false,
        visible: !bound.waiting && document.visibilityState === "visible" }),
      minimumStateVersion: () => {
      const external = minimum(), saved = retained.current!;
      if (BigInt(external) > BigInt(saved.floor)) saved.floor = external;
      return saved.floor;
    }, terminalSessionIds: [...retained.current.terminal], onUpdate(snapshot) {
      if (!active || owner.current !== bound || find.current() !== bound) return;
      remember(snapshot, id); repaint();
    } });
    const bound: Owner = { identity: id, access: current.access, seed: current.initialSessionId, controller, waiting: false };
    owner.current = bound;
    const suspend = () => {
      if (!active || find.current() !== bound) return;
      bound.waiting = true;
      controller.setActivity({ enabled: latest.current.enabled !== false, visible: false });
    };
    document.addEventListener("visibilitychange", suspend, true);
    window.addEventListener("pageshow", suspend, true);
    if (document.visibilityState !== "visible") suspend();
    else controller.setActivity({ enabled: current.enabled !== false, visible: true });
    void controller.refresh(); repaint();
    return () => {
      document.removeEventListener("visibilitychange", suspend, true);
      window.removeEventListener("pageshow", suspend, true);
      active = false;
      remember(controller.snapshot(), id);
      controller.dispose();
      if (owner.current === bound) owner.current = null;
    };
  }, [options.access, options.transport, options.studyStore, options.stopStore, options.initialSessionId]);
  useEffect(() => {
    const bound = find.current();
    if (!bound) return;
    bound.controller.setActivity({ enabled: options.enabled !== false,
      visible: !bound.waiting && document.visibilityState === "visible" });
    if (!bound.waiting) void bound.controller.refresh();
  }, [options.enabled, options.minimumStateVersion]);
  const actions = useMemo<OralDocumentActions>(() => {
    const perform = (action: (controller: OralDocumentController) => Promise<void>) => {
      const bound = find.current();
      return bound ? action(bound.controller) : Promise.resolve();
    };
    return { refresh: () => perform(controller => controller.recheck()), start: bucket => perform(controller => controller.start(bucket)),
      shown: ticket => perform(controller => controller.shown(ticket)), reveal: () => perform(controller => controller.reveal()),
      grade: correct => perform(controller => controller.grade(correct)), stop: reason => perform(controller => controller.stop(reason)),
      retry: lane => perform(controller => controller.retry(lane)) };
  }, []);
  const bound = lookup();
  // Mask the replaced source on render, before passive effect cleanup can dispose it.
  const state = bound ? bound.controller.snapshot() : null;
  if (bound && state) remember(state, bound.identity);
  return { state, actions };
}
