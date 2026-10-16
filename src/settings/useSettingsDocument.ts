import { useEffect, useMemo, useReducer, useRef } from "react";
import { FeedbackPendingStore } from "../feedback/feedbackPending";
import { useFeedbackDocument, type FeedbackDocument } from "../feedback/useFeedbackDocument";
import type { HttpOptions } from "../api/http";
import type { SettingsResponse } from "../api/generated";
import type { OpenedAccess } from "../app/openedAccess";
import type { Language } from "../i18n/language";
import { createSettingsApi } from "./settingsApi";
import { SettingsController, type SettingsSnapshot } from "./settingsController";
import type { SettingsPendingStore } from "./settingsPending";
import { SettingsResetPendingStore } from "./settingsResetPending";
import type { SettingsScreenProps } from "./SettingsScreen";

export type SettingsObservation = {
  accessKey: string; profileId: string; version: string;
  uiLanguage: Language; dictionaryLanguage: Language;
};
type Options = {
  access: OpenedAccess; transport: HttpOptions; pendingStore: SettingsPendingStore;
  minimumStateVersion?: string;
  onCurrent(current: SettingsObservation): void;
};
export type SettingsDocument = {
  state: SettingsSnapshot;
  /** Only a current read with no unresolved setting command can configure study. */
  confirmed: SettingsResponse | null;
  actions: SettingsScreenProps["actions"];
  /** The message to the developer; its owner lives as long as this document, like the unsaved settings drafts. */
  feedback: FeedbackDocument;
};
type Owner = {
  key: string; transport: HttpOptions; store: SettingsPendingStore;
  controller: SettingsController; source: OpenedAccess | null;
  lastAccess: OpenedAccess; minimum: string;
  refresh(): Promise<void>;
  run(action: () => Promise<void>): Promise<void>;
};
const initial: SettingsSnapshot = { phase: "loading", data: null, dataCurrent: false, drafts: {}, pending: null,
  resetPending: null, outcome: null, resetOutcome: null, problem: null, canEdit: false, canReset: false, canRetry: false,
  canContinueWithServer: false };

// The reset slot shares the application storage of the settings slot, and one instance per storage serializes its
// writes across document lifetimes, as the settings slot instance does.
const resetStores = new WeakMap<SettingsPendingStore, SettingsResetPendingStore>();
function resetStoreOf(store: SettingsPendingStore): SettingsResetPendingStore {
  let reset = resetStores.get(store);
  if (!reset) { reset = new SettingsResetPendingStore(store.backing); resetStores.set(store, reset); }
  return reset;
}

