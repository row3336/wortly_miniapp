import { describe, expect, it, vi } from "vitest";
import type { DictionaryCardView, DictionaryCardViewResponse } from "../api/generated";
import { createDictionaryViewApi, validDictionaryView } from "./viewApi";

const cardId = "a0000000-0000-4000-8000-000000000001";
const groupId = "a0000000-0000-4000-8000-000000000002";
const largeVersion = "9007199254740993";

function current(): DictionaryCardView {
  return {
    status: "available",
    content: {
      pair: "uk-de", card: { id: cardId, revision: largeVersion, lemma: "Haus", type: "noun", cefr: "A1" },
      translations: { common: ["будинок"], personal: null }, grammar: null,
      reference_conjugations: [], examples: { common: [], personal: null }, association: null, field_versions: { translation: "1", example: "1", association: "1" },
    },
    study: {
      status: "available", card_id: cardId, card_revision: largeVersion, pair: "uk-de", card_type: "noun",
      local_date: "2026-09-30",
      facts: {
        common_translation_present: true, exclusion: { excluded: false, version: null },
        manual: { selected: false, selection_version: largeVersion },
        learning: { ever_selected: false, finished_or_skipped: false, current: null }, non_learning_history: false,
      },
      directions: (["l1-de", "de-l1"] as const).map(direction => ({
        direction, introduced: false, progress_present: false, progress_version: null, schedule: null, interval_preview: null,
      })),
    },
    card_actions: { exclude: false, return: false, relearn: false },
  };
}
function body(value = current()): DictionaryCardViewResponse {
  return { state_version: "9223372036854775807", current: value };
}
function review(): DictionaryCardView {
  const value = current();
  value.study.facts.learning = { ever_selected: true, finished_or_skipped: true, current: null };
  value.study.directions.forEach(d => {
    Object.assign(d, { introduced: true, progress_present: true, progress_version: largeVersion,
      schedule: { interval_days: 350, next_due_date: "2026-10-02" }, interval_preview: [] });
  });
  value.card_actions = { exclude: true, return: false, relearn: true };
  return value;
}
function transport(value: unknown, status = 200, maxResponseBytes = 100000) {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(value), { status }));
  return { fetcher, api: createDictionaryViewApi({ fetcher, timeoutMs: 1000, maxResponseBytes }) };
}

