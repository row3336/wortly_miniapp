import { describe, expect, it, vi } from "vitest";
import { commonIntentHash, createCommonFieldApi, validCommonCurrent } from "./commonFieldApi";
import {
  CARD_ID, CONTEXT, command, commonCurrent, commonFact, fid, grammarIntent, json, origin, translationIntent,
} from "./ownerTestData.test-support";

function api(...replies: Response[]) {
  const fetcher = vi.fn<typeof fetch>(async () => replies.shift() ?? json({}, 500));
  return { fetcher, api: createCommonFieldApi({ fetcher, timeoutMs: 5000, maxResponseBytes: 1_000_000 }) };
}
const body = (fetcher: ReturnType<typeof api>["fetcher"], call = 0) => JSON.parse(String(fetcher.mock.calls[call][1]!.body));

describe("common field.save wire (core CommonFieldSavePayload, C-FIELDS-3)", () => {
  it("C1 fingerprints match core identity.intent_hash (list in order with raw text, grammar form, status only, separability)", async () => {
    // Expected values: core identity/service.py intent_hash run on the same payloads (logs/hash_reference.txt).
    expect(await commonIntentHash(translationIntent({ value: ["  жилище ", "дом", "здание, строение"], expected_field_version: "3" })))
      .toBe("3cf6bd00d50dec6bd5dc6cd5edd72e972003bcb57c94c88e52fd7aeaa3bd9e96");
    expect(await commonIntentHash(grammarIntent({ value: { status: "applicable", value: "Häuser" }, expected_field_version: "4" })))
      .toBe("63391e5f229afb446b729583e0722095a8a23d3992cf4b787906d0442f87b619");
    expect(await commonIntentHash(grammarIntent({ field_name: "article", value: { status: "unknown", value: null } })))
      .toBe("ddb815d8b2d4493319aebac6530f129b0f001535b712cd5e84525bb16912479e");
    expect(await commonIntentHash(grammarIntent({ field_name: "separability", value: "separable", expected_field_version: "2" })))
      .toBe("2238926709a64daaade56045e97de2657f5389debfa139b6a890bded4288c40f");
    // The order is part of the intent: another order is another command.
    expect(await commonIntentHash(translationIntent({ value: ["дом", "  жилище ", "здание, строение"], expected_field_version: "3" })))
      .not.toBe("3cf6bd00d50dec6bd5dc6cd5edd72e972003bcb57c94c88e52fd7aeaa3bd9e96");
    // Upper-case IDs are the same intent; the command ID is not part of it.
    expect(await commonIntentHash(translationIntent({ value: ["  жилище ", "дом", "здание, строение"], expected_field_version: "3",
      card_id: CARD_ID.toUpperCase(), command_id: fid(99) }))).toBe("3cf6bd00d50dec6bd5dc6cd5edd72e972003bcb57c94c88e52fd7aeaa3bd9e96");
  });

  it("C2 a translation save sends the whole list in display order with the card revision; grammar has no language", async () => {
    const save = command(translationIntent({ value: ["здание", " дом", "жилище"], expected_field_version: "7" }));
    const { fetcher, api: client } = api(json({ command: commonFact(save),
      current: commonCurrent({ card_revision: "8", translations: ["здание", "дом", "жилище"] }), state_version: "11" }));
    const reply = await client.send("token", "proof", save);
    expect(reply).toMatchObject({ outcome: "accepted", current: { translations: ["здание", "дом", "жилище"], card_revision: "8" } });
    expect(body(fetcher)).toEqual({ command_id: fid(10), kind: "field.save", client_instance_id: origin.client_instance_id,
      document_id: origin.document_id, context_id: CONTEXT, expected_field_version: "7",
      payload: { card_id: CARD_ID, field_name: "translation", scope: "common", language: "ru", value: ["здание", " дом", "жилище"] } });

    const grammar = command(grammarIntent({ field_name: "gender", value: { status: "applicable", value: "masculine" } }));
    const second = api(json({ command: commonFact(grammar), current: commonCurrent(), state_version: "12" }));
    expect((await second.api.send("token", "proof", grammar)).outcome).toBe("accepted");
    expect(body(second.fetcher).payload).toEqual({ card_id: CARD_ID, field_name: "gender", scope: "common", language: null,
      value: { status: "applicable", value: "masculine" } });
  });

  it("C3 refusals with a fact: conflict carries the current list, 422 and FORBIDDEN are rejected, a mismatch is named", async () => {
    const save = command(translationIntent());
    const rejected = (code: string, current: unknown) => ({ command: { id: save.command_id, status: "rejected" }, current,
      state_version: "11", error: { code } });
    const { api: client } = api(json(rejected("VERSION_CONFLICT", commonCurrent({ translations: ["первый"] })), 409),
      json(rejected("VALIDATION_FAILED", commonCurrent()), 422), json(rejected("FORBIDDEN", { status: "unavailable" }), 403),
      json(rejected("COMMAND_PAYLOAD_MISMATCH", commonCurrent()), 409));
    expect(await client.send("token", "proof", save)).toMatchObject({ outcome: "rejected", error: { code: "VERSION_CONFLICT" },
      current: { translations: ["первый"], card_revision: "2" } });
    expect(await client.send("token", "proof", save)).toMatchObject({ outcome: "rejected", error: { code: "VALIDATION_FAILED" } });
    expect(await client.send("token", "proof", save)).toMatchObject({ outcome: "rejected", error: { code: "FORBIDDEN" },
      current: { status: "unavailable" } });
    expect((await client.send("token", "proof", save)).outcome).toBe("mismatch");
  });

  it("C4 a 422 without a fact (refused before the transaction) is an HTTP error with its code: nothing was saved", async () => {
    const { api: client } = api(json({ error: { code: "VALIDATION_FAILED" } }, 422));
    await expect(client.send("token", "proof", command(translationIntent()))).rejects.toMatchObject({ kind: "http", status: 422,
      code: "VALIDATION_FAILED" });
  });

  it("C5 strict replies: another card or L1, a blank text, an undo action, a wrong version or an error at 200 are never a success", async () => {
    const save = command(translationIntent());
    const good = () => ({ command: commonFact(save), current: commonCurrent(), state_version: "11" });
    const broken = [
      { ...good(), current: commonCurrent({ card_id: fid(902) }) },
      { ...good(), current: commonCurrent({ language: "uk" }) },
      { ...good(), current: commonCurrent({ translations: ["дом", "  "] }) },
      { ...good(), current: { ...commonCurrent(), scope: "personal" } },
      // A noun without a grammar row has null grammar (core _grammar); a verb's grammar on a noun is foreign.
      { ...good(), current: { ...commonCurrent(), grammar: { infinitive: "gehen", infinitive_status: "applicable" } } },
      { ...good(), current: { ...commonCurrent(), extra: 1 } },
      { ...good(), command: { ...commonFact(save), action_id: fid(777) } },
      { ...good(), command: { ...commonFact(save), object_version: "3" } },
      { ...good(), command: { ...commonFact(save), target_id: fid(600) } },
      { ...good(), command: { ...commonFact(save), context_id: fid(501) } },
      { ...good(), error: { code: "VERSION_CONFLICT" } },
    ];
    for (const value of broken) {
      const { api: client } = api(json(value));
      await expect(client.send("token", "proof", save)).rejects.toMatchObject({ kind: "invalid_response" });
    }
    // A grammar save takes the owner's L1 of the current as it is; a card type without editable grammar has none.
    expect(validCommonCurrent(commonCurrent({ language: "en" }), { card_id: CARD_ID, language: null })).toBe(true);
    expect(validCommonCurrent(commonCurrent({ card_type: "phrase", grammar: null }), { card_id: CARD_ID, language: "ru" })).toBe(true);
    expect(validCommonCurrent(commonCurrent({ card_type: "phrase" }), { card_id: CARD_ID, language: "ru" })).toBe(false);
  });

  it("C6 status: the verified hash confirms the same intent; not_found and a payload mismatch are distinct", async () => {
    const save = command(translationIntent());
    const hash = await commonIntentHash(translationIntent());
    const profile = { profile_id: fid(3), access: { status: "admitted", version: "1", reason: null }, role: "owner",
      ui_language: "ru", dictionary_language: "ru", time_zone: "UTC", state_version: "11" };
    const { fetcher, api: client } = api(
      json({ command: commonFact(save, "already_applied"), current: commonCurrent(), state_version: "11", verified_intent_hash: hash }),
      json({ command: { id: save.command_id, status: "not_found" }, current: profile, state_version: "11" }),
      json({ error: { code: "COMMAND_PAYLOAD_MISMATCH" } }, 409),
      json({ command: commonFact(save, "already_applied"), current: commonCurrent(), state_version: "11",
        verified_intent_hash: "0".repeat(64) }));
    expect((await client.status("token", "proof", save)).outcome).toBe("accepted");
    const url = new URL(String(fetcher.mock.calls[0][0]), "http://local");
    expect(url.pathname).toBe(`/api/v1/commands/${fid(10)}`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ ...origin, expected_intent_hash: hash });
    expect((await client.status("token", "proof", save)).outcome).toBe("not_found");
    expect((await client.status("token", "proof", save)).outcome).toBe("mismatch");
    await expect(client.status("token", "proof", save)).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("C7 invalid intents fail before any request: an empty list (R12-06), a language on grammar, an unknown field", async () => {
    const { fetcher, api: client } = api();
    await expect(client.send("token", "proof", command(translationIntent({ value: [] })))).rejects.toThrow("invalid common field intent");
    await expect(client.send("token", "proof", command(translationIntent({ language: null })))).rejects.toThrow();
    await expect(client.send("token", "proof", command(grammarIntent({ language: "ru" })))).rejects.toThrow();
    await expect(client.send("token", "proof", command(grammarIntent({ field_name: "lemma" as never })))).rejects.toThrow();
    await expect(client.send("token", "proof", command(grammarIntent({ field_name: "separability", value: "maybe" as never })))).rejects.toThrow();
    await expect(client.send("token", "proof", command(translationIntent({ expected_field_version: "0" })))).rejects.toThrow();
    await expect(client.send("", "proof", command(translationIntent()))).rejects.toThrow("invalid common field command");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("C8 R12-04 read: every L1 in order for the owner, unavailable for anyone else; a foreign shape is never shown", async () => {
    const good = { state_version: "11", current: { status: "available", card_id: CARD_ID, card_revision: "3", language: "ru",
      translations: { ru: ["дом", "жилище"], uk: ["будинок"], en: [] } } };
    const { fetcher, api: client } = api(json(good), json({ state_version: "11", current: { status: "unavailable" } }),
      json({ ...good, current: { ...good.current, translations: { ru: ["дом"], uk: [] } } }),
      json({ ...good, current: { ...good.current, translations: { ...good.current.translations, en: ["  "] } } }),
      json({ ...good, current: { ...good.current, card_id: fid(902) } }), json({ error: { code: "AUTH_INVALID" } }, 401));
    expect(await client.readTranslations("token", CARD_ID)).toEqual(good);
    const url = new URL(String(fetcher.mock.calls[0][0]), "http://local");
    expect(url.pathname).toBe(`/api/v1/dictionary/cards/${CARD_ID}/common`);
    expect(url.search).toBe("");
    expect(fetcher.mock.calls[0][1]!.method).toBe("GET");
    expect((await client.readTranslations("token", CARD_ID)).current).toEqual({ status: "unavailable" });
    for (let index = 0; index < 3; index++) {
      await expect(client.readTranslations("token", CARD_ID)).rejects.toMatchObject({ kind: "invalid_response" });
    }
    await expect(client.readTranslations("token", CARD_ID)).rejects.toMatchObject({ kind: "http", status: 401 });
    await expect(client.readTranslations("token", "not-a-card")).rejects.toThrow("token and card ID are required");
  });
});
