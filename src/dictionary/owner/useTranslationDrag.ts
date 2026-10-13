import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { suspendVerticalSwipes } from "../../platform/telegram";
import { dropIndex, shiftOf } from "./translationOrder";

/** R14-01: a field is picked up after a long press (~400 ms) without moving; a move before that is a scroll. */
export const LONG_PRESS_MS = 400;
export const MOVE_TOLERANCE_PX = 8;
/** The vertical gap between two fields in the list (ownerEditor.css .owner-translation-list gap). */
export const FIELD_GAP_PX = 8;

export type DragView = {
  /** The index of the picked-up field and where it would land now. */
  from: number;
  to: number;
  /** The pointer's vertical travel since the pickup (down is positive). */
  offset: number;
  height: number;
};
/** The last frame after a drop: the dropped field starts from where the pointer left it and glides into its place. */
type Settle = { key: string; residual: number; phase: "start" | "glide" };

type Pending = { index: number; key: string; pointerId: number; startX: number; startY: number; element: HTMLElement;
  timer: ReturnType<typeof setTimeout> };
type Active = { index: number; key: string; pointerId: number; startY: number; element: HTMLElement; heights: number[];
  restore: () => void };

export type TranslationDrag = {
  drag: DragView | null;
  /**
   * Pointer handlers of the field at `index` (its stable `key` identifies it through the reorder). The press starts at
   * the field; its move, release and cancel are followed on the whole document, so a release outside the row (a mouse
   * leaving it, a lost pointer capture) still ends the gesture.
   */
  handlers(index: number, key: string): {
    onPointerDown(event: ReactPointerEvent<HTMLElement>): void;
    onContextMenu(event: { preventDefault(): void }): void;
  };
  /** The row element of a field, measured at pickup. */
  register(index: number, element: HTMLElement | null): void;
  /** The CSS transform and transition of the field at `index` now. */
  styleOf(index: number, key: string): { transform?: string; transition?: string; zIndex?: number };
};

function frame(win: Window, callback: () => void): void {
  if (typeof win.requestAnimationFrame === "function") win.requestAnimationFrame(callback);
  else setTimeout(callback, 16);
}

/**
 * Long-press drag of the owner's translation fields (R14-01) on Pointer Events, no package: the picked-up field follows
 * the pointer, the others part smoothly by CSS transform, a drop reorders the list through `onDrop(from, to)`. While a
 * field is held, Telegram's vertical swipe is off (disableVerticalSwipes) and page scrolling is held; both come back at
 * the drop, a cancel or an unmount. Real-phone behaviour in the Telegram WebView is checked on DEV-38.
 */
