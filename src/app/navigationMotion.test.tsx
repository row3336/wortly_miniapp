import { cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialRoute, navigationReducer, type Route } from "./navigation";
import { leavingFrames, screenTransition, transitionFrames, useScreenTransition } from "./navigationMotion";

function Screen({ route }: { route: Route }) {
  const frame = useRef<HTMLDivElement>(null);
  useScreenTransition(frame, route);
  return <div className="nav-screen" ref={frame} id="screen"><button id="inner">{route.screen}</button>
    <input type="radio" name="group" defaultChecked /><input type="radio" name="group" /></div>;
}

type Played = { target: HTMLElement; frames: Keyframe[]; options: KeyframeAnimationOptions; cancel: ReturnType<typeof vi.fn>;
  onfinish?: () => void; oncancel?: () => void };
let animations: Played[];
/** The incoming animation targets the real screen; the leaving one targets its copy. */
const incomingOf = () => animations.filter(item => !item.target.classList.contains("wortly-screen-ghost"));
const leavingOf = () => animations.filter(item => item.target.classList.contains("wortly-screen-ghost"));
function motion(reduced: boolean) {
  animations = [];
  HTMLElement.prototype.animate = vi.fn(function (this: HTMLElement, frames: Keyframe[], options: KeyframeAnimationOptions) {
    const animation: Played = { target: this, frames, options, cancel: vi.fn() };
    animations.push(animation);
    return animation as unknown as Animation;
  }) as unknown as HTMLElement["animate"];
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({ matches: reduced && query === "(prefers-reduced-motion: reduce)" })));
}
const original = HTMLElement.prototype.animate;
beforeEach(() => motion(false));
afterEach(() => { cleanup(); HTMLElement.prototype.animate = original; vi.unstubAllGlobals(); });

const settings = navigationReducer(initialRoute, { type: "open", screen: "settings" });
const today = navigationReducer(settings, { type: "home" });

