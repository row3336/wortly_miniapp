/**
 * What a screen may show of the running timer: the shown result it belongs to and its length. After a pause of the same
 * result, durationMs is what is left and elapsedMs (only then) what was already spent of the original countdown (П02).
 */
export type ResultTimerView = { key: string; durationMs: number; elapsedMs?: number };

/**
 * The auto-advance timer of a result view. Every cancel starts a new generation, so a callback of an older arm never
 * acts, even if its clearTimeout raced it; a background (suspend) is just a cancel. The timer only signals the view:
 * it never submits, grades or confirms anything (К05-049).
 *
 * A pause is the one cancel that remembers the countdown: when the same result (same base) is armed again, the original
 * deadline continues instead of a full duration (П02). Any other cancel or arm forgets it.
 */
export class ResultTimer {
  private generation = 0;
  private handle: ReturnType<typeof setTimeout> | null = null;
  private value: ResultTimerView | null = null;
  private base: string | null = null;
  private dueAt = 0;
  /** The original length of the countdown, spent part included. */
  private totalMs = 0;
  private paused: { base: string; dueAt: number; totalMs: number } | null = null;

  cancel(): void {
    this.stop();
    this.paused = null;
  }
  /** Stop the running countdown but keep its deadline for the same result; nothing running keeps an earlier pause. */
  pause(): void {
    const running = this.value !== null && this.base !== null ? { base: this.base, dueAt: this.dueAt, totalMs: this.totalMs } : null;
    this.stop();
    if (running) this.paused = running;
  }
  /** Forget a pause that no arm has used (the view did not come back to the same result). */
  discardPause(): void { this.paused = null; }
  view(): ResultTimerView | null { return this.value && { ...this.value }; }
  /** Arm for the result named by base. guard.live is checked first and guard.due last, after the generation and key. */
  start(base: string, durationMs: number, guard: { live(): boolean; due(): boolean }, fire: () => void): void {
    // Arming the result that already runs continues it; this also ends the older callback's generation.
    if (this.value && this.base === base) this.pause();
    // Another result never leaves an older callback behind.
    else if (this.handle !== null) { clearTimeout(this.handle); this.handle = null; }
    const generation = this.generation;
    const key = `${base}:${generation}`;
    const left = this.paused?.base === base ? Math.max(0, this.paused.dueAt - Date.now()) : durationMs;
    // The remainder never exceeds the duration the current mode asks for; the cut part counts as spent.
    const remaining = Math.min(durationMs, left);
    const elapsed = this.paused?.base === base ? this.paused.totalMs - left : 0;
    this.paused = null;
    this.totalMs = remaining + elapsed;
    this.value = elapsed > 0 ? { key, durationMs: remaining, elapsedMs: elapsed } : { key, durationMs: remaining };
    this.base = base; this.dueAt = Date.now() + remaining;
    this.handle = setTimeout(() => {
      if (!guard.live() || generation !== this.generation || this.value?.key !== key || !guard.due()) return;
      this.handle = null; this.value = null; this.base = null;
      fire();
    }, remaining);
  }
  private stop(): void {
    this.generation++;
    if (this.handle !== null) clearTimeout(this.handle);
    this.handle = null; this.value = null; this.base = null;
  }
}
