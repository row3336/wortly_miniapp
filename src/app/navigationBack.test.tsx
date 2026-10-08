import { useLayoutEffect } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBackLayer, useUnsavedFieldBack, type BackLayer } from "./navigationBack";

function fakeBack() {
  const handlers = new Set<() => void>(), log: string[] = [];
  const api = {
    show() { log.push("show"); }, hide() { log.push("hide"); },
    onClick(handler: () => void) { handlers.add(handler); log.push("on"); },
    offClick(handler: () => void) { handlers.delete(handler); log.push("off"); },
  };
  return { api, log, get handlers() { return handlers.size; },
    click: () => act(() => { for (const handler of [...handlers]) handler(); }) };
}

function Layer({ layer, handler }: { layer: BackLayer; handler: (() => void) | null }) {
  useBackLayer(layer, handler);
  return null;
}
function Guard({ confirm }: { confirm: (() => void) | null }) {
  useUnsavedFieldBack(confirm);
  return null;
}

let back: ReturnType<typeof fakeBack>;
beforeEach(() => { back = fakeBack(); vi.stubGlobal("Telegram", { WebApp: { BackButton: back.api } }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("one native Back automaton (TA:86)", () => {
  it("binds once while any handler is present and hides when none is left", () => {
    const screen = vi.fn(), overlay = vi.fn();
    const view = render(<><Layer layer="screen" handler={screen} /><Layer layer="overlay" handler={null} /></>);
    expect(back.handlers).toBe(1); expect(back.log).toEqual(["on", "show"]);
    view.rerender(<><Layer layer="screen" handler={screen} /><Layer layer="overlay" handler={overlay} /></>);
    expect(back.handlers).toBe(1); expect(back.log).toEqual(["on", "show"]);
    view.rerender(<><Layer layer="screen" handler={null} /><Layer layer="overlay" handler={null} /></>);
    expect(back.handlers).toBe(0); expect(back.log).toEqual(["on", "show", "off", "hide"]);
  });

  it("a modal window closes before the screen handles Back; then the screen does", async () => {
    const screen = vi.fn(), overlay = vi.fn();
    const view = render(<><Layer layer="screen" handler={screen} /><Layer layer="overlay" handler={overlay} /></>);
    await back.click();
    expect(overlay).toHaveBeenCalledOnce(); expect(screen).not.toHaveBeenCalled();
    view.rerender(<><Layer layer="screen" handler={screen} /><Layer layer="overlay" handler={null} /></>);
    await back.click();
    expect(screen).toHaveBeenCalledOnce(); expect(overlay).toHaveBeenCalledOnce();
  });

  it("an unsaved personal field asks its own confirmation instead of leaving the screen (M-EDIT extension point)", async () => {
    const screen = vi.fn(), confirm = vi.fn(), overlay = vi.fn();
    const view = render(<><Layer layer="screen" handler={screen} /><Guard confirm={confirm} /></>);
    await back.click();
    expect(confirm).toHaveBeenCalledOnce(); expect(screen).not.toHaveBeenCalled();
    view.rerender(<><Layer layer="screen" handler={screen} /><Guard confirm={confirm} /><Layer layer="overlay" handler={overlay} /></>);
    await back.click();
    expect(overlay).toHaveBeenCalledOnce(); expect(confirm).toHaveBeenCalledOnce();
    view.rerender(<><Layer layer="screen" handler={screen} /><Guard confirm={null} /></>);
    await back.click();
    expect(screen).toHaveBeenCalledOnce();
  });

  it("a new handler identity runs on the next press without hiding and showing the button again", async () => {
    const first = vi.fn(), second = vi.fn();
    const view = render(<Layer layer="screen" handler={first} />);
    view.rerender(<Layer layer="screen" handler={second} />);
    await back.click();
    expect(second).toHaveBeenCalledOnce(); expect(first).not.toHaveBeenCalled();
    expect(back.log).toEqual(["on", "show"]);
  });

  it("the latest screen handler of one layer wins, and one press runs one transition", async () => {
    const older = vi.fn(), newer = vi.fn();
    render(<><Layer layer="screen" handler={older} /><Layer layer="screen" handler={newer} /></>);
    await back.click();
    expect(newer).toHaveBeenCalledOnce(); expect(older).not.toHaveBeenCalled();
  });

  it("does nothing without the Telegram Back button", () => {
    vi.unstubAllGlobals();
    expect(() => render(<Layer layer="screen" handler={vi.fn()} />)).not.toThrow();
  });
});

// QA M-NAV (F1): the priority holds whatever order the handlers were registered in.
describe("layer priority does not depend on registration order", () => {
  it("an overlay registered before the screen still closes first", async () => {
    const overlay = vi.fn(), screen = vi.fn();
    const view = render(<><Layer layer="overlay" handler={overlay} /><Layer layer="screen" handler={null} /></>);
    view.rerender(<><Layer layer="overlay" handler={overlay} /><Layer layer="screen" handler={screen} /></>);
    await back.click();
    expect(overlay).toHaveBeenCalledOnce(); expect(screen).not.toHaveBeenCalled();
  });

  it("a guard registered before the screen still asks first", async () => {
    const confirm = vi.fn(), screen = vi.fn();
    const view = render(<><Guard confirm={confirm} /><Layer layer="screen" handler={null} /></>);
    view.rerender(<><Guard confirm={confirm} /><Layer layer="screen" handler={screen} /></>);
    await back.click();
    expect(confirm).toHaveBeenCalledOnce(); expect(screen).not.toHaveBeenCalled();
  });
});

// 2.33: while the window checks its document, its screens are out of sight and none of them may act on Back.
describe("a document check holds Back", () => {
  it("outranks a later overlay, guard and screen; once it ends, the highest of them runs again", async () => {
    const check = vi.fn(), overlay = vi.fn(), confirm = vi.fn(), screen = vi.fn();
    const view = render(<><Layer layer="check" handler={check} /><Layer layer="screen" handler={screen} /></>);
    view.rerender(<><Layer layer="check" handler={check} /><Layer layer="screen" handler={screen} />
      <Guard confirm={confirm} /><Layer layer="overlay" handler={overlay} /></>);
    await back.click();
    expect(check).toHaveBeenCalledOnce();
    expect(overlay).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled(); expect(screen).not.toHaveBeenCalled();
    view.rerender(<><Layer layer="check" handler={null} /><Layer layer="screen" handler={screen} />
      <Guard confirm={confirm} /><Layer layer="overlay" handler={overlay} /></>);
    await back.click();
    expect(overlay).toHaveBeenCalledOnce(); expect(check).toHaveBeenCalledOnce();
  });
});

// 2.33 tail: the check hides the screens in one commit, so Back must be bound in that same commit (layout phase),
// not by a passive effect after the paint.
describe("a document check binds Back within the commit that shows it", () => {
  it("Back is already bound when the layout effects of the same commit run", () => {
    const boundAtLayout: number[] = [];
    function LayoutProbe() { useLayoutEffect(() => { boundAtLayout.push(back.handlers); }); return null; }
    const view = render(<><Layer layer="check" handler={null} /><LayoutProbe /></>);
    boundAtLayout.length = 0;
    view.rerender(<><Layer layer="check" handler={vi.fn()} /><LayoutProbe /></>);
    expect(boundAtLayout).toEqual([1]);
  });
});
