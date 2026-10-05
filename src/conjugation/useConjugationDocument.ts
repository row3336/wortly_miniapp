import { useEffect, useMemo, useReducer, useRef } from "react";
import type { OpenedAccess } from "../app/openedAccess";
import { sameId, version } from "../api/wireValidation";
import { ConjugationDocumentController, type ConjugationAcceptedAddress, type ConjugationDocumentActions,
  type ConjugationDocumentOptions, type ConjugationDocumentSnapshot } from "./conjugationDocumentController";

export type ConjugationDocumentHookOptions = Omit<ConjugationDocumentOptions,
  "onUpdate" | "isLive" | "activity" | "terminalSessionIds" | "minimumStateVersion" | "initialResultAddress"> & {
  minimumStateVersion: string | null;
  enabled: boolean;
};
/** Floor, terminal memory and A's address survive source replacement within one semantic document tuple. */
type Retained = { key: string; floor: string; terminal: Set<string>; address: ConjugationAcceptedAddress | null };
type Owner = { access: OpenedAccess; transport: ConjugationDocumentHookOptions["transport"];
  studyStore: ConjugationDocumentHookOptions["studyStore"]; stopStore: ConjugationDocumentHookOptions["stopStore"];
  seed: string | null; retained: Retained; controller: ConjugationDocumentController; waiting: boolean };

/** (profile, client, document, epoch, pair); deliberately independent of access object, transport and stores. */
function retentionKey(options: ConjugationDocumentHookOptions): string {
  const { access } = options, profile = access.profile;
  return JSON.stringify([profile.profile_id.toLowerCase(), access.document.clientInstanceId.toLowerCase(),
    access.document.documentId.toLowerCase(), access.document.epoch, profile.dictionary_language]);
}
function raise(record: Retained, value: string | null | undefined): void {
  if (typeof value === "string" && version(value) && BigInt(value) > BigInt(record.floor)) record.floor = value;
}
function remember(record: Retained, snapshot: ConjugationDocumentSnapshot): void {
  raise(record, snapshot.stateVersion);
  snapshot.terminalSessionIds.forEach(item => record.terminal.add(item.toLowerCase()));
  // C3: only a non-empty address replaces it; null, masked or disposed snapshots never erase it.
  // Another selected session or a confirmed terminal of its own session removes it.
  if (record.address && snapshot.sessionId !== null && !sameId(record.address.session_id, snapshot.sessionId)) record.address = null;
  if (snapshot.acceptedAddress) record.address = { ...snapshot.acceptedAddress };
  if (record.address && record.terminal.has(record.address.session_id.toLowerCase())) record.address = null;
}

/** React Adapter for document lifetime only. Render creates nothing and sends nothing: it masks a
 * replaced source or raised floor through ref guards and updates retained metadata. The renderer
 * owns the actual visible commit and calls actions.shown with the opaque ticket. */
export function useConjugationDocument(options: ConjugationDocumentHookOptions): {
  state: ConjugationDocumentSnapshot | null; actions: ConjugationDocumentActions;
} {
  const latest = useRef(options); latest.current = options;
  const owner = useRef<Owner | null>(null), retained = useRef<Retained | null>(null);
  const [, repaint] = useReducer((value: number) => value + 1, 0);
  const retain = (current: ConjugationDocumentHookOptions): Retained => {
    const key = retentionKey(current);
    if (!retained.current || retained.current.key !== key) {
      retained.current = { key, floor: current.access.profile.state_version, terminal: new Set(), address: null };
    }
    raise(retained.current, current.access.profile.state_version);
    raise(retained.current, current.minimumStateVersion);
    return retained.current;
  };
  const lookup = (): Owner | null => {
    const bound = owner.current, current = latest.current;
    return bound && bound.access === current.access && bound.transport === current.transport
      && bound.studyStore === current.studyStore && bound.stopStore === current.stopStore
      && bound.seed === current.initialSessionId && bound.retained === retained.current ? bound : null;
  };
  const find = useRef(lookup); find.current = lookup;

  useEffect(() => {
    const current = latest.current;
    if (!current.access.isLive() || current.access.profile.access.status !== "admitted") return;
    const record = retain(current);
    let active = true;
    // Assigned right after construction; the controller may consult its guards while constructing.
    let bound: Owner | undefined;
    const visible = () => !!bound && !bound.waiting && document.visibilityState === "visible";
    const controller = new ConjugationDocumentController({
      access: current.access, transport: current.transport, studyStore: current.studyStore, stopStore: current.stopStore,
      initialSessionId: current.initialSessionId, initialResultAddress: record.address, newId: () => latest.current.newId(),
      terminalSessionIds: [...record.terminal],
      isLive: () => active && !!bound && find.current() === bound,
      activity: () => ({ enabled: latest.current.enabled === true, visible: visible() }),
      minimumStateVersion: () => {
        if (retained.current === record) raise(record, latest.current.minimumStateVersion);
        return record.floor;
      },
      onUpdate(snapshot) {
        if (!active || owner.current !== bound || find.current() !== bound) return;
        remember(record, snapshot); repaint();
      },
    });
    const owned: Owner = bound = { access: current.access, transport: current.transport, studyStore: current.studyStore,
      stopStore: current.stopStore, seed: current.initialSessionId, retained: record, controller, waiting: false };
    owner.current = owned;
    // Hidden or restored-from-cache pages close this owner's foreground until a fresh access owner.
    const suspend = () => {
      if (!active || find.current() !== owned) return;
      owned.waiting = true;
      controller.setActivity({ enabled: latest.current.enabled === true, visible: false });
    };
    document.addEventListener("visibilitychange", suspend, true);
    window.addEventListener("pageshow", suspend, true);
    if (document.visibilityState !== "visible") suspend();
    else controller.setActivity({ enabled: current.enabled === true, visible: true });
    void controller.refresh(); repaint();
    return () => {
      document.removeEventListener("visibilitychange", suspend, true);
      window.removeEventListener("pageshow", suspend, true);
      active = false;
      remember(record, controller.snapshot());
      controller.dispose();
      if (owner.current === owned) owner.current = null;
    };
  }, [options.access, options.transport, options.studyStore, options.stopStore, options.initialSessionId]);

  useEffect(() => {
    const bound = find.current();
    if (!bound) return;
    bound.controller.setActivity({ enabled: options.enabled === true, visible: !bound.waiting && document.visibilityState === "visible" });
    if (!bound.waiting) void bound.controller.refresh();
  }, [options.enabled, options.minimumStateVersion]);

  const actions = useMemo<ConjugationDocumentActions>(() => {
    const perform = <T>(action: (controller: ConjugationDocumentController) => T, idle: T): T => {
      const bound = find.current();
      return bound ? action(bound.controller) : idle;
    };
    const none = () => Promise.resolve();
    return {
      refresh: () => perform(c => c.refresh(), none()), start: () => perform(c => c.start(), none()),
      openStep: ticket => perform(c => c.openStep(ticket), undefined), openResult: () => perform(c => c.openResult(), undefined),
      shown: ticket => perform(c => c.shown(ticket), none()),
      submit: answer => perform(c => c.submit(answer), none()),
      grade: value => perform(c => c.grade(value), none()), correct: () => perform(c => c.correct(), none()),
      stop: reason => perform(c => c.stop(reason), none()), retry: lane => perform(c => c.retry(lane), none()),
    };
  }, []);

  retain(options);
  const bound = lookup();
  // Mask a replaced source (or a floor raised by props) on render, before passive effect cleanup.
  const state = bound ? bound.controller.snapshot() : null;
  if (bound && state) remember(bound.retained, state);
  return { state, actions };
}
