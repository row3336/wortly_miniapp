import { describe, expect, it, vi } from "vitest";
import type { OpenedClient, Profile } from "../api/generated";
import { createOpenedAccess, type OpenedAccess } from "../app/openedAccess";
import type { AsyncStorage } from "../platform/storage";
import { createSettingsApi, KnownRefusal, type SettingKey } from "./settingsApi";
import { SettingsController } from "./settingsController";
import { SettingsPendingStore } from "./settingsPending";
import { settingsResponse } from "./settingsRead.test-support";
import { SettingsResetPendingStore } from "./settingsResetPending";
import { testGate } from "../commands/testGate.test-support";

// M-SETTINGS-KNOWN-REFUSAL (C082): the two exact refusals the core answers before any command handling, through the
// real SettingsApi and controller over a synthetic server.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const incompatible = { status: 409, body: { error: { code: "CLIENT_INCOMPATIBLE" } } };
const refused = { status: 422, body: { error: { code: "VALIDATION_FAILED" } } };
type Answer = { status: number; body: unknown } | "network";
const profile = (profileId = id(1)): Profile => ({ profile_id: profileId, access: { status: "admitted", version: "1", reason: null },
  role: "user", ui_language: "ru", dictionary_language: "uk", time_zone: "UTC", state_version: "1" });
const opened = (clientId = id(2), documentId = id(3)): OpenedClient => ({ status: "opened", client_instance_id: clientId, document_id: documentId,
  document_epoch: "1", proof_version: "1", profile: profile(), session: null, compatibility: { compatible: true, contract_version: "1" } });

// Command IDs never repeat within the file, as real ones never do: a known refusal is held per document in page
// memory, which one test file shares.
let sequence = 100;
function world(storage = memory()) {
  const data = settingsResponse();
  const posts: Array<Record<string, unknown>> = [];
  const postAnswers: Answer[] = [], statusAnswers: Answer[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const fact = (body: Record<string, unknown>, status: string) => {
    const { state_version, ...current } = structuredClone(data);
    const save = body.kind === "setting.save";
    return json({ command: { id: body.command_id, kind: body.kind, status, applied_at: "2026-10-09T00:00:00Z", target_id: id(1),
      action_id: null, result_id: null, context_id: null,
      object_version: save ? String(BigInt(body.expected_field_version as string) + 1n) : "7" }, current, state_version });
  };
  const answer = (next: Answer | undefined, fallback: () => Response) => {
    if (next === "network") throw new TypeError("network");
    return next ? json(next.body, next.status) : fallback();
  };
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/settings")) { const { ...current } = structuredClone(data); return json(current); }
    if (url.includes("/commands/")) {
      const commandId = url.split("/").at(-1)!;
      const sent = posts.find(post => post.command_id === commandId)!;
      const next = statusAnswers.shift();
      if (next !== undefined && next !== "network" && next.status === 200 && next.body === "applied") return fact(sent, "already_applied");
      return answer(next, () => json({ command: { id: commandId, status: "not_found" }, current: profile(), state_version: data.state_version }));
    }
    const body = JSON.parse(String(init!.body)); posts.push(body);
    return answer(postAnswers.shift(), () => fact(body, "applied"));
  });
  const api = createSettingsApi({ fetcher, timeoutMs: 1000, maxResponseBytes: 50000, gate: testGate() });
  let access: OpenedAccess | null = null;
  function open(data = opened(), generation = 1) {
    const handle: OpenedAccess = createOpenedAccess({ opened: data, token: `token-${generation}`, proof: `proof-${generation}`,
      generation, isLive: () => access === handle, onDenied: () => {} });
    access = handle;
    return handle;
  }
  open();
  const newId = vi.fn(() => id(sequence++));
  const make = () => new SettingsController({ api, pendingStore: new SettingsPendingStore(storage),
    resetStore: new SettingsResetPendingStore(storage), access: () => access, newId, onUpdate: () => {} });
  return { posts, postAnswers, statusAnswers, open, make, newId, storage };
}
function memory(): AsyncStorage {
  const values = new Map<string, string>();
  return { get: async key => values.get(key) ?? null, set: async (key, value) => { values.set(key, value); },
    remove: async key => { values.delete(key); } };
}
const commands = {
  reset: async (controller: SettingsController) => controller.reset(),
  save: async (controller: SettingsController) => { controller.edit("retry_count" as SettingKey, "4"); await controller.save("retry_count"); },
};

