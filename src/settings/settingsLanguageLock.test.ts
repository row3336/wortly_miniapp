import { describe, expect, it, vi } from "vitest";
import type { OpenedClient, Profile, SavedCommandFact, SettingsResponse } from "../api/generated";
import { createOpenedAccess, type OpenedAccess } from "../app/openedAccess";
import type { AsyncStorage } from "../platform/storage";
import { allowedSettingValue, createSettingsApi, type SettingIntent, type SettingSaveReply, type SettingStatusReply,
  type SettingsApi } from "./settingsApi";
import { SettingsController, type SettingsSnapshot } from "./settingsController";
import { SettingsPendingStore, type SettingsPending } from "./settingsPending";
import { settingsResponse } from "./settingsRead.test-support";
import { SettingsResetPendingStore } from "./settingsResetPending";
import { readWithTicket, testGate } from "../commands/testGate.test-support";

/**
 * Core CP2 of the dictionary language lock (19.2-А, C150) against the existing client, without changing it: once the
 * field version is above 1 the core lists only the current language in constraints.dictionary_language and refuses a
 * real change with 409 DICTIONARY_LANGUAGE_LOCKED; the interface language keeps every value. The reply must parse,
 * a pending draft of another language must end in a plain known rejection and never in a repeat or a dead end.
 */
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
type Language = "ru" | "uk" | "en";
const all: Language[] = ["ru", "uk", "en"];
const subject = id(1);

/** Settings as the core serves them: chosen (version above 1) narrows only the dictionary language. */
function settings(language: Language, version: string, state = "20"): SettingsResponse {
  const data = settingsResponse();
  data.state_version = state;
  data.settings.dictionary_language = { value: language, version };
  if (BigInt(version) > 1n) data.constraints.dictionary_language = { type: "enum", values: [language] };
  return data;
}
const profile = (state = "20"): Profile => ({ profile_id: subject, access: { status: "admitted", version: "1", reason: null },
  role: "user", ui_language: "ru", dictionary_language: "uk", time_zone: "UTC", state_version: state });
const opened = (): OpenedClient => ({ status: "opened", client_instance_id: id(2), document_id: id(3),
  document_epoch: "1", proof_version: "1", profile: profile(), session: null,
  compatibility: { compatible: true, contract_version: "1" } });
const languageIntent = (value: string, version: string, commandId = id(100)): SettingIntent => ({ command_id: commandId,
  kind: "setting.save", expected_field_version: version, payload: { key: "dictionary_language", value } });
const fact = (request: SettingIntent): SavedCommandFact => ({ id: request.command_id, kind: "setting.save", status: "applied",
  applied_at: "2026-10-09T00:00:00Z", target_id: subject, action_id: null, result_id: null, context_id: null,
  object_version: String(BigInt(request.expected_field_version) + 1n) });
function refusal(code: string, data: SettingsResponse, commandId = id(100)): SettingSaveReply {
  return { outcome: "rejected", command: { id: commandId, status: "rejected" }, error: { code }, current: data,
    state_version: data.state_version };
}
const missing = (state = "20"): SettingStatusReply => ({ outcome: "not_found", command: { id: id(100), status: "not_found" },
  current: profile(state), state_version: state });

