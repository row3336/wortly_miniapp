import { describe, expect, it, vi } from "vitest";
import type { OralSessionProjection, Profile } from "../api/generated";
import { createOralApi, type OralCommand } from "./oralApi";
import { copyOralIntent, validOralIntent } from "./oralIntent";
import { recordedOralUnknownClosed } from "../api/realCoreStatusRecordings.test-support";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const origin = { client_instance_id: id(1), document_id: id(2), session_id: id(3) };
const base = { ...origin, command_id: id(4) };
const commands: OralCommand[] = [
  { ...base, kind: "session.start", payload: { mode: "oral", bucket: "words" } },
  { ...base, kind: "session.start", payload: { mode: "oral", bucket: "phrases" } },
  { ...base, kind: "assignment.present", assignment_id: id(6), payload: {} },
  { ...base, kind: "oral.reveal", assignment_id: id(6), payload: {} },
  { ...base, kind: "oral.grade", assignment_id: id(6), payload: { correct: true } },
  { ...base, kind: "oral.grade", assignment_id: id(6), payload: { correct: false } },
  { ...base, kind: "session.stop", payload: { reason: "stop" } },
  { ...base, kind: "session.stop", payload: { reason: "summary_home" } },
];
// Fixed Python identity.intent_hash vectors; do not derive expected proof with the client under test.
const intentHashes = [
  "171ae33024369acb9467bb35827e4df5ae8606ddb916c6350746743490ce4351",
  "317e27c80ebe15c45348dccb096a80b28716d4619492b76f18036df6163872ad",
  "5ffb65afab3630ed601ef97b2ed613a64ced3a24c56fe7b639a66b7a00cbc950",
  "3668fc1547a8a1800206e04dc1dbdf8e56a59d4d5b03cc9885538123a68a0bd9",
  "06a42e236c1227929c1b8aa527635b1bb815c9dbf054449120db876518269f3c",
  "a2643734f81c3f380735ed8e39a733cd34554ec8201d13faf92f64bb0b05a609",
  "9469e8627c7ed2cc827d96d93ad8cacf5ec8dccadc964952c4031a6ac1110485",
  "fda09eb41981f78899c15cc795a1b12dbf5436f1fc2ed7e12b9382fe23b0612d"
];
function current(status: "prefetched" | "presented" = "prefetched", revealed = false): OralSessionProjection {
  const assignment = { id: id(6), card_id: id(11), kind: "original" as const,
    prompt: { text: "Haus", language: "de" as const, conjunction_hint: null } };
  return { session_id: id(3), status: "active", mode: "oral", pair: "ru-de", direction: "de-l1",
    local_date: "2026-09-30", bucket: "words", close_reason: null,
    progress: { completed: 0, total: 2, correct: 0, wrong: 0 }, summary: null,
    practice: { pair: "ru-de", direction: "de-l1", local_date: "2026-09-30", time_zone: "UTC", count: 0 },
    capabilities: { reveal_target: status === "presented" && !revealed ? id(6) : null,
      grade_target: revealed ? id(6) : null, stop: true, summary_home: false },
    assignment: revealed ? { ...assignment, status: "presented", revealed: true, translations: ["дом", "здание"] }
      : { ...assignment, status, revealed: false } };
}
function finished(status: "summary" | "closed", completed = 2): OralSessionProjection {
  return { ...current(), status, close_reason: status === "closed" ? "stop" : null, assignment: null,
    progress: { total: 2, completed, correct: completed, wrong: 0 },
    summary: { completed, correct: completed, wrong: 0,
      ratio: completed ? { numerator: completed, denominator: completed } : null },
    capabilities: { reveal_target: null, grade_target: null, stop: status !== "closed", summary_home: status === "summary" } };
}
const profile: Profile = { profile_id: id(50), role: "user", ui_language: "ru", dictionary_language: "ru",
  time_zone: "UTC", state_version: "3", access: { status: "admitted", version: "1", reason: null } };
