import { describe, expect, it, vi } from "vitest";
import type { AuthResponse, IncompatibleClient, OpenedClient, Profile } from "../api/generated";
import { EntryApiError } from "../api/entryApi";
import type { EntryApi } from "../api/entryApi";
import type { AsyncStorage } from "../platform/storage";
import type { DocumentLock } from "./documentLock";
import { EntryController } from "./entryController";
import type { EntryState } from "./entryState";
import { readInstallation } from "./installation";

// M-COMPAT-HDR: a client the core does not serve reads why, and a paused write is told from a network error.
const profileId = "11111111-1111-4111-8111-111111111111";
const instanceId = "22222222-2222-4222-8222-222222222222";
const registrationId = "33333333-3333-4333-8333-333333333333";
const documentId = "44444444-4444-4444-8444-444444444444";
const commandId = "55555555-5555-4555-8555-555555555555";

function profile(status: "admitted" | "rejected"): Profile {
  return { profile_id: profileId, access: { status, version: "3", reason: status === "rejected" ? "Review complete" : null },
    role: "user", ui_language: "ru", dictionary_language: "ru", time_zone: null, state_version: "9" };
}
const auth = (status: "admitted" | "rejected", compatible = true): AuthResponse => ({ access_token: "memory-token",
  expires_at: "2026-10-01T00:00:00Z", profile: profile(status), compatibility: { compatible, contract_version: "1" } });
const opened = (): OpenedClient => ({ status: "opened", client_instance_id: instanceId, document_id: documentId,
  document_epoch: "1", proof_version: "1", profile: profile("admitted"), session: null,
  compatibility: { compatible: true, contract_version: "1" } });
const incompatible = (patch: Partial<IncompatibleClient> = {}): IncompatibleClient => ({ status: "incompatible",
  client_instance_id: instanceId, profile: profile("admitted"), session: null,
  compatibility: { compatible: false, contract_version: "2" }, ...patch });

function fixture(status: "admitted" | "rejected" = "admitted", compatible = true) {
  const values = new Map<string, string>();
  const storage: AsyncStorage = {
    async get(key) { return values.get(key) ?? null; },
    async set(key, value) { values.set(key, value); },
    async remove(key) { values.delete(key); },
  };
  const states: EntryState[] = [];
  const profiles: (Profile | undefined)[] = [];
  const api: EntryApi = {
    auth: vi.fn(async () => auth(status, compatible)),
    reapply: vi.fn(async (_token, request) => ({
      command: { id: request.command_id, status: "applied" as const, applied_at: "2026-09-29T00:00:00Z", target_id: null, object_version: "4" },
      current: { ...profile("admitted"), access: { status: "pending" as const, version: "4", reason: null }, state_version: "10" },
    })),
    register: vi.fn(async () => ({ client_instance_id: instanceId, status: "registered" as const, origin_proof: "saved-proof", proof_version: "1", activated: false })),
    open: vi.fn(async () => opened()),
  };
  const lock: DocumentLock = { acquire: vi.fn(async () => ({ release: vi.fn() })) };
  const ids = [instanceId, registrationId, documentId, commandId];
  const controller = new EntryController({
    api, storage, lock, initData: "signed", savedLanguage: "ru", browserLanguage: "ru", clientVersion: "0.0.0",
    contractVersion: "1", timeZone: () => "Europe/Berlin", newId: () => ids.shift()!,
    onUpdate: ({ state, profile }) => { states.push(state); profiles.push(profile); },
  });
  return { controller, api, storage, values, states, profiles, lock };
}

describe("an incompatible client at sign-in", () => {
  it("shows the update state, not «unavailable», and opens nothing", async () => {
    const f = fixture("admitted", false);
    await f.controller.start();
    expect(f.states.at(-1)).toEqual({ kind: "incompatible" });
    expect(f.states.map(state => state.kind)).not.toContain("unavailable");
    expect(f.profiles.at(-1)?.profile_id).toBe(profileId);
    expect(f.api.register).not.toHaveBeenCalled();
    expect(f.api.open).not.toHaveBeenCalled();
    expect(f.controller.getOpenedAccess()).toBeNull();
    // Nothing of a document exists yet: no lock is claimed and no installation is written.
    expect(f.lock.acquire).not.toHaveBeenCalled();
    expect(await readInstallation(f.storage, profileId)).toBeNull();
    expect(f.values.size).toBe(0);
  });

  it("is not left by a foreground event: there is no document to refresh", async () => {
    const f = fixture("admitted", false);
    await f.controller.start(); await f.controller.foreground();
    expect(f.api.auth).toHaveBeenCalledOnce();
    expect(f.states.at(-1)).toEqual({ kind: "incompatible" });
  });
});

