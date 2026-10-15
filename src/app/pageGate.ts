import { createAvailabilityClient, type Availability } from "../api/availability";
import type { HttpOptions } from "../api/http";
import { WriteGate } from "../commands/writeGate";

/**
 * How App makes the write gate of its page (P03 M-P03-3, RD-5): one WriteGate per page on the monotonic browser clock,
 * whose single probe is GET /api/v1/availability over the page's own transport. Production code never replaces these.
 * The App-level tests of other modules do (src/app/pageGate.test-support.ts): their synthetic cores serve no
 * availability route and their real timers cannot wait the 5 s of the series; the gate itself has its own tests.
 */
export const pageGate = {
  make(): WriteGate { return new WriteGate(); },
  probe(options: HttpOptions): () => Promise<Availability> { return createAvailabilityClient(options).probe; },
};
