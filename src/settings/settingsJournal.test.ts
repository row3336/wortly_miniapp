import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenedClient, Profile } from "../api/generated";
import { createOpenedAccess, type OpenedAccess } from "../app/openedAccess";
import { WriteGate } from "../commands/writeGate";
import { ManualClock } from "../commands/writeGate.test-support";
import type { AsyncStorage } from "../platform/storage";
import type { DocumentStaleSource } from "../api/http";
import { REPLACEMENT_PROOF_KINDS } from "../app/entryController";
import { createSettingsApi } from "./settingsApi";
import { SettingsController } from "./settingsController";
import { SettingsPendingStore } from "./settingsPending";
import { settingsResponse } from "./settingsRead.test-support";
import { settingsResetSlotOf, SettingsResetPendingStore } from "./settingsResetPending";
import { ApiError, TRACE_HEADER, type SentRequest } from "../api/http";
import { ClientJournal, installClientJournal } from "../journal/clientJournal";
import type { ClientEvent } from "../journal/events";
import type { SettingsApi } from "./settingsApi";

// DEV-41 M1 (events §4.5, plan ред.3 M1/§8, C486, C496): c.reset and c.defect of the settings reset. The harness below is the
// one of settingsResetClassifier.test.ts (the real SettingsApi, transport and write gate over a synthetic core of P02-R),
// copied so that file stays as it is; the journal is a real ClientJournal of an admitted profile whose sends never run.

// К19-057 (R16-01 variant 1) end to end: the real SettingsApi over a synthetic core of P02-R (canon r3, core ca6ccbb), the
// real transport and the real write gate with its observer and R6 tickets, and the controller of the settings document.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const time = "2026-10-16T05:00:00.000000Z";
const profile = (): Profile => ({ profile_id: id(1), access: { status: "admitted", version: "1", reason: null },
  role: "user", ui_language: "ru", dictionary_language: "uk", time_zone: "UTC", state_version: "1" });
const opened = (documentId = id(3)): OpenedClient => ({ status: "opened", client_instance_id: id(2), document_id: documentId,
  document_epoch: "1", proof_version: "1", profile: profile(), session: null, compatibility: { compatible: true, contract_version: "1" } });
type Outcome = "cancelled" | "rejected_stale_epoch" | "rejected_invalid" | "rejected_incompatible";
const answers: Record<Outcome, [string, number]> = { cancelled: ["RESET_CANCELLED", 409], rejected_stale_epoch: ["RESET_EPOCH_STALE", 409],
  rejected_invalid: ["VALIDATION_FAILED", 422], rejected_incompatible: ["CLIENT_INCOMPATIBLE", 409] };
/** What the core does with the next POST of X: decides it (default: applies it) or answers without a record of X. */
type ResetPlan = { kind: "apply" } | { kind: "store"; outcome: Outcome } | { kind: "unrecorded"; status: number; body: unknown }
  | { kind: "network" } | { kind: "apply_then_lose" } | { kind: "store_then_lose"; outcome: Outcome };

