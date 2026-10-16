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
 * The legacy global key of earlier builds (project_pending_profile_slots.md ред.1.1 §3.4, §4). It is never routed to,
 * written, removed, copied or imported: its presence (or a failed read of it) only closes NEW saves of settings (preflight).
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

/** One generic slot on the profile key whose validator also pins the owner and keeps one (lowercase) spelling of the ID. */
function ownedSlot(storage: AsyncStorage, key: string, owner: string): PendingSlot<SettingsPending> {
  return new PendingSlot(storage, key, value => {
    const checked = copy(value);
    // A record that names another profile is damaged: "invalid", never removed.
    if (checked.profileId.toLowerCase() !== owner) throw new PendingStoreError("invalid");
    return { ...checked, profileId: owner };
  }, "fixed");
}

/**
 * Instantiate once for the application's document lifetimes, using its existing AsyncStorage. Each profile has its own
 * `PendingSlot` under its own key `wortly.pending.setting:profile:<pid>` (R3-02); no operation touches another key.
 *
 * The legacy global key `SETTINGS_SLOT` is only read by the preflight of a NEW save (§4): present or unreadable — "legacy",
 * nothing stored, settings stay closed for new changes until a cutover; a repeat of the profile's own stored save is not
 * affected. An unfinished save of a retired setting under the profile key is dropped once by that profile's `load`
 * (key-name-only report).
 *
 * Calls for one profile run strictly in call order. Not covered: the order of calls across two windows of the SAME profile
 * (the window lease of Entry keeps them apart).
 */
export class SettingsPendingStore {
  private readonly slots = new Map<string, PendingSlot<SettingsPending>>();
  private readonly chains = new Map<string, Promise<unknown>>();

  /** The application storage, so a sibling slot of the same document (the message to the developer) lands beside this one. */
  constructor(readonly backing: AsyncStorage, private readonly report: (message: string) => void = message => console.warn(message)) {}

  private slot(owner: string): PendingSlot<SettingsPending> {
    let slot = this.slots.get(owner);
    if (!slot) { slot = ownedSlot(this.backing, settingsSlotOf(owner), owner); this.slots.set(owner, slot); }
    return slot;
  }

  /** Runs `action` after every earlier call of the same profile has finished; a failure does not poison the chain. */
  private serial<R>(profileId: string, action: (owner: string) => Promise<R>): Promise<R> {
    if (!validId(profileId)) return Promise.reject(new PendingStoreError("invalid"));
    const owner = profileId.toLowerCase();
    const task = (this.chains.get(owner) ?? Promise.resolve()).then(() => action(owner)).catch((error: unknown) => {
      throw error instanceof PendingStoreError ? error : new PendingStoreError("unavailable");
    });
    this.chains.set(owner, task.catch(() => undefined));
    return task;
  }

  /** §4: the legacy key must be reliably absent before a NEW save; it is never written or removed. */
  private async preflight(signal: AbortSignal): Promise<void> {
    let raw: string | null;
    try { raw = await this.backing.get(SETTINGS_SLOT); } catch { this.report(`settings preflight: legacy key ${SETTINGS_SLOT} unreadable`); throw new PendingStoreError("legacy"); }
    if (signal.aborted) throw new PendingStoreError("cancelled");
    if (raw !== null) { this.report(`settings preflight: legacy key ${SETTINGS_SLOT} present`); throw new PendingStoreError("legacy"); }
  }

  /** Load runs before any write of a document: an unfinished save of a retired setting on the profile key is dropped once. */
  async load(profileId: string, signal: AbortSignal): Promise<SettingsPending | null> {
    return this.serial(profileId, async owner => {
      const ownKey = settingsSlotOf(owner);
      const raw = await this.backing.get(ownKey);
      if (signal.aborted) throw new PendingStoreError("cancelled");
      const retired = retiredPending(raw);
      if (retired && retired.profileId.toLowerCase() === owner) {
        await this.backing.remove(ownKey);
        this.report(`settings: discarded an unfinished save of the retired setting ${retired.key}`);
        return null;
      }
      return this.slot(owner).load(owner, signal);
    });
  }

  async save(value: SettingsPending, signal: AbortSignal): Promise<void> {
    const pending = copy(value);
    return this.serial(pending.profileId, async owner => {
      const slot = this.slot(owner);
      // A repeat of the stored save (the same intent) is no new save: the preflight closes new ones only.
      const stored = await slot.load(owner, signal);
      if (stored === null) await this.preflight(signal);
      return slot.save({ ...pending, profileId: owner }, signal);
    });
  }

  async clear(value: SettingsPending, signal: AbortSignal): Promise<void> {
    const pending = copy(value);
    return this.serial(pending.profileId, owner => this.slot(owner).clear({ ...pending, profileId: owner }, signal));
  }

  async clearMarked(value: SettingsPending, signal: AbortSignal): Promise<void> {
    const pending = copy(value);
    return this.serial(pending.profileId, owner => this.slot(owner).clearMarked({ ...pending, profileId: owner }, signal));
  }

  /**
   * Keeps the 422 of a stored intent with its record (R2-09 / K19-024): one write, same intent, plus the mark. A record that
   * changed meanwhile (another intent of this profile) is never overwritten: "changed", nothing written.
   */
  async markRefused(value: SettingsPending, signal: AbortSignal): Promise<void> {
    const pending = copy(value);
    const marked = copy({ ...pending, refused: true });
    return this.serial(pending.profileId, owner => this.slot(owner).replace({ ...pending, profileId: owner },
      { ...marked, profileId: owner }, signal));
  }

  async markMismatch(value: SettingsPending, signal: AbortSignal): Promise<void> {
    const pending = copy(value);
    return this.serial(pending.profileId, owner => this.slot(owner).markMismatch({ ...pending, profileId: owner }, signal));
  }
}
