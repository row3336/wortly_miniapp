// Q03 вариант 1 (К19-017, П5-002, TZA S-A03, WM Q-06): the answer is committed, its reply is lost and the client finds it
// by the same command ID («уже записан»), at once, after a pause offline, or as a new owner after a reload. Its result
// waits for «Далее» in both modes and at every grade: no time, read, return from background or old countdown turns it.
// A result this window got by the reply to its own send keeps its mode's rule (correct: 3 s / 2 s; error: waits / 2 s).
// «Уже записан» as the reply to a repeated POST (command.status "already_applied": a late first copy committed between the
// check and the resend) is the same fact and waits the same way.
import { afterEach, describe, expect, it, vi } from "vitest";
import { WrittenViewController } from "./writtenViewController";
import { id, tick, writtenFixture } from "./writtenFixtures.test-support";

type Mode = "normal" | "accelerated";
const owners: WrittenViewController[] = [];
afterEach(() => { owners.splice(0).forEach(owner => owner.dispose()); vi.useRealTimers(); });
function harness(cards: number[], mode: Mode) {
  const f = writtenFixture({ cards });
  const own = () => {
    const view = new WrittenViewController({ access: f.access, storage: f.storage, transport: f.transport, newId: f.newId,
      sessionId: null, transitionMode: () => mode, onUpdate: vi.fn() });
    owners.push(view);
    return view;
  };
  const view = own();
  const kinds = () => f.posts().map(post => post.kind);
  const lastSubmit = () => f.posts().filter(post => post.kind === "answer.submit").at(-1)!.command_id as string;
  return { ...f, view, own, kinds, lastSubmit };
}
const resultPhase = (grade: 2 | 4) => grade === 4 ? "result_correct" : "result_wrong";
const draft = (grade: 2 | 4) => grade === 4 ? "Haus" : "falsch";
const cases = [["normal", 4], ["normal", 2], ["accelerated", 4], ["accelerated", 2]] as const;

/** Nothing but «Далее» turns the card: time, a read, a return from background. Then «Далее» shows the next one. */
async function waitsForNext(view: WrittenViewController, h: ReturnType<typeof harness>, grade: 2 | 4, nextCard: number) {
  const phase = resultPhase(grade), presents = h.kinds().filter(kind => kind === "assignment.present").length;
  expect(view.snapshot()).toMatchObject({ phase, answer: { result: { grade } }, timer: null, canNext: true });
  await tick(10000);
  await view.refresh(); await tick(10000);
  view.suspend(); await view.resume(); await tick(10000);
  expect(view.snapshot()).toMatchObject({ phase, timer: null, canNext: true });
  expect(h.kinds().filter(kind => kind === "assignment.present")).toHaveLength(presents);
  await view.next(); await tick(0);
  expect(h.kinds().at(-1)).toBe("assignment.present");
  expect(h.kinds().filter(kind => kind === "assignment.present")).toHaveLength(presents + 1);
  expect(view.snapshot()).toMatchObject({ phase: "question", question: { id: id(nextCard) } });
}

describe("Q03: a result the check by its ID reports already recorded waits for «Далее»", () => {
  for (const [mode, grade] of cases) it(`right after the lost reply: ${mode}, grade ${grade}`, async () => {
    vi.useFakeTimers(); const h = harness([6, 7], mode);
    await h.view.refresh(); await h.view.start("words");
    h.view.setDraft(draft(grade)); h.loseReply(); await h.view.submit(); await tick(0);
    const commandId = h.lastSubmit();
    expect(h.gets(`/commands/${commandId}`).length).toBeGreaterThan(0);
    expect(h.posts().filter(post => post.command_id === commandId)).toHaveLength(1);
    expect(h.view.snapshot().commands.primary.resolved).toMatchObject({ commandId, kind: "answer.submit" });
    expect(h.view.snapshot().commands.primary.resolved?.restored).toBeUndefined();
    expect(h.view.snapshot().commands.recovery).toMatchObject({ state: { name: "settled" }, sends: 1 });
    await waitsForNext(h.view, h, grade, 7);
  });

  for (const [mode, grade] of cases) it(`after a pause offline, by the check before the retry: ${mode}, grade ${grade}`, async () => {
    vi.useFakeTimers(); const h = harness([6, 7], mode);
    await h.view.refresh(); await h.view.start("words");
    h.view.setDraft(draft(grade)); h.loseReply(); const online = h.offline(); await h.view.submit(); await tick(0);
    const commandId = h.lastSubmit();
    expect(h.view.snapshot()).toMatchObject({ phase: "unknown", answer: null });
    // The recovery timers run while offline; none of them shows or turns a result.
    await tick(30000);
    expect(h.view.snapshot()).toMatchObject({ phase: "unknown", answer: null });
    // Back online: the next light probe (at most 30 s) checks the same ID; stop the clock at that moment.
    online();
    for (let step = 0; step < 60 && h.view.snapshot().commands.primary.resolved?.commandId !== commandId; step++) await tick(500);
    await tick(0);
    expect(h.posts().filter(post => post.command_id === commandId)).toHaveLength(1);
    expect(h.view.snapshot().commands.primary.resolved).toMatchObject({ commandId, kind: "answer.submit" });
    expect(h.view.snapshot().commands.primary.resolved?.restored).toBeUndefined();
    await waitsForNext(h.view, h, grade, 7);
  });
});

