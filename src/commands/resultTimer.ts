/** What a screen may show of the running timer: the shown result it belongs to and its length. */
export type ResultTimerView = { key: string; durationMs: number };

/**
 * The auto-advance timer of a result view. Every cancel starts a new generation, so a callback of an older arm never
 * acts, even if its clearTimeout raced it; a background (suspend) is just a cancel. The timer only signals the view:
 * it never submits, grades or confirms anything (К05-049).
 */
export class ResultTimer {
  private generation = 0;
  private handle: ReturnType<typeof setTimeout> | null = null;
  private value: ResultTimerView | null = null;

  cancel(): void {
    this.generation++;
    if (this.handle !== null) clearTimeout(this.handle);
    this.handle = null; this.value = null;
  }
  view(): ResultTimerView | null { return this.value && { ...this.value }; }
  /** Arm for the result named by base. guard.live is checked first and guard.due last, after the generation and key. */
  start(base: string, durationMs: number, guard: { live(): boolean; due(): boolean }, fire: () => void): void {
    const generation = this.generation;
    const key = `${base}:${generation}`;
    this.value = { key, durationMs };
    this.handle = setTimeout(() => {
      if (!guard.live() || generation !== this.generation || this.value?.key !== key || !guard.due()) return;
      this.handle = null; this.value = null;
      fire();
    }, durationMs);
  }
}
