import type {
  CommonFieldsCurrent, CommonGrammarForm, CommonTranslationsResponse, MissingCommandFact, Profile, ReferenceAdjective, ReferenceNoun, ReferenceVerb,
  RejectedCommandFact, SavedCommandFact, StoredCommandFact, UnavailableCurrent,
} from "../../api/generated";
import { validProfile } from "../../api/entryApi";
import { ApiError, createJsonTransport, errorCode, httpError, type HttpOptions } from "../../api/http";
import { eventTime, exactKeys, oneOf, record, sameId, uuid, version } from "../../api/wireValidation";
import { intentHash } from "../../commands/intentHash";
import { validCardGrammar } from "../../study/referenceCardContent";
import type { ReadbackTicket } from "../../commands/writeGate";

export type CommonLanguage = "ru" | "uk" | "en";
export type CardType = CommonFieldsCurrent["card_type"];
export type EditableGrammar = ReferenceNoun | ReferenceVerb | ReferenceAdjective;
/** Grammar the owner edits, per card type (core common_fields.GRAMMAR_FIELDS; owner's decision R12-05). */
export const grammarFields = {
  noun: ["gender", "singular", "plural", "article"],
  verb: ["infinitive", "preterite", "participle_ii", "auxiliary", "separability"],
  adjective: ["positive", "comparative", "superlative"],
} as const;
export type GrammarCardType = keyof typeof grammarFields;
export type GrammarFieldName = (typeof grammarFields)[GrammarCardType][number];
export type CommonFieldName = "translation" | GrammarFieldName;
export type Separability = "separable" | "inseparable" | "unknown";
export type CommonValue = string[] | CommonGrammarForm | Separability;
const languages: readonly CommonLanguage[] = ["ru", "uk", "en"];
const statuses = ["applicable", "not_applicable", "unknown"];
const separabilities: readonly Separability[] = ["separable", "inseparable", "unknown"];
const cardTypes = ["noun", "verb", "phrase", "adjective", "pronoun", "adverb", "preposition", "conjunction", "particle"];

export function grammarCardType(type: string): type is GrammarCardType {
  return Object.hasOwn(grammarFields, type);
}

/**
 * Owner field.save scope=common (core CommonFieldSavePayload, C-FIELDS-3): the whole list of one language's common
 * translations in display order, or one grammar field. The version is the card revision. Texts go as typed: the core
 * trims the edges and refuses a blank text and an empty list (R12-06).
 */
export type CommonSaveIntent = {
  kind: "field.save"; command_id: string; context_id: string; card_id: string; field_name: CommonFieldName;
  language: CommonLanguage | null; value: CommonValue; expected_field_version: string;
};
export type CommonOrigin = { client_instance_id: string; document_id: string };
export type CommonCommand = CommonSaveIntent & CommonOrigin;
export type CommonCurrent = CommonFieldsCurrent | UnavailableCurrent;

export type CommonCommandReply = { current: CommonCurrent; state_version: string } & (
  | { outcome: "accepted"; command: SavedCommandFact }
  | { outcome: "rejected" | "mismatch"; command: RejectedCommandFact; error: { code: string } }
);
export type CommonCommandStatus =
  | { outcome: "accepted"; command: StoredCommandFact; current: CommonCurrent; state_version: string }
  | { outcome: "not_found"; command: MissingCommandFact; current: Profile; state_version: string }
  | { outcome: "mismatch"; error: { code: "COMMAND_PAYLOAD_MISMATCH" } };

/** One request per call, never repeated; a thrown local Error means nothing was sent (as fieldEditorApi). */
export interface CommonFieldApi {
  send(token: string, proof: string, command: CommonCommand): Promise<CommonCommandReply>;
  status(token: string, proof: string, command: CommonCommand, ticket: ReadbackTicket): Promise<CommonCommandStatus>;
  /** R12-04: the owner's common translations of every L1, read when «Изменить перевод для всех» opens. */
  readTranslations(token: string, cardId: string): Promise<CommonTranslationsResponse>;
}

/** core CommonTranslationsResponse: every L1 present, each a list of non-blank texts in display order. */
export function validCommonTranslations(value: unknown, cardId: string): value is CommonTranslationsResponse {
  if (!record(value) || !exactKeys(value, ["state_version", "current"]) || !version(value.state_version)) return false;
  const current = value.current;
  if (record(current) && exactKeys(current, ["status"]) && current.status === "unavailable") return true;
  if (!record(current) || !exactKeys(current, ["status", "card_id", "card_revision", "language", "translations"])
    || current.status !== "available" || !sameId(current.card_id, cardId) || !version(current.card_revision)
    || !oneOf(current.language, languages) || !record(current.translations)) return false;
  const translations = current.translations;
  return exactKeys(translations, [...languages]) && languages.every(language => {
    const texts = translations[language];
    return Array.isArray(texts) && texts.every(text => typeof text === "string" && text.trim() !== "");
  });
}

