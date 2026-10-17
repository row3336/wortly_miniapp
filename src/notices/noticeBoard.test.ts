import { describe, expect, it, vi } from "vitest";
import type { NoticeView } from "../api/generated";
import { ApiError } from "../api/http";
import type { OpenedAccess } from "../app/openedAccess";
import type { AckEnd, NoticeApi } from "./noticeApi";
import { NoticeBoard } from "./noticeBoard";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const view = (n: number, createdAt = `2026-10-07T00:00:0${n}Z`): NoticeView => ({ notice_id: id(100 + n), kind: "answer_loss",
  session_id: id(200 + n), mode: "written", close_reason: "save_failed", defect_class: null, created_at: createdAt, summary: null });
function access(notices: NoticeView[] | null | undefined, live = true): OpenedAccess {
  return { key: "k", profile: {} as OpenedAccess["profile"], session: null, notices,
    document: { clientInstanceId: id(1), documentId: id(2), epoch: "1" }, isLive: () => live,
    run: operation => operation({ token: "tok", proof: "proof", clientInstanceId: id(1), documentId: id(2) }) };
}
function api(overrides: Partial<NoticeApi> = {}) {
  return { pending: vi.fn<NoticeApi["pending"]>(async () => []), ack: vi.fn<NoticeApi["ack"]>(async (): Promise<AckEnd> =>
    ({ kind: "done", status: "applied" })), ...overrides };
}
const ids = (board: NoticeBoard) => board.getSnapshot().notices.map(n => n.notice_id);

describe("NoticeBoard (project notices ed.2.4 §5, §6, §6.1)", () => {
  it("takes the open's list in showing order and sends nothing by itself", () => {
    const remote = api(), board = new NoticeBoard({ api: remote, newId: () => id(9), access: access([view(3), view(1), view(2)]) });
    expect(ids(board)).toEqual([id(101), id(102), id(103)]);
    expect(remote.ack).not.toHaveBeenCalled();
    expect(remote.pending).not.toHaveBeenCalled();
  });
  it("an older core's open (no notices) keeps what is known; a newer open replaces it", () => {
    const board = new NoticeBoard({ api: api(), newId: () => id(9), access: access([view(1)]) });
    board.observe(access(null));
    expect(ids(board)).toEqual([id(101)]);
    board.observe(access([]));
    expect(ids(board)).toEqual([]);
  });
  it("acknowledges only when asked; an ended notice never returns from an older list", async () => {
    const remote = api(), board = new NoticeBoard({ api: remote, newId: () => id(9), access: access([view(1), view(2)]) });
    expect(await board.acknowledge(id(101))).toBe(true);
    expect(remote.ack).toHaveBeenCalledWith("tok", "proof", id(101), { command_id: id(9), client_instance_id: id(1) });
    expect(ids(board)).toEqual([id(102)]);
    board.observe(access([view(1), view(2)]));
    expect(ids(board)).toEqual([id(102)]);
  });
  it("404 ends a notice; a failed or thrown acknowledgement keeps it, the next press repeats with the same command_id", async () => {
    const ends: (AckEnd | Error)[] = [{ kind: "failed", error: new ApiError("network") }, new ApiError("http", 503, "MAINTENANCE"),
      { kind: "done", status: "already_applied" }, { kind: "gone" }];
    const ack = vi.fn<NoticeApi["ack"]>(async () => { const end = ends.shift()!; if (end instanceof Error) throw end; return end; });
    const remote = api({ ack });
    let n = 10;
    const board = new NoticeBoard({ api: remote, newId: () => id(n++), access: access([view(1), view(2)]) });
    expect(await board.acknowledge(id(101))).toBe(false);
    expect(ids(board)).toEqual([id(101), id(102)]);
    expect(await board.acknowledge(id(101))).toBe(false);
    expect(await board.acknowledge(id(101))).toBe(true);
    expect(await board.acknowledge(id(102))).toBe(true);
    expect(ids(board)).toEqual([]);
    const sent = ack.mock.calls.map(call => [call[2], call[3].command_id]);
    expect(sent).toEqual([[id(101), id(10)], [id(101), id(10)], [id(101), id(10)], [id(102), id(11)]]);
  });
  it("one acknowledgement at a time; none through a closed access", async () => {
    let release!: () => void;
    const remote = api({ ack: vi.fn<NoticeApi["ack"]>(() => new Promise(resolve => { release = () => resolve({ kind: "done", status: "applied" }); })) });
    const board = new NoticeBoard({ api: remote, newId: () => id(9), access: access([view(1)]) });
    const first = board.acknowledge(id(101));
    expect(board.getSnapshot().acking).toBe(id(101));
    expect(await board.acknowledge(id(101))).toBe(false);
    release(); expect(await first).toBe(true);
    expect(remote.ack).toHaveBeenCalledTimes(1);
    const closed = new NoticeBoard({ api: remote, newId: () => id(9), access: access([view(1)], false) });
    expect(await closed.acknowledge(id(101))).toBe(false);
    expect(remote.ack).toHaveBeenCalledTimes(1);
  });
  it("Т2: require() reads GET /notices; a failure keeps the list and stays required; only read() repeats", async () => {
    const answers: (NoticeView[] | Error)[] = [new ApiError("http", 500, "INTERNAL_ERROR"), [view(2)]];
    const remote = api({ pending: vi.fn<NoticeApi["pending"]>(async () => { const a = answers.shift()!; if (a instanceof Error) throw a; return a; }) });
    const board = new NoticeBoard({ api: remote, newId: () => id(9), access: access([]) });
    board.require();
    expect(board.getSnapshot()).toMatchObject({ required: true, read: "reading" });
    await vi.waitFor(() => expect(board.getSnapshot().read).toBe("failed"));
    expect(board.getSnapshot().required).toBe(true);
    expect(ids(board)).toEqual([]);
    expect(await board.read()).toBe(true);
    expect(board.getSnapshot()).toMatchObject({ required: false, read: "idle" });
    expect(ids(board)).toEqual([id(102)]);
    expect(remote.pending).toHaveBeenCalledTimes(2);
    expect(remote.ack).not.toHaveBeenCalled();
  });
  it("finds the notice of one closed session by kind", () => {
    const oral: NoticeView = { ...view(1), kind: "oral_forced_close", mode: "oral", close_reason: "midnight" };
    const board = new NoticeBoard({ api: api(), newId: () => id(9), access: access([oral, view(2)]) });
    expect(board.find(id(201).toUpperCase(), "oral_forced_close")?.notice_id).toBe(id(101));
    expect(board.find(id(202), "oral_forced_close")).toBeNull();
  });
});
