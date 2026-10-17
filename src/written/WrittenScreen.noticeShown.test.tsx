// P3 of the delta QA M1c (project notices §8, events 3.6.3 §4.5): in the written quiz c.screen(notice_shown) follows the
// drawn summary with the notice line — never the route or the read: while the summary of the own Stop is still read (the
// loader), nothing is recorded; once the summary is on screen, one event names the notice.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installClientJournal } from "../journal/clientJournal";
import { resetNoticeShown } from "../notices/noticeJournal";
import { useWrittenDocument } from "./useWrittenDocument";
import { WrittenScreen } from "./WrittenScreen";
import { id, writtenFixture } from "./writtenFixtures.test-support";

afterEach(() => { cleanup(); vi.useRealTimers(); installClientJournal(null); resetNoticeShown(); });

const LINES = ["Занятие прервано.", "Последний ответ не сохранился. Остальные ответы сохранены."];

describe("notice_shown in the written quiz (QA M1c P3)", () => {
  it("is recorded once the summary with its line is drawn, not while the summary is still read", async () => {
    const record = vi.fn();
    const f = writtenFixture();
    function Harness() {
      const { state, actions } = useWrittenDocument({ access: f.access(), storage: f.storage, transport: f.transport, newId: f.newId,
        transitionMode: "normal" });
      if (!state) return null;
      return <>
        <button type="button" onClick={() => { void actions.start("words"); }}>start-words</button>
        <WrittenScreen state={state} language="ru" submitOnEnter actions={actions} onToday={() => {}} noticeLines={LINES} noticeId={id(101)} />
      </>;
    }
    render(<Harness />);
    await waitFor(() => expect(screen.getByRole("button", { name: "start-words" })).toBeTruthy());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    fireEvent.click(screen.getByRole("button", { name: "start-words" }));
    await waitFor(() => expect((screen.getByRole("textbox") as HTMLTextAreaElement).readOnly).toBe(false));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Haus" } });
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    await screen.findByText("Верно");
    f.dropRequest(); fireEvent.click(screen.getByRole("button", { name: "Выйти" }));
    await screen.findByText("Завершаем занятие…");
    Object.assign(f.server.state, { status: "closed", closeReason: "stop", assignment: null, version: f.server.state.version + 1 });
    f.fetcher.mockImplementationOnce(f.server.handle); const gate = f.hold();
    // Only the screen part of the journal is watched (its sends of commands are not part of this check).
    fireEvent.click(screen.getByRole("button", { name: "Проверить состояние" }));
    await screen.findByRole("status", { name: "Итог занятия" });
    installClientJournal({ record } as never); resetNoticeShown();
    const shown = () => record.mock.calls.filter(([event]) => (event as { kind?: string }).kind === "notice_shown");
    expect(shown()).toEqual([]);
    gate.resolve(); await screen.findByText(LINES[1]);
    expect(shown()).toEqual([[{ ev: "c.screen", kind: "notice_shown", notice: id(101) }]]);
  });
});
