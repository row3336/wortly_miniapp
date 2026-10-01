import type { PracticeResponse } from "../api/generated";
import { ApiError, createJsonTransport, httpError, type HttpOptions } from "../api/http";
import { count, date, eventTime, exactKeys, oneOf, record, version } from "../api/wireValidation";

export type PracticeWeek = "current" | "previous";
export interface PracticeApi {
  get(token: string, week: PracticeWeek): Promise<PracticeResponse>;
}

/** Week labels use the server's local date, never the device clock or a fixed UTC week duration. */
export function validPractice(value: unknown, week: PracticeWeek): value is PracticeResponse {
  if (!oneOf(week, ["current", "previous"]) || !record(value)
    || !exactKeys(value, ["state_version", "local_date", "pair", "time_zone", "starts_at", "ends_at", "days"])
    || !version(value.state_version) || !date(value.local_date) || value.local_date.startsWith("0000")
    || !oneOf(value.pair, ["ru-de", "uk-de", "en-de"])
    || typeof value.time_zone !== "string" || value.time_zone.trim().length === 0
    || !eventTime(value.starts_at) || !eventTime(value.ends_at)
    || Date.parse(value.starts_at as string) >= Date.parse(value.ends_at as string)
    || !Array.isArray(value.days) || value.days.length !== 7) return false;
  const day = new Date(`${value.local_date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 6) % 7 - (week === "previous" ? 7 : 0));
  for (const item of value.days) {
    if (!record(item) || !exactKeys(item, ["local_date", "directions"]) || !date(item.local_date)
      || item.local_date !== day.toISOString().slice(0, 10) || !record(item.directions)
      || !exactKeys(item.directions, ["l1-de", "de-l1"])
      || !count(item.directions["l1-de"]) || !count(item.directions["de-l1"])) return false;
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return true;
}

/** Read aggregate facts only. Configuration, presentation and Telegram delivery are separate. */
export function createPracticeApi(options: HttpOptions): PracticeApi {
  const request = createJsonTransport(options);
  return {
    async get(token, week) {
      if (!token || !oneOf(week, ["current", "previous"])) throw new Error("token and explicit practice week are required");
      const reply = await request(`/statistics/practice?week=${week}`, { method: "GET", token });
      if (!reply.ok) throw httpError(reply);
      if (reply.status !== 200 || !validPractice(reply.value, week)) throw new ApiError("invalid_response");
      return reply.value;
    },
  };
}
