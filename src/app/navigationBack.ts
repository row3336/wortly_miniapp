import { useEffect, useLayoutEffect, useRef } from "react";
import { bindBackButton } from "../platform/telegram";

/**
 * Native Back runs the same transition as the visible control (TA:86). Priority: a modal window closes first,
 * then an unsaved personal field asks its own confirmation, then the current screen handles Back.
 */
export type BackLayer = "overlay" | "guard" | "screen";
const priority: readonly BackLayer[] = ["overlay", "guard", "screen"];

type Entry = { layer: BackLayer; run(): void };

/** One Telegram binding per window, whatever number of owners currently supply a handler. */
class BackDispatcher {
  private readonly entries: Entry[] = [];
  private unbind: (() => void) | null = null;
  constructor(private readonly win: Window) {}

  add(entry: Entry): () => void {
    this.entries.push(entry);
    this.unbind ??= bindBackButton(this.win, () => this.dispatch());
    return () => {
      const index = this.entries.indexOf(entry);
      if (index >= 0) this.entries.splice(index, 1);
      if (this.entries.length === 0) { this.unbind?.(); this.unbind = null; }
    };
  }

  /** The most recent handler of the highest layer; one press never runs two transitions. */
  private dispatch(): void {
    for (const layer of priority) {
      for (let index = this.entries.length - 1; index >= 0; index--) {
        if (this.entries[index].layer === layer) { this.entries[index].run(); return; }
      }
    }
  }
}

const dispatchers = new WeakMap<Window, BackDispatcher>();
function dispatcherOf(win: Window): BackDispatcher {
  let dispatcher = dispatchers.get(win);
  if (!dispatcher) { dispatcher = new BackDispatcher(win); dispatchers.set(win, dispatcher); }
  return dispatcher;
}

/**
 * Supplies native Back for one layer while `handler` is present. Only a committed render supplies the handler,
 * and the binding follows presence alone: a new handler identity never hides and shows the button again.
 */
export function useBackLayer(layer: BackLayer, handler: (() => void) | null): void {
  const current = useRef<() => void>(() => {});
  useLayoutEffect(() => { if (handler) current.current = handler; });
  const present = handler !== null;
  useEffect(() => present ? dispatcherOf(window).add({ layer, run: () => current.current() }) : undefined, [layer, present]);
}

/**
 * Extension point for an unsaved personal field (M-EDIT): while `confirm` is present, native Back runs it instead
 * of leaving the screen, so the editor asks its own confirmation (TA:86, Т31).
 */
export function useUnsavedFieldBack(confirm: (() => void) | null): void {
  useBackLayer("guard", confirm);
}