describe("known refusals of settings commands are not lost replies (C082)", () => {
  describe.each(Object.entries(commands))("%s", (_name, send) => {
    it.each([["incompatible", incompatible], ["command_refused", refused]] as const)(
      "%s: the attempt is refused, the intent stays checkable, nothing is unlocked and no useless repeat is offered", async (reason, reply) => {
        const w = world(); const c = w.make(); await c.refresh();
        w.postAnswers.push(reply); await send(c);
        const state = c.snapshot();
        expect(state.problem).toEqual({ reason, code: reply.body.error.code });
        expect(state).toMatchObject({ phase: "unresolved", canRetry: false, canEdit: false, canReset: false, outcome: null, resetOutcome: null });
        expect(state.pending ?? state.resetPending).not.toBeNull();
        await c.retry(); expect(w.posts).toHaveLength(1);
        // A later status check finding nothing neither erases the refusal nor brings the repeat back.
        await c.refresh();
        expect(c.snapshot()).toMatchObject({ problem: { reason, code: reply.body.error.code }, canRetry: false, canEdit: false });
        await c.retry(); expect(w.posts).toHaveLength(1);
        // A failing status read neither opens the repeat nor hides why it is closed (QA finding 1).
        w.statusAnswers.push("network"); await c.refresh();
        expect(c.snapshot()).toMatchObject({ problem: { reason, code: reply.body.error.code }, canRetry: false, canEdit: false });
        await c.retry(); expect(w.posts).toHaveLength(1);
      });

    it("the refusal does not leak into the next intent after the old one is found applied (QA probe, mutation M1)", async () => {
      const w = world(); const c = w.make(); await c.refresh();
      w.postAnswers.push(incompatible); await send(c);
      w.statusAnswers.push({ status: 200, body: "applied" }); await c.refresh();
      expect(c.snapshot()).toMatchObject({ phase: "ready", canEdit: true });
      w.postAnswers.push("network"); await send(c);
      expect(c.snapshot()).toMatchObject({ problem: { reason: "network" }, canRetry: true });
    });

    it("an earlier attempt found applied by the status check settles the intent normally", async () => {
      const w = world(); const c = w.make(); await c.refresh();
      w.postAnswers.push(incompatible); await send(c);
      w.statusAnswers.push({ status: 200, body: "applied" }); await c.refresh();
      const state = c.snapshot();
      expect(state).toMatchObject({ phase: "ready", pending: null, resetPending: null, problem: null, canEdit: true });
      expect((state.outcome ?? state.resetOutcome)?.status).toBe("accepted");
    });

    it("CLIENT_INCOMPATIBLE: a newer compatible client/open (a new live access handle) lifts it; the same ID may be repeated", async () => {
      const w = world(); const c = w.make(); await c.refresh();
      w.postAnswers.push(incompatible); await send(c);
      // The same document re-opened by Entry: a new handle under the same key (a new key means a new controller).
      w.open(opened(), 1); await c.refresh();
      expect(c.snapshot()).toMatchObject({ problem: { reason: "not_found" }, canRetry: true });
      await c.retry();
      expect(w.posts).toHaveLength(2); expect(w.posts[1].command_id).toBe(w.posts[0].command_id); expect(w.newId).toHaveBeenCalledOnce();
    });

    it("422: a compatible client/open does not prove the core accepts the payload, so the refusal stands", async () => {
      const w = world(); const c = w.make(); await c.refresh();
      w.postAnswers.push(refused); await send(c);
      w.open(opened(), 1); await c.refresh();
      expect(c.snapshot()).toMatchObject({ problem: { reason: "command_refused", code: "VALIDATION_FAILED" }, canRetry: false, canEdit: false });
      w.statusAnswers.push("network"); w.open(opened(), 1); await c.refresh();
      expect(c.snapshot()).toMatchObject({ problem: { reason: "command_refused" }, canRetry: false });
      await c.retry(); expect(w.posts).toHaveLength(1);
      // The earlier attempt found applied still settles the intent.
      w.statusAnswers.push({ status: 200, body: "applied" }); await c.refresh();
      expect(c.snapshot()).toMatchObject({ phase: "ready", pending: null, resetPending: null, canEdit: true });
    });

    it.each([["the same handle", 0], ["a newer handle under the same key", 1],
      ["a new generation, a new key (Entry retry)", 2]] as const)(
      "422 outlives a remount of the same document (%s): a new controller does not reopen the repeat (QA delta 2, finding 1)",
      async (_label, generation) => {
        const w = world(); const c = w.make(); await c.refresh();
        w.postAnswers.push(refused); await send(c);
        // ApplicationDocument remounts when Entry leaves `opened` and comes back (a newer handle, the same key), and a
        // new generation mounts it under a new key: either way a new controller of the same document.
        c.dispose(); if (generation) w.open(opened(), generation);
        const d = w.make(); await d.refresh();
        expect(d.snapshot()).toMatchObject({ problem: { reason: "command_refused", code: "VALIDATION_FAILED" }, canRetry: false, canEdit: false });
        await d.retry(); expect(w.posts).toHaveLength(1);
        w.statusAnswers.push("network"); d.dispose(); const e = w.make(); await e.refresh();
        expect(e.snapshot()).toMatchObject({ problem: { reason: "command_refused" }, canRetry: false });
        await e.retry(); expect(w.posts).toHaveLength(1);
        // The earlier attempt found applied still settles it, and the next intent starts with no hold.
        w.statusAnswers.push({ status: 200, body: "applied" }); await e.refresh();
        expect(e.snapshot()).toMatchObject({ phase: "ready", pending: null, resetPending: null, canEdit: true });
        e.dispose(); const f = w.make(); await f.refresh();
        w.postAnswers.push("network"); await send(f);
        expect(f.snapshot()).toMatchObject({ problem: { reason: "network" }, canRetry: true });
      });

    it.each([1, 2])("CLIENT_INCOMPATIBLE outlives a remount on the same handle and is lifted only by a newer one (generation %i)", async generation => {
      const w = world(); const c = w.make(); await c.refresh();
      w.postAnswers.push(incompatible); await send(c); c.dispose();
      const d = w.make(); await d.refresh();
      expect(d.snapshot()).toMatchObject({ problem: { reason: "incompatible" }, canRetry: false });
      await d.retry(); expect(w.posts).toHaveLength(1);
      d.dispose(); w.open(opened(), generation); const e = w.make(); await e.refresh();
      expect(e.snapshot()).toMatchObject({ problem: { reason: "not_found" }, canRetry: true });
    });

    it("a reload is a new document: a field save's 422 kept with its record still holds (R2-09 / K19-024); a reset gets one attempt", async () => {
      const storage = memory(); const w = world(storage); const c = w.make(); await c.refresh();
      w.postAnswers.push(refused); await send(c); c.dispose();
      // Entry gives a reloaded page a new document ID (app/entryController.ts); the stored intent is the same.
      w.open(opened(id(2), id(4)), 2); const d = w.make(); await d.refresh();
      if (_name === "save") {
        expect(d.snapshot()).toMatchObject({ problem: { reason: "command_refused", code: "VALIDATION_FAILED" }, canRetry: false,
          canEdit: false, canCancelStored: true });
        await d.retry(); expect(w.posts).toHaveLength(1);
        await d.refresh(); await d.retry(); expect(w.posts).toHaveLength(1);
        return;
      }
      // The reset keeps its earlier behaviour here (its own cancel, R8-05, is a separate step).
      expect(d.snapshot()).toMatchObject({ problem: { reason: "not_found" }, canRetry: true });
      w.postAnswers.push(refused); await d.retry();
      expect(w.posts).toHaveLength(2); expect(w.posts[1].command_id).toBe(w.posts[0].command_id);
      expect(d.snapshot()).toMatchObject({ problem: { reason: "command_refused" }, canRetry: false });
      await d.refresh(); await d.retry(); expect(w.posts).toHaveLength(2);
    });

    it("another installation or another profile keeps every restriction", async () => {
      const storage = memory(); const w = world(storage); const c = w.make(); await c.refresh();
      w.postAnswers.push(incompatible); await send(c); c.dispose();
      const other = world(storage); other.open(opened(id(9))); const d = other.make(); await d.refresh();
      expect(d.snapshot()).toMatchObject({ problem: { reason: "client_changed" }, canRetry: false, canEdit: false });
      await d.retry(); expect(other.posts).toHaveLength(0);
      // Another profile never sees or repeats it: its load drops the earlier profile's record (TA §9).
      d.dispose(); const third = world(storage); third.open({ ...opened(), profile: profile(id(8)) });
      const e = third.make(); await e.refresh();
      expect(e.snapshot()).toMatchObject({ pending: null, resetPending: null, canRetry: false });
      await e.retry(); expect(third.posts).toHaveLength(0);
    });

    it("a status reply naming another profile is not trusted and does not reopen the repeat", async () => {
      const w = world(); const c = w.make(); await c.refresh();
      w.postAnswers.push(incompatible); await send(c);
      w.statusAnswers.push({ status: 200, body: { command: { id: w.posts[0].command_id, status: "not_found" }, current: profile(id(8)), state_version: "1" } });
      await c.refresh();
      expect(c.snapshot()).toMatchObject({ canRetry: false, canEdit: false });
      await c.retry(); expect(w.posts).toHaveLength(1);
    });

    it.each([["network", "network" as Answer], ["maintenance", { status: 503, body: { error: { code: "MAINTENANCE" } } } as Answer]])(
      "%s gets no lasting ban: the repeat stays available and succeeds", async (_label, failure) => {
        const w = world(); const c = w.make(); await c.refresh();
        w.postAnswers.push(failure); await send(c);
        expect(c.snapshot()).toMatchObject({ problem: { reason: "network" }, canRetry: true });
        await c.retry();
        expect(w.posts).toHaveLength(2);
        expect(c.snapshot()).toMatchObject({ phase: "ready", pending: null, resetPending: null });
      });
  });

  it.each([
    { status: 409, body: { error: { code: "CLIENT_INCOMPATIBLE", detail: "x" } } },
    { status: 409, body: { error: { code: "CLIENT_INCOMPATIBLE" }, extra: true } },
    { status: 409, body: { error: { code: "VERSION_CONFLICT" } } },
    { status: 422, body: { error: { code: "VALIDATION_FAILED" }, current: null } },
    { status: 422, body: { error: { code: "SOMETHING_ELSE" } } },
    { status: 400, body: { error: { code: "VALIDATION_FAILED" } } },
    { status: 200, body: { error: { code: "CLIENT_INCOMPATIBLE" } } },
  ])("only the exact forms are known refusals; %# stays a plain error with the usual repeat", async reply => {
    const w = world(); const c = w.make(); await c.refresh();
    w.postAnswers.push(reply); await c.reset();
    expect(c.snapshot()).toMatchObject({ problem: { reason: "network" }, canRetry: true });
  });

  it("the api names the two refusals and nothing else", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(incompatible.body), { status: 409 }));
    const api = createSettingsApi({ fetcher, timeoutMs: 1000, maxResponseBytes: 20000, gate: testGate() });
    const command = { command_id: id(1), kind: "settings.reset" as const, client_instance_id: id(2), document_id: id(3), payload: {} };
    const error = await api.reset("t", "p", id(1), command).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(KnownRefusal);
    expect(error).toMatchObject({ refusal: "incompatible", kind: "http", status: 409, code: "CLIENT_INCOMPATIBLE" });
  });
});
