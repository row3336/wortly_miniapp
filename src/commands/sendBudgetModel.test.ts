import { describe, expect, it } from "vitest";
import {
  budgetVerdict, MemorySendBudget, summarize,
  type BudgetBinding, type BudgetIdentity, type BudgetSlot, type BudgetSummary, type BudgetVerdict, type SendBudgetRecord, type SlotClaim,
} from "./sendBudget";

/**
 * Exhaustive interleavings of the slot protocol on MemorySendBudget: a port of the F1-ATTEMPT-ID model
 * (root_cc_20261005/F1-ATTEMPT-ID/model.py, variant "attempt ID + no release after sending"; D-CP5 5.3.9–5.3.10).
 * Windows run attempts one after another; every store operation is one atomic step and the real request (fetch start)
 * is a separate step. An attempt may be abandoned after its request (cancel, unknown outcome), a window may crash once
 * in any held phase and goes on with its next attempt, and a finished attempt may fire a late release and a late mark at
 * any later moment. Earlier history is given as slots already transmitted.
 *
 * Checked in every reachable state: no more than six real sends (I1); no slot transmitted without a send and exhaustion
 * only with six real, transmitted sends (I2); a slot whose request has left is never freed or taken over (I3); no state
 * that may still send at six real sends (I4); no operation of one attempt changes a slot held by another (I5); once the
 * ban of C053 is set, no reservation, no gate and no "transmitted" goes through and the verdict is "forbidden" (I6);
 * after a refusal whose ban failed to commit, no reservation and no gate goes through (I7, C060). A sent attempt is
 * written "retryable" when its reply is lost; the model has no clear(): no failure path removes a record. Bounds of the proof are those of F1: one record, no reordered or lost
 * store operations, the store behaves as one queue.
 */

const COMMAND = "00000000-0000-4000-8000-000000000001";
const identity: BudgetIdentity = {
  commandId: COMMAND, profileId: "00000000-0000-4000-8000-0000000000a1", clientInstanceId: "00000000-0000-4000-8000-0000000000c1",
  pair: "ru-de", sessionId: "00000000-0000-4000-8000-0000000000e1", kind: "assignment.answer", intentHash: "a".repeat(64),
};
const SIX = 6;
const attemptId = (g: number) => `10000000-0000-4000-8000-${g.toString(16).padStart(12, "0")}`;
const HISTORY = 0x900; // attempts of the prefilled history

const NEW = 0, RESERVED = 1, SENDING = 2, FETCHED = 3, DONE = 4, MARKED = 5;
/** late: bits of the late events already fired (1 release, 2 mark, 4 retryable); refused: the server refused it. */
type Attempt = { phase: number; slot: number; late: number; fetched: boolean; refused?: boolean };
type Window = { next: number; crashed: boolean; current: number };
/** refused: a refusal arrived and its ban failed to commit (C060) — nothing in the store says so. */
/** damaged: the record was corrupted in storage (slots frozen at that moment); freed: a new start N released it. */
type State = { slots: BudgetSlot[]; windows: Window[]; attempts: Attempt[]; actual: number; banned: boolean; refused: boolean;
  damaged: boolean; freed: boolean };

/** The store operations the model drives; a broken store can be put in its place for the controls. */
type ModelStore = Pick<MemorySendBudget, "createAndReserve" | "reserve" | "beginSending" | "markTransmitted" | "markRetryable"
  | "release" | "forbidSends" | "seed" | "peek">;

/**
 * ban: a proven refusal of the server may set the ban of C053 at any moment, once. refuse: the answer to a transmitted
 * attempt may be a refusal whose ban fails to commit (C060).
 */
type Config = { attempts: number[]; prefill: number; late: "one" | "both"; crash?: boolean; ban?: boolean; refuse?: boolean;
  /** The record may be damaged at any moment, once, and then released by the explicit start of a new session (C073). */
  damage?: boolean };
type Options = {
  store?: () => ModelStore;
  verdict?: (summary: BudgetSummary | null) => BudgetVerdict;
  maxStates?: number;
  /** Controls stop at the first violation: finding one is the whole point. */
  stopOnViolation?: boolean;
};
type Report = { states: number; edges: number; maxActual: number; violations: string[]; complete: boolean };

