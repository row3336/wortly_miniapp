import { useEffect, useMemo, useReducer, useRef } from "react";
import type { HttpOptions } from "../api/http";
import type { OpenedAccess } from "../app/openedAccess";
import type { AsyncStorage } from "../platform/storage";
import type { LearningActions } from "./LearningScreen";
import { LearningViewController, type LearningViewSnapshot } from "./learningViewController";

type Options = {
  access: OpenedAccess;
  storage: AsyncStorage;
  transport: HttpOptions;
  newId(): string;
  /** Seed from a confirmed Learning resume; null means explicit start is still required. */
  initialSessionId: string | null;
  /** Null suspends study until a setting is confirmed; it never selects a default. */
  transitionMode: "normal" | "accelerated" | null;
  /** Keep the owner mounted while a different route or unconfirmed settings prevent study. */
  enabled?: boolean;
  /** Confirmed observations must belong to this access key and profile. */
  minimumStateVersion?: string;
};
type Owner = {
  key: string;
  dictionaryLanguage: string;
  storage: AsyncStorage;
  transport: HttpOptions;
  lastAccess: OpenedAccess;
  waitingForAccess: OpenedAccess | null;
  lastMinimumVersion: string;
  lastEnabled: boolean;
  startEpoch: number;
  activation: Promise<void> | null;
  controller: LearningViewController;
};
export type LearningDocumentActions = LearningActions & { start(): Promise<void> };

/** One owner per opened document and dictionary. Keep it mounted across routes so pending recovery survives. */
export function useLearningDocument(options: Options): { state: LearningViewSnapshot | null; actions: LearningDocumentActions } {
  const latest = useRef(options); latest.current = options;
  const owner = useRef<Owner | null>(null);
  const [, repaint] = useReducer((version: number) => version + 1, 0);
  const currentOwner = () => {
    const bound = owner.current, current = latest.current;
    return bound?.key === current.access.key && bound.dictionaryLanguage === current.access.profile.dictionary_language
      && bound.storage === current.storage && bound.transport === current.transport ? bound : null;
  };
  const lookup = useRef(currentOwner); lookup.current = currentOwner;

  useEffect(() => {
    if (!latest.current.access.isLive() || latest.current.access.profile.access.status !== "admitted") return;
    let active = true;
    const current = latest.current;
    const controller = new LearningViewController({ access: () => latest.current.access, storage: current.storage,
      transport: current.transport, newId: () => latest.current.newId(), sessionId: current.initialSessionId,
      transitionMode: () => latest.current.transitionMode,
      enabled: () => latest.current.enabled !== false && document.visibilityState === "visible",
      minimumStateVersion: () => latest.current.minimumStateVersion ?? null,
      onUpdate() {
        if (active && owner.current === bound) repaint();
      },
    });
    const bound: Owner = { key: current.access.key, dictionaryLanguage: current.access.profile.dictionary_language,
      storage: current.storage, transport: current.transport,
      lastAccess: current.access, waitingForAccess: null,
      lastEnabled: current.enabled !== false && current.transitionMode !== null, startEpoch: 0,
      activation: null,
      lastMinimumVersion: current.minimumStateVersion ?? current.access.profile.state_version, controller };
    owner.current = bound;
    const suspend = () => {
      if (!active || lookup.current() !== bound) return;
      bound.startEpoch++; bound.waitingForAccess = latest.current.access; controller.suspend();
    };
    // Capture runs before App's foreground listener. Visibility alone cannot
    // restore study rights while the previous open handle is still live.
    document.addEventListener("visibilitychange", suspend, true);
    window.addEventListener("pageshow", suspend, true);
    if (document.visibilityState !== "visible") suspend();
    else if (!bound.lastEnabled) controller.suspend();
    repaint();
    void controller.refresh();
    return () => {
      document.removeEventListener("visibilitychange", suspend, true);
      window.removeEventListener("pageshow", suspend, true);
      active = false; controller.dispose();
      if (owner.current === bound) owner.current = null;
    };
  }, [options.access.key, options.access.profile.dictionary_language, options.storage, options.transport]);

  useEffect(() => {
    const bound = lookup.current();
    if (!bound) return;
    const activate = () => {
      const task = bound.controller.resume().finally(() => {
        if (bound.activation === task) bound.activation = null;
      });
      bound.activation = task;
    };
    const minimum = options.minimumStateVersion ?? options.access.profile.state_version;
    const advanced = BigInt(minimum) > BigInt(bound.lastMinimumVersion);
    if (advanced) bound.lastMinimumVersion = minimum;
    const enabled = options.enabled !== false && options.transitionMode !== null;
    const returning = enabled && !bound.lastEnabled;
    if (!enabled && bound.lastEnabled) bound.startEpoch++;
    bound.lastEnabled = enabled;
    if (!enabled) bound.controller.suspend();
    if (bound.lastAccess !== options.access) {
      bound.lastAccess = options.access;
      if (document.visibilityState !== "visible") {
        bound.waitingForAccess = options.access; bound.controller.suspend(); void bound.controller.refresh();
      } else if (bound.waitingForAccess !== options.access) {
        bound.waitingForAccess = null;
        if (enabled) activate();
        else void bound.controller.refresh();
      }
    } else if (returning && !bound.waitingForAccess && document.visibilityState === "visible") activate();
    else if (advanced && !bound.waitingForAccess) void bound.controller.refresh();
  }, [options.access, options.minimumStateVersion, options.enabled, options.transitionMode]);

  const actions = useMemo<LearningDocumentActions>(() => {
    const perform = (run: (controller: LearningViewController) => Promise<void>) => {
      const bound = lookup.current();
      return bound ? run(bound.controller) : Promise.resolve();
    };
    return {
      setDraft: text => { lookup.current()?.controller.setDraft(text); },
      previousResult: () => { lookup.current()?.controller.previousResult(); },
      submit: flags => perform(controller => controller.submit(flags)),
      next: () => perform(controller => controller.next()),
      grade: grade => perform(controller => controller.grade(grade)),
      correct: () => perform(controller => controller.correct()),
      retry: lane => perform(controller => controller.retry(lane)),
      refresh: () => {
        const bound = lookup.current();
        return bound && !bound.waitingForAccess ? bound.controller.refresh() : Promise.resolve();
      },
      stop: reason => perform(controller => controller.stop(reason)),
      advancePreview: known => perform(controller => controller.advancePreview(known)),
      async start() {
        const bound = lookup.current();
        if (!bound || bound.waitingForAccess || latest.current.enabled === false
          || latest.current.transitionMode === null || document.visibilityState !== "visible") return;
        const epoch = bound.startEpoch, source = latest.current.access;
        // A route tap can arrive in the same commit as resume. Its read ending
        // does not yet mean resume has restored the controller's active state.
        await bound.activation;
        // Joining initial recovery is safe; its old start receipt must be known
        // before an explicit tap can create a new session identity.
        await bound.controller.refresh();
        await bound.activation;
        if (lookup.current() === bound && bound.startEpoch === epoch && latest.current.access === source
          && !bound.waitingForAccess) await bound.controller.start();
      },
    };
  }, []);

  const bound = currentOwner();
  // Re-evaluate liveness/floor on a props change, even before its refresh effect.
  const state = bound ? bound.controller.snapshot() : null;
  return { state, actions };
}
