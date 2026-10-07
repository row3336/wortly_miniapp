import { useEffect, useInsertionEffect, useReducer, useRef, useState } from "react";
import type { HttpOptions } from "../api/http";
import { version } from "../api/wireValidation";
import type { OpenedAccess } from "../app/openedAccess";
import { admitted, identityKey, pairOf, runCurrent, useSuspendedAccesses } from "./accessBinding";
import { createDictionaryCardApi } from "./cardApi";
import {
  DictionaryHistoryController,
  type DictionaryHistoryActions, type DictionaryHistoryIo, type DictionaryHistorySnapshot,
} from "./dictionaryHistoryController";
import { createDictionaryHistoryApi } from "./historyApi";

export type { DictionaryHistoryActions, DictionaryHistoryEntry, DictionaryHistorySnapshot } from "./dictionaryHistoryController";
export type DictionaryHistoryDocumentOptions = {
  access: OpenedAccess;
  transport: HttpOptions;
  enabled: boolean;
};
type Scope = { key: string; transport: HttpOptions };
type Binding = { access: OpenedAccess; transport: HttpOptions; io: DictionaryHistoryIo };

function historyIo(access: OpenedAccess, transport: HttpOptions, live: () => boolean): DictionaryHistoryIo {
  const history = createDictionaryHistoryApi(transport), cards = createDictionaryCardApi(transport);
  return {
    live,
    history: current => runCurrent(access, current, token => history.read(token)),
    card: (cardId, current) => runCurrent(access, current, token => cards.read(token, cardId)),
  };
}

/**
 * The history lives for the whole hook; reads belong to the current access only. A new access object
 * (application foreground) rereads it, and so does `refresh`. Actions are stable.
 */
export function useDictionaryHistoryDocument(options: DictionaryHistoryDocumentOptions):
  { state: DictionaryHistorySnapshot; actions: DictionaryHistoryActions } {
  const pair = pairOf(options.access);
  if (!version(options.access.profile.state_version)) throw new Error("invalid dictionary state version");
  // Reads follow the committed render, never an interrupted one.
  const committed = useRef(options);
  useInsertionEffect(() => { committed.current = options; });
  const [, repaint] = useReducer((value: number) => value + 1, 0);
  const [{ controller, actions }] = useState(() => {
    const controller = new DictionaryHistoryController();
    const actions: DictionaryHistoryActions = Object.freeze({
      refresh: () => controller.refresh(),
      retry: () => controller.retry(),
      forget: (cardId?: string) => controller.forget(cardId),
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
    const { access, transport, enabled } = options;
    if (document.visibilityState !== "visible") suspended.add(access);
    const key = identityKey(access);
    if (!scope.current || scope.current.key !== key || scope.current.transport !== transport) scope.current = { key, transport };
    let io: DictionaryHistoryIo | null = null;
    if (enabled && admitted(access) && !suspended.has(access)) {
      let bound = binding.current;
      if (!bound || bound.access !== access || bound.transport !== transport) {
        const live = () => {
          const current = committed.current;
          return current.enabled && current.access === access && current.transport === transport && admitted(access)
            && !suspended.has(access) && document.visibilityState === "visible";
        };
        bound = binding.current = { access, transport, io: historyIo(access, transport, live) };
      }
      io = bound.io;
    }
    controller.commit({ access, pair: pairOf(access), scope: scope.current, floor: access.profile.state_version, io });
  });

  const state = controller.view({ access: options.access, pair, open: admitted(options.access) });
  return { state, actions };
}
