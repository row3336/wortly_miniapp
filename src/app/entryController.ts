import type { AuthResponse, OpenRequest, Profile, RegisterResponse } from "../api/generated";
import { EntryApiError } from "../api/entryApi";
import type { EntryApi } from "../api/entryApi";
import type { Language } from "../i18n/language";
import type { AsyncStorage } from "../platform/storage";
import type { DocumentLease, DocumentLock } from "./documentLock";
import { newerVersion, readInstallation, writeInstallation } from "./installation";
import type { Installation } from "./installation";
import type { EntryState } from "./entryState";
import { clearReapplyIntent, readReapplyIntent, writeReapplyIntent } from "./reapplyIntent";
import type { ReapplyIntent } from "./reapplyIntent";
import { createOpenedAccess, type OpenedAccess } from "./openedAccess";
import type { RemoteSessionApi, RemoteStopIntent } from "../study/remoteSessionApi";
import type { RemoteStopPendingStore } from "../study/remoteStopPending";
import { RemoteStopController } from "../study/remoteStopController";
import type { TodayApi } from "../today/todayApi";
import { createBusyAccess, type BusyAccess } from "./busyAccess";

export type EntrySnapshot = { state: EntryState; profile?: Profile };

/** HTTP 401 means this sign-in no longer works: retrying with the same signed data cannot help. */
function failure(error: unknown): EntryState {
  return { kind: error instanceof EntryApiError && error.kind === "http" && error.status === 401 ? "expired" : "unavailable" };
}

export type EntryControllerOptions = {
  api: EntryApi;
  today?: TodayApi;
  remote?: { api: RemoteSessionApi; pendingStore: RemoteStopPendingStore };
  storage: AsyncStorage;
  lock: DocumentLock;
  initData: string | null;
  savedLanguage: Language | null;
  browserLanguage: string | null;
  clientVersion: string;
  contractVersion: string;
  timeZone(): string | null;
  newId(): string;
  onUpdate(snapshot: EntrySnapshot): void;
  /** Closes this window when the platform can (the Telegram Mini App); otherwise the replaced screen stays. */
  closeWindow?(): void;
  /**
   * True from a DOCUMENT_STALE until its foreground check has settled. The window keeps its screens mounted but out
   * of sight meanwhile, so a replaced window closes without showing a module's refusal first (2.33).
   */
  onDocumentCheck?(checking: boolean): void;
};

export class EntryController {
  private generation = 0;
  private disposed = false;
  private state: EntryState = { kind: "checking" };
  private session: AuthResponse | null = null;
  private installation: Installation | null = null;
  private documentId: string | null = null;
  private lease: DocumentLease | null = null;
  // The pending lock request; reset, replacement and dispose drop it, so a late grant is given back.
  private claim: object | null = null;
  // A request of this document got DOCUMENT_STALE and no open has confirmed the document since.
  private staleHint = false;
  // The foreground check that a DOCUMENT_STALE asked for is still running.
  private checking = false;
  // A newer window of this installation took the document over: nothing here is sent for it again.
  private replaced = false;
  private profileVersion: string | null = null;
  private accessVersion: string | null = null;
  private reapplyIntent: ReapplyIntent | null = null;
  private conflictedIntentId: string | null = null;
  private conflictedAccessVersion: string | null = null;
  // The profile whose reapply the core refused with 403 ACCESS_REJECTED (two refusals, CT §6.3). It outlives
  // retry(): the closure is final, and an older core's profile has no reapply_closed to say so again.
  private reapplyClosedFor: string | null = null;
  private proofIssuedThisSession = false;
  private running: Promise<void> | null = null;
  private foregroundRunning = false;
  private queuedForeground: Promise<void> | null = null;
  private queuedRemoteRequest: Promise<void> | null = null;
  private openedAccess: OpenedAccess | null = null;
  private busyAccess: BusyAccess | null = null;
  private busySequence = 0;
  private remote: RemoteStopController | null = null;
  private observedStateVersion: string | null = null;
  // The target of a confirmed stop that the core refused (for example SESSION_CLOSED). The reopen that follows
  // compares it with the session now occupying the account: a different one is explained, not silently offered.
  private refusedTarget: string | null = null;

