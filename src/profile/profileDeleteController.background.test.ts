import { describe, expect, it, vi } from "vitest";
import type { Profile } from "../api/generated";
import type { OpenedAccess } from "../app/openedAccess";
import { MAX_SENDS } from "../commands/recoveryLimits";
import { WriteGate } from "../commands/writeGate";
import { ManualClock } from "../commands/writeGate.test-support";
import { createProfileDeleteApi, type ProfileCheckReply, type ProfileDeleteApi, type ProfileDeleteReply } from "./profileDeleteApi";
import { CONFIRM_DELAY_MS, ProfileDeleteController, type DeletionEnd } from "./profileDeleteController";
import { memoryStorage } from "./profileStorage.test-support";

/**
 * P04 ред.15 §3.7 / PD-21a, P03 N3 [ВЛ] and the criterion C365/C366: no automatic request leaves while the page is
 * hidden or the window is closed; after the return the result is checked first (GET /settings of the same session), and
 * only then the rest of the budget goes on with the same command_id; the last guard before fetch checks the owner of
 * the norm. Also the classes only a real transport proves: 500 on a repeat, 408, a failed check read.
 */
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const X = id(50), Y = id(60);
const profileOf = (profileId: string): Profile => ({ profile_id: profileId, role: "user", ui_language: "ru",
  dictionary_language: "ru", time_zone: "UTC", state_version: "1", access: { status: "admitted", version: "1", reason: null } });
const credentials = { token: "token", proof: "proof", clientInstanceId: id(1), documentId: id(2) };
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const applied = (commandId: string) => json({
  command: { id: commandId, kind: "profile.delete", status: "already_applied", applied_at: "2026-10-16T10:00:00Z" },
  deletion: { request_id: id(900), working_data: "deleted", archive: "pending", archive_deadline: "2026-10-23T10:00:00Z", fully_deleted: false },
  session: "revoked" });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

type Hook = (read: number) => void | Promise<void>;
function harness(api: ProfileDeleteApi, gate: WriteGate, clock: ManualClock, onCredentials?: Hook) {
  const ended: DeletionEnd[] = [];
  let changed: (() => void) | null = null;
  let hidden = false, reads = 0;
  // A dynamic access, as the entry gives it: a foreground replaces it with a new object, and the old one stops being live.
  const accessOf = (p: Profile, documentId = id(2), token = "token"): OpenedAccess & { alive: { value: boolean } } => {
    const alive = { value: true };
    return { key: `${p.profile_id}:${documentId}`, profile: p, session: null, alive,
      document: { clientInstanceId: id(1), documentId, epoch: "1" }, isLive: () => alive.value,
      run: async operation => {
        await onCredentials?.(++reads);
        if (!alive.value) throw new Error("closed_access");
        return operation({ ...credentials, token, documentId });
      } };
  };
  let current: (OpenedAccess & { alive: { value: boolean } }) | null = accessOf(profileOf(X));
  const { storage, values } = memoryStorage({ [`wortly.installation:${X}`]: "{}" });
  const controller = new ProfileDeleteController({ api, access: () => current, gate, storage, clock, newId: () => id(101),
    onUpdate: () => undefined, onEnded: end => ended.push(end), pageVisible: () => !hidden,
    onPageChange: listener => { changed = listener; return () => { changed = null; }; } });
  /** The App: the document is hidden / shown — the gate is told as the App tells it, then the page event. */
  const hide = async () => { hidden = true; gate.setVisible(false); changed?.(); await clock.advanceBy(0); await settle(); };
  const show = async () => { hidden = false; gate.setVisible(true); changed?.(); await clock.advanceBy(0); await settle(); };
  return { controller, ended, values, hide, show, pageEvent: () => changed?.(), listening: () => changed !== null,
    hideNow: () => { hidden = true; gate.setVisible(false); }, switchTo: (p: string | null) => { current = p ? accessOf(profileOf(p)) : null; },
    /** The foreground of the entry: the old access dies at once; the new one (same document unless told) comes later. */
    killAccess: () => { if (current) current.alive.value = false; },
    replaceAccess: (options: { documentId?: string; token?: string; profileId?: string } = {}) => {
      if (current) current.alive.value = false;
      current = accessOf(profileOf(options.profileId ?? X), options.documentId ?? id(2), options.token ?? "token");
      controller.accessChanged();
    } };
}
async function confirm(controller: ProfileDeleteController, clock: ManualClock) {
  controller.open();
  await clock.advanceBy(CONFIRM_DELAY_MS);
  controller.confirm();
  await settle();
}
function fakeApi(replies: ProfileDeleteReply[], checks: ProfileCheckReply[] = []) {
  const sent: string[] = [];
  const api: ProfileDeleteApi = {
    delete: vi.fn(async (_credentials, intent): Promise<ProfileDeleteReply> => { sent.push(intent.commandId); return replies.shift() ?? { outcome: "unknown" }; }),
    check: vi.fn(async (): Promise<ProfileCheckReply> => checks.shift() ?? "unknown"),
  };
  return { api, sent };
}

