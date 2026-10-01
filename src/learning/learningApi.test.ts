import { describe, expect, it, vi } from "vitest";
import type { LearningCurrentResponse, ManualSelectionCommand, SavedCommandFact } from "../api/generated";
import { createLearningApi } from "./learningApi";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const time = "2026-09-30T00:00:00.123456Z";
const bigVersion = "9007199254740995";
function command(): ManualSelectionCommand {
  return { command_id: id(1), kind: "learning.select", client_instance_id: id(2), document_id: id(3),
    expected_selection_version: bigVersion, payload: { card_id: id(4), expected_pair: "ru-de" } };
}
function current(): LearningCurrentResponse {
  return { pair: "ru-de", state_version: bigVersion, manual_selection_version: bigVersion,
    learning: { status: "preview", ready: 0, preview: 1, next_due_at: null,
      new_group_size: 0, manual_eligible: 1, automatic_eligible: 0 },
    manual_selection: [{ card_id: id(4), position: 3, version: bigVersion, eligible: true }],
    group: { group_id: id(6), status: "assembling", created_at: time,
      introduction: { position: 0, version: "1", next_card_id: id(7) },
      members: [{ card_id: id(7), introduction_order: 1, stage: 0, due_at: null,
        status: "pending", version: "1", available: true, needs_preview: true, ready: false }] } };
}
function fact(): SavedCommandFact {
  return { id: id(1), kind: "learning.select", status: "applied", applied_at: time,
    target_id: id(4), action_id: null, result_id: null, context_id: null, object_version: bigVersion };
}
function profile() {
  return { profile_id: id(8), access: { status: "admitted", version: "1", reason: null },
    role: "user", ui_language: "ru", dictionary_language: "ru", time_zone: "UTC", state_version: bigVersion };
}
function response(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status }); }
function setup(body: unknown, status = 200) {
  const fetcher = vi.fn(async () => response(body, status));
  return { fetcher, api: createLearningApi({ fetcher, timeoutMs: 1000, maxResponseBytes: 10000 }) };
}
function reply() { return { command: fact(), current: current(), state_version: bigVersion }; }

describe("Learning read adapter", () => {
  it("reads all displayed group/manual fields without rounding versions", async () => {
    const { api, fetcher } = setup(current());
    expect(await api.get("synthetic")).toEqual(current());
    expect(fetcher).toHaveBeenCalledWith("/api/v1/learning/current", expect.objectContaining({
      method: "GET", headers: { Authorization: "Bearer synthetic" }, body: undefined,
    }));
  });

  it("accepts no group and a legacy group without a saved introduction", async () => {
    const data = current();
    data.group!.introduction = null;
    await expect(setup(data).api.get("synthetic")).resolves.toEqual(data);
    data.group = null;
    await expect(setup(data).api.get("synthetic")).resolves.toEqual(data);
  });

  const invalid: Array<[string, (data: LearningCurrentResponse) => void]> = [
    ["unsafe state version", data => { data.state_version = "9223372036854775808"; }],
    ["zero selection version", data => { data.manual_selection_version = "0"; }],
    ["padded version", data => { data.manual_selection_version = "01"; }],
    ["pair array", data => { Object.assign(data, { pair: ["ru-de"] }); }],
    ["fractional count", data => { data.learning.ready = 0.5; }],
    ["string count", data => { Object.assign(data.learning, { preview: "1" }); }],
    ["missing learning field", data => { Reflect.deleteProperty(data.learning, "manual_eligible"); }],
    ["invalid due date", data => { data.learning.next_due_at = "2026-02-30T00:00:00Z"; }],
    ["nonUTC event", data => { data.group!.created_at = "2026-09-30T00:00:00+02:00"; }],
    ["24 hour event", data => { data.group!.created_at = "2026-09-30T24:00:00Z"; }],
    ["missing group", data => { Reflect.deleteProperty(data, "group"); }],
    ["invalid group ID", data => { data.group!.group_id = "group"; }],
    ["closed group", data => { Object.assign(data.group!, { status: "completed" }); }],
    ["missing introduction", data => { Reflect.deleteProperty(data.group!, "introduction"); }],
    ["invalid next card", data => { data.group!.introduction!.next_card_id = "word"; }],
    ["negative cursor", data => { data.group!.introduction!.position = -1; }],
    ["unsafe cursor", data => { data.group!.introduction!.position = Number.MAX_SAFE_INTEGER + 1; }],
    ["negative stage", data => { data.group!.members[0].stage = -1; }],
    ["bad member status", data => { Object.assign(data.group!.members[0], { status: ["pending"] }); }],
    ["nonboolean capability", data => { Object.assign(data.group!.members[0], { ready: 1 }); }],
    ["missing member capability", data => { Reflect.deleteProperty(data.group!.members[0], "needs_preview"); }],
    ["duplicate member", data => { data.group!.members.push({ ...data.group!.members[0], introduction_order: 2 }); }],
    ["duplicate selection", data => { data.manual_selection.push({ ...data.manual_selection[0], position: 4 }); }],
    ["unordered selection", data => { data.manual_selection.push({ ...data.manual_selection[0], card_id: id(10), position: 2 }); }],
    ["selection ID", data => { data.manual_selection[0].card_id = "word"; }],
    ["selection eligibility", data => { Object.assign(data.manual_selection[0], { eligible: "true" }); }],
  ];
  it.each(invalid)("rejects %s", async (_name, corrupt) => {
    const data = current(); corrupt(data);
    await expect(setup(data).api.get("synthetic")).rejects.toMatchObject({ kind: "invalid_response" });
  });
});