  constructor(private readonly options: EntryControllerOptions) {}

  private current(generation: number): boolean {
    return !this.disposed && generation === this.generation;
  }

  private emit(state: EntryState, profile?: Profile): void {
    this.state = state;
    if (state.kind !== "opened") this.openedAccess = null;
    this.busyAccess = null;
    if (state.kind === "busy" && state.remoteTarget && profile && this.session && this.options.today) {
      const generation = this.generation;
      const access: BusyAccess = createBusyAccess({
        key: `${profile.profile_id}:busy:${++this.busySequence}`, profile,
        token: this.session.access_token, api: this.options.today,
        minimumVersion: this.observedStateVersion,
        onRead: version => this.observeStateVersion(version),
        isLive: () => this.current(generation) && this.state.kind === "busy" && this.busyAccess === access,
        onDenied: error => {
          this.generation += 1;
          this.resetInvalidSession(error);
          this.emit(failure(error));
        },
      });
      this.busyAccess = access;
    }
    this.options.onUpdate({ state, profile });
  }

  getOpenedAccess(): OpenedAccess | null {
    return this.openedAccess?.isLive() ? this.openedAccess : null;
  }

  getBusyAccess(): BusyAccess | null {
    return this.busyAccess?.isLive() ? this.busyAccess : null;
  }

  private observeStateVersion(version: string): void {
    // Reads and commands can advance account state without returning a profile.
    // Do not relabel a cached profile with that newer version.
    if (!this.observedStateVersion || newerVersion(version, this.observedStateVersion)) this.observedStateVersion = version;
  }

  private acceptProfile(profile: Profile): boolean {
    if (this.session && this.session.profile.profile_id !== profile.profile_id) return false;
    if (this.profileVersion && newerVersion(this.profileVersion, profile.state_version)) return false;
    if (this.accessVersion && newerVersion(this.accessVersion, profile.access.version)) return false;
    this.profileVersion = profile.state_version;
    this.accessVersion = profile.access.version;
    if (this.session?.profile.profile_id === profile.profile_id) {
      this.session = { ...this.session, profile };
    }
    return true;
  }

  start(): Promise<void> {
    if (this.running) return this.running;
    this.session = null;
    this.installation = null;
    this.documentId = null;
    this.profileVersion = null;
    this.observedStateVersion = null;
    this.accessVersion = null;
    this.reapplyIntent = null;
    this.staleHint = false;
    this.proofIssuedThisSession = false;
    return this.run(true);
  }

  retry(): Promise<void> {
    if (this.running) return this.running;
    return this.run(this.session === null);
  }

  /** Refresh the same document before its screens read the new calendar state. */
  foreground(): Promise<void> {
    if (this.replaced) return Promise.resolve();
    if (this.running) {
      if (this.foregroundRunning || !this.refreshable()) return this.running;
      // Opened can be rendered before startup's finally clears running.
      // Retain that event, but coalesce events already covered by a foreground request.
      if (!this.queuedForeground) this.queuedForeground = this.running.then(() => {
        this.queuedForeground = null;
        return this.foreground();
      });
      return this.queuedForeground;
    }
    if (!this.refreshable() || !this.session) return Promise.resolve();
    const generation = this.generation;
    const task = this.open(this.session.access_token, generation, "foreground").catch((error: unknown) => {
      if (this.current(generation)) this.fail(error);
    }).finally(() => {
      if (this.running === task) {
        this.running = null;
        this.foregroundRunning = false;
      }
    });
    this.running = task;
    this.foregroundRunning = true;
    return task;
  }

  private refreshable(): boolean {
    return this.getOpenedAccess() !== null || this.getBusyAccess() !== null;
  }

  private run(authenticate: boolean): Promise<void> {
    if (this.replaced) return Promise.resolve();
    this.remote?.dispose();
    this.remote = null;
    const generation = ++this.generation;
    const task = this.execute(generation, authenticate).catch((error: unknown) => {
      if (this.current(generation)) this.fail(error);
    }).finally(() => {
      if (this.running === task) this.running = null;
    });
    this.running = task;
    return task;
  }

