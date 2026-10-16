import type { Availability } from "../api/availability";
import type { RecoveryClock } from "../commands/recoveryClock";
import { WriteGate } from "../commands/writeGate";
import { pageGate } from "./pageGate";

/** 100× faster than the browser clock: the 5/10/20/30 s of the series and an announced hold pass in tens of ms. */
const fast: RecoveryClock = {
  now: () => performance.now() * 100,
  schedule: (callback, delayMs) => ({ id: setTimeout(callback, delayMs / 100) }),
  cancel: timer => clearTimeout(timer.id as ReturnType<typeof setTimeout>),
};

/**
 * The page gate of the App tests (vitest setup): a real WriteGate — L2, R6, the observer and its closings work — on a fast
 * clock, whose probe says ready (the synthetic cores have no availability route). So a lost connection in an App test
 * closes writes for a moment and opens them again, as the gate does after a real outage, without waiting real seconds.
 */
let latest: WriteGate | null = null;
let pageProbeAnswer: Availability = { status: "ready" };

/** The page gate of the App mounted last (a test of the gate's facts reads its snapshot). */
export function latestPageGate(): WriteGate | null { return latest; }

/** What the availability probe of the App under test answers (ready by default); a test of an outage sets unknown. */
export function setPageProbe(answer: Availability): void { pageProbeAnswer = answer; }

export function installTestPageGate(): void {
  pageGate.make = () => (latest = new WriteGate({ clock: fast }));
  pageGate.probe = () => async () => pageProbeAnswer;
}

/**
 * Resolves once the page gate of the App under test lets a write through again (ready after a closure, the announced
 * hold over): an App test presses a button only then, as P03 asks of the user (M01, I9).
 */
export async function pageGateOpen(): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (!(latest?.mayWrite() ?? true)) {
    if (performance.now() > deadline) throw new Error("the page gate did not open");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
