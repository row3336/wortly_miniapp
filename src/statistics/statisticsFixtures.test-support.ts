import type { StatisticsOverviewResponse } from "../api/generated";
import type { PracticeWeek } from "./practiceApi";

/** Distinct numbers in every field, so a swapped or mislabelled value fails a test instead of passing by chance. */
export function statisticsData(week: PracticeWeek = "current", patch: Partial<StatisticsOverviewResponse> = {},
  version = "1", pair: StatisticsOverviewResponse["pair"] = "ru-de"): StatisticsOverviewResponse {
  const start = week === "current" ? "2026-09-28" : "2026-09-21";
  const end = week === "current" ? "2026-10-05" : "2026-09-28";
  const days = Array.from({ length: 7 }, (_, index) => ({
    local_date: new Date(Date.parse(`${start}T00:00:00Z`) + index * 86400000).toISOString().slice(0, 10),
    words: week === "current" ? 11 + index : 31 + index, phrases: week === "current" ? 21 + index : 41 + index }));
  return { state_version: version, pair, local_date: "2026-10-01", time_zone: "UTC",
    base: { total: 30, words: 25, phrases: 5, by_type: { noun: 12, verb: 5, phrase: 5, adjective: 3, pronoun: 2,
      adverb: 1, preposition: 1, conjunction: 1, particle: 0 } },
    ready: { words: { "l1-de": 7, "de-l1": 6 }, phrases: { "l1-de": 3, "de-l1": 2 } },
    learned: { words: 9, phrases: 2 }, not_started: { words: 8, phrases: 1 }, added: { words: 4, phrases: 3 },
    word_results: { last_wrong: 4, streaks: { one: 3, two: 2, three: 5, four: 1, five_plus: 6 } },
    practice: { state_version: version, pair, local_date: "2026-10-01", time_zone: "UTC",
      starts_at: `${start}T00:00:00Z`, ends_at: `${end}T00:00:00Z`, days },
    ...patch };
}

/** A real server answer with nothing counted: every counter is an honest zero, not a missing value. */
export function emptyStatistics(week: PracticeWeek = "current", version = "1"): StatisticsOverviewResponse {
  const zero = { words: 0, phrases: 0 };
  const data = statisticsData(week, {}, version);
  return { ...data,
    base: { total: 0, words: 0, phrases: 0, by_type: { noun: 0, verb: 0, phrase: 0, adjective: 0, pronoun: 0,
      adverb: 0, preposition: 0, conjunction: 0, particle: 0 } },
    ready: { words: { "l1-de": 0, "de-l1": 0 }, phrases: { "l1-de": 0, "de-l1": 0 } },
    learned: zero, not_started: zero, added: zero,
    word_results: { last_wrong: 0, streaks: { one: 0, two: 0, three: 0, four: 0, five_plus: 0 } },
    practice: { ...data.practice, days: data.practice.days.map(day => ({ ...day, words: 0, phrases: 0 })) } };
}
