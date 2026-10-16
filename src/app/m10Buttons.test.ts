// The rule of the button (§4.1 RD-1/RD-3, C335; M-P03-10) on owners the earlier packages left out, each on a real write
// gate: the owner editor (AC-16/AC-28), the document lanes of a study screen (K01s start, K03 Stop, CommandRecovery), and
// the negative control F8 of QA M4–M8: after not_found the manual selection resends by mayWrite of its ID, which an
// identity lock of the document shuts while checkButtonActive stays true.
import { describe, expect, it, vi } from "vitest";
import type { LearningCurrentResponse, OpenedClient, Profile } from "../api/generated";
import type { AsyncStorage } from "../platform/storage";
import { createOpenedAccess, type OpenedAccess } from "./openedAccess";
import { WriteGate } from "../commands/writeGate";
import { DOC_A, ManualClock, settle } from "../commands/writeGate.test-support";
import { DocumentLanes, type LaneWiring } from "../commands/documentLanes";
import { OwnerEditorController, type CommonSource } from "../dictionary/owner/ownerEditorController";
import { CARD_ID, CONTEXT, NOUN_GRAMMAR, origin } from "../dictionary/owner/ownerTestData.test-support";
import { ManualSelectionController } from "../learning/manualSelectionController";
import { ManualPendingStore } from "../learning/manualPending";
import type { LearningApi, ManualStatusReply } from "../learning/learningApi";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const realGate = () => { const gate = new WriteGate({ clock: new ManualClock() }); return gate; };

describe("AC-16/AC-28: the owner editor waits for the gate — visibly, with no queued click", () => {
  function editor(gate: WriteGate) {
    const send = vi.fn(async () => { throw new Error("not reached"); });
    const states: unknown[] = [];
    const controller = new OwnerEditorController({ gate,
      port: { origin: () => origin, send, status: vi.fn(),
        readTranslations: async () => ({ state_version: "10", current: { status: "unavailable" } }) },
      newId: () => id(777), onUpdate: snapshot => states.push(snapshot), onChanged: () => {} });
    const source: CommonSource = { cardId: CARD_ID, cardType: "noun", language: "ru", revision: "1", stateVersion: "10",
      translations: ["дом"], grammar: { ...NOUN_GRAMMAR } };
    controller.setCard(source); controller.setContext(CONTEXT); controller.openTranslations();
    controller.editTranslation(0, "дом, жильё");
    return { controller, send, states };
  }

  it("«Сохранить» is inactive while net is closed, the field stays editable (M12); a press sends nothing", async () => {
    const gate = realGate();
    const { controller, send, states } = editor(gate);
    expect(controller.snapshot().translations?.canSave).toBe(true);
    const before = states.length;
    gate.closeByFailure();
    expect(states.length).toBeGreaterThan(before); // repainted by the gate
    expect(controller.snapshot().translations).toMatchObject({ canSave: false, canEdit: true });
    await controller.saveTranslations();
    expect(send).not.toHaveBeenCalled();
    gate.extendHold(30);
    expect(controller.snapshot().translations?.canSave).toBe(false);
  });

  it("an identity lock of the document shuts it as well (I10); its end gives the button back", () => {
    const gate = realGate(); gate.trackAccess(); gate.noteOpened(DOC_A);
    const { controller } = editor(gate);
    gate.lockIdentity(DOC_A);
    expect(controller.snapshot().translations?.canSave).toBe(false);
    gate.identityVerified(DOC_A); // the round is empty: Z4
    expect(controller.snapshot().translations?.canSave).toBe(true);
  });
});

