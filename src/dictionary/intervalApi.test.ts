import { withTrace } from "../api/traceHeader.test-support";
import { describe, expect, it, vi } from "vitest";
import type { DictionaryCardView, OpenDictionaryContext } from "../api/generated";
import { ApiError, clientContractVersion } from "../api/http";
import { recordedOralUnknownClosed } from "../api/realCoreStatusRecordings.test-support";
import {
  commandOutcomeUnknown, createDictionaryIntervalApi, dictionaryIncreaseIntent, dictionaryIntervalIntentHash,
  dictionaryUndoIntent, dictionaryUndoOfferIntent, validDictionaryContextCurrent, type DictionaryIntervalCommand,
  type DictionaryIntervalIntent,
} from "./intervalApi";

// Wire forms follow core api/models.py (Dictionary*Context*, *CommandFact), coordinator._fact and
// dictionary_interval.context_projection. Literal steps: CORE_HANDOFF_CP2 §5 (D = 2026-09-29).
// Core C-INTV: only the written L1->De of a word has an interval state and an increase.
const cardId = "a0000000-0000-4000-8000-000000000001";
const otherCardId = "a0000000-0000-4000-8000-000000000009";
const contextId = "c0000000-0000-4000-8000-000000000002";
const otherContextId = "c0000000-0000-4000-8000-000000000008";
const actionId = "d0000000-0000-4000-8000-000000000003";
const commandId = "e0000000-0000-4000-8000-000000000004";
const clientId = "b0000000-0000-4000-8000-00000000000a";
const documentId = "b0000000-0000-4000-8000-00000000000b";
const profileId = "f0000000-0000-4000-8000-000000000005";
const token = "synthetic-token";
const proof = "synthetic-proof";
const today = "2026-09-29";
const largeVersion = "9007199254740993";
const stateVersion = "9223372036854775807";
const appliedAt = "2026-09-29T12:00:00Z";

// l1-de I10/R2/E2.5 from D: table O, options 1..8.
const ladder: Array<[number, number, string]> = [
  [1, 15, "2026-10-14"], [2, 23, "2026-10-22"], [3, 36, "2026-11-04"], [4, 58, "2026-11-26"],
  [5, 94, "2027-01-01"], [6, 155, "2027-03-03"], [7, 259, "2027-06-15"], [8, 438, "2027-12-11"],
];
// l1-de without a row (ILC A01): first steps 2→3, 3→5, 4→8; the tail is omitted, the client checks arithmetic only.
const initial: Array<[number, number, string]> = [[2, 3, "2026-10-02"], [3, 5, "2026-10-04"], [4, 8, "2026-10-07"]];
const choices = (steps: Array<[number, number, string]>) =>
  steps.map(([option_id, interval_days, next_due_date]) => ({ option_id, interval_days, next_due_date }));

function view(): DictionaryCardView {
  return {
    status: "available",
    content: {
      pair: "uk-de", card: { id: cardId, revision: "5", lemma: "Haus", type: "noun", cefr: "A1" },
      translations: { common: ["будинок"], personal: null }, grammar: null,
      reference_conjugations: [], examples: { common: [], personal: null }, association: null, field_versions: { translation: "1", example: "1", association: "1" },
    },
    study: {
      status: "available", card_id: cardId, card_revision: "5", pair: "uk-de", card_type: "noun", local_date: today,
      facts: {
        common_translation_present: true, exclusion: { excluded: false, version: null },
        manual: { selected: false, selection_version: "1" },
        learning: { ever_selected: true, finished_or_skipped: true, current: null }, non_learning_history: false,
      },
      directions: [
        { direction: "l1-de", introduced: true, progress_present: true, progress_version: largeVersion,
          schedule: { interval_days: 10, next_due_date: "2026-10-05" },
          interval_preview: ladder.map(([step_id, interval_days, next_due_date]) => ({ step_id, interval_days, next_due_date })) },
        { direction: "de-l1", introduced: true, progress_present: false, progress_version: null,
          schedule: null, interval_preview: null },
      ],
    },
    card_actions: { exclude: true, return: false, relearn: true },
  };
}

function open(): OpenDictionaryContext {
  return {
    status: "open", context: { id: contextId, kind: "dictionary", card_id: cardId }, view: view(),
    interval: {
      local_date: today, expected_pair: "uk-de", direction: "l1-de", applicable: true,
      current_schedule: { interval_days: 10, next_due_date: "2026-10-05", persisted: true },
      expected_progress_version: largeVersion, options: choices(ladder), default_option_id: 5,
    },
    capabilities: { interval_increase: { direction: "l1-de" }, undo_offer: null, undo_target: null },
  };
}

/** The live undo offer of actionId in this context (core C-INTV-OFFER, CT 2.1.2). */
function undoOffer(status: "pending" | "offered", offerVersion = status === "pending" ? "1" : "2") {
  return { action_id: actionId, context_id: contextId, status, version: offerVersion };
}

/** The written direction without a saved row (ILC A01): due today, null version. */
function initialOpen(): OpenDictionaryContext {
  const value = open();
  Object.assign((value.view as DictionaryCardView).study.directions[0], { progress_present: false, progress_version: null,
    schedule: null, interval_preview: null });
  Object.assign(value.interval!, { current_schedule: { interval_days: 1, next_due_date: today, persisted: false },
    expected_progress_version: null, options: choices(initial), default_option_id: 4 });
  return value;
}

/**
 * After l1-de option 2 from A01 (bridge A30): a saved row I3, version "1". The increase reply carries a
 * pending offer; once action.undo_offer.open is confirmed it is offered with undo of this action.
 */
