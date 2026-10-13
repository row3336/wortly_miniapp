// The owner seed under the React lifecycle (D-23 trace 5.4, C149): a seed proposed by a render that never commits
// (an interrupted transition) and the double render of StrictMode must neither address nor re-create the owner.
import { act, cleanup, render } from "@testing-library/react";
import { StrictMode, Suspense, startTransition, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenedClient, Profile } from "../api/generated";
import { createOpenedAccess, type OpenedAccess } from "../app/openedAccess";
import type { AsyncStorage } from "../platform/storage";
import { useStudyDocument, type StudyActions, type StudyDocumentOptions, type StudyViewSettings } from "./useStudyDocument";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
/** A recording controller; `leads` stands for the session it restored (e.g. a written receipt after a reload). */
class FakeController {
  calls: string[] = [];
  leads: string | null = null;
  constructor(readonly seed: string | null, readonly settings: StudyViewSettings<string>) {}
  snapshot(): string { return `view:${this.seed}:${this.leads}`; }
  suspend(): void { this.calls.push("suspend"); }
  async resume(): Promise<void> { this.calls.push("resume"); }
  resumeRecovery(): void {}
  async refresh(): Promise<void> { this.calls.push("refresh"); }
  async cleanup(): Promise<void> {}
  dispose(): void { this.calls.push("dispose"); }
  setDraft(text: string): void { this.calls.push(`draft:${text}`); }
  previousResult(): void {}
  async submit(): Promise<void> {}
  async next(): Promise<void> {}
  async grade(): Promise<void> {}
  async correct(): Promise<void> {}
  async undo(): Promise<void> {}
  async retry(): Promise<void> {}
  async stop(): Promise<void> {}
}
const baseProfile: Profile = { profile_id: id(1), role: "user", ui_language: "ru", dictionary_language: "ru", time_zone: "UTC",
  state_version: "5", access: { status: "admitted", version: "1", reason: null } };
function open(patch: { document?: string; profile?: string; pair?: Profile["dictionary_language"] } = {}): OpenedAccess {
  const opened: OpenedClient = { status: "opened", client_instance_id: id(2), document_id: patch.document ?? id(4), document_epoch: "1",
    proof_version: "1", profile: { ...baseProfile, profile_id: patch.profile ?? baseProfile.profile_id,
      dictionary_language: patch.pair ?? baseProfile.dictionary_language },
    session: null, compatibility: { compatible: true, contract_version: "1" } };
  return createOpenedAccess({ opened, token: "t", proof: "p", generation: 1, isLive: () => true, onDenied: () => {} });
}
const storage = (): AsyncStorage => ({ get: vi.fn(), set: vi.fn(), remove: vi.fn() });
const transport = () => ({ fetcher: vi.fn(), timeoutMs: 1, maxResponseBytes: 1 });
const never = new Promise<never>(() => {});