function core() {
  const data = settingsResponse();
  const facts = new Map<string, { kind: string; target?: string }>();
  const terminals = new Map<string, Outcome>();
  const log: string[] = [];
  const resetPlans: ResetPlan[] = [];
  const statusFailures: Array<"network" | { status: number; body: unknown }> = [];
  let cancelFailures = 0;
  const projection = () => { const { state_version, ...current } = structuredClone(data); return { current, state_version }; };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const fact = (commandId: string, kind: string, status: string, target = id(1), version: string | null = "7") => ({ id: commandId, kind,
    status, applied_at: time, target_id: target, action_id: null, result_id: null, context_id: null, object_version: version });
  const targetOutcome = (target: string) => facts.has(target) ? "applied" : terminals.get(target);
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input), method = init?.method ?? "GET";
    if (url.endsWith("/settings")) return json({ ...projection().current, state_version: data.state_version });
    const status = /\/commands\/([^/?]+)(\?.*)?$/.exec(url);
    if (method === "GET" && status) {
      const commandId = status[1], refusals = status[2] === "?include_refusal=true";
      log.push(`GET ${commandId}${refusals ? " include_refusal" : ""}`);
      const failure = statusFailures.shift();
      if (failure === "network") throw new TypeError("network");
      if (failure) return json(failure.body, failure.status);
      const held = facts.get(commandId), { current, state_version } = projection();
      if (held?.kind === "settings.reset") return json({ command: fact(commandId, held.kind, "already_applied"), current, state_version });
      if (held?.kind === "settings.reset_cancel") return json({ command: fact(commandId, held.kind, "already_applied", held.target, null),
        current: { ...current, reset_target: { command_id: held.target, outcome: targetOutcome(held.target!) } }, state_version });
      const terminal = terminals.get(commandId);
      if (terminal && refusals) {
        const [code, http] = answers[terminal];
        return json({ command: { id: commandId, kind: "settings.reset", status: "rejected", outcome: terminal, refused_at: time,
          ...(terminal === "rejected_invalid" || terminal === "rejected_incompatible" ? { http_status: http } : {}) },
        error: { code }, current, state_version });
      }
      return json({ command: { id: commandId, status: "not_found" }, current: profile(), state_version });
    }
    const body = JSON.parse(String(init!.body)) as Record<string, unknown>;
    const commandId = body.command_id as string;
    log.push(`POST ${body.kind} ${commandId}${body.kind === "settings.reset_cancel" ? ` → ${(body.payload as { target_command_id: string }).target_command_id}` : ""}`);
    if (body.kind === "settings.reset") {
      const attributed = (outcome: Outcome) => { const [code, http] = answers[outcome];
        return json({ command: { id: commandId, status: "rejected" }, error: { code }, ...projection() }, http); };
      if (facts.has(commandId)) return json({ command: fact(commandId, "settings.reset", "already_applied"), ...projection() });
      const stored = terminals.get(commandId);
      if (stored) return attributed(stored);
      const plan = resetPlans.shift() ?? { kind: "apply" };
      if (plan.kind === "network") throw new TypeError("network");
      if (plan.kind === "unrecorded") return json(plan.body, plan.status);
      if (plan.kind === "store" || plan.kind === "store_then_lose") {
        terminals.set(commandId, plan.outcome);
        if (plan.kind === "store_then_lose") throw new TypeError("network");
        return attributed(plan.outcome);
      }
      facts.set(commandId, { kind: "settings.reset" });
      data.state_version = String(BigInt(data.state_version) + 1n);
      data.settings.retry_count = { value: 4, version: String(BigInt(data.settings.retry_count.version) + 1n) };
      if (plan.kind === "apply_then_lose") throw new TypeError("network");
      return json({ command: fact(commandId, "settings.reset", "applied"), ...projection() });
    }
    if (body.kind === "settings.reset_cancel") {
      const target = (body.payload as { target_command_id: string }).target_command_id;
      if (cancelFailures > 0) { cancelFailures--; throw new TypeError("network"); }
      const known = facts.get(commandId);
      if (!known) {
        if (!facts.has(target) && !terminals.has(target)) terminals.set(target, "cancelled");
        facts.set(commandId, { kind: "settings.reset_cancel", target });
        data.state_version = String(BigInt(data.state_version) + 1n);
      }
      const { current, state_version } = projection();
      return json({ command: fact(commandId, "settings.reset_cancel", known ? "already_applied" : "applied", target, null),
        current: { ...current, reset_target: { command_id: target, outcome: targetOutcome(target) } }, state_version });
    }
    throw new Error("unexpected request");
  });
  return { data, facts, terminals, log, resetPlans, statusFailures, fetcher, failCancel: (n = 1) => { cancelFailures = n; } };
}

function memory(): { values: Map<string, string>; storage: AsyncStorage } {
  const values = new Map<string, string>();
  return { values, storage: { get: async key => values.get(key) ?? null, set: async (key, value) => { values.set(key, value); },
    remove: async key => { values.delete(key); } } };
}

let sequence = 100;
function world(server = core(), disk = memory(), junction = false, wrap?: (api: SettingsApi) => SettingsApi) {
  const clock = new ManualClock();
  const gate = new WriteGate({ clock, probe: async () => ({ status: "ready" }) });
  // The window's side of the DOCUMENT_STALE junction (entryController.documentStale → replacementProved → replace): an
  // attributed 409 of the reset family closes the window at once (closedWindow), before the module reads the refusal.
  const stale: DocumentStaleSource[] = [];
  const onDocumentStale = (source: DocumentStaleSource) => {
    stale.push(source);
    if (source.method === "POST" && source.kind !== null && REPLACEMENT_PROOF_KINDS.has(source.kind) && source.attributed) gate.closeWindow();
  };
  const real = createSettingsApi({ fetcher: server.fetcher, timeoutMs: 1000, maxResponseBytes: 60000, gate,
    ...(junction ? { onDocumentStale } : {}) });
  const api = wrap ? wrap(real) : real;
  let access: OpenedAccess | null = null;
  const open = (documentId = id(3), generation = 1) => {
    const handle: OpenedAccess = createOpenedAccess({ opened: opened(documentId), token: `token-${generation}`, proof: `proof-${generation}`,
      generation, isLive: () => access === handle, onDenied: () => {} });
    access = handle;
  };
  open();
  // The page's visibility as the controller reads it (C365 N3); show() is the return to the page.
  let hidden = false;
  const make = () => new SettingsController({ gate, api, pendingStore: new SettingsPendingStore(disk.storage),
    resetStore: new SettingsResetPendingStore(disk.storage), access: () => access, newId: () => id(sequence++), onUpdate: () => {},
    visible: () => !hidden });
  const record = () => { const raw = disk.values.get(settingsResetSlotOf(id(1))); return raw ? JSON.parse(raw) : null; };
  const hide = () => { hidden = true; };
  const show = () => { hidden = false; document.dispatchEvent(new Event("visibilitychange")); };
  return { server, disk, gate, clock, open, make, record, hide, show, stale };
}