describe("the document lanes of a study screen: K01s start, K03 Stop and the CommandRecovery controls", () => {
  const profile = (): Profile => ({ profile_id: id(1), role: "user", ui_language: "ru", dictionary_language: "ru",
    time_zone: "UTC", state_version: "5", access: { status: "admitted", version: "1", reason: null } });
  type State = { pending: boolean; phase: string; kind: string | null; outcome: string | null; sessionId: string | null;
    pendingIntent: { command_id: string; kind: string; session_id: string } | null; resolved: null; problem: string | null;
    canRetry: boolean; current: null; closedSession: null; stateVersion: string | null };
  function lanes(gate: WriteGate, withPending = true) {
    const opened: OpenedClient = { status: "opened", client_instance_id: id(2), document_id: id(3), document_epoch: "1",
      proof_version: "1", profile: profile(), session: null, compatibility: { compatible: true, contract_version: "1" } };
    const access: OpenedAccess = createOpenedAccess({ opened, token: "t", proof: "p", generation: 1, isLive: () => true, onDenied: () => {} });
    const lane = (wiring: LaneWiring<State>) => {
      const held = withPending && wiring.lane === "primary";
      const state: State = { pending: held, phase: held ? "unresolved" : "idle", kind: null,
        outcome: null, sessionId: null, resolved: null, problem: held ? "paused" : null, canRetry: false,
        current: null, closedSession: null, stateVersion: null,
        pendingIntent: held ? { command_id: id(50), kind: "item.mark", session_id: id(9) } : null };
      return { snapshot: () => ({ ...state }), refresh: vi.fn(async () => {}), begin: vi.fn(async () => {}), retry: vi.fn(async () => {}),
        dispose: vi.fn(), prepare: vi.fn(() => new Error("manual")), start: vi.fn(async () => {}), resend: vi.fn(async () => {}),
        lastFailure: () => null, release: vi.fn(async () => {}), releaseClosed: vi.fn(async () => {}) };
    };
    const onUpdate = vi.fn();
    const storage: AsyncStorage = { get: vi.fn(async () => null), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) };
    const owner = new DocumentLanes<State, { kind: "session.stop" | "item.mark"; session_id: string }, never, never>({ access: () => access,
      transport: { fetcher: vi.fn(), timeoutMs: 1, maxResponseBytes: 1, gate }, storage, newId: () => id(100), onUpdate },
    { label: "m10", readSession: vi.fn(), readResult: vi.fn(), controller: lane, automatic: [] });
    return { owner, onUpdate };
  }

  it("closed: start and Stop are inactive, the check and the resend wait with 9.2.2; ready gives them back", () => {
    const gate = realGate();
    const { owner, onUpdate } = lanes(gate);
    const open = owner.snapshot();
    expect(open.gate).toEqual({ checkable: true, primaryWritable: true, stopWritable: true, wait: null });
    const calls = onUpdate.mock.calls.length;
    gate.closeByFailure();
    expect(onUpdate.mock.calls.length).toBe(calls + 1); // one repaint for the change of what the controls show
    expect(owner.snapshot()).toMatchObject({ canBegin: false, canStop: false,
      gate: { checkable: false, primaryWritable: false, stopWritable: false, wait: { cause: "offline" } } });
    gate.registerPending("lane", id(51)); // a registration inside a step changes nothing shown: no repaint
    expect(onUpdate.mock.calls.length).toBe(calls + 1);
  });

  it("K01s start and K03 Stop of a ready document follow mayWrite: inactive while closed, active again after ready", async () => {
    const clock = new ManualClock();
    const gate = new WriteGate({ clock, probe: async () => ({ status: "ready" }) });
    const { owner } = lanes(gate, false);
    expect(owner.snapshot()).toMatchObject({ canBegin: true, canStop: true });
    gate.closeByFailure();
    expect(owner.snapshot()).toMatchObject({ canBegin: false, canStop: false });
    await clock.advanceTo(5_000);
    expect(owner.snapshot()).toMatchObject({ canBegin: true, canStop: true });
    gate.extendHold(30);
    expect(owner.snapshot()).toMatchObject({ canBegin: false, canStop: false });
  });

  it("a family lock of the pending ID shuts its resend only; the check stays (C335)", () => {
    const gate = realGate();
    const { owner } = lanes(gate);
    gate.resolvePending(id(50), "stale");
    expect(owner.snapshot().gate).toMatchObject({ checkable: true, primaryWritable: false, stopWritable: true });
  });
});

describe("F8 (QA M4–M8, negative control under identityLock): the resend after not_found follows mayWrite of its ID", () => {
  it("an identity lock of the document keeps checkButtonActive but shuts the resend of the not_found ID", async () => {
    const gate = realGate(); gate.trackAccess(); gate.noteOpened(DOC_A);
    const values = new Map<string, string>();
    const storage: AsyncStorage = { get: async key => values.get(key) ?? null, set: async (key, value) => { values.set(key, value); },
      remove: async key => { values.delete(key); } };
    const store = new ManualPendingStore(storage);
    await store.save({ schemaVersion: 1, profileId: id(1), clientInstanceId: id(2), intent: { command_id: id(100),
      kind: "learning.select", expected_selection_version: "10", payload: { card_id: id(4), expected_pair: "ru-de" } } },
    new AbortController().signal);
    const current: LearningCurrentResponse = { pair: "ru-de", state_version: "10", manual_selection_version: "10",
      manual_selection: [], group: null, learning: { status: "new_group", ready: 0, preview: 0, next_due_at: null,
        new_group_size: 2, manual_eligible: 0, automatic_eligible: 2 } };
    const missing: ManualStatusReply = { outcome: "not_found", command: { id: id(100), status: "not_found" },
      current: { profile_id: id(1), access: { status: "admitted", reason: null, version: "1" }, state_version: "10", role: "user",
        dictionary_language: "ru", ui_language: "ru", time_zone: "UTC" }, state_version: "10" };
    const api = { get: vi.fn(async () => current), change: vi.fn(), status: vi.fn(async () => missing) } as unknown as LearningApi;
    const controller = new ManualSelectionController({ gate, api, pendingStore: store, newId: () => id(200), onUpdate: () => {},
      context: { profileId: id(1), clientInstanceId: id(2), documentId: id(3), pair: "ru-de", token: "t", proof: "p" } });
    await controller.refresh(); await settle();
    expect(controller.snapshot()).toMatchObject({ canRetry: true, problem: { reason: "not_found" } });
    gate.lockIdentity(DOC_A);
    expect(gate.checkButtonActive()).toBe(true);
    expect(controller.snapshot().canRetry).toBe(false);
    await controller.retry();
    expect(api.change).not.toHaveBeenCalled();
    controller.dispose();
  });
});
