import { afterEach, describe, expect, it, vi } from "vitest";
import { deferred, fixture, id, profile, response } from "../learning/learningFixtures.test-support";
import { settingsResponse } from "./settingsRead.test-support";
import { SettingsReadController, type SettingsReadState } from "./settingsReadController";
import { testGate } from "../commands/testGate.test-support";

function settings(version = "3") {
  const value = settingsResponse(); value.state_version = version;
  for (const field of Object.values(value.settings)) field.version = "1";
  value.settings.dictionary_language.value = "ru";
  return value;
}
const readers: SettingsReadController[] = [];
afterEach(() => { for (const reader of readers.splice(0)) reader.dispose(); });
function setup() {
  const f = fixture(); let minimum = "1";
  f.owner.dispose(); f.fetcher.mockImplementation(async () => response(settings()));
  const onUpdate = vi.fn<(state: SettingsReadState) => void>();
  const options = { access: f.access, transport: { fetcher: f.fetcher, timeoutMs: 1000, maxResponseBytes: 30000, gate: testGate() },
    minimumStateVersion: () => minimum, onUpdate };
  const reader = new SettingsReadController(options); readers.push(reader);
  return { ...f, reader, options, onUpdate, floor: (value: string) => { minimum = value; } };
}

describe("confirmed Settings read outside the editor", () => {
  it.each(["normal", "accelerated", null] as const)("preserves transition mode %s without a fallback or setup guess", async mode => {
    const f = setup(), value = settings(); value.settings.transition_mode.value = mode;
    value.settings.material.value = { mode: "level", selected_level: "A1" }; value.needs_setup = false;
    f.fetcher.mockResolvedValueOnce(response(value)); await f.reader.refresh();
    expect(f.reader.snapshot()).toEqual({ kind: "ready", data: value });
    expect(f.fetcher).toHaveBeenCalledExactlyOnceWith("/api/v1/settings", expect.objectContaining({ method: "GET",
      headers: expect.objectContaining({ Authorization: "Bearer synthetic-token" }) }));
    expect(f.newId).not.toHaveBeenCalled(); expect(f.storage.get).not.toHaveBeenCalled();
    expect(f.storage.set).not.toHaveBeenCalled(); expect(f.storage.remove).not.toHaveBeenCalled();
  });
  it.each(["invalid_mode", "invalid_version"])("rejects %s without publishing an invented preference", async kind => {
    const f = setup(), value = settings();
    if (kind === "invalid_version") value.state_version = "no-version";
    else Object.assign(value.settings.transition_mode, { value: "fast" });
    f.fetcher.mockResolvedValueOnce(response(value)); await f.reader.refresh();
    expect(f.reader.snapshot()).toEqual({ kind: "failed" });
    expect(f.onUpdate.mock.calls.some(([state]) => state.kind === "ready")).toBe(false);
  });
  it("coalesces calls against the same handle and required version", async () => {
    const f = setup(), gate = deferred<Response>(); f.fetcher.mockReturnValueOnce(gate.promise);
    const first = f.reader.refresh(), second = f.reader.refresh(); expect(second).toBe(first);
    gate.resolve(response(settings())); await first; expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it.each([false, true])("new access wins over a late old response (refused=%s)", async refused => {
    const f = setup(), gate = deferred<Response>(); f.fetcher.mockReturnValueOnce(gate.promise);
    const first = f.reader.refresh(); f.replace({}, "new-synthetic-token");
    expect(f.reader.snapshot()).toEqual({ kind: "loading" });
    const value = settings("5"); value.settings.transition_mode.value = "accelerated";
    f.fetcher.mockResolvedValueOnce(response(value)); await f.reader.refresh();
    const updates = f.onUpdate.mock.calls.length;
    gate.resolve(refused ? response({ error: { code: "FORBIDDEN" } }, 403) : response(settings("4"))); await first;
    expect(f.reader.snapshot()).toEqual({ kind: "ready", data: value }); expect(f.onUpdate).toHaveBeenCalledTimes(updates);
    expect(f.onDenied).not.toHaveBeenCalled();
    expect(new Headers(f.fetcher.mock.calls[1][1]?.headers).get("Authorization")).toBe("Bearer new-synthetic-token");
  });
  it("a higher same-document floor starts a fresh read without waiting for old data", async () => {
    const f = setup(), gate = deferred<Response>(); f.fetcher.mockReturnValueOnce(gate.promise);
    const first = f.reader.refresh(); f.floor("9");
    f.fetcher.mockResolvedValueOnce(response(settings("9"))); await f.reader.refresh();
    expect(f.reader.snapshot()).toEqual({ kind: "ready", data: settings("9") });
    gate.resolve(response(settings("8"))); await first;
    expect(f.reader.snapshot()).toEqual({ kind: "ready", data: settings("9") }); expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it("a subscriber requesting a newer floor during loading cannot strand the fresh read", async () => {
    const f = setup(), gate = deferred<Response>();
    f.fetcher.mockReturnValueOnce(gate.promise).mockResolvedValueOnce(response(settings("9")));
    let raised = false, latest: Promise<void> | null = null;
    f.onUpdate.mockImplementation(state => {
      if (state.kind === "loading" && !raised) { raised = true; f.floor("9"); latest = f.reader.refresh(); }
    });
    const old = f.reader.refresh();
    await vi.waitFor(() => expect(f.reader.snapshot().kind).toBe("ready"));
    gate.resolve(response(settings("8"))); await old; await latest;
    expect(f.reader.snapshot()).toEqual({ kind: "ready", data: settings("9") }); expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it("a floor advanced without another refresh still prevents publishing its old in-flight response", async () => {
    const f = setup(), gate = deferred<Response>(); f.fetcher.mockReturnValueOnce(gate.promise);
    const reading = f.reader.refresh(); f.floor("9"); gate.resolve(response(settings("8"))); await reading;
    expect(f.reader.snapshot()).toEqual({ kind: "failed" }); expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it("hides a cached setting as soon as a newer confirmed version is observed", async () => {
    const f = setup(); await f.reader.refresh(); f.floor("4");
    expect(f.reader.snapshot()).toEqual({ kind: "loading" }); expect(f.fetcher).toHaveBeenCalledOnce();
    f.floor("1"); expect(f.reader.snapshot()).toEqual({ kind: "loading" });
    f.fetcher.mockResolvedValueOnce(response(settings("4"))); await f.reader.refresh();
    expect(f.reader.snapshot()).toEqual({ kind: "ready", data: settings("4") });
  });
  it("checks both opened and shared versions without rounding large integers", async () => {
    const f = setup(); f.replace({ profile: profile("9007199254740995") });
    f.floor("9007199254740996"); f.fetcher.mockResolvedValueOnce(response(settings("9007199254740995")));
    await f.reader.refresh(); expect(f.reader.snapshot()).toEqual({ kind: "failed" });
    f.fetcher.mockResolvedValueOnce(response(settings("9007199254740996"))); await f.reader.refresh();
    expect(f.reader.snapshot()).toEqual({ kind: "ready", data: settings("9007199254740996") });
  });
  it.each(["dispose", "revoke", "document", "profile"])("%s invalidates in-flight and retained data without further reads", async change => {
    const f = setup(), gate = deferred<Response>(); f.fetcher.mockReturnValueOnce(gate.promise);
    const reading = f.reader.refresh();
    if (change === "dispose") f.reader.dispose();
    else if (change === "revoke") f.revoke();
    else if (change === "document") f.replace({ document_id: id(91) });
    else f.replace({ profile: { ...profile(), profile_id: id(92) } });
    const updates = f.onUpdate.mock.calls.length;
    gate.resolve(response(settings())); await reading; await f.reader.refresh();
    expect(f.reader.snapshot()).toEqual({ kind: "disposed" }); expect(f.onUpdate).toHaveBeenCalledTimes(updates);
    expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it("cannot create a reader for an invalid access", () => {
    const f = setup(); f.revoke(); expect(() => new SettingsReadController(f.options)).toThrow("closed_access");
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("a refusal for the current handle revokes it, whereas a transient error permits explicit retry", async () => {
    const f = setup(); f.fetcher.mockRejectedValueOnce(new Error("offline")); await f.reader.refresh();
    expect(f.reader.snapshot()).toEqual({ kind: "failed" }); expect(f.fetcher).toHaveBeenCalledOnce();
    await f.reader.refresh(); expect(f.reader.snapshot().kind).toBe("ready");
    f.fetcher.mockResolvedValueOnce(response({ error: { code: "EXPIRED" } }, 401)); await f.reader.refresh();
    expect(f.onDenied).toHaveBeenCalledOnce(); expect(f.reader.snapshot()).toEqual({ kind: "disposed" });
  });
  it("publishes independent copies and no credentials or pending-command assertions", async () => {
    const f = setup(); f.values.set("wortly.pending.setting", "synthetic unresolved setting");
    await f.reader.refresh(); const first = f.reader.snapshot();
    if (first.kind !== "ready") throw new Error("expected ready"); first.data.settings.transition_mode.value = "normal";
    const emitted = f.onUpdate.mock.calls.at(-1)![0];
    if (emitted.kind !== "ready") throw new Error("expected ready callback"); emitted.data.settings.retry_gap.value = 987;
    expect(f.reader.snapshot()).toEqual({ kind: "ready", data: settings() });
    expect(JSON.stringify(f.reader.snapshot())).not.toMatch(/synthetic-token|synthetic-proof/);
    expect(f.values.get("wortly.pending.setting")).toBe("synthetic unresolved setting");
    expect(f.storage.get).not.toHaveBeenCalled(); expect(f.storage.remove).not.toHaveBeenCalled();
  });
});
