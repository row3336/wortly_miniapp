import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AuthResponse, Profile } from "../api/generated";
import { createEntryApi, EntryApiError, type EntryApi } from "../api/entryApi";
import { t } from "../i18n/messages";
import type { AsyncStorage } from "../platform/storage";
import { EntryController } from "./entryController";
import { EntryScreen } from "./EntryScreen";
import type { EntryState } from "./entryState";
import { testGate } from "../commands/testGate.test-support";

// After two refusals the core closes reapplication (CT §6.3): the refusal screen says so without a reapply
// button, and a 403 ACCESS_REJECTED to a reapply lands there too instead of looping through "unavailable".

const profileId = "11111111-1111-4111-8111-111111111111";
const reapplyKey = `wortly.reapply:${profileId}`;

function rejected(reapplyClosed?: boolean): Profile {
  const profile: Profile = {
    profile_id: profileId, access: { status: "rejected", version: "4", reason: "Second review" },
    role: "user", ui_language: "ru", dictionary_language: "ru", time_zone: null, state_version: "7",
  };
  return reapplyClosed === undefined ? profile : { ...profile, reapply_closed: reapplyClosed };
}

function fixture(profile: Profile) {
  const values = new Map<string, string>();
  const storage: AsyncStorage = {
    async get(key) { return values.get(key) ?? null; },
    async set(key, value) { values.set(key, value); },
    async remove(key) { values.delete(key); },
  };
  const states: EntryState[] = [];
  const auth: AuthResponse = { access_token: "memory-token", expires_at: "2026-10-01T00:00:00Z", profile,
    compatibility: { compatible: true, contract_version: "1" } };
  const api: EntryApi = {
    auth: vi.fn(async () => auth),
    reapply: vi.fn(async () => { throw new EntryApiError("http", 403, "ACCESS_REJECTED"); }),
    register: vi.fn(async () => { throw new Error("not expected"); }),
    open: vi.fn(async () => { throw new Error("not expected"); }),
  };
  let id = 0;
  const controller = new EntryController({
    api, storage, lock: { acquire: vi.fn(async () => ({ release: vi.fn() })) },
    initData: "signed-Telegram-data", savedLanguage: "ru", browserLanguage: "ru-RU",
    clientVersion: "0.0.0", contractVersion: "1", timeZone: () => "Europe/Berlin",
    newId: () => `55555555-5555-4555-8555-55555555555${id++}`,
    onUpdate: ({ state }) => { states.push(state); },
  });
  return { controller, api, states, values };
}

describe("closed reapplication: entry controller", () => {
  it("shows the closed refusal from reapply_closed and never sends a reapply", async () => {
    const f = fixture(rejected(true));
    await f.controller.start();
    expect(f.states.at(-1)).toEqual({ kind: "rejected", reason: "Second review", closed: true });
    await f.controller.reapply();
    expect(f.api.reapply).not.toHaveBeenCalled();
    expect(f.states.at(-1)).toEqual({ kind: "rejected", reason: "Second review", closed: true });
  });

  it.each([undefined, false])("keeps the reapply open when reapply_closed is %s", async flag => {
    const f = fixture(rejected(flag));
    await f.controller.start();
    expect(f.states.at(-1)).toEqual({ kind: "rejected", reason: "Second review" });
  });

  it("turns a 403 ACCESS_REJECTED to a reapply into the closed refusal, without a loop", async () => {
    // An older core sends no reapply_closed, so the button is shown once and the core's 403 closes it.
    const f = fixture(rejected());
    await f.controller.start();
    await f.controller.reapply();
    expect(f.states.map(state => state.kind).slice(-2)).toEqual(["reapplying", "rejected"]);
    expect(f.states.at(-1)).toEqual({ kind: "rejected", reason: "Second review", closed: true });
    expect(f.states.some(state => state.kind === "unavailable")).toBe(false);
    expect(f.values.has(reapplyKey)).toBe(false);
    // Neither another tap nor a new check of the same old-core profile offers or sends a reapply again.
    await f.controller.reapply();
    await f.controller.retry();
    await f.controller.reapply();
    expect(f.api.reapply).toHaveBeenCalledOnce();
    expect(f.states.at(-1)).toEqual({ kind: "rejected", reason: "Second review", closed: true });
    expect(f.states.some(state => state.kind === "unavailable")).toBe(false);
  });

  it("still treats a 403 with another code as a failure, not as closed", async () => {
    const f = fixture(rejected());
    vi.mocked(f.api.reapply).mockRejectedValueOnce(new EntryApiError("http", 403, "FORBIDDEN"));
    await f.controller.start();
    await f.controller.reapply();
    expect(f.states.at(-1)).toEqual({ kind: "unavailable" });
  });
});

describe("closed reapplication: entry screen", () => {
  it.each(["ru", "uk", "en"] as const)("shows the calm closed text without a reapply button in %s", language => {
    const copy = t(language);
    const html = renderToStaticMarkup(<EntryScreen language={language} onReapply={() => {}} onRetry={() => {}}
      state={{ kind: "rejected", reason: "Second review", closed: true }} />);
    expect(html).toContain(copy.rejectedClosed);
    expect(html).toContain(copy.rejectedClosedDetail);
    expect(html).toContain("Second review");
    // The closed detail may quote the button's words, so the label is checked as a whole element text.
    expect(html).not.toContain(`>${copy.reapply}<`);
    expect(html).not.toContain(copy.rejectedDetail);
    expect(html).not.toContain("<button");
  });

  it("keeps the reapply button on an open refusal", () => {
    const html = renderToStaticMarkup(<EntryScreen language="ru" onReapply={() => {}}
      state={{ kind: "rejected" }} />);
    expect(html).toContain(t("ru").reapply);
  });

  it.each(["ru", "uk", "en"] as const)("has non-empty closed texts in %s", language => {
    const copy = t(language);
    expect(copy.rejectedClosed.trim()).not.toBe("");
    expect(copy.rejectedClosedDetail.trim()).not.toBe("");
    expect(copy.rejectedClosed).not.toBe(copy.rejected);
  });
});

describe("closed reapplication: profile decoder", () => {
  function respondingWith(profile: unknown) {
    return createEntryApi({
      fetcher: vi.fn(async () => new Response(JSON.stringify({ access_token: "token",
        expires_at: "2026-10-01T00:00:00Z", profile, compatibility: { compatible: true, contract_version: "1" } })),
      ) as typeof fetch,
      timeoutMs: 1000, maxResponseBytes: 10000, gate: testGate(),
    });
  }
  const request = { init_data: "synthetic", client_version: "0.0.0", contract_version: "1" };

  it("accepts an older core's profile without reapply_closed", async () => {
    const { reapply_closed: absent, ...old } = rejected(true);
    expect(absent).toBe(true);
    const auth = await respondingWith(old).auth(request);
    expect(auth.profile.reapply_closed).toBeUndefined();
  });

  it.each([true, false])("accepts reapply_closed %s", async flag => {
    expect((await respondingWith(rejected(flag)).auth(request)).profile.reapply_closed).toBe(flag);
  });

  it.each(["yes", 1, null])("rejects a malformed reapply_closed %j", async value => {
    await expect(respondingWith({ ...rejected(), reapply_closed: value }).auth(request))
      .rejects.toMatchObject({ kind: "invalid_response" });
  });
});
