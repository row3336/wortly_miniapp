import { useEffect, type RefObject } from "react";

/**
 * Enter on a shown result works as «Далее». Only an advancing result listens; the effect follows the result itself,
 * so a newer result re-registers the listener as the screens always did.
 */
export function useEnterNext(root: RefObject<HTMLElement | null>, composing: RefObject<boolean>,
  submitOnEnter: boolean, result: unknown, canNext: boolean, actions: { next(): Promise<void> }): void {
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "Enter" || !submitOnEnter || !result || !canNext) return;
      // Enter of an IME composition, a held key or a repeated event never advances (TA §2).
      if (event.repeat || composing.current || event.isComposing || event.keyCode === 229) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target !== document.body && !root.current?.contains(target)) return;
      // A focused control owns Enter; bubbling must not bypass its selected grade or action.
      if (target.closest('button, a, input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
      event.preventDefault(); void actions.next();
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [submitOnEnter, result, canNext, actions]);
}
