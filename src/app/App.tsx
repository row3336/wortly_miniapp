import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { chooseInitialLanguage, languageStorageKey, readSavedLanguage } from "../i18n/language";
import type { Language } from "../i18n/language";
import { createEntryApi } from "../api/entryApi";
import { browserStorage } from "../platform/storage";
import type { AsyncStorage } from "../platform/storage";
import { closeMiniApp, notifyAcceptedMilestone, signedInitData, syncPlatform, telegramLanguage } from "../platform/telegram";
import { browserDocumentLock } from "./documentLock";
import { EntryController, type ForegroundIntent } from "./entryController";
import { EntryScreen } from "./EntryScreen";
import type { EntryState } from "./entryState";
import { clientContractVersion, type HttpOptions } from "../api/http";
import { pageGate } from "./pageGate";
import type { OpenedAccess } from "./openedAccess";
import type { LearningPageStarts } from "../learning/learningPageStarts";
import type { BusyAccess } from "./busyAccess";
import { BusyTodayHost } from "./TodayHost";
import { createTodayApi } from "../today/todayApi";
import { ApplicationDocument } from "./ApplicationDocument";
import { WindowRecoveryStatus } from "../commands/RecoveryOverlay";
import { LaunchHost } from "./LaunchScreen";
import { forgetLaunchCard, LaunchCard, launchCardId } from "./launchCard";
import { useBackLayer } from "./navigationBack";
import { SettingsPendingStore } from "../settings/settingsPending";
import { RemoteStopPendingStore } from "../study/remoteStopPending";
import { createRemoteSessionApi } from "../study/remoteSessionApi";
import type { SettingsObservation } from "../settings/useSettingsDocument";
import { OralSessionPendingStore, OralStopPendingStore } from "../oral/oralPending";
import type { OralStores } from "./OralHost";
import { ConjugationSessionPendingStore, ConjugationStopPendingStore } from "../conjugation/conjugationPending";
import type { ConjugationStores } from "./ConjugationHost";
import packageJson from "../../package.json";
import { clientJournal, installClientJournal } from "../journal/clientJournal";
import { createPageJournal, watchPage } from "../journal/pageJournal";
import type { DeletionEnd } from "../profile/profileDeleteController";
import { DeletionNotice, deletionCheckResult } from "../profile/DeletionNotice";
import { wipeProfileRecords } from "../profile/profileWipe";

/** The entry is still being decided: the launch screen keeps waiting (М20). Every other state is an answer, success or refusal. */
const undecided: ReadonlySet<EntryState["kind"]> = new Set(["checking", "opening", "reapplying"]);

/** Back while the document is checked: nothing on screen may act until the check has answered. */
const holdBack = () => {};

/** The single identity source for entry and study commands. */
const newId = () => window.crypto.randomUUID();

