// C163 (C405/C410; integration on the IndexedDB store fix1): the pure decisions of the four installation writers, and the
// same decisions through the product store over the IndexedDB double shared by two windows, the fail-closed read of an
// invalid record, the "unavailable" outcome (never a localStorage fallback) and the read-only path of store canon §5.
import { describe, expect, it, vi } from "vitest";
import type { Installation } from "./installation";
import { decideA, decideActivated, decideB, decideRegister, sameInstallation } from "./installationWriters";
import { contextInstallationStore } from "./entryInstallation.test-support";
import type { InstallationStore } from "./installationStore";
import { installationKey } from "./installationStore";
import { idbInstallationStore, INSTALLATION_DATABASE, INSTALLATION_STORE } from "./installationStoreIdb";
import { upgradeWrites } from "./installationIdb.test-support";
import { FakeIndexedDb } from "../commands/idbFake.test-support";
import { sharedStorage } from "./webLocks.test-support";
import { EntryController } from "./entryController";
import { WriteGate } from "../commands/writeGate";
import { ManualClock, settle } from "../commands/writeGate.test-support";
import type { EntryApi } from "../api/entryApi";
import type { AsyncStorage } from "../platform/storage";

const P = "00000000-0000-4000-8000-000000000001";
const ids = { clientInstanceId: "00000000-0000-4000-8000-0000000000b1", registrationId: "00000000-0000-4000-8000-0000000000b2" };
const A: Installation = { profileId: P, clientInstanceId: "00000000-0000-4000-8000-0000000000a1",
  registrationId: "00000000-0000-4000-8000-0000000000a2", proof: "proof-a", proofVersion: "1", activated: true };

describe("decideA — writer 1 (create/reuse)", () => {
  it("reuses a record with a proof as it is", () => expect(decideA(A, P, ids)).toEqual({ keep: true, result: A }));
  it.each([["none", null], ["one without a proof (an earlier sign-in's registration)", { ...A, proof: null, proofVersion: null }]])(
    "replaces %s by new IDs", (_n, current) => {
      const decision = decideA(current, P, ids);
      expect(decision).toEqual({ write: { profileId: P, ...ids, proof: null, proofVersion: null, activated: false },
        result: { profileId: P, ...ids, proof: null, proofVersion: null, activated: false } });
    });
});

describe("decideB — writer 2 (B after a refused proof)", () => {
  const fresh = { profileId: P, ...ids, proof: null, proofVersion: null, activated: false };
  it("over exactly the expected A: a NEW B", () => expect(decideB(A, P, A, null, ids)).toEqual({ write: fresh, result: fresh }));
  // 6b (P3, OB-null): C405 asks for the EXACT expected A or own B — «no record» gets no B either.
  it("over none: conflict (no B over a vanished A)", () => expect(decideB(null, P, A, null, ids)).toEqual({ conflict: "foreign" }));
  it("own B (exactly as this page knew it) with a proof: kept", () => {
    const own = { ...A, clientInstanceId: "00000000-0000-4000-8000-0000000000c1", proof: "proof-b" };
    expect(decideB(own, P, A, own, ids)).toEqual({ keep: true, result: own });
  });
  it("own B without a proof: replaced by a new B", () => {
    const own = { ...fresh, clientInstanceId: "00000000-0000-4000-8000-0000000000c1" };
    expect(decideB(own, P, A, own, ids)).toEqual({ write: fresh, result: fresh });
  });
  // 6b (P2-6A, QA RB1): our client id is no identity — another registration or proof under it is not our B.
  it.each([
    ["another registration_id", { registrationId: "00000000-0000-4000-8000-000000000888" }],
    ["another proof and version", { proof: "proof-foreign", proofVersion: "7" }],
    ["another profile", { profileId: "00000000-0000-4000-8000-000000000002" }],
  ])("a record with our B's client id but %s: foreign, nothing written", (_n, patch) => {
    const own = { ...A, clientInstanceId: "00000000-0000-4000-8000-0000000000c1", proof: "proof-b" };
    expect(decideB({ ...own, ...patch }, P, A, own, ids)).toEqual({ conflict: "foreign" });
  });
  it.each([
    ["a fresher A (newer proof)", { ...A, proof: "proof-a2", proofVersion: "2" }],
    ["A with another activated flag", { ...A, activated: false }],
    ["another window's B", { ...A, clientInstanceId: "00000000-0000-4000-8000-0000000000d1" }],
  ])("%s: foreign, nothing written", (_n, current) => expect(decideB(current, P, A, null, ids)).toEqual({ conflict: "foreign" }));
});

