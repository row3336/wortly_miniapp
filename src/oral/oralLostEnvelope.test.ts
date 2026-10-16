// Q27 (CON §6.1 п.5, project_pending_profile_slots.md ред.1.1 §3.1–§3.2, C467) in the oral quiz: the self-assessment of
// oral.grade is content — after Е02 its pointer, command_id and budget stay while its payload {correct} is gone. The
// document owner reads the status of the SAME command_id (without a fingerprint) — never a resend, never a new ID.
import { describe, expect, it, vi } from "vitest";
import type { OpenedClient, OralSessionProjection } from "../api/generated";
import { createOpenedAccess } from "../app/openedAccess";
import type { AsyncStorage } from "../platform/storage";
import { oralIntentHash, type OralIntent, type OralCommand } from "./oralIntent";
import { OralSessionPendingStore, OralStopPendingStore } from "./oralPending";
import { OralDocumentController } from "./oralDocumentController";
import { freshTestGate } from "../commands/testGate.test-support";
import { hasPending, seedRaw } from "../commands/pendingSeed.test-support";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const studyKey = "wortly.pending.oral_session";
type Step = "prefetched" | "presented" | "revealed" | "summary" | "closed";
function projection(step: Step = "revealed", session = id(3), assignment = id(6)): OralSessionProjection {
  const active = !["summary", "closed"].includes(step), revealed = step === "revealed";
  return { session_id: session, status: active ? "active" : step as "summary" | "closed", mode: "oral", pair: "ru-de",
    direction: "de-l1", local_date: "2026-10-01", bucket: "phrases", close_reason: step === "closed" ? "stop" : null,
    progress: { completed: active ? 0 : 1, total: 1, correct: active ? 0 : 1, wrong: 0 },
    assignment: active ? { id: assignment, card_id: id(7), status: step === "prefetched" ? "prefetched" : "presented",
      kind: "original", prompt: { text: "Haus", language: "de", conjunction_hint: null },
      ...(revealed ? { status: "presented", revealed: true, translations: ["дом"] } : { revealed: false }) } : null,
    summary: active ? null : { completed: 1, correct: 1, wrong: 0, ratio: { numerator: 1, denominator: 1 } },
    practice: { pair: "ru-de", direction: "de-l1", local_date: "2026-10-01", time_zone: "UTC", count: 0 },
    capabilities: { reveal_target: step === "presented" ? assignment : null, grade_target: revealed ? assignment : null,
      stop: step !== "closed", summary_home: step === "summary" } };
}
const profile = (state_version = "1"): OpenedClient["profile"] => ({ profile_id: id(50), role: "user", ui_language: "ru",
  dictionary_language: "ru", time_zone: "UTC", state_version, access: { status: "admitted", version: "1", reason: null } });
function fact(intent: OralIntent, status: "applied" | "already_applied" = "applied") {
  const grade = intent.kind === "oral.grade";
  return { id: intent.command_id, kind: intent.kind, status, applied_at: "2026-10-01T12:00:00Z",
    target_id: "assignment_id" in intent ? intent.assignment_id : intent.session_id,
    action_id: grade ? id(10) : null, result_id: grade ? id(11) : null, context_id: null, object_version: grade ? "1" : null };
}
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const grade = (correct: boolean): OralIntent => ({ session_id: id(3), command_id: id(4), kind: "oral.grade", assignment_id: id(6),
  payload: { correct } });

