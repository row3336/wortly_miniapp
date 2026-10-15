// R17-02 вар.1 (core 5b14780): a translation of any of ru, uk, en is saved in place and the reply's current shows the
// owner's dictionary language. The current stays bound: to the card, to the profile's dictionary language and to a
// revision not older than the one the save made (QA 887a7d63, P2-2).
import { describe, expect, it, vi } from "vitest";
import { testGate } from "../../commands/testGate.test-support";
import { createCommonFieldApi, type CommonLanguage } from "./commonFieldApi";
import { command, commonCurrent, commonFact, fid, grammarIntent, json, translationIntent } from "./ownerTestData.test-support";

function api(dictionary: CommonLanguage | null, ...replies: Response[]) {
  const fetcher = vi.fn<typeof fetch>(async () => replies.shift() ?? json({}, 500));
  return createCommonFieldApi({ fetcher, timeoutMs: 5000, maxResponseBytes: 1_000_000, gate: testGate() }, () => dictionary);
}
const reply = (save: ReturnType<typeof command>, current: unknown) => json({ command: commonFact(save), current, state_version: "11" });

describe("R17-02: the reply of a common translation save is bound to the profile's dictionary language", () => {
  it("B1 any language saved, the current of the dictionary language is a success", async () => {
    for (const [dictionary, saved] of [["ru", "uk"], ["ru", "en"], ["uk", "ru"], ["en", "uk"], ["ru", "ru"]] as const) {
      const save = command(translationIntent({ language: saved, value: ["x"] }));
      const client = api(dictionary, reply(save, commonCurrent({ language: dictionary })));
      expect(await client.send("token", "proof", save)).toMatchObject({ outcome: "accepted", current: { language: dictionary } });
    }
  });

  it("B2 a current of another language than the profile's dictionary one is never a success, whatever was saved", async () => {
    for (const [dictionary, saved, shown] of [["ru", "ru", "uk"], ["ru", "uk", "uk"], ["ru", "uk", "en"], ["uk", "en", "ru"]] as const) {
      const save = command(translationIntent({ language: saved, value: ["x"] }));
      const client = api(dictionary, reply(save, commonCurrent({ language: shown })));
      await expect(client.send("token", "proof", save)).rejects.toMatchObject({ kind: "invalid_response" });
    }
    // A refusal is bound the same way: its current of a foreign language is not taken.
    const save = command(translationIntent({ language: "uk" }));
    const refused = api("ru", json({ command: { id: save.command_id, status: "rejected" }, current: commonCurrent({ language: "uk" }),
      state_version: "11", error: { code: "VERSION_CONFLICT" } }, 409));
    await expect(refused.send("token", "proof", save)).rejects.toMatchObject({ kind: "http", status: 409 });
  });

  it("B3 without the profile's language the current must show the saved language itself (the strict binding before R17-02)", async () => {
    const save = command(translationIntent({ language: "uk", value: ["x"] }));
    await expect(api(null, reply(save, commonCurrent({ language: "ru" }))).send("token", "proof", save))
      .rejects.toMatchObject({ kind: "invalid_response" });
    const same = command(translationIntent({ language: "uk", value: ["x"], command_id: fid(12) }));
    expect((await api(null, reply(same, commonCurrent({ language: "uk" }))).send("token", "proof", same)).outcome).toBe("accepted");
  });

  it("B4 another card or a current older than the revision the save made is never a success", async () => {
    const save = command(translationIntent({ language: "uk", value: ["x"], expected_field_version: "5" }));
    for (const current of [commonCurrent({ card_id: fid(902), card_revision: "6" }), commonCurrent({ card_revision: "5" }),
      commonCurrent({ card_revision: "4" })]) {
      await expect(api("ru", reply(save, current)).send("token", "proof", save)).rejects.toMatchObject({ kind: "invalid_response" });
    }
    expect((await api("ru", reply(save, commonCurrent({ card_revision: "6" }))).send("token", "proof", save)).outcome).toBe("accepted");
  });

  it("B5 grammar has no language of its own: any L1 of the owner's current fits", async () => {
    const save = command(grammarIntent());
    expect((await api("ru", reply(save, commonCurrent({ language: "en" }))).send("token", "proof", save)).outcome).toBe("accepted");
  });
});
