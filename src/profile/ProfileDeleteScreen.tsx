import { useEffect, useRef, useState } from "react";
import type { HttpOptions } from "../api/http";
import type { OpenedAccess } from "../app/openedAccess";
import type { RecoveryClock } from "../commands/recoveryClock";
import type { Language } from "../i18n/language";
import { navigationText } from "../i18n/messages";
import type { AsyncStorage } from "../platform/storage";
import { createProfileDeleteApi, type ProfileDeleteApi } from "./profileDeleteApi";
import { ProfileDeleteController, type DeleteSnapshot, type DeletionEnd } from "./profileDeleteController";
import { deleteText } from "./profileDeleteCopy";

/** What the Settings host needs to offer the deletion; without it Settings show no deletion item. */
export type ProfileDeletion = {
  storage: AsyncStorage;
  newId(): string;
  onEnded(end: DeletionEnd): void;
  /** Tests inject a fake API and a manual clock; the app builds the API from its transport. */
  api?: ProfileDeleteApi;
  clock?: RecoveryClock;
};

/**
 * The item in the client area of Settings (П5-006, Q12): its title and the button that opens the deletion screen. The
 * owner (Profile.role='owner', Q-DEL-1) sees the item with the button unavailable and the explanation beside it.
 */
export function ProfileDeleteItem({ access, language, onOpen }: { access: OpenedAccess; language: Language; onOpen(): void }) {
  const d = deleteText(language), owner = access.profile.role === "owner";
  return <section className="settings-group profile-delete" aria-labelledby="profile-delete-title">
    <h2 id="profile-delete-title">{d.group}</h2>
    <div className="settings-group-body">
      <button type="button" className="settings-secondary" disabled={owner} onClick={owner ? undefined : onOpen}
        aria-describedby={owner ? "profile-delete-owner" : undefined}>{d.open}</button>
      {owner && <p id="profile-delete-owner" className="settings-help">{d.ownerNote}</p>}
    </div>
  </section>;
}

/**
 * The deletion screen: the question with the final button active after 5 s, then the outcome. Its controller — and with
 * it the intent {profile_id, command_id} — lives exactly as long as this screen is mounted (Q-DEL-4).
 */
export function ProfileDeleteScreen({ access, transport, language, deletion, onClose }: {
  access: OpenedAccess; transport: HttpOptions; language: Language; deletion: ProfileDeletion; onClose(): void;
}) {
  const latest = useRef(access); latest.current = access;
  const settings = useRef(deletion); settings.current = deletion;
  const [controller, setController] = useState<ProfileDeleteController | null>(null);
  const [snapshot, setSnapshot] = useState<DeleteSnapshot | null>(null);
  useEffect(() => {
    // One controller per mount (also under StrictMode's second mount); unmount disposes it with its intent.
    const options = settings.current;
    const created = new ProfileDeleteController({
      // The access as the document has it now; the controller itself tells a dead or replaced one from another document.
      api: options.api ?? createProfileDeleteApi(transport), access: () => latest.current,
      gate: transport.gate, storage: options.storage, newId: options.newId, clock: options.clock,
      onUpdate: setSnapshot, onEnded: end => settings.current.onEnded(end),
    });
    setController(created);
    created.open();
    setSnapshot(created.snapshot());
    return () => created.dispose();
  }, [transport]);
  // A foreground of the same document gives this screen a new access: a waiting repeat goes on with it (P2-2).
  useEffect(() => { controller?.accessChanged(); }, [access, controller]);
  if (!controller || !snapshot) return null;
  const d = deleteText(language);
  const { phase } = snapshot;
  const status = phase === "sending" && !snapshot.repeating ? d.sending
    : snapshot.repeating ? d.repeating : phase === "checking" ? d.sending : null;
  const again = phase === "refused" || phase === "not_deleted";
  // An intent dropped by the controller (another access) leaves no empty screen: the line, if any, and a new start.
  const idle = phase === "idle";
  return <main className="settings-screen profile-delete-screen" lang={language}>
    <header className="settings-header">
      <button type="button" className="settings-secondary" onClick={onClose}>{navigationText(language).back}</button>
      <h1>{d.group}</h1>
    </header>
    {phase === "asking" && <section className="settings-group" role="alertdialog" aria-labelledby="profile-delete-question">
      <p id="profile-delete-question">{d.question}</p>
      {snapshot.remainingS !== null && snapshot.remainingS > 0 && <p className="settings-help" role="status">{d.wait(snapshot.remainingS)}</p>}
      {snapshot.paused && <p className="settings-error" role="alert">{d.paused}</p>}
      <div className="settings-actions">
        <button type="button" className="settings-secondary" onClick={onClose}>{d.cancel}</button>
        <button type="button" className="settings-primary" disabled={!snapshot.canConfirm}
          onClick={() => controller.confirm()}>{d.confirm}</button>
      </div>
    </section>}
    {status && <p role="status">{status}</p>}
    {phase === "stuck" && <div className="settings-error" role="alert">
      <p>{d.stuck}</p>
      <button type="button" className="settings-secondary" disabled={!snapshot.canCheck} onClick={() => controller.check()}>{d.check}</button>
    </div>}
    {idle && <div className={snapshot.droppedUnknown ? "settings-error" : undefined} role={snapshot.droppedUnknown ? "alert" : undefined}>
      {snapshot.droppedUnknown && <p>{d.dropped}</p>}
      {snapshot.canOpen && <button type="button" className="settings-secondary" onClick={() => controller.open()}>{d.open}</button>}
    </div>}
    {again && <div className="settings-error" role="alert">
      <p>{phase === "not_deleted" ? d.notDeleted
        : snapshot.refusalCode === "CLIENT_INCOMPATIBLE" ? d.refusedIncompatible : d.refused}</p>
      {snapshot.canOpen && <button type="button" className="settings-secondary" onClick={() => controller.open()}>{d.open}</button>}
    </div>}
  </main>;
}
