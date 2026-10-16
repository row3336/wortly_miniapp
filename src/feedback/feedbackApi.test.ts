import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/http";
import { id, profile, response } from "../learning/learningFixtures.test-support";
import { blankText, createFeedbackApi, validFeedbackIntent, type FeedbackIntent } from "./feedbackApi";
import { readWithTicket, testGate } from "../commands/testGate.test-support";

const intent: FeedbackIntent = { command_id: id(100), kind: "feedback.send", payload: { text: "Das Wort ist falsch" } };
const origin = { clientInstanceId: id(1), documentId: id(2) };
const fact = (over: Record<string, unknown> = {}, status = "applied") => ({ id: id(100), kind: "feedback.send", status,
  applied_at: "2026-10-06T12:00:00Z", target_id: id(900), action_id: null, result_id: null, context_id: null, object_version: null, ...over });
const saved = (over: Record<string, unknown> = {}) => ({ command: fact(), current: { inbox_id: id(900), card_id: null }, state_version: "5", ...over });
function api(reply: () => Response | Promise<Response>) {
  const fetcher = vi.fn<typeof fetch>(async () => reply());
  return { fetcher, api: createFeedbackApi({ fetcher, timeoutMs: 1000, maxResponseBytes: 100000, gate: testGate() }) };
}
const send = (client: ReturnType<typeof createFeedbackApi>, value = intent) => client.send("token", "proof", origin, value);

describe("feedback intent", () => {
  it.each([["a"], [" a "], ["\n\ta\n"]])("%j is a message", text => {
    expect(validFeedbackIntent({ ...intent, payload: { text } })).toBe(true);
  });
  it.each([[""], [" "], ["\n\t"], [" "]])("%j is blank", text => {
    expect(blankText(text)).toBe(true); expect(validFeedbackIntent({ ...intent, payload: { text } })).toBe(false);
  });
  it.each([
    ["not an object", 5], ["extra key", { ...intent, expected_field_version: "1" }], ["wrong kind", { ...intent, kind: "setting.save" }],
    ["id not a uuid", { ...intent, command_id: "x" }], ["text not a string", { ...intent, payload: { text: 5 } }],
    ["extra payload key", { ...intent, payload: { text: "a", subject: "x" } }],
    ["card_id not a uuid", { ...intent, payload: { text: "a", card_id: "x" } }],
    ["card_id null", { ...intent, payload: { text: "a", card_id: null } }],
  ])("rejects %s", (_name, value) => { expect(validFeedbackIntent(value)).toBe(false); });
  it("accepts a complaint with a card", () => {
    expect(validFeedbackIntent({ ...intent, payload: { text: "a", card_id: id(7) } })).toBe(true);
  });
});