  private fail(error: unknown): void {
    if (error instanceof EntryApiError && error.kind === "http" && error.status === 409 && error.code === "DOCUMENT_STALE") {
      // Only an open of this same document answers so: a newer window of the installation took it over.
      this.replace();
      return;
    }
    this.resetInvalidSession(error);
    this.emit(failure(error));
  }

  /**
   * A request of this window got DOCUMENT_STALE: the shared transport reports it before the module reads the reply.
   * The core gives that answer to a replaced document, but also to a closed card context of the live one, so a
   * foreground of this same document decides. It asks one task later, on purpose: the module settles its refusal
   * first and clears its saved action from the storage that the installation's windows share; a window closed
   * before that would leave the action there to block the new window's next command.
   */
  documentStale(): void {
    if (this.disposed || this.replaced) return;
    this.staleHint = true;
    if (this.checking) return; // The running check answers this refusal too.
    // Synchronously: the module reads the refusal after this returns and must not be seen showing it (2.33).
    this.setChecking(true);
    setTimeout(() => {
      void (this.staleHint ? this.foreground() : Promise.resolve()).finally(() => this.setChecking(false));
    }, 0);
  }

  private setChecking(checking: boolean): void {
    if (this.checking === checking) return;
    this.checking = checking;
    if (!this.disposed) this.options.onDocumentCheck?.(checking);
  }

  /** A newer window of this installation took the document over (decision 2.3). Terminal for this window. */
  private replace(): void {
    if (this.disposed || this.replaced) return;
    this.replaced = true;
    this.generation += 1; // A late reply of this document must not reopen or relabel anything.
    this.releaseLock();
    this.remote?.dispose();
    this.remote = null;
    this.emit({ kind: "replaced" }, this.session?.profile);
    this.options.closeWindow?.();
  }

  private releaseLock(): void {
    this.claim = null;
    this.lease?.release();
    this.lease = null;
  }

  /**
   * The lock is no permission to open (the new window never waits for it): it only lets an older window of this
   * installation learn at once that its document was replaced. Taken after the server accepted this document.
   */
  private claimLock(key: string): void {
    if (this.lease || this.claim) return;
    const claim = {};
    this.claim = claim;
    let lease: DocumentLease | null = null;
    void this.options.lock.acquire(key, () => {
      if (lease !== null && this.lease === lease) this.replace();
    }).then((result) => {
      if (typeof result !== "object") return;
      if (this.claim !== claim) { result.release(); return; }
      lease = result;
      this.lease = result;
    }, () => undefined).finally(() => {
      if (this.claim === claim) this.claim = null;
    });
  }

  private resetInvalidSession(error: unknown): void {
    if (!(error instanceof EntryApiError) || error.kind !== "http"
      || (error.status !== 401 && error.status !== 403)) return;
    this.session = null;
    this.installation = null;
    this.documentId = null;
    this.staleHint = false;
    this.proofIssuedThisSession = false;
    this.remote?.dispose();
    this.remote = null;
    this.observedStateVersion = null;
    this.releaseLock();
  }

