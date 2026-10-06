/** Labels of the command state controls, the same in every study screen: check by the same ID, resend, retry Stop. */
export const commandCopy = {
  ru: { check: "Проверить состояние", retry: "Повторить отправку", retryStop: "Повторить завершение" },
  uk: { check: "Перевірити стан", retry: "Повторити надсилання", retryStop: "Повторити завершення" },
  en: { check: "Check status", retry: "Retry sending", retryStop: "Retry ending the session" },
} as const;
