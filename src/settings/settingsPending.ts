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
};

export function validSettingsPending(value: unknown): value is SettingsPending {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Partial<SettingsPending>;
  const fields = ["schemaVersion", "profileId", "clientInstanceId", "intent",
    ...(Object.hasOwn(item, "mismatch") ? ["mismatch"] : [])];
  return Object.keys(item).length === fields.length && fields.every(key => Object.hasOwn(item, key))
    && item.schemaVersion === 1 && validId(item.profileId) && validId(item.clientInstanceId)
    && (!Object.hasOwn(item, "mismatch") || item.mismatch === true) && validSettingIntent(item.intent);
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
    ...(value.mismatch ? { mismatch: true } : {}),
    intent: { command_id: source.command_id, kind: source.kind, expected_field_version: source.expected_field_version,
      payload: { key: source.payload.key, value: canonical } } };
}

const SLOT_KEY = "wortly.pending.setting";

/** The key of an unfinished save of a retired setting stored by an older build, otherwise null. */
function retiredPendingKey(raw: string | null): string | null {
  let value: unknown;
  try { value = raw === null ? null : JSON.parse(raw); } catch { return null; }
  const intent = (value as { intent?: { payload?: { key?: unknown } } } | null)?.intent;
  const key = intent?.payload?.key;
  return typeof key === "string" && (retiredKeys as readonly string[]).includes(key) ? key : null;
}

/** Instantiate once for the application's document lifetimes, using its existing AsyncStorage. */
export class SettingsPendingStore extends PendingSlot<SettingsPending> {
  /** The application storage, so a sibling slot of the same document (the message to the developer) lands beside this one. */
  constructor(readonly backing: AsyncStorage, private readonly report: (message: string) => void = message => console.warn(message)) {
    super(backing, SLOT_KEY, copy);
  }

  /**
   * An unfinished save of a retired setting would be read as an invalid slot and block every new change.
   * It is dropped once, with a technical record that carries the key name only. Load runs before any write
   * of a document, so this stays ahead of the slot's own queue.
   */
  override async load(profileId: string, signal: AbortSignal): Promise<SettingsPending | null> {
    await this.dropRetired(signal);
    return super.load(profileId, signal);
  }

  /** Storage failures surface as PendingStoreError("unavailable") and a cancelled signal neither removes nor reports, as in the base slot. */
  private async dropRetired(signal: AbortSignal): Promise<void> {
    const cancelled = () => { if (signal.aborted) throw new PendingStoreError("cancelled"); };
    try {
      cancelled();
      const key = retiredPendingKey(await this.backing.get(SLOT_KEY));
      cancelled();
      if (key === null) return;
      await this.backing.remove(SLOT_KEY);
      this.report(`settings: discarded an unfinished save of the retired setting ${key}`);
    } catch (error) {
      throw error instanceof PendingStoreError ? error : new PendingStoreError("unavailable");
    }
  }
}
