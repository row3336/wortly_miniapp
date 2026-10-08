/** The first send plus five retries of one command_id over its whole recovery (Я15.5, CT §6.1 п. 4). */
export const MAX_SENDS = 6;
/** Pauses before retries №1–№5 (Я15.6). */
export const RETRY_PAUSES_MS: readonly number[] = Object.freeze([2_000, 5_000, 10_000, 20_000, 30_000]);
/** Pauses before successive light probes while the server is unreachable: 5, 10, 20, then 30 s each (Я15.7). */
export const PROBE_DELAYS_MS: readonly number[] = Object.freeze([5_000, 10_000, 20_000, 30_000]);