  private async execute(generation: number, authenticate: boolean): Promise<void> {
    this.emit({ kind: "checking" });
    if (authenticate) {
      if (!this.options.initData) { this.emit({ kind: "unavailable" }); return; }
      const response = await this.options.api.auth({
        init_data: this.options.initData,
        client_version: this.options.clientVersion,
        contract_version: this.options.contractVersion,
        saved_language: this.options.savedLanguage,
        browser_language: this.options.browserLanguage,
      });
      if (!this.current(generation)) return;
      this.session = response;
    }
    const session = this.session;
    if (!session) { this.emit({ kind: "unavailable" }); return; }
    // An incompatible client may read why (CT §1), so this is its own state, not "unavailable" (К10-060).
    if (!session.compatibility.compatible) { this.emit({ kind: "incompatible" }, session.profile); return; }
    const profile = session.profile;
    if (!this.acceptProfile(profile)) throw new EntryApiError("invalid_response");
    if (profile.access.status === "pending") {
      await this.dropSettledReapplyIntent(profile.profile_id);
      if (!this.current(generation)) return;
      this.emit({ kind: "pending" }, profile);
      return;
    }
    if (profile.access.status === "rejected") {
      this.reapplyIntent ??= await readReapplyIntent(this.options.storage, profile.profile_id);
      if (!this.current(generation)) return;
      if (this.conflictedIntentId) {
        if (this.reapplyIntent && this.reapplyIntent.commandId !== this.conflictedIntentId) {
          throw new Error("Conflicting pending action");
        }
        if (this.reapplyIntent) await clearReapplyIntent(this.options.storage, profile.profile_id);
        if (!this.current(generation)) return;
        this.conflictedIntentId = null;
        this.reapplyIntent = null;
      }
      if (this.conflictedAccessVersion) {
        if (!newerVersion(profile.access.version, this.conflictedAccessVersion)) {
          this.session = null;
          this.emit({ kind: "unavailable" });
          return;
        }
        this.conflictedAccessVersion = null;
      }
      this.emit(this.rejected(profile), profile);
      return;
    }
    this.emit({ kind: "opening" }, profile);
    await this.prepareInstallation(profile.profile_id);
    if (!this.current(generation)) return;
    if (!this.installation) throw new Error("Missing installation");
    if (!this.installation.proof) await this.register(session.access_token, generation);
    if (!this.current(generation)) return;
    try {
      await this.open(session.access_token, generation);
    } catch (error) {
      if (!(error instanceof EntryApiError) || error.kind !== "http" || error.status !== 403
        || this.installation?.activated || !this.proofIssuedThisSession || !this.current(generation)) throw error;
      // A late registration may have replaced a proof before this open reached the server.
      await this.register(session.access_token, generation);
      if (this.current(generation)) await this.open(session.access_token, generation);
    }
  }

  /** The refusal screen of a rejected profile; closed once no reapplication is left (CT §6.3). */
  private rejected(profile: Profile): EntryState {
    // An older core sends no reapply_closed: it reads as open, and its 403 to the reapply closes it below.
    const closed = profile.reapply_closed === true || this.reapplyClosedFor === profile.profile_id;
    const reason = profile.access.reason ?? undefined;
    return closed ? { kind: "rejected", reason, closed: true } : { kind: "rejected", reason };
  }

  /** Pending access means any earlier reapply was settled: its saved ID must not be resent later. */
  private async dropSettledReapplyIntent(profileId: string): Promise<void> {
    this.reapplyIntent = null;
    try {
      await clearReapplyIntent(this.options.storage, profileId);
    } catch {
      // reapply() also refuses an intent saved for another access version, so a failed cleanup
      // must not hide the confirmed pending state.
    }
  }

  private async prepareInstallation(profileId: string): Promise<void> {
    if (this.installation?.profileId === profileId) return;
    const stored = await readInstallation(this.options.storage, profileId);
    if (stored?.proof && stored.proofVersion) {
      this.installation = stored;
      return;
    }
    // Without a saved proof, a pending registration belongs to its old auth session.
    const created: Installation = {
      profileId,
      clientInstanceId: this.options.newId(),
      registrationId: this.options.newId(),
      proof: null,
      proofVersion: null,
      activated: false,
    };
    await writeInstallation(this.options.storage, created);
    this.installation = created;
  }

  private async register(token: string, generation: number): Promise<void> {
    const installation = this.installation;
    if (!installation) throw new Error("Missing installation");
    const response: RegisterResponse = await this.options.api.register(token, {
      client_instance_id: installation.clientInstanceId,
      registration_id: installation.registrationId,
    });
    if (!this.current(generation)) return;
    if (response.client_instance_id !== installation.clientInstanceId) throw new Error("Wrong installation");
    if (response.status === "already_registered") {
      if (!installation.proof) throw new Error("Proof unavailable");
      return;
    }
    if (!response.origin_proof || response.activated) throw new Error("Invalid registration");
    if (installation.proofVersion && newerVersion(installation.proofVersion, response.proof_version)) return;
    const updated: Installation = {
      ...installation, proof: response.origin_proof, proofVersion: response.proof_version,
    };
    await writeInstallation(this.options.storage, updated);
    if (this.current(generation)) {
      this.installation = updated;
      this.proofIssuedThisSession = true;
    }
  }

