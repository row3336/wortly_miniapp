import { useEffect, useLayoutEffect, useMemo, useReducer, useRef } from "react";
import type { HttpOptions } from "../api/http";
import type { OpenedAccess } from "../app/openedAccess";
import type { AsyncStorage } from "../platform/storage";
import type { DocumentLane } from "./documentLanes";

export type StudyDocumentOptions = {
  access: OpenedAccess;
  storage: AsyncStorage;
  transport: HttpOptions;
  newId(): string;
  /** Null suspends study until a setting is confirmed; it never selects a default. */
  transitionMode: "normal" | "accelerated" | null;
  /** Keep the owner mounted while another route or unconfirmed settings prevent study. */
  enabled?: boolean;
  /** Confirmed observations must belong to this access key and profile. */
  minimumStateVersion?: string;
};
/** What a study view controller gets from the document: live callbacks over the latest props. */
export type StudyViewSettings<S> = {
  access(): OpenedAccess;
  storage: AsyncStorage;
  transport: HttpOptions;
  newId(): string;
  transitionMode(): "normal" | "accelerated" | null;
  enabled(): boolean;
  minimumStateVersion(): string | null;
  onUpdate(snapshot: S): void;
};
type StudyController<S> = {
  snapshot(): S;
  /** "disabled": another route or unconfirmed settings; automatic recovery of the visible window goes on. */
  suspend(reason?: "background" | "disabled"): void;
  resume(): Promise<void>;
  /** A visible window got its fresh open handle while study stays disabled: recovery goes on (Я15.7). */
  resumeRecovery(): void;
  refresh(): Promise<void>;
  /** S07 «Продолжить»: only the local cleanup of a confirmed outcome. */
  cleanup(): Promise<void>;
  dispose(): void;
  setDraft(text: string): void;
  previousResult(): void;
  submit(options?: { forgot?: boolean }): Promise<void>;
  next(): Promise<void>;
  grade(grade: 3 | 4 | 5): Promise<void>;
  correct(): Promise<void>;
  undo(): Promise<void>;
  retry(lane?: DocumentLane): Promise<void>;
  stop(reason?: "stop" | "summary_home"): Promise<void>;
};
export type StudyActions = Pick<StudyController<unknown>, "setDraft" | "submit" | "previousResult" | "next" | "grade" | "correct"
  | "undo" | "retry" | "refresh" | "cleanup" | "stop">;
type Owner<V> = {
  key: string; dictionaryLanguage: string; storage: AsyncStorage; transport: HttpOptions; seed: string | null;
  lastAccess: OpenedAccess; waitingForAccess: OpenedAccess | null; lastMinimumVersion: string; lastEnabled: boolean;
  startEpoch: number; activation: Promise<void> | null; controller: V;
};

/**
 * One owner per opened document, dictionary pair and owner seed. It stays mounted across routes so a durable receipt
 * is recovered by its ID. ownerSeed re-creates the owner when it changes (the written resume seed); a mode whose seed
 * is read only once at creation (Learning) passes null and reads it in create. A new seed naming the session the
 * owner already leads (the mode's `leads`) only addresses that owner: re-creating it would drop what it settled in
 * memory, such as a confirmed result restored by its receipt after a reload.
 */
