import { StrictMode, useLayoutEffect, type PropsWithChildren } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SettingCommand, SettingsResetCommand, SettingsResponse } from "../api/generated";
import type { EditableSettingIntent, SettingIntent, SettingKey } from "./settingsApi";
import { deferred, fixture, id, profile, response } from "../learning/learningFixtures.test-support";
import { SettingsPendingStore, type SettingsPending } from "./settingsPending";
import { settingsResponse } from "./settingsRead.test-support";
import { useSettingsDocument, type SettingsDocument } from "./useSettingsDocument";
import { testGate } from "../commands/testGate.test-support";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const slot = `wortly.pending.setting:profile:${id(50)}`;
const intent: EditableSettingIntent = { command_id: id(100), kind: "setting.save", expected_field_version: "1",
  payload: { key: "retry_count", value: 4 } };
const pending: SettingsPending = { schemaVersion: 1, profileId: id(50), clientInstanceId: id(1), intent };
type Options = Parameters<typeof useSettingsDocument>[0];
function setup(saved?: "accepted" | "missing" | "invalid", strict = false, before?: (f: ReturnType<typeof fixture>) => void,
  probe?: (document: SettingsDocument) => void) {
  const f = fixture(); f.owner.dispose();
  const data = settingsResponse(); data.state_version = "1";
  for (const field of Object.values(data.settings)) field.version = "1";
  data.settings.dictionary_language.value = "ru";
  const facts = new Map<string, SettingIntent>();
  const apply = (request: SettingIntent) => {
    facts.set(request.command_id, request); data.state_version = String(BigInt(data.state_version) + 1n);
    Object.assign(data.settings[request.payload.key as SettingKey], { value: request.payload.value,
      version: String(BigInt(request.expected_field_version) + 1n) });
  };
  if (saved) f.values.set(slot, saved === "invalid" ? "broken" : JSON.stringify(pending));
  if (saved === "accepted") apply(intent);
  const accepted = (request: SettingIntent, status: "applied" | "already_applied") => {
    const { state_version, ...current } = structuredClone(data);
    return response({ command: { id: request.command_id, kind: "setting.save", status,
      applied_at: "2026-09-30T00:00:00Z", target_id: id(50), action_id: null, result_id: null, context_id: null,
      object_version: String(BigInt(request.expected_field_version) + 1n) }, current, state_version });
  };
  const get = vi.fn(async () => response(data));
  const status = vi.fn(async (commandId: string) => {
    const fact = facts.get(commandId);
    return fact ? accepted(fact, "already_applied") : response({ command: { id: commandId, status: "not_found" },
      current: profile(data.state_version), state_version: data.state_version });
  });
  const post = vi.fn(async (command: SettingCommand) => { apply(command); return accepted(command, "applied"); });
  f.fetcher.mockImplementation(async (url, init) => {
    const path = String(url);
    if (path.endsWith("/settings")) return get();
    if (path.includes("/commands/")) return status(path.split("/").at(-1)!.split("?")[0]);
    if (path.endsWith("/commands")) return post(JSON.parse(String(init?.body)));
    throw new Error("Unexpected endpoint");
  });
  before?.(f);
  const options: Options = { access: f.access(), transport: { fetcher: f.fetcher, timeoutMs: 30000, maxResponseBytes: 50000, gate: testGate() },
    pendingStore: new SettingsPendingStore(f.storage), onCurrent: vi.fn() };
  const wrapper = strict ? ({ children }: PropsWithChildren) => <StrictMode>{children}</StrictMode> : undefined;
  const ui = renderHook((props: Options) => {
    const document = useSettingsDocument(props);
    useLayoutEffect(() => { probe?.(document); }, [document]);
    return document;
  }, { initialProps: options, wrapper });
  return { f, data, get, status, post, apply, accepted, options, ...ui };
}

