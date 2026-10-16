// M-SLOT-INVALID, written: the shared slot holds a record nobody can read when a new answer Y is submitted. Y is neither stored
// nor sent, so it is never checked by its ID, never retried and no machine waits for it. The unreadable record is not touched.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useWrittenDocument } from "./useWrittenDocument";
import { WrittenScreen } from "./WrittenScreen";
import { writtenPrimaryKey } from "./writtenPending";
import { tick, writtenFixture } from "./writtenFixtures.test-support";
import { pendingRaw, seedRaw, pointerKeyOf } from "../commands/pendingSeed.test-support";

afterEach(() => { cleanup(); vi.useRealTimers(); });
type F = ReturnType<typeof writtenFixture>;
function mount(f: F) {
  function Harness() {
    const { state, actions } = useWrittenDocument({ access: f.access(), storage: f.storage, transport: f.transport, newId: f.newId, transitionMode: "normal" });
    if (!state) return null;
    return <>
      <button type="button" onClick={() => { void actions.start("words"); }}>start-words</button>
      <WrittenScreen state={state} language="ru" submitOnEnter actions={actions} onToday={vi.fn()} />
    </>;
  }
  return render(<Harness />);
}
async function started() {
  vi.useFakeTimers();
  const f = writtenFixture(), view = mount(f);
  const step = (ms = 0) => act(() => tick(ms));
  await step();
  fireEvent.click(screen.getByRole("button", { name: "start-words" })); await step();
  return { f, step, view };
}
const path = (url: unknown) => new URL(String(url), "http://localhost").pathname;
/** Requests after mark: status checks by ID, and the kinds of the POSTs. */
function requests(f: F, mark: number) {
  const calls = f.fetcher.mock.calls.slice(mark);
  return {
    statuses: calls.filter(([url, init]) => (init?.method ?? "GET") === "GET" && path(url).startsWith("/api/v1/commands/")).map(([url]) => path(url).split("/").pop()),
    posts: calls.filter(([, init]) => init?.method === "POST").map(([, init]) => JSON.parse(String(init!.body)) as { kind: string; command_id: string }),
  };
}
const lastId = (f: F) => f.newId.mock.results.at(-1)!.value as string;
const answer = async (text: string, step: (ms?: number) => Promise<unknown>) => {
  fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Проверить" })); await step();
};
const shown = () => document.body.textContent ?? "";

describe("written quiz: an unreadable record in the slot meets a new answer", () => {
  it.each([["not JSON", "{not json"], ["JSON of another shape", "{\"a\":1}"]])("%s: Y is never checked or sent, and the record is kept", async (_name, raw) => {
    const { f, step } = await started();
    seedRaw(f.values, writtenPrimaryKey, raw, "00000000-0000-4000-8000-000000000050");
    const mark = f.fetcher.mock.calls.length;
    await answer("Hund", step);
    const y = lastId(f);
    await step(1000); await step(300_000);
    const seen = requests(f, mark);
    expect(seen.statuses).toEqual([]);
    expect(seen.posts).toEqual([]);
    expect(pendingRaw(f.values, writtenPrimaryKey)).toBe(raw);
    // The lost-connection waiting of the recovery machine belongs to an intent that was sent and lost; this one was not.
    expect(shown()).not.toContain("Ждём, когда связь восстановится");
    expect(shown()).toContain("Действие нельзя повторить. Проверь состояние занятия.");
    // The ID of Y appears in no request at all.
    expect(f.fetcher.mock.calls.slice(mark).some(([url, init]) => String(url).includes(y) || String(init?.body ?? "").includes(y))).toBe(false);
  });

  it("«Проверить состояние» frees the lane without asking for Y; the typed text stays", async () => {
    const { f, step } = await started();
    seedRaw(f.values, writtenPrimaryKey, "{not json", "00000000-0000-4000-8000-000000000050");
    const mark = f.fetcher.mock.calls.length;
    await answer("Hund", step); await step(30_000);
    fireEvent.click(screen.getByRole("button", { name: "Проверить состояние" })); await step(); await step(30_000);
    const seen = requests(f, mark);
    expect(seen.statuses).toEqual([]); expect(seen.posts).toEqual([]);
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("Hund");
    expect(pendingRaw(f.values, writtenPrimaryKey)).toBe("{not json");
    // The next attempt is refused by the same record, again without a request.
    await answer("Hund", step); await step(60_000);
    expect(requests(f, mark)).toEqual({ statuses: [], posts: [] });
  });

  it("once the record is gone, the next answer goes out once under a new ID", async () => {
    const { f, step } = await started();
    seedRaw(f.values, writtenPrimaryKey, "{not json", "00000000-0000-4000-8000-000000000050");
    const mark = f.fetcher.mock.calls.length;
    await answer("Hund", step); await step(30_000);
    const y = lastId(f);
    f.values.delete(pointerKeyOf(writtenPrimaryKey, "00000000-0000-4000-8000-000000000050"));
    fireEvent.click(screen.getByRole("button", { name: "Проверить состояние" })); await step(); await step(1000);
    await answer("Hund", step); await step(30_000);
    const seen = requests(f, mark);
    const answers = seen.posts.filter(post => post.kind === "answer.submit");
    expect(answers).toHaveLength(1);
    expect(answers[0].command_id).not.toBe(y);
    expect(seen.statuses).not.toContain(y);
  });

  it("the view goes back to the question: no saving text, the typed answer stays editable (the unsent-slot return of the view)", async () => {
    const { f, step } = await started();
    seedRaw(f.values, writtenPrimaryKey, "{not json", "00000000-0000-4000-8000-000000000050");
    await answer("Hund", step); await step(1000);
    expect(shown()).not.toContain("Сохраняем ответ");
    expect(shown()).not.toContain("Проверяем, сохранилось ли действие");
    expect((screen.getByRole("textbox") as HTMLInputElement).readOnly).toBe(false);
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("Hund");
  });

  it("a new owner over the record has no Y at all: no request about a command", async () => {
    const { f, step, view } = await started();
    seedRaw(f.values, writtenPrimaryKey, "{not json", "00000000-0000-4000-8000-000000000050");
    await answer("Hund", step);
    const y = lastId(f), mark = f.fetcher.mock.calls.length;
    view.unmount(); mount(f); await step(); await step(60_000);
    const seen = requests(f, mark);
    expect(seen.statuses).toEqual([]); expect(seen.posts).toEqual([]);
    expect(f.fetcher.mock.calls.slice(mark).some(([url]) => String(url).includes(y))).toBe(false);
    expect(pendingRaw(f.values, writtenPrimaryKey)).toBe("{not json");
  });
});
