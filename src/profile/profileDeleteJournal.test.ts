import { afterEach, describe, expect, it, vi } from "vitest";
import type { Profile } from "../api/generated";
import { TRACE_HEADER } from "../api/http";
import type { OpenedAccess } from "../app/openedAccess";
import { WriteGate } from "../commands/writeGate";
import { ManualClock } from "../commands/writeGate.test-support";
import { ClientJournal, installClientJournal } from "../journal/clientJournal";
import type { ClientEvent } from "../journal/events";
import { createProfileDeleteApi, type ProfileDeleteApi, type ProfileDeleteReply } from "./profileDeleteApi";
import { CONFIRM_DELAY_MS, ProfileDeleteController, type DeletionEnd } from "./profileDeleteController";
import { memoryStorage } from "./profileStorage.test-support";

// DEV-41 M2 (events §4.5, П-Р2; plan ред.3 M2/§9; C486 P3-D/P3-E): c.delete and c.defect of the profile deletion, over the
// real ProfileDeleteApi and transport with a synthetic fetch, and a real ClientJournal of the admitted profile X.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const X = id(50);
const profile = (): Profile => ({ profile_id: X, role: "user", ui_language: "ru", dictionary_language: "ru", time_zone: "UTC",
  state_version: "1", access: { status: "admitted", version: "1", reason: null } });
const QUESTION_TEXT = "delete_profile";

function access(): OpenedAccess {
  const credentials = { token: "MARKER-TOKEN", proof: "MARKER-PROOF", clientInstanceId: id(1), documentId: id(2) };
  return { key: `${X}:doc`, profile: profile(), session: null, document: { clientInstanceId: id(1), documentId: id(2), epoch: "1" },
    isLive: () => true, run: async operation => operation(credentials) };
}

type Answer = Response | (() => Response) | "network";
const json = (body: unknown, status: number, echo?: string) => new Response(typeof body === "string" ? body : JSON.stringify(body),
  { status, ...(echo === undefined ? {} : { headers: { [TRACE_HEADER]: echo } }) });
const applied = (commandId: string, status = "applied") => json({ command: { id: commandId, kind: "profile.delete", status,
  applied_at: "2026-10-16T05:00:00.000000Z" }, deletion: { request_id: id(70), working_data: "deleted", archive: "pending",
  fully_deleted: false, archive_deadline: "2026-11-16" }, session: "revoked" }, 200);

const OWN = new Set(["c.reset", "c.defect", "c.delete"]);
function setup(answers: Array<Answer | ((commandId: string) => Response)>, checks: Answer[] = [],
  wrap?: (api: ProfileDeleteApi) => ProfileDeleteApi) {
  const clock = new ManualClock();
  const gate = new WriteGate({ clock });
  const deletes: Array<{ trace: string; commandId: string; body: string }> = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/profile/delete")) {
      const body = String(init!.body);
      const commandId = (JSON.parse(body) as { command_id: string }).command_id;
      deletes.push({ trace: (init!.headers as Record<string, string>)[TRACE_HEADER], commandId, body });
      const next = answers.shift() ?? "network";
      if (next === "network") throw new TypeError("network");
      return typeof next === "function" ? next(commandId) : next;
    }
    if (url.endsWith("/settings")) {
      const next = checks.shift() ?? "network";
      if (next === "network") throw new TypeError("network");
      return typeof next === "function" ? next() : next;
    }
    throw new Error(`unexpected ${url}`);
  });
  const real = createProfileDeleteApi({ fetcher, timeoutMs: 1000, maxResponseBytes: 60000, gate });
  const journal = new ClientJournal({ clientVersion: "0.0.0", send: vi.fn(async () => ({ status: 200 })),
    openStore: async () => ({ load: async () => null, save: async () => undefined, keepOnly: async () => undefined }),
    clock: { now: () => Date.parse("2026-10-16T05:00:00.000Z"), schedule: () => ({}), cancel: () => undefined } });
  journal.admit(X);
  installClientJournal(journal);
  const { storage } = memoryStorage({ [`wortly.installation:${X}`]: "{}" });
  const ended: DeletionEnd[] = [];
  let n = 100;
  const controller = new ProfileDeleteController({ api: wrap ? wrap(real) : real, access, gate, storage, clock,
    newId: () => id(++n), onUpdate: () => undefined, onEnded: end => ended.push(end) });
  const own = (): ClientEvent[] => journal.pending().events.filter(event => OWN.has(event.ev))
    .map(event => { const { cts: _cts, ...rest } = event; return rest as ClientEvent; });
  return { clock, gate, controller, journal, deletes, ended, own };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
