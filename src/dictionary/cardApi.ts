import type { DictionaryCardResponse } from "../api/generated";
import { ApiError, createJsonTransport, httpError, type HttpOptions } from "../api/http";
import { exactKeys, record, uuid, version } from "../api/wireValidation";
import { validReferenceCardContent } from "../study/referenceCardContent";

export interface DictionaryCardApi {
  read(token: string, cardId: string): Promise<DictionaryCardResponse>;
}

/** The current server pair may differ from the earlier search result's pair. */
export function validDictionaryCard(value: unknown, cardId: string): value is DictionaryCardResponse {
  if (!uuid(cardId) || !record(value) || !exactKeys(value, ["state_version", "current"])
    || !version(value.state_version) || !record(value.current)) return false;
  const current = value.current;
  if (current.status === "unavailable") return exactKeys(current, ["status"]);
  return typeof current.pair === "string" && validReferenceCardContent(current, cardId, current.pair);
}

/** One bounded authenticated read, without origin proof, local caching or retry. */
export function createDictionaryCardApi(options: HttpOptions): DictionaryCardApi {
  const transport = createJsonTransport(options);
  return {
    async read(token, cardId) {
      if (typeof token !== "string" || !token || !uuid(cardId)) throw new Error("token and card ID are required");
      const reply = await transport(`/dictionary/cards/${cardId}`, { method: "GET", token });
      if (!reply.ok) throw httpError(reply);
      if (reply.status !== 200 || !validDictionaryCard(reply.value, cardId)) throw new ApiError("invalid_response");
      return reply.value;
    },
  };
}
