import { StrictMode, type PropsWithChildren } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { id } from "../learning/learningFixtures.test-support";
import { FeedbackPendingStore } from "./feedbackPending";
import { feedbackWorld, pendingRecord, slot, TEXT, type Fate } from "./feedbackFixtures.test-support";
import { useFeedbackDocument } from "./useFeedbackDocument";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
type Options = Parameters<typeof useFeedbackDocument>[0];
function setup(fates: Fate[] = [], saved?: string, strict = false) {
  const world = feedbackWorld(fates);
  if (saved) world.f.values.set(slot, saved);
  const options: Options = { access: world.f.access(), transport: { fetcher: world.f.fetcher, timeoutMs: 30000, maxResponseBytes: 50000 },
    pendingStore: new FeedbackPendingStore(world.f.storage) };
  const wrapper = strict ? ({ children }: PropsWithChildren) => <StrictMode>{children}</StrictMode> : undefined;
  const ui = renderHook((props: Options) => useFeedbackDocument(props), { initialProps: options, wrapper });
  return { world, options, ...ui };
}

describe("application-owned message form", () => {
  it("reads storage once, makes no request without a stored intent, and then accepts text", async () => {
    const { world, result } = setup([], undefined, true);
    await waitFor(() => expect(result.current.state.phase).toBe("idle"));
    expect(world.f.fetcher).not.toHaveBeenCalled();
    act(() => result.current.actions.edit(TEXT));
    expect(result.current.state).toMatchObject({ text: TEXT, canSend: true });
    await act(() => result.current.actions.send());
    expect(result.current.state).toMatchObject({ confirmed: true, text: "" }); expect(world.posts).toHaveLength(1);
  });
  it("keeps the unsent text and the same owner across a foreground that replaces the access handle", async () => {
    const { world, options, result, rerender } = setup();
    await waitFor(() => expect(result.current.state.phase).toBe("idle"));
    const actions = result.current.actions; act(() => actions.edit(TEXT));
    world.f.replace(); rerender({ ...options, access: world.f.access() });
    expect(result.current.actions).toBe(actions); expect(result.current.state).toMatchObject({ text: TEXT, canSend: true });
    expect(world.f.fetcher).not.toHaveBeenCalled();
    await act(() => actions.send());
    expect(world.posts).toHaveLength(1); expect(result.current.state.confirmed).toBe(true);
  });
  it("after a failed send, a foreground checks the same command_id and does not send by itself", async () => {
    const { world, options, result, rerender } = setup(["lose-after"]);
    await waitFor(() => expect(result.current.state.phase).toBe("idle"));
    act(() => result.current.actions.edit(TEXT));
    await act(() => result.current.actions.send());
    expect(result.current.state).toMatchObject({ problem: "network", text: TEXT });
    world.f.replace(); rerender({ ...options, access: world.f.access() });
    await waitFor(() => expect(result.current.state.confirmed).toBe(true));
    expect(world.gets).toEqual([world.posts[0].command_id]); expect(world.posts).toHaveLength(1);
  });
  it("resolves a stored unconfirmed message when the document opens", async () => {
    const { world, result } = setup([], pendingRecord(id(300)));
    await waitFor(() => expect(result.current.state).toMatchObject({ phase: "unresolved", problem: "not_sent", text: TEXT }));
    expect(world.posts).toHaveLength(0);
    await act(() => result.current.actions.retry());
    expect(world.posts.map(post => post.command_id)).toEqual([id(300)]); expect(result.current.state.confirmed).toBe(true);
  });
  it("does not own a form for a document that is not admitted", async () => {
    const world = feedbackWorld();
    const access = world.f.access();
    const pending = { ...access, profile: { ...access.profile, access: { ...access.profile.access, status: "pending" as const } } };
    const { result } = renderHook(() => useFeedbackDocument({ access: pending as typeof access,
      transport: { fetcher: world.f.fetcher, timeoutMs: 1000, maxResponseBytes: 1000 }, pendingStore: new FeedbackPendingStore(world.f.storage) }));
    expect(result.current.state).toMatchObject({ phase: "loading", canSend: false, canEdit: false });
    await act(async () => { await result.current.actions.send(); });
    expect(world.posts).toHaveLength(0);
  });
});