/** One settings command owner per opened document, independent of whether its editor is visible. */
export function useSettingsDocument(options: Options): SettingsDocument {
  const latest = useRef(options); latest.current = options;
  const owner = useRef<Owner | null>(null);
  const [, repaint] = useReducer((version: number) => version + 1, 0);
  const lookup = () => {
    const bound = owner.current, current = latest.current;
    return bound?.key === current.access.key && bound.transport === current.transport && bound.store === current.pendingStore
      ? bound : null;
  };
  const currentOwner = useRef(lookup); currentOwner.current = lookup;

  useEffect(() => {
    const current = latest.current;
    if (!current.access.isLive() || current.access.profile.access.status !== "admitted") return;
    let live = true;
    const publish = () => {
      if (!live || currentOwner.current() !== bound) return;
      repaint();
      const access = latest.current.access, state = controller.snapshot();
      if (bound.source === access && state.dataCurrent && state.data && access.isLive()) latest.current.onCurrent({
        accessKey: access.key, profileId: access.profile.profile_id, version: state.data.state_version,
        uiLanguage: state.data.settings.ui_language.value, dictionaryLanguage: state.data.settings.dictionary_language.value,
      });
    };
    const controller = new SettingsController({ api: createSettingsApi(current.transport), pendingStore: current.pendingStore,
      resetStore: resetStoreOf(current.pendingStore), access: () => latest.current.access, newId: () => window.crypto.randomUUID(),
      minimumStateVersion: () => latest.current.minimumStateVersion ?? null, onUpdate: publish, gate: current.transport.gate });
    const bound: Owner = { key: current.access.key, transport: current.transport, store: current.pendingStore, controller,
      source: null, lastAccess: current.access, minimum: current.minimumStateVersion ?? current.access.profile.state_version,
      async run(action) {
        const source = latest.current.access;
        await action();
        if (!live || currentOwner.current() !== bound || source !== latest.current.access) return;
        // Recovery can finish unresolved. Exact retry is then an explicit choice;
        // configuring study still requires the separate ready/current/no-pending checks.
        bound.source = source;
        publish();
      },
      refresh() {
        bound.source = null; publish();
        return bound.run(() => controller.refresh());
      },
    };
    owner.current = bound;
    void bound.refresh();
    return () => { live = false; controller.dispose(); if (owner.current === bound) owner.current = null; };
  }, [options.access.key, options.transport, options.pendingStore]);

  useEffect(() => {
    const bound = currentOwner.current();
    if (!bound) return;
    const minimum = options.minimumStateVersion ?? options.access.profile.state_version;
    const advanced = BigInt(minimum) > BigInt(bound.minimum);
    if (advanced) bound.minimum = minimum;
    const changedAccess = bound.lastAccess !== options.access;
    bound.lastAccess = options.access;
    if (changedAccess || advanced && !bound.controller.snapshot().dataCurrent) void bound.refresh();
  }, [options.access, options.minimumStateVersion]);

  const actions = useMemo<SettingsScreenProps["actions"]>(() => {
    const recovered = () => {
      const bound = currentOwner.current();
      return bound?.source === latest.current.access ? bound : null;
    };
    return {
      edit: (key, input) => recovered()?.controller.edit(key, input),
      save: key => { const bound = recovered(); return bound?.run(() => bound.controller.save(key)) ?? Promise.resolve(); },
      keepMine: key => { const bound = recovered(); return bound?.run(() => bound.controller.keepMine(key)) ?? Promise.resolve(); },
      acceptCurrent: key => recovered()?.controller.acceptCurrent(key),
      retry: () => { const bound = recovered(); return bound?.run(() => bound.controller.retry()) ?? Promise.resolve(); },
      continueWithServer: () => { const bound = recovered(); return bound?.run(() => bound.controller.continueWithServer()) ?? Promise.resolve(); },
      cancelStored: () => { const bound = recovered(); return bound?.run(() => bound.controller.cancelStored()) ?? Promise.resolve(); },
      cancelReset: () => { const bound = recovered(); return bound?.run(() => bound.controller.cancelReset()) ?? Promise.resolve(); },
      reset: () => { const bound = recovered(); return bound?.run(() => bound.controller.reset()) ?? Promise.resolve(); },
      refresh: () => currentOwner.current()?.refresh() ?? Promise.resolve(),
    };
  }, []);
  const bound = lookup();
  let state = bound?.controller.snapshot() ?? initial;
  if (bound?.source !== options.access) state = { ...state, canEdit: false, canReset: false, canRetry: false, canContinueWithServer: false,
    canCancelStored: false, canCancelReset: false,
    drafts: Object.fromEntries(Object.entries(state.drafts).map(([key, draft]) => [key, { ...draft, canSave: false, canKeepMine: false }])) };
  const confirmed = bound?.source === options.access && state.phase === "ready" && state.dataCurrent && !state.pending
    && !state.resetPending ? state.data : null;
  const feedbackStore = useMemo(() => new FeedbackPendingStore(options.pendingStore.backing), [options.pendingStore]);
  const feedback = useFeedbackDocument({ access: options.access, transport: options.transport, pendingStore: feedbackStore });
  return { state, confirmed, actions, feedback };
}