function response(command = commands[0], projection: unknown = current(), status: "applied" | "already_applied" = "applied") {
  const grade = command.kind === "oral.grade";
  return { current: projection, state_version: "3", error: null,
    ...(status === "already_applied" ? { verified_intent_hash: intentHashes[commands.indexOf(command)] } : {}),
    command: { id: command.command_id, kind: command.kind, status, applied_at: "2026-09-30T12:00:00Z",
      target_id: "assignment_id" in command ? command.assignment_id : command.session_id,
      action_id: grade ? id(7) : null, result_id: grade ? id(8) : null,
      context_id: null, object_version: grade ? "1" : null } };
}
function fixture(value: unknown = response(), status = 200, maxResponseBytes = 10000) {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(value), { status }));
  return { fetcher, api: createOralApi({ fetcher, timeoutMs: 100, maxResponseBytes, baseUrl: "https://synthetic.invalid/" }) };
}
const missing = (closed_session?: unknown) => ({ command: { id: id(4), status: "not_found" },
  current: profile, state_version: "3", ...(closed_session === undefined ? {} : { closed_session }) });

describe("oral adapter command and addressed read interface", () => {
  it.each(commands)("sends $kind exactly once and validates the addressed fact", async command => {
    const projection = current(); projection.assignment!.id = id(99);
    const f = fixture(response(command, projection));
    expect(await f.api.send("synthetic-token", "synthetic-proof", command)).toEqual({
      ...response(command, projection), error: undefined, outcome: "accepted" });
    expect(f.fetcher).toHaveBeenCalledOnce();
    const [url, init] = f.fetcher.mock.calls[0];
    expect(url).toBe("https://synthetic.invalid/api/v1/commands");
    expect(init).toMatchObject({ method: "POST", cache: "no-store", credentials: "same-origin",
      headers: { Authorization: "Bearer synthetic-token", "X-Origin-Proof": "synthetic-proof", "Content-Type": "application/json" } });
    expect(JSON.parse(String(init?.body))).toEqual(command);
    expect(String(init?.body)).not.toMatch(/synthetic-token|synthetic-proof/);
  });
  it.each(commands)("recovers $kind without replaying a mutation or restoring the old assignment", async command => {
    const projection = current("presented", true);
    projection.assignment!.id = id(99); projection.capabilities.grade_target = id(99);
    const f = fixture(response(command, projection, "already_applied"));
    const result = await f.api.status("token", "proof", command);
    expect(result).toMatchObject({ outcome: "accepted", current: projection });
    if (result.outcome !== "accepted") throw new Error("expected an accepted fact");
    expect(result.command.target_id).toBe("assignment_id" in command ? command.assignment_id : id(3));
    const [url, init] = f.fetcher.mock.calls[0]; const parsed = new URL(String(url));
    expect(parsed.pathname).toBe(`/api/v1/commands/${command.command_id}`);
    expect(Object.fromEntries(parsed.searchParams)).toEqual({ client_instance_id: id(1), document_id: id(2), session_id: id(3),
      expected_intent_hash: intentHashes[commands.indexOf(command)] });
    expect(init?.method).toBe("GET"); expect(init?.body).toBeUndefined(); expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it.each([current(), current("presented"), current("presented", true), finished("summary"), finished("summary", 1),
    finished("summary", 0), finished("closed", 1), finished("closed", 0),
    { session_id: id(3), status: "not_found" }, { session_id: id(3), status: "unavailable" }])(
    "reads valid fresh phase %j", async projection => {
      const f = fixture({ current: projection, state_version: "9223372036854775807" });
      expect(await f.api.read("token", "proof", origin)).toEqual({ current: projection, state_version: "9223372036854775807" });
      const [url, init] = f.fetcher.mock.calls[0], parsed = new URL(String(url));
      expect(parsed.pathname).toBe(`/api/v1/sessions/${id(3)}`);
      expect(Object.fromEntries(parsed.searchParams)).toEqual({ client_instance_id: id(1), document_id: id(2) });
      expect(init?.method).toBe("GET"); expect(init?.body).toBeUndefined();
    });
  it("accepts ordered translations, drill, all pairs and nullable conjunction fields without date policy", async () => {
    for (const pair of ["ru-de", "uk-de", "en-de"] as const) {
      const projection = current("presented", true); projection.pair = pair; projection.bucket = "phrases";
      projection.local_date = "0001-01-01"; projection.assignment!.kind = "drill";
      projection.assignment!.prompt.conjunction_hint = { meaning_category: "time", verb_position: null };
      const f = fixture({ current: projection, state_version: "3" });
      expect((await f.api.read("token", "proof", origin)).current).toEqual(projection);
    }
  });
  // R12-08: the learner's own association stands in the oral question. Older core: no key (accepted); the core with the patch: null or a value.
  it.each([["no key (an older core)", undefined], ["null: none of their own", null],
    ["a value", { value: "Haus wie ein Zuhause", version: "4" }], ["a blank value", { value: "  ", version: "1" }]] as const)(
    "accepts the optional association of the oral prompt: %s", async (_name, association) => {
      for (const revealed of [false, true]) {
        const projection = revealed ? current("presented", true) : current();
        if (association !== undefined) Object.assign(projection.assignment!.prompt, { association });
        const f = fixture({ current: projection, state_version: "3" });
        const read = (await f.api.read("token", "proof", origin)).current as OralSessionProjection;
        expect(read).toEqual(projection);
        expect(Object.hasOwn(read.assignment!.prompt, "association")).toBe(association !== undefined);
      }
    });
  it("practice follows current profile pair and date independently of the historical session", async () => {
    const projection = finished("closed", 1);
    projection.practice = { ...projection.practice, pair: "en-de", local_date: "9999-12-31", time_zone: "Europe/Berlin" };
    expect((await fixture({ current: projection, state_version: "3" }).api.read("token", "proof", origin)).current).toEqual(projection);
  });
  it.each([[409, "ASSIGNMENT_STALE", "rejected"], [409, "COMMAND_PAYLOAD_MISMATCH", "mismatch"],
    [403, "FORBIDDEN", "rejected"], [422, "VALIDATION_FAILED", "rejected"]] as const)(
    "keeps HTTP%s %s distinct from acceptance", async (status, code, outcome) => {
      const f = fixture({ command: { id: id(4), status: "rejected" }, current: current(), state_version: "3", error: { code } }, status);
      expect(await f.api.send("token", "proof", commands[3])).toMatchObject({ outcome, error: { code } });
    });
  it("copies nested intent before awaiting and leaves no credentials in durable intent", async () => {
    const original = structuredClone(commands[4]), saved = structuredClone(original), f = fixture();
    let finish!: (response: Response) => void;
    f.fetcher.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.api.send("token", "proof", original);
    original.command_id = id(100); original.session_id = id(101); Object.assign(original.payload, { correct: false });
    finish(new Response(JSON.stringify(response(saved))));
    expect((await pending).command.id).toBe(saved.command_id);
    expect(JSON.parse(String(f.fetcher.mock.calls[0][1]?.body))).toEqual(saved);
    const { document_id: _document, client_instance_id: _client, ...intent } = saved;
    expect(validOralIntent(intent)).toBe(true); expect(copyOralIntent(intent)).toEqual(intent);
    expect(validOralIntent(saved)).toBe(false);
    expect(validOralIntent({ ...intent, token: "synthetic" })).toBe(false);
  });
  it.each([1, 0, "true", null])("does not coerce grade correct=%j", async correct => {
    const f = fixture();
    await expect(f.api.send("token", "proof", { ...commands[4], payload: { correct } } as OralCommand)).rejects.toThrow();
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each([{ ...commands[0], payload: { mode: "written", bucket: "words" } },
    { ...commands[0], payload: { mode: "oral", bucket: "unknown" } }, { ...commands[0], payload: { mode: "oral" } },
    { ...commands[3], assignment_id: "bad" }, { ...commands[3], payload: { translations: ["leak"] } },
    { ...commands[6], payload: { reason: "midnight" } }, { ...commands[3], kind: "answer.submit" },
    { ...commands[0], document_id: "bad" }, { ...commands[0], proof: "extra" }, { ...commands[0], command_id: "bad" }])(
    "rejects malformed outgoing commands before exchange %j", async command => {
      const f = fixture(); await expect(f.api.send("token", "proof", command as OralCommand)).rejects.toThrow();
      expect(f.fetcher).not.toHaveBeenCalled();
    });
  it.each([["", "proof"], ["token", ""]])("requires authentication and origin proof", async (token, proof) => {
    const f = fixture(); await expect(f.api.read(token, proof, origin)).rejects.toThrow(); expect(f.fetcher).not.toHaveBeenCalled();
  });
});

describe("oral adapter rejects malformed public projections", () => {
  const changes: [string, (v: Record<string, any>) => void][] = [
    ["foreign session", v => { v.session_id = id(90); }], ["unknown mode", v => { v.mode = "written"; }],
    ["invalid pair", v => { v.pair = "de-ru"; }], ["invalid direction", v => { v.direction = "l1-de"; }],
    ["invalid date", v => { v.local_date = "2026-02-30"; }], ["missing assignment", v => { v.assignment = null; }],
    ["unknown bucket", v => { v.bucket = "unknown"; }], ["negative count", v => { v.progress.correct = -1; }],
    ["unsafe count", v => { v.progress.total = 2 ** 53; }], ["fractional count", v => { v.practice.count = .5; }],
    ["incorrect sum", v => { v.progress.completed = 1; }], ["beyond total", v => { v.progress.total = 0; }],
    ["invalid practice date", v => { v.practice.local_date = "not-date"; }], ["invalid practice pair", v => { v.practice.pair = "de-en"; }],
    ["invalid practice direction", v => { v.practice.direction = "l1-de"; }], ["private field", v => { v.source_content = {}; }],
    ["written answer spec", v => { v.assignment.answer_spec = {}; }], ["snapshot", v => { v.assignment.snapshot = {}; }],
    ["prompt translation leak", v => { v.assignment.prompt.translations = ["leak"]; }],
    ["unrevealed translation leak", v => { v.assignment.translations = ["leak"]; }],
    ["missing conjunction key", v => { delete v.assignment.prompt.conjunction_hint; }],
    ["extra conjunction field", v => { v.assignment.prompt.conjunction_hint = { meaning_category: null, verb_position: null, hint: "private" }; }],
    ["association of the wrong shape", v => { v.assignment.prompt.association = "my own"; }],
    ["association without version", v => { v.assignment.prompt.association = { value: "mine" }; }],
    ["association with a private extra key", v => { v.assignment.prompt.association = { value: "mine", version: "1", language: "ru" }; }],
    ["association with a non-text value", v => { v.assignment.prompt.association = { value: 7, version: "1" }; }],
    ["association with a bad version", v => { v.assignment.prompt.association = { value: "mine", version: "01" }; }],
    ["association undefined-as-key beside an extra prompt key", v => { v.assignment.prompt.association = null; v.assignment.prompt.hint = "x"; }],
    ["non-German prompt", v => { v.assignment.prompt.language = "ru"; }], ["non-string text", v => { v.assignment.prompt.text = null; }],
    ["invalid assignment UUID", v => { v.assignment.id = "bad"; }], ["invalid card UUID", v => { v.assignment.card_id = "bad"; }],
    ["written kind", v => { v.assignment.kind = "learning"; }], ["answered assignment", v => { v.assignment.status = "answered"; }],
    ["non-boolean revealed", v => { v.assignment.revealed = 1; }],
    ["capability on prefetch", v => { v.capabilities.reveal_target = id(6); }],
    ["past capability", v => { v.assignment.status = "presented"; v.capabilities.reveal_target = id(90); }],
    ["wrong capability phase", v => { v.capabilities.summary_home = true; }], ["non-boolean stop", v => { v.capabilities.stop = 1; }],
    ["active summary", v => { v.summary = {}; }], ["active closure", v => { v.close_reason = "stop"; }],
  ];
  it.each(changes)("rejects %s", async (_name, change) => {
    const projection = current(); change(projection);
    await expect(fixture({ current: projection, state_version: "3" }).api.read("token", "proof", origin))
      .rejects.toMatchObject({ kind: "invalid_response" });
  });
  it.each(["missing translations", "unordered object", "non-string item", "prefetched reveal", "reveal capability", "missing grade target"])(
    "rejects revealed inconsistency %s", async problem => {
      const projection = current("presented", true), assignment = projection.assignment as unknown as Record<string, unknown>;
      if (problem === "missing translations") delete assignment.translations;
      if (problem === "unordered object") assignment.translations = { first: "дом" };
      if (problem === "non-string item") assignment.translations = [2];
      if (problem === "prefetched reveal") assignment.status = "prefetched";
      if (problem === "reveal capability") projection.capabilities.reveal_target = id(6);
      if (problem === "missing grade target") projection.capabilities.grade_target = null;
      await expect(fixture({ current: projection, state_version: "3" }).api.read("token", "proof", origin))
        .rejects.toMatchObject({ kind: "invalid_response" });
    });
  it.each(["live assignment", "count mismatch", "ratio mismatch", "extra ratio", "missing ratio", "capability", "close reason"])(
    "rejects summary inconsistency %s", async problem => {
      const projection = finished("summary");
      if (problem === "live assignment") projection.assignment = current().assignment;
      if (problem === "count mismatch") projection.summary!.correct = 1;
      if (problem === "ratio mismatch") projection.summary!.ratio!.numerator = 1;
      if (problem === "extra ratio") Object.assign(projection.summary!.ratio!, { private: true });
      if (problem === "missing ratio") projection.summary!.ratio = null;
      if (problem === "capability") projection.capabilities.grade_target = id(6);
      if (problem === "close reason") projection.close_reason = "stop";
      await expect(fixture({ current: projection, state_version: "3" }).api.read("token", "proof", origin))
        .rejects.toMatchObject({ kind: "invalid_response" });
    });
});

describe("oral adapter facts, missing-command closure and transport failures", () => {
  const badFacts = [{ id: id(90) }, { kind: "session.stop" }, { target_id: id(90) }, { status: "not_found" },
    { applied_at: "2026-02-30T12:00:00Z" }, { applied_at: "2026-09-30T12:00:00+02:00" },
    { result_id: id(90) }, { action_id: id(90) }, { context_id: id(90) }, { object_version: "1" }, { private: {} }];
  it.each(badFacts)("rejects altered reveal fact %j", async change => {
    const value = response(commands[3]); Object.assign(value.command, change);
    await expect(fixture(value).api.send("token", "proof", commands[3])).rejects.toMatchObject({ kind: "invalid_response" });
  });
  it.each([{ result_id: null }, { result_id: "bad" }, { action_id: null }, { action_id: "bad" },
    { object_version: "2" }, { object_version: 1 }, { object_version: null }, { context_id: id(9) }, { target_id: id(3) }])(
    "rejects altered grade fact %j", async change => {
      const value = response(commands[4], current(), "already_applied"); Object.assign(value.command, change);
      await expect(fixture(value).api.status("token", "proof", commands[4])).rejects.toMatchObject({ kind: "invalid_response" });
    });
  it.each(["0", "01", "9223372036854775808", 3, null])("rejects non-int64 state version %j", async state_version => {
    await expect(fixture({ ...response(), state_version }).api.send("token", "proof", commands[0]))
      .rejects.toMatchObject({ kind: "invalid_response" });
  });
  it("allows only exact unavailable current for an already accepted status", async () => {
    const value = response(commands[4], { status: "unavailable" }, "already_applied");
    expect(await fixture(value).api.status("token", "proof", commands[4])).toMatchObject({ outcome: "accepted", current: { status: "unavailable" } });
    await expect(fixture({ ...value, current: { status: "unavailable", assignment: {} } }).api.status("token", "proof", commands[4]))
      .rejects.toMatchObject({ kind: "invalid_response" });
  });
  it.each([undefined, "stop", "midnight", "pair_changed", "timezone_date_changed", "remote_stop", "summary_home"])(
    "reads unresolved command with optional minimal closure %j", async close_reason => {
      const value = missing(close_reason && { session_id: id(3), status: "closed", close_reason });
      expect(await fixture(value).api.status("token", "proof", commands[3])).toEqual({ ...value, outcome: "not_found" });
    });
  it.each([null, {}, { session_id: id(99), status: "closed", close_reason: "stop" },
    { session_id: id(3), status: "active", close_reason: "stop" }, { session_id: id(3), status: "closed", close_reason: null },
    { session_id: id(3), status: "closed", close_reason: "unknown" }, { session_id: id(3), status: "closed", close_reason: "stop", assignment: {} }])(
    "rejects malformed closed boundary %j", async closed => {
      await expect(fixture(missing(closed)).api.status("token", "proof", commands[3])).rejects.toMatchObject({ kind: "invalid_response" });
    });
  it.each(["send", "status"] as const)("rejects acceptance with closed boundary or an error in %s", async method => {
    const value = response(commands[3], current(), method === "status" ? "already_applied" : "applied");
    for (const extra of [{ closed_session: { session_id: id(3), status: "closed", close_reason: "stop" } },
      { error: { code: "WRITE_UNAVAILABLE" } }, { unexpected_private_snapshot: {} }]) {
      await expect(fixture({ ...value, ...extra }).api[method]("token", "proof", commands[3])).rejects.toMatchObject({ kind: "invalid_response" });
    }
  });
  it("rejects extra private profile fields during not_found", async () => {
    await expect(fixture({ ...missing(), current: { ...profile, private: {} } }).api.status("token", "proof", commands[3]))
      .rejects.toMatchObject({ kind: "invalid_response" });
  });
  describe("not_found with the profile of the real core (reapply_closed present)", () => {
    // The recording is verbatim: the command under test takes its command and session IDs.
    const recorded = recordedOralUnknownClosed;
    const lost: OralCommand = { ...commands[3], command_id: recorded.command.id, session_id: recorded.closed_session.session_id };
    it("accepts the recorded reply, reapply_closed included", async () => {
      expect(recorded.current).toHaveProperty("reapply_closed", false);
      expect(await fixture(recorded).api.status("token", "proof", lost)).toEqual({ ...recorded, outcome: "not_found" });
    });
    it("accepts a closed reapply and a reply of an older core without the field", async () => {
      expect(await fixture({ ...recorded, current: { ...recorded.current, reapply_closed: true } }).api.status("token", "proof", lost))
        .toMatchObject({ outcome: "not_found", current: { reapply_closed: true } });
      const { reapply_closed: _omitted, ...older } = recorded.current;
      expect(await fixture({ ...recorded, current: older }).api.status("token", "proof", lost)).toMatchObject({ outcome: "not_found" });
    });
    it.each([{ reapply_closed: "false" }, { reapply_closed: null }, { private: {} }, { reapply_closed: false, private: {} }])(
      "rejects a malformed or unknown profile key %j", async extra => {
        await expect(fixture({ ...recorded, current: { ...recorded.current, ...extra } }).api.status("token", "proof", lost))
          .rejects.toMatchObject({ kind: "invalid_response" });
      });
  });
  it.each([{ command: { id: id(90), status: "not_found" } },
    { current: { session_id: id(3), status: "not_found" } },
    { current: { ...profile, profile_id: "bad" } },
    { current: { ...profile, access: { ...profile.access, private: true } } }])(
    "rejects misaddressed or malformed not_found %j", async change => {
      await expect(fixture({ ...missing(), ...change }).api.status("token", "proof", commands[3]))
        .rejects.toMatchObject({ kind: "invalid_response" });
    });
  it("status cannot confirm a newly applied fact", async () => {
    await expect(fixture(response(commands[3])).api.status("token", "proof", commands[3]))
      .rejects.toMatchObject({ kind: "invalid_response" });
  });
  it.each(["read", "status"] as const)("keeps %s HTTP and network failures unresolved", async method => {
    const f = fixture({ error: { code: "WRITE_UNAVAILABLE" } }, 503);
    const invoke = () => method === "read" ? f.api.read("token", "proof", origin) : f.api.status("token", "proof", commands[3]);
    await expect(invoke()).rejects.toMatchObject({ kind: "http", status: 503 });
    f.fetcher.mockRejectedValueOnce(new TypeError("synthetic network"));
    await expect(invoke()).rejects.toMatchObject({ kind: "network" });
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([201, 202, 206])("requires HTTP200 for status, rejects HTTP%s", async status => {
    await expect(fixture(response(commands[3], current(), "already_applied"), status).api.status("token", "proof", commands[3]))
      .rejects.toMatchObject({ kind: "invalid_response" });
  });
  it.each([401, 403, 500, 503])("keeps HTTP%s failures as refusals", async status => {
    const f = fixture({ error: { code: "WRITE_UNAVAILABLE" } }, status);
    await expect(f.api.send("token", "proof", commands[3])).rejects.toMatchObject({ kind: "http", status });
    expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it("does not retry network failure", async () => {
    const f = fixture(); f.fetcher.mockRejectedValueOnce(new TypeError("synthetic network"));
    await expect(f.api.send("token", "proof", commands[3])).rejects.toMatchObject({ kind: "network" });
    expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it("bounds bytes before interpreting an acceptance", async () => {
    const f = fixture(response(), 200, 20);
    await expect(f.api.send("token", "proof", commands[0])).rejects.toMatchObject({ kind: "invalid_response" });
    expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it("rejects unreadable success JSON and retains an unreadable refusal's HTTP status", async () => {
    for (const status of [200, 503]) {
      const f = fixture(); f.fetcher.mockResolvedValueOnce(new Response("{broken", { status }));
      await expect(f.api.send("token", "proof", commands[0])).rejects.toMatchObject(
        status === 200 ? { kind: "invalid_response" } : { kind: "http", status });
    }
  });
});