describe("the background (P03 N3): hidden — nothing is sent; shown — the result first, then the rest of the budget", () => {
  it("a lost answer, hidden for a minute: no request; shown: one GET, alive → the same command_id → deleted", async () => {
    const clock = new ManualClock(), gate = new WriteGate({ clock });
    const f = fakeApi([{ outcome: "unknown" }, { outcome: "applied", status: "already_applied" }], ["not_deleted"]);
    const t = harness(f.api, gate, clock);
    await confirm(t.controller, clock);
    expect(f.sent).toEqual([id(101)]);
    await t.hide();
    await clock.advanceBy(60_000); await settle();
    expect(f.sent).toEqual([id(101)]);
    expect(f.api.check).not.toHaveBeenCalled();
    await t.show();
    expect(f.api.check).toHaveBeenCalledTimes(1);
    expect(f.sent).toEqual([id(101), id(101)]);
    expect(t.ended).toEqual([{ kind: "deleted" }]);
  });

  it("the check after the return says PROFILE_DELETED: applied without a new POST, the records of X go", async () => {
    const clock = new ManualClock(), gate = new WriteGate({ clock });
    const f = fakeApi([{ outcome: "unknown" }], ["deleted"]);
    const t = harness(f.api, gate, clock);
    await confirm(t.controller, clock);
    await t.hide(); await clock.advanceBy(10_000); await t.show();
    expect(f.sent).toEqual([id(101)]);
    expect(t.ended).toEqual([{ kind: "deleted" }]);
    expect(t.values.has(`wortly.installation:${X}`)).toBe(false);
  });

  it("the check after the return answers PROFILE_DELETED only after the screen was left: still applied, X cleared", async () => {
    const clock = new ManualClock(), gate = new WriteGate({ clock });
    const f = fakeApi([{ outcome: "unknown" }]);
    const answer = deferred<ProfileCheckReply>();
    f.api.check = vi.fn(() => answer.promise);
    const t = harness(f.api, gate, clock);
    await confirm(t.controller, clock);
    await t.hide(); await clock.advanceBy(10_000); await t.show();
    expect(f.api.check).toHaveBeenCalledTimes(1);
    t.controller.dispose();
    answer.resolve("deleted");
    await settle();
    expect(f.sent).toEqual([id(101)]);
    expect(t.ended).toEqual([{ kind: "deleted" }]);
    expect(t.values.has(`wortly.installation:${X}`)).toBe(false);
  });

  it.each(["not_deleted", "auth", "unknown"] as const)(
    "the check after the return answers %s only after the screen was left: nothing more (no POST, no end)", async reply => {
      const clock = new ManualClock(), gate = new WriteGate({ clock });
      const f = fakeApi([{ outcome: "unknown" }]);
      const answer = deferred<ProfileCheckReply>();
      f.api.check = vi.fn(() => answer.promise);
      const t = harness(f.api, gate, clock);
      await confirm(t.controller, clock);
      await t.hide(); await clock.advanceBy(10_000); await t.show();
      t.controller.dispose();
      answer.resolve(reply);
      await settle(); await clock.advanceBy(60_000); await settle();
      expect(f.sent).toEqual([id(101)]);
      expect(t.ended).toEqual([]);
      expect(t.values.has(`wortly.installation:${X}`)).toBe(true);
    });

  it("the check after the return says AUTH_*: «исход неизвестен» (PD-28), no POST, no sign-in", async () => {
    const clock = new ManualClock(), gate = new WriteGate({ clock });
    const f = fakeApi([{ outcome: "unknown" }], ["auth"]);
    const t = harness(f.api, gate, clock);
    await confirm(t.controller, clock);
    await t.hide(); await clock.advanceBy(10_000); await t.show();
    expect(f.sent).toEqual([id(101)]);
    expect(t.ended).toEqual([{ kind: "unknown", confirmedProfileId: X }]);
  });

  it("a failed check decides nothing: no POST; the next look after 5 s, and not while hidden", async () => {
    const clock = new ManualClock(), gate = new WriteGate({ clock });
    const f = fakeApi([{ outcome: "unknown" }, { outcome: "applied", status: "already_applied" }], ["unknown", "not_deleted"]);
    const t = harness(f.api, gate, clock);
    await confirm(t.controller, clock);
    await t.hide(); await clock.advanceBy(10_000); await t.show();
    expect(f.api.check).toHaveBeenCalledTimes(1);
    expect(f.sent).toEqual([id(101)]);
    await t.hide();
    await clock.advanceBy(60_000); await settle();
    expect(f.api.check).toHaveBeenCalledTimes(1);
    await t.show();
    expect(f.api.check).toHaveBeenCalledTimes(2);
    expect(f.sent).toEqual([id(101), id(101)]);
    expect(t.ended).toEqual([{ kind: "deleted" }]);
  });

  it("the return continues the rest of the budget: never more than MAX_SENDS of the one command_id, the check outside it", async () => {
    const clock = new ManualClock(), gate = new WriteGate({ clock });
    const f = fakeApi([], ["not_deleted"]);
    const t = harness(f.api, gate, clock);
    await confirm(t.controller, clock);
    await clock.advanceBy(2_000); await settle();
    await clock.advanceBy(5_000); await settle();
    expect(f.sent).toHaveLength(3);
    await t.hide();
    await clock.advanceBy(600_000); await settle();
    expect(f.sent).toHaveLength(3);
    await t.show();
    expect(f.sent).toHaveLength(4);
    for (let i = 0; i < 10; i++) { await clock.advanceBy(30_000); await settle(); }
    expect(f.sent).toEqual(Array(MAX_SENDS).fill(id(101)));
    expect(f.api.check).toHaveBeenCalledTimes(1);
    expect(t.controller.snapshot().phase).toBe("stuck");
  });

  it("hidden and shown before the pause ran out: the check and the POST at the end of the pause, not earlier, not later", async () => {
    const clock = new ManualClock(), gate = new WriteGate({ clock });
    const f = fakeApi([{ outcome: "unknown" }, { outcome: "applied", status: "already_applied" }], ["not_deleted"]);
    const t = harness(f.api, gate, clock);
    await confirm(t.controller, clock);
    await clock.advanceBy(500); await t.hide();
    await clock.advanceBy(500); await t.show();
    expect(f.api.check).not.toHaveBeenCalled();
    await clock.advanceBy(999); await settle();
    expect(f.sent).toHaveLength(1);
    await clock.advanceBy(1); await settle();
    expect(f.api.check).toHaveBeenCalledTimes(1);
    expect(f.sent).toEqual([id(101), id(101)]);
  });

  it("a pause that ran out in the background is not waited again: the check right on the return", async () => {
    const clock = new ManualClock(), gate = new WriteGate({ clock });
    const f = fakeApi([{ outcome: "unknown" }, { outcome: "applied", status: "already_applied" }], ["not_deleted"]);
    const t = harness(f.api, gate, clock);
    await confirm(t.controller, clock);
    await t.hide(); await clock.advanceBy(30_000);
    await t.show();
    expect(f.sent).toEqual([id(101), id(101)]);
  });

  it("REAL transport: the client's own timeout leaves the gate open (RD-2); hidden — no request; shown — GET, then the same ID", async () => {
    const clock = new ManualClock(), gate = new WriteGate({ clock });
    const posts: string[] = [], gets: string[] = [];
    const fetcher = vi.fn<typeof fetch>((url, init) => {
      if (init?.method === "GET") { gets.push(String(url)); return Promise.resolve(json({ state_version: "2" })); }
      const commandId = JSON.parse(String(init?.body)).command_id as string;
      posts.push(commandId);
      if (posts.length > 1) return Promise.resolve(applied(commandId));
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    });
    const t = harness(createProfileDeleteApi({ fetcher, timeoutMs: 20, maxResponseBytes: 100000, gate }), gate, clock);
    await confirm(t.controller, clock);
    await new Promise(resolve => setTimeout(resolve, 60)); await settle();
    expect(posts).toHaveLength(1);
    expect(gate.mayWrite()).toBe(true);
    await t.hide();
    await clock.advanceBy(60_000); await settle();
    expect(posts).toHaveLength(1);
    expect(gets).toEqual([]);
    await t.show();
    expect(gets).toEqual(["/api/v1/settings"]);
    expect(posts).toEqual([id(101), id(101)]);
    expect(t.ended).toEqual([{ kind: "deleted" }]);
  });

  it("a closed window (closedWindow): no request is ever sent, shown or not", async () => {
    const clock = new ManualClock(), gate = new WriteGate({ clock });
    const f = fakeApi([{ outcome: "unknown" }], ["not_deleted"]);
    const t = harness(f.api, gate, clock);
    await confirm(t.controller, clock);
    gate.closeWindow();
    for (let i = 0; i < 10; i++) { await clock.advanceBy(30_000); await settle(); }
    await t.hide(); await t.show();
    expect(f.sent).toEqual([id(101)]);
    expect(f.api.check).not.toHaveBeenCalled();
    expect(t.controller.snapshot()).toMatchObject({ canConfirm: false, canCheck: false });
  });

  it("two page events on the return make one check and one request", async () => {
    const clock = new ManualClock(), gate = new WriteGate({ clock });
    const f = fakeApi([{ outcome: "unknown" }, { outcome: "applied", status: "already_applied" }], ["not_deleted", "not_deleted"]);
    const t = harness(f.api, gate, clock);
    await confirm(t.controller, clock);
    await t.hide(); await clock.advanceBy(10_000);
    t.pageEvent(); t.pageEvent();
    await t.show(); t.pageEvent();
    await clock.advanceBy(0); await settle();
    expect(f.api.check).toHaveBeenCalledTimes(1);
    expect(f.sent).toEqual([id(101), id(101)]);
  });

  it("left while hidden (dispose; a reload is a new page): the return sends and reads nothing (Q-DEL-4)", async () => {
    const clock = new ManualClock(), gate = new WriteGate({ clock });
    const f = fakeApi([{ outcome: "unknown" }], ["not_deleted"]);
    const t = harness(f.api, gate, clock);
    await confirm(t.controller, clock);
    await t.hide(); await clock.advanceBy(10_000); await settle();
    expect(t.listening()).toBe(true);
    t.controller.dispose();
    expect(t.listening()).toBe(false);
    await t.show();
    await clock.advanceBy(120_000); await settle();
    expect(f.sent).toEqual([id(101)]);
    expect(f.api.check).not.toHaveBeenCalled();
    expect(clock.pending()).toBe(0);
  });
});

