import type { DictionarySearchResponse } from "../api/generated";
import { ApiError, createJsonTransport, httpError, type HttpOptions } from "../api/http";
import { exactKeys, oneOf, record, uuid, version } from "../api/wireValidation";

/** K07-093: two exclusive modes; there is no combined result. */
export type SearchMaterial = "words" | "phrases";

export interface SearchRequest {
  query: string;
  mode: SearchMaterial;
  limit: number;
  cursor_token: string | null;
}

export interface DictionarySearchApi {
  get(token: string, request: SearchRequest): Promise<DictionarySearchResponse>;
}

const kinds = ["noun", "verb", "phrase", "adjective", "pronoun", "adverb", "preposition", "conjunction", "particle"];
const ranks = ["exact", "prefix", "substring"];
const materials: SearchMaterial[] = ["words", "phrases"];
const cardKeys = ["card_id", "revision", "lemma", "type", "cefr", "translation"];
/** K07-091: at most five similar cards, sent with the first page only. */
const SIMILAR_LIMIT = 5;
const opaqueCursor = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value);

function validRequest(value: unknown): value is SearchRequest {
  if (!record(value) || !exactKeys(value, ["query", "mode", "limit", "cursor_token"])
    || typeof value.query !== "string" || value.query.length === 0
    || !oneOf(value.mode, materials) || typeof value.limit !== "number"
    || !Number.isSafeInteger(value.limit) || value.limit < 1
    || (value.cursor_token !== null && !opaqueCursor(value.cursor_token))) return false;
  // URLSearchParams replaces lone surrogates. Refuse them instead of silently
  // changing the raw query that the server binds into its cursor.
  return [...value.query].every(char => {
    const code = char.codePointAt(0)!;
    return code < 0xd800 || code > 0xdfff;
  });
}

/** One card of the requested mode only: phrases mode carries phrases, words mode never does. */
function validCard(item: unknown, mode: SearchMaterial, keys: string[]): item is Record<string, unknown> {
  if (!record(item) || !exactKeys(item, keys)
    || !uuid(item.card_id) || !version(item.revision) || typeof item.lemma !== "string"
    || !oneOf(item.type, kinds) || (item.type === "phrase") !== (mode === "phrases")
    || (item.cefr !== null && !oneOf(item.cefr, ["A1", "A2", "B1", "B2", "C1", "C2"]))
    || !record(item.translation)
    || !exactKeys(item.translation, ["common", "personal"]) || !Array.isArray(item.translation.common)) return false;
  for (const text of item.translation.common) if (typeof text !== "string") return false;
  const personal = item.translation.personal;
  return personal === null || (record(personal) && exactKeys(personal, ["value", "version"])
    && typeof personal.value === "string" && version(personal.version));
}

/** Validate one page without interpreting the server's opaque cursor. */
export function validSearchPage(value: unknown, request: SearchRequest): value is DictionarySearchResponse {
  if (!validRequest(request) || !record(value)
    || !exactKeys(value, ["state_version", "query", "pair", "mode", "items", "next_cursor", "similar"])
    || !version(value.state_version) || value.query !== request.query
    || value.mode !== request.mode || !oneOf(value.pair, ["ru-de", "uk-de", "en-de"])
    || !Array.isArray(value.items) || value.items.length > request.limit
    || (value.next_cursor !== null && (!opaqueCursor(value.next_cursor)
      || value.items.length !== request.limit || value.next_cursor === request.cursor_token))) return false;
  // Similar cards belong to the first page; a continuation page reports none.
  if (request.cursor_token === null
    ? !Array.isArray(value.similar) || value.similar.length > SIMILAR_LIMIT
    : value.similar !== null) return false;
  if (Array.isArray(value.similar)) {
    const similar = new Set<string>();
    for (const item of value.similar) {
      if (!validCard(item, request.mode, cardKeys)) return false;
      const id = (item.card_id as string).toLowerCase();
      if (similar.has(id)) return false;
      similar.add(id);
    }
  }
  const seen = new Set<string>();
  let previousRank = -1, previousId = "";
  for (const item of value.items) {
    if (!validCard(item, request.mode, [...cardKeys, "match_kind"]) || !oneOf(item.match_kind, ranks)) return false;
    const id = (item.card_id as string).toLowerCase(), rank = ranks.indexOf(item.match_kind as string);
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
      const params = new URLSearchParams({ query: captured.query, mode: captured.mode,
        limit: String(captured.limit) });
      if (captured.cursor_token !== null) params.set("cursor_token", captured.cursor_token);
      const reply = await transport(`/dictionary/search?${params.toString()}`, { method: "GET", token });
      if (!reply.ok) throw httpError(reply);
      if (reply.status !== 200 || !validSearchPage(reply.value, captured)) throw new ApiError("invalid_response");
      return reply.value;
    },
  };
}
