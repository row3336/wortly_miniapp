import { describe, expect, it, vi } from "vitest";
import type { OpenedClient, Profile } from "../api/generated";
import { createOpenedAccess, type OpenedAccess } from "../app/openedAccess";
import { WriteGate } from "../commands/writeGate";
import { ManualClock, settle } from "../commands/writeGate.test-support";
import type { AsyncStorage } from "../platform/storage";
import type { DocumentStaleSource } from "../api/http";
import { REPLACEMENT_PROOF_KINDS } from "../app/entryController";
import { createSettingsApi } from "./settingsApi";
import { SettingsController } from "./settingsController";
import { SettingsPendingStore } from "./settingsPending";
import { settingsResponse } from "./settingsRead.test-support";
import { settingsResetSlotOf, SettingsResetPendingStore } from "./settingsResetPending";

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
function world(server = core(), disk = memory(), junction = false) {
  const clock = new ManualClock();
  const gate = new WriteGate({ clock, probe: async () => ({ status: "ready" }) });
  // The window's side of the DOCUMENT_STALE junction (entryController.documentStale → replacementProved → replace): an
  // attributed 409 of the reset family closes the window at once (closedWindow), before the module reads the refusal.
  const stale: DocumentStaleSource[] = [];
  const onDocumentStale = (source: DocumentStaleSource) => {
    stale.push(source);
    if (source.method === "POST" && source.kind !== null && REPLACEMENT_PROOF_KINDS.has(source.kind) && source.attributed) gate.closeWindow();
  };
  const api = createSettingsApi({ fetcher: server.fetcher, timeoutMs: 1000, maxResponseBytes: 60000, gate,
    ...(junction ? { onDocumentStale } : {}) });
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
const unrecorded: Array<[string, ResetPlan]> = [
  ["a bare 422 (a proxy or a damaged request)", { kind: "unrecorded", status: 422, body: { error: { code: "VALIDATION_FAILED" } } }],
  ["a bare 413 page", { kind: "unrecorded", status: 413, body: { detail: "too large" } }],
  ["a bare 409 CLIENT_INCOMPATIBLE", { kind: "unrecorded", status: 409, body: { error: { code: "CLIENT_INCOMPATIBLE" } } }],
  ["an attributed answer whose code and status disagree", { kind: "unrecorded", status: 422,
    body: { command: { id: "X", status: "rejected" }, error: { code: "RESET_EPOCH_STALE" } } }],
  ["409 SESSION_BUSY", { kind: "unrecorded", status: 409, body: { error: { code: "SESSION_BUSY" } } }],
];

describe("К19-057: an answer without a recorded outcome of this very reset is no refusal (R16-01 variant 1)", () => {
  it.each(unrecorded)("%s: in the same window the status of X is read by its ID, the client cancels X and says «сброс не выполнен»", async (_label, plan) => {
    const w = world(); const c = w.make(); await c.refresh();
    w.server.resetPlans.push(plan);
    await c.reset();
    const x = id(sequence - 2), cancel = id(sequence - 1);
    expect(w.server.log).toEqual([`POST settings.reset ${x}`, `GET ${x} include_refusal`, `POST settings.reset_cancel ${cancel} → ${x}`]);
    expect(c.snapshot()).toMatchObject({ phase: "ready", resetPending: null, canEdit: true, canReset: true, canCancelReset: false,
      resetOutcome: { commandId: x, status: "rejected", code: "RESET_CANCELLED" }, problem: null });
    expect(w.record()).toBeNull();
    // X never applies after that: a late copy of it gets the tombstone's refusal (S2, S2a).
    expect(w.server.terminals.get(x)).toBe("cancelled");
    c.dispose(); w.gate.dispose();
  });

  it.each(unrecorded)("%s, the window closed before anything was noted: the next document goes the same way", async (_label, plan) => {
    const disk = memory(); const server = core();
    const first = world(server, disk); const c = first.make(); await c.refresh();
    server.resetPlans.push(plan); server.statusFailures.push("network");
    await c.reset();
    // The window is gone after the answer: here its first check of X was lost, so the record stays «sent».
    c.dispose(); first.gate.dispose();
    const x = id(sequence - 1);
    expect(first.record()).toEqual({ schemaVersion: 2, profileId: id(1), clientInstanceId: id(2),
      intent: { command_id: x, kind: "settings.reset", payload: { expected_reset_epoch: "1" } } });
    server.log.length = 0;
    const second = world(server, disk); second.open(id(4), 2); const d = second.make(); await d.refresh();
    expect(server.log).toEqual([`GET ${x} include_refusal`, `POST settings.reset_cancel ${id(sequence - 1)} → ${x}`]);
    expect(d.snapshot()).toMatchObject({ resetPending: null, canEdit: true, resetOutcome: { status: "rejected", code: "RESET_CANCELLED" } });
    d.dispose(); second.gate.dispose();
  });

  /** The next POST settings.reset gets a 409 DOCUMENT_STALE attributed to its very command_id (what the junction can prove). */
  function attributedStale(server: ReturnType<typeof core>, record?: Outcome) {
    const base = server.fetcher.getMockImplementation()!;
    let once = true;
    server.fetcher.mockImplementation(async (input, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (!once || body?.kind !== "settings.reset") return base(input, init);
      once = false;
      server.log.push(`POST ${body.kind} ${body.command_id}`);
      if (record) server.terminals.set(body.command_id, record);
      return new Response(JSON.stringify({ command: { id: body.command_id, status: "rejected" }, error: { code: "DOCUMENT_STALE" } }), { status: 409 });
    });
  }

  it.each([
    ["bare", { error: { code: "DOCUMENT_STALE" } }],
    ["attributed to another command", { command: { id: id(999), status: "rejected" }, error: { code: "DOCUMENT_STALE" } }],
  ])("C437 / R16-01: a %s DOCUMENT_STALE of a live window is no replacement: GET X, not_found → the own cancel of X, never X again", async (_label, body) => {
    const disk = memory(); const server = core();
    const w = world(server, disk, true); w.open(id(_label === "bare" ? 51 : 52)); const c = w.make(); await c.refresh();
    server.resetPlans.push({ kind: "unrecorded", status: 409, body });
    await c.reset();
    const x = id(sequence - 2), cancel = id(sequence - 1);
    expect(w.gate.snapshot().closedWindow).toBeNull();
    expect(w.stale[0]).toMatchObject({ attributed: false, kind: "settings.reset" });
    expect(server.log).toEqual([`POST settings.reset ${x}`, `GET ${x} include_refusal`, `POST settings.reset_cancel ${cancel} → ${x}`]);
    expect(c.snapshot()).toMatchObject({ resetPending: null, canEdit: true, problem: null,
      resetOutcome: { commandId: x, status: "rejected", code: "RESET_CANCELLED" } });
    expect(w.record()).toBeNull();
    c.dispose(); w.gate.dispose();
  });

  it("C437: a bare DOCUMENT_STALE while the core had stored F2 — GET X shows it, held until the button; no cancel by itself", async () => {
    const server = core(); const w = world(server, memory(), true); w.open(id(54)); const c = w.make(); await c.refresh();
    const base = server.fetcher.getMockImplementation()!;
    server.fetcher.mockImplementationOnce(async (_input, init) => { const body = JSON.parse(String(init!.body));
      server.log.push(`POST ${body.kind} ${body.command_id}`); server.terminals.set(body.command_id, "rejected_invalid");
      return new Response(JSON.stringify({ error: { code: "DOCUMENT_STALE" } }), { status: 409 }); });
    void base;
    await c.reset();
    const x = id(sequence - 1);
    expect(server.log).toEqual([`POST settings.reset ${x}`, `GET ${x} include_refusal`]);
    expect(c.snapshot()).toMatchObject({ canCancelReset: true, problem: { reason: "reset_refused", code: "VALIDATION_FAILED" } });
    await c.refresh(); await w.clock.advanceTo(60_000); await settle();
    expect(server.log.filter(line => line.includes("reset_cancel"))).toEqual([]);
    await c.cancelReset();
    expect(server.log.at(-1)).toBe(`POST settings.reset_cancel ${id(sequence - 1)} → ${x}`);
    expect(c.snapshot()).toMatchObject({ resetPending: null, resetOutcome: { status: "rejected", code: "VALIDATION_FAILED" } });
    c.dispose(); w.gate.dispose();
  });

  it("C437 / N3: a bare DOCUMENT_STALE while hidden reads X but sends no cancel; the return reads first and cancels once", async () => {
    const server = core(); const w = world(server, memory(), true); w.open(id(55)); const c = w.make(); await c.refresh();
    server.resetPlans.push({ kind: "unrecorded", status: 409, body: { error: { code: "DOCUMENT_STALE" } } });
    w.hide(); await c.reset();
    const x = id(sequence - 1);
    expect(server.log).toEqual([`POST settings.reset ${x}`, `GET ${x} include_refusal`]);
    w.show(); await vi.waitFor(() => expect(c.snapshot().resetPending).toBeNull());
    expect(server.log.slice(2)).toEqual([`GET ${x} include_refusal`, `POST settings.reset_cancel ${id(sequence - 1)} → ${x}`]);
    c.dispose(); w.gate.dispose();
  });

  it("I.11.4 :640, C376, C437: a DOCUMENT_STALE the junction proved closes the window — this document reads and sends nothing more of X, a new access of it revives nothing; a new document goes on", async () => {
    const disk = memory(); const server = core();
    const w = world(server, disk, true); w.open(id(56)); const c = w.make(); await c.refresh();
    attributedStale(server);
    await c.reset();
    const x = id(sequence - 1);
    const sent = { schemaVersion: 2, profileId: id(1), clientInstanceId: id(2),
      intent: { command_id: x, kind: "settings.reset", payload: { expected_reset_epoch: "1" } } };
    expect(w.gate.snapshot().closedWindow).not.toBeNull();
    expect(w.stale[0]).toMatchObject({ attributed: true, kind: "settings.reset", commandId: x });
    expect(server.log).toEqual([`POST settings.reset ${x}`]);
    expect(w.record()).toEqual(sent);
    expect(c.snapshot()).toMatchObject({ problem: { reason: "context_closed", code: "DOCUMENT_STALE" }, canEdit: false, canCancelReset: false });
    await c.refresh(); await w.clock.advanceTo(60_000); w.show(); await settle();
    // C376: a new access object of the same document (an ordinary foreground) lifts nothing.
    w.open(id(56), 1); await c.refresh(); w.hide(); w.show(); await w.clock.advanceTo(120_000); await settle();
    await c.refresh();
    expect(server.log).toEqual([`POST settings.reset ${x}`]); expect(w.record()).toEqual(sent);
    c.dispose(); w.gate.dispose();
    const next = world(server, disk); next.open(id(7), 5); const d = next.make(); await d.refresh();
    expect(server.log).toEqual([`POST settings.reset ${x}`, `GET ${x} include_refusal`, `POST settings.reset_cancel ${id(sequence - 1)} → ${x}`]);
    expect(d.snapshot()).toMatchObject({ resetPending: null, resetOutcome: { status: "rejected", code: "RESET_CANCELLED" } });
    d.dispose(); next.gate.dispose();
  });

  it.each(["rejected_stale_epoch", "cancelled"] as const)("I.11.3a: F1 %s — «отказан» stays with the profile; the next document neither sends, cancels nor reads X", async outcome => {
    const disk = memory(); const server = core();
    const w = world(server, disk); const c = w.make(); await c.refresh();
    server.resetPlans.push({ kind: "store", outcome });
    await c.reset();
    const x = id(sequence - 1), code = answers[outcome][0];
    expect(server.log).toEqual([`POST settings.reset ${x}`]);
    expect(w.record()).toEqual({ schemaVersion: 2, profileId: id(1), clientInstanceId: id(2), final: { command_id: x, code } });
    expect(c.snapshot()).toMatchObject({ canEdit: true, canReset: true, resetOutcome: { status: "rejected", code, final: true } });
    c.dispose(); w.gate.dispose(); server.log.length = 0;
    const next = world(server, disk); next.open(id(8), 6); const d = next.make(); await d.refresh();
    expect(server.log).toEqual([]);
    expect(d.snapshot()).toMatchObject({ canEdit: true, canReset: true, resetPending: null });
    expect(next.record()).toMatchObject({ final: { command_id: x } });
    d.dispose(); next.gate.dispose();
  });

  it("a lost answer to an X the core applied: the status by ID says so, nothing is cancelled", async () => {
    const w = world(); const c = w.make(); await c.refresh();
    w.server.resetPlans.push({ kind: "apply_then_lose" });
    await c.reset();
    const x = id(sequence - 1);
    expect(w.server.log).toEqual([`POST settings.reset ${x}`, `GET ${x} include_refusal`]);
    expect(c.snapshot()).toMatchObject({ resetPending: null, resetOutcome: { status: "accepted" }, data: { settings: { retry_count: { value: 4 } } } });
    c.dispose(); w.gate.dispose();
  });

  it("R16-01 «при любом варианте»: the core stored F2 but the answer was lost — the status shows the refusal, held until the button", async () => {
    const w = world(); const c = w.make(); await c.refresh();
    w.server.resetPlans.push({ kind: "store_then_lose", outcome: "rejected_invalid" });
    await c.reset();
    const x = id(sequence - 1);
    expect(w.server.log).toEqual([`POST settings.reset ${x}`, `GET ${x} include_refusal`]);
    expect(c.snapshot()).toMatchObject({ phase: "unresolved", canEdit: false, problem: { reason: "reset_refused", code: "VALIDATION_FAILED" } });
    expect(w.record()).toMatchObject({ state: { refused: "VALIDATION_FAILED" } });
    // The lost answer closed `net`: the button waits for the gate (I9). Nothing goes by itself: the gate's changes and a
    // refresh only read.
    expect(c.snapshot().canCancelReset).toBe(false);
    await w.clock.advanceTo(60_000); await settle(); await c.refresh();
    expect(w.server.log.filter(line => line.startsWith("POST"))).toHaveLength(1);
    expect(c.snapshot()).toMatchObject({ canCancelReset: true, problem: { reason: "reset_refused" } });
    await c.cancelReset();
    expect(w.server.log.at(-1)).toBe(`POST settings.reset_cancel ${id(sequence - 1)} → ${x}`);
    expect(c.snapshot()).toMatchObject({ resetPending: null, canEdit: true, resetOutcome: { status: "rejected", code: "VALIDATION_FAILED" } });
    c.dispose(); w.gate.dispose();
  });

  it("I.11.3c: an attributed F2 from the core is held at once without a status read; R8-06: the next document reads it by ID", async () => {
    const disk = memory(); const server = core();
    const w = world(server, disk); const c = w.make(); await c.refresh();
    server.resetPlans.push({ kind: "store", outcome: "rejected_invalid" });
    await c.reset();
    const x = id(sequence - 1);
    expect(server.log).toEqual([`POST settings.reset ${x}`]);
    expect(c.snapshot()).toMatchObject({ canCancelReset: true, problem: { reason: "reset_refused" } });
    c.dispose(); w.gate.dispose(); server.log.length = 0;
    const again = world(server, disk); again.open(id(5), 3); const d = again.make(); await d.refresh();
    expect(server.log).toEqual([`GET ${x} include_refusal`]);
    expect(d.snapshot()).toMatchObject({ canCancelReset: true, canEdit: false, problem: { reason: "reset_refused" } });
    d.dispose(); again.gate.dispose();
  });

  it.each([
    ["no answer", "network" as const], ["a 503", { status: 503, body: { error: { code: "MAINTENANCE" } } }],
    ["a 200 whose not_found names another ID", { status: 200, body: { command: { id: id(999), status: "not_found" }, current: profile(), state_version: "1" } }],
    ["a 200 without a profile", { status: 200, body: { command: { id: "SELF", status: "not_found" }, state_version: "1" } }],
  ])("C362: a status read of X that is no canonical not_found (%s) stores and sends no cancel", async (_label, failure) => {
    const w = world(); const c = w.make(); await c.refresh();
    w.server.resetPlans.push({ kind: "unrecorded", status: 422, body: { error: { code: "VALIDATION_FAILED" } } });
    w.server.statusFailures.push(failure);
    await c.reset();
    const x = id(sequence - 1);
    expect(w.server.log).toEqual([`POST settings.reset ${x}`, `GET ${x} include_refusal`]);
    expect(w.record()).toEqual({ schemaVersion: 2, profileId: id(1), clientInstanceId: id(2),
      intent: { command_id: x, kind: "settings.reset", payload: { expected_reset_epoch: "1" } } });
    expect(c.snapshot()).toMatchObject({ canEdit: false, canReset: false, canCancelReset: false, canRetry: false, resetOutcome: null });
    c.dispose(); w.gate.dispose();
  });

  it("P03: no answer closes `net`; the status is read at once, the cancel waits for `ready`, then the client takes it up by itself", async () => {
    const w = world(); const c = w.make(); await c.refresh();
    w.server.resetPlans.push({ kind: "network" });
    await c.reset();
    const x = id(sequence - 1);
    expect(w.gate.snapshot().net).toEqual({ kind: "closed", cause: "unknown" });
    expect(w.server.log).toEqual([`POST settings.reset ${x}`, `GET ${x} include_refusal`]);
    expect(w.record()).toMatchObject({ intent: { command_id: x } }); expect(w.record().state).toBeUndefined();
    expect(c.snapshot()).toMatchObject({ problem: { reason: "paused" }, canEdit: false });
    // The series of probes: `ready` after 5 s opens the gate; one readback, then the cancel (I5).
    await w.clock.advanceTo(5_000); await vi.waitFor(() => expect(c.snapshot().resetPending).toBeNull());
    expect(w.server.log).toEqual([`POST settings.reset ${x}`, `GET ${x} include_refusal`, `GET ${x} include_refusal`,
      `POST settings.reset_cancel ${id(sequence - 1)} → ${x}`]);
    expect(c.snapshot()).toMatchObject({ canEdit: true, resetOutcome: { status: "rejected", code: "RESET_CANCELLED" } });
    // Nothing more by itself afterwards.
    await w.clock.advanceTo(120_000); await settle();
    expect(w.server.log).toHaveLength(4);
    c.dispose(); w.gate.dispose();
  });

  it("a lost cancel is checked by its ID and only then sent again with the same ID (P03 I9); it is never a new reset", async () => {
    const w = world(); const c = w.make(); await c.refresh();
    w.server.resetPlans.push({ kind: "unrecorded", status: 422, body: { error: { code: "VALIDATION_FAILED" } } });
    w.server.failCancel();
    await c.reset();
    const x = id(sequence - 2), cancel = id(sequence - 1);
    expect(w.record()).toMatchObject({ state: { cancel, explicit: false } });
    await w.clock.advanceTo(5_000); await vi.waitFor(() => expect(c.snapshot().resetPending).toBeNull());
    expect(w.server.log).toEqual([`POST settings.reset ${x}`, `GET ${x} include_refusal`, `POST settings.reset_cancel ${cancel} → ${x}`,
      `GET ${cancel}`, `POST settings.reset_cancel ${cancel} → ${x}`]);
    expect(c.snapshot()).toMatchObject({ resetOutcome: { status: "rejected", code: "RESET_CANCELLED" } });
    c.dispose(); w.gate.dispose();
  });

  it("C362 (3): after the window closed for good nothing more is read or sent from it; the record waits for the next document", async () => {
    const w = world(); w.open(id(53)); const c = w.make(); await c.refresh();
    w.server.resetPlans.push({ kind: "unrecorded", status: 409, body: { error: { code: "DOCUMENT_STALE" } } });
    w.server.fetcher.mockImplementationOnce(async () => { w.gate.closeWindow(); return new Response(JSON.stringify({ error: { code: "DOCUMENT_STALE" } }), { status: 409 }); });
    await c.reset();
    expect(w.server.log).toEqual([]);
    expect(w.record()).toMatchObject({ intent: { kind: "settings.reset" } });
    await c.refresh(); await w.clock.advanceTo(60_000); await settle();
    expect(w.server.fetcher).toHaveBeenCalledTimes(2);
    c.dispose(); w.gate.dispose();
  });

  describe("C365 N3: the client's own cancel leaves only from a shown page", () => {
    const bare422: ResetPlan = { kind: "unrecorded", status: 422, body: { error: { code: "VALIDATION_FAILED" } } };

    it("hidden before the cancel: X is read, nothing is stored or sent; on the return it reads X again and cancels once", async () => {
      const w = world(); const c = w.make(); await c.refresh();
      w.server.resetPlans.push(bare422); w.hide();
      await c.reset();
      const x = id(sequence - 1);
      expect(w.server.log).toEqual([`POST settings.reset ${x}`, `GET ${x} include_refusal`]);
      expect(w.record().state).toBeUndefined();
      // Nothing by itself while hidden, whatever the gate does.
      await w.clock.advanceTo(60_000); await settle(); expect(w.server.log).toHaveLength(2);
      w.show(); await vi.waitFor(() => expect(c.snapshot().resetPending).toBeNull());
      expect(w.server.log).toEqual([`POST settings.reset ${x}`, `GET ${x} include_refusal`, `GET ${x} include_refusal`,
        `POST settings.reset_cancel ${id(sequence - 1)} → ${x}`]);
      w.show(); await settle(); expect(w.server.log).toHaveLength(4);
      c.dispose(); w.gate.dispose();
    });

    it("hidden on the await between storing the cancel and its fetch: on the return C is checked, then sent with the same ID", async () => {
      const w = world(); const c = w.make(); await c.refresh();
      w.server.resetPlans.push(bare422);
      const set = w.disk.storage.set;
      w.disk.storage.set = async (key, value) => { await set(key, value); if (value.includes('"cancel"')) w.hide(); };
      await c.reset();
      const x = id(sequence - 2), cancel = id(sequence - 1);
      expect(w.record()).toMatchObject({ state: { cancel, explicit: false } });
      expect(w.server.log).toEqual([`POST settings.reset ${x}`, `GET ${x} include_refusal`]);
      w.show(); await vi.waitFor(() => expect(c.snapshot().resetPending).toBeNull());
      expect(w.server.log).toEqual([`POST settings.reset ${x}`, `GET ${x} include_refusal`, `GET ${cancel}`,
        `POST settings.reset_cancel ${cancel} → ${x}`]);
      expect(c.snapshot()).toMatchObject({ resetOutcome: { status: "rejected", code: "RESET_CANCELLED" } });
      c.dispose(); w.gate.dispose();
    });

    it("`ready` while hidden resumes nothing; the return reads first and sends only the cancel, once", async () => {
      const w = world(); const c = w.make(); await c.refresh();
      w.server.resetPlans.push({ kind: "network" });
      await c.reset();
      const x = id(sequence - 1);
      w.hide(); await w.clock.advanceTo(5_000); await settle();
      expect(w.gate.snapshot().net).toEqual({ kind: "open" });
      expect(w.server.log).toEqual([`POST settings.reset ${x}`, `GET ${x} include_refusal`]);
      w.show(); await vi.waitFor(() => expect(c.snapshot().resetPending).toBeNull());
      expect(w.server.log.slice(2)).toEqual([`GET ${x} include_refusal`, `POST settings.reset_cancel ${id(sequence - 1)} → ${x}`]);
      c.dispose(); w.gate.dispose();
    });

    it("a stored cancel loaded by a hidden document is read, not sent; the return sends it with its ID", async () => {
      const disk = memory(); const server = core();
      const first = world(server, disk); const c = first.make(); await c.refresh();
      server.resetPlans.push(bare422); server.failCancel();
      await c.reset(); c.dispose(); first.gate.dispose();
      const x = id(sequence - 2), cancel = id(sequence - 1); server.log.length = 0;
      const second = world(server, disk); second.open(id(6), 4); second.hide(); const d = second.make(); await d.refresh();
      expect(server.log).toEqual([`GET ${cancel}`]);
      second.show(); await vi.waitFor(() => expect(d.snapshot().resetPending).toBeNull());
      expect(server.log).toEqual([`GET ${cancel}`, `GET ${cancel}`, `POST settings.reset_cancel ${cancel} → ${x}`]);
      d.dispose(); second.gate.dispose();
    });

    it("dispose or a closed window after a hidden stop: the return resumes nothing", async () => {
      for (const end of ["dispose", "closeWindow"] as const) {
        const w = world(); const c = w.make(); await c.refresh();
        w.server.resetPlans.push(bare422); w.hide();
        await c.reset();
        if (end === "dispose") c.dispose(); else w.gate.closeWindow();
        w.show(); await w.clock.advanceTo(60_000); await settle();
        expect(w.server.log).toHaveLength(2);
        expect(w.record()).toMatchObject({ intent: { kind: "settings.reset" } }); expect(w.record().state).toBeUndefined();
        c.dispose(); w.gate.dispose();
      }
    });

    it("the user's own «Отменить прежний сброс» is no automatic send: one press, one request", async () => {
      const w = world(); const c = w.make(); await c.refresh();
      w.server.resetPlans.push({ kind: "store", outcome: "rejected_invalid" });
      await c.reset();
      await c.cancelReset(); await c.cancelReset();
      expect(w.server.log.filter(line => line.includes("reset_cancel"))).toHaveLength(1);
      c.dispose(); w.gate.dispose();
    });
  });

  describe("the DOCUMENT_STALE junction of HEAD (8a7b7a5): one closer, the settings side adds its own silence", () => {
    it.each([["POST X", "reset"], ["the own cancel C", "cancel"]] as const)(
      "an attributed 409 on %s closes the window at once; nothing more of X is read or sent, the record as it is", async (_label, where) => {
        const disk = memory(); const server = core();
        const w = world(server, disk, true); w.open(id(where === "reset" ? 61 : 62)); const c = w.make(); await c.refresh();
        if (where === "reset") {
          server.fetcher.mockImplementationOnce(async (_input, init) => { const body = JSON.parse(String(init!.body));
            server.log.push(`POST ${body.kind} ${body.command_id}`);
            return new Response(JSON.stringify({ command: { id: body.command_id, status: "rejected" }, error: { code: "DOCUMENT_STALE" },
              ...{ current: (({ state_version: _v, ...rest }) => rest)(server.data), state_version: server.data.state_version } }), { status: 409 }); });
        } else {
          server.resetPlans.push({ kind: "unrecorded", status: 422, body: { error: { code: "VALIDATION_FAILED" } } });
          const base = server.fetcher.getMockImplementation()!;
          server.fetcher.mockImplementation(async (input, init) => {
            const body = init?.body ? JSON.parse(String(init.body)) : null;
            if (body?.kind !== "settings.reset_cancel") return base(input, init);
            server.log.push(`POST ${body.kind} ${body.command_id}`);
            return new Response(JSON.stringify({ command: { id: body.command_id, status: "rejected" }, error: { code: "DOCUMENT_STALE" } }),
              { status: 409 });
          });
        }
        await c.reset();
        expect(w.gate.snapshot().closedWindow).not.toBeNull();
        expect(w.stale).toHaveLength(1); expect(w.stale[0]).toMatchObject({ attributed: true,
          kind: where === "reset" ? "settings.reset" : "settings.reset_cancel" });
        const log = [...server.log], kept = w.record();
        expect(log.filter(line => line.startsWith("POST"))).toHaveLength(where === "reset" ? 1 : 2);
        expect(c.snapshot()).toMatchObject({ problem: { reason: "context_closed", code: "DOCUMENT_STALE" }, canEdit: false, canCancelReset: false });
        await c.refresh(); w.hide(); w.show(); await w.clock.advanceTo(60_000); await settle(); await c.cancelReset();
        expect(server.log).toEqual(log); expect(w.record()).toEqual(kept);
        c.dispose(); w.gate.dispose();
      });

    it("a bare 409 (no attribution) does not close the window; the settings take the route of an unknown outcome (C437)", async () => {
      const w = world(core(), memory(), true); w.open(id(63)); const c = w.make(); await c.refresh();
      w.server.resetPlans.push({ kind: "unrecorded", status: 409, body: { error: { code: "DOCUMENT_STALE" } } });
      await c.reset();
      expect(w.gate.snapshot().closedWindow).toBeNull();
      expect(w.stale[0]).toMatchObject({ attributed: false, kind: "settings.reset" });
      const x = id(sequence - 2);
      expect(w.server.log).toEqual([`POST settings.reset ${x}`, `GET ${x} include_refusal`, `POST settings.reset_cancel ${id(sequence - 1)} → ${x}`]);
      expect(c.snapshot().problem).toBeNull();
      c.dispose(); w.gate.dispose();
    });
  });
});
