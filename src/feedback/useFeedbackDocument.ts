import { useEffect, useMemo, useReducer, useRef } from "react";
import type { HttpOptions } from "../api/http";
import type { OpenedAccess } from "../app/openedAccess";
import { createFeedbackApi } from "./feedbackApi";
import { FeedbackController, type FeedbackSnapshot } from "./feedbackController";
import type { FeedbackPendingStore } from "./feedbackPending";

type Options = { access: OpenedAccess; transport: HttpOptions; pendingStore: FeedbackPendingStore };
export type FeedbackDocument = {
  state: FeedbackSnapshot;
  actions: Pick<FeedbackController, "edit" | "send" | "retry">;
};
type Owner = { key: string; transport: HttpOptions; store: FeedbackPendingStore; controller: FeedbackController };
const initial: FeedbackSnapshot = { phase: "loading", text: "", confirmed: false, refusal: null, problem: null,
  canEdit: false, canSend: false, canRetry: false };

/** One message owner per opened document: the unsent text survives leaving the screen and returning to the foreground. */
export function useFeedbackDocument(options: Options): FeedbackDocument {
  const latest = useRef(options); latest.current = options;
  const owner = useRef<Owner | null>(null);
  const lastAccess = useRef(options.access);
  const [, repaint] = useReducer((version: number) => version + 1, 0);
  const lookup = () => {
    const bound = owner.current, current = latest.current;
    return bound?.key === current.access.key && bound.transport === current.transport && bound.store === current.pendingStore
      ? bound : null;
  };
  const currentOwner = useRef(lookup); currentOwner.current = lookup;

  useEffect(() => {
    const current = latest.current;
    if (!current.access.isLive() || current.access.profile.access.status !== "admitted") return;
    let live = true;
    const controller = new FeedbackController({ api: createFeedbackApi(current.transport), pendingStore: current.pendingStore,
      access: () => latest.current.access, newId: () => window.crypto.randomUUID(),
      onUpdate: () => { if (live && owner.current === bound) repaint(); } });
    const bound: Owner = { key: current.access.key, transport: current.transport, store: current.pendingStore, controller };
    owner.current = bound;
    lastAccess.current = current.access;
    void controller.refresh();
    return () => { live = false; controller.dispose(); if (owner.current === bound) owner.current = null; };
  }, [options.access.key, options.transport, options.pendingStore]);

  // A returning foreground gives a new handle: an unconfirmed message is checked again by its own command_id.
  useEffect(() => {
    if (lastAccess.current === options.access) return;
    lastAccess.current = options.access;
    void currentOwner.current()?.controller.refresh();
  }, [options.access]);

  const actions = useMemo<FeedbackDocument["actions"]>(() => ({
    edit: text => currentOwner.current()?.controller.edit(text),
    send: () => currentOwner.current()?.controller.send() ?? Promise.resolve(),
    retry: () => currentOwner.current()?.controller.retry() ?? Promise.resolve(),
  }), []);
  return { state: lookup()?.controller.snapshot() ?? initial, actions };
}