export function useTranslationDrag(options: { count: number; enabled: boolean; onDrop(from: number, to: number): void;
  onPickUp?(index: number): void; win?: Window }): TranslationDrag {
  const win = options.win ?? window;
  const latest = useRef(options); latest.current = options;
  const rows = useRef(new Map<number, HTMLElement>());
  const pending = useRef<Pending | null>(null);
  const active = useRef<Active | null>(null);
  const [drag, setDragState] = useState<DragView | null>(null);
  // The drag as the handlers see it now; the state only paints it (no side effect inside a state updater).
  const view = useRef<DragView | null>(null);
  const setDrag = useCallback((next: DragView | null) => { view.current = next; setDragState(next); }, []);
  const [settle, setSettle] = useState<Settle | null>(null);

  // The document listeners of the gesture under way (null: none attached).
  const listening = useRef<(() => void) | null>(null);
  const unlisten = useCallback(() => { listening.current?.(); listening.current = null; }, []);

  const clearPending = useCallback(() => {
    const waiting = pending.current;
    if (waiting) clearTimeout(waiting.timer);
    pending.current = null;
    if (!active.current) unlisten();
  }, [unlisten]);

  const finish = useCallback((drop: boolean) => {
    clearPending();
    const held = active.current;
    unlisten();
    if (!held) return;
    active.current = null;
    held.restore();
    try { if (held.element.hasPointerCapture?.(held.pointerId)) held.element.releasePointerCapture(held.pointerId); } catch { /* gone */ }
    const current = view.current;
    setDrag(null);
    if (!drop || !current) return;
    const { from, to, offset, height } = current;
    // The dropped field's slot moved by the heights it passed; the rest of the pointer travel glides away.
    let travel = 0;
    for (let index = Math.min(from, to); index <= Math.max(from, to); index++) {
      if (index !== from) travel += (held.heights[index] ?? height) + FIELD_GAP_PX;
    }
    setSettle({ key: held.key, residual: offset - (to >= from ? travel : -travel), phase: "start" });
    if (to !== from) latest.current.onDrop(from, to);
  }, [clearPending, setDrag, unlisten]);

  // The drop frame: first without transitions at the old visual place, then the dropped field glides home.
  useEffect(() => {
    if (!settle) return;
    if (settle.phase === "start") frame(win, () => frame(win, () => setSettle(current => current && { ...current, phase: "glide" })));
    else {
      const timer = setTimeout(() => setSettle(null), 200);
      return () => clearTimeout(timer);
    }
  }, [settle, win]);

  // Page scrolling stays still while a field is held: a non-passive touchmove is cancelled (Telegram WebView, iOS).
  const holding = drag !== null;
  useEffect(() => {
    if (!holding) return;
    const hold = (event: Event) => { if (event.cancelable) event.preventDefault(); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") finish(false); };
    win.document.addEventListener("touchmove", hold, { passive: false });
    win.document.addEventListener("keydown", escape);
    return () => {
      win.document.removeEventListener("touchmove", hold);
      win.document.removeEventListener("keydown", escape);
    };
  }, [holding, win, finish]);

  useEffect(() => { if (!options.enabled) finish(false); }, [options.enabled, finish]);
  // An unmount in the middle of a drag gives the swipes back.
  useEffect(() => () => {
    clearPending();
    unlisten();
    active.current?.restore();
    active.current = null;
  }, [clearPending, unlisten]);

  const pickUp = useCallback(() => {
    const waiting = pending.current;
    pending.current = null;
    if (!waiting || !latest.current.enabled) { if (!active.current) unlisten(); return; }
    const heights = Array.from({ length: latest.current.count }, (_, index) => {
      const row = rows.current.get(index);
      return row ? row.getBoundingClientRect().height : 0;
    });
    try { waiting.element.setPointerCapture?.(waiting.pointerId); } catch { /* a released pointer cannot be captured */ }
    const focused = win.document.activeElement;
    // The text field under the finger must not keep the caret or start a selection while it travels.
    if (focused instanceof HTMLElement && waiting.element.contains(focused)) focused.blur();
    active.current = { index: waiting.index, key: waiting.key, pointerId: waiting.pointerId, startY: waiting.startY,
      element: waiting.element, heights, restore: suspendVerticalSwipes(win) };
    setSettle(null);
    setDrag({ from: waiting.index, to: waiting.index, offset: 0, height: heights[waiting.index] ?? 0 });
    latest.current.onPickUp?.(waiting.index);
  }, [win, setDrag, unlisten]);

  const pointerMove = useCallback((event: PointerEvent) => {
    const waiting = pending.current;
    if (waiting && waiting.pointerId === event.pointerId) {
      // Moving before the long press ends is a scroll or a text selection, not a pickup.
      if (Math.abs(event.clientX - waiting.startX) > MOVE_TOLERANCE_PX || Math.abs(event.clientY - waiting.startY) > MOVE_TOLERANCE_PX) {
        clearPending();
      }
      return;
    }
    const held = active.current;
    if (!held || held.pointerId !== event.pointerId) return;
    if (event.cancelable) event.preventDefault();
    const offset = event.clientY - held.startY;
    const to = dropIndex(held.index, offset, held.heights, FIELD_GAP_PX);
    if (view.current) setDrag({ ...view.current, offset, to });
  }, [clearPending, setDrag]);
  const pointerUp = useCallback((event: PointerEvent) => {
    if (pending.current?.pointerId === event.pointerId) { clearPending(); return; }
    if (active.current?.pointerId === event.pointerId) finish(true);
  }, [clearPending, finish]);
  const pointerCancel = useCallback((event: PointerEvent) => {
    if (pending.current?.pointerId === event.pointerId) { clearPending(); return; }
    // The system took the gesture over: the field goes back, nothing is reordered.
    if (active.current?.pointerId === event.pointerId) finish(false);
  }, [clearPending, finish]);

  const handlers = useCallback((index: number, key: string) => ({
    onPointerDown(event: ReactPointerEvent<HTMLElement>) {
      if (!latest.current.enabled || active.current || latest.current.count < 2) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      clearPending();
      pending.current = { index, key, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
        element: event.currentTarget, timer: setTimeout(pickUp, LONG_PRESS_MS) };
      if (!listening.current) {
        const document = win.document;
        document.addEventListener("pointermove", pointerMove, true);
        document.addEventListener("pointerup", pointerUp, true);
        document.addEventListener("pointercancel", pointerCancel, true);
        listening.current = () => {
          document.removeEventListener("pointermove", pointerMove, true);
          document.removeEventListener("pointerup", pointerUp, true);
          document.removeEventListener("pointercancel", pointerCancel, true);
        };
      }
    },
    onContextMenu(event: { preventDefault(): void }) {
      // A long press must not open the text menu of the field it picks up.
      if (pending.current || active.current) event.preventDefault();
    },
  }), [clearPending, pickUp, win, pointerMove, pointerUp, pointerCancel]);

  const register = useCallback((index: number, element: HTMLElement | null) => {
    if (element) rows.current.set(index, element); else rows.current.delete(index);
  }, []);

  const styleOf = (index: number, key: string) => {
    if (drag) {
      if (index === drag.from) return { transform: `translateY(${drag.offset}px)`, transition: "none", zIndex: 1 };
      return { transform: `translateY(${shiftOf(index, drag.from, drag.to, drag.height, FIELD_GAP_PX)}px)` };
    }
    if (settle) {
      if (settle.key === key) {
        return settle.phase === "start" ? { transform: `translateY(${settle.residual}px)`, transition: "none", zIndex: 1 }
          : { zIndex: 1 };
      }
      // The others are already at their new places: no transition back from their parted offsets.
      return settle.phase === "start" ? { transition: "none" } : {};
    }
    return {};
  };

  return { drag, handlers, register, styleOf };
}