describe("decideRegister — writer 3 (the register result)", () => {
  const sent = { clientInstanceId: A.clientInstanceId, registrationId: A.registrationId };
  const pending = { ...A, proof: null, proofVersion: null, activated: false };
  it("belongs only to the sent IDs", () => {
    expect(decideRegister({ ...A, clientInstanceId: ids.clientInstanceId }, sent, { proof: "p", proofVersion: "1" })).toEqual({ conflict: "replaced" });
    expect(decideRegister({ ...A, registrationId: ids.registrationId }, sent, { proof: "p", proofVersion: "1" })).toEqual({ conflict: "replaced" });
    expect(decideRegister(null, sent, { proof: "p", proofVersion: "1" })).toEqual({ conflict: "replaced" });
  });
  it("writes the proof over the actual record (a first proof)", () => {
    expect(decideRegister(pending, sent, { proof: "p1", proofVersion: "1" })).toEqual({ write: { ...pending, proof: "p1", proofVersion: "1" },
      result: { ...pending, proof: "p1", proofVersion: "1" } });
  });
  it("the highest version comes from the ACTUAL record: a late older reply keeps it", () => {
    const actual = { ...pending, proof: "p3", proofVersion: "3" };
    expect(decideRegister(actual, sent, { proof: "p2", proofVersion: "2" })).toEqual({ keep: true, result: actual });
  });
  it("the same version: the same proof is kept, another proof is inconsistent", () => {
    const actual = { ...pending, proof: "p2", proofVersion: "2" };
    expect(decideRegister(actual, sent, { proof: "p2", proofVersion: "2" })).toEqual({ keep: true, result: actual });
    expect(decideRegister(actual, sent, { proof: "px", proofVersion: "2" })).toEqual({ conflict: "inconsistent" });
  });
  it("a newer reply never lowers activated", () => {
    const actual = { ...A, activated: true };
    const decision = decideRegister(actual, sent, { proof: "p2", proofVersion: "2" });
    expect(decision).toEqual({ write: { ...actual, proof: "p2", proofVersion: "2" }, result: { ...actual, proof: "p2", proofVersion: "2" } });
  });
});

describe("decideActivated — writer 4 (activated)", () => {
  it("only the flag of the same installation; a fresher proof stays", () => {
    const actual = { ...A, activated: false, proof: "p5", proofVersion: "5" };
    expect(decideActivated(actual, A)).toEqual({ write: { ...actual, activated: true }, result: { ...actual, activated: true } });
  });
  it("already set: kept", () => expect(decideActivated(A, A)).toEqual({ keep: true, result: A }));
  it("another record now: replaced, nothing written", () => {
    expect(decideActivated({ ...A, clientInstanceId: ids.clientInstanceId }, A)).toEqual({ conflict: "replaced" });
    expect(decideActivated(null, A)).toEqual({ conflict: "replaced" });
  });
  // 6b (P2-6A, QA RB2): the same client id with another registration (or profile) is another installation.
  it.each([["another registration_id", { registrationId: ids.registrationId }], ["another profile", { profileId: "00000000-0000-4000-8000-000000000002" }]])(
    "RB2: the same client id with %s: replaced, nothing written", (_n, patch) => {
      expect(decideActivated({ ...A, activated: false, ...patch }, A)).toEqual({ conflict: "replaced" });
    });
  it("sameInstallation compares every field", () => {
    expect(sameInstallation(A, { ...A })).toBe(true);
    expect(sameInstallation(A, { ...A, proof: "x" })).toBe(false);
    expect(sameInstallation(null, null)).toBe(true);
  });
});

