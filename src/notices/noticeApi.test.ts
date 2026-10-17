import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { NoticeView } from "../api/generated";
import { createEntryApi } from "../api/entryApi";
import { readWithTicket, testGate } from "../commands/testGate.test-support";
import { POST_ROUTES, WriteGate } from "../commands/writeGate";
import { ManualClock } from "../commands/writeGate.test-support";
import { journalRecord } from "../journal/clientJournal";
import { ERROR_CODES } from "../journal/events";
import { createLearningSessionApi, LEAVING_START_REFUSALS, type LearningSessionCommand } from "../learning/learningSessionApi";
import { createNoticeApi, noticeOrder, validNotice, validNotices } from "./noticeApi";
import { NOTICE_SHOWN_ACCEPTED, noticeShown } from "./noticeJournal";
import { noticePendingStart } from "./noticePending";

vi.mock("../journal/clientJournal", async importOriginal => {
  const original = await importOriginal<typeof import("../journal/clientJournal")>();
  return { ...original, journalRecord: vi.fn() };
});

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const view = (n: number, extra: Partial<NoticeView> = {}): NoticeView => ({ notice_id: id(100 + n), kind: "answer_loss",
  session_id: id(200 + n), mode: "written", close_reason: "save_failed", defect_class: null,
  created_at: "2026-10-07T00:00:01Z", summary: { completed: 3, correct: 2, wrong: 1, ratio: { numerator: 2, denominator: 3 } }, ...extra });
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function fixture(answer: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const fetcher = vi.fn<typeof fetch>(async (url, init) => answer(String(url), init));
  return { fetcher, api: createNoticeApi({ fetcher, timeoutMs: 1000, maxResponseBytes: 100000, gate: testGate() }) };
}

describe("NoticeView decoder (core a2c29f4 api/models.py NoticeView)", () => {
  it("accepts the core's shape, with defect_class null or absent, and any summary object or null", () => {
    expect(validNotice(view(1))).toBe(true);
    const { defect_class: _absent, ...withoutDefect } = view(1);
    expect(validNotice(withoutDefect)).toBe(true);
    expect(validNotice(view(1, { kind: "oral_forced_close", mode: "oral", close_reason: "midnight", summary: null }))).toBe(true);
    // The progress the core adds later (C525): absent today, null, or exactly a study progress.
    expect(validNotice({ ...view(1), progress: null })).toBe(true);
    expect(validNotice({ ...view(1), progress: { completed: 4, total: 6, correct: 3, wrong: 1 } })).toBe(true);
  });
  it.each<[string, (value: Record<string, unknown>) => void]>([
    ["a defect class (Д1: always null)", v => { v.defect_class = "known"; }],
    ["an unknown kind", v => { v.kind = "learning_closed"; }],
    ["an unknown mode", v => { v.mode = "drill"; }],
    ["an unknown close reason", v => { v.close_reason = "crash"; }],
    ["a bad notice id", v => { v.notice_id = "x"; }],
    ["a bad session id", v => { v.session_id = 7; }],
    ["a bad time", v => { v.created_at = "yesterday"; }],
    ["a summary that is no object", v => { v.summary = [1]; }],
    ["an extra field", v => { v.acked_at = "2026-10-07T00:00:02Z"; }],
    ["a missing summary", v => { delete v.summary; }],
    ["a progress of another shape", v => { v.progress = { completed: 1, total: 2 }; }],
    ["a progress beyond its total", v => { v.progress = { completed: 3, total: 2, correct: 3, wrong: 0 }; }],
  ])("refuses %s, and a list with one such item as a whole", (_name, mutate) => {
    const bad = view(2) as unknown as Record<string, unknown>; mutate(bad);
    expect(validNotice(bad)).toBe(false);
    expect(validNotices([view(1), bad])).toBe(false);
  });
  it("keeps the microseconds of created_at (C523): 00:00:01.000001Z with a larger id before 00:00:01.000002Z with a smaller", () => {
    const first = view(9, { created_at: "2026-10-07T00:00:01.000001Z" }), second = view(1, { created_at: "2026-10-07T00:00:01.000002Z" });
    expect(noticeOrder([second, first]).map(n => n.notice_id)).toEqual([first.notice_id, second.notice_id]);
    expect(noticeOrder([first, second]).map(n => n.notice_id)).toEqual([first.notice_id, second.notice_id]);
    // +00:00 and Z are the same instant; equal times fall to the id.
    const z = view(4, { created_at: "2026-10-07T00:00:01.5Z" }), offset = view(3, { created_at: "2026-10-07T00:00:01.500000+00:00" });
    expect(noticeOrder([z, offset]).map(n => n.notice_id)).toEqual([offset.notice_id, z.notice_id]);
  });
  it("orders by created_at, then by id", () => {
    const a = view(3, { created_at: "2026-10-07T00:00:02Z" }), b = view(2, { created_at: "2026-10-07T00:00:01.500Z" });
    const c = view(1, { created_at: "2026-10-07T00:00:02Z" });
    expect(noticeOrder([a, b, c]).map(n => n.notice_id)).toEqual([b.notice_id, c.notice_id, a.notice_id]);
  });
});

