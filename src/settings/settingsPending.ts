import type { AsyncStorage } from "../platform/storage";
import { PendingSlot, PendingStoreError, validId } from "../commands/pendingSlot";
import { retiredKeys, validSettingIntent, type EditableSettingIntent } from "./settingsApi";

/** Only the sent intent survives recovery; credentials and unsubmitted editor drafts do not. */
export type SettingsPending = {
  schemaVersion: 1;
  profileId: string;
  clientInstanceId: string;
  intent: EditableSettingIntent;
  /** A minimal status fact cannot prove this intent after an ID/content mismatch. */
  mismatch?: true;
  /**
   * R2-09 / K19-024 / P5-013: the server refused this stored intent with 422. Kept with the record, of any key, so the
   * refusal stands between openings until the server's state is proven changed or the user explicitly cancels.
   */
  refused?: true;
};

export function validSettingsPending(value: unknown): value is SettingsPending {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Partial<SettingsPending>;
  const fields = ["schemaVersion", "profileId", "clientInstanceId", "intent",
    ...(Object.hasOwn(item, "mismatch") ? ["mismatch"] : []), ...(Object.hasOwn(item, "refused") ? ["refused"] : [])];
  return Object.keys(item).length === fields.length && fields.every(key => Object.hasOwn(item, key))
    && item.schemaVersion === 1 && validId(item.profileId) && validId(item.clientInstanceId)
    && (!Object.hasOwn(item, "mismatch") || item.mismatch === true) && validSettingIntent(item.intent)
    && (!Object.hasOwn(item, "refused") || item.refused === true);
}

function copy(value: unknown): SettingsPending {
  if (!validSettingsPending(value)) throw new PendingStoreError("invalid");
  const source = value.intent;
  const selected = source.payload.value;
  // Property order is irrelevant for object equality; array order remains semantic.
  const canonical = typeof selected !== "object" || selected === null ? selected
    : Array.isArray(selected) ? [...selected]
    : selected.mode === "level" ? { mode: selected.mode, selected_level: selected.selected_level }
    : { mode: selected.mode, topic_ids: [...selected.topic_ids] };
  return { schemaVersion: 1, profileId: value.profileId, clientInstanceId: value.clientInstanceId,
    ...(value.mismatch ? { mismatch: true } : {}), ...(value.refused ? { refused: true } : {}),
    intent: { command_id: source.command_id, kind: source.kind, expected_field_version: source.expected_field_version,
      payload: { key: source.payload.key, value: canonical } } };
}

/**
 * The legacy global key of earlier builds. It is never copied or renamed. Only the profile it names may touch it:
 * through the same generic slot (so IDs and status are exactly the stored ones), or to drop a retired-setting record.
 */
export const SETTINGS_SLOT = "wortly.pending.setting";

/**
 * The record of one confirmed profile (R3-02): another profile can neither see, replace nor delete it.
 * Profile IDs are confirmed UUIDs, so the key is deterministic and holds no setting values beyond the intent itself.
 */
export function settingsSlotOf(profileId: string): string {
  if (!validId(profileId)) throw new PendingStoreError("invalid");
  return `${SETTINGS_SLOT}:profile:${profileId.toLowerCase()}`;
}

/** The parsed form of a stored record, when it is an unfinished save of a retired setting and names a profile. */
function retiredPending(raw: string | null): { key: string; profileId: string } | null {
  let value: unknown;
  try { value = raw === null ? null : JSON.parse(raw); } catch { return null; }
  const item = value as { profileId?: unknown; intent?: { payload?: { key?: unknown } } } | null;
  const key = item?.intent?.payload?.key;
  if (typeof key !== "string" || !(retiredKeys as readonly string[]).includes(key) || !validId(item?.profileId)) return null;
  return { key, profileId: item!.profileId as string };
}

/** One generic slot whose validator also pins the owner and keeps one (lowercase) spelling of the ID. */
function ownedSlot(storage: AsyncStorage, key: string, owner: string): PendingSlot<SettingsPending> {
  return new PendingSlot(storage, key, value => {
    const checked = copy(value);
    // A record that names another profile is damaged: reject it rather than let the generic `load` delete it.
    if (checked.profileId.toLowerCase() !== owner) throw new PendingStoreError("invalid");
    // The generic `load` compares profile IDs case-sensitively and deletes on a difference: keep one spelling.
    return { ...checked, profileId: owner };
  });
}

