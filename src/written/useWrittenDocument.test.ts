// Which resume seed only addresses the written owner instead of re-creating it (D-23 trace 5.4).
import { describe, expect, it } from "vitest";
import { leadsSession } from "./useWrittenDocument";
import type { WrittenViewSnapshot } from "./writtenViewController";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const owner = (sessionId: string | null) => ({ snapshot: () => ({ sessionId }) as WrittenViewSnapshot });

describe("written owner seed", () => {
  it("only the session the owner already leads is kept, whatever the letter case of its ID", () => {
    expect(leadsSession(owner(id(3)), id(3))).toBe(true);
    expect(leadsSession(owner(id(3).toUpperCase()), id(3))).toBe(true);
    expect(leadsSession(owner(id(3)), id(5))).toBe(false);
    expect(leadsSession(owner(null), id(3))).toBe(false);
  });
  it("compares IDs with hex letters regardless of their case", () => {
    const lower = "abcdefab-cdef-4abc-8def-abcdefabcdef";
    expect(leadsSession(owner(lower), lower.toUpperCase())).toBe(true);
    expect(leadsSession(owner(lower.toUpperCase()), lower)).toBe(true);
    expect(leadsSession(owner(lower), "abcdefab-cdef-4abc-8def-abcdefabcdee")).toBe(false);
  });
});