function afterInitialIncrease(undoVersion = "1", offer: "pending" | "offered" = "offered"): OpenDictionaryContext {
  const value = open();
  const study = (value.view as DictionaryCardView).study;
  const steps: Array<[number, number, string]> = [[1, 5, "2026-10-04"], [2, 8, "2026-10-07"]];
  Object.assign(study.directions[0], { progress_present: true, progress_version: "1",
    schedule: { interval_days: 3, next_due_date: "2026-10-02" },
    interval_preview: steps.map(([step_id, interval_days, next_due_date]) => ({ step_id, interval_days, next_due_date })) });
  Object.assign(value.interval!, { expected_progress_version: "1",
    current_schedule: { interval_days: 3, next_due_date: "2026-10-02", persisted: true },
    options: choices(steps), default_option_id: 2 });
  value.capabilities.undo_offer = undoOffer(offer);
  value.capabilities.undo_target = offer === "pending" ? null
    : { action_id: actionId, kind: "interval.increase", version: undoVersion, context_id: contextId };
  return value;
}

/** At the top step: no options, no default and no operation (K07-063). */
function atTopStep(): OpenDictionaryContext {
  const value = open();
  (value.view as DictionaryCardView).study.directions[0].interval_preview = [];
  Object.assign(value.interval!, { options: [], default_option_id: null });
  value.capabilities.interval_increase = null;
  return value;
}

function fact(kind: string, fields: Record<string, unknown> = {}) {
  return { id: commandId, kind, status: "applied", applied_at: appliedAt, target_id: cardId, action_id: null,
    result_id: null, context_id: contextId, object_version: null, ...fields };
}
function reply(command: unknown, current: unknown, extra: Record<string, unknown> = {}) {
  return { command, current, state_version: stateVersion, ...extra };
}
function rejected(code: string, current: unknown) {
  return reply({ id: commandId, status: "rejected" }, current, { error: { code } });
}
function profile() {
  return { profile_id: profileId, access: { status: "admitted", version: "1", reason: null }, role: "user",
    ui_language: "uk", dictionary_language: "uk", time_zone: "Europe/Kyiv", state_version: stateVersion };
}

