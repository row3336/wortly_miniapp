// C229 on the screen itself: only a Stop refusal carrying the closed projection of its session says «Занятие завершено.»;
// the closed view hides the problem line, so the App alone cannot show this branch.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LearningScreen } from "./LearningScreen";
import type { LearningViewSnapshot } from "./learningViewController";
import { learningViewFixture } from "./learningView.test-support";

const sessionId = "00000000-0000-4000-8000-000000000003";
afterEach(() => cleanup());
function draw(change: (state: LearningViewSnapshot) => LearningViewSnapshot) {
  const f = learningViewFixture(), base = f.view.snapshot();
  render(<LearningScreen state={change({ ...base, commands: { ...base.commands } })} language="ru" submitOnEnter
    actions={f.view} renderPreview={() => null} />);
  f.view.dispose();
}
function stopRefused(state: LearningViewSnapshot, status: "not_found" | "closed"): LearningViewSnapshot {
  const stop = { ...state.commands.stop, outcome: "rejected" as const, rejectionCode: "SESSION_CLOSED", pending: false,
    resolved: { commandId: "00000000-0000-4000-8000-000000000004", kind: "session.stop" as const, sessionId },
    current: { session_id: sessionId, status } as LearningViewSnapshot["commands"]["stop"]["current"] };
  return { ...state, phase: "stale", problem: "SESSION_CLOSED", commands: { ...state.commands, stop } };
}

describe("Learning screen: the text of a SESSION_CLOSED refusal (C229)", () => {
  it("a SESSION_CLOSED that did not come from Stop keeps the closure text", () => {
    draw(state => ({ ...state, phase: "stale", problem: "SESSION_CLOSED" }));
    expect(screen.queryByText("Занятие завершено.")).toBeTruthy();
  });
  it("a Stop refusal without a projection of its session is neutral", () => {
    draw(state => stopRefused(state, "not_found"));
    expect(screen.queryByText("Занятие завершено.")).toBeNull();
    expect(screen.queryByText("Не удалось обновить занятие.")).toBeTruthy();
  });
  it("a Stop refusal with the closed projection of its session says closed", () => {
    draw(state => stopRefused(state, "closed"));
    expect(screen.queryByText("Занятие завершено.")).toBeTruthy();
  });
});
