import type { TodayResponse } from "../api/generated";
import { ApiError, createJsonTransport, httpError, type HttpOptions } from "../api/http";

export interface TodayApi {
  get(token: string): Promise<TodayResponse>;
}

export type TodayApiOptions = HttpOptions;

const pairValues = ["ru-de", "uk-de", "en-de"];
const todayStatuses = ["work_now", "learning_waiting", "setup_required", "no_material", "all_done"];
const learningStatuses = ["preview", "ready", "waiting", "completed", "setup_required", "new_group", "no_material"];
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const dueTimePattern = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|\+00:00)$/;
const versionPattern = /^[1-9]\d{0,18}$/;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function date(value: unknown): value is string {
  if (typeof value !== "string" || !datePattern.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

function nullableDate(value: unknown): boolean {
  return value === null || date(value);
}

function dueTime(value: unknown): boolean {
  return value === null || (typeof value === "string" && dueTimePattern.test(value)
    && date(value.slice(0, 10)) && !Number.isNaN(Date.parse(value)));
}

function readyCount(value: unknown): boolean {
  return object(value) && count(value.ready) && nullableDate(value.next_due_date);
}

function directions(value: unknown): boolean {
  return object(value) && readyCount(value["l1-de"]) && readyCount(value["de-l1"]);
}

export function validToday(value: unknown): value is TodayResponse {
  if (!object(value) || !object(value.base) || !object(value.ordinary)
    || !object(value.learning) || !object(value.conjugation)) return false;
  const learning = value.learning;
  const conjugation = value.conjugation;
  const base = value.base;
  return typeof value.state_version === "string" && versionPattern.test(value.state_version)
    && BigInt(value.state_version) <= 9223372036854775807n
    && typeof value.pair === "string" && pairValues.includes(value.pair) && date(value.local_date)
    && typeof value.status === "string" && todayStatuses.includes(value.status)
    && count(base.total) && count(base.words) && count(base.phrases)
    && base.words + base.phrases === base.total
    && directions(value.ordinary.words) && directions(value.ordinary.phrases)
    && (value.ordinary_status === "ready" || value.ordinary_status === "done")
    && typeof learning.status === "string" && learningStatuses.includes(learning.status)
    && count(learning.ready) && count(learning.preview) && dueTime(learning.next_due_at)
    && count(learning.new_group_size) && count(learning.manual_eligible)
    && count(learning.automatic_eligible)
    && count(conjugation.ready) && count(conjugation.openable)
    && nullableDate(conjugation.next_due_date) && nullableDate(value.next_repeat_date);
}

export function createTodayApi(options: TodayApiOptions): TodayApi {
  const request = createJsonTransport(options);
  return {
    async get(token) {
      if (!token) throw new Error("token is required");
      const reply = await request("/today", { method: "GET", token });
      if (!reply.ok) throw httpError(reply);
      if (!validToday(reply.value)) throw new ApiError("invalid_response");
      return reply.value;
    },
  };
}
