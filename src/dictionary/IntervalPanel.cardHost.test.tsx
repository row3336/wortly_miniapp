import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenedClient } from "../api/generated";
import { createOpenedAccess } from "../app/openedAccess";
import { ManualPendingStore } from "../learning/manualPending";
import type { AsyncStorage } from "../platform/storage";
import { CardHost, type CardHostProps } from "./card/CardHost";
import type { CardOrigin } from "./card/cardOrigin";
import { CARD } from "./card/cardTestData.test-support";
import { intervalWorld } from "./intervalCardTestData.test-support";
import { testGate } from "../commands/testGate.test-support";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const aid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function fixture(origin: CardOrigin, extensions?: CardHostProps["extensions"]) {
  let version = 10;
  const world = intervalWorld({ cardId: CARD, id: aid, version: { get: () => version, bump: () => ++version } });
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const reply = world.handle(input, init);
    if (!reply) throw new Error(`unexpected ${init?.method} ${input}`);
    return reply;
  });
  const values = new Map<string, string>();
  const storage: AsyncStorage = { get: async key => values.get(key) ?? null, set: async (key, value) => { values.set(key, value); },
    remove: async key => { values.delete(key); } };
  const opened: OpenedClient = { status: "opened", client_instance_id: aid(1), document_id: aid(2), document_epoch: "1", proof_version: "1",
    profile: { profile_id: aid(50), role: "user", ui_language: "ru", dictionary_language: "ru", time_zone: "UTC",
      access: { status: "admitted", reason: null, version: "1" }, state_version: "5" },
    session: null, compatibility: { compatible: true, contract_version: "1" } };
  let next = 100;
  const onBack = vi.fn(), onStudyAction = vi.fn();
  const props: CardHostProps = { access: createOpenedAccess({ opened, token: "synthetic-interval-card-token",
    proof: "synthetic-interval-card-proof", generation: 1, isLive: () => true, onDenied: () => {} }),
    transport: { fetcher, timeoutMs: 5000, maxResponseBytes: 1_000_000, gate: testGate() }, language: "ru", pendingStore: new ManualPendingStore(storage),
    cardId: CARD, origin, newId: () => aid(next++), onBack, onStudyAction, extensions };
  return { world, props, onBack, onStudyAction };
}
const increaseButton = () => screen.findByRole("button", { name: "Увеличить интервал" }, { timeout: 5000 });
async function enabledIncrease() {
  const button = await increaseButton() as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  return button;
}

