// C163 integration — the bounded C423 set at the App level (store canon ред.1.4 §5, §9): the real App over the product
// installation store. noIDB (the IndexedDB API reliably absent) + a valid six-field activated A in localStorage → the
// existing open, the P04 deletion reachable, 0 register, 0 installation writes; noIDB + a record that is pending /
// invalid / without a proof / of another profile → 0 open; a temporary IndexedDB failure with a valid legacy A → 0
// localStorage fallback, 0 open.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Profile, SettingsResponse, TodayResponse } from "../api/generated";
import { App } from "./App";
import { withJournalIntake } from "../journal/intake.test-support";
import { settingsResponse } from "../settings/settingsRead.test-support";
import { installationProvider } from "./installationProvider";
import { idbInstallationStore } from "./installationStoreIdb";
import { installationKey } from "./installationStore";
import { FakeIndexedDb } from "../commands/idbFake.test-support";
import { upgradeWrites } from "./installationIdb.test-support";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const X = id(1);
const A = { profileId: X, clientInstanceId: id(11), registrationId: id(12), proof: "proof-a", proofVersion: "1", activated: true };

function core(status: "admitted" | "pending" = "admitted") {
  const profile: Profile = { profile_id: X, access: { status, version: "1", reason: null }, role: "user", ui_language: "ru",
    dictionary_language: "uk", time_zone: "UTC", state_version: "10" };
  const data: SettingsResponse = settingsResponse();
  data.state_version = "10";
  data.settings.dictionary_language = { value: "uk", version: "2" };
  data.constraints.dictionary_language = { type: "enum", values: ["uk"] };
  const proofs: (string | null)[] = [];
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url), body = init?.body ? JSON.parse(init.body as string) : null;
    if (path.endsWith("/auth/telegram")) return json({ access_token: "token-x", expires_at: "2026-10-16T12:00:00Z", profile,
      compatibility: { compatible: true, contract_version: "1" } });
    if (path.endsWith("/client/register")) return json({ client_instance_id: body.client_instance_id, status: "registered",
      origin_proof: "proof-new", proof_version: "1", activated: false });
    if (path.endsWith("/client/open")) {
      proofs.push(new Headers(init?.headers).get("X-Origin-Proof"));
      return json({ status: "opened", profile, compatibility: { compatible: true, contract_version: "1" },
        client_instance_id: body.client_instance_id, document_id: body.document_id, proof_version: "1", document_epoch: "1", session: null });
    }
    if (path.endsWith("/today")) return json({ state_version: "10", pair: "uk-de", local_date: "2026-10-16", status: "no_material",
      base: { total: 0, words: 0, phrases: 0 }, ordinary_status: "done",
      ordinary: { words: { "l1-de": { ready: 0, next_due_date: null }, "de-l1": { ready: 0, next_due_date: null } },
        phrases: { "l1-de": { ready: 0, next_due_date: null }, "de-l1": { ready: 0, next_due_date: null } } },
      learning: { status: "no_material", ready: 0, preview: 0, next_due_at: null, new_group_size: 0, manual_eligible: 0,
        automatic_eligible: 0 }, conjugation: { ready: 0, openable: 0, next_due_date: null }, next_repeat_date: null } satisfies TodayResponse);
    if (path.endsWith("/settings/topics")) return json({ topics: [], state_version: "10" });
    if (path.endsWith("/settings")) return json(data);
    if (path.endsWith("/profile/delete")) return json({
      command: { id: body.command_id, kind: "profile.delete", status: "applied", applied_at: "2026-10-16T10:00:00Z" },
      deletion: { request_id: id(900), working_data: "deleted", archive: "pending", archive_deadline: "2026-10-23T10:00:00Z", fully_deleted: false },
      session: "revoked" });
    throw new Error(`Unexpected synthetic endpoint ${path}`);
  });
  vi.stubGlobal("fetch", withJournalIntake(fetcher));
  vi.stubGlobal("Telegram", { WebApp: { initData: "synthetic-init-data", initDataUnsafe: { user: { language_code: "ru" } },
    colorScheme: "light", HapticFeedback: { notificationOccurred: vi.fn() } } });
  return { fetcher, proofs, calls: (suffix: string) => fetcher.mock.calls.filter(([url]) => String(url).endsWith(suffix)).length };
}

