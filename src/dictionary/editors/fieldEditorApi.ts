import type {
  CardExample, MissingCommandFact, PersonalCardText, PersonalFieldCurrent, PrepositionExampleCurrent, PrepositionPair,
  Profile, RejectedCommandFact, SavedCommandFact, StoredCommandFact, UnavailableCurrent,
} from "../../api/generated";
import { validProfile } from "../../api/entryApi";
import { ApiError, createJsonTransport, errorCode, httpError, type HttpOptions } from "../../api/http";
import { eventTime, exactKeys, oneOf, record, sameId, uuid, version } from "../../api/wireValidation";
import { intentHash } from "../../commands/intentHash";
import { validCardExamples } from "../../study/referenceCardContent";

export type FieldName = "translation" | "example" | "association";
export type CaseRole = "akkusativ" | "dativ";
/** One own field of a card: a scalar field or one case role of a two-case preposition's example pair (K07-121). */
export type FieldKey = FieldName | CaseRole;
export type FieldLanguage = "ru" | "uk" | "en";
export const caseRoles: readonly CaseRole[] = ["akkusativ", "dativ"];
const fieldNames: readonly FieldName[] = ["translation", "example", "association"];
const languages: readonly FieldLanguage[] = ["ru", "uk", "en"];

/** The editor's raw text goes as is: the core trims the edges and treats blank as clearing (C-FIELDS-1 §12). */
export type FieldSaveIntent = {
  kind: "field.save"; command_id: string; context_id: string; card_id: string; language: FieldLanguage;
  field_name: FieldName; case_role: CaseRole | null; value: string | null; expected_field_version: string;
};
/** Only a translation save has its own undo (CT table 2.3). */
export type FieldUndoIntent = {
  kind: "field.undo"; command_id: string; context_id: string; card_id: string; language: FieldLanguage;
  action_id: string; expected_action_version: string; expected_field_version: string;
};
export type FieldIntent = FieldSaveIntent | FieldUndoIntent;
export type FieldOrigin = { client_instance_id: string; document_id: string };
export type FieldCommand<T extends FieldIntent = FieldIntent> = T & FieldOrigin;
export type FieldCurrent = PersonalFieldCurrent | PrepositionExampleCurrent | UnavailableCurrent;

export type FieldCommandReply = { current: FieldCurrent; state_version: string } & (
  | { outcome: "accepted"; command: SavedCommandFact }
  | { outcome: "rejected" | "mismatch"; command: RejectedCommandFact; error: { code: string } }
);
export type FieldCommandStatus =
  | { outcome: "accepted"; command: StoredCommandFact; current: FieldCurrent; state_version: string }
  | { outcome: "not_found"; command: MissingCommandFact; current: Profile; state_version: string }
  | { outcome: "mismatch"; error: { code: "COMMAND_PAYLOAD_MISMATCH" } };

/**
 * One request per call, never repeated. A thrown local Error means nothing was sent;
 * an ApiError after a command POST is resolved by status (commands/commandOutcome.ts).
 */
export interface FieldEditorApi {
  send(token: string, proof: string, command: FieldCommand): Promise<FieldCommandReply>;
  status(token: string, proof: string, command: FieldCommand): Promise<FieldCommandStatus>;
}

export function fieldKeyOf(intent: FieldIntent): FieldKey {
  return intent.kind === "field.undo" ? "translation" : intent.case_role ?? intent.field_name;
}

export function validFieldIntent(value: unknown): value is FieldIntent {
  if (!record(value) || !uuid(value.command_id) || !uuid(value.context_id) || !uuid(value.card_id)
    || !oneOf(value.language, [...languages]) || !version(value.expected_field_version)) return false;
  if (value.kind === "field.undo") {
    return exactKeys(value, ["kind", "command_id", "context_id", "card_id", "language", "action_id",
      "expected_action_version", "expected_field_version"]) && uuid(value.action_id) && version(value.expected_action_version);
  }
  return value.kind === "field.save" && exactKeys(value, ["kind", "command_id", "context_id", "card_id", "language",
    "field_name", "case_role", "value", "expected_field_version"])
    && oneOf(value.field_name, [...fieldNames]) && (value.value === null || typeof value.value === "string")
    // A case role addresses only the example pair (core FieldSavePayload.case_role).
    && (value.case_role === null || oneOf(value.case_role, [...caseRoles]) && value.field_name === "example");
}

