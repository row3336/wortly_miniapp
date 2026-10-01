import { useCallback, useEffect, useReducer, useRef } from "react";
import type { HttpOptions } from "../api/http";
import type { OpenedAccess } from "../app/openedAccess";
import { SessionResumeController, type SessionResumeState } from "./sessionResumeController";

type Options = {
  access: OpenedAccess;
  transport: HttpOptions;
  minimumStateVersion?: string;
  /** Read the initial mode only until the application has selected its study owner. */
  enabled: boolean;
};
export type SessionResumeDocument = { state: SessionResumeState; refresh(): Promise<void> };
type Owner = {
  key: string;
  profileId: string;
  dictionaryLanguage: string;
  clientInstanceId: string;
  documentId: string;
  epoch: string;
  transport: HttpOptions;
  lastAccess: OpenedAccess;
  lastMinimum: string | undefined;
  lastProfileVersion: string;
  controller: SessionResumeController;
};

/** Owns addressed initial-mode reads, never navigation, pending recovery or study commands. */
export function useSessionResumeDocument(options: Options): SessionResumeDocument {
  const latest = useRef(options); latest.current = options;
  const owner = useRef<Owner | null>(null);
  const [, repaint] = useReducer((version: number) => version + 1, 0);
  const lookup = () => {
    const bound = owner.current, current = latest.current, access = current.access;
    const profile = access.profile, document = access.document;
    return current.enabled && access.isLive() && profile.access.status === "admitted"
      && bound?.key === access.key && bound.profileId === profile.profile_id
      && bound.dictionaryLanguage === profile.dictionary_language
      && bound.clientInstanceId === document.clientInstanceId && bound.documentId === document.documentId
      && bound.epoch === document.epoch && bound.transport === current.transport ? bound : null;
  };
  const currentOwner = useRef(lookup); currentOwner.current = lookup;
  const profile = options.access.profile, document = options.access.document;
  const live = options.access.isLive() && profile.access.status === "admitted";

  useEffect(() => {
    const current = latest.current;
    if (!current.enabled || !current.access.isLive() || current.access.profile.access.status !== "admitted") return;
    let active = true;
    const controller = new SessionResumeController({
      access: () => latest.current.access,
      transport: current.transport,
      minimumStateVersion: () => latest.current.minimumStateVersion ?? latest.current.access.profile.state_version,
      onUpdate() { if (active && currentOwner.current() === bound) repaint(); },
    });
    const bound: Owner = {
      key: current.access.key, profileId: current.access.profile.profile_id,
      dictionaryLanguage: current.access.profile.dictionary_language,
      clientInstanceId: current.access.document.clientInstanceId, documentId: current.access.document.documentId,
      epoch: current.access.document.epoch, transport: current.transport,
      lastAccess: current.access, lastMinimum: current.minimumStateVersion,
      lastProfileVersion: current.access.profile.state_version, controller,
    };
    owner.current = bound;
    void controller.refresh();
    return () => { active = false; controller.dispose(); if (owner.current === bound) owner.current = null; };
  }, [options.access.key, profile.profile_id, profile.dictionary_language, document.clientInstanceId,
    document.documentId, document.epoch, options.transport, options.enabled, live]);

  useEffect(() => {
    const bound = currentOwner.current();
    if (!bound) return;
    if (bound.lastAccess === options.access && bound.lastMinimum === options.minimumStateVersion
      && bound.lastProfileVersion === profile.state_version) return;
    bound.lastAccess = options.access;
    bound.lastMinimum = options.minimumStateVersion;
    bound.lastProfileVersion = profile.state_version;
    void bound.controller.refresh();
    // A coalesced read may already cover this floor and emit no new update.
    repaint();
  }, [options.access, options.minimumStateVersion, profile.state_version]);

  const refresh = useCallback(() => currentOwner.current()?.controller.refresh() ?? Promise.resolve(), []);
  const bound = lookup();
  let state: SessionResumeState;
  if (!options.enabled) state = { kind: "idle" };
  else if (!live) state = { kind: "disposed" };
  else if (!bound) state = { kind: options.access.session === null ? "idle" : "loading" };
  // Mask a previous ready during render, before the new source/floor refresh effect runs.
  else if (bound.lastAccess !== options.access || bound.lastMinimum !== options.minimumStateVersion
    || bound.lastProfileVersion !== profile.state_version) state = { kind: "loading" };
  else state = bound.controller.snapshot();
  return { state, refresh };
}
