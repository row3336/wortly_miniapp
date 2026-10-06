import { describe, expect, it, vi } from "vitest";
import { browserDocumentLock } from "./documentLock";

type Callback = (lock: Lock | null) => Promise<void>;

/** navigator.locks of one browser profile, as far as the document lock uses it: every request steals. */
function locks() {
  const holders = new Map<string, (error: Error) => void>();
  const request = vi.fn((name: string, _options: LockOptions, callback: Callback) => new Promise<void>((resolve, reject) => {
    holders.get(name)?.(new DOMException("stolen", "AbortError"));
    holders.set(name, reject);
    void callback({ name, mode: "exclusive" } as Lock).then(() => {
      if (holders.get(name) === reject) holders.delete(name);
      resolve();
    });
  }));
  return { nav: { locks: { request } } as unknown as Navigator, request, holders };
}

describe("document Web Lock", () => {
  it("never waits: it steals the lock of the installation's document and keeps it until released", async () => {
    const l = locks();
    const lost = vi.fn();
    const lease = await browserDocumentLock(l.nav).acquire("profile:client", lost);
    expect(l.request).toHaveBeenCalledWith("wortly-document:profile:client", { steal: true }, expect.any(Function));
    expect(lease).not.toBe("unsupported");
    expect(l.holders.has("wortly-document:profile:client")).toBe(true);
    if (typeof lease === "object") lease.release();
    await vi.waitFor(() => expect(l.holders.size).toBe(0));
    expect(lost).not.toHaveBeenCalled();
  });

  it("tells the older window at once when a newer one takes the lock", async () => {
    const l = locks();
    const older = vi.fn(), newer = vi.fn();
    await browserDocumentLock(l.nav).acquire("profile:client", older);
    const lease = await browserDocumentLock(l.nav).acquire("profile:client", newer);
    await vi.waitFor(() => expect(older).toHaveBeenCalledOnce());
    expect(newer).not.toHaveBeenCalled();
    expect(lease).not.toBe("unsupported");
  });

  it("windows of another installation keep their own lock", async () => {
    const l = locks();
    const other = vi.fn();
    await browserDocumentLock(l.nav).acquire("profile:other-client", other);
    await browserDocumentLock(l.nav).acquire("profile:client", vi.fn());
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(other).not.toHaveBeenCalled();
  });

  it("without Web Locks, or when the request fails before a grant, there is no lock and no loss", async () => {
    const lost = vi.fn();
    expect(await browserDocumentLock({} as Navigator).acquire("profile:client", lost)).toBe("unsupported");
    const request = vi.fn(async () => { throw new DOMException("denied", "SecurityError"); });
    expect(await browserDocumentLock({ locks: { request } } as unknown as Navigator).acquire("profile:client", lost)).toBe("unsupported");
    expect(lost).not.toHaveBeenCalled();
  });
});