describe("manual command exchange", () => {
  it.each(["learning.select", "learning.unselect"] as const)("sends the exact %s envelope", async kind => {
    const request = command(); request.kind = kind;
    const body = reply(); body.command.kind = kind;
    const { api, fetcher } = setup(body);
    const result = await api.change("synthetic", "synthetic-proof", request);
    expect(result.outcome).toBe("accepted");
    expect(result.command).toEqual(body.command);
    const call = (fetcher.mock.calls as unknown as [string, RequestInit][])[0];
    expect(call[0]).toBe("/api/v1/commands");
    expect(call[1].headers).toEqual({ Authorization: "Bearer synthetic",
      "X-Origin-Proof": "synthetic-proof", "Content-Type": "application/json" });
    expect(JSON.parse(call[1].body as string)).toEqual(request);
  });

  it("does not assume a fresh projection still represents the original accepted change", async () => {
    const body = reply();
    body.command.status = "already_applied";
    body.command.object_version = "2";
    body.current.pair = "uk-de";
    body.current.manual_selection = [];
    body.current.manual_selection_version = "1";
    const result = await setup(body).api.change("synthetic", "proof", command());
    expect(result).toMatchObject({ outcome: "accepted", command: { object_version: "2" },
      current: { pair: "uk-de", manual_selection: [], manual_selection_version: "1" } });
  });

  it("snapshots the request before waiting, so caller mutation cannot change the expected address", async () => {
    let finish!: (value: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
    const api = createLearningApi({ fetcher, timeoutMs: 1000, maxResponseBytes: 10000 });
    const original = command();
    const pending = api.change("synthetic", "proof", original);
    original.command_id = id(11); original.payload.card_id = id(12);
    finish(response(reply()));
    await expect(pending).resolves.toMatchObject({ outcome: "accepted", command: { id: id(1), target_id: id(4) } });
  });

  it("leaves a lost response unresolved; the caller can repeat the very same command", async () => {
    const body = reply(); body.command.status = "already_applied";
    const fetcher = vi.fn().mockRejectedValueOnce(new Error("lost-after-commit"))
      .mockResolvedValueOnce(response(body));
    const api = createLearningApi({ fetcher, timeoutMs: 1000, maxResponseBytes: 10000 });
    await expect(api.change("synthetic", "proof", command())).rejects.toMatchObject({ kind: "network" });
    expect(fetcher).toHaveBeenCalledOnce();
    await expect(api.change("synthetic", "proof", command())).resolves.toMatchObject({ outcome: "accepted" });
    expect(fetcher.mock.calls[0][1].body).toBe(fetcher.mock.calls[1][1].body);
  });

  it.each([403, 409, 422])("returns an addressed business refusal at HTTP %s", async status => {
    const body = { ...reply(), command: { id: id(1), status: "rejected" }, error: { code: "VERSION_CONFLICT" } };
    await expect(setup(body, status).api.change("synthetic", "proof", command()))
      .resolves.toMatchObject({ outcome: "rejected", error: { code: "VERSION_CONFLICT" }, current: body.current });
  });

  it("distinguishes an ID/payload mismatch from proof of a rejected original intent", async () => {
    const body = { ...reply(), command: { id: id(1), status: "rejected" }, error: { code: "COMMAND_PAYLOAD_MISMATCH" } };
    await expect(setup(body, 409).api.change("synthetic", "proof", command()))
      .resolves.toMatchObject({ outcome: "mismatch" });
  });

  it.each([401, 403, 409, 422, 503])("does not invent a resolved outcome from a plain HTTP %s", async status => {
    await expect(setup({ error: { code: "WRITE_UNAVAILABLE" } }, status).api.change("synthetic", "proof", command()))
      .rejects.toMatchObject({ kind: "http", status });
  });

  it.each([401, 500, 503])("never treats a rejected envelope on HTTP %s as definitive", async status => {
    const body = { ...reply(), command: { id: id(1), status: "rejected" }, error: { code: "WRITE_UNAVAILABLE" } };
    await expect(setup(body, status).api.change("synthetic", "proof", command()))
      .rejects.toMatchObject({ kind: "http", status });
  });

  it.each([
    { id: id(11) }, { kind: "learning.unselect" }, { target_id: id(11) }, { target_id: null },
    { result_id: id(12) }, { action_id: id(12) }, { context_id: id(12) },
    { object_version: null }, { object_version: 3 }, { applied_at: "yesterday" }, { status: "rejected" },
  ])("rejects a mismatching/malformed acceptance %#", async corrupt => {
    const body = reply(); Object.assign(body.command, corrupt);
    await expect(setup(body).api.change("synthetic", "proof", command())).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("does not accept another command's conflict", async () => {
    const body = { ...reply(), command: { id: id(11), status: "rejected" }, error: { code: "VERSION_CONFLICT" } };
    await expect(setup(body, 409).api.change("synthetic", "proof", command())).rejects.toMatchObject({ kind: "http" });
  });

  it("does not discard extra outgoing semantic fields", async () => {
    const { api, fetcher } = setup(reply());
    await expect(api.change("synthetic", "proof", { ...command(), extra: true } as ManualSelectionCommand)).rejects.toThrow();
    const extra = command(); Object.assign(extra.payload, { extra: true });
    await expect(api.change("synthetic", "proof", extra)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects malformed request IDs before any network operation", async () => {
    const { api, fetcher } = setup(reply());
    const request = command(); request.command_id = "../another-endpoint";
    await expect(api.status("synthetic", request)).rejects.toThrow();
    await expect(api.change("synthetic", "proof", request)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("checking the outcome of a manual command", () => {
  it.each([
    { command: { ...fact(), status: "already_applied" }, current: current() },
    { command: { ...fact(), status: "already_applied" }, current: { status: "unavailable" } },
    { command: { id: id(1), status: "not_found" }, current: profile() },
  ])("does not resolve an outcome with a contradictory error %#", async outcome => {
    const { api, fetcher } = setup({ ...outcome, state_version: bigVersion,
      error: { code: "COMMAND_PAYLOAD_MISMATCH" } });
    await expect(api.status("synthetic", command())).rejects.toMatchObject({ kind: "invalid_response" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([201, 202, 206])("requires HTTP 200 rather than unexpected successful status %s", async status => {
    const { api, fetcher } = setup({ command: { ...fact(), status: "already_applied" },
      current: current(), state_version: bigVersion }, status);
    await expect(api.status("synthetic", command())).rejects.toMatchObject({ kind: "invalid_response" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("returns not_found with current profile, without resending or declaring rejection", async () => {
    const { api, fetcher } = setup({ command: { id: id(1), status: "not_found" }, current: profile(), state_version: bigVersion });
    await expect(api.status("synthetic", command())).resolves.toMatchObject({ outcome: "not_found", current: profile() });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(`/api/v1/commands/${id(1)}`, expect.objectContaining({ method: "GET", body: undefined }));
  });

  it.each([current(), { status: "unavailable" }])("keeps an accepted fact separate from current read permissions %#", async projection => {
    const body = { command: { ...fact(), status: "already_applied" }, current: projection, state_version: bigVersion };
    await expect(setup(body).api.status("synthetic", command()))
      .resolves.toMatchObject({ outcome: "accepted", current: projection });
  });

  it.each([
    { command: { ...fact(), status: "already_applied", kind: "setting.save" }, current: current() },
    { command: { ...fact(), status: "already_applied", target_id: id(99) }, current: current() },
    { command: fact(), current: current() },
    { command: { id: id(99), status: "not_found" }, current: profile() },
    { command: { id: id(1), status: "not_found" }, current: current() },
    { command: { ...fact(), status: "already_applied" }, current: profile() },
  ])("rejects the wrong outcome branch or address %#", async corrupt => {
    await expect(setup({ ...corrupt, state_version: bigVersion }).api.status("synthetic", command()))
      .rejects.toMatchObject({ kind: "invalid_response" });
  });
});
