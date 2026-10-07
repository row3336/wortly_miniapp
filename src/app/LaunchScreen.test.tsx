/// <reference types="node" />
// The stylesheet is read from disk (tests run from the package root): vitest does not process CSS, so a ?raw import of it is empty.
import { readFileSync } from "node:fs";
import { act, cleanup, render } from "@testing-library/react";
import { StrictMode, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import html from "../../index.html?raw";
import { LAUNCH_BUILD_MS, LAUNCH_EXIT_MS, LaunchHost, type LaunchPhase, useLaunch } from "./LaunchScreen";

// М20 timing contract (TA:44, RA §6.1.5): assembly 2400 ms, then exit 700 ms; the entry decides when the exit may start.

type Query = { matches: boolean; listeners: Set<() => void> };
let query: Query;
function motion(reduced: boolean) {
  query = { matches: reduced, listeners: new Set() };
  vi.stubGlobal("matchMedia", vi.fn((media: string) => media === "(prefers-reduced-motion: reduce)" ? {
    get matches() { return query.matches; },
    addEventListener: (_: string, listener: () => void) => query.listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => query.listeners.delete(listener),
  } : { matches: false, addEventListener() {}, removeEventListener() {} }));
}
const setReduced = (value: boolean) => { query.matches = value; for (const listener of [...query.listeners]) listener(); };
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const overlay = () => document.querySelector<HTMLElement>(".launch");
const host = () => document.querySelector<HTMLElement>(".launch-host")!;

beforeEach(() => { vi.useFakeTimers(); motion(false); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("the constants of the contract", () => {
  it("assembly 2400 ms and exit 700 ms", () => {
    expect(LAUNCH_BUILD_MS).toBe(2400);
    expect(LAUNCH_EXIT_MS).toBe(700);
  });
});

describe("launch phases with fake timers", () => {
  it("a decided entry still waits for the whole assembly: building until 2399 ms, leaving at 2400 ms", async () => {
    render(<LaunchHost ready><p>app</p></LaunchHost>);
    expect(overlay()?.dataset.phase).toBe("building");
    await advance(LAUNCH_BUILD_MS - 1);
    expect(overlay()?.dataset.phase).toBe("building");
    await advance(1);
    expect(overlay()?.dataset.phase).toBe("leaving");
  });

  it("the exit lasts exactly 700 ms: present at 3099 ms, gone at 3100 ms", async () => {
    render(<LaunchHost ready><p>app</p></LaunchHost>);
    await advance(LAUNCH_BUILD_MS);
    await advance(LAUNCH_EXIT_MS - 1);
    expect(overlay()).not.toBeNull();
    expect(host().hasAttribute("inert")).toBe(true);
    await advance(1);
    expect(overlay()).toBeNull();
    expect(host().hasAttribute("inert")).toBe(false);
    expect(host().classList.contains("launch-host--entering")).toBe(false);
  });

  it("an undecided entry keeps the logo with the spinner for as long as it takes, however late", async () => {
    const view = render(<LaunchHost ready={false}><p>app</p></LaunchHost>);
    await advance(LAUNCH_BUILD_MS);
    expect(overlay()?.dataset.phase).toBe("waiting");
    await advance(60_000);
    expect(overlay()?.dataset.phase).toBe("waiting");
    expect(overlay()?.querySelector(".launch-loader")).not.toBeNull();
    view.rerender(<LaunchHost ready><p>app</p></LaunchHost>);
    await advance(0);
    expect(overlay()?.dataset.phase).toBe("leaving");
    await advance(LAUNCH_EXIT_MS - 1);
    expect(overlay()).not.toBeNull();
    await advance(1);
    expect(overlay()).toBeNull();
  });

  it("a decision before the end of the assembly never shortens it", async () => {
    const view = render(<LaunchHost ready={false}><p>app</p></LaunchHost>);
    await advance(100);
    view.rerender(<LaunchHost ready><p>app</p></LaunchHost>);
    await advance(2299);
    expect(overlay()?.dataset.phase).toBe("building");
    await advance(1);
    expect(overlay()?.dataset.phase).toBe("leaving");
  });

  it("an exit that has begun is finished even when the entry becomes undecided again", async () => {
    const view = render(<LaunchHost ready><p>app</p></LaunchHost>);
    await advance(LAUNCH_BUILD_MS);
    view.rerender(<LaunchHost ready={false}><p>app</p></LaunchHost>);
    await advance(LAUNCH_EXIT_MS);
    expect(overlay()).toBeNull();
  });

  it("one launch per mounted owner: a later undecided entry does not bring it back", async () => {
    const view = render(<LaunchHost ready><p>app</p></LaunchHost>);
    await advance(LAUNCH_BUILD_MS);
    await advance(LAUNCH_EXIT_MS);
    view.rerender(<LaunchHost ready={false}><p>app</p></LaunchHost>);
    await advance(10_000);
    expect(overlay()).toBeNull();
    expect(host().hasAttribute("inert")).toBe(false);
  });

  it("the exit class and its length are set only while leaving", async () => {
    render(<LaunchHost ready><p>app</p></LaunchHost>);
    expect(host().className).toBe("launch-host");
    expect(overlay()?.className).toBe("launch");
    await advance(LAUNCH_BUILD_MS);
    expect(host().className).toBe("launch-host launch-host--entering");
    expect(overlay()?.className).toBe("launch launch--leaving");
    expect(host().style.getPropertyValue("--launch-exit-ms")).toBe("700ms");
    expect(overlay()?.style.getPropertyValue("--launch-exit-ms")).toBe("700ms");
  });

  it("unmounting clears every timer", async () => {
    const view = render(<LaunchHost ready><p>app</p></LaunchHost>);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    await advance(10_000);
  });
});

describe("the application under the launch screen", () => {
  it("renders from the first frame, is inert and keeps its node through every phase", async () => {
    let mounts = 0;
    function Probe() {
      useEffect(() => { mounts += 1; }, []);
      return <p>app</p>;
    }
    render(<LaunchHost ready><Probe /></LaunchHost>);
    const paragraph = document.querySelector("p");
    expect(paragraph?.textContent).toBe("app");
    expect(host().hasAttribute("inert")).toBe(true);
    await advance(LAUNCH_BUILD_MS);
    expect(host().hasAttribute("inert")).toBe(true);
    await advance(LAUNCH_EXIT_MS);
    expect(document.querySelector("p")).toBe(paragraph);
    expect(mounts).toBe(1);
  });

  it("the logo is named Wortly and the launch screen carries no translated text", () => {
    render(<LaunchHost ready={false}><p>app</p></LaunchHost>);
    expect(overlay()?.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("Wortly");
    expect(overlay()?.textContent).toBe("");
    expect(overlay()?.querySelectorAll("img")).toHaveLength(3);
  });
});

describe("reduced motion (TA:35): the accepted prototype keeps the finished logo still", () => {
  const still = () => overlay()?.dataset.phase === "still";

  it("shows the still logo with no assembly, no timer and no exit; the application is inert until the entry is decided", async () => {
    motion(true);
    const view = render(<LaunchHost ready={false}><p>app</p></LaunchHost>);
    expect(still()).toBe(true);
    expect(overlay()?.className).toBe("launch launch--still");
    expect(overlay()?.querySelectorAll(".launch-book")).toHaveLength(3);
    expect(overlay()?.querySelector(".launch-word")).not.toBeNull();
    expect(host().hasAttribute("inert")).toBe(true);
    expect(host().className).toBe("launch-host");
    expect(vi.getTimerCount()).toBe(0);
    await advance(60_000);
    expect(still()).toBe(true);
    view.rerender(<LaunchHost ready><p>app</p></LaunchHost>);
    // At once: no 2400 ms wait, no exit, the screen simply changes.
    expect(overlay()).toBeNull();
    expect(host().hasAttribute("inert")).toBe(false);
    expect(host().className).toBe("launch-host");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a decided entry on the first render shows no launch at all", () => {
    motion(true);
    render(<LaunchHost ready><p>app</p></LaunchHost>);
    expect(overlay()).toBeNull();
    expect(host().hasAttribute("inert")).toBe(false);
  });

  it("the still logo does not come back when the entry becomes undecided again", async () => {
    motion(true);
    const view = render(<LaunchHost ready={false}><p>app</p></LaunchHost>);
    view.rerender(<LaunchHost ready><p>app</p></LaunchHost>);
    view.rerender(<LaunchHost ready={false}><p>app</p></LaunchHost>);
    await advance(1000);
    expect(overlay()).toBeNull();
  });

  it("turning it on during the assembly stops the motion: the still logo stays until the entry is decided", async () => {
    const view = render(<LaunchHost ready={false}><p>app</p></LaunchHost>);
    await advance(500);
    expect(overlay()?.dataset.phase).toBe("building");
    act(() => setReduced(true));
    expect(still()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await advance(10_000);
    expect(still()).toBe(true);
    view.rerender(<LaunchHost ready><p>app</p></LaunchHost>);
    expect(overlay()).toBeNull();
    expect(host().hasAttribute("inert")).toBe(false);
  });

  it("turning it on during the exit removes the screen and the inert at once", async () => {
    render(<LaunchHost ready><p>app</p></LaunchHost>);
    await advance(LAUNCH_BUILD_MS + 100);
    expect(overlay()?.dataset.phase).toBe("leaving");
    act(() => setReduced(true));
    expect(overlay()).toBeNull();
    expect(host().hasAttribute("inert")).toBe(false);
    expect(host().className).toBe("launch-host");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("turning it off during the launch changes nothing", async () => {
    render(<LaunchHost ready={false}><p>app</p></LaunchHost>);
    await advance(300);
    act(() => setReduced(false));
    expect(overlay()?.dataset.phase).toBe("building");
  });

  it("an unavailable matchMedia (no support) means full motion", () => {
    vi.stubGlobal("matchMedia", undefined);
    render(<LaunchHost ready={false}><p>app</p></LaunchHost>);
    expect(overlay()?.dataset.phase).toBe("building");
  });

  it("a matchMedia object without addEventListener (old WebView) does not break the launch", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
    render(<LaunchHost ready><p>app</p></LaunchHost>);
    expect(overlay()?.dataset.phase).toBe("building");
    await advance(LAUNCH_BUILD_MS);
    await advance(LAUNCH_EXIT_MS);
    expect(overlay()).toBeNull();
  });
});

describe("timers and listeners (К17-014 leaks)", () => {
  it("unmounting during the exit clears the exit timer", async () => {
    const view = render(<StrictMode><LaunchHost ready><p>app</p></LaunchHost></StrictMode>);
    await advance(LAUNCH_BUILD_MS);
    expect(overlay()?.dataset.phase).toBe("leaving");
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("unmounting during the wait clears every timer and the reduced-motion listener", async () => {
    const view = render(<LaunchHost ready={false}><p>app</p></LaunchHost>);
    await advance(LAUNCH_BUILD_MS + 5);
    expect(query.listeners.size).toBe(1);
    view.unmount();
    expect(query.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("StrictMode leaves exactly one reduced-motion listener while the launch runs", () => {
    render(<StrictMode><LaunchHost ready={false}><p>app</p></LaunchHost></StrictMode>);
    expect(query.listeners.size).toBe(1);
  });

  it("the still logo keeps no listener and no timer", () => {
    motion(true);
    render(<LaunchHost ready={false}><p>app</p></LaunchHost>);
    expect(query.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("static contract of the files jsdom cannot play", () => {
  const css = readFileSync("src/app/launch.css", "utf8");
  it("launch.css pins the prototype choreography and the exit through the shared variable", () => {
    expect(css).toMatch(/launch-books-shift 650ms[^;]*760ms/);
    expect(css).toMatch(/launch-word-in 500ms[^;]*1160ms/);
    expect(css).toMatch(/launch-loader-show 1ms linear 1660ms/);
    expect(css).toMatch(/calc\(var\(--launch-book\) \* 150ms\)/);
    expect(css).toMatch(/\.launch--leaving \{\s*animation: launch-out var\(--launch-exit-ms\)/);
    expect(css).toMatch(/launch-host-in var\(--launch-exit-ms\)/);
    expect(css).toMatch(/translateX\(30\.612%\)/);
    expect(css).toMatch(/scale\(\.72\)/);
    expect(css).toMatch(/scale\(1\.12\)/);
  });

  it("the still logo switches every animation off", () => {
    expect(css).toMatch(/\.launch--still \.launch-books,[^{]*\.launch-loader \{ animation: none; \}/);
  });

  it("index.html preloads the four launch layers; the word, a CSS mask, in CORS mode", () => {
    for (const name of ["book-1", "book-2", "book-3"]) expect(html).toContain(`<link rel="preload" as="image" href="/launch/${name}.png" />`);
    expect(html).toContain('<link rel="preload" as="image" href="/launch/word.png" crossorigin />');
    expect(html).not.toContain("prefers-reduced-motion");
  });
});

describe("useLaunch alone", () => {
  it("reports the phase sequence", async () => {
    const seen: LaunchPhase[] = [];
    function Phase({ ready }: { ready: boolean }) { seen.push(useLaunch(ready)); return null; }
    render(<Phase ready />);
    await advance(LAUNCH_BUILD_MS);
    await advance(LAUNCH_EXIT_MS);
    expect([...new Set(seen)]).toEqual(["building", "leaving", "done"]);
  });
});