function fixture(initial: SettingsResponse) {
  const values = new Map<string, string>();
  const storage: AsyncStorage = { get: vi.fn(async key => values.get(key) ?? null),
    set: vi.fn(async (key, value) => { values.set(key, value); }), remove: vi.fn(async key => { values.delete(key); }) };
  const store = new SettingsPendingStore(storage);
  const api = { get: vi.fn<SettingsApi["get"]>(async () => initial),
    save: vi.fn<SettingsApi["save"]>(async () => { throw new Error("unexpected save"); }),
    status: vi.fn<SettingsApi["status"]>(async () => missing()),
    reset: vi.fn<SettingsApi["reset"]>(async () => { throw new Error("unexpected reset"); }),
    resetStatus: vi.fn<SettingsApi["resetStatus"]>(async () => missing()),
    resetCancel: vi.fn<SettingsApi["resetCancel"]>(async () => { throw new Error("unexpected reset cancel"); }),
    resetCancelStatus: vi.fn<SettingsApi["resetCancelStatus"]>(async () => { throw new Error("unexpected reset cancel status"); }) };
  let access: OpenedAccess | null = null;
  const handle: OpenedAccess = createOpenedAccess({ opened: opened(), token: "synthetic-token", proof: "synthetic-proof",
    generation: 1, isLive: () => access === handle, onDenied: vi.fn() });
  access = handle;
  let sequence = 100;
  const states: SettingsSnapshot[] = [];
  const controller = new SettingsController({ gate: testGate(), api, pendingStore: store, resetStore: new SettingsResetPendingStore(storage),
    access: () => access, newId: () => id(sequence++), onUpdate: state => states.push(state) });
  return { controller, api, values, store };
}
async function seed(f: ReturnType<typeof fixture>, intent: SettingIntent) {
  const record: SettingsPending = { schemaVersion: 1, profileId: subject, clientInstanceId: id(2), intent: intent as SettingsPending["intent"] };
  await f.store.save(record, new AbortController().signal);
}

function reply(body: unknown, status = 200) {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));
  return createSettingsApi({ fetcher, timeoutMs: 1000, maxResponseBytes: 20000, gate: testGate() });
}
const command = (intent: SettingIntent) => ({ ...intent, client_instance_id: id(2), document_id: id(3) });

describe("the narrowed dictionary language constraint in the existing settings reader", () => {
  it("reads the settings before and after the choice; only the dictionary language narrows", async () => {
    const before = settings("uk", "1");
    await expect(reply(before).get("synthetic")).resolves.toEqual(before);
    expect(before.constraints.dictionary_language.values).toEqual(all);
    const after = settings("uk", "2");
    const read = await reply(after).get("synthetic");
    expect(read).toEqual(after);
    expect(read.constraints.dictionary_language).toEqual({ type: "enum", values: ["uk"] });
    expect(read.constraints.ui_language).toEqual({ type: "enum", values: all });
  });

  it("validates a new choice against the narrowed values, the interface language against all", () => {
    const before = settings("uk", "1"), after = settings("uk", "2");
    for (const language of all) {
      expect(allowedSettingValue(before, "dictionary_language", language)).toBe(true);
      expect(allowedSettingValue(after, "dictionary_language", language)).toBe(language === "uk");
      expect(allowedSettingValue(after, "ui_language", language)).toBe(true);
    }
  });

  it("parses a save accepted, a lock refusal and a version conflict with the narrowed current", async () => {
    const first = languageIntent("en", "1");
    const chosen = settings("en", "2");
    await expect(reply({ command: fact(first), current: chosen, state_version: "20" })
      .save("synthetic", "proof", subject, command(first))).resolves.toMatchObject({ outcome: "accepted", current: chosen });
    const change = languageIntent("ru", "2");
    for (const code of ["DICTIONARY_LANGUAGE_LOCKED", "VERSION_CONFLICT"]) {
      const parsed = await reply({ command: { id: change.command_id, status: "rejected" }, error: { code }, current: chosen,
        state_version: "20" }, 409).save("synthetic", "proof", subject, command(change));
      expect(parsed).toEqual({ outcome: "rejected", command: { id: change.command_id, status: "rejected" }, error: { code },
        current: chosen, state_version: "20" });
    }
  });

  it("parses a command status whose constraints carry the unset bounds as null", async () => {
    // The core's command status read serializes every SettingConstraint field (tests/identity/test_settings_api.py).
    const first = languageIntent("uk", "1");
    const data = settings("uk", "2") as unknown as { constraints: Record<string, Record<string, unknown>> };
    for (const rule of Object.values(data.constraints)) for (const field of ["values", "minimum", "maximum", "nonempty",
      "item_minimum", "item_maximum", "modes"]) if (!Object.hasOwn(rule, field)) rule[field] = null;
    const status = await readWithTicket(first, (__command, __ticket) => reply({ command: { ...fact(first), status: "already_applied" }, current: data, state_version: "20" })
      .status("synthetic", subject, __command, __ticket));
    expect(status).toMatchObject({ outcome: "accepted", current: { constraints: { dictionary_language: { values: ["uk"] } } } });
  });
});