function record(slots: BudgetSlot[], banned = false): SendBudgetRecord {
  return {
    schemaVersion: 1, ...identity, family: "primary",
    target: { field: "assignment_id", id: "00000000-0000-4000-8000-0000000000f1" }, slots,
    ...(banned ? { sendBan: true as const } : {}), createdAt: 0,
  };
}
/** The record as storage damage leaves it: one slot short, everything else intact. */
function damagedRecord(slots: BudgetSlot[], banned: boolean): Record<string, unknown> {
  return { ...record(slots, banned), slots: slots.slice(0, SIX - 1) };
}
const NEW_SESSION = "00000000-0000-4000-8000-0000000000e3";
const START: BudgetBinding = { ...identity, commandId: "00000000-0000-4000-8000-000000000009", sessionId: NEW_SESSION,
  kind: "session.start", family: "primary", target: { field: "session_id", id: NEW_SESSION } };

function key(state: State): string {
  const slots = state.slots.map(slot => "attempt" in slot ? `${slot.state.slice(0, 3)}${parseInt(slot.attempt.slice(24), 16)}` : slot.state.slice(0, 3));
  return JSON.stringify([slots, state.windows, state.attempts, state.actual, state.banned, state.refused, state.damaged, state.freed]);
}
function clone(state: State): State {
  return { slots: state.slots.map(slot => ({ ...slot })), windows: state.windows.map(w => ({ ...w })),
    attempts: state.attempts.map(a => ({ ...a })), actual: state.actual, banned: state.banned, refused: state.refused,
    damaged: state.damaged, freed: state.freed };
}

/** I5: an operation of attempt g changed a slot held by another attempt (C006: a late handler hits a foreign slot). */
function foreign(before: BudgetSlot[], after: BudgetSlot[], g: number): string | null {
  const hit = before.findIndex((slot, j) => "attempt" in slot && slot.attempt !== attemptId(g)
    && JSON.stringify(slot) !== JSON.stringify(after[j]));
  return hit < 0 ? null : `I5: attempt #${g} changed slot ${hit + 1} of another attempt`;
}

const SENT = ["transmitted", "retryable"];
/**
 * I6 (C053): after the ban no operation reserves, opens the gate or makes a slot transmitted or retryable.
 * I7 (C060): after a refusal whose ban failed, no operation reserves or opens the gate.
 */
function afterBan(state: State, after: BudgetSlot[], allowed: boolean): string | null {
  if (state.refused && !allowed) return "I7: a send step went through after a refusal whose ban failed";
  if (!state.banned) return null;
  const advanced = after.some((slot, j) => SENT.includes(slot.state) && slot.state !== state.slots[j].state);
  if (!allowed || advanced) return "I6: a send step went through after the ban";
  return null;
}

class Model {
  readonly owner: number[] = [];
  readonly first: number[] = [];
  private readonly store: ModelStore;
  private readonly makeStore: () => ModelStore;
  private readonly answers = new Map<string, { result: unknown; slots: BudgetSlot[] }>();
  private readonly verdicts = new Map<string, BudgetVerdict>();
  private readonly verdict: (summary: BudgetSummary | null) => BudgetVerdict;

  constructor(private readonly config: Config, options: Options) {
    let g = 0;
    config.attempts.forEach((count, window) => {
      this.first.push(g);
      for (let n = 0; n < count; n++) this.owner[g++] = window;
    });
    this.makeStore = options.store ?? (() => new MemorySendBudget());
    this.store = this.makeStore();
    this.verdict = options.verdict ?? budgetVerdict;
  }

  initial(): State {
    const slots: BudgetSlot[] = Array.from({ length: SIX }, (_, j) =>
      j < this.config.prefill ? { state: "retryable" as const, attempt: attemptId(HISTORY + j) } : { state: "empty" as const });
    return {
      slots, windows: this.config.attempts.map(() => ({ next: 0, crashed: false, current: -1 })),
      attempts: this.owner.map(() => ({ phase: NEW, slot: -1, late: 0, fetched: false })), actual: this.config.prefill,
      banned: false, refused: false, damaged: false, freed: false,
    };
  }