const OWN = new Set(["c.reset", "c.defect", "c.delete"]);
/** The journal of the admitted profile id(1); `at` is what the reset record held on the disk when each own event came. */
function journalOf(w: ReturnType<typeof world>) {
  const journal = new ClientJournal({ clientVersion: "0.0.0", send: vi.fn(async () => ({ status: 200 })),
    openStore: async () => ({ load: async () => null, save: async () => undefined, keepOnly: async () => undefined }),
    clock: { now: () => Date.parse("2026-10-16T05:00:00.000Z"), schedule: () => ({}), cancel: () => undefined } });
  journal.admit(id(1));
  const at: unknown[] = [];
  const record = journal.record.bind(journal);
  journal.record = event => { if (OWN.has(event.ev)) at.push(structuredClone(w.record())); record(event); };
  installClientJournal(journal);
  const own = (): ClientEvent[] => journal.pending().events.filter(event => OWN.has(event.ev))
    .map(event => { const { cts: _cts, ...rest } = event; return rest as ClientEvent; });
  return { journal, own, at };
}
/** The X-Wortly-Trace-Id this client set on every POST settings.reset, in order. */
function resetTraces(server: ReturnType<typeof core>): string[] {
  return server.fetcher.mock.calls.filter(([, init]) => init?.method === "POST" && JSON.parse(String(init.body)).kind === "settings.reset")
    .map(([, init]) => (init!.headers as Record<string, string>)[TRACE_HEADER]);
}
/** The next POST settings.reset gets this answer, with nothing of X recorded (the core never saw it, or a proxy answered). */
function answerResetOnce(server: ReturnType<typeof core>, answer: () => Response) {
  const base = server.fetcher.getMockImplementation()!;
  let once = true;
  server.fetcher.mockImplementation(async (input, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (!once || body?.kind !== "settings.reset") return base(input, init);
    once = false;
    server.log.push(`POST ${body.kind} ${body.command_id}`);
    return answer();
  });
}
const bare = (status: number, body: unknown, echo?: string) => () => new Response(typeof body === "string" ? body : JSON.stringify(body),
  { status, ...(echo === undefined ? {} : { headers: { [TRACE_HEADER]: echo } }) });

afterEach(() => installClientJournal(null));

