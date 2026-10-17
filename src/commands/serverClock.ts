/**
 * The server's clock as this page can bound it (D-CP5 10.3, C556 В4, C572): the Date header of a successful answer and
 * the page's monotonic times when its request left and when its answer arrived. Date is whole seconds and is made at
 * some instant between those two times, so at any monotonic time t the server time lies in
 *   [ D + (t − received),  D + ACCURACY + (t − sent) ].
 * Every answer narrows that interval; the tightest bounds of all answers are kept. A pause between owners is never
 * shortened by the delivery time or by the rounding: a loss is written by the upper bound, the time since it is read by
 * the lower one. No answer with a readable Date, or bounds that contradict each other: the server time is unknown (null)
 * — never the device clock (Q35.2 А, CON §6.1 п.4). Whether the header reaches the page is the live fact 10.4.1.
 */
export const SERVER_TIME_ACCURACY_MS = 1000;

export type ServerBounds = { lower: number; upper: number };
export type ServerClock = {
  /** The Date header of a successful answer, with the monotonic times its request left and its answer arrived. */
  observe(dateHeader: string | null, sentAt: number, receivedAt: number): void;
  /** The server time now as an interval (ms since the epoch), or null when it is unknown. */
  bounds(): ServerBounds | null;
};

export function createServerClock(monotonic: () => number = () => performance.now()): ServerClock {
  // lower(t) = t + low, upper(t) = t + high: the tightest offsets of all answers seen.
  let low: number | null = null, high: number | null = null;
  return {
    observe(dateHeader, sentAt, receivedAt) {
      if (dateHeader === null || !Number.isFinite(sentAt) || !Number.isFinite(receivedAt) || receivedAt < sentAt) return;
      const server = Date.parse(dateHeader);
      // A malformed header teaches nothing; the bounds learnt so far stay.
      if (!Number.isFinite(server) || server < 0) return;
      const answerLow = server - receivedAt, answerHigh = server + SERVER_TIME_ACCURACY_MS - sentAt;
      low = low === null ? answerLow : Math.max(low, answerLow);
      high = high === null ? answerHigh : Math.min(high, answerHigh);
    },
    bounds() {
      // A server clock that jumped makes the bounds contradict each other: then nothing is known.
      if (low === null || high === null || low > high) return null;
      const t = monotonic();
      return { lower: t + low, upper: t + high };
    },
  };
}

/** The server clock of this page (one JS realm): every transport of the page feeds it. */
export const pageServerClock: ServerClock = createServerClock();
