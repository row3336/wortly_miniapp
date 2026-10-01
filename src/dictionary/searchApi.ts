import type { DictionarySearchResponse } from "../api/generated";
import { ApiError, createJsonTransport, httpError, type HttpOptions } from "../api/http";
import { exactKeys, oneOf, record, uuid, version } from "../api/wireValidation";

export interface SearchRequest {
  query: string;
  include_phrases: boolean;
  limit: number;
  cursor_token: string | null;
}

export interface DictionarySearchApi {
  get(token: string, request: SearchRequest): Promise<DictionarySearchResponse>;
}

const kinds = ["noun", "verb", "phrase", "adjective", "pronoun", "adverb", "preposition", "conjunction", "particle"];
const ranks = ["exact", "prefix", "substring"];
const opaqueCursor = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value);

function validRequest(value: unknown): value is SearchRequest {
  if (!record(value) || !exactKeys(value, ["query", "include_phrases", "limit", "cursor_token"])
    || typeof value.query !== "string" || value.query.length === 0
    || typeof value.include_phrases !== "boolean" || typeof value.limit !== "number"
    || !Number.isSafeInteger(value.limit) || value.limit < 1
    || (value.cursor_token !== null && !opaqueCursor(value.cursor_token))) return false;
  // URLSearchParams replaces lone surrogates. Refuse them instead of silently
  // changing the raw query that the server binds into its cursor.
  return [...value.query].every(char => {
    const code = char.codePointAt(0)!;
    return code < 0xd800 || code > 0xdfff;
  });
}

/** Validate one ordinary page without interpreting the server's opaque cursor. */
export function validSearchPage(value: unknown, request: SearchRequest): value is DictionarySearchResponse {
  if (!validRequest(request) || !record(value)
    || !exactKeys(value, ["state_version", "query", "pair", "include_phrases", "items", "next_cursor"])
    || !version(value.state_version) || value.query !== request.query
    || value.include_phrases !== request.include_phrases || !oneOf(value.pair, ["ru-de", "uk-de", "en-de"])
    || !Array.isArray(value.items) || value.items.length > request.limit
    || (value.next_cursor !== null && (!opaqueCursor(value.next_cursor)
      || value.items.length !== request.limit || value.next_cursor === request.cursor_token))) return false;
  const seen = new Set<string>();
  let previousRank = -1, previousId = "";
  for (const item of value.items) {
    if (!record(item) || !exactKeys(item, ["card_id", "revision", "lemma", "type", "cefr", "translation", "match_kind"])
      || !uuid(item.card_id) || !version(item.revision) || typeof item.lemma !== "string"
      || !oneOf(item.type, kinds) || (!request.include_phrases && item.type === "phrase")
      || (item.cefr !== null && !oneOf(item.cefr, ["A1", "A2", "B1", "B2", "C1", "C2"]))
      || !oneOf(item.match_kind, ranks) || !record(item.translation)
      || !exactKeys(item.translation, ["common", "personal"]) || !Array.isArray(item.translation.common)) return false;
    for (const text of item.translation.common) if (typeof text !== "string") return false;
    const personal = item.translation.personal;
    if (personal !== null && (!record(personal) || !exactKeys(personal, ["value", "version"])
      || typeof personal.value !== "string" || !version(personal.version))) return false;
    const id = item.card_id.toLowerCase(), rank = ranks.indexOf(item.match_kind as string);
    if (seen.has(id) || rank < previousRank || (rank === previousRank && id <= previousId)) return false;
    seen.add(id); previousRank = rank; previousId = id;
  }
  return true;
}

/** Single bounded read. Cursor refusal never retries with a different query or first page. */
export function createDictionarySearchApi(options: HttpOptions): DictionarySearchApi {
  const transport = createJsonTransport(options);
  return {
    async get(token, request) {
      if (typeof token !== "string" || !token || !validRequest(request)) throw new Error("token and explicit search parameters are required");
      // Capture the request before awaiting: callers may edit their search input.
      const captured = { ...request };
      const params = new URLSearchParams({ query: captured.query, include_phrases: String(captured.include_phrases),
        limit: String(captured.limit) });
      if (captured.cursor_token !== null) params.set("cursor_token", captured.cursor_token);
      const reply = await transport(`/dictionary/search?${params.toString()}`, { method: "GET", token });
      if (!reply.ok) throw httpError(reply);
      if (reply.status !== 200 || !validSearchPage(reply.value, captured)) throw new ApiError("invalid_response");
      return reply.value;
    },
  };
}