/**
 * Instantiate once for the application's document lifetimes, using its existing AsyncStorage. Each profile gets its
 * own `PendingSlot` under its own key; the generic slot and its single-record rules stay as they are.
 *
 * Legacy global key `SETTINGS_SLOT` (written by released builds):
 * - a record of another profile is ignored and never touched;
 * - a valid record naming this profile stays where it is. This profile's operations are routed through a generic slot
 *   on that key, so the controller reads the status of the same `command_id`, may repeat the same stored envelope and,
 *   after a proven terminal outcome, its ordinary `clear` removes that record. Later saves go to the profile key.
 *   Nothing is copied and no new ID appears;
 * - fail closed ("invalid", record kept) when the profile key is also occupied (two records for one profile: which is
 *   newer cannot be proven), or when the record cannot be read as a save (no known owner: blocks every profile);
 * - a retired-setting record with a valid owner is dropped once by that owner's `load` with a key-name-only report.
 *
 * Calls for one profile run strictly in call order (guard and operation together). Before every write the route is checked
 * again (see `guarded`), so a stale route fails closed as "changed" without recreating the legacy key or filling both slots.
 * Not covered: a third party writing between that check and the write (no compare-and-set in the storage API), and the
 * order of calls across two instances; the window lease of Entry is what keeps two windows apart.
 */
export class SettingsPendingStore {
  private readonly slots = new Map<string, PendingSlot<SettingsPending>>();
  private readonly chains = new Map<string, Promise<unknown>>();
  /** The signal of the call now running for each profile: the generic slot hands none to its storage. */
  private readonly running = new Map<string, AbortSignal>();

  /** The application storage, so a sibling slot of the same document (the message to the developer) lands beside this one. */
  constructor(readonly backing: AsyncStorage, private readonly report: (message: string) => void = message => console.warn(message)) {}

  private slot(key: string, owner: string): PendingSlot<SettingsPending> {
    const id = `${key}\n${owner}`;
    let slot = this.slots.get(id);
    if (!slot) { slot = ownedSlot(this.guarded(owner), key, owner); this.slots.set(id, slot); }
    return slot;
  }

  /**
   * Storage for the slots of one profile whose `set` first re-reads both keys and refuses (as "changed", nothing written)
   * when the route chosen earlier is no longer the right one: a window that cleared the legacy record meanwhile must not
   * have it recreated, and a profile record must not appear beside a legacy one. The check and the write are two storage
   * calls, so a third party writing exactly between them is not excluded: the storage API has no compare-and-set.
   * Removes are not re-checked; the slot has just compared the record it removes.
   */
  private guarded(owner: string): AsyncStorage {
    return {
      get: key => this.backing.get(key),
      remove: key => this.backing.remove(key),
      set: async (key, value) => {
        const ownKey = settingsSlotOf(owner);
        const ownRaw = await this.backing.get(ownKey);
        const legacyRaw = await this.backing.get(SETTINGS_SLOT);
        let target: string;
        // A cancelled call must leave every key as it is. No await follows this check, so it is also the one right before the write.
        if (this.running.get(owner)?.aborted) throw new PendingStoreError("cancelled");
        try { target = this.decide(owner, ownRaw, legacyRaw); } catch { throw new PendingStoreError("changed"); }
        if (target !== key) throw new PendingStoreError("changed");
        await this.backing.set(key, value);
      },
    };
  }

  /** The key this profile's operations belong to, or "invalid" when the stored state cannot be used safely. */
  private decide(mine: string, ownRaw: string | null, legacyRaw: string | null): string {
    const ownKey = settingsSlotOf(mine);
    if (legacyRaw === null) return ownKey;
    const retired = retiredPending(legacyRaw);
    if (retired) {
      if (retired.profileId.toLowerCase() !== mine) return ownKey;
      throw new PendingStoreError("invalid");
    }
    let owner: string;
    try { owner = copy(JSON.parse(legacyRaw)).profileId.toLowerCase(); } catch { throw new PendingStoreError("invalid"); }
    if (owner !== mine) return ownKey;
    // The legacy record is this profile's. Both slots filled: refuse rather than guess which one is current.
    if (ownRaw !== null) throw new PendingStoreError("invalid");
    return SETTINGS_SLOT;
  }

