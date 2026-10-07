import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/http";
import { createFieldEditorApi, fieldIntentHash, fieldOutcomeUnknown, type FieldCommand } from "./fieldEditorApi";
import {
  ACTION, CARD_ID, CONTEXT, fid, fieldFact, json, origin, pairOf, roleCurrent, saveIntent, scalarCurrent, undoIntent,
} from "./fieldTestData.test-support";

function api(...replies: Response[]) {
  const fetcher = vi.fn<typeof fetch>(async () => replies.shift() ?? json({}, 500));
  return { fetcher, api: createFieldEditorApi({ fetcher, timeoutMs: 5000, maxResponseBytes: 1_000_000 }) };
}
const body = (fetcher: ReturnType<typeof api>["fetcher"], call = 0) => JSON.parse(String(fetcher.mock.calls[call][1]!.body));
const command = <T extends object>(intent: T) => ({ ...intent, ...origin }) as unknown as FieldCommand;

describe("field command wire (core personal_fields, result_undo)", () => {
  it("A1 fingerprints match core identity.intent_hash (raw text, role, null value, undo)", async () => {
    // Expected values: core .venv python, wortly.identity.service.intent_hash (logs/hash_reference.txt).
    expect(await fieldIntentHash(saveIntent({ command_id: fid(10), value: "  идти, ходить\n", expected_field_version: "3" })))
      .toBe("96554889830b8a57563f40e4d312a9c71f66a16d052fec18a1148336403bb661");
    expect(await fieldIntentHash(saveIntent({ field_name: "example", case_role: "akkusativ", value: "Ich gehe ins Kino.", expected_field_version: "2" })))
      .toBe("18897a178c6aa750028d9c4aa06eecc479d8c9645ff98fb2ff5c17c1212b70c5");
    expect(await fieldIntentHash(saveIntent({ field_name: "association", language: "uk", value: null, expected_field_version: "1" })))
      .toBe("ae3a5884c24e4ca293909e1d1718190f3dc36f92134f635c2e59a408d7c46aa8");
    expect(await fieldIntentHash(undoIntent({ expected_field_version: "4" })))
      .toBe("fe82885042d354235cf94d335cc565818b0ad21bb6fd131c8b524a4d75591b57");
    // Upper-case IDs are the same intent; the command ID is not part of it.
    expect(await fieldIntentHash(undoIntent({ expected_field_version: "4", context_id: CONTEXT.toUpperCase(), command_id: fid(99) })))
      .toBe("fe82885042d354235cf94d335cc565818b0ad21bb6fd131c8b524a4d75591b57");
  });

  it("A2 save sends the raw editor text; a role adds case_role, a scalar field has none", async () => {
    const save = command(saveIntent({ value: "  мой дом " }));
    const { fetcher, api: client } = api(json({ command: fieldFact(save), current: scalarCurrent("translation", "мой дом", "2",
      { undo: { action_id: ACTION } }), state_version: "11" }));
    const reply = await client.send("token", "proof", save);
    expect(reply.outcome).toBe("accepted");
    expect(body(fetcher)).toEqual({ command_id: fid(10), kind: "field.save", client_instance_id: origin.client_instance_id,
      document_id: origin.document_id, context_id: CONTEXT, expected_field_version: "1",
      payload: { card_id: CARD_ID, field_name: "translation", scope: "personal", language: "ru", value: "  мой дом " } });

    const role = command(saveIntent({ field_name: "example", case_role: "dativ", value: "", expected_field_version: "2" }));
    const pair = pairOf({ value: null, version: "1" }, { value: null, version: "3" });
    const second = api(json({ command: fieldFact(role), current: roleCurrent("dativ", pair), state_version: "12" }));
    expect((await second.api.send("token", "proof", role)).outcome).toBe("accepted");
    expect(body(second.fetcher).payload).toEqual({ card_id: CARD_ID, field_name: "example", scope: "personal", language: "ru",
      value: "", case_role: "dativ" });
  });

  it("A3 undo addresses the action, its version and the field version", async () => {
    const undo = command(undoIntent());
    const { fetcher, api: client } = api(json({ command: fieldFact(undo), current: scalarCurrent("translation", null, "3"),
      state_version: "12", error: null }));
    const reply = await client.send("token", "proof", undo);
    expect(reply.outcome).toBe("accepted");
    expect(body(fetcher)).toEqual({ command_id: fid(11), kind: "field.undo", client_instance_id: origin.client_instance_id,
      document_id: origin.document_id, context_id: CONTEXT, action_id: ACTION, expected_action_version: "1",
      expected_field_version: "2", payload: { card_id: CARD_ID, field_name: "translation", language: "ru" } });
  });

  it("A4 409 VERSION_CONFLICT carries the actual value and version (Т61); a mismatch is named", async () => {
    const save = command(saveIntent());
    const conflict = { command: { id: save.command_id, status: "rejected" }, current: scalarCurrent("translation", "первый", "2"),
      state_version: "11", error: { code: "VERSION_CONFLICT" } };
    const { api: client } = api(json(conflict, 409),
      json({ ...conflict, error: { code: "COMMAND_PAYLOAD_MISMATCH" } }, 409));
    const reply = await client.send("token", "proof", save);
    expect(reply).toMatchObject({ outcome: "rejected", error: { code: "VERSION_CONFLICT" },
      current: { personal: { value: "первый", version: "2" }, field_version: "2" } });
    expect((await client.send("token", "proof", save)).outcome).toBe("mismatch");
  });

  it("A5 strict replies: another field, a foreign undo context, a wrong fact or an error at 200 are never a success", async () => {
    const save = command(saveIntent());
    const good = () => ({ command: fieldFact(save), current: scalarCurrent("translation", "мой дом", "2"), state_version: "11" });
    const broken = [
      { ...good(), current: scalarCurrent("example", "x", "2") },
      { ...good(), current: { ...scalarCurrent("translation", "мой дом", "2"), undo_target: { action_id: ACTION, kind: "field.save", version: "1", context_id: fid(501) } } },
      { ...good(), command: { ...fieldFact(save), object_version: "5" } },
      { ...good(), command: { ...fieldFact(save), action_id: null } },
      { ...good(), command: { ...fieldFact(save), context_id: fid(501) } },
      { ...good(), current: { ...scalarCurrent("translation", "мой дом", "2"), personal: { value: "  ", version: "2" } } },
      { ...good(), current: { ...scalarCurrent("translation", "мой дом", "2"), hint: null } },
      { ...good(), error: { code: "VERSION_CONFLICT" } },
    ];
    for (const value of broken) {
      const { api: client } = api(json(value));
      await expect(client.send("token", "proof", save)).rejects.toMatchObject({ kind: "invalid_response" });
    }
    // An example or association save has no undo action; an action_id there is foreign.
    const example = command(saveIntent({ field_name: "example" }));
    const { api: client } = api(json({ command: { ...fieldFact(example), action_id: ACTION },
      current: scalarCurrent("example", "x", "2"), state_version: "11" }));
    await expect(client.send("token", "proof", example)).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("A6 a role current must agree with its pair; an unavailable current is accepted as such", async () => {
    const role = command(saveIntent({ field_name: "example", case_role: "akkusativ", value: "Ich gehe.", expected_field_version: "1" }));
    const pair = pairOf({ value: "Ich gehe.", version: "2" }, { value: null, version: "1" });
    const wrong = { ...roleCurrent("akkusativ", pair), personal: { value: "Anders.", version: "2" } };
    const first = api(json({ command: fieldFact(role), current: wrong, state_version: "11" }));
    await expect(first.api.send("token", "proof", role)).rejects.toMatchObject({ kind: "invalid_response" });
    const mixed = { ...pair, effective: { source: "personal", akkusativ: { value: "Ich gehe.", version: "2" }, dativ: { value: "x", version: "1" } } };
    const second = api(json({ command: fieldFact(role), current: { ...roleCurrent("akkusativ", pair), preposition_pair: mixed }, state_version: "11" }));
    await expect(second.api.send("token", "proof", role)).rejects.toMatchObject({ kind: "invalid_response" });
    const third = api(json({ command: fieldFact(role), current: { status: "unavailable" }, state_version: "11" }));
    expect((await third.api.send("token", "proof", role)).current).toEqual({ status: "unavailable" });
  });

  it("A7 status: the verified hash confirms the same intent; not_found and a payload mismatch are distinct", async () => {
    const save = command(saveIntent());
    const hash = await fieldIntentHash(saveIntent());
    const profile = { profile_id: fid(3), access: { status: "admitted", version: "1", reason: null }, role: "user",
      ui_language: "ru", dictionary_language: "ru", time_zone: "UTC", state_version: "11" };
    const { fetcher, api: client } = api(
      json({ command: fieldFact(save, "already_applied"), current: scalarCurrent("translation", "мой дом", "2"), state_version: "11",
        verified_intent_hash: hash }),
      json({ command: { id: save.command_id, status: "not_found" }, current: profile, state_version: "11" }),
      json({ error: { code: "COMMAND_PAYLOAD_MISMATCH" } }, 409),
      json({ command: fieldFact(save, "already_applied"), current: scalarCurrent("translation", "мой дом", "2"), state_version: "11",
        verified_intent_hash: "0".repeat(64) }));
    expect((await client.status("token", "proof", save)).outcome).toBe("accepted");
    const url = new URL(String(fetcher.mock.calls[0][0]), "http://local");
    expect(url.pathname).toBe(`/api/v1/commands/${fid(10)}`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ ...origin, expected_intent_hash: hash });
    expect((await client.status("token", "proof", save)).outcome).toBe("not_found");
    expect((await client.status("token", "proof", save)).outcome).toBe("mismatch");
    await expect(client.status("token", "proof", save)).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("A8 only an HTTP refusal below 500 proves that nothing was saved", () => {
    expect(fieldOutcomeUnknown(new ApiError("network"))).toBe(true);
    expect(fieldOutcomeUnknown(new ApiError("invalid_response"))).toBe(true);
    expect(fieldOutcomeUnknown(new ApiError("http", 503, "MAINTENANCE"))).toBe(true);
    expect(fieldOutcomeUnknown(new Error("closed_access"))).toBe(true);
    expect(fieldOutcomeUnknown(new ApiError("http", 403, "FORBIDDEN"))).toBe(false);
    expect(fieldOutcomeUnknown(new ApiError("http", 409, "CLIENT_INCOMPATIBLE"))).toBe(false);
  });

  it("A9 invalid intents fail before any request", async () => {
    const { fetcher, api: client } = api();
    await expect(client.send("token", "proof", command(saveIntent({ case_role: "dativ" })))).rejects.toThrow("invalid field intent");
    await expect(client.send("token", "proof", command(saveIntent({ expected_field_version: "0" })))).rejects.toThrow();
    await expect(client.send("", "proof", command(saveIntent()))).rejects.toThrow("invalid field command");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
