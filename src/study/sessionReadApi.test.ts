import { previewContent } from "../learning/learningPreview.test-support";
import { describe, expect, it, vi } from "vitest";
import type { SessionProjection, SessionResponse } from "../api/generated";
import { createLearningSessionApi } from "../learning/learningSessionApi";
import { createSessionReadApi, type SessionAddress } from "./sessionReadApi";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const address: SessionAddress = { session_id: id(3), client_instance_id: id(1), document_id: id(2) };
function written(): SessionProjection {
  return { session_id: id(3), mode: "written", status: "active", pair: "ru-de", direction: "l1-de",
    local_date: "2026-09-30", bucket: "words", close_reason: null, progress: { completed: 0, total: 2 },
    assignment: { id: id(6), card_id: id(7), status: "presented", kind: "original",
      prompt: { text: "дом", language: "ru", translations: ["дом"], personal_translation_version: null, hint: null, hint_version: null, conjunction_hint: null },
      answer_spec: { kind: "word", labels: ["word"], part_count: 1, case_sensitive: true } } };
}
function fixture(current: unknown = written(), stateVersion: unknown = "3", status = 200) {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ current, state_version: stateVersion }), { status }));
  const options = { fetcher, timeoutMs: 100, maxResponseBytes: 20000 };
  return { fetcher, api: createSessionReadApi(options), learning: createLearningSessionApi(options) };
}
const learning = (): SessionResponse["current"] => ({ session_id: id(3), mode: "learning", status: "active", pair: "ru-de",
  local_date: "2026-09-30", close_reason: null, group: { id: id(8), status: "assembling", version: "1", total: 2, preview_position: 0 },
  preview: { id: id(9), card_id: id(7), position: 1, total: 2, content: previewContent(id(7)) }, assignment: null });