describe("the writers through the IndexedDB store, two windows", () => {
  function twoWindows(seed: unknown) {
    const fake = new FakeIndexedDb(), factory = upgradeWrites(fake), legacy = () => sharedStorage().storage;
    const w1 = idbInstallationStore(factory, legacy), w2 = idbInstallationStore(factory, legacy);
    return { fake, w1, w2, ready: async () => { await w1.read(P); fake.seed(INSTALLATION_DATABASE, INSTALLATION_STORE, P, seed); },
      row: () => fake.rows(INSTALLATION_DATABASE, INSTALLATION_STORE).get(P) };
  }
  it("a late register reply of A after another window wrote B: no write (replaced)", async () => {
    const pending = { ...A, proof: null, proofVersion: null, activated: false };
    const t = twoWindows(pending); await t.ready();
    const b = { profileId: P, ...ids, proof: null, proofVersion: null, activated: false };
    expect(await t.w2.mutate(P, () => true, current => decideB(current, P, pending, null, ids))).toMatchObject({ kind: "applied", record: b });
    const late = await t.w1.mutate(P, () => true, current => decideRegister(current,
      { clientInstanceId: A.clientInstanceId, registrationId: A.registrationId }, { proof: "pa", proofVersion: "1" }));
    expect(late).toMatchObject({ kind: "conflict", reason: "replaced" });
    expect(t.row()).toEqual(b);
  });
  it("activated of window 1 keeps the fresher proof window 2 wrote", async () => {
    const t = twoWindows({ ...A, activated: false }); await t.ready();
    await t.w2.mutate(P, () => true, current => decideRegister(current,
      { clientInstanceId: A.clientInstanceId, registrationId: A.registrationId }, { proof: "p2", proofVersion: "2" }));
    await t.w1.mutate(P, () => true, current => decideActivated(current, A));
    expect(t.row()).toEqual({ ...A, proof: "p2", proofVersion: "2", activated: true });
  });
  it("writers build exactly six fields: an extra field of the actual value is never carried (no spread)", async () => {
    // The store's validator refuses a record with extras (invalid); the reducers never get one — and never make one.
    const written = decideRegister({ ...A, proof: null, proofVersion: null, activated: true },
      { clientInstanceId: A.clientInstanceId, registrationId: A.registrationId }, { proof: "p9", proofVersion: "9" });
    expect(Object.keys((written as { write: object }).write).sort()).toEqual(["activated", "clientInstanceId", "profileId", "proof", "proofVersion", "registrationId"]);
    const flagged = decideActivated({ ...A, activated: false, extra: "x" } as Installation, A);
    expect(Object.keys((flagged as { write: object }).write)).not.toContain("extra");
  });
});

