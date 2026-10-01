import { describe, expect, it, vi } from "vitest";
import type { AnswerSubmitCommand, LearningAnswerResponse, LearningSessionProjection } from "../api/generated";
import { createLearningAnswerApi } from "./learningAnswerApi";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const command = (): AnswerSubmitCommand => ({ command_id: id(1), client_instance_id: id(2), document_id: id(3),
  session_id: id(4), assignment_id: id(5), kind: "answer.submit", payload: { text: "Hallo" } });
const step = (): LearningSessionProjection => ({ session_id: id(4), status: "active", mode: "learning", pair: "ru-de",
  local_date: "2026-09-30", close_reason: null, group: { id: id(6), version: "3", status: "active", total: 1, preview_position: 1 },
  preview: null, assignment: { id: id(7), card_id: id(8), status: "prefetched", kind: "learning",
    prompt: { text: "привет", language: "ru", translations: ["привет"], personal_translation_version: null, hint: null, hint_version: null, conjunction_hint: null },
    answer_spec: { kind: "word", labels: ["word"], part_count: 1, case_sensitive: true } } });
const response = (): LearningAnswerResponse => ({
  command: { id: id(1), kind: "answer.submit", status: "applied", applied_at: "2026-09-30T12:00:00Z",
    target_id: id(5), action_id: id(9), result_id: id(10), context_id: null, object_version: "1" },
  action: { action_id: id(9), kind: "answer.submit", status: "active", version: "1" },
  result: { result_id: id(10), assignment_id: id(5), version: "1", grade: 4, correct: true,
    status: "active", accepted_at: "2026-09-30T12:00:00Z", answer_date: "2026-09-30",
    detail: { conjunction_hint: null, examples: null, input: { kind: "text", text: "Hallo" }, variants: [{ parts: ["Hallo"] }, { parts: ["Hi"] }],
      initial_check: { correct: true, variant_index: 0, correct_answer: "Hallo", other_answers: ["Hi"],
        matched_spans: [{ start: 0, end: 5 }], span_unit: "unicode_code_point", span_bounds: "start_inclusive_end_exclusive" } } },
  step: step(), capabilities: { answer_target: null, grades: null, correct_target: null, undo_target: null,
    stop: true, summary_home: false }, state_version: "8", error: null,
});
function fixture(value: unknown = response(), status = 200) {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(value), { status }));
  return { fetcher, api: createLearningAnswerApi({ fetcher, timeoutMs: 200, maxResponseBytes: 10000 }) };
}
function recovered() {
  const value = response(); Object.assign(value.command, { status: "already_applied" }); return value;
}

