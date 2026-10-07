import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { app, pairText, startWords, useWrittenAppEnvironment } from "../written/writtenApp.test-support";
import { App } from "./App";
import { leavingFrames, transitionFrames } from "./navigationMotion";

useWrittenAppEnvironment();

const panel = () => screen.queryByRole("navigation", { name: "Основная навигация" });
const panelButton = (name: string) => within(panel()!).getByRole("button", { name }) as HTMLButtonElement;

// M-NAV through the actual App document: the panel navigates, nested screens return to their source,
// and native Back runs the same transition as the visible control (TA:86, К09-038…040).
describe("M-NAV navigation through the actual App document", () => {
  it("N1 Today shows the panel with Today current; it has no native Back of its own", async () => {
    const a = app(); render(<App />);
    await screen.findByText(pairText);
    expect(panelButton("Сегодня").getAttribute("aria-current")).toBe("page");
    expect(panelButton("Сегодня").disabled).toBe(true);
    expect(panelButton("Словарь").disabled).toBe(false); expect(panelButton("Настройки").disabled).toBe(false);
    expect(a.back.bound).toBe(0);
  });

  it("N2 Dictionary is an entry point: the panel stays, native Back returns to a fresh Today, nothing is sent", async () => {
    const a = app(); render(<App />);
    await screen.findByText(pairText);
    fireEvent.click(panelButton("Словарь"));
    await screen.findByRole("heading", { name: "Словарь", level: 1 });
    expect(panelButton("Словарь").getAttribute("aria-current")).toBe("page");
    expect(a.back.bound).toBe(1);
    const opens = a.openReply.mock.calls.length;
    await a.back.click();
    await screen.findByText(pairText);
    expect(a.openReply.mock.calls.length).toBeGreaterThan(opens);
    expect(a.back.bound).toBe(0); expect(a.posts()).toEqual([]);
  });

  it("N3 Statistics opens from Today without the panel; its Back control and native Back both return to Today", async () => {
    const a = app(); render(<App />);
    await screen.findByText(pairText);
    fireEvent.click(screen.getByRole("button", { name: "Статистика" }));
    await screen.findByRole("heading", { name: "Статистика", level: 1 });
    expect(panel()).toBeNull(); expect(a.back.bound).toBe(1);
    await a.back.click();
    await screen.findByText(pairText);
    fireEvent.click(screen.getByRole("button", { name: "Статистика" }));
    fireEvent.click(await screen.findByRole("button", { name: "Назад" }));
    await screen.findByText(pairText);
    expect(a.back.bound).toBe(0); expect(a.posts()).toEqual([]);
  });

  it("N4 the panel moves between sections; Back from Settings is still its «Сегодня»", async () => {
    const a = app(); render(<App />);
    await screen.findByText(pairText);
    fireEvent.click(panelButton("Словарь"));
    await screen.findByRole("heading", { name: "Словарь", level: 1 });
    fireEvent.click(panelButton("Настройки"));
    await screen.findByRole("heading", { name: "Настройки", level: 1 });
    expect(a.back.bound).toBe(1);
    await a.back.click();
    await screen.findByText(pairText);
    expect(a.back.bound).toBe(0); expect(a.posts()).toEqual([]);
  });

  it("N9 Settings opens the Dictionary from the same panel; Back from there is Today", async () => {
    const a = app(); render(<App />);
    await screen.findByText(pairText);
    fireEvent.click(panelButton("Настройки"));
    await screen.findByRole("heading", { name: "Настройки", level: 1 });
    expect(panelButton("Настройки").getAttribute("aria-current")).toBe("page");
    fireEvent.click(panelButton("Словарь"));
    await screen.findByRole("heading", { name: "Словарь", level: 1 });
    await a.back.click();
    await screen.findByText(pairText);
    expect(a.back.bound).toBe(0); expect(a.posts()).toEqual([]);
  });

  it("N5 the written session hides the panel; its native Back is the stop without confirmation", async () => {
    const a = app({ cards: [6, 7] }); render(<App />);
    await startWords();
    expect(panel()).toBeNull();
    await a.back.click();
    await waitFor(() => expect(a.posts().at(-1)).toMatchObject({ kind: "session.stop", payload: { reason: "stop" } }));
    expect(panel()).toBeNull();
  });

  it("N6 Today rows carry the direction with the arrow for the dictionary pair (И04)", async () => {
    app(); render(<App />);
    await screen.findByText(pairText);
    expect(screen.getByRole("button", { name: /^Рус → Нем Слова: перевод на немецкий/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Нем → Рус Слова: перевод с немецкого/ })).toBeTruthy();
  });
});

describe("M-NAV П1 in the actual App document", () => {
  let leavingRecord: Keyframe[][] = [];
  const original = HTMLElement.prototype.animate;
  afterEach(() => { HTMLElement.prototype.animate = original; });
  function record(reduced: boolean) {
    // `frames` holds the incoming screen's motion; the leaving copy's motion is kept apart (2.24б.1).
    const frames: Keyframe[][] = [], leaving: Keyframe[][] = [];
    HTMLElement.prototype.animate = vi.fn(function (this: HTMLElement, keyframes: Keyframe[]) {
      (this.classList.contains("wortly-screen-ghost") ? leaving : frames).push(keyframes); return { cancel() {} } as unknown as Animation;
    }) as unknown as HTMLElement["animate"];
    leavingRecord = leaving;
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: reduced && query === "(prefers-reduced-motion: reduce)" }));
    return frames;
  }

  it("N7 a section opens forward and Back returns mirrored", async () => {
    const a = app(); const frames = record(false); render(<App />);
    await screen.findByText(pairText);
    expect(frames).toEqual([]);
    fireEvent.click(panelButton("Словарь"));
    await screen.findByRole("heading", { name: "Словарь", level: 1 });
    expect(frames).toEqual([transitionFrames("forward")]);
    await a.back.click();
    await screen.findByText(pairText);
    expect(frames).toEqual([transitionFrames("forward"), transitionFrames("back")]);
    // The previous screen leaves the opposite way each time (2.24б.1, 2.24б.2).
    expect(leavingRecord).toEqual([leavingFrames("forward"), leavingFrames("back")]);
  });

  it("N8 with reduced motion the same navigation is static", async () => {
    const a = app(); const frames = record(true); render(<App />);
    await screen.findByText(pairText);
    fireEvent.click(panelButton("Словарь"));
    await screen.findByRole("heading", { name: "Словарь", level: 1 });
    await a.back.click();
    await screen.findByText(pairText);
    expect(frames).toEqual([]);
  });
});