/** learningPage models another JS document in tests; the app itself always runs with its own document's page. */
export function App({ learningPage }: { learningPage?: LearningPageStarts } = {}) {
  const [language, setLanguage] = useState<Language | null>(null);
  const [entryState, setEntryState] = useState<EntryState>({ kind: "checking" });
  const [controller, setController] = useState<EntryController | null>(null);
  const [access, setAccess] = useState<OpenedAccess | null>(null);
  const [busyAccess, setBusyAccess] = useState<BusyAccess | null>(null);
  const [transport, setTransport] = useState<HttpOptions | null>(null);
  const [pendingStore, setPendingStore] = useState<SettingsPendingStore | null>(null);
  const [storage, setStorage] = useState<AsyncStorage | null>(null);
  const [oralStores, setOralStores] = useState<OralStores | null>(null);
  const [conjugationStores, setConjugationStores] = useState<ConjugationStores | null>(null);
  const [documentCheck, setDocumentCheck] = useState(false);
  // Read once at launch; the opened document takes it after the ordinary entry (answer Q20).
  const [launchCard] = useState(() => new LaunchCard(launchCardId(window.location.search), () => forgetLaunchCard(window)));
  const openedRef = useRef<OpenedAccess | null>(null);
  // PD-28 (P04 §3.7): the profile whose deletion ended unknown; the next profile the explicit sign-in names decides it.
  // Memory of this page only: a reload or a closed Mini App forgets it, like the intent itself (Q-DEL-4).
  const deletionCheck = useRef<string | null>(null);
  const [deletionNotice, setDeletionNotice] = useState<"deleted" | "not_deleted" | null>(null);
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
  // The deletion screen ended the document (P04 §8): no sign-in follows by itself.
  const endDeletion = useCallback((end: DeletionEnd) => {
    deletionCheck.current = end.kind === "unknown" ? end.confirmedProfileId : null;
    controller?.endAfterDeletion(end);
  }, [controller]);
  const foreground = useCallback(async (intent?: ForegroundIntent) => {
    await controller?.foreground("screen", intent);
    // While the window recovers (К-11/К-9а) its foreground proves nothing to the screens (AC-11h).
    if (controller?.unconfirmed()) return "unconfirmed" as const;
    return controller?.getOpenedAccess() ?? null;
  }, [controller]);

  useEffect(() => {
    let active = true;
    let storage: AsyncStorage | null = null;
    let currentController: EntryController | null = null;
    let enteredDocument: string | null = null;
    let journal: ReturnType<typeof createPageJournal> | null = null;
    // The write gate of this page (P03 M-P03-3): every request of every module passes it (RD-7); it owns the probes.
    const gate = pageGate.make();
    // The series of probes runs only in a visible window: hidden, its timers stop; shown, it starts again at 5 s (Q35.3).
    const visibility = () => {
      gate.setVisible(document.visibilityState !== "hidden");
      // The entry counts shows (ВР-4: one recovery foreground per show of a hidden window).
      currentController?.setVisible(document.visibilityState !== "hidden");
    };
    visibility();
    document.addEventListener("visibilitychange", visibility);
    try {
      storage = browserStorage(window.localStorage);
    } catch {
      const fallback = chooseInitialLanguage(null, telegramLanguage(window), window.navigator.language);
      document.documentElement.lang = fallback;
      setLanguage(fallback);
      setEntryState({ kind: "unavailable" });
      return () => {
        active = false;
        document.removeEventListener("visibilitychange", visibility);
        gate.dispose();
      };
    }
    const readyStorage = storage;
    storageRef.current = readyStorage;
    observedLanguage.current = null;
    setPendingStore(new SettingsPendingStore(readyStorage));
    // One pair per storage, shared by every oral owner of this App.
    setOralStores({ study: new OralSessionPendingStore(readyStorage), stop: new OralStopPendingStore(readyStorage) });
    setConjugationStores({ study: new ConjugationSessionPendingStore(readyStorage), stop: new ConjugationStopPendingStore(readyStorage) });
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
          gate,
        };
        gate.attachProbe(pageGate.probe(options));
        const api = createEntryApi(options);
        setTransport(options);
        const clientVersion = import.meta.env.VITE_WORTLY_CLIENT_VERSION || packageJson.version;
        // The client journal of this page (R3-03): it keeps nothing until the entry admits a profile. Only the explicit
        // build flag VITE_WORTLY_CLIENT_JOURNAL=off leaves it out (the App tests set it: their synthetic servers do not
        // serve the intake); any other value, or none, keeps it.
        if (import.meta.env.VITE_WORTLY_CLIENT_JOURNAL !== "off") {
          journal = createPageJournal(options, clientVersion);
          installClientJournal(journal);
        }
        currentController = new EntryController({
          api,
          today: createTodayApi(options),
          remote: { api: createRemoteSessionApi(options), pendingStore: new RemoteStopPendingStore(readyStorage) },
          storage: readyStorage,
          lock: browserDocumentLock(window.navigator),
          initData: signedInitData(window),
          savedLanguage: saved,
          browserLanguage: window.navigator.language || null,
          clientVersion,
          contractVersion: clientContractVersion(),
          timeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone || null,
          newId,
          closeWindow: () => closeMiniApp(window),
          gate,
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
            const confirmed = deletionCheck.current, checked = deletionCheckResult(confirmed, snapshot);
            if (confirmed && checked) {
              deletionCheck.current = null;
              // Another profile after the explicit sign-in: the earlier one is deleted, its local records go (§3.7 (A)).
              if (checked === "deleted") void wipeProfileRecords(readyStorage, confirmed);
              setDeletionNotice(checked);
            }
            if (snapshot.profile) {
              publishLanguage(snapshot.profile.profile_id, snapshot.profile.state_version, snapshot.profile.ui_language);
            }
          },
        });
        currentController.setVisible(document.visibilityState !== "hidden");
        setController(currentController);
        void currentController.start();
      } catch {
        setEntryState({ kind: "unavailable" });
      }
    });
    return () => {
      active = false;
      if (journal && clientJournal() === journal) installClientJournal(null);
      journal?.dispose();
      currentController?.dispose();
      document.removeEventListener("visibilitychange", visibility);
      gate.dispose();
      openedRef.current = null;
      if (storageRef.current === readyStorage) storageRef.current = null;
    };
  }, [publishLanguage]);

  useEffect(() => syncPlatform(document.documentElement, window), []);
  useEffect(() => watchPage(window, clientJournal), []);

  useEffect(() => {
    const foreground = () => {
      // The real return of the window (P03 N14, E-M12): the entry tells it from a screen's own synchronization (fix2).
      if (document.visibilityState === "visible") void controller?.foreground("show");
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
    // PD-28 after the explicit sign-in: the conclusion first; the entry of the profile now signed in waits under it.
    if (language !== null && deletionNotice) {
      return <DeletionNotice kind={deletionNotice} language={language} onContinue={() => setDeletionNotice(null)} />;
    }
    if (language === null) {
      return (
        <EntryScreen
          state={{ kind: "checking" }}
          language={chooseInitialLanguage(null, telegramLanguage(window), window.navigator.language)}
        />
      );
    }
    if (entryState.kind === "opened" && access && transport && pendingStore && storage && oralStores && conjugationStores) {
      // While a DOCUMENT_STALE is being checked the document stays mounted (a live window goes on as it was) but out
      // of sight, so a replaced window never shows its module's refusal before it closes (2.33). The wrapper is
      // always there: adding it only for the check would remount the document. Inert stops focus and clicks, and the
      // Enter shortcuts (useEnterNext) read it, so the hidden screens do nothing meanwhile.
      return <>
        <div className="document-check" style={{ display: documentCheck ? "none" : "contents" }} inert={documentCheck}>
          <ApplicationDocument key={access.key} access={access} transport={transport} pendingStore={pendingStore}
            storage={storage} oralStores={oralStores} conjugationStores={conjugationStores} newId={newId} language={language}
            foreground={foreground} onCurrent={observeSettings} onDeletionEnded={controller ? endDeletion : undefined}
            launchCard={launchCard} learningPage={learningPage} />
        </div>
        {documentCheck && <EntryScreen state={{ kind: "checking" }} language={language} afterStale />}
        {/* К-11/К-9а and the identity check (P03 §4.8): a status over the kept screen, without buttons. */}
        {!documentCheck && entryState.wait && <WindowRecoveryStatus wait={entryState.wait} language={language} />}
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
        onLogin={controller && entryState.kind === "deletion_unknown" ? () => { void controller.start(); } : undefined}
      />
    );
  };
  // The launch screen lies over the application from the first frame; the entry above runs independently of it.
  return <LaunchHost ready={language !== null && !undecided.has(entryState.kind)}>{content()}</LaunchHost>;
}
