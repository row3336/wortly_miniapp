import { describe, expect, it, vi } from "vitest";
import type { ConjugationCatalog, ConjugationResultReadResponse, ConjugationSessionProjection, Profile, SavedCommandFact } from "../api/generated";
import { createSessionReadApi } from "../study/sessionReadApi";
import { createConjugationApi, type ConjugationResultAddress, type ConjugationSessionAddress } from "./conjugationApi";
import { conjugationIntentHash, copyConjugationIntent, validConjugationIntent, type ConjugationCommand, type ConjugationResultCommand,
  type ConjugationScheduleTransportCommand, type ConjugationSessionCommand } from "./conjugationIntent";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const origin = { client_instance_id: id(1), document_id: id(2) };
const address: ConjugationSessionAddress = { ...origin, session_id: id(3) };
const resultAddress: ConjugationResultAddress = { ...address, assignment_id: id(4), result_id: id(6) };
const submit = (payload: { text: string } | { forgot: true } = { text: "komme" }): ConjugationResultCommand => ({
  ...address, assignment_id: id(4), command_id: id(10), kind: "answer.submit", payload });
const schedule: ConjugationScheduleTransportCommand = { ...origin, command_id: id(11), kind: "conjugation.schedule",
  payload: { base_verb_id: id(8), tense: "present" } };
const start: ConjugationSessionCommand = { ...address, command_id: id(12), kind: "session.start", payload: { mode: "conjugation" } };
const grade: ConjugationResultCommand = { ...resultAddress, command_id: id(13), kind: "result.grade", expected_result_version: "1", payload: { grade: 5 } };
const correct: ConjugationResultCommand = { ...resultAddress, command_id: id(14), kind: "result.correct", expected_result_version: "1", payload: {} };
const present: ConjugationSessionCommand = { ...address, assignment_id: id(5), command_id: id(15), kind: "assignment.present", payload: {} };
const stop: ConjugationSessionCommand = { ...address, command_id: id(16), kind: "session.stop", payload: { reason: "stop" } };
function catalog(): ConjugationCatalog {
  return { pair: "ru-de", local_date: "2026-10-01", items: [
    { base_verb_id: id(8), lemma: "kommen", tense: "present", status: "openable", due_date: null, can_schedule: true },
    // Availability is server state, independent of the client's calendar comparison.
    { base_verb_id: id(8), lemma: "kommen", tense: "preterite", status: "ready", due_date: "2026-12-01", can_schedule: false },
  ] };
}
function session(): ConjugationSessionProjection {
  return { session_id: id(3), status: "active", mode: "conjugation", pair: "ru-de", direction: "conjugation",
    local_date: "2026-10-01", close_reason: null, progress: { total: 3, completed: 1, correct: 1, wrong: 0 },
    assignment: { id: id(5), card_id: id(8), status: "presented", kind: "conjugation", cycle_id: id(9),
      slot_id: { cycle_id: id(9), pronoun_group: "du" }, base_verb_id: id(8), display_verb_id: id(18), tense: "present", pronoun_group: "du",
      prompt: { verb: "ankommen", translation: "прибывать", language: "ru", pronoun: "du", tense: "present" },
      answer_spec: { kind: "forms", labels: ["du"], part_count: 1, case_sensitive: false } }, summary: null,
    capabilities: { answer_target: id(5), correct_target: null, grades: null, undo_target: null, stop: true, summary_home: false } };
}
function summary(closed = false): ConjugationSessionProjection {
  const value = session();
  value.status = closed ? "closed" : "summary"; value.close_reason = closed ? "stop" : null;
  value.assignment = null; value.progress = { total: 3, completed: closed ? 1 : 3, correct: closed ? 1 : 2, wrong: closed ? 0 : 1 };
  value.summary = { completed_cycle_ids: closed ? [] : [id(9)], partial: closed ? [{ cycle_id: id(9), answered_groups: ["ich", "du", "wir", "ihr"] }] : [],
    results: Array.from({ length: value.progress.completed }, (_, n) => ({ result_id: id(6 + n), version: "1" })),
    completed: value.progress.completed, correct: value.progress.correct, wrong: value.progress.wrong };
  value.capabilities = { answer_target: null, correct_target: null, grades: null, undo_target: null, stop: !closed, summary_home: !closed };
  return value;
}
function result(): ConjugationResultReadResponse {
  return { action: { action_id: id(7), kind: "answer.submit", version: "1", status: "active" },
    result: { result_id: id(6), assignment_id: id(4), version: "1", grade: 4, correct: true, status: "active",
      accepted_at: "2026-10-01T08:00:00Z", answer_date: "2026-10-01", detail: {
        input: { kind: "text", text: "komme" }, initial_check: { correct: true, variant_index: 0, correct_answer: "komme", other_answers: [],
          matched_spans: [{ start: 0, end: 5 }], span_unit: "unicode_code_point", span_bounds: "start_inclusive_end_exclusive" },
        variants: [{ parts: ["komme"] }], conjunction_hint: null, examples: null } },
    step: session(), capabilities: { ...session().capabilities, grades: { session_id: id(3), assignment_id: id(4), result_id: id(6), expected_result_version: "1", values: [3, 4, 5] } }, state_version: "9" };
}
function unavailableResult(): ConjugationResultReadResponse {
  return { action: null, result: null, step: { session_id: id(3), status: "unavailable" },
    capabilities: { answer_target: null, correct_target: null, grades: null, undo_target: null, stop: false, summary_home: false }, state_version: "9" };
}
function fact(command: ConjugationCommand, status: "applied" | "already_applied" = "applied", objectVersion?: string): SavedCommandFact {
  const result = ["answer.submit", "result.grade", "result.correct"].includes(command.kind);
  return { id: command.command_id, kind: command.kind, status, applied_at: "2026-10-01T08:00:00+00:00",
    target_id: command.kind === "conjugation.schedule" ? command.payload.base_verb_id : "assignment_id" in command ? command.assignment_id : command.session_id,
    action_id: result ? id(7) : null, result_id: result ? id(6) : null, context_id: null,
    object_version: objectVersion ?? (result || command.kind === "conjugation.schedule" ? "1" : null) };
}
function fixture(body: unknown, status = 200, maxResponseBytes = 20000, timeoutMs = 100) {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));
  const options = { fetcher, timeoutMs, maxResponseBytes };
  return { fetcher, api: createConjugationApi(options), sessions: createSessionReadApi(options) };
}
const profile: Profile = { profile_id: id(90), access: { status: "admitted", version: "1", reason: null }, role: "user", ui_language: "ru", dictionary_language: "ru", time_zone: "Europe/Berlin", state_version: "9" };
const invalid = { kind: "invalid_response" };
async function withProof(command: ConjugationCommand, body: object) {
  const { client_instance_id: _client, document_id: _document, ...intent } = command;
  return { ...body, verified_intent_hash: await conjugationIntentHash(intent) };
}