async function confirm(t: ReturnType<typeof setup>) {
  t.controller.open();
  await t.clock.advanceBy(CONFIRM_DELAY_MS);
  t.controller.confirm();
  for (let i = 0; i < 4; i++) await settle();
}

afterEach(() => installClientJournal(null));

describe("M2 §9: c.defect of the attempt a defect answered, its own trace and command_id", () => {
  it.each([
    ["D1 a bare 422 without an echo", json({ error: { code: "VALIDATION_FAILED" } }, 422), "VALIDATION_FAILED"],
    ["D2 a bad echo", json({ error: { code: "VALIDATION_FAILED" } }, 422, "not-a-uuid"), "VALIDATION_FAILED"],
    ["D3 another attempt's UUID as the echo", json({ error: { code: "VALIDATION_FAILED" } }, 422, id(777)), "VALIDATION_FAILED"],
    ["a 422 with a body that is no JSON (read as no body)", json("<html>proxy</html>", 422), undefined],
    ["409 COMMAND_PAYLOAD_MISMATCH", json({ error: { code: "COMMAND_PAYLOAD_MISMATCH" } }, 409, id(779)), "COMMAND_PAYLOAD_MISMATCH"],
  ] as const)("%s: one c.defect, no c.delete (P3-D); the screen as before", async (_label, answer, code) => {
    const t = setup([answer]);
    await confirm(t);
    const [sent] = t.deletes;
    expect(sent.commandId).toBe(id(101));
    expect(t.own()).toEqual([{ ev: "c.defect", cmd: id(101), trace: sent.trace, status: answer.status, ...(code ? { code } : {}) }]);
    expect(t.controller.snapshot()).toMatchObject({ phase: "refused", refusalCode: code ?? "VALIDATION_FAILED" });
    const text = JSON.stringify(t.journal.pending());
    for (const marker of ["not-a-uuid", id(777), id(779), QUESTION_TEXT, "MARKER", X]) expect(text).not.toContain(marker);
  });

  it("D4 §8 п.5: a 422 whose body stalls past the client's deadline — c.defect without a code", async () => {
    const t = setup([() => new Response(new ReadableStream({ start() { /* never closes */ } }), { status: 422 })]);
    t.controller.open();
    await t.clock.advanceBy(CONFIRM_DELAY_MS);
    t.controller.confirm();
    await vi.waitFor(() => expect(t.controller.snapshot().phase).toBe("refused"), { timeout: 3000 });
    expect(t.own()).toEqual([{ ev: "c.defect", cmd: id(101), trace: t.deletes[0].trace, status: 422 }]);
  });

  it("D7 a snapshot of another command: no c.defect", async () => {
    const t = setup([json({ error: { code: "VALIDATION_FAILED" } }, 422)], [], real => ({ ...real,
      delete: async (credentials, intent) => {
        // The answer of an earlier attempt of another intent: its snapshot names that command.
        const reply = { ...await real.delete(credentials, intent) };
        Object.defineProperty(reply, "attempt", { value: Object.freeze({ trace: id(900), commandId: id(999) }), enumerable: false });
        return reply;
      } }));
    await confirm(t);
    expect(t.own()).toEqual([]);
    expect(t.controller.snapshot()).toMatchObject({ phase: "refused", refusalCode: "VALIDATION_FAILED" });
  });

  it("a defect on a repeat after an unknown outcome: c.defect, then the read by the same session decides", async () => {
    const t = setup([json({ error: { code: "VALIDATION_FAILED" } }, 422)], [json({ settings: {} }, 200)], real => {
      let first = true;
      return { ...real, delete: async (credentials, intent): Promise<ProfileDeleteReply> => {
        if (first) { first = false; return { outcome: "unknown" }; }
        return real.delete(credentials, intent);
      } };
    });
    await confirm(t);
    await t.clock.advanceBy(2_000);
    for (let i = 0; i < 6; i++) await settle();
    expect(t.own()).toEqual([{ ev: "c.defect", cmd: id(101), trace: t.deletes[0].trace, status: 422, code: "VALIDATION_FAILED" }]);
    expect(t.controller.snapshot().phase).toBe("not_deleted");
  });
});

