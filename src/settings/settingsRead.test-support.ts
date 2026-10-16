import type { SettingsResponse } from "../api/generated";

const big = "9007199254740995";
/**
 * A profile whose dictionary language is already chosen (field version above 1, 19.3-А), so the App opens Today. Tests
 * of the first choice set the version back to "1" themselves.
 */
export function settingsResponse(): SettingsResponse {
  return { state_version: big, needs_setup: true, reset_epoch: "1", settings: {
    ui_language: { value: "ru", version: big }, dictionary_language: { value: "uk", version: "2" },
    time_zone: { value: "Asia/Tokyo", version: "3" }, retry_gap: { value: null, version: "1" },
    retry_count: { value: 3, version: "2" }, learning_group_size: { value: null, version: "1" },
    learning_intervals_seconds: { value: [120, 30, 120], version: "2" },
    learning_mix: { value: null, version: "1" },
    strict_case: { value: true, version: big }, include_preterite: { value: false, version: "1" },
    include_comparative: { value: null, version: "1" }, transition_mode: { value: null, version: "1" },
    review_error_mode: { value: "strict", version: "1" },
    learning_content: { value: "words", version: "1" },
    material: { value: null, version: "1" },
    notify_learning: { value: true, version: "2" }, notify_weekly: { value: true, version: "2" },
    notify_daily: { value: false, version: "3" }, notify_evening: { value: true, version: "2" },
    weekly_report_hour: { value: 7, version: "1" }, daily_report_hour: { value: 7, version: "1" },
    evening_reminder_hour: { value: 18, version: "1" },
  }, notifications: { telegram_opened: true }, constraints: {
    ui_language: { type: "enum", values: ["ru", "uk", "en"] },
    dictionary_language: { type: "enum", values: ["ru", "uk", "en"] },
    retry_gap: { type: "integer", minimum: 1, maximum: 2147483647 },
    retry_count: { type: "integer", minimum: 1, maximum: 2147483647 },
    learning_group_size: { type: "integer", minimum: 1, maximum: 2147483647 },
    learning_intervals_seconds: { type: "ordered_integer_list", nonempty: true, item_minimum: 1, item_maximum: 2147483647 },
    learning_mix: { type: "boolean" }, strict_case: { type: "boolean" }, include_preterite: { type: "boolean" },
    include_comparative: { type: "boolean" }, transition_mode: { type: "enum", values: ["normal", "accelerated"] },
    review_error_mode: { type: "enum", values: ["strict", "soft"] },
    learning_content: { type: "enum", values: ["words", "phrases", "mixed"] },
    material: { type: "exclusive_choice", modes: { level: { selected_level: ["A1", "A2", "B1", "B2", "C1", "C2"] },
      topics: { topic_ids: "nonempty_existing_uuid_list" } } },
    notify_learning: { type: "boolean" }, notify_weekly: { type: "boolean" }, notify_daily: { type: "boolean" },
    notify_evening: { type: "boolean" }, weekly_report_hour: { type: "integer", minimum: 0, maximum: 23 },
    daily_report_hour: { type: "integer", minimum: 0, maximum: 23 }, evening_reminder_hour: { type: "integer", minimum: 0, maximum: 23 },
  } };
}