describe("П1 screen transition (TA:35, RA табл. 6.1.2)", () => {
  it("forward: 24 px shift from the right with opacity over 240 ms", () => {
    const view = render(<Screen route={initialRoute} />);
    expect(animations).toEqual([]);
    view.rerender(<Screen route={settings} />);
    expect(incomingOf()).toHaveLength(1);
    expect(incomingOf()[0].frames).toEqual([{ transform: "translateX(24px)", opacity: 0 }, { transform: "translateX(0)", opacity: 1 }]);
    expect(incomingOf()[0].options).toEqual({ duration: 240, easing: screenTransition.easing });
  });

  it("forward: the outgoing screen leaves 24 px to the left over the same 240 ms (2.24б.1)", () => {
    const view = render(<Screen route={initialRoute} />);
    view.rerender(<Screen route={settings} />);
    expect(leavingOf()).toHaveLength(1);
    expect(leavingOf()[0].frames).toEqual([{ transform: "translateX(0)", opacity: 1 }, { transform: "translateX(-24px)", opacity: 0 }]);
    expect(leavingOf()[0].options).toMatchObject({ duration: 240, easing: screenTransition.easing });
  });

  it("the leaving copy is a frozen, inert, id-free image of the previous screen laid next to the real one", () => {
    const view = render(<Screen route={initialRoute} />);
    view.rerender(<Screen route={settings} />);
    const copy = leavingOf()[0].target;
    expect(copy).not.toBe(view.container.querySelector("#screen"));
    expect(copy.parentElement).toBe(view.container);
    expect(copy.textContent).toBe("today");
    expect(copy.getAttribute("aria-hidden")).toBe("true");
    expect(copy.hasAttribute("inert")).toBe(true);
    expect(copy.hasAttribute("id") || copy.querySelector("[id]") !== null).toBe(false);
    expect(view.container.querySelectorAll("#screen")).toHaveLength(1);
    expect(view.container.querySelector("#screen")!.textContent).toBe("settings");
  });

  it("the copy's radios keep neither a group name nor a checked state, so they cannot uncheck the live radios", () => {
    const view = render(<Screen route={initialRoute} />);
    view.rerender(<Screen route={settings} />);
    const copy = leavingOf()[0].target;
    const radios = Array.from(copy.querySelectorAll("input"));
    expect(radios).toHaveLength(2);
    expect(radios.map(radio => [radio.hasAttribute("name"), radio.hasAttribute("checked"), radio.checked])).toEqual([[false, false, false], [false, false, false]]);
    const live = Array.from(view.container.querySelector("#screen")!.querySelectorAll("input"));
    expect(live.map(radio => [radio.name, radio.checked])).toEqual([["group", true], ["group", false]]);
  });

  it("a late finish of a superseded incoming motion does not remove the live copy", () => {
    const view = render(<Screen route={initialRoute} />);
    view.rerender(<Screen route={settings} />);
    view.rerender(<Screen route={today} />);
    const live = leavingOf()[1].target;
    incomingOf()[0].onfinish?.(); incomingOf()[0].oncancel?.();
    expect(live.isConnected).toBe(true);
    expect(leavingOf()[1].cancel).not.toHaveBeenCalled();
    incomingOf()[1].onfinish?.();
    expect(live.isConnected).toBe(false);
  });

  it("the copy is removed when the incoming motion ends, and not before", () => {
    const view = render(<Screen route={initialRoute} />);
    view.rerender(<Screen route={settings} />);
    const copy = leavingOf()[0].target;
    expect(copy.isConnected).toBe(true);
    incomingOf()[0].onfinish?.();
    expect(copy.isConnected).toBe(false);
    expect(leavingOf()[0].cancel).toHaveBeenCalled();
  });

  it("back mirrors the direction", () => {
    const view = render(<Screen route={settings} />);
    view.rerender(<Screen route={today} />);
    expect(incomingOf().at(-1)!.frames).toEqual(transitionFrames("back"));
    expect(transitionFrames("back")[0]).toEqual({ transform: "translateX(-24px)", opacity: 0 });
    // The leaving screen goes the opposite way: to the right when going back.
    expect(leavingOf().at(-1)!.frames).toEqual(leavingFrames("back"));
    expect(leavingFrames("back")[1]).toEqual({ transform: "translateX(24px)", opacity: 0 });
  });

  it("a newer change cancels the running motion, and so does leaving the document", () => {
    const view = render(<Screen route={initialRoute} />);
    view.rerender(<Screen route={settings} />);
    view.rerender(<Screen route={today} />);
    expect(incomingOf()).toHaveLength(2);
    const firstCopy = leavingOf()[0].target;
    expect(incomingOf()[0].cancel).toHaveBeenCalled(); expect(leavingOf()[0].cancel).toHaveBeenCalled();
    expect(firstCopy.isConnected).toBe(false);
    expect(incomingOf()[1].cancel).not.toHaveBeenCalled();
    const secondCopy = leavingOf()[1].target;
    view.unmount();
    expect(incomingOf()[1].cancel).toHaveBeenCalled(); expect(leavingOf()[1].cancel).toHaveBeenCalled();
    expect(secondCopy.isConnected).toBe(false);
  });

  it("an unchanged route plays nothing", () => {
    const view = render(<Screen route={settings} />);
    const before = animations.length;
    view.rerender(<Screen route={navigationReducer(settings, { type: "open", screen: "settings" })} />);
    expect(animations).toHaveLength(before);
  });

  it("with reduced motion from the system the screen changes statically", () => {
    motion(true);
    const view = render(<Screen route={initialRoute} />);
    view.rerender(<Screen route={settings} />);
    view.rerender(<Screen route={today} />);
    expect(animations).toEqual([]);
    expect(view.container.querySelector(".wortly-screen-ghost")).toBeNull();
  });

  it("a change without direction leaves no copy behind", () => {
    const view = render(<Screen route={settings} />);
    view.rerender(<Screen route={navigationReducer(settings, { type: "open", screen: "settings" })} />);
    expect(view.container.querySelector(".wortly-screen-ghost")).toBeNull();
  });

  it("without the Web Animations API the screen still changes", () => {
    HTMLElement.prototype.animate = undefined as unknown as HTMLElement["animate"];
    const view = render(<Screen route={initialRoute} />);
    expect(() => view.rerender(<Screen route={settings} />)).not.toThrow();
  });
});