describe("application-owned settings for study and the editor", () => {
  it("reads without mounting an editor and preserves unset preferences", async () => {
    const { f, result, get, post } = setup(undefined, true);
    await waitFor(() => expect(result.current.confirmed).not.toBeNull());
    expect(result.current.confirmed?.settings.transition_mode.value).toBeNull();
    expect(result.current.confirmed?.needs_setup).toBe(true);
    expect(get).toHaveBeenCalledOnce(); expect(post).not.toHaveBeenCalled();
    expect(f.fetcher.mock.calls.map(call => String(call[0]))).toEqual(["/api/v1/settings"]);
  });
  it("does not expose confirmed settings until local recovery and the first read finish", async () => {
    const gate = deferred<string | null>();
    const { result, get } = setup(undefined, false, f => { vi.spyOn(f.storage, "get").mockReturnValueOnce(gate.promise); });
    expect(result.current.confirmed).toBeNull(); expect(get).not.toHaveBeenCalled();
    await act(async () => gate.resolve(null)); await waitFor(() => expect(result.current.confirmed).not.toBeNull());
  });
  it("resolves a saved accepted command before the editor opens without sending it again", async () => {
    const { f, result, status, post, get } = setup("accepted", true);
    await waitFor(() => expect(result.current.confirmed?.settings.retry_count.value).toBe(4));
    expect(status).toHaveBeenCalledOnce(); expect(post).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled();
    expect(result.current.state.pending).toBeNull(); expect(f.values.has(slot)).toBe(false);
  });
  it("keeps a not-found command unresolved until explicit retry of its exact intent", async () => {
    const { result, post, f } = setup("missing");
    await waitFor(() => expect(result.current.state.canRetry).toBe(true));
    expect(result.current.state.dataCurrent).toBe(true); expect(result.current.confirmed).toBeNull();
    expect(post).not.toHaveBeenCalled(); expect(f.values.has(slot)).toBe(true);
    await act(() => result.current.actions.retry());
    expect(post).toHaveBeenCalledOnce(); expect(post.mock.calls[0][0]).toMatchObject(intent);
    expect(result.current.confirmed?.settings.retry_count.value).toBe(4); expect(f.values.has(slot)).toBe(false);
  });
  it("a corrupt pending record never becomes a confirmed setting or a replacement command", async () => {
    const { result, f, post, get } = setup("invalid");
    await waitFor(() => expect(result.current.state.problem?.reason).toBe("invalid_pending"));
    expect(result.current.confirmed).toBeNull(); expect(post).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled();
    expect(f.values.get(slot)).toBe("broken");
  });
  it("publishes an accepted current after cleanup failure but cannot configure study until cleanup succeeds", async () => {
    const { result, options, post, f } = setup("accepted", false, f => {
      vi.spyOn(f.storage, "remove").mockRejectedValueOnce(new Error("local failure"));
    });
    await waitFor(() => expect(result.current.state.problem?.reason).toBe("storage"));
    expect(result.current.state.outcome?.status).toBe("accepted"); expect(result.current.confirmed).toBeNull();
    expect(options.onCurrent).toHaveBeenCalledWith(expect.objectContaining({ version: "2" }));
    await act(() => result.current.actions.refresh());
    expect(result.current.confirmed?.settings.retry_count.value).toBe(4); expect(f.values.has(slot)).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });
  it("retains one action owner and an unsent draft across foreground reads", async () => {
    const { result, options, rerender, f, data, get, post } = setup();
    await waitFor(() => expect(result.current.confirmed).not.toBeNull());
    const actions = result.current.actions; act(() => actions.edit("retry_count", "8"));
    const gate = deferred<Response>(); get.mockReturnValueOnce(gate.promise);
    f.replace(); rerender({ ...options, access: f.access() });
    expect(result.current.confirmed).toBeNull(); expect(result.current.actions).toBe(actions);
    expect(result.current.state.canEdit).toBe(false); expect(result.current.state.drafts.retry_count?.input).toBe("8");
    await act(() => actions.save("retry_count")); expect(post).not.toHaveBeenCalled();
    await act(async () => gate.resolve(response(data)));
    await waitFor(() => expect(result.current.confirmed).not.toBeNull());
    expect(result.current.state.drafts.retry_count?.input).toBe("8");
  });
  it("never publishes or configures study from a read below a new shared floor", async () => {
    const { result, options, rerender, data, get } = setup();
    await waitFor(() => expect(result.current.confirmed).not.toBeNull());
    vi.mocked(options.onCurrent).mockClear(); rerender({ ...options, minimumStateVersion: "9" });
    expect(result.current.confirmed).toBeNull();
    await waitFor(() => expect(result.current.state.problem?.reason).toBe("stale_response"));
    expect(options.onCurrent).not.toHaveBeenCalled(); expect(result.current.confirmed).toBeNull();
    data.state_version = "9"; await act(() => result.current.actions.refresh());
    expect(result.current.confirmed?.state_version).toBe("9");
    rerender({ ...options, minimumStateVersion: "8" }); await act(async () => {});
    expect(get).toHaveBeenCalledTimes(3); expect(result.current.confirmed?.state_version).toBe("9");
  });
  it("a new foreground handle closes readiness and retained editing rights before passive effects", async () => {
    let inspect = false, observed = false;
    const { result, f, options, rerender, post } = setup(undefined, false, undefined, document => {
      if (!inspect) return;
      inspect = false; observed = true;
      expect(document.confirmed).toBeNull(); expect(document.state.canEdit).toBe(false);
      document.actions.edit("retry_count", "9"); void document.actions.save("retry_count");
    });
    await waitFor(() => expect(result.current.confirmed).not.toBeNull());
    act(() => result.current.actions.edit("retry_count", "8"));
    f.replace(); inspect = true; rerender({ ...options, access: f.access() });
    await waitFor(() => expect(result.current.confirmed).not.toBeNull());
    expect(observed).toBe(true); expect(result.current.state.drafts.retry_count?.input).toBe("8");
    expect(post).not.toHaveBeenCalled();
  });
  it("a retained retry cannot post through a new handle before its recovery read", async () => {
    let inspect = false;
    const { result, f, options, rerender, post, status } = setup("missing", false, undefined, document => {
      if (!inspect) return;
      inspect = false; expect(document.state.canRetry).toBe(false); void document.actions.retry();
    });
    await waitFor(() => expect(result.current.state.canRetry).toBe(true));
    const read = deferred<Response>(); status.mockReturnValueOnce(read.promise);
    f.replace(); inspect = true; rerender({ ...options, access: f.access() });
    await waitFor(() => expect(status).toHaveBeenCalledTimes(2));
    expect(post).not.toHaveBeenCalled(); expect(result.current.confirmed).toBeNull();
    await act(async () => read.resolve(response({ command: { id: intent.command_id, status: "not_found" },
      current: profile(), state_version: "1" })));
    await waitFor(() => expect(result.current.state.canRetry).toBe(true));
    await act(() => result.current.actions.retry()); expect(post).toHaveBeenCalledOnce();
  });
  it("a failed status read retains the owner's explicit exact retry without claiming confirmed data", async () => {
    const { result, post, status } = setup("missing");
    status.mockRejectedValueOnce(new Error("network"));
    await waitFor(() => expect(result.current.state.canRetry).toBe(true));
    expect(result.current.confirmed).toBeNull(); expect(result.current.state.data).toBeNull();
    expect(post).not.toHaveBeenCalled(); await act(() => result.current.actions.retry());
    expect(post.mock.calls[0][0]).toMatchObject(intent); expect(result.current.confirmed).not.toBeNull();
  });
  it("a save response cannot reopen readiness while a new foreground handle still needs recovery", async () => {
    const { result, f, options, rerender, post, apply, accepted, status } = setup();
    await waitFor(() => expect(result.current.confirmed).not.toBeNull());
    act(() => result.current.actions.edit("retry_count", "8"));
    const send = deferred<Response>(); post.mockReturnValueOnce(send.promise);
    let saving!: Promise<void>; act(() => { saving = result.current.actions.save("retry_count"); });
    await waitFor(() => expect(post).toHaveBeenCalledOnce()); const command = post.mock.calls[0][0]; apply(command);
    const recovering = deferred<Response>(); status.mockReturnValueOnce(recovering.promise);
    f.replace(); rerender({ ...options, access: f.access() });
    await act(async () => { send.resolve(accepted(command, "applied")); await saving; });
    await waitFor(() => expect(status).toHaveBeenCalledOnce()); expect(result.current.confirmed).toBeNull();
    await act(async () => recovering.resolve(accepted(command, "already_applied")));
    await waitFor(() => expect(result.current.confirmed?.settings.retry_count.value).toBe(8));
    expect(post).toHaveBeenCalledOnce(); expect(f.values.has(slot)).toBe(false);
  });
  it("revocation removes confirmed data and retained actions cannot mutate", async () => {
    const { result, f, options, rerender, post } = setup();
    await waitFor(() => expect(result.current.confirmed).not.toBeNull());
    const actions = result.current.actions; act(() => actions.edit("retry_count", "8"));
    f.revoke(); rerender(options);
    expect(result.current.confirmed).toBeNull(); expect(result.current.state.data).toBeNull();
    await act(() => actions.save("retry_count")); expect(post).not.toHaveBeenCalled();
  });
  it("a different document discards editor drafts and a late read cannot publish to it", async () => {
    const { result, f, options, rerender, get, data } = setup();
    await waitFor(() => expect(result.current.confirmed).not.toBeNull());
    act(() => result.current.actions.edit("retry_count", "8"));
    const old = deferred<Response>(); get.mockReturnValueOnce(old.promise);
    let reading!: Promise<void>; act(() => { reading = result.current.actions.refresh(); });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    f.replace({ document_id: id(99) }); rerender({ ...options, access: f.access() });
    await waitFor(() => expect(result.current.confirmed).not.toBeNull());
    expect(result.current.state.drafts).toEqual({}); vi.mocked(options.onCurrent).mockClear();
    await act(async () => { old.resolve(response(data)); await reading; });
    expect(options.onCurrent).not.toHaveBeenCalled(); expect(result.current.state.drafts).toEqual({});
  });
  it("returned projections cannot mutate the owner's confirmed configuration", async () => {
    const { result, rerender, options } = setup();
    await waitFor(() => expect(result.current.confirmed).not.toBeNull());
    result.current.confirmed!.settings.transition_mode.value = "accelerated";
    rerender(options); expect(result.current.confirmed?.settings.transition_mode.value).toBeNull();
  });
});

