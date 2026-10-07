import { useLayoutEffect, useRef, type RefObject } from "react";
import type { Route } from "./navigation";

/** П1 (selection.json, RA табл. 6.1.2): a short horizontal shift with opacity; the easing follows the prototype. */
export const screenTransition = { distancePx: 24, durationMs: 240, easing: "cubic-bezier(.2,.7,.2,1)" } as const;

/** The incoming screen enters from the right going forward; going back mirrors it. */
export function transitionFrames(direction: "forward" | "back"): Keyframe[] {
  const offset = direction === "forward" ? screenTransition.distancePx : -screenTransition.distancePx;
  return [{ transform: `translateX(${offset}px)`, opacity: 0 }, { transform: "translateX(0)", opacity: 1 }];
}

/** The outgoing screen leaves the opposite way (2.24б.1): to the left going forward, to the right going back. */
export function leavingFrames(direction: "forward" | "back"): Keyframe[] {
  const offset = direction === "forward" ? -screenTransition.distancePx : screenTransition.distancePx;
  return [{ transform: "translateX(0)", opacity: 1 }, { transform: `translateX(${offset}px)`, opacity: 0 }];
}

/** The system setting only; the product adds no motion switch of its own (RA табл. 6.1.2). */
export function prefersReducedMotion(win: Window): boolean {
  return win.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/**
 * A frozen copy of the screen as it is now, for the leaving half of the motion. It must be taken before the route's
 * DOM is committed, so it is read in render; the copy has no ids and no interaction, like the prototype's ghost.
 */
function snapshotOf(element: HTMLElement): HTMLElement {
  const ghost = element.cloneNode(true) as HTMLElement;
  ghost.removeAttribute("id");
  ghost.querySelectorAll("[id]").forEach(node => node.removeAttribute("id"));
  ghost.classList.add("wortly-screen-ghost");
  // The attribute, not the property: it works wherever inert is supported and is visible to the tree as plain markup.
  ghost.setAttribute("inert", "");
  ghost.setAttribute("aria-hidden", "true");
  // A checked radio of the copy would uncheck the live radios of the same group once the copy joins the document.
  ghost.querySelectorAll("input").forEach(input => { input.removeAttribute("name"); input.removeAttribute("checked"); input.checked = false; });
  Object.assign(ghost.style, { width: `${element.offsetWidth}px`, height: `${element.offsetHeight}px`,
    top: `${element.offsetTop}px`, left: `${element.offsetLeft}px` });
  return ghost;
}

/**
 * Plays П1 on the screen container whenever the route changes: the incoming screen enters and a copy of the outgoing
 * one leaves (2.24б.1). A newer change or unmount cancels the running motion and removes the copy, so a stale animation
 * never finishes over another screen (TA §2); with reduced motion the screen changes statically.
 */
export function useScreenTransition(container: RefObject<HTMLElement | null>, route: Route): void {
  const running = useRef<Animation[]>([]);
  const ghost = useRef<HTMLElement | null>(null);
  const seen = useRef(route);
  const leaving = useRef<HTMLElement | null>(null);
  const stop = () => {
    for (const animation of running.current) animation.cancel();
    running.current = [];
    ghost.current?.remove();
    ghost.current = null;
  };
  // Render still sees the previous route's DOM; the layout effect below only sees the new one.
  if (seen.current !== route) {
    seen.current = route;
    const element = container.current;
    leaving.current = element && route.direction !== "none" && typeof element.animate === "function"
      && !prefersReducedMotion(window) ? snapshotOf(element) : null;
  }
  useLayoutEffect(() => {
    stop();
    const copy = leaving.current;
    leaving.current = null;
    const element = container.current;
    if (!element || route.direction === "none" || typeof element.animate !== "function" || prefersReducedMotion(window)) return;
    const incoming = element.animate(transitionFrames(route.direction),
      { duration: screenTransition.durationMs, easing: screenTransition.easing });
    running.current = [incoming];
    if (!copy || !element.parentElement) return;
    element.parentElement.append(copy);
    ghost.current = copy;
    const outgoing = copy.animate(leavingFrames(route.direction),
      { duration: screenTransition.durationMs, easing: screenTransition.easing, fill: "forwards" });
    running.current = [incoming, outgoing];
    const drop = () => { if (ghost.current === copy) stop(); };
    incoming.onfinish = drop;
    incoming.oncancel = drop;
  }, [container, route]);
  useLayoutEffect(() => stop, []);
}
