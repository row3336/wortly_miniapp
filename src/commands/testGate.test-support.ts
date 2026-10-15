import { WriteGate } from "./writeGate";
import { ManualClock } from "./writeGate.test-support";

/**
 * The write gate of a test that is not about the gate (HttpOptions.gate is required, RD-7 п.1): a real gate with a
 * manual clock, so it starts no timer. One gate per test file.
 */
const shared = new WriteGate({ clock: new ManualClock() });

export function testGate(): WriteGate { return shared; }