describe("the last guard right before fetch (C366): the owner of the norm, not only the page", () => {
  type Change = "dispose" | "profile" | "no_access" | "closed_window" | "hidden";
  const changes: Change[] = ["dispose", "profile", "no_access", "closed_window", "hidden"];

  it.each(changes)("the tap: the credentials are held, then %s — no POST", async change => {
    const clock = new ManualClock(), gate = new WriteGate({ clock });
    const f = fakeApi([{ outcome: "applied", status: "applied" }]);
    const hold = deferred<void>();
    const t = harness(f.api, gate, clock, read => read === 1 ? hold.promise : undefined);
    t.controller.open();
    await clock.advanceBy(CONFIRM_DELAY_MS);
    t.controller.confirm();
    await settle();
    if (change === "dispose") t.controller.dispose();
    if (change === "profile") t.switchTo(Y);
    if (change === "no_access") t.switchTo(null);
    if (change === "closed_window") gate.closeWindow();
    if (change === "hidden") t.hideNow();
    hold.resolve();
    await settle();
    // Even the user's own tap does not leave from a hidden page: the question stays, nothing is queued.
    expect(f.sent).toEqual([]);
    if (change === "profile") expect(t.controller.snapshot().phase).toBe("idle");
    // No live access just now (a foreground replacing it): the question stays, nothing is queued.
    if (change === "no_access") expect(t.controller.snapshot()).toMatchObject({ phase: "asking", paused: true });
    if (change === "closed_window") expect(t.controller.snapshot()).toMatchObject({ phase: "asking", paused: true, canConfirm: false });
    if (change === "hidden") {
      expect(t.controller.snapshot()).toMatchObject({ phase: "asking", paused: true });
      await t.show();
      expect(f.sent).toEqual([]);
      t.controller.confirm();
      await settle();
      expect(f.sent).toEqual([id(101)]);
    }
  });

  it.each(changes)("an automatic repeat: the credentials are held, then %s — no POST, no budget spent", async change => {
    const clock = new ManualClock(), gate = new WriteGate({ clock });
    const f = fakeApi([{ outcome: "unknown" }, { outcome: "applied", status: "applied" }], ["not_deleted"]);
    const hold = deferred<void>();
    const t = harness(f.api, gate, clock, read => read === 2 ? hold.promise : undefined);
    await confirm(t.controller, clock);
    await clock.advanceBy(2_000); await settle();
    expect(f.sent).toEqual([id(101)]);
    if (change === "dispose") t.controller.dispose();
    if (change === "profile") t.switchTo(Y);
    if (change === "no_access") t.switchTo(null);
    if (change === "closed_window") gate.closeWindow();
    if (change === "hidden") t.hideNow();
    hold.resolve();
    await settle();
    await clock.advanceBy(60_000); await settle();
    expect(f.sent).toEqual([id(101)]);
    if (change === "hidden") {
      // Shown again: the result first, then the same ID, once (the held attempt spent nothing).
      await t.show();
      expect(f.api.check).toHaveBeenCalledTimes(1);
      expect(f.sent).toEqual([id(101), id(101)]);
    }
  });
});

