import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenedClient, Profile } from "../api/generated";
import { createOpenedAccess } from "../app/openedAccess";
import type { SettingsDocument } from "../settings/useSettingsDocument";
import { useWrittenHost } from "./useWrittenHost";
import { settingsRefusalText } from "./writtenApp.test-support";

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