describe("M1: c.reset once the outcome of X is recorded, cmd X, code only for a refusal", () => {
  it.each([
    ["rejected_stale_epoch", { cmd: "X", kind: "settings.reset", outcome: "rejected_stale_epoch", code: "RESET_EPOCH_STALE" }],
    ["cancelled", { cmd: "X", kind: "settings.reset_cancel", outcome: "cancelled" }],
  ] as const)("F1 %s: written after «отказан» is stored", async (outcome, expected) => {
    const w = world(); const { own, at } = journalOf(w); const c = w.make(); await c.refresh();
    w.server.resetPlans.push({ kind: "store", outcome });
    await c.reset();
    const x = id(sequence - 1);
    expect(own()).toEqual([{ ...expected, ev: "c.reset", cmd: x }]);
    expect(at).toEqual([{ schemaVersion: 2, profileId: id(1), clientInstanceId: id(2),
      final: { command_id: x, code: outcome === "cancelled" ? "RESET_CANCELLED" : "RESET_EPOCH_STALE" } }]);
    c.dispose(); w.gate.dispose();
  });

  it("F1 whose «отказан» could not be stored: nothing is recorded, so nothing is written", async () => {
    const w = world(); const { own } = journalOf(w); const c = w.make(); await c.refresh();
    const replace = SettingsResetPendingStore.prototype.replace;
    const spy = vi.spyOn(SettingsResetPendingStore.prototype, "replace").mockImplementation(async function (this: SettingsResetPendingStore, ...args) {
      if ("final" in (args[1] as object)) throw new Error("synthetic storage failure");
      return replace.apply(this, args);
    });
    w.server.resetPlans.push({ kind: "store", outcome: "rejected_stale_epoch" });
    await c.reset();
    spy.mockRestore();
    expect(own()).toEqual([]);
    c.dispose(); w.gate.dispose();
  });

  it.each([
    ["rejected_invalid", "VALIDATION_FAILED"], ["rejected_incompatible", "CLIENT_INCOMPATIBLE"],
  ] as const)("F2 %s: written after the held refusal is stored; its explicit cancel reads the same outcome and writes nothing more",
    async (outcome, code) => {
      const w = world(); const { own, at } = journalOf(w); const c = w.make(); await c.refresh();
      w.server.resetPlans.push({ kind: "store", outcome });
      await c.reset();
      const x = id(sequence - 1);
      expect(own()).toEqual([{ ev: "c.reset", cmd: x, kind: "settings.reset", outcome, code }]);
      expect(at).toEqual([{ schemaVersion: 2, profileId: id(1), clientInstanceId: id(2), state: { refused: code },
        intent: { command_id: x, kind: "settings.reset", payload: { expected_reset_epoch: "1" } } }]);
      if (outcome === "rejected_invalid") {
        await c.cancelReset();
        expect(c.snapshot()).toMatchObject({ resetPending: null, resetOutcome: { status: "rejected", code } });
        expect(own()).toHaveLength(1);
      }
      c.dispose(); w.gate.dispose();
    });

  it("applied: one c.reset without a code, and no c.defect", async () => {
    const w = world(); const { own } = journalOf(w); const c = w.make(); await c.refresh();
    await c.reset();
    expect(own()).toEqual([{ ev: "c.reset", cmd: id(sequence - 1), kind: "settings.reset", outcome: "applied" }]);
    c.dispose(); w.gate.dispose();
  });

  it("a lost answer, then the status of X shows it applied: c.reset applied only once the status said so; nothing for the loss", async () => {
    const w = world(); const { own } = journalOf(w); const c = w.make(); await c.refresh();
    w.server.resetPlans.push({ kind: "apply_then_lose" }); w.server.statusFailures.push("network");
    await c.reset();
    expect(own()).toEqual([]);
    await c.refresh();
    expect(own()).toEqual([{ ev: "c.reset", cmd: id(sequence - 1), kind: "settings.reset", outcome: "applied" }]);
    c.dispose(); w.gate.dispose();
  });

  it("no event carries a setting, a value or the screen's text", async () => {
    const w = world(); const { own, journal } = journalOf(w); const c = w.make(); await c.refresh();
    w.server.resetPlans.push({ kind: "store", outcome: "rejected_invalid" });
    await c.reset();
    for (const event of own()) expect(Object.keys(event).sort()).toEqual(["cmd", "code", "ev", "kind", "outcome"]);
    const text = JSON.stringify(journal.pending().events);
    for (const marker of ["retry_count", "retry_gap", "strict_case", "expected_reset_epoch", "payload", "token", "proof"]) {
      expect(text).not.toContain(marker);
    }
    c.dispose(); w.gate.dispose();
  });
});

