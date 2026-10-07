import type { StatisticsOverviewResponse } from "../api/generated";
import { ApiError, createJsonTransport, httpError, type HttpOptions } from "../api/http";
import { count, date, exactKeys, oneOf, record, uuid, version } from "../api/wireValidation";
import { validPractice, type PracticeWeek } from "./practiceApi";

export interface StatisticsApi {
  get(token: string, week: PracticeWeek): Promise<StatisticsOverviewResponse>;
}

const types = ["noun", "verb", "phrase", "adjective", "pronoun", "adverb", "preposition", "conjunction", "particle"];
const directions = ["l1-de", "de-l1"];
const buckets = ["words", "phrases"];
const streaks = ["one", "two", "three", "four", "five_plus"];
const keys = ["state_version", "local_date", "pair", "time_zone", "base", "ready", "practice",
  "learned", "not_started", "word_results", "added"];

/** Words/phrases counts of cards from the same visible base, so neither exceeds its base bucket. */
function validCardCounts(value: unknown, words: number, phrases: number): boolean {
  if (!record(value) || !exactKeys(value, [...buckets])) return false;
  const { words: wordCount, phrases: phraseCount } = value;
  return count(wordCount) && count(phraseCount) && wordCount <= words && phraseCount <= phrases;
}

/** Each word is at most in one group: the last error or one series length. */
function validWordResults(value: unknown, words: number): boolean {
  if (!record(value) || !exactKeys(value, ["last_wrong", "streaks"]) || !count(value.last_wrong)
    || !record(value.streaks) || !exactKeys(value.streaks, streaks)) return false;
  let total = BigInt(value.last_wrong);
  for (const group of streaks) {
    const amount = value.streaks[group];
    if (!count(amount)) return false;
    total += BigInt(amount);
  }
  return total <= BigInt(words);
}

/** Owner-only service metric: absent for everyone else, never null (CT table 1.1). */
function validOwnerMetric(value: unknown): boolean {
  if (!record(value) || !exactKeys(value, ["profiles"]) || !Array.isArray(value.profiles)) return false;
  const seen = new Set<string>();
  for (const row of value.profiles) {
    if (!record(row) || !exactKeys(row, ["profile_id", "words", "phrases"]) || !uuid(row.profile_id)
      || !count(row.words) || !count(row.phrases) || seen.has(row.profile_id.toLowerCase())) return false;
    seen.add(row.profile_id.toLowerCase());
  }
  return true;
}

export function validStatistics(value: unknown, week: PracticeWeek): value is StatisticsOverviewResponse {
  if (!record(value) || !exactKeys(value, Object.hasOwn(value, "owner_metric") ? [...keys, "owner_metric"] : keys)
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
  const words = value.base.words, phrases = value.base.phrases;
  if (!validCardCounts(value.learned, words, phrases) || !validCardCounts(value.not_started, words, phrases)
    || !validCardCounts(value.added, words, phrases) || !validWordResults(value.word_results, words)
    || (Object.hasOwn(value, "owner_metric") && !validOwnerMetric(value.owner_metric))) return false;
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
