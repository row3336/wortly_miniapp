import type { StatisticsOverviewResponse } from "../api/generated";
import { ApiError, createJsonTransport, httpError, type HttpOptions } from "../api/http";
import { count, date, exactKeys, oneOf, record, version } from "../api/wireValidation";
import { validPractice, type PracticeWeek } from "./practiceApi";

export interface StatisticsApi {
  get(token: string, week: PracticeWeek): Promise<StatisticsOverviewResponse>;
}

const types = ["noun", "verb", "phrase", "adjective", "pronoun", "adverb", "preposition", "conjunction", "particle"];
const directions = ["l1-de", "de-l1"];

export function validStatistics(value: unknown, week: PracticeWeek): value is StatisticsOverviewResponse {
  if (!record(value) || !exactKeys(value, ["state_version", "local_date", "pair", "time_zone", "base", "ready", "practice"])
    || !version(value.state_version) || !date(value.local_date) || value.local_date.startsWith("0000")
    || !oneOf(value.pair, ["ru-de", "uk-de", "en-de"])
    || typeof value.time_zone !== "string" || value.time_zone.trim().length === 0
    || !record(value.base) || !exactKeys(value.base, ["total", "words", "phrases", "by_type"])
    || !count(value.base.total) || !count(value.base.words) || !count(value.base.phrases)
    || !record(value.base.by_type) || !exactKeys(value.base.by_type, types)
    || !record(value.ready) || !exactKeys(value.ready, ["words", "phrases"])) return false;

  let total = 0n;
  for (const type of types) {
    const amount = value.base.by_type[type];
    if (!count(amount)) return false;
    total += BigInt(amount);
  }
  // Exact sums must not round an overflowing combination of individually safe counts.
  if (total !== BigInt(value.base.total) || value.base.by_type.phrase !== value.base.phrases
    || BigInt(value.base.words) + BigInt(value.base.phrases) !== BigInt(value.base.total)) return false;

  for (const bucket of ["words", "phrases"] as const) {
    const ready = value.ready[bucket];
    const maximum = bucket === "words" ? value.base.words : value.base.phrases;
    if (!record(ready) || !exactKeys(ready, directions)) return false;
    for (const direction of directions) {
      const amount = ready[direction];
      if (!count(amount) || amount > maximum) return false;
    }
  }
  return validPractice(value.practice, week)
    && value.practice.state_version === value.state_version && value.practice.local_date === value.local_date
    && value.practice.pair === value.pair && value.practice.time_zone === value.time_zone;
}

/** Read the server snapshot without deriving additional metrics or bounding historical practice by today's base. */
export function createStatisticsApi(options: HttpOptions): StatisticsApi {
  const request = createJsonTransport(options);
  return {
    async get(token, week) {
      if (!token || !oneOf(week, ["current", "previous"])) throw new Error("token and explicit statistics week are required");
      const reply = await request(`/statistics/overview?week=${week}`, { method: "GET", token });
      if (!reply.ok) throw httpError(reply);
      if (reply.status !== 200 || !validStatistics(reply.value, week)) throw new ApiError("invalid_response");
      return reply.value;
    },
  };
}
