// The owner editor UI on its controller alone (no server): drag endings, focus after «+» and ✕, the hint, a user.
// D12 and the non-owner case come from the independent QA of R12-04…06 / R14-01 (qa_owner.test.tsx).
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OwnerCommonSlot } from "./OwnerEditor";
import { OwnerEditorController, type CommonSource } from "./ownerEditorController";
import type { OwnerEditorActions, OwnerEditorState } from "./useOwnerEditor";
import { CARD_ID, CONTEXT, NOUN_GRAMMAR, origin } from "./ownerTestData.test-support";
import { testGate } from "../../commands/testGate.test-support";

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function source(translations = ["дом", "жилище", "здание"]): CommonSource {
  return { cardId: CARD_ID, cardType: "noun", language: "ru", revision: "1", stateVersion: "10", translations, grammar: { ...NOUN_GRAMMAR } };
}

function controllerOf(onUpdate: (state: OwnerEditorState) => void = () => {}) {
  return new OwnerEditorController({ gate: testGate(),
    port: { origin: () => origin, send: async () => { throw new Error("no send"); }, status: async () => { throw new Error("no status"); },
      readTranslations: async () => ({ state_version: "10", current: { status: "unavailable" } }) },
    newId: () => "00000000-0000-4000-8000-000000000777", onUpdate: snapshot => onUpdate({ ...snapshot, leaveAsked: false }),
    onChanged: () => {},
  });
}

function setup(translations?: string[]) {
  let push: (state: OwnerEditorState) => void = () => {};
  const controller = controllerOf(state => push(state));
  controller.setCard(source(translations)); controller.setContext(CONTEXT);
  const actions = {
    openTranslations: () => controller.openTranslations(), cancel: () => controller.cancel(),
    editTranslation: (index: number, text: string) => controller.editTranslation(index, text),
    addTranslation: () => controller.addTranslation(), removeTranslation: (index: number) => controller.removeTranslation(index),
    moveTranslation: (from: number, to: number) => controller.moveTranslation(from, to),
    moveTranslationUp: (index: number) => controller.moveTranslationUp(index),
    moveTranslationDown: (index: number) => controller.moveTranslationDown(index),
    saveTranslations: () => {}, retryOthers: () => {}, toggleLanguage: () => {},
  } as unknown as OwnerEditorActions;
  function Harness() {
    const [state, set] = useState<OwnerEditorState>({ ...controller.snapshot(), leaveAsked: false });
    push = set;
    return <OwnerCommonSlot state={state} actions={actions} language="ru" dictionaryLanguage="ru" />;
  }
  render(<Harness />);
  act(() => { controller.openTranslations(); });
  return { controller };
}

const rows = () => screen.getAllByRole("listitem").filter(item => item.classList.contains("owner-translation"));
const inputs = () => screen.getAllByRole("textbox") as HTMLInputElement[];
const texts = () => inputs().map(input => input.value);
function swipes() {
  const api = { isVerticalSwipesEnabled: true, disableVerticalSwipes: vi.fn(() => { api.isVerticalSwipesEnabled = false; }),
    enableVerticalSwipes: vi.fn(() => { api.isVerticalSwipesEnabled = true; }) };
  vi.stubGlobal("Telegram", { WebApp: api });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ height: 44, width: 300, top: 0, left: 0, bottom: 44,
    right: 300, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
  return api;
}
const pointer = (pointerId: number, clientY: number, pointerType = "touch") => ({ pointerId, clientX: 10, clientY, pointerType });
const hold = () => act(() => { vi.advanceTimersByTime(400); });

describe("owner editor UI: drag endings, focus, hint (R14-01; QA P3)", () => {
  it("D12 a pointer cancel after the pickup puts the field back and returns the swipes", () => {
    const api = swipes(); setup(); vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.pointerDown(inputs()[0], pointer(1, 100)); hold();
    fireEvent.pointerMove(inputs()[0], pointer(1, 180));
    fireEvent.pointerCancel(inputs()[0], pointer(1, 180));
    expect(api.enableVerticalSwipes).toHaveBeenCalledTimes(1);
    expect(api.isVerticalSwipesEnabled).toBe(true);
    expect(texts()).toEqual(["дом", "жилище", "здание"]);
    expect(rows().every(row => row.getAttribute("data-picked") === null)).toBe(true);
  });

  it("D13 a mouse released outside the row ends the drag there: the drop applies, the swipes come back", () => {
    const api = swipes(); setup(); vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.pointerDown(inputs()[0], pointer(1, 100, "mouse")); hold();
    expect(rows()[0].getAttribute("data-picked")).toBe("true");
    // The move and the release reach only the page, never the row.
    fireEvent.pointerMove(document.body, pointer(1, 210, "mouse")); // 110 px: past both middles (52, 104)
    fireEvent.pointerUp(document.body, pointer(1, 210, "mouse"));
    expect(api.enableVerticalSwipes).toHaveBeenCalledTimes(1);
    expect(rows().every(row => row.getAttribute("data-picked") === null)).toBe(true);
    expect(texts()).toEqual(["жилище", "здание", "дом"]);
  });

  it("D14 a release outside the row before the long press ends picks nothing up", () => {
    const api = swipes(); setup(); vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.pointerDown(inputs()[1], pointer(2, 100, "mouse"));
    fireEvent.pointerUp(document.body, pointer(2, 100, "mouse"));
    hold();
    expect(api.disableVerticalSwipes).not.toHaveBeenCalled();
    expect(rows().every(row => row.getAttribute("data-picked") === null)).toBe(true);
  });

  it("F1 after ✕ the focus goes to the neighbour field (the next one; the previous at the end), after «+» to the new field", () => {
    setup(["a", "b", "c"]);
    fireEvent.click(screen.getByRole("button", { name: "Убрать «b»" }));
    expect(texts()).toEqual(["a", "c"]);
    expect(document.activeElement).toBe(inputs()[1]);
    fireEvent.click(screen.getByRole("button", { name: "Убрать «c»" }));
    expect(document.activeElement).toBe(inputs()[0]);
    fireEvent.click(screen.getByRole("button", { name: "Добавить перевод" }));
    expect(inputs()).toHaveLength(2);
    expect(document.activeElement).toBe(inputs()[1]);
  });

  it("F2 a refused removal of the last field keeps the focus on its cross, next to the explanation", () => {
    setup(["дом"]);
    const cross = screen.getByRole("button", { name: "Убрать «дом»" });
    cross.focus();
    fireEvent.click(cross);
    expect(document.activeElement).toBe(cross);
    expect(screen.getByRole("alert").textContent).toContain("Последний перевод удалить нельзя");
  });

  it("H1 the hint speaks only of what a touch user sees: hold and drag (the keyboard buttons name themselves)", () => {
    setup();
    const hint = screen.getByText(/удерживайте поле и перетащите его/);
    expect(hint.textContent).not.toMatch(/Выше|Ниже/);
    expect(screen.getByRole("button", { name: "Переместить «жилище» выше" })).toBeTruthy();
  });

  it("W1 without the owner's source (a user, a guest) there is no editor and no entry at all", () => {
    const controller = controllerOf();
    controller.setCard(null); controller.setContext(CONTEXT);
    expect(controller.snapshot().available).toBe(false);
    controller.openTranslations();
    expect(controller.snapshot().open).toBeNull();
    const { container } = render(<OwnerCommonSlot state={{ ...controller.snapshot(), leaveAsked: false }}
      actions={{} as OwnerEditorActions} language="ru" dictionaryLanguage="ru" />);
    expect(container.innerHTML).toBe("");
    expect(within(container).queryAllByRole("button")).toHaveLength(0);
  });
});
