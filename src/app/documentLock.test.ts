import { describe, expect, it, vi } from "vitest";
import { browserDocumentLock } from "./documentLock";

describe("document Web Lock", () => {
  it("reports a lock held by another tab as busy", async () => {
    const request = vi.fn(async (_name: string, _options: unknown, callback: (lock: Lock | null) => Promise<void>) => callback(null));
    const nav = { locks: { request } } as unknown as Navigator;
    expect(await browserDocumentLock(nav).acquire("profile-id")).toBe("busy");
  });

  it("keeps the lock until the document releases it", async () => {
    let released = false;
    const request = vi.fn(async (_name: string, _options: unknown, callback: (lock: Lock | null) => Promise<void>) => {
      await callback({} as Lock);
      released = true;
    });
    const nav = { locks: { request } } as unknown as Navigator;
    const lease = await browserDocumentLock(nav).acquire("profile-id");
    expect(lease).not.toBe("busy");
    expect(released).toBe(false);
    if (typeof lease === "object") lease.release();
    await vi.waitFor(() => expect(released).toBe(true));
  });
});