/** Detached copy with lower-case UUIDs, as core str(UUID) fingerprints them. */
export function copyFieldIntent<T extends FieldIntent>(value: T): T {
  if (!validFieldIntent(value)) throw new Error("invalid field intent");
  const id = (text: string) => text.toLowerCase();
  const head = { command_id: id(value.command_id), context_id: id(value.context_id), card_id: id(value.card_id),
    language: value.language };
  if (value.kind === "field.undo") {
    return { kind: value.kind, ...head, action_id: id(value.action_id), expected_action_version: value.expected_action_version,
      expected_field_version: value.expected_field_version } as T;
  }
  return { kind: value.kind, ...head, field_name: value.field_name, case_role: value.case_role, value: value.value,
    expected_field_version: value.expected_field_version } as T;
}

/** Service payload of core PersonalFields.save / FieldUndoService.undo: versions as strings. */
function fingerprintPayload(intent: FieldIntent): Record<string, unknown> {
  if (intent.kind === "field.undo") {
    return { context_id: intent.context_id, action_id: intent.action_id, expected_action_version: intent.expected_action_version,
      card_id: intent.card_id, language: intent.language, field_name: "translation",
      expected_field_version: intent.expected_field_version };
  }
  // A scalar save keeps its C-FIELDS-1 fingerprint; only a role adds its own key (C-FIELDS-2 §4).
  return { context_id: intent.context_id, card_id: intent.card_id, language: intent.language, field_name: intent.field_name,
    scope: "personal", value: intent.value, expected_field_version: intent.expected_field_version,
    ...(intent.case_role === null ? {} : { case_role: intent.case_role }) };
}

/** Matches core identity.intent_hash(kind, payload); origin and command ID are not part of it. */
export function fieldIntentHash(value: FieldIntent): Promise<string> {
  const intent = copyFieldIntent(value);
  return intentHash(intent.kind, fingerprintPayload(intent));
}


function prepareCommand(token: string, proof: string, value: FieldCommand): FieldCommand {
  if (typeof token !== "string" || !token || typeof proof !== "string" || !proof || !record(value)) {
    throw new Error("invalid field command");
  }
  const { client_instance_id: clientId, document_id: documentId, ...rest } = value as Record<string, unknown>;
  if (!uuid(clientId) || !uuid(documentId)) throw new Error("invalid field command");
  return { ...copyFieldIntent(rest as FieldIntent), client_instance_id: clientId.toLowerCase(), document_id: documentId.toLowerCase() };
}

function wireBody(command: FieldCommand): object {
  const head = { command_id: command.command_id, kind: command.kind, client_instance_id: command.client_instance_id,
    document_id: command.document_id, context_id: command.context_id };
  if (command.kind === "field.undo") {
    return { ...head, action_id: command.action_id, expected_action_version: command.expected_action_version,
      expected_field_version: command.expected_field_version,
      payload: { card_id: command.card_id, field_name: "translation", language: command.language } };
  }
  return { ...head, expected_field_version: command.expected_field_version,
    payload: { card_id: command.card_id, field_name: command.field_name, scope: "personal", language: command.language,
      value: command.value, ...(command.case_role === null ? {} : { case_role: command.case_role }) } };
}

/** A stored own text is never blank (core _editor_text); its version is the field version. */
function ownText(value: unknown, fieldVersion: unknown): value is PersonalCardText {
  return record(value) && exactKeys(value, ["value", "version"]) && typeof value.value === "string"
    && value.value.trim() !== "" && version(value.version) && value.version === fieldVersion;
}
function commonExample(value: unknown, role: CardExample["role"]): boolean {
  return validCardExamples({ common: [value], personal: null }) && (value as CardExample).role === role;
}