  private async open(token: string, generation: number, event: "open" | "foreground" = "open"): Promise<void> {
    if (this.replaced) return;
    const installation = this.installation;
    if (!installation?.proof || !installation.proofVersion) throw new Error("Proof unavailable");
    const timeZone = this.options.timeZone();
    if (!timeZone) throw new Error("Time zone unavailable");
    this.documentId ??= this.options.newId();
    const refused = this.refusedTarget;
    this.refusedTarget = null;
    if (this.options.remote && (!await this.prepareRemote(token, generation) || !this.current(generation))) return;
    // After DOCUMENT_STALE an open of this document would make it live again, taking it from the newer window
    // (question 2.30 is open). Only a foreground may ask until an answer confirms the document.
    if (this.staleHint) event = "foreground";
    // A new document of this installation always becomes the live one (decision 2.3): no lock flag, no confirmation.
    const request: OpenRequest = {
      client_instance_id: installation.clientInstanceId,
      document_id: this.documentId,
      time_zone: timeZone,
      event,
      client_version: this.options.clientVersion,
      contract_version: this.options.contractVersion,
    };
    const opened = await this.options.api.open(token, installation.proof, request);
    if (!this.current(generation)) return;
    if (opened.profile.access.status !== "admitted"
      || (this.observedStateVersion !== null && newerVersion(this.observedStateVersion, opened.profile.state_version))
      || !this.acceptProfile(opened.profile)) throw new EntryApiError("invalid_response");
    if (opened.status === "incompatible" || !opened.compatibility.compatible) {
      // The core neither made this document live nor activated the installation (В6): nothing is saved or locked here.
      if (opened.status === "incompatible" && opened.client_instance_id !== installation.clientInstanceId) {
        throw new Error("Invalid opened client");
      }
      this.emit({ kind: "incompatible" }, opened.profile);
      return;
    }
    this.staleHint = false; // The server answered for this document: it is still the live one.
    this.claimLock(`${opened.profile.profile_id}:${installation.clientInstanceId}`);
    if (opened.status === "SESSION_BUSY") {
      const { stop_remote_target: target } = opened.session;
      if (this.remote && target && refused && refused !== target) {
        this.emit({ kind: "remote_confirm", targetId: target, changed: true }, opened.profile);
        return;
      }
      this.emit({ kind: "busy", ...(this.remote && target ? { remoteTarget: target } : {}) }, opened.profile);
      return;
    }
    if (opened.client_instance_id !== installation.clientInstanceId || opened.document_id !== this.documentId
      || opened.proof_version !== installation.proofVersion) {
      throw new Error("Invalid opened client");
    }
    const updated = { ...installation, activated: true };
    await writeInstallation(this.options.storage, updated);
    if (!this.current(generation)) return;
    this.installation = updated;
    const access: OpenedAccess = createOpenedAccess({ opened, token, proof: installation.proof, generation,
      isLive: () => this.current(generation) && this.state.kind === "opened" && this.openedAccess === access,
      onDenied: error => {
        this.generation += 1; // A pending foreground reply must not restore revoked access.
        this.resetInvalidSession(error);
        this.emit(failure(error));
      },
    });
    this.openedAccess = access;
    this.emit({ kind: "opened" }, opened.profile);
  }

  private async prepareRemote(token: string, generation: number): Promise<boolean> {
    const remoteOptions = this.options.remote;
    if (!remoteOptions) return true;
    const installation = this.installation;
    const documentId = this.documentId;
    if (!installation?.proof || !documentId) return false;
    if (this.remote?.snapshot().phase === "settled") { this.remote.dispose(); this.remote = null; }
    if (!this.remote) {
      const proof = installation.proof;
      const addressed = (intent: RemoteStopIntent) => ({ ...intent,
        client_instance_id: installation.clientInstanceId, document_id: documentId });
      const remote = new RemoteStopController({
        profileId: installation.profileId, clientInstanceId: installation.clientInstanceId,
        pendingStore: remoteOptions.pendingStore, newId: this.options.newId,
        send: intent => remoteOptions.api.stop(token, proof, addressed(intent)),
        check: intent => remoteOptions.api.status(token, proof, addressed(intent)),
        onUpdate: snapshot => {
          if (!this.current(generation) || this.remote !== remote) return;
          if (snapshot.stateVersion) this.observeStateVersion(snapshot.stateVersion);
          if (snapshot.pending || snapshot.phase === "blocked") {
            if (snapshot.problem === "expired" || snapshot.problem === "forbidden") {
              this.resetInvalidSession(new EntryApiError("http", snapshot.problem === "expired" ? 401 : 403));
              this.emit({ kind: snapshot.problem === "expired" ? "expired" : "unavailable" });
              return;
            }
            this.emit({ kind: "remote", remote: snapshot }, this.session?.profile);
          }
        },
      });
      this.remote = remote;
    }
    const remote = this.remote;
    await remote.refresh();
    if (!this.current(generation) || this.remote !== remote) return false;
    if (remote.snapshot().phase === "settled") {
      remote.dispose();
      this.remote = null;
      return this.prepareRemote(token, generation);
    }
    return remote.snapshot().phase === "idle";
  }

