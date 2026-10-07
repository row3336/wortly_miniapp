import { useEffect, useInsertionEffect, useReducer, useRef, useState } from "react";
import type { HttpOptions } from "../api/http";
import { version } from "../api/wireValidation";
import type { OpenedAccess } from "../app/openedAccess";
import { admitted as open, identityKey, pairOf, runCurrent, useSuspendedAccesses } from "./accessBinding";
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
type Scope = { key: string; transport: HttpOptions };
type Binding = { access: OpenedAccess; transport: HttpOptions; io: DictionarySearchIo };

function searchIo(access: OpenedAccess, transport: HttpOptions, live: () => boolean): DictionarySearchIo {
  const api = createDictionarySearchApi(transport);
  return {
    live,
    read: (request, current) => runCurrent(access, current, token => api.get(token, request)),
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
  const suspended = useSuspendedAccesses(() => committed.current.access, repaint);
  const scope = useRef<Scope | null>(null), binding = useRef<Binding | null>(null);

  useEffect(() => {
    controller.attach(repaint);
    return () => controller.detach();
  }, [controller]);
  // Every commit, after all layout effects: the only place where reads are sent.
  useEffect(() => {
    const { access, transport, enabled, limits } = options;
    if (document.visibilityState !== "visible") suspended.add(access);
    const key = identityKey(access);
    if (!scope.current || scope.current.key !== key || scope.current.transport !== transport) scope.current = { key, transport };
    let io: DictionarySearchIo | null = null;
    if (enabled && open(access) && !suspended.has(access)) {
      let bound = binding.current;
      if (!bound || bound.access !== access || bound.transport !== transport) {
        const live = () => {
          const current = committed.current;
          return current.enabled && current.access === access && current.transport === transport && open(access)
            && !suspended.has(access) && document.visibilityState === "visible";
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