export function useStudyDocument<O extends StudyDocumentOptions, V extends StudyController<S>, S>(options: O, ownerSeed: string | null,
  create: (current: O, seed: string | null, settings: StudyViewSettings<S>) => V,
  leads?: (controller: V, seed: string) => boolean): {
  state: S | null;
  actions: StudyActions;
  perform(run: (controller: V) => Promise<void>): Promise<void>;
  /** An explicit start: only from a visible, enabled, settled owner whose recovery already resolved any old start. */
  start(run: (controller: V) => Promise<void>): Promise<void>;
} {
  const latest = useRef(options); latest.current = options;
  const owner = useRef<Owner<V> | null>(null);
  const [, repaint] = useReducer((value: number) => value + 1, 0);
  const sameIdentity = (bound: Owner<V>, current: O) => bound.key === current.access.key
    && bound.dictionaryLanguage === current.access.profile.dictionary_language
    && bound.storage === current.storage && bound.transport === current.transport;
  // The committed owner seed and owner generation. They are written only in the commit phase: a render React discards
  // (an interrupted transition, the second render of StrictMode) neither addresses nor re-creates the owner.
  const seeds = useRef({ seed: ownerSeed, generation: 0 });
  const currentOwner = () => {
    const bound = owner.current;
    return bound && sameIdentity(bound, latest.current) && bound.seed === seeds.current.seed ? bound : null;
  };
  const lookup = useRef(currentOwner); lookup.current = currentOwner;
  const seed = ownerSeed;
  // Any other seed change re-creates the owner, as before: its generation is the effect's identity, not the seed.
  // A new document, pair, storage or transport re-creates it through the effect's own dependencies in any case.
  const committed = seeds.current, held = owner.current;
  const adopted = committed.seed !== ownerSeed && ownerSeed !== null && held !== null && held.seed === committed.seed
    && sameIdentity(held, options) && !!leads?.(held.controller, ownerSeed) ? held : null;
  const generation = committed.seed === ownerSeed || adopted ? committed.generation : committed.generation + 1;
  useLayoutEffect(() => {
    if (adopted && owner.current === adopted) adopted.seed = ownerSeed;
    seeds.current = { seed: ownerSeed, generation };
  }, [adopted, ownerSeed, generation]);

  useEffect(() => {
    if (!latest.current.access.isLive() || latest.current.access.profile.access.status !== "admitted") return;
    let active = true;
    const current = latest.current;
    const controller = create(current, seed, { access: () => latest.current.access, storage: current.storage,
      transport: current.transport, newId: () => latest.current.newId(),
      transitionMode: () => latest.current.transitionMode,
      enabled: () => latest.current.enabled !== false && document.visibilityState === "visible",
      minimumStateVersion: () => latest.current.minimumStateVersion ?? null,
      onUpdate() { if (active && owner.current === bound) repaint(); },
    });
    const bound: Owner<V> = { key: current.access.key, dictionaryLanguage: current.access.profile.dictionary_language,
      storage: current.storage, transport: current.transport, seed, lastAccess: current.access, waitingForAccess: null,
      lastEnabled: current.enabled !== false && current.transitionMode !== null, startEpoch: 0, activation: null,
      lastMinimumVersion: current.minimumStateVersion ?? current.access.profile.state_version, controller };
    owner.current = bound;
    const suspend = () => {
      if (!active || lookup.current() !== bound) return;
      bound.startEpoch++; bound.waitingForAccess = latest.current.access; controller.suspend();
    };
    // Capture runs before App's foreground listener: visibility alone cannot restore study rights
    // while the previous open handle is still live.
    document.addEventListener("visibilitychange", suspend, true);
    window.addEventListener("pageshow", suspend, true);
    if (document.visibilityState !== "visible") suspend();
    else if (!bound.lastEnabled) controller.suspend("disabled");
    repaint();
    void controller.refresh();
    return () => {
      document.removeEventListener("visibilitychange", suspend, true);
      window.removeEventListener("pageshow", suspend, true);
      active = false; controller.dispose();
      if (owner.current === bound) owner.current = null;
    };
    // create belongs to the mode, not to this owner's identity.
  }, [options.access.key, options.access.profile.dictionary_language, options.storage, options.transport, generation]);

  useEffect(() => {
    const bound = lookup.current();
    if (!bound) return;
    const activate = () => {
      const task = bound.controller.resume().finally(() => { if (bound.activation === task) bound.activation = null; });
      bound.activation = task;
    };
    const minimum = options.minimumStateVersion ?? options.access.profile.state_version;
    const advanced = BigInt(minimum) > BigInt(bound.lastMinimumVersion);
    if (advanced) bound.lastMinimumVersion = minimum;
    const enabled = options.enabled !== false && options.transitionMode !== null;
    const returning = enabled && !bound.lastEnabled;
    if (!enabled && bound.lastEnabled) bound.startEpoch++;
    bound.lastEnabled = enabled;
    if (!enabled) bound.controller.suspend("disabled");
    if (bound.lastAccess !== options.access) {
      bound.lastAccess = options.access;
      if (document.visibilityState !== "visible") {
        bound.waitingForAccess = options.access; bound.controller.suspend(); void bound.controller.refresh();
      } else if (bound.waitingForAccess !== options.access) {
        bound.waitingForAccess = null;
        if (enabled) activate();
        else { bound.controller.resumeRecovery(); void bound.controller.refresh(); }
      }
    } else if (returning && !bound.waitingForAccess && document.visibilityState === "visible") activate();
    else if (advanced && !bound.waitingForAccess) void bound.controller.refresh();
  }, [options.access, options.minimumStateVersion, options.enabled, options.transitionMode]);

  const methods = useMemo(() => {
    const perform = (run: (controller: V) => Promise<void>) => {
      const bound = lookup.current();
      return bound ? run(bound.controller) : Promise.resolve();
    };
    const actions: StudyActions = {
      setDraft: text => { lookup.current()?.controller.setDraft(text); },
      previousResult: () => { lookup.current()?.controller.previousResult(); },
      submit: flags => perform(controller => controller.submit(flags)),
      next: () => perform(controller => controller.next()),
      grade: grade => perform(controller => controller.grade(grade)),
      correct: () => perform(controller => controller.correct()),
      undo: () => perform(controller => controller.undo()),
      retry: lane => perform(controller => controller.retry(lane)),
      refresh: () => {
        const bound = lookup.current();
        return bound && !bound.waitingForAccess ? bound.controller.refresh() : Promise.resolve();
      },
      cleanup: () => perform(controller => controller.cleanup()),
      stop: reason => perform(controller => controller.stop(reason)),
    };
    const start = async (run: (controller: V) => Promise<void>) => {
      const bound = lookup.current();
      if (!bound || bound.waitingForAccess || latest.current.enabled === false
        || latest.current.transitionMode === null || document.visibilityState !== "visible") return;
      const epoch = bound.startEpoch, source = latest.current.access;
      // A tap can arrive in the same commit as resume; its read ending does not yet mean resume has restored the
      // controller's active state. Joining initial recovery is safe: an old start receipt is known before a new start.
      await bound.activation;
      await bound.controller.refresh();
      await bound.activation;
      if (lookup.current() === bound && bound.startEpoch === epoch && latest.current.access === source
        && !bound.waitingForAccess) await run(bound.controller);
    };
    return { actions, perform, start };
  }, []);

  // This render's owner: its own seed, or the owner this render addresses with it (committed with this render).
  const bound = owner.current && sameIdentity(owner.current, options) && owner.current.seed === ownerSeed ? owner.current : adopted;
  // Re-evaluate liveness and the version floor on a props change, before its refresh effect.
  return { state: bound ? bound.controller.snapshot() : null, ...methods };
}