describe("GET /api/v1/notices (§5: the read, no X-Origin-Proof, no acknowledgement)", () => {
  it("reads with the bearer only and returns the list in showing order", async () => {
    const late = view(2, { created_at: "2026-10-07T00:00:09Z" }), early = view(1);
    const f = fixture(() => reply({ notices: [late, early] }));
    expect((await f.api.pending("synthetic-token")).map(n => n.notice_id)).toEqual([early.notice_id, late.notice_id]);
    const [url, init] = f.fetcher.mock.calls[0];
    expect(url).toBe("/api/v1/notices");
    expect(init?.method).toBe("GET");
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer synthetic-token");
    expect(headers.get("X-Origin-Proof")).toBeNull();
    expect(init?.body).toBeUndefined();
  });
  it.each([[{ notices: [view(1)], extra: 1 }], [{ notices: "none" }], [{}], [{ notices: [{ ...view(1), defect_class: "x" }] }]])(
    "refuses a malformed answer %j", async value => {
      const f = fixture(() => reply(value));
      await expect(f.api.pending("t")).rejects.toMatchObject({ kind: "invalid_response" });
    });
  it("an error answer stays an HTTP refusal with its code", async () => {
    const f = fixture(() => reply({ error: { code: "PROFILE_DELETED" } }, 403));
    await expect(f.api.pending("t")).rejects.toMatchObject({ kind: "http", status: 403, code: "PROFILE_DELETED" });
  });
});

describe("POST /api/v1/notices/{notice_id}/ack (§5, T4)", () => {
  const body = { command_id: id(9), client_instance_id: id(8) };
  it("sends the proof, the contract header and exactly {command_id, client_instance_id}", async () => {
    const f = fixture(() => reply({ notice_id: id(101), status: "applied", acked_at: "2026-10-07T10:00:00Z" }));
    expect(await f.api.ack("tok", "proof", id(101), body)).toEqual({ kind: "done", status: "applied" });
    const [url, init] = f.fetcher.mock.calls[0];
    expect(url).toBe(`/api/v1/notices/${id(101)}/ack`);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual(body);
    const headers = new Headers(init?.headers);
    expect(headers.get("X-Origin-Proof")).toBe("proof");
    expect(headers.get("X-Wortly-Contract-Version")).toBe("1");
  });
  it("already_applied ends it as well (a second device, or the reply of the first was lost)", async () => {
    const f = fixture(() => reply({ notice_id: id(101), status: "already_applied", acked_at: "2026-10-07T10:00:00Z" }));
    expect(await f.api.ack("tok", "proof", id(101), body)).toEqual({ kind: "done", status: "already_applied" });
  });
  it("404 NOT_FOUND: unknown or another profile's — gone", async () => {
    const f = fixture(() => reply({ error: { code: "NOT_FOUND" } }, 404));
    expect(await f.api.ack("tok", "proof", id(101), body)).toEqual({ kind: "gone" });
  });
  it("a lost reply or an answer about another notice does not end it", async () => {
    const lost = fixture(() => { throw new TypeError("network"); });
    expect((await lost.api.ack("tok", "proof", id(101), body)).kind).toBe("failed");
    const other = fixture(() => reply({ notice_id: id(102), status: "applied", acked_at: "2026-10-07T10:00:00Z" }));
    expect((await other.api.ack("tok", "proof", id(101), body)).kind).toBe("failed");
  });
  it.each([[403, "PROFILE_DELETED"], [403, "FORBIDDEN"], [503, "MAINTENANCE"], [422, "VALIDATION_FAILED"]])(
    "%s %s is thrown as an HTTP refusal (the access handle sees 401/403)", async (status, code) => {
      const f = fixture(() => reply({ error: { code } }, status));
      await expect(f.api.ack("tok", "proof", id(101), body)).rejects.toMatchObject({ kind: "http", status, code });
    });
  it("is a gated write: a paused gate sends nothing", async () => {
    const gate = new WriteGate({ clock: new ManualClock() });
    gate.closeByFailure("unknown");
    const fetcher = vi.fn<typeof fetch>();
    const api = createNoticeApi({ fetcher, timeoutMs: 1000, maxResponseBytes: 100000, gate });
    expect((await api.ack("tok", "proof", id(101), body)).kind).toBe("failed");
    expect(fetcher).not.toHaveBeenCalled();
    expect(POST_ROUTES["/notices/{notice_id}/ack"]).toBe("gated");
  });
});