describe("«Проверить» and the live access (P3 QA fix3)", () => {
  it("no live access of the document: the button is inactive; the new access of the same document makes it active", async () => {
    const clock = new ManualClock(), gate = new WriteGate({ clock });
    const f = fakeApi([], ["not_deleted"]);
    const t = harness(f.api, gate, clock);
    await confirm(t.controller, clock);
    for (let i = 0; i < 10; i++) { await clock.advanceBy(30_000); await settle(); }
    expect(t.controller.snapshot()).toMatchObject({ phase: "stuck", canCheck: true });
    t.killAccess();
    expect(t.controller.snapshot().canCheck).toBe(false);
    t.controller.check();
    await settle();
    expect(f.api.check).not.toHaveBeenCalled();
    t.replaceAccess();
    await clock.advanceBy(0); await settle();
    expect(t.controller.snapshot().canCheck).toBe(true);
    t.controller.check();
    await settle();
    expect(f.api.check).toHaveBeenCalledTimes(1);
    expect(t.controller.snapshot().phase).toBe("not_deleted");
  });
});

describe("classes a real transport proves (§3.7)", () => {
  const readyProbe = async () => ({ status: "ready" as const });

  it("a lost answer, then 500 INTERNAL_ERROR on the repeat: unknown, repeated with the same command_id until already_applied", async () => {
    const clock = new ManualClock(), gate = new WriteGate({ clock, probe: readyProbe });
    const posts: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const commandId = JSON.parse(String(init?.body)).command_id as string;
      posts.push(commandId);
      if (posts.length === 1) throw new TypeError("offline");
      if (posts.length === 2) return json({ error: { code: "INTERNAL_ERROR", diagnostic_id: "d" } }, 500);
      return applied(commandId);
    });
    const t = harness(createProfileDeleteApi({ fetcher, timeoutMs: 1000, maxResponseBytes: 100000, gate }), gate, clock);
    await confirm(t.controller, clock);
    for (let i = 0; i < 8; i++) { await clock.advanceBy(10_000); await settle(); }
    expect(posts).toEqual([id(101), id(101), id(101)]);
    expect(t.ended).toEqual([{ kind: "deleted" }]);
    expect(t.values.has(`wortly.installation:${X}`)).toBe(false);
  });

  it("a defect code on the repeat, then the check read fails on the network: unknown (PD-28), never «not deleted», no POST more", async () => {
    const clock = new ManualClock(), gate = new WriteGate({ clock, probe: readyProbe });
    const posts: string[] = [], reads: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      if (init?.method === "GET") { reads.push(String(url)); throw new TypeError("offline"); }
      posts.push(JSON.parse(String(init?.body)).command_id);
      if (posts.length === 1) throw new TypeError("offline");
      return json({ error: { code: "VALIDATION_FAILED" } }, 422);
    });
    const t = harness(createProfileDeleteApi({ fetcher, timeoutMs: 1000, maxResponseBytes: 100000, gate }), gate, clock);
    await confirm(t.controller, clock);
    for (let i = 0; i < 8; i++) { await clock.advanceBy(10_000); await settle(); }
    expect(posts).toEqual([id(101), id(101)]);
    expect(reads).toEqual(["/api/v1/settings"]);
    expect(t.ended).toEqual([{ kind: "unknown", confirmedProfileId: X }]);
    expect(t.controller.snapshot().phase).not.toBe("not_deleted");
    expect(t.values.has(`wortly.installation:${X}`)).toBe(true);
  });

  it("408 is a lost answer, not a defect: the same command_id is repeated", async () => {
    const clock = new ManualClock(), gate = new WriteGate({ clock, probe: readyProbe });
    const posts: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const commandId = JSON.parse(String(init?.body)).command_id as string;
      posts.push(commandId);
      return posts.length === 1 ? json({ error: { code: "REQUEST_TIMEOUT" } }, 408) : applied(commandId);
    });
    const t = harness(createProfileDeleteApi({ fetcher, timeoutMs: 1000, maxResponseBytes: 100000, gate }), gate, clock);
    await confirm(t.controller, clock);
    for (let i = 0; i < 4; i++) { await clock.advanceBy(10_000); await settle(); }
    expect(posts).toEqual([id(101), id(101)]);
    expect(t.ended).toEqual([{ kind: "deleted" }]);
  });

  it("the budget: after MAX_SENDS «Проверить» is one GET outside it; «not deleted» ends the intent, no POST of that ID after", async () => {
    const clock = new ManualClock(), gate = new WriteGate({ clock });
    const f = fakeApi([], ["not_deleted"]);
    const t = harness(f.api, gate, clock);
    await confirm(t.controller, clock);
    for (let i = 0; i < 10; i++) { await clock.advanceBy(30_000); await settle(); }
    expect(f.sent).toHaveLength(MAX_SENDS);
    t.controller.check();
    await settle();
    expect(f.api.check).toHaveBeenCalledTimes(1);
    expect(t.controller.snapshot().phase).toBe("not_deleted");
    for (let i = 0; i < 10; i++) { await clock.advanceBy(30_000); await settle(); }
    await t.hide(); await t.show();
    expect(f.sent).toHaveLength(MAX_SENDS);
  });
});