  requestRemoteStop(): void {
    if (this.state.kind !== "busy" || !this.state.remoteTarget) return;
    this.requestRemoteStopFor(this.state.remoteTarget);
  }

  /** `tapped` is the target the user saw when pressing the button: a refreshed answer may name another session. */
  private requestRemoteStopFor(tapped: string): void {
    if (this.running) {
      // The busy screen and its button stay visible while a refresh settles occupancy. Keep the tap,
      // as foreground() keeps an event during startup, and ask once the current task has finished.
      this.queuedRemoteRequest ??= this.running.then(() => {
        this.queuedRemoteRequest = null;
        this.requestRemoteStopFor(tapped);
      });
      return;
    }
    if (this.state.kind !== "busy" || !this.state.remoteTarget || !this.remote) return;
    // The tap was for another session: it is no confirmation for this one, so say so and ask separately.
    const changed = this.state.remoteTarget !== tapped;
    this.emit({ kind: "remote_confirm", targetId: this.state.remoteTarget, ...(changed ? { changed: true as const } : {}) },
      this.session?.profile);
  }

  cancelRemoteStop(): void {
    if (this.running || this.state.kind !== "remote_confirm") return;
    this.emit({ kind: "busy", remoteTarget: this.state.targetId }, this.session?.profile);
  }

  private remoteAction(action: (remote: RemoteStopController) => Promise<void>): Promise<void> {
    if (this.running) return this.running;
    if (!this.remote || !this.session || this.disposed) return Promise.resolve();
    const remote = this.remote;
    const token = this.session.access_token;
    const generation = this.generation;
    const task = Promise.resolve().then(async () => {
      await action(remote);
      if (!this.current(generation) || this.remote !== remote) return;
      const phase = remote.snapshot().phase;
      if (phase === "idle" || phase === "settled") await this.open(token, generation);
    }).catch((error: unknown) => {
      if (this.current(generation)) this.fail(error);
    }).finally(() => {
      this.refusedTarget = null; // Only the reopen right after this action may use it.
      if (this.running === task) this.running = null;
    });
    this.running = task;
    return task;
  }

  confirmRemoteStop(): Promise<void> {
    if (this.state.kind !== "remote_confirm") return this.running ?? Promise.resolve();
    const target = this.state.targetId;
    return this.remoteAction(async remote => {
      await remote.confirm(target);
      if (remote.snapshot().outcome === "rejected") this.refusedTarget = target;
    });
  }

  checkRemoteStop(): Promise<void> {
    if (this.state.kind !== "remote") return this.running ?? Promise.resolve();
    return this.remoteAction(remote => remote.refresh());
  }

  retryRemoteStop(): Promise<void> {
    if (this.state.kind !== "remote") return this.running ?? Promise.resolve();
    return this.remoteAction(remote => remote.retry());
  }

