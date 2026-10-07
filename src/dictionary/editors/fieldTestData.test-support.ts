import type { PrepositionPair } from "../../api/generated";
import type { FieldCommand, FieldSaveIntent, FieldUndoIntent } from "./fieldEditorApi";

export const fid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const CONTEXT = fid(500), CARD_ID = fid(901), ACTION = fid(777), FIELD_ROW = fid(600), CLIENT_ID = fid(1), DOCUMENT_ID = fid(2);
export const origin = { client_instance_id: CLIENT_ID, document_id: DOCUMENT_ID };

export function saveIntent(change: Partial<FieldSaveIntent> = {}): FieldSaveIntent {
  return { kind: "field.save", command_id: fid(10), context_id: CONTEXT, card_id: CARD_ID, language: "ru",
    field_name: "translation", case_role: null, value: "мой дом", expected_field_version: "1", ...change };
}
export function undoIntent(change: Partial<FieldUndoIntent> = {}): FieldUndoIntent {
  return { kind: "field.undo", command_id: fid(11), context_id: CONTEXT, card_id: CARD_ID, language: "ru",
    action_id: ACTION, expected_action_version: "1", expected_field_version: "2", ...change };
}

/** core coordinator._fact of an accepted field command. */
export function fieldFact(command: FieldCommand, status: "applied" | "already_applied" = "applied", actionId: string | null = null) {
  const translationSave = command.kind === "field.save" && command.field_name === "translation" && command.case_role === null;
  return { id: command.command_id, kind: command.kind, status, applied_at: "2026-10-07T09:00:00Z", target_id: FIELD_ROW,
    action_id: command.kind === "field.undo" ? command.action_id : translationSave ? actionId ?? ACTION : null,
    result_id: null, context_id: command.context_id, object_version: String(BigInt(command.expected_field_version) + 1n) };
}

/** core field_projection for a scalar field. */
export function scalarCurrent(field: "translation" | "example" | "association", value: string | null, version: string,
  options: { undo?: { action_id: string; version?: string } | null; common?: string[]; language?: string } = {}) {
  return { status: "available", card_id: CARD_ID, language: options.language ?? "ru", card_revision: "1", field_name: field,
    field_version: version, personal: value === null ? null : { value, version },
    common_translations: field === "translation" ? options.common ?? ["дом"] : null,
    common_examples: field === "example" ? [] : null,
    undo_target: options.undo ? { action_id: options.undo.action_id, kind: "field.save", version: options.undo.version ?? "1",
      context_id: CONTEXT } : null };
}

const commonDirection = { id: fid(801), text: "Ich gehe in die Stadt.", role: "wechsel_direction", highlighted_parts: [] };
const commonLocation = { id: fid(802), text: "Ich bin in der Stadt.", role: "wechsel_location", highlighted_parts: [] };

/** core card_content.preposition_pair. */
export function pairOf(akkusativ: { value: string | null; version: string }, dativ: { value: string | null; version: string }): PrepositionPair {
  const full = akkusativ.value !== null && dativ.value !== null;
  return { editor: { akkusativ, dativ }, effective: full
    ? { source: "personal", akkusativ: { value: akkusativ.value!, version: akkusativ.version }, dativ: { value: dativ.value!, version: dativ.version } }
    : { source: "common", akkusativ: commonDirection as never, dativ: commonLocation as never } };
}

/** core role_projection of one case role. */
export function roleCurrent(role: "akkusativ" | "dativ", pair: PrepositionPair) {
  const own = pair.editor[role];
  return { status: "available", card_id: CARD_ID, language: "ru", card_revision: "1", field_name: "example", case_role: role,
    field_version: own.version, personal: own.value === null ? null : { value: own.value, version: own.version }, preposition_pair: pair };
}

export const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
