import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthResponse, OpenedClient, Profile } from "../api/generated";
import { EntryApiError, type EntryApi } from "../api/entryApi";
import { testGate } from "../commands/testGate.test-support";
import type { DocumentLock } from "../app/documentLock";
import { EntryController } from "../app/entryController";
import { EntryScreen } from "../app/EntryScreen";
import { deletionCheckResult, DeletionNotice } from "./DeletionNotice";
import { profileDeleteCopy } from "./profileDeleteCopy";
import { memoryStorage } from "./profileStorage.test-support";

afterEach(cleanup);
const X = "11111111-1111-4111-8111-111111111111", Y = "66666666-6666-4666-8666-666666666666";
const ids = () => ["22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555"];

function profile(status: "admitted" | "pending" | "rejected", profileId = X): Profile {
  return { profile_id: profileId, access: { status, version: "3", reason: null }, role: "user", ui_language: "ru",
    dictionary_language: "ru", time_zone: null, state_version: "9" };
}
const auth = (status: "admitted" | "pending" | "rejected", profileId = X): AuthResponse => ({ access_token: "token",
  expires_at: "2026-10-16T12:00:00Z", profile: profile(status, profileId), compatibility: { compatible: true, contract_version: "1" } });
const opened = (): OpenedClient => ({ status: "opened", client_instance_id: ids()[0], document_id: ids()[2], document_epoch: "1",
  proof_version: "1", profile: profile("admitted"), session: null, compatibility: { compatible: true, contract_version: "1" } });

function entry(status: "admitted" | "rejected" = "admitted", laterOpens: Array<() => Promise<OpenedClient>> = []) {
  const { storage, values } = memoryStorage();
  const states: string[] = [];
  const queue = ids();
  const api: EntryApi = {
    auth: vi.fn(async () => auth(status)),
    reapply: vi.fn(async () => { throw new EntryApiError("http", 403, "PROFILE_DELETED"); }),
    register: vi.fn(async () => ({ client_instance_id: ids()[0], status: "registered" as const, origin_proof: "proof", proof_version: "1", activated: false })),
    open: vi.fn(async () => { const next = laterOpens.shift(); return next ? next() : opened(); }),
  };
  const lock: DocumentLock = { acquire: vi.fn(async () => ({ release: vi.fn() })) };
  const controller = new EntryController({ gate: testGate(), api, storage, lock, initData: "signed", savedLanguage: "ru",
    browserLanguage: "ru", clientVersion: "0.0.0", contractVersion: "1", timeZone: () => "UTC",
    newId: () => queue.shift() ?? "77777777-7777-4777-8777-777777777777", onUpdate: ({ state }) => { states.push(state.kind); } });
  return { controller, api, states, values };
}