/** Structure of the case-role pair as the role current carries it (core card_content.preposition_pair). */
function validPair(value: unknown): value is PrepositionPair {
  if (!record(value) || !exactKeys(value, ["editor", "effective"]) || !record(value.editor)
    || !exactKeys(value.editor, [...caseRoles]) || !record(value.effective)) return false;
  const editor = value.editor as Record<string, unknown>, effective = value.effective;
  if (!caseRoles.every(role => {
    const entry = editor[role];
    return record(entry) && exactKeys(entry, ["value", "version"]) && version(entry.version)
      && (entry.value === null || typeof entry.value === "string" && entry.value.trim() !== "");
  })) return false;
  const roles = editor as Record<CaseRole, { value: string | null; version: string }>;
  const full = caseRoles.every(role => roles[role].value !== null);
  if (!exactKeys(effective, ["source", ...caseRoles])) return false;
  if (effective.source === "personal") {
    return full && caseRoles.every(role => {
      const shown = effective[role];
      return record(shown) && exactKeys(shown, ["value", "version"]) && shown.value === roles[role].value
        && shown.version === roles[role].version;
    });
  }
  // One own role stays in the editor while both common examples are shown (К05-127).
  return effective.source === "common" && !full && commonExample(effective.akkusativ, "wechsel_direction")
    && commonExample(effective.dativ, "wechsel_location");
}

const fieldKeys = ["status", "card_id", "language", "card_revision", "field_name", "field_version", "personal",
  "common_translations", "common_examples", "undo_target"];
const roleKeys = ["status", "card_id", "language", "card_revision", "field_name", "case_role", "field_version",
  "personal", "preposition_pair"];

/**
 * The strict current of one addressed field (core field_projection / role_projection). It belongs to the command's
 * card, language and field; "unavailable" means the card or that language is no longer current (C-FIELDS-1 §12 Н3).
 */
export function validFieldCurrent(value: unknown, binding: { card_id: string; language: FieldLanguage; key: FieldKey;
  context_id: string }): value is FieldCurrent {
  if (record(value) && exactKeys(value, ["status"]) && value.status === "unavailable") return true;
  if (!record(value) || value.status !== "available" || !sameId(value.card_id, binding.card_id)
    || value.language !== binding.language || !version(value.card_revision) || !version(value.field_version)
    || (value.personal !== null && !ownText(value.personal, value.field_version))) return false;
  const key = binding.key;
  if (key === "akkusativ" || key === "dativ") {
    if (!exactKeys(value, roleKeys) || value.field_name !== "example" || value.case_role !== key
      || !validPair(value.preposition_pair)) return false;
    const own = value.preposition_pair.editor[key];
    return own.version === value.field_version && own.value === ((value.personal as PersonalCardText | null)?.value ?? null);
  }
  if (!exactKeys(value, fieldKeys) || value.field_name !== key) return false;
  const translations = value.common_translations, examples = value.common_examples, undo = value.undo_target;
  if (key === "translation" ? !(Array.isArray(translations) && translations.every(text => typeof text === "string"))
    : translations !== null) return false;
  if (key === "example" ? !(Array.isArray(examples) && validCardExamples({ common: examples, personal: null }))
    : examples !== null) return false;
  // The undo right of a translation save exists only in the same open card context (CT 2.3).
  return undo === null || key === "translation" && record(undo) && exactKeys(undo, ["action_id", "kind", "version", "context_id"])
    && uuid(undo.action_id) && undo.kind === "field.save" && version(undo.version) && sameId(undo.context_id, binding.context_id);
}

const factKeys = ["id", "kind", "status", "applied_at", "target_id", "action_id", "result_id", "context_id", "object_version"];

/** Fact references (core coordinator._fact; PersonalFields.save, FieldUndoService.undo). */
function acceptedFact(value: unknown, intent: FieldIntent, statuses: string[]): value is SavedCommandFact {
  if (!record(value) || !exactKeys(value, factKeys) || !sameId(value.id, intent.command_id) || value.kind !== intent.kind
    || !oneOf(value.status, statuses) || !eventTime(value.applied_at) || value.result_id !== null
    || !uuid(value.target_id) || !sameId(value.context_id, intent.context_id)
    // Every accepted write raises the field (or role) version by one, also a removal (no ABA).
    || value.object_version !== String(BigInt(intent.expected_field_version) + 1n)) return false;
  if (intent.kind === "field.undo") return sameId(value.action_id, intent.action_id);
  // Only a translation save creates an action with its own undo (CT 2.3).
  return intent.field_name === "translation" && intent.case_role === null ? uuid(value.action_id) : value.action_id === null;
}