function validForm(value: unknown): value is CommonGrammarForm {
  return record(value) && exactKeys(value, ["status", "value"]) && oneOf(value.status, statuses)
    && (value.value === null || typeof value.value === "string");
}

function validValue(field: unknown, value: unknown): boolean {
  if (field === "translation") return Array.isArray(value) && value.length > 0 && value.every(text => typeof text === "string");
  if (field === "separability") return oneOf(value, separabilities);
  return validForm(value);
}

const allGrammar: readonly string[] = Object.values(grammarFields).flat();

export function validCommonIntent(value: unknown): value is CommonSaveIntent {
  if (!record(value) || value.kind !== "field.save" || !exactKeys(value, ["kind", "command_id", "context_id", "card_id",
    "field_name", "language", "value", "expected_field_version"]) || !uuid(value.command_id) || !uuid(value.context_id)
    || !uuid(value.card_id) || !version(value.expected_field_version)) return false;
  // A translation is per L1; grammar is not (core CommonFieldSavePayload.language).
  if (value.field_name === "translation") return oneOf(value.language, languages) && validValue("translation", value.value);
  return oneOf(value.field_name, allGrammar) && value.language === null && validValue(value.field_name, value.value);
}

/** Detached copy with lower-case UUIDs, as core str(UUID) fingerprints them. */
export function copyCommonIntent(value: CommonSaveIntent): CommonSaveIntent {
  if (!validCommonIntent(value)) throw new Error("invalid common field intent");
  const id = (text: string) => text.toLowerCase();
  const copied: CommonValue = Array.isArray(value.value) ? [...value.value]
    : typeof value.value === "string" ? value.value : { status: value.value.status, value: value.value.value };
  return { kind: "field.save", command_id: id(value.command_id), context_id: id(value.context_id), card_id: id(value.card_id),
    field_name: value.field_name, language: value.language, value: copied, expected_field_version: value.expected_field_version };
}

/** Service payload of core CommonFields.save (its `payload` dict): versions as strings, the value as sent. */
function fingerprintPayload(intent: CommonSaveIntent): Record<string, unknown> {
  return { context_id: intent.context_id, card_id: intent.card_id, scope: "common", field_name: intent.field_name,
    language: intent.language, value: intent.value, expected_field_version: intent.expected_field_version };
}

/** Matches core identity.intent_hash(kind, payload); origin and command ID are not part of it. */
export function commonIntentHash(value: CommonSaveIntent): Promise<string> {
  const intent = copyCommonIntent(value);
  return intentHash(intent.kind, fingerprintPayload(intent));
}

function prepareCommand(token: string, proof: string, value: CommonCommand): CommonCommand {
  if (typeof token !== "string" || !token || typeof proof !== "string" || !proof || !record(value)) {
    throw new Error("invalid common field command");
  }
  const { client_instance_id: clientId, document_id: documentId, ...rest } = value as Record<string, unknown>;
  if (!uuid(clientId) || !uuid(documentId)) throw new Error("invalid common field command");
  return { ...copyCommonIntent(rest as CommonSaveIntent), client_instance_id: clientId.toLowerCase(),
    document_id: documentId.toLowerCase() };
}

function wireBody(command: CommonCommand): object {
  return { command_id: command.command_id, kind: command.kind, client_instance_id: command.client_instance_id,
    document_id: command.document_id, context_id: command.context_id, expected_field_version: command.expected_field_version,
    payload: { card_id: command.card_id, field_name: command.field_name, scope: "common", language: command.language,
      value: command.value } };
}

/** The binding of a reply's current: the card, and (when given) the owner's dictionary language it must show. */
export type CommonBinding = { card_id: string; language: CommonLanguage | null };

const currentKeys = ["status", "scope", "card_id", "card_type", "card_revision", "language", "translations", "grammar"];

/**
 * The owner's current common data of the card (core common_projection): the L1 of the profile and its translations in
 * order, the editable grammar of the card type (null for other types). Anyone else gets "unavailable".
 */
export function validCommonCurrent(value: unknown, binding: CommonBinding): value is CommonCurrent {
  if (record(value) && exactKeys(value, ["status"]) && value.status === "unavailable") return true;
  if (!record(value) || !exactKeys(value, currentKeys) || value.status !== "available" || value.scope !== "common"
    || !sameId(value.card_id, binding.card_id) || !oneOf(value.card_type, cardTypes) || !version(value.card_revision)
    || !oneOf(value.language, languages) || (binding.language !== null && value.language !== binding.language)
    || !Array.isArray(value.translations)
    || !value.translations.every(text => typeof text === "string" && text.trim() !== "")) return false;
  const type = value.card_type as string;
  return grammarCardType(type) ? validCardGrammar(value.grammar, type) : value.grammar === null;
}