describe("conjugation transport contract", () => {
  it("reads server-owned catalog without origin and separates schedule/session/result shapes", async () => {
    const f = fixture({ current: catalog(), state_version: "9223372036854775807" });
    expect((await f.api.catalog("synthetic-token")).current).toEqual(catalog());
    expect(f.fetcher.mock.calls[0]).toEqual(["/api/v1/conjugations", expect.objectContaining({ method: "GET", headers: { Authorization: "Bearer synthetic-token" } })]);
    expect((await fixture({ current: catalog(), command: fact(schedule), state_version: "9" }).api.send("t", "p", schedule)).outcome).toBe("accepted");
    for (const command of [start, present, stop]) {
      const current = command.kind === "session.stop" ? summary(true) : session();
      expect((await fixture({ current, command: fact(command), state_version: "9" }).api.send("t", "p", command)).current).toEqual(current);
    }
    expect((await fixture({ ...result(), command: fact(submit()) }).api.send("t", "p", submit())).result?.assignment_id).toBe(id(4));
    const forgot = result();
    forgot.result!.grade = 2; forgot.result!.correct = false;
    forgot.result!.detail!.input = { kind: "forgot" };
    Object.assign(forgot.result!.detail!.initial_check, { correct: false, variant_index: null, matched_spans: [] });
    forgot.capabilities.grades = null;
    forgot.capabilities.correct_target = { session_id: id(3), assignment_id: id(4), result_id: id(6), expected_result_version: "1" };
    expect((await fixture({ ...forgot, command: fact(submit({ forgot: true })) }).api.send("t", "p", submit({ forgot: true }))).result?.grade).toBe(2);
    await expect(fixture({ ...forgot, command: fact(submit()) }).api.send("t", "p", submit())).rejects.toMatchObject(invalid);
  });

  it("allows all exact intents including empty text and rejects mixed/foreign payloads before transport", async () => {
    const commands = [schedule, start, present, stop, submit(), submit({ text: "" }), submit({ forgot: true }), grade, correct,
      { ...stop, payload: { reason: "summary_home" } }];
    for (const command of commands) {
      const { client_instance_id: _c, document_id: _d, ...intent } = command;
      expect(validConjugationIntent(intent)).toBe(true); expect(copyConjugationIntent(intent as any)).toEqual(intent);
    }
    const bad = [
      { ...submit(), payload: { text: "", forgot: true } }, { ...submit(), payload: { forgot: false } },
      { ...submit(), payload: { text: 4 } }, { ...schedule, session_id: id(3) }, { ...start, payload: { mode: "conjugation", bucket: "words" } },
      { ...grade, payload: { grade: 2 } }, { ...correct, expected_result_version: "9223372036854775808" },
      { ...correct, kind: "result.undo" }, { ...present, payload: { variants: [] } }, { ...submit(), token: "x" },
    ];
    for (const command of bad) {
      const f = fixture({}); await expect(f.api.send("t", "p", command as any)).rejects.toThrow(); expect(f.fetcher).not.toHaveBeenCalled();
    }
  });

  it("dispatches stored conjugation sessions and validates exact read addresses", async () => {
    const f = fixture({ current: session(), state_version: "9" });
    expect((await f.sessions.read("t", "p", address)).current).toEqual(session());
    const r = fixture(result()); expect((await r.api.read("t", "p", resultAddress)).step).toEqual(session());
    const url = new URL(String(r.fetcher.mock.calls[0][0]), "https://synthetic.invalid");
    expect(Object.fromEntries(url.searchParams)).toEqual({ ...origin, assignment_id: id(4), result_id: id(6) });
    for (const bad of [{ ...resultAddress, result_id: id(60) }, { ...resultAddress, assignment_id: id(40) }]) {
      await expect(fixture(result()).api.read("t", "p", bad)).rejects.toMatchObject(invalid);
    }
    for (const bad of [{ ...address, result_id: id(6) }, { ...address, queue: [] }, { ...address, session_id: "bad" }]) {
      const f = fixture({}); await expect(f.api.read("t", "p", bad as any)).rejects.toThrow(); expect(f.fetcher).not.toHaveBeenCalled();
    }
  });

  it("requires the canonical pronoun for each of the six logical groups even when labels agree", async () => {
    const cases = [["ich", "ich"], ["du", "du"], ["er_sie_es", "er/sie/es"],
      ["wir", "wir"], ["ihr", "ihr"], ["sie_sie", "sie/Sie"]] as const;
    for (const [group, pronoun] of cases) {
      const current = session(), assignment = current.assignment!;
      assignment.status = "prefetched"; current.capabilities.answer_target = null;
      assignment.pronoun_group = assignment.slot_id.pronoun_group = group;
      assignment.prompt.pronoun = pronoun; assignment.answer_spec.labels = [pronoun];
      expect((await fixture({ current, state_version: "9" }).api.read("t", "p", address)).current).toEqual(current);
      const other = group === "ich" ? "du" : "ich";
      assignment.prompt.pronoun = other; assignment.answer_spec.labels = [other];
      await expect(fixture({ current, state_version: "9" }).api.read("t", "p", address)).rejects.toMatchObject(invalid);
    }
  });

  it("rejects hidden fields and inconsistent assignment relationships", async () => {
    const mutations = [
      (s: any) => { s.assignment.answer_spec.variants = ["kommst"]; }, (s: any) => { s.assignment.prompt.answer = "kommst"; },
      (s: any) => { s.queue = []; }, (s: any) => { s.assignment.slot_id.cycle_id = id(80); },
      (s: any) => { s.assignment.slot_id.pronoun_group = "ich"; }, (s: any) => { s.assignment.card_id = id(80); },
      (s: any) => { s.assignment.prompt.tense = "preterite"; }, (s: any) => { s.assignment.prompt.language = "de"; },
      (s: any) => { s.assignment.answer_spec.labels = ["ich"]; }, (s: any) => { s.capabilities.undo_target = {}; },
    ];
    for (const change of mutations) {
      const current = session(); change(current);
      await expect(fixture({ current, state_version: "9" }).api.read("t", "p", address)).rejects.toMatchObject(invalid);
    }
    const c = catalog(); c.items.push({ ...c.items[0], base_verb_id: c.items[0].base_verb_id.toUpperCase() });
    await expect(fixture({ current: c, state_version: "9" }).api.catalog("t")).rejects.toMatchObject(invalid);
    const c2 = catalog(); c2.items[1].can_schedule = true;
    await expect(fixture({ current: c2, state_version: "9" }).api.catalog("t")).rejects.toMatchObject(invalid);
    const c3 = catalog(); c3.items[0].due_date = "2026-02-30";
    await expect(fixture({ current: c3, state_version: "9" }).api.catalog("t")).rejects.toMatchObject(invalid);
  });

  it("accepts three-form resumed completion and frozen partial Stop without six-times arithmetic", async () => {
    for (const current of [summary(), summary(true)]) {
      expect((await fixture({ current, state_version: "9" }).api.read("t", "p", address)).current).toEqual(current);
    }
    const changes = [
      (s: any) => { s.summary.results.pop(); }, (s: any) => { s.summary.completed_cycle_ids.push(id(9)); },
      (s: any) => { s.summary.partial = [{ cycle_id: id(9), answered_groups: [] }]; },
      (s: any) => { s.summary.partial = [{ cycle_id: id(19), answered_groups: ["ich", "ich"] }]; },
      (s: any) => { s.summary.partial = [{ cycle_id: id(19), answered_groups: ["ich", "du", "er_sie_es", "wir", "ihr", "sie_sie"] }]; },
    ];
    for (const change of changes) {
      const current = summary(); change(current);
      await expect(fixture({ current, state_version: "9" }).api.read("t", "p", address)).rejects.toMatchObject(invalid);
    }
  });

  it("keeps old addressed result A while fresh presented B owns only its answer target", async () => {
    const body = { ...result(), command: fact(submit(), "already_applied") };
    const reply = await fixture(await withProof(submit(), body)).api.status("t", "p", submit());
    expect(reply.outcome).toBe("accepted");
    if ("step" in reply) { expect(reply.result?.assignment_id).toBe(id(4)); expect(reply.capabilities.answer_target).toBe(id(5)); }
    const bad = result(); bad.capabilities.answer_target = id(4);
    await expect(fixture(bad).api.read("t", "p", resultAddress)).rejects.toMatchObject(invalid);
    const version = result(); version.capabilities.grades!.expected_result_version = "2";
    await expect(fixture(version).api.read("t", "p", resultAddress)).rejects.toMatchObject(invalid);
    const detail = result(); (detail.result!.detail as any).before = {};
    await expect(fixture(detail).api.read("t", "p", resultAddress)).rejects.toMatchObject(invalid);
  });

  it("checks immutable revision facts against exact versions while allowing later revisions", async () => {
    for (const command of [grade, correct]) {
      const body = result(); body.action!.version = "3"; body.result!.version = "3"; body.result!.grade = 3;
      body.capabilities.grades!.expected_result_version = "3";
      expect((await fixture(await withProof(command, { ...body, command: fact(command, "already_applied", "2") })).api.status("t", "p", command)).outcome).toBe("accepted");
    }
    const sameVersion = result(); sameVersion.result!.grade = 5;
    expect((await fixture(await withProof(grade, { ...sameVersion, command: fact(grade, "already_applied", "1") })).api.status("t", "p", grade)).outcome).toBe("accepted");
    for (const altered of [{ id: id(99) }, { kind: "session.start" }, { target_id: id(5) }, { result_id: id(99) }, { object_version: "4" }]) {
      await expect(fixture({ ...result(), command: { ...fact(submit()), ...altered } }).api.send("t", "p", submit())).rejects.toMatchObject(invalid);
    }
    await expect(fixture(await withProof(grade, { ...result(), command: fact(grade, "already_applied", "2") })).api.status("t", "p", grade)).rejects.toMatchObject(invalid);
  });

  it("separates rejected/mismatch, unavailable acceptance and missing command lifecycle proof", async () => {
    for (const [code, outcome] of [["VERSION_CONFLICT", "rejected"], ["COMMAND_PAYLOAD_MISMATCH", "mismatch"]]) {
      const body = { ...unavailableResult(), command: { id: id(10), status: "rejected" }, error: { code } };
      expect((await fixture(body, 409).api.send("t", "p", submit())).outcome).toBe(outcome);
    }
    expect((await fixture(await withProof(submit(), { ...unavailableResult(), command: fact(submit(), "already_applied") })).api.status("t", "p", submit())).outcome).toBe("accepted");
    const missing = { command: { id: start.command_id, status: "not_found" }, current: profile, state_version: "9",
      closed_session: { session_id: id(3), status: "closed", close_reason: "stop" } };
    expect((await fixture(missing).api.status("t", "p", start)).outcome).toBe("not_found");
    await expect(fixture({ ...missing, closed_session: { ...missing.closed_session, session_id: id(80) } }).api.status("t", "p", start)).rejects.toMatchObject(invalid);
    for (const command of [schedule, start]) {
      expect((await fixture(await withProof(command, { current: { status: "unavailable" }, command: fact(command, "already_applied"), state_version: "9" })).api.status("t", "p", command)).outcome).toBe("accepted");
    }
  });

  it("validates exact signed-64 versions, calendar dates and safe form counts", async () => {
    const current = session(); current.progress.total = Number.MAX_SAFE_INTEGER;
    expect((await fixture({ current, state_version: "9223372036854775807" }).api.read("t", "p", address)).state_version).toBe("9223372036854775807");
    const maximal = result(); maximal.action!.version = maximal.result!.version = "9223372036854775807";
    maximal.result!.grade = 5; maximal.capabilities.grades!.expected_result_version = "9223372036854775807";
    const maxGrade = { ...grade, expected_result_version: "9223372036854775807" };
    expect((await fixture(await withProof(maxGrade, { ...maximal, command: fact(maxGrade, "already_applied", "9223372036854775807") })).api.status("t", "p", maxGrade)).outcome).toBe("accepted");
    for (const version of ["0", "01", "9223372036854775808", 1]) {
      await expect(fixture({ current: session(), state_version: version }).api.read("t", "p", address)).rejects.toMatchObject(invalid);
    }
    for (const change of [(s: any) => { s.local_date = "2026-02-30"; }, (s: any) => { s.progress.total = Number.MAX_SAFE_INTEGER + 1; },
      (s: any) => { s.progress.correct = 0; }, (s: any) => { s.progress.wrong = -1; }]) {
      const current = session(); change(current);
      await expect(fixture({ current, state_version: "9" }).api.read("t", "p", address)).rejects.toMatchObject(invalid);
    }
    const body = result(); body.result!.accepted_at = "2026-02-30T08:00:00Z";
    await expect(fixture(body).api.read("t", "p", resultAddress)).rejects.toMatchObject(invalid);
  });

  it("copies nested intent and result address before awaiting", async () => {
    const command = submit(); const f = fixture({});
    let finish!: (response: Response) => void;
    f.fetcher.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.api.send("t", "p", command);
    command.assignment_id = id(80); if ("text" in command.payload) command.payload.text = "changed";
    finish(new Response(JSON.stringify({ ...result(), command: fact(submit()) })));
    expect((await pending).outcome).toBe("accepted");
    expect(JSON.parse(String(f.fetcher.mock.calls[0][1]?.body))).toEqual(submit());
    const a = { ...resultAddress }, r = fixture({});
    r.fetcher.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const reading = r.api.read("t", "p", a); a.result_id = id(80); a.session_id = id(81);
    finish(new Response(JSON.stringify(result()))); expect((await reading).result?.result_id).toBe(id(6));
  });

  it("bounds responses/deadlines and never retries HTTP or network failures", async () => {
    const over = fixture({ current: catalog(), state_version: "9" }, 200, 8);
    await expect(over.api.catalog("t")).rejects.toMatchObject(invalid); expect(over.fetcher).toHaveBeenCalledOnce();
    const offline = fixture({}); offline.fetcher.mockRejectedValueOnce(new TypeError("synthetic offline"));
    await expect(offline.api.send("t", "p", submit())).rejects.toMatchObject({ kind: "network" }); expect(offline.fetcher).toHaveBeenCalledOnce();
    const deadline = fixture({}, 200, 20000, 5); deadline.fetcher.mockImplementationOnce(() => new Promise(() => {}));
    await expect(deadline.api.status("t", "p", submit())).rejects.toMatchObject({ kind: "network" }); expect(deadline.fetcher).toHaveBeenCalledOnce();
    for (const status of [401, 403, 409, 422, 503]) {
      const f = fixture({ error: { code: "WRITE_UNAVAILABLE" } }, status);
      await expect(f.api.send("t", "p", start)).rejects.toMatchObject({ kind: "http", status }); expect(f.fetcher).toHaveBeenCalledOnce();
    }
  });
});