  reapply(): Promise<void> {
    if (this.running) return this.running;
    if (this.conflictedIntentId || this.conflictedAccessVersion) return Promise.resolve();
    const session = this.session;
    if (!session || this.state.kind !== "rejected" || this.state.closed) return Promise.resolve();
    const reason = this.state.reason;
    const generation = ++this.generation;
    this.emit({ kind: "reapplying", reason });
    let confirmed = false;
    const task = (async () => {
      let intent = this.reapplyIntent;
      // An unknown outcome repeats its ID only while access is still at the version it was sent for.
      // After a newer decision that ID can only return the old fact, so the tap needs a new command.
      if (!intent || intent.expectedAccessVersion !== session.profile.access.version) {
        intent = {
          profileId: session.profile.profile_id,
          commandId: this.options.newId(),
          expectedAccessVersion: session.profile.access.version,
        };
        await writeReapplyIntent(this.options.storage, intent); // Replaces a stale intent under the same key.
        if (!this.current(generation)) return;
        this.reapplyIntent = intent;
      }
      if (!this.current(generation)) return;
      const response = await this.options.api.reapply(session.access_token, {
        command_id: intent.commandId,
        expected_access_version: intent.expectedAccessVersion,
      });
      if (!this.current(generation)) return;
      if (response.command.id !== intent.commandId || !this.acceptProfile(response.current)) {
        throw new EntryApiError("invalid_response");
      }
      confirmed = true;
      this.session = { ...session, profile: response.current };
      await clearReapplyIntent(this.options.storage, session.profile.profile_id);
      if (!this.current(generation)) return;
      this.reapplyIntent = null;
      if (response.current.access.status === "pending") {
        this.emit({ kind: "pending" }, response.current);
      } else if (response.current.access.status === "admitted") {
        await this.execute(generation, false);
      } else {
        this.emit(this.rejected(response.current), response.current);
      }
    })().catch(async (error: unknown) => {
      if (!this.current(generation)) return;
      if (!confirmed && error instanceof EntryApiError && error.kind === "http" && error.status === 403
        && error.code === "ACCESS_REJECTED") {
        // The core refused a third application and wrote nothing (CT §6.3). The sign-in still works, so the
        // session stays; the screen is the closed refusal, not "unavailable" with a retry that leads back here.
        this.reapplyClosedFor = session.profile.profile_id;
        this.reapplyIntent = null;
        try {
          await clearReapplyIntent(this.options.storage, session.profile.profile_id);
        } catch {
          // The saved ID was never applied; with no reapply button left it is never sent again.
        }
        if (this.current(generation)) this.emit(this.rejected(session.profile), session.profile);
        return;
      }
      this.resetInvalidSession(error);
      if (error instanceof EntryApiError && error.kind === "http" && error.status === 409
        && error.code === "VERSION_CONFLICT") {
        this.conflictedIntentId = this.reapplyIntent?.commandId ?? null;
        this.conflictedAccessVersion = this.reapplyIntent?.expectedAccessVersion ?? null;
        this.reapplyIntent = null;
        this.session = null;
        try {
          await clearReapplyIntent(this.options.storage, session.profile.profile_id);
          if (this.current(generation)) this.conflictedIntentId = null;
        } catch {
          // Keep the in-memory block until the known-unapplied ID is cleared.
        }
        if (this.current(generation)) this.emit({ kind: "unavailable" });
        return;
      }
      if (confirmed) { this.emit(failure(error)); return; }
      if (error instanceof EntryApiError && error.kind === "http") {
        // Known refusals of a write, each with its own meaning: neither is a network error nor a rejected access.
        if (error.status === 409 && error.code === "CLIENT_INCOMPATIBLE") { this.emit({ kind: "incompatible" }); return; }
        if (error.status === 503 && error.code === "MAINTENANCE") {
          const wait = error.pause?.waitSeconds;
          this.emit({ kind: "rejected", reason, pause: wait === null || wait === undefined ? {} : { waitSeconds: wait } });
          return;
        }
      }
      if (error instanceof EntryApiError && error.kind === "invalid_response") {
        this.emit({ kind: "unavailable" });
        return;
      }
      if (error instanceof EntryApiError && error.kind === "http" && (error.status === 401 || error.status === 403)) {
        this.emit(failure(error));
      } else {
        this.emit({ kind: "rejected", reason });
      }
    }).finally(() => {
      if (this.running === task) this.running = null;
    });
    this.running = task;
    return task;
  }

  dispose(): void {
    this.remote?.dispose();
    this.remote = null;
    this.disposed = true;
    this.generation += 1;
    this.releaseLock();
    this.session = null;
    this.openedAccess = null;
    this.busyAccess = null;
  }
}