/** localStorage writes of the installation key, watched on the Storage prototype jsdom uses. */
function watchInstallationWrites() {
  const writes: string[] = [];
  const set = Storage.prototype.setItem, remove = Storage.prototype.removeItem;
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key: string, value: string) {
    if (key.startsWith(installationKey(""))) writes.push(`set ${key}`);
    return set.call(this, key, value);
  });
  vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function (this: Storage, key: string) {
    if (key.startsWith(installationKey(""))) writes.push(`remove ${key}`);
    return remove.call(this, key);
  });
  return writes;
}

const make = installationProvider.make;
beforeEach(() => {
  localStorage.clear();
  vi.stubEnv("VITE_WORTLY_TIMEOUT_MS", "3000"); vi.stubEnv("VITE_WORTLY_MAX_RESPONSE_BYTES", "20000");
  vi.stubEnv("VITE_WORTLY_API_BASE_URL", "");
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); localStorage.clear(); installationProvider.make = make; });

describe("C423 at the App: the IndexedDB API reliably absent (store canon §5)", () => {
  beforeEach(() => { installationProvider.make = () => idbInstallationStore(undefined, () => window.localStorage); });

  it("a valid six-field activated A: the existing open with its proof, P04 deletion reachable, 0 register, 0 installation writes", async () => {
    localStorage.setItem(installationKey(X), JSON.stringify(A));
    const c = core();
    const writes = watchInstallationWrites();
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Настройки" }, { timeout: 5_000 }));
    expect(c.calls("/client/register")).toBe(0);
    expect(c.proofs).toEqual(["proof-a"]);
    expect(writes).toEqual([]);
    fireEvent.click(await screen.findByRole("button", { name: "Удалить профиль" }, { timeout: 5_000 }));
    const confirm = screen.getByRole("button", { name: "Удалить навсегда" });
    await waitFor(() => expect(confirm.hasAttribute("disabled")).toBe(false), { timeout: 7_000 });
    fireEvent.click(confirm);
    await screen.findByText("Профиль удалён из приложения. Архивные копии ещё обрабатываются — до 7 дней.", {}, { timeout: 3_000 });
    expect(c.calls("/profile/delete")).toBe(1);
    expect(c.calls("/client/register")).toBe(0);
    // No installation write by the store; only the P04 cleanup removes the local records of X afterwards.
    expect(writes.filter(entry => entry.startsWith("set"))).toEqual([]);
  }, 30_000);

  it.each([
    ["not activated", JSON.stringify({ ...A, activated: false })],
    ["without a proof", JSON.stringify({ ...A, proof: null, proofVersion: null })],
    ["invalid", "{broken"],
    ["of another profile", JSON.stringify({ ...A, profileId: id(2) })],
  ])("a legacy record %s: no register, no open", async (_n, value) => {
    localStorage.setItem(installationKey(X), value);
    const c = core();
    render(<App />);
    await screen.findByRole("heading", { name: "Не удалось открыть Wortly" }, { timeout: 5_000 });
    expect(c.calls("/client/register")).toBe(0); expect(c.calls("/client/open")).toBe(0);
    expect(localStorage.getItem(installationKey(X))).toBe(value);
  }, 20_000);

  it("a pending profile: its own screen, no open", async () => {
    localStorage.setItem(installationKey(X), JSON.stringify(A));
    const c = core("pending");
    render(<App />);
    await screen.findByRole("heading", { name: "Заявка отправлена" }, { timeout: 5_000 });
    expect(c.calls("/client/open")).toBe(0); expect(c.calls("/client/register")).toBe(0);
  }, 20_000);
});

describe("C423 at the App: a temporary IndexedDB failure with a valid legacy A", () => {
  it("the database does not open: unavailable — no localStorage fallback, no register, no open", async () => {
    const fake = new FakeIndexedDb();
    fake.openBehaviour = "error";
    installationProvider.make = () => idbInstallationStore(upgradeWrites(fake), () => window.localStorage);
    localStorage.setItem(installationKey(X), JSON.stringify(A));
    const c = core();
    render(<App />);
    await screen.findByRole("heading", { name: "Не удалось открыть Wortly" }, { timeout: 5_000 });
    expect(c.calls("/client/register")).toBe(0); expect(c.calls("/client/open")).toBe(0);
  }, 20_000);
});