describe("M2: c.delete only for an outcome that was not applied, never del", () => {
  it.each([
    ["409 CLIENT_INCOMPATIBLE", json({ error: { code: "CLIENT_INCOMPATIBLE" } }, 409), "CLIENT_INCOMPATIBLE"],
    ["403 FORBIDDEN with the proof sent", json({ error: { code: "FORBIDDEN" } }, 403), "FORBIDDEN"],
  ] as const)("D5 %s: one c.delete refused with its code", async (_label, answer, code) => {
    const t = setup([answer]);
    await confirm(t);
    expect(t.own()).toEqual([{ ev: "c.delete", cmd: id(101), outcome: "refused", code }]);
    for (const event of t.own()) expect(Object.keys(event).sort()).toEqual(["cmd", "code", "ev", "outcome"]);
  });

  it("D5 403 ACCESS_REJECTED: the admission ended, the transport cleared the journal first — nothing of X is kept", async () => {
    const t = setup([json({ error: { code: "ACCESS_REJECTED" } }, 403)]);
    await confirm(t);
    expect(t.controller.snapshot()).toMatchObject({ phase: "refused", refusalCode: "ACCESS_REJECTED" });
    expect(t.journal.admitted()).toBeNull();
    expect(t.journal.pending()).toEqual({ events: [], lost: 0 });
  });

  it.each([
    ["applied", (commandId: string) => applied(commandId)],
    ["already_applied", (commandId: string) => applied(commandId, "already_applied")],
    ["PROFILE_DELETED", () => json({ error: { code: "PROFILE_DELETED" } }, 403)],
  ] as const)("D6 %s: no event, the buffer is empty", async (_label, answer) => {
    const t = setup([answer]);
    await confirm(t);
    expect(t.ended).toEqual([{ kind: "deleted" }]);
    expect(t.journal.pending()).toEqual({ events: [], lost: 0 });
  });

  it("the final «исход неизвестен» (AUTH_* after an unknown outcome, PD-28): one c.delete unknown, no code, no trace", async () => {
    const t = setup([json({ error: { code: "AUTH_EXPIRED" } }, 401)], [], real => {
      let first = true;
      return { ...real, delete: async (credentials, intent): Promise<ProfileDeleteReply> => {
        if (first) { first = false; return { outcome: "unknown" }; }
        return real.delete(credentials, intent);
      } };
    });
    await confirm(t);
    await t.clock.advanceBy(2_000);
    for (let i = 0; i < 6; i++) await settle();
    expect(t.ended).toEqual([{ kind: "unknown", confirmedProfileId: X }]);
    expect(t.own()).toEqual([{ ev: "c.delete", cmd: id(101), outcome: "unknown" }]);
  });

  it("an unknown outcome that is still being repeated writes nothing yet", async () => {
    const t = setup([json("bad gateway", 502)]);
    await confirm(t);
    expect(t.controller.snapshot()).toMatchObject({ phase: "waiting", repeating: true });
    expect(t.own()).toEqual([]);
  });
});