describe("stored-mode session read", () => {
  it.each([null, { meaning_category: "konditional", verb_position: "Verb am Ende" },
    { meaning_category: null, verb_position: null }])("reads only the saved public conjunction hint %j", async hint => {
    const current = written(); current.assignment!.prompt.conjunction_hint = hint;
    expect((await fixture(current).api.read("token", "proof", address)).current).toEqual(current);
  });
  it.each([undefined, false, "konditional", {}, { meaning_category: "konditional" },
    { meaning_category: [], verb_position: null }, { meaning_category: null, verb_position: 1 },
    { meaning_category: "konditional", verb_position: "Verb am Ende", variants: ["falls"] }])(
    "rejects missing, malformed or private conjunction context %j", async hint => {
      const current = written(); Object.assign(current.assignment!.prompt, { conjunction_hint: hint });
      await expect(fixture(current).api.read("token", "proof", address)).rejects.toMatchObject({ kind: "invalid_response" });
    });
  it.each([written(), learning(), { ...written(), status: "summary", assignment: null },
    { ...written(), status: "summary", bucket: null, progress: { completed: 0, total: 0 }, assignment: null },
    { ...written(), status: "closed", close_reason: "stop", assignment: null },
    { session_id: id(3), status: "not_found" }, { session_id: id(3), status: "unavailable" }])(
    "reads the exact server projection without choosing or starting a mode: %j", async current => {
      const f = fixture(current);
      expect(await f.api.read("synthetic-token", "synthetic-proof", address)).toEqual({ current, state_version: "3" });
      expect(f.fetcher).toHaveBeenCalledOnce();
      const [url, init] = f.fetcher.mock.calls[0];
      const parsed = new URL(String(url), "http://localhost");
      expect(parsed.pathname).toBe(`/api/v1/sessions/${id(3)}`);
      expect(Object.fromEntries(parsed.searchParams)).toEqual({ client_instance_id: id(1), document_id: id(2) });
      expect(init).toMatchObject({ method: "GET", cache: "no-store", headers: {
        Authorization: "Bearer synthetic-token", "X-Origin-Proof": "synthetic-proof" } });
      expect(init?.body).toBeUndefined();
    });

  it.each(["words", "phrases"] as const)("accepts presented and prefetched original/drill %s questions", async bucket => {
    for (const kind of ["original", "drill"] as const) for (const status of ["prefetched", "presented"] as const) {
      const current = written(); current.bucket = bucket; current.assignment!.kind = kind; current.assignment!.status = status;
      if (bucket === "phrases") current.assignment!.answer_spec.kind = "phrase";
      const f = fixture(current);
      expect((await f.api.read("token", "proof", address)).current).toEqual(current);
    }
  });
  it("accepts a drill after all originals have been completed", async () => {
    const current = written(); current.assignment!.kind = "drill"; current.progress.completed = current.progress.total;
    expect((await fixture(current).api.read("token", "proof", address)).current).toEqual(current);
  });
  it.each(["ru", "uk", "en"] as const)("keeps the language and public forms prompt for %s", async language => {
    const current = written(); current.pair = `${language}-de`; current.assignment!.prompt.language = language;
    current.assignment!.answer_spec = { kind: "forms", labels: ["Infinitiv", "Partizip II"], part_count: 2, case_sensitive: false };
    expect((await fixture(current).api.read("token", "proof", address)).current).toEqual(current);
  });
  const unsafe: [string, (value: Record<string, any>) => void][] = [
    ["foreign session", x => { x.session_id = id(90); }],
    ["unknown mode", x => { x.mode = "oral"; }],
    ["Learning with written fields", x => { x.mode = "learning"; }],
    ["wrong pair", x => { x.pair = "de-ru"; }],
    ["reverse direction", x => { x.direction = "de-l1"; }],
    ["invalid date", x => { x.local_date = "2026-02-30"; }],
    ["private queue", x => { x.queue = [id(90)]; }],
    ["negative progress", x => { x.progress.completed = -1; }],
    ["over-completed", x => { x.progress.completed = 3; }],
    ["fractional total", x => { x.progress.total = 2.5; }],
    ["coerced total", x => { x.progress.total = "2"; }],
    ["no originals", x => { x.progress.total = 0; }],
    ["absent bucket", x => { x.bucket = null; }],
    ["absent active step", x => { x.assignment = null; }],
    ["active closed reason", x => { x.close_reason = "stop"; }],
    ["closed with step", x => { x.status = "closed"; x.close_reason = "stop"; }],
    ["closed without reason", x => { x.status = "closed"; x.assignment = null; }],
    ["summary with step", x => { x.status = "summary"; }],
    ["question snapshot", x => { x.assignment.snapshot = { answers: ["Haus"] }; }],
    ["invalid assignment ID", x => { x.assignment.id = "bad"; }],
    ["Learning assignment", x => { x.assignment.kind = "learning"; }],
    ["conjugation assignment", x => { x.assignment.kind = "conjugation"; }],
    ["already answered", x => { x.assignment.status = "answered"; }],
    ["answer in prompt", x => { x.assignment.prompt.answer = "Haus"; }],
    ["wrong language", x => { x.assignment.prompt.language = "en"; }],
    ["untyped hint", x => { x.assignment.prompt.hint = 4; }],
    ["invalid hint version", x => { x.assignment.prompt.hint_version = "0"; }],
    ["untyped translation", x => { x.assignment.prompt.translations = [3]; }],
    ["correct variants", x => { x.assignment.answer_spec.variants = [["Haus"]]; }],
    ["phrase in words", x => { x.assignment.answer_spec.kind = "phrase"; }],
    ["word in phrases", x => { x.bucket = "phrases"; }],
    ["no labels", x => { x.assignment.answer_spec.labels = []; }],
    ["untyped case flag", x => { x.assignment.answer_spec.case_sensitive = "true"; }],
  ];
  it.each(unsafe)("rejects an inconsistent or unsafe response: %s", async (_name, change) => {
    const value = written(); change(value); const f = fixture(value);
    await expect(f.api.read("token", "proof", address)).rejects.toMatchObject({ kind: "invalid_response" });
    expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it.each([0, "0", "9223372036854775808", null])("rejects invalid state version %s", async version => {
    await expect(fixture(written(), version).api.read("token", "proof", address)).rejects.toMatchObject({ kind: "invalid_response" });
  });
  it("does not allow unavailable to carry a guessed mode or step", async () => {
    await expect(fixture({ session_id: id(3), status: "unavailable", mode: "learning" }).api.read("token", "proof", address))
      .rejects.toMatchObject({ kind: "invalid_response" });
  });
  it("Learning callers still refuse an otherwise valid written session", async () => {
    const f = fixture(); await expect(f.learning.read("token", "proof", address)).rejects.toMatchObject({ kind: "invalid_response" });
    expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it.each(["api", "learning"] as const)("freezes the addressed session before awaiting in %s", async which => {
    const current = which === "learning" ? learning() : written();
    const f = fixture(current), original = { ...address, unexpected: "ignore" };
    let finish!: (value: Response) => void;
    f.fetcher.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = f[which].read("token", "proof", original);
    original.session_id = id(99); original.document_id = id(90);
    finish(new Response(JSON.stringify({ current, state_version: "3" })));
    expect((await pending).current).toEqual(current);
    expect(String(f.fetcher.mock.calls[0][0])).not.toMatch(/unexpected|ignore/);
  });
  it.each([401, 403, 409, 503])("does not treat HTTP%s as a state or retry it", async status => {
    const f = fixture(written(), "3", status);
    await expect(f.api.read("token", "proof", address)).rejects.toMatchObject({ kind: "http", status });
    expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it("does not retry a failed read automatically", async () => {
    const f = fixture(); f.fetcher.mockRejectedValueOnce(new TypeError("offline"));
    await expect(f.api.read("token", "proof", address)).rejects.toMatchObject({ kind: "network" });
    expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it.each(["session_id", "client_instance_id", "document_id"] as const)("rejects bad %s before fetch", async field => {
    const f = fixture(); await expect(f.api.read("token", "proof", { ...address, [field]: "bad" })).rejects.toThrow();
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each([["", "proof"], ["token", ""]])("requires authentication and proof (%s, %s)", async (token, proof) => {
    const f = fixture(); await expect(f.api.read(token, proof, address)).rejects.toThrow();
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});