describe("settings reset through the document owner (M-SET-RESET, D-SET-RESET 4.3.4, 5.3.7)", () => {
  const resetSlot = `wortly.pending.settings-reset:profile:${id(50)}`;
  const resetPending = { schemaVersion: 1, profileId: id(50), clientInstanceId: id(1),
    intent: { command_id: id(100), kind: "settings.reset", payload: {} } };
  /** The server side of a reset: retry_count returns to 4 and the reply carries the full current settings. */
  function resetOn(data: SettingsResponse) {
    return async (command: SettingsResetCommand) => {
      data.state_version = String(BigInt(data.state_version) + 1n);
      data.settings.retry_count = { value: 4, version: String(BigInt(data.settings.retry_count.version) + 1n) };
      const { state_version, ...current } = structuredClone(data);
      return response({ command: { id: command.command_id, kind: "settings.reset", status: "applied",
        applied_at: "2026-10-08T00:00:00Z", target_id: id(50), action_id: null, result_id: null, context_id: null,
        object_version: "3" }, current, state_version });
    };
  }

  it("sends one reset, confirms the server's settings and discards only the reset fields' drafts", async () => {
    const { result, post, data, f } = setup();
    await waitFor(() => expect(result.current.state.canReset).toBe(true));
    act(() => { result.current.actions.edit("retry_count", "8"); result.current.actions.edit("ui_language", "en"); });
    post.mockImplementationOnce(resetOn(data) as never);
    await act(() => result.current.actions.reset());
    expect(post).toHaveBeenCalledOnce();
    expect(post.mock.calls[0][0]).toEqual({ command_id: expect.any(String), kind: "settings.reset", client_instance_id: id(1),
      document_id: expect.any(String), payload: { expected_reset_epoch: "1" } });
    expect(result.current.confirmed?.settings.retry_count.value).toBe(4);
    expect(result.current.state.resetOutcome?.status).toBe("accepted");
    expect(Object.keys(result.current.state.drafts)).toEqual(["ui_language"]);
    expect(f.values.has(resetSlot)).toBe(false);
  });

  it("a new foreground handle withholds the reset until its recovery read", async () => {
    let inspect = false, observed = false;
    const { result, f, options, rerender, post } = setup(undefined, false, undefined, document => {
      if (!inspect) return;
      inspect = false; observed = true;
      expect(document.state.canReset).toBe(false); void document.actions.reset();
    });
    await waitFor(() => expect(result.current.confirmed).not.toBeNull());
    f.replace(); inspect = true; rerender({ ...options, access: f.access() });
    await waitFor(() => expect(result.current.confirmed).not.toBeNull());
    expect(observed).toBe(true); expect(post).not.toHaveBeenCalled(); expect(f.values.has(resetSlot)).toBe(false);
  });

  it("an unconfirmed reset of an earlier build withholds confirmed settings, is checked by its ID; not found, the client cancels it (R16-01)", async () => {
    const cancelling = deferred<Response>();
    const { result, post, status, data, f } = setup(undefined, false, f => { f.values.set(resetSlot, JSON.stringify(resetPending)); });
    post.mockImplementationOnce((() => cancelling.promise) as never);
    await waitFor(() => expect(post).toHaveBeenCalledOnce());
    expect(status).toHaveBeenCalledExactlyOnceWith(id(100));
    expect(post.mock.calls[0][0]).toEqual({ command_id: expect.any(String), kind: "settings.reset_cancel", client_instance_id: id(1),
      document_id: expect.any(String), payload: { target_command_id: id(100) } });
    expect(result.current.confirmed).toBeNull(); expect(result.current.state).toMatchObject({ canReset: false, canRetry: false });
    const { state_version, ...current } = structuredClone(data);
    const cancelId = (post.mock.calls[0][0] as unknown as { command_id: string }).command_id;
    await act(async () => cancelling.resolve(response({ command: { id: cancelId, kind: "settings.reset_cancel", status: "applied",
      applied_at: "2026-10-16T00:00:00Z", target_id: id(100), action_id: null, result_id: null, context_id: null, object_version: null },
    current: { ...current, reset_target: { command_id: id(100), outcome: "cancelled" } }, state_version })));
    await waitFor(() => expect(result.current.confirmed).not.toBeNull());
    expect(result.current.state.resetOutcome).toMatchObject({ commandId: id(100), status: "rejected", code: "RESET_CANCELLED" });
    expect(f.values.has(resetSlot)).toBe(false); expect(post).toHaveBeenCalledOnce();
  });
});
