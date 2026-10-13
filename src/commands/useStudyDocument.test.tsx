// The React owner of a study view (M-REFAC-CMD): one owner per document, pair and owner seed; background suspends it.
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenedClient, Profile } from "../api/generated";
import { createOpenedAccess, type OpenedAccess } from "../app/openedAccess";
import type { AsyncStorage } from "../platform/storage";
import { useStudyDocument, type StudyDocumentOptions, type StudyViewSettings } from "./useStudyDocument";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
type Options = StudyDocumentOptions & { initialSessionId: string | null };
/** A recording controller: the hook only drives its lifecycle and forwards actions. */
class FakeController {
  calls: string[] = [];
  /** The session this owner leads (the mode's own fact, e.g. a written receipt it restored). */
  leads: string | null = null;
  constructor(readonly seed: string | null, readonly settings: StudyViewSettings<string>) {}
  snapshot(): string { return `view:${this.seed}`; }
  suspend(reason: "background" | "disabled" = "background"): void { this.calls.push(reason === "background" ? "suspend" : "suspend:disabled"); }
  async resume(): Promise<void> { this.calls.push("resume"); }
  resumeRecovery(): void { this.calls.push("recover"); }
  async refresh(): Promise<void> { this.calls.push("refresh"); }
  async cleanup(): Promise<void> { this.calls.push("cleanup"); }
  dispose(): void { this.calls.push("dispose"); }
  setDraft(text: string): void { this.calls.push(`draft:${text}`); }
  previousResult(): void { this.calls.push("previous"); }
  async submit(options: { forgot?: boolean } = {}): Promise<void> { this.calls.push(`submit:${JSON.stringify(options)}`); }
  async next(): Promise<void> { this.calls.push("next"); }
  async grade(grade: 3 | 4 | 5): Promise<void> { this.calls.push(`grade:${grade}`); }
  async correct(): Promise<void> { this.calls.push("correct"); }
  async undo(): Promise<void> { this.calls.push("undo"); }
  async retry(lane: "primary" | "stop" = "primary"): Promise<void> { this.calls.push(`retry:${lane}`); }
  async stop(reason: "stop" | "summary_home" = "stop"): Promise<void> { this.calls.push(`stop:${reason}`); }
  async start(): Promise<void> { this.calls.push("start"); }
}
const profile: Profile = { profile_id: id(1), role: "user", ui_language: "ru", dictionary_language: "ru", time_zone: "UTC",
  state_version: "5", access: { status: "admitted", version: "1", reason: null } };