describe("client.open carries the pending notices (CON §7.2 п.4)", () => {
  const profile = { profile_id: id(50), role: "user", ui_language: "ru", dictionary_language: "ru", time_zone: "UTC",
    state_version: "3", access: { status: "admitted", version: "1", reason: null } };
  const opened = (notices: unknown) => ({ status: "opened", client_instance_id: id(1), document_id: id(2), document_epoch: "1",
    proof_version: "1", profile, session: null, compatibility: { compatible: true, contract_version: "1" },
    ...(notices === undefined ? {} : { notices }) });
  const open = (value: unknown) => createEntryApi({ fetcher: vi.fn<typeof fetch>(async () => reply(value)), timeoutMs: 1000,
    maxResponseBytes: 100000, gate: testGate() }).open("t", "p", { client_instance_id: id(1), document_id: id(2), event: "foreground",
    client_version: "0.0.0", contract_version: "1" } as never);
  it.each([[undefined], [null], [[]], [[view(1)]]])("accepts notices %j", async notices => {
    expect(await open(opened(notices))).toMatchObject({ status: "opened" });
  });
  it("refuses an open whose notices are malformed", async () => {
    await expect(open(opened([{ ...view(1), kind: "other" }]))).rejects.toMatchObject({ kind: "invalid_response" });
  });
});

describe("NOTICE_PENDING (§6.1): the same lane state from the reply and from the check of an unknown start", () => {
  it("is a known error code of the journal", () => { expect(ERROR_CODES).toContain("NOTICE_PENDING"); });
  it("names the refused start only for session.start rejected with NOTICE_PENDING", () => {
    const lane = { outcome: "rejected", rejectionCode: "NOTICE_PENDING", resolved: { kind: "session.start", commandId: id(4) } };
    expect(noticePendingStart(lane)).toBe(id(4));
    expect(noticePendingStart({ ...lane, rejectionCode: "SESSION_BUSY" })).toBeNull();
    expect(noticePendingStart({ ...lane, outcome: "accepted" })).toBeNull();
    expect(noticePendingStart({ ...lane, resolved: { kind: "session.stop", commandId: id(4) } })).toBeNull();
    expect(noticePendingStart(null)).toBeNull();
  });
  it("Learning: a stored NOTICE_PENDING refusal found by the status read of an unknown start is read and left", async () => {
    expect(LEAVING_START_REFUSALS.has("NOTICE_PENDING")).toBe(true);
    const command: LearningSessionCommand = { command_id: id(4), client_instance_id: id(1), document_id: id(2), session_id: id(3),
      kind: "session.start", payload: { mode: "learning" } };
    const hash = createHash("sha256").update(`{"kind":"session.start","payload":{"mode":"learning","session_id":"${id(3)}"}}`).digest("hex");
    const fetcher = vi.fn<typeof fetch>(async () => reply({ command: { id: id(4), kind: "session.start", status: "rejected",
      refused_at: "2026-10-07T12:00:00Z" }, error: { code: "NOTICE_PENDING" }, current: { session_id: id(3), status: "not_found" },
    state_version: "3", verified_intent_hash: hash }));
    const api = createLearningSessionApi({ fetcher, timeoutMs: 1000, maxResponseBytes: 100000, gate: testGate() });
    expect(await readWithTicket(command, (c, ticket) => api.status("t", "p", c, ticket)))
      .toMatchObject({ outcome: "rejected", error: { code: "NOTICE_PENDING" } });
  });
});

// M1a kept this seam closed (core a2c29f4 had no kind notice_shown); core 35c3844 accepts it, so M1b opens it.
describe("c.screen(notice_shown): open since core 35c3844 (M1b)", () => {
  it("records the shown notice once per page, with the notice only", () => {
    expect(NOTICE_SHOWN_ACCEPTED).toBe(true);
    noticeShown(id(101).toUpperCase()); noticeShown(id(101));
    expect(vi.mocked(journalRecord).mock.calls).toEqual([[{ ev: "c.screen", kind: "notice_shown", notice: id(101) }]]);
  });
});
