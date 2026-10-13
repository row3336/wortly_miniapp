// D-FALSE-TEXTS part A: the screen hides the generic refresh-failure line only when the owner vouches for the source of the
// current cause (checkedAbsent); a lane's not_found alone is never enough for the screen to decide.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OralScreen } from "./OralScreen";
import type { OralCommandSnapshot } from "./oralCommandController";
import type { OralDocumentSnapshot } from "./oralDocumentController";

afterEach(cleanup);
const id = "00000000-0000-4000-8000-000000000003";
const STALE = "Не удалось обновить занятие. Проверь состояние.";
const lane = (patch: Partial<OralCommandSnapshot> = {}): OralCommandSnapshot => ({ phase: "idle", pending: false, kind: null, sessionId: null,
  pendingIntent: null, outcome: null, resolved: null, rejectionCode: null, problem: null, canRetry: false, current: null,
  closedSession: null, stateVersion: "8", ...patch });
const state = (problem: string, checkedAbsent: boolean): OralDocumentSnapshot => ({ phase: "unknown", sessionId: id,
  current: null, stateVersion: "8", terminalSessionIds: [], problem, presentationTicket: null, canStart: false, canReveal: false,
  canGrade: false, canStop: false, canSummaryHome: false, canRetry: { study: true, stop: false }, closed: null, pairMismatch: null,
  commands: { study: lane({ pending: true, kind: "oral.reveal", sessionId: id, phase: "unresolved", problem: "not_found", canRetry: true }), stop: lane() },
  ...(checkedAbsent ? { checkedAbsent: true as const } : {}) });
const actions = { refresh: vi.fn(async () => {}), start: vi.fn(async () => {}), shown: vi.fn(async () => {}), reveal: vi.fn(async () => {}),
  grade: vi.fn(async () => {}), stop: vi.fn(async () => {}), retry: vi.fn(async () => {}) };
const show = (value: OralDocumentSnapshot) => render(<OralScreen state={value} actions={actions} language="ru" active onToday={() => {}} />);

describe("OralScreen: checkedAbsent decides, not a lane's not_found", () => {
  it("vouched: no refresh failure; the unconfirmed lines and both buttons stay", () => {
    show(state("not_found", true));
    expect(screen.queryByText(STALE)).toBeNull();
    expect(screen.getByText("Действие ещё не подтверждено. Проверь состояние.")).toBeTruthy();
    expect(screen.getByText("Учебное действие ещё не подтверждено.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Проверить состояние" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Повторить действие" })).toBeTruthy();
  });
  it("not vouched: the lane's not_found is on the screen, but the line stays", () => {
    show(state("not_found", false));
    expect(screen.getAllByText(STALE).length).toBeGreaterThan(0);
  });
  it("a different cause is never hidden even if flagged by mistake in the text path", () => {
    show(state("network", false));
    expect(screen.getAllByText(STALE).length).toBeGreaterThan(0);
  });
});