describe("the existing settings controller with a pending draft of another language", () => {
  it("before the choice offers every language and saves the first choice", async () => {
    const f = fixture(settings("uk", "1"));
    await f.controller.refresh();
    f.controller.edit("dictionary_language", "en");
    expect(f.controller.snapshot().drafts.dictionary_language).toMatchObject({ valid: true, canSave: true, error: null });
    f.api.save.mockImplementationOnce(async (_token, _proof, _profile, request) =>
      ({ outcome: "accepted", command: fact(request), current: settings("en", "2", "21"), state_version: "21" }));
    await f.controller.save("dictionary_language");
    expect(f.controller.snapshot()).toMatchObject({ phase: "ready", pending: null, drafts: {}, outcome: { status: "accepted" },
      data: { constraints: { dictionary_language: { values: ["en"] } } } });
  });

  it("a stale first choice gets VERSION_CONFLICT: the draft is shown invalid, never sent again, and can be dropped", async () => {
    const f = fixture(settings("uk", "1"));
    await f.controller.refresh();
    f.controller.edit("dictionary_language", "en");
    // Another window chose uk meanwhile: the core answers with version 2 and the narrowed constraint.
    f.api.save.mockResolvedValueOnce(refusal("VERSION_CONFLICT", settings("uk", "2", "21")));
    await f.controller.save("dictionary_language");
    expect(f.controller.snapshot()).toMatchObject({ phase: "ready", pending: null, canEdit: true, canRetry: false,
      outcome: { key: "dictionary_language", status: "rejected", code: "VERSION_CONFLICT" },
      drafts: { dictionary_language: { input: "en", valid: false, error: "invalid", canSave: false, canKeepMine: false } } });
    expect(f.values.size).toBe(0);
    await f.controller.keepMine("dictionary_language"); await f.controller.save("dictionary_language"); await f.controller.retry();
    expect(f.api.save).toHaveBeenCalledOnce();
    f.controller.acceptCurrent("dictionary_language");
    expect(f.controller.snapshot()).toMatchObject({ phase: "ready", drafts: {}, canEdit: true });
  });

  it("a stored change after the choice is retried once, gets DICTIONARY_LANGUAGE_LOCKED and settles as a rejection", async () => {
    const f = fixture(settings("uk", "2"));
    // Saved by an earlier page while the field was at version 2, its reply lost.
    await seed(f, languageIntent("en", "2"));
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ phase: "unresolved", canRetry: true, problem: { reason: "not_found" },
      drafts: { dictionary_language: { input: "en", valid: false, canSave: false } } });
    f.api.save.mockResolvedValueOnce(refusal("DICTIONARY_LANGUAGE_LOCKED", settings("uk", "2", "20")));
    await f.controller.retry();
    expect(f.api.save).toHaveBeenCalledOnce();
    expect(f.api.save.mock.calls[0][3]).toMatchObject({ command_id: id(100), expected_field_version: "2",
      payload: { key: "dictionary_language", value: "en" } });
    expect(f.controller.snapshot()).toMatchObject({ phase: "ready", pending: null, canEdit: true, canRetry: false,
      outcome: { key: "dictionary_language", status: "rejected", code: "DICTIONARY_LANGUAGE_LOCKED" },
      drafts: { dictionary_language: { input: "en", valid: false, error: "invalid", canSave: false } } });
    expect(f.values.size).toBe(0);
    await f.controller.retry(); await f.controller.save("dictionary_language");
    expect(f.api.save).toHaveBeenCalledOnce();
  });

  it("after the choice another language cannot be sent, the interface language still can", async () => {
    const f = fixture(settings("uk", "2"));
    await f.controller.refresh();
    f.controller.edit("dictionary_language", "ru");
    expect(f.controller.snapshot().drafts.dictionary_language).toMatchObject({ valid: false, error: "invalid", canSave: false });
    await f.controller.save("dictionary_language");
    expect(f.api.save).not.toHaveBeenCalled();
    f.controller.edit("ui_language", "en");
    expect(f.controller.snapshot().drafts.ui_language).toMatchObject({ valid: true, canSave: true });
  });
});
