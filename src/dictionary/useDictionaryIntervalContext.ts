import { useEffect, useInsertionEffect, useMemo, useReducer, useRef } from "react";
import type { HttpOptions } from "../api/http";
import { uuid, version } from "../api/wireValidation";
import { ClosedAccessError, type OpenedAccess } from "../app/openedAccess";
import {
  DictionaryIntervalController, sendDictionaryIntervalCommand,
  type DictionaryIntervalHandoff, type DictionaryIntervalPort, type DictionaryIntervalSnapshot,
} from "./dictionaryIntervalController";
import { createDictionaryIntervalApi, type DictionaryIntervalApi, type IntervalChoice } from "./intervalApi";

/**
 * Host obligations:
 * - pass the opened Entry access; a foreground gives a new handle, which resumes the same document's context;
 * - enabled while the dictionary card screen (M12) of cardId is open, after the card is ready; enabled=false does no IO;
 * - call actions.close() on a managed exit from that card (Back or route change); closing the interval window or
 *   another editor inside the card does not call it (CON:147); unmount and access change only dispose, without a request;
 * - render from state only: canIncrease/canUndo/canRetry, problem.code as text; never compute versions or dates;
 * - one hook per installation and card at a time (a new context closes the previous one on the server).
 */
export type DictionaryIntervalContextOptions = {
  access: OpenedAccess;
  transport: HttpOptions;
  cardId: string;
  enabled: boolean;
  /** A confirmed version observed elsewhere in this document, such as the card's own read. */
  minimumStateVersion?: string;
  newId?(): string;
};
export type DictionaryIntervalContextActions = {
  /** Throws synchronously for a choice outside the current offer; a second tap while pending does nothing. */
  increase(choice: IntervalChoice): Promise<void>;
  undo(): Promise<void>;
  /** The same unresolved command, only when state.canRetry. */
  retry(): Promise<void>;
  close(): Promise<void>;
  refresh(): Promise<void>;
};
type Owner = {
  access: OpenedAccess; transport: HttpOptions; cardId: string; document: string; controller: DictionaryIntervalController;
  /** Managed exit requested for this binding, possibly while it could not send: it never resumes or hands off. */
  closed: boolean;
};
type Saved = { document: string; handoff: DictionaryIntervalHandoff };

/** Every request through one access handle; an obsolete binding fails before access.run can treat its 401/403 as a denial. */
export function accessBoundIntervalPort(options: { access: OpenedAccess; api: DictionaryIntervalApi; isCurrent(): boolean }): DictionaryIntervalPort {
  const { access, api } = options;
  const bound = <T>(operation: (credentials: { token: string; proof: string }) => Promise<T>): Promise<T> => {
    const requireCurrent = () => { if (!options.isCurrent()) throw new ClosedAccessError(); };
    return access.run(async credentials => {
      requireCurrent();
      try {
        const result = await operation(credentials);
        requireCurrent();
        return result;
      } catch (error) {
        requireCurrent();
        throw error;
      }
    });
  };
  return {
    origin: { client_instance_id: access.document.clientInstanceId, document_id: access.document.documentId },
    send: command => bound(({ token, proof }) => sendDictionaryIntervalCommand(api, token, proof, command)),
    read: address => bound(({ token, proof }) => api.readContext(token, proof, address)),
    status: command => bound(({ token, proof }) => api.commandStatus(token, proof, command)),
  };
}

function documentKey(access: OpenedAccess): string {
  return JSON.stringify([access.profile.profile_id, access.document.clientInstanceId, access.document.documentId,
    access.document.epoch, access.profile.dictionary_language]);
}
function admitted(access: OpenedAccess): boolean {
  return access.isLive() && access.profile.access.status === "admitted";
}
function binding(current: DictionaryIntervalContextOptions, bound: Owner | null, suspended: WeakSet<OpenedAccess>): Owner | null {
  // Identity of the handle object, not its key: a same-key successor must not reach the old controller.
  return bound && current.enabled && current.access === bound.access && current.transport === bound.transport
    && current.cardId.toLowerCase() === bound.cardId && admitted(current.access) && !suspended.has(current.access)
    && document.visibilityState === "visible" ? bound : null;
}
function masked(phase: DictionaryIntervalSnapshot["phase"], cardId: string): DictionaryIntervalSnapshot {
  return { phase, cardId: cardId.toLowerCase(), context: null, view: null, interval: null,
    capabilities: { interval_increase: null, undo_offer: null, undo_target: null }, pending: null, problem: null, stateVersion: null,
    canIncrease: false, canUndo: false, canRetry: false };
}
function raise(floors: Map<string, string>, profileId: string, observed: string | null | undefined): void {
  if (observed === null || observed === undefined) return;
  const known = floors.get(profileId);
  if (known === undefined || BigInt(observed) > BigInt(known)) floors.set(profileId, observed);
}