function bindingOf(command: FieldCommand) {
  return { card_id: command.card_id, language: command.language, key: fieldKeyOf(command), context_id: command.context_id };
}

export function createFieldEditorApi(options: HttpOptions): FieldEditorApi {
  const request = createJsonTransport(options);
  return {
    async send(token, proof, original) {
      // Detached before the first await: later caller mutation cannot change the sent intent.
      const command = prepareCommand(token, proof, original);
      const reply = await request("/commands", { method: "POST", token, proof, body: wireBody(command) });
      const value = reply.value;
      if (record(value) && version(value.state_version)) {
        const stateVersion = value.state_version;
        if (reply.status === 200 && value.error == null
          && exactKeys(value, ["command", "current", "state_version", ...(Object.hasOwn(value, "error") ? ["error"] : [])])
          && acceptedFact(value.command, command, ["applied", "already_applied"])
          && validFieldCurrent(value.current, bindingOf(command))) {
          return { outcome: "accepted", command: value.command, current: value.current, state_version: stateVersion };
        }
        const code = errorCode(value);
        if ([403, 409, 422].includes(reply.status) && code && exactKeys(value, ["command", "current", "state_version", "error"])
          && record(value.error) && exactKeys(value.error, ["code"])
          && record(value.command) && exactKeys(value.command, ["id", "status"])
          && sameId(value.command.id, command.command_id) && value.command.status === "rejected"
          && validFieldCurrent(value.current, bindingOf(command))) {
          return { outcome: code === "COMMAND_PAYLOAD_MISMATCH" ? "mismatch" : "rejected",
            command: { id: command.command_id, status: "rejected" }, error: { code }, current: value.current,
            state_version: stateVersion };
        }
      }
      if (!reply.ok) throw httpError(reply);
      // HTTP 200 with an error or a foreign shape is never a success.
      throw new ApiError("invalid_response");
    },

    async status(token, proof, original) {
      const command = prepareCommand(token, proof, original);
      const { client_instance_id: clientId, document_id: documentId, ...intent } = command as Record<string, unknown>;
      const expectedHash = await fieldIntentHash(intent as FieldIntent);
      const parameters = new URLSearchParams({ client_instance_id: clientId as string, document_id: documentId as string,
        expected_intent_hash: expectedHash });
      const reply = await request.readback(command.command_id, `/commands/${command.command_id}?${parameters}`, { method: "GET", token, proof });
      const value = reply.value;
      if (reply.status === 409 && record(value) && exactKeys(value, ["error"]) && record(value.error)
        && exactKeys(value.error, ["code"]) && value.error.code === "COMMAND_PAYLOAD_MISMATCH") {
        return { outcome: "mismatch", error: { code: "COMMAND_PAYLOAD_MISMATCH" } };
      }
      if (!reply.ok) throw httpError(reply);
      if (reply.status !== 200 || !record(value) || !version(value.state_version) || !record(value.command)) {
        throw new ApiError("invalid_response");
      }
      const fact = value.command;
      if (fact.status === "not_found") {
        if (exactKeys(value, ["command", "current", "state_version"]) && exactKeys(fact, ["id", "status"])
          && sameId(fact.id, command.command_id) && validProfile(value.current) && uuid(value.current.profile_id)) {
          return { outcome: "not_found", command: { id: command.command_id, status: "not_found" },
            current: value.current, state_version: value.state_version };
        }
        throw new ApiError("invalid_response");
      }
      // The ID alone cannot tell this intent from another payload; the server echoes the verified hash.
      if (exactKeys(value, ["command", "current", "state_version", "verified_intent_hash"])
        && value.verified_intent_hash === expectedHash && acceptedFact(fact, command, ["already_applied"])
        && validFieldCurrent(value.current, bindingOf(command))) {
        return { outcome: "accepted", command: fact as StoredCommandFact, current: value.current, state_version: value.state_version };
      }
      throw new ApiError("invalid_response");
    },
  };
}