describe("the entry after a deletion (P04 §8): no automatic sign-in", () => {
  it("PROFILE_DELETED on the refusal screen (the reapply after a manual deletion): the result, the records of X go, no sign-in", async () => {
    const t = entry("rejected");
    await t.controller.start();
    expect(t.states.at(-1)).toBe("rejected");
    await t.controller.reapply();
    expect(t.states.at(-1)).toBe("profile_deleted");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect([...t.values.keys()].filter(key => key.includes(X))).toEqual([]);
    await t.controller.foreground();
    expect(t.api.auth).toHaveBeenCalledTimes(1);
  });

  it("deleted from the screen: profile_deleted; a later foreground opens nothing and signs in nothing", async () => {
    const t = entry();
    await t.controller.start();
    expect(t.states.at(-1)).toBe("opened");
    expect(t.values.has(`wortly.installation:${X}`)).toBe(true);
    t.controller.endAfterDeletion({ kind: "deleted" });
    expect(t.states.at(-1)).toBe("profile_deleted");
    expect(t.controller.getOpenedAccess()).toBeNull();
    await t.controller.foreground();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(t.api.auth).toHaveBeenCalledTimes(1);
    expect(t.api.open).toHaveBeenCalledTimes(1);
    expect(t.values.has(`wortly.installation:${X}`)).toBe(false);
  });

  it("an unknown outcome (PD-28): deletion_unknown, the sign-in only on the explicit start()", async () => {
    const t = entry();
    await t.controller.start();
    t.controller.endAfterDeletion({ kind: "unknown", confirmedProfileId: X });
    expect(t.states.at(-1)).toBe("deletion_unknown");
    await t.controller.foreground();
    expect(t.api.auth).toHaveBeenCalledTimes(1);
    // The records of X stay: nothing proves the deletion yet.
    expect(t.values.has(`wortly.installation:${X}`)).toBe(true);
    await t.controller.start();
    expect(t.api.auth).toHaveBeenCalledTimes(2);
  });

  it.each([["deleted", "profile_deleted"], ["unknown", "deletion_unknown"]] as const)(
    "a foreground whose /client/open answers only after the end (%s) reopens nothing and signs in nothing", async (kind, state) => {
      let answer!: (value: OpenedClient) => void;
      const t = entry("admitted");
      await t.controller.start();
      // The next open (the foreground) hangs until the deletion has ended the document.
      (t.api.open as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise<OpenedClient>(resolve => { answer = resolve; }));
      const foreground = t.controller.foreground();
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(t.api.open).toHaveBeenCalledTimes(2);
      t.controller.endAfterDeletion(kind === "deleted" ? { kind } : { kind, confirmedProfileId: X });
      answer(opened());
      await foreground;
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(t.states.at(-1)).toBe(state);
      expect(t.states.filter(s => s === "opened")).toHaveLength(1);
      expect(t.controller.getOpenedAccess()).toBeNull();
      expect(t.api.auth).toHaveBeenCalledTimes(1);
    });

  it("AUTH_* on the first attempt: the ordinary expired screen", async () => {
    const t = entry();
    await t.controller.start();
    t.controller.endAfterDeletion({ kind: "expired" });
    expect(t.states.at(-1)).toBe("expired");
  });
});

describe("PD-28 after the explicit sign-in", () => {
  const snapshot = (kind: "checking" | "pending" | "opening" | "deletion_unknown", profileId?: string) =>
    ({ state: { kind }, ...(profileId ? { profile: profile("pending", profileId) } : {}) }) as Parameters<typeof deletionCheckResult>[1];
  it("another profile_id: deleted; the same: not deleted; no profile yet: undecided", () => {
    expect(deletionCheckResult(X, snapshot("pending", Y))).toBe("deleted");
    expect(deletionCheckResult(X, snapshot("opening", X.toUpperCase()))).toBe("not_deleted");
    expect(deletionCheckResult(X, snapshot("checking"))).toBeNull();
    expect(deletionCheckResult(X, snapshot("deletion_unknown", X))).toBeNull();
    expect(deletionCheckResult(null, snapshot("pending", Y))).toBeNull();
  });
  it("the notice has only «Продолжить»", () => {
    const onContinue = vi.fn();
    render(<DeletionNotice kind="deleted" language="ru" onContinue={onContinue} />);
    expect(screen.getByText("Прежний профиль удалён из приложения.")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Продолжить" }));
    expect(onContinue).toHaveBeenCalledOnce();
  });
});

describe("the screens of the entry", () => {
  it("S-A07: the TZA:313 result, no button (no sign-in from here)", () => {
    render(<EntryScreen state={{ kind: "profile_deleted" }} language="ru" onRetry={vi.fn()} onLogin={vi.fn()} />);
    expect(screen.getByText("Профиль удалён из приложения. Архивные копии ещё обрабатываются — до 7 дней.")).toBeDefined();
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("PD-28: «исход неизвестен» and the explicit sign-in", () => {
    const onLogin = vi.fn();
    render(<EntryScreen state={{ kind: "deletion_unknown" }} language="en" onLogin={onLogin} />);
    expect(screen.getByText("Deletion outcome unknown")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(onLogin).toHaveBeenCalledOnce();
  });
  it("no text says the deletion is complete before the archive (S-A07, И15)", () => {
    for (const copy of Object.values(profileDeleteCopy)) {
      for (const value of Object.values(copy)) {
        if (typeof value === "string") expect(value).not.toMatch(/полностью|повністю|fully|completely/i);
      }
    }
  });
});
