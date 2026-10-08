import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { chooseInitialLanguage, languageStorageKey, readSavedLanguage } from "../i18n/language";
import type { Language } from "../i18n/language";
import { createEntryApi } from "../api/entryApi";
import { browserStorage } from "../platform/storage";
import type { AsyncStorage } from "../platform/storage";
import { closeMiniApp, notifyAcceptedMilestone, signedInitData, syncPlatform, telegramLanguage } from "../platform/telegram";
import { browserDocumentLock } from "./documentLock";
import { EntryController } from "./entryController";
import { EntryScreen } from "./EntryScreen";
import type { EntryState } from "./entryState";
import { clientContractVersion, type HttpOptions } from "../api/http";
import type { OpenedAccess } from "./openedAccess";
import type { BusyAccess } from "./busyAccess";
import { BusyTodayHost } from "./TodayHost";
import { createTodayApi } from "../today/todayApi";
import { ApplicationDocument } from "./ApplicationDocument";
import { LaunchHost } from "./LaunchScreen";
import { LaunchCard, launchCardId } from "./launchCard";
import { useBackLayer } from "./navigationBack";
import { SettingsPendingStore } from "../settings/settingsPending";
import { RemoteStopPendingStore } from "../study/remoteStopPending";
import { createRemoteSessionApi } from "../study/remoteSessionApi";
import type { SettingsObservation } from "../settings/useSettingsDocument";
import { OralSessionPendingStore, OralStopPendingStore } from "../oral/oralPending";
import type { OralStores } from "./OralHost";
import packageJson from "../../package.json";

/** The entry is still being decided: the launch screen keeps waiting (М20). Every other state is an answer, success or refusal. */
const undecided: ReadonlySet<EntryState["kind"]> = new Set(["checking", "opening", "reapplying"]);

/** Back while the document is checked: nothing on screen may act until the check has answered. */
const holdBack = () => {};

/** The single identity source for entry and study commands. */
const newId = () => window.crypto.randomUUID();

export function App() {
  const [language, setLanguage] = useState<Language | null>(null);
  const [entryState, setEntryState] = useState<EntryState>({ kind: "checking" });
  const [controller, setController] = useState<EntryController | null>(null);
  const [access, setAccess] = useState<OpenedAccess | null>(null);
  const [busyAccess, setBusyAccess] = useState<BusyAccess | null>(null);
  const [transport, setTransport] = useState<HttpOptions | null>(null);
  const [pendingStore, setPendingStore] = useState<SettingsPendingStore | null>(null);
  const [storage, setStorage] = useState<AsyncStorage | null>(null);
  const [oralStores, setOralStores] = useState<OralStores | null>(null);
  const [documentCheck, setDocumentCheck] = useState(false);
  // Read once at launch; the opened document takes it after the ordinary entry (answer Q20).
  const [launchCard] = useState(() => new LaunchCard(launchCardId(window.location.search)));
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
    // One pair per storage, shared by every oral owner of this App.
    setOralStores({ study: new OralSessionPendingStore(readyStorage), stop: new OralStopPendingStore(readyStorage) });
    setStorage(readyStorage);
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
          onDocumentStale: () => currentController?.documentStale(),
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
          contractVersion: clientContractVersion(),
          timeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone || null,
          newId,
          closeWindow: () => closeMiniApp(window),
          onDocumentCheck(checking) { if (active) setDocumentCheck(checking); },
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

  // The remote-stop confirmation is a modal step: native Back closes it like «Отмена» (tz_app:86).
  const remoteConfirm = language !== null && entryState.kind === "remote_confirm" ? controller : null;
  useBackLayer("overlay", remoteConfirm ? () => remoteConfirm.cancelRemoteStop() : null);
  // The hidden document keeps its Back handlers mounted: while it is checked, Back reaches none of them (2.33).
  useBackLayer("check", documentCheck ? holdBack : null);

  const content = (): ReactNode => {
    if (language === null) {
      return (
        <EntryScreen
          state={{ kind: "checking" }}
          language={chooseInitialLanguage(null, telegramLanguage(window), window.navigator.language)}
        />
      );
    }
    if (entryState.kind === "opened" && access && transport && pendingStore && storage && oralStores) {
      // While a DOCUMENT_STALE is being checked the document stays mounted (a live window goes on as it was) but out
      // of sight, so a replaced window never shows its module's refusal before it closes (2.33). The wrapper is
      // always there: adding it only for the check would remount the document. Inert stops focus and clicks, and the
      // Enter shortcuts (useEnterNext) read it, so the hidden screens do nothing meanwhile.
      return <>
        <div className="document-check" style={{ display: documentCheck ? "none" : "contents" }} inert={documentCheck}>
          <ApplicationDocument key={access.key} access={access} transport={transport} pendingStore={pendingStore}
            storage={storage} oralStores={oralStores} newId={newId} language={language} foreground={foreground} onCurrent={observeSettings}
            launchCard={launchCard} />
        </div>
        {documentCheck && <EntryScreen state={{ kind: "checking" }} language={language} afterStale />}
      </>;
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
  };
  // The launch screen lies over the application from the first frame; the entry above runs independently of it.
  return <LaunchHost ready={language !== null && !undecided.has(entryState.kind)}>{content()}</LaunchHost>;
}
