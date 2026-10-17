// P3 of QA CP5b stage 3: the working stub of Q34 on the written screen (C556 В3; text №16 waits for the owner, so the line
// is the screen's general unavailability line, a working text, not an approved wording): shown while the page's store
// does not open, the start sends nothing, and the line goes once the store opens.
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendBudgetProvider } from "../commands/intentBudget";
import { TestSendBudget } from "../commands/budget.test-support";
import { SendBudgetError } from "../commands/sendBudget";
import { useWrittenDocument } from "./useWrittenDocument";
import { WrittenScreen } from "./WrittenScreen";
import { writtenFixture } from "./writtenFixtures.test-support";

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("the written screen without the page's store (Q34 working stub)", () => {
  it("shows the stub, sends nothing on start, and drops the stub once the store opens", async () => {
    let up = false;
    const store = new TestSendBudget();
    sendBudgetProvider.make = () => up ? Promise.resolve(store) : Promise.reject(new SendBudgetError("unavailable"));
    const f = writtenFixture();
    let actions: ReturnType<typeof useWrittenDocument>["actions"] | null = null;
    function Harness() {
      const document = useWrittenDocument({ access: f.access(), storage: f.storage, transport: f.transport, newId: f.newId, transitionMode: "normal" });
      actions = document.actions;
      return document.state ? <WrittenScreen state={document.state} language="ru" submitOnEnter actions={document.actions} onToday={() => {}} /> : null;
    }
    render(<Harness />);
    const stub = "Занятие недоступно в этом окне.";
    await screen.findByText(stub);
    await act(async () => { await actions!.start("words"); });
    expect(f.posts()).toEqual([]);
    expect(screen.getByText(stub)).toBeTruthy();
    up = true;
    await act(async () => { await actions!.refresh(); });
    await waitFor(() => expect(screen.queryByText(stub)).toBeNull());
    await act(async () => { await actions!.start("words"); });
    await waitFor(() => expect(f.posts().map(post => post.kind)).toContain("session.start"));
  });
});