/** One dictionary interval context per access handle, transport and card. The host owns the window and its close. */
export function useDictionaryIntervalContext(options: DictionaryIntervalContextOptions): {
  state: DictionaryIntervalSnapshot; actions: DictionaryIntervalContextActions;
} {
  if (!uuid(options.cardId)) throw new Error("dictionary card ID required");
  for (const observed of [options.access.profile.state_version, options.minimumStateVersion]) {
    if (observed !== undefined && !version(observed)) throw new Error("invalid dictionary state version");
  }
  // Render only reads refs: an interrupted or suspended render changes no binding, floor or credentials.
  const latest = useRef(options), owner = useRef<Owner | null>(null), saved = useRef<Saved | null>(null);
  const floors = useRef(new Map<string, string>()), suspended = useRef(new WeakSet<OpenedAccess>());
  const [, repaint] = useReducer((value: number) => value + 1, 0);
  // Commit makes these options current before any layout effect, so a callback in the commit→passive
  // window finds no binding instead of the previous controller and its access.
  useInsertionEffect(() => {
    latest.current = options;
    const profile = options.access.profile;
    raise(floors.current, profile.profile_id, profile.state_version);
    raise(floors.current, profile.profile_id, options.minimumStateVersion);
  });
  const find = useRef(() => binding(latest.current, owner.current, suspended.current));

  useEffect(() => {
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
    if (!current.enabled || !admitted(access) || suspended.current.has(access)) return;
    let active = true;
    const live = () => active && find.current() === bound;
    const profileId = access.profile.profile_id;
    const controller = new DictionaryIntervalController({
      port: accessBoundIntervalPort({ access, api: createDictionaryIntervalApi(current.transport), isCurrent: live }),
      isLive: live,
      newId: () => latest.current.newId?.() ?? window.crypto.randomUUID(),
      minimumStateVersion: () => floors.current.get(profileId) ?? null,
      onUpdate(snapshot) {
        if (!live()) return;
        raise(floors.current, profileId, snapshot.stateVersion);
        repaint();
      },
    });
    const bound: Owner = { access, transport: current.transport, cardId: current.cardId.toLowerCase(),
      document: documentKey(access), controller, closed: false };
    owner.current = bound;
    const previous = saved.current;
    const resume = previous && previous.document === bound.document && previous.handoff.cardId === bound.cardId ? previous.handoff : null;
    let started = false;
    // StrictMode's synchronous unmount ends the first binding before this microtask: one context.open.
    queueMicrotask(() => {
      if (!live() || bound.closed) return;
      started = true;
      void (resume ? controller.resume(resume) : controller.open(bound.cardId));
    });
    repaint();
    return () => {
      active = false;
      // A binding that never started keeps the previous handoff; memory only, no durable pending (REQ_MATRIX §4).
      if (bound.closed) saved.current = null;
      else if (started) {
        const handoff = controller.handoff();
        saved.current = handoff ? { document: bound.document, handoff } : null;
      }
      controller.dispose();
      if (owner.current === bound) owner.current = null;
    };
  }, [options.access, options.transport, options.cardId.toLowerCase(), options.enabled]);

  useEffect(() => {
    // A raised confirmed version re-reads once; an older context then stays hidden.
    const bound = find.current();
    if (bound && bound.controller.snapshot().problem?.reason === "stale_response") void bound.controller.refresh();
  }, [options.minimumStateVersion]);

  const actions = useMemo<DictionaryIntervalContextActions>(() => ({
    increase: choice => find.current()?.controller.increase(choice) ?? Promise.resolve(),
    undo: () => find.current()?.controller.undo() ?? Promise.resolve(),
    retry: () => find.current()?.controller.retry() ?? Promise.resolve(),
    close: () => {
      // CON:147: a managed exit removes the previous undo at once. Without a live binding (background, commit→passive)
      // nothing is sent through the old access; no later cleanup may hand this context to the next binding.
      saved.current = null;
      const bound = find.current(), held = owner.current;
      if (held) held.closed = true;
      if (bound) return bound.controller.close();
      repaint();
      return Promise.resolve();
    },
    refresh: () => find.current()?.controller.refresh() ?? Promise.resolve(),
  }), []);

  const bound = binding(options, owner.current, suspended.current);
  if (bound) return { state: bound.controller.snapshot(), actions };
  if (!options.enabled) return { state: masked("idle", options.cardId), actions };
  if (!admitted(options.access)) return { state: masked("disposed", options.cardId), actions };
  return { state: masked("opening", options.cardId), actions };
}