describe("coherent dictionary view", () => {
  it("reads the current server pair once without origin, input mutation or lost int64 precision", async () => {
    const response = body(), before = structuredClone(response), { api, fetcher } = transport(response);
    expect(await api.read("synthetic", cardId.toUpperCase())).toEqual(response);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][0]).toBe(`/api/v1/dictionary/cards/${cardId.toUpperCase()}/view`);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "GET", cache: "no-store", credentials: "same-origin" });
    expect(Object.keys(fetcher.mock.calls[0][1]?.headers ?? {})).toEqual(["Authorization"]);
    expect(response).toEqual(before);
  });
  it("2.26б.1: a card opened from a quiz is read with origin=study; the dictionary keeps the bare address", async () => {
    const { api, fetcher } = transport(body());
    await api.read("synthetic", cardId, "study");
    await api.read("synthetic", cardId, "dictionary");
    expect(fetcher.mock.calls.map(call => call[0])).toEqual([
      `/api/v1/dictionary/cards/${cardId}/view?origin=study`, `/api/v1/dictionary/cards/${cardId}/view`]);
    await expect(api.read("synthetic", cardId, "quiz" as never)).rejects.toThrow("unknown card view origin");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("accepts opaque unavailable without leaking the requested card", async () => {
    const response = { state_version: "1", current: { status: "unavailable" } };
    const { api } = transport(response);
    expect(await api.read("synthetic", cardId)).toEqual(response);
    expect(validDictionaryView({ ...response, current: { ...response.current, card_id: cardId } }, cardId)).toBe(false);
  });
  it.each(["card_id", "card_revision", "pair", "card_type"])("rejects mixed snapshots: %s", async field => {
    const response = body() as any;
    response.current.study[field] = { card_id: groupId, card_revision: "1", pair: "ru-de", card_type: "verb" }[field];
    const { api, fetcher } = transport(response);
    await expect(api.read("synthetic", cardId)).rejects.toMatchObject({ kind: "invalid_response" });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("keeps manual membership and saved ordinary schedules as independent facts", () => {
    const value = review(); value.study.facts.manual.selected = true;
    expect(validDictionaryView(body(value), cardId)).toBe(true);
    expect(value.study.directions.map(d => d.schedule?.next_due_date)).toEqual(["2026-10-02", "2026-10-02"]);
  });
  it("suppresses old dates of both directions while preserving progress in current Learning", () => {
    const value = review();
    value.study.facts.learning.current = { group_id: groupId, group_status: "assembling", member_status: "pending", member_version: "4" };
    value.card_actions = { exclude: false, return: false, relearn: false };
    expect(validDictionaryView(body(value), cardId)).toBe(false);
    value.study.directions.forEach(d => { d.schedule = null; d.interval_preview = null; });
    expect(validDictionaryView(body(value), cardId)).toBe(true);
  });
  it("hides only the written L1->De terms of an excluded card and keeps the oral schedule (K07-058)", () => {
    const value = review();
    value.study.facts.exclusion = { excluded: true, version: "3" };
    value.card_actions = { exclude: false, return: true, relearn: false };
    expect(validDictionaryView(body(value), cardId)).toBe(false);
    value.study.directions[0].schedule = null; value.study.directions[0].interval_preview = null;
    expect(validDictionaryView(body(value), cardId)).toBe(true);
    expect(value.study.directions[1].schedule).toEqual({ interval_days: 350, next_due_date: "2026-10-02" });
    value.study.directions[1].schedule = null; value.study.directions[1].interval_preview = null;
    expect(validDictionaryView(body(value), cardId)).toBe(false);
  });
  it.each([
    { exclude: true, return: true, relearn: false },
    { exclude: true, return: false, relearn: false },
    { exclude: false, return: true, relearn: false },
    { exclude: 1, return: false, relearn: 1 },
  ])("rejects card actions that contradict the exclusion fact: %o", actions => {
    const value = review() as any; value.card_actions = actions;
    expect(validDictionaryView(body(value), cardId)).toBe(false);
  });
  it("preserves schedules without a time zone and requires null previews", () => {
    const value = review(); value.study.local_date = null;
    expect(validDictionaryView(body(value), cardId)).toBe(false);
    value.study.directions.forEach(d => { d.interval_preview = null; });
    expect(validDictionaryView(body(value), cardId)).toBe(true);
  });
  it("uses per-direction phrase progress for introduction, without offering Learning", () => {
    const value = current(); value.content.card.type = value.study.card_type = "phrase";
    Object.assign(value.study.directions[1], { introduced: true, progress_present: true, progress_version: "1",
      schedule: { interval_days: 365, next_due_date: "2027-09-30" }, interval_preview: [] });
    expect(validDictionaryView(body(value), cardId)).toBe(true);
    value.study.directions[0].introduced = true;
    expect(validDictionaryView(body(value), cardId)).toBe(false);
  });
  it("does not infer introduction or a schedule from word progress alone", () => {
    const value = current();
    value.study.directions[0].progress_present = true; value.study.directions[0].progress_version = "2";
    expect(validDictionaryView(body(value), cardId)).toBe(true);
    value.study.directions[0].introduced = true;
    expect(validDictionaryView(body(value), cardId)).toBe(false);
  });
  it("accepts completed Learning without invented progress or dates", () => {
    const value = current();
    value.study.facts.learning = { ever_selected: true, finished_or_skipped: true, current: null };
    value.study.directions.forEach(d => { d.introduced = true; });
    expect(validDictionaryView(body(value), cardId)).toBe(true);
  });
  it("keeps all common translations and separates personal examples without choosing a renderer", () => {
    const value = current();
    value.content.translations.common.push("дім");
    value.content.examples.personal = { value: "<b>literal</b>", version: "7" };
    expect(validDictionaryView(body(value), cardId)).toBe(true);
    value.content.translations.common = []; value.study.facts.common_translation_present = false;
    expect(validDictionaryView(body(value), cardId)).toBe(true);
    value.study.facts.common_translation_present = true;
    expect(validDictionaryView(body(value), cardId)).toBe(false);
  });
  it("validates preview dates/ordering and retains the real 438-day upper step", () => {
    const value = review(), direction = value.study.directions[0];
    direction.schedule = { interval_days: 10, next_due_date: "2026-10-02" };
    // Captured from the existing server helper for I10/R2/E2.5 on 2026-09-30.
    direction.interval_preview = [
      [15, "2026-10-15"], [23, "2026-10-23"], [36, "2026-11-05"], [58, "2026-11-27"],
      [94, "2027-01-02"], [155, "2027-03-04"], [259, "2027-06-16"], [438, "2027-12-12"],
    ].map(([interval, due], index) => ({ step_id: index + 1, interval_days: interval as number, next_due_date: due as string }));
    expect(validDictionaryView(body(value), cardId)).toBe(true);
    direction.interval_preview[7].next_due_date = "2027-12-11";
    expect(validDictionaryView(body(value), cardId)).toBe(false);
    direction.interval_preview[7].next_due_date = "2027-12-12";
    direction.interval_preview[7].step_id = 7;
    expect(validDictionaryView(body(value), cardId)).toBe(false);
  });
  it.each(["2026-02-29", "0000-01-01", "2026-09-30T00:00:00Z", "10000-01-01"])("rejects invalid local date %s", date => {
    const value = current(); value.study.local_date = date;
    expect(validDictionaryView(body(value), cardId)).toBe(false);
  });
  it("accepts leap dates and year boundaries without interpreting them as UTC events", () => {
    const value = review(); value.study.local_date = "2024-02-28";
    value.study.directions[0].schedule = { interval_days: 0, next_due_date: "0001-01-01" };
    value.study.directions[0].interval_preview = [{ step_id: 1, interval_days: 1, next_due_date: "2024-02-29" }];
    value.study.directions[1].schedule!.next_due_date = "9999-12-31";
    expect(validDictionaryView(body(value), cardId)).toBe(true);
  });
  it.each([
    (x: any) => { x.current.study.facts.learning.ever_selected = false; },
    (x: any) => { x.current.study.directions.reverse(); },
    (x: any) => { x.current.study.directions[1].direction = "l1-de"; },
    (x: any) => { x.current.study.directions[0].progress_version = 1; },
    (x: any) => { x.current.study.directions[0].progress_version = "9223372036854775808"; },
    (x: any) => { x.current.study.directions[0].schedule.interval_days = true; },
    (x: any) => { x.current.study.directions[0].schedule.interval_days = -1; },
    (x: any) => { x.current.study.facts.manual.selection_version = "0"; },
    (x: any) => { x.current.study.facts.manual.selected = 1; },
    (x: any) => { x.current.study.facts.exclusion.excluded = true; },
    (x: any) => { x.current.content.card.type = "unknown"; },
    (x: any) => { x.current.content.examples.common = [{ id: cardId, text: "x", role: null, highlighted_parts: [Infinity] }]; },
  ])("rejects invalid facts or reused content fields", mutate => {
    const response = body(review()); mutate(response);
    expect(validDictionaryView(response, cardId)).toBe(false);
  });
  it("rejects extra keys throughout the structured state", () => {
    const value = review(), response = body(value);
    const roots = [response, value, value.card_actions, value.study, value.study.facts,
      value.study.facts.manual, value.study.facts.exclusion, value.study.facts.learning,
      value.study.directions[0], value.study.directions[0].schedule];
    for (const root of roots) {
      Object.defineProperty(root, "__proto__", { value: {}, configurable: true, enumerable: true });
      expect(validDictionaryView(response, cardId)).toBe(false);
      Reflect.deleteProperty(root!, "__proto__");
    }
    expect(validDictionaryView(response, cardId)).toBe(true);
  });
  it("treats a view without card_actions as an invalid response", async () => {
    const response = body(review()) as any;
    delete response.current.card_actions;
    const { api } = transport(response);
    await expect(api.read("synthetic", cardId)).rejects.toMatchObject({ kind: "invalid_response" });
  });
  it("refuses bad caller input before dispatch and bounds bytes on a successful reply", async () => {
    const { api, fetcher } = transport(body(), 200, 1);
    await expect(api.read("", cardId)).rejects.toThrow();
    await expect(api.read("synthetic", "wrong")).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    await expect(api.read("synthetic", cardId)).rejects.toMatchObject({ kind: "invalid_response" });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([401, 403, 422, 503])("preserves HTTP refusal %s without retries", async status => {
    const { api, fetcher } = transport({ error: { code: "WRITE_UNAVAILABLE" } }, status);
    await expect(api.read("synthetic", cardId)).rejects.toMatchObject({ kind: "http", status });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("requires exact 200 and never returns a valid-looking body from 201", async () => {
    const { api } = transport(body(), 201);
    await expect(api.read("synthetic", cardId)).rejects.toMatchObject({ kind: "invalid_response" });
  });
});