describe("an incompatible client at open", () => {
  it("reads the incompatible answer as its own state, never invalid_response/unavailable", async () => {
    const f = fixture();
    vi.mocked(f.api.open).mockResolvedValueOnce(incompatible());
    await f.controller.start();
    expect(f.states.at(-1)).toEqual({ kind: "incompatible" });
    expect(f.states.map(state => state.kind)).not.toContain("unavailable");
    expect(f.controller.getOpenedAccess()).toBeNull();
  });

  it("does not activate the installation, claim the document lock or present an open session", async () => {
    const f = fixture();
    vi.mocked(f.api.open).mockResolvedValueOnce(incompatible({ session: { id: "s", phase: "active" } }));
    await f.controller.start();
    expect((await readInstallation(f.storage, profileId))?.activated).toBe(false);
    expect(f.lock.acquire).not.toHaveBeenCalled();
    expect(f.controller.getOpenedAccess()).toBeNull();
    expect(f.controller.getBusyAccess()).toBeNull();
  });

  it("still reads an ordinary answer that says compatible=false as incompatible, not as a broken reply", async () => {
    const f = fixture();
    vi.mocked(f.api.open).mockResolvedValueOnce({ ...opened(), compatibility: { compatible: false, contract_version: "2" } });
    await f.controller.start();
    expect(f.states.at(-1)).toEqual({ kind: "incompatible" });
    expect((await readInstallation(f.storage, profileId))?.activated).toBe(false);
  });

  it("does not trust an incompatible answer for another installation", async () => {
    const f = fixture();
    vi.mocked(f.api.open).mockResolvedValueOnce(incompatible({ client_instance_id: "99999999-9999-4999-8999-999999999999" }));
    await f.controller.start();
    expect(f.states.at(-1)).toEqual({ kind: "unavailable" });
  });

  it("still refuses an incompatible answer carrying another profile", async () => {
    const f = fixture();
    vi.mocked(f.api.open).mockResolvedValueOnce(incompatible({ profile: { ...profile("admitted"), profile_id: "99999999-9999-4999-8999-999999999999" } }));
    await f.controller.start();
    expect(f.states.at(-1)).toEqual({ kind: "unavailable" });
  });
});

describe("a refused reapply", () => {
  it("409 CLIENT_INCOMPATIBLE leads to the update state", async () => {
    const f = fixture("rejected"); await f.controller.start();
    vi.mocked(f.api.reapply).mockRejectedValueOnce(new EntryApiError("http", 409, "CLIENT_INCOMPATIBLE"));
    await f.controller.reapply();
    expect(f.states.at(-1)).toEqual({ kind: "incompatible" });
  });

  it("503 MAINTENANCE is a planned pause with its wait, on the refusal screen, and the same command ID is kept", async () => {
    const f = fixture("rejected"); await f.controller.start();
    vi.mocked(f.api.reapply).mockRejectedValueOnce(new EntryApiError("http", 503, "MAINTENANCE",
      { waitSeconds: 40 }));
    await f.controller.reapply();
    expect(f.states.at(-1)).toEqual({ kind: "rejected", reason: "Review complete", pause: { waitSeconds: 40 } });
    expect(f.values.has(`wortly.reapply:${profileId}`)).toBe(true);
    await f.controller.reapply(); // Same button, same saved command: the user may try again.
    expect(f.states.at(-1)).toEqual({ kind: "pending" });
    const [first, second] = vi.mocked(f.api.reapply).mock.calls;
    expect(second[1]).toEqual(first[1]);
  });

  it("503 MAINTENANCE without an estimate carries no wait", async () => {
    const f = fixture("rejected"); await f.controller.start();
    vi.mocked(f.api.reapply).mockRejectedValueOnce(new EntryApiError("http", 503, "MAINTENANCE", { waitSeconds: null }));
    await f.controller.reapply();
    expect(f.states.at(-1)).toEqual({ kind: "rejected", reason: "Review complete", pause: {} });
  });

  it("keeps wait_seconds=0 (the estimate has passed): it is not «no estimate»", async () => {
    const f = fixture("rejected"); await f.controller.start();
    vi.mocked(f.api.reapply).mockRejectedValueOnce(new EntryApiError("http", 503, "MAINTENANCE", { waitSeconds: 0 }));
    await f.controller.reapply();
    expect(f.states.at(-1)).toEqual({ kind: "rejected", reason: "Review complete", pause: { waitSeconds: 0 } });
  });

  it.each([
    ["503 WRITE_UNAVAILABLE", new EntryApiError("http", 503, "WRITE_UNAVAILABLE")],
    ["a lost reply", new EntryApiError("network")],
    ["a plain 503", new EntryApiError("http", 503)],
  ])("%s is not passed off as the planned pause", async (_name, error) => {
    const f = fixture("rejected"); await f.controller.start();
    vi.mocked(f.api.reapply).mockRejectedValueOnce(error);
    await f.controller.reapply();
    expect(f.states.at(-1)).toEqual({ kind: "rejected", reason: "Review complete" });
  });
});
