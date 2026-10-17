import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NoticeView } from "../api/generated";
import { journalRecord } from "../journal/clientJournal";
import type { ClosureNotices } from "./noticeBoard";
import { resetNoticeShown } from "./noticeJournal";
import { useClosureNotice, type ClosureNotice } from "./useClosureNotice";

vi.mock("../journal/clientJournal", async importOriginal => {
  const original = await importOriginal<typeof import("../journal/clientJournal")>();
  return { ...original, journalRecord: vi.fn() };
});
afterEach(() => { cleanup(); resetNoticeShown(); vi.mocked(journalRecord).mockClear(); });

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const loss = (reason: "stop" | "save_failed"): NoticeView => ({ notice_id: id(101), kind: "answer_loss", session_id: id(3), mode: "written",
  close_reason: reason, defect_class: null, created_at: "2026-10-07T00:00:01Z", summary: null });
function fake(notice: NoticeView | null, ack = true) {
  const state = { notice };
  return { state, read: vi.fn(), find: vi.fn((sessionId: string) => state.notice && sessionId === id(3) ? state.notice : null),
    leave: vi.fn(async () => ack) } satisfies ClosureNotices & { state: unknown };
}
function Probe(props: { notices: ClosureNotices; reason: string | null; unsaved?: string[]; visible?: boolean; seen: { value: ClosureNotice | null } }) {
  const value = useClosureNotice({ notices: props.notices, closed: { sessionId: id(3), reason: props.reason },
    unsavedClosures: props.unsaved, language: "ru", visible: props.visible ?? true });
  props.seen.value = value;
  return <p data-testid="lines">{value.lines?.join("|") ?? ""}</p>;
}

describe("answer_loss in the open window (project notices §6, Т2)", () => {
  it("only a session closed with X reads GET /notices, once; a plain Stop reads nothing", () => {
    const n = fake(null), seen = { value: null as ClosureNotice | null };
    const { rerender } = render(<Probe notices={n} reason="stop" seen={seen} />);
    expect(n.read).not.toHaveBeenCalled();
    rerender(<Probe notices={n} reason="stop" unsaved={[id(3).toUpperCase()]} seen={seen} />);
    rerender(<Probe notices={n} reason="stop" unsaved={[id(3)]} seen={seen} />);
    expect(n.read).toHaveBeenCalledOnce();
    rerender(<Probe notices={n} reason="summary_home" unsaved={[id(3)]} seen={seen} />);
    expect(n.read).toHaveBeenCalledOnce();
  });
  // QA M1b P3: the hook records nothing — c.screen(notice_shown) belongs to the drawn summary (NoticeShown; OralScreen test).
  it("shows 9.2.7 after C and R2-05 after the own Stop; the hook itself records no c.screen(notice_shown)", () => {
    const n = fake(loss("save_failed")), seen = { value: null as ClosureNotice | null };
    const { rerender } = render(<Probe notices={n} reason="save_failed" unsaved={[id(3)]} visible={false} seen={seen} />);
    expect(screen.getByTestId("lines").textContent).toBe("Не удалось сохранить последнее действие. Занятие завершено. Ранее сохранённый прогресс не потерян.");
    expect(journalRecord).not.toHaveBeenCalled();
    rerender(<Probe notices={n} reason="save_failed" unsaved={[id(3)]} seen={seen} />);
    expect(journalRecord).not.toHaveBeenCalled();
    n.state.notice = loss("stop");
    rerender(<Probe notices={n} reason="stop" unsaved={[id(3)]} seen={seen} />);
    expect(screen.getByTestId("lines").textContent).toBe("Занятие завершено.|Последний ответ не сохранился. Остальные ответы сохранены.");
  });
  it("«На Сегодня» acknowledges first; a failed acknowledgement keeps the summary; without a notice it just goes", async () => {
    const failing = fake(loss("stop"), false), seen = { value: null as ClosureNotice | null }, go = vi.fn();
    render(<Probe notices={failing} reason="stop" unsaved={[id(3)]} seen={seen} />);
    await act(async () => { seen.value!.leave(go); });
    expect(failing.leave).toHaveBeenCalledWith(id(3)); expect(go).not.toHaveBeenCalled();
    cleanup();
    const ok = fake(loss("stop"));
    render(<Probe notices={ok} reason="stop" unsaved={[id(3)]} seen={seen} />);
    await act(async () => { seen.value!.leave(go); });
    expect(go).toHaveBeenCalledOnce();
    cleanup(); go.mockClear();
    const none = fake(null);
    render(<Probe notices={none} reason="stop" unsaved={[id(3)]} seen={seen} />);
    await act(async () => { seen.value!.leave(go); });
    expect(go).toHaveBeenCalledOnce(); expect(none.leave).not.toHaveBeenCalled();
  });
});
