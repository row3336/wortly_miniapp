import { settingsResponse as current } from "./settingsRead.test-support";
import { describe, expect, it, vi } from "vitest";
import type { Profile, SavedCommandFact, SettingsResponse } from "../api/generated";
import {
  allowedSettingValue, createSettingsApi, validSettingIntent, type EditableSettingCommand, type EditableSettingPayload,
  type SettingIntent,
} from "./settingsApi";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const subject = id(4);
const big = "9007199254740995";
const time = "2026-09-30T00:00:00.123456Z";

function intent(): SettingIntent {
  return { command_id: id(1), kind: "setting.save", expected_field_version: big,
    payload: { key: "strict_case", value: true } };
}
function command(original = intent()): EditableSettingCommand {
  return { ...original, client_instance_id: id(2), document_id: id(3) };
}
function fact(): SavedCommandFact {
  return { id: id(1), kind: "setting.save", status: "applied", applied_at: time, target_id: subject,
    action_id: null, result_id: null, context_id: null, object_version: "9007199254740996" };
}
function profile(): Profile {
  return { profile_id: subject, access: { status: "admitted", version: "1", reason: null }, role: "user",
    ui_language: "ru", dictionary_language: "uk", time_zone: "UTC", state_version: big };
}
function reply() { return { command: fact(), current: current(), state_version: big }; }
function response(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status }); }
function setup(body: unknown, status = 200) {
  const fetcher = vi.fn<typeof fetch>(async () => response(body, status));
  return { fetcher, api: createSettingsApi({ fetcher, timeoutMs: 1000, maxResponseBytes: 20000 }) };
}