const factKeys = ["id", "kind", "status", "applied_at", "target_id", "action_id", "result_id", "context_id", "object_version"];

/** Fact of an accepted common save: the card is its target, the new card revision its version; no undo right (CT 2.3). */
function acceptedFact(value: unknown, intent: CommonSaveIntent, statuses: string[]): value is SavedCommandFact {
  return record(value) && exactKeys(value, factKeys) && sameId(value.id, intent.command_id) && value.kind === "field.save"
    && oneOf(value.status, statuses) && eventTime(value.applied_at) && sameId(value.target_id, intent.card_id)
    && value.action_id === null && value.result_id === null && sameId(value.context_id, intent.context_id)
    && value.object_version === String(BigInt(intent.expected_field_version) + 1n);
}


/**
 * `dictionaryLanguage`: the owner's dictionary language of the profile now. A translation save's current must show it,
 * whatever language was saved (core 5b14780, R17-02 вар.1: any of ru, uk, en is saved in place); without it the current
 * must show the saved language itself. Grammar has no L1 of its own: any L1 of the owner's current fits.
 */
export function createCommonFieldApi(options: HttpOptions, dictionaryLanguage?: () => CommonLanguage | null): CommonFieldApi {
  const request = createJsonTransport(options);
  const bindingOf = (command: CommonCommand): CommonBinding => ({ card_id: command.card_id,
    language: command.field_name !== "translation" ? null : dictionaryLanguage?.() ?? command.language });
  return {
    async send(token, proof, original) {
      // Detached before the first await: later caller mutation cannot change the sent intent.
      const command = prepareCommand(token, proof, original);
      const reply = await request("/commands", { method: "POST", token, proof, body: wireBody(command) });
      const value = reply.value;
      const binding = bindingOf(command);
      if (record(value) && version(value.state_version)) {
        const stateVersion = value.state_version;
        if (reply.status === 200 && value.error == null
          && exactKeys(value, ["command", "current", "state_version", ...(Object.hasOwn(value, "error") ? ["error"] : [])])
          && acceptedFact(value.command, command, ["applied", "already_applied"]) && validCommonCurrent(value.current, binding)
          && notOlder(value.current, command)) {
          return { outcome: "accepted", command: value.command, current: value.current, state_version: stateVersion };
        }
        const code = errorCode(value);
        if ([403, 409, 422].includes(reply.status) && code && exactKeys(value, ["command", "current", "state_version", "error"])
          && record(value.error) && exactKeys(value.error, ["code"])
          && record(value.command) && exactKeys(value.command, ["id", "status"])
          && sameId(value.command.id, command.command_id) && value.command.status === "rejected"
          && validCommonCurrent(value.current, binding)) {
          return { outcome: code === "COMMAND_PAYLOAD_MISMATCH" ? "mismatch" : "rejected",
            command: { id: command.command_id, status: "rejected" }, error: { code }, current: value.current,
            state_version: stateVersion };
        }
      }
      if (!reply.ok) throw httpError(reply);
      // HTTP 200 with an error or a foreign shape is never a success.
      throw new ApiError("invalid_response");
    },

    async status(token, proof, original, ticket: ReadbackTicket) {
      const command = prepareCommand(token, proof, original);
      const { client_instance_id: clientId, document_id: documentId, ...intent } = command as Record<string, unknown>;
      const expectedHash = await commonIntentHash(intent as CommonSaveIntent);
      const parameters = new URLSearchParams({ client_instance_id: clientId as string, document_id: documentId as string,
        expected_intent_hash: expectedHash });
      const reply = await request(`/commands/${command.command_id}?${parameters}`, { method: "GET", token, proof, readbackTicket: ticket });
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
        && validCommonCurrent(value.current, bindingOf(command)) && notOlder(value.current, command)) {
        return { outcome: "accepted", command: fact as StoredCommandFact, current: value.current, state_version: value.state_version };
      }
      throw new ApiError("invalid_response");
    },

    async readTranslations(token, cardId) {
      if (typeof token !== "string" || !token || !uuid(cardId)) throw new Error("token and card ID are required");
      const reply = await request(`/dictionary/cards/${cardId.toLowerCase()}/common`, { method: "GET", token });
      if (!reply.ok) throw httpError(reply);
      if (reply.status !== 200 || !validCommonTranslations(reply.value, cardId)) throw new ApiError("invalid_response");
      return reply.value;
    },
  };
}

/** The current of an accepted save is at least the revision its fact made (expected + 1), never an older card. */
function notOlder(current: CommonCurrent, command: CommonCommand): boolean {
  return current.status !== "available" || BigInt(current.card_revision) > BigInt(command.expected_field_version);
}
