import { useEffect, useInsertionEffect, useReducer, useRef, useState } from "react";
import type { HttpOptions } from "../api/http";
import { oneOf, version } from "../api/wireValidation";
import { ClosedAccessError, type OpenedAccess } from "../app/openedAccess";
import {
  DictionarySearchController, searchLimits,
  type DictionarySearchActions, type DictionarySearchIo, type DictionarySearchSnapshot, type SearchLimits,
} from "./dictionarySearchController";
import { createDictionarySearchApi, type SearchMaterial } from "./searchApi";

export type { DictionarySearchActions, DictionarySearchSnapshot, SearchLimits } from "./dictionarySearchController";
export type DictionarySearchDocumentOptions = {
  access: OpenedAccess;
  transport: HttpOptions;
  enabled: boolean;
  limits: SearchLimits;
};
type Pair = NonNullable<DictionarySearchSnapshot["pair"]>;
type Scope = { key: string; transport: HttpOptions };
type Binding = { access: OpenedAccess; transport: HttpOptions; io: DictionarySearchIo };

function pairOf(access: OpenedAccess): Pair {
  const pair = `${access.profile.dictionary_language}-de`;
  if (!oneOf(pair, ["ru-de", "uk-de", "en-de"])) throw new Error("unknown dictionary pair");
  return pair as Pair;
}
function identityKey(access: OpenedAccess): string {
  return JSON.stringify([access.key, access.profile.profile_id, access.document.clientInstanceId,
    access.document.documentId, access.document.epoch, access.profile.dictionary_language]);
}
function open(access: OpenedAccess): boolean {
  return access.isLive() && access.profile.access.status === "admitted";
}

function searchIo(access: OpenedAccess, transport: HttpOptions, live: () => boolean): DictionarySearchIo {
  const api = createDictionarySearchApi(transport);
  return {
    live,
    read(request, current) {
      const requireCurrent = () => { if (!current()) throw new ClosedAccessError(); };
      return access.run(async ({ token }) => {
        requireCurrent();
        try {
          const page = await api.get(token, request);
          requireCurrent();
          return page;
        } catch (error) {
          // Obsolete denials must be discarded before access.run can revoke this handle.
          requireCurrent();
          throw error;
        }
      });
    },
  };
}

/**
 * Search input and results live for the whole hook; reads belong to the current access only.
 * Actions are stable. Call `enterFromSection` in the same event or layout effect that delivers
 * a new access: both are sent as one read when the commit's passive effect runs.
 */
export function useDictionarySearchDocument(options: DictionarySearchDocumentOptions):
  { state: DictionarySearchSnapshot; actions: DictionarySearchActions } {
  searchLimits(options.limits);
  const pair = pairOf(options.access);
  if (!version(options.access.profile.state_version)) throw new Error("invalid dictionary state version");
  // Reads and suspension follow the committed render. An interrupted or suspended render must not
  // retarget them; insertion effects run in the commit, before any layout effect can call an action.
  const committed = useRef(options);
  useInsertionEffect(() => { committed.current = options; });
  const [, repaint] = useReducer((value: number) => value + 1, 0);
  const [{ controller, actions }] = useState(() => {
    const controller = new DictionarySearchController();
    const actions: DictionarySearchActions = Object.freeze({
      setQuery: (query: string) => controller.setQuery(query),
      setMaterial: (material: SearchMaterial) => controller.setMaterial(material),
      submit: () => controller.submit(),
      loadMore: () => controller.loadMore(),
      retry: () => controller.retry(),
      enterFromSection: (...unexpected: never[]) => controller.enterFromSection(...unexpected),
    });
    return { controller, actions };
  });
  const suspended = useRef(new WeakSet<OpenedAccess>());
  const scope = useRef<Scope | null>(null), binding = useRef<Binding | null>(null);

  useEffect(() => {
    controller.attach(repaint);
    return () => controller.detach();
  }, [controller]);
  useEffect(() => {
    const suspend = () => { suspended.current.add(committed.current.access); repaint(); };
    document.addEventListener("visibilitychange", suspend, true);
    window.addEventListener("pageshow", suspend, true);
    return () => {
      document.removeEventListener("visibilitychange", suspend, true);
      window.removeEventListener("pageshow", suspend, true);
    };
  }, []);
  // Every commit, after all layout effects: the only place where reads are sent.
  useEffect(() => {
    const { access, transport, enabled, limits } = options;
    if (document.visibilityState !== "visible") suspended.current.add(access);
    const key = identityKey(access);
    if (!scope.current || scope.current.key !== key || scope.current.transport !== transport) scope.current = { key, transport };
    let io: DictionarySearchIo | null = null;
    if (enabled && open(access) && !suspended.current.has(access)) {
      let bound = binding.current;
      if (!bound || bound.access !== access || bound.transport !== transport) {
        const live = () => {
          const current = committed.current;
          return current.enabled && current.access === access && current.transport === transport && open(access)
            && !suspended.current.has(access) && document.visibilityState === "visible";
        };
        bound = binding.current = { access, transport, io: searchIo(access, transport, live) };
      }
      io = bound.io;
    }
    controller.commit({ access, pair: pairOf(access), scope: scope.current, floor: access.profile.state_version, limits, io });
  });

  const state = controller.view({ access: options.access, pair, open: open(options.access) });
  return { state, actions };
}
