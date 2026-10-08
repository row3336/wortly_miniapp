import type { DictionaryHistoryResponse } from "../api/generated";
import { ApiError, createJsonTransport, httpError, type HttpOptions } from "../api/http";
import { eventTime, exactKeys, oneOf, record, uuid, version } from "../api/wireValidation";

/** K07-094: the history keeps the 20 most recently opened cards of the account. */
export const HISTORY_LIMIT = 20;

export interface DictionaryHistoryApi {
  read(token: string): Promise<DictionaryHistoryResponse>;
}

const pairs = ["ru-de", "uk-de", "en-de"];
const kinds = ["noun", "verb", "phrase", "adjective", "pronoun", "adverb", "preposition", "conjunction", "particle"];
const levels = ["A1", "A2", "B1", "B2", "C1", "C2"];

/**
 * The server orders entries by its own opening sequence, so equal or earlier clock times are accepted
 * as sent. An entry appears once: a repeated opening moves the card up instead of adding it again.
 * Each entry carries its list row (P18: lemma, type, level; no translation), so no card is read to show it (P19).
 * Rows hidden in the current pair or skipped by the server are simply absent, so fewer than 20 is normal.
 */
export function validDictionaryHistory(value: unknown): value is DictionaryHistoryResponse {
  if (!record(value) || !exactKeys(value, ["state_version", "pair", "items"]) || !version(value.state_version)
    || !oneOf(value.pair, pairs) || !Array.isArray(value.items) || value.items.length > HISTORY_LIMIT) return false;
  const seen = new Set<string>();
  for (const item of value.items) {
    if (!record(item) || !exactKeys(item, ["card_id", "opened_at", "lemma", "type", "cefr"]) || !uuid(item.card_id)
      || !eventTime(item.opened_at) || typeof item.lemma !== "string" || item.lemma === "" || !oneOf(item.type, kinds)
      || (item.cefr !== null && !oneOf(item.cefr, levels))) return false;
    const id = item.card_id.toLowerCase();
    if (seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}

/** One bounded authenticated read; it records nothing and is never retried here. */
export function createDictionaryHistoryApi(options: HttpOptions): DictionaryHistoryApi {
  const transport = createJsonTransport(options);
  return {
    async read(token) {
      if (typeof token !== "string" || !token) throw new Error("token is required");
      const reply = await transport("/dictionary/history", { method: "GET", token });
      if (!reply.ok) throw httpError(reply);
      if (reply.status !== 200 || !validDictionaryHistory(reply.value)) throw new ApiError("invalid_response");
      return reply.value;
    },
  };
}