describe("Entry over the store: fail-closed, unavailable, and the read-only path of §5 (C423 at the entry)", () => {
  const compatibility = { compatible: true, contract_version: "1" };
  const admitted = { profile_id: P, role: "user", ui_language: "ru", dictionary_language: "ru", time_zone: "UTC", state_version: "10",
    access: { status: "admitted", version: "1", reason: null } };
  type Mode = "idb" | "absent" | "open-error" | "getter-throws";
  function entry(mode: Mode, legacyValue: string | null, options: { access?: "admitted" | "pending" } = {}) {
    const legacy = sharedStorage();
    if (legacyValue !== null) legacy.map.set(installationKey(P), legacyValue);
    const fake = new FakeIndexedDb();
    if (mode === "open-error") fake.openBehaviour = "error";
    const source = mode === "absent" ? undefined : mode === "getter-throws" ? { kind: "error" as const } : upgradeWrites(fake);
    const profile = { ...admitted, access: { ...admitted.access, status: options.access ?? "admitted" } };
    const api = {
      auth: vi.fn(async () => ({ access_token: "t", expires_at: "2026-10-17T00:00:00Z", profile, compatibility })),
      register: vi.fn(async (_t: string, body: { client_instance_id: string }) => ({ status: "registered", client_instance_id: body.client_instance_id,
        origin_proof: "p", proof_version: "1", activated: false })),
      open: vi.fn(async (_t: string, _p: string, body: { client_instance_id: string; document_id: string }) => ({ status: "opened",
        client_instance_id: body.client_instance_id, document_id: body.document_id, document_epoch: "1", proof_version: "1", profile,
        session: null, compatibility })),
      reapply: vi.fn(),
    } as unknown as EntryApi;
    const memory: AsyncStorage = { get: async () => null, set: async () => undefined, remove: async () => undefined };
    const states: string[] = [];
    let n = 100;
    const controller = new EntryController({ gate: new WriteGate({ clock: new ManualClock() }), api, storage: memory,
      lock: { acquire: vi.fn(async () => ({ release: vi.fn() })) }, initData: "signed", savedLanguage: "ru", browserLanguage: "ru",
      clientVersion: "0.0.0", contractVersion: "1", timeZone: () => "UTC", newId: () => `00000000-0000-4000-8000-${String(n++).padStart(12, "0")}`,
      onUpdate: ({ state }) => states.push(state.kind), installationStore: idbInstallationStore(source, () => legacy.storage) });
    const idbWrites = () => fake.log.filter(entry => entry.mode === "readwrite" && entry.outcome === "complete").length;
    const legacyWrites = () => legacy.log.filter(line => line.startsWith("set") || line.startsWith("remove")).length;
    return { controller, api, states, legacy, fake, idbWrites, legacyWrites };
  }
  it("IDB: an invalid legacy record is imported as the invalid marker — fail-closed: no new A, no register, no open", async () => {
    const e = entry("idb", "{broken");
    await e.controller.start(); await settle();
    expect(e.states.at(-1)).toBe("unavailable");
    expect(e.api.register).not.toHaveBeenCalled(); expect(e.api.open).not.toHaveBeenCalled();
    expect(e.legacy.map.get(installationKey(P))).toBe("{broken");
  });
  it("§5 noIDB: a valid six-field activated A with a proof opens by the existing open — 0 register, 0 installation writes", async () => {
    const e = entry("absent", JSON.stringify(A));
    await e.controller.start(); await settle();
    expect(e.api.register).not.toHaveBeenCalled(); expect(e.api.open).toHaveBeenCalledTimes(1);
    expect(e.states.at(-1)).toBe("opened");
    expect(e.legacyWrites()).toBe(0);
  });
  it.each([
    ["not activated", JSON.stringify({ ...A, activated: false })],
    ["without a proof", JSON.stringify({ ...A, proof: null, proofVersion: null })],
    ["invalid JSON", "{broken"],
    ["another profile's record under this key", JSON.stringify({ ...A, profileId: "00000000-0000-4000-8000-000000000002" })],
    ["an extra field", JSON.stringify({ ...A, extra: 1 })],
    ["none", null],
  ])("§5 noIDB: a legacy record %s — no register, no open, no new A, no write", async (_n, value) => {
    const e = entry("absent", value);
    await e.controller.start(); await settle();
    expect(e.states.at(-1)).toBe("unavailable");
    expect(e.api.register).not.toHaveBeenCalled(); expect(e.api.open).not.toHaveBeenCalled();
    expect(e.legacyWrites()).toBe(0);
  });
  it("§5 noIDB + a pending profile: its own screen, no open, no write", async () => {
    const e = entry("absent", JSON.stringify(A), { access: "pending" });
    await e.controller.start(); await settle();
    expect(e.states.at(-1)).toBe("pending");
    expect(e.api.open).not.toHaveBeenCalled(); expect(e.legacyWrites()).toBe(0);
  });
  it.each([["the database does not open (temporary)", "open-error"], ["the indexedDB getter throws (error, not absent)", "getter-throws"]] as const)(
    "%s with a valid legacy A: unavailable — 0 localStorage fallback, 0 register, 0 open", async (_n, mode) => {
      const e = entry(mode, JSON.stringify(A));
      await e.controller.start(); await settle();
      expect(e.states.at(-1)).toBe("unavailable");
      expect(e.api.register).not.toHaveBeenCalled(); expect(e.api.open).not.toHaveBeenCalled();
      expect(e.legacy.log.filter(line => line.startsWith("get"))).toHaveLength(0); // never a localStorage fallback
      expect(e.legacyWrites()).toBe(0);
    });
  it("§5 noIDB: dispose between the legacy read and the open — no open, no write", async () => {
    const e = entry("absent", JSON.stringify(A));
    const read = e.legacy.storage.getItem.bind(e.legacy.storage);
    e.legacy.storage.getItem = key => { const value = read(key); e.controller.dispose(); return value; };
    await e.controller.start(); await settle();
    expect(e.api.open).not.toHaveBeenCalled(); expect(e.legacyWrites()).toBe(0);
  });
  // QA a2f6d85b J5 (C444) as a regression: an event of the page INSIDE the strict legacy read (§5) ends the run — the late
  // read must not leave its record in this page's memory (a dead generation keeping a proof, also X's after its deletion).
  it.each(["deletedEnd", "unknownEnd", "dispose", "replace", "closeFor"] as const)(
    "J5: %s during the §5 legacy read — no record kept in memory, no open, nothing after it", async event => {
      const e = entry("absent", JSON.stringify(A));
      const c = e.controller as unknown as { installation: unknown; endAfterDeletion(end: { kind: string }): void; replace(): void;
        closeFor(reason: string): void; reenter(): Promise<void>; retry(): Promise<void>; foreground(source?: string): Promise<void> };
      const read = e.legacy.storage.getItem.bind(e.legacy.storage);
      e.legacy.storage.getItem = key => {
        const value = read(key);
        if (event === "deletedEnd") c.endAfterDeletion({ kind: "deleted" });
        if (event === "unknownEnd") c.endAfterDeletion({ kind: "unknown" });
        if (event === "dispose") e.controller.dispose();
        if (event === "replace") c.replace();
        if (event === "closeFor") c.closeFor("identity");
        return value;
      };
      await e.controller.start(); await settle();
      e.legacy.storage.getItem = read;
      expect(c.installation).toBeNull();
      expect(e.api.open).not.toHaveBeenCalled();
      await c.reenter(); await c.retry(); await c.foreground("show"); await c.foreground("screen"); await settle();
      expect(e.api.open).not.toHaveBeenCalled();
      expect(e.legacyWrites()).toBe(0);
    });

  // QA a2f6d85b J7 (C444) as a regression: an outcome of an ENDED run forgets the page's memory only if no newer run set
  // its own record meanwhile — an old late/dead outcome never erases the new memory.
  it("J7: a late outcome of an ended run does not erase the record a newer run set meanwhile", async () => {
    const e = entry("idb", null);
    const c = e.controller as unknown as { installation: unknown; generation: number;
      prepareInstallation(profileId: string, generation: number): Promise<boolean>; store: { mutate: (...args: unknown[]) => Promise<unknown> } };
    const newer = { ...A, clientInstanceId: "00000000-0000-4000-8000-0000000000e1" };
    let finishOld!: () => void;
    const mutate = c.store.mutate.bind(c.store);
    let calls = 0;
    c.store.mutate = (...args: unknown[]) => {
      calls += 1;
      if (calls === 1) return new Promise(resolve => { finishOld = () => resolve({ kind: "late", record: A, result: A }); });
      if (calls === 2) return Promise.resolve({ kind: "current", record: newer, result: newer });
      return mutate(...args);
    };
    const old = c.prepareInstallation(P, c.generation);
    await settle();
    c.generation += 1; // a newer run of this page begins
    expect(await c.prepareInstallation(P, c.generation)).toBe(true);
    expect(c.installation).toEqual(newer);
    finishOld(); await old; await settle();
    expect(c.installation).toEqual(newer);
  });

  it("§5 noIDB: a later new B (Q01) is impossible without a persist — the re-entry stops", async () => {
    const e = entry("absent", JSON.stringify(A));
    await e.controller.start(); await settle();
    expect(e.states.at(-1)).toBe("opened");
    // The B of a refused proof needs a write: with no store there is none, so nothing more is sent.
    const B = (e.controller as unknown as { prepareInstallationB(p: string, g: number): Promise<boolean> });
    (e.controller as unknown as { installationRecovery: unknown }).installationRecovery = { a: A, b: null };
    expect(await B.prepareInstallationB(P, (e.controller as unknown as { generation: number }).generation)).toBe(false);
    expect(e.legacyWrites()).toBe(0);
  });
});