describe("send", () => {
  it("posts one command with this document's origin and credentials; a general message has no card_id", async () => {
    const { api: client, fetcher } = api(() => response(saved()));
    expect(await send(client)).toEqual({ outcome: "accepted", inboxId: id(900) });
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toBe("/api/v1/commands"); expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer token", "X-Origin-Proof": "proof" });
    expect(JSON.parse(String(init?.body))).toEqual({ command_id: id(100), kind: "feedback.send", client_instance_id: id(1),
      document_id: id(2), payload: { text: "Das Wort ist falsch" } });
  });
  it("sends the card of a complaint and expects it back", async () => {
    const card = { ...intent, payload: { text: "a", card_id: id(7) } };
    const { api: client, fetcher } = api(() => response(saved({ current: { inbox_id: id(900), card_id: id(7) } })));
    expect(await send(client, card)).toEqual({ outcome: "accepted", inboxId: id(900) });
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).payload).toEqual({ text: "a", card_id: id(7) });
    const other = api(() => response(saved())).api;
    await expect(send(other, card)).rejects.toMatchObject({ kind: "invalid_response" });
  });
  it("a repeat (already_applied) and a record deleted since are still confirmations of the fact", async () => {
    expect(await send(api(() => response(saved({ command: fact({}, "already_applied") }))).api)).toMatchObject({ outcome: "accepted" });
    expect(await send(api(() => response(saved({ current: { status: "unavailable" } }))).api)).toMatchObject({ outcome: "accepted" });
  });
  it.each([
    ["another command id", saved({ command: fact({ id: id(101) }) })],
    ["another kind", saved({ command: fact({ kind: "setting.save" }) })],
    ["rejected status", saved({ command: { id: id(100), status: "rejected" } })],
    ["no target", saved({ command: fact({ target_id: null }) })],
    ["no applied time", saved({ command: fact({ applied_at: "yesterday" }) })],
    ["a record other than the target", saved({ current: { inbox_id: id(901), card_id: null } })],
    ["a projection of something else", saved({ current: { status: "open" } })],
    ["an error beside a fact", saved({ error: { code: "X" } })],
    ["no state version", saved({ state_version: undefined })],
    ["no command", { current: { inbox_id: id(900), card_id: null }, state_version: "5" }],
  ])("a 200 reply with %s is not a confirmation", async (_name, body) => {
    await expect(send(api(() => response(body)).api)).rejects.toMatchObject({ kind: "invalid_response" });
  });
  it.each([[409, "COMMAND_PAYLOAD_MISMATCH"], [422, "VALIDATION_FAILED"]])(
    "%i %s is a refusal before any write", async (status, code) => {
      const body = status === 409 ? { command: { id: id(100), status: "rejected" }, current: { status: "unavailable" }, state_version: "5", error: { code } }
        : { error: { code } };
      expect(await send(api(() => response(body, status)).api)).toEqual({ outcome: "refused", code });
    });
  it("a refusal without a readable body is still a refusal, without a code", async () => {
    expect(await send(api(() => new Response("oops", { status: 422 })).api)).toEqual({ outcome: "refused", code: null });
  });
  // root decision, pending owner: every 4xx except 401/403/408/429 is refused before any write.
  it.each([400, 404, 413, 418])("HTTP %i is a refusal", async status => {
    expect(await send(api(() => response({ error: { code: "REFUSED" } }, status)).api)).toEqual({ outcome: "refused", code: "REFUSED" });
    expect(await send(api(() => new Response("<html>", { status })).api)).toEqual({ outcome: "refused", code: null });
  });
  it.each([401, 403, 408, 429, 500, 503])("HTTP %i is thrown, never a success or a refusal", async status => {
    await expect(send(api(() => response({ error: { code: "X" } }, status)).api)).rejects.toMatchObject({ kind: "http", status });
  });
  it("a network failure is thrown as unknown", async () => {
    await expect(send(api(() => { throw new TypeError("offline"); }).api)).rejects.toBeInstanceOf(ApiError);
  });
  it("refuses a blank or malformed intent and bad credentials before any request", async () => {
    const { api: client, fetcher } = api(() => response(saved()));
    await expect(send(client, { ...intent, payload: { text: "  " } })).rejects.toThrow("invalid feedback intent");
    await expect(client.send("", "proof", origin, intent)).rejects.toThrow("invalid feedback command");
    await expect(client.send("token", "proof", { clientInstanceId: "x", documentId: id(2) }, intent)).rejects.toThrow("invalid feedback command");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("status", () => {
  const status = (body: unknown, code = 200) => readWithTicket(intent, (__command, __ticket) => api(() => response(body, code)).api.status("token", id(50), __command, __ticket));
  it("names an applied command by reference", async () => {
    expect(await status({ command: fact({}, "already_applied"), current: { inbox_id: id(900), card_id: null }, state_version: "5" }))
      .toEqual({ outcome: "accepted", inboxId: id(900) });
    expect(await status({ command: fact({}, "already_applied"), current: { status: "unavailable" }, state_version: "5" }))
      .toEqual({ outcome: "accepted", inboxId: id(900) });
  });
  it("a missing command carries the profile and nothing else", async () => {
    expect(await status({ command: { id: id(100), status: "not_found" }, current: profile("5"), state_version: "5" })).toEqual({ outcome: "not_found" });
    await expect(status({ command: { id: id(100), status: "not_found" }, current: { ...profile("5"), profile_id: id(51) }, state_version: "5" }))
      .rejects.toMatchObject({ kind: "invalid_response" });
    await expect(status({ command: { id: id(101), status: "not_found" }, current: profile("5"), state_version: "5" }))
      .rejects.toMatchObject({ kind: "invalid_response" });
  });
  it.each([
    ["a fresh applied status", { command: fact(), current: { inbox_id: id(900), card_id: null }, state_version: "5" }],
    ["another kind", { command: fact({ kind: "setting.save" }, "already_applied"), current: { inbox_id: id(900), card_id: null }, state_version: "5" }],
    ["a record other than the target", { command: fact({}, "already_applied"), current: { inbox_id: id(901), card_id: null }, state_version: "5" }],
    ["an error", { command: fact({}, "already_applied"), current: { inbox_id: id(900), card_id: null }, state_version: "5", error: { code: "X" } }],
  ])("%s is invalid", async (_name, body) => {
    await expect(status(body)).rejects.toMatchObject({ kind: "invalid_response" });
  });
  it("HTTP failures are thrown", async () => {
    await expect(status({ error: { code: "AUTH_INVALID" } }, 401)).rejects.toMatchObject({ kind: "http", status: 401 });
    await expect(status({ error: { code: "X" } }, 500)).rejects.toMatchObject({ kind: "http", status: 500 });
  });
});

describe("statusById (Q27: a message whose text is gone, by its stored ID and card)", () => {
  const byId = (body: unknown, cardId: string | null = null, code = 200) => readWithTicket(intent, (__command, __ticket) =>
    api(() => response(body, code)).api.statusById("token", id(50), { commandId: id(100), cardId }, __ticket));
  it("the same strict checks as status: an applied fact of this ID and card, a not_found of this profile", async () => {
    expect(await byId({ command: fact({}, "already_applied"), current: { inbox_id: id(900), card_id: null }, state_version: "5" }))
      .toEqual({ outcome: "accepted", inboxId: id(900) });
    expect(await byId({ command: fact({}, "already_applied"), current: { inbox_id: id(900), card_id: id(7) }, state_version: "5" }, id(7)))
      .toEqual({ outcome: "accepted", inboxId: id(900) });
    expect(await byId({ command: { id: id(100), status: "not_found" }, current: profile("5"), state_version: "5" })).toEqual({ outcome: "not_found" });
  });
  it.each([
    ["a not_found of another profile", { command: { id: id(100), status: "not_found" }, current: { ...profile("5"), profile_id: id(51) }, state_version: "5" }],
    ["a not_found of another ID", { command: { id: id(101), status: "not_found" }, current: profile("5"), state_version: "5" }],
    ["a fact of another card", { command: fact({}, "already_applied"), current: { inbox_id: id(900), card_id: id(8) }, state_version: "5" }],
    ["a fact of another ID", { command: fact({ id: id(101) }, "already_applied"), current: { inbox_id: id(900), card_id: null }, state_version: "5" }],
    ["a fresh applied status", { command: fact(), current: { inbox_id: id(900), card_id: null }, state_version: "5" }],
    ["another kind", { command: fact({ kind: "setting.save" }, "already_applied"), current: { inbox_id: id(900), card_id: null }, state_version: "5" }],
    ["an error", { command: fact({}, "already_applied"), current: { inbox_id: id(900), card_id: null }, state_version: "5", error: { code: "X" } }],
  ])("%s is invalid", async (_name, body) => {
    await expect(byId(body)).rejects.toMatchObject({ kind: "invalid_response" });
  });
  it("a GET only, never a send; bad subjects are refused before any request", async () => {
    const client = api(() => response({ command: { id: id(100), status: "not_found" }, current: profile("5"), state_version: "5" }));
    await readWithTicket(intent, (_c, ticket) => client.api.statusById("token", id(50), { commandId: id(100), cardId: null }, ticket));
    expect(client.fetcher.mock.calls.map(([url, init]) => [String(url).replace(/^.*\/commands/, "/commands"), init?.method]))
      .toEqual([[`/commands/${id(100)}`, "GET"]]);
    await expect(readWithTicket(intent, (_c, ticket) => client.api.statusById("token", id(50), { commandId: "x", cardId: null }, ticket)))
      .rejects.toThrow("invalid feedback subject");
    await expect(readWithTicket(intent, (_c, ticket) => client.api.statusById("token", id(50), { commandId: id(100), cardId: "x" }, ticket)))
      .rejects.toThrow("invalid feedback subject");
    expect(client.fetcher).toHaveBeenCalledTimes(1);
  });
});
