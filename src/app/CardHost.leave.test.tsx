// T+M-CARD-LINK: leaving a card asks for its context close exactly once. The interval controller also drops a repeated close,
// so only a count taken at the host itself can see a second `context.actions.close()` in CardHost.leave.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenedClient } from "../api/generated";
import { CardHost } from "../dictionary/card/CardHost";
import { cardIdOf, cardView } from "../dictionary/card/cardTestData.test-support";
import { ManualPendingStore } from "../learning/manualPending";
import type { AsyncStorage } from "../platform/storage";
import { createOpenedAccess } from "./openedAccess";
import { testGate } from "../commands/testGate.test-support";

const closeCalls = vi.hoisted(() => ({ count: 0 }));
// The real hook, with the close action of the host counted before it reaches the controller.
vi.mock("../dictionary/useDictionaryIntervalContext", async importOriginal => {
  const real = await importOriginal<typeof import("../dictionary/useDictionaryIntervalContext")>();
  return { ...real, useDictionaryIntervalContext: (options: Parameters<typeof real.useDictionaryIntervalContext>[0]) => {
    const context = real.useDictionaryIntervalContext(options);
    return { ...context, actions: { ...context.actions, close: () => { closeCalls.count++; return context.actions.close(); } } };
  } };
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); closeCalls.count = 0; });

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CARD = cardIdOf(3), CONTEXT = id(500);
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });

function mount() {
  const reference = { id: CONTEXT, kind: "dictionary", card_id: CARD };
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input), "http://local");
    if (url.pathname.endsWith("/view")) return json({ state_version: "10", current: cardView(CARD) });
    if (url.pathname === "/api/v1/learning/current") return json({ pair: "ru-de", state_version: "10", manual_selection_version: "1", group: null,
      manual_selection: [], learning: { status: "new_group", ready: 0, preview: 0, next_due_at: null, new_group_size: 2, manual_eligible: 0, automatic_eligible: 2 } });
    const body = JSON.parse(String(init!.body));
    const view = cardView(CARD); view.study.local_date = null;
    const command = { id: body.command_id, kind: body.kind, status: "applied", applied_at: "2026-10-07T09:00:00Z", target_id: CARD,
      action_id: null, result_id: null, context_id: CONTEXT, object_version: null };
    return json({ command, state_version: "11", current: body.kind === "context.open"
      ? { status: "open", context: reference, view, interval: null, capabilities: { interval_increase: null, undo_offer: null, undo_target: null } }
      : { status: "closed", context: reference } });
  });
  const opened: OpenedClient = { status: "opened", client_instance_id: id(1), document_id: id(2), document_epoch: "1", proof_version: "1",
    profile: { profile_id: id(3), role: "user", ui_language: "ru", dictionary_language: "ru", time_zone: "UTC", state_version: "10",
      access: { status: "admitted", version: "1", reason: null } }, session: null, compatibility: { compatible: true, contract_version: "1" } };
  let active: ReturnType<typeof createOpenedAccess> | null = null;
  const access = createOpenedAccess({ opened, token: "synthetic-token", proof: "synthetic-proof", generation: 1,
    isLive: () => active === access, onDenied: () => { active = null; } });
  active = access;
  const values = new Map<string, string>();
  const storage: AsyncStorage = { get: async key => values.get(key) ?? null, set: async (key, value) => { values.set(key, value); },
    remove: async key => { values.delete(key); } };
  const onBack = vi.fn();
  let next = 100;
  render(<CardHost access={access} transport={{ fetcher, timeoutMs: 5000, maxResponseBytes: 1_000_000, gate: testGate() }} language="ru"
    pendingStore={new ManualPendingStore(storage)} cardId={CARD} origin={{ kind: "dictionary" }} newId={() => id(next++)} onBack={onBack} />);
  const kinds = () => fetcher.mock.calls.filter(([, init]) => init!.method === "POST").map(([, init]) => JSON.parse(String(init!.body)).kind);
  return { onBack, kinds };
}

describe("CardHost.leave asks for the context close once", () => {
  it("C1 Back calls the close action of the host once and sends a single context.close", async () => {
    const host = mount();
    await screen.findByRole("heading", { level: 2 });
    await waitFor(() => expect(host.kinds()).toEqual(["context.open"]));
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    expect(host.onBack).toHaveBeenCalledTimes(1);
    expect(closeCalls.count).toBe(1);
    await waitFor(() => expect(host.kinds()).toEqual(["context.open", "context.close"]));
    // Nothing else asks for a close afterwards.
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(closeCalls.count).toBe(1);
  });
});
