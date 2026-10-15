import type {
  CardActionsCurrent, DictionaryCardActions, MissingCommandFact, Profile, SavedCommandFact, StoredCommandFact, UnavailableCurrent,
} from "../../api/generated";
import { validProfile } from "../../api/entryApi";
import { ApiError, createJsonTransport, errorCode, httpError, type HttpOptions } from "../../api/http";
import { eventTime, exactKeys, oneOf, record, sameId, uuid, version } from "../../api/wireValidation";
import { intentHash } from "../../commands/intentHash";

/**
 * «Не повторять» / «Вернуть в повторы» compare-and-set the card's own study state: the expected version is
 * study.facts.exclusion.version of the shown card (null: no state row yet), never command.object_version (C-EXCL §9).
 */
export type CardStateIntent = {
  kind: "card.exclude" | "card.return"; command_id: string; card_id: string; expected_card_state_version: string | null;
};
/** «Изучить заново» carries its separate confirmation and no version (CT 2.1, К07-077). */
export type CardRelearnIntent = { kind: "card.relearn"; command_id: string; card_id: string; confirmed: true };
export type CardActionIntent = CardStateIntent | CardRelearnIntent;
export type CardActionKind = CardActionIntent["kind"];
export type CardActionOrigin = { client_instance_id: string; document_id: string };
export type CardActionCommand = CardActionIntent & CardActionOrigin;
export type CardActionCurrent = CardActionsCurrent | UnavailableCurrent;

export type CardActionReply = { current: CardActionCurrent; state_version: string } & (
  | { outcome: "accepted"; command: SavedCommandFact }
  | { outcome: "rejected" | "mismatch"; error: { code: string } }
);
export type CardActionStatus =
  | { outcome: "accepted"; command: StoredCommandFact; current: CardActionCurrent; state_version: string }
  | { outcome: "not_found"; command: MissingCommandFact; current: Profile; state_version: string }
  | { outcome: "mismatch" };

/**
 * One request per call, never repeated. A thrown local Error means nothing was sent; an ApiError after a command POST
 * is resolved by status (commands/commandOutcome.ts).
 */
export interface CardActionApi {
  send(token: string, proof: string, command: CardActionCommand): Promise<CardActionReply>;
  status(token: string, proof: string, command: CardActionCommand): Promise<CardActionStatus>;
}

const kinds: readonly CardActionKind[] = ["card.exclude", "card.return", "card.relearn"];

export function validCardActionIntent(value: unknown): value is CardActionIntent {
  if (!record(value) || !oneOf(value.kind, [...kinds]) || !uuid(value.command_id) || !uuid(value.card_id)) return false;
  if (value.kind === "card.relearn") return exactKeys(value, ["kind", "command_id", "card_id", "confirmed"]) && value.confirmed === true;
  return exactKeys(value, ["kind", "command_id", "card_id", "expected_card_state_version"])
    && (value.expected_card_state_version === null || version(value.expected_card_state_version));
}

/** Detached copy with lower-case UUIDs, as core str(UUID) fingerprints them. */
export function copyCardActionIntent<T extends CardActionIntent>(value: T): T {
  if (!validCardActionIntent(value)) throw new Error("invalid card action intent");
  const head = { command_id: value.command_id.toLowerCase(), card_id: value.card_id.toLowerCase() };
  if (value.kind === "card.relearn") return { kind: value.kind, ...head, confirmed: true } as T;
  return { kind: value.kind, ...head, expected_card_state_version: value.expected_card_state_version } as T;
}

/** The service payload of core CardExclusionService (card_exclusion.py): the version as a string or null. */
function fingerprintPayload(intent: CardActionIntent): Record<string, unknown> {
  return intent.kind === "card.relearn" ? { card_id: intent.card_id, confirmed: true }
    : { card_id: intent.card_id, expected_card_state_version: intent.expected_card_state_version };
}

/** Matches core identity.intent_hash(kind, payload); origin and command ID are not part of it. */
export function cardActionIntentHash(value: CardActionIntent): Promise<string> {
  const intent = copyCardActionIntent(value);
  return intentHash(intent.kind, fingerprintPayload(intent));
}

function prepareCommand(token: string, proof: string, value: CardActionCommand): CardActionCommand {
  if (typeof token !== "string" || !token || typeof proof !== "string" || !proof || !record(value)) {
    throw new Error("invalid card action command");
  }
  const { client_instance_id: clientId, document_id: documentId, ...rest } = value as Record<string, unknown>;
  if (!uuid(clientId) || !uuid(documentId)) throw new Error("invalid card action command");
  return { ...copyCardActionIntent(rest as CardActionIntent), client_instance_id: clientId.toLowerCase(),
    document_id: documentId.toLowerCase() };
}