describe("M1, C479 R7, §8: c.defect of an answer to this very send of X that records no outcome of it", () => {
  const cases: Array<[string, () => Response, number, string | undefined]> = [
    ["T1 a bare 422 without an echo", bare(422, { error: { code: "VALIDATION_FAILED" } }), 422, "VALIDATION_FAILED"],
    ["T2 a bare 422 with a bad echo", bare(422, { error: { code: "VALIDATION_FAILED" } }, "not-a-uuid"), 422, "VALIDATION_FAILED"],
    ["T3 a bare 422 echoing another attempt's UUID", bare(422, { error: { code: "VALIDATION_FAILED" } }, id(777)), 422, "VALIDATION_FAILED"],
    ["a 422 with a body that is no JSON (read as no body)", bare(422, "<html>proxy</html>"), 422, undefined],
    ["a bare 409 CLIENT_INCOMPATIBLE", bare(409, { error: { code: "CLIENT_INCOMPATIBLE" } }, id(778)), 409, "CLIENT_INCOMPATIBLE"],
    ["an attributed answer whose code and status disagree (AC-59)", () => new Response(JSON.stringify({ error: { code: "RESET_EPOCH_STALE" } }),
      { status: 422 }), 422, "RESET_EPOCH_STALE"],
  ];
  it.each(cases)("%s: one c.defect with the attempt's own trace, then the same path as without a journal", async (_label, answer, status, code) => {
    const w = world(); const { own } = journalOf(w); const c = w.make(); await c.refresh();
    answerResetOnce(w.server, answer);
    await c.reset();
    const x = id(sequence - 2), cancel = id(sequence - 1);
    const [trace] = resetTraces(w.server);
    expect(trace).toMatch(/^[0-9a-f-]{36}$/);
    expect(own()).toEqual([
      { ev: "c.defect", cmd: x, trace, status, ...(code ? { code } : {}) },
      { ev: "c.reset", cmd: x, kind: "settings.reset_cancel", outcome: "cancelled" },
    ]);
    // R16-01 variant 1 as it is: the status of X by its ID, the canonical not_found, the client's own cancel of X.
    expect(w.server.log).toEqual([`POST settings.reset ${x}`, `GET ${x} include_refusal`, `POST settings.reset_cancel ${cancel} → ${x}`]);
    expect(JSON.stringify(own())).not.toContain("not-a-uuid");
    expect(JSON.stringify(own())).not.toContain(id(777));
    c.dispose(); w.gate.dispose();
  });

  it("T4 §8 п.5: a 422 whose body stalls past the client's deadline (http.ts, the unreadable refusal) — c.defect without a code", async () => {
    const w = world(); const { own } = journalOf(w); const c = w.make(); await c.refresh();
    answerResetOnce(w.server, () => new Response(new ReadableStream({ start() { /* never closes */ } }), { status: 422 }));
    await c.reset();
    const x = id(sequence - 2), cancel = id(sequence - 1);
    const [trace] = resetTraces(w.server);
    expect(own()).toEqual([
      { ev: "c.defect", cmd: x, trace, status: 422 },
      { ev: "c.reset", cmd: x, kind: "settings.reset_cancel", outcome: "cancelled" },
    ]);
    expect(w.server.log).toEqual([`POST settings.reset ${x}`, `GET ${x} include_refusal`, `POST settings.reset_cancel ${cancel} → ${x}`]);
    c.dispose(); w.gate.dispose();
  });

  it.each([
    ["an attributed F2 (P02R :471)", { kind: "store", outcome: "rejected_invalid" }],
    ["409 SESSION_BUSY", { kind: "unrecorded", status: 409, body: { error: { code: "SESSION_BUSY" } } }],
    ["a bare DOCUMENT_STALE of a live window", { kind: "unrecorded", status: 409, body: { error: { code: "DOCUMENT_STALE" } } }],
    ["a bare 413 page", { kind: "unrecorded", status: 413, body: { detail: "too large" } }],
    ["a broken connection", { kind: "network" }],
  ] as Array<[string, ResetPlan]>)("%s: no c.defect", async (_label, plan) => {
    const w = world(); const { own } = journalOf(w); const c = w.make(); await c.refresh();
    w.server.resetPlans.push(plan);
    await c.reset();
    expect(own().filter(event => event.ev === "c.defect")).toEqual([]);
    c.dispose(); w.gate.dispose();
  });

  const sentOf = (commandId: string, clientInstanceId = id(2), kind = "settings.reset"): SentRequest => Object.freeze({ method: "POST",
    route: "/commands", query: [], kind, commandId, clientInstanceId, documentId: id(3), proofSent: true, trace: id(900),
    deleteCommandId: null });
  it.each([
    ["the snapshot of this very send", (x: string) => sentOf(x), 1],
    ["a snapshot of another command", () => sentOf(id(999)), 0],
    ["a snapshot of X from another installation", (x: string) => sentOf(x, id(998)), 0],
    ["a snapshot of another kind", (x: string) => sentOf(x, id(2), "setting.save"), 0],
    ["no snapshot at all", null, 0],
  ] as const)("§8 п.3 guard — %s: %i c.defect", async (_label, sent, count) => {
    const w = world(core(), memory(), false, real => ({ ...real, reset: async (_t, _p, _profile, command) => {
      throw new ApiError("http", 422, "VALIDATION_FAILED", undefined,
        sent ? Object.freeze({ sent: sent(command.command_id), bareForbidden: false }) : undefined);
    } }));
    const { own } = journalOf(w); const c = w.make(); await c.refresh();
    await c.reset();
    const defects = own().filter(event => event.ev === "c.defect");
    expect(defects).toEqual(count ? [{ ev: "c.defect", cmd: id(sequence - 2), trace: id(900), status: 422, code: "VALIDATION_FAILED" }] : []);
    c.dispose(); w.gate.dispose();
  });
});
