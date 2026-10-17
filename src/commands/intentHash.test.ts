import { describe, expect, it } from "vitest";
import { canonicalJson, intentHash, intentHashSync, sha256Hex } from "./intentHash";

describe("core identity.intent_hash in the client", () => {
  it("sorts keys at every level, keeps non-ASCII and arrays, escapes like json.dumps", () => {
    expect(canonicalJson({ b: [1, { d: null, c: "дом" }], a: "x\n\"" })).toBe('{"a":"x\\n\\"","b":[1,{"c":"дом","d":null}]}');
  });

  it("matches a hash computed by core (M-EDIT logs/hash_reference.txt, field.undo)", async () => {
    expect(await intentHash("field.undo", { context_id: "00000000-0000-4000-8000-000000000500",
      action_id: "00000000-0000-4000-8000-000000000777", expected_action_version: "1",
      card_id: "00000000-0000-4000-8000-000000000901", language: "ru", field_name: "translation", expected_field_version: "4" }))
      .toBe("fe82885042d354235cf94d335cc565818b0ad21bb6fd131c8b524a4d75591b57");
  });
});

describe("the synchronous digest of the local envelope fingerprint (CP5b)", () => {
  it("equals the platform SHA-256 for the core reference and for texts of every block length and script", async () => {
    const reference = { context_id: "00000000-0000-4000-8000-000000000500", action_id: "00000000-0000-4000-8000-000000000777",
      expected_action_version: "1", card_id: "00000000-0000-4000-8000-000000000901", language: "ru", field_name: "translation",
      expected_field_version: "4" };
    expect(intentHashSync("field.undo", reference)).toBe("fe82885042d354235cf94d335cc565818b0ad21bb6fd131c8b524a4d75591b57");
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    for (const size of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000]) {
      for (const unit of ["a", "ä", "дом", "🙂"]) {
        const text = unit.repeat(size);
        const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
        expect(sha256Hex(text)).toBe(Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join(""));
      }
    }
    expect(intentHashSync("answer.submit", { text: "der Tisch" })).toBe(await intentHash("answer.submit", { text: "der Tisch" }));
  });
});
