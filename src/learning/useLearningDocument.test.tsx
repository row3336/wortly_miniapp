import { StrictMode, useEffect, useLayoutEffect, type PropsWithChildren } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useLearningDocument } from "./useLearningDocument";
import { learningViewFixture } from "./learningView.test-support";
import { current, deferred, id, primaryKey, profile, response } from "./learningFixtures.test-support";
import { testGate } from "../commands/testGate.test-support";

type Options = Parameters<typeof useLearningDocument>[0];
type Fixture = ReturnType<typeof learningViewFixture>;
const fixtures: Fixture[] = [];
afterEach(() => { cleanup(); for (const f of fixtures.splice(0)) { f.view.dispose(); f.owner.dispose(); } vi.useRealTimers(); vi.restoreAllMocks(); });
function setup(fresh = false, strict = false, prefetched = false, extra: Partial<Options> = {}) {
  const f = learningViewFixture("normal", fresh ? null : id(3)); fixtures.push(f);
  if (prefetched) f.setStep({ ...current(), assignment: { ...current().assignment!, status: "prefetched" } });
  const options: Options = { access: f.access(), storage: f.storage,
    transport: { fetcher: f.fetcher, timeoutMs: 30000, maxResponseBytes: 100000, gate: testGate() }, newId: f.newId,
    initialSessionId: fresh ? null : id(3), transitionMode: "normal", ...extra };
  const wrapper = strict ? ({ children }: PropsWithChildren) => <StrictMode>{children}</StrictMode> : undefined;
  const ui = renderHook(props => useLearningDocument(props), { initialProps: options, wrapper });
  return { f, options, ...ui };
}
const lastCall = (f: Fixture) => f.fetcher.mock.calls.at(-1)!;
function visibility(initial: DocumentVisibilityState = "visible") {
  let state = initial;
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => state);
  return (next: DocumentVisibilityState) => act(() => {
    state = next; document.dispatchEvent(new Event("visibilitychange"));
  });
}