/** A document over a synthetic core that holds `recorded` (or not), with the record of `saved` whose payload Е02 deleted. */
function fixture(saved: OralIntent, recorded: boolean, mismatch = false) {
  const values = new Map<string, string>();
  seedRaw(values, studyKey, JSON.stringify({ schemaVersion: 1, profileId: id(50), clientInstanceId: id(1), pair: "ru-de", intent: saved,
    ...(mismatch ? { mismatch: true } : {}) }), id(50));
  const payloads = [...values.keys()].filter(name => name.startsWith("wortly.payload.oral_session:"));
  expect(payloads).toHaveLength(1); // the self-assessment ({correct}, false included) is content (C467)
  for (const name of payloads) values.delete(name); // Е02
  const storage: AsyncStorage = { get: vi.fn(async k => values.get(k) ?? null), set: vi.fn(async (k, v) => { values.set(k, v); }),
    remove: vi.fn(async k => { values.delete(k); }) };
  let current = projection("revealed"), stateVersion = "8";
  const access = createOpenedAccess({ opened: { status: "opened", client_instance_id: id(1), document_id: id(2), document_epoch: "1",
    proof_version: "1", profile: profile(), session: null, compatibility: { compatible: true, contract_version: "1" } },
    token: "synthetic-token", proof: "synthetic-proof", generation: 1, isLive: () => true, onDenied: () => {} });
  const posted: OralCommand[] = [], gets: string[] = [];
  const held = new Map<string, OralIntent>(recorded ? [[saved.command_id, saved]] : []);
  const fetcher = vi.fn<typeof fetch>(async (url, options) => {
    const path = new URL(String(url), "https://model.invalid");
    if (options?.method === "POST") {
      const command = JSON.parse(String(options.body)) as OralCommand; posted.push(command);
      const { client_instance_id: _client, document_id: _doc, ...intent } = command;
      held.set(command.command_id, intent); stateVersion = String(BigInt(stateVersion) + 1n);
      current = command.kind === "session.stop" ? projection("closed", command.session_id) : projection("summary", command.session_id);
      return response({ command: fact(intent), current, state_version: stateVersion });
    }
    gets.push(path.pathname + path.search);
    if (path.pathname.includes("/commands/")) {
      const commandId = path.pathname.split("/").at(-1)!, intent = held.get(commandId);
      if (!intent) return response({ command: { id: commandId, status: "not_found" }, current: profile(stateVersion), state_version: stateVersion,
        ...(current.status === "closed" ? { closed_session: { session_id: current.session_id, status: "closed", close_reason: "stop" } } : {}) });
      // As the core: without expected_intent_hash nothing is verified and none is claimed.
      const expected = path.searchParams.get("expected_intent_hash");
      if (expected !== null && expected !== await oralIntentHash(intent)) return response({ error: { code: "COMMAND_PAYLOAD_MISMATCH" } }, 409);
      return response({ command: fact(intent, "already_applied"), ...(expected === null ? {} : { verified_intent_hash: expected }),
        current: projection("summary"), state_version: stateVersion });
    }
    return response({ current: { ...current, session_id: path.pathname.split("/").at(-1) }, state_version: stateVersion });
  });
  const newId = vi.fn(() => id(100 + newId.mock.calls.length));
  const controller = new OralDocumentController({ access,
    transport: { fetcher, timeoutMs: 1000, maxResponseBytes: 100000, gate: freshTestGate() },
    studyStore: new OralSessionPendingStore(storage), stopStore: new OralStopPendingStore(storage), newId, initialSessionId: id(3),
    onUpdate: vi.fn() });
  const statusReads = (commandId: string) => gets.filter(url => url.includes(`/commands/${commandId}`));
  return { controller, values, posted, gets, newId, statusReads };
}

describe("Q27 oral: a lost self-assessment is read by its own ID only", () => {
  it.each([true, false])("recorded by the server (correct: %s): restored by its ID without a fingerprint; no POST, no new ID", async correct => {
    const f = fixture(grade(correct), true);
    await f.controller.refresh();
    const reads = f.statusReads(id(4));
    expect(reads.length).toBeGreaterThan(0); expect(reads.every(url => !url.includes("expected_intent_hash"))).toBe(true);
    expect(f.controller.snapshot().commands.study).toMatchObject({ pending: false, outcome: "accepted",
      resolved: { commandId: id(4), restored: true } });
    expect(f.posted).toEqual([]); expect(f.newId).not.toHaveBeenCalled();
    expect(hasPending(f.values, studyKey)).toBe(false);
  });

  it("never reached the server: not_found → unresolved, never resent; the voluntary Stop of the open session clears it", async () => {
    const f = fixture(grade(false), false);
    await f.controller.refresh();
    expect(f.controller.snapshot().commands.study).toMatchObject({ pending: true, outcome: null, problem: "lost_envelope",
      canRetry: false, pendingIntent: null, lost: { commandId: id(4), sessionOpen: true } });
    expect(f.posted).toEqual([]); expect(f.newId).not.toHaveBeenCalled();
    expect(f.controller.snapshot().canStop).toBe(true);
    await f.controller.stop("stop");
    expect(f.posted.map(post => post.kind)).toEqual(["session.stop"]);
    await f.controller.refresh();
    expect(f.posted.filter(post => post.kind === "oral.grade")).toEqual([]);
    expect(hasPending(f.values, studyKey)).toBe(false);
  });

  it("Я17: a lost self-assessment whose record carries the conflict mark is never read as this lane's fact", async () => {
    const f = fixture(grade(true), true, true);
    const kept = [...f.values];
    await f.controller.refresh();
    expect(f.statusReads(id(4))).toEqual([]);
    expect(f.controller.snapshot().commands.study).toMatchObject({ pending: true, outcome: null, problem: "mismatch", conflict: true });
    expect(f.posted).toEqual([]); expect(f.newId).not.toHaveBeenCalled();
    expect([...f.values]).toEqual(kept);
  });
});
