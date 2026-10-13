import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthResponse, OpenedClient, Profile } from "../api/generated";
import { EntryApiError, type EntryApi } from "../api/entryApi";
import { EntryController } from "../app/entryController";
import type { AsyncStorage } from "../platform/storage";
import { screenDecision } from "../commands/laneRecovery";
import { ClientJournal, installClientJournal, type ClientJournalOptions, type JournalClock } from "./clientJournal";

const profileId = "11111111-1111-4111-8111-111111111111";
const instanceId = "22222222-2222-4222-8222-222222222222";
const registrationId = "33333333-3333-4333-8333-333333333333";
const documentId = "44444444-4444-4444-8444-444444444444";

function profile(status: "admitted" | "pending" | "rejected"): Profile {
  return { profile_id: profileId, access: { status, version: "3", reason: null }, role: "user", ui_language: "ru",
    dictionary_language: "ru", time_zone: null, state_version: "5" };
}
function auth(status: "admitted" | "pending" | "rejected", compatible = true): AuthResponse {
  return { access_token: "MARKER-token", expires_at: "2026-10-14T00:00:00Z", profile: profile(status),
    compatibility: { compatible, contract_version: "1" } };
}
const opened: OpenedClient = { status: "opened", client_instance_id: instanceId, document_id: documentId, document_epoch: "1",
  proof_version: "1", profile: { ...profile("admitted"), state_version: "6" }, session: null, compatibility: { compatible: true, contract_version: "1" } };

function storage(): AsyncStorage {
  const values = new Map<string, string>();
  return { async get(key) { return values.get(key) ?? null; }, async set(key, value) { values.set(key, value); }, async remove(key) { values.delete(key); } };
}
const clock: JournalClock = { now: () => Date.parse("2026-10-13T10:00:00.000Z"), schedule: () => null, cancel: () => undefined };

function setup(status: "admitted" | "pending" | "rejected",
  options: { compatible?: boolean; open?: EntryApi["open"]; openStore?: ClientJournalOptions["openStore"] } = {}) {
  const send = vi.fn(async () => ({ status: 200 }));
  const journal = new ClientJournal({ clientVersion: "0.0.0", send, clock, openStore: options.openStore ?? (() => Promise.reject(new Error("none"))) });
  installClientJournal(journal);
  const ids = [instanceId, registrationId, documentId];
  const api: EntryApi = {
    auth: vi.fn(async () => auth(status, options.compatible ?? true)),
    reapply: vi.fn(),
    register: vi.fn(async () => ({ client_instance_id: instanceId, status: "registered" as const, origin_proof: "MARKER-proof", proof_version: "1", activated: false })),
    open: options.open ?? vi.fn(async () => opened),
  };
  const controller = new EntryController({ api, storage: storage(), lock: { acquire: vi.fn(async () => ({ release: vi.fn() })) },
    initData: "MARKER-initData", savedLanguage: "ru", browserLanguage: "ru-RU", clientVersion: "0.0.0", contractVersion: "1",
    timeZone: () => "Europe/Berlin", newId: () => ids.shift()!, onUpdate: () => undefined });
  return { controller, journal, send };
}
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

afterEach(() => installClientJournal(null));

describe("the entry decides who has a journal (P1-2)", () => {
  it.each(["pending", "rejected"] as const)("a %s profile has none: nothing is kept, no buffer exists", async (status) => {
    const { controller, journal, send } = setup(status);
    await controller.start();
    await settle();
    expect(journal.admitted()).toBeNull();
    expect(journal.pending()).toEqual({ events: [], lost: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it.each(["pending", "rejected"] as const)("a fresh page that meets a %s profile clears the buffer an earlier page stored (QA P2-1)", async (status) => {
    const { FakeIndexedDb } = await import("../commands/idbFake.test-support");
    const { IdbJournalStore, JOURNAL_DATABASE, JOURNAL_STORE } = await import("./journalStore");
    const idb = new FakeIndexedDb();
    const earlier = new ClientJournal({ clientVersion: "0.0.0", send: vi.fn(), clock, openStore: () => IdbJournalStore.open(idb.factory) });
    earlier.admit(profileId);
    earlier.record({ ev: "c.error", err: "TypeError" });
    await settle(); await settle();
    expect(idb.rows(JOURNAL_DATABASE, JOURNAL_STORE).size).toBe(1);
    const { controller } = setup(status, { openStore: () => IdbJournalStore.open(idb.factory) });
    await controller.start();
    await settle(); await settle();
    expect(idb.rows(JOURNAL_DATABASE, JOURNAL_STORE).size).toBe(0);
  });

  it("an incompatible pending profile has none either", async () => {
    const { controller, journal } = setup("pending", { compatible: false });
    await controller.start();
    expect(journal.admitted()).toBeNull();
    expect(journal.pending().events).toEqual([]);
  });

  it("an admitted profile's open is journalled with its document, never its sign-in data", async () => {
    const { controller, journal } = setup("admitted");
    await controller.start();
    await settle();
    expect(journal.admitted()).toBe(profileId);
    const events = journal.pending().events;
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ ev: "c.app.open", kind: "open", doc: documentId, idb_ok: false })]));
    expect(JSON.stringify(events)).not.toMatch(/MARKER|initData/);
  });

  it("an admitted but incompatible client keeps the update screen", async () => {
    const { controller, journal } = setup("admitted", { compatible: false });
    await controller.start();
    expect(journal.pending().events.filter(event => event.ev !== "c.storage"))
      .toEqual([expect.objectContaining({ ev: "c.screen", kind: "update_required", code: "CLIENT_INCOMPATIBLE" })]);
  });

  it("a lost admission (403 ACCESS_REJECTED) ends the journal and clears its buffer", async () => {
    const open = vi.fn(async () => { throw new EntryApiError("http", 403, "ACCESS_REJECTED"); });
    const { controller, journal } = setup("admitted", { open });
    await controller.start();
    expect(journal.admitted()).toBeNull();
    expect(journal.pending().events).toEqual([]);
  });
});