describe("React owner for an opened Learning document", () => {
  it.each(["layout", "passive"])("an explicit %s route tap waits for activation before starting", async timing => {
    const f = learningViewFixture("normal", null); fixtures.push(f);
    const options: Options = { access: f.access(), storage: f.storage, newId: f.newId,
      transport: { fetcher: f.fetcher, timeoutMs: 30000, maxResponseBytes: 100000, gate: testGate() },
      initialSessionId: null, transitionMode: "normal", enabled: false };
    let pending: Promise<void> | null = null;
    const { result, rerender } = renderHook((props: Options) => {
      const current = useLearningDocument(props);
      useLayoutEffect(() => { if (props.enabled && timing === "layout") pending = current.actions.start(); }, [props.enabled]);
      useEffect(() => { if (props.enabled && timing === "passive") pending = current.actions.start(); }, [props.enabled]);
      return current;
    }, { initialProps: options });
    await waitFor(() => expect(result.current.state?.phase).toBe("idle"));
    expect(f.posts()).toEqual([]);
    rerender({ ...options, enabled: true });
    await act(async () => { await pending; });
    expect(f.posts().map(post => post.kind)).toEqual(["session.start"]);
    expect(result.current.state?.phase).toBe("preview");
  });
  it("a new access handle during start persistence keeps the intent without posting it", async () => {
    const { f, options, result, rerender } = setup(true);
    await waitFor(() => expect(result.current.state?.phase).toBe("idle"));
    const gate = deferred<string | null>();
    vi.mocked(f.storage.get).mockReturnValueOnce(gate.promise);
    const calls = vi.mocked(f.storage.get).mock.calls.length;
    let starting!: Promise<void>;
    act(() => { starting = result.current.actions.start(); });
    await waitFor(() => expect(f.storage.get).toHaveBeenCalledTimes(calls + 1));
    f.replace({ session: null }); rerender({ ...options, access: f.access() });
    await act(async () => { gate.resolve(null); await starting; });
    expect(f.posts()).toEqual([]);
    expect(f.values.has(primaryKey)).toBe(true);
    await act(() => result.current.actions.start());
    expect(f.posts()).toEqual([]);
  });
  it("an inactive route recovers the question but cannot present it until the route is enabled", async () => {
    const { f, options, result, rerender } = setup(false, true, true, { enabled: false });
    await waitFor(() => expect(result.current.state?.current?.assignment).toBeTruthy());
    expect(f.posts()).toEqual([]); expect(result.current.state?.canEditDraft).toBe(false);
    expect(result.current.state?.current?.assignment?.status).toBe("prefetched");
    rerender({ ...options, enabled: true });
    await waitFor(() => expect(result.current.state?.phase).toBe("question"));
    expect(f.posts().map(post => post.kind)).toEqual(["assignment.present"]);
  });
  it("changing routes blocks retained actions while keeping the same owner and unsent draft", async () => {
    const { f, options, result, rerender } = setup();
    await waitFor(() => expect(result.current.state?.phase).toBe("question"));
    const actions = result.current.actions; act(() => actions.setDraft("keep across settings"));
    rerender({ ...options, enabled: false });
    expect(result.current.state?.canEditDraft).toBe(false); expect(result.current.state?.canSubmit).toBe(false);
    act(() => actions.setDraft("late edit")); await act(() => actions.submit());
    expect(result.current.state?.draft).toBe("keep across settings"); expect(f.posts()).toEqual([]);
    const read = deferred<Response>(); f.fetcher.mockReturnValueOnce(read.promise);
    rerender({ ...options, enabled: true });
    await waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(2));
    expect(result.current.state?.canSubmit).toBe(false);
    await act(async () => read.resolve(await f.handler(...lastCall(f))));
    await waitFor(() => expect(result.current.state?.canSubmit).toBe(true));
    expect(result.current.actions).toBe(actions); expect(result.current.state?.draft).toBe("keep across settings");
  });
  it("an unconfirmed transition mode never supplies a default or creates a session", async () => {
    const { f, options, result, rerender } = setup(true, false, false, { transitionMode: null });
    await waitFor(() => expect(result.current.state?.phase).toBe("idle"));
    await act(() => result.current.actions.start()); expect(f.posts()).toEqual([]); expect(f.newId).not.toHaveBeenCalled();
    rerender({ ...options, transitionMode: "accelerated" });
    await act(async () => {}); expect(f.posts()).toEqual([]); expect(f.newId).not.toHaveBeenCalled();
    await act(() => result.current.actions.start());
    expect(f.posts().map(post => post.kind)).toEqual(["session.start"]);
  });
  it("new props revoke actions before passive effects run", async () => {
    const f = learningViewFixture(); fixtures.push(f);
    const options: Options = { access: f.access(), storage: f.storage, newId: f.newId,
      transport: { fetcher: f.fetcher, timeoutMs: 30000, maxResponseBytes: 100000, gate: testGate() }, initialSessionId: id(3), transitionMode: "normal" };
    let checked = false;
    const { result, rerender } = renderHook((props: Options) => {
      const current = useLearningDocument(props);
      useLayoutEffect(() => {
        if (props.enabled === false) {
          expect(current.state?.canEditDraft).toBe(false); expect(current.state?.canSubmit).toBe(false);
          current.actions.setDraft("late layout edit"); void current.actions.submit(); checked = true;
        }
      }, [props.enabled]);
      return current;
    }, { initialProps: options });
    await waitFor(() => expect(result.current.state?.phase).toBe("question"));
    act(() => result.current.actions.setDraft("keep")); rerender({ ...options, enabled: false });
    expect(checked).toBe(true); expect(result.current.state?.draft).toBe("keep"); expect(f.posts()).toEqual([]);
  });
  it.each(["route", "settings"])("%s suspension cancels the timer; on return the result waits for «Далее», the next result uses the newly confirmed mode", async reason => {
    const { f, options, result, rerender } = setup();
    await waitFor(() => expect(result.current.state?.phase).toBe("question")); vi.useFakeTimers();
    act(() => result.current.actions.setDraft("Haus")); await act(() => result.current.actions.submit());
    expect(result.current.state?.timer?.durationMs).toBe(3000);
    rerender({ ...options, enabled: reason !== "route", transitionMode: reason === "settings" ? null : "normal" });
    expect(result.current.state?.timer).toBeNull(); expect(result.current.state?.grades).toEqual([]);
    await act(() => result.current.actions.next()); await act(() => result.current.actions.grade(5));
    await act(() => vi.advanceTimersByTimeAsync(5000)); expect(f.posts().map(post => post.kind)).toEqual(["answer.submit"]);
    await act(async () => { rerender({ ...options, transitionMode: "accelerated" }); });
    expect(result.current.state).toMatchObject({ phase: "result_correct", timer: null, canNext: true });
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(f.posts().map(post => post.kind)).toEqual(["answer.submit"]);
    await act(() => result.current.actions.next());
    expect(f.posts().map(post => post.kind)).toEqual(["answer.submit", "assignment.present"]);
    // The wait ends with «Далее»: the next result is timed in the newly confirmed (accelerated) mode.
    act(() => result.current.actions.setDraft("Haus")); await act(() => result.current.actions.submit());
    expect(result.current.state?.timer?.durationMs).toBe(2000);
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(f.posts().map(post => post.kind)).toEqual(["answer.submit", "assignment.present", "answer.submit", "assignment.present"]);
  });
  it("an answer accepted while settings are unconfirmed cannot advance until confirmation and a fresh read", async () => {
    const { f, options, result, rerender } = setup();
    await waitFor(() => expect(result.current.state?.phase).toBe("question"));
    act(() => result.current.actions.setDraft("Haus")); const gate = deferred<Response>(); f.fetcher.mockReturnValueOnce(gate.promise);
    let sending!: Promise<void>; act(() => { sending = result.current.actions.submit(); });
    await waitFor(() => expect(f.posts()).toHaveLength(1)); const response = await f.handler(...lastCall(f));
    rerender({ ...options, transitionMode: null });
    await act(async () => { gate.resolve(response); await sending; });
    expect(result.current.state).toMatchObject({ phase: "result_correct", timer: null, canNext: false, grades: [] });
    expect(f.values.has(primaryKey)).toBe(false); expect(f.posts()).toHaveLength(1);
    rerender(options); await waitFor(() => expect(result.current.state?.canNext).toBe(true));
    expect(result.current.state).toMatchObject({ phase: "result_correct", timer: null }); expect(f.posts()).toHaveLength(1);
    // The wait ends with «Далее»: the next result gets the confirmed mode's timer.
    vi.useFakeTimers(); await act(() => result.current.actions.next());
    act(() => result.current.actions.setDraft("Haus")); await act(() => result.current.actions.submit());
    expect(result.current.state?.timer?.durationMs).toBe(3000);
    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(f.posts().map(post => post.kind)).toEqual(["answer.submit", "assignment.present", "answer.submit", "assignment.present"]);
  });
  it("repeated route changes invalidate a still-pending activation without losing the draft", async () => {
    const { f, options, result, rerender } = setup();
    await waitFor(() => expect(result.current.state?.phase).toBe("question"));
    act(() => result.current.actions.setDraft("keep")); rerender({ ...options, enabled: false });
    const first = deferred<Response>(); f.fetcher.mockReturnValueOnce(first.promise); rerender(options);
    await waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(2));
    const old = await f.handler(...lastCall(f)); rerender({ ...options, enabled: false });
    await act(async () => first.resolve(old));
    expect(result.current.state?.canEditDraft).toBe(false); expect(result.current.state?.draft).toBe("keep");
    rerender(options); await waitFor(() => expect(result.current.state?.canSubmit).toBe(true));
    expect(f.posts()).toEqual([]); expect(result.current.state?.draft).toBe("keep");
  });
  it("returning to the route cannot bypass a pending foreground open", async () => {
    const show = visibility(); const { f, options, result, rerender } = setup();
    await waitFor(() => expect(result.current.state?.phase).toBe("question"));
    act(() => result.current.actions.setDraft("keep")); rerender({ ...options, enabled: false });
    show("hidden"); show("visible"); const calls = f.fetcher.mock.calls.length;
    rerender(options); await act(() => result.current.actions.refresh());
    expect(result.current.state?.canSubmit).toBe(false); expect(f.fetcher).toHaveBeenCalledTimes(calls);
    f.replace(); rerender({ ...options, access: f.access() });
    await waitFor(() => expect(result.current.state?.canSubmit).toBe(true)); expect(f.posts()).toEqual([]);
  });
  it("a new visible access handle clears foreground recovery while the route stays inactive", async () => {
    const show = visibility(); const { f, options, result, rerender } = setup();
    await waitFor(() => expect(result.current.state?.phase).toBe("question"));
    act(() => result.current.actions.setDraft("keep")); rerender({ ...options, enabled: false }); show("hidden"); show("visible");
    f.replace(); rerender({ ...options, enabled: false, access: f.access() });
    await waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(2)); await act(async () => {});
    expect(result.current.state?.canSubmit).toBe(false); expect(f.posts()).toEqual([]);
    rerender({ ...options, access: f.access() }); await waitFor(() => expect(result.current.state?.canSubmit).toBe(true));
    expect(result.current.state?.draft).toBe("keep"); expect(f.posts()).toEqual([]);
  });
  it("Stop remains available with a disabled route and unconfirmed settings", async () => {
    const { f, options, result, rerender } = setup();
    await waitFor(() => expect(result.current.state?.phase).toBe("question"));
    act(() => result.current.actions.setDraft("keep")); rerender({ ...options, enabled: false, transitionMode: null });
    expect(result.current.state?.canStop).toBe(true); await act(() => result.current.actions.stop());
    expect(result.current.state?.phase).toBe("closed"); expect(result.current.state?.draft).toBe("");
    rerender(options); await act(async () => {}); expect(result.current.state?.phase).toBe("closed");
    expect(f.posts().map(post => post.kind)).toEqual(["session.stop"]);
  });
  it("a start waiting for local recovery is cancelled by a route change even if the route returns", async () => {
    const { f, options, result, rerender } = setup(true);
    await waitFor(() => expect(result.current.state?.phase).toBe("idle"));
    const gate = deferred<string | null>(); vi.spyOn(f.storage, "get").mockReturnValueOnce(gate.promise);
    let starting!: Promise<void>; act(() => { starting = result.current.actions.start(); });
    rerender({ ...options, enabled: false }); rerender(options);
    await act(async () => { gate.resolve(null); await starting; });
    expect(f.posts()).toEqual([]); expect(f.newId).not.toHaveBeenCalled();
    await act(() => result.current.actions.start()); expect(f.posts().map(post => post.kind)).toEqual(["session.start"]);
  });
  it("a Settings observation refreshes the same document without discarding its draft", async () => {
    const { f, options, result, rerender } = setup();
    await waitFor(() => expect(result.current.state?.phase).toBe("question"));
    act(() => result.current.actions.setDraft("keep")); const actions = result.current.actions;
    const gate = deferred<Response>(); f.fetcher.mockReturnValueOnce(gate.promise);
    rerender({ ...options, minimumStateVersion: "9" });
    await waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(2));
    expect(result.current.state?.canSubmit).toBe(false); expect(result.current.state?.current).toBeNull();
    await act(async () => gate.resolve(response({ current: current(), state_version: "9" })));
    await waitFor(() => expect(result.current.state?.canSubmit).toBe(true));
    expect(result.current.actions).toBe(actions); expect(result.current.state?.draft).toBe("keep");
    expect(result.current.state?.commands.stateVersion).toBe("9"); expect(f.posts()).toEqual([]);
    rerender({ ...options, minimumStateVersion: "8" }); await act(async () => {});
    expect(result.current.state?.commands.stateVersion).toBe("9"); expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it("an accepted answer below a new Settings floor recovers its exact result instead of skipping to B", async () => {
    const { f, options, result, rerender } = setup();
    await waitFor(() => expect(result.current.state?.phase).toBe("question"));
    act(() => result.current.actions.setDraft("Haus")); const gate = deferred<Response>(); f.fetcher.mockReturnValueOnce(gate.promise);
    let sending!: Promise<void>; act(() => { sending = result.current.actions.submit(); });
    await waitFor(() => expect(f.posts()).toHaveLength(1)); const old = await f.handler(...lastCall(f));
    f.fetcher.mockImplementation(async (...call) => {
      const reply = await f.handler(...call), data = await reply.json(); data.state_version = "9"; return response(data);
    });
    rerender({ ...options, minimumStateVersion: "9" });
    await act(async () => { gate.resolve(old); await sending; });
    await waitFor(() => expect(result.current.state?.phase).toBe("result_correct"));
    expect(result.current.state).toMatchObject({ draft: "", answer: { result: { assignment_id: id(6), result_id: id(706) } } });
    expect(f.fetcher.mock.calls.some(call => new URL(String(call[0]), "http://localhost").searchParams.get("result_id") === id(706))).toBe(true);
    expect(f.posts().map(post => post.kind)).toEqual(["answer.submit"]);
  });
  it.each(["grade", "correct", "previous_grade"])("recovers %s below the Settings floor without changing its navigation intent", async operation => {
    const { f, options, result, rerender } = setup(); if (operation === "correct") f.wrong();
    await waitFor(() => expect(result.current.state?.phase).toBe("question"));
    act(() => result.current.actions.setDraft("Haus")); await act(() => result.current.actions.submit());
    if (operation === "previous_grade") {
      await act(() => result.current.actions.next());
      act(() => { result.current.actions.setDraft("B draft"); result.current.actions.previousResult(); });
    }
    const count = f.posts().length, gate = deferred<Response>(); f.fetcher.mockReturnValueOnce(gate.promise);
    let sending!: Promise<void>; act(() => { sending = operation === "correct" ? result.current.actions.correct() : result.current.actions.grade(5); });
    await waitFor(() => expect(f.posts()).toHaveLength(count + 1)); const old = await f.handler(...lastCall(f));
    f.fetcher.mockImplementation(async (...call) => {
      const reply = await f.handler(...call), data = await reply.json(); data.state_version = "9"; return response(data);
    });
    rerender({ ...options, minimumStateVersion: "9" }); await act(async () => { gate.resolve(old); await sending; });
    await waitFor(() => expect(result.current.state?.phase).toBe(operation === "grade" ? "question" : operation === "correct" ? "result_correct" : "previous_result"));
    expect(result.current.state?.answer?.result?.grade).toBe(operation === "correct" ? 4 : 5);
    expect(result.current.state?.draft).toBe(operation === "previous_grade" ? "B draft" : "");
    expect(f.posts().filter(post => post.kind === "result.grade" || post.kind === "result.correct")).toHaveLength(1);
    expect(f.posts().filter(post => post.kind === "assignment.present")).toHaveLength(operation === "correct" ? 0 : 1);
  });
  it("failed exact-result recovery keeps the accepted answer and never presents B as a substitute", async () => {
    const { f, options, result, rerender } = setup();
    await waitFor(() => expect(result.current.state?.phase).toBe("question"));
    act(() => result.current.actions.setDraft("Haus")); const gate = deferred<Response>(); f.fetcher.mockReturnValueOnce(gate.promise);
    let sending!: Promise<void>; act(() => { sending = result.current.actions.submit(); });
    await waitFor(() => expect(f.posts()).toHaveLength(1)); const old = await f.handler(...lastCall(f));
    let fail = true;
    f.fetcher.mockImplementation(async (...call) => {
      if (fail && new URL(String(call[0]), "http://localhost").searchParams.has("result_id")) throw new Error("offline");
      const reply = await f.handler(...call), data = await reply.json(); data.state_version = "9"; return response(data);
    });
    rerender({ ...options, minimumStateVersion: "9" }); await act(async () => { gate.resolve(old); await sending; });
    await waitFor(() => expect(result.current.state?.problem).toBe("load"));
    expect(result.current.state).toMatchObject({ phase: "stale", draft: "", commands: { primary: { outcome: "accepted", pending: false } } });
    expect(f.posts()).toHaveLength(1); fail = false; await act(() => result.current.actions.refresh());
    expect(result.current.state?.phase).toBe("result_correct"); expect(f.posts()).toHaveLength(1);
  });
  it("Stop during exact-result recovery wins over its late accepted answer display", async () => {
    const { f, options, result, rerender } = setup();
    await waitFor(() => expect(result.current.state?.phase).toBe("question"));
    act(() => result.current.actions.setDraft("Haus")); const gate = deferred<Response>(); f.fetcher.mockReturnValueOnce(gate.promise);
    let sending!: Promise<void>; act(() => { sending = result.current.actions.submit(); });
    await waitFor(() => expect(f.posts()).toHaveLength(1)); const old = await f.handler(...lastCall(f));
    const reading = deferred<Response>(); let answer: Response | null = null;
    f.fetcher.mockImplementation(async (...call) => {
      const reply = await f.handler(...call), data = await reply.json(); data.state_version = "9";
      if (new URL(String(call[0]), "http://localhost").searchParams.has("result_id")) { answer = response(data); return reading.promise; }
      return response(data);
    });
    rerender({ ...options, minimumStateVersion: "9" }); await act(async () => { gate.resolve(old); await sending; });
    await waitFor(() => expect(answer).not.toBeNull()); await act(() => result.current.actions.stop());
    await act(async () => reading.resolve(answer!));
    expect(result.current.state).toMatchObject({ phase: "closed", answer: null, draft: "" });
    expect(f.posts().map(post => post.kind)).toEqual(["answer.submit", "session.stop"]);
  });
  it("a Settings observation during an older same-handle read queues one fresh read", async () => {
    const { f, options, result, rerender } = setup();
    await waitFor(() => expect(result.current.state?.phase).toBe("question"));
    act(() => result.current.actions.setDraft("keep"));
    const old = deferred<Response>(); f.fetcher.mockReturnValueOnce(old.promise);
    let reading!: Promise<void>; act(() => { reading = result.current.actions.refresh(); });
    await waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(2));
    const fresh = deferred<Response>(); f.fetcher.mockReturnValueOnce(fresh.promise);
    rerender({ ...options, minimumStateVersion: "9" }); rerender({ ...options, minimumStateVersion: "10" });
    await act(async () => { old.resolve(response({ current: current(), state_version: "8" })); await reading; });
    await waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(3)); expect(result.current.state?.canSubmit).toBe(false);
    await act(async () => fresh.resolve(response({ current: current(), state_version: "10" })));
    await waitFor(() => expect(result.current.state?.canSubmit).toBe(true));
    expect(result.current.state?.draft).toBe("keep"); expect(f.fetcher).toHaveBeenCalledTimes(3); expect(f.posts()).toEqual([]);
  });
  it("a Settings floor update while awaiting foreground does not read through the old access", async () => {
    const show = visibility(); const { f, options, result, rerender } = setup();
    await waitFor(() => expect(result.current.state?.phase).toBe("question"));
    act(() => result.current.actions.setDraft("keep")); show("hidden"); show("visible");
    rerender({ ...options, minimumStateVersion: "9" }); await act(() => result.current.actions.refresh());
    expect(f.fetcher).toHaveBeenCalledTimes(1); expect(result.current.state?.canSubmit).toBe(false);
    f.fetcher.mockResolvedValueOnce(response({ current: current(), state_version: "9" })); f.replace();
    rerender({ ...options, access: f.access(), minimumStateVersion: "9" });
    await waitFor(() => expect(result.current.state?.canSubmit).toBe(true));
    expect(result.current.state?.draft).toBe("keep"); expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it("hidden result timers cannot present a question before a fresh foreground handle", async () => {
    const show = visibility(); const { f, options, result, rerender } = setup();
    await waitFor(() => expect(result.current.state?.phase).toBe("question")); vi.useFakeTimers();
    act(() => result.current.actions.setDraft("Haus")); await act(() => result.current.actions.submit());
    show("hidden"); expect(result.current.state?.timer).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(f.posts().map(post => post.kind)).toEqual(["answer.submit"]);
    const reads = f.fetcher.mock.calls.length; show("visible");
    await act(() => result.current.actions.next()); expect(f.fetcher).toHaveBeenCalledTimes(reads);
    f.replace(); await act(async () => { rerender({ ...options, access: f.access() }); });
    expect(result.current.state).toMatchObject({ phase: "result_correct", timer: null, canNext: true });
    await act(() => vi.advanceTimersByTimeAsync(10000));
    expect(f.posts().map(post => post.kind)).toEqual(["answer.submit"]);
    await act(() => result.current.actions.next());
    expect(f.posts().map(post => post.kind)).toEqual(["answer.submit", "assignment.present"]);
  });
  it("a hidden mount reads a prefetched question but presents it only after foreground open", async () => {
    const show = visibility("hidden"); const { f, options, result, rerender } = setup(false, true, true);
    await act(async () => {});
    expect(f.posts()).toEqual([]); show("visible"); await act(async () => {});
    expect(f.posts()).toEqual([]);
    f.replace(); rerender({ ...options, access: f.access() });
    await waitFor(() => expect(result.current.state?.phase).toBe("question"));
    expect(f.posts().map(post => post.kind)).toEqual(["assignment.present"]);
  });
  it("foreground waits for open and the subsequent study read while preserving the exact draft", async () => {
    const show = visibility(); const { f, options, result, rerender } = setup();
    await waitFor(() => expect(result.current.state?.phase).toBe("question"));
    act(() => result.current.actions.setDraft("unfinished")); show("hidden"); show("visible");
    expect(result.current.state?.canSubmit).toBe(false);
    act(() => result.current.actions.setDraft("overwritten")); await act(() => result.current.actions.submit({ forgot: true }));
    expect(result.current.state?.draft).toBe("unfinished"); expect(f.posts()).toEqual([]);
    const gate = deferred<Response>(); f.fetcher.mockReturnValueOnce(gate.promise);
    f.replace(); rerender({ ...options, access: f.access() });
    await waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(2));
    expect(result.current.state?.canSubmit).toBe(false);
    await act(async () => gate.resolve(await f.handler(...lastCall(f))));
    await waitFor(() => expect(result.current.state?.canSubmit).toBe(true));
    expect(result.current.state?.draft).toBe("unfinished"); expect(f.posts()).toEqual([]);
  });
  it("pageshow suspends before App's ordinary foreground listener and cannot read with the old handle", async () => {
    const { f, options, result, rerender } = setup();
    await waitFor(() => expect(result.current.state?.phase).toBe("question"));
    act(() => result.current.actions.setDraft("keep"));
    let canSubmit: boolean | undefined;
    const foreground = () => { canSubmit = result.current.state?.canSubmit; void result.current.actions.submit(); };
    window.addEventListener("pageshow", foreground);
    try {
      act(() => window.dispatchEvent(new Event("pageshow")));
      // React may not have rendered yet, so the retained action is the critical guard.
      expect(canSubmit).toBeDefined(); expect(result.current.state?.canSubmit).toBe(false);
      await act(() => result.current.actions.refresh()); expect(f.fetcher).toHaveBeenCalledTimes(1);
      f.replace(); rerender({ ...options, access: f.access() });
      await waitFor(() => expect(result.current.state?.canSubmit).toBe(true));
      expect(f.posts()).toEqual([]); expect(result.current.state?.draft).toBe("keep");
    } finally { window.removeEventListener("pageshow", foreground); }
  });
  it("a handle received while hidden cannot unlock the next visible event", async () => {
    const show = visibility("hidden"); const { f, options, result, rerender } = setup(false, false, true);
    await act(async () => {}); f.replace(); await act(async () => { rerender({ ...options, access: f.access() }); });
    expect(f.posts()).toEqual([]); const reads = f.fetcher.mock.calls.length;
    show("visible"); await act(() => result.current.actions.refresh());
    expect(f.fetcher).toHaveBeenCalledTimes(reads); expect(f.posts()).toEqual([]);
    f.replace(); rerender({ ...options, access: f.access() });
    await waitFor(() => expect(result.current.state?.phase).toBe("question")); expect(f.posts()).toHaveLength(1);
  });
  it("hiding again during foreground study read prevents its late activation", async () => {
    const show = visibility(); const { f, options, result, rerender } = setup();
    await waitFor(() => expect(result.current.state?.phase).toBe("question"));
    act(() => result.current.actions.setDraft("keep")); show("hidden"); show("visible");
    const gate = deferred<Response>(); f.fetcher.mockReturnValueOnce(gate.promise);
    f.replace(); rerender({ ...options, access: f.access() });
    await waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(2)); const reply = await f.handler(...lastCall(f));
    show("hidden"); await act(async () => gate.resolve(reply));
    expect(result.current.state?.canSubmit).toBe(false); show("visible");
    expect(result.current.state?.canSubmit).toBe(false);
    f.replace(); rerender({ ...options, access: f.access() });
    await waitFor(() => expect(result.current.state?.canSubmit).toBe(true));
    expect(result.current.state?.draft).toBe("keep"); expect(f.posts()).toEqual([]);
  });
  it("a newer foreground handle supersedes an activation whose read is still in flight", async () => {
    const show = visibility(); const { f, options, result, rerender } = setup();
    await waitFor(() => expect(result.current.state?.phase).toBe("question"));
    act(() => result.current.actions.setDraft("keep")); show("hidden"); show("visible");
    const first = deferred<Response>(), second = deferred<Response>(); f.fetcher.mockReturnValueOnce(first.promise);
    f.replace(); rerender({ ...options, access: f.access() });
    await waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(2)); const old = await f.handler(...lastCall(f));
    f.fetcher.mockReturnValueOnce(second.promise); f.replace(); rerender({ ...options, access: f.access() });
    await act(async () => first.resolve(old)); await waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(3));
    expect(result.current.state?.canSubmit).toBe(false);
    act(() => result.current.actions.setDraft("cannot edit yet"));
    await act(async () => second.resolve(await f.handler(...lastCall(f))));
    await waitFor(() => expect(result.current.state?.canSubmit).toBe(true));
    expect(result.current.state?.draft).toBe("keep"); expect(f.posts()).toEqual([]);
  });
  it("hidden idle state never starts a new session, including a retained tap", async () => {
    const show = visibility("hidden"); const { f, options, result, rerender } = setup(true);
    await waitFor(() => expect(result.current.state?.phase).toBe("idle"));
    await act(() => result.current.actions.start()); show("visible"); await act(() => result.current.actions.start());
    expect(f.posts()).toEqual([]); expect(f.newId).not.toHaveBeenCalled();
    f.replace(); await act(async () => { rerender({ ...options, access: f.access() }); });
    expect(f.posts()).toEqual([]); await act(() => result.current.actions.start()); expect(f.posts()).toHaveLength(1);
  });
  it("an answer accepted in the background cannot advance until foreground has refreshed access", async () => {
    const show = visibility(); const { f, options, result, rerender } = setup();
    await waitFor(() => expect(result.current.state?.phase).toBe("question"));
    act(() => result.current.actions.setDraft("Haus"));
    const gate = deferred<Response>(); f.fetcher.mockReturnValueOnce(gate.promise);
    let sending!: Promise<void>; act(() => { sending = result.current.actions.submit(); });
    await waitFor(() => expect(f.posts()).toHaveLength(1)); const reply = await f.handler(...lastCall(f));
    show("hidden"); vi.useFakeTimers(); await act(async () => { gate.resolve(reply); await sending; });
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(result.current.state).toMatchObject({ phase: "result_correct", timer: null }); expect(f.posts()).toHaveLength(1);
    show("visible"); f.replace(); await act(async () => { rerender({ ...options, access: f.access() }); });
    expect(result.current.state).toMatchObject({ phase: "result_correct", timer: null, canNext: true });
    await act(() => vi.advanceTimersByTimeAsync(5000)); expect(f.posts()).toHaveLength(1);
  });
  it("a grade acknowledged in the background advances once immediately after foreground recovery", async () => {
    const show = visibility(); const { f, options, result, rerender } = setup();
    await waitFor(() => expect(result.current.state?.phase).toBe("question"));
    act(() => result.current.actions.setDraft("Haus")); await act(() => result.current.actions.submit());
    const gate = deferred<Response>(); f.fetcher.mockReturnValueOnce(gate.promise);
    let grading!: Promise<void>; act(() => { grading = result.current.actions.grade(5); });
    await waitFor(() => expect(f.posts()).toHaveLength(2)); const reply = await f.handler(...lastCall(f));
    show("hidden"); vi.useFakeTimers(); await act(async () => { gate.resolve(reply); await grading; });
    await act(() => vi.advanceTimersByTimeAsync(5000)); expect(f.posts()).toHaveLength(2);
    show("visible"); f.replace(); await act(async () => { rerender({ ...options, access: f.access() }); });
    expect(result.current.state).toMatchObject({ phase: "question", timer: null, answer: { result: { grade: 5 } } });
    expect(f.posts().map(post => post.kind)).toEqual(["answer.submit", "result.grade", "assignment.present"]);
    await act(() => vi.advanceTimersByTimeAsync(5000)); expect(f.posts()).toHaveLength(3);
  });
  it("Stop stays independent of a suspended window and late foreground cannot reopen it", async () => {
    const show = visibility(); const { f, options, result, rerender } = setup();
    await waitFor(() => expect(result.current.state?.phase).toBe("question"));
    act(() => result.current.actions.setDraft("discard on explicit Stop")); show("hidden");
    await act(() => result.current.actions.stop()); expect(result.current.state).toMatchObject({ phase: "closed", draft: "" });
    show("visible"); f.replace(); await act(async () => { rerender({ ...options, access: f.access() }); });
    expect(result.current.state?.phase).toBe("closed"); expect(f.posts().map(post => post.kind)).toEqual(["session.stop"]);
  });
  it.each([false, true])("only an explicit tap starts Learning, including React StrictMode (%s)", async strict => {
    const { f, result } = setup(true, strict);
    await waitFor(() => expect(result.current.state?.phase).toBe("idle"));
    expect(f.posts()).toEqual([]); expect(f.newId).not.toHaveBeenCalled();
    await act(async () => { await Promise.all([result.current.actions.start(), result.current.actions.start()]); });
    expect(result.current.state?.phase).toBe("preview"); expect(f.posts().map(post => post.kind)).toEqual(["session.start"]);
    expect(f.newId).toHaveBeenCalledTimes(2); // One session ID and one command ID.
  });
  it("loads a resumed session without another start or answer", async () => {
    const { f, result } = setup(); await waitFor(() => expect(result.current.state?.phase).toBe("question"));
    expect(f.posts()).toEqual([]); expect(f.newId).not.toHaveBeenCalled();
    await act(() => result.current.actions.start()); expect(f.posts()).toEqual([]);
  });
  it("StrictMode presents a resumed prefetched question once without an answer or another start", async () => {
    const { f, result } = setup(false, true, true); await waitFor(() => expect(result.current.state?.phase).toBe("question"));
    expect(f.posts().map(post => post.kind)).toEqual(["assignment.present"]);
    expect(f.posts()[0].assignment_id).toBe(id(6)); expect(f.newId).toHaveBeenCalledOnce();
  });
  it("same document and a new access handle preserve the draft and use new credentials", async () => {
    const { f, options, result, rerender } = setup(); await waitFor(() => expect(result.current.state?.phase).toBe("question"));
    const actions = result.current.actions; act(() => actions.setDraft("unfinished"));
    f.replace({}, "fresh-synthetic-token"); rerender({ ...options, access: f.access() });
    await waitFor(() => expect(result.current.state?.canSubmit).toBe(true));
    expect(result.current.actions).toBe(actions); expect(result.current.state?.draft).toBe("unfinished");
    expect(new Headers(lastCall(f)[1]?.headers).get("Authorization")).toBe("Bearer fresh-synthetic-token");
    expect(f.posts()).toEqual([]);
  });
  it("same document retains B and its previous-result view through foreground", async () => {
    const { f, options, result, rerender } = setup(); f.wrong(); await waitFor(() => expect(result.current.state?.phase).toBe("question"));
    act(() => result.current.actions.setDraft("wrong A")); await act(() => result.current.actions.submit()); await act(() => result.current.actions.next());
    act(() => { result.current.actions.setDraft("B draft"); result.current.actions.previousResult(); });
    f.replace(); rerender({ ...options, access: f.access() });
    await waitFor(() => expect(result.current.state?.canCorrect).toBe(true));
    expect(result.current.state).toMatchObject({ phase: "previous_result", draft: "B draft" });
    await act(() => result.current.actions.next()); expect(result.current.state?.draft).toBe("B draft");
    expect(f.posts().map(post => post.kind)).toEqual(["answer.submit", "assignment.present"]);
  });
  it("an updated resume seed after own start does not recreate the owner or its draft", async () => {
    const { f, options, result, rerender } = setup(true);
    await waitFor(() => expect(result.current.state?.phase).toBe("idle")); await act(() => result.current.actions.start());
    await act(() => result.current.actions.advancePreview()); act(() => result.current.actions.setDraft("my own draft"));
    const session = result.current.state!.sessionId!;
    f.replace({ session: { id: session, phase: "active" } });
    rerender({ ...options, initialSessionId: session, access: f.access() });
    await waitFor(() => expect(result.current.state?.canSubmit).toBe(true));
    expect(result.current.state?.draft).toBe("my own draft");
    expect(f.posts().map(post => post.kind)).toEqual(["session.start", "learning.preview_next", "assignment.present"]);
  });
  it("a different document never receives the old unsent draft", async () => {
    const { f, options, result, rerender } = setup(); await waitFor(() => expect(result.current.state?.phase).toBe("question"));
    act(() => result.current.actions.setDraft("private old draft")); f.replace({ document_id: id(91) });
    rerender({ ...options, access: f.access() }); await waitFor(() => expect(result.current.state?.phase).toBe("question"));
    expect(result.current.state?.draft).toBe(""); expect(f.posts()).toEqual([]);
  });
  it("a confirmed dictionary change in the same document replaces the old owner and can explicitly start", async () => {
    const { f, options, result, rerender } = setup(); await waitFor(() => expect(result.current.state?.phase).toBe("question"));
    act(() => result.current.actions.setDraft("old pair draft")); const oldKey = f.access().key;
    f.replace({ profile: { ...profile(), dictionary_language: "en" }, session: null });
    expect(f.access().key).toBe(oldKey); rerender({ ...options, access: f.access(), initialSessionId: null });
    await waitFor(() => expect(result.current.state?.phase).toBe("idle"));
    expect(result.current.state?.draft).toBe(""); expect(result.current.state?.commands.live).toBe(true); expect(f.posts()).toEqual([]);
    f.fetcher.mockImplementationOnce(async (...call) => {
      expect(JSON.parse(f.values.get(primaryKey)!).pair).toBe("en-de");
      const reply = await f.handler(...call), data = await reply.json();
      data.current.pair = "en-de"; data.current.preview.content.pair = "en-de";
      data.current.preview.content.translations.common = ["Hello"]; return response(data);
    });
    await act(() => result.current.actions.start());
    expect(result.current.state).toMatchObject({ phase: "preview", current: { pair: "en-de" } });
    expect(f.posts().map(post => post.kind)).toEqual(["session.start"]);
  });
  it("revoked access disappears on render even without a controller callback", async () => {
    const { f, options, result, rerender } = setup(); await waitFor(() => expect(result.current.state?.phase).toBe("question"));
    act(() => result.current.actions.setDraft("hide me")); f.revoke(); rerender({ ...options });
    expect(result.current.state).toMatchObject({ phase: "disposed", question: null, draft: "" });
    await act(() => result.current.actions.submit()); await act(() => result.current.actions.start()); expect(f.posts()).toEqual([]);
  });
  it("an invalid access cannot create an owner or start from a retained action callback", async () => {
    const { f, options, result, rerender } = setup(); await waitFor(() => expect(result.current.state?.phase).toBe("question"));
    f.replace({ document_id: id(91) }); f.revoke(); rerender({ ...options, access: f.access() });
    expect(result.current.state).toBeNull(); await act(() => result.current.actions.start()); expect(f.posts()).toEqual([]);
  });
  it("foreground during an older read waits for the fresh result and keeps the current draft", async () => {
    const { f, options, result, rerender } = setup(); await waitFor(() => expect(result.current.state?.phase).toBe("question"));
    act(() => result.current.actions.setDraft("keep")); const gate = deferred<Response>(); f.fetcher.mockReturnValueOnce(gate.promise);
    let reading!: Promise<void>; act(() => { reading = result.current.actions.refresh(); });
    await waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(2)); const old = await f.handler(...lastCall(f));
    f.replace({}, "fresh-synthetic-token"); rerender({ ...options, access: f.access() });
    await act(async () => { gate.resolve(old); await reading; });
    await waitFor(() => expect(result.current.state?.canSubmit).toBe(true));
    expect(result.current.state?.draft).toBe("keep"); expect(f.posts()).toEqual([]); expect(f.fetcher).toHaveBeenCalledTimes(3);
  });
  it("unmount cancels result timers and retained callbacks cannot send to a disposed owner", async () => {
    const { f, result, unmount } = setup(); await waitFor(() => expect(result.current.state?.phase).toBe("question"));
    vi.useFakeTimers(); act(() => result.current.actions.setDraft("Haus")); await act(() => result.current.actions.submit());
    expect(result.current.state?.timer?.durationMs).toBe(3000); const actions = result.current.actions; unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); await actions.next(); await actions.start(); });
    expect(f.posts().map(post => post.kind)).toEqual(["answer.submit"]);
  });
  it("the next confirmed transition setting is used without discarding the current draft", async () => {
    const { f, options, result, rerender } = setup(); f.wrong(); await waitFor(() => expect(result.current.state?.phase).toBe("question"));
    act(() => result.current.actions.setDraft("Haus")); rerender({ ...options, transitionMode: "accelerated" });
    expect(result.current.state?.draft).toBe("Haus"); await act(() => result.current.actions.submit());
    expect(result.current.state?.timer?.durationMs).toBe(2000);
  });
  it("remount recovers an already submitted answer rather than recreating its command", async () => {
    const { f, options, result, unmount } = setup(); f.wrong(); await waitFor(() => expect(result.current.state?.phase).toBe("question"));
    act(() => result.current.actions.setDraft("exact input")); const gate = deferred<Response>(); f.fetcher.mockReturnValueOnce(gate.promise);
    let sending!: Promise<void>; act(() => { sending = result.current.actions.submit(); });
    await waitFor(() => expect(f.posts()).toHaveLength(1)); const old = await f.handler(...lastCall(f)); unmount();
    expect(f.values.has(primaryKey)).toBe(true);
    const next = renderHook(props => useLearningDocument(props), { initialProps: options });
    await waitFor(() => expect(next.result.current.state?.phase).toBe("result_wrong"));
    await act(async () => { gate.resolve(old); await sending; });
    expect(next.result.current.state?.phase).toBe("result_wrong"); expect(f.posts()).toHaveLength(1); expect(f.values.has(primaryKey)).toBe(false);
  });
  it("foreground while an old-handle answer is still in flight reconciles its receipt without resending", async () => {
    const { f, options, result, rerender } = setup(); f.wrong(); await waitFor(() => expect(result.current.state?.phase).toBe("question"));
    act(() => result.current.actions.setDraft("exact input")); const gate = deferred<Response>(); f.fetcher.mockReturnValueOnce(gate.promise);
    let sending!: Promise<void>; act(() => { sending = result.current.actions.submit(); });
    await waitFor(() => expect(f.posts()).toHaveLength(1)); const old = await f.handler(...lastCall(f));
    f.replace({}, "fresh-synthetic-token"); rerender({ ...options, access: f.access() });
    await act(async () => { gate.resolve(old); await sending; });
    await waitFor(() => expect(result.current.state?.phase).toBe("result_wrong"));
    expect(f.posts()).toHaveLength(1); expect(f.values.has(primaryKey)).toBe(false);
  });
});