describe("Learning answer HTTP boundary", () => {
  it.each(["send", "status"] as const)("preserves frozen examples in the addressed result on %s", async method => {
    const value = recovered();
    const examples = { common: [{ id: id(40), text: "Falls es regnet…", role: "general" as const,
      highlighted_parts: ["Falls", { legacy: [0, true, null] }] }], personal: { value: "Mein Beispiel.", version: "2" } };
    value.result!.detail!.examples = examples;
    const reply = await fixture(value).api[method]("token", "proof", command());
    expect("result" in reply && reply.result?.detail?.examples).toEqual(examples);
    expect((value.step as LearningSessionProjection).assignment).not.toHaveProperty("examples");
  });
  it.each([undefined, false, [], {}, { common: [] }, { common: [], personal: false },
    { common: [], personal: { value: "x", version: "0" } }, { common: [], personal: { value: "x", version: "1", private: true } },
    { common: [{ id: id(40), text: "x", role: "wrong", highlighted_parts: [] }], personal: null },
    { common: [{ id: id(40), text: "x", role: null, highlighted_parts: {} }], personal: null },
    { common: [{ id: id(40), text: "x", role: null, highlighted_parts: [], private: true }], personal: null }])(
    "rejects missing or malformed answered examples %j", async examples => {
      const value = response(); Object.assign(value.result!.detail!, { examples });
      await expect(fixture(value).api.send("token", "proof", command())).rejects.toMatchObject({ kind: "invalid_response" });
    });
  it.each(["send", "status"] as const)("rejects a rewritten original answer fact in %s", async method => {
    const value = recovered();
    Object.assign(value.command, { object_version: "3" });
    value.result!.version = value.action!.version = "3";
    await expect(fixture(value).api[method]("token", "proof", command())).rejects.toMatchObject({ kind: "invalid_response" });
  });
  it.each([201, 202, 206])("rejects HTTP%s as answer status confirmation", async status => {
    await expect(fixture(recovered(), status).api.status("token", "proof", command()))
      .rejects.toMatchObject({ kind: "invalid_response" });
  });
  it("keeps diagnostic code-point ranges separate from the original correctness decision", async () => {
    const value = response();
    value.result!.version = value.action!.version = "2";
    const detail = value.result!.detail!; detail.input = { kind: "text", text: "😀Hxus" };
    detail.variants = [{ parts: ["😀Haus"] }, { parts: ["Gebäude"] }];
    Object.assign(detail.initial_check, { correct: false, variant_index: null, correct_answer: "😀Haus", matched_spans: [],
      other_answers: ["Gebäude"], input_errors: [{ start: 2, end: 3 }], answer_errors: [{ start: 2, end: 3 }] });
    const original = command(); original.payload = { text: "😀Hxus" };
    const reply = await fixture(value).api.send("token", "proof", original);
    expect(reply.result?.detail?.initial_check).toMatchObject({ correct: false,
      input_errors: [{ start: 2, end: 3 }], answer_errors: [{ start: 2, end: 3 }] });
    expect(reply.result?.grade).toBe(4);
  });
  it("allows absent diagnostics on older saved detail without fabricating ranges", async () => {
    const value = response(); Object.assign(value.result!.detail!.initial_check, { input_errors: null, answer_errors: null });
    expect((await fixture(value).api.send("token", "proof", command())).result?.detail?.initial_check.input_errors).toBeNull();
  });
  it.each([
    { input_errors: [], answer_errors: null },
    { input_errors: [], answer_errors: [{ start: 0, end: 100 }] },
    { input_errors: [{ start: -1, end: 1 }], answer_errors: [] },
    { input_errors: [{ start: 1, end: 1 }], answer_errors: [] },
    { input_errors: [{ start: true, end: 2 }], answer_errors: [] },
    { input_errors: [{ start: 0, end: 1, private: true }], answer_errors: [] },
    { input_errors: [{ start: 1, end: 4 }, { start: 2, end: 3 }], answer_errors: [] },
    { input_errors: [] },
  ])("rejects contradictory or malformed diagnostic spans %j", async diagnostics => {
    const value = response(); Object.assign(value.result!.detail!.initial_check, { correct: false, variant_index: null, ...diagnostics });
    await expect(fixture(value).api.send("token", "proof", command())).rejects.toMatchObject({ kind: "invalid_response" });
  });
  it.each(["input_errors", "answer_errors"])("an initially correct answer cannot contain %s", async key => {
    const value = response(); Object.assign(value.result!.detail!.initial_check, { input_errors: [], answer_errors: [], [key]: [{ start: 0, end: 1 }] });
    await expect(fixture(value).api.send("token", "proof", command())).rejects.toMatchObject({ kind: "invalid_response" });
  });
  it("sends the exact answer once and returns its result separately from the next unshown question", async () => {
    const f = fixture(), original = command();
    const reply = await f.api.send("token", "proof", original);
    expect(reply.outcome).toBe("accepted"); expect(reply.result?.assignment_id).toBe(id(5));
    expect(reply.step).toMatchObject({ assignment: { id: id(7), status: "prefetched" } });
    expect(reply.capabilities.answer_target).toBeNull();
    expect(f.fetcher).toHaveBeenCalledOnce();
    const [url, init] = f.fetcher.mock.calls[0];
    expect(url).toBe("/api/v1/commands"); expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer token", "X-Origin-Proof": "proof" });
    expect(JSON.parse(String(init?.body))).toEqual(original);
    expect(String(init?.body)).not.toMatch(/token|proof/);
  });

  it("explicit forgot has no text and is recovered as that same intent", async () => {
    const original = command(); original.payload = { forgot: true };
    const value = response(); value.result!.grade = 2; value.result!.correct = false;
    value.result!.detail!.input = { kind: "forgot" };
    Object.assign(value.result!.detail!.initial_check, { correct: false, variant_index: null, matched_spans: [] });
    const f = fixture(value);
    expect((await f.api.send("token", "proof", original)).result?.detail?.input).toEqual({ kind: "forgot" });
    expect(JSON.parse(String(f.fetcher.mock.calls[0][1]?.body)).payload).toEqual({ forgot: true });
  });

  it("status uses the original command ID in a GET without sending answer text or proof in its URL", async () => {
    const f = fixture(recovered()); const reply = await f.api.status("token", "proof", command());
    expect(reply.outcome).toBe("accepted"); expect(reply.command.status).toBe("already_applied");
    const [url, init] = f.fetcher.mock.calls[0], parsed = new URL(String(url), "http://localhost");
    expect(parsed.pathname).toBe(`/api/v1/commands/${id(1)}`);
    expect(Object.fromEntries(parsed.searchParams)).toEqual({ client_instance_id: id(2), document_id: id(3), session_id: id(4) });
    expect(init?.method).toBe("GET"); expect(init?.body).toBeUndefined();
    expect(String(url)).not.toMatch(/Hallo|proof|token/); expect(f.fetcher).toHaveBeenCalledOnce();
  });

  it("original acceptance version and newer current grade are both preserved", async () => {
    const value = recovered(); value.result!.version = value.action!.version = "9007199254740993"; value.result!.grade = 5;
    const f = fixture(value), reply = await f.api.status("token", "proof", command());
    expect(reply).toMatchObject({ outcome: "accepted", command: { object_version: "1" },
      result: { grade: 5, version: "9007199254740993" } });
  });

  it("a later correction does not make the initial check or original submitted text correct", async () => {
    const original = command(); original.payload = { text: "wrong" };
    const value = recovered(); value.result!.version = value.action!.version = "2";
    value.result!.detail!.input = { kind: "text", text: "wrong" };
    Object.assign(value.result!.detail!.initial_check, { correct: false, variant_index: null, matched_spans: [] });
    expect(await fixture(value).api.status("token", "proof", original)).toMatchObject({
      outcome: "accepted", result: { grade: 4, correct: true, detail: { initial_check: { correct: false } } } });
  });

  it.each(["unavailable", "closed", "detail_collected"])("retains the fact without reviving the old answer: %s", async phase => {
    const value = recovered();
    if (phase === "unavailable") {
      value.step = { status: "unavailable" }; value.result = value.action = null;
      value.capabilities.stop = false;
    } else if (phase === "closed") {
      value.step = { ...step(), status: "closed", close_reason: "midnight", assignment: null };
      value.result!.detail = null; value.capabilities.stop = false;
    } else value.result!.detail = null;
    const f = fixture(value), reply = await f.api.status("token", "proof", command());
    expect(reply.outcome).toBe("accepted");
    if (reply.outcome === "accepted") expect(reply.result?.detail ?? null).toBeNull();
  });

  it("missing fact remains distinct from a rejection or success", async () => {
    const value = { command: { id: id(1), status: "not_found" }, state_version: "8",
      current: { profile_id: id(50), role: "user", ui_language: "ru", dictionary_language: "ru", time_zone: "UTC",
        state_version: "8", access: { status: "admitted", version: "1", reason: null } } };
    const f = fixture(value); expect(await f.api.status("token", "proof", command())).toEqual({ ...value, outcome: "not_found" });
    expect(f.fetcher).toHaveBeenCalledOnce();
  });

  it.each([[409, "ASSIGNMENT_STALE", "rejected"], [409, "COMMAND_PAYLOAD_MISMATCH", "mismatch"],
    [403, "FORBIDDEN", "rejected"], [422, "VALIDATION_FAILED", "rejected"]] as const)(
    "keeps HTTP%s/%s separate from acceptance", async (status, code, outcome) => {
      const value = response(); value.command = { id: id(1), status: "rejected" }; value.error = { code };
      const f = fixture(value, status);
      expect(await f.api.send("token", "proof", command())).toMatchObject({ outcome, error: { code } });
      expect(f.fetcher).toHaveBeenCalledOnce();
    });

  const badFacts = [
    { id: id(99) }, { kind: "result.grade" }, { target_id: id(99) }, { action_id: id(99) }, { result_id: id(99) },
    { context_id: id(99) }, { object_version: "2" }, { object_version: 1 }, { applied_at: "2026-02-30T12:00:00Z" },
  ];
  it.each(badFacts)("refuses a malformed or wrongly addressed fact %j", async change => {
    const value = response(); Object.assign(value.command, change);
    await expect(fixture(value).api.send("token", "proof", command())).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("preserves different context on the addressed result and the next question", async () => {
    const value = response();
    const oldHint = { meaning_category: "konditional", verb_position: "Verb am Ende" };
    const nextHint = { meaning_category: "kausal", verb_position: "Verb auf Position 2" };
    value.result!.detail!.conjunction_hint = oldHint;
    (value.step as LearningSessionProjection).assignment!.prompt.conjunction_hint = nextHint;
    const reply = await fixture(value).api.send("token", "proof", command());
    expect(reply.result!.detail!.conjunction_hint).toEqual(oldHint);
    expect((reply.step as LearningSessionProjection).assignment!.prompt.conjunction_hint).toEqual(nextHint);
  });
  it.each([undefined, false, "konditional", {}, { meaning_category: "konditional" },
    { meaning_category: null, verb_position: 1 },
    { meaning_category: "konditional", verb_position: "Verb am Ende", variants: ["falls"] }])(
    "refuses malformed or private result context %j", async hint => {
      const value = response(); Object.assign(value.result!.detail!, { conjunction_hint: hint });
      await expect(fixture(value).api.send("token", "proof", command())).rejects.toMatchObject({ kind: "invalid_response" });
    });

  const invalid: [string, (value: LearningAnswerResponse) => void][] = [
    ["other session", value => { value.step = { ...step(), session_id: id(99) }; }],
    ["other assignment", value => { value.result!.assignment_id = id(99); }],
    ["unsafe next question", value => { Object.assign((value.step as LearningSessionProjection).assignment!.answer_spec, { variants: ["Hallo"] }); }],
    ["private result fields", value => { Object.assign(value.result!, { before_image: { hidden: true } }); }],
    ["private detail fields", value => { Object.assign(value.result!.detail!, { snapshot: { hidden: true } }); }],
    ["result without action", value => { value.action = null; }],
    ["different action revision", value => { value.action!.version = "2"; }],
    ["unavailable result", value => { value.step = { status: "unavailable" }; }],
    ["contradictory correctness", value => { value.result!.correct = false; }],
    ["wrong initial input", value => { value.result!.detail!.input = { kind: "text", text: "another" }; }],
    ["invalid initial index", value => { value.result!.detail!.initial_check.variant_index = 9; }],
    ["missing correct index", value => { value.result!.detail!.initial_check.variant_index = null; }],
    ["empty variants", value => { value.result!.detail!.variants = []; }],
    ["empty answer parts", value => { value.result!.detail!.variants[0].parts = []; }],
    ["out-of-range span", value => { value.result!.detail!.initial_check.matched_spans[0].end = 6; }],
    ["zero-length span", value => { value.result!.detail!.initial_check.matched_spans[0].end = 0; }],
    ["wrong span units", value => { Object.assign(value.result!.detail!.initial_check, { span_unit: "utf16" }); }],
    ["invalid result date", value => { value.result!.answer_date = "2026-02-30"; }],
    ["answer before present", value => { value.capabilities.answer_target = id(7); }],
    ["incomplete grade target", value => { Object.assign(value.capabilities, { grades: { values: [3, 4, 5] } }); }],
    ["home while active", value => { value.capabilities.summary_home = true; }],
    ["closed answer detail", value => { value.step = { ...step(), status: "closed", close_reason: "stop", assignment: null }; }],
  ];
  it.each(invalid)("refuses inconsistent/private current: %s", async (_name, mutate) => {
    const value = response(); mutate(value);
    await expect(fixture(value).api.send("token", "proof", command())).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("validates matched spans in code points rather than JavaScript string length", async () => {
    const original = command(); original.payload = { text: "😀x" };
    const value = response(); value.result!.detail!.input = { kind: "text", text: "😀x" };
    value.result!.grade = 2; value.result!.correct = false;
    Object.assign(value.result!.detail!.initial_check, { correct: false, variant_index: null, matched_spans: [{ start: 1, end: 2 }] });
    expect((await fixture(value).api.send("token", "proof", original)).outcome).toBe("accepted");
    value.result!.detail!.initial_check.matched_spans[0].end = 3;
    await expect(fixture(value).api.send("token", "proof", original)).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("permits answer only for the exact confirmed next assignment", async () => {
    const value = response(); (value.step as LearningSessionProjection).assignment!.status = "presented";
    value.capabilities.answer_target = id(7);
    expect((await fixture(value).api.send("token", "proof", command())).capabilities.answer_target).toBe(id(7));
    value.capabilities.answer_target = id(5);
    await expect(fixture(value).api.send("token", "proof", command())).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it.each(["send", "status"] as const)("HTTP200 with an error is not acceptance in %s", async method => {
    const value = method === "status" ? recovered() : response(); value.error = { code: "WRITE_UNAVAILABLE" };
    await expect(fixture(value).api[method]("token", "proof", command())).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it.each([401, 403, 500, 503])("HTTP%s without a valid outcome never establishes acceptance", async status => {
    const f = fixture({ error: { code: "FORBIDDEN" } }, status);
    await expect(f.api.send("token", "proof", command())).rejects.toMatchObject({ kind: "http", status });
    expect(f.fetcher).toHaveBeenCalledOnce();
  });

  it("network loss has no automatic retry", async () => {
    const f = fixture(); f.fetcher.mockRejectedValueOnce(new TypeError("synthetic network"));
    await expect(f.api.send("token", "proof", command())).rejects.toMatchObject({ kind: "network" });
    expect(f.fetcher).toHaveBeenCalledOnce();
  });

  it("even an acceptance-shaped HTTP503 is not confirmation", async () => {
    const f = fixture(response(), 503);
    await expect(f.api.send("token", "proof", command())).rejects.toMatchObject({ kind: "http", status: 503 });
    expect(f.fetcher).toHaveBeenCalledOnce();
  });

  it("an explicitly submitted empty string is distinct from forgot", async () => {
    const original = command(); original.payload = { text: "" };
    const value = response(); value.result!.detail!.input = { kind: "text", text: "" };
    value.result!.grade = 2; value.result!.correct = false;
    Object.assign(value.result!.detail!.initial_check, { correct: false, variant_index: null, matched_spans: [] });
    expect(await fixture(value).api.send("token", "proof", original)).toMatchObject({
      outcome: "accepted", result: { grade: 2, detail: { conjunction_hint: null, input: { kind: "text", text: "" } } } });
  });

  it.each([{ text: "Hallo", forgot: true }, { forgot: false }, { text: 1 }, {}, { text: "Hallo", grade: 5 }])(
    "invalid outgoing payload %j fails before any network work", async payload => {
      const f = fixture(), original = { ...command(), payload } as AnswerSubmitCommand;
      await expect(f.api.send("token", "proof", original)).rejects.toThrow();
      expect(f.fetcher).not.toHaveBeenCalled();
    });

  it("copies command and input before awaiting the network", async () => {
    const f = fixture(), original = command(), saved = structuredClone(original);
    let finish!: (response: Response) => void;
    f.fetcher.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const waiting = f.api.send("token", "proof", original);
    original.assignment_id = id(99); original.payload = { forgot: true };
    finish(new Response(JSON.stringify(response())));
    expect((await waiting).outcome).toBe("accepted");
    expect(JSON.parse(String(f.fetcher.mock.calls[0][1]?.body))).toEqual(saved);
  });
});

const missing = (closed_session: unknown) => ({ command: { id: id(1), status: "not_found" }, state_version: "8",
  current: { profile_id: id(50), role: "user", ui_language: "ru", dictionary_language: "ru", time_zone: "UTC",
    state_version: "8", access: { status: "admitted", version: "1", reason: null } }, closed_session });
describe("Learning answer missing-command closure", () => {
  it.each(["stop", "midnight", "pair_changed", "timezone_date_changed", "remote_stop", "summary_home"])(
    "preserves missing fact and final closure after %s", async reason => {
      const value = missing({ session_id: id(4), status: "closed", close_reason: reason }), f = fixture(value);
      expect(await f.api.status("token", "proof", command())).toEqual({ ...value, outcome: "not_found" });
      expect(f.fetcher).toHaveBeenCalledOnce(); expect(f.fetcher.mock.calls[0][1]?.method).toBe("GET");
    });
  it.each([null, {}, { session_id: id(99), status: "closed", close_reason: "stop" },
    { session_id: id(4), status: "active", close_reason: "stop" },
    { session_id: id(4), status: "closed", close_reason: null },
    { session_id: id(4), status: "closed", close_reason: "unknown" },
    { session_id: id(4), status: "closed", close_reason: "stop", assignment: {} }])(
    "rejects malformed or foreign closure %j", async closed => {
      const f = fixture(missing(closed));
      await expect(f.api.status("token", "proof", command())).rejects.toMatchObject({ kind: "invalid_response" });
    });
  it("a failing HTTP reply cannot establish non-application", async () => {
    const f = fixture(missing({ session_id: id(4), status: "closed", close_reason: "stop" }), 503);
    await expect(f.api.status("token", "proof", command())).rejects.toMatchObject({ status: 503 });
  });
});

function withRevisionRight(correction = false) {
  const value = response();
  const target = { session_id: id(4), assignment_id: id(5), result_id: id(10), expected_result_version: "1" };
  if (correction) {
    value.result!.grade = 2; value.result!.correct = false;
    value.result!.detail!.input = { kind: "text", text: "wrong" };
    Object.assign(value.result!.detail!.initial_check, { correct: false, variant_index: null, matched_spans: [] });
    value.capabilities.correct_target = target;
  } else value.capabilities.grades = { ...target, values: [3, 4, 5] };
  return value;
}
describe("Learning addressed result capabilities", () => {
  it.each([false, true])("accepts a current revision capability, correction=%s", async correction => {
    const value = withRevisionRight(correction), original = command();
    if (correction) original.payload = { text: "wrong" };
    const f = fixture(value), reply = await f.api.send("token", "proof", original);
    expect(reply.capabilities).toEqual(value.capabilities);
    expect(reply.step).toEqual(value.step);
  });
  it("accepts current-version grade rights with an older stored command fact", async () => {
    const value = withRevisionRight(); Object.assign(value.command, { status: "already_applied" });
    value.result!.version = value.action!.version = value.capabilities.grades!.expected_result_version = "3";
    const parsed = await fixture(value).api.status("token", "proof", command());
    expect(parsed.command).toMatchObject({ object_version: "1" });
    if (parsed.outcome === "accepted") expect(parsed.capabilities.grades?.expected_result_version).toBe("3");
  });
  const corrupt: [string, (value: LearningAnswerResponse, correction: boolean) => void][] = [
    ["session", (value, correction) => { (correction ? value.capabilities.correct_target : value.capabilities.grades)!.session_id = id(99); }],
    ["assignment", (value, correction) => { (correction ? value.capabilities.correct_target : value.capabilities.grades)!.assignment_id = id(99); }],
    ["result", (value, correction) => { (correction ? value.capabilities.correct_target : value.capabilities.grades)!.result_id = id(99); }],
    ["version", (value, correction) => { (correction ? value.capabilities.correct_target : value.capabilities.grades)!.expected_result_version = "2"; }],
    ["extra", (value, correction) => { Object.assign(correction ? value.capabilities.correct_target! : value.capabilities.grades!, { private: true }); }],
    ["closed", value => { value.step = { ...step(), status: "closed", close_reason: "stop", assignment: null }; value.result!.detail = null; value.capabilities.stop = false; }],
    ["undone", value => { value.action!.status = value.result!.status = "undone"; }],
  ];
  it.each(corrupt)("rejects wrong %s for both kinds of revision", async (_name, damage) => {
    for (const correction of [false, true]) {
      const value = withRevisionRight(correction), original = command();
      if (correction) original.payload = { text: "wrong" };
      damage(value, correction);
      await expect(fixture(value).api.send("token", "proof", original)).rejects.toMatchObject({ kind: "invalid_response" });
    }
  });
  it.each([[3, 3, 5], [3, 4], [3, 4, 5, 5], ["3", 4, 5], [2, 4, 5], []].map(values => ({ values })))(
    "rejects incomplete or duplicated grade values $values", async ({ values }) => {
      const value = withRevisionRight(); Object.assign(value.capabilities.grades!, { values });
      await expect(fixture(value).api.send("token", "proof", command())).rejects.toMatchObject({ kind: "invalid_response" });
    });
  it.each([false, true])("rejects a right for the wrong grade category, correction=%s", async correction => {
    const value = withRevisionRight(correction), original = command();
    value.result!.grade = correction ? 4 : 2; value.result!.correct = correction;
    if (correction) original.payload = { text: "wrong" };
    await expect(fixture(value).api.send("token", "proof", original)).rejects.toMatchObject({ kind: "invalid_response" });
  });
});

it.each(["send", "status"] as const)("the submit-only interface refuses a revision passed to %s", async method => {
  const f = fixture();
  const revision = { ...command(), kind: "result.correct", result_id: id(10), expected_result_version: "1", payload: {} };
  await expect(f.api[method]("token", "proof", revision as unknown as AnswerSubmitCommand)).rejects.toThrow();
  expect(f.fetcher).not.toHaveBeenCalled();
});
