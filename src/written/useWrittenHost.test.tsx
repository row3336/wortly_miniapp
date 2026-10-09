import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenedClient, Profile } from "../api/generated";
import { createOpenedAccess } from "../app/openedAccess";
import type { SettingsDocument } from "../settings/useSettingsDocument";
import { useWrittenHost } from "./useWrittenHost";
import { settingsResponse } from "../settings/settingsRead.test-support";
import { settingsRefusalText } from "./writtenApp.test-support";
import { profile, writtenFixture } from "./writtenFixtures.test-support";

afterEach(() => cleanup());
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function access(live: boolean, status: "admitted" | "pending" | "denied") {
  const profile = { profile_id: id(1), access: { status, version: "1", reason: null }, role: "user", ui_language: "ru",
    dictionary_language: "uk", time_zone: "UTC", state_version: "10" } as unknown as Profile;
  const opened = { status: "opened", profile, compatibility: { compatible: true, contract_version: "1" }, client_instance_id: id(2),
    document_id: id(3), proof_version: "1", document_epoch: "1", session: null } as unknown as OpenedClient;
  return createOpenedAccess({ opened, token: "t", proof: "p", generation: 1, isLive: () => live, onDenied: () => undefined });
}
const settings = { state: { phase: "loading", data: null, dataCurrent: false, drafts: {}, pending: null, outcome: null, problem: null,
  canEdit: false, canRetry: false }, confirmed: null, actions: { refresh: vi.fn(async () => undefined) } } as unknown as SettingsDocument;
function Probe({ live, status }: { live: boolean; status: "admitted" | "pending" | "denied" }) {
  const host = useWrittenHost({ access: access(live, status), transport: {} as never, storage: {} as never, newId: () => id(9), language: "ru",
    settings, initialSessionId: null, route: "written", onWritten: () => undefined, onToday: () => undefined });
  return <>{host.screen}</>;
}
describe("Written host: refusal versus loading before the owner exists", () => {
  it("dead access: the refusal with its two buttons, not a loading status", () => {
    render(<Probe live={false} status="admitted" />);
    expect(screen.getByText(settingsRefusalText)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Обновить настройки" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "На Сегодня" })).toBeTruthy();
    expect(screen.queryByText("Загружаем занятие…")).toBeNull();
  });
  it("a live access that is not admitted: the refusal, not a loading status", () => {
    render(<Probe live={true} status="pending" />);
    expect(screen.getByText(settingsRefusalText)).toBeTruthy();
    expect(screen.queryByText("Загружаем занятие…")).toBeNull();
  });
});

/** Confirmed current settings of this pair (TA §5 gate): ready, current, nothing pending, a transition mode. */
function confirmedSettings(pair: "ru" | "uk", version: string): SettingsDocument {
  const confirmed = settingsResponse(); confirmed.needs_setup = false; confirmed.state_version = version;
  confirmed.settings.dictionary_language.value = pair; confirmed.settings.transition_mode.value = "normal";
  return { state: { phase: "ready", data: confirmed, dataCurrent: true, drafts: {}, pending: null, outcome: null, problem: null,
    canEdit: true, canRetry: false }, confirmed, actions: { refresh: vi.fn(async () => undefined) } } as unknown as SettingsDocument;
}
describe("Written host: a closure of the quiz (Q27-А, TA:164)", () => {
  it("TA:164 a saved pair change from this window's Settings closes the quiz and leaves Today, never its summary", async () => {
    const f = writtenFixture({ cards: [6, 7, 8] }), onWritten = vi.fn(), onToday = vi.fn();
    const seen: { host: ReturnType<typeof useWrittenHost> | null } = { host: null };
    function Host({ route, pair }: { route: "today" | "written" | "hidden"; pair: "ru" | "uk" }) {
      const host = useWrittenHost({ access: f.access(), transport: f.transport, storage: f.storage, newId: f.newId, language: "ru",
        settings: confirmedSettings(pair, f.access().profile.state_version), initialSessionId: null, route, onWritten, onToday });
      seen.host = host;
      return <>{host.screen}</>;
    }
    const view = render(<Host route="written" pair="ru" />);
    await waitFor(() => expect(seen.host?.canRequestStart).toBe(true));
    act(() => seen.host!.requestStart("words"));
    await screen.findByText("слово 6");
    await waitFor(() => expect((screen.getByRole("textbox") as HTMLTextAreaElement).readOnly).toBe(false));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Haus" } });
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    await screen.findByText("Верно");
    // Settings of this window save the new pair: the server closes the quiz and the profile carries the new pair.
    view.rerender(<Host route="hidden" pair="ru" />);
    Object.assign(f.server.state, { status: "closed", closeReason: "pair_changed", assignment: null, version: f.server.state.version + 1 });
    f.replace({ profile: { ...profile(String(f.server.state.version)), dictionary_language: "uk" } });
    view.rerender(<Host route="today" pair="uk" />);
    await waitFor(() => expect(seen.host?.blocksToday).toBe(false));
    expect(onWritten).not.toHaveBeenCalled();
    expect(view.container.textContent).toBe("");
    expect(screen.queryByText("Занятие прервано.")).toBeNull();
    expect(f.posts().filter(post => post.kind === "session.stop")).toHaveLength(0);
  });
});
