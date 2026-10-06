import { cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialRoute, navigationReducer, type Route } from "./navigation";
import { screenTransition, transitionFrames, useScreenTransition } from "./navigationMotion";

function Screen({ route }: { route: Route }) {
  const frame = useRef<HTMLDivElement>(null);
  useScreenTransition(frame, route);
  return <div ref={frame} />;
}

let animations: { frames: Keyframe[]; options: KeyframeAnimationOptions; cancel: ReturnType<typeof vi.fn> }[];
function motion(reduced: boolean) {
  animations = [];
  HTMLElement.prototype.animate = vi.fn(function (frames: Keyframe[], options: KeyframeAnimationOptions) {
    const animation = { frames, options, cancel: vi.fn() };
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
    expect(animations).toHaveLength(1);
    expect(animations[0].frames).toEqual([{ transform: "translateX(24px)", opacity: 0 }, { transform: "translateX(0)", opacity: 1 }]);
    expect(animations[0].options).toEqual({ duration: 240, easing: screenTransition.easing });
  });

  it("back mirrors the direction", () => {
    const view = render(<Screen route={settings} />);
    view.rerender(<Screen route={today} />);
    expect(animations.at(-1)!.frames).toEqual(transitionFrames("back"));
    expect(transitionFrames("back")[0]).toEqual({ transform: "translateX(-24px)", opacity: 0 });
  });

  it("a newer change cancels the running motion, and so does leaving the document", () => {
    const view = render(<Screen route={initialRoute} />);
    view.rerender(<Screen route={settings} />);
    view.rerender(<Screen route={today} />);
    expect(animations).toHaveLength(2);
    expect(animations[0].cancel).toHaveBeenCalled(); expect(animations[1].cancel).not.toHaveBeenCalled();
    view.unmount();
    expect(animations[1].cancel).toHaveBeenCalled();
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
  });

  it("without the Web Animations API the screen still changes", () => {
    HTMLElement.prototype.animate = undefined as unknown as HTMLElement["animate"];
    const view = render(<Screen route={initialRoute} />);
    expect(() => view.rerender(<Screen route={settings} />)).not.toThrow();
  });
});
