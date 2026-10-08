import { MAX_SENDS } from "./recoveryLimits";

/**
 * Two marks per send of one command_id (D-RECOV RESULTS_VP table 1.7.1; root decision, pending owner, question 3):
 * reserved is written before the network and bounds the sends (never more than six); transmitted counts the sends whose
 * request has really started and is the only proof that the budget is truly spent (Я15.8). transmitted <= reserved.
 */
export type SendMarks = {
  reserved: number;
  transmitted: number;
  /**
   * The last send that reached the server met a planned pause (503 MAINTENANCE). Kept with the count so that a
   * re-created machine at six sends waits in the pause instead of exhausting (TC §11). Absent (older records) = false.
   */
  lastMaintenance?: true;
  /**
   * forbidSends was called for this command_id: a proven refusal or a payload conflict closed its sends for good
   * (D-CP2C-START, C038 п. 3, C053). No owner may send it again, whatever the count allows. Absent = not forbidden;
   * a record that cannot be read or validated is an unknown count, which forbids a send as well.
   */
  forbidden?: true;
};

/** The canonical copy: lastMaintenance only when set, so records with and without the flag compare stably. */
export function copyMarks(marks: SendMarks): SendMarks {
  return { reserved: marks.reserved, transmitted: marks.transmitted, ...(marks.lastMaintenance ? { lastMaintenance: true } : {}),
    ...(marks.forbidden ? { forbidden: true } : {}) };
}

/**
 * Integers with 0 <= transmitted <= reserved <= 6 and, when present, a boolean lastMaintenance and a boolean forbidden;
 * anything else (a corrupt or foreign record) is an unknown count.
 */
export function validMarks(value: unknown): value is SendMarks {
  if (typeof value !== "object" || value === null) return false;
  const { reserved, transmitted, lastMaintenance, forbidden } = value as Record<string, unknown>;
  return Number.isInteger(reserved) && Number.isInteger(transmitted)
    && (transmitted as number) >= 0 && (transmitted as number) <= (reserved as number) && (reserved as number) <= MAX_SENDS
    && (lastMaintenance === undefined || typeof lastMaintenance === "boolean")
    && (forbidden === undefined || typeof forbidden === "boolean");
}

/**
 * The marks of a command_id over its whole recovery (CT §6.1 п. 4). load() answers null when they cannot be
 * established: an unknown count forbids a retry and never proves exhaustion. A rejected save() makes the count unknown.
 */
export interface SendCounter {
  load(commandId: string): Promise<SendMarks | null>;
  save(commandId: string, marks: SendMarks): Promise<void>;
  /**
   * Forbid every further send of commandId for good (idempotent; the same name as the durable store of CP5a). load()
   * then answers forbidden: true, and a later save() without the flag does not lift it. A rejection means the ban may
   * be missing: the caller must make the count unknown (clear) instead of relying on it.
   */
  forbidSends(commandId: string): Promise<void>;
  clear(commandId: string): Promise<void>;
}

/**
 * Stage 1 (DESIGN D-RECOV 4.1): the marks live in the memory of one document. They survive the background, a return
 * and routes inside the document; a reload or another window starts without them, so only a check is allowed there.
 * Stage 2 (CP5) replaces it with a durable store behind the same interface.
 */
export class MemorySendCounter implements SendCounter {
  private readonly marks = new Map<string, SendMarks>();
  private readonly forbidden = new Set<string>();

  async load(commandId: string): Promise<SendMarks | null> {
    const marks = this.marks.get(commandId);
    // Without marks the count is unknown, which forbids a send anyway.
    return marks ? copyMarks({ ...marks, ...(this.forbidden.has(commandId) ? { forbidden: true } : {}) }) : null;
  }
  async save(commandId: string, marks: SendMarks): Promise<void> {
    if (!validMarks(marks)) throw new Error("invalid send marks");
    this.marks.set(commandId, copyMarks(marks));
  }
  async forbidSends(commandId: string): Promise<void> {
    this.forbidden.add(commandId);
  }
  async clear(commandId: string): Promise<void> {
    this.marks.delete(commandId);
    this.forbidden.delete(commandId);
  }
}