type Planned = { status: number; body?: unknown; raw?: string } | Error;
function transport(...replies: Planned[]) {
  const queue = [...replies];
  const fetcher = vi.fn<typeof fetch>(async () => {
    const next = queue.shift();
    if (next === undefined) throw new Error("unexpected request");
    if (next instanceof Error) throw next;
    return new Response(next.raw ?? JSON.stringify(next.body), { status: next.status });
  });
  return { fetcher, api: createDictionaryIntervalApi({ fetcher, timeoutMs: 1000, maxResponseBytes: 1_000_000 }) };
}
function sent(fetcher: ReturnType<typeof transport>["fetcher"], index = 0) {
  const [url, init] = fetcher.mock.calls[index];
  const text = init?.body as string | undefined;
  return { url: String(url), init: init!, text, body: text === undefined ? undefined : JSON.parse(text) };
}
function command<T extends DictionaryIntervalIntent>(intent: T): DictionaryIntervalCommand<T> {
  return { ...intent, client_instance_id: clientId, document_id: documentId };
}
async function sha256(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
async function failure(promise: Promise<unknown>): Promise<unknown> {
  try { await promise; } catch (error) { return error; }
  throw new Error("expected a failure");
}

const openIntent = { kind: "context.open", command_id: commandId, card_id: cardId } as const;
const closeIntent = { kind: "context.close", command_id: commandId, context_id: contextId, card_id: cardId } as const;

describe("dictionary context commands over the real JSON transport", () => {
  it("opens one context with the exact wire body, detached before the request", async () => {
    const { api, fetcher } = transport({ status: 200, body: reply(fact("context.open"), open()) });
    const original = command({ ...openIntent });
    const pending = api.openContext(token, proof, original);
    (original as { card_id: string }).card_id = otherCardId;
    const result = await pending;
    expect(result).toMatchObject({ outcome: "accepted", state_version: stateVersion, current: { status: "open" } });
    expect(fetcher).toHaveBeenCalledOnce();
    const { url, init, body } = sent(fetcher);
    expect(url).toBe("/api/v1/commands");
    expect(init).toMatchObject({ method: "POST", cache: "no-store", credentials: "same-origin" });
    expect(init.headers).toEqual(withTrace({ Authorization: `Bearer ${token}`, "X-Origin-Proof": proof, "Content-Type": "application/json",
      "X-Wortly-Contract-Version": clientContractVersion() }));
    expect(body).toEqual({ command_id: commandId, kind: "context.open", client_instance_id: clientId,
      document_id: documentId, payload: { card_id: cardId, source: { kind: "dictionary" } } });
  });

  it("binds a new context to its fact and accepts an opaque unavailable replay", async () => {
    const replay = fact("context.open", { status: "already_applied" });
    const { api } = transport(
      { status: 200, body: reply(fact("context.open", { context_id: otherContextId }), open()) },
      { status: 200, body: reply(replay, { status: "unavailable" }) },
    );
    await expect(api.openContext(token, proof, command(openIntent))).rejects.toMatchObject({ kind: "invalid_response" });
    expect(await api.openContext(token, proof, command(openIntent)))
      .toMatchObject({ outcome: "accepted", command: replay, current: { status: "unavailable" } });
  });

  it("closes without reopening the closed ID", async () => {
    const closed = { status: "closed", context: { id: contextId, kind: "dictionary", card_id: cardId } };
    const { api, fetcher } = transport(
      { status: 200, body: reply(fact("context.close"), closed) },
      { status: 200, body: reply(fact("context.close"), open()) },
    );
    expect(await api.closeContext(token, proof, command(closeIntent))).toMatchObject({ outcome: "accepted", current: closed });
    expect(sent(fetcher).body).toEqual({ command_id: commandId, kind: "context.close", client_instance_id: clientId,
      document_id: documentId, context_id: contextId, payload: {} });
    const error = await failure(api.closeContext(token, proof, command(closeIntent)));
    expect(error).toMatchObject({ kind: "invalid_response" });
    expect(commandOutcomeUnknown(error)).toBe(true);
  });

  it("increases the A01 written direction with a null version and accepts the saved row as version 1 (B9)", async () => {
    const intent = dictionaryIncreaseIntent(initialOpen(), commandId, { option_id: 2 });
    const accepted = fact("interval.increase", { action_id: actionId, object_version: "1" });
    const { api, fetcher } = transport({ status: 200, body: reply(accepted, afterInitialIncrease("1", "pending")) });
    const result = await api.increase(token, proof, command(intent));
    expect(sent(fetcher).body).toEqual({
      command_id: commandId, kind: "interval.increase", client_instance_id: clientId, document_id: documentId,
      context_id: contextId, expected_progress_version: null,
      payload: { card_id: cardId, expected_pair: "uk-de", expected_local_date: today,
        direction: "l1-de", option_id: 2, interval_days: 3, next_due_date: "2026-10-02" },
    });
    expect(result).toMatchObject({ outcome: "accepted", command: accepted });
    if (result.current.status !== "open") throw new Error("open context expected");
    expect(result.current.interval).toMatchObject({ direction: "l1-de", expected_progress_version: "1", default_option_id: 2,
      current_schedule: { interval_days: 3, next_due_date: "2026-10-02", persisted: true } });
    // CT 2.1.2 p.1: the reply names the pending offer; there is no undo until it is opened.
    expect(result.current.capabilities.undo_offer).toEqual(undoOffer("pending"));
    expect(result.current.capabilities.undo_target).toBeNull();
  });

  it("keeps an int64 progress version as an exact string (B10)", async () => {
    const intent = dictionaryIncreaseIntent(open(), commandId, { option_id: 1 });
    const { api, fetcher } = transport({ status: 409, body: rejected("VERSION_CONFLICT", open()) });
    const result = await api.increase(token, proof, command(intent));
    expect(result).toMatchObject({ outcome: "rejected", error: { code: "VERSION_CONFLICT" }, command: { id: commandId, status: "rejected" } });
    const { text, body } = sent(fetcher);
    expect(text).toContain(`"expected_progress_version":"${largeVersion}"`);
    expect(body.payload).toEqual({ card_id: cardId, expected_pair: "uk-de", expected_local_date: today,
      direction: "l1-de", option_id: 1, interval_days: 15, next_due_date: "2026-10-14" });
  });

  it("undoes the offered target and checks the next action version with BigInt", async () => {
    const current = afterInitialIncrease(largeVersion);
    const intent = dictionaryUndoIntent(current, commandId);
    const undone = open();
    const exact = fact("action.undo", { action_id: actionId, object_version: "9007199254740994" });
    const rounded = fact("action.undo", { action_id: actionId, object_version: "9007199254740992" });
    const { api, fetcher } = transport(
      { status: 200, body: reply(exact, undone) },
      { status: 200, body: reply(rounded, undone) },
    );
    expect(await api.undo(token, proof, command(intent))).toMatchObject({ outcome: "accepted", command: exact });
    expect(sent(fetcher).body).toEqual({ command_id: commandId, kind: "action.undo", client_instance_id: clientId,
      document_id: documentId, context_id: contextId, action_id: actionId, expected_action_version: largeVersion, payload: {} });
    await expect(api.undo(token, proof, command(intent))).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it.each([
    ["increase action version", fact("interval.increase", { action_id: actionId, object_version: "2" })],
    ["missing action", fact("interval.increase", { object_version: "1" })],
    ["foreign context", fact("interval.increase", { action_id: actionId, object_version: "1", context_id: otherContextId })],
    ["foreign target", fact("interval.increase", { action_id: actionId, object_version: "1", target_id: otherCardId })],
    ["result reference", fact("interval.increase", { action_id: actionId, object_version: "1", result_id: actionId })],
    ["other kind", fact("action.undo", { action_id: actionId, object_version: "1" })],
    ["rejected status", fact("interval.increase", { action_id: actionId, object_version: "1", status: "rejected" })],
  ])("never treats a foreign fact as acceptance: %s", async (_name, wrong) => {
    const intent = dictionaryIncreaseIntent(initialOpen(), commandId, { option_id: 2 });
    const { api } = transport({ status: 200, body: reply(wrong, afterInitialIncrease()) });
    const error = await failure(api.increase(token, proof, command(intent)));
    expect(error).toMatchObject({ kind: "invalid_response" });
    expect(commandOutcomeUnknown(error)).toBe(true);
  });

  it("does not take HTTP 200 with an error as success", async () => {
    const accepted = fact("interval.increase", { action_id: actionId, object_version: "1" });
    const intent = dictionaryIncreaseIntent(initialOpen(), commandId, { option_id: 2 });
    const { api } = transport({ status: 200, body: reply(accepted, afterInitialIncrease(), { error: { code: "VERSION_CONFLICT" } }) });
    const error = await failure(api.increase(token, proof, command(intent)));
    expect(error).toMatchObject({ kind: "invalid_response" });
    expect(commandOutcomeUnknown(error)).toBe(true);
  });

  it("reports network loss and 5xx as unknown, never as a refusal, without repeating the POST", async () => {
    const intent = dictionaryIncreaseIntent(initialOpen(), commandId, { option_id: 2 });
    const lost = transport(new TypeError("connection reset"));
    const network = await failure(lost.api.increase(token, proof, command(intent)));
    expect(network).toBeInstanceOf(ApiError);
    expect(network).toMatchObject({ kind: "network" });
    expect(commandOutcomeUnknown(network)).toBe(true);
    expect(lost.fetcher).toHaveBeenCalledOnce();
    const unavailable = transport({ status: 503, body: { error: { code: "WRITE_UNAVAILABLE" } } });
    const server = await failure(unavailable.api.increase(token, proof, command(intent)));
    expect(server).toMatchObject({ kind: "http", status: 503, code: "WRITE_UNAVAILABLE" });
    expect(commandOutcomeUnknown(server)).toBe(true);
    expect(unavailable.fetcher).toHaveBeenCalledOnce();
  });

  it("keeps a structural or access refusal without a fact as a known refusal", async () => {
    const { api } = transport(
      { status: 422, body: { error: { code: "VALIDATION_FAILED" } } },
      { status: 403, body: { error: { code: "FORBIDDEN" } } },
    );
    const structural = await failure(api.closeContext(token, proof, command(closeIntent)));
    expect(structural).toMatchObject({ kind: "http", status: 422, code: "VALIDATION_FAILED" });
    expect(commandOutcomeUnknown(structural)).toBe(false);
    const access = await failure(api.closeContext(token, proof, command(closeIntent)));
    expect(access).toMatchObject({ kind: "http", status: 403, code: "FORBIDDEN" });
    expect(commandOutcomeUnknown(access)).toBe(false);
  });

  it.each(["DOCUMENT_STALE", "CAPABILITY_EXPIRED", "SETUP_REQUIRED", "ASSIGNMENT_STALE"])(
    "returns the %s refusal with the current context", async code => {
      const closed = { status: "closed", context: { id: contextId, kind: "dictionary", card_id: cardId } };
      const { api } = transport({ status: 409, body: rejected(code, closed) });
      const intent = dictionaryUndoIntent(afterInitialIncrease(), commandId);
      expect(await api.undo(token, proof, command(intent)))
        .toEqual({ outcome: "rejected", command: { id: commandId, status: "rejected" }, error: { code }, current: closed, state_version: stateVersion });
    });

  it("separates a reused ID with another payload; an open refusal may show the earlier context", async () => {
    const earlier = { ...open(), context: { id: otherContextId, kind: "dictionary", card_id: cardId } };
    const { api } = transport(
      { status: 409, body: rejected("COMMAND_PAYLOAD_MISMATCH", earlier) },
      { status: 409, body: rejected("COMMAND_PAYLOAD_MISMATCH", earlier) },
    );
    expect(await api.openContext(token, proof, command(openIntent))).toMatchObject({ outcome: "mismatch", current: { status: "open" } });
    // Other kinds address their own context; a foreign one is not a typed refusal.
    await expect(api.closeContext(token, proof, command(closeIntent))).rejects.toMatchObject({ kind: "http", status: 409 });
  });

  it("refuses a local intent before any request", async () => {
    const { api, fetcher } = transport();
    await expect(api.openContext("", proof, command(openIntent))).rejects.toThrow("invalid dictionary interval command");
    await expect(api.openContext(token, "", command(openIntent))).rejects.toThrow("invalid dictionary interval command");
    await expect(api.closeContext(token, proof, command(openIntent) as any)).rejects.toThrow("invalid dictionary interval command");
    await expect(api.openContext(token, proof, { ...command(openIntent), extra: true } as any)).rejects.toThrow();
    const intent = dictionaryIncreaseIntent(open(), commandId, { option_id: 1 });
    const numeric = { ...intent, expected_progress_version: 7 };
    await expect(api.increase(token, proof, command(numeric as any))).rejects.toThrow("invalid dictionary interval intent");
    // CON:94: neither the oral direction nor the former batch of selections is sent.
    const oral = { ...intent, direction: "de-l1" };
    await expect(api.increase(token, proof, command(oral as any))).rejects.toThrow("invalid dictionary interval intent");
    const { direction: _direction, option_id: _option, interval_days: _days, next_due_date: _due,
      expected_progress_version: _version, ...head } = intent;
    const legacy = { ...head, selections: [{ direction: "l1-de", expected_progress_version: largeVersion, option_id: 1,
      interval_days: 15, next_due_date: "2026-10-14" }] };
    await expect(api.increase(token, proof, command(legacy as any))).rejects.toThrow("invalid dictionary interval intent");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("contextual read", () => {
  const address = { context_id: contextId, card_id: cardId, client_instance_id: clientId, document_id: documentId };

  it("reads one live-document context with origin and proof", async () => {
    const { api, fetcher } = transport({ status: 200, body: { current: open(), state_version: stateVersion } });
    expect(await api.readContext(token, proof, address)).toEqual({ current: open(), state_version: stateVersion });
    const { url, init } = sent(fetcher);
    expect(url).toBe(`/api/v1/dictionary/contexts/${contextId}?client_instance_id=${clientId}&document_id=${documentId}`);
    expect(init.method).toBe("GET");
    expect(init.headers).toEqual(withTrace({ Authorization: `Bearer ${token}`, "X-Origin-Proof": proof }));
  });

  it("keeps an unrecognized document as opaque unavailable, not readiness", async () => {
    // Current core answers an invalid origin proof with 200 + unavailable (context_projection).
    const { api } = transport({ status: 200, body: { current: { status: "unavailable" }, state_version: "3" } });
    expect(await api.readContext(token, proof, address)).toEqual({ current: { status: "unavailable" }, state_version: "3" });
  });

  it.each([
    ["foreign context", { current: { ...open(), context: { id: otherContextId, kind: "dictionary", card_id: cardId } }, state_version: "3" }],
    ["foreign card", { current: { status: "closed", context: { id: contextId, kind: "dictionary", card_id: otherCardId } }, state_version: "3" }],
    ["extra envelope key", { current: { status: "unavailable" }, state_version: "3", error: null }],
    ["numeric state version", { current: { status: "unavailable" }, state_version: 3 }],
    ["unavailable with detail", { current: { status: "unavailable", context_id: contextId }, state_version: "3" }],
    ["oral interval", { current: { ...open(), interval: { ...open().interval, direction: "de-l1" } }, state_version: "3" }],
    ["former two-direction interval", { current: { ...open(), interval: { local_date: today, expected_pair: "uk-de",
      directions: [{ direction: "l1-de", applicable: true, current_schedule: open().interval!.current_schedule,
        expected_progress_version: largeVersion, options: choices(ladder) },
      { direction: "de-l1", applicable: false, current_schedule: null, expected_progress_version: null, options: [] }] },
      capabilities: { interval_increase: { directions: ["l1-de"] }, undo_offer: null, undo_target: null } }, state_version: "3" }],
    ["oral capability", { current: { ...open(), capabilities: { interval_increase: { direction: "de-l1" }, undo_offer: null,
      undo_target: null } }, state_version: "3" }],
    ["capabilities without the undo offer", { current: { ...open(), capabilities: { interval_increase: { direction: "l1-de" },
      undo_target: null } }, state_version: "3" }],
  ])("rejects %s", async (_name, body) => {
    const { api } = transport({ status: 200, body });
    await expect(api.readContext(token, proof, address)).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("passes an access refusal through as HTTP", async () => {
    const { api } = transport({ status: 401, body: { error: { code: "AUTH_INVALID" } } });
    await expect(api.readContext(token, proof, address)).rejects.toMatchObject({ kind: "http", status: 401, code: "AUTH_INVALID" });
  });
});

describe("context validator (B8)", () => {
  const valid = (value: unknown) => validDictionaryContextCurrent(value, stateVersion, { context_id: contextId, card_id: cardId });
  const mutated = (change: (value: any) => void, base: () => OpenDictionaryContext = open) => {
    const value: any = base(); change(value); return value;
  };
  const notApplicable = { applicable: false, current_schedule: null, expected_progress_version: null, options: [],
    default_option_id: null };

  it("accepts the open, closed and unavailable variants", () => {
    expect(valid(open())).toBe(true);
    expect(valid(initialOpen())).toBe(true);
    expect(valid(afterInitialIncrease())).toBe(true);
    expect(valid({ status: "closed", context: { id: contextId, kind: "dictionary", card_id: cardId } })).toBe(true);
    expect(valid({ status: "unavailable" })).toBe(true);
  });

  it("accepts the top step only without default and capability (K07-063)", () => {
    expect(valid(atTopStep())).toBe(true);
    expect(valid(mutated(value => { value.capabilities.interval_increase = { direction: "l1-de" }; }, atTopStep))).toBe(false);
    expect(valid(mutated(value => { value.interval.default_option_id = 8; }, atTopStep))).toBe(false);
  });

  it("accepts an excluded card only as inapplicable, without capability", () => {
    const excluded = (applicable: boolean) => mutated(value => {
      value.view.study.facts.exclusion = { excluded: true, version: "3" };
      value.view.card_actions = { exclude: false, return: true, relearn: false };
      value.view.study.directions[0].schedule = null;
      value.view.study.directions[0].interval_preview = null;
      Object.assign(value.interval, notApplicable, { applicable });
      value.capabilities.interval_increase = null;
    });
    expect(valid(excluded(false))).toBe(true);
    expect(valid(excluded(true))).toBe(false);
  });

  it("accepts a phrase only as inapplicable, whatever its schedule (K07-064)", () => {
    const phrase = (applicable: boolean) => mutated(value => {
      value.view.content.card.type = value.view.study.card_type = "phrase";
      value.view.study.directions[0].interval_preview = [];
      Object.assign(value.interval, notApplicable, { applicable });
      value.capabilities.interval_increase = null;
    });
    expect(valid(phrase(false))).toBe(true);
    expect(valid(phrase(true))).toBe(false);
  });

  it("requires no interval without a time zone or an available view", () => {
    const noZone = (interval: boolean) => mutated(value => {
      value.view.study.local_date = null;
      value.view.study.directions[0].interval_preview = null;
      if (!interval) value.interval = null;
      value.capabilities.interval_increase = null;
    });
    expect(valid(noZone(false))).toBe(true);
    expect(valid(noZone(true))).toBe(false);
    expect(valid(mutated(value => { value.view = { status: "unavailable" }; value.interval = null; value.capabilities.interval_increase = null; }))).toBe(true);
    expect(valid(mutated(value => { value.view = { status: "unavailable" }; }))).toBe(false);
  });

  it.each([
    ["extra key in open", (value: any) => { value.card_id = cardId; }],
    ["extra key in context", (value: any) => { value.context.session_id = null; }],
    ["extra key in interval", (value: any) => { value.interval.ease = "2.5"; }],
    ["former directions list", (value: any) => { value.interval.directions = [{ ...value.interval }]; }],
    ["oral direction", (value: any) => { value.interval.direction = "de-l1"; }],
    ["missing default", (value: any) => { delete value.interval.default_option_id; }],
    ["default not offered", (value: any) => { value.interval.default_option_id = 9; }],
    ["null default with options", (value: any) => { value.interval.default_option_id = null; }],
    ["extra key in capabilities", (value: any) => { value.capabilities.can_undo = false; }],
    ["open without view", (value: any) => { delete value.view; }],
    ["view of another card", (value: any) => { value.view.content.card.id = value.view.study.card_id = otherCardId; }],
    ["undo target of another context", (value: any) => {
      value.capabilities.undo_offer = undoOffer("offered");
      value.capabilities.undo_target = { action_id: actionId, kind: "interval.increase", version: "1", context_id: otherContextId };
    }],
    ["numeric undo version", (value: any) => {
      value.capabilities.undo_offer = undoOffer("offered");
      value.capabilities.undo_target = { action_id: actionId, kind: "interval.increase", version: 1, context_id: contextId };
    }],
    ["undo of another kind", (value: any) => {
      value.capabilities.undo_offer = undoOffer("offered");
      value.capabilities.undo_target = { action_id: actionId, kind: "answer.submit", version: "1", context_id: contextId };
    }],
    ["missing undo offer key", (value: any) => { delete value.capabilities.undo_offer; }],
    ["undo target without an offer", (value: any) => {
      value.capabilities.undo_target = { action_id: actionId, kind: "interval.increase", version: "1", context_id: contextId };
    }],
    ["undo target of a pending offer", (value: any) => {
      value.capabilities.undo_offer = undoOffer("pending");
      value.capabilities.undo_target = { action_id: actionId, kind: "interval.increase", version: "1", context_id: contextId };
    }],
    ["offered offer without an undo target", (value: any) => { value.capabilities.undo_offer = undoOffer("offered"); }],
    ["undo target of another action than the offer", (value: any) => {
      value.capabilities.undo_offer = { ...undoOffer("offered"), action_id: otherContextId };
    }, () => afterInitialIncrease()],
    ["offer of another context", (value: any) => { value.capabilities.undo_offer = { ...undoOffer("pending"), context_id: otherContextId }; }],
    ["closed offer status", (value: any) => { value.capabilities.undo_offer = undoOffer("closed" as any); }],
    ["numeric offer version", (value: any) => { value.capabilities.undo_offer = { ...undoOffer("pending"), version: 1 }; }],
    ["extra key in offer", (value: any) => { value.capabilities.undo_offer = { ...undoOffer("pending"), deadline: "2026-10-05T12:00:03Z" }; }],
    ["offer without an action", (value: any) => {
      const { action_id: _, ...rest } = undoOffer("pending"); value.capabilities.undo_offer = rest;
    }],
    ["numeric progress version", (value: any) => { value.interval.expected_progress_version = Number(largeVersion); }],
    ["null version with persisted=true", (value: any) => { value.interval.expected_progress_version = null; }],
    ["saved schedule differs from view", (value: any) => { value.interval.current_schedule.interval_days = 11; }],
    ["version differs from view", (value: any) => { value.interval.expected_progress_version = "7"; }],
    ["options differ from view preview", (value: any) => { value.interval.options.pop(); }],
    ["local date differs from view", (value: any) => { value.interval.local_date = "2026-09-30"; }],
    ["pair differs from view", (value: any) => { value.interval.expected_pair = "ru-de"; }],
    ["former capability list", (value: any) => { value.capabilities.interval_increase = { directions: ["l1-de"] }; }],
    ["oral capability", (value: any) => { value.capabilities.interval_increase = { direction: "de-l1" }; }],
    ["empty capability instead of an explicit direction", (value: any) => { value.capabilities.interval_increase = {}; }],
    ["missing capability with options", (value: any) => { value.capabilities.interval_increase = null; }],
  ])("rejects %s", (_name, change, base?: () => OpenDictionaryContext) => {
    expect(valid(mutated(change, base))).toBe(false);
  });

  it("accepts a pending offer without undo and an offered one with its undo target", () => {
    expect(valid(afterInitialIncrease("1", "pending"))).toBe(true);
    expect(valid(afterInitialIncrease())).toBe(true);
    expect(valid(mutated(value => { value.capabilities.undo_offer = undoOffer("pending", "9007199254740993"); }))).toBe(true);
  });

  it.each([
    ["version with persisted=false", (value: any) => { value.interval.expected_progress_version = "1"; }],
    ["persisted flag without a saved row", (value: any) => { value.interval.current_schedule.persisted = true; }],
    ["A01 schedule not due today", (value: any) => { value.interval.current_schedule.next_due_date = "2026-09-30"; }],
    ["option date off by one day", (value: any) => { value.interval.options[0].next_due_date = "2026-10-03"; }],
    ["options not growing", (value: any) => { value.interval.options[1].interval_days = 3; }],
    ["option above command range", (value: any) => {
      value.interval.options.push({ option_id: 2147483648, interval_days: 9, next_due_date: "2026-10-08" });
    }],
  ])("rejects an A01 interval with %s", (_name, change) => {
    expect(valid(mutated(change, initialOpen))).toBe(false);
  });
});

describe("command status", () => {
  const increaseIntent = () => dictionaryIncreaseIntent(initialOpen(), commandId, { option_id: 2 });

  it("sends origin, proof and the verified intent hash; accepts only the echoed hash", async () => {
    const intent = increaseIntent();
    const hash = await dictionaryIntervalIntentHash(intent);
    const stored = fact("interval.increase", { status: "already_applied", action_id: actionId, object_version: "1" });
    const { api, fetcher } = transport(
      { status: 200, body: reply(stored, afterInitialIncrease(), { verified_intent_hash: hash }) },
      { status: 200, body: reply(stored, afterInitialIncrease()) },
    );
    expect(await api.commandStatus(token, proof, command(intent)))
      .toEqual({ outcome: "accepted", command: stored, current: afterInitialIncrease(), state_version: stateVersion });
    const { url, init } = sent(fetcher);
    expect(url).toBe(`/api/v1/commands/${commandId}?client_instance_id=${clientId}&document_id=${documentId}&expected_intent_hash=${hash}`);
    expect(init.method).toBe("GET");
    expect(init.headers).toEqual(withTrace({ Authorization: `Bearer ${token}`, "X-Origin-Proof": proof }));
    await expect(api.commandStatus(token, proof, command(intent))).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("returns not_found with the profile for an explicit retry of the same command", async () => {
    const { api } = transport({ status: 200, body: reply({ id: commandId, status: "not_found" }, profile()) });
    expect(await api.commandStatus(token, proof, command(increaseIntent())))
      .toEqual({ outcome: "not_found", command: { id: commandId, status: "not_found" }, current: profile(), state_version: stateVersion });
  });

  it("returns not_found for the real core's profile (reapply_closed present) and rejects unknown profile keys", async () => {
    const real = recordedOralUnknownClosed.current;
    const { api } = transport({ status: 200, body: reply({ id: commandId, status: "not_found" }, real) });
    expect(await api.commandStatus(token, proof, command(increaseIntent())))
      .toEqual({ outcome: "not_found", command: { id: commandId, status: "not_found" }, current: real, state_version: stateVersion });
    for (const extra of [{ reapply_closed: "false" }, { private: {} }, { reapply_closed: false, private: {} }]) {
      const rejecting = transport({ status: 200, body: reply({ id: commandId, status: "not_found" }, { ...real, ...extra }) });
      await expect(rejecting.api.commandStatus(token, proof, command(increaseIntent()))).rejects.toMatchObject({ kind: "invalid_response" });
    }
  });

  it("returns a typed mismatch for another payload under the same ID", async () => {
    const { api } = transport({ status: 409, body: { error: { code: "COMMAND_PAYLOAD_MISMATCH" } } });
    expect(await api.commandStatus(token, proof, command(closeIntent)))
      .toEqual({ outcome: "mismatch", error: { code: "COMMAND_PAYLOAD_MISMATCH" } });
  });

  it("accepts a found fact whose context is no longer visible", async () => {
    const hash = await dictionaryIntervalIntentHash(closeIntent);
    const stored = fact("context.close", { status: "already_applied" });
    const { api } = transport({ status: 200, body: reply(stored, { status: "unavailable" }, { verified_intent_hash: hash }) });
    expect(await api.commandStatus(token, proof, command(closeIntent)))
      .toMatchObject({ outcome: "accepted", current: { status: "unavailable" } });
  });

  it.each([
    ["applied instead of stored", (hash: string) => reply(fact("context.open"), open(), { verified_intent_hash: hash })],
    ["foreign hash", (_hash: string) => reply(fact("context.open", { status: "already_applied" }), open(), { verified_intent_hash: "0".repeat(64) })],
    ["not_found with a closed session", (_hash: string) => reply({ id: commandId, status: "not_found" }, profile(), {
      closed_session: { session_id: contextId, status: "closed", close_reason: "stop" } })],
    ["not_found without a profile", (_hash: string) => reply({ id: commandId, status: "not_found" }, { status: "unavailable" })],
    ["status with an error", (hash: string) => reply(fact("context.open", { status: "already_applied" }), open(),
      { verified_intent_hash: hash, error: { code: "VERSION_CONFLICT" } })],
  ])("rejects %s", async (_name, build) => {
    const hash = await dictionaryIntervalIntentHash(openIntent);
    const { api } = transport({ status: 200, body: build(hash) });
    await expect(api.commandStatus(token, proof, command(openIntent))).rejects.toMatchObject({ kind: "invalid_response" });
  });
});

describe("intent fingerprint compatible with core identity.intent_hash", () => {
  // Literal canonical texts: json.dumps({"kind", "payload"}, sort_keys=True, separators=(",", ":")) over
  // DictionaryIntervalService payloads (values as strings, the one selection in a list, UUIDs lower-case).
  it.each<[string, DictionaryIntervalIntent, string]>([
    ["context.open", { ...openIntent, card_id: cardId.toUpperCase() },
      `{"kind":"context.open","payload":{"card_id":"${cardId}","source":{"kind":"dictionary"}}}`],
    ["context.close", closeIntent, `{"kind":"context.close","payload":{"context_id":"${contextId}"}}`],
    ["interval.increase", {
      kind: "interval.increase", command_id: commandId, context_id: contextId, card_id: cardId, expected_pair: "uk-de",
      expected_local_date: today, direction: "l1-de", expected_progress_version: largeVersion,
      option_id: 1, interval_days: 15, next_due_date: "2026-10-14" },
      `{"kind":"interval.increase","payload":{"card_id":"${cardId}","context_id":"${contextId}",`
        + `"expected_local_date":"${today}","expected_pair":"uk-de","selections":[`
        + `{"direction":"l1-de","expected_progress_version":"${largeVersion}","interval_days":"15","next_due_date":"2026-10-14","option_id":"1"}]}}`],
    ["interval.increase from A01", {
      kind: "interval.increase", command_id: commandId, context_id: contextId, card_id: cardId, expected_pair: "uk-de",
      expected_local_date: today, direction: "l1-de", expected_progress_version: null,
      option_id: 2, interval_days: 3, next_due_date: "2026-10-02" },
      `{"kind":"interval.increase","payload":{"card_id":"${cardId}","context_id":"${contextId}",`
        + `"expected_local_date":"${today}","expected_pair":"uk-de","selections":[`
        + `{"direction":"l1-de","expected_progress_version":null,"interval_days":"3","next_due_date":"2026-10-02","option_id":"2"}]}}`],
    ["action.undo", { kind: "action.undo", command_id: commandId, context_id: contextId, card_id: cardId,
      action_id: actionId, expected_action_version: largeVersion },
      `{"kind":"action.undo","payload":{"action_id":"${actionId}","context_id":"${contextId}","expected_action_version":"${largeVersion}"}}`],
  ])("%s", async (_kind, intent, canonical) => {
    expect(await dictionaryIntervalIntentHash(intent)).toBe(await sha256(canonical));
  });

  it("does not depend on the command ID or the binding card of close", async () => {
    const other = { ...closeIntent, command_id: actionId, card_id: otherCardId };
    expect(await dictionaryIntervalIntentHash(other)).toBe(await dictionaryIntervalIntentHash(closeIntent));
  });
});

describe("controller seam: intents from the server offer", () => {
  it("copies versions, dates and pair from the context and never offers more", () => {
    expect(dictionaryIncreaseIntent(open(), commandId, { option_id: 8 })).toEqual({
      kind: "interval.increase", command_id: commandId, context_id: contextId, card_id: cardId, expected_pair: "uk-de",
      expected_local_date: today, direction: "l1-de", expected_progress_version: largeVersion,
      option_id: 8, interval_days: 438, next_due_date: "2027-12-11",
    });
    // The default step is one of the offered steps (+5 here).
    const current = open();
    expect(dictionaryIncreaseIntent(current, commandId, { option_id: current.interval!.default_option_id! }))
      .toMatchObject({ option_id: 5, interval_days: 94, next_due_date: "2027-01-01" });
    expect(() => dictionaryIncreaseIntent(open(), commandId, { option_id: 9 })).toThrow("option is not offered");
    expect(() => dictionaryIncreaseIntent(open(), commandId, { direction: "de-l1", option_id: 1 } as any)).toThrow("invalid interval choice");
    expect(() => dictionaryIncreaseIntent(open(), commandId, [{ option_id: 1 }] as any)).toThrow("invalid interval choice");
    expect(() => dictionaryIncreaseIntent(atTopStep(), commandId, { option_id: 1 })).toThrow("interval increase is not offered");
    expect(() => dictionaryIncreaseIntent({ status: "unavailable" }, commandId, { option_id: 1 })).toThrow();
  });

  it("undoes only the current undo_target", () => {
    expect(() => dictionaryUndoIntent(open(), commandId)).toThrow("undo is not offered");
    expect(dictionaryUndoIntent(afterInitialIncrease(), commandId)).toEqual({ kind: "action.undo", command_id: commandId,
      context_id: contextId, card_id: cardId, action_id: actionId, expected_action_version: "1" });
  });
});

describe("M-INTV: action.undo_offer.open / close (core C-INTV-OFFER, CT 2.1.2)", () => {
  const offerFact = (kind: string, fields: Record<string, unknown> = {}) =>
    fact(kind, { target_id: actionId, action_id: null, object_version: "2", ...fields });

  it("builds the intent from the live offer at its version; another action or no offer throws", () => {
    const pending = afterInitialIncrease("1", "pending");
    expect(dictionaryUndoOfferIntent(pending, commandId, "action.undo_offer.open", actionId.toUpperCase())).toEqual({
      kind: "action.undo_offer.open", command_id: commandId, context_id: contextId, card_id: cardId, action_id: actionId,
      expected_offer_version: "1" });
    expect(dictionaryUndoOfferIntent(afterInitialIncrease(), commandId, "action.undo_offer.close", actionId))
      .toMatchObject({ kind: "action.undo_offer.close", expected_offer_version: "2" });
    expect(() => dictionaryUndoOfferIntent(open(), commandId, "action.undo_offer.open", actionId)).toThrow("undo offer is not live");
    expect(() => dictionaryUndoOfferIntent(pending, commandId, "action.undo_offer.open", otherCardId)).toThrow("undo offer is not live");
    expect(() => dictionaryUndoOfferIntent({ status: "unavailable" }, commandId, "action.undo_offer.open", actionId)).toThrow();
  });

  it("sends the exact wire body without time fields and accepts the offer fact (target = action, no own action)", async () => {
    const intent = dictionaryUndoOfferIntent(afterInitialIncrease("1", "pending"), commandId, "action.undo_offer.open", actionId);
    const accepted = offerFact("action.undo_offer.open");
    const { api, fetcher } = transport({ status: 200, body: reply(accepted, afterInitialIncrease()) });
    expect(await api.undoOffer(token, proof, command(intent))).toMatchObject({ outcome: "accepted", command: accepted });
    expect(sent(fetcher).body).toEqual({ command_id: commandId, kind: "action.undo_offer.open", client_instance_id: clientId,
      document_id: documentId, context_id: contextId, action_id: actionId, expected_offer_version: "1", payload: {} });
    expect(sent(fetcher).url).toMatch(/\/api\/v1\/commands$/);
  });

  it("closes from the offered version; a refusal is a known refusal with the context", async () => {
    const intent = dictionaryUndoOfferIntent(afterInitialIncrease(), commandId, "action.undo_offer.close", actionId);
    const closed = open();
    const { api, fetcher } = transport(
      { status: 200, body: reply(offerFact("action.undo_offer.close", { object_version: "3" }), closed) },
      { status: 409, body: rejected("CAPABILITY_EXPIRED", closed) },
    );
    expect(await api.undoOffer(token, proof, command(intent))).toMatchObject({ outcome: "accepted" });
    expect(sent(fetcher).body).toMatchObject({ kind: "action.undo_offer.close", expected_offer_version: "2" });
    expect(await api.undoOffer(token, proof, command(intent))).toMatchObject({ outcome: "rejected", error: { code: "CAPABILITY_EXPIRED" } });
  });

  it.each([
    ["card as target", offerFact("action.undo_offer.open", { target_id: cardId })],
    ["own action", offerFact("action.undo_offer.open", { action_id: actionId })],
    ["same version", offerFact("action.undo_offer.open", { object_version: "1" })],
    ["foreign context", offerFact("action.undo_offer.open", { context_id: otherContextId })],
    ["other kind", offerFact("action.undo_offer.close")],
  ])("never treats a foreign offer fact as acceptance: %s", async (_name, wrong) => {
    const intent = dictionaryUndoOfferIntent(afterInitialIncrease("1", "pending"), commandId, "action.undo_offer.open", actionId);
    const { api } = transport({ status: 200, body: reply(wrong, afterInitialIncrease()) });
    const error = await failure(api.undoOffer(token, proof, command(intent)));
    expect(error).toMatchObject({ kind: "invalid_response" });
    expect(commandOutcomeUnknown(error)).toBe(true);
  });

  it("refuses another kind or a time field before any request", async () => {
    const { api, fetcher } = transport();
    const intent = dictionaryUndoOfferIntent(afterInitialIncrease("1", "pending"), commandId, "action.undo_offer.open", actionId);
    await expect(api.undoOffer(token, proof, { ...command(intent), kind: "action.undo" } as any)).rejects.toThrow();
    await expect(api.undoOffer(token, proof, { ...command(intent), clicked_at: 1 } as any)).rejects.toThrow();
    await expect(api.undoOffer(token, proof, { ...command(intent), expected_offer_version: 2 } as any)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["action.undo_offer.open", "action.undo_offer.close"] as const)("%s fingerprint matches core _offer_command", async kind => {
    const intent: DictionaryIntervalIntent = { kind, command_id: commandId, context_id: contextId.toUpperCase(), card_id: cardId,
      action_id: actionId, expected_offer_version: largeVersion };
    expect(await dictionaryIntervalIntentHash(intent)).toBe(await sha256(
      `{"kind":"${kind}","payload":{"action_id":"${actionId}","context_id":"${contextId}","expected_offer_version":"${largeVersion}"}}`));
  });

  it("status of an offer command: the verified hash and the stored fact", async () => {
    const intent = dictionaryUndoOfferIntent(afterInitialIncrease("1", "pending"), commandId, "action.undo_offer.open", actionId);
    const hash = await dictionaryIntervalIntentHash(intent);
    const { api } = transport({ status: 200, body: reply(offerFact("action.undo_offer.open", { status: "already_applied" }),
      afterInitialIncrease(), { verified_intent_hash: hash }) });
    expect(await api.commandStatus(token, proof, command(intent))).toMatchObject({ outcome: "accepted" });
  });

  it("literal hashes of core intent_hash for open v1 and close v2, upper-case IDs normalised (M-INTV-QA probes/core_offer_hash.py)", async () => {
    const base = { command_id: commandId, context_id: "00000000-0000-4000-8000-0000000001F4", card_id: cardId,
      action_id: "00000000-0000-4000-8000-0000000001F5" };
    expect(await dictionaryIntervalIntentHash({ ...base, kind: "action.undo_offer.open", expected_offer_version: "1" }))
      .toBe("ec2e4c92c988282d9ea99e5cca7f3e7fe57225446fcd820bebec028ac25c1fb9");
    expect(await dictionaryIntervalIntentHash({ ...base, kind: "action.undo_offer.close", expected_offer_version: "2" }))
      .toBe("1a335cd9a9e1b13e033b91040cc326513b318a98245cd9999974b05aaadec516");
  });
});