  /**
   * Runs one store operation on the state's record and returns the record after it. The store is deterministic, so the
   * answer for the same record and the same call is reused: many interleavings reach the same slots.
   */
  private async run<R>(state: State, call: string, operation: (store: ModelStore) => Promise<R>): Promise<{ result: R; slots: BudgetSlot[] }> {
    const id = `${JSON.stringify(state.slots)}|${state.banned}|${state.damaged}|${call}`;
    const known = this.answers.get(id);
    if (known) return { result: known.result as R, slots: known.slots.map(slot => ({ ...slot })) };
    if (state.damaged) {
      const damaged = damagedRecord(state.slots, state.banned);
      this.store.seed(COMMAND, damaged);
      const result = await operation(this.store);
      // I8: nothing writes over a damaged record, and nothing on it succeeds: no reservation, no gate, no mark.
      if (JSON.stringify(this.store.peek(COMMAND)) !== JSON.stringify(damaged)) throw new Error(`I8: ${call} changed the damaged record`);
      if (result === true || (typeof result === "object" && result !== null && (result as { outcome?: string }).outcome === "reserved")) {
        throw new Error(`I8: ${call} succeeded on the damaged record`);
      }
      this.answers.set(id, { result, slots: state.slots });
      return { result, slots: state.slots.map(slot => ({ ...slot })) };
    }
    this.store.seed(COMMAND, record(state.slots, state.banned));
    const result = await operation(this.store);
    const after = this.store.peek(COMMAND) as SendBudgetRecord;
    if ((after.sendBan === true) !== (state.banned || call === "forbid")) throw new Error(`the ban changed by ${call}`);
    const slots = after.slots;
    this.answers.set(id, { result, slots });
    return { result, slots: slots.map(slot => ({ ...slot })) };
  }

