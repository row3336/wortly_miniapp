import { afterEach, describe, expect, it, vi } from "vitest";
import type { Profile } from "../api/generated";
import type { OpenedAccess } from "../app/openedAccess";
import { MAX_SENDS } from "../commands/recoveryLimits";
import { WriteGate } from "../commands/writeGate";
import { ManualClock } from "../commands/writeGate.test-support";
import { installClientJournal, type ClientJournal } from "../journal/clientJournal";
import type { ProfileCheckReply, ProfileDeleteApi, ProfileDeleteReply } from "./profileDeleteApi";
import { CONFIRM_DELAY_MS, ProfileDeleteController, type DeletionEnd } from "./profileDeleteController";
import { memoryStorage } from "./profileStorage.test-support";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const X = id(50);
const profile = (role: "owner" | "user" = "user", profileId = X): Profile => ({ profile_id: profileId, role, ui_language: "ru",
  dictionary_language: "ru", time_zone: "UTC", state_version: "1", access: { status: "admitted", version: "1", reason: null } });

function access(p: Profile, live = { value: true }): OpenedAccess {
  const credentials = { token: "token", proof: "proof", clientInstanceId: id(1), documentId: id(2) };
  return { key: `${p.profile_id}:doc`, profile: p, session: null, document: { clientInstanceId: id(1), documentId: id(2), epoch: "1" },
    isLive: () => live.value, run: async operation => operation(credentials) };
}

