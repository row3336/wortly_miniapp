import type { Language } from "../i18n/language";
import type { FeedbackProblem } from "../feedback/feedbackController";

type Copy = {
  title: string; label: string; hint: string; send: string; retry: string;
  loading: string; sending: string; checking: string; confirmed: string; refused: string;
  problems: Record<FeedbackProblem, string>;
};

// Working copy for G05: the owner fixes final wording. Facts follow TA:153 and RA:291/340: the text stays after a failure,
// success is shown only after the server confirms it, and no direct contact of the developer is shown anywhere.
export const settingsFeedbackCopy: Record<Language, Copy> = {
  ru: {
    title: "Связь с разработчиком", label: "Сообщение разработчику",
    hint: "Напиши, что не так или что улучшить. Сообщение придёт разработчику через бота.",
    send: "Отправить", retry: "Повторить отправку", loading: "Проверяем сохранённую отправку",
    sending: "Отправляем сообщение", checking: "Проверяем, принято ли сообщение",
    confirmed: "Сообщение принято. Спасибо.",
    refused: "Сообщение не принято. Текст сохранён: проверь его и отправь снова.",
    problems: {
      network: "Пока не удалось подтвердить, что сообщение принято. Текст сохранён. Повтори отправку.",
      not_sent: "Сообщение ещё не принято. Текст сохранён. Повтори отправку.",
      storage: "Не удалось прочитать или обновить временную запись отправки. Повтори отправку.",
      invalid_pending: "Сохранённая отправка повреждена, отправить сообщение сейчас нельзя.",
      pending_changed: "Сохранённая отправка изменилась в другом окне. Закрой лишние окна и открой приложение заново.",
      expired: "Сеанс истёк. Текст сохранён: открой приложение заново.",
      forbidden: "Нет доступа к отправке сообщений. Текст сохранён.",
    },
  },
  uk: {
    title: "Зв’язок із розробником", label: "Повідомлення розробнику",
    hint: "Напиши, що не так або що покращити. Повідомлення прийде розробнику через бота.",
    send: "Надіслати", retry: "Повторити надсилання", loading: "Перевіряємо збережене надсилання",
    sending: "Надсилаємо повідомлення", checking: "Перевіряємо, чи прийнято повідомлення",
    confirmed: "Повідомлення прийнято. Дякуємо.",
    refused: "Повідомлення не прийнято. Текст збережено: перевір його й надішли знову.",
    problems: {
      network: "Поки не вдалося підтвердити, що повідомлення прийнято. Текст збережено. Повтори надсилання.",
      not_sent: "Повідомлення ще не прийнято. Текст збережено. Повтори надсилання.",
      storage: "Не вдалося прочитати або оновити тимчасовий запис надсилання. Повтори надсилання.",
      invalid_pending: "Збережене надсилання пошкоджене, надіслати повідомлення зараз неможливо.",
      pending_changed: "Збережене надсилання змінилося в іншому вікні. Закрий зайві вікна й відкрий застосунок знову.",
      expired: "Сеанс завершився. Текст збережено: відкрий застосунок знову.",
      forbidden: "Немає доступу до надсилання повідомлень. Текст збережено.",
    },
  },
  en: {
    title: "Contact the developer", label: "Message to the developer",
    hint: "Write what is wrong or what to improve. The message reaches the developer through the bot.",
    send: "Send", retry: "Retry sending", loading: "Checking the saved message",
    sending: "Sending the message", checking: "Checking whether the message was accepted",
    confirmed: "Message accepted. Thank you.",
    refused: "The message was not accepted. The text is kept: check it and send again.",
    problems: {
      network: "Could not confirm yet that the message was accepted. The text is kept. Retry sending.",
      not_sent: "The message has not been accepted yet. The text is kept. Retry sending.",
      storage: "Could not read or update the temporary record of the message. Retry sending.",
      invalid_pending: "The saved message record is damaged, so a message cannot be sent now.",
      pending_changed: "The saved message changed in another window. Close extra windows and reopen the app.",
      expired: "The session expired. The text is kept: reopen the app.",
      forbidden: "Sending messages is not allowed. The text is kept.",
    },
  },
};