function open(document = id(4), pair = profile.dictionary_language): OpenedAccess {
  const opened: OpenedClient = { status: "opened", client_instance_id: id(2), document_id: document, document_epoch: "1", proof_version: "1",
    profile: { ...profile, dictionary_language: pair }, session: null, compatibility: { compatible: true, contract_version: "1" } };
  return createOpenedAccess({ opened, token: "t", proof: "p", generation: 1, isLive: () => true, onDenied: () => {} });
}
const storage: AsyncStorage = { get: vi.fn(), set: vi.fn(), remove: vi.fn() };
const transport = { fetcher: vi.fn(), timeoutMs: 1, maxResponseBytes: 1 };
function setup(reseed: boolean, initial: Partial<Options> = {}) {
  const created: FakeController[] = [];
  const options: Options = { access: open(), storage, transport, newId: () => id(9), transitionMode: "normal", initialSessionId: id(3), ...initial };
  const ui = renderHook((props: Options) => useStudyDocument<Options, FakeController, string>(props, reseed ? props.initialSessionId : null,
    (current, seed, settings) => { const controller = new FakeController(reseed ? seed : current.initialSessionId, settings); created.push(controller); return controller; }),
  { initialProps: options });
  return { ...ui, created, options };
}
function visibility(initial: DocumentVisibilityState = "visible") {
  let state = initial;
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => state);
  return (next: DocumentVisibilityState) => act(() => { state = next; document.dispatchEvent(new Event("visibilitychange")); });
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("shared study document owner", () => {
  it("re-creates the owner for a new owner seed, but keeps it when the seed is read only at creation", () => {
    visibility();
    const written = setup(true);
    expect(written.result.current.state).toBe(`view:${id(3)}`);
    written.rerender({ ...written.options, initialSessionId: id(5) });
    expect(written.created.map(controller => controller.seed)).toEqual([id(3), id(5)]);
    expect(written.created[0].calls).toContain("dispose"); expect(written.result.current.state).toBe(`view:${id(5)}`);
    const learning = setup(false);
    learning.rerender({ ...learning.options, initialSessionId: id(5) });
    expect(learning.created.map(controller => controller.seed)).toEqual([id(3)]);
  });
  it("a new seed naming the session the owner leads keeps it; any other seed, document or pair re-creates it", () => {
    visibility();
    const created: FakeController[] = [];
    const options: Options = { access: open(), storage, transport, newId: () => id(9), transitionMode: "normal", initialSessionId: null };
    const ui = renderHook((props: Options) => useStudyDocument<Options, FakeController, string>(props, props.initialSessionId,
      (_current, seed, settings) => { const controller = new FakeController(seed, settings); created.push(controller); return controller; },
      (controller, seed) => controller.leads === seed), { initialProps: options });
    created[0].leads = id(3);
    ui.rerender({ ...options, initialSessionId: id(3) });
    expect(created).toHaveLength(1); expect(created[0].calls).not.toContain("dispose");
    expect(ui.result.current.state).toBe("view:null");
    // A seed going back to none, and another session, re-create the owner as before.
    ui.rerender({ ...options, initialSessionId: null });
    expect(created.map(controller => controller.seed)).toEqual([null, null]); expect(created[0].calls).toContain("dispose");
    ui.rerender({ ...options, initialSessionId: id(5) });
    expect(created.map(controller => controller.seed)).toEqual([null, null, id(5)]);
    // A led session never crosses into another document or pair: what the owner holds stays with it.
    created[2].leads = id(7);
    ui.rerender({ ...options, access: open(id(6)), initialSessionId: id(7) });
    expect(created.map(controller => controller.seed)).toEqual([null, null, id(5), id(7)]);
    created[3].leads = id(8);
    ui.rerender({ ...options, access: open(id(6), "uk"), initialSessionId: id(8) });
    expect(created.map(controller => controller.seed)).toEqual([null, null, id(5), id(7), id(8)]);
    expect(ui.result.current.state).toBe(`view:${id(8)}`);
  });
  it("forwards actions to the current owner and refreshes it once on mount", async () => {
    visibility();
    const f = setup(true), controller = f.created[0], actions = f.result.current.actions;
    actions.setDraft("Haus"); await actions.submit({ forgot: true }); await actions.grade(5); await actions.retry("stop");
    await actions.stop("summary_home");
    expect(controller.calls).toEqual(["refresh", "draft:Haus", 'submit:{"forgot":true}', "grade:5", "retry:stop", "stop:summary_home"]);
    f.rerender({ ...f.options });
    expect(f.result.current.actions).toBe(actions);
  });
  it("background suspends the owner; only a new open handle in the foreground resumes it and allows a start", async () => {
    const set = visibility();
    const f = setup(true), controller = f.created[0];
    set("hidden"); expect(controller.calls).toContain("suspend");
    await act(async () => { await f.result.current.start(owner => owner.start()); });
    expect(controller.calls).not.toContain("start");
    set("visible");
    await act(async () => { await f.result.current.start(owner => owner.start()); });
    expect(controller.calls).not.toContain("start");
    // The foreground supplies a new handle of the same opened document (same key).
    const access = open();
    f.rerender({ ...f.options, access });
    expect(controller.calls).toContain("resume");
    await act(async () => { await f.result.current.start(owner => owner.start()); });
    expect(controller.calls.at(-1)).toBe("start");
    expect(f.created).toHaveLength(1);
  });
  it("a disabled owner stays mounted, suspended, and starts nothing", async () => {
    visibility();
    const f = setup(true, { enabled: false }), controller = f.created[0];
    // A disabled route stops the view only: automatic recovery of the visible window goes on (Я15.7, RESULTS_VP 9.1.5).
    expect(controller.calls).toEqual(["suspend:disabled", "refresh", "suspend:disabled"]);
    expect(controller.settings.enabled()).toBe(false);
    await act(async () => { await f.result.current.start(owner => owner.start()); });
    expect(controller.calls).not.toContain("start");
    f.rerender({ ...f.options, enabled: true });
    expect(controller.calls).toContain("resume");
  });
});
