import { describe, expect, it, vi } from "vitest";
import type { OpenedClient } from "../api/generated";
import { ApiError } from "../api/http";
import { ClosedAccessError, createOpenedAccess } from "./openedAccess";

function opened(): OpenedClient {
  return { status: "opened", client_instance_id: "client", document_id: "document", document_epoch: "2", proof_version: "3",
    profile: { profile_id: "profile", access: { status: "admitted", version: "1", reason: null },
      role: "user", ui_language: "uk", dictionary_language: "en", time_zone: "UTC", state_version: "10" },
    session: { id: "session", phase: "summary" }, compatibility: { compatible: true, contract_version: "1" } };
}
function fixture() {
  let live = true;
  const onDenied = vi.fn();
  const response = opened();
  const access = createOpenedAccess({ opened: response, token: "synthetic-token", proof: "synthetic-proof",
    generation: 4, isLive: () => live, onDenied });
  return { access, onDenied, response, close: () => { live = false; } };
}

describe("opened document access", () => {
  it("exposes metadata and the exact active-session route without serializing credentials", async () => {
    const { access } = fixture();
    expect(access.session).toEqual({ id: "session", phase: "summary" });
    expect(access.document).toEqual({ clientInstanceId: "client", documentId: "document", epoch: "2" });
    expect(JSON.stringify(access)).not.toMatch(/synthetic-token|synthetic-proof|token|proof/);
    const operation = vi.fn(async credentials => { expect(credentials).toEqual({ token: "synthetic-token",
      proof: "synthetic-proof", clientInstanceId: "client", documentId: "document" }); return "result"; });
    await expect(access.run(operation)).resolves.toBe("result");
    expect(operation).toHaveBeenCalledOnce();
  });

  it("does not let callers mutate the confirmed profile or session", () => {
    const { access, response } = fixture();
    access.profile.access.status = "rejected";
    access.profile.dictionary_language = "ru";
    access.session!.id = "another";
    response.profile.profile_id = "changed-after-construction";
    expect(access.profile).toMatchObject({ profile_id: "profile", access: { status: "admitted" }, dictionary_language: "en" });
    expect(access.session?.id).toBe("session");
  });

  it("does not invoke an operation after the document has closed", async () => {
    const { access, close } = fixture(); close();
    const operation = vi.fn(async () => "should not run");
    await expect(access.run(operation)).rejects.toBeInstanceOf(ClosedAccessError);
    expect(operation).not.toHaveBeenCalled();
  });

  it.each(["success", "401", "403"])("ignores late %s after closing without revoking another context", async outcome => {
    const { access, close, onDenied } = fixture();
    let finish!: () => void;
    const pending = access.run(() => new Promise<string>((resolve, reject) => {
      finish = () => outcome === "success" ? resolve("old") : reject(new ApiError("http", Number(outcome)));
    }));
    close(); finish();
    await expect(pending).rejects.toBeInstanceOf(ClosedAccessError);
    expect(onDenied).not.toHaveBeenCalled();
  });

  it.each([401, 403])("notifies Entry of a current HTTP %s", async status => {
    const { access, onDenied } = fixture();
    const error = new ApiError("http", status);
    await expect(access.run(async () => { throw error; })).rejects.toBe(error);
    expect(onDenied).toHaveBeenCalledExactlyOnceWith(error);
  });

  it.each([new ApiError("network"), new ApiError("http", 503), new ApiError("invalid_response")])(
    "does not revoke access for a non-authentication error %#", async error => {
      const { access, onDenied } = fixture();
      await expect(access.run(async () => { throw error; })).rejects.toBe(error);
      expect(onDenied).not.toHaveBeenCalled(); expect(access.isLive()).toBe(true);
    });
});