describe("the screen's decision for a recovered action (c.screen)", () => {
  it("names the class of the decision, never more", () => {
    expect(screenDecision({ name: "settled", outcome: "accepted" }, false)).toEqual({ kind: "result_shown" });
    expect(screenDecision({ name: "settled", outcome: "accepted" }, true)).toEqual({ kind: "already_recorded" });
    expect(screenDecision({ name: "settled", outcome: "rejected" }, true)).toEqual({ kind: "refusal_shown" });
    expect(screenDecision({ name: "refused", code: "VALIDATION_FAILED" }, false)).toEqual({ kind: "refusal_shown", code: "VALIDATION_FAILED" });
    expect(screenDecision({ name: "refused", code: "free text" }, false)).toEqual({ kind: "refusal_shown" });
    expect(screenDecision({ name: "exhausted" }, true)).toEqual({ kind: "unsaved_shown" });
    expect(screenDecision({ name: "terminated", reason: "client_incompatible" }, true)).toEqual({ kind: "update_required", code: "CLIENT_INCOMPATIBLE" });
    expect(screenDecision({ name: "terminated", reason: "window_replaced" }, true)).toBeNull();
    expect(screenDecision({ name: "checking" }, true)).toBeNull();
  });
});

describe("the recovery machine's part (c.recovery, c.budget)", () => {
  it("journals each change of state of one command and the spent budget, with the machine's send numbers", async () => {
    const { RecoveryMachine } = await import("../commands/recoveryMachine");
    const { MemorySendCounter } = await import("../commands/sendCounter");
    vi.useFakeTimers();
    try {
      const journal = new ClientJournal({ clientVersion: "0.0.0", send: vi.fn(), openStore: () => Promise.reject(new Error("none")) });
      installClientJournal(journal);
      journal.admit(profileId);
      const cmd = "55555555-5555-4555-8555-555555555555";
      const attempts: number[] = [];
      const machine = new RecoveryMachine({
        intent: { command_id: cmd, kind: "answer.submit", session_id: documentId, answer: "MARKER-answer" },
        counter: new MemorySendCounter(), active: true,
        clock: { now: () => performance.now(), schedule: (callback, delayMs) => ({ id: setTimeout(callback, delayMs) }),
          cancel: timer => clearTimeout(timer.id as ReturnType<typeof setTimeout>) },
        ports: {
          async send(_intent, transmitted) { attempts.push(journal.attempt(cmd)); transmitted(); return { kind: "lost", cause: "network" }; },
          async check() { return { kind: "not_recorded" }; },
          async probe() { return true; }, isLive: () => true, windowCheck: async () => true,
        },
      });
      machine.begin();
      for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(30_000);
      expect(machine.snapshot().state.name).toBe("exhausted");
      expect(attempts).toEqual([1, 2, 3, 4, 5, 6]);
      const events = journal.pending().events;
      const recoveries = events.filter(event => event.ev === "c.recovery");
      // Six sends with their checks and pauses make more than 20 changes: the bound of §6 keeps the first 20; the end
      // is still told by c.budget (and by c.screen at the lane).
      expect(recoveries).toHaveLength(20);
      expect(recoveries[0]).toMatchObject({ cmd, from: "idle", to: "sending" });
      expect(events).toContainEqual(expect.objectContaining({ ev: "c.budget", cmd, n: 6, outcome: "failed" }));
      expect(JSON.stringify(events)).not.toContain("MARKER");
    } finally { vi.useRealTimers(); }
  });
});