type Step = ProfileDeleteReply | (() => Promise<ProfileDeleteReply>);
function setup(options: { role?: "owner" | "user"; replies?: Step[]; checks?: (ProfileCheckReply | (() => Promise<ProfileCheckReply>))[] } = {}) {
  const clock = new ManualClock();
  const gate = new WriteGate({ clock });
  let current: OpenedAccess | null = access(profile(options.role));
  const replies = [...(options.replies ?? [])], checks = [...(options.checks ?? [])];
  const sent: string[] = [];
  const api: ProfileDeleteApi = {
    delete: vi.fn(async (_credentials, intent) => {
      sent.push(intent.commandId);
      expect(intent.profileId).toBe(X);
      const next = replies.shift() ?? { outcome: "unknown" };
      return typeof next === "function" ? next() : next;
    }),
    check: vi.fn(async () => { const next = checks.shift() ?? "unknown"; return typeof next === "function" ? next() : next; }),
  };
  const { storage, values, writes } = memoryStorage({ [`wortly.installation:${X}`]: "{}", "wortly.uiLanguage": "ru" });
  const ended: DeletionEnd[] = [];
  let n = 100;
  const controller = new ProfileDeleteController({ api, access: () => current, gate, storage, clock,
    newId: () => id(++n), onUpdate: () => undefined, onEnded: end => ended.push(end) });
  return { clock, gate, controller, api, sent, ended, values, writes, swap: (next: OpenedAccess | null) => { current = next; } };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
async function confirmAfterDelay(t: ReturnType<typeof setup>) {
  t.controller.open();
  await t.clock.advanceBy(CONFIRM_DELAY_MS);
  t.controller.confirm();
  await settle(); await settle();
}

afterEach(() => installClientJournal(null));

describe("the question (Q12) and the owner (Q-DEL-1)", () => {
  it("the final button is active only 5 s after the question; a tap before does nothing and is not kept", async () => {
    const t = setup({ replies: [{ outcome: "applied", status: "applied" }] });
    t.controller.open();
    expect(t.controller.snapshot()).toMatchObject({ phase: "asking", remainingS: 5, canConfirm: false });
    await t.clock.advanceBy(4_999);
    expect(t.controller.snapshot()).toMatchObject({ remainingS: 1, canConfirm: false });
    t.controller.confirm();
    await t.clock.advanceBy(1);
    expect(t.controller.snapshot()).toMatchObject({ remainingS: 0, canConfirm: true });
    await settle();
    expect(t.api.delete).not.toHaveBeenCalled();
  });

  it("the owner: the item is shown with the button unavailable; no question and no timer ever start", async () => {
    const t = setup({ role: "owner" });
    expect(t.controller.snapshot()).toMatchObject({ phase: "owner", canOpen: false, canConfirm: false, remainingS: null });
    t.controller.open();
    expect(t.controller.snapshot().phase).toBe("owner");
    expect(t.clock.pending()).toBe(0);
    await t.clock.advanceBy(10_000);
    t.controller.confirm();
    await settle();
    expect(t.api.delete).not.toHaveBeenCalled();
  });

  it("the button follows the write gate: closed — disabled, and a tap then is no hidden queue", async () => {
    const t = setup({ replies: [{ outcome: "applied", status: "applied" }] });
    t.controller.open();
    await t.clock.advanceBy(CONFIRM_DELAY_MS);
    t.gate.closeByFailure("unknown");
    expect(t.controller.snapshot().canConfirm).toBe(false);
    t.controller.confirm();
    await settle();
    expect(t.api.delete).not.toHaveBeenCalled();
  });

  it("is not blocked by an unreadable or unwritable profile record of the storage (P04 §3.7 (A)) and writes no intent", async () => {
    const t = setup({ replies: [{ outcome: "unknown" }, { outcome: "applied", status: "already_applied" }] });
    await confirmAfterDelay(t);
    expect(t.api.delete).toHaveBeenCalledTimes(1);
    // Q-DEL-4: the intent {profile_id, command_id} is never written to the storage.
    expect(t.writes.filter(key => !key.startsWith("-"))).toEqual([]);
  });
});

describe("the outcome classes (P04 §3.7)", () => {
  it("applied: the journal buffer and the records of X go, the uiLanguage stays, the screen ends as deleted", async () => {
    const revoke = vi.fn();
    installClientJournal({ revoke } as unknown as ClientJournal);
    const t = setup({ replies: [{ outcome: "applied", status: "applied" }] });
    await confirmAfterDelay(t);
    expect(revoke).toHaveBeenCalledWith(true);
    expect(t.values.has(`wortly.installation:${X}`)).toBe(false);
    expect(t.values.get("wortly.uiLanguage")).toBe("ru");
    expect(t.ended).toEqual([{ kind: "deleted" }]);
  });

  it("PROFILE_DELETED on the first attempt is «applied» too", async () => {
    const t = setup({ replies: [{ outcome: "applied", status: "profile_deleted" }] });
    await confirmAfterDelay(t);
    expect(t.ended).toEqual([{ kind: "deleted" }]);
  });

  it("an unknown outcome repeats the same command_id after the pause; already_applied then ends as deleted", async () => {
    const t = setup({ replies: [{ outcome: "unknown" }, { outcome: "applied", status: "already_applied" }] });
    await confirmAfterDelay(t);
    expect(t.controller.snapshot()).toMatchObject({ phase: "waiting", repeating: true });
    await t.clock.advanceBy(2_000);
    await settle();
    expect(t.sent).toEqual([id(101), id(101)]);
    expect(t.ended).toEqual([{ kind: "deleted" }]);
  });

  it("503 MAINTENANCE: the repeat waits for the gate's readiness (P03), not for a timer alone", async () => {
    const t = setup({ replies: [async () => { t.gate.closeByMaintenance(null); return { outcome: "maintenance" }; },
      { outcome: "applied", status: "applied" }] });
    await confirmAfterDelay(t);
    await t.clock.advanceBy(2_000);
    expect(t.sent).toHaveLength(1);
    expect(t.gate.mayWrite()).toBe(false);
  });

  it("503 WRITE_UNAVAILABLE on the first attempt repeats; 401 after it is «not done» (expired), not PD-28", async () => {
    const t = setup({ replies: [{ outcome: "write_unavailable" }, { outcome: "auth", code: "AUTH_EXPIRED" }] });
    await confirmAfterDelay(t);
    await t.clock.advanceBy(2_000);
    await settle();
    expect(t.sent).toEqual([id(101), id(101)]);
    expect(t.ended).toEqual([{ kind: "expired" }]);
  });

  it("AUTH_* on the first attempt: not done, no PD-28 screen", async () => {
    const t = setup({ replies: [{ outcome: "auth", code: "AUTH_INVALID" }] });
    await confirmAfterDelay(t);
    expect(t.ended).toEqual([{ kind: "expired" }]);
  });

  it("AUTH_* on a repeat after an unknown outcome: the outcome is unknown (PD-28) for the confirmed profile", async () => {
    const t = setup({ replies: [{ outcome: "unknown" }, { outcome: "auth", code: "AUTH_EXPIRED" }] });
    await confirmAfterDelay(t);
    await t.clock.advanceBy(2_000);
    await settle();
    expect(t.ended).toEqual([{ kind: "unknown", confirmedProfileId: X }]);
  });

  it.each([["ACCESS_PENDING"], ["ACCESS_REJECTED"], ["CLIENT_INCOMPATIBLE"], ["FORBIDDEN"]])(
    "%s: not done, no repeat, the intent is dropped; a new tap is a new question with a new command_id", async code => {
      const t = setup({ replies: [{ outcome: "refused", code }, { outcome: "applied", status: "applied" }] });
      await confirmAfterDelay(t);
      expect(t.controller.snapshot()).toMatchObject({ phase: "refused", refusalCode: code, canOpen: true });
      await t.clock.advanceBy(60_000);
      expect(t.sent).toEqual([id(101)]);
      t.controller.open();
      expect(t.controller.snapshot()).toMatchObject({ phase: "asking", remainingS: 5, canConfirm: false });
      await t.clock.advanceBy(CONFIRM_DELAY_MS);
      t.controller.confirm();
      await settle(); await settle();
      expect(t.sent).toEqual([id(101), id(102)]);
    });

  it.each([["not_deleted", "not_deleted"], ["deleted", "deleted"], ["auth", "unknown"], ["unknown", "unknown"]] as const)(
    "a defect code on a repeat stops the repeats; the read by the same session says %s", async (check, expected) => {
      const t = setup({ replies: [{ outcome: "unknown" }, { outcome: "defect", status: 422, code: "VALIDATION_FAILED" }],
        checks: [check] });
      await confirmAfterDelay(t);
      await t.clock.advanceBy(2_000);
      await settle(); await settle();
      expect(t.api.check).toHaveBeenCalledWith("token");
      if (expected === "not_deleted") expect(t.controller.snapshot().phase).toBe("not_deleted");
      else if (expected === "deleted") expect(t.ended).toEqual([{ kind: "deleted" }]);
      else expect(t.ended).toEqual([{ kind: "unknown", confirmedProfileId: X }]);
      await t.clock.advanceBy(120_000);
      expect(t.sent).toHaveLength(2);
    });

  it(`after ${MAX_SENDS} sends without an answer no more automatic repeats; «Проверить» reads, never sends`, async () => {
    const t = setup({ checks: ["not_deleted"] });
    await confirmAfterDelay(t);
    for (let i = 0; i < 10; i++) { await t.clock.advanceBy(30_000); await settle(); }
    expect(t.sent).toHaveLength(MAX_SENDS);
    expect(t.controller.snapshot()).toMatchObject({ phase: "stuck", canCheck: true });
    t.controller.check();
    await settle(); await settle();
    expect(t.controller.snapshot().phase).toBe("not_deleted");
    expect(t.sent).toHaveLength(MAX_SENDS);
  });
});

describe("the intent lives only on the open screen (Q-DEL-4)", () => {
  it("leaving the screen (dispose) during the pause: nothing is sent afterwards", async () => {
    const t = setup({ replies: [{ outcome: "unknown" }] });
    await confirmAfterDelay(t);
    expect(t.clock.pending()).toBe(1);
    t.controller.dispose();
    // The repeat timer goes with the screen at once, not only by a later no-op.
    expect(t.clock.pending()).toBe(0);
    await t.clock.advanceBy(120_000);
    await settle();
    expect(t.sent).toEqual([id(101)]);
  });

  it("another profile in the access (a change of profile): the intent is dropped, no repeat goes", async () => {
    const t = setup({ replies: [{ outcome: "unknown" }, { outcome: "applied", status: "applied" }] });
    await confirmAfterDelay(t);
    t.swap(access(profile("user", id(60))));
    await t.clock.advanceBy(120_000);
    await settle();
    expect(t.sent).toEqual([id(101)]);
    expect(t.controller.snapshot().phase).toBe("idle");
  });

  it("the access is gone (sign-in lost): no repeat goes", async () => {
    const t = setup({ replies: [{ outcome: "unknown" }] });
    await confirmAfterDelay(t);
    t.swap(null);
    await t.clock.advanceBy(120_000);
    expect(t.sent).toEqual([id(101)]);
  });

  it("an applied answer that arrives after the screen was left is still a fact: cleared and ended as deleted", async () => {
    let finish!: (reply: ProfileDeleteReply) => void;
    const t = setup({ replies: [() => new Promise(resolve => { finish = resolve; })] });
    await confirmAfterDelay(t);
    t.controller.dispose();
    finish({ outcome: "applied", status: "applied" });
    await settle(); await settle();
    expect(t.ended).toEqual([{ kind: "deleted" }]);
    expect(t.values.has(`wortly.installation:${X}`)).toBe(false);
  });

  it("a check read that answers «deleted» after the screen was left still clears X and ends as deleted", async () => {
    let answer!: (reply: ProfileCheckReply) => void;
    const t = setup({ replies: [{ outcome: "unknown" }, { outcome: "defect", status: 409, code: "COMMAND_PAYLOAD_MISMATCH" }],
      checks: [() => new Promise<ProfileCheckReply>(resolve => { answer = resolve; })] });
    await confirmAfterDelay(t);
    await t.clock.advanceBy(2_000);
    await settle(); await settle();
    expect(t.controller.snapshot().phase).toBe("checking");
    t.controller.dispose();
    answer("deleted");
    await settle(); await settle();
    expect(t.values.has(`wortly.installation:${X}`)).toBe(false);
    expect(t.ended).toEqual([{ kind: "deleted" }]);
  });

  it("a check read that answers «not deleted» after the screen was left changes nothing", async () => {
    let answer!: (reply: ProfileCheckReply) => void;
    const t = setup({ replies: [{ outcome: "unknown" }, { outcome: "defect", status: 422, code: "VALIDATION_FAILED" }],
      checks: [() => new Promise<ProfileCheckReply>(resolve => { answer = resolve; })] });
    await confirmAfterDelay(t);
    await t.clock.advanceBy(2_000);
    await settle(); await settle();
    t.controller.dispose();
    answer("not_deleted");
    await settle(); await settle();
    expect(t.values.has(`wortly.installation:${X}`)).toBe(true);
    expect(t.ended).toEqual([]);
  });

  it("a send the gate kept on the client: the question stays, the same command_id goes with the next tap", async () => {
    const t = setup({ replies: [{ outcome: "paused" }, { outcome: "applied", status: "applied" }] });
    await confirmAfterDelay(t);
    expect(t.controller.snapshot()).toMatchObject({ phase: "asking", paused: true, canConfirm: true });
    t.controller.confirm();
    await settle(); await settle();
    expect(t.sent).toEqual([id(101), id(101)]);
  });
});
