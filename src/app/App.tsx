import { useCallback, useEffect, useRef, useState } from "react";
import { chooseInitialLanguage, languageStorageKey, readSavedLanguage } from "../i18n/language";
import type { Language } from "../i18n/language";
import { createEntryApi } from "../api/entryApi";
import { browserStorage } from "../platform/storage";
import type { AsyncStorage } from "../platform/storage";
import { notifyAcceptedMilestone, signedInitData, syncPlatform, telegramLanguage } from "../platform/telegram";
import { browserDocumentLock } from "./documentLock";
import { EntryController } from "./entryController";
import { EntryScreen } from "./EntryScreen";
import type { EntryState } from "./entryState";
import type { HttpOptions } from "../api/http";
import type { OpenedAccess } from "./openedAccess";
import type { BusyAccess } from "./busyAccess";
import { BusyTodayHost } from "./TodayHost";
import { createTodayApi } from "../today/todayApi";
import { ApplicationDocument } from "./ApplicationDocument";
import { SettingsPendingStore } from "../settings/settingsPending";
import { RemoteStopPendingStore } from "../study/remoteStopPending";
import { createRemoteSessionApi } from "../study/remoteSessionApi";
import type { SettingsObservation } from "../settings/useSettingsDocument";
import packageJson from "../../package.json";

