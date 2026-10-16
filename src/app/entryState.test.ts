import { describe, expect, it, vi } from "vitest";
import { TestEntryController } from "./entryInstallation.test-support";
import type { AuthResponse, OpenedClient, Profile } from "../api/generated";
import { EntryApiError } from "../api/entryApi";
import type { EntryApi } from "../api/entryApi";
import type { AsyncStorage } from "../platform/storage";
import type { EntryState } from "./entryState";
import { freshTestGate } from "../commands/testGate.test-support";

// The entry screens render exactly the state sequence that EntryController publishes.
const profileId = "11111111-1111-4111-8111-111111111111";

function profile(status: Profile["access"]["status"], reason: string | null = null): Profile {
  return { profile_id: profileId, role: "user", ui_language: "en", dictionary_language: "en", time_zone: null,
    state_version: "5", access: { status, version: "3", reason } };
}

function setup(status: Profile["access"]["status"], reason: string | null = null) {
  const values = new Map<string, string>();
  const storage: AsyncStorage = { get: async key => values.get(key) ?? null,
    set: async (key, value) => { values.set(key, value); }, remove: async key => { values.delete(key); } };
  const api: EntryApi = {
    auth: vi.fn(async (): Promise<AuthResponse> => ({ access_token: "token", expires_at: "2026-10-06T00:00:00Z",
      profile: profile(status, reason), compatibility: { compatible: true, contract_version: "1" } })),
    reapply: vi.fn(),
    register: vi.fn(async (_token, request) => ({ client_instance_id: request.client_instance_id, status: "registered" as const,
      origin_proof: "proof", proof_version: "1", activated: false })),
    open: vi.fn(async (_token, _proof, request): Promise<OpenedClient> => ({ status: "opened",
      client_instance_id: request.client_instance_id, document_id: request.document_id, document_epoch: "1",
      proof_version: "1", profile: { ...profile("admitted"), state_version: "6" }, session: null,
      compatibility: { compatible: true, contract_version: "1" } })),
  };
  let next = 0;
  const states: EntryState[] = [];
  const controller = new TestEntryController({ gate: freshTestGate(), api, storage, lock: { acquire: async () => ({ release: () => undefined }) },
    initData: "signed", savedLanguage: "en", browserLanguage: "en", clientVersion: "0.0.0", contractVersion: "1",
    timeZone: () => "UTC", newId: () => `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`,
    onUpdate: ({ state }) => states.push(state) });
  return { api, controller, states, kinds: () => states.map(state => state.kind) };
}

describe("entry state sequence", () => {
  it("keeps admitted access in opening until the document is really opened", async () => {
    const f = setup("admitted");
    const original = vi.mocked(f.api.open).getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(f.api.open).mockImplementationOnce(async (...args) => { await gate; return original(...args); });
    const starting = f.controller.start();
    await vi.waitFor(() => expect(f.api.open).toHaveBeenCalledOnce());
    expect(f.kinds()).toEqual(["checking", "opening"]);
    release(); await starting;
    expect(f.kinds()).toEqual(["checking", "opening", "opened"]);
  });

  it("does not reapply on reopening a rejected profile", async () => {
    const f = setup("rejected", "Access review");
    await f.controller.start(); await f.controller.foreground(); await f.controller.retry();
    expect(f.states.at(-1)).toEqual({ kind: "rejected", reason: "Access review" });
    expect(f.kinds()).not.toContain("reapplying");
    expect(f.api.reapply).not.toHaveBeenCalled();
  });

  it("shows pending only after reapply is confirmed and keeps the refusal after an unknown outcome", async () => {
    const f = setup("rejected", "Access review"); await f.controller.start();
    vi.mocked(f.api.reapply).mockRejectedValueOnce(new EntryApiError("network"));
    await f.controller.reapply();
    expect(f.states.slice(-2)).toEqual([{ kind: "reapplying", reason: "Access review" }, { kind: "rejected", reason: "Access review" }]);
    let confirm!: () => void;
    vi.mocked(f.api.reapply).mockImplementationOnce((_token, request) => new Promise(resolve => {
      confirm = () => resolve({ command: { id: request.command_id, status: "already_applied", applied_at: "2026-10-05T12:00:00Z",
        target_id: profileId, object_version: "4" }, current: { ...profile("pending"), state_version: "6",
        access: { status: "pending", version: "4", reason: null } } });
    }));
    const sending = f.controller.reapply();
    await vi.waitFor(() => expect(f.api.reapply).toHaveBeenCalledTimes(2));
    expect(f.states.at(-1)).toEqual({ kind: "reapplying", reason: "Access review" });
    confirm(); await sending;
    expect(f.states.at(-1)).toEqual({ kind: "pending" });
  });

  it("separates unavailable from a confirmed pending state", async () => {
    const pending = setup("pending"); await pending.controller.start(); await pending.controller.foreground();
    expect(pending.kinds()).toEqual(["checking", "pending"]);
    const failed = setup("pending");
    vi.mocked(failed.api.auth).mockRejectedValueOnce(new EntryApiError("network"));
    await failed.controller.start();
    expect(failed.kinds()).toEqual(["checking", "unavailable"]);
    // P03 M-P03-10 (§4.13 В, AC-102): a window without a session or a document signs in again no more; nothing leaves.
    await failed.controller.retry();
    expect(failed.kinds()).toEqual(["checking", "unavailable"]);
    expect(failed.api.auth).toHaveBeenCalledOnce();
  });
});
