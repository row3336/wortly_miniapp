import { describe, expect, it, vi } from "vitest";
import type { Profile, TodayResponse } from "../api/generated";
import { ApiError } from "../api/http";
import { createBusyAccess } from "./busyAccess";
import { ClosedAccessError } from "./openedAccess";

const profile: Profile = { profile_id: "00000000-0000-4000-8000-000000000001", role: "user",
  ui_language: "ru", dictionary_language: "ru", time_zone: "UTC", state_version: "2",
  access: { status: "admitted", version: "1", reason: null } };
const today: TodayResponse = { state_version: "3", pair: "ru-de", local_date: "2026-09-30", status: "no_material",
  base: { total: 0, words: 0, phrases: 0 }, ordinary_status: "done",
  ordinary: { words: { "l1-de": { ready: 0, next_due_date: null }, "de-l1": { ready: 0, next_due_date: null } },
    phrases: { "l1-de": { ready: 0, next_due_date: null }, "de-l1": { ready: 0, next_due_date: null } } },
  learning: { status: "no_material", ready: 0, preview: 0, next_due_at: null,
    new_group_size: 0, manual_eligible: 0, automatic_eligible: 0 },
  conjugation: { ready: 0, openable: 0, next_due_date: null }, next_repeat_date: null };
function fixture() {
  const state = { live: true };
  const get = vi.fn(async () => today), denied = vi.fn();
  const access = createBusyAccess({ key: "synthetic-busy", profile, token: "synthetic-token", api: { get },
    isLive: () => state.live, onDenied: denied });
  return { access, get, denied, state };
}
describe("aggregate-only busy access", () => {
  it("exposes only detached metadata and a specific read, not credentials or a document", async () => {
    const f = fixture();
    expect(await f.access.readToday()).toEqual(today);
    expect(f.get).toHaveBeenCalledWith("synthetic-token");
    expect(Object.keys(f.access).sort()).toEqual(["isLive", "key", "profile", "readToday"]);
    expect(JSON.stringify(f.access)).not.toContain("synthetic-token");
    f.access.profile.dictionary_language = "en";
    expect(f.access.profile.dictionary_language).toBe("ru");
    expect(Object.isFrozen(f.access)).toBe(true);
  });
  it("cannot start a read after losing access", async () => {
    const f = fixture(); f.state.live = false;
    await expect(f.access.readToday()).rejects.toBeInstanceOf(ClosedAccessError);
    expect(f.get).not.toHaveBeenCalled();
  });
  it.each(["success", "refusal"])("ignores a late %s after access is replaced", async result => {
    const f = fixture(); let resolve!: (value: TodayResponse) => void, reject!: (error: Error) => void;
    f.get.mockImplementationOnce(() => new Promise((yes, no) => { resolve = yes; reject = no; }));
    const pending = f.access.readToday();
    const assertion = expect(pending).rejects.toBeInstanceOf(ClosedAccessError);
    f.state.live = false;
    if (result === "success") resolve(today); else reject(new ApiError("http", 401));
    await assertion; expect(f.denied).not.toHaveBeenCalled();
  });
  it.each([401, 403])("revokes current access on HTTP%s", async status => {
    const f = fixture(), error = new ApiError("http", status); f.get.mockRejectedValueOnce(error);
    await expect(f.access.readToday()).rejects.toBe(error);
    expect(f.denied).toHaveBeenCalledExactlyOnceWith(error);
  });
  it.each([{ pair: "en-de" as const }, { state_version: "1" }])("rejects mismatched pair or old state: %j", async change => {
    const f = fixture(); f.get.mockResolvedValueOnce({ ...today, ...change });
    await expect(f.access.readToday()).rejects.toMatchObject({ kind: "invalid_response" });
    expect(f.denied).not.toHaveBeenCalled();
  });
  it("retains the aggregate version floor without changing the cached profile metadata", async () => {
    const f = fixture(); await f.access.readToday();
    f.get.mockResolvedValueOnce({ ...today, state_version: "2" });
    await expect(f.access.readToday()).rejects.toMatchObject({ kind: "invalid_response" });
    expect(f.access.profile.state_version).toBe("2");
  });
  it("inherits the floor from a replaced handle and only observes accepted reads", async () => {
    const onRead = vi.fn();
    const api = { get: vi.fn(async () => today) };
    const access = createBusyAccess({ key: "new-busy", profile, token: "synthetic", api, minimumVersion: "4",
      onRead, isLive: () => true, onDenied: vi.fn() });
    await expect(access.readToday()).rejects.toMatchObject({ kind: "invalid_response" });
    expect(onRead).not.toHaveBeenCalled();
    api.get.mockResolvedValueOnce({ ...today, state_version: "4" });
    await access.readToday(); expect(onRead).toHaveBeenCalledExactlyOnceWith("4");
    expect(access.profile.state_version).toBe("2");
  });
});
