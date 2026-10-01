import type { TopicCatalogResponse } from "../api/generated";
import { ApiError, createJsonTransport, httpError, type HttpOptions } from "../api/http";

export interface TopicCatalogApi {
  get(token: string): Promise<TopicCatalogResponse>;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }

function validCatalog(value: unknown): value is TopicCatalogResponse {
  if (!record(value) || !exact(value, ["topics", "state_version"]) || !Array.isArray(value.topics)
    || typeof value.state_version !== "string" || !/^[1-9]\d{0,18}$/.test(value.state_version)
    || BigInt(value.state_version) > 9223372036854775807n) return false;
  const ids = new Set<string>();
  let previous = 0;
  for (const topic of value.topics) {
    if (!record(topic) || !exact(topic, ["id", "number", "german_name", "description"])
      || typeof topic.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(topic.id)
      || ids.has(topic.id.toLowerCase()) || typeof topic.number !== "number" || !Number.isSafeInteger(topic.number)
      || topic.number <= previous || topic.number > 2147483647 || !text(topic.german_name) || !text(topic.description)) return false;
    ids.add(topic.id.toLowerCase());
    previous = topic.number;
  }
  return true;
}

/** The profile version is not a catalog revision. Refetch on entry and foreground. */
export function createTopicCatalogApi(options: HttpOptions): TopicCatalogApi {
  const request = createJsonTransport(options);
  return {
    async get(token) {
      if (!token) throw new Error("token is required");
      const reply = await request("/settings/topics", { method: "GET", token });
      if (!reply.ok) throw httpError(reply);
      if (!validCatalog(reply.value)) throw new ApiError("invalid_response");
      return reply.value;
    },
  };
}
