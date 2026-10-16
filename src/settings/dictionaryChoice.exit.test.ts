import { describe, expect, it } from "vitest";
import type { SettingsSnapshot } from "./settingsController";
import { markedMismatch, settingsExit } from "./dictionaryChoice";

const save = (key: string, mismatch?: boolean) => ({ schemaVersion: 1, profileId: "p", clientInstanceId: "c", ...(mismatch ? { mismatch } : {}),
  intent: { command_id: "x", kind: "setting.save", expected_field_version: "1", payload: { key, value: 4 } } });
const state = (patch: Record<string, unknown>) => ({ pending: null, resetPending: null, canRetry: false, ...patch }) as unknown as SettingsSnapshot;

describe("the way from a frame that cannot show Today to Settings", () => {
  it("R9-01: a marked mismatch of a save or of a reset leads to Settings although it can never be retried", () => {
    expect(markedMismatch(state({ pending: save("retry_count", true) }))).toBe(true);
    expect(settingsExit(state({ pending: save("retry_count", true) }))).toBe(true);
    expect(markedMismatch(state({ resetPending: { mismatch: true } }))).toBe(true);
    expect(settingsExit(state({ resetPending: { mismatch: true } }))).toBe(true);
  });
  it("P02-R: an unresolved reset (unknown, held or cancelling) leads to Settings once nothing runs; it never needs canRetry", () => {
    const reset = { schemaVersion: 2, profileId: "p", clientInstanceId: "c",
      intent: { command_id: "x", kind: "settings.reset", payload: { expected_reset_epoch: "1" } } };
    for (const resetPending of [reset, { ...reset, state: { refused: "VALIDATION_FAILED" } }, { ...reset, state: { cancel: "y", explicit: true } }]) {
      for (const phase of ["unresolved", "blocked", "ready"]) expect(settingsExit(state({ resetPending, phase }))).toBe(true);
      for (const phase of ["loading", "checking", "sending"]) expect(settingsExit(state({ resetPending, phase, canRetry: true }))).toBe(false);
    }
    // A save of another field still needs its retry; a reset beside nothing pending does not lead anywhere by itself.
    expect(settingsExit(state({ pending: save("retry_count"), phase: "unresolved" }))).toBe(false);
  });
  it("an unmarked command still needs its retry (R2-01), and no command offers nothing", () => {
    expect(settingsExit(state({ pending: save("retry_count"), canRetry: true }))).toBe(true);
    expect(settingsExit(state({ pending: save("retry_count") }))).toBe(false);
    expect(settingsExit(state({ pending: save("dictionary_language"), canRetry: true }))).toBe(false);
    expect(settingsExit(state({}))).toBe(false);
    expect(markedMismatch(state({ pending: save("retry_count") }))).toBe(false);
  });
});
