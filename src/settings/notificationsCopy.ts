import type { Language } from "../i18n/language";

type Copy = {
  /** The row on the settings screen and the submenu title. */
  title: string;
  zone(zone: string): string;
  notOpened: string; openBot: string;
  learning: string;
  weekly: string; weeklyNote: string;
  daily: string; dailyNote: string;
  evening: string;
  time: string;
  /** The messages that are not switched off here. */
  always: string;
};

// WORKING TEXTS, to be shown to the owner (project_notifications §9 table №5 ed.4.3, P5-024): not approved yet. The rows for a
// weekday choice and for the Learning pause are deliberately absent (R12-02, R14-02). On/off, errors, conflicts and the
// mismatch reuse the existing lines of settingsCopy.ts (§9).
export const notificationsCopy: Record<Language, Copy> = {
  ru: {
    title: "Уведомления",
    zone: zone => `Время указано по твоему часовому поясу: ${zone}`,
    notOpened: "Уведомления включатся, когда ты откроешь бота", openBot: "Открыть бота",
    learning: "Напоминания Learning",
    weekly: "Недельный отчёт", weeklyNote: "Приходит в понедельник за прошлую неделю",
    daily: "Ежедневный отчёт #daily", dailyNote: "Приходит после окончания суток по твоему времени за эти сутки",
    evening: "Вечернее напоминание о повторах",
    time: "Время",
    always: "Сообщения о доступе, ответы на обращения и сообщения безопасности приходят всегда.",
  },
  uk: {
    title: "Сповіщення",
    zone: zone => `Час вказано за твоїм часовим поясом: ${zone}`,
    notOpened: "Сповіщення ввімкнуться, коли ти відкриєш бота", openBot: "Відкрити бота",
    learning: "Нагадування Learning",
    weekly: "Тижневий звіт", weeklyNote: "Надходить у понеділок за минулий тиждень",
    daily: "Щоденний звіт #daily", dailyNote: "Надходить після завершення доби за твоїм часом за цю добу",
    evening: "Вечірнє нагадування про повторення",
    time: "Час",
    always: "Повідомлення про доступ, відповіді на звернення та повідомлення безпеки надходять завжди.",
  },
  en: {
    title: "Notifications",
    zone: zone => `Times are in your time zone: ${zone}`,
    notOpened: "Notifications will switch on once you open the bot", openBot: "Open the bot",
    learning: "Learning reminders",
    weekly: "Weekly report", weeklyNote: "Arrives on Monday for the previous week",
    daily: "Daily report #daily", dailyNote: "Arrives after your local day ends, for that day",
    evening: "Evening review reminder",
    time: "Time",
    always: "Access messages, replies to your messages and security notices always arrive.",
  },
};

/** A whole local hour 0–23 as the submenu shows it (R12-13: no minutes). */
export function hourText(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}