describe("the default page source is the document", () => {
  it("document hidden: no request; visibilitychange back to visible: the check, then the same command_id", async () => {
    let state: DocumentVisibilityState = "visible";
    const spy = vi.spyOn(document, "visibilityState", "get").mockImplementation(() => state);
    try {
      const clock = new ManualClock(), gate = new WriteGate({ clock });
      const f = fakeApi([{ outcome: "unknown" }, { outcome: "applied", status: "already_applied" }], ["not_deleted"]);
      const access: OpenedAccess = { key: `${X}:doc`, profile: profileOf(X), session: null,
        document: { clientInstanceId: id(1), documentId: id(2), epoch: "1" }, isLive: () => true, run: async op => op(credentials) };
      const controller = new ProfileDeleteController({ api: f.api, access: () => access, gate, storage: memoryStorage().storage,
        clock, newId: () => id(101), onUpdate: () => undefined, onEnded: () => undefined });
      await confirm(controller, clock);
      state = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
      await clock.advanceBy(60_000); await settle();
      expect(f.sent).toEqual([id(101)]);
      state = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
      await clock.advanceBy(0); await settle();
      expect(f.api.check).toHaveBeenCalledTimes(1);
      expect(f.sent).toEqual([id(101), id(101)]);
      controller.dispose();
    } finally { spy.mockRestore(); }
  });
});