describe("Settings current and constraints", () => {
  it("reads nullable settings without supplying defaults or rounding versions", async () => {
    const { api, fetcher } = setup(current());
    expect(await api.get("synthetic")).toEqual(current());
    expect(fetcher).toHaveBeenCalledExactlyOnceWith("/api/v1/settings", expect.objectContaining({
      method: "GET", body: undefined, headers: { Authorization: "Bearer synthetic" }, cache: "no-store",
    }));
  });

  it("accepts optional null metadata as returned by command status and keeps needs_setup as a server fact", async () => {
    const data = current(); data.needs_setup = false;
    for (const rule of Object.values(data.constraints)) Object.assign(rule, { modes: rule.modes ?? null,
      values: rule.values ?? null, minimum: rule.minimum ?? null, maximum: rule.maximum ?? null,
      item_minimum: rule.item_minimum ?? null, item_maximum: rule.item_maximum ?? null, nonempty: rule.nonempty ?? null });
    await expect(setup(data).api.get("synthetic")).resolves.toEqual(data);
  });

  it("decodes both review error modes exactly as stored (K04-102)", async () => {
    for (const mode of ["strict", "soft"] as const) {
      const data = current(); data.settings.review_error_mode = { value: mode, version: "7" };
      await expect(setup(data).api.get("synthetic")).resolves.toEqual(data);
    }
  });

  it("decodes every learning content exactly as stored, apart from learning_mix (K04-105)", async () => {
    for (const content of ["words", "phrases", "mixed"] as const) {
      const data = current(); data.settings.learning_content = { value: content, version: "7" };
      data.settings.learning_mix = { value: content === "mixed", version: "2" };
      await expect(setup(data).api.get("synthetic")).resolves.toEqual(data);
    }
  });

  // Recorded 2026-10-06 from the core application (GET /api/v1/settings, a new
  // profile with the time zone opened as UTC), key order as served: not a hand-made shape.
  const coreNewProfile = '{"constraints":{"dictionary_language":{"type":"enum","values":["ru","uk","en"]},'
    + '"include_comparative":{"type":"boolean"},"include_preterite":{"type":"boolean"},'
    + '"learning_content":{"type":"enum","values":["words","phrases","mixed"]},'
    + '"learning_group_size":{"maximum":2147483647,"minimum":1,"type":"integer"},'
    + '"learning_intervals_seconds":{"item_maximum":2147483647,"item_minimum":1,"nonempty":true,"type":"ordered_integer_list"},'
    + '"learning_mix":{"type":"boolean"},"learning_poll_seconds":{"maximum":2147483647,"minimum":10,"type":"integer"},'
    + '"learning_ready_percent":{"maximum":100,"minimum":1,"type":"integer"},'
    + '"learning_reminder_pause_seconds":{"maximum":2147483647,"minimum":60,"type":"integer"},'
    + '"material":{"modes":{"level":{"selected_level":["A1","A2","B1","B2","C1","C2"]},'
    + '"topics":{"topic_ids":"nonempty_existing_uuid_list"}},"type":"exclusive_choice"},'
    + '"retry_count":{"maximum":2147483647,"minimum":1,"type":"integer"},'
    + '"retry_gap":{"maximum":2147483647,"minimum":1,"type":"integer"},'
    + '"review_error_mode":{"type":"enum","values":["strict","soft"]},"strict_case":{"type":"boolean"},'
    + '"transition_mode":{"type":"enum","values":["normal","accelerated"]},'
    + '"ui_language":{"type":"enum","values":["ru","uk","en"]}},"needs_setup":true,"settings":{'
    + '"dictionary_language":{"value":"ru","version":"1"},"include_comparative":{"value":false,"version":"1"},'
    + '"include_preterite":{"value":false,"version":"1"},"learning_content":{"value":"words","version":"1"},'
    + '"learning_group_size":{"value":null,"version":"1"},"learning_intervals_seconds":{"value":null,"version":"1"},'
    + '"learning_mix":{"value":null,"version":"1"},"learning_poll_seconds":{"value":null,"version":"1"},'
    + '"learning_ready_percent":{"value":null,"version":"1"},"learning_reminder_pause_seconds":{"value":null,"version":"1"},'
    + '"material":{"value":null,"version":"1"},"retry_count":{"value":null,"version":"1"},'
    + '"retry_gap":{"value":null,"version":"1"},"review_error_mode":{"value":"strict","version":"1"},'
    + '"strict_case":{"value":true,"version":"1"},"time_zone":{"value":"UTC","version":"1"},'
    + '"transition_mode":{"value":null,"version":"1"},"ui_language":{"value":"ru","version":"1"}},"state_version":"3"}';

  it("opens the recorded core reply of a new profile with learning content words and its version", async () => {
    const recorded = JSON.parse(coreNewProfile) as SettingsResponse;
    // The exact recorded text is served, not a re-serialized object.
    const fetcher = vi.fn<typeof fetch>(async () => new Response(coreNewProfile, { status: 200 }));
    const read = await createSettingsApi({ fetcher, timeoutMs: 1000, maxResponseBytes: 20000 }).get("synthetic");
    expect(read).toEqual(recorded);
    expect(read.settings.learning_content).toEqual({ value: "words", version: "1" });
    expect(read.constraints.learning_content).toEqual({ type: "enum", values: ["words", "phrases", "mixed"] });
    // The same reply carried by a saved command and by a command status.
    const saved = await setup({ command: fact(), current: recorded, state_version: big })
      .api.save("synthetic", "proof", subject, command());
    expect(saved).toMatchObject({ outcome: "accepted", current: { settings: { learning_content: { value: "words" } } } });
  });

  it("does not display a successful projection carrying a contradictory error", async () => {
    await expect(setup({ ...current(), error: { code: "WRITE_UNAVAILABLE" } }).api.get("synthetic"))
      .rejects.toMatchObject({ kind: "invalid_response" });
  });

  const bad: Array<[string, (data: SettingsResponse) => void]> = [
    ["missing field", x => { Reflect.deleteProperty(x.settings, "retry_count"); }],
    ["missing value", x => { Reflect.deleteProperty(x.settings.retry_count, "value"); }],
    ["numeric version", x => { Object.assign(x.settings.strict_case, { version: 2 }); }],
    ["oversize version", x => { x.state_version = "9223372036854775808"; }],
    ["padded version", x => { x.settings.retry_count.version = "01"; }],
    ["zero version", x => { x.settings.time_zone.version = "0"; }],
    ["boolean number", x => { Object.assign(x.settings.retry_count, { value: true }); }],
    ["fraction", x => { x.settings.retry_count.value = 1.5; }],
    ["unsafe integer", x => { x.settings.retry_count.value = Number.MAX_SAFE_INTEGER + 1; }],
    ["numeric boolean", x => { Object.assign(x.settings.strict_case, { value: 1 }); }],
    ["null language", x => { Object.assign(x.settings.ui_language, { value: null }); }],
    ["unknown language", x => { Object.assign(x.settings.dictionary_language, { value: "de" }); }],
    ["unknown transition", x => { Object.assign(x.settings.transition_mode, { value: "fast" }); }],
    ["missing review mode", x => { Reflect.deleteProperty(x.settings, "review_error_mode"); }],
    ["null review mode", x => { Object.assign(x.settings.review_error_mode, { value: null }); }],
    ["unknown review mode", x => { Object.assign(x.settings.review_error_mode, { value: "lenient" }); }],
    ["capitalized review mode", x => { Object.assign(x.settings.review_error_mode, { value: "Strict" }); }],
    ["boolean review mode", x => { Object.assign(x.settings.review_error_mode, { value: true }); }],
    ["numeric review version", x => { Object.assign(x.settings.review_error_mode, { version: 1 }); }],
    ["missing review constraint", x => { Reflect.deleteProperty(x.constraints, "review_error_mode"); }],
    ["wrong review constraint", x => { x.constraints.review_error_mode.type = "boolean"; }],
    ["unknown review choice", x => { x.constraints.review_error_mode.values = ["strict", "lenient"]; }],
    ["missing learning content", x => { Reflect.deleteProperty(x.settings, "learning_content"); }],
    ["null learning content", x => { Object.assign(x.settings.learning_content, { value: null }); }],
    ["unknown learning content", x => { Object.assign(x.settings.learning_content, { value: "verbs" }); }],
    ["singular learning content", x => { Object.assign(x.settings.learning_content, { value: "phrase" }); }],
    ["capitalized learning content", x => { Object.assign(x.settings.learning_content, { value: "Words" }); }],
    ["boolean learning content", x => { Object.assign(x.settings.learning_content, { value: true }); }],
    ["list learning content", x => { Object.assign(x.settings.learning_content, { value: ["words"] }); }],
    ["numeric learning version", x => { Object.assign(x.settings.learning_content, { version: 1 }); }],
    ["zero learning version", x => { Object.assign(x.settings.learning_content, { version: "0" }); }],
    ["missing learning constraint", x => { Reflect.deleteProperty(x.constraints, "learning_content"); }],
    ["wrong learning constraint", x => { x.constraints.learning_content.type = "boolean"; }],
    ["unknown learning choice", x => { x.constraints.learning_content.values = ["words", "verbs"]; }],
    ["empty learning choices", x => { x.constraints.learning_content.values = []; }],
    ["unknown extra setting", x => { Object.assign(x.settings, { learning_contents: { value: "words", version: "1" } }); }],
    ["unknown extra constraint", x => { Object.assign(x.constraints, { learning_contents: { type: "boolean" } }); }],
    ["string time zone", x => { Object.assign(x.settings.time_zone, { value: ["UTC"] }); }],
    ["wrong list item", x => { Object.assign(x.settings.learning_intervals_seconds, { value: [30, "60"] }); }],
    ["invalid material mode", x => { Object.assign(x.settings.material, { value: { mode: "both" } }); }],
    ["mixed material", x => { Object.assign(x.settings.material, { value: { mode: "level", selected_level: "A1", topic_ids: [id(8)] } }); }],
    ["duplicate topics", x => { x.settings.material.value = { mode: "topics", topic_ids: [id(8), id(8)] }; }],
    ["bad topic ID", x => { x.settings.material.value = { mode: "topics", topic_ids: ["topic"] }; }],
    ["missing constraint", x => { Reflect.deleteProperty(x.constraints, "retry_count"); }],
    ["wrong constraint type", x => { x.constraints.strict_case.type = "integer"; }],
    ["missing maximum", x => { Reflect.deleteProperty(x.constraints.retry_count, "maximum"); }],
    ["fractional bound", x => { x.constraints.retry_count.minimum = 1.5; }],
    ["reversed bounds", x => { x.constraints.learning_ready_percent.minimum = 101; }],
    ["missing list maximum", x => { Reflect.deleteProperty(x.constraints.learning_intervals_seconds, "item_maximum"); }],
    ["nonboolean list rule", x => { Object.assign(x.constraints.learning_intervals_seconds, { nonempty: 1 }); }],
    ["empty enum", x => { x.constraints.ui_language.values = []; }],
    ["duplicate enum", x => { x.constraints.ui_language.values = ["ru", "ru"]; }],
    ["unsupported enum", x => { x.constraints.ui_language.values = ["de"]; }],
    ["bad topic rule", x => { x.constraints.material.modes!.topics.topic_ids = "any"; }],
    ["bad level rule", x => { x.constraints.material.modes!.level.selected_level = ["A0"]; }],
    ["missing setup", x => { Reflect.deleteProperty(x, "needs_setup"); }],
  ];
  it.each(bad)("rejects malformed current: %s", async (_name, corrupt) => {
    const data = current(); corrupt(data);
    await expect(setup(data).api.get("synthetic")).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("validates new numbers using API bounds and retains an older now-invalid displayed value", async () => {
    const data = current(); data.settings.retry_count.value = 3;
    data.constraints.retry_count = { type: "integer", minimum: 7, maximum: 9 };
    await expect(setup(data).api.get("synthetic")).resolves.toEqual(data);
    for (const value of [7, 8, 9]) expect(allowedSettingValue(data, "retry_count", value)).toBe(true);
    for (const value of [3, 6, 10, 7.5, "7", true, null]) expect(allowedSettingValue(data, "retry_count", value)).toBe(false);
    expect(data.settings.retry_count.value).toBe(3);
  });

  it("keeps ordered intervals and duplicate durations without sorting or clamping", () => {
    const data = current(); data.constraints.learning_intervals_seconds = {
      type: "ordered_integer_list", nonempty: true, item_minimum: 10, item_maximum: 120 };
    const value = [120, 30, 120];
    expect(allowedSettingValue(data, "learning_intervals_seconds", value)).toBe(true);
    expect(value).toEqual([120, 30, 120]);
    for (const invalid of [[], [9], [121], [30, false], [30, 40.5]]) {
      expect(allowedSettingValue(data, "learning_intervals_seconds", invalid)).toBe(false);
    }
  });

  it("uses the advertised enum subset without losing material exclusivity", () => {
    const data = current(); data.constraints.ui_language.values = ["ru"];
    data.constraints.material.modes!.level.selected_level = ["B1"];
    expect(allowedSettingValue(data, "ui_language", "en")).toBe(false);
    expect(allowedSettingValue(data, "ui_language", "ru")).toBe(true);
    expect(allowedSettingValue(data, "material", { mode: "level", selected_level: "A1" })).toBe(false);
    expect(allowedSettingValue(data, "material", { mode: "level", selected_level: "B1" })).toBe(true);
    expect(allowedSettingValue(data, "material", { mode: "topics", topic_ids: [id(9)] })).toBe(true);
    expect(allowedSettingValue(data, "material", { mode: "topics", topic_ids: [] })).toBe(false);
  });
});

describe("Settings command exchange", () => {
  const values: EditableSettingPayload[] = [
    { key: "ui_language", value: "ru" }, { key: "dictionary_language", value: "uk" },
    { key: "retry_gap", value: 1 }, { key: "retry_count", value: 2 }, { key: "learning_group_size", value: 10 },
    { key: "learning_poll_seconds", value: 10 }, { key: "learning_reminder_pause_seconds", value: 60 },
    { key: "learning_ready_percent", value: 80 }, { key: "learning_intervals_seconds", value: [120, 30, 120] },
    { key: "strict_case", value: false }, { key: "learning_mix", value: true },
    { key: "include_preterite", value: true }, { key: "include_comparative", value: false },
    { key: "transition_mode", value: "accelerated" }, { key: "material", value: { mode: "level", selected_level: "A1" } },
    { key: "material", value: { mode: "topics", topic_ids: [id(8), id(7)] } },
  ];
  it.each(values)("sends an exact $key value %#", async payload => {
    const request = command(); request.payload = payload;
    const { api, fetcher } = setup(reply());
    await expect(api.save("synthetic", "synthetic-proof", subject, request)).resolves.toMatchObject({ outcome: "accepted" });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("/api/v1/commands");
    expect(init?.headers).toEqual({ Authorization: "Bearer synthetic", "X-Origin-Proof": "synthetic-proof", "Content-Type": "application/json" });
    expect(JSON.parse(init!.body as string)).toEqual(request); expect(fetcher).toHaveBeenCalledOnce();
    expect(allowedSettingValue(current(), payload.key, payload.value)).toBe(true);
  });

  it("snapshots nested values and the original address before awaiting a reply", async () => {
    let finish!: (result: Response) => void;
    const fetcher = vi.fn<typeof fetch>(() => new Promise(resolve => { finish = resolve; }));
    const api = createSettingsApi({ fetcher, timeoutMs: 1000, maxResponseBytes: 20000 });
    const topics = { mode: "topics" as const, topic_ids: [id(8)] };
    const request = command(); request.payload = { key: "material", value: topics };
    const original = structuredClone(request);
    const waiting = api.save("synthetic", "proof", subject, request);
    request.command_id = id(99); request.expected_field_version = "1";
    topics.topic_ids.push(id(9));
    finish(response(reply()));
    await expect(waiting).resolves.toMatchObject({ outcome: "accepted", command: { id: id(1) } });
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toEqual(original);
  });

  it("keeps an old accepted fact separate from a subsequently changed value and version", async () => {
    const body = reply(); body.command.status = "already_applied";
    body.current.settings.strict_case = { value: false, version: "9007199254740997" };
    await expect(setup(body).api.save("synthetic", "proof", subject, command())).resolves.toMatchObject({
      outcome: "accepted", command: { object_version: "9007199254740996" },
      current: { settings: { strict_case: { value: false, version: "9007199254740997" } } },
    });
  });

  it("never automatically resends a lost response or changes its original envelope", async () => {
    const { api, fetcher } = setup(reply());
    fetcher.mockRejectedValueOnce(new Error("lost-after-commit"));
    await expect(api.save("synthetic", "proof", subject, command())).rejects.toMatchObject({ kind: "network" });
    expect(fetcher).toHaveBeenCalledOnce();
    await api.save("synthetic", "proof", subject, command());
    expect(fetcher.mock.calls[0][1]?.body).toBe(fetcher.mock.calls[1][1]?.body);
  });

  it.each([403, 409, 422])("recognizes only addressed business rejections (%s)", async status => {
    const body = { ...reply(), command: { id: id(1), status: "rejected" }, error: { code: "VERSION_CONFLICT" } };
    await expect(setup(body, status).api.save("synthetic", "proof", subject, command()))
      .resolves.toMatchObject({ outcome: "rejected", error: { code: "VERSION_CONFLICT" } });
    body.error.code = "COMMAND_PAYLOAD_MISMATCH";
    await expect(setup(body, status).api.save("synthetic", "proof", subject, command())).resolves.toMatchObject({ outcome: "mismatch" });
    body.command.id = id(99);
    await expect(setup(body, status).api.save("synthetic", "proof", subject, command())).rejects.toMatchObject({ kind: "http", status });
  });

  it.each([401, 403, 409, 422, 500, 503])("does not invent a known outcome from plain HTTP %s", async status => {
    await expect(setup({ error: { code: "WRITE_UNAVAILABLE" } }, status).api.save("synthetic", "proof", subject, command()))
      .rejects.toMatchObject({ kind: "http", status });
  });

  it.each([
    { id: id(99) }, { kind: "learning.select" }, { target_id: id(99) }, { target_id: null },
    { object_version: big }, { object_version: "9007199254740997" }, { object_version: 3 },
    { object_version: null }, { action_id: id(9) }, { result_id: id(9) }, { context_id: id(9) },
    { applied_at: "2026-02-30T00:00:00Z" }, { applied_at: "2026-09-30T00:00:00+02:00" }, { status: "rejected" },
  ])("refuses unrelated or malformed accepted facts %#", async corrupt => {
    const body = reply(); Object.assign(body.command, corrupt);
    await expect(setup(body).api.save("synthetic", "proof", subject, command())).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("does not send extra semantic fields or invalid addresses/field types", async () => {
    const { api, fetcher } = setup(reply());
    const candidates = [Object.assign(command(), { extra: true }),
      { ...command(), document_id: "bad" }, { ...command(), command_id: "../another-endpoint" },
      { ...command(), expected_field_version: "9223372036854775807" },
      { ...command(), payload: Object.assign({ key: "strict_case", value: true }, { extra: true }) },
      { ...command(), payload: { key: "retry_count", value: true } },
      { ...command(), payload: { key: "time_zone", value: "UTC" } },
      // Read-only in this client: refused at runtime even if a caller bypasses the type.
      { ...command(), payload: { key: "review_error_mode", value: "soft" } },
      { ...command(), payload: { key: "learning_content", value: "phrases" } },
      { ...command(), payload: { key: "material", value: { mode: "topics", topic_ids: [id(8), id(8)] } } },
    ];
    for (const request of candidates) await expect(api.save("synthetic", "proof", subject, request as EditableSettingCommand)).rejects.toThrow();
    await expect(api.save("synthetic", "", subject, command())).rejects.toThrow();
    await expect(api.save("", "proof", subject, command())).rejects.toThrow();
    await expect(api.status("synthetic", "bad", intent())).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(validSettingIntent({ ...intent(), extra: true })).toBe(false);
    // review_error_mode is read-only in this client until its editor exists.
    expect(validSettingIntent({ ...intent(), payload: { key: "review_error_mode", value: "soft" } })).toBe(false);
    // Likewise learning_content: decoded strictly, not editable without its screen.
    for (const value of ["words", "phrases", "mixed"]) {
      expect(validSettingIntent({ ...intent(), payload: { key: "learning_content", value } })).toBe(false);
    }
    // @ts-expect-error learning_content is not an editable key of this client
    const notEditable: EditableSettingPayload = { key: "learning_content", value: "phrases" };
    expect(notEditable.key).toBe("learning_content");
  });

  it.each(["learning_intervals_seconds", "material"] as const)("does not serialize a missing %s array element as null", async key => {
    const original = intent();
    original.payload = key === "material" ? { key, value: { mode: "topics", topic_ids: new Array<string>(1) } }
      : { key, value: new Array<number>(1) };
    expect(validSettingIntent(original)).toBe(false);
    expect(allowedSettingValue(current(), key, original.payload.value)).toBe(false);
    const { api, fetcher } = setup(reply());
    await expect(api.save("synthetic", "proof", subject, command(original))).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("Settings recovery status", () => {
  it("not_found keeps the same profile and never posts a new command", async () => {
    const { api, fetcher } = setup({ command: { id: id(1), status: "not_found" }, current: profile(), state_version: big });
    await expect(api.status("synthetic", subject, intent())).resolves.toMatchObject({ outcome: "not_found", current: profile() });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(`/api/v1/commands/${id(1)}`, expect.objectContaining({ method: "GET", body: undefined }));
  });

  it.each([current(), { status: "unavailable" }])("accepted history does not grant current access %#", async projection => {
    const body = { command: { ...fact(), status: "already_applied" }, current: projection, state_version: big };
    await expect(setup(body).api.status("synthetic", subject, intent())).resolves.toMatchObject({ outcome: "accepted", current: projection });
  });

  it.each([
    { command: fact(), current: current() },
    { command: { ...fact(), status: "already_applied", target_id: id(99) }, current: current() },
    { command: { ...fact(), status: "already_applied", object_version: big }, current: current() },
    { command: { ...fact(), status: "already_applied" }, current: profile() },
    { command: { id: id(99), status: "not_found" }, current: profile() },
    { command: { id: id(1), status: "not_found" }, current: { ...profile(), profile_id: id(99) } },
    { command: { id: id(1), status: "not_found" }, current: current() },
    { command: { ...fact(), status: "already_applied" }, current: { status: "unavailable", settings: {} } },
  ])("rejects conflicting status addresses and branches %#", async body => {
    await expect(setup({ ...body, state_version: big }).api.status("synthetic", subject, intent()))
      .rejects.toMatchObject({ kind: "invalid_response" });
  });
});