describe("Q03 after a reload: an old result a new owner restores by its ID waits for «Далее» (WM Q-06)", () => {
  for (const [mode, grade] of cases) it(`${mode}, grade ${grade}`, async () => {
    vi.useFakeTimers(); const h = harness([6, 7], mode);
    await h.view.refresh(); await h.view.start("words");
    h.view.setDraft(draft(grade)); h.loseReply(); h.offline(); await h.view.submit();
    const commandId = h.lastSubmit();
    h.view.dispose(); h.fetcher.mockImplementation(h.server.handle);
    const next = h.own(); await next.refresh(); await tick(0);
    expect(next.snapshot().commands.primary.resolved).toMatchObject({ commandId, kind: "answer.submit", restored: true });
    expect(h.posts().filter(post => post.command_id === commandId)).toHaveLength(1);
    await waitsForNext(next, h, grade, 7);
  });
});

describe("Q03: a result the server reports already recorded as the reply to a repeated POST waits for «Далее»", () => {
  for (const [mode, grade] of cases) it(`late first copy, the resend gets already_applied: ${mode}, grade ${grade}`, async () => {
    vi.useFakeTimers(); const h = harness([6, 7], mode);
    await h.view.refresh(); await h.view.start("words");
    h.view.setDraft(draft(grade));
    // POST #1 never answers; the server commits it only after two status checks found nothing, right before the resend
    // (the check-then-send race of a slow core: the late first copy lands between the last check and the resend).
    let late: (() => Promise<Response>) | null = null;
    h.fetcher.mockImplementationOnce(async (...call) => { late = () => h.server.handle(...call); throw new TypeError("network"); });
    h.fetcher.mockImplementation(async (...call) => {
      const reply = await h.server.handle(...call);
      if (late && call[1]?.method === "GET" && String(call[0]).includes("/sessions/") && h.gets("/commands/").length >= 2) { const commit = late; late = null; await commit(); }
      return reply;
    });
    await h.view.submit(); await tick(0);
    const commandId = h.lastSubmit();
    for (let step = 0; step < 40 && h.view.snapshot().commands.primary.resolved?.commandId !== commandId; step++) await tick(500);
    await tick(0);
    // The resend itself was answered "already_applied" by the server, as the reply to a live send.
    expect(h.posts().filter(post => post.command_id === commandId)).toHaveLength(2);
    expect(h.view.snapshot().commands.primary.resolved).toMatchObject({ commandId, kind: "answer.submit", checked: true });
    expect(h.view.snapshot().commands.primary.resolved?.restored).toBeUndefined();
    await waitsForNext(h.view, h, grade, 7);
  });
});

describe("controls: a result got by the reply to this window's own send keeps its mode's rule", () => {
  for (const [mode, grade] of cases) it(`live reply: ${mode}, grade ${grade}`, async () => {
    vi.useFakeTimers(); const h = harness([6, 7], mode);
    await h.view.refresh(); await h.view.start("words");
    h.view.setDraft(draft(grade)); await h.view.submit();
    const waits = mode === "normal" && grade === 2;
    expect(h.view.snapshot()).toMatchObject({ phase: resultPhase(grade),
      timer: waits ? null : { durationMs: mode === "normal" ? 3000 : 2000 } });
    await tick(3000);
    if (waits) {
      expect(h.view.snapshot().phase).toBe("result_wrong");
      await h.view.next(); await tick(0);
    }
    expect(h.view.snapshot()).toMatchObject({ phase: "question", question: { id: id(7) } });
  });

  for (const mode of ["normal", "accelerated"] as const) it(`lost before commit, resent by the machine: the reply decides (${mode})`, async () => {
    vi.useFakeTimers(); const h = harness([6, 7], mode);
    await h.view.refresh(); await h.view.start("words");
    h.view.setDraft("Haus"); h.dropRequest(); await h.view.submit(); await tick(0);
    expect(h.view.snapshot()).toMatchObject({ phase: "unknown", answer: null });
    await tick(2000); await tick(0);
    expect(h.posts().filter(post => post.kind === "answer.submit")).toHaveLength(2);
    expect(h.view.snapshot()).toMatchObject({ phase: "result_correct", timer: { durationMs: mode === "normal" ? 3000 : 2000 } });
    await tick(3000);
    expect(h.view.snapshot()).toMatchObject({ phase: "question", question: { id: id(7) } });
  });
});