describe("the access replaced by a foreground of the same document (P2-2, C375)", () => {
  it("the return: the old access dies, the new one of the same document comes later — GET, then the same ID, deleted", async () => {
    const clock = new ManualClock(), gate = new WriteGate({ clock });
    const f = fakeApi([{ outcome: "unknown" }, { outcome: "applied", status: "already_applied" }], ["not_deleted"]);
    const t = harness(f.api, gate, clock);
    await confirm(t.controller, clock);
    await t.hide(); await clock.advanceBy(10_000);
    // The App's foreground starts with the page event: the old access is no longer live before the new one is given.
    t.killAccess();
    await t.show();
    expect(f.api.check).not.toHaveBeenCalled();
    expect(t.controller.snapshot()).toMatchObject({ phase: "waiting", repeating: true, droppedUnknown: false });
    await clock.advanceBy(1_500); await settle();
    t.replaceAccess();
    await clock.advanceBy(0); await settle();
    expect(f.api.check).toHaveBeenCalledTimes(1);
    expect(f.sent).toEqual([id(101), id(101)]);
    expect(t.ended).toEqual([{ kind: "deleted" }]);
  });

  it("the return: the access is replaced on the await of the credentials (the race) — waited for, not dropped", async () => {
    const clock = new ManualClock(), gate = new WriteGate({ clock });
    const f = fakeApi([{ outcome: "unknown" }, { outcome: "applied", status: "already_applied" }], ["not_deleted"]);
    let t!: ReturnType<typeof harness>;
    // read 2 = the return check: the foreground kills the old access exactly while the credentials are read.
    t = harness(f.api, gate, clock, read => { if (read === 2) t.killAccess(); });
    await confirm(t.controller, clock);
    await t.hide(); await clock.advanceBy(10_000); await t.show();
    expect(f.api.check).not.toHaveBeenCalled();
    expect(t.controller.snapshot().phase).toBe("waiting");
    t.replaceAccess();
    await clock.advanceBy(0); await settle();
    expect(f.api.check).toHaveBeenCalledTimes(1);
    expect(f.sent).toEqual([id(101), id(101)]);
  });

  it("the repeat (not a return): the access is replaced right before fetch — the same ID once, with the new access", async () => {
    const clock = new ManualClock(), gate = new WriteGate({ clock });
    const f = fakeApi([{ outcome: "unknown" }, { outcome: "applied", status: "already_applied" }]);
    let t!: ReturnType<typeof harness>;
    t = harness(f.api, gate, clock, read => { if (read === 2) t.killAccess(); });
    await confirm(t.controller, clock);
    await clock.advanceBy(2_000); await settle();
    expect(f.sent).toEqual([id(101)]);
    t.replaceAccess();
    await clock.advanceBy(0); await settle();
    expect(f.sent).toEqual([id(101), id(101)]);
    expect(t.ended).toEqual([{ kind: "deleted" }]);
  });

  it("the repeat is due while no access is live (the foreground still running): it waits, then the same ID with the new access", async () => {
    const clock = new ManualClock(), gate = new WriteGate({ clock });
    const f = fakeApi([{ outcome: "unknown" }, { outcome: "applied", status: "already_applied" }]);
    const t = harness(f.api, gate, clock);
    await confirm(t.controller, clock);
    t.killAccess();
    await clock.advanceBy(2_000); await settle();
    expect(f.sent).toEqual([id(101)]);
    expect(t.controller.snapshot()).toMatchObject({ phase: "waiting", droppedUnknown: false });
    t.replaceAccess();
    await clock.advanceBy(0); await settle();
    expect(f.sent).toEqual([id(101), id(101)]);
    expect(t.ended).toEqual([{ kind: "deleted" }]);
  });

  it("repeated page events and access changes while waiting make one GET and one POST", async () => {
    const clock = new ManualClock(), gate = new WriteGate({ clock });
    const f = fakeApi([{ outcome: "unknown" }, { outcome: "applied", status: "already_applied" }], ["not_deleted", "not_deleted"]);
    const t = harness(f.api, gate, clock);
    await confirm(t.controller, clock);
    await t.hide(); await clock.advanceBy(10_000);
    t.killAccess();
    await t.show(); t.pageEvent(); t.pageEvent();
    t.replaceAccess(); t.controller.accessChanged(); t.pageEvent();
    await clock.advanceBy(0); await settle();
    t.pageEvent(); t.controller.accessChanged();
    await clock.advanceBy(0); await settle();
    expect(f.api.check).toHaveBeenCalledTimes(1);
    expect(f.sent).toEqual([id(101), id(101)]);
  });

  it.each([["another document", { documentId: id(3) }], ["another profile", { profileId: Y }], ["another sign-in", { token: "token-2" }]] as const)(
    "a new access of %s: the intent is not moved — 0 POST, 0 GET, the screen says the outcome is unknown", async (_name, change) => {
      const clock = new ManualClock(), gate = new WriteGate({ clock });
      const f = fakeApi([{ outcome: "unknown" }, { outcome: "applied", status: "applied" }], ["not_deleted"]);
      const t = harness(f.api, gate, clock);
      await confirm(t.controller, clock);
      await t.hide(); await clock.advanceBy(10_000);
      t.killAccess();
      await t.show();
      t.replaceAccess(change);
      await clock.advanceBy(0); await settle();
      await clock.advanceBy(120_000); await settle();
      expect(f.sent).toEqual([id(101)]);
      // A new sign-in is only seen at its credentials: no request leaves with them either.
      expect(f.api.check).not.toHaveBeenCalled();
      expect(t.controller.snapshot()).toMatchObject({ phase: "idle", droppedUnknown: true, canOpen: true });
    });

  it("V6: 503 WRITE_UNAVAILABLE on the first attempt, then AUTH_* on the return check: not done (expired), not PD-28", async () => {
    const clock = new ManualClock(), gate = new WriteGate({ clock });
    const f = fakeApi([{ outcome: "write_unavailable" }], ["auth"]);
    const t = harness(f.api, gate, clock);
    await confirm(t.controller, clock);
    await t.hide(); await clock.advanceBy(10_000); await t.show();
    expect(f.api.check).toHaveBeenCalledTimes(1);
    expect(f.sent).toEqual([id(101)]);
    expect(t.ended).toEqual([{ kind: "expired" }]);
  });
});
