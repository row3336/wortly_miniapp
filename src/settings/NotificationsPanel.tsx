import { useId } from "react";
import type { Language } from "../i18n/language";
import type { NotificationFlag, NotificationHour, SettingKey } from "./settingsApi";
import type { SettingsSnapshot } from "./settingsController";
import { settingsCopy } from "./settingsCopy";
import { hourText, notificationsCopy } from "./notificationsCopy";

type Actions = {
  edit(key: SettingKey, input: unknown): void;
  save(key: SettingKey): Promise<void>;
  acceptCurrent(key: SettingKey): void;
  keepMine(key: SettingKey): Promise<void>;
};
export type NotificationsPanelProps = {
  snapshot: SettingsSnapshot;
  language: Language;
  actions: Actions;
  /** «Открыть бота» (R12-15); without it the button is not shown. */
  onOpenBot?(): void;
};
type Kind = { flag: NotificationFlag; hour?: NotificationHour; title: "learning" | "weekly" | "daily" | "evening";
  note?: "weeklyNote" | "dailyNote" };

// project_notifications §8.1: Learning has only its switch (no pause, R14-02); the weekly report has only its hour (always
// Monday, no weekday, R12-02); #daily and the evening reminder have their hour.
const kinds: readonly Kind[] = [
  { flag: "notify_learning", title: "learning" },
  { flag: "notify_weekly", hour: "weekly_report_hour", title: "weekly", note: "weeklyNote" },
  { flag: "notify_daily", hour: "daily_report_hour", title: "daily", note: "dailyNote" },
  { flag: "notify_evening", hour: "evening_reminder_hour", title: "evening" },
];

function shown(key: SettingKey, value: unknown, language: Language): string {
  const t = settingsCopy[language];
  if (typeof value === "boolean") return value ? t.on : t.off;
  return typeof value === "number" && key.endsWith("_hour") ? hourText(value) : String(value ?? t.notSet);
}

/** The result, error and conflict lines of one key; the conflict offers the existing «Принять / Сохранить моё». */
function KeyState({ setting, snapshot, language, actions, id }: Pick<NotificationsPanelProps, "snapshot" | "language" | "actions">
  & { setting: SettingKey; id: string }) {
  const t = settingsCopy[language], draft = snapshot.drafts[setting];
  const current = snapshot.data!.settings[setting].value;
  const outcome = snapshot.outcome?.key === setting ? snapshot.outcome : null;
  const busy = ["loading", "checking", "sending"].includes(snapshot.phase);
  const refused = snapshot.problem?.reason === "incompatible" || snapshot.problem?.reason === "command_refused";
  return <>
    <div id={id} className="settings-error" aria-live="polite">
      {draft?.error === "invalid" && <p>{t.invalid}</p>}
      {draft?.error === "version_exhausted" && <p>{t.exhausted}</p>}
      {draft?.error === "rejected" && <p>{t.rejected}</p>}
      {draft?.conflict && <div className="settings-conflict">
        <p>{t.conflict}</p><p>{t.current}: {shown(setting, current, language)}</p>
        <div className="settings-actions">
          <button type="button" className="settings-secondary" disabled={!snapshot.canEdit || busy}
            onClick={() => actions.acceptCurrent(setting)}>{t.acceptCurrent}</button>
          <button type="button" className="settings-primary" disabled={!draft.canKeepMine}
            onClick={() => { void actions.keepMine(setting); }}>{t.keepMine}</button>
        </div>
      </div>}
    </div>
    <div className="settings-actions">
      {snapshot.pending?.intent.payload.key === setting && !refused && !snapshot.pending.mismatch
        && <span role="status">{snapshot.phase === "sending" ? t.saving : t.unknown}</span>}
      {outcome?.status === "accepted" && <span className="settings-saved" role="status">{t.saved}</span>}
    </div>
  </>;
}

/**
 * The submenu «Уведомления» (project_notifications §8): every choice is saved at once with one command, the fields close
 * while it is in flight (the controller's canEdit), and until the bot is opened the switches are shown off and closed.
 */
export function NotificationsPanel({ snapshot, language, actions, onOpenBot }: NotificationsPanelProps) {
  const id = useId(), t = settingsCopy[language], n = notificationsCopy[language];
  const data = snapshot.data!;
  const opened = data.notifications.telegram_opened;
  const choose = (key: SettingKey, value: boolean | number) => { actions.edit(key, value); void actions.save(key); };
  const value = (key: SettingKey) => snapshot.drafts[key] ? snapshot.drafts[key]!.input : data.settings[key].value;
  return <div className="settings-group-body settings-notifications">
    <p className="settings-help">{n.zone(data.settings.time_zone.value ?? t.notSet)}</p>
    {!opened && <div className="settings-notice" role="note">
      <p>{n.notOpened}</p>
      {onOpenBot && <button type="button" className="settings-secondary" onClick={onOpenBot}>{n.openBot}</button>}
    </div>}
    {kinds.map(kind => {
      const key = `${id}-${kind.flag}`, flagValue = value(kind.flag);
      // Before the bot is opened the switch shows off whatever is stored (contract §7.3 p.3, R12-15).
      const checked = opened && flagValue === true;
      const hour = kind.hour, hourValue = hour ? value(hour) : null, rule = hour ? data.constraints[hour] : null;
      const hours = rule && typeof rule.minimum === "number" && typeof rule.maximum === "number"
        ? Array.from({ length: rule.maximum - rule.minimum + 1 }, (_, index) => rule.minimum! + index) : [];
      return <section className="settings-field" role="group" aria-labelledby={`${key}-title`} key={kind.flag}>
        <h3 id={`${key}-title`}>{n[kind.title]}</h3>
        <div className="settings-options">
          <label>
            <input type="checkbox" role="switch" checked={checked} disabled={!snapshot.canEdit || !opened}
              aria-labelledby={`${key}-title`} aria-describedby={`${key}-error`}
              onChange={event => { if (opened) choose(kind.flag, event.target.checked); }} />
            {checked ? t.on : t.off}
          </label>
        </div>
        <KeyState setting={kind.flag} id={`${key}-error`} snapshot={snapshot} language={language} actions={actions} />
        {kind.note && <p className="settings-help">{n[kind.note]}</p>}
        {hour && <>
          {/* The hours stay open before the bot is opened (§3, §8.1). */}
          <label className="settings-label">{n.time}
            <select disabled={!snapshot.canEdit} value={typeof hourValue === "number" ? String(hourValue) : ""}
              aria-describedby={`${key}-hour-error`} onChange={event => choose(hour, Number(event.target.value))}>
              {typeof hourValue === "number" && !hours.includes(hourValue)
                && <option value={String(hourValue)} disabled>{hourText(hourValue)}</option>}
              {hours.map(item => <option key={item} value={String(item)}>{hourText(item)}</option>)}
            </select>
          </label>
          <KeyState setting={hour} id={`${key}-hour-error`} snapshot={snapshot} language={language} actions={actions} />
        </>}
      </section>;
    })}
    <p className="settings-help">{n.always}</p>
  </div>;
}