export function App() {
  const [language, setLanguage] = useState<Language | null>(null);
  const [entryState, setEntryState] = useState<EntryState>({ kind: "checking" });
  const [controller, setController] = useState<EntryController | null>(null);
  const [access, setAccess] = useState<OpenedAccess | null>(null);
  const [busyAccess, setBusyAccess] = useState<BusyAccess | null>(null);
  const [transport, setTransport] = useState<HttpOptions | null>(null);
  const [pendingStore, setPendingStore] = useState<SettingsPendingStore | null>(null);
  const openedRef = useRef<OpenedAccess | null>(null);
  const storageRef = useRef<AsyncStorage | null>(null);
  const observedLanguage = useRef<{ profileId: string; version: string } | null>(null);
  const languageWrites = useRef(Promise.resolve());
  const publishLanguage = useCallback((profileId: string, version: string, next: Language) => {
    const previous = observedLanguage.current;
    if (previous?.profileId === profileId && BigInt(version) <= BigInt(previous.version)) return;
    observedLanguage.current = { profileId, version };
    document.documentElement.lang = next;
    setLanguage(next);
    const storage = storageRef.current;
    languageWrites.current = languageWrites.current.then(async () => {
      if (storage && storage === storageRef.current) await storage.set(languageStorageKey, next);
    }).catch(() => { /* A preference cache failure must not undo a confirmed server setting. */ });
  }, []);
  const observeSettings = useCallback((current: SettingsObservation) => {
    const opened = openedRef.current;
    if (opened?.isLive() && opened.key === current.accessKey && opened.profile.profile_id === current.profileId) {
      publishLanguage(current.profileId, current.version, current.uiLanguage);
    }
  }, [publishLanguage]);
  const foreground = useCallback(async () => {
    await controller?.foreground();
    return controller?.getOpenedAccess() ?? null;
  }, [controller]);

  useEffect(() => {
    let active = true;
    let storage: AsyncStorage | null = null;
    let currentController: EntryController | null = null;
    let enteredDocument: string | null = null;
    try {
      storage = browserStorage(window.localStorage);
    } catch {
      const fallback = chooseInitialLanguage(null, telegramLanguage(window), window.navigator.language);
      document.documentElement.lang = fallback;
      setLanguage(fallback);
      setEntryState({ kind: "unavailable" });
      return () => { active = false; };
    }
    const readyStorage = storage;
    storageRef.current = readyStorage;
    observedLanguage.current = null;
    setPendingStore(new SettingsPendingStore(readyStorage));
    void readSavedLanguage(readyStorage).then((saved) => {
      if (!active) return;
      try {
        const chosen = chooseInitialLanguage(saved, telegramLanguage(window), window.navigator.language);
        document.documentElement.lang = chosen;
        setLanguage(chosen);
        const configuredTimeout = import.meta.env.VITE_WORTLY_TIMEOUT_MS;
        const configuredLimit = import.meta.env.VITE_WORTLY_MAX_RESPONSE_BYTES;
        if (!configuredTimeout || !configuredLimit) throw new Error("Entry transport limits are not configured");
        const options: HttpOptions = {
          fetcher: window.fetch.bind(window),
          baseUrl: import.meta.env.VITE_WORTLY_API_BASE_URL || "",
          timeoutMs: Number(configuredTimeout),
          maxResponseBytes: Number(configuredLimit),
        };
        const api = createEntryApi(options);
        setTransport(options);
        currentController = new EntryController({
          api,
          today: createTodayApi(options),
          remote: { api: createRemoteSessionApi(options), pendingStore: new RemoteStopPendingStore(readyStorage) },
          storage: readyStorage,
          lock: browserDocumentLock(window.navigator),
          initData: signedInitData(window),
          savedLanguage: saved,
          browserLanguage: window.navigator.language || null,
          clientVersion: import.meta.env.VITE_WORTLY_CLIENT_VERSION || packageJson.version,
          contractVersion: import.meta.env.VITE_WORTLY_CONTRACT_VERSION || "1",
          timeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone || null,
          newId: () => window.crypto.randomUUID(),
          onUpdate(snapshot) {
            if (!active) return;
            setEntryState(snapshot.state);
            const opened = currentController?.getOpenedAccess() ?? null;
            openedRef.current = opened;
            setAccess(opened);
            setBusyAccess(currentController?.getBusyAccess() ?? null);
            if (opened) {
              const documentKey = `${opened.profile.profile_id}:${opened.document.documentId}:${opened.document.epoch}`;
              if (documentKey !== enteredDocument) {
                enteredDocument = documentKey;
                notifyAcceptedMilestone(window, "entry");
              }
            }
            if (snapshot.profile) {
              publishLanguage(snapshot.profile.profile_id, snapshot.profile.state_version, snapshot.profile.ui_language);
            }
          },
        });
        setController(currentController);
        void currentController.start();
      } catch {
        setEntryState({ kind: "unavailable" });
      }
    });
    return () => {
      active = false;
      currentController?.dispose();
      openedRef.current = null;
      if (storageRef.current === readyStorage) storageRef.current = null;
    };
  }, [publishLanguage]);

  useEffect(() => syncPlatform(document.documentElement, window), []);

  useEffect(() => {
    const foreground = () => {
      if (document.visibilityState === "visible") void controller?.foreground();
    };
    document.addEventListener("visibilitychange", foreground);
    window.addEventListener("pageshow", foreground);
    return () => {
      document.removeEventListener("visibilitychange", foreground);
      window.removeEventListener("pageshow", foreground);
    };
  }, [controller]);

  if (language === null) {
    return (
      <EntryScreen
        state={{ kind: "checking" }}
        language={chooseInitialLanguage(null, telegramLanguage(window), window.navigator.language)}
      />
    );
  }
  if (entryState.kind === "opened" && access && transport && pendingStore) {
    return <ApplicationDocument key={access.key} access={access} transport={transport} pendingStore={pendingStore}
      language={language} foreground={foreground} onCurrent={observeSettings} />;
  }
  if (entryState.kind === "busy" && busyAccess && transport && controller) {
    return <BusyTodayHost access={busyAccess} transport={transport} language={language}
      onRequest={() => controller.requestRemoteStop()} onRefresh={() => { void controller.foreground(); }} />;
  }
  return (
    <EntryScreen
      state={entryState}
      language={language}
      onRetry={controller && entryState.kind === "unavailable" ? () => { void controller.retry(); } : undefined}
      onReapply={controller && entryState.kind === "rejected" ? () => { void controller.reapply(); } : undefined}
      onRemoteRequest={controller ? () => controller.requestRemoteStop() : undefined}
      onRemoteCancel={controller ? () => controller.cancelRemoteStop() : undefined}
      onRemoteConfirm={controller ? () => { void controller.confirmRemoteStop(); } : undefined}
      onRemoteCheck={controller ? () => { void controller.checkRemoteStop(); } : undefined}
      onRemoteRetry={controller ? () => { void controller.retryRemoteStop(); } : undefined}
    />
  );
}