function wireBody(command: CardActionCommand): object {
  const head = { command_id: command.command_id, kind: command.kind, client_instance_id: command.client_instance_id,
    document_id: command.document_id };
  if (command.kind === "card.relearn") return { ...head, payload: { card_id: command.card_id, confirmed: true } };
  return { ...head, expected_card_state_version: command.expected_card_state_version, payload: { card_id: command.card_id } };
}

/** The same consistency the card view decoder requires (viewApi): an excluded card offers only return. */
function validActions(value: unknown, excluded: boolean): value is DictionaryCardActions {
  return record(value) && exactKeys(value, ["exclude", "return", "relearn"]) && typeof value.exclude === "boolean"
    && typeof value.return === "boolean" && typeof value.relearn === "boolean"
    && value.return === excluded && value.exclude === value.relearn && !(value.exclude && excluded);
}

/** core card_actions_projection: the current flag of the command's card, or unavailable (card or document gone). */
export function validCardActionCurrent(value: unknown, cardId: string): value is CardActionCurrent {
  if (record(value) && exactKeys(value, ["status"]) && value.status === "unavailable") return true;
  return record(value) && exactKeys(value, ["status", "card_id", "pair", "excluded", "version", "actions"])
    && value.status === "available" && sameId(value.card_id, cardId) && oneOf(value.pair, ["ru-de", "uk-de", "en-de"])
    && typeof value.excluded === "boolean" && (value.version === null || version(value.version))
    && validActions(value.actions, value.excluded);
}

const factKeys = ["id", "kind", "status", "applied_at", "target_id", "action_id", "result_id", "context_id", "object_version"];

/** Fact references (core coordinator._fact; CardExclusionService._execute): a history action without undo. */
function acceptedFact(value: unknown, intent: CardActionIntent, statuses: string[]): value is SavedCommandFact {
  if (!record(value) || !exactKeys(value, factKeys) || !sameId(value.id, intent.command_id) || value.kind !== intent.kind
    || !oneOf(value.status, statuses) || !eventTime(value.applied_at) || !sameId(value.target_id, intent.card_id)
    || !uuid(value.action_id) || value.result_id !== null || value.context_id !== null) return false;
  // object_version is not the client's (C-EXCL §9: the progress version for relearn); the next command's version comes
  // from current.version or a new card read.
  return value.object_version === null || version(value.object_version);
}

export function createCardActionApi(options: HttpOptions): CardActionApi {
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
          && validCardActionCurrent(value.current, command.card_id)) {
          return { outcome: "accepted", command: value.command, current: value.current, state_version: stateVersion };
        }
        const code = errorCode(value);
        if ([403, 409, 422].includes(reply.status) && code && exactKeys(value, ["command", "current", "state_version", "error"])
          && record(value.error) && exactKeys(value.error, ["code"])
          && record(value.command) && exactKeys(value.command, ["id", "status"])
          && sameId(value.command.id, command.command_id) && value.command.status === "rejected"
          && validCardActionCurrent(value.current, command.card_id)) {
          return { outcome: code === "COMMAND_PAYLOAD_MISMATCH" ? "mismatch" : "rejected", error: { code },
            current: value.current, state_version: stateVersion };
        }
      }
      if (!reply.ok) throw httpError(reply);
      // HTTP 200 with an error or a foreign shape is never a success.
      throw new ApiError("invalid_response");
    },

    async status(token, proof, original) {
      const command = prepareCommand(token, proof, original);
      const { client_instance_id: clientId, document_id: documentId, ...intent } = command as Record<string, unknown>;
      const expectedHash = await cardActionIntentHash(intent as CardActionIntent);
      const parameters = new URLSearchParams({ client_instance_id: clientId as string, document_id: documentId as string,
        expected_intent_hash: expectedHash });
      const reply = await request.readback(command.command_id, `/commands/${command.command_id}?${parameters}`, { method: "GET", token, proof });
      const value = reply.value;
      if (reply.status === 409 && record(value) && exactKeys(value, ["error"]) && record(value.error)
        && exactKeys(value.error, ["code"]) && value.error.code === "COMMAND_PAYLOAD_MISMATCH") return { outcome: "mismatch" };
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
        && validCardActionCurrent(value.current, command.card_id)) {
        return { outcome: "accepted", command: fact as StoredCommandFact, current: value.current, state_version: value.state_version };
      }
      throw new ApiError("invalid_response");
    },
  };
}