describe("C414 outcome mapping (prototype) — the extra outcomes of the IndexedDB store step 2 (late/failed/unknown)", () => {
  const compatibility = { compatible: true, contract_version: "1" };
  const profile = { profile_id: P, role: "user", ui_language: "ru", dictionary_language: "ru", time_zone: "UTC", state_version: "10",
    access: { status: "admitted", version: "1", reason: null } };
  /** A store whose n-th mutation (1-based) answers `answer` instead of mutating; the others go to a context store. */
  function scripted(answers: Record<number, { kind: string } | (() => { kind: string })>) {
    const values = new Map<string, string>();
    const memory: AsyncStorage = { get: async key => values.get(key) ?? null, set: async (key, value) => { values.set(key, value); },
      remove: async key => { values.delete(key); } };
    const inner = contextInstallationStore(memory);
    let n = 0;
    const store: InstallationStore = {
      mutate: ((profileId: string, guard: () => boolean, reducer: never) => {
        n += 1;
        const answer = answers[n];
        if (typeof answer === "function") return Promise.resolve(answer());
        return answer ? Promise.resolve(answer) : inner.mutate(profileId, guard, reducer);
      }) as InstallationStore["mutate"],
      read: vi.fn(inner.read) as InstallationStore["read"],
      forget: inner.forget,
    };
    return { store, values };
  }
  function entry(answers: Record<number, { kind: string } | (() => { kind: string })>) {
    const { store, values } = scripted(answers);
    const api = {
      auth: vi.fn(async () => ({ access_token: "t", expires_at: "2026-10-17T00:00:00Z", profile, compatibility })),
      register: vi.fn(async (_t: string, body: { client_instance_id: string }) => ({ status: "registered", client_instance_id: body.client_instance_id,
        origin_proof: "p", proof_version: "1", activated: false })),
      open: vi.fn(async (_t: string, _p: string, body: { client_instance_id: string; document_id: string }) => ({ status: "opened",
        client_instance_id: body.client_instance_id, document_id: body.document_id, document_epoch: "1", proof_version: "1", profile,
        session: null, compatibility })),
      reapply: vi.fn(),
    } as unknown as EntryApi;
    const memory: AsyncStorage = { get: async () => null, set: async () => undefined, remove: async () => undefined };
    const states: string[] = [];
    let n = 100;
    const controller = new EntryController({ gate: new WriteGate({ clock: new ManualClock() }), api, storage: memory,
      lock: { acquire: vi.fn(async () => ({ release: vi.fn() })) }, initData: "signed", savedLanguage: "ru", browserLanguage: "ru",
      clientVersion: "0.0.0", contractVersion: "1", timeZone: () => "UTC", newId: () => `00000000-0000-4000-8000-${String(n++).padStart(12, "0")}`,
      onUpdate: ({ state }) => states.push(state.kind), installationStore: store });
    return { controller, api, states, store, values };
  }
  it.each(["unknown", "failed", "late", "cancelled"])("writer 1 (A) answers %s: no register, no open, no read fallback", async kind => {
    const e = entry({ 1: { kind } });
    await e.controller.start(); await settle();
    expect(e.states.at(-1)).toBe("unavailable");
    expect(e.api.register).not.toHaveBeenCalled(); expect(e.api.open).not.toHaveBeenCalled();
    expect(e.store.read).not.toHaveBeenCalled();
  });
  it.each(["unknown", "failed", "late"])("writer 3 (register result) answers %s: no open", async kind => {
    const e = entry({ 2: { kind } });
    await e.controller.start(); await settle();
    expect(e.api.register).toHaveBeenCalledTimes(1); expect(e.api.open).not.toHaveBeenCalled();
    expect(e.states.at(-1)).toBe("unavailable");
  });
  it.each(["unknown", "failed", "late"])("writer 4 (activated) answers %s: the window does not go on as opened", async kind => {
    const e = entry({ 3: { kind } });
    await e.controller.start(); await settle();
    expect(e.api.open).toHaveBeenCalledTimes(1);
    expect(e.states.at(-1)).toBe("unavailable");
  });
  // 6b (P3, QA): after "late" this page forgets its memory of the record — the next run reads the actual one.
  it("writer 3 answers late: the page forgets its installation (memory reset), no open", async () => {
    const e = entry({ 2: { kind: "late" } });
    await e.controller.start(); await settle();
    expect(e.api.open).not.toHaveBeenCalled();
    expect((e.controller as unknown as { installation: unknown }).installation).toBeNull();
  });
  // 6b (K2 of the store QA): a "current" (or "applied") given to a context that ended during the await is not used.
  it.each(["current", "applied"])("K2: writer 1 answers %s after the page was disposed during the await: no register, no open", async kind => {
    let controller!: EntryController;
    const e = entry({ 1: () => { controller.dispose(); return { kind, record: null, result: { profileId: P, ...ids, proof: "p", proofVersion: "1", activated: true } }; } });
    controller = e.controller;
    await e.controller.start(); await settle();
    expect(e.api.register).not.toHaveBeenCalled(); expect(e.api.open).not.toHaveBeenCalled();
    if (kind === "applied") expect((e.controller as unknown as { installation: unknown }).installation).toBeNull();
  });
  it("K2: writer 3 answers applied after the page was disposed: not used, and the memory of the record is forgotten", async () => {
    let controller!: EntryController;
    const e = entry({ 2: () => { controller.dispose(); return { kind: "applied", record: null, result: { profileId: P, ...ids, proof: "p", proofVersion: "1", activated: false } }; } });
    controller = e.controller;
    await e.controller.start(); await settle();
    expect(e.api.open).not.toHaveBeenCalled();
    expect((e.controller as unknown as { installation: unknown }).installation).toBeNull();
  });
  it("K2: writer 3 answers current after a new run began (another generation): no open", async () => {
    let controller!: EntryController;
    const e = entry({ 2: () => { (controller as unknown as { generation: number }).generation += 1;
      return { kind: "current", record: null, result: { profileId: P, ...ids, proof: "p", proofVersion: "1", activated: false } }; } });
    controller = e.controller;
    await e.controller.start(); await settle();
    expect(e.api.open).not.toHaveBeenCalled();
  });
});