  /** Every move from the state: [label, next state, violation of the move itself]. */
  async moves(state: State): Promise<Array<[string, State, string | null]>> {
    const out: Array<[string, State, string | null]> = [];
    const claim = (g: number): SlotClaim => ({ slot: state.attempts[g].slot, attempt: attemptId(g) });

    for (let w = 0; w < state.windows.length; w++) {
      const window = state.windows[w];
      if (window.current === -1) {
        if (window.next >= this.config.attempts[w]) continue;
        const g = this.first[w] + window.next;
        const { result, slots } = await this.run(state, `reserve ${g}`, store => store.reserve(identity, attemptId(g)));
        const next = clone(state);
        next.slots = slots;
        next.windows[w].next++;
        if (result.outcome === "reserved") {
          next.attempts[g] = { phase: RESERVED, slot: result.claim.slot, late: 0, fetched: false };
          next.windows[w].current = g;
        } else {
          next.attempts[g] = { phase: DONE, slot: -1, late: 3, fetched: false };
        }
        out.push([`W${w}#${g}:reserve:${result.outcome}`, next,
          result.outcome === "unknown" && !state.damaged ? "record became unknown"
            : afterBan(state, slots, result.outcome !== "reserved") ?? foreign(state.slots, slots, g)]);
        continue;
      }
      const g = window.current;
      const attempt = state.attempts[g];
      const finish = (next: State) => { next.attempts[g].phase = DONE; next.windows[w].current = -1; return next; };
      if (attempt.phase === RESERVED) {
        const released = await this.run(state, `release ${g} ${state.attempts[g].slot}`, store => store.release(identity, claim(g)));
        out.push([`W${w}#${g}:release`, finish({ ...clone(state), slots: released.slots }), foreign(state.slots, released.slots, g)]);
        const sending = await this.run(state, `beginSending ${g} ${state.attempts[g].slot}`, store => store.beginSending(identity, claim(g)));
        const next = { ...clone(state), slots: sending.slots };
        if (sending.result) next.attempts[g].phase = SENDING;
        else finish(next);
        out.push([`W${w}#${g}:beginSending:${sending.result}`, next,
          afterBan(state, sending.slots, !sending.result) ?? foreign(state.slots, sending.slots, g)]);
      }
      if (attempt.phase === SENDING) {
        const next = clone(state);
        next.actual++;
        next.attempts[g].phase = FETCHED;
        next.attempts[g].fetched = true;
        out.push([`W${w}#${g}:FETCH`, next, state.actual >= SIX ? `I1: send #${state.actual + 1}` : null]);
      }
      if (attempt.phase === FETCHED) {
        const marked = await this.run(state, `markTransmitted ${g} ${state.attempts[g].slot}`, store => store.markTransmitted(identity, claim(g)));
        const next = { ...clone(state), slots: marked.slots };
        if (marked.result) next.attempts[g].phase = MARKED;
        else finish(next);
        out.push([`W${w}#${g}:mark`, next, afterBan(state, marked.slots, true) ?? foreign(state.slots, marked.slots, g)]);
        out.push([`W${w}#${g}:abandon`, finish(clone(state)), null]);
      }
      if (attempt.phase === MARKED) {
        // The reply was lost or allows a retry: the page writes it down.
        const settled = await this.run(state, `markRetryable ${g} ${state.attempts[g].slot}`, store => store.markRetryable(identity, claim(g)));
        out.push([`W${w}#${g}:retryable`, finish({ ...clone(state), slots: settled.slots }),
          afterBan(state, settled.slots, true) ?? foreign(state.slots, settled.slots, g)]);
        // Outcome never written (the page is gone, the answer unknown).
        out.push([`W${w}#${g}:abandon`, finish(clone(state)), null]);
        if (this.config.refuse) {
          const refused = finish(clone(state));
          refused.refused = true;
          refused.attempts[g].refused = true;
          out.push([`W${w}#${g}:REFUSED_BAN_FAILED`, refused, null]);
        }
      }
      if (this.config.crash !== false && !window.crashed && attempt.phase !== NEW && attempt.phase !== DONE) {
        const next = finish(clone(state));
        next.windows[w].crashed = true;
        out.push([`W${w}#${g}:CRASH`, next, null]);
      }
    }

    for (let g = 0; g < state.attempts.length; g++) {
      const attempt = state.attempts[g];
      if (attempt.phase !== DONE || attempt.slot < 0) continue;
      const allowed = this.config.late === "both" || attempt.late === 0;
      if ((attempt.late & 1) === 0 && allowed) {
        const released = await this.run(state, `release ${g} ${state.attempts[g].slot}`, store => store.release(identity, claim(g)));
        const next = { ...clone(state), slots: released.slots };
        next.attempts[g].late |= 1;
        out.push([`late#${g}:release`, next, foreign(state.slots, released.slots, g)]);
      }
      if (attempt.fetched && (attempt.late & 2) === 0 && allowed) {
        const marked = await this.run(state, `markTransmitted ${g} ${state.attempts[g].slot}`, store => store.markTransmitted(identity, claim(g)));
        const next = { ...clone(state), slots: marked.slots };
        next.attempts[g].late |= 2;
        out.push([`late#${g}:mark`, next, afterBan(state, marked.slots, true) ?? foreign(state.slots, marked.slots, g)]);
      }
      // A late loss handler; a refused attempt has none (its answer arrived).
      if (attempt.fetched && !attempt.refused && (attempt.late & 4) === 0 && allowed) {
        const settled = await this.run(state, `markRetryable ${g} ${state.attempts[g].slot}`, store => store.markRetryable(identity, claim(g)));
        const next = { ...clone(state), slots: settled.slots };
        next.attempts[g].late |= 4;
        out.push([`late#${g}:retryable`, next, afterBan(state, settled.slots, true) ?? foreign(state.slots, settled.slots, g)]);
      }
    }
    if (this.config.damage && !state.damaged) out.push(["DAMAGE", { ...clone(state), damaged: true }, null]);
    if (state.damaged && !state.freed) out.push(["RELEASE", { ...clone(state), freed: true }, await this.releaseByNewStart(state)]);
    if (this.config.ban && !state.banned && !state.damaged) {
      const banned = await this.run(state, "forbid", store => store.forbidSends(identity));
      out.push(["BAN", { ...clone(state), slots: banned.slots, banned: true }, banned.result ? null : "the ban was refused"]);
    }
    return out;
  }