type Props = { seed: string | null; options: StudyDocumentOptions };
function harness(strict: boolean, blocked: string) {
  const created: FakeController[] = [], rendered: (string | null)[] = [], led: string[] = [];
  const states: (string | null)[] = [];
  const actions: { current: StudyActions | null } = { current: null };
  let set: (next: Props) => void = () => {};
  const first: Props = { seed: null, options: { access: open(), storage: storage(), transport: transport(), newId: () => id(9),
    transitionMode: "normal" } };
  function Owner({ seed, options }: Props) {
    rendered.push(seed);
    const document = useStudyDocument<StudyDocumentOptions, FakeController, string>(options, seed,
      (_current, value, settings) => { const controller = new FakeController(value, settings); created.push(controller); return controller; },
      (controller, value) => { led.push(value); return controller.leads === value; });
    states.push(document.state); actions.current = document.actions;
    return null;
  }
  /** Suspends the render of the blocked seed forever: its transition never commits. */
  function Gate({ seed }: { seed: string | null }): ReactNode { if (seed === blocked) throw never; return null; }
  function Root() {
    const [props, setProps] = useState(first);
    set = setProps;
    return <Suspense fallback={null}><Owner {...props} /><Gate seed={props.seed} /></Suspense>;
  }
  const ui = render(strict ? <StrictMode><Root /></StrictMode> : <Root />);
  const live = () => created.filter(controller => !controller.calls.includes("dispose"));
  return { ui, created, rendered, led, states, first, live, actions: () => actions.current!,
    commit: (next: Props) => act(() => { set(next); }),
    interrupt: (next: Props) => act(() => { startTransition(() => { set(next); }); }) };
}
beforeEach(() => { vi.spyOn(document, "visibilityState", "get").mockImplementation(() => "visible"); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

for (const strict of [false, true]) describe(`owner seed under the React lifecycle${strict ? " (StrictMode)" : ""}`, () => {
  it("a led seed proposed only by an interrupted render, then the old seed again, keeps the owner and its result", async () => {
    const S = id(3), h = harness(strict, S);
    const owner = h.live()[0]; owner.leads = S;
    const before = h.created.length;
    await h.interrupt({ ...h.first, seed: S });
    // The render with S really ran (and asked the mode), but never committed.
    expect(h.rendered).toContain(S); expect(h.led).toContain(S);
    await h.commit({ ...h.first, seed: null });
    expect(h.created).toHaveLength(before); expect(h.live()).toEqual([owner]);
    expect(h.states.at(-1)).toBe(`view:null:${S}`);
  });

  it("another seed proposed only by an interrupted render, then the old seed again, re-creates nothing", async () => {
    const S = id(5), h = harness(strict, S);
    const owner = h.live()[0]; owner.leads = id(3);
    const before = h.created.length;
    await h.interrupt({ ...h.first, seed: S });
    expect(h.rendered).toContain(S);
    await h.commit({ ...h.first, seed: null });
    expect(h.created).toHaveLength(before); expect(h.live()).toEqual([owner]);
  });

  it("a committed led seed only addresses the owner; then another seed or none re-creates it", async () => {
    const S = id(3), h = harness(strict, id(99));
    const owner = h.live()[0]; owner.leads = S;
    const before = h.created.length;
    await h.commit({ ...h.first, seed: S });
    expect(h.created).toHaveLength(before); expect(h.live()).toEqual([owner]);
    expect(h.states.at(-1)).toBe(`view:null:${S}`);
    // Taps reach the adopted owner: it is addressed by the new seed, not only shown.
    h.actions().setDraft("Haus"); expect(owner.calls).toContain("draft:Haus");
    await h.commit({ ...h.first, seed: id(5) });
    expect(h.live().map(controller => controller.seed)).toEqual([id(5)]); expect(owner.calls).toContain("dispose");
    await h.commit({ ...h.first, seed: null });
    expect(h.live().map(controller => controller.seed)).toEqual([null]);
  });

  it("a seed proposed before the owner knows its session (no receipt yet) re-creates the owner, as before", async () => {
    const S = id(3), h = harness(strict, id(99));
    const owner = h.live()[0];
    await h.commit({ ...h.first, seed: S });
    expect(h.live().map(controller => controller.seed)).toEqual([S]); expect(owner.calls).toContain("dispose");
  });

  for (const [label, change] of [
    ["profile", (props: Props) => ({ ...props.options, access: open({ profile: id(7) }) })],
    ["document", (props: Props) => ({ ...props.options, access: open({ document: id(6) }) })],
    ["pair", (props: Props) => ({ ...props.options, access: open({ pair: "uk" }) })],
    ["storage", (props: Props) => ({ ...props.options, storage: storage() })],
    ["transport", (props: Props) => ({ ...props.options, transport: transport() })],
  ] as const) it(`a led seed never carries the owner into another ${label}`, async () => {
    const S = id(3), h = harness(strict, id(99));
    const owner = h.live()[0]; owner.leads = S;
    const mark = h.states.length;
    await h.commit({ seed: S, options: change(h.first) });
    expect(owner.calls).toContain("dispose");
    // Not even one render shows the old owner's view under the new identity.
    expect(h.states.slice(mark)).not.toContain(`view:null:${S}`);
    expect(h.live().map(controller => controller.seed)).toEqual([S]);
    expect(h.live()[0]).not.toBe(owner);
  });

  it("a seed of a session the owner does not lead: no render shows the previous owner's view under it", async () => {
    const S = id(31), other = id(77), h = harness(strict, id(99));
    const owner = h.live()[0]; owner.leads = other;
    const mark = h.states.length;
    await h.commit({ ...h.first, seed: S });
    expect(owner.calls).toContain("dispose");
    expect(h.states.slice(mark).filter(state => state?.includes(`:${other}`))).toEqual([]);
    expect(h.live().map(controller => controller.seed)).toEqual([S]);
  });
});
