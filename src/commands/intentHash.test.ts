import { describe, expect, it } from "vitest";
import { canonicalJson, intentHash } from "./intentHash";

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
