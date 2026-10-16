// Е02 (tz_app.md:179, project_pending_profile_slots.md §3.3): the open of an admitted account on this device removes the
// content of every other account's unconfirmed command (`wortly.payload.*:<other>:*`) and nothing else.
import { describe, expect, it, vi } from "vitest";
import { TestEntryController } from "./entryInstallation.test-support";
import type { AuthResponse, OpenedClient, Profile } from "../api/generated";
import type { EntryApi } from "../api/entryApi";
import type { AsyncStorage } from "../platform/storage";
import type { DocumentLock } from "./documentLock";
import { freshTestGate } from "../commands/testGate.test-support";

const profileId = "11111111-1111-4111-8111-111111111111";
const instanceId = "22222222-2222-4222-8222-222222222222";
const registrationId = "33333333-3333-4333-8333-333333333333";
const documentId = "44444444-4444-4444-8444-444444444444";
const commandId = "55555555-5555-4555-8555-555555555555";

function profile(status: "admitted" | "pending" | "rejected", version = "9007199254740993"): Profile {
  return {
    profile_id: profileId,
    access: { status, version: "3", reason: status === "rejected" ? "Review complete" : null },
    role: "user", ui_language: "ru", dictionary_language: "ru", time_zone: null,
    state_version: version,
  };
}

function auth(status: "admitted" | "pending" | "rejected"): AuthResponse {
  return { access_token: "memory-token", expires_at: "2026-10-01T00:00:00Z", profile: profile(status), compatibility: { compatible: true, contract_version: "1" } };
}

function opened(version = "9007199254740994"): OpenedClient {
  return {
    status: "opened", client_instance_id: instanceId, document_id: documentId,
    document_epoch: "1", proof_version: "1", profile: profile("admitted", version),
    session: null, compatibility: { compatible: true, contract_version: "1" },
  };
}

function memoryStorage(listed = true): AsyncStorage & { values: Map<string, string>; set: ReturnType<typeof vi.fn> } {
  const values = new Map<string, string>();
  return {
    values,
    ...(listed ? { async keys(prefix: string) { return [...values.keys()].filter(key => key.startsWith(prefix)); } } : {}),
    async get(key) { return values.get(key) ?? null; },
    set: vi.fn(async (key: string, value: string) => { values.set(key, value); }),
    async remove(key) { values.delete(key); },
  };
}

function fixture(status: "admitted" | "pending" | "rejected" = "admitted", onState?: (kind: string) => void, listed = true) {
  const storage = memoryStorage(listed);
  const states: string[] = [];
  const ids = [instanceId, registrationId, documentId, commandId];
  const api: EntryApi = {
    auth: vi.fn(async () => auth(status)),
    reapply: vi.fn(async (_token, request) => ({
      command: { id: request.command_id, status: "applied" as const, applied_at: "2026-09-29T00:00:00Z", target_id: null, object_version: "4" },
      current: profile("pending", "9007199254740994"),
    })),
    register: vi.fn(async () => ({ client_instance_id: instanceId, status: "registered" as const, origin_proof: "saved-proof", proof_version: "1", activated: false })),
    open: vi.fn(async () => opened()),
  };
  const lock: DocumentLock = { acquire: vi.fn(async () => ({ release: vi.fn() })) };
  const timeZone = vi.fn((): string | null => "Europe/Berlin");
  const controller = new TestEntryController({ gate: freshTestGate(),
    api, storage, lock, initData: "signed-Telegram-data", savedLanguage: "ru", browserLanguage: "ru-RU",
    clientVersion: "0.0.0", contractVersion: "1", timeZone,
    newId: () => {
      const id = ids.shift();
      if (!id) throw new Error("ID exhausted");
      return id;
    },
    onUpdate: ({ state }) => { states.push(state.kind); onState?.(state.kind); },
  });
  return { controller, api, storage, states, lock, timeZone };
}


const OTHER = "66666666-6666-4666-8666-666666666666";
const OTHER_PAYLOAD = `wortly.payload.learning_session:${OTHER}:${commandId}`;
const OWN_PAYLOAD = `wortly.payload.feedback:${profileId}:${commandId}`;
const OTHER_POINTER = `wortly.pending.learning_session:profile:${OTHER}`;
function seed(values: Map<string, string>) {
  values.set(OTHER_PAYLOAD, '{"text":"Haus"}');
  values.set(`wortly.payload.oral_session:${OTHER}:${instanceId}`, '{"correct":false}');
  values.set(OWN_PAYLOAD, '{"text":"mine"}');
  values.set(OTHER_POINTER, '{"schemaVersion":2}');
  values.set("wortly.pending.learning_session", "legacy");
  values.set("unrelated", "keep");
}

describe("Е02 on the open of an admitted account", () => {
  it("removes only the payloads of other accounts; their pointers, own payloads, legacy and other keys stay", async () => {
    const f = fixture(); seed(f.storage.values);
    await f.controller.start();
    expect(f.controller.getOpenedAccess()?.profile.profile_id).toBe(profileId);
    await vi.waitFor(() => expect(f.storage.values.has(OTHER_PAYLOAD)).toBe(false));
    expect(f.storage.values.has(`wortly.payload.oral_session:${OTHER}:${instanceId}`)).toBe(false);
    expect(f.storage.values.get(OWN_PAYLOAD)).toBe('{"text":"mine"}');
    expect(f.storage.values.get(OTHER_POINTER)).toBe('{"schemaVersion":2}'); // the service IDs of the other account stay
    expect(f.storage.values.get("wortly.pending.learning_session")).toBe("legacy");
    expect(f.storage.values.get("unrelated")).toBe("keep");
  });

  it.each(["pending", "rejected"] as const)("a %s profile is not admitted: nothing is removed", async status => {
    const f = fixture(status); seed(f.storage.values);
    await f.controller.start();
    await Promise.resolve();
    expect(f.storage.values.has(OTHER_PAYLOAD)).toBe(true);
  });

  it("a storage without a listing: the open goes on, nothing is removed (repeated on a later open)", async () => {
    const f = fixture("admitted", undefined, false); seed(f.storage.values);
    await f.controller.start();
    expect(f.controller.getOpenedAccess()?.profile.profile_id).toBe(profileId);
    expect(f.storage.values.has(OTHER_PAYLOAD)).toBe(true);
  });
});
