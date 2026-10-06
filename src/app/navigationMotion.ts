import { useLayoutEffect, useRef, type RefObject } from "react";
import type { Route } from "./navigation";

/** П1 (selection.json, RA табл. 6.1.2): a short horizontal shift with opacity; the easing follows the prototype. */
export const screenTransition = { distancePx: 24, durationMs: 240, easing: "cubic-bezier(.2,.7,.2,1)" } as const;

/** The incoming screen enters from the right going forward; going back mirrors it. */
export function transitionFrames(direction: "forward" | "back"): Keyframe[] {
  const offset = direction === "forward" ? screenTransition.distancePx : -screenTransition.distancePx;
  return [{ transform: `translateX(${offset}px)`, opacity: 0 }, { transform: "translateX(0)", opacity: 1 }];
}

/** The system setting only; the product adds no motion switch of its own (RA табл. 6.1.2). */
export function prefersReducedMotion(win: Window): boolean {
  return win.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/**
 * Plays П1 on the screen container whenever the route changes. A newer change or unmount cancels the running motion,
 * so a stale animation never finishes over another screen (TA §2); with reduced motion the screen changes statically.
 */
export function useScreenTransition(container: RefObject<HTMLElement | null>, route: Route): void {
  const running = useRef<Animation | null>(null);
  useLayoutEffect(() => {
    running.current?.cancel();
    running.current = null;
    const element = container.current;
    if (!element || route.direction === "none" || typeof element.animate !== "function" || prefersReducedMotion(window)) return;
    running.current = element.animate(transitionFrames(route.direction),
      { duration: screenTransition.durationMs, easing: screenTransition.easing });
  }, [container, route]);
  useLayoutEffect(() => () => { running.current?.cancel(); running.current = null; }, []);
}