  /**
   * The explicit start of a new session N with the release of the damaged key (C073): it is created, the damaged record
   * stays as it was, and its command still gets no reservation.
   */
  private async releaseByNewStart(state: State): Promise<string | null> {
    const scratch = this.makeStore();
    const damaged = damagedRecord(state.slots, state.banned);
    scratch.seed(COMMAND, damaged);
    const start = await scratch.createAndReserve(START, attemptId(0x800), 0, [COMMAND]);
    const again = await scratch.reserve(identity, attemptId(0x801));
    if (start.outcome !== "reserved") return `I8: the start of N was refused (${start.outcome})`;
    if (JSON.stringify(scratch.peek(COMMAND)) !== JSON.stringify(damaged)) return "I8: the release changed the damaged record";
    if (again.outcome !== "unknown") return `I8: the damaged command got ${again.outcome} after the release`;
    return null;
  }

  check(state: State): string[] {
    const errors: string[] = [];
    if (state.actual > SIX) errors.push(`I1: actual=${state.actual}`);
    const fetchedBy = (attempt: string) => {
      const g = parseInt(attempt.slice(24), 16);
      return g >= HISTORY || state.attempts[g]?.fetched === true;
    };
    state.attempts.forEach((attempt, g) => {
      if (!attempt.fetched) return;
      const slot = state.slots[attempt.slot];
      if (!("attempt" in slot) || slot.attempt !== attemptId(g) || slot.state === "reserved") {
        errors.push(`I3: the slot of sent attempt #${g} is ${JSON.stringify(slot)}`);
      }
    });
    if (state.slots.some(slot => "attempt" in slot && SENT.includes(slot.state) && !fetchedBy(slot.attempt))) errors.push("I2: transmitted without send");
    const slotsId = `${JSON.stringify(state.slots)}|${state.banned}`;
    let verdict = this.verdicts.get(slotsId);
    if (verdict === undefined) {
      verdict = this.verdict(summarize(record(state.slots, state.banned), identity));
      this.verdicts.set(slotsId, verdict);
    }
    if (state.damaged) return errors;
    if (verdict === "unknown") errors.push("record became unknown");
    const transmittedAndSent = state.slots.filter(slot => "attempt" in slot && SENT.includes(slot.state) && fetchedBy(slot.attempt)).length;
    if (verdict === "exhausted" && !(state.actual === SIX && transmittedAndSent === SIX)) {
      errors.push(`I2: exhaustion declared at actual=${state.actual}, transmitted=${transmittedAndSent}`);
    }
    if (state.banned && verdict !== "forbidden") errors.push(`I6: verdict ${verdict} after the ban`);
    // Neither a send nor a send derived from exhaustion (closing C, cancel of the start) — QA Н1, C081.
    if (state.refused && (verdict === "can_send" || verdict === "exhausted")) errors.push(`I7: ${verdict} after a refusal whose ban failed`);
    if (state.actual >= SIX && (verdict === "can_send" || state.attempts.some(attempt => attempt.phase === SENDING))) {
      errors.push(`I4: may still send at actual=${state.actual}`);
    }
    return errors;
  }
}

async function explore(config: Config, options: Options = {}): Promise<Report> {
  const model = new Model(config, options);
  const start = model.initial();
  const seen = new Set<string>([key(start)]);
  const queue: State[] = [start];
  const violations = new Set<string>();
  let edges = 0;
  let maxActual = start.actual;
  const maxStates = options.maxStates ?? 400_000;
  for (let index = 0; index < queue.length; index++) {
    const state = queue[index];
    maxActual = Math.max(maxActual, state.actual);
    model.check(state).forEach(error => violations.add(error.split(":")[0]));
    if (options.stopOnViolation && violations.size > 0) break;
    for (const [, next, violation] of await model.moves(state)) {
      edges++;
      if (violation) violations.add(violation.split(":")[0]);
      const id = key(next);
      if (!seen.has(id)) {
        if (seen.size >= maxStates) return { states: seen.size, edges, maxActual, violations: [...violations], complete: false };
        seen.add(id);
        queue.push(next);
      }
    }
  }
  return { states: seen.size, edges, maxActual, violations: [...violations], complete: violations.size === 0 || !options.stopOnViolation };
}

