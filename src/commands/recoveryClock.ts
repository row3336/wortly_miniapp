/** An opaque handle of one scheduled callback. */
export type RecoveryTimer = { readonly id: unknown };

/**
 * The time source of automatic recovery. now() is monotonic: pauses before a retry are measured from the loss of a
 * reply, and a wall-clock jump (a user changing the device time) must neither shorten nor stretch them (CT §6.1 п. 4).
 */
export interface RecoveryClock {
  now(): number;
  schedule(callback: () => void, delayMs: number): RecoveryTimer;
  cancel(timer: RecoveryTimer): void;
}

/** The browser clock. Timers of a hidden page may be throttled; the machine stops them in the background anyway. */
export const systemRecoveryClock: RecoveryClock = {
  now: () => performance.now(),
  schedule: (callback, delayMs) => ({ id: setTimeout(callback, delayMs) }),
  cancel: (timer) => clearTimeout(timer.id as ReturnType<typeof setTimeout>),
};
