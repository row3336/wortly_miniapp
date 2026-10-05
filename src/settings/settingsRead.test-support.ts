import type { SettingsResponse } from "../api/generated";

const big = "9007199254740995";
export function settingsResponse(): SettingsResponse {
  return { state_version: big, needs_setup: true, settings: {
    ui_language: { value: "ru", version: big }, dictionary_language: { value: "uk", version: "1" },
    time_zone: { value: "Asia/Tokyo", version: "3" }, retry_gap: { value: null, version: "1" },
    retry_count: { value: 3, version: "2" }, learning_group_size: { value: null, version: "1" },
    learning_intervals_seconds: { value: [120, 30, 120], version: "2" },
    learning_poll_seconds: { value: null, version: "1" }, learning_reminder_pause_seconds: { value: null, version: "1" },
    learning_ready_percent: { value: null, version: "1" }, learning_mix: { value: null, version: "1" },
    strict_case: { value: true, version: big }, include_preterite: { value: false, version: "1" },
    include_comparative: { value: null, version: "1" }, transition_mode: { value: null, version: "1" },
    review_error_mode: { value: "strict", version: "1" },
    material: { value: null, version: "1" },
  }, constraints: {
    ui_language: { type: "enum", values: ["ru", "uk", "en"] },
    dictionary_language: { type: "enum", values: ["ru", "uk", "en"] },
    retry_gap: { type: "integer", minimum: 1, maximum: 2147483647 },
    retry_count: { type: "integer", minimum: 1, maximum: 2147483647 },
    learning_group_size: { type: "integer", minimum: 1, maximum: 2147483647 },
    learning_poll_seconds: { type: "integer", minimum: 10, maximum: 2147483647 },
    learning_reminder_pause_seconds: { type: "integer", minimum: 60, maximum: 2147483647 },
    learning_ready_percent: { type: "integer", minimum: 1, maximum: 100 },
    learning_intervals_seconds: { type: "ordered_integer_list", nonempty: true, item_minimum: 1, item_maximum: 2147483647 },
    learning_mix: { type: "boolean" }, strict_case: { type: "boolean" }, include_preterite: { type: "boolean" },
    include_comparative: { type: "boolean" }, transition_mode: { type: "enum", values: ["normal", "accelerated"] },
    review_error_mode: { type: "enum", values: ["strict", "soft"] },
    material: { type: "exclusive_choice", modes: { level: { selected_level: ["A1", "A2", "B1", "B2", "C1", "C2"] },
      topics: { topic_ids: "nonempty_existing_uuid_list" } } },
  } };
}