  /** Runs `action` after every earlier call of the same profile has finished; a failure does not poison the chain. */
  private serial<R>(profileId: string, signal: AbortSignal, action: () => Promise<R>): Promise<R> {
    if (!validId(profileId)) return Promise.reject(new PendingStoreError("invalid"));
    const owner = profileId.toLowerCase();
    const task = (this.chains.get(owner) ?? Promise.resolve()).then(() => { this.running.set(owner, signal); return action(); }).catch((error: unknown) => {
      throw error instanceof PendingStoreError ? error : new PendingStoreError("unavailable");
    });
    this.chains.set(owner, task.catch(() => undefined));
    return task;
  }

  /** Chooses the slot of this profile; storage failures are "unavailable" and a cancelled signal never writes. */
  private async route(profileId: string, signal: AbortSignal, dropRetired: boolean): Promise<PendingSlot<SettingsPending>> {
    const cancelled = () => { if (signal.aborted) throw new PendingStoreError("cancelled"); };
    const mine = profileId.toLowerCase();
    const ownKey = settingsSlotOf(profileId);
    cancelled();
    const ownRaw = await this.backing.get(ownKey);
    cancelled();
    const ownDropped = await this.dropRetiredRecord(ownKey, ownRaw, mine, signal, dropRetired, false);
    const legacyRaw = await this.backing.get(SETTINGS_SLOT);
    cancelled();
    const legacyDropped = legacyRaw !== null && await this.dropRetiredRecord(SETTINGS_SLOT, legacyRaw, mine, signal, dropRetired, true);
    return this.slot(this.decide(mine, ownDropped ? null : ownRaw, legacyDropped ? null : legacyRaw), mine);
  }

  /**
   * An unfinished save of a retired setting would be read as an invalid slot and block every new change.
   * It is dropped once, with a technical record that carries the key name only. Returns true only when the record was dropped.
   */
  private async dropRetiredRecord(key: string, raw: string | null, mine: string, signal: AbortSignal,
    allowed: boolean, legacy: boolean): Promise<boolean> {
    const retired = retiredPending(raw);
    if (retired === null) return false;
    if (legacy && retired.profileId.toLowerCase() !== mine) return false;
    if (!allowed) throw new PendingStoreError("invalid");
    if (signal.aborted) throw new PendingStoreError("cancelled");
    await this.backing.remove(key);
    this.report(`settings: discarded an unfinished save of the retired setting ${retired.key}`);
    return true;
  }

  /** Load runs before any write of a document, so dropping a retired record stays ahead of the slot's own queue. */
  async load(profileId: string, signal: AbortSignal): Promise<SettingsPending | null> {
    return this.serial(profileId, signal, async () => (await this.route(profileId, signal, true)).load(profileId.toLowerCase(), signal));
  }

  async save(value: SettingsPending, signal: AbortSignal): Promise<void> {
    const pending = copy(value);
    return this.serial(pending.profileId, signal, async () => (await this.route(pending.profileId, signal, false)).save(pending, signal));
  }

  async clear(value: SettingsPending, signal: AbortSignal): Promise<void> {
    const pending = copy(value);
    return this.serial(pending.profileId, signal, async () => (await this.route(pending.profileId, signal, false)).clear(pending, signal));
  }

  async clearMarked(value: SettingsPending, signal: AbortSignal): Promise<void> {
    const pending = copy(value);
    return this.serial(pending.profileId, signal, async () => (await this.route(pending.profileId, signal, false)).clearMarked(pending, signal));
  }

  /**
   * Keeps the 422 of a stored intent with its record (R2-09 / K19-024): one write, same intent, plus the mark. A record that
   * changed meanwhile (another intent of this profile) is never overwritten: "changed", nothing written.
   */
  async markRefused(value: SettingsPending, signal: AbortSignal): Promise<void> {
    const pending = copy(value);
    const marked = copy({ ...pending, refused: true });
    return this.serial(pending.profileId, signal, async () => (await this.route(pending.profileId, signal, false)).replace(pending, marked, signal));
  }

  async markMismatch(value: SettingsPending, signal: AbortSignal): Promise<void> {
    const pending = copy(value);
    return this.serial(pending.profileId, signal, async () => (await this.route(pending.profileId, signal, false)).markMismatch(pending, signal));
  }
}