/** Control (a): the prior scheme's "roll the counter back to n−1" — a release frees the last taken slot, whoever holds it. */
class RollbackStore extends MemorySendBudget {
  override release(_identity: BudgetIdentity, _claim: SlotClaim): Promise<boolean> {
    const current = this.peek(COMMAND) as SendBudgetRecord;
    let held = -1;
    current.slots.forEach((slot, j) => { if ("attempt" in slot) held = j; });
    if (held < 0) return Promise.resolve(false);
    current.slots[held] = { state: "released" };
    this.seed(COMMAND, current);
    return Promise.resolve(true);
  }
}
/** Control (b): exhaustion by six occupied slots instead of six transmitted. */
const occupiedVerdict = (summary: BudgetSummary | null): BudgetVerdict =>
  summary === null ? "unknown" : summary.occupied < SIX ? "can_send" : "exhausted";

describe("slot protocol model on MemorySendBudget (D-CP5 5.3.9, port of F1-ATTEMPT-ID)", () => {
  it.each<Config>([
    { attempts: [2, 2], prefill: 4, late: "both" },
    { attempts: [3, 3], prefill: 5, late: "one" },
    { attempts: [2, 2, 2], prefill: 5, late: "one" },
    { attempts: [4, 2], prefill: 5, late: "one" },
    { attempts: [2, 2], prefill: 0, late: "one", crash: false },
    { attempts: [2, 2], prefill: 4, late: "one", ban: true },
    { attempts: [2, 2], prefill: 4, late: "one", refuse: true },
    { attempts: [3, 3], prefill: 5, late: "one", ban: true, refuse: true },
    { attempts: [2, 2], prefill: 5, late: "one", damage: true },
  ])("no violation in every interleaving: $attempts attempts, $prefill sent before, late $late, ban $ban, refuse $refuse, damage $damage", async (config) => {
    const report = await explore(config);
    expect(report.complete).toBe(true);
    expect(report.violations).toEqual([]);
    // Not vacuous: the bound itself is reached when the history leaves room for it.
    if (config.prefill > 0) expect(report.maxActual).toBe(SIX);
    expect(report.states).toBeGreaterThan(100);
  });

  it("C006: a late release of an old attempt does not free the slot of a newer attempt of the same window", async () => {
    const model = new Model({ attempts: [2, 1], prefill: 5, late: "one" }, {});
    let state = model.initial();
    for (const step of ["W0#0:reserve", "W0#0:release", "W0#1:reserve", "W0#1:beginSending", "W0#1:FETCH", "late#0:release",
      "W1#2:reserve", "W0#1:mark", "W0#1:retryable"]) {
      const move = (await model.moves(state)).find(([label]) => label.startsWith(step));
      expect(move, step).toBeDefined();
      state = move![1];
      expect(model.check(state)).toEqual([]);
    }
    expect(state.actual).toBe(SIX);
    expect(state.attempts[2]).toMatchObject({ phase: DONE, slot: -1 });
    expect(budgetVerdict(summarize(record(state.slots), identity))).toBe("exhausted");
  });
});

describe("controls: the model catches broken protocols (D-CP5 5.3.10)", () => {
  it("rolling the count back to n−1 instead of freeing the own slot is caught", async () => {
    const report = await explore({ attempts: [2, 1], prefill: 4, late: "one" }, { store: () => new RollbackStore() });
    // A sent slot is freed (I3) by an attempt that never held it (I5).
    expect(report.violations).toEqual(expect.arrayContaining(["I3", "I5"]));
  });

  it("exhaustion by six occupied slots instead of six transmitted is caught", async () => {
    const report = await explore({ attempts: [2, 2], prefill: 4, late: "one" }, { verdict: occupiedVerdict, stopOnViolation: true });
    expect(report.violations).toContain("I2");
  });
});
