import type { DictionaryHistoryResponse } from "../api/generated";
import { ApiError, createJsonTransport, httpError, type HttpOptions } from "../api/http";
import { eventTime, exactKeys, record, uuid, version } from "../api/wireValidation";

/** K07-094: the history keeps the 20 most recently opened cards of the account. */
export const HISTORY_LIMIT = 20;

export interface DictionaryHistoryApi {
  read(token: string): Promise<DictionaryHistoryResponse>;
}

/**
 * The server orders entries by its own opening sequence, so equal or earlier clock times are accepted
 * as sent. An entry appears once: a repeated opening moves the card up instead of adding it again.
 */
export function validDictionaryHistory(value: unknown): value is DictionaryHistoryResponse {
  if (!record(value) || !exactKeys(value, ["state_version", "items"]) || !version(value.state_version)
    || !Array.isArray(value.items) || value.items.length > HISTORY_LIMIT) return false;
  const seen = new Set<string>();
  for (const item of value.items) {
    if (!record(item) || !exactKeys(item, ["card_id", "opened_at"]) || !uuid(item.card_id) || !eventTime(item.opened_at)) return false;
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