describe("the interval window in the card (M-INTV CP2: TA:149–151, К07-059…067, К07-122)", () => {
  it("from the dictionary: +5 by default, success closes the window, the card shows the new term and «Отменить увеличение»", async () => {
    const f = fixture({ kind: "dictionary" });
    render(<CardHost {...f.props} />);
    await screen.findByText("Интервал: 3 дн.");
    fireEvent.click(await enabledIncrease());
    const dialog = screen.getByRole("dialog", { name: "Увеличить интервал" });
    expect(within(dialog).getByText("56 дн.")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Увеличить" }));
    const undo = await screen.findByRole("button", { name: "Отменить увеличение" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await screen.findByText("Интервал: 56 дн.");
    expect(f.world.kinds()).toEqual(["context.open", "interval.increase", "action.undo_offer.open"]);
    expect(f.world.posts[1]).toMatchObject({ payload: { direction: "l1-de", option_id: 5, interval_days: 56 } });
    expect(f.onStudyAction).toHaveBeenCalledWith({ kind: "interval.increase", cardId: CARD, stateVersion: "12" });
    // К07-122: the undo addresses the manual action, not the earlier answer.
    fireEvent.click(undo);
    await screen.findByText("Интервал: 3 дн.");
    expect(f.world.kinds().slice(3)).toEqual(["action.undo"]);
    expect(f.world.posts[3]).toMatchObject({ action_id: aid(601), expected_action_version: "1" });
    expect(screen.queryByRole("button", { name: "Отменить увеличение" })).toBeNull();
    await waitFor(() => expect(f.onStudyAction).toHaveBeenLastCalledWith({ kind: "action.undo", cardId: CARD, stateVersion: "14" }));
  });

  it("from the main written quiz: the same window; the card stays and reports the increase to the quiz (Т08)", async () => {
    const f = fixture({ kind: "quiz", direction: "l1-de" });
    render(<CardHost {...f.props} />);
    await screen.findByText("Интервал: 3 дн.");
    expect(screen.queryByText("Интервал: 8 дн.")).toBeNull();
    fireEvent.click(await enabledIncrease());
    fireEvent.change(within(screen.getByRole("dialog")).getByRole("slider"), { target: { value: "0" } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Увеличить" }));
    await screen.findByText("Интервал: 9 дн.");
    await waitFor(() => expect(f.onStudyAction).toHaveBeenCalledWith({ kind: "interval.increase", cardId: CARD, stateVersion: "12" }));
    expect(f.onBack).not.toHaveBeenCalled();
  });

  it("from the oral quiz: no increase at all, although the dictionary context offers it (RA:220, К07-064; M-ORAL-ENTRY В3)", async () => {
    const f = fixture({ kind: "quiz", direction: "de-l1" });
    render(<CardHost {...f.props} />);
    await screen.findByText("Интервал: 8 дн.");
    await waitFor(() => expect(f.world.kinds()).toEqual(["context.open"]));
    // The server's capability is present: the oral rule is the card's, not a missing offer.
    expect(f.world.contexts.size).toBe(1);
    expect(screen.queryByRole("button", { name: "Увеличить интервал" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Back while «Отменить увеличение» is shown: only context.close, no offer close; closing the window is no Back", async () => {
    const f = fixture({ kind: "dictionary" });
    render(<CardHost {...f.props} />);
    fireEvent.click(await enabledIncrease());
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Отмена" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(f.onBack).not.toHaveBeenCalled();
    fireEvent.click(await enabledIncrease());
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Увеличить" }));
    await screen.findByRole("button", { name: "Отменить увеличение" });
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    await waitFor(() => expect(f.onBack).toHaveBeenCalledWith("sent"));
    await waitFor(() => expect(f.world.kinds()).toEqual(["context.open", "interval.increase", "action.undo_offer.open", "context.close"]));
  });

  it("at the top step: «Предел достигнут» and no increase (К07-063)", async () => {
    const f = fixture({ kind: "dictionary" });
    f.world.written = { version: 2, days: 400, ladder: [] };
    render(<CardHost {...f.props} />);
    await screen.findByText("Предел достигнут");
    await waitFor(() => expect(f.world.kinds()).toEqual(["context.open"]));
    expect(screen.queryByRole("button", { name: "Увеличить интервал" })).toBeNull();
  });

  it("Н1: increase and then its undo in the real card: no window is open afterwards, no close follows the undo", async () => {
    const f = fixture({ kind: "dictionary" });
    render(<CardHost {...f.props} />);
    fireEvent.click(await enabledIncrease());
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Увеличить" }));
    fireEvent.click(await screen.findByRole("button", { name: "Отменить увеличение" }));
    await screen.findByText("Интервал: 3 дн.");
    await waitFor(() => expect(f.onStudyAction).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "action.undo" })));
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(f.world.kinds()).toEqual(["context.open", "interval.increase", "action.undo_offer.open", "action.undo"]);
  });

  it("an extension replaces the default window; for the oral quiz neither is shown (Н5, Р3)", async () => {
    const custom = { renderInterval: () => <p>custom interval</p> };
    const dictionary = fixture({ kind: "dictionary" }, custom);
    const view = render(<CardHost {...dictionary.props} />);
    await screen.findByText("custom interval", undefined, { timeout: 5000 });
    expect(screen.queryByRole("button", { name: "Увеличить интервал" })).toBeNull();
    view.unmount();
    const oral = fixture({ kind: "quiz", direction: "de-l1" }, custom);
    render(<CardHost {...oral.props} />);
    await screen.findByText("Интервал: 8 дн.", undefined, { timeout: 5000 });
    await waitFor(() => expect(oral.world.kinds()).toEqual(["context.open"]));
    expect(screen.queryByText("custom interval")).toBeNull();
  });
});