describe("6b (P2-6B, QA RS1): no installation store given — fail-closed, no product fallback", () => {
  it("RS1: Entry without a store, a delayed storage set and a dispose meanwhile: no installation write at all, no register, no open", async () => {
    const compatibility = { compatible: true, contract_version: "1" };
    const profile = { profile_id: P, role: "user", ui_language: "ru", dictionary_language: "ru", time_zone: "UTC", state_version: "10",
      access: { status: "admitted", version: "1", reason: null } };
    const values = new Map<string, string>();
    let writes = 0, release: (() => void) | null = null;
    const storage: AsyncStorage = { get: async key => values.get(key) ?? null,
      set: async (key, value) => { if (key.startsWith("wortly.installation:")) { writes++; await new Promise<void>(r => { release = r; }); } values.set(key, value); },
      remove: async key => { values.delete(key); } };
    const api = { auth: vi.fn(async () => ({ access_token: "t", expires_at: "2026-10-17T00:00:00Z", profile, compatibility })),
      register: vi.fn(), open: vi.fn(), reapply: vi.fn() } as unknown as EntryApi;
    let n = 100;
    const controller = new EntryController({ gate: new WriteGate({ clock: new ManualClock() }), api, storage,
      lock: { acquire: vi.fn(async () => ({ release: vi.fn() })) }, initData: "signed", savedLanguage: "ru", browserLanguage: "ru",
      clientVersion: "0.0.0", contractVersion: "1", timeZone: () => "UTC", newId: () => `00000000-0000-4000-8000-${String(n++).padStart(12, "0")}`,
      onUpdate: () => undefined });
    const task = controller.start(); await settle();
    controller.dispose(); (release as (() => void) | null)?.(); await task; await settle();
    expect(writes).toBe(0);
    expect([...values.keys()].filter(key => key.startsWith("wortly.installation:"))).toEqual([]);
    expect(api.register).not.toHaveBeenCalled(); expect(api.open).not.toHaveBeenCalled();
  });
});
