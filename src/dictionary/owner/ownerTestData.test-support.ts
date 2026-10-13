import type { CommonFieldsCurrent } from "../../api/generated";
import type { CommonCommand, CommonSaveIntent } from "./commonFieldApi";

export const fid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const CONTEXT = fid(500), CARD_ID = fid(901), CLIENT_ID = fid(1), DOCUMENT_ID = fid(2);
export const origin = { client_instance_id: CLIENT_ID, document_id: DOCUMENT_ID };

export const NOUN_GRAMMAR = { gender: "neuter", gender_status: "applicable", singular: "Haus", singular_status: "applicable",
  plural: "Häuser", plural_status: "applicable", article_status: "applicable" } as const;

export function translationIntent(change: Partial<CommonSaveIntent> = {}): CommonSaveIntent {
  return { kind: "field.save", command_id: fid(10), context_id: CONTEXT, card_id: CARD_ID, field_name: "translation",
    language: "ru", value: ["дом", "жилище"], expected_field_version: "1", ...change };
}
export function grammarIntent(change: Partial<CommonSaveIntent> = {}): CommonSaveIntent {
  return { kind: "field.save", command_id: fid(11), context_id: CONTEXT, card_id: CARD_ID, field_name: "plural",
    language: null, value: { status: "applicable", value: "Häuschen" }, expected_field_version: "1", ...change };
}
export const command = (intent: CommonSaveIntent): CommonCommand => ({ ...intent, ...origin });

/** core coordinator._fact of an accepted common save: the card is the target, the new revision its version. */
export function commonFact(intent: CommonSaveIntent, status: "applied" | "already_applied" = "applied") {
  return { id: intent.command_id, kind: "field.save", status, applied_at: "2026-10-13T09:00:00Z", target_id: intent.card_id,
    action_id: null, result_id: null, context_id: intent.context_id,
    object_version: String(BigInt(intent.expected_field_version) + 1n) };
}

/** core common_projection of the owner. */
export function commonCurrent(change: Partial<CommonFieldsCurrent> = {}): CommonFieldsCurrent {
  return { status: "available", scope: "common", card_id: CARD_ID, card_type: "noun", card_revision: "2", language: "ru",
    translations: ["дом", "жилище"], grammar: { ...NOUN_GRAMMAR }, ...change };
}

export const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
